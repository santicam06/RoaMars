import { useEffect } from 'react';
import type { MarsViewerController } from '../../../core/MarsViewerController';
import { useRoutingStore } from '../store/useRoutingStore';
import { RouteOverlayManager } from './RouteOverlayManager';

interface RouteLayerProps {
  controller: MarsViewerController | null;
}

/**
 * Renders safe routes from `useRoutingStore` onto the map. Has no UI of its own: requests come
 * from the route planner (see `useCampSafeRoute`).
 */
export function RouteLayer({ controller }: RouteLayerProps) {
  useEffect(() => {
    if (!controller) return;

    const manager = new RouteOverlayManager(controller);
    let last: {
      request: ReturnType<typeof useRoutingStore.getState>['request'];
      routes: ReturnType<typeof useRoutingStore.getState>['routes'];
      highlighted: ReturnType<typeof useRoutingStore.getState>['highlightedKind'];
      etaMode: ReturnType<typeof useRoutingStore.getState>['etaMode'];
      walkableArea: ReturnType<typeof useRoutingStore.getState>['walkableArea'];
      walkableAreaVisible: ReturnType<typeof useRoutingStore.getState>['walkableAreaVisible'];
    } | null = null;

    const draw = (state: ReturnType<typeof useRoutingStore.getState>) => {
      if (
        last &&
        last.request === state.request &&
        last.routes === state.routes &&
        last.highlighted === state.highlightedKind &&
        last.etaMode === state.etaMode &&
        last.walkableArea === state.walkableArea &&
        last.walkableAreaVisible === state.walkableAreaVisible
      ) {
        return;
      }
      last = {
        request: state.request,
        routes: state.routes,
        highlighted: state.highlightedKind,
        etaMode: state.etaMode,
        walkableArea: state.walkableArea,
        walkableAreaVisible: state.walkableAreaVisible,
      };
      manager.render(last);
    };

    draw(useRoutingStore.getState());
    const unsubscribe = useRoutingStore.subscribe(draw);
    return () => {
      unsubscribe();
      manager.destroy();
    };
  }, [controller]);

  return null;
}
