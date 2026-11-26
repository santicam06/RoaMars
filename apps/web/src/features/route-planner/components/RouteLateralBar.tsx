import { useRef, useState, type PointerEvent } from 'react';
import { ArrowUpDown, GripHorizontal, MapPin, X } from 'lucide-react';
import { LocationDetailsPanel } from '../../../components/Locations/LocationDetailsPanel';
import { OlympusRehearsal } from '../../../components/Outposts/OlympusRehearsal';
import type { MarsViewerController } from '../../../core/MarsViewerController';
import { useNomenclatureSelection } from '../../../components/Locations/useNomenclatureSelection';
import { DEFAULT_ROUTE_KIND } from '../../routing/config/routeStyle';
import { formatDuration, formatKm } from '../../routing/map/RouteOverlayManager';
import { shortestEtaSeconds, useRoutingStore } from '../../routing/store/useRoutingStore';
import { useCampSafeRoute } from '../map/useCampSafeRoute';
import { useRoutePlannerStore } from '../store/useRoutePlannerStore';
import type { TravelMode } from '../types';
import { AstronautIcon, MarsRoverIcon } from './icons/TravelModeIcons';
import { LocationInputBox } from './LocationInputBox';
import { RouteDetails } from './RouteDetails';
import { RouteResults } from './RouteResults';

const MIN_TOP_SECTION_PX = 140;
const MIN_BOTTOM_SECTION_PX = 140;

interface RouteLateralBarProps {
  controller: MarsViewerController | null;
}

