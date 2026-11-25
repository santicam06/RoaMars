import * as Cesium from 'cesium';
import { MARS_ELLIPSOID } from '../../../config/marsConfig';
import type { MarsViewerController } from '../../../core/MarsViewerController';
import { ROUTE_STYLE } from '../config/routeStyle';
import { WALKABLE_CELL_RGBA } from '../config/walkableAreaStyle';
import {
  type LatLon,
  type Route,
  type RouteKind,
  type RouteRequest,
  type WalkableArea,
} from '../types/routing';

const OVERLAY_CHANNEL_ID = 'routing';
const LABEL_FONT = '500 12px "JetBrains Mono", monospace';
/** Each DEM pixel is drawn as an N×N block so cell edges stay crisp when resampled */
const CELL_UPSCALE = 4;
const WALKABLE_LAYER_ALPHA = 0.85;
/** Route labels stay visible from far enough out to frame long camp-to-camp traverses */
const LABEL_MAX_DISTANCE_M = 5_000_000;
/** Extra margin around the framed route, as a fraction of its extent */
const FRAME_PADDING = 0.25;
/** Minimum framed half-extent (degrees of latitude), so short routes are not over-zoomed */
const FRAME_MIN_HALF_DEG = 0.25;

export interface RouteOverlayState {
  request: RouteRequest | null;
  routes: Route[];
  highlighted: RouteKind | null;
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
  private lastFramedRequest: RouteRequest | null = null;
  /** Imagery layer showing the walkable area, and the grid it was drawn from */
  private walkableLayer: { area: WalkableArea; layer: Cesium.ImageryLayer } | null = null;

  constructor(private readonly controller: MarsViewerController) {
    this.channel = controller.getOrCreateOverlayChannel(OVERLAY_CHANNEL_ID);
  }

  /** Redraws everything for the given routing state. */
  public render(state: RouteOverlayState) {
    const { request, routes, highlighted, walkableArea, walkableAreaVisible } = state;
    this.channel.entities.removeAll();
    this.routeEntities.clear();
    this.syncWalkableLayer(request && walkableAreaVisible ? walkableArea : null);
    if (!request) return this.requestRender();

    // Draw the highlighted route last so it sits on top
    const hasSelection = highlighted !== null && routes.some((r) => r.kind === highlighted);
    const ordered = [...routes].sort(
      (a, b) => Number(a.kind === highlighted) - Number(b.kind === highlighted)
    );
    for (const route of ordered) {
      const isSelected = route.kind === highlighted;
      const dimmed = hasSelection && !isSelected;
      this.addRoute(route, isSelected, dimmed);
    }
    this.addPin(request.source, 'A', '#FFFFFF');
    this.addPin(request.destination, 'B', '#B91C1C');

    // Frame once per request, also when there is no route but the blocking terrain is shown
    if ((routes.length > 0 || walkableArea) && this.lastFramedRequest !== request) {
      this.lastFramedRequest = request;
      this.frame(request, routes);
    }
    this.requestRender();
  }

  private addRoute(route: Route, highlighted: boolean, dimmed: boolean) {
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

    // Label near the middle of the route, offset per kind so overlapping labels stay readable
    const [lon, lat] = route.coordinates[Math.floor(route.coordinates.length / 2)];
    const offsetY = { shortest: -18, fastest: 0, safest: 18 }[route.kind];
    const labelOutline = baseColor.darken(0.4, new Cesium.Color());
    this.channel.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0, MARS_ELLIPSOID),
      label: {
        text: `${style.label} · ${formatKm(route.distance_m)} · ${formatDuration(route.eta_rover_s)}`,
        font: LABEL_FONT,
        fillColor: dimmed ? Cesium.Color.WHITE.withAlpha(0.6) : Cesium.Color.WHITE,
        outlineColor: dimmed ? labelOutline.withAlpha(0.5) : labelOutline,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(dimmed ? 0.35 : 0.65),
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        pixelOffset: new Cesium.Cartesian2(12, offsetY),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, LABEL_MAX_DISTANCE_M),
      },
    });
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
    const provider = new Cesium.SingleTileImageryProvider({
      url: canvas.toDataURL('image/png'),
      rectangle: Cesium.Rectangle.fromDegrees(area.west, area.south, area.east, area.north),
      tileWidth: canvas.width,
      tileHeight: canvas.height,
      ellipsoid: MARS_ELLIPSOID,
    });
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
    this.channel.entities.removeAll();
    this.routeEntities.clear();
    this.removeWalkableLayer();
    this.requestRender();
  }
}

/** Paints one RGBA pixel per DEM cell (north-west first), upscaled with crisp edges. */
function renderWalkableCanvas(area: WalkableArea): HTMLCanvasElement {
  const pixels = new ImageData(area.cols, area.rows);
  for (let i = 0; i < area.cells.length; i++) {
    const rgba = WALKABLE_CELL_RGBA[area.cells[i]];
    if (rgba) pixels.data.set(rgba, i * 4);
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
