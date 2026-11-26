import { create } from 'zustand';
import { RouteRequestError, fetchRoutes } from '../api/routingClient';
import { DEFAULT_ROUTE_KIND } from '../config/routeStyle';
import type { Route, RouteEtaMode, RouteKind, RouteRequest, WalkableArea } from '../types/routing';

export type RoutingStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModeRouteResult {
  request: RouteRequest;
  routes: Route[];
  warnings: string[];
  walkableArea: WalkableArea | null;
  status: RoutingStatus;
  error: string | null;
}

/** Shortest ETA (in seconds) across all routes for the given travel mode, or `null` if none. */
export function shortestEtaSeconds(routes: Route[], mode: RouteEtaMode): number | null {
  if (routes.length === 0) return null;
  return Math.min(...routes.map((route) => (mode === 'rover' ? route.eta_rover_s : route.eta_eva_s)));
}

const EMPTY_MODE_RESULTS: Record<RouteEtaMode, ModeRouteResult | null> = {
  eva: null,
  rover: null,
};

function loadingModeResult(request: RouteRequest): ModeRouteResult {
  return {
    request,
    routes: [],
    warnings: [],
    walkableArea: null,
    status: 'loading',
    error: null,
  };
}

function projectActiveMode(result: ModeRouteResult | null) {
  if (!result) {
    return {
      request: null,
      routes: [],
      warnings: [],
      walkableArea: null,
      status: 'idle' as RoutingStatus,
      error: null,
    };
  }
  return {
    request: result.request,
    routes: result.routes,
    warnings: result.warnings,
    walkableArea: result.walkableArea,
    status: result.status,
    error: result.error,
  };
}

interface RoutingState {
  request: RouteRequest | null;
  routes: Route[];
  warnings: string[];
  /** Per-pixel terrain classes (gentle / moderate / steep / unreachable) around the destination */
  walkableArea: WalkableArea | null;
  /** Whether the walkable-area overlay is drawn (HUD toggle) */
  walkableAreaVisible: boolean;
  status: RoutingStatus;
  error: string | null;
  /** Per-mode route results for the current camp pair so ETA previews and mode switches stay exact */
  modeResults: Record<RouteEtaMode, ModeRouteResult | null>;
  /** Route drawn emphasised on the map and summarised in the route planner */
  highlightedKind: RouteKind | null;
  /** Which ETA (EVA walk vs. rover) to show on map route labels */
  etaMode: RouteEtaMode;
  /**
   * Entry point for any UI: sets source/destination and fetches the 3 safe routes.
   * A newer request supersedes (aborts) one still in flight.
   */
  setRequest: (request: RouteRequest, etaMode?: RouteEtaMode) => Promise<void>;
  /**
   * Fetches safe routes for both EVA and rover modes in parallel for the same camp pair,
   * projecting `activeMode` onto the top-level fields.
   */
  setModeRequests: (
    requests: Record<RouteEtaMode, RouteRequest>,
    activeMode: RouteEtaMode
  ) => Promise<void>;
  /** Switches the active mode, immediately projecting its cached result if available. */
  setEtaMode: (mode: RouteEtaMode) => void;
  setHighlightedKind: (kind: RouteKind | null) => void;
  setWalkableAreaVisible: (visible: boolean) => void;
  clear: () => void;
}

let inFlight: AbortController | null = null;

/** Bounded LRU cache of deterministic route results so revisiting/swapping camps is instant. */
const MAX_ROUTE_CACHE = 32;
const routeResultCache = new Map<string, ModeRouteResult>();

function routeCacheKey(request: RouteRequest): string {
  const { source, destination, max_slope_deg } = request;
  return `${source.lat},${source.lon}|${destination.lat},${destination.lon}|${max_slope_deg ?? ''}`;
}

function getCachedResult(request: RouteRequest): ModeRouteResult | null {
  const key = routeCacheKey(request);
  const hit = routeResultCache.get(key);
  if (!hit) return null;
  routeResultCache.delete(key);
  routeResultCache.set(key, hit);
  return hit;
}

function setCachedResult(request: RouteRequest, result: ModeRouteResult): void {
  const key = routeCacheKey(request);
  routeResultCache.delete(key);
  routeResultCache.set(key, result);
  while (routeResultCache.size > MAX_ROUTE_CACHE) {
    const oldest = routeResultCache.keys().next().value;
    if (oldest !== undefined) routeResultCache.delete(oldest);
  }
}

