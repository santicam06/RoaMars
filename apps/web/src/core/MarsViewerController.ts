import * as Cesium from 'cesium';
import {
  CAMERA_BOUNDS,
  MARS_CIRCUMFERENCE_METERS,
  MARS_ELLIPSOID,
} from '../config/marsConfig';
import type { MarsViewMode } from '../store/useMapStore';
import { createVikingBasemapProvider } from './layers/createVikingBasemap';
import {
  NomenclatureManager,
  type NomenclatureLabelHit,
  type PickedMapFeature,
} from './layers/NomenclatureManager';
import {
  type MarsLatLon,
  normalizeLongitude180,
  pickMarsCoordinates,
  projectMarsLatLonToWindow,
} from './pickMarsCoordinates';

export type { PickedMapFeature };
export type CursorCoordinateListener = (coords: MarsLatLon | null) => void;
export type FeatureClickListener = (feature: PickedMapFeature) => void;
export type SurfaceClickListener = (coords: MarsLatLon) => void;
export type DragStateListener = (dragging: boolean) => void;

const CLICK_MAX_DRAG_DISTANCE_PX = 6;
const DRAG_START_DISTANCE_PX = 3;
const KINETIC_SAMPLE_WINDOW_MS = 90;
const KINETIC_MAX_IDLE_BEFORE_RELEASE_MS = 65;
const KINETIC_MIN_SPEED_PX_PER_SEC = 80;
const KINETIC_MAX_SPEED_PX_PER_SEC = 4500;
const KINETIC_STOP_SPEED_PX_PER_SEC = 8;
const KINETIC_DECAY_RATE = 6.3;
const CAMP_LABEL_MAX_ALTITUDE_METERS = 3_800_000;

const TAN_HALF_DEFAULT_FOV = Math.tan(Cesium.Math.toRadians(30)); // 60° reference horizontal FOV

interface VelocitySample {
  x: number;
  y: number;
  t: number;
}

/**
 * Unified imperative planetary map controller wrapping CesiumJS for both
 * 3D Globe (`SCENE3D`) and 2D Equirectangular Map (`SCENE2D`) views of Mars.
 *
 * Designed as the modular base template upon which Core Features 2–6
 * (Rover Street View dots, Outposts & EVA/Rover routes, Climate overlays,
 * Topography-aware routing, and Scientific Waypoint missions) mount cleanly.
 */
export class MarsViewerController {
  public readonly viewer: Cesium.Viewer;
  private readonly nomenclatureManager: NomenclatureManager;
  private readonly eventHandler: Cesium.ScreenSpaceEventHandler;
  private readonly overlayDataSources = new Map<string, Cesium.CustomDataSource>();
  private readonly cursorListeners = new Set<CursorCoordinateListener>();
  private readonly featureClickListeners = new Set<FeatureClickListener>();
  private readonly surfaceClickListeners = new Set<SurfaceClickListener>();
  private readonly dragStateListeners = new Set<DragStateListener>();
  private readonly entityFeatureCache = new WeakMap<
    Cesium.Entity,
    PickedMapFeature | null
  >();
  private readonly entityCoordsCache = new WeakMap<
    Cesium.Entity,
    MarsLatLon | null
  >();
  private readonly entityOccluder: Cesium.EllipsoidalOccluder;
  private readonly scratchPickWin = new Cesium.Cartesian2();
  private readonly scratchJulianDate = new Cesium.JulianDate();
  private readonly scratchEntityWorldPos = new Cesium.Cartesian3();
  private readonly scratchEntityCarto = new Cesium.Cartographic();
  private readonly scratchKineticDir = new Cesium.Cartesian3();

  private baseImageryLayer: Cesium.ImageryLayer | null = null;
  private zoomAnimationFrame: number | null = null;
  private cursorRafPending = false;
  private latestMousePosition = new Cesium.Cartesian2(-1, -1);
  private leftDownPosition: Cesium.Cartesian2 | null = null;
  private mouseInsideCanvas = false;
  private dragging = false;
  private pointerDownClientPos: { x: number; y: number } | null = null;
  private activeDragButton = -1;
  private readonly velocitySamples: VelocitySample[] = [];
  private kineticVxPx = 0;
  private kineticVyPx = 0;
  private kineticLastTime = 0;
  private handleMouseLeaveBound: () => void;
  private handlePointerDownBound: (event: PointerEvent) => void;
  private handlePointerMoveBound: (event: PointerEvent) => void;
  private handlePointerUpBound: (event: PointerEvent) => void;
  private handleWheelBound: () => void;
  private handleWindowBlurBound: () => void;
  private handleResizeBound: () => void;
  private removePreUpdateListener: (() => void) | null = null;

