import numpy as np
import pytest

from app.core.config import Settings
from app.modules.routing.errors import NoSafeRouteError, SourceTooFarError
from app.modules.routing.geo import haversine_m
from app.modules.routing.schemas import RouteRequest
from app.modules.routing.service import compute_routes

SETTINGS = Settings()
# Source and destination ~12 km apart along the equator, both on exact 1/128 deg pixel centres
DEST_LON = 26 / 128
SOURCE = {"lat": 0.0, "lon": 0.0}
DESTINATION = {"lat": 0.0, "lon": DEST_LON}
STRAIGHT_M = float(haversine_m(0.0, 0.0, 0.0, DEST_LON))
WALL_WEST, WALL_EAST = 0.09, 0.11  # a 1 km-high plateau (impassable cliffs) across the path
GAP = (0.02, 0.06)  # latitude band where the wall is open (~5 px; its edge rows are steep)


def request(source=SOURCE, destination=DESTINATION, **extra) -> RouteRequest:
    return RouteRequest(source=source, destination=destination, **extra)


def flat(lat, lon):
    return np.zeros_like(lat)


def wall(lat, lon, gap=GAP):
    blocked = (lon >= WALL_WEST) & (lon <= WALL_EAST)
    if gap is not None:
        blocked &= ~((lat >= gap[0]) & (lat <= gap[1]))
    return np.where(blocked, 1000.0, 0.0)


MOUND_LON, MOUND_SIGMA = 0.1, 0.03


def mound(lat, lon):
    """Flat plains with a 2.5 km flat-topped (super-Gaussian) mound between the endpoints.

    Its flanks peak around 40 deg (steep), its outer skirt is moderate, and its rounded summit
    is gentle but ringed by steep ground, i.e. an unreachable pocket.
    """
    r2 = lat**2 + (lon - MOUND_LON) ** 2
    return 2500.0 * np.exp(-((r2 / (2 * MOUND_SIGMA**2)) ** 2))


def test_flat_terrain_gives_three_straight_routes(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(flat), SETTINGS)

    assert [r.kind for r in response.routes] == ["shortest", "fastest", "safest"]
    for route in response.routes:
        assert route.distance_m == pytest.approx(STRAIGHT_M, rel=0.01)
        assert route.max_slope_deg == 0
        assert route.coordinates[0][:2] == (0.0, 0.0)
        assert route.coordinates[-1][:2] == (DEST_LON, 0.0)
        # 10 km/h rover and 3.5 km/h EVA on flat ground
        assert route.eta_rover_s == pytest.approx(route.distance_m / (10 / 3.6), rel=1e-3)
        assert route.eta_eva_s == pytest.approx(route.distance_m / (3.5 / 3.6), rel=1e-3)


def test_routes_detour_through_the_gap_in_a_steep_wall(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(wall), SETTINGS)

    for route in response.routes:
        in_wall = [lat for lon, lat, _ in route.coordinates if WALL_WEST <= lon <= WALL_EAST]
        assert in_wall, "route should cross the wall band"
        assert all(GAP[0] <= lat <= GAP[1] for lat in in_wall)
        assert route.distance_m > STRAIGHT_M


def test_closed_wall_has_no_safe_route(synthetic_dem):
    closed = synthetic_dem(lambda lat, lon: wall(lat, lon, gap=None))
    with pytest.raises(NoSafeRouteError) as excinfo:
        compute_routes(request(), closed, SETTINGS)

    # The error carries the terrain grid; the source side is walled off from the destination
    area = excinfo.value.walkable_area
    assert area is not None
    grid = np.array(list(area.cells)).reshape(area.rows, area.cols)
    lat_grid, lon_grid = cell_centres(area)
    assert (grid[(lon_grid < 0.0) & (grid != "0")] == "4").all()
    assert (grid[(lon_grid > WALL_EAST + 0.02) & (grid != "0")] == "1").all()


def test_source_beyond_the_maximum_distance_is_rejected(synthetic_dem):
    far_source = {"lat": 0.0, "lon": -14.0}  # ~830 km from the destination
    with pytest.raises(SourceTooFarError):
        compute_routes(request(source=far_source), synthetic_dem(flat), SETTINGS)


def test_long_traverse_is_planned_on_a_coarsened_grid(synthetic_dem):
    # ~150 km apart: far beyond the native-resolution window, like the Olympus crew camps
    source, destination = {"lat": 0.0, "lon": -1.25}, {"lat": 0.0, "lon": 1.25}
    response = compute_routes(request(source, destination), synthetic_dem(flat), SETTINGS)

    assert [r.kind for r in response.routes] == ["shortest", "fastest", "safest"]
    assert response.dem_resolution_m > 463
    assert any("Long traverse" in w for w in response.warnings)
    area = response.walkable_area
    assert max(area.rows, area.cols) <= SETTINGS.route_graph_max_side_px
    straight = float(haversine_m(0.0, -1.25, 0.0, 1.25))
    assert response.routes[0].distance_m == pytest.approx(straight, rel=0.02)
    assert response.routes[0].coordinates[0][:2] == (-1.25, 0.0)
    assert response.routes[0].coordinates[-1][:2] == (1.25, 0.0)