export function RouteLateralBar({ controller }: RouteLateralBarProps) {
  const asideRef = useRef<HTMLElement | null>(null);
  const topSectionRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [topHeightPx, setTopHeightPx] = useState<number | null>(null);
  const isOpen = useRoutePlannerStore((s) => s.isOpen);
  const isRouteCalculatorOpen = useRoutePlannerStore((s) => s.isRouteCalculatorOpen);
  const travelMode = useRoutePlannerStore((s) => s.travelMode);
  const source = useRoutePlannerStore((s) => s.source);
  const destination = useRoutePlannerStore((s) => s.destination);
  const activeInputSlot = useRoutePlannerStore((s) => s.activeInputSlot);
  useCampSafeRoute();
  // While a camp-to-camp route is shown, the bar lists only the routes (no camp/place details card)
  const hasRoute = useRoutingStore((s) => s.request !== null);
  const routesReady = useRoutingStore((s) => s.status === 'ready');
  const selectedRoute = useRoutingStore(
    (s) => s.routes.find((r) => r.kind === (s.highlightedKind ?? DEFAULT_ROUTE_KIND)) ?? null
  );
  const marswalkEtaSeconds = useRoutingStore((s) =>
    shortestEtaSeconds(s.modeResults.eva?.routes ?? [], 'eva')
  );
  const roverEtaSeconds = useRoutingStore((s) =>
    shortestEtaSeconds(s.modeResults.rover?.routes ?? [], 'rover')
  );
  const marswalkEta = marswalkEtaSeconds !== null ? formatDuration(marswalkEtaSeconds) : null;
  const roverEta = roverEtaSeconds !== null ? formatDuration(roverEtaSeconds) : null;

  const setOpen = useRoutePlannerStore((s) => s.setOpen);
  const setTravelMode = useRoutePlannerStore((s) => s.setTravelMode);
  const setSource = useRoutePlannerStore((s) => s.setSource);
  const setDestination = useRoutePlannerStore((s) => s.setDestination);
  const swapLocations = useRoutePlannerStore((s) => s.swapLocations);
  const setActiveInputSlot = useRoutePlannerStore((s) => s.setActiveInputSlot);
  const selectedPlace = useNomenclatureSelection((s) => s.hit);
  const clearSelectedPlace = useNomenclatureSelection((s) => s.setHit);

  const handleCloseLateralBar = () => {
    setOpen(false);
    clearSelectedPlace(null);
  };

  const modes: Array<{
    id: TravelMode;
    label: string;
    eta: string | null;
    Icon: typeof AstronautIcon;
  }> = [
    {
      id: 'marswalk',
      label: 'Marswalk',
      eta: marswalkEta,
      Icon: AstronautIcon,
    },
    {
      id: 'rover',
      label: 'Rover',
      eta: roverEta,
      Icon: MarsRoverIcon,
    },
  ];

  const formattedDistance = selectedRoute ? formatKm(selectedRoute.distance_m) : '-- km';

  const handleSeparatorPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const topEl = topSectionRef.current;
    if (!topEl) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      startY: e.clientY,
      startHeight: topEl.getBoundingClientRect().height,
    };
  };

  const handleSeparatorPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    const asideEl = asideRef.current;
    if (!drag || !asideEl) return;
    const maxTop = Math.max(
      MIN_TOP_SECTION_PX,
      asideEl.getBoundingClientRect().height - 56 - MIN_BOTTOM_SECTION_PX
    );
    const next = Math.min(maxTop, Math.max(MIN_TOP_SECTION_PX, drag.startHeight + (e.clientY - drag.startY)));
    setTopHeightPx(next);
  };

  const handleSeparatorPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current) {
      dragStateRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  return (
    <aside
      ref={asideRef}
      aria-label="Martian traversal route planner"
      aria-hidden={!isOpen}
      className={`pointer-events-auto fixed top-0 left-0 z-20 flex h-full w-[475px] max-w-[calc(100vw-3rem)] flex-col bg-white text-[#202124] transition-[transform,opacity] duration-250 ease-out ${
        isOpen
          ? 'translate-x-0 opacity-100 shadow-[2px_0_12px_rgba(0,0,0,0.25)]'
          : '-translate-x-full opacity-0 pointer-events-none'
      }`}
    >
      {/* Room for the map search bar, which sits on top of this bar (Google Maps style) */}
      <div className="h-14 shrink-0" aria-hidden="true" />
      {isRouteCalculatorOpen ? (
        <>
          <div
            ref={topSectionRef}
            style={topHeightPx !== null ? { height: `${topHeightPx}px` } : undefined}
            className="shrink-0 overflow-y-auto"
          >
            {/* Top section: Travel modes (Marswalk & Rover) + ETA below each icon + Close button */}
          <div className="px-4 pt-3.5 pb-4">
            <div className="relative flex items-start justify-center">
              <div
                role="radiogroup"
                aria-label="Surface travel mode"
                className="flex items-start gap-5"
              >
                {modes.map(({ id, label, eta, Icon }) => {
                  const active = travelMode === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      title={label}
                      onClick={() => setTravelMode(id)}
                      className="group flex flex-col items-center gap-1 cursor-pointer focus:outline-none"
                    >
                      <span
                        className={`flex h-9 w-13 items-center justify-center rounded-full transition-colors duration-150 ${
                          active
                            ? 'bg-[#FAD2CF] text-[#A50E0E]'
                            : 'bg-transparent text-[#3C4043] group-hover:bg-[#FCE8E6] group-hover:text-[#B3261E]'
                        }`}
                      >
                        <Icon className="h-[25px] w-[25px]" />
                      </span>
                      <span
                        className={`text-[13px] leading-tight tabular-nums transition-colors duration-150 ${
                          active
                            ? 'font-semibold text-[#A50E0E]'
                            : 'font-normal text-[#5F6368] group-hover:text-[#B3261E]'
                        }`}
                      >
                        {eta ?? '—'}
                      </span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleCloseLateralBar}
                title="Close lateral bar"
                aria-label="Close lateral bar"
                className="absolute top-0.5 right-0 flex h-9 w-9 items-center justify-center rounded-full text-[#3C4043] transition-colors duration-150 hover:bg-[#FCE8E6] hover:text-[#B3261E] cursor-pointer"
              >
                <X className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>

            {/* Distance readout below modes in a bigger font size */}
            <div className="mt-2.5 mb-3.5 text-center">
              <span
                aria-label="Traversal distance in kilometers"
                className="text-[26px] font-semibold tracking-tight text-[#202124] tabular-nums"
              >
                {formattedDistance}
              </span>
            </div>

            {/* Source & Destination boxes + route track icons + Interchange (swap) button */}
            <div className="flex items-center gap-2.5">
              {/* Left Google Maps origin/connector/destination icon column */}
              <div
                aria-hidden="true"
                className="flex w-5 shrink-0 flex-col items-center py-2.5"
              >
                <span className="h-3.5 w-3.5 rounded-full border-[2px] border-[#3C4043] bg-white" />
                <div className="my-1.5 flex flex-col items-center gap-[3px]">
                  <span className="h-[3px] w-[3px] rounded-full bg-[#70757A]" />
                  <span className="h-[3px] w-[3px] rounded-full bg-[#70757A]" />
                  <span className="h-[3px] w-[3px] rounded-full bg-[#70757A]" />
                </div>
                <MapPin className="h-[18px] w-[18px] text-[#D93025]" strokeWidth={2.2} />
              </div>

              {/* Center Source & Destination inputs */}
              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                <LocationInputBox
                  label="Source location"
                  placeholder="Choose starting camp..."
                  value={source}
                  isActiveSlot={activeInputSlot === 'source'}
                  onFocusSlot={() => setActiveInputSlot('source')}
                  onSelect={setSource}
                />
                <LocationInputBox
                  label="Destination location"
                  placeholder="Choose destination camp..."
                  value={destination}
                  isActiveSlot={activeInputSlot === 'destination'}
                  onFocusSlot={() => setActiveInputSlot('destination')}
                  onSelect={setDestination}
                />
              </div>

              {/* Right Interchange button to swap Source and Destination */}
              <button
                type="button"
                onClick={swapLocations}
                title="Swap starting point and destination"
                aria-label="Swap starting point and destination"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#3C4043] transition-colors duration-150 hover:bg-[#FCE8E6] hover:text-[#B3261E] active:bg-[#FAD2CF] cursor-pointer"
              >
                <ArrowUpDown className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
            </div>
          </div>

            <RouteResults travelMode={travelMode} />
          </div>

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize route planner and details sections"
            title="Drag up or down to resize"
            onPointerDown={handleSeparatorPointerDown}
            onPointerMove={handleSeparatorPointerMove}
            onPointerUp={handleSeparatorPointerUp}
            onPointerCancel={handleSeparatorPointerUp}
            className="group flex h-3.5 w-full shrink-0 cursor-ns-resize touch-none select-none items-center justify-center border-y border-red-700/20 bg-red-50 transition-colors hover:bg-red-100"
          >
            <GripHorizontal
              className="h-3.5 w-3.5 text-[#A50E0E]/60 transition-colors group-hover:text-[#A50E0E]"
              aria-hidden="true"
            />
          </div>
        </>
      ) : (
        <div className="flex items-center justify-end border-b border-red-700/20 px-3 py-2">
          <button
            type="button"
            onClick={handleCloseLateralBar}
            title="Close lateral bar"
            aria-label="Close lateral bar"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#3C4043] transition-colors duration-150 hover:bg-[#FCE8E6] hover:text-[#B3261E] cursor-pointer"
          >
            <X className="h-5 w-5" strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto bg-white">
        {hasRoute && routesReady && selectedRoute && <RouteDetails route={selectedRoute} />}
        {!hasRoute && (
          <LocationDetailsPanel
            hit={selectedPlace}
            onClose={() => clearSelectedPlace(null)}
          />
        )}
        <OlympusRehearsal
          controller={controller}
          hidePanel={hasRoute || Boolean(selectedPlace)}
        />
      </div>
    </aside>
  );
}
