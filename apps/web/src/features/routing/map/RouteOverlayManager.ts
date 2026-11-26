import * as Cesium from 'cesium';
import { MARS_ELLIPSOID } from '../../../config/marsConfig';
import type { MarsViewerController } from '../../../core/MarsViewerController';
import { projectMarsLatLonToWindow } from '../../../core/pickMarsCoordinates';
import { ROUTE_STYLE } from '../config/routeStyle';
import { WALKABLE_CELL_RGBA } from '../config/walkableAreaStyle';
import {
  type LatLon,
  type Route,
  type RouteEtaMode,
  type RouteKind,
  type RouteRequest,
  type WalkableArea,
} from '../types/routing';

const OVERLAY_CHANNEL_ID = 'routing';
const LABEL_FONT = '500 12px "JetBrains Mono", monospace';
const LABEL_BG_PADDING_X = 8;
const LABEL_BG_PADDING_Y = 5;
const LABEL_BOX_HEIGHT_PX = 26;
/** Minimum vertical & horizontal screen-space gap between route label boxes */
const MIN_LABEL_GAP_Y_PX = 18;
const MIN_LABEL_GAP_X_PX = 20;
/** Clearance box around the A/B endpoint pins so route labels do not cover them */
const PIN_CLEARANCE_W_PX = 56;
const PIN_CLEARANCE_H_PX = 48;
/** Number of evenly spaced interior candidates sampled per route for anchor placement */
const ANCHOR_CANDIDATE_COUNT = 13;
const ANCHOR_MIN_FRACTION = 0.2;
const ANCHOR_MAX_FRACTION = 0.8;
const ROUTE_KIND_ORDER: Record<RouteKind, number> = {
  shortest: 0,
  fastest: 1,
  safest: 2,
};
/** Each DEM pixel is drawn as an N×N block so cell edges stay crisp when resampled */
const CELL_UPSCALE = 4;
const WALKABLE_LAYER_ALPHA = 0.85;
/** Route labels stay visible from far enough out to frame long camp-to-camp traverses */
const LABEL_MAX_DISTANCE_M = 5_000_000;
/** Extra margin around the framed route, as a fraction of its extent */
const FRAME_PADDING = 0.25;
/** Minimum framed half-extent (degrees of latitude), so short routes are not over-zoomed */
const FRAME_MIN_HALF_DEG = 0.25;

interface RouteLabelRecord {
  kind: RouteKind;
  lon: number;
  lat: number;
  entity: Cesium.Entity;
  widthPx: number;
  heightPx: number;
  lastOffsetX: number;
  lastOffsetY: number;
}

export interface RouteOverlayState {
  request: RouteRequest | null;
  routes: Route[];
  highlighted: RouteKind | null;
  etaMode: RouteEtaMode;
  walkableArea: WalkableArea | null;
  walkableAreaVisible: boolean;
}

/**
 * Draws the walkable-area overlay, the source/destination pins and the shortest / fastest /
 * safest routes on both the 3D globe and the 2D map.
 */
export class RouteOverlayManager {
  private readonly channel: Cesium.CustomDataSource;
  private readonly routeEntities = new Map<RouteKind, Cesium.Entity>();
  private readonly routeLabels: RouteLabelRecord[] = [];
  private readonly pinPoints: LatLon[] = [];
  private readonly scratchScreen = new Cesium.Cartesian2();
  private removePreRenderListener: (() => void) | null = null;
  private lastFramedRequest: RouteRequest | null = null;
  /** Imagery layer showing the walkable area, and the grid it was drawn from */
  private walkableLayer: { area: WalkableArea; layer: Cesium.ImageryLayer } | null = null;

  constructor(private readonly controller: MarsViewerController) {
    this.channel = controller.getOrCreateOverlayChannel(OVERLAY_CHANNEL_ID);
    this.removePreRenderListener = controller.viewer.scene.preRender.addEventListener(() => {
      this.resolveLabelCollisions();
    });
  }

