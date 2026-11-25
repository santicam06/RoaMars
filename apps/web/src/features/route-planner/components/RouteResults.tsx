import { AlertTriangle, Loader2 } from 'lucide-react';
import { ROUTE_STYLE } from '../../routing/config/routeStyle';
import { formatDuration, formatKm } from '../../routing/map/RouteOverlayManager';
import { useRoutingStore } from '../../routing/store/useRoutingStore';
import { MAX_SLOPE_DEG } from '../map/useCampSafeRoute';
import type { TravelMode } from '../types';

interface RouteResultsProps {
  travelMode: TravelMode;
}

/**
 * Status and the shortest / fastest / safest MOLA routes for the planner's camp pair. Clicking a
 * route makes it the one summarised above and emphasised on the map.
 */
export function RouteResults({ travelMode }: RouteResultsProps) {
  const status = useRoutingStore((s) => s.status);
  const error = useRoutingStore((s) => s.error);
  const routes = useRoutingStore((s) => s.routes);
  const warnings = useRoutingStore((s) => s.warnings);
  const blockedTerrain = useRoutingStore((s) => s.walkableArea !== null);
  const highlightedKind = useRoutingStore((s) => s.highlightedKind);
  const setHighlightedKind = useRoutingStore((s) => s.setHighlightedKind);

  if (status === 'idle') return null;
  const limit = MAX_SLOPE_DEG[travelMode];

  return (
    <section aria-label="Safe routes" aria-live="polite" className="px-4 pt-1 pb-4 text-[14px]">
      {status === 'loading' && (
        <p className="flex items-center gap-2 text-[#5F6368]">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          Computing slope-safe routes (≤ {limit}°) over MOLA terrain…
        </p>
      )}

      {status === 'error' && (
        <div className="flex gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[#A50E0E]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p>{error}</p>
            {blockedTerrain && (
              <p className="mt-1 text-[13px] text-[#5F6368]">
                The traversable-area overlay shows the terrain that blocks this traverse.
                {travelMode === 'marswalk' && ' A rover can handle steeper grades.'}
              </p>
            )}
          </div>
        </div>
      )}

      {status === 'ready' && (
        <>
          <ul className="flex flex-col gap-2">
            {routes.map((route) => {
              const style = ROUTE_STYLE[route.kind];
              const active = route.kind === highlightedKind;
              const eta = travelMode === 'rover' ? route.eta_rover_s : route.eta_eva_s;
              return (
                <li key={route.kind}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setHighlightedKind(route.kind)}
                    className={`flex w-full flex-col gap-1 rounded-lg border border-l-4 px-3.5 py-2.5 text-left transition-all duration-150 cursor-pointer ${
                      active
                        ? 'border-[#F4C7C3] bg-[#FCE8E6]'
                        : 'border-[#E0E0E0] opacity-60 hover:bg-[#F1F3F4] hover:opacity-100'
                    }`}
                    style={{ borderLeftColor: style.color }}
                  >
                    <span className="flex w-full items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/20"
                        style={{ backgroundColor: style.color }}
                      />
                      <span className="flex-1 text-[16px] font-semibold">{style.label}</span>
                      <span
                        className={`text-[16px] tabular-nums ${
                          active ? 'font-semibold text-[#A50E0E]' : 'font-medium text-[#202124]'
                        }`}
                      >
                        {formatDuration(eta)}
                      </span>
                    </span>
                    <span className="pl-6 text-[14px] tabular-nums text-[#5F6368]">
                      {formatKm(route.distance_m)} · max {route.max_slope_deg.toFixed(0)}° · mean{' '}
                      {route.mean_slope_deg.toFixed(1)}°
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-2.5 text-[12.5px] text-[#5F6368]">
            Routes avoid MOLA terrain steeper than {limit}° (
            {travelMode === 'rover' ? 'rover' : 'Marswalk'} limit). Source: MGS MOLA DEM, NASA/GSFC.
          </p>
          {warnings.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5 text-[12.5px] text-[#B06000]">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