def test_short_traverse_keeps_native_resolution(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(flat), SETTINGS)

    assert response.dem_resolution_m == pytest.approx(463, abs=1)
    assert not any("Long traverse" in w for w in response.warnings)


@pytest.mark.parametrize("limit", [8.0, 15.0])
def test_every_route_segment_respects_the_slope_limit(synthetic_dem, limit):
    response = compute_routes(request(max_slope_deg=limit), synthetic_dem(mound), SETTINGS)

    assert response.max_slope_deg == limit
    for route in response.routes:
        assert 0 < route.max_slope_deg <= limit
        assert route.mean_slope_deg <= route.max_slope_deg


def test_each_route_wins_its_own_metric(synthetic_dem):
    routes = {r.kind: r for r in compute_routes(request(), synthetic_dem(mound), SETTINGS).routes}

    tolerance = 1e-6
    assert routes["shortest"].distance_m <= routes["fastest"].distance_m + tolerance
    assert routes["shortest"].distance_m <= routes["safest"].distance_m + tolerance
    assert routes["fastest"].eta_rover_s <= routes["shortest"].eta_rover_s + tolerance
    assert routes["safest"].mean_slope_deg <= routes["shortest"].mean_slope_deg + tolerance


def walkable_grid(response) -> np.ndarray:
    area = response.walkable_area
    assert len(area.cells) == area.rows * area.cols
    return np.array(list(area.cells)).reshape(area.rows, area.cols)


def cell_centres(area) -> tuple[np.ndarray, np.ndarray]:
    """(lat_grid, lon_grid) of pixel centres for a walkable-area grid."""
    lat_step = (area.north - area.south) / area.rows
    lon_step = (area.east - area.west) / area.cols
    lats = area.north - (np.arange(area.rows) + 0.5) * lat_step
    lons = area.west + (np.arange(area.cols) + 0.5) * lon_step
    return np.meshgrid(lats, lons, indexing="ij")


def cell_at(response, grid, lon: float, lat: float) -> str:
    area = response.walkable_area
    row = int((area.north - lat) / (area.north - area.south) * area.rows)
    col = int((lon - area.west) / (area.east - area.west) * area.cols)
    return grid[row, col]


def test_walkable_area_on_flat_terrain_is_all_gentle(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(flat), SETTINGS)

    grid = walkable_grid(response)
    area = response.walkable_area
    assert set(np.unique(grid)) == {"0", "1"}  # inside the radius everything is gentle
    assert area.west < DEST_LON < area.east
    assert area.south < 0.0 < area.north
    assert area.max_slope_deg == 15
    assert area.gentle_max_slope_deg == 5
    # The 25 km planning disc covers ~pi * 25^2 km^2 of ~0.463 km pixels
    expected_cells = np.pi * 25_000**2 / response.dem_resolution_m**2
    assert (grid == "1").sum() == pytest.approx(expected_cells, rel=0.05)


def test_walkable_area_classifies_mound_by_slope(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(mound), SETTINGS)

    grid = walkable_grid(response)
    lat_grid, lon_grid = cell_centres(response.walkable_area)
    dist = np.hypot(lat_grid, lon_grid - MOUND_LON) / MOUND_SIGMA  # in mound sigmas

    assert set(np.unique(grid)) == {"0", "1", "2", "3", "4"}
    assert cell_at(response, grid, MOUND_LON, 0.0) == "4"  # summit: gentle but walled off
    assert (grid[(dist > 0.8) & (dist < 1.6)] == "3").all()  # steepest flanks
    assert (grid[(dist > 5) & (grid != "0")] == "1").all()  # far plains


def test_routes_never_touch_steep_or_unreachable_cells(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(mound), SETTINGS)
    grid = walkable_grid(response)

    for route in response.routes:
        cells = {cell_at(response, grid, lon, lat) for lon, lat, _ in route.coordinates}
        assert cells <= {"1", "2"}, route.kind