  /** Redraws everything for the given routing state. */
  public render(state: RouteOverlayState) {
    const { request, routes, highlighted, etaMode, walkableArea, walkableAreaVisible } = state;
    this.channel.entities.removeAll();
    this.routeEntities.clear();
    this.routeLabels.length = 0;
    this.pinPoints.length = 0;
    this.syncWalkableLayer(request && walkableAreaVisible ? walkableArea : null);
    if (!request) return this.requestRender();

    // Pick geographically separated interior anchors along each route before drawing
    const anchors = chooseLabelAnchors(routes, [request.source, request.destination]);

    // Draw the highlighted route last so it sits on top
    const hasSelection = highlighted !== null && routes.some((r) => r.kind === highlighted);
    const ordered = [...routes].sort(
      (a, b) => Number(a.kind === highlighted) - Number(b.kind === highlighted)
    );
    for (const route of ordered) {
      const isSelected = route.kind === highlighted;
      const dimmed = hasSelection && !isSelected;
      const fallback = route.coordinates[Math.floor(route.coordinates.length / 2)];
      const anchor: [number, number] = anchors.get(route.kind) ?? [fallback[0], fallback[1]];
      this.addRoute(route, isSelected, dimmed, etaMode, anchor);
    }
    this.addPin(request.source, 'A', '#FFFFFF');
    this.addPin(request.destination, 'B', '#B91C1C');
    this.pinPoints.push(request.source, request.destination);

    // Frame once per request, also when there is no route but the blocking terrain is shown
    if ((routes.length > 0 || walkableArea) && this.lastFramedRequest !== request) {
      this.lastFramedRequest = request;
      this.frame(request, routes);
    }
    this.resolveLabelCollisions();
    this.requestRender();
  }

