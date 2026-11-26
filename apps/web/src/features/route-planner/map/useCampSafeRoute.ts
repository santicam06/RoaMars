import { useEffect } from 'react';
import { useNomenclatureSelection } from '../../../components/Locations/useNomenclatureSelection';
import { useOutpostSelection } from '../../../components/Outposts/useOutpostSelection';
import { useRoutingStore } from '../../routing/store/useRoutingStore';
import type { LatLon } from '../../routing/types/routing';
import { useRoutePlannerStore } from '../store/useRoutePlannerStore';
import { isCampRouteLocation, type RouteLocation, type TravelMode } from '../types';

/** Steepest grade each travel mode may traverse (same limits as the Olympus rehearsal router). */
export const MAX_SLOPE_DEG: Record<TravelMode, number> = {
  marswalk: 15,
  rover: 25,
};

/**
 * Requests MOLA slope-safe routes (`POST /api/routes`) whenever the planner holds two different
 * crew camps, and clears them when either endpoint is removed or the planner closes.
 * Generating a route also closes the camp / place details card so the lateral bar shows only
 * the route; clicking a camp or place afterwards reopens its card as usual.
 */
export function useCampSafeRoute(): void {
  const source = useRoutePlannerStore((state) => state.source);
  const destination = useRoutePlannerStore((state) => state.destination);
  const travelMode = useRoutePlannerStore((state) => state.travelMode);

  useEffect(() => {
    const routing = useRoutingStore.getState();
    if (
      !isCampRouteLocation(source) ||
      !isCampRouteLocation(destination) ||
      source.id === destination.id
    ) {
      if (routing.request) routing.clear();
      return;
    }
    useOutpostSelection.getState().setOpen(false);
    useNomenclatureSelection.getState().setHit(null);
    const activeMode = useRoutePlannerStore.getState().travelMode === 'rover' ? 'rover' : 'eva';
    const src = toLatLon(source);
    const dst = toLatLon(destination);
    void routing.setModeRequests(
      {
        eva: { source: src, destination: dst, max_slope_deg: MAX_SLOPE_DEG.marswalk },
        rover: { source: src, destination: dst, max_slope_deg: MAX_SLOPE_DEG.rover },
      },
      activeMode
    );
  }, [source, destination]);

  useEffect(() => {
    useRoutingStore.getState().setEtaMode(travelMode === 'rover' ? 'rover' : 'eva');
  }, [travelMode]);

  // Leave no route behind when the planner unmounts
  useEffect(() => () => useRoutingStore.getState().clear(), []);
}

function toLatLon(location: RouteLocation): LatLon {
  // The API expects east-positive longitudes in [-180, 180]
  const lon = ((((location.lon + 180) % 360) + 360) % 360) - 180;
  return { lat: location.lat, lon };
}
