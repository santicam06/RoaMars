"""Computes the shortest, fastest and safest traversable routes between two points."""

import threading
from collections import OrderedDict
from weakref import WeakKeyDictionary

import numpy as np

from app.core.config import Settings
from app.modules.routing.dem import DemPatch, DemReader
from app.modules.routing.errors import NoSafeRouteError, OutsideDemError, SourceTooFarError
from app.modules.routing.geo import haversine_m
from app.modules.routing.graph import (
    BaseTerrain,
    SpeedModel,
    Terrain,
    astar_path,
    build_base_terrain,
    build_distance_heuristic,
    build_terrain_from_base,
    connected_component_mask,
    node_id,
)
from app.modules.routing.schemas import (
    CELL_GENTLE,
    CELL_MODERATE,
    CELL_OUTSIDE,
    CELL_STEEP,
    CELL_UNREACHABLE,
    LatLon,
    Route,
    RouteKind,
    RouteRequest,
    RouteResponse,
    WalkableArea,
)

# Slopes up to this fraction of the limit are shown as "gentle" on the walkable-area overlay
GENTLE_SLOPE_FRACTION = 1 / 3

ROUTE_WEIGHTS: dict[RouteKind, str] = {
    "shortest": "distance",
    "fastest": "time",
    "safest": "safety",
}

_CELL_CODE_OUTSIDE = ord(CELL_OUTSIDE)
_CELL_CODE_GENTLE = ord(CELL_GENTLE)
_CELL_CODE_MODERATE = ord(CELL_MODERATE)
_CELL_CODE_STEEP = ord(CELL_STEEP)
_CELL_CODE_UNREACHABLE = ord(CELL_UNREACHABLE)

_BASE_TERRAIN_CACHE_MAX = 8
_ROUTE_CACHE_MAX = 64

type _BaseKey = tuple[float, float, float, int]
type _RouteKey = tuple[float, float, float, float, float, float, float, int, float, float, float]
type _CachedOutcome = tuple[RouteResponse, None] | tuple[None, tuple[str, WalkableArea | None]]


