/** Mirrors `apps/api/app/modules/routing/schemas.py`. */

export type RouteKind = 'shortest' | 'fastest' | 'safest';
export type RouteEtaMode = 'eva' | 'rover';

export interface LatLon {
  lat: number;
  /** East-positive longitude in [-180, 180] */
  lon: number;
}

export interface RouteRequest {
  source: LatLon;
  destination: LatLon;
  /** Optional override of the server's traversable slope limit (degrees) */
  max_slope_deg?: number;
}

export interface Route {
  kind: RouteKind;
  /** Path vertices as [lon, lat, elevation_m] (elevation relative to the Mars areoid) */
  coordinates: [number, number, number][];
  distance_m: number;
  eta_rover_s: number;
  eta_eva_s: number;
  max_slope_deg: number;
  mean_slope_deg: number;
}

export interface RouteResponse {
  routes: Route[];
  dem_resolution_m: number;
  max_slope_deg: number;
  warnings: string[];
  walkable_area: WalkableArea;
}

/**
 * Per-pixel terrain codes in `WalkableArea.cells`. A pixel's slope is its steepest step to any
 * of its 8 neighbours.
 */
export const WALKABLE_CELL = {
  /** Outside the planning radius (or no DEM data) */
  outside: '0',
  /** Reachable, slope <= `gentle_max_slope_deg` */
  gentle: '1',
  /** Reachable, slope between `gentle_max_slope_deg` and the limit */
  moderate: '2',
  /** Slope over the limit: off-limits for routing */
  steep: '3',
  /** Within the limit, but walled off from the destination by steep terrain */
  unreachable: '4',
} as const;

/**
 * DEM-pixel grid of terrain classes around the destination.
 * `cells` is row-major from the north-west corner, one character per pixel
 * (see `WALKABLE_CELL`).
 */
export interface WalkableArea {
  west: number;
  south: number;
  east: number;
  north: number;
  rows: number;
  cols: number;
  gentle_max_slope_deg: number;
  max_slope_deg: number;
  cells: string;
}