export const useRoutingStore = create<RoutingState>((set, get) => ({
  request: null,
  routes: [],
  warnings: [],
  walkableArea: null,
  walkableAreaVisible: true,
  status: 'idle',
  error: null,
  modeResults: { ...EMPTY_MODE_RESULTS },
  highlightedKind: DEFAULT_ROUTE_KIND,
  etaMode: 'rover',

  setRequest: async (request, etaMode = 'rover') => {
    inFlight?.abort();
    const cached = getCachedResult(request);
    if (cached) {
      inFlight = null;
      const hit: ModeRouteResult = { ...cached, request };
      set({
        ...projectActiveMode(hit),
        etaMode,
        modeResults: { ...EMPTY_MODE_RESULTS, [etaMode]: hit },
      });
      return;
    }

    const controller = new AbortController();
    inFlight = controller;
    const loading = loadingModeResult(request);
    set({
      ...projectActiveMode(loading),
      etaMode,
      modeResults: { ...EMPTY_MODE_RESULTS, [etaMode]: loading },
    });

    try {
      const response = await fetchRoutes(request, controller.signal);
      if (controller.signal.aborted) return;
      const ready: ModeRouteResult = {
        request,
        routes: response.routes,
        warnings: response.warnings,
        walkableArea: response.walkable_area,
        status: 'ready',
        error: null,
      };
      setCachedResult(request, ready);
      set((state) => ({
        modeResults: { ...state.modeResults, [etaMode]: ready },
        ...(state.etaMode === etaMode ? projectActiveMode(ready) : {}),
      }));
    } catch (err) {
      if (controller.signal.aborted) return;
      const failed: ModeRouteResult = {
        request,
        routes: [],
        warnings: [],
        // "No safe route" errors still carry the terrain that blocks the crew
        walkableArea: err instanceof RouteRequestError ? err.walkableArea : null,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      if (err instanceof RouteRequestError && err.status === 422) {
        setCachedResult(request, failed);
      }
      set((state) => ({
        modeResults: { ...state.modeResults, [etaMode]: failed },
        ...(state.etaMode === etaMode ? projectActiveMode(failed) : {}),
      }));
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  setModeRequests: async (requests, activeMode) => {
    inFlight?.abort();
    const otherMode: RouteEtaMode = activeMode === 'eva' ? 'rover' : 'eva';
    const cachedActive = getCachedResult(requests[activeMode]);
    const cachedOther = getCachedResult(requests[otherMode]);

    const initial: Record<RouteEtaMode, ModeRouteResult> = {
      eva:
        activeMode === 'eva'
          ? cachedActive
            ? { ...cachedActive, request: requests.eva }
            : loadingModeResult(requests.eva)
          : cachedOther
            ? { ...cachedOther, request: requests.eva }
            : loadingModeResult(requests.eva),
      rover:
        activeMode === 'rover'
          ? cachedActive
            ? { ...cachedActive, request: requests.rover }
            : loadingModeResult(requests.rover)
          : cachedOther
            ? { ...cachedOther, request: requests.rover }
            : loadingModeResult(requests.rover),
    };
    set({
      ...projectActiveMode(initial[activeMode]),
      etaMode: activeMode,
      modeResults: initial,
    });

    if (cachedActive && cachedOther) {
      inFlight = null;
      return;
    }

    const controller = new AbortController();
    inFlight = controller;

    const runMode = async (mode: RouteEtaMode) => {
      const request = requests[mode];
      try {
        const response = await fetchRoutes(request, controller.signal);
        if (controller.signal.aborted) return;
        const ready: ModeRouteResult = {
          request,
          routes: response.routes,
          warnings: response.warnings,
          walkableArea: response.walkable_area,
          status: 'ready',
          error: null,
        };
        setCachedResult(request, ready);
        set((state) => ({
          modeResults: { ...state.modeResults, [mode]: ready },
          ...(state.etaMode === mode ? projectActiveMode(ready) : {}),
        }));
      } catch (err) {
        if (controller.signal.aborted) return;
        const failed: ModeRouteResult = {
          request,
          routes: [],
          warnings: [],
          // "No safe route" errors still carry the terrain that blocks the crew
          walkableArea: err instanceof RouteRequestError ? err.walkableArea : null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
        if (err instanceof RouteRequestError && err.status === 422) {
          setCachedResult(request, failed);
        }
        set((state) => ({
          modeResults: { ...state.modeResults, [mode]: failed },
          ...(state.etaMode === mode ? projectActiveMode(failed) : {}),
        }));
      }
    };

    try {
      // Fetch the active mode first so the visible UI resolves without GIL/DEM contention,
      // and warms the backend's shared terrain cache for the secondary mode right after.
      if (!cachedActive) {
        await runMode(activeMode);
      }
      if (!controller.signal.aborted && !cachedOther) {
        await runMode(otherMode);
      }
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  setEtaMode: (mode) => {
    const result = get().modeResults[mode];
    if (result) {
      set({ etaMode: mode, ...projectActiveMode(result) });
    } else {
      set({ etaMode: mode });
    }
  },

  setHighlightedKind: (highlightedKind) => set({ highlightedKind }),

  setWalkableAreaVisible: (walkableAreaVisible) => set({ walkableAreaVisible }),

  clear: () => {
    inFlight?.abort();
    inFlight = null;
    set({
      ...projectActiveMode(null),
      modeResults: { ...EMPTY_MODE_RESULTS },
    });
  },
}));
