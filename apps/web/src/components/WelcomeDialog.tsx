import { useEffect, useRef, useState } from 'react';

const APP_NAME = 'RoaMars';

/**
 * Start-up welcome screen: blurs the map while the red title rises into view, until the user
 * clicks Start. Shown on every page load. Animations live in index.css (`welcome-*`).
 */
export function WelcomeDialog() {
  const [open, setOpen] = useState(true);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) startRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-black/40 p-4 text-center backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      aria-describedby="welcome-description"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 h-64 w-64 bg-[radial-gradient(circle_at_top_right,rgba(0,0,0,1)_0%,rgba(0,0,0,0.92)_48%,transparent_78%)]"
      />
      <img
        src="/RoaMars-Logo.png"
        alt="RoaMars logo"
        className="welcome-fade-up pointer-events-none absolute top-3 right-3 h-28 w-28 rounded-full bg-black object-contain drop-shadow-lg select-none sm:h-36 sm:w-36"
      />
      <div>
        <p className="font-orbitron welcome-fade-up text-[13px] font-bold tracking-[0.4em] text-red-300 uppercase">
          Welcome to
        </p>
        {/* Clipping mask: the title slides up from underneath its own baseline. */}
        <div className="overflow-hidden pt-2 pb-1">
          <h1
            id="welcome-title"
            className="font-orbitron welcome-rise text-[56px] leading-none font-black tracking-[0.06em] text-red-600 uppercase drop-shadow-lg sm:text-[80px]"
          >
            {APP_NAME}
          </h1>
        </div>
        <p
          id="welcome-description"
          className="welcome-fade-up mt-3 text-[15px] text-red-200 drop-shadow [animation-delay:600ms]"
        >
          Plan safe routes across the surface of Mars.
        </p>
      </div>
      <div className="welcome-fade-up [animation-delay:800ms]">
        <button
          ref={startRef}
          type="button"
          onClick={() => setOpen(false)}
          className="pixel-start group relative mt-8 flex h-14 w-60 cursor-pointer items-center justify-center outline-none [--rover-travel:184px]"
        >
          {/* Rover parked on top of the button; drives to the right on hover. */}
          <span className="pixel-rover pointer-events-none absolute -top-[34px] left-1">
            <PixelRover />
          </span>
          <span className="pixel-button font-pixel flex h-full w-full items-center justify-center bg-red-700 text-[16px] text-white transition-colors group-hover:bg-red-600 group-active:translate-y-0.5">
            START
          </span>
        </button>
      </div>
    </div>
  );
}

/** 16×10 pixel-art rover (3 px per pixel). */
function PixelRover() {
  const px = (x: number, y: number, w: number, h: number, fill: string) => (
    <rect key={`${x}-${y}-${fill}`} x={x} y={y} width={w} height={h} fill={fill} />
  );
  const white = '#ffffff';
  const grey = '#a3a3a3';
  const dark = '#262626';
  const red = '#b91c1c';

  return (
    <svg
      width={48}
      height={30}
      viewBox="0 0 16 10"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="pixel-rover-body block"
    >
      {/* Mast and camera head */}
      {px(2, 0, 3, 1, white)}
      {px(4, 0, 1, 1, red)}
      {px(3, 1, 1, 2, grey)}
      {/* Solar deck */}
      {px(5, 2, 10, 1, grey)}
      {/* Body */}
      {px(1, 3, 14, 3, white)}
      {px(1, 4, 14, 1, red)}
      {px(13, 3, 2, 1, grey)}
      {/* Suspension */}
      {px(2, 6, 12, 1, dark)}
      {/* Wheels */}
      {px(1, 7, 3, 3, dark)}
      {px(6, 7, 3, 3, dark)}
      {px(11, 7, 3, 3, dark)}
      {px(2, 8, 1, 1, grey)}
      {px(7, 8, 1, 1, grey)}
      {px(12, 8, 1, 1, grey)}
    </svg>
  );
}