def test_walkable_area_marks_cliffs_steep_and_plateau_unreachable(synthetic_dem):
    response = compute_routes(request(), synthetic_dem(wall), SETTINGS)

    grid = walkable_grid(response)
    lat_grid, lon_grid = cell_centres(response.walkable_area)
    plateau_top = (lon_grid > WALL_WEST + 0.01) & (lon_grid < WALL_EAST - 0.01) & (lat_grid < 0)
    inside = grid != "0"

    assert (grid[plateau_top & inside] == "4").all()  # flat top, cut off by cliffs
    assert cell_at(response, grid, WALL_WEST, -0.1) == "3"  # cliff edge
    assert (grid[(lon_grid < 0.0) & inside] == "1").all()  # source side: reachable via the gap


def test_base_terrain_reuses_dem_read_across_slope_limits(synthetic_dem):
    base_reader = synthetic_dem(mound)
    reads = 0

    class CountingReader:
        def read_patch(self, lat, lon, radius_m, max_side_px=None):
            nonlocal reads
            reads += 1
            return base_reader.read_patch(lat, lon, radius_m, max_side_px)

    reader = CountingReader()
    r15 = compute_routes(request(max_slope_deg=15.0), reader, SETTINGS)
    r25 = compute_routes(request(max_slope_deg=25.0), reader, SETTINGS)
    r15_again = compute_routes(request(max_slope_deg=15.0), reader, SETTINGS)

    assert reads == 1  # 25° reuses cached patch + base geometry from 15°
    assert r15_again == r15
    assert r25.max_slope_deg == 25.0


def test_connected_component_handles_diagonal_bridges():
    from app.modules.routing.graph import connected_component_mask

    # 8-connected diagonal chain from (0, 0) to (2, 2); (0, 4) is isolated by a 2-col gap
    grid = np.array(
        [
            [True, False, False, False, True],
            [False, True, False, False, False],
            [False, False, True, False, True],
        ],
        dtype=bool,
    )
    mask = connected_component_mask(grid, 0, 0)
    assert mask[0, 0] and mask[1, 1] and mask[2, 2]
    assert not mask[0, 4] and not mask[2, 4]


def test_astar_matches_dijkstra_costs_on_mound(synthetic_dem):
    from app.modules.routing.graph import (
        SpeedModel,
        astar_path,
        build_distance_heuristic,
        build_terrain,
        node_id,
    )
    from app.modules.routing.service import _nearest_pixel

    req = request()
    reader = synthetic_dem(mound)
    center_lat = (req.source.lat + req.destination.lat) / 2
    center_lon = (req.source.lon + req.destination.lon) / 2
    radius = SETTINGS.route_graph_radius_m
    patch = reader.read_patch(center_lat, center_lon, radius, SETTINGS.route_graph_max_side_px)
    speed = SpeedModel(
        SETTINGS.rover_speed_kmh, SETTINGS.eva_speed_kmh, SETTINGS.route_max_slope_deg
    )
    terrain = build_terrain(patch, center_lat, center_lon, radius, speed)

    cols = patch.elevation.shape[1]
    sr, sc = _nearest_pixel(patch, req.source)
    gr, gc = _nearest_pixel(patch, req.destination)
    start, goal = node_id(sr, sc, cols), node_id(gr, gc, cols)
    n = terrain.rows * terrain.cols

    h_dist = build_distance_heuristic(patch, terrain, gr, gc)
    zeros = [0.0] * n
    checks = [
        ("distance", h_dist.ravel().tolist()),
        ("time", (h_dist / (speed.rover_kmh / 3.6)).ravel().tolist()),
        ("safety", h_dist.ravel().tolist()),
    ]

    def path_cost(path: list[int], weight_kind: str) -> float:
        w_e, w_s, w_se, w_sw = terrain.weights[weight_kind]
        total = 0.0
        for u, v in zip(path, path[1:], strict=False):
            ur, uc = divmod(u, cols)
            vr, vc = divmod(v, cols)
            dr, dc = vr - ur, vc - uc
            if (dr, dc) == (0, 1):
                total += float(w_e[ur, uc])
            elif (dr, dc) == (0, -1):
                total += float(w_e[vr, vc])
            elif (dr, dc) == (1, 0):
                total += float(w_s[ur, uc])
            elif (dr, dc) == (-1, 0):
                total += float(w_s[vr, vc])
            elif (dr, dc) == (1, 1):
                total += float(w_se[ur, uc])
            elif (dr, dc) == (-1, -1):
                total += float(w_se[vr, vc])
            elif (dr, dc) == (1, -1):
                total += float(w_sw[ur, uc])
            else:
                total += float(w_sw[vr, vc])
        return total

    for weight_kind, heuristic in checks:
        p_astar = astar_path(terrain, start, goal, weight_kind, heuristic)
        p_dijk = astar_path(terrain, start, goal, weight_kind, zeros)
        assert p_astar is not None and p_dijk is not None
        assert path_cost(p_astar, weight_kind) == pytest.approx(
            path_cost(p_dijk, weight_kind), rel=1e-9
        )
