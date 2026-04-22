"""
RF Path Coverage Analyzer - Flask Backend

Terrain engine:
  • Primary elevation: AWS Terrarium RGB tiles (zoom 14→13→12, ~9m res)
    https://registry.opendata.aws/terrain-tiles/
  • Fallback: OpenTopoData SRTM30m API (batch 100 pts)
  • Fallback: USGS EPQS (concurrent single-point, US only)
  • All tiles/points cached to disk; in-memory during session

Propagation model (mesh_terrain + Radio-Mobile methodology):
  • Earth effective radius Re = 6371 km × 4/3 (k-factor standard atmosphere)
  • Curvature bulge: h_b = d1·d2 / (2·Re_eff) added to each terrain point
  • Diffraction: Deygout 2-level knife-edge (ITU-R P.526 v-parameter)
  • FSPL: 32.44 + 20·log10(f_MHz) + 20·log10(d_km)
  • Link budget: Pr = Pt + Gt + Gr − FSPL − L_diffraction
"""

import csv
import io
import json
import math
import os
import re
import sqlite3
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import unquote
from collections import OrderedDict
import functools
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_file, stream_with_context
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# App & directory setup
# ---------------------------------------------------------------------------

import logging

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")

BASE_DIR  = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
KML_DIR      = UPLOAD_DIR / "kml"
CSV_DIR      = UPLOAD_DIR / "csv"
TILE_DIR     = UPLOAD_DIR / "tiles"
ANALYSES_DIR = UPLOAD_DIR / "analyses"
CACHE_FILE   = UPLOAD_DIR / "elevation_cache.json"   # legacy — migrated on first run
ELEV_DB      = UPLOAD_DIR / "elevation_cache.db"     # SQLite — current store

for d in [KML_DIR, CSV_DIR, TILE_DIR, ANALYSES_DIR]:
    d.mkdir(parents=True, exist_ok=True)

ALLOWED_KML = {"kml", "kmz"}
ALLOWED_CSV = {"csv"}

_http = requests.Session()
_http.headers["User-Agent"] = "RF-Coverage-Analyzer/1.0 (terrain analysis)"

# ---------------------------------------------------------------------------
# Point-elevation fallback cache  —  SQLite (WAL mode, disk-backed)
#
# Why SQLite instead of a JSON dict?
#   • The in-memory dict grows without bound for large geographic areas.
#   • SQLite keeps data on disk; only queried rows are loaded into RAM.
#   • WAL mode allows concurrent readers while a writer is active, which
#     matters because prefetch and per-point lookups run on different threads.
# ---------------------------------------------------------------------------

_db_lock = threading.Lock()   # serialise writes; reads are lock-free in WAL
_db_conn: sqlite3.Connection  # module-level singleton