  private addRoute(
    route: Route,
    highlighted: boolean,
    dimmed: boolean,
    etaMode: RouteEtaMode,
    anchor: [number, number]
  ) {
    const style = ROUTE_STYLE[route.kind];
    const baseColor = Cesium.Color.fromCssColorString(style.color);
    const lineColor = dimmed ? baseColor.withAlpha(0.48) : baseColor;
    const outlineColor = Cesium.Color.BLACK.withAlpha(dimmed ? 0.3 : 0.65);
    const positions = route.coordinates.map(([lon, lat]) =>
      Cesium.Cartesian3.fromDegrees(lon, lat, 0, MARS_ELLIPSOID)
    );

    const entity = this.channel.entities.add({
      name: `${style.label} route`,
      polyline: {
        positions,
        width: highlighted ? 6 : 4,
        clampToGround: true,
        material: new Cesium.PolylineOutlineMaterialProperty({
          color: lineColor,
          outlineColor,
          outlineWidth: 1,
        }),
      },
    });
    this.routeEntities.set(route.kind, entity);

    const [lon, lat] = anchor;
    const labelOutline = baseColor.darken(0.4, new Cesium.Color());
    const etaSeconds = etaMode === 'rover' ? route.eta_rover_s : route.eta_eva_s;
    const text = `${style.label} · ${formatKm(route.distance_m)} · ${formatDuration(etaSeconds)}`;
    const widthPx = measureLabelWidthPx(text);
    const labelEntity = this.channel.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0, MARS_ELLIPSOID),
      label: {
        text,
        font: LABEL_FONT,
        fillColor: dimmed ? Cesium.Color.WHITE.withAlpha(0.6) : Cesium.Color.WHITE,
        outlineColor: dimmed ? labelOutline.withAlpha(0.5) : labelOutline,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(dimmed ? 0.35 : 0.65),
        backgroundPadding: new Cesium.Cartesian2(LABEL_BG_PADDING_X, LABEL_BG_PADDING_Y),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, LABEL_MAX_DISTANCE_M),
      },
    });
    this.routeLabels.push({
      kind: route.kind,
      lon,
      lat,
      entity: labelEntity,
      widthPx,
      heightPx: LABEL_BOX_HEIGHT_PX,
      lastOffsetX: 0,
      lastOffsetY: 0,
    });
  }

  /**
   * Projects every route label and endpoint pin to screen coordinates and adjusts label
   * `pixelOffset`s so no two route labels overlap or sit close together at any zoom level.
   */
  private resolveLabelCollisions() {
    if (this.routeLabels.length === 0 || this.controller.viewer.isDestroyed()) return;
    const viewer = this.controller.viewer;

    interface PlacedLabel {
      record: RouteLabelRecord;
      sx: number;
      sy: number;
      cx: number;
      cy: number;
    }

    const placed: PlacedLabel[] = [];
    for (const record of this.routeLabels) {
      const win = projectMarsLatLonToWindow(viewer, record.lon, record.lat, this.scratchScreen);
      if (!win) continue;
      placed.push({
        record,
        sx: win.x,
        sy: win.y,
        cx: win.x,
        cy: win.y,
      });
    }
    if (placed.length === 0) return;

    const pinBoxes: Array<{ cx: number; cy: number }> = [];
    for (const pin of this.pinPoints) {
      const win = projectMarsLatLonToWindow(viewer, pin.lon, pin.lat, this.scratchScreen);
      if (win) pinBoxes.push({ cx: win.x, cy: win.y - 8 });
    }

    // Order top-to-bottom on screen with deterministic tie-breaking so labels never swap/flicker
    placed.sort((a, b) => {
      if (Math.abs(a.sy - b.sy) > 0.5) return a.sy - b.sy;
      return ROUTE_KIND_ORDER[a.record.kind] - ROUTE_KIND_ORDER[b.record.kind];
    });

    // Iteratively separate overlapping label boxes and keep clear of endpoint pins
    for (let iter = 0; iter < 8; iter++) {
      let moved = false;

      // Keep route labels away from endpoint pins A and B
      for (const item of placed) {
        for (const pin of pinBoxes) {
          const minDx = (item.record.widthPx + PIN_CLEARANCE_W_PX) / 2;
          const minDy = (item.record.heightPx + PIN_CLEARANCE_H_PX) / 2;
          if (Math.abs(item.cx - pin.cx) < minDx) {
            const dy = item.cy - pin.cy;
            if (Math.abs(dy) < minDy) {
              const dir = dy < 0 ? -1 : 1;
              item.cy = pin.cy + dir * minDy;
              moved = true;
            }
          }
        }
      }

      // Separate any pair of route labels whose boxes overlap or sit closer than the minimum gap
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const upper = placed[i];
          const lower = placed[j];
          const minDx = (upper.record.widthPx + lower.record.widthPx) / 2 + MIN_LABEL_GAP_X_PX;
          if (Math.abs(upper.cx - lower.cx) >= minDx) continue;

          const minDy = (upper.record.heightPx + lower.record.heightPx) / 2 + MIN_LABEL_GAP_Y_PX;
          const dy = lower.cy - upper.cy;
          if (dy < minDy) {
            const push = (minDy - dy) / 2;
            upper.cy -= push;
            lower.cy += push;
            moved = true;
          }
        }
      }

      if (!moved) break;
    }

    let anyChanged = false;
    for (const item of placed) {
      const dx = Math.round(item.cx - item.sx);
      const dy = Math.round(item.cy - item.sy);
      if (dx !== item.record.lastOffsetX || dy !== item.record.lastOffsetY) {
        item.record.lastOffsetX = dx;
        item.record.lastOffsetY = dy;
        if (item.record.entity.label) {
          item.record.entity.label.pixelOffset = new Cesium.ConstantProperty(
            new Cesium.Cartesian2(dx, dy)
          );
        }
        anyChanged = true;
      }
    }
    if (anyChanged) this.requestRender();
  }

  private addPin(point: LatLon, text: string, cssColor: string) {
    this.channel.entities.add({
      position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0, MARS_ELLIPSOID),
      point: {
        pixelSize: 11,
        color: Cesium.Color.fromCssColorString(cssColor),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text,
        font: '700 13px "JetBrains Mono", monospace',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -10),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /**
   * Shades every DEM pixel in the planning area by its own slope: green (gentle), yellow
   * (moderate), red (over the limit, off-limits for routes) and purple (walkable but walled
   * off from the destination by steep terrain).
   *
   * Drawn as an imagery layer on the globe rather than a textured ground rectangle: imagery
   * uses the same lat/lon grid as the MOLA DEM, so cells line up exactly with the terrain and
   * the routes in both 3D and 2D.
   */
  private syncWalkableLayer(area: WalkableArea | null) {
    if (this.walkableLayer?.area === area) return;
    this.removeWalkableLayer();
    if (!area) return;

    const canvas = renderWalkableCanvas(area);
    const rectangle = Cesium.Rectangle.fromDegrees(area.west, area.south, area.east, area.north);
    const provider = createCanvasImageryProvider(canvas, rectangle, MARS_ELLIPSOID);
    const layer = this.controller.addImageryOverlay(provider, WALKABLE_LAYER_ALPHA);
    layer.magnificationFilter = Cesium.TextureMagnificationFilter.NEAREST;
    this.walkableLayer = { area, layer };
  }

  private removeWalkableLayer() {
    if (!this.walkableLayer) return;
    if (!this.controller.viewer.isDestroyed()) {
      this.controller.viewer.imageryLayers.remove(this.walkableLayer.layer, true);
    }
    this.walkableLayer = null;
  }

  /** Flies the camera to frame both endpoints and every route between them (3D and 2D). */
  private frame(request: RouteRequest, routes: Route[]) {
    const points: LatLon[] = [request.source, request.destination];
    for (const route of routes) {
      for (const [lon, lat] of route.coordinates) points.push({ lat, lon });
    }
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const lonScale = Math.max(Math.cos(Cesium.Math.toRadians(centerLat)), 0.05);

    const halfLat = Math.max(
      ((Math.max(...lats) - Math.min(...lats)) / 2) * (1 + FRAME_PADDING),
      FRAME_MIN_HALF_DEG
    );
    const halfLon = Math.max(
      ((Math.max(...lons) - Math.min(...lons)) / 2) * (1 + FRAME_PADDING),
      FRAME_MIN_HALF_DEG / lonScale
    );
    this.controller.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(
        centerLon - halfLon,
        centerLat - halfLat,
        centerLon + halfLon,
        centerLat + halfLat
      ),
      duration: 2.5,
    });
  }

  private requestRender() {
    if (!this.controller.viewer.isDestroyed()) {
      this.controller.viewer.scene.requestRender();
    }
  }

  public destroy(): void {
    this.removePreRenderListener?.();
    this.removePreRenderListener = null;
    this.channel.entities.removeAll();
    this.routeEntities.clear();
    this.routeLabels.length = 0;
    this.pinPoints.length = 0;
    this.removeWalkableLayer();
    this.requestRender();
  }
}

