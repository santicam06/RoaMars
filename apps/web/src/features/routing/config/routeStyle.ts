import type { RouteKind } from '../types/routing';

export const ROUTE_STYLE: Record<RouteKind, { label: string; color: string }> = {
  shortest: { label: 'Shortest', color: '#38BDF8' },
  fastest: { label: 'Fastest', color: '#DC2626' },
  safest: { label: 'Safest', color: '#9333EA' },
};

/** Route shown in the planner summary until the user picks another one. */
export const DEFAULT_ROUTE_KIND: RouteKind = 'safest';
