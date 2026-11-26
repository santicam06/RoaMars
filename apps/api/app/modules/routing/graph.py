"""Slope-filtered terrain grid and exact A* search built from a DEM patch.

Every DEM pixel within the planning radius whose own slope (steepest step to any of its 8
neighbours) is within the limit is traversable and connected to its traversable neighbours. Any
path through the terrain therefore stays on slope-safe ground. Each undirected edge carries three
weights, one per route kind:

- ``distance``: 3D length in metres (horizontal great-circle distance plus elevation change)
- ``time``: seconds for a rover whose speed falls linearly with slope (20% speed at the limit)
- ``safety``: length penalised quadratically by how close the slope is to the limit
"""

import heapq
import math
from dataclasses import dataclass

import numpy as np

from app.modules.routing.dem import DemPatch
from app.modules.routing.geo import MARS_RADIUS_M, haversine_m

# Fraction of flat-ground rover speed lost when climbing/descending at the slope limit
ROVER_SLOPE_SLOWDOWN = 0.8
# (row, col) offsets that cover each undirected 8-neighbour edge exactly once: E, S, SE, SW
NEIGHBOUR_OFFSETS = ((0, 1), (1, 0), (1, 1), (1, -1))
SAFETY_PENALTY = 4.0
# Slight safety factor on admissible heuristics to prevent IEEE-754 rounding from overestimating
HEURISTIC_EPS = 1.0 - 1e-9


@dataclass(frozen=True)
class SpeedModel:
    rover_kmh: float
    eva_kmh: float
    max_slope_deg: float

    def rover_mps(self, slope_deg):
        """Rover speed falls linearly from full speed on flat ground to 20% at the slope limit."""
        slowdown = ROVER_SLOPE_SLOWDOWN * np.asarray(slope_deg) / self.max_slope_deg
        return self.rover_kmh / 3.6 * (1.0 - slowdown)

    def eva_mps(self, signed_grade):
        """Tobler's hiking function, rescaled so flat ground gives ``eva_kmh``.

        ``signed_grade`` is rise/run in the direction of travel (negative = downhill).
        """
        tobler = np.exp(-3.5 * np.abs(np.asarray(signed_grade) + 0.05)) / math.exp(-3.5 * 0.05)
        return self.eva_kmh / 3.6 * tobler


def node_id(row: int, col: int, cols: int) -> int:
    return row * cols + col


def planning_mask(patch: DemPatch, center_lat: float, center_lon: float, radius_m: float):
    """Pixels with elevation data within ``radius_m`` of the centre."""
    p1 = math.radians(center_lat)
    p2 = np.radians(patch.lats)[:, None]
    dp = p2 - p1
    dl = np.radians(patch.lons)[None, :] - math.radians(center_lon)
    a = np.sin(dp * 0.5) ** 2 + (math.cos(p1) * np.cos(p2)) * (np.sin(dl * 0.5) ** 2)
    dist = (2.0 * MARS_RADIUS_M) * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))
    return (dist <= radius_m) & np.isfinite(patch.elevation)


@dataclass(frozen=True)
class _DirectionStep:
    """Slope-independent geometry for one of the four undirected grid neighbour directions."""

    ra: slice
    rb: slice
    ca: slice
    cb: slice
    valid: np.ndarray
    length: np.ndarray
    slope_deg: np.ndarray


@dataclass(frozen=True)
class BaseTerrain:
    """Slope-limit-independent terrain geometry for a DEM patch.

    Shared across travel modes (e.g. 15° EVA vs. 25° rover) on the same planning window so
    elevation differences, horizontal distances and per-pixel slopes are computed only once.
    """

    rows: int
    cols: int
    in_area: np.ndarray  # (rows, cols) bool: pixel is inside the planning area with data
    pixel_slope_deg: np.ndarray  # (rows, cols) steepest step to any 8-neighbour; NaN outside
    steps: tuple[_DirectionStep, ...]
    min_dx_m: float
    min_dy_m: float
    min_diag_m: float


@dataclass(frozen=True)
class Terrain:
    """Compact flat-grid representation of the slope-filtered terrain graph.

    For each weight kind (``distance``, ``time``, ``safety``), ``weights[kind]`` holds four
    ``(rows, cols)`` float64 arrays corresponding to ``NEIGHBOUR_OFFSETS`` (E, S, SE, SW), with
    ``+inf`` where an edge is absent or impassable.
    """

    rows: int
    cols: int
    in_area: np.ndarray  # (rows, cols) bool: pixel is inside the planning area with data
    pixel_slope_deg: np.ndarray  # (rows, cols) steepest step to any 8-neighbour; NaN outside
    max_slope_deg: float
    traversable: np.ndarray  # (rows, cols) bool: in_area & (pixel_slope_deg <= max_slope_deg)
    weights: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]
    min_dx_m: float
    min_dy_m: float
    min_diag_m: float