let labelMeasureCtx: CanvasRenderingContext2D | null = null;

function measureLabelWidthPx(text: string): number {
  if (!labelMeasureCtx && typeof document !== 'undefined') {
    labelMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  if (labelMeasureCtx) {
    labelMeasureCtx.font = LABEL_FONT;
    return Math.ceil(labelMeasureCtx.measureText(text).width) + LABEL_BG_PADDING_X * 2 + 6;
  }
  return Math.ceil(text.length * 7.5) + LABEL_BG_PADDING_X * 2 + 6;
}

/**
 * Picks one interior `[lon, lat]` anchor per route that maximizes separation between route
 * labels and keeps them clear of the A/B endpoint pins. Works for any number of routes
 * (identical corridors or diverging branches).
 */
function chooseLabelAnchors(routes: Route[], endpoints: LatLon[]): Map<RouteKind, [number, number]> {
  const result = new Map<RouteKind, [number, number]>();
  if (routes.length === 0) return result;

  const meanLat =
    endpoints.length > 0
      ? endpoints.reduce((sum, p) => sum + p.lat, 0) / endpoints.length
      : routes[0].coordinates[0][1];
  const lonScale = Math.max(Math.cos(Cesium.Math.toRadians(meanLat)), 0.05);

  const toLocal = (lon: number, lat: number): [number, number] => [lon * lonScale, lat];
  const localEndpoints = endpoints.map((p) => toLocal(p.lon, p.lat));

  // Sample evenly spaced interior vertices per route
  const candidateSets: Array<Array<{ coord: [number, number]; x: number; y: number }>> = routes.map(
    (route) => {
      const coords = route.coordinates;
      if (coords.length <= 2) {
        const [lon, lat] = coords[Math.floor(coords.length / 2)];
        const [x, y] = toLocal(lon, lat);
        return [{ coord: [lon, lat], x, y }];
      }
      const list: Array<{ coord: [number, number]; x: number; y: number }> = [];
      let prevIdx = -1;
      for (let s = 0; s < ANCHOR_CANDIDATE_COUNT; s++) {
        const t =
          ANCHOR_MIN_FRACTION +
          ((ANCHOR_MAX_FRACTION - ANCHOR_MIN_FRACTION) * s) / (ANCHOR_CANDIDATE_COUNT - 1);
        const idx = Math.min(coords.length - 1, Math.max(0, Math.round(t * (coords.length - 1))));
        if (idx === prevIdx) continue;
        prevIdx = idx;
        const [lon, lat] = coords[idx];
        const [x, y] = toLocal(lon, lat);
        list.push({ coord: [lon, lat], x, y });
      }
      return list;
    }
  );

  // Exhaustive search over the small candidate product (<= 13^3 = 2,197 combos)
  let bestScore = -1;
  let bestIndices: number[] = routes.map(() => 0);
  const current: number[] = new Array(routes.length).fill(0);

  const search = (depth: number) => {
    if (depth === routes.length) {
      let minPair = Number.POSITIVE_INFINITY;
      let sumPair = 0;
      for (let i = 0; i < routes.length; i++) {
        const a = candidateSets[i][current[i]];
        for (let j = i + 1; j < routes.length; j++) {
          const b = candidateSets[j][current[j]];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < minPair) minPair = d;
          sumPair += d;
        }
      }
      let minEnd = Number.POSITIVE_INFINITY;
      for (let i = 0; i < routes.length; i++) {
        const a = candidateSets[i][current[i]];
        for (const [ex, ey] of localEndpoints) {
          const d = Math.hypot(a.x - ex, a.y - ey);
          if (d < minEnd) minEnd = d;
        }
      }
      const primary =
        routes.length === 1 ? minEnd : Math.min(minPair, minEnd * 1.1);
      const score = primary + 0.1 * sumPair;
      if (score > bestScore) {
        bestScore = score;
        bestIndices = [...current];
      }
      return;
    }

    const candidates = candidateSets[depth];
    for (let i = 0; i < candidates.length; i++) {
      current[depth] = i;
      search(depth + 1);
    }
  };

  search(0);
  for (let i = 0; i < routes.length; i++) {
    result.set(routes[i].kind, candidateSets[i][bestIndices[i]].coord);
  }
  return result;
}