  constructor(
    container: HTMLElement,
    options?: {
      initialMode?: MarsViewMode;
      initialNomenclatureVisible?: boolean;
    }
  ) {
    const initialMode = options?.initialMode ?? '3d';
    const initialNomenclatureVisible = options?.initialNomenclatureVisible ?? true;

    const marsGlobe = new Cesium.Globe(MARS_ELLIPSOID);
    const marsProjection = new Cesium.GeographicProjection(MARS_ELLIPSOID);

    this.viewer = new Cesium.Viewer(container, {
      globe: marsGlobe,
      mapProjection: marsProjection,
      sceneMode:
        initialMode === '2d' ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D,
      mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
      orderIndependentTranslucency: false,
      baseLayer: false,
      skyBox: Cesium.SkyBox.createEarthSkyBox(),
      skyAtmosphere: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      useBrowserRecommendedResolution: false,
      msaaSamples: initialMode === '2d' ? 1 : 4,
      contextOptions: {
        webgl: {
          alpha: true,
          antialias: true,
        },
      },
    });

    const occluderEllipsoid = new Cesium.Ellipsoid(
      MARS_ELLIPSOID.radii.x - 1500,
      MARS_ELLIPSOID.radii.y - 1500,
      MARS_ELLIPSOID.radii.z - 1500
    );
    this.entityOccluder = new Cesium.EllipsoidalOccluder(
      occluderEllipsoid,
      this.viewer.camera.positionWC
    );

    this.configureVisualFidelity(initialMode);
    this.configureCameraController(initialMode);

    // Add verified NASA Mars Trek global Viking Color Mosaic WMTS basemap
    const vikingBasemap = createVikingBasemapProvider();
    this.baseImageryLayer = this.viewer.imageryLayers.addImageryProvider(vikingBasemap);

    // Set initial Mars Trek framing (3D starts centered on Olympus Mons camps; 2D keeps default framing)
    const initialLonDeg =
      initialMode === '3d'
        ? CAMERA_BOUNDS.initial3DLongitudeDeg
        : CAMERA_BOUNDS.initialLongitudeDeg;
    const initialLatDeg =
      initialMode === '3d'
        ? CAMERA_BOUNDS.initial3DLatitudeDeg
        : CAMERA_BOUNDS.initialLatitudeDeg;

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        initialLonDeg,
        initialLatDeg,
        CAMERA_BOUNDS.initialAltitudeMeters,
        MARS_ELLIPSOID
      ),
    });

    // Initialize Mars Nomenclature layer
    this.nomenclatureManager = new NomenclatureManager(
      this.viewer,
      () => this.getEffectiveAltitudeMeters(),
      initialNomenclatureVisible
    );
    void this.nomenclatureManager.load();

    // High-frequency pointer coordinate tracking (throttled via requestAnimationFrame)
    this.eventHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this.eventHandler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        this.mouseInsideCanvas = true;
        Cesium.Cartesian2.clone(movement.endPosition, this.latestMousePosition);
        this.scheduleCursorBroadcast();
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE
    );

    // Distinguish stationary feature clicks from camera drags
    this.eventHandler.setInputAction(
      (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        this.leftDownPosition = Cesium.Cartesian2.clone(click.position);
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN
    );

    this.eventHandler.setInputAction(
      (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const downPos = this.leftDownPosition;
        this.leftDownPosition = null;
        if (!downPos) return;
        if (this.featureClickListeners.size === 0 && this.surfaceClickListeners.size === 0) return;

        const dragDist = Cesium.Cartesian2.distance(downPos, click.position);
        if (dragDist > CLICK_MAX_DRAG_DISTANCE_PX) return;

        const picked = this.pickFeatureAt(click.position.x, click.position.y);
        if (picked) {
          for (const listener of this.featureClickListeners) {
            listener(picked);
          }
          return;
        }

        if (this.surfaceClickListeners.size === 0) return;
        const coords = pickMarsCoordinates(this.viewer, click.position);
        if (!coords) return;
        for (const listener of this.surfaceClickListeners) {
          listener(coords);
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_UP
    );

    // Also update cursor readout while zooming/panning if pointer remains stationary
    this.viewer.camera.changed.addEventListener(() => {
      if (this.mouseInsideCanvas) {
        this.scheduleCursorBroadcast();
      }
    });
    this.viewer.camera.percentageChanged = 0.01;

    const canvas = this.viewer.scene.canvas;

    this.handlePointerDownBound = (event: PointerEvent) => {
      this.cancel2DKineticPan();
      if (event.button === 0 || event.button === 1 || event.button === 2) {
        this.pointerDownClientPos = { x: event.clientX, y: event.clientY };
        this.activeDragButton = event.button;
        this.velocitySamples.length = 0;
        this.velocitySamples.push({
          x: event.clientX,
          y: event.clientY,
          t: performance.now(),
        });
      }
    };

    this.handlePointerMoveBound = (event: PointerEvent) => {
      if (event.buttons === 0) {
        if (this.dragging) {
          this.pointerDownClientPos = null;
          this.activeDragButton = -1;
          this.velocitySamples.length = 0;
          this.setDragging(false);
        }
        return;
      }

      if (!this.dragging && this.pointerDownClientPos) {
        const dist = Math.hypot(
          event.clientX - this.pointerDownClientPos.x,
          event.clientY - this.pointerDownClientPos.y
        );
        if (dist > DRAG_START_DISTANCE_PX) {
          this.setDragging(true);
        }
      }

      if (this.dragging && this.activeDragButton === 0) {
        const now = performance.now();
        this.velocitySamples.push({ x: event.clientX, y: event.clientY, t: now });
        while (
          this.velocitySamples.length > 2 &&
          now - this.velocitySamples[0].t > KINETIC_SAMPLE_WINDOW_MS
        ) {
          this.velocitySamples.shift();
        }
      }
    };

    this.handlePointerUpBound = (event: PointerEvent) => {
      const wasDragging = this.dragging;
      const button = this.activeDragButton;
      this.pointerDownClientPos = null;
      this.activeDragButton = -1;

      if (wasDragging) {
        if (button === 0 && this.viewer.scene.mode === Cesium.SceneMode.SCENE2D) {
          this.start2DKineticPanFromSamples();
        }
        this.setDragging(false);
      }

      if (event.type === 'pointercancel') {
        this.cancel2DKineticPan();
      }
      this.velocitySamples.length = 0;
    };

    this.handleWheelBound = () => {
      this.cancel2DKineticPan();
    };

    this.handleWindowBlurBound = () => {
      this.pointerDownClientPos = null;
      this.activeDragButton = -1;
      this.velocitySamples.length = 0;
      this.cancel2DKineticPan();
      this.setDragging(false);
    };

    this.handleResizeBound = () => {
      if (this.viewer.isDestroyed()) return;
      const dpr = window.devicePixelRatio || 1;
      const nextScale = Math.min(dpr, 2);
      if (this.viewer.resolutionScale !== nextScale) {
        this.viewer.resolutionScale = nextScale;
      }
    };

    this.handleMouseLeaveBound = () => {
      this.mouseInsideCanvas = false;
      if (!this.dragging) {
        canvas.style.cursor = '';
      }
      this.broadcastCursorCoordinates(null);
    };

    canvas.addEventListener('pointerdown', this.handlePointerDownBound, { passive: true });
    canvas.addEventListener('pointermove', this.handlePointerMoveBound, { passive: true });
    canvas.addEventListener('wheel', this.handleWheelBound, { passive: true });
    canvas.addEventListener('mouseleave', this.handleMouseLeaveBound);
    window.addEventListener('pointerup', this.handlePointerUpBound, { passive: true });
    window.addEventListener('pointercancel', this.handlePointerUpBound, { passive: true });
    window.addEventListener('blur', this.handleWindowBlurBound);
    window.addEventListener('resize', this.handleResizeBound, { passive: true });

    // Run 2D kinetic coasting + vertical bounds clamping BEFORE `globe.update`
    // and `preRender` so tile selection and label projection stay in lockstep.
    this.removePreUpdateListener = this.viewer.scene.preUpdate.addEventListener(() => {
      this.update2DKineticPan();
      this.clamp2DVerticalPan();
    });
  }

  /**
   * Applies Mars Trek visual fidelity overrides:
   * - Tycho-2 deep-space starfield skybox in 3D (matching `trek.nasa.gov/mars/`)
   * - Transparent space background in 2D so the starfield backdrop shows outside ±90°
   * - True Viking MDIM 2.1 coloration (no Earth blue atmosphere, no day/night shadows, no sun/moon glare)
   */
  private configureVisualFidelity(initialMode: MarsViewMode): void {
    const { scene } = this.viewer;
    const globe = scene.globe;

    const pixelRatio = window.devicePixelRatio || 1;
    this.viewer.resolutionScale = Math.min(pixelRatio, 2);

    // In 3D, opaque black clears behind the Tycho-2 SkyBox; in 2D, transparent clears reveal the starfield backdrop
    scene.backgroundColor =
      initialMode === '2d' ? Cesium.Color.TRANSPARENT : Cesium.Color.BLACK;
    if (scene.skyBox) scene.skyBox.show = true;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.fog.enabled = false;
    scene.highDynamicRange = false;

    // Critical: disable Earth Rayleigh ground atmosphere & day/night terminator
    // so colors match NASA Mars Trek (`trek.nasa.gov/mars/`) 1:1
    globe.showGroundAtmosphere = false;
    globe.enableLighting = false;
    globe.baseColor = Cesium.Color.fromCssColorString('#1c110c');
    globe.depthTestAgainstTerrain = false;
    globe.tileCacheSize = 600;
    globe.preloadAncestors = true;
    globe.preloadSiblings = true;

    this.applyModeRenderTuning(initialMode);

    // Disable FXAA post-processing blur; rely on native physical DPI + 3D MSAA
    scene.postProcessStages.fxaa.enabled = false;
  }

  /**
   * Tunes GPU multisampling and quadtree LOD per view mode:
   * - 2D mode uses `msaaSamples = 1` (flat orthographic tiles & SDF labels need no
   *   4x MSAA renderbuffer blit) and balanced `maximumScreenSpaceError = 1.75` so
   *   panning across Mars avoids 16x over-tessellation while keeping 1:1 tile sharpness.
   * - 3D mode enables 4x MSAA for a smooth planetary limb silhouette.
   */
  private applyModeRenderTuning(mode: MarsViewMode): void {
    const { scene } = this.viewer;
    scene.msaaSamples = mode === '2d' ? 1 : 4;
    scene.globe.maximumScreenSpaceError = mode === '2d' ? 1.75 : 1.5;
  }

  /**
   * Configures fluid Mars Trek–like drag inertia, scroll zoom, and mode-specific rotation locks.
   */
  private configureCameraController(mode: MarsViewMode): void {
    const ctrl = this.viewer.scene.screenSpaceCameraController;
    ctrl.minimumZoomDistance = CAMERA_BOUNDS.minZoomDistanceMeters;
    // In 2D mode, cap frustum width to Mars's exact 360° circumference (~21,339 km)
    // so full zoom-out shows one complete -180°..+180° map framed by black space above/below poles
    ctrl.maximumZoomDistance =
      mode === '2d'
        ? MARS_CIRCUMFERENCE_METERS
        : CAMERA_BOUNDS.maxZoomDistanceMeters;

    ctrl.inertiaSpin = 0.9;
    // In 2D mode, `1.0` bypasses Cesium's <400ms-only `maintainInertia` cutoff so our
    // velocity-windowed 2D kinetic glide delivers smooth Mars Trek–style momentum on every drag.
    ctrl.inertiaTranslate = mode === '2d' ? 1.0 : 0.9;
    ctrl.inertiaZoom = 0.8;
    ctrl.zoomFactor = 3.0;

    ctrl.enableInputs = true;
    ctrl.enableZoom = true;
    ctrl.enableTranslate = true;
    // In 2D mode, disable rotation so mouse drag strictly pans without twisting North off-vertical
    ctrl.enableRotate = mode === '3d';
    ctrl.enableTilt = mode === '3d';
    ctrl.enableLook = false;
  }

  /**
   * Computes unified effective camera altitude (meters) across both 3D perspective
   * and 2D orthographic frustums.
   */
  public getEffectiveAltitudeMeters(): number {
    const { scene, camera } = this.viewer;
    if (scene.mode === Cesium.SceneMode.SCENE2D) {
      const frustum = camera.frustum;
      if (
        frustum instanceof Cesium.OrthographicOffCenterFrustum &&
        typeof frustum.right === 'number' &&
        typeof frustum.left === 'number'
      ) {
        const widthMeters = Math.abs(frustum.right - frustum.left);
        return Cesium.Math.clamp(
          widthMeters / (2 * TAN_HALF_DEFAULT_FOV),
          CAMERA_BOUNDS.minZoomDistanceMeters,
          CAMERA_BOUNDS.maxZoomDistanceMeters
        );
      }
      return Cesium.Math.clamp(
        camera.getMagnitude() / (2 * TAN_HALF_DEFAULT_FOV),
        CAMERA_BOUNDS.minZoomDistanceMeters,
        CAMERA_BOUNDS.maxZoomDistanceMeters
      );
    }

    return Cesium.Math.clamp(
      camera.positionCartographic.height,
      CAMERA_BOUNDS.minZoomDistanceMeters,
      CAMERA_BOUNDS.maxZoomDistanceMeters
    );
  }

  /**
   * Samples the current viewport center's Martian `(lat, lon)` so switching
   * between 3D Globe and 2D Map keeps the user anchored on the exact same area.
   */
  public getViewportCenterLatLon(): MarsLatLon {
    const canvas = this.viewer.scene.canvas;
    const centerPx = new Cesium.Cartesian2(
      canvas.clientWidth / 2,
      canvas.clientHeight / 2
    );
    const picked = pickMarsCoordinates(this.viewer, centerPx);
    if (picked) {
      return picked;
    }

    const carto = this.viewer.camera.positionCartographic;
    return {
      lat: Cesium.Math.clamp(Cesium.Math.toDegrees(carto.latitude), -85, 85),
      lon: normalizeLongitude180(Cesium.Math.toDegrees(carto.longitude)),
    };
  }

  /**
   * Switches seamlessly between 3D Globe (`SCENE3D`) and 2D Map (`SCENE2D`),
   * preserving exact viewport center `(lat, lon)` and effective zoom scale.
   */
  public setViewMode(targetMode: MarsViewMode): void {
    if (this.viewer.isDestroyed()) return;
    this.cancelActiveZoomAnimation();
    this.cancel2DKineticPan();

    const currentSceneMode = this.viewer.scene.mode;
    const desiredSceneMode =
      targetMode === '2d' ? Cesium.SceneMode.SCENE2D : Cesium.SceneMode.SCENE3D;

    if (currentSceneMode === desiredSceneMode) {
      return;
    }

    const center = this.getViewportCenterLatLon();
    const effectiveAltitude = this.getEffectiveAltitudeMeters();

    if (targetMode === '2d') {
      this.viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
      this.viewer.scene.morphTo2D(0);
    } else {
      this.viewer.scene.backgroundColor = Cesium.Color.BLACK;
      this.viewer.scene.morphTo3D(0);
    }

    this.applyModeRenderTuning(targetMode);
    this.configureCameraController(targetMode);

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        center.lon,
        center.lat,
        effectiveAltitude,
        MARS_ELLIPSOID
      ),
    });
    this.clamp2DVerticalPan();

    this.nomenclatureManager.markDirty();
    if (this.mouseInsideCanvas) {
      this.scheduleCursorBroadcast();
    }
    this.viewer.scene.requestRender();
  }

  /**
   * Smoothly zooms in (+) in either 3D or 2D mode.
   */
  public zoomIn(): void {
    const currentAlt = this.getEffectiveAltitudeMeters();
    const availableDelta = currentAlt - CAMERA_BOUNDS.minZoomDistanceMeters;
    if (availableDelta <= 1) return;

    const totalZoomMeters = Math.min(currentAlt * 0.36, availableDelta);
    this.animateZoomStep(totalZoomMeters, 'in');
  }

  /**
   * Smoothly zooms out (-) in either 3D or 2D mode.
   */
  public zoomOut(): void {
    const is2D = this.viewer.scene.mode === Cesium.SceneMode.SCENE2D;
    const maxEffectiveAlt = is2D
      ? MARS_CIRCUMFERENCE_METERS / (2 * TAN_HALF_DEFAULT_FOV)
      : CAMERA_BOUNDS.maxZoomDistanceMeters;

    const currentAlt = this.getEffectiveAltitudeMeters();
    const availableDelta = maxEffectiveAlt - currentAlt;
    if (availableDelta <= 1) return;

    const totalZoomMeters = Math.min(currentAlt * 0.5, availableDelta);
    this.animateZoomStep(totalZoomMeters, 'out');
  }

  private animateZoomStep(totalMeters: number, direction: 'in' | 'out'): void {
    this.cancelActiveZoomAnimation();
    this.cancel2DKineticPan();

    const durationMs = 200;
    const startTime = performance.now();
    let appliedSoFar = 0;

    // In 2D mode, Cesium's camera.zoomIn/zoomOut expects orthographic frustum units
    const scaleMultiplier =
      this.viewer.scene.mode === Cesium.SceneMode.SCENE2D
        ? 2 * TAN_HALF_DEFAULT_FOV
        : 1;
    const scaledTotal = totalMeters * scaleMultiplier;

    const step = (now: number) => {
      if (this.viewer.isDestroyed()) return;

      const t = Math.min(1, (now - startTime) / durationMs);
      // Cubic ease-out
      const eased = 1 - Math.pow(1 - t, 3);
      const targetApplied = scaledTotal * eased;
      const frameDelta = targetApplied - appliedSoFar;
      appliedSoFar = targetApplied;

      if (frameDelta > 0) {
        if (direction === 'in') {
          this.viewer.camera.zoomIn(frameDelta);
        } else {
          this.viewer.camera.zoomOut(frameDelta);
        }
      }

      if (t < 1) {
        this.zoomAnimationFrame = requestAnimationFrame(step);
      } else {
        this.zoomAnimationFrame = null;
      }
    };

    this.zoomAnimationFrame = requestAnimationFrame(step);
  }

  private cancelActiveZoomAnimation(): void {
    if (this.zoomAnimationFrame !== null) {
      cancelAnimationFrame(this.zoomAnimationFrame);
      this.zoomAnimationFrame = null;
    }
  }

  /**
   * Flies the camera to a point on the Martian ellipsoid. Altitude is meters
   * above the surface in both the 3D globe and the 2D map.
   */
  public flyToLatLon(lonDeg: number, latDeg: number, altitudeMeters: number): void {
    if (this.viewer.isDestroyed()) return;
    this.cancelActiveZoomAnimation();
    this.cancel2DKineticPan();

    const altitude = Cesium.Math.clamp(
      altitudeMeters,
      CAMERA_BOUNDS.minZoomDistanceMeters,
      CAMERA_BOUNDS.maxZoomDistanceMeters
    );

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, altitude, MARS_ELLIPSOID),
      duration: 1.4,
    });
  }

  private setDragging(next: boolean): void {
    if (this.dragging === next) return;
    this.dragging = next;

    if (!this.viewer.isDestroyed()) {
      if (next) {
        this.viewer.scene.canvas.style.cursor = 'grabbing';
      } else if (this.mouseInsideCanvas) {
        this.scheduleCursorBroadcast();
      } else {
        this.viewer.scene.canvas.style.cursor = '';
      }
    }

    for (const listener of this.dragStateListeners) {
      listener(next);
    }
  }

  public isDragging(): boolean {
    return this.dragging;
  }

  public onDragStateChange(listener: DragStateListener): () => void {
    this.dragStateListeners.add(listener);
    return () => {
      this.dragStateListeners.delete(listener);
    };
  }

  private start2DKineticPanFromSamples(): void {
    if (this.velocitySamples.length < 2) return;

    const now = performance.now();
    const newest = this.velocitySamples[this.velocitySamples.length - 1];
    // If the user paused their pointer before lifting the button, stop cleanly on the pixel
    if (now - newest.t > KINETIC_MAX_IDLE_BEFORE_RELEASE_MS) {
      return;
    }

    let startIdx = 0;
    while (
      startIdx < this.velocitySamples.length - 1 &&
      now - this.velocitySamples[startIdx].t > KINETIC_SAMPLE_WINDOW_MS
    ) {
      startIdx++;
    }

    const oldest = this.velocitySamples[startIdx];
    const dtSec = (newest.t - oldest.t) / 1000;
    if (dtSec < 0.008) return;

    let vx = (newest.x - oldest.x) / dtSec;
    let vy = (newest.y - oldest.y) / dtSec;
    const speed = Math.hypot(vx, vy);
    if (speed < KINETIC_MIN_SPEED_PX_PER_SEC) return;

    if (speed > KINETIC_MAX_SPEED_PX_PER_SEC) {
      const scale = KINETIC_MAX_SPEED_PX_PER_SEC / speed;
      vx *= scale;
      vy *= scale;
    }

    this.kineticVxPx = vx;
    this.kineticVyPx = vy;
    this.kineticLastTime = now;
    this.viewer.scene.requestRender();
  }

  private cancel2DKineticPan(): void {
    this.kineticVxPx = 0;
    this.kineticVyPx = 0;
    this.kineticLastTime = 0;
  }

  /**
   * Frame-rate–independent exponential 2D kinetic pan glide matching Mars Trek / OpenLayers.
   * Overcomes Cesium's built-in 400ms press-duration cutoff so releasing any moving drag
   * glides smoothly to rest.
   */
  private update2DKineticPan(): void {
    if (this.kineticVxPx === 0 && this.kineticVyPx === 0) return;
    if (this.viewer.isDestroyed()) return;

    const { scene, camera } = this.viewer;
    if (scene.mode !== Cesium.SceneMode.SCENE2D) {
      this.cancel2DKineticPan();
      return;
    }

    const frustum = camera.frustum;
    const canvas = scene.canvas;
    if (
      canvas.clientWidth <= 0 ||
      canvas.clientHeight <= 0 ||
      !(frustum instanceof Cesium.OrthographicOffCenterFrustum) ||
      typeof frustum.right !== 'number' ||
      typeof frustum.left !== 'number' ||
      typeof frustum.top !== 'number' ||
      typeof frustum.bottom !== 'number'
    ) {
      this.cancel2DKineticPan();
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.kineticLastTime) / 1000));
    this.kineticLastTime = now;
    if (dt <= 0) return;

    const metersPerPxX = (frustum.right - frustum.left) / canvas.clientWidth;
    const metersPerPxY = (frustum.top - frustum.bottom) / canvas.clientHeight;
    const moveX = -this.kineticVxPx * metersPerPxX * dt;
    const moveY = this.kineticVyPx * metersPerPxY * dt;
    const distance = Math.hypot(moveX, moveY);

    if (distance > 0) {
      Cesium.Cartesian3.fromElements(
        moveX / distance,
        moveY / distance,
        0,
        this.scratchKineticDir
      );
      camera.move(this.scratchKineticDir, distance);
    }

    const decay = Math.exp(-KINETIC_DECAY_RATE * dt);
    this.kineticVxPx *= decay;
    this.kineticVyPx *= decay;

    if (Math.hypot(this.kineticVxPx, this.kineticVyPx) < KINETIC_STOP_SPEED_PX_PER_SEC) {
      this.cancel2DKineticPan();
    } else {
      scene.requestRender();
    }
  }

  /**
   * In 2D mode, locks vertical panning when the entire Martian map (-90°..+90°)
   * fits inside the viewport (allowing only horizontal dragging), and when zoomed
   * in, constrains vertical panning so the poles never scroll off into blank space.
   */
  private clamp2DVerticalPan(): void {
    if (this.viewer.isDestroyed()) return;
    const { scene, camera } = this.viewer;
    if (scene.mode !== Cesium.SceneMode.SCENE2D) return;

    const frustum = camera.frustum;
    if (
      !(frustum instanceof Cesium.OrthographicOffCenterFrustum) ||
      typeof frustum.top !== 'number'
    ) {
      return;
    }

    const halfMapHeight = Math.PI * 0.5 * MARS_ELLIPSOID.maximumRadius;
    const halfViewportHeight = Math.abs(frustum.top);
    const allowedMaxY = Math.max(0, halfMapHeight - halfViewportHeight);

    const clampedY = Cesium.Math.clamp(camera.position.y, -allowedMaxY, allowedMaxY);
    if (Math.abs(camera.position.y - clampedY) > 1e-6) {
      camera.position.y = clampedY;
      this.kineticVyPx = 0;
      void camera.positionWC;
    }
  }

  /**
   * Toggles the Mars Nomenclature label layer ON or OFF.
   */
  public setNomenclatureVisible(visible: boolean): void {
    this.nomenclatureManager.setVisible(visible);
  }

  /** Hit-tests a visible nomenclature label at a canvas-relative pixel. */
  public pickNomenclature(screenX: number, screenY: number): NomenclatureLabelHit | null {
    return this.nomenclatureManager.pickAt(screenX, screenY);
  }

  /** Drives the hover/selection enlarge-and-red treatment on one label. */
  public setNomenclatureLabelVisual(fid: number, scale: number, blueMix: number): void {
    this.nomenclatureManager.setLabelVisual(fid, scale, blueMix);
  }

  /** Enlarges named route labels slightly when pinned. */
  public setNamedRouteLabels(fids: number[]): void {
    this.nomenclatureManager.setRouteNames(fids);
  }

  /**
   * Subscribes to live cursor `(lat, lon)` updates (or `null` when over black space).
   * Returns an unsubscribe cleanup function.
   */
  public onCursorCoordinatesChange(listener: CursorCoordinateListener): () => void {
    this.cursorListeners.add(listener);
    return () => {
      this.cursorListeners.delete(listener);
    };
  }

  /**
   * Subscribes to clicks on interactive map features (visible nomenclature labels
   * or custom overlay markers). Returns an unsubscribe cleanup function.
   */
  public onFeatureClick(listener: FeatureClickListener): () => void {
    this.featureClickListeners.add(listener);
    return () => {
      this.featureClickListeners.delete(listener);
    };
  }

  /**
   * Clicks on the Martian surface that miss a named label or marker.
   * Used to drop a start or end pin the way Google Maps drops a pin.
   */
  public onSurfaceClick(listener: SurfaceClickListener): () => void {
    this.surfaceClickListeners.add(listener);
    return () => {
      this.surfaceClickListeners.delete(listener);
    };
  }

  /**
   * Resolves any clickable map feature at `(x, y)` CSS canvas pixels, prioritizing
   * visible planetary nomenclature labels (which render on top of map markers)
   * before camp / outpost overlay entities underneath.
   */
  public pickFeatureAt(x: number, y: number): PickedMapFeature | null {
    return this.inspectPointerTarget(x, y, true).feature;
  }

  private getEntityFeature(entity: Cesium.Entity): PickedMapFeature | null {
    if (this.entityFeatureCache.has(entity)) {
      return this.entityFeatureCache.get(entity) ?? null;
    }

    let resolved: PickedMapFeature | null = null;
    if (entity.properties) {
      Cesium.JulianDate.now(this.scratchJulianDate);
      const bag = entity.properties.getValue(this.scratchJulianDate) as
        | Record<string, unknown>
        | undefined;
      if (
        bag &&
        typeof bag.id === 'string' &&
        typeof bag.name === 'string' &&
        typeof bag.lat === 'number' &&
        typeof bag.lon === 'number'
      ) {
        resolved = {
          id: bag.id,
          name: bag.name,
          subtitle: typeof bag.subtitle === 'string' ? bag.subtitle : undefined,
          lat: bag.lat,
          lon: bag.lon,
          kind: bag.kind === 'outpost' ? 'outpost' : 'nomenclature',
        };
      }
    }

    this.entityFeatureCache.set(entity, resolved);
    return resolved;
  }

  private getEntityLatLon(entity: Cesium.Entity): MarsLatLon | null {
    if (this.entityCoordsCache.has(entity)) {
      return this.entityCoordsCache.get(entity) ?? null;
    }

    let resolved: MarsLatLon | null = null;
    if (entity.position) {
      Cesium.JulianDate.now(this.scratchJulianDate);
      const worldPos = entity.position.getValue(
        this.scratchJulianDate,
        this.scratchEntityWorldPos
      );
      if (worldPos) {
        const carto = MARS_ELLIPSOID.cartesianToCartographic(
          worldPos,
          this.scratchEntityCarto
        );
        if (carto) {
          resolved = {
            lat: Cesium.Math.toDegrees(carto.latitude),
            lon: normalizeLongitude180(Cesium.Math.toDegrees(carto.longitude)),
          };
        }
      }
    }

    this.entityCoordsCache.set(entity, resolved);
    return resolved;
  }

  private extractPickedFeature(picked: { id?: unknown } | undefined): PickedMapFeature | null {
    if (!picked?.id || typeof picked.id !== 'object') return null;

    if (picked.id instanceof Cesium.Entity) {
      return this.getEntityFeature(picked.id);
    }

    const candidate = picked.id as Record<string, unknown>;
    if (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.lat === 'number' &&
      typeof candidate.lon === 'number' &&
      (candidate.kind === 'outpost' || candidate.kind === 'nomenclature')
    ) {
      return candidate as unknown as PickedMapFeature;
    }

    return null;
  }

  /**
   * Hit-tests interactive map targets at `(x, y)` CSS canvas pixels.
   *
   * On high-frequency pointer hover (`allowGpuDrillPick = false`), this runs purely
   * in CPU screen space (~0.005 ms) and NEVER calls `scene.drillPick`, avoiding
   * synchronous WebGL `gl.readPixels` pipeline stalls during 2D/3D panning and hover.
   */
  private inspectPointerTarget(
    x: number,
    y: number,
    allowGpuDrillPick = false
  ): { feature: PickedMapFeature | null; hasInteractiveEntity: boolean } {
    if (this.viewer.isDestroyed()) {
      return { feature: null, hasInteractiveEntity: false };
    }

    const nomFeature = this.nomenclatureManager.pickAtWindowPosition(x, y);
    if (nomFeature) {
      return {
        feature: nomFeature,
        hasInteractiveEntity: true,
      };
    }

    const { scene, camera } = this.viewer;
    if (scene.mode === Cesium.SceneMode.SCENE3D) {
      this.entityOccluder.cameraPosition = camera.positionWC;
    }
    const effectiveAlt = this.getEffectiveAltitudeMeters();
    const showCampLabels = effectiveAlt <= CAMP_LABEL_MAX_ALTITUDE_METERS;

    let bestOutpost: { feature: PickedMapFeature; dist2: number } | null = null;
    let hasInteractiveMarker = false;

    for (const ds of this.overlayDataSources.values()) {
      if (!ds.show) continue;
      const entities = ds.entities.values;
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (!entity.isShowing) continue;

        const feature = this.getEntityFeature(entity);
        if (feature?.kind === 'outpost') {
          const win = projectMarsLatLonToWindow(
            this.viewer,
            feature.lon,
            feature.lat,
            this.scratchPickWin,
            x,
            this.entityOccluder
          );
          if (!win) continue;

          const dx = x - win.x;
          const dy = y - win.y;
          const dotDist2 = dx * dx + dy * dy;
          const hitDot = dotDist2 <= 14 * 14;
          const halfLabelW = Math.ceil(feature.name.length * 4.3) + 8;
          const hitLabel =
            showCampLabels &&
            Math.abs(dx) <= halfLabelW &&
            dy >= -30 &&
            dy <= -6;

          if (hitDot || hitLabel) {
            if (!bestOutpost || dotDist2 < bestOutpost.dist2) {
              bestOutpost = { feature, dist2: dotDist2 };
            }
          }
          continue;
        }

        if (
          !hasInteractiveMarker &&
          typeof entity.id === 'string' &&
          entity.id.startsWith('streetview:') &&
          entity.id !== 'streetview:cluster-label'
        ) {
          const coords = this.getEntityLatLon(entity);
          if (!coords) continue;
          const win = projectMarsLatLonToWindow(
            this.viewer,
            coords.lon,
            coords.lat,
            this.scratchPickWin,
            x,
            this.entityOccluder
          );
          if (win && Math.abs(x - win.x) <= 14 && Math.abs(y - win.y) <= 14) {
            hasInteractiveMarker = true;
          }
        }
      }
    }

    if (bestOutpost) {
      return {
        feature: bestOutpost.feature,
        hasInteractiveEntity: true,
      };
    }

    if (hasInteractiveMarker) {
      return {
        feature: null,
        hasInteractiveEntity: true,
      };
    }

    if (allowGpuDrillPick) {
      const drilled = this.viewer.scene.drillPick(
        new Cesium.Cartesian2(x, y),
        10,
        16,
        16
      ) as Array<{ id?: unknown }>;

      for (const item of drilled) {
        const feature = this.extractPickedFeature(item);
        if (feature?.kind === 'outpost') {
          return {
            feature,
            hasInteractiveEntity: true,
          };
        }
      }

      for (const item of drilled) {
        const feature = this.extractPickedFeature(item);
        if (feature) {
          return {
            feature,
            hasInteractiveEntity: true,
          };
        }
      }
    }

    return {
      feature: null,
      hasInteractiveEntity: false,
    };
  }

  private scheduleCursorBroadcast(): void {
    if (this.cursorRafPending) return;
    this.cursorRafPending = true;

    requestAnimationFrame(() => {
      this.cursorRafPending = false;
      if (this.viewer.isDestroyed()) return;
      const canvas = this.viewer.scene.canvas;
      if (!this.mouseInsideCanvas) {
        if (!this.dragging) {
          canvas.style.cursor = '';
        }
        this.broadcastCursorCoordinates(null);
        return;
      }
      const coords = pickMarsCoordinates(this.viewer, this.latestMousePosition);
      this.broadcastCursorCoordinates(coords);

      // Skip all hover hit-testing while actively dragging the map
      if (this.dragging) {
        canvas.style.cursor = 'grabbing';
        return;
      }

      const { hasInteractiveEntity } = this.inspectPointerTarget(
        this.latestMousePosition.x,
        this.latestMousePosition.y,
        false
      );
      canvas.style.cursor = hasInteractiveEntity ? 'pointer' : '';
    });
  }

  private broadcastCursorCoordinates(coords: MarsLatLon | null): void {
    for (const listener of this.cursorListeners) {
      listener(coords);
    }
  }

  /* ============================================================================
   * Extensibility Hooks for Core Features 2–6 (Rover Street View, Outposts,
   * Safe Routes, Climate Hazard Overlays, and Scientific Waypoint Missions)
   * ============================================================================ */

  /**
   * Registers or retrieves a named `CustomDataSource` channel so future features
   * (rover capture dots, habitats, EVA routes, hazard zones) mount cleanly onto
   * both 3D and 2D views without touching Core Feature 1.
   */
  public getOrCreateOverlayChannel(channelId: string): Cesium.CustomDataSource {
    const existing = this.overlayDataSources.get(channelId);
    if (existing) return existing;

    const ds = new Cesium.CustomDataSource(channelId);
    void this.viewer.dataSources.add(ds).then(() => {
      this.nomenclatureManager.raiseToTop();
      if (!this.viewer.isDestroyed()) {
        this.viewer.scene.requestRender();
      }
    });
    this.nomenclatureManager.raiseToTop();
    this.overlayDataSources.set(channelId, ds);
    return ds;
  }

  /** Swaps the globe imagery (Satellite or Terrain) and keeps every overlay above it. */
  public replaceBasemap(provider: Cesium.ImageryProvider): void {
    if (this.viewer.isDestroyed()) return;
    const layers = this.viewer.imageryLayers;
    if (this.baseImageryLayer) {
      layers.remove(this.baseImageryLayer, true);
    }
    this.baseImageryLayer = layers.addImageryProvider(provider, 0);
    this.viewer.scene.requestRender();
  }

  /**
   * Adds an imagery overlay layer (e.g., thermal/dust/climate data or regional CTX/HiRISE)
   * above the global Viking MDIM 2.1 basemap.
   */
  public addImageryOverlay(
    provider: Cesium.ImageryProvider,
    alpha = 1.0
  ): Cesium.ImageryLayer {
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = alpha;
    return layer;
  }

  /**
   * Converts any screen pixel coordinate to Martian `(lat, lon)` (reusable for
   * Street View pegman drop-targeting and interactive waypoint placement).
   */
  public screenToMarsCoordinates(x: number, y: number): MarsLatLon | null {
    return pickMarsCoordinates(this.viewer, new Cesium.Cartesian2(x, y));
  }

  public destroy(): void {
    this.cancelActiveZoomAnimation();
    this.cancel2DKineticPan();
    this.removePreUpdateListener?.();
    this.removePreUpdateListener = null;
    window.removeEventListener('pointerup', this.handlePointerUpBound);
    window.removeEventListener('pointercancel', this.handlePointerUpBound);
    window.removeEventListener('blur', this.handleWindowBlurBound);
    window.removeEventListener('resize', this.handleResizeBound);
    if (!this.viewer.isDestroyed()) {
      const canvas = this.viewer.scene.canvas;
      canvas.removeEventListener('pointerdown', this.handlePointerDownBound);
      canvas.removeEventListener('pointermove', this.handlePointerMoveBound);
      canvas.removeEventListener('wheel', this.handleWheelBound);
      canvas.removeEventListener('mouseleave', this.handleMouseLeaveBound);
    }
    this.eventHandler.destroy();
    this.nomenclatureManager.destroy();
    this.cursorListeners.clear();
    this.featureClickListeners.clear();
    this.surfaceClickListeners.clear();
    this.dragStateListeners.clear();
    this.overlayDataSources.clear();
    if (!this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