def _open_elev_db() -> sqlite3.Connection:
    """Open (or create) the SQLite elevation cache and migrate legacy JSON."""
    conn = sqlite3.connect(str(ELEV_DB), check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")      # concurrent read/write
    conn.execute("PRAGMA synchronous=NORMAL")    # safe, faster than FULL
    conn.execute("PRAGMA cache_size=-8192")      # 8 MB page cache per connection
    conn.execute("""
        CREATE TABLE IF NOT EXISTS elev_pts (
            key  TEXT PRIMARY KEY,
            val  REAL NOT NULL
        )
    """)
    conn.commit()

    # One-time migration from the legacy JSON file
    if CACHE_FILE.exists():
        try:
            count = conn.execute("SELECT COUNT(*) FROM elev_pts").fetchone()[0]
            if count == 0:
                with open(CACHE_FILE) as f:
                    legacy: dict = json.load(f)
                conn.executemany(
                    "INSERT OR IGNORE INTO elev_pts (key, val) VALUES (?, ?)",
                    legacy.items(),
                )
                conn.commit()
                app.logger.info(
                    "Migrated %d elevation entries from JSON → SQLite", len(legacy)
                )
            CACHE_FILE.rename(CACHE_FILE.with_suffix(".json.bak"))
        except Exception as exc:
            app.logger.warning("Legacy cache migration skipped: %s", exc)

    return conn


_db_conn = _open_elev_db()


def _elev_key(lat: float, lon: float) -> str:
    return f"{round(lat, 4)},{round(lon, 4)}"


# ---------- thin helpers (called everywhere the old dict was used) ----------

def _pt_get(key: str) -> float | None:
    """Return cached elevation or None (no memory copy of the full table)."""
    row = _db_conn.execute(
        "SELECT val FROM elev_pts WHERE key=?", (key,)
    ).fetchone()
    return row[0] if row else None


def _pt_put(key: str, val: float) -> None:
    with _db_lock:
        _db_conn.execute(
            "INSERT OR REPLACE INTO elev_pts (key, val) VALUES (?, ?)", (key, val)
        )
        _db_conn.commit()


def _pt_put_many(kvs: list[tuple[str, float]]) -> None:
    """Batch insert/replace — much faster than individual _pt_put calls."""
    if not kvs:
        return
    with _db_lock:
        _db_conn.executemany(
            "INSERT OR REPLACE INTO elev_pts (key, val) VALUES (?, ?)", kvs
        )
        _db_conn.commit()


def _pt_uncached(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Return the subset of (lat, lon) pairs that are NOT in the cache.

    Uses chunked IN-queries (SQLite limit: 999 variables per statement) so
    a 10 000-point list is resolved in ~12 round-trips rather than 10 000.
    """
    rounded = list(dict.fromkeys(  # deduplicate while preserving order
        (round(la, 4), round(lo, 4)) for la, lo in points
    ))
    if not rounded:
        return []

    keys       = [_elev_key(*p) for p in rounded]
    cached_set: set[str] = set()
    CHUNK      = 900  # stay under the 999-variable SQLite limit

    for i in range(0, len(keys), CHUNK):
        batch = keys[i : i + CHUNK]
        placeholders = ",".join("?" * len(batch))
        rows = _db_conn.execute(
            f"SELECT key FROM elev_pts WHERE key IN ({placeholders})", batch
        ).fetchall()
        cached_set.update(r[0] for r in rows)

    return [p for p, k in zip(rounded, keys) if k not in cached_set]


# ---------------------------------------------------------------------------
# AWS Terrarium elevation tile service
# Encoding: elev_m = R*256 + G + B/256 − 32768
# Zoom levels: 14 (~9.4 m/px), 13 (~18.8 m/px), 12 (~37.6 m/px)
# ---------------------------------------------------------------------------

class ElevationTileService:
    URL   = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png"
    ZOOMS = [14, 13, 12]

    # Maximum number of decoded tiles to keep in RAM simultaneously.
    # Each tile is stored as raw RGB bytes: 256×256×3 = 196 608 bytes ≈ 192 KB.
    # 500 tiles × 192 KB ≈ 96 MB — a practical ceiling for large courses.
    # Evicted tiles remain on disk and are re-decoded on next access (cheap).
    TILE_CACHE_MAX = 2048

    def __init__(self, tile_dir: Path):
        self.tile_dir = tile_dir
        # OrderedDict used as an LRU: most-recently-used at the right end.
        # Values are raw RGB bytes (not a list of tuples — 26× less memory).
        self._mem: OrderedDict[tuple, bytes] = OrderedDict()
        self._lock = threading.Lock()

    # -- Tile coordinate math --

    @staticmethod
    def _tile_xy(lat: float, lon: float, zoom: int) -> tuple[int, int]:
        n = 1 << zoom
        x = int((lon + 180.0) / 360.0 * n)
        lr = math.radians(lat)
        y = int((1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n)
        return max(0, min(n - 1, x)), max(0, min(n - 1, y))

    @staticmethod
    def _tile_bounds(x: int, y: int, zoom: int) -> tuple[float, float, float, float]:
        """Returns (lat_N, lon_W, lat_S, lon_E)."""
        n = 1 << zoom
        lon_w = x / n * 360.0 - 180.0
        lon_e = (x + 1) / n * 360.0 - 180.0
        lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
        lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
        return lat_n, lon_w, lat_s, lon_e

    # -- LRU helpers (must be called with self._lock held) --

    def _lru_get(self, key: tuple) -> bytes | None:
        if key not in self._mem:
            return None
        self._mem.move_to_end(key)   # mark as most-recently-used
        return self._mem[key]

    def _lru_put(self, key: tuple, data: bytes) -> None:
        if key in self._mem:
            self._mem.move_to_end(key)
        self._mem[key] = data
        # Evict LRU entries until we're within the limit
        while len(self._mem) > self.TILE_CACHE_MAX:
            evicted_key, _ = self._mem.popitem(last=False)
            app.logger.debug("Tile LRU evict: z%d/%d/%d", *evicted_key)

    # -- Tile loading (disk-cached PNGs → in-memory raw bytes) --

    def _load_tile(self, z: int, x: int, y: int) -> bytes | None:
        key = (z, x, y)

        with self._lock:
            cached = self._lru_get(key)
            if cached is not None:
                return cached

        path = self.tile_dir / f"t{z}_{x}_{y}.png"

        # Remove corrupt / zero-byte files left by a previous failed download
        if path.exists() and path.stat().st_size < 67:
            app.logger.warning("Tile cache: removing corrupt file %s (%d bytes)",
                               path.name, path.stat().st_size)
            path.unlink()

        # Download if not on disk
        if not path.exists():
            url = self.URL.format(z=z, x=x, y=y)
            try:
                r = _http.get(url, timeout=25)
                if r.status_code == 200:
                    path.write_bytes(r.content)
                    app.logger.debug("Tile downloaded: z%d/%d/%d", z, x, y)
                else:
                    app.logger.warning("Tile HTTP %d for z%d/%d/%d", r.status_code, z, x, y)
                    return None   # do NOT cache failure
            except Exception as exc:
                app.logger.warning("Tile download error z%d/%d/%d: %s", z, x, y, exc)
                return None

        # Decode PNG → raw RGB bytes  (256×256×3 = 196 608 bytes ≈ 192 KB)
        # This is ~26× smaller than a Python list[tuple[int,int,int]] for the
        # same data, because it avoids CPython's per-object overhead.
        try:
            from PIL import Image
            img = Image.open(str(path)).convert("RGB")
            data = img.tobytes()                       # flat R,G,B,R,G,B,… bytes
            if len(data) != 256 * 256 * 3:
                raise ValueError(f"unexpected byte count {len(data)}")
            with self._lock:
                self._lru_put(key, data)
            return data
        except Exception as exc:
            app.logger.warning("Tile decode error z%d/%d/%d: %s — deleting cached file",
                               z, x, y, exc)
            if path.exists():
                path.unlink()
            return None   # do NOT store None — allow retry

    # -- Bilinear elevation query --

    def _elev_from_pixels(self, data: bytes, px: float, py: float) -> float:
        """Bilinear interpolation over raw RGB bytes (3 bytes per pixel, row-major)."""
        px = max(0.0, min(254.99, px))
        py = max(0.0, min(254.99, py))
        x0, y0 = int(px), int(py)
        fx, fy = px - x0, py - y0

        def pe(xi: int, yi: int) -> float:
            idx = (yi * 256 + xi) * 3
            r, g, b = data[idx], data[idx + 1], data[idx + 2]
            return r * 256.0 + g + b / 256.0 - 32768.0

        return (
            pe(x0,     y0    ) * (1 - fx) * (1 - fy)
            + pe(x0 + 1, y0    ) * fx       * (1 - fy)
            + pe(x0,     y0 + 1) * (1 - fx) * fy
            + pe(x0 + 1, y0 + 1) * fx       * fy
        )

    def get_elevation(self, lat: float, lon: float) -> float | None:
        """Return elevation in metres MSL, or None if tiles unavailable."""
        for zoom in self.ZOOMS:
            tx, ty   = self._tile_xy(lat, lon, zoom)
            pixels   = self._load_tile(zoom, tx, ty)
            if pixels is None:
                continue
            lat_n, lon_w, lat_s, lon_e = self._tile_bounds(tx, ty, zoom)
            if lon_e == lon_w or lat_n == lat_s:
                continue
            px = (lon - lon_w) / (lon_e - lon_w) * 255.0
            py = (lat_n - lat) / (lat_n - lat_s) * 255.0
            try:
                e = self._elev_from_pixels(pixels, px, py)
                if -500 <= e <= 9000:
                    return e
            except Exception:
                continue
        return None

    def prefetch_area(
        self,
        lat_min: float, lat_max: float,
        lon_min: float, lon_max: float,
        progress_cb=None,
    ) -> int:
        """Download & cache all tiles covering the padded bounding box.

        Tiles are fetched in parallel (up to 32 concurrent HTTP requests).
        The LRU lock is held only for brief dict operations — not during the
        actual HTTP download or PNG decode — so concurrent fetches are safe.
        """
        pad = 0.05  # ~5 km margin
        la0, la1 = lat_min - pad, lat_max + pad
        lo0, lo1 = lon_min - pad, lon_max + pad

        tiles: set[tuple[int, int, int]] = set()
        for z in self.ZOOMS:
            x0, y0 = self._tile_xy(la1, lo0, z)   # NW → top-left tile
            x1, y1 = self._tile_xy(la0, lo1, z)   # SE → bottom-right tile
            for tx in range(x0, x1 + 1):
                for ty in range(y0, y1 + 1):
                    tiles.add((z, tx, ty))

        tile_list  = sorted(tiles)   # deterministic order
        total      = len(tile_list)
        if not total:
            return 0

        done_count = [0]
        cb_lock    = threading.Lock()

        def _fetch_one(zxy: tuple[int, int, int]) -> None:
            self._load_tile(*zxy)
            if progress_cb:
                with cb_lock:
                    done_count[0] += 1
                    progress_cb(done_count[0], total)

        # Cap at 32 concurrent downloads to avoid overwhelming the tile CDN.
        max_workers = min(32, total)
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            list(ex.map(_fetch_one, tile_list))

        return total


_tiles = ElevationTileService(TILE_DIR)


# ---------------------------------------------------------------------------
# Point-elevation fallback APIs (used when tiles unavailable)
# ---------------------------------------------------------------------------

def _fetch_opentopodata(chunk: list[tuple[float, float]]) -> bool:
    """OpenTopoData SRTM30m — up to 100 pts per call."""
    try:
        locs = "|".join(f"{la},{lo}" for la, lo in chunk)
        resp = _http.get(
            "https://api.opentopodata.org/v1/srtm30m",
            params={"locations": locs},
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "OK":
                results = data.get("results", [])
                if len(results) == len(chunk):
                    kvs = []
                    for j, r in enumerate(results):
                        la, lo = chunk[j]
                        elev = r.get("elevation")
                        if elev is not None:   # skip null/nodata
                            kvs.append((_elev_key(la, lo), float(elev)))
                    _pt_put_many(kvs)
                    return True
    except Exception:
        pass
    return False


def _fetch_open_elevation(chunk: list[tuple[float, float]]) -> bool:
    """Open-Elevation API — up to 500 pts per call."""
    try:
        locations = [{"latitude": la, "longitude": lo} for la, lo in chunk]
        resp = _http.post(
            "https://api.open-elevation.com/api/v1/lookup",
            json={"locations": locations},
            timeout=45,
        )
        if resp.status_code == 200:
            results = resp.json().get("results", [])
            if len(results) == len(chunk):
                kvs = []
                for j, r in enumerate(results):
                    la, lo = chunk[j]
                    elev = r.get("elevation")
                    if elev is not None:   # skip null/nodata
                        kvs.append((_elev_key(la, lo), float(elev)))
                _pt_put_many(kvs)
                return True
    except Exception:
        pass
    return False


def _fetch_usgs_single(lat_lon: tuple[float, float]) -> tuple[float, float, float | None]:
    """Returns (lat, lon, elevation_m) or (lat, lon, None) on failure/nodata."""
    la, lo = lat_lon
    try:
        resp = _http.get(
            f"https://epqs.nationalmap.gov/v1/json?x={lo}&y={la}&units=Meters&includeDate=false",
            timeout=10,
        )
        if resp.status_code == 200:
            val = resp.json().get("value")
            if val is not None and float(val) != -1_000_000:
                return la, lo, float(val)
    except Exception:
        pass
    return la, lo, None  # failure — caller must NOT store this in the cache


def fetch_fallback_elevations(points: list[tuple[float, float]], progress_cb=None):
    """
    Fetch point elevations via API chain when tiles fail.  Writes to SQLite cache.

    Strategy (per 100-point chunk):
      1. OpenTopoData SRTM30m  — free, reliable, 100 pts/req
      2. Open-Elevation        — free, 500 pts/req (tried if OTD fails)
      3. USGS EPQS             — US only, concurrent single-point requests

    Already-cached points are skipped using a single chunked SQL IN-query
    rather than checking a full in-memory dict — O(n/900) round-trips.
    """
    uncached = _pt_uncached(points)

    if not uncached:
        if progress_cb:
            progress_cb(len(points), len(points))
        return

    app.logger.info("Fallback elevation: fetching %d uncached points", len(uncached))
    fetched    = 0
    chunk_size = 100

    for i in range(0, len(uncached), chunk_size):
        chunk = uncached[i : i + chunk_size]

        success = _fetch_opentopodata(chunk)
        if not success:
            success = _fetch_open_elevation(chunk)
        if not success:
            # USGS EPQS: concurrent single-point requests (US coverage only)
            kvs: list[tuple[str, float]] = []
            with ThreadPoolExecutor(max_workers=16) as ex:
                futs = {ex.submit(_fetch_usgs_single, p): p for p in chunk}
                for fut in as_completed(futs):
                    la, lo, elev = fut.result()
                    if elev is not None:   # skip failure sentinel
                        kvs.append((_elev_key(la, lo), elev))
            _pt_put_many(kvs)

        fetched += len(chunk)
        if progress_cb:
            progress_cb(fetched, len(uncached))

        if fetched < len(uncached):
            time.sleep(0.15)   # gentle rate-limiting between chunks

    app.logger.info("Fallback elevation: done (%d new points cached)", fetched)


# ---------------------------------------------------------------------------
# Unified elevation getter: tile service → point cache
# ---------------------------------------------------------------------------

def _get_elev(lat: float, lon: float) -> float:
    e = _tiles.get_elevation(lat, lon)
    if e is not None:
        return e
    cached = _pt_get(_elev_key(lat, lon))
    return cached if cached is not None else 0.0


# ---------------------------------------------------------------------------
# Geodetic helpers
# ---------------------------------------------------------------------------

EARTH_R      = 6_371_000.0               # true mean radius, m
EARTH_RE_EFF = EARTH_R * (4.0 / 3.0)    # effective radius, standard k-factor

# Coordinate precision: 6 decimal places ≈ 0.11 m — sufficient for all RF
# path-loss and terrain analysis; avoids accumulated floating-point drift.
_COORD_DP = 6

def _rc(v: float) -> float:
    """Round a latitude or longitude to _COORD_DP decimal places."""
    return round(v, _COORD_DP)


def haversine(lat1, lon1, lat2, lon2) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def intermediate_point(lat1, lon1, lat2, lon2, f: float) -> tuple[float, float]:
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = 2 * math.asin(
        math.sqrt(
            math.sin((lat2 - lat1) / 2) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
        )
    )
    if d < 1e-10:
        return _rc(math.degrees(lat1)), _rc(math.degrees(lon1))
    a = math.sin((1 - f) * d) / math.sin(d)
    b = math.sin(f * d) / math.sin(d)
    x = a * math.cos(lat1) * math.cos(lon1) + b * math.cos(lat2) * math.cos(lon2)
    y = a * math.cos(lat1) * math.sin(lon1) + b * math.cos(lat2) * math.sin(lon2)
    z = a * math.sin(lat1) + b * math.sin(lat2)
    return _rc(math.degrees(math.atan2(z, math.sqrt(x**2 + y**2)))), _rc(math.degrees(math.atan2(y, x)))


def interpolate_path(waypoints: list[tuple[float, float]], max_pts: int = 600) -> list[tuple[float, float]]:
    if len(waypoints) < 2:
        return waypoints
    total_dist = sum(
        haversine(waypoints[i][0], waypoints[i][1], waypoints[i + 1][0], waypoints[i + 1][1])
        for i in range(len(waypoints) - 1)
    )
    spacing = max(50.0, total_dist / max_pts)
    result = [waypoints[0]]
    for i in range(len(waypoints) - 1):
        lat1, lon1 = waypoints[i]
        lat2, lon2 = waypoints[i + 1]
        seg = haversine(lat1, lon1, lat2, lon2)
        n   = max(1, int(seg / spacing))
        for j in range(1, n + 1):
            result.append(intermediate_point(lat1, lon1, lat2, lon2, j / n))
    return result


# ---------------------------------------------------------------------------
# RF / propagation calculations
# ---------------------------------------------------------------------------

# Sample spacing for terrain profiles.
# At zoom-14 tiles: ~9.4 m/pixel → 30 m gives ~3 tile pixels per sample,
# sufficient to detect sub-30 m ridges via bilinear interpolation.
TERRAIN_SPACING = 30   # metres


def earth_bulge(d1_m: float, total_dist_m: float) -> float:
    """
    Additional apparent terrain height at distance d1 from Tx due to Earth
    curvature under standard tropospheric refraction (k = 4/3).

    h_b = d1 * d2 / (2 * Re_eff)   [metres]
    """
    d2_m = max(0.0, total_dist_m - d1_m)
    return (d1_m * d2_m) / (2.0 * EARTH_RE_EFF)


def fspl_db(freq_mhz: float, dist_m: float) -> float:
    """Free-space path loss: 32.44 + 20log10(f_MHz) + 20log10(d_km)"""
    return 32.44 + 20 * math.log10(freq_mhz) + 20 * math.log10(max(dist_m, 1.0) / 1000.0)


def knife_edge_loss_db(v: float) -> float:
    """
    ITU-R P.526-15 knife-edge diffraction loss for Fresnel-Kirchhoff
    parameter v.  Returns 0 dB for v < −0.7 (clear Fresnel zone).
    """
    if v < -0.7:
        return 0.0
    return max(0.0, 6.9 + 20 * math.log10(math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1))


# Profile entry type: (fraction, d1_m, terrain_elev_m, eff_terrain_m)
# eff_terrain = terrain_elev + earth_bulge(d1, total_dist)

ProfileEntry = tuple[float, float, float, float]

_ELEV_WINDOW = 8   # points either side used for outlier context


def _profile_median(vals: list[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[len(s) // 2]


def _get_elev_nullable(lat: float, lon: float) -> float | None:
    """Like _get_elev but returns None when no data is available."""
    e = _tiles.get_elevation(lat, lon)
    if e is not None:
        return e
    return _pt_get(_elev_key(lat, lon))   # None if absent — caller treats as missing


def validate_and_repair_profile(
    profile: list[ProfileEntry],
    total_dist: float,
) -> tuple[list[ProfileEntry], int]:
    """
    Detect and repair bad elevation samples in a terrain profile.

    Bad samples are:
      • None / unavailable (tile miss + no cache entry)
      • Near-zero (< 1 m) when the surrounding median is > 50 m above sea level
      • Outlier spikes: deviation from local median > max(300 m, 6 × MAD)

    Bad samples are replaced by linear interpolation between the nearest
    valid neighbours.  Returns (repaired_profile, count_repaired).
    """
    n = len(profile)
    if n < 3:
        return profile, 0

    raw: list[float | None] = [te for (_, _, te, _) in profile]

    def ctx_window(i: int) -> list[float]:
        lo = max(0, i - _ELEV_WINDOW)
        hi = min(n, i + _ELEV_WINDOW + 1)
        return [raw[j] for j in range(lo, hi) if j != i and raw[j] is not None]

    bad: set[int] = set()
    for i, te in enumerate(raw):
        if te is None:
            bad.add(i); continue
        win = ctx_window(i)
        if not win:
            continue
        med = _profile_median(win)
        mad = _profile_median([abs(v - med) for v in win]) or 1.0
        if abs(te) < 1.0 and med > 50.0:          # zero-fill surrounded by hills
            bad.add(i)
        elif abs(te - med) > max(300.0, 6.0 * mad):  # spike / pit outlier
            bad.add(i)

    if not bad:
        return profile, 0

    # Interpolate bad samples from nearest valid neighbours (left-to-right so
    # earlier repairs can serve as anchors for later ones).
    repaired = list(profile)
    clean: list[float] = [te if te is not None else 0.0 for te in raw]

    for i in sorted(bad):
        left  = next((j for j in range(i - 1, -1, -1) if j not in bad), None)
        right = next((j for j in range(i + 1,  n)      if j not in bad), None)
        if left is not None and right is not None:
            alpha    = (i - left) / (right - left)
            te_fixed = clean[left] * (1.0 - alpha) + clean[right] * alpha
        elif left is not None:
            te_fixed = clean[left]
        elif right is not None:
            te_fixed = clean[right]
        else:
            te_fixed = 0.0
        clean[i] = te_fixed
        f, d1, _, _ = profile[i]
        repaired[i] = (f, d1, te_fixed, te_fixed + earth_bulge(d1, total_dist))

    return repaired, len(bad)


def build_terrain_profile(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[list[ProfileEntry], float]:
    """
    Sample the terrain between two points, apply Earth curvature correction,
    then validate and repair any missing or anomalous elevation samples.

    Returns (profile, total_dist_m) where each profile entry is:
      (fraction, d1_m, terrain_elev_m, eff_terrain_m)
    """
    total_dist = haversine(lat1, lon1, lat2, lon2)
    n = max(10, int(total_dist / TERRAIN_SPACING))
    profile: list[ProfileEntry] = []
    for i in range(n + 1):
        f  = i / n
        d1 = f * total_dist
        mlat, mlon = intermediate_point(lat1, lon1, lat2, lon2, f)
        t_elev = _get_elev_nullable(mlat, mlon)  # None if truly missing
        te     = t_elev if t_elev is not None else 0.0
        eff    = te + (earth_bulge(d1, total_dist) if total_dist > 1 else 0.0)
        profile.append((f, d1, te, eff))
        # Carry nullable value forward for validation
        profile[-1] = (f, d1, t_elev, eff)  # type: ignore[assignment]

    profile, n_bad = validate_and_repair_profile(profile, total_dist)
    if n_bad:
        app.logger.warning("Repaired %d/%d bad elevation samples", n_bad, len(profile))
    return profile, total_dist


# ---------------------------------------------------------------------------
# Terrain profile cache
#
# Profiles are pure functions of the four endpoint coordinates — identical
# coordinates always produce identical terrain samples regardless of RF
# parameters.  Caching eliminates redundant recomputation when:
#   • The same analysis is re-run with different RF settings
#   • Two path points round to the same coordinate key
#   • The same (source, receiver) pair appears in both track and link phases
#
# maxsize=8192: each cached entry is ~(350 × 4 floats + metadata) ≈ 12 KB
# → 8192 entries ≈ 96 MB per process, acceptable on a server.
# The cache is per-process — pool workers accumulate hits independently.
# ---------------------------------------------------------------------------

@functools.lru_cache(maxsize=8_192)
def _terrain_profile_cached(
    lat1: float, lon1: float, lat2: float, lon2: float,
) -> tuple[list[ProfileEntry], float]:
    """Memoized wrapper around build_terrain_profile.

    Arguments must already be rounded to _COORD_DP decimal places so that
    logically identical paths hash to the same cache key.  The returned
    profile list is treated as read-only by all callers.
    """
    return build_terrain_profile(lat1, lon1, lat2, lon2)


def _dominant_obstacle(
    profile: list[ProfileEntry],
    from_total: float,
    to_total: float,
    total_dist: float,
    freq_mhz: float,
) -> tuple[float, int]:
    """
    Find the terrain point with the largest Fresnel-Kirchhoff v parameter.
    Uses eff_terrain (terrain + curvature) vs. the straight LOS line.
    """
    wl = 300.0 / freq_mhz   # wavelength, m
    max_v, max_i = -9999.0, -1

    for i, (frac, d1, _, eff) in enumerate(profile):
        if frac <= 0.0 or frac >= 1.0:
            continue
        d2 = total_dist - d1
        if d1 < 0.5 or d2 < 0.5:
            continue
        los = from_total + frac * (to_total - from_total)
        h   = eff - los
        v   = h * math.sqrt(2.0 * total_dist / (wl * d1 * d2))
        if v > max_v:
            max_v, max_i = v, i

    return max_v, max_i


ObstacleInfo = dict  # {"d_m", "eff_m", "v", "loss_db", "level"}


def deygout_detail(
    profile: list[ProfileEntry],
    from_total: float,
    to_total: float,
    total_dist: float,
    freq_mhz: float,
) -> tuple[float, list[ObstacleInfo]]:
    """
    Deygout 2-level multi-knife-edge diffraction (ITU-R P.526).

    Returns (total_loss_db, obstacles) where each obstacle dict contains:
      d_m      – distance from TX (m, in original profile coords)
      eff_m    – effective terrain height at that point (terrain + earth bulge, m MSL)
      v        – Fresnel-Kirchhoff v-parameter
      loss_db  – knife-edge loss contribution from this obstacle (dB)
      level    – 0 = dominant obstacle, 1 = secondary sub-path obstacle

    Earth curvature is re-applied to each sub-path independently.
    For secondary obstacles the reported d_m / eff_m are looked up from the
    original full profile so they map correctly onto the drawn terrain cross-section.
    """
    obstacles: list[ObstacleInfo] = []

    v1, idx1 = _dominant_obstacle(profile, from_total, to_total, total_dist, freq_mhz)
    if v1 < -0.7 or idx1 < 0:
        return 0.0, obstacles

    loss1 = knife_edge_loss_db(v1)
    frac1, d1_main, _, eff1 = profile[idx1]
    obstacles.append({
        "d_m":     round(d1_main, 1),
        "eff_m":   round(eff1,    1),
        "v":       round(v1,      2),
        "loss_db": round(loss1,   1),
        "level":   0,
    })
    total_loss = loss1
    d2_main    = total_dist - d1_main

    # ---- Left sub-path: TX → dominant obstacle ----
    left: list[ProfileEntry] = []
    left_orig:  list[int]    = []   # original profile indices (for display coords)
    for i, (f, d1, te, _) in enumerate(profile):
        if 0.0 < f < frac1 and d1_main > 0:
            sf = d1 / d1_main
            se = te + earth_bulge(d1, d1_main)
            left.append((sf, d1, te, se))
            left_orig.append(i)
    if len(left) >= 2:
        v2, idx2 = _dominant_obstacle(left, from_total, eff1, d1_main, freq_mhz)
        if v2 > -0.7 and idx2 >= 0:
            loss2 = knife_edge_loss_db(v2)
            total_loss += loss2
            # Use original-profile eff_m so it aligns with the drawn terrain
            oi = left_orig[idx2]
            _, d_orig, _, eff_orig = profile[oi]
            obstacles.append({
                "d_m":     round(d_orig,  1),
                "eff_m":   round(eff_orig, 1),
                "v":       round(v2,       2),
                "loss_db": round(loss2,    1),
                "level":   1,
            })

    # ---- Right sub-path: dominant obstacle → RX ----
    right: list[ProfileEntry] = []
    right_orig: list[int]    = []
    for i, (f, d1, te, _) in enumerate(profile):
        if frac1 < f < 1.0 and d2_main > 0:
            sd1 = d1 - d1_main
            sf  = sd1 / d2_main
            se  = te + earth_bulge(sd1, d2_main)
            right.append((sf, sd1, te, se))
            right_orig.append(i)
    if len(right) >= 2:
        v2, idx2 = _dominant_obstacle(right, eff1, to_total, d2_main, freq_mhz)
        if v2 > -0.7 and idx2 >= 0:
            loss2 = knife_edge_loss_db(v2)
            total_loss += loss2
            oi = right_orig[idx2]
            _, d_orig, _, eff_orig = profile[oi]
            obstacles.append({
                "d_m":     round(d_orig,   1),
                "eff_m":   round(eff_orig,  1),
                "v":       round(v2,        2),
                "loss_db": round(loss2,     1),
                "level":   1,
            })

    return round(total_loss, 1), obstacles


def deygout_loss_db(
    profile: list[ProfileEntry],
    from_total: float,
    to_total: float,
    total_dist: float,
    freq_mhz: float,
    depth: int = 0,   # kept for API compatibility; 2-level is always used
) -> float:
    """Convenience wrapper — returns only the loss scalar."""
    loss, _ = deygout_detail(profile, from_total, to_total, total_dist, freq_mhz)
    return loss


# ---------------------------------------------------------------------------
# Vegetation / clutter attenuation  (ITU-R P.833-9 inspired)
# ---------------------------------------------------------------------------

# Each entry defines:
#   canopy_h_m – assumed mean canopy height above ground (m)
#   max_db     – plateau / maximum excess loss (dB); signal is practically
#                blocked once this is reached (hard-fail threshold = 30 dB)
#   gamma      – specific attenuation (dB/m) keyed by frequency (MHz);
#                values from P.833-9 Table 1 (in-leaf woodland) scaled to
#                match measured UHF/VHF excess-loss empirical data
VEG_PROFILES: dict[str, dict] = {
    "none": {
        "label": "None / rocky",
        "canopy_h_m": 0, "max_db": 0,
        "gamma": {144: 0.000, 433: 0.000, 915: 0.000},
    },
    "shrubs": {
        "label": "Shrubs / low scrub",
        "canopy_h_m": 2, "max_db": 6,
        "gamma": {144: 0.010, 433: 0.025, 915: 0.050},
    },
    "light": {
        "label": "Light trees / open woodland",
        "canopy_h_m": 8, "max_db": 15,
        "gamma": {144: 0.030, 433: 0.060, 915: 0.120},
    },
    "dense": {
        "label": "Dense forest / jungle",
        "canopy_h_m": 15, "max_db": 30,
        "gamma": {144: 0.060, 433: 0.120, 915: 0.250},
    },
}

# Hard-fail threshold: if either diffraction OR vegetation loss exceeds this,
# the path is considered unworkable regardless of the computed RSSI.
HARD_FAIL_DB = 30.0

# ---------------------------------------------------------------------------
# ProcessPoolExecutor — true multi-core parallelism for RF analysis
#
# Each pool worker is a separate OS process with its own GIL, tile LRU cache,
# and SQLite connection.  This eliminates the GIL bottleneck that limited
# ThreadPoolExecutor to ~1.3× speedup regardless of core count.
#
# _POOL_WORKERS: use all cores minus one (reserved for Gunicorn + nginx).
# If you run more than 2 Gunicorn workers, reduce this proportionally so
# total process count ≤ cpu_count.
# Do NOT start Gunicorn with --preload; that would fork the pool into every
# worker process.
# ---------------------------------------------------------------------------

_POOL_WORKERS = max(2, (os.cpu_count() or 4) - 1)

_analysis_pool:      ProcessPoolExecutor | None = None
_analysis_pool_lock: threading.Lock              = threading.Lock()


def _worker_init(tile_dir_str: str, elev_db_str: str) -> None:
    """Called once in each pool worker process at startup.

    Replaces any fork-inherited SQLite connection with a fresh one (SQLite
    connections are not fork-safe) and resets the tile LRU so each worker
    builds its own independent in-memory cache from the shared on-disk store.
    The terrain-profile lru_cache is inherited from the fork or starts empty
    on spawn — either way it accumulates hits across requests within the
    worker's lifetime.
    """
    global _tiles, _db_conn, _db_lock
    _tiles   = ElevationTileService(Path(tile_dir_str))
    _db_lock = threading.Lock()
    conn = sqlite3.connect(elev_db_str, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8192")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS elev_pts (
            key  TEXT PRIMARY KEY,
            val  REAL NOT NULL
        )
    """)
    conn.commit()
    _db_conn = conn


def _get_analysis_pool() -> ProcessPoolExecutor:
    """Return the module-level process pool, creating it lazily on first call."""
    global _analysis_pool
    if _analysis_pool is None:
        with _analysis_pool_lock:
            if _analysis_pool is None:
                import atexit
                pool = ProcessPoolExecutor(
                    max_workers=_POOL_WORKERS,
                    initializer=_worker_init,
                    initargs=(str(TILE_DIR), str(ELEV_DB)),
                )
                atexit.register(pool.shutdown, wait=False)
                _analysis_pool = pool
    return _analysis_pool


def _interp_gamma(veg: dict, freq_mhz: float) -> float:
    """Log-linear interpolation of γ (dB/m) between tabulated frequencies."""
    freqs = sorted(veg["gamma"])
    if freq_mhz <= freqs[0]:
        return veg["gamma"][freqs[0]]
    if freq_mhz >= freqs[-1]:
        return veg["gamma"][freqs[-1]]
    for k in range(len(freqs) - 1):
        f0, f1 = freqs[k], freqs[k + 1]
        if f0 <= freq_mhz <= f1:
            t = (math.log(freq_mhz) - math.log(f0)) / (math.log(f1) - math.log(f0))
            return veg["gamma"][f0] * (1.0 - t) + veg["gamma"][f1] * t
    return 0.0


def vegetation_loss_db(
    profile: list[ProfileEntry],
    from_total: float,
    to_total: float,
    total_dist: float,
    freq_mhz: float,
    veg_type: str,
) -> float:
    """
    Per-segment vegetation attenuation along the LOS path (ITU-R P.833-9).

    For each terrain profile segment the LOS height above ground (AGL) is
    compared to the assumed canopy height.  The fraction of the segment that
    lies below the canopy contributes γ × length (dB) to the total loss.

    The accumulated loss is capped at max_db for the selected class, which
    represents the physical limit beyond which the signal is practically
    absorbed (see ITU-R P.833 plateau behaviour A·(1−e^{−γd/A})).
    """
    if veg_type not in VEG_PROFILES or veg_type == "none":
        return 0.0

    veg      = VEG_PROFILES[veg_type]
    canopy_h = veg["canopy_h_m"]
    max_db   = veg["max_db"]
    gamma    = _interp_gamma(veg, freq_mhz)

    if gamma == 0.0 or canopy_h <= 0:
        return 0.0

    total_loss = 0.0

    for i in range(1, len(profile)):
        f0, d0, te0, _ = profile[i - 1]
        f1, d1, te1, _ = profile[i]
        seg_len = d1 - d0
        if seg_len <= 0:
            continue

        # Signal-path height above terrain at each end of the segment
        los0 = from_total + f0 * (to_total - from_total)
        los1 = from_total + f1 * (to_total - from_total)
        agl0 = los0 - te0
        agl1 = los1 - te1

        below0 = agl0 < canopy_h
        below1 = agl1 < canopy_h

        if not below0 and not below1:
            continue                              # segment entirely above canopy

        if below0 and below1:
            frac = 1.0                            # segment entirely in canopy
        else:
            # Linear crossing: agl(t) = agl0 + t*(agl1-agl0) = canopy_h
            denom = (agl1 - agl0) or 1e-9
            t_x   = max(0.0, min(1.0, (canopy_h - agl0) / denom))
            frac  = t_x if below0 else (1.0 - t_x)

        total_loss += gamma * seg_len * frac
        if total_loss >= max_db:
            break

    return round(min(total_loss, max_db), 2)


# ---------------------------------------------------------------------------
# KML / CSV parsing
# ---------------------------------------------------------------------------

KML_NS = [
    "http://www.opengis.net/kml/2.2",
    "http://earth.google.com/kml/2.2",
    "http://earth.google.com/kml/2.1",
    "",
]

CSV_COLUMNS = ["name", "longitude", "latitude", "height_agl_m", "antenna_gain_dbi", "tx_power_dbm", "enabled"]


def _parse_coord_text(text: str) -> list[tuple[float, float]]:
    """Convert a KML <coordinates> text block into (lat, lon) tuples."""
    result = []
    for token in (text or "").strip().split():
        parts = token.split(",")
        if len(parts) >= 2:
            try:
                result.append((_rc(float(parts[1])), _rc(float(parts[0]))))
            except ValueError:
                pass
    return result


def parse_kml(content: str, track_name: str | None = None) -> list[tuple[float, float]]:
    """
    Parse track coordinates from a KML file.

    If track_name is given, returns only the named LineString's coordinates.
    Otherwise returns the first LineString found (ignores Point placemarks so
    aid-station coordinates no longer pollute the track).
    Falls back to any <coordinates> element for bare KMLs with no Placemark wrapper.
    """
    root = ET.fromstring(content)
    for ns in KML_NS:
        np = f"{{{ns}}}" if ns else ""

        if track_name is not None:
            for pm in root.iter(f"{np}Placemark"):
                name_el = pm.find(f"{np}name")
                if name_el is None or (name_el.text or "").strip() != track_name:
                    continue
                ls = pm.find(f".//{np}LineString")
                if ls is None:
                    continue
                ce = ls.find(f"{np}coordinates")
                if ce is not None:
                    pts = _parse_coord_text(ce.text or "")
                    if pts:
                        return pts
        else:
            for pm in root.iter(f"{np}Placemark"):
                ls = pm.find(f".//{np}LineString")
                if ls is None:
                    continue
                ce = ls.find(f"{np}coordinates")
                if ce is not None:
                    pts = _parse_coord_text(ce.text or "")
                    if pts:
                        return pts
            # Fallback: bare <coordinates> element (legacy / simple KMLs)
            for el in root.iter(f"{np}coordinates"):
                pts = _parse_coord_text(el.text or "")
                if pts:
                    return pts

    return []


def _kml_icon_type(href: str) -> str:
    """Return a short icon-type string from a CalTopo/Google Earth icon URL."""
    m = re.search(r'cfg=([^&]+)', href)
    if not m:
        return "point"
    cfg = unquote(m.group(1)).lower()
    for key in ("radiotower", "camping", "rangerstation", "helicopter", "triangle", "lodge"):
        if key in cfg:
            return key
    return "point"


def parse_kml_info(content: str) -> dict:
    """
    Return structured metadata for a KML file:
      linestrings — [{name, point_count}] for each named LineString Placemark
      placemarks  — [{name, lat, lon, description, icon_type}] for each Point Placemark
    """
    root        = ET.fromstring(content)
    linestrings: list[dict] = []
    placemarks:  list[dict] = []
    seen_ls:     set[str]   = set()
    seen_pm:     set[str]   = set()

    for ns in KML_NS:
        np = f"{{{ns}}}" if ns else ""

        for pm in root.iter(f"{np}Placemark"):
            name_el = pm.find(f"{np}name")
            name    = (name_el.text or "").strip() if name_el is not None else ""
            desc_el = pm.find(f"{np}description")
            desc    = (desc_el.text or "").strip() if desc_el is not None else ""
            href_el = pm.find(f".//{np}href")
            icon_href = (href_el.text or "") if href_el is not None else ""

            # LineString?
            ls = pm.find(f".//{np}LineString")
            if ls is not None:
                ce = ls.find(f"{np}coordinates")
                if ce is not None:
                    pts = _parse_coord_text(ce.text or "")
                    label = name or f"Track {len(linestrings) + 1}"
                    if pts and label not in seen_ls:
                        linestrings.append({"name": label, "point_count": len(pts)})
                        seen_ls.add(label)
                continue

            # Point?
            pt_el = pm.find(f".//{np}Point")
            if pt_el is not None:
                ce = pt_el.find(f"{np}coordinates")
                if ce is not None:
                    parts = (ce.text or "").strip().split(",")
                    if len(parts) >= 2:
                        try:
                            lon = _rc(float(parts[0]))
                            lat = _rc(float(parts[1]))
                            key = f"{name}|{lat}|{lon}"
                            if key not in seen_pm:
                                placemarks.append({
                                    "name":        name,
                                    "lat":         lat,
                                    "lon":         lon,
                                    "description": desc,
                                    "icon_type":   _kml_icon_type(icon_href),
                                })
                                seen_pm.add(key)
                        except ValueError:
                            pass

        if linestrings or placemarks:
            break

    return {"linestrings": linestrings, "placemarks": placemarks}


def parse_csv_file(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


# ---------------------------------------------------------------------------
# SSE helper
# ---------------------------------------------------------------------------

def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# ---------------------------------------------------------------------------
# Routes – file management
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/api/files")
def list_files():
    kmls = sorted(f.name for f in KML_DIR.iterdir() if f.suffix.lower() == ".kml")
    csvs = sorted(f.name for f in CSV_DIR.iterdir() if f.suffix.lower() == ".csv")
    return jsonify({"kml": kmls, "csv": csvs})


@app.route("/api/upload/<filetype>", methods=["POST"])
def upload_file(filetype: str):
    if filetype not in ("kml", "csv"):
        return jsonify({"error": "Invalid type"}), 400
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower()
    if ext not in (ALLOWED_KML if filetype == "kml" else ALLOWED_CSV):
        return jsonify({"error": "File type not allowed"}), 400
    fname = secure_filename(f.filename)
    (KML_DIR if filetype == "kml" else CSV_DIR).joinpath(fname).write_bytes(f.read())
    return jsonify({"filename": fname})


@app.route("/api/files/<filetype>/<filename>", methods=["DELETE"])
def delete_file(filetype: str, filename: str):
    if filetype not in ("kml", "csv"):
        return jsonify({"error": "Invalid type"}), 400
    p = (KML_DIR if filetype == "kml" else CSV_DIR) / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    p.unlink()
    return jsonify({"ok": True})


@app.route("/api/files/<filetype>/<filename>")
def download_file(filetype: str, filename: str):
    if filetype not in ("kml", "csv"):
        return jsonify({"error": "Invalid type"}), 400
    p = (KML_DIR if filetype == "kml" else CSV_DIR) / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    return send_file(str(p), as_attachment=True)


# ---------------------------------------------------------------------------
# Routes – CSV editor
# ---------------------------------------------------------------------------

@app.route("/api/csv/<filename>")
def get_csv(filename: str):
    p = CSV_DIR / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    return jsonify({"columns": CSV_COLUMNS, "rows": parse_csv_file(p)})


@app.route("/api/csv/<filename>", methods=["PUT"])
def save_csv(filename: str):
    p    = CSV_DIR / secure_filename(filename)
    rows = request.get_json().get("rows", [])
    buf  = io.StringIO()
    w    = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for row in rows:
        w.writerow({col: row.get(col, "") for col in CSV_COLUMNS})
    p.write_text(buf.getvalue(), encoding="utf-8")
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – Saved analyses
# ---------------------------------------------------------------------------

@app.route("/api/analyses", methods=["GET"])
def list_analyses():
    """Return lightweight metadata for all saved analyses, newest first."""
    items = []
    for f in sorted(ANALYSES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            items.append({
                "id":                 data.get("id"),
                "name":               data.get("name", "Unnamed"),
                "saved_at":           data.get("saved_at"),
                "kml_file":           data.get("kml_file"),
                "csv_file":           data.get("csv_file"),
                "total_coverage_pct": data.get("total_coverage_pct"),
                "mode":               data.get("params", {}).get("mode"),
            })
        except Exception as exc:
            app.logger.warning("Skipping corrupt analysis file %s: %s", f.name, exc)
    return jsonify(items)


@app.route("/api/analyses", methods=["POST"])
def save_analysis():
    """Persist a complete analysis result sent by the client."""
    payload = request.get_json(force=True)
    if not payload:
        return jsonify({"error": "Empty payload"}), 400
    aid = str(uuid.uuid4())
    payload["id"]       = aid
    payload["saved_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Atomic write: temp file then rename so a crash never leaves a corrupt file
    tmp = ANALYSES_DIR / f".{aid}.tmp"
    try:
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.rename(ANALYSES_DIR / f"{aid}.json")
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return jsonify({"id": aid, "name": payload.get("name"), "saved_at": payload["saved_at"]}), 201


@app.route("/api/analyses/<aid>", methods=["GET"])
def load_analysis(aid: str):
    """Return the full saved analysis JSON."""
    p = ANALYSES_DIR / secure_filename(f"{aid}.json")
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    return jsonify(json.loads(p.read_text(encoding="utf-8")))


@app.route("/api/analyses/<aid>", methods=["DELETE"])
def delete_analysis(aid: str):
    """Delete a saved analysis file."""
    p = ANALYSES_DIR / secure_filename(f"{aid}.json")
    if p.exists():
        p.unlink()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – KML parse
# ---------------------------------------------------------------------------

@app.route("/api/kml/<filename>")
def get_kml(filename: str):
    p = KML_DIR / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    track_name = request.args.get("track")   # optional: select LineString by name
    coords = parse_kml(p.read_text(encoding="utf-8", errors="replace"), track_name=track_name)
    if not coords:
        return jsonify({"error": "No coordinates found in KML"}), 400
    lats = [c[0] for c in coords]
    lons = [c[1] for c in coords]
    return jsonify({
        "coordinates": coords,
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
    })


@app.route("/api/kml/<filename>/info")
def get_kml_info(filename: str):
    p = KML_DIR / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    return jsonify(parse_kml_info(p.read_text(encoding="utf-8", errors="replace")))


# ---------------------------------------------------------------------------
# Route – single-point elevation lookup (used by the map cursor info bar)
# ---------------------------------------------------------------------------

@app.route("/api/elevation")
def get_elevation_point():
    try:
        lat = _rc(float(request.args["lat"]))
        lon = _rc(float(request.args["lon"]))
    except (KeyError, ValueError):
        return jsonify({"error": "lat and lon required"}), 400
    return jsonify({"elevation_m": round(_get_elev(lat, lon), 1)})


# ---------------------------------------------------------------------------
# Route – terrain profile with LOS, Fresnel zone, and diffraction info
# Query params: lat1 lon1 lat2 lon2 h1 h2 freq_mhz
# ---------------------------------------------------------------------------

@app.route("/api/profile")
def terrain_profile():
    try:
        la1      = _rc(float(request.args["lat1"]))
        lo1      = _rc(float(request.args["lon1"]))
        la2      = _rc(float(request.args["lat2"]))
        lo2      = _rc(float(request.args["lon2"]))
        h1       = float(request.args.get("h1",       2.0))
        h2       = float(request.args.get("h2",       2.0))
        freq_mhz = float(request.args.get("freq_mhz", 915.0))
    except (KeyError, ValueError):
        return jsonify({"error": "lat1 lon1 lat2 lon2 required"}), 400

    veg_type = request.args.get("veg_type", "none")

    profile, dist = _terrain_profile_cached(la1, lo1, la2, lo2)

    e1_ground  = _get_elev(la1, lo1)
    e2_ground  = _get_elev(la2, lo2)
    from_total = e1_ground + h1
    to_total   = e2_ground + h2
    wl         = 300.0 / freq_mhz

    points = []
    for f, d1, te, eff in profile:
        d2  = max(0.0, dist - d1)
        los = from_total + f * (to_total - from_total)
        clr = los - eff                                              # +ve = clear
        f1r = math.sqrt(wl * d1 * d2 / dist) if (d1 > 0 and d2 > 0 and dist > 0) else 0.0
        points.append({
            "d_m":   round(d1,  1),
            "te_m":  round(te,  1),   # raw terrain MSL
            "eff_m": round(eff, 1),   # terrain + earth-curvature bulge
            "los_m": round(los, 1),   # LOS line elevation at this point
            "clr_m": round(clr, 1),   # clearance (+ve = terrain below LOS)
            "f1r_m": round(f1r, 1),   # first Fresnel zone radius
        })

    diff_loss, obstacles = deygout_detail(profile, from_total, to_total, dist, freq_mhz)
    veg_loss  = vegetation_loss_db(profile, from_total, to_total, dist, freq_mhz, veg_type)

    return jsonify({
        "dist_m":       round(dist,       1),
        "from_total_m": round(from_total, 1),
        "to_total_m":   round(to_total,   1),
        "diff_db":      round(diff_loss,  1),
        "veg_loss_db":  round(veg_loss,   2),
        "los":          diff_loss < 6.0,
        "points":       points,
        "obstacles":    obstacles,
    })


# ---------------------------------------------------------------------------
# Task functions for parallel RF analysis (ProcessPoolExecutor)
# Both functions are module-level (not nested) so they are picklable across
# process boundaries — required for ProcessPoolExecutor on all platforms.
# ---------------------------------------------------------------------------

def _link_task(args: tuple) -> dict:
    """Compute one inter-receiver RF link. Designed to run in a thread pool."""
    i, rx1, j, rx2, freq_mhz, sensitivity_dbm, fade_margin_db, veg_type = args
    la1 = _rc(float(rx1["latitude"]));  lo1 = _rc(float(rx1["longitude"]))
    la2 = _rc(float(rx2["latitude"]));  lo2 = _rc(float(rx2["longitude"]))
    e1  = _get_elev(la1, lo1) + float(rx1.get("height_agl_m", 2) or 2)
    e2  = _get_elev(la2, lo2) + float(rx2.get("height_agl_m", 2) or 2)
    profile, dist = _terrain_profile_cached(la1, lo1, la2, lo2)
    diff_loss = deygout_loss_db(profile, e1, e2, dist, freq_mhz)
    veg_loss  = vegetation_loss_db(profile, e1, e2, dist, freq_mhz, veg_type)
    pl        = fspl_db(freq_mhz, dist)
    rssi_at_2 = (
        float(rx1.get("tx_power_dbm",    22) or 22)
        + float(rx1.get("antenna_gain_dbi", 0) or 0)
        + float(rx2.get("antenna_gain_dbi", 0) or 0)
        - pl - diff_loss - veg_loss
    )
    hard_fail = diff_loss >= HARD_FAIL_DB or veg_loss >= HARD_FAIL_DB
    return {
        "type":      "inter_rx",
        "rx1_idx":   i,
        "rx2_idx":   j,
        "rssi":      round(rssi_at_2, 1),
        "los":       diff_loss < 6.0,
        "hard_fail": hard_fail,
        "good_link": rssi_at_2 >= (sensitivity_dbm + fade_margin_db) and not hard_fail,
        "dist_km":   round(dist / 1000, 2),
        "diff_db":   round(diff_loss,   1),
        "veg_db":    round(veg_loss,    2),
    }


def _point_task(args: tuple) -> dict:
    """Compute RF coverage for one path point against all receivers. Designed to run in a thread pool."""
    (idx, plat, plon, receivers,
     freq_mhz, tx_power_dbm, tx_gain_dbi,
     sensitivity_dbm, veg_type, fade_margin_db) = args

    TRACKER_H = 1.5
    t_total   = _get_elev(plat, plon) + TRACKER_H

    best_rx_idx       = -1
    best_rssi         = float("-inf")
    overall_best_rssi = float("-inf")
    overall_hard_fail = False
    rx_results:  list[dict] = []

    for rx_idx, rx in enumerate(receivers):
        if str(rx.get("enabled", "1")).strip() == "0":
            continue
        rxlat     = _rc(float(rx["latitude"]))
        rxlon     = _rc(float(rx["longitude"]))
        rx_total  = _get_elev(rxlat, rxlon) + float(rx.get("height_agl_m", 2) or 2)
        rx_gain   = float(rx.get("antenna_gain_dbi", 0) or 0)

        profile, dist = _terrain_profile_cached(plat, plon, rxlat, rxlon)
        diff_loss = deygout_loss_db(profile, t_total, rx_total, dist, freq_mhz)
        veg_loss  = vegetation_loss_db(profile, t_total, rx_total, dist, freq_mhz, veg_type)
        path_loss = fspl_db(freq_mhz, dist)
        rssi      = tx_power_dbm + tx_gain_dbi + rx_gain - path_loss - diff_loss - veg_loss
        hard_fail = diff_loss >= HARD_FAIL_DB or veg_loss >= HARD_FAIL_DB

        rx_results.append({
            "rx_idx":    rx_idx,
            "rssi":      round(rssi, 1),
            "los":       diff_loss < 6.0,
            "dist_km":   round(dist / 1000, 2),
            "diff_db":   round(diff_loss, 1),
            "veg_db":    round(veg_loss,  2),
            "hard_fail": hard_fail,
        })

        if not hard_fail and rssi >= (sensitivity_dbm + fade_margin_db) and rssi > best_rssi:
            best_rssi   = rssi
            best_rx_idx = rx_idx

        if rssi > overall_best_rssi:
            overall_best_rssi = rssi
            overall_hard_fail = hard_fail

    covered      = best_rx_idx >= 0
    pt_hard_fail = overall_hard_fail and not covered
    return {
        "idx":         idx,
        "lat":         plat,
        "lon":         plon,
        "coverage":    covered,
        "hard_fail":   pt_hard_fail,
        "best_rx_idx": best_rx_idx,
        "best_rssi":   round(best_rssi, 1) if covered else None,
        "rx_results":  rx_results,
    }


# ---------------------------------------------------------------------------
# Route – RF Analysis (Server-Sent Events)
# ---------------------------------------------------------------------------

@app.route("/api/analyze", methods=["POST"])
def analyze():
    data             = request.get_json()
    kml_file         = data.get("kml_file")
    csv_file         = data.get("csv_file")
    freq_mhz         = float(data.get("freq_mhz",         915))
    tx_power_dbm     = float(data.get("tx_power_dbm",      22))
    tx_gain_dbi      = float(data.get("tx_gain_dbi",        0))
    sensitivity_dbm  = float(data.get("sensitivity_dbm", -135))
    veg_type         = data.get("veg_type",                "none")  # vegetation class
    fade_margin_db   = float(data.get("fade_margin_db",       0))   # extra link margin required
    mode             = data.get("mode", "both")   # "track" | "links" | "both"
    # Client may send receivers directly so the server always sees the live UI state
    # (enabled/disabled, dragged positions) without requiring an explicit CSV save first.
    body_receivers   = data.get("receivers")       # list[dict] | None

    def generate():
        try:
            yield sse({"type": "status", "message": "Parsing files…"})

            # ---- Load receivers ----
            # Prefer the list sent by the client; fall back to reading from disk.
            if body_receivers is not None:
                receivers = body_receivers
            else:
                csv_p = CSV_DIR / secure_filename(csv_file)
                if not csv_p.exists():
                    yield sse({"type": "error", "message": "CSV file not found"}); return
                receivers = parse_csv_file(csv_p)
                if not receivers:
                    yield sse({"type": "error", "message": "No receivers in CSV"}); return

            # Validate at least one receiver is enabled (keep full list — disabled ones
            # are skipped via `continue` inside the analysis loops below to preserve indices)
            if not any(str(rx.get("enabled", "1")).strip() != "0" for rx in receivers):
                yield sse({"type": "error", "message": "All receivers are disabled — enable at least one in the CSV editor"}); return

            # ---- Parse KML (required for track/both) ----
            path_pts = []
            if mode in ("track", "both"):
                if not kml_file:
                    yield sse({"type": "error", "message": "KML file required for track analysis"}); return
                kml_p = KML_DIR / secure_filename(kml_file)
                if not kml_p.exists():
                    yield sse({"type": "error", "message": "KML file not found"}); return
                waypoints = parse_kml(kml_p.read_text(encoding="utf-8", errors="replace"))
                if not waypoints:
                    yield sse({"type": "error", "message": "No coordinates in KML"}); return
                path_pts = interpolate_path(waypoints)

            yield sse({
                "type":              "path_info",
                "total_points":      len(path_pts),
                "total_receivers":   len(receivers),
                "terrain_spacing_m": TERRAIN_SPACING,
            })

            # ---- Compute bounding box ----
            rx_lats  = [_rc(float(rx["latitude"]))  for rx in receivers]
            rx_lons  = [_rc(float(rx["longitude"])) for rx in receivers]
            all_lats = [p[0] for p in path_pts] + rx_lats
            all_lons = [p[1] for p in path_pts] + rx_lons
            la_min, la_max = min(all_lats), max(all_lats)
            lo_min, lo_max = min(all_lons), max(all_lons)

            # ---- Prefetch Terrarium tiles ----
            yield sse({"type": "status",
                        "message": "Downloading terrain tiles (AWS Terrarium, zoom 14→13→12)…"})
            _prog = [0, 1]

            def _tile_cb(done, total):
                _prog[0], _prog[1] = done, max(1, total)

            tile_thread = threading.Thread(
                target=lambda: _tiles.prefetch_area(la_min, la_max, lo_min, lo_max, _tile_cb),
                daemon=True,
            )
            tile_thread.start()
            while tile_thread.is_alive():
                yield sse({"type": "elev_progress",
                            "current": _prog[0], "total": _prog[1],
                            "message": f"Tile {_prog[0]}/{_prog[1]} cached…"})
                time.sleep(0.6)
            tile_thread.join()
            yield sse({"type": "elev_progress", "current": _prog[1], "total": _prog[1]})

            # ---- Verify tile coverage; fall back to API if needed ----
            # Sample up to 5 spread points; tiles are available if ANY succeed.
            _test_step = max(1, len(all_lats) // 5)
            _test_pts  = [(all_lats[i], all_lons[i])
                          for i in range(0, len(all_lats), _test_step)][:5]
            _tile_hits = sum(1 for la, lo in _test_pts
                             if _tiles.get_elevation(la, lo) is not None)
            app.logger.info("Tile service check: %d/%d test points returned elevation",
                            _tile_hits, len(_test_pts))
            if _tile_hits == 0:
                yield sse({"type": "status",
                           "message": "Tile service unavailable — falling back to OpenTopoData/USGS EPQS…"})

                # Build a compact, deduplicated set of points to cache:
                #   • Every interpolated path point (the KML track)
                #   • Every receiver location
                #   • A bounding-box grid at ~500 m spacing to give the
                #     profile-validation interpolator enough anchor points
                #     across the whole area — no cross-product needed.
                GRID_SPACING_M = 500.0
                api_pts: set[tuple[float, float]] = set()

                # KML path points
                for plat, plon in path_pts:
                    api_pts.add((round(plat, 4), round(plon, 4)))

                # Receiver locations
                for rx in receivers:
                    api_pts.add((round(_rc(float(rx["latitude"])),  4),
                                 round(_rc(float(rx["longitude"])), 4)))

                # Bounding-box grid  (~0.0045° ≈ 500 m)
                deg_step = GRID_SPACING_M / 111_000.0
                la = la_min
                while la <= la_max + deg_step:
                    lo = lo_min
                    while lo <= lo_max + deg_step:
                        api_pts.add((round(la, 4), round(lo, 4)))
                        lo += deg_step
                    la += deg_step

                app.logger.info("API elevation fallback: %d unique points to fetch",
                                len(api_pts))

                _api_prog = [0, max(1, len(api_pts))]

                def _api_cb(done, total):
                    _api_prog[0], _api_prog[1] = done, max(1, total)

                api_thread = threading.Thread(
                    target=fetch_fallback_elevations,
                    args=(list(api_pts), _api_cb),
                    daemon=True,
                )
                api_thread.start()
                while api_thread.is_alive():
                    yield sse({"type": "elev_progress",
                               "current": _api_prog[0], "total": _api_prog[1],
                               "message": f"API elevation {_api_prog[0]}/{_api_prog[1]}…"})
                    time.sleep(0.8)
                api_thread.join()

            # ---- Inter-receiver analysis ----
            if mode in ("links", "both"):
                yield sse({"type": "status", "message": "Analyzing inter-receiver links…"})
                link_args = [
                    (i, rx1, j, rx2, freq_mhz, sensitivity_dbm, fade_margin_db, veg_type)
                    for i, rx1 in enumerate(receivers)
                    if str(rx1.get("enabled", "1")).strip() != "0"
                    for j, rx2 in enumerate(receivers)
                    if j > i and str(rx2.get("enabled", "1")).strip() != "0"
                ]
                pool = _get_analysis_pool()
                chunksize = max(1, len(link_args) // (_POOL_WORKERS * 4)) if link_args else 1
                for result in pool.map(_link_task, link_args, chunksize=chunksize):
                    yield sse(result)

            # ---- Per-path-point RF analysis ----
            if mode in ("track", "both"):
                yield sse({"type": "status", "message": "Running RF analysis with Deygout terrain model…"})

                rx_stats = [
                    {"name": rx["name"], "covered": 0, "rssi_sum": 0.0, "rssi_count": 0}
                    for rx in receivers
                ]
                total_covered = 0
                total_pts     = len(path_pts)
                FLUSH         = 20
                batch: list[dict] = []

                point_args = [
                    (idx, plat, plon, receivers,
                     freq_mhz, tx_power_dbm, tx_gain_dbi,
                     sensitivity_dbm, veg_type, fade_margin_db)
                    for idx, (plat, plon) in enumerate(path_pts)
                ]

                pool = _get_analysis_pool()
                for pt in pool.map(_point_task, point_args, chunksize=1):
                        if pt["coverage"]:
                            total_covered += 1
                            bx = pt["best_rx_idx"]
                            rx_stats[bx]["covered"]    += 1
                            rx_stats[bx]["rssi_sum"]   += pt["best_rssi"]
                            rx_stats[bx]["rssi_count"] += 1

                        batch.append({
                            "type":        "point",
                            "idx":         pt["idx"],
                            "lat":         pt["lat"],
                            "lon":         pt["lon"],
                            "coverage":    pt["coverage"],
                            "hard_fail":   pt["hard_fail"],
                            "best_rx_idx": pt["best_rx_idx"],
                            "best_rssi":   pt["best_rssi"],
                            "rx_results":  pt["rx_results"],
                        })

                        if len(batch) >= FLUSH or pt["idx"] == total_pts - 1:
                            yield sse({
                                "type":     "points_batch",
                                "points":   batch,
                                "progress": pt["idx"] + 1,
                                "total":    total_pts,
                            })
                            batch = []

                # ---- Summary ----
                stats = []
                for i, s in enumerate(rx_stats):
                    if str(receivers[i].get("enabled", "1")).strip() == "0":
                        continue
                    avg = s["rssi_sum"] / s["rssi_count"] if s["rssi_count"] > 0 else None
                    stats.append({
                        "name":         s["name"],
                        "coverage_pct": round(s["covered"] / total_pts * 100, 1) if total_pts else 0,
                        "avg_rssi":     round(avg, 1) if avg is not None else None,
                        "color_idx":    i,
                    })

                yield sse({
                    "type":               "complete",
                    "mode":               mode,
                    "stats":              stats,
                    "total_coverage_pct": round(total_covered / total_pts * 100, 1) if total_pts else 0,
                })
            else:
                # Links-only: no coverage stats to report
                yield sse({"type": "complete", "mode": mode, "stats": [], "total_coverage_pct": 0})

        except GeneratorExit:
            pass
        except Exception as exc:
            import traceback
            yield sse({"type": "error", "message": f"{exc}\n{traceback.format_exc()}"})

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":       "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