class _ReaderCache:
    """Thread-safe per-DEM-reader LRU caches for base terrain patches and route responses."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._base: OrderedDict[_BaseKey, tuple[DemPatch, BaseTerrain]] = OrderedDict()
        self._routes: OrderedDict[_RouteKey, _CachedOutcome] = OrderedDict()

    def get_base(self, key: _BaseKey) -> tuple[DemPatch, BaseTerrain] | None:
        with self._lock:
            entry = self._base.get(key)
            if entry is not None:
                self._base.move_to_end(key)
            return entry

    def put_base(self, key: _BaseKey, value: tuple[DemPatch, BaseTerrain]) -> None:
        with self._lock:
            self._base[key] = value
            self._base.move_to_end(key)
            while len(self._base) > _BASE_TERRAIN_CACHE_MAX:
                self._base.popitem(last=False)

    def get_route(self, key: _RouteKey) -> _CachedOutcome | None:
        with self._lock:
            entry = self._routes.get(key)
            if entry is not None:
                self._routes.move_to_end(key)
            return entry

    def put_route(self, key: _RouteKey, value: _CachedOutcome) -> None:
        with self._lock:
            self._routes[key] = value
            self._routes.move_to_end(key)
            while len(self._routes) > _ROUTE_CACHE_MAX:
                self._routes.popitem(last=False)


_CACHE_REGISTRY_LOCK = threading.Lock()
_READER_CACHES: WeakKeyDictionary[DemReader, _ReaderCache] = WeakKeyDictionary()


def _reader_cache(reader: DemReader) -> _ReaderCache | None:
    with _CACHE_REGISTRY_LOCK:
        try:
            cache = _READER_CACHES.get(reader)
            if cache is None:
                cache = _ReaderCache()
                _READER_CACHES[reader] = cache
            return cache
        except TypeError:
            # Reader implementation does not support weak references
            return None


def compute_routes(request: RouteRequest, reader: DemReader, settings: Settings) -> RouteResponse:
    source, destination = request.source, request.destination
    max_slope = request.max_slope_deg or settings.route_max_slope_deg

    separation = float(haversine_m(source.lat, source.lon, destination.lat, destination.lon))
    if separation > settings.route_source_max_distance_m:
        raise SourceTooFarError(
            f"Source is {separation / 1000:.1f} km from the destination; the maximum is "
            f"{settings.route_source_max_distance_m / 1000:.0f} km."
        )

    cache = _reader_cache(reader)
    route_key: _RouteKey = (
        source.lat,
        source.lon,
        destination.lat,
        destination.lon,
        max_slope,
        settings.route_source_max_distance_m,
        settings.route_graph_radius_m,
        settings.route_graph_max_side_px,
        settings.route_area_margin_fraction,
        settings.rover_speed_kmh,
        settings.eva_speed_kmh,
    )
    if cache is not None:
        cached = cache.get_route(route_key)
        if cached is not None:
            response, err = cached
            if response is not None:
                return response
            assert err is not None
            raise NoSafeRouteError(err[0], err[1])

    # Plan over a disc centred between the endpoints, padded so detours around obstacles fit.
    # Antimeridian crossings are rejected by the reader, so a plain lat/lon mean is enough.
    center_lat = (source.lat + destination.lat) / 2
    center_lon = (source.lon + destination.lon) / 2
    radius = max(
        settings.route_graph_radius_m,
        separation / 2 * (1 + settings.route_area_margin_fraction),
    )

    base_key: _BaseKey = (center_lat, center_lon, radius, settings.route_graph_max_side_px)
    base_entry = cache.get_base(base_key) if cache is not None else None
    if base_entry is not None:
        patch, base = base_entry
    else:
        patch = reader.read_patch(center_lat, center_lon, radius, settings.route_graph_max_side_px)
        base = build_base_terrain(patch, center_lat, center_lon, radius)
        if cache is not None:
            cache.put_base(base_key, (patch, base))

    speed = SpeedModel(settings.rover_speed_kmh, settings.eva_speed_kmh, max_slope)
    terrain = build_terrain_from_base(base, speed)

    cols = patch.elevation.shape[1]
    source_px = _nearest_pixel(patch, source)
    goal_px = _nearest_pixel(patch, destination)
    start, goal = node_id(*source_px, cols), node_id(*goal_px, cols)

    # Computed up front so a "no safe route" error can still show the terrain that blocks it,
    # and so disconnected source/goal pairs fail immediately without searching.
    reachable = connected_component_mask(terrain.traversable, goal_px[0], goal_px[1])
    walkable_area = _walkable_area(patch, terrain, reachable)

    for name, (row, col) in (("source", source_px), ("destination", goal_px)):
        if not terrain.traversable[row, col]:
            detail = (
                f"The {name} sits on terrain steeper than the {max_slope:g}° slope limit "
                f"({terrain.pixel_slope_deg[row, col]:.1f}°)."
            )
            if cache is not None:
                cache.put_route(route_key, (None, (detail, walkable_area)))
            raise NoSafeRouteError(detail, walkable_area)

    if not reachable[source_px]:
        detail = f"No route between the points stays under the {max_slope:g}° slope limit."
        if cache is not None:
            cache.put_route(route_key, (None, (detail, walkable_area)))
        raise NoSafeRouteError(detail, walkable_area)

    h_dist_arr = build_distance_heuristic(patch, terrain, goal_px[0], goal_px[1])
    h_dist = h_dist_arr.ravel().tolist()
    h_time = (h_dist_arr / (speed.rover_kmh / 3.6)).ravel().tolist()
    heuristics: dict[RouteKind, list[float]] = {
        "shortest": h_dist,
        "fastest": h_time,
        "safest": h_dist,
    }

    paths: dict[RouteKind, list[int]] = {}
    for kind, weight in ROUTE_WEIGHTS.items():
        path = astar_path(terrain, start, goal, weight, heuristics[kind])
        if path is None:
            detail = f"No route between the points stays under the {max_slope:g}° slope limit."
            if cache is not None:
                cache.put_route(route_key, (None, (detail, walkable_area)))
            raise NoSafeRouteError(detail, walkable_area)
        paths[kind] = path

    routes = [
        _describe(kind, path, patch, source, destination, speed) for kind, path in paths.items()
    ]
    response = RouteResponse(
        routes=routes,
        dem_resolution_m=patch.resolution_m,
        max_slope_deg=max_slope,
        warnings=_resolution_warnings(patch) + _duplicate_warnings(paths),
        walkable_area=walkable_area,
    )
    if cache is not None:
        cache.put_route(route_key, (response, None))
    return response


def _walkable_area(patch: DemPatch, terrain: Terrain, reachable: np.ndarray) -> WalkableArea:
    """Classifies each planning-area pixel by its own slope and by reachability.

    The terrain grid is undirected, so the destination's connected component is exactly the set of
    pixels with a slope-safe path to (and from) the destination. Traversable pixels outside it are
    walled-off pockets.
    """
    rows, cols = patch.elevation.shape
    gentle_max = terrain.max_slope_deg * GENTLE_SLOPE_FRACTION
    slope = terrain.pixel_slope_deg

    cells = np.full((rows, cols), _CELL_CODE_OUTSIDE, dtype=np.uint8)
    with np.errstate(invalid="ignore"):
        cells[terrain.in_area & (slope > terrain.max_slope_deg)] = _CELL_CODE_STEEP
    cells[terrain.traversable] = _CELL_CODE_UNREACHABLE
    with np.errstate(invalid="ignore"):
        cells[reachable & (slope <= gentle_max)] = _CELL_CODE_GENTLE
        cells[reachable & (slope > gentle_max)] = _CELL_CODE_MODERATE

    half_lat = abs(patch.lats[0] - patch.lats[1]) / 2 if rows > 1 else 0.0
    half_lon = abs(patch.lons[1] - patch.lons[0]) / 2 if cols > 1 else 0.0
    return WalkableArea(
        west=float(patch.lons[0] - half_lon),
        east=float(patch.lons[-1] + half_lon),
        north=float(patch.lats[0] + half_lat),
        south=float(patch.lats[-1] - half_lat),
        rows=rows,
        cols=cols,
        gentle_max_slope_deg=round(gentle_max, 2),
        max_slope_deg=terrain.max_slope_deg,
        cells=cells.tobytes().decode("ascii"),
    )


def _nearest_pixel(patch: DemPatch, point: LatLon) -> tuple[int, int]:
    row = int(np.abs(patch.lats - point.lat).argmin())
    col = int(np.abs(patch.lons - point.lon).argmin())
    if not np.isfinite(patch.elevation[row, col]):
        raise OutsideDemError(f"No elevation data at {point.lat:.4f}, {point.lon:.4f}.")
    return row, col


def _describe(
    kind: RouteKind,
    path: list[int],
    patch: DemPatch,
    source: LatLon,
    destination: LatLon,
    speed: SpeedModel,
) -> Route:
    cols = patch.elevation.shape[1]
    rows_idx, cols_idx = np.divmod(np.asarray(path), cols)
    lats = patch.lats[rows_idx]
    lons = patch.lons[cols_idx]
    elev = patch.elevation[rows_idx, cols_idx]

    # Metrics use the snapped pixel centres, so they match the graph edges (slope <= limit).
    horizontal = haversine_m(lats[:-1], lons[:-1], lats[1:], lons[1:])
    dz = np.diff(elev)
    length = np.hypot(horizontal, dz)
    slope = np.degrees(np.arctan2(np.abs(dz), horizontal))
    with np.errstate(divide="ignore", invalid="ignore"):
        grade = np.where(horizontal > 0, dz / horizontal, 0.0)

    # The drawn line starts and ends exactly at the requested points (inside the snapped pixels).
    coordinates = [
        (round(float(lo), 6), round(float(la), 6), round(float(z), 1))
        for lo, la, z in zip(lons, lats, elev, strict=True)
    ]
    coordinates[0] = (source.lon, source.lat, coordinates[0][2])
    coordinates[-1] = (destination.lon, destination.lat, coordinates[-1][2])

    distance = float(length.sum())
    return Route(
        kind=kind,
        coordinates=coordinates,
        distance_m=round(distance, 1),
        eta_rover_s=round(float((length / speed.rover_mps(slope)).sum()), 1),
        eta_eva_s=round(float((length / speed.eva_mps(grade)).sum()), 1),
        max_slope_deg=round(float(slope.max(initial=0.0)), 2),
        mean_slope_deg=round(float((slope * length).sum() / distance) if distance else 0.0, 2),
    )


def _resolution_warnings(patch: DemPatch) -> list[str]:
    if patch.downsample <= 1:
        return []
    return [
        f"Long traverse: terrain was sampled at ~{patch.resolution_m / 1000:.1f} km cells, so "
        "slopes shorter than that are smoothed out. Re-plan short legs for full detail."
    ]


def _duplicate_warnings(paths: dict[RouteKind, list[int]]) -> list[str]:
    warnings: list[str] = []
    kinds = list(paths)
    for i, later in enumerate(kinds):
        for earlier in kinds[:i]:
            if paths[later] == paths[earlier]:
                warnings.append(f"The {later} route is identical to the {earlier} route.")
                break
    return warnings
