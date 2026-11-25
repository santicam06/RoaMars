import * as Cesium from 'cesium';

/**
 * Enforce zero proprietary Cesium Ion usage and set Mars (IAU 2000) as the global
 * reference ellipsoid BEFORE any Viewer, Globe, Projection, or Camera is created.
 */
Cesium.Ion.defaultAccessToken = '';
export const MARS_ELLIPSOID = Cesium.Ellipsoid.MARS; // (3396190.0, 3396190.0, 3376200.0) meters
Cesium.Ellipsoid.default = MARS_ELLIPSOID;

/** Equatorial circumference of Mars (~21,338.9 km), matching full -180..+180 2D map width */
export const MARS_CIRCUMFERENCE_METERS = 2 * Math.PI * MARS_ELLIPSOID.maximumRadius;

/**
 * Placeholder shown in the bottom-right Lat/Lon readout when the cursor is over
 * the black space background (off the 3D globe or outside the 2D map bounds).
 */
export const OFF_MAP_COORD_PLACEHOLDER = '--';

/**
 * Verified NASA Mars Trek default global basemap (WMTS 1.0.0 RESTful):
 * Product: Mars_Viking_MDIM21_ClrMosaic_global_232m ("Viking VIS, Global Color Mosaic", 232m/px)
 */
export const VIKING_WMTS_CONFIG = {
  url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{TileMatrix}/{TileRow}/{TileCol}.jpg',
  layer: 'Mars_Viking_MDIM21_ClrMosaic_global_232m',
  style: 'default',
  format: 'image/jpeg',
  tileMatrixSetID: 'default028mm',
  tileWidth: 256,
  tileHeight: 256,
  minimumLevel: 0,
  maximumLevel: 7,
  credit: 'Courtesy NASA/JPL-Caltech/USGS',
} as const;

/**
 * Cached GeoJSON snapshot of NASA Mars Trek's 1,783 IAU Nomenclature features,
 * plus live NASA REST endpoint fallback.
 */
export const NOMENCLATURE_GEOJSON_URL = '/data/mars_nomenclature.geojson';

/**
 * Camera zoom / altitude limits (in meters above the Martian ellipsoid).
 */
export const CAMERA_BOUNDS = {
  /** 2.5 km minimum height above smooth sphere — prevents near-plane clipping while allowing EVA-scale zoom */
  minZoomDistanceMeters: 2_500,
  /** 32,000 km maximum zoom distance — frames both the 3D globe and full 2D map cleanly inside black space */
  maxZoomDistanceMeters: 32_000_000,
  /** Default initial 2D camera framing (centered near Margaritifer Terra / Valles Marineris hemisphere, full map view) */
  initialLongitudeDeg: -22.0,
  initialLatitudeDeg: -4.0,
  /** Default initial 3D globe framing (centered over the Olympus Mons crew camps, full globe view) */
  initial3DLongitudeDeg: -136.8,
  initial3DLatitudeDeg: 20.4,
  initialAltitudeMeters: 11_500_000,
} as const;

/**
 * Maximum effective camera altitude (in meters) at which each Mars Trek nomenclature
 * hierarchy `level` (1 = planetary terrae/planitiae -> 7 = small craters) becomes visible.
 *
 * Calibrated directly against Mars Trek so regional views (~1,000–3,500 km altitude)
 * cleanly show levels 1–5 (e.g., Margaritifer Terra [1], Iani Chaos [3],
 * Aureum Chaos [4], Arsinoes Chaos [5]) without clutter from 1,180 level-7 craters.
 */
export const NOMENCLATURE_LEVEL_MAX_ALTITUDE_METERS: Record<number, number> = {
  1: 35_000_000, // Always eligible from full global orbit down to surface
  2: 10_500_000,
  3: 6_200_000,
  4: 4_200_000,
  5: 2_800_000,
  6: 1_200_000,
  7: 550_000,
};