/**
 * Single-tile `Cesium.ImageryProvider` backed directly by an `HTMLCanvasElement`, avoiding
 * synchronous PNG encoding (`toDataURL`) and base64 decoding when uploading walkable-area grids.
 */
function createCanvasImageryProvider(
  canvas: HTMLCanvasElement,
  rectangle: Cesium.Rectangle,
  ellipsoid: Cesium.Ellipsoid
): Cesium.ImageryProvider {
  const tilingScheme = new Cesium.GeographicTilingScheme({
    rectangle,
    numberOfLevelZeroTilesX: 1,
    numberOfLevelZeroTilesY: 1,
    ellipsoid,
  });
  const errorEvent = new Cesium.Event();
  return {
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    tileWidth: canvas.width,
    tileHeight: canvas.height,
    maximumLevel: 0,
    minimumLevel: 0,
    tileDiscardPolicy: undefined as unknown as Cesium.TileDiscardPolicy,
    errorEvent,
    credit: undefined as unknown as Cesium.Credit,
    proxy: undefined as unknown as Cesium.Proxy,
    hasAlphaChannel: true,
    getTileCredits: () => [],
    requestImage: () => Promise.resolve(canvas),
    pickFeatures: () => undefined,
  };
}

/** Pre-built lookup table mapping ASCII cell char codes (0–127) to packed RGBA tuples. */
const WALKABLE_CODE_RGBA: Array<readonly [number, number, number, number] | undefined> = (() => {
  const lut: Array<readonly [number, number, number, number] | undefined> = new Array(128);
  for (const [key, rgba] of Object.entries(WALKABLE_CELL_RGBA)) {
    if (key.length === 1 && rgba) {
      lut[key.charCodeAt(0)] = rgba;
    }
  }
  return lut;
})();

/** Paints one RGBA pixel per DEM cell (north-west first), upscaled with crisp edges. */
function renderWalkableCanvas(area: WalkableArea): HTMLCanvasElement {
  const pixels = new ImageData(area.cols, area.rows);
  const data = pixels.data;
  const cells = area.cells;
  for (let i = 0; i < cells.length; i++) {
    const rgba = WALKABLE_CODE_RGBA[cells.charCodeAt(i)];
    if (rgba) {
      const o = i * 4;
      data[o] = rgba[0];
      data[o + 1] = rgba[1];
      data[o + 2] = rgba[2];
      data[o + 3] = rgba[3];
    }
  }

  const small = document.createElement('canvas');
  small.width = area.cols;
  small.height = area.rows;
  small.getContext('2d')?.putImageData(pixels, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = area.cols * CELL_UPSCALE;
  canvas.height = area.rows * CELL_UPSCALE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes} min`;
}