def _horizontal_steps(patch: DemPatch) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Horizontal great-circle step lengths for (E, S, SE, SW).

    On a regular lat/lon grid, step lengths depend only on latitude (1D array of length ``rows``),
    avoiding O(rows * cols) trigonometric calls. Falls back to 2D haversine for irregular grids.
    """
    rows, cols = patch.elevation.shape
    lats, lons = patch.lats, patch.lons

    if cols > 1:
        dl_col = float(lons[1] - lons[0])
        uniform_lon = cols <= 2 or bool(np.allclose(np.diff(lons), dl_col, rtol=0.0, atol=1e-9))
    else:
        dl_col = 0.0
        uniform_lon = True

    if uniform_lon:
        h_e = haversine_m(lats, 0.0, lats, dl_col)[:, None] if cols > 1 else np.empty((rows, 0))
        h_s = (
            haversine_m(lats[:-1], 0.0, lats[1:], 0.0)[:, None]
            if rows > 1
            else np.empty((0, cols))
        )
        if rows > 1 and cols > 1:
            h_diag = haversine_m(lats[:-1], 0.0, lats[1:], dl_col)[:, None]
        else:
            h_diag = np.empty((max(0, rows - 1), max(0, cols - 1)))
        return h_e, h_s, h_diag, h_diag

    lat_grid, lon_grid = np.meshgrid(lats, lons, indexing="ij")
    horiz: list[np.ndarray] = []
    for dr, dc in NEIGHBOUR_OFFSETS:
        ra, rb = slice(0, rows - dr), slice(dr, rows)
        ca = slice(max(0, -dc), cols - max(0, dc))
        cb = slice(max(0, dc), cols - max(0, -dc))
        horiz.append(
            haversine_m(lat_grid[ra, ca], lon_grid[ra, ca], lat_grid[rb, cb], lon_grid[rb, cb])
        )
    return horiz[0], horiz[1], horiz[2], horiz[3]


def build_base_terrain(
    patch: DemPatch,
    center_lat: float,
    center_lon: float,
    radius_m: float,
) -> BaseTerrain:
    """Computes slope-limit-independent geometry for the planning area around ``center``."""
    elev = patch.elevation
    rows, cols = elev.shape
    in_area = planning_mask(patch, center_lat, center_lon, radius_m)
    horiz_by_dir = _horizontal_steps(patch)

    steps: list[_DirectionStep] = []
    pixel_slope = np.zeros((rows, cols), dtype=np.float64)
    for (dr, dc), horizontal in zip(NEIGHBOUR_OFFSETS, horiz_by_dir, strict=True):
        ra, rb = slice(0, rows - dr), slice(dr, rows)
        ca = slice(max(0, -dc), cols - max(0, dc))
        cb = slice(max(0, dc), cols - max(0, -dc))

        valid = in_area[ra, ca] & in_area[rb, cb]
        dz = elev[rb, cb] - elev[ra, ca]
        with np.errstate(invalid="ignore"):
            slope = np.where(valid, np.degrees(np.arctan2(np.abs(dz), horizontal)), 0.0)
        np.maximum(pixel_slope[ra, ca], slope, out=pixel_slope[ra, ca])
        np.maximum(pixel_slope[rb, cb], slope, out=pixel_slope[rb, cb])
        length = np.where(valid, np.hypot(horizontal, dz), math.inf)
        steps.append(_DirectionStep(ra, rb, ca, cb, valid, length, slope))
    pixel_slope[~in_area] = np.nan

    min_dx = float(horiz_by_dir[0].min()) if horiz_by_dir[0].size else 0.0
    min_dy = float(horiz_by_dir[1].min()) if horiz_by_dir[1].size else 0.0
    min_diag = (
        float(min(horiz_by_dir[2].min(), horiz_by_dir[3].min())) if horiz_by_dir[2].size else 0.0
    )
    return BaseTerrain(
        rows=rows,
        cols=cols,
        in_area=in_area,
        pixel_slope_deg=pixel_slope,
        steps=tuple(steps),
        min_dx_m=min_dx,
        min_dy_m=min_dy,
        min_diag_m=min_diag,
    )


def build_terrain_from_base(base: BaseTerrain, speed: SpeedModel) -> Terrain:
    """Applies a slope limit and speed model to precomputed ``BaseTerrain`` geometry."""
    rows, cols = base.rows, base.cols
    with np.errstate(invalid="ignore"):
        traversable = base.in_area & (base.pixel_slope_deg <= speed.max_slope_deg)

    inf = math.inf
    dist_dirs: list[np.ndarray] = []
    time_dirs: list[np.ndarray] = []
    safe_dirs: list[np.ndarray] = []
    inv_max_slope = 1.0 / speed.max_slope_deg

    for step in base.steps:
        keep = step.valid & traversable[step.ra, step.ca] & traversable[step.rb, step.cb]
        safe_slope = np.where(keep, step.slope_deg, 0.0)
        length = step.length

        d_grid = np.full((rows, cols), inf, dtype=np.float64)
        t_grid = np.full((rows, cols), inf, dtype=np.float64)
        s_grid = np.full((rows, cols), inf, dtype=np.float64)

        d_grid[step.ra, step.ca] = np.where(keep, length, inf)
        t_grid[step.ra, step.ca] = np.where(keep, length / speed.rover_mps(safe_slope), inf)
        s_grid[step.ra, step.ca] = np.where(
            keep,
            length * (1.0 + SAFETY_PENALTY * (safe_slope * inv_max_slope) ** 2),
            inf,
        )
        dist_dirs.append(d_grid)
        time_dirs.append(t_grid)
        safe_dirs.append(s_grid)

    return Terrain(
        rows=rows,
        cols=cols,
        in_area=base.in_area,
        pixel_slope_deg=base.pixel_slope_deg,
        max_slope_deg=speed.max_slope_deg,
        traversable=traversable,
        weights={
            "distance": (dist_dirs[0], dist_dirs[1], dist_dirs[2], dist_dirs[3]),
            "time": (time_dirs[0], time_dirs[1], time_dirs[2], time_dirs[3]),
            "safety": (safe_dirs[0], safe_dirs[1], safe_dirs[2], safe_dirs[3]),
        },
        min_dx_m=base.min_dx_m,
        min_dy_m=base.min_dy_m,
        min_diag_m=base.min_diag_m,
    )


def build_terrain(
    patch: DemPatch,
    center_lat: float,
    center_lon: float,
    radius_m: float,
    speed: SpeedModel,
) -> Terrain:
    """Builds the slope-safe terrain grid for the planning area around ``center``.

    A pixel's slope is its steepest step to any neighbour. Pixels steeper than the limit are
    off-limits, so routes keep clear of crater walls and scarps rather than just avoiding their
    single steepest step.
    """
    base = build_base_terrain(patch, center_lat, center_lon, radius_m)
    return build_terrain_from_base(base, speed)


def connected_component_mask(
    traversable: np.ndarray, goal_row: int, goal_col: int
) -> np.ndarray:
    """Returns a boolean mask of all pixels 8-connected to ``(goal_row, goal_col)``.

    Extracts contiguous horizontal runs of traversable pixels per row and runs an 8-connected
    interval BFS, reducing ~80k pixels to ~1k runs for >100x faster reachability classification.
    """
    rows, cols = traversable.shape
    reachable = np.zeros((rows, cols), dtype=bool)
    if rows == 0 or cols == 0 or not traversable[goal_row, goal_col]:
        return reachable

    padded = np.zeros((rows, cols + 2), dtype=np.int8)
    padded[:, 1:-1] = traversable
    diff = np.diff(padded, axis=1)
    sr, sc = np.nonzero(diff == 1)
    _, ec = np.nonzero(diff == -1)

    row_runs: list[list[tuple[int, int]]] = [[] for _ in range(rows)]
    for r, s, e in zip(sr.tolist(), sc.tolist(), ec.tolist(), strict=True):
        row_runs[r].append((s, e))

    visited = [bytearray(len(runs)) for runs in row_runs]
    stack: list[tuple[int, int, int]] = []
    for idx, (s, e) in enumerate(row_runs[goal_row]):
        if s <= goal_col < e:
            visited[goal_row][idx] = 1
            stack.append((goal_row, s, e))
            break

    while stack:
        r, s, e = stack.pop()
        reachable[r, s:e] = True
        for nr in (r - 1, r + 1):
            if 0 <= nr < rows:
                nruns = row_runs[nr]
                nvis = visited[nr]
                for idx, (ns, ne) in enumerate(nruns):
                    if ns > e:
                        break
                    if not nvis[idx] and s <= ne:
                        nvis[idx] = 1
                        stack.append((nr, ns, ne))

    return reachable


def build_distance_heuristic(
    patch: DemPatch, terrain: Terrain, goal_row: int, goal_col: int
) -> np.ndarray:
    """Admissible and consistent distance-to-goal lower bound (metres) for every grid cell.

    Takes the pointwise maximum of exact spherical great-circle distance and a grid-wide octile
    lower bound, both of which are consistent (so their maximum is also consistent).
    """
    glat = float(patch.lats[goal_row])
    glon = float(patch.lons[goal_col])
    p1 = math.radians(glat)
    p2 = np.radians(patch.lats)[:, None]
    dp = p2 - p1
    dl = np.radians(patch.lons)[None, :] - math.radians(glon)
    a = np.sin(dp * 0.5) ** 2 + (math.cos(p1) * np.cos(p2)) * (np.sin(dl * 0.5) ** 2)
    h_hav = (2.0 * MARS_RADIUS_M) * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    if terrain.min_dx_m > 0.0 and terrain.min_dy_m > 0.0 and terrain.min_diag_m > 0.0:
        min_diag = min(terrain.min_diag_m, terrain.min_dx_m + terrain.min_dy_m)
        if min_diag >= terrain.min_dx_m and min_diag >= terrain.min_dy_m:
            dr = np.abs(np.arange(terrain.rows) - goal_row)[:, None]
            dc = np.abs(np.arange(terrain.cols) - goal_col)[None, :]
            diag = np.minimum(dr, dc)
            h_oct = (
                diag * min_diag
                + (dr - diag) * terrain.min_dy_m
                + (dc - diag) * terrain.min_dx_m
            )
            h_hav = np.maximum(h_hav, h_oct)

    return h_hav * HEURISTIC_EPS


def astar_path(
    terrain: Terrain,
    start: int,
    goal: int,
    weight_kind: str,
    heuristic: list[float],
) -> list[int] | None:
    """Exact A* shortest path on the 8-connected terrain grid.

    Returns the list of flat ``node_id`` integers from ``start`` to ``goal``, or ``None`` if no
    path exists. All 4 directional weight lists are padded with ``cols + 1`` ``+inf`` sentinels so
    every 8-neighbour lookup is bounds-safe without per-step coordinate checks.
    """
    rows, cols = terrain.rows, terrain.cols
    n = rows * cols
    if start == goal:
        return [start]

    inf = math.inf
    pad = [inf] * (cols + 1)
    w_e_arr, w_s_arr, w_se_arr, w_sw_arr = terrain.weights[weight_kind]
    w_e = w_e_arr.ravel().tolist() + pad
    w_s = w_s_arr.ravel().tolist() + pad
    w_se = w_se_arr.ravel().tolist() + pad
    w_sw = w_sw_arr.ravel().tolist() + pad

    g_score = [inf] * n
    parent = [-1] * n
    closed = bytearray(n)
    g_score[start] = 0.0

    heap: list[tuple[float, int]] = [(heuristic[start], start)]
    heappop = heapq.heappop
    heappush = heapq.heappush
    d_s = cols
    d_se = cols + 1
    d_sw = cols - 1

    while heap:
        _, u = heappop(heap)
        if closed[u]:
            continue
        if u == goal:
            path: list[int] = []
            cur = goal
            while cur != -1:
                path.append(cur)
                cur = parent[cur]
            path.reverse()
            return path

        closed[u] = 1
        g = g_score[u]

        # East (u + 1)
        w = w_e[u]
        if w < inf:
            v = u + 1
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # West (u - 1)
        w = w_e[u - 1]
        if w < inf:
            v = u - 1
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # South (u + cols)
        w = w_s[u]
        if w < inf:
            v = u + d_s
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # North (u - cols)
        w = w_s[u - d_s]
        if w < inf:
            v = u - d_s
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # South-East (u + cols + 1)
        w = w_se[u]
        if w < inf:
            v = u + d_se
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # North-West (u - cols - 1)
        w = w_se[u - d_se]
        if w < inf:
            v = u - d_se
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # South-West (u + cols - 1)
        w = w_sw[u]
        if w < inf:
            v = u + d_sw
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

        # North-East (u - cols + 1)
        w = w_sw[u - d_sw]
        if w < inf:
            v = u - d_sw
            if not closed[v]:
                ng = g + w
                if ng < g_score[v]:
                    g_score[v] = ng
                    parent[v] = u
                    heappush(heap, (ng + heuristic[v], v))

    return None
