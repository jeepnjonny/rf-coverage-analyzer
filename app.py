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
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed, wait as cf_wait
from pathlib import Path

import numpy as np
import requests
from flask import Flask, Response, jsonify, request, send_file, stream_with_context
from werkzeug.utils import secure_filename

# ---------------------------------------------------------------------------
# App & directory setup
# ---------------------------------------------------------------------------

import logging

app = Flask(__name__, static_folder="static")
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024
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

ALLOWED_KML = {"kml", "kmz", "gpx"}
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

# Roles that satisfy the WIDE1 relay requirement in APRS chain mode.
# A WIDE1 is viable when it has a good RF link to any receiver with one of these roles.
# Meshtastic is intentionally excluded — it is a separate protocol, not part of the APRS chain.
W1_RELAY_ROLES: frozenset[str] = frozenset(("wide2", "igate"))

# ---------------------------------------------------------------------------
# Infrastructure Location Advisor — OSM + greedy site selection
# ---------------------------------------------------------------------------

OVERPASS_URL           = "https://overpass-api.de/api/interpreter"
TIER1_HIGHWAYS: set[str] = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "unclassified", "service", "track",
}
ROAD_SAMPLE_SPACING_M  = 150    # metres between sampled road candidates
MAX_CANDIDATES         = 300    # hard cap on candidates sent to full RF scoring
RAW_CANDIDATES_CAP     = 10000  # raw pool size before FSPL pre-filter
HIGHPOINT_GRID_M       = 75     # radial scan grid spacing for hike-accessible sites
MAX_HIKE_SLOPE_DEG     = 40     # steeper than 40° (≈84% grade) → reject as physically inaccessible
WIDE_APRS_RX_GAIN_DBI  = 2.4    # typical omni vertical (J-pole / collinear) for WIDE1/WIDE2/iGate
TRACK_SAMPLE_SPACING_M = 400    # metres between on-route Tier-3 candidates
HIGHPOINT_N_BEARINGS   = 24     # radial scan directions for Tier-2 elevated sites
# Coarse scoring — cheap in-process pass before expensive parallel RF model
COARSE_SCORE_SUBSAMPLE = 8      # score every Nth track point (300 pts → ~37 samples)
COARSE_TERRAIN_SAMPLES = 6      # interior terrain check points per coarse LOS path
COARSE_REJECT_BOTTOM   = 0.50   # discard bottom 50 % of candidates by coarse score
# Heat-map expansion — micro-candidates in geographically dense coarse-survivor zones
HOT_ZONE_CELL_M        = 400.0  # spatial grid cell size (metres) for clustering
HOT_ZONE_MIN_DENSITY   = 2      # min coarse survivors per cell to declare a hot zone
HOT_ZONE_EXPAND_M      = 200.0  # expansion radius (m) around each hot zone centre
HOT_ZONE_STEP_M        = 50.0   # micro-candidate grid step (m) inside hot zones
# Local refinement — fine spatial search around each greedy-selected site
REFINE_RADIUS_M        = 150.0  # search radius (m) around each selected site
REFINE_STEP_M          = 50.0   # grid step (m) for local refinement

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
    """Return the module-level analysis process pool, creating it lazily on first call.
    Resets automatically if a worker crash has left the pool in a broken state."""
    global _analysis_pool
    if _analysis_pool is not None and getattr(_analysis_pool, '_broken', False):
        _analysis_pool = None
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


# Separate pool for the Infrastructure Advisor.  The advisor daemon thread
# can run thousands of pool.map() tasks in the background; isolating it
# prevents zombie tasks from blocking /api/analyze link/track requests.
_advisor_pool:      ProcessPoolExecutor | None = None
_advisor_pool_lock: threading.Lock              = threading.Lock()


def _get_advisor_pool() -> ProcessPoolExecutor:
    """Return the module-level advisor process pool, creating/resetting lazily."""
    global _advisor_pool
    if _advisor_pool is not None and getattr(_advisor_pool, '_broken', False):
        _advisor_pool = None
    if _advisor_pool is None:
        with _advisor_pool_lock:
            if _advisor_pool is None:
                import atexit
                pool = ProcessPoolExecutor(
                    max_workers=_POOL_WORKERS,
                    initializer=_worker_init,
                    initargs=(str(TILE_DIR), str(ELEV_DB)),
                )
                atexit.register(pool.shutdown, wait=False)
                _advisor_pool = pool
    return _advisor_pool


def _terrain_check_task(args: tuple) -> dict:
    """Slope + exclusion-zone check for one candidate. Module-level for process pool."""
    ci, clat, clon, max_slope, excl_polygons, excl_grid, excl_cell_deg = args
    try:
        if _local_slope_deg(clat, clon) > max_slope:
            return {"ci": ci, "ok": False, "reason": "slope"}
        if excl_polygons and point_in_exclusion_zone(
            clat, clon, excl_polygons, excl_grid, excl_cell_deg
        ):
            return {"ci": ci, "ok": False, "reason": "excl"}
        return {"ci": ci, "ok": True}
    except Exception:
        return {"ci": ci, "ok": True}


def _coarse_task(args: tuple) -> dict:
    """Coarse RF coverage score for one candidate. Module-level for process pool."""
    (ci, clat, clon, c_agl, track_pts, freq_mhz,
     tx_power_dbm, tx_gain_dbi, sensitivity_dbm, fade_margin_db) = args
    try:
        score = coarse_score_candidate(
            clat, clon, c_agl, track_pts, freq_mhz,
            tx_power_dbm, tx_gain_dbi, sensitivity_dbm, fade_margin_db,
        )
    except Exception:
        score = 0.0
    return {"ci": ci, "score": score}


def _los_check_task(args: tuple) -> dict:
    """LOS check for one candidate against a set of nearby track points."""
    ci, clat, clon, agl, check_pts = args
    try:
        ok = any(terrain_los_clear(clat, clon, agl, lat, lon)
                 for lat, lon in check_pts)
    except Exception:
        ok = True
    return {"ci": ci, "ok": ok}


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

GPX_NS = [
    "http://www.topografix.com/GPX/1/1",
    "http://www.topografix.com/GPX/1/0",
    "",
]

CSV_COLUMNS = ["name", "longitude", "latitude", "height_agl_m", "antenna_gain_dbi", "tx_power_dbm", "enabled", "role"]


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


def _validate_track_content(data: bytes, ext: str) -> str | None:
    """
    Return None if *data* is parseable XML of the expected track-file type,
    or a human-readable error string if it is not.
    """
    try:
        text = data.decode("utf-8", errors="replace")
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        return f"Invalid XML: {exc}"
    except Exception as exc:
        return f"Could not read file: {exc}"

    local = root.tag.split("}")[-1].lower() if "}" in root.tag else root.tag.lower()
    if ext == "gpx":
        if local != "gpx":
            return f"Not a valid GPX file (root element is <{local}>)"
    else:  # kml / kmz
        if local not in ("kml", "document", "folder"):
            return f"Not a valid KML file (root element is <{local}>)"
    return None


def parse_kml(content: str, track_name: str | None = None) -> list[tuple[float, float]]:
    """
    Parse track coordinates from a KML file.

    If track_name is given, returns only the named LineString's coordinates.
    Otherwise returns the first LineString found (ignores Point placemarks so
    aid-station coordinates no longer pollute the track).
    Falls back to any <coordinates> element for bare KMLs with no Placemark wrapper.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
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
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return {"linestrings": [], "placemarks": []}
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


# ---------------------------------------------------------------------------
# GPX parsing helpers
# ---------------------------------------------------------------------------

def _parse_gpx_pts(container_el, pt_tag: str) -> list[tuple[float, float]]:
    """Collect (lat, lon) from trkpt or rtept elements inside a trk/rte element."""
    pts = []
    for pt in container_el.iter(pt_tag):
        try:
            pts.append((_rc(float(pt.get("lat", ""))), _rc(float(pt.get("lon", "")))))
        except (ValueError, TypeError):
            pass
    return pts


def parse_gpx(content: str, track_name: str | None = None) -> list[tuple[float, float]]:
    """
    Parse track coordinates from a GPX file.

    Checks <trk> elements first, falls back to <rte> elements.
    If track_name is given, returns only the segment whose <name> matches.
    Waypoints (<wpt>) are ignored here — they are returned by parse_gpx_info.
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return []
    for ns in GPX_NS:
        np = f"{{{ns}}}" if ns else ""

        # Prefer tracks; fall back to routes
        containers = list(root.iter(f"{np}trk"))
        pt_tag     = f"{np}trkpt"
        if not containers:
            containers = list(root.iter(f"{np}rte"))
            pt_tag     = f"{np}rtept"

        if not containers:
            continue

        if track_name is not None:
            for trk in containers:
                name_el = trk.find(f"{np}name")
                if name_el is not None and (name_el.text or "").strip() == track_name:
                    pts = _parse_gpx_pts(trk, pt_tag)
                    if pts:
                        return pts
        else:
            for trk in containers:
                pts = _parse_gpx_pts(trk, pt_tag)
                if pts:
                    return pts

        break  # correct namespace found — don't try others

    return []


def parse_gpx_info(content: str) -> dict:
    """
    Return structured metadata for a GPX file in the same shape as parse_kml_info:
      linestrings — [{name, point_count}] for each track/route
      placemarks  — [{name, lat, lon, description, icon_type}] for each waypoint
    """
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        return {"linestrings": [], "placemarks": []}
    linestrings: list[dict] = []
    placemarks:  list[dict] = []

    for ns in GPX_NS:
        np           = f"{{{ns}}}" if ns else ""
        found_any    = False

        # Tracks
        for trk in root.iter(f"{np}trk"):
            found_any = True
            name_el = trk.find(f"{np}name")
            name    = (name_el.text or "").strip() if name_el is not None else ""
            pts     = _parse_gpx_pts(trk, f"{np}trkpt")
            if pts:
                linestrings.append({
                    "name":        name or f"Track {len(linestrings) + 1}",
                    "point_count": len(pts),
                })

        # Routes (treated as tracks)
        for rte in root.iter(f"{np}rte"):
            found_any = True
            name_el = rte.find(f"{np}name")
            name    = (name_el.text or "").strip() if name_el is not None else ""
            pts     = _parse_gpx_pts(rte, f"{np}rtept")
            if pts:
                linestrings.append({
                    "name":        name or f"Route {len(linestrings) + 1}",
                    "point_count": len(pts),
                })

        # Waypoints → placemarks
        for wpt in root.iter(f"{np}wpt"):
            found_any = True
            try:
                lat     = _rc(float(wpt.get("lat", "")))
                lon     = _rc(float(wpt.get("lon", "")))
                name_el = wpt.find(f"{np}name")
                desc_el = wpt.find(f"{np}desc")
                placemarks.append({
                    "name":        (name_el.text or "").strip() if name_el is not None else "",
                    "lat":         lat,
                    "lon":         lon,
                    "description": (desc_el.text or "").strip() if desc_el is not None else "",
                    "icon_type":   "point",
                })
            except (ValueError, TypeError):
                pass

        if found_any:
            break

    return {"linestrings": linestrings, "placemarks": placemarks}


def _is_gpx(filename: str) -> bool:
    return Path(filename).suffix.lower() == ".gpx"


def parse_track_file(content: str, filename: str,
                     track_name: str | None = None) -> list[tuple[float, float]]:
    """Dispatch to parse_gpx or parse_kml based on file extension."""
    if _is_gpx(filename):
        return parse_gpx(content, track_name)
    return parse_kml(content, track_name)


def parse_track_file_info(content: str, filename: str) -> dict:
    """Dispatch to parse_gpx_info or parse_kml_info based on file extension."""
    if _is_gpx(filename):
        return parse_gpx_info(content)
    return parse_kml_info(content)



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
    kmls = sorted(f.name for f in KML_DIR.iterdir() if f.suffix.lower() in (".kml", ".gpx"))
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
        allowed = ", ".join(sorted(ALLOWED_KML if filetype == "kml" else ALLOWED_CSV))
        return jsonify({"error": f"File type not allowed — expected one of: {allowed}"}), 400
    data = f.read()
    if not data:
        return jsonify({"error": "Uploaded file is empty"}), 400
    # Validate content before saving
    if filetype == "kml":
        err = _validate_track_content(data, ext)
        if err:
            return jsonify({"error": err}), 400
    fname = secure_filename(f.filename)
    (KML_DIR if filetype == "kml" else CSV_DIR).joinpath(fname).write_bytes(data)
    return jsonify({"filename": fname})


@app.route("/api/files/<filetype>/<filename>", methods=["PATCH"])
def rename_file(filetype: str, filename: str):
    if filetype not in ("kml", "csv"):
        return jsonify({"error": "Invalid type"}), 400
    d = KML_DIR if filetype == "kml" else CSV_DIR
    src = d / secure_filename(filename)
    if not src.exists():
        return jsonify({"error": "Not found"}), 404
    new_name = secure_filename((request.get_json(force=True) or {}).get("new_name", ""))
    if not new_name:
        return jsonify({"error": "new_name required"}), 400
    dst = d / new_name
    if dst.exists():
        return jsonify({"error": "A file with that name already exists"}), 409
    src.rename(dst)
    return jsonify({"ok": True, "filename": new_name})


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
    resp = jsonify({"columns": CSV_COLUMNS, "rows": parse_csv_file(p)})
    resp.headers["Cache-Control"] = "no-store"
    return resp


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
        if f.name.endswith(".meta.json"):
            continue  # sidecar files handled below
        try:
            meta_path = f.with_suffix("").with_suffix(".meta.json")
            if meta_path.exists():
                # Fast path: tiny sidecar with pre-extracted listing fields
                items.append(json.loads(meta_path.read_text(encoding="utf-8")))
            else:
                # Fallback for analyses saved before sidecar support.
                # Generate the sidecar now so future listings use the fast path.
                data = json.loads(f.read_text(encoding="utf-8"))
                meta = {
                    "id":                 data.get("id"),
                    "name":               data.get("name", "Unnamed"),
                    "saved_at":           data.get("saved_at"),
                    "kml_file":           data.get("kml_file"),
                    "csv_file":           data.get("csv_file"),
                    "total_coverage_pct": data.get("total_coverage_pct"),
                    "mode":               data.get("params", {}).get("mode"),
                }
                try:
                    meta_path.write_text(json.dumps(meta), encoding="utf-8")
                except Exception as _we:
                    app.logger.debug("Could not write sidecar for %s: %s", f.name, _we)
                items.append(meta)
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
    meta = {
        "id":                 aid,
        "name":               payload.get("name", "Unnamed"),
        "saved_at":           payload["saved_at"],
        "kml_file":           payload.get("kml_file"),
        "csv_file":           payload.get("csv_file"),
        "total_coverage_pct": payload.get("total_coverage_pct"),
        "mode":               payload.get("params", {}).get("mode"),
    }
    # Atomic write: temp file then rename so a crash never leaves a corrupt file
    tmp = ANALYSES_DIR / f".{aid}.tmp"
    try:
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.rename(ANALYSES_DIR / f"{aid}.json")
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    # Sidecar metadata file — list_analyses() reads this instead of the full JSON
    (ANALYSES_DIR / f"{aid}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return jsonify({"id": aid, "name": meta["name"], "saved_at": meta["saved_at"]}), 201


@app.route("/api/analyses/<aid>", methods=["GET"])
def load_analysis(aid: str):
    """Return the full saved analysis JSON."""
    p = ANALYSES_DIR / secure_filename(f"{aid}.json")
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    return jsonify(json.loads(p.read_text(encoding="utf-8")))


@app.route("/api/analyses/<aid>", methods=["DELETE"])
def delete_analysis(aid: str):
    """Delete a saved analysis file and its metadata sidecar."""
    p = ANALYSES_DIR / secure_filename(f"{aid}.json")
    if p.exists():
        p.unlink()
    meta = ANALYSES_DIR / secure_filename(f"{aid}.meta.json")
    if meta.exists():
        meta.unlink()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Routes – KML parse
# ---------------------------------------------------------------------------

@app.route("/api/kml/<filename>")
def get_kml(filename: str):
    p = KML_DIR / secure_filename(filename)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    track_name = request.args.get("track")   # optional: select track by name
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
        coords  = parse_track_file(content, p.name, track_name=track_name)
    except Exception as exc:
        return jsonify({"error": f"Could not parse file: {exc}"}), 400
    if not coords:
        return jsonify({"error": "No track coordinates found in file"}), 400
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
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
        return jsonify(parse_track_file_info(content, p.name))
    except Exception as exc:
        return jsonify({"error": f"Could not parse file: {exc}"}), 400


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


def _run_link_analysis(receivers, freq_mhz, sensitivity_dbm, fade_margin_db,
                        veg_type, chain_mode, emit_links, pool):
    """Run inter-receiver link analysis and, if chain_mode, derive the set of WIDE1
    receivers with a viable backbone link to a WIDE2/iGate.

    Generator: yields SSE-ready event dicts (status messages, and inter_rx results
    when emit_links is True). Returns (link_results_cache, viable_w1_idxs) as the
    generator's return value — capture it via `next()`/StopIteration, e.g.:

        _gen = _run_link_analysis(...)
        try:
            while True:
                yield sse(next(_gen))
        except StopIteration as _si:
            link_results_cache, viable_w1_idxs = _si.value

    Shared by /api/analyze and /api/area-coverage so the backbone-viability logic
    (and its rx1/rx2-index direction quirk, see below) isn't duplicated.
    """
    link_results_cache: list[dict] = []
    viable_w1_idxs: frozenset[int] = frozenset()
    if not (emit_links or chain_mode):
        return link_results_cache, viable_w1_idxs

    status_msg = (
        "Building APRS backbone map for chain analysis…"
        if chain_mode and not emit_links
        else "Analyzing inter-receiver links…"
    )
    yield {"type": "status", "message": status_msg}
    link_args = [
        (i, rx1, j, rx2, freq_mhz, sensitivity_dbm, fade_margin_db, veg_type)
        for i, rx1 in enumerate(receivers)
        if str(rx1.get("enabled", "1")).strip() != "0"
        for j, rx2 in enumerate(receivers)
        if j > i and str(rx2.get("enabled", "1")).strip() != "0"
    ]
    _link_fmap: dict = {}
    for _la in link_args:
        try:
            _link_fmap[pool.submit(_link_task, _la)] = _la
        except Exception as _lse:
            app.logger.warning("link submit failed: %s", _lse)
    _link_pending = set(_link_fmap)
    while _link_pending:
        _lj_done, _link_pending = cf_wait(_link_pending, timeout=8)
        if not _lj_done:
            yield {"type": "status", "message": status_msg}
            continue
        for _lf in _lj_done:
            try:
                result = _lf.result()
                link_results_cache.append(result)
                if emit_links:
                    yield result
            except Exception as _le:
                app.logger.warning("link task failed: %s", _le)

    # Build the set of WIDE1 receivers with a viable backbone link to a terminal node.
    #
    # _link_task evaluates links as rx1→rx2 (rx1 = lower index, rx1 transmits).
    # When WIDE1 has a higher index it becomes rx2, so the cached good_link reflects
    # the terminal→WIDE1 direction (wrong for relay viability). For that case we
    # re-derive the RSSI with WIDE1 as transmitter using the same cached path losses.
    if chain_mode:
        _w1: set[int] = set()
        for _res in link_results_cache:
            if _res.get("hard_fail"):
                continue
            _i, _j = _res["rx1_idx"], _res["rx2_idx"]
            _r1 = (receivers[_i].get("role") or "").strip().lower()
            _r2 = (receivers[_j].get("role") or "").strip().lower()

            # Case A: WIDE1 is rx1 (lower index) — link was evaluated WIDE1→terminal ✓
            if _r1 == "wide1" and _r2 in W1_RELAY_ROLES and _res.get("good_link"):
                _w1.add(_i)

            # Case B: WIDE1 is rx2 (higher index) — link was evaluated terminal→WIDE1 ✗
            # Re-compute RSSI for the WIDE1→terminal direction using cached path losses.
            if _r2 == "wide1" and _r1 in W1_RELAY_ROLES:
                _pl   = fspl_db(freq_mhz, _res["dist_km"] * 1000)
                _rssi = (
                    float(receivers[_j].get("tx_power_dbm",    22) or 22)
                    + float(receivers[_j].get("antenna_gain_dbi", 0) or 0)
                    + float(receivers[_i].get("antenna_gain_dbi", 0) or 0)
                    - _pl - _res["diff_db"] - _res["veg_db"]
                )
                if _rssi >= (sensitivity_dbm + fade_margin_db):
                    _w1.add(_j)

        viable_w1_idxs = frozenset(_w1)
        if not any(
            (rx.get("role") or "").strip().lower() in W1_RELAY_ROLES
            for rx in receivers
            if str(rx.get("enabled", "1")).strip() != "0"
        ):
            yield {"type": "status",
                   "message": "⚠ Chain mode: no WIDE2 or iGate receivers found — "
                              "WIDE1 fill-in digis cannot relay without a backbone node. "
                              "Add receivers with role=wide2 or role=igate, or disable chain mode."}

    return link_results_cache, viable_w1_idxs


def _grid_link_task(args: tuple) -> dict:
    """Compute RF link viability from a fixed test point to one grid cell. Designed to run in a process pool."""
    (gi,
     test_lat, test_lon, test_elev_m,
     grid_lat, grid_lon, grid_agl_m,
     freq_mhz, tx_power_dbm, tx_gain_dbi,
     sensitivity_dbm, veg_type, fade_margin_db) = args

    grid_elev_m = _get_elev(_rc(grid_lat), _rc(grid_lon)) + grid_agl_m
    profile, dist_m = _terrain_profile_cached(
        _rc(test_lat), _rc(test_lon),
        _rc(grid_lat), _rc(grid_lon),
    )
    if dist_m < 50:
        return {"gi": gi, "lat": grid_lat, "lon": grid_lon,
                "viable": False, "hard_fail": False, "rssi": None}

    diff_db = deygout_loss_db(profile, test_elev_m, grid_elev_m, dist_m, freq_mhz)
    veg_db  = vegetation_loss_db(profile, test_elev_m, grid_elev_m, dist_m, freq_mhz, veg_type)
    path_db = fspl_db(freq_mhz, dist_m)
    rssi    = tx_power_dbm + tx_gain_dbi - path_db - diff_db - veg_db

    hard_fail = diff_db >= HARD_FAIL_DB or veg_db >= HARD_FAIL_DB
    viable    = (not hard_fail) and rssi >= (sensitivity_dbm + fade_margin_db)

    return {
        "gi":        gi,
        "lat":       grid_lat,
        "lon":       grid_lon,
        "viable":    viable,
        "hard_fail": hard_fail,
        "rssi":      round(rssi, 1),
    }


def _point_task(args: tuple) -> dict:
    """Compute RF coverage for one path point against all receivers. Designed to run in a thread pool."""
    (idx, plat, plon, receivers,
     freq_mhz, tx_power_dbm, tx_gain_dbi,
     sensitivity_dbm, veg_type, fade_margin_db,
     chain_mode, viable_w1_idxs) = args

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

    # In APRS chain mode a point is covered only when the full uplink path exists:
    # tracker → WIDE1 (that has a verified backbone link to a WIDE2/iGate)
    #        OR tracker → WIDE2/iGate directly (WIDE2-2 alias path)
    if chain_mode:
        chain_best_rssi = float("-inf")
        chain_best_rx   = -1
        for rr in rx_results:
            if rr["hard_fail"]: continue
            if rr["rssi"] < (sensitivity_dbm + fade_margin_db): continue
            rx_role = (receivers[rr["rx_idx"]].get("role") or "").strip().lower()
            viable  = (rr["rx_idx"] in viable_w1_idxs) or rx_role in W1_RELAY_ROLES
            if viable and rr["rssi"] > chain_best_rssi:
                chain_best_rssi = rr["rssi"]
                chain_best_rx   = rr["rx_idx"]
        covered      = chain_best_rx >= 0
        pt_hard_fail = overall_hard_fail and not covered
        best_rx_idx  = chain_best_rx
        best_rssi    = chain_best_rssi

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


def score_candidate(args: tuple) -> dict:
    """Score one infrastructure candidate location against all track points.

    Module-level (picklable) so it can run inside ProcessPoolExecutor workers.
    Uses the same RF pipeline as _point_task but treats the candidate as the
    fixed infrastructure and each track point as the mobile device.

    If backbone_pts is provided (12th element), the candidate is only credited
    with coverage if it can also relay to at least one backbone receiver via a
    viable RF link — enforcing the APRS WIDE1→WIDE2/iGate chain requirement.
    """
    (cand_idx, cand_lat, cand_lon, cand_height_agl,
     track_pts, freq_mhz, tx_power_dbm, tx_gain_dbi,
     sensitivity_dbm, veg_type, fade_margin_db,
     backbone_pts, max_practical_range_m) = args

    TRACKER_H = 1.5
    rx_elev   = _get_elev(cand_lat, cand_lon)
    rx_total  = rx_elev + cand_height_agl

    # Early backbone check: verify the relay path to WIDE2/iGate BEFORE scoring
    # all track points. A backbone-blocked site contributes zero coverage regardless
    # of local terrain — checking first avoids O(track_pts) Deygout for blocked sites.
    if backbone_pts:
        can_relay = False
        for (blat, blon, bh) in backbone_pts:
            b_total   = _get_elev(blat, blon) + bh
            profile_b, dist_b = _terrain_profile_cached(
                _rc(cand_lat), _rc(cand_lon), _rc(blat), _rc(blon)
            )
            diff_b = deygout_loss_db(profile_b, rx_total, b_total, dist_b, freq_mhz)
            if diff_b >= HARD_FAIL_DB:
                continue
            veg_b  = vegetation_loss_db(profile_b, rx_total, b_total, dist_b, freq_mhz, veg_type)
            if veg_b >= HARD_FAIL_DB:
                continue
            rssi_b = tx_power_dbm + tx_gain_dbi - fspl_db(freq_mhz, dist_b) - diff_b - veg_b
            if rssi_b >= (sensitivity_dbm + fade_margin_db):
                can_relay = True
                break
        if not can_relay:
            return {
                "cand_idx":         cand_idx,
                "covered_set":      [],
                "coverage_pct":     0.0,
                "lat":              cand_lat,
                "lon":              cand_lon,
                "backbone_blocked": True,
            }

    # Vectorized range mask: only run expensive Deygout on track points within
    # practical range. Skips ~30–50% of calls on long courses where the candidate
    # is near one end of the route.
    covered: list[int] = []
    if math.isfinite(max_practical_range_m):
        _tl = np.radians(np.array([tp[0] for tp in track_pts]))
        _tg = np.radians(np.array([tp[1] for tp in track_pts]))
        _cl = math.radians(cand_lat)
        _cg = math.radians(cand_lon)
        _dl = _tl - _cl
        _dg = _tg - _cg
        _a  = np.sin(_dl / 2)**2 + math.cos(_cl) * np.cos(_tl) * np.sin(_dg / 2)**2
        _reachable = np.where(
            2 * EARTH_R * np.arcsin(np.sqrt(np.clip(_a, 0, 1))) <= max_practical_range_m
        )[0]
    else:
        _reachable = range(len(track_pts))

    for idx in _reachable:
        plat, plon = track_pts[idx]
        t_total   = _get_elev(plat, plon) + TRACKER_H
        profile, dist = _terrain_profile_cached(
            _rc(plat), _rc(plon), _rc(cand_lat), _rc(cand_lon)
        )
        diff_loss = deygout_loss_db(profile, t_total, rx_total, dist, freq_mhz)
        if diff_loss >= HARD_FAIL_DB:
            continue
        veg_loss  = vegetation_loss_db(profile, t_total, rx_total, dist, freq_mhz, veg_type)
        if veg_loss >= HARD_FAIL_DB:
            continue
        path_loss = fspl_db(freq_mhz, dist)
        rssi      = tx_power_dbm + tx_gain_dbi - path_loss - diff_loss - veg_loss
        if rssi >= (sensitivity_dbm + fade_margin_db):
            covered.append(int(idx))  # int(): numpy.intp → Python int for JSON safety

    total = len(track_pts)
    return {
        "cand_idx":     cand_idx,
        "covered_set":  covered,
        "coverage_pct": round(len(covered) / total * 100, 1) if total else 0.0,
        "lat":          cand_lat,
        "lon":          cand_lon,
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
    chain_mode       = bool(data.get("chain_mode", False))
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
                try:
                    waypoints = parse_track_file(
                        kml_p.read_text(encoding="utf-8", errors="replace"), kml_p.name
                    )
                except Exception as exc:
                    yield sse({"type": "error", "message": f"Could not parse track file: {exc}"}); return
                if not waypoints:
                    yield sse({"type": "error", "message": "No track coordinates found in file"}); return
                path_pts = interpolate_path(waypoints)
                track_dist_m = sum(
                    haversine(path_pts[i][0], path_pts[i][1],
                              path_pts[i + 1][0], path_pts[i + 1][1])
                    for i in range(len(path_pts) - 1)
                ) if len(path_pts) > 1 else 0.0
            else:
                track_dist_m = 0.0

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
            # Always run when mode includes "links"/"both", OR when chain_mode is on
            # (need link results to determine which WIDE1s have backbone to WIDE2/iGate).
            link_results_cache: list[dict] = []
            viable_w1_idxs: frozenset[int] = frozenset()
            if mode in ("links", "both") or chain_mode:
                pool = _get_analysis_pool()
                _lgen = _run_link_analysis(
                    receivers, freq_mhz, sensitivity_dbm, fade_margin_db, veg_type,
                    chain_mode, mode in ("links", "both"), pool,
                )
                try:
                    while True:
                        yield sse(next(_lgen))
                except StopIteration as _lsi:
                    link_results_cache, viable_w1_idxs = _lsi.value

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
                     sensitivity_dbm, veg_type, fade_margin_db,
                     chain_mode, viable_w1_idxs)
                    for idx, (plat, plon) in enumerate(path_pts)
                ]

                pool = _get_analysis_pool()
                _pt_fmap: dict = {}
                _pt_errors: set[int] = set()
                for _pta in point_args:
                    try:
                        _pt_fmap[pool.submit(_point_task, _pta)] = _pta[0]
                    except Exception as _pse:
                        app.logger.warning("point submit failed (idx %d): %s", _pta[0], _pse)
                        _pt_errors.add(_pta[0])
                _pt_pending = set(_pt_fmap)
                _pt_buf: dict[int, dict] = {}
                _pt_next = 0

                while _pt_pending:
                    _ptj_done, _pt_pending = cf_wait(_pt_pending, timeout=8)
                    if not _ptj_done:
                        yield sse({"type": "status",
                                   "message": f"RF analysis… {_pt_next}/{total_pts} pts"})
                    for _ptf in _ptj_done:
                        try:
                            _pt_r = _ptf.result()
                            _pt_buf[_pt_r["idx"]] = _pt_r
                        except Exception as _pte:
                            app.logger.warning("point task failed: %s", _pte)
                            _pt_errors.add(_pt_fmap[_ptf])
                    # Flush consecutive results in order
                    while _pt_next in _pt_buf or _pt_next in _pt_errors:
                        if _pt_next not in _pt_errors:
                            pt = _pt_buf.pop(_pt_next)
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
                        else:
                            _pt_errors.discard(_pt_next)
                        if batch and (len(batch) >= FLUSH or _pt_next == total_pts - 1):
                            _istats = []
                            for _ii, _s in enumerate(rx_stats):
                                if str(receivers[_ii].get("enabled", "1")).strip() == "0":
                                    continue
                                _avg = (_s["rssi_sum"] / _s["rssi_count"]
                                        if _s["rssi_count"] > 0 else None)
                                _istats.append({
                                    "name":         _s["name"],
                                    "coverage_pct": round(_s["covered"] / total_pts * 100, 1)
                                                    if total_pts else 0,
                                    "avg_rssi":     round(_avg, 1) if _avg is not None else None,
                                    "color_idx":    _ii,
                                })
                            yield sse({
                                "type":               "points_batch",
                                "points":             batch,
                                "progress":           _pt_next + 1,
                                "total":              total_pts,
                                "stats":              _istats,
                                "total_coverage_pct": round(total_covered / total_pts * 100, 1)
                                                      if total_pts else 0,
                                "track_dist_m":       round(track_dist_m),
                            })
                            batch = []
                        _pt_next += 1

                # Safety flush for any remaining batch (e.g. total_pts < FLUSH)
                if batch:
                    _istats = []
                    for _ii, _s in enumerate(rx_stats):
                        if str(receivers[_ii].get("enabled", "1")).strip() == "0":
                            continue
                        _avg = (_s["rssi_sum"] / _s["rssi_count"]
                                if _s["rssi_count"] > 0 else None)
                        _istats.append({
                            "name":         _s["name"],
                            "coverage_pct": round(_s["covered"] / total_pts * 100, 1)
                                            if total_pts else 0,
                            "avg_rssi":     round(_avg, 1) if _avg is not None else None,
                            "color_idx":    _ii,
                        })
                    yield sse({
                        "type":               "points_batch",
                        "points":             batch,
                        "progress":           total_pts,
                        "total":              total_pts,
                        "stats":              _istats,
                        "total_coverage_pct": round(total_covered / total_pts * 100, 1)
                                              if total_pts else 0,
                        "track_dist_m":       round(track_dist_m),
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
                    "chain_mode":         chain_mode,
                    "stats":              stats,
                    "total_coverage_pct": round(total_covered / total_pts * 100, 1) if total_pts else 0,
                    "track_dist_m":       round(track_dist_m),
                })
            else:
                # Links-only: no coverage stats to report
                yield sse({"type": "complete", "mode": mode, "chain_mode": chain_mode,
                           "stats": [], "total_coverage_pct": 0})

        except GeneratorExit:
            pass
        except BaseException as exc:
            import traceback
            app.logger.exception("Analyze SSE generator crashed: %r", exc)
            try:
                yield sse({"type": "error", "message": f"{exc!r}\n{traceback.format_exc()}"})
            except Exception:
                pass

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
# Infrastructure Location Advisor — OSM helpers + greedy optimizer
# ---------------------------------------------------------------------------

FOOT_HIGHWAYS: frozenset[str] = frozenset({"path", "footway", "bridleway"})


def fetch_osm_roads(lat_min: float, lat_max: float,
                    lon_min: float, lon_max: float,
                    include_foot_trails: bool = False) -> list[dict]:
    """Fetch road/trail polylines from the Overpass API for the bounding box."""
    query = (
        f"[out:json][timeout:60];"
        f"way[\"highway\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"(._; >>;);"
        f"out body;"
    )
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            resp = _http.post(OVERPASS_URL, data={"data": query}, timeout=90)
            if resp.status_code in (429, 504):
                time.sleep(5 * (attempt + 1))
                continue
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            break
        except Exception as exc:
            last_exc = exc
            time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"Overpass API failed after 3 attempts: {last_exc}")

    allowed = TIER1_HIGHWAYS | (FOOT_HIGHWAYS if include_foot_trails else frozenset())
    nodes: dict[int, tuple[float, float]] = {}
    ways_raw: list[dict] = []
    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (_rc(el["lat"]), _rc(el["lon"]))
        elif el["type"] == "way":
            ways_raw.append(el)

    ways: list[dict] = []
    for way in ways_raw:
        hw = way.get("tags", {}).get("highway", "")
        if hw not in allowed:
            continue
        pts = [nodes[nid] for nid in way.get("nodes", []) if nid in nodes]
        if len(pts) >= 2:
            ways.append({"highway": hw, "nodes": pts})
    return ways


# ---------------------------------------------------------------------------
# Terrain / land-use exclusion helpers
# ---------------------------------------------------------------------------

# Slope check offset (metres) — elevation is sampled this far in each
# cardinal direction to estimate local gradient.
_SLOPE_PROBE_M = 15.0

# Maximum terrain slope (degrees) allowed for any candidate placement.
# Applies to ALL tiers (not just Tier-2 hike sites).
MAX_SITE_SLOPE_DEG = 35


def _local_slope_deg(lat: float, lon: float, probe_m: float = _SLOPE_PROBE_M) -> float:
    """Estimate terrain slope at (lat, lon) using four cardinal elevation probes.

    Returns the steepest of the N-S and E-W gradients in degrees.
    """
    d_lat = probe_m / 111_000.0
    cos_lat = math.cos(math.radians(lat))
    d_lon = probe_m / (111_000.0 * max(cos_lat, 0.001))

    e_n = _get_elev(lat + d_lat, lon)
    e_s = _get_elev(lat - d_lat, lon)
    e_e = _get_elev(lat, lon + d_lon)
    e_w = _get_elev(lat, lon - d_lon)

    ns_rise = abs(e_n - e_s)
    ew_rise = abs(e_e - e_w)
    run = 2.0 * probe_m
    slope_rad = math.atan(max(ns_rise, ew_rise) / max(run, 0.01))
    return math.degrees(slope_rad)


def fetch_osm_exclusion_zones(
    lat_min: float, lat_max: float,
    lon_min: float, lon_max: float,
) -> list[list[tuple[float, float]]]:
    """Fetch water bodies, wetlands, and building footprints from OSM.

    Returns a list of closed polygon rings as [(lat, lon), ...].  Used as
    exclusion zones — any candidate landing inside one of these polygons is
    rejected as inaccessible.
    """
    query = (
        f"[out:json][timeout:60];"
        f"("
        f"  way[\"natural\"=\"water\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"  way[\"natural\"=\"wetland\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"  way[\"waterway\"=\"riverbank\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"  way[\"landuse\"=\"reservoir\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"  way[\"building\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f"  relation[\"natural\"=\"water\"]({lat_min},{lon_min},{lat_max},{lon_max});"
        f");"
        f"(._; >>;);"
        f"out body;"
    )
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            resp = _http.post(OVERPASS_URL, data={"data": query}, timeout=120)
            if resp.status_code in (429, 504):
                time.sleep(5 * (attempt + 1))
                continue
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            break
        except Exception as exc:
            last_exc = exc
            time.sleep(5 * (attempt + 1))
    else:
        app.logger.warning("Exclusion-zone OSM fetch failed after 3 attempts: %s", last_exc)
        return []

    nodes: dict[int, tuple[float, float]] = {}
    ways_raw: list[dict] = []
    for el in elements:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lat"], el["lon"])
        elif el["type"] == "way":
            ways_raw.append(el)

    polygons: list[list[tuple[float, float]]] = []
    for way in ways_raw:
        tags = way.get("tags", {})
        is_excl = (tags.get("natural") in ("water", "wetland")
                   or tags.get("waterway") == "riverbank"
                   or tags.get("landuse") == "reservoir"
                   or "building" in tags)
        if not is_excl:
            continue
        nids = way.get("nodes", [])
        pts = [nodes[nid] for nid in nids if nid in nodes]
        if len(pts) >= 3:
            polygons.append(pts)

    return polygons


def _point_in_polygon(lat: float, lon: float,
                      poly: list[tuple[float, float]]) -> bool:
    """Ray-casting point-in-polygon test (odd-crossing rule).

    Poly vertices are (lat, lon) pairs.  The test casts a horizontal ray
    in the +lon direction and counts crossings.
    """
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        lat_i, lon_i = poly[i]
        lat_j, lon_j = poly[j]
        if ((lat_i > lat) != (lat_j > lat)) and \
           (lon < (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i) + lon_i):
            inside = not inside
        j = i
    return inside


def _build_exclusion_grid(
    polygons: list[list[tuple[float, float]]],
) -> tuple[dict[tuple[int, int], list[int]], float]:
    """Spatial hash of exclusion polygons for fast point-in-polygon lookups.

    Returns (grid_dict, cell_deg).  Each cell maps to indices into the
    polygons list whose bounding box overlaps that cell.
    """
    cell_deg = 0.005   # ~550 m cells — coarse enough to be fast, fine enough to cull
    grid: dict[tuple[int, int], list[int]] = {}
    for pi, poly in enumerate(polygons):
        lats = [p[0] for p in poly]
        lons = [p[1] for p in poly]
        r_min = int(min(lats) / cell_deg) - 1
        r_max = int(max(lats) / cell_deg) + 1
        c_min = int(min(lons) / cell_deg) - 1
        c_max = int(max(lons) / cell_deg) + 1
        for r in range(r_min, r_max + 1):
            for c in range(c_min, c_max + 1):
                grid.setdefault((r, c), []).append(pi)
    return grid, cell_deg


def point_in_exclusion_zone(
    lat: float, lon: float,
    polygons: list[list[tuple[float, float]]],
    grid: dict[tuple[int, int], list[int]],
    cell_deg: float,
) -> bool:
    """Return True if (lat, lon) falls inside any exclusion polygon."""
    cell = (int(lat / cell_deg), int(lon / cell_deg))
    poly_indices = grid.get(cell)
    if not poly_indices:
        return False
    for pi in poly_indices:
        if _point_in_polygon(lat, lon, polygons[pi]):
            return True
    return False


def sample_road_candidates(ways: list[dict], spacing_m: float) -> list[dict]:
    """Sample candidate infrastructure points every spacing_m metres along roads."""
    seen: set[tuple[float, float]] = set()
    candidates: list[dict] = []

    for way in ways:
        pts = way["nodes"]
        hw  = way["highway"]

        key = (round(pts[0][0], 4), round(pts[0][1], 4))
        if key not in seen:
            seen.add(key)
            candidates.append({"lat": pts[0][0], "lon": pts[0][1],
                                "tier": 1, "highway": hw})

        dist_since_last = 0.0
        for i in range(len(pts) - 1):
            lat1, lon1 = pts[i]
            lat2, lon2 = pts[i + 1]
            seg       = haversine(lat1, lon1, lat2, lon2)
            remaining = spacing_m - dist_since_last

            if seg >= remaining:
                pos = remaining
                while pos <= seg:
                    f  = pos / seg
                    la, lo = intermediate_point(lat1, lon1, lat2, lon2, min(f, 1.0))
                    k = (round(la, 4), round(lo, 4))
                    if k not in seen:
                        seen.add(k)
                        candidates.append({"lat": la, "lon": lo,
                                           "tier": 1, "highway": hw})
                    pos += spacing_m
                dist_since_last = seg - (pos - spacing_m)
            else:
                dist_since_last += seg

    return candidates


def sample_track_candidates(pts: list, spacing_m: float) -> list[dict]:
    """Sample candidate sites every spacing_m metres along the course track itself.

    Tier-3 candidates are placed directly on the race route, guaranteeing
    coverage of sections that have no nearby OSM-mapped roads or trails.
    """
    if not pts or spacing_m <= 0:
        return []

    seen: set[tuple[float, float]] = set()
    candidates: list[dict] = []

    k = (round(pts[0][0], 4), round(pts[0][1], 4))
    seen.add(k)
    candidates.append({"lat": pts[0][0], "lon": pts[0][1], "tier": 3, "highway": "course"})

    dist_since_last = 0.0
    for i in range(len(pts) - 1):
        lat1, lon1 = pts[i]
        lat2, lon2 = pts[i + 1]
        seg       = haversine(lat1, lon1, lat2, lon2)
        remaining = spacing_m - dist_since_last

        if seg >= remaining:
            pos = remaining
            while pos <= seg:
                f  = pos / seg
                la, lo = intermediate_point(lat1, lon1, lat2, lon2, min(f, 1.0))
                k = (round(la, 4), round(lo, 4))
                if k not in seen:
                    seen.add(k)
                    candidates.append({"lat": la, "lon": lo, "tier": 3, "highway": "course"})
                pos += spacing_m
            dist_since_last = seg - (pos - spacing_m)
        else:
            dist_since_last += seg

    return candidates


def terrain_los_clear(
    clat: float, clon: float, c_agl: float,
    tlat: float, tlon: float, t_agl: float = 1.5,
    n_samples: int = 8,
) -> bool:
    """Return True if terrain does not block the straight-line path between a
    candidate site (c_agl metres AGL) and a track point (t_agl AGL).

    Walks n_samples evenly spaced interior points along the path and checks
    whether any terrain reading rises above the LOS elevation at that fraction.
    Coarse but fast — intended as a cheap pre-screen before full RF analysis.
    """
    c_elev = _get_elev(clat, clon) + c_agl
    t_elev = _get_elev(tlat, tlon) + t_agl
    for si in range(1, n_samples):
        f = si / n_samples
        mlat, mlon = intermediate_point(clat, clon, tlat, tlon, f)
        terrain = _get_elev(mlat, mlon)
        if terrain > c_elev + f * (t_elev - c_elev):
            return False
    return True


def coarse_score_candidate(
    clat: float, clon: float, c_agl: float,
    track_pts: list,
    freq_mhz: float, tx_power_dbm: float, tx_gain_dbi: float,
    sensitivity_dbm: float, fade_margin_db: float,
    subsample: int = COARSE_SCORE_SUBSAMPLE,
    n_terrain: int = COARSE_TERRAIN_SAMPLES,
) -> float:
    """Fast coarse coverage fraction using FSPL + simplified binary LOS check.

    Scores the candidate against every `subsample`-th track point using
    COARSE_TERRAIN_SAMPLES interior terrain checks per link (no Deygout
    diffraction).  Runs in the main process from the already-cached tile
    store — roughly 20× faster than full scoring — and is used to rank and
    prune the candidate pool before the expensive parallel RF pass.

    Returns estimated fraction of sampled track points covered [0.0–1.0].
    """
    c_elev    = _get_elev(clat, clon)
    rx_height = c_elev + c_agl
    covered   = 0
    total     = 0

    for pt_lat, pt_lon in track_pts[::subsample]:
        dist_m = haversine(clat, clon, pt_lat, pt_lon)
        if dist_m < 1.0:
            covered += 1
            total   += 1
            continue

        dist_km   = dist_m / 1000.0
        tx_elev   = _get_elev(pt_lat, pt_lon)
        tx_height = tx_elev + 1.5  # tracker AGL

        # FSPL ceiling — if the link can't close in free space, skip terrain work
        fspl = 32.44 + 20.0 * math.log10(max(freq_mhz, 1.0)) + 20.0 * math.log10(max(dist_km, 0.001))
        if tx_power_dbm + tx_gain_dbi - fspl < sensitivity_dbm + fade_margin_db:
            total += 1
            continue

        # Binary terrain check at n_terrain interior fractions (5 m clearance)
        blocked = False
        for si in range(1, n_terrain + 1):
            f      = si / (n_terrain + 1)
            mlat, mlon = intermediate_point(clat, clon, pt_lat, pt_lon, f)
            terrain    = _get_elev(mlat, mlon)
            los_height = rx_height + f * (tx_height - rx_height)
            if terrain > los_height + 5.0:
                blocked = True
                break

        total += 1
        if not blocked:
            covered += 1

    return covered / max(total, 1)


def compute_hot_zones(
    candidates: list[dict],
    cell_m: float = HOT_ZONE_CELL_M,
    min_density: int = HOT_ZONE_MIN_DENSITY,
) -> list[tuple[float, float, int]]:
    """Return geographic cells containing >= min_density coarse-surviving candidates.

    Cells are approximately cell_m × cell_m on the ground.  Returns
    (centre_lat, centre_lon, count) for each qualifying cell.  Hot zones
    indicate areas where the terrain geometry makes many nearby sites viable —
    good candidates for dense micro-sampling.
    """
    cell_deg = cell_m / 111_000.0
    grid: dict[tuple[int, int], list[dict]] = {}
    for c in candidates:
        ci = (int(c["lat"] / cell_deg), int(c["lon"] / cell_deg))
        grid.setdefault(ci, []).append(c)

    zones: list[tuple[float, float, int]] = []
    for cell_cands in grid.values():
        if len(cell_cands) >= min_density:
            avg_lat = sum(c["lat"] for c in cell_cands) / len(cell_cands)
            avg_lon = sum(c["lon"] for c in cell_cands) / len(cell_cands)
            zones.append((avg_lat, avg_lon, len(cell_cands)))

    return zones


def expand_hot_zones(
    hot_zones: list[tuple[float, float, int]],
    expand_m: float = HOT_ZONE_EXPAND_M,
    step_m: float = HOT_ZONE_STEP_M,
) -> list[dict]:
    """Generate a fine grid of Tier-4 micro-candidates around each hot zone centre.

    Creates candidates at step_m resolution within expand_m radius.  These
    micro-candidates let the optimizer explore small spatial variations —
    exact ridge position, alternate road access points — that the sparser
    initial sweep may have missed in a zone that already demonstrated good
    RF geometry during coarse scoring.
    """
    micro: list[dict] = []
    seen:  set[tuple[float, float]] = set()
    n_steps = max(1, int(expand_m / step_m))

    for centre_lat, centre_lon, _density in hot_zones:
        cos_lat       = math.cos(math.radians(centre_lat))
        m_per_deg_lat = 111_000.0
        m_per_deg_lon = 111_000.0 * max(cos_lat, 0.001)

        for di in range(-n_steps, n_steps + 1):
            for dj in range(-n_steps, n_steps + 1):
                offset_m = math.sqrt((di * step_m) ** 2 + (dj * step_m) ** 2)
                if offset_m > expand_m or offset_m < 1.0:
                    continue
                lat = centre_lat + (di * step_m) / m_per_deg_lat
                lon = centre_lon + (dj * step_m) / m_per_deg_lon
                key = (round(lat, 4), round(lon, 4))
                if key not in seen:
                    seen.add(key)
                    micro.append({"lat": lat, "lon": lon,
                                  "tier": 4, "highway": "hot_zone"})

    return micro


def find_highpoint_candidates(
    tier1_pts: list[dict],
    max_dist_m: float,
    grid_m: float,
) -> list[dict]:
    """For each Tier-1 road point find the highest terrain point reachable by hike.

    Scans radially in HIGHPOINT_N_BEARINGS directions out to max_dist_m at
    grid_m intervals.  Returns each best-elevated point that is higher than
    its corresponding road point (deduplicated across all road points).
    """
    if not tier1_pts or max_dist_m <= 0:
        return []

    n_rings  = max(1, int(max_dist_m / grid_m))
    n_angles = HIGHPOINT_N_BEARINGS
    seen: set[tuple[float, float]] = set()
    candidates: list[dict] = []

    for road_pt in tier1_pts:
        lat0, lon0 = road_pt["lat"], road_pt["lon"]
        road_elev  = _get_elev(_rc(lat0), _rc(lon0))
        best_elev  = road_elev
        best_la: float | None = None
        best_lo: float | None = None

        cos_lat = math.cos(math.radians(lat0))
        for ring in range(1, n_rings + 1):
            dist = ring * grid_m
            for ai in range(n_angles):
                bearing = math.tau * ai / n_angles
                la = _rc(lat0 + (dist * math.cos(bearing)) / 111_000.0)
                lo = _rc(lon0 + (dist * math.sin(bearing))
                         / (111_000.0 * max(cos_lat, 0.001)))
                elev = _get_elev(la, lo)
                # Skip terrain that is steeper than MAX_HIKE_SLOPE_DEG
                if (elev - road_elev) / max(dist, 1) > math.tan(math.radians(MAX_HIKE_SLOPE_DEG)):
                    continue
                if elev > best_elev:
                    best_elev = elev
                    best_la, best_lo = la, lo

        if best_la is not None:
            key = (round(best_la, 4), round(best_lo, 4))
            if key not in seen:
                seen.add(key)
                candidates.append({"lat": best_la, "lon": best_lo,
                                    "tier": 2, "highway": "highpoint",
                                    "elev_m": best_elev})

    return candidates


def greedy_set_cover(
    candidates: list[dict],
    total_pts: int,
    max_n: int,
    target_pct: float = 100.0,
    pre_covered: set[int] | None = None,
    min_contribution_pct: float = 0.0,
) -> list[dict]:
    """Iteratively select the candidate with the best marginal coverage gain."""
    if not candidates or total_pts == 0:
        return []

    remaining = [{**c, "covered_set": set(c["covered_set"])} for c in candidates]
    covered:  set[int]   = set(pre_covered) if pre_covered else set()
    selected: list[dict] = []
    min_marginal_pts = max(1, math.ceil(min_contribution_pct / 100.0 * total_pts)) \
                       if min_contribution_pct > 0 else 1

    for rank in range(1, max_n + 1):
        if len(covered) / total_pts * 100 >= target_pct:
            break
        if not remaining:
            break

        remaining.sort(key=lambda c: len(c["covered_set"] - covered), reverse=True)
        best     = remaining.pop(0)
        marginal = best["covered_set"] - covered

        if len(marginal) < min_marginal_pts:
            break

        covered |= marginal
        alternatives = []
        for alt in remaining[:2]:
            alt_marginal = len(alt["covered_set"] - covered)
            if alt_marginal > 0:
                alternatives.append({
                    "lat":         alt["lat"],
                    "lon":         alt["lon"],
                    "tier":        alt.get("tier", 1),
                    "highway":     alt.get("highway", ""),
                    "marginal_pct": round(alt_marginal / total_pts * 100, 1),
                })
        selected.append({
            "rank":             rank,
            "lat":              best["lat"],
            "lon":              best["lon"],
            "cand_idx":         best.get("cand_idx"),
            "tier":             best.get("tier", 1),
            "highway":          best.get("highway", ""),
            "coverage_pct":     best["coverage_pct"],
            "marginal_pts":     len(marginal),
            "marginal_pct":     round(len(marginal) / total_pts * 100, 1),
            "cumulative_pct":   round(len(covered)  / total_pts * 100, 1),
            "marginal_indices": sorted(marginal),
            "alternatives":     alternatives,
        })

    return selected


# ---------------------------------------------------------------------------
# Route – Infrastructure Location Advisor (Server-Sent Events)
# ---------------------------------------------------------------------------

@app.route("/api/suggest-locations", methods=["POST"])
def suggest_locations():
    data             = request.get_json()
    kml_file         = data.get("kml_file")
    freq_mhz         = float(data.get("freq_mhz",            915))
    tx_power_dbm     = float(data.get("tx_power_dbm",         22))
    tx_gain_dbi      = float(data.get("tx_gain_dbi",           0))
    sensitivity_dbm  = float(data.get("sensitivity_dbm",    -135))
    veg_type         = data.get("veg_type",                "none")
    fade_margin_db   = float(data.get("fade_margin_db",        0))
    antenna_height_m = float(data.get("antenna_height_m",      4))
    max_walk_m       = float(data.get("max_walk_m",           500))
    max_locations    = int(  data.get("max_locations",          5))
    target_cov_pct   = float(data.get("target_coverage_pct",  90))
    tier_hint              = str(  data.get("tier_hint",            "wide1")).lower()
    min_contribution_pct   = float(data.get("min_contribution_pct",    1.0))
    include_foot_trails    = bool( data.get("include_foot_trails",   False))
    max_practical_range_m  = float(data.get("max_practical_range_m", 75_000))
    existing_receivers     = [r for r in data.get("receivers", [])
                              if str(r.get("enabled", "1")) != "0"]

    def generate():
        try:
            _stop_flag: list = [False]  # set True on generator exit to halt filter_thread
            # Determine backbone anchors for chain-aware scoring (WIDE1 and WIDE2).
            # Both tiers require a relay path to a WIDE2/iGate to be network-useful.
            # Load an iGate or existing WIDE2 in the receivers CSV to enable this check.
            backbone_pts: tuple | None = None
            if tier_hint in ("wide1", "wide2") and existing_receivers:
                backbone_rxs = [
                    r for r in existing_receivers
                    if str(r.get("role", "wide1")).lower() in ("wide2", "igate")
                ]
                if backbone_rxs:
                    backbone_pts = tuple(
                        (_rc(float(r["latitude"])), _rc(float(r["longitude"])),
                         float(r.get("height_agl_m") or 4))
                        for r in backbone_rxs
                    )

            yield sse({"type": "status", "message": "Parsing track file…"})

            if not kml_file:
                yield sse({"type": "error", "message": "kml_file is required"}); return
            kml_p = KML_DIR / secure_filename(kml_file)
            if not kml_p.exists():
                yield sse({"type": "error", "message": "Track file not found"}); return

            try:
                waypoints = parse_track_file(
                    kml_p.read_text(encoding="utf-8", errors="replace"), kml_p.name
                )
            except Exception as exc:
                yield sse({"type": "error", "message": f"Could not parse track: {exc}"}); return
            if not waypoints:
                yield sse({"type": "error", "message": "No track coordinates found"}); return

            # Cap at 300 pts — adequate coverage resolution, bounded per-candidate cost
            track_pts = interpolate_path(waypoints, max_pts=300)
            total_pts = len(track_pts)

            yield sse({"type": "status",
                       "message": f"Track: {total_pts} scoring points. Fetching terrain…"})
            yield sse({"type": "track_pts",
                       "pts": [[round(p[0], 5), round(p[1], 5)] for p in track_pts]})

            all_lats = [p[0] for p in track_pts]
            all_lons = [p[1] for p in track_pts]
            la_min = min(all_lats) - 0.02
            la_max = max(all_lats) + 0.02
            lo_min = min(all_lons) - 0.02
            lo_max = max(all_lons) + 0.02

            # Prefetch elevation tiles (identical pattern to analyze())
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

            # Pre-score existing receivers so greedy set-cover only fills gaps.
            # Parallelize across track points (same strategy as /api/analyze) rather
            # than per-receiver futures — with only 2–10 receivers the old approach
            # left most workers idle; 300 track-point tasks saturate all cores.
            pre_covered: set[int] = set()
            if existing_receivers:
                yield sse({"type": "status",
                           "message": f"Scoring {len(existing_receivers)} existing receiver(s)…"})

                def _rx_site_gain(r: dict) -> float:
                    # Use the CSV value; fall back to WIDE_APRS_RX_GAIN_DBI for
                    # WIDE1/WIDE2/iGate when the CSV entry was left at zero.
                    raw = float(r.get("antenna_gain_dbi") or 0)
                    if raw == 0.0 and str(r.get("role", "")).lower() in ("wide1", "wide2", "igate"):
                        return WIDE_APRS_RX_GAIN_DBI
                    return raw

                _eff_existing = [
                    {**r, "antenna_gain_dbi": _rx_site_gain(r)}
                    for r in existing_receivers
                ]
                pre_point_args = [
                    (idx, plat, plon, _eff_existing,
                     freq_mhz, tx_power_dbm, tx_gain_dbi,
                     sensitivity_dbm, veg_type, fade_margin_db,
                     False, frozenset())   # chain_mode off — raw coverage only
                    for idx, (plat, plon) in enumerate(track_pts)
                ]
                pool = _get_advisor_pool()
                # Use submit+cf_wait (not pool.map) so the generator keeps yielding
                # SSE heartbeats — pool.map blocks the generator entirely and the
                # browser SSE connection times out on longer tracks.
                pre_pending = {pool.submit(_point_task, a) for a in pre_point_args}
                n_pre_pts = len(pre_point_args)
                pre_done_count = 0
                while pre_pending:
                    just_done, pre_pending = cf_wait(pre_pending, timeout=8)
                    if not just_done:
                        yield sse({"type": "step_progress",
                                   "message": f"Scoring existing receivers… {pre_done_count}/{n_pre_pts} pts"})
                        continue
                    for fut in just_done:
                        try:
                            pt = fut.result()
                            if pt["coverage"]:
                                pre_covered.add(pt["idx"])
                        except Exception as exc:
                            app.logger.warning("pre-score point failed: %s", exc)
                        pre_done_count += 1
                    yield sse({"type": "step_progress",
                               "message": f"Scoring existing receivers… {pre_done_count}/{n_pre_pts} pts"})
                yield sse({
                    "type":            "existing_coverage",
                    "coverage_pct":    round(len(pre_covered) / total_pts * 100, 1),
                    "receiver_count":  len(existing_receivers),
                    "covered_indices": sorted(pre_covered),
                })

            # Fetch OSM road/trail network AND exclusion zones (water, wetland,
            # buildings) in parallel threads.  Both use Overpass API — separate
            # queries avoid bloating a single response and let the two requests
            # pipeline on the Overpass server.
            yield sse({"type": "status",
                       "message": "Fetching road/trail and terrain exclusion data from OpenStreetMap…"})
            _osm_result: list = [None]
            _osm_exc:    list = [None]
            _excl_result: list = [None]
            _excl_exc:    list = [None]
            def _do_osm():
                try:
                    _osm_result[0] = fetch_osm_roads(la_min, la_max, lo_min, lo_max,
                                                     include_foot_trails)
                except Exception as e:
                    _osm_exc[0] = e
            def _do_excl():
                try:
                    _excl_result[0] = fetch_osm_exclusion_zones(
                        la_min, la_max, lo_min, lo_max)
                except Exception as e:
                    _excl_exc[0] = e
            osm_thread  = threading.Thread(target=_do_osm,  daemon=True)
            excl_thread = threading.Thread(target=_do_excl, daemon=True)
            osm_thread.start()
            excl_thread.start()
            while osm_thread.is_alive() or excl_thread.is_alive():
                roads_done = not osm_thread.is_alive()
                excl_done  = not excl_thread.is_alive()
                if roads_done and not excl_done:
                    msg = "Roads loaded — awaiting water/building exclusion data…"
                elif excl_done and not roads_done:
                    msg = "Exclusion zones loaded — awaiting road/trail data…"
                else:
                    msg = "Fetching road/trail and terrain exclusion data from OpenStreetMap…"
                yield sse({"type": "status", "message": msg})
                time.sleep(1)
            osm_thread.join()
            excl_thread.join()
            if _osm_exc[0]:
                yield sse({"type": "error", "message": str(_osm_exc[0])}); return
            ways = _osm_result[0]

            # Build exclusion zone spatial index (non-fatal if fetch failed)
            _excl_polygons: list[list[tuple[float, float]]] = []
            _excl_grid:  dict[tuple[int, int], list[int]] = {}
            _excl_cell_deg: float = 0.005
            if _excl_exc[0]:
                app.logger.warning("Exclusion zone fetch failed: %s", _excl_exc[0])
            elif _excl_result[0]:
                _excl_polygons = _excl_result[0]
                _excl_grid, _excl_cell_deg = _build_exclusion_grid(_excl_polygons)

            yield sse({"type": "osm_status",
                       "message": (f"Found {len(ways)} road/trail segments, "
                                   f"{len(_excl_polygons)} exclusion zone(s). "
                                   f"Generating candidates…"),
                       "way_count": len(ways),
                       "exclusion_zone_count": len(_excl_polygons)})

            # Emit simplified road geometry for map preview.
            # Nodes are (lat, lon) tuples; subsample to ~10 pts per way.
            _road_lines: list = []
            for _way in ways:
                _pts = _way.get("nodes", [])
                if len(_pts) < 2:
                    continue
                _step = max(1, len(_pts) // 10)
                _sub  = _pts[::_step]
                if _sub[-1] != _pts[-1]:
                    _sub = list(_sub) + [_pts[-1]]
                _road_lines.append(
                    [[round(p[0], 5), round(p[1], 5)] for p in _sub])
            if _road_lines:
                yield sse({"type": "osm_roads", "lines": _road_lines})

            # Emit exclusion zone polygons (water, buildings) — capped for payload size.
            if _excl_polygons:
                _excl_out: list = []
                for _poly in _excl_polygons[:200]:
                    _pstep = max(1, len(_poly) // 20)
                    _excl_out.append(
                        [[round(p[0], 5), round(p[1], 5)] for p in _poly[::_pstep]])
                yield sse({"type": "osm_exclusions", "polygons": _excl_out})

            # Tier-1: sample points along driveable roads
            tier1 = sample_road_candidates(ways, ROAD_SAMPLE_SPACING_M)

            # Tier-3: sample points directly on the race route.  Uses the
            # full-resolution waypoints (not the 300-pt scoring grid) so spacing
            # is consistent regardless of course length.  These guarantee candidates
            # where OSM road coverage is incomplete (private roads, unmarked trails).
            tier3 = sample_track_candidates(waypoints, TRACK_SAMPLE_SPACING_M)

            # Tier-2: elevated sites reachable by short hike — run in thread
            # so the keepalive yields prevent proxy timeouts during the scan.
            tier2: list[dict] = []
            if max_walk_m > 0 and tier1:
                yield sse({"type": "status",
                           "message": "Scanning for elevated hike-accessible sites…"})
                _hp_result: list = [None]
                _hp_exc:    list = [None]
                def _do_hp():
                    try:
                        _hp_result[0] = find_highpoint_candidates(
                            tier1, max_walk_m, HIGHPOINT_GRID_M)
                    except Exception as e:
                        _hp_exc[0] = e
                hp_thread = threading.Thread(target=_do_hp, daemon=True)
                hp_thread.start()
                while hp_thread.is_alive():
                    yield sse({"type": "status",
                               "message": "Scanning for elevated hike-accessible sites…"})
                    time.sleep(1)
                hp_thread.join()
                if _hp_exc[0]:
                    app.logger.warning("Highpoint scan error: %s", _hp_exc[0])
                    # Non-fatal: continue without Tier-2 candidates
                else:
                    tier2 = _hp_result[0] or []

            yield sse({"type": "status", "message": "Merging candidate pool…"})

            # Merge and deduplicate into raw pool (up to RAW_CANDIDATES_CAP).
            # WIDE2: elevation highpoints → roads → on-route fallback.
            # WIDE1: on-route (most course-relevant) → roads → hilltops.
            if tier_hint == "wide2":
                tier2_sorted = sorted(tier2, key=lambda c: c.get("elev_m", 0), reverse=True)
                merged_order = tier2_sorted + tier1 + tier3
            else:
                merged_order = tier3 + tier1 + tier2
            seen_keys: set[tuple[float, float]] = set()
            candidates: list[dict] = []
            for c in merged_order:
                k = (round(c["lat"], 4), round(c["lon"], 4))
                if k not in seen_keys:
                    seen_keys.add(k)
                    candidates.append(c)
                if len(candidates) >= RAW_CANDIDATES_CAP:
                    break

            # FSPL-based range pre-filter — cheap haversine pass to drop candidates
            # that are too far from every track point to ever close the link budget,
            # even under ideal free-space conditions.  Runs in milliseconds and
            # lets us draw from a 1000-candidate raw pool while only passing the
            # spatially relevant subset to the expensive terrain/diffraction model.
            fspl_budget_db = (tx_power_dbm + tx_gain_dbi + WIDE_APRS_RX_GAIN_DBI
                              - sensitivity_dbm - fade_margin_db)
            try:
                max_range_m = (10 ** ((fspl_budget_db - 32.44
                                       - 20 * math.log10(freq_mhz)) / 20)) * 1000.0
            except (ValueError, ZeroDivisionError):
                max_range_m = float("inf")

            # Clamp theoretical FSPL range to the user's practical limit.
            # For APRS the FSPL budget gives thousands of km (free-space ideal),
            # but real-world terrain and propagation cap usable range far lower.
            effective_range_m = min(max_range_m, max_practical_range_m)

            pre_fspl_count = len(candidates)
            if math.isfinite(effective_range_m) and candidates:
                _c_lats_r = np.radians([c["lat"] for c in candidates])
                _c_lons_r = np.radians([c["lon"] for c in candidates])
                _t_lats_r = np.radians([tp[0] for tp in track_pts])
                _t_lons_r = np.radians([tp[1] for tp in track_pts])
                _dlat = _c_lats_r[:, None] - _t_lats_r[None, :]
                _dlon = _c_lons_r[:, None] - _t_lons_r[None, :]
                _a    = (np.sin(_dlat / 2)**2
                         + np.cos(_c_lats_r)[:, None] * np.cos(_t_lats_r)[None, :]
                         * np.sin(_dlon / 2)**2)
                _dist_m   = 2 * EARTH_R * np.arcsin(np.sqrt(np.clip(_a, 0, 1)))
                _in_range = np.any(_dist_m <= effective_range_m, axis=1)
                raw_count = len(candidates)
                candidates = [c for c, ok in zip(candidates, _in_range) if ok]
                removed = raw_count - len(candidates)
                if removed:
                    yield sse({"type": "status",
                               "message": (f"Range pre-filter: {removed} out-of-range "
                                           f"candidates removed, {len(candidates)} remain.")})

            # ── Phases 0b / 1 / 2: terrain filter + coarse RF scoring + hot-zone
            # expansion — all run in a daemon thread so the generator keeps
            # yielding keepalive SSE events every 0.5 s.  Without this the
            # Flask generator blocks for minutes (1500 candidates × ~100 ms
            # per _get_elev() SQLite fallback) and the browser drops the SSE
            # connection, resetting the UI button.
            _phase_state: dict = {
                "phase":   "terrain",
                "current": 0,
                "total":   len(candidates),
                "message": f"Checking terrain accessibility for {len(candidates)} candidates…",
                "done":    False,
                "error":   None,
            }
            _phase_candidates: list = [None]

            def _run_phases_012():
                try:
                    _pool = _get_advisor_pool()

                    # ── Phase 0b: terrain accessibility filter (parallel) ─
                    _phase_state["phase"] = "terrain"
                    _phase_state["total"] = len(candidates)
                    terrain_ok: list[dict] = []
                    slope_rej = excl_rej = 0
                    _chk_args = [
                        (ti, c["lat"], c["lon"], MAX_SITE_SLOPE_DEG,
                         _excl_polygons, _excl_grid, _excl_cell_deg)
                        for ti, c in enumerate(candidates)
                    ]
                    _chk_chunk = max(1, len(_chk_args) // (_POOL_WORKERS * 4))
                    for res in _pool.map(_terrain_check_task, _chk_args,
                                         chunksize=_chk_chunk):
                        if res["ok"]:
                            terrain_ok.append(candidates[res["ci"]])
                        elif res["reason"] == "slope":
                            slope_rej += 1
                        else:
                            excl_rej += 1
                        _phase_state["current"] = res["ci"] + 1
                        _phase_state["message"] = (
                            f"Terrain check: {res['ci'] + 1}/{len(candidates)}…")

                    if _stop_flag[0]:
                        return

                    total_rej = slope_rej + excl_rej
                    filtered = terrain_ok if terrain_ok else candidates
                    _phase_state["message"] = (
                        f"Terrain filter: removed {total_rej} inaccessible "
                        f"({slope_rej} steep, {excl_rej} water/building). "
                        f"{len(filtered)} remain.")

                    # ── Phase 1: coarse RF scoring (parallel) ─────────────
                    _PRE_COARSE_CAP = 1500
                    if len(filtered) > _PRE_COARSE_CAP:
                        filtered.sort(key=lambda c: c["lat"])
                        _step = len(filtered) / _PRE_COARSE_CAP
                        filtered = [filtered[int(i * _step)]
                                    for i in range(_PRE_COARSE_CAP)]

                    _phase_state["phase"] = "score"
                    _phase_state["total"] = len(filtered)
                    _phase_state["current"] = 0
                    _phase_state["message"] = (
                        f"Coarse scoring {len(filtered)} candidates…")

                    rx_gain_total = tx_gain_dbi + WIDE_APRS_RX_GAIN_DBI
                    _cs_args = [
                        (ci, c["lat"], c["lon"], antenna_height_m,
                         track_pts, freq_mhz,
                         tx_power_dbm, rx_gain_total,
                         sensitivity_dbm, fade_margin_db)
                        for ci, c in enumerate(filtered)
                    ]
                    _cs_chunk = max(1, len(_cs_args) // (_POOL_WORKERS * 4))
                    for res in _pool.map(_coarse_task, _cs_args,
                                          chunksize=_cs_chunk):
                        filtered[res["ci"]]["_coarse"] = res["score"]
                        _phase_state["current"] = res["ci"] + 1
                        _phase_state["message"] = (
                            f"Coarse scoring: {res['ci'] + 1}/{len(filtered)}…")

                    if _stop_flag[0]:
                        return

                    filtered.sort(key=lambda c: c["_coarse"], reverse=True)
                    n_keep = max(50, int(len(filtered) * (1.0 - COARSE_REJECT_BOTTOM)))
                    coarse_survivors = filtered[:n_keep]

                    # ── Phase 2: heat-map expansion ───────────────────────
                    hot_zones   = compute_hot_zones(coarse_survivors)
                    micro_cands = expand_hot_zones(hot_zones)
                    # Store for the generator to emit as a map visualization event
                    _phase_state["hot_zones"] = [
                        {"lat": lat, "lon": lon, "count": cnt}
                        for lat, lon, cnt in hot_zones
                    ]

                    if micro_cands:
                        _phase_state["phase"] = "hotzone"
                        _phase_state["total"] = len(micro_cands)
                        _phase_state["current"] = 0
                        _phase_state["message"] = (
                            f"Hot-zone analysis: {len(hot_zones)} zone(s) → "
                            f"scoring {len(micro_cands)} micro-candidates…")

                        existing_keys = {
                            (round(c["lat"], 4), round(c["lon"], 4))
                            for c in coarse_survivors
                        }
                        # Deduplicate before dispatching to pool
                        novel_mc = [
                            mc for mc in micro_cands
                            if (round(mc["lat"], 4), round(mc["lon"], 4))
                            not in existing_keys
                        ]

                        # Parallel terrain check for novel micro-candidates
                        _mc_chk_args = [
                            (mi, mc["lat"], mc["lon"], MAX_SITE_SLOPE_DEG,
                             _excl_polygons, _excl_grid, _excl_cell_deg)
                            for mi, mc in enumerate(novel_mc)
                        ]
                        _mc_chk_chunk = max(1, len(_mc_chk_args) // (_POOL_WORKERS * 4)) if _mc_chk_args else 1
                        mc_terrain_ok: list[dict] = []
                        for res in _pool.map(_terrain_check_task, _mc_chk_args,
                                              chunksize=_mc_chk_chunk):
                            if res["ok"]:
                                mc_terrain_ok.append(novel_mc[res["ci"]])
                            _phase_state["current"] = res["ci"] + 1
                            _phase_state["message"] = (
                                f"Hot-zone terrain check: {res['ci'] + 1}/{len(novel_mc)}…")

                        # Parallel coarse score for terrain-ok micro-candidates
                        _mc_cs_args = [
                            (mi, mc["lat"], mc["lon"], antenna_height_m,
                             track_pts, freq_mhz,
                             tx_power_dbm, rx_gain_total,
                             sensitivity_dbm, fade_margin_db)
                            for mi, mc in enumerate(mc_terrain_ok)
                        ]
                        _mc_cs_chunk = max(1, len(_mc_cs_args) // (_POOL_WORKERS * 4)) if _mc_cs_args else 1
                        micro_survivors: list[dict] = []
                        for res in _pool.map(_coarse_task, _mc_cs_args,
                                              chunksize=_mc_cs_chunk):
                            mc = mc_terrain_ok[res["ci"]]
                            if res["score"] > 0.0:
                                mc["_coarse"] = res["score"]
                                mk = (round(mc["lat"], 4), round(mc["lon"], 4))
                                if mk not in existing_keys:
                                    micro_survivors.append(mc)
                                    existing_keys.add(mk)
                            _phase_state["current"] = res["ci"] + 1
                            _phase_state["message"] = (
                                f"Hot-zone scoring: {res['ci'] + 1}/{len(mc_terrain_ok)}…")

                        coarse_survivors = coarse_survivors + micro_survivors
                        _phase_state["message"] = (
                            f"{len(micro_survivors)} micro-candidates added from "
                            f"hot zones. Pool: {len(coarse_survivors)}.")

                    _phase_candidates[0] = coarse_survivors

                except BaseException as exc:
                    _phase_state["error"] = repr(exc)
                    app.logger.exception("_run_phases_012 crashed: %r", exc)
                finally:
                    _phase_state["done"] = True

            filter_thread = threading.Thread(target=_run_phases_012, daemon=True)
            filter_thread.start()
            while not _phase_state["done"]:
                yield sse({
                    "type":    "coarse_progress",
                    "phase":   _phase_state["phase"],
                    "current": _phase_state["current"],
                    "total":   max(1, _phase_state["total"]),
                    "message": _phase_state["message"],
                })
                time.sleep(0.5)
            filter_thread.join()

            if _phase_state["error"]:
                yield sse({"type": "status",
                           "message": f"Warning during coarse phase: {_phase_state['error']}"})

            # Final yield so the completed state is visible in the UI
            yield sse({
                "type":    "coarse_progress",
                "phase":   _phase_state["phase"],
                "current": max(1, _phase_state["total"]),
                "total":   max(1, _phase_state["total"]),
                "message": _phase_state["message"],
            })

            # Diagnostic breadcrumb — this status event lets the user (and logs)
            # distinguish a crash during the coarse filter from one after it.
            _pre_los_count = len(_phase_candidates[0]) if _phase_candidates[0] is not None else len(candidates)
            yield sse({"type": "status",
                       "message": f"Coarse filter done — {_pre_los_count} candidates, running LOS pre-filter…"})

            # Emit hot zone circles for map visualization
            _hz = _phase_state.get("hot_zones") or []
            if _hz:
                yield sse({"type": "hot_zones",
                           "zones": _hz,
                           "radius_m": HOT_ZONE_EXPAND_M})

            candidates = (
                _phase_candidates[0]
                if _phase_candidates[0] is not None
                else candidates
            )

            # ── Phase 3: Vectorized nearest-track-point index ────────────────
            # One numpy argmin over the full squared-degrees distance matrix
            # replaces an O(n×m) Python loop.
            _gc_lats = np.array([c["lat"] for c in candidates])
            _gc_lons = np.array([c["lon"] for c in candidates])
            _gt_lats = np.array([tp[0] for tp in track_pts])
            _gt_lons = np.array([tp[1] for tp in track_pts])
            _gd2     = ((_gc_lats[:, None] - _gt_lats[None, :])**2
                        + (_gc_lons[:, None] - _gt_lons[None, :])**2)
            for c, ni in zip(candidates, np.argmin(_gd2, axis=1)):
                c["_ntidx"] = int(ni)

            # ── Phase 4: Terrain LOS pre-filter (parallel) ──────────────────
            # Belt-and-suspenders: reject candidates with no clear LOS to any
            # of their nearest LOS_CHECK_PTS track points using the 8-sample
            # full LOS check (catches coarse-scoring edge cases).
            _LOS_CHECK_PTS = 6
            _los_args: list[tuple] = []
            for ci2, c in enumerate(candidates):
                ni    = c["_ntidx"]
                start = max(0, ni - _LOS_CHECK_PTS // 2)
                end   = min(len(track_pts), start + _LOS_CHECK_PTS)
                _los_args.append((ci2, c["lat"], c["lon"], antenna_height_m,
                                  [(track_pts[ti][0], track_pts[ti][1])
                                   for ti in range(start, end)]))
            _los_pool    = _get_advisor_pool()
            _los_pending: set = set()
            for _la in _los_args:
                try:
                    _los_pending.add(_los_pool.submit(_los_check_task, _la))
                except Exception as _lse:
                    app.logger.warning("LOS submit failed: %s", _lse)
                    _los_done += 1
            _los_ok: set[int] = set()
            _los_done = 0
            _n_los    = len(_los_args)
            while _los_pending:
                _just_done, _los_pending = cf_wait(_los_pending, timeout=8)
                if not _just_done:
                    yield sse({"type": "step_progress",
                               "message": f"LOS pre-filter: {_los_done}/{_n_los}…"})
                    continue
                for _fut in _just_done:
                    try:
                        _r = _fut.result()
                        if _r["ok"]:
                            _los_ok.add(_r["ci"])
                    except Exception as _exc:
                        app.logger.warning("LOS check failed: %s", _exc)
                    _los_done += 1
                yield sse({"type": "step_progress",
                           "message": f"LOS pre-filter: {_los_done}/{_n_los}…"})
            _los_survivors = [c for ci2, c in enumerate(candidates) if ci2 in _los_ok]
            if _los_survivors:
                candidates = _los_survivors

            # Drop candidates whose nearest track point is already covered.
            gap_candidates = [c for c in candidates if c["_ntidx"] not in pre_covered]
            work = gap_candidates if gap_candidates else candidates

            # ── Phase 5: Quality-aware geographic stride ─────────────────────
            # Divide work into MAX_CANDIDATES geographic buckets (by track
            # position) and within each bucket select the candidate with the
            # highest coarse score.  This preserves full-course geographic
            # spread while preferring sites that already demonstrated good RF
            # geometry in the coarse pass.
            work.sort(key=lambda c: c["_ntidx"])
            if len(work) > MAX_CANDIDATES:
                bucket_size = len(work) / MAX_CANDIDATES
                candidates = []
                for bi in range(MAX_CANDIDATES):
                    bstart = int(bi * bucket_size)
                    bend   = int((bi + 1) * bucket_size)
                    bucket = work[bstart:bend]
                    if bucket:
                        candidates.append(max(bucket, key=lambda c: c.get("_coarse", 0.0)))
            else:
                candidates = work

            if candidates:
                yield sse({"type": "candidates", "candidates": [
                    {"idx": i, "lat": c["lat"], "lon": c["lon"], "tier": c.get("tier", 1)}
                    for i, c in enumerate(candidates)
                ]})

            if not candidates:
                if pre_fspl_count > 0:
                    yield sse({
                        "type":    "error",
                        "message": (
                            f"Range pre-filter eliminated all {pre_fspl_count} candidates — "
                            f"link budget too tight for this frequency/power combination. "
                            f"Try increasing TX power, reducing fade margin, or checking frequency."
                        ),
                    }); return
                yield sse({
                    "type":    "error",
                    "message": ("No road/trail candidates found in the course area. "
                                "Ensure the course overlaps an area with OSM road data."),
                }); return

            _tier4_count = sum(1 for c in candidates if c.get("tier") == 4)
            yield sse({
                "type":            "osm_status",
                "message":         f"{len(candidates)} candidate sites ready to score "
                                   f"({_tier4_count} from hot-zone expansion).",
                "way_count":       len(ways),
                "candidate_count": len(candidates),
                "tier1_count":     len(tier1),
                "tier2_count":     len(tier2),
                "tier4_count":     _tier4_count,
            })

            # Parallel RF scoring via the analysis process pool
            n_cands = len(candidates)
            if backbone_pts:
                tier_label = tier_hint.upper()
                yield sse({"type": "status",
                           "message": (f"Chain mode: {len(backbone_pts)} backbone anchor(s) found — "
                                       f"scoring {n_cands} {tier_label} candidates for relay viability…")})
            elif tier_hint in ("wide1", "wide2") and existing_receivers and not backbone_pts:
                yield sse({"type": "status",
                           "message": (f"No WIDE2/iGate receivers loaded — "
                                       f"scoring {n_cands} candidates for direct coverage only.")})
            else:
                yield sse({"type": "status",
                           "message": f"Scoring {n_cands} candidate sites via RF model…"})

            score_args = [
                (i, c["lat"], c["lon"], antenna_height_m,
                 track_pts, freq_mhz, tx_power_dbm,
                 tx_gain_dbi + WIDE_APRS_RX_GAIN_DBI,   # tracker TX gain + proposed site RX gain
                 sensitivity_dbm, veg_type, fade_margin_db,
                 backbone_pts, max_practical_range_m)
                for i, c in enumerate(candidates)
            ]

            scored: list[dict] = []
            backbone_blocked_count = 0
            pool = _get_advisor_pool()
            futures = {pool.submit(score_candidate, a): a[0] for a in score_args}
            done_count  = 0
            skip_count  = 0
            pending = set(futures.keys())
            while pending:
                just_done, pending = cf_wait(pending, timeout=8)
                if not just_done:
                    # No futures finished in 8 s — yield keepalive to prevent proxy timeout
                    yield sse({"type": "scoring_progress",
                               "current": done_count, "total": n_cands})
                    continue
                for fut in just_done:
                    try:
                        result = fut.result()
                    except Exception as exc:
                        skip_count += 1
                        app.logger.warning("score_candidate failed: %s", exc)
                    else:
                        c = candidates[result["cand_idx"]]
                        result["tier"]    = c.get("tier", 1)
                        result["highway"] = c.get("highway", "")
                        if result.get("backbone_blocked"):
                            backbone_blocked_count += 1
                        scored.append(result)
                        yield sse({"type": "candidate_scored",
                                   "idx": result["cand_idx"],
                                   "coverage_pct": result["coverage_pct"],
                                   "backbone_blocked": result.get("backbone_blocked", False)})
                    done_count += 1
                yield sse({"type": "scoring_progress",
                           "current": done_count, "total": n_cands})

            if skip_count:
                yield sse({"type": "status",
                           "message": f"{skip_count} candidate(s) skipped due to scoring errors."})

            # Compute best possible marginal before applying min_contribution filter,
            # so the failure message can tell the user how much headroom they have.
            pre_covered_snap = set(pre_covered)
            best_marginal_pct = 0.0
            if scored:
                best_marginal_pts = max(
                    len(set(c["covered_set"]) - pre_covered_snap) for c in scored
                )
                best_marginal_pct = round(best_marginal_pts / total_pts * 100, 1)

            zero_coverage_count = sum(
                1 for c in scored
                if c.get("coverage_pct", 0) == 0 and not c.get("backbone_blocked")
            )

            # Greedy set-cover to select the best combination
            yield sse({"type": "status",
                       "message": "Selecting optimal location combination…"})
            # If existing receivers already meet the user's target, still run greedy
            # trying to reach 100% so sites are suggested for the remaining gap.
            effective_target = (
                100.0
                if total_pts and len(pre_covered) / total_pts * 100 >= target_cov_pct
                else target_cov_pct
            )
            selected = greedy_set_cover(
                scored, total_pts, max_locations, effective_target,
                pre_covered=pre_covered,
                min_contribution_pct=min_contribution_pct,
            )

            # ── Phase 6: Local refinement ────────────────────────────────────
            # For each greedy-selected site, score a fine grid of micro-
            # candidates within REFINE_RADIUS_M at REFINE_STEP_M resolution
            # using the full RF model.  If any neighbour outperforms the
            # selected site on individual coverage_pct, replace the lat/lon.
            # This catches small positional improvements (50–150 m shifts)
            # missed by the coarser initial sweep.
            if selected:
                yield sse({"type": "status",
                           "message": f"Refining {len(selected)} selected site position(s)…"})
                _refine_args  = []
                _refine_meta  = {}   # abs_idx → selected list index
                _refine_base  = len(candidates)  # offset so idx doesn't clash

                for sel_i, site in enumerate(selected):
                    clat, clon  = site["lat"], site["lon"]
                    cos_lat     = math.cos(math.radians(clat))
                    m_per_dlat  = 111_000.0
                    m_per_dlon  = 111_000.0 * max(cos_lat, 0.001)
                    n_steps     = max(1, int(REFINE_RADIUS_M / REFINE_STEP_M))
                    for di in range(-n_steps, n_steps + 1):
                        for dj in range(-n_steps, n_steps + 1):
                            off_m = math.sqrt((di * REFINE_STEP_M)**2
                                              + (dj * REFINE_STEP_M)**2)
                            if off_m > REFINE_RADIUS_M or off_m < 1.0:
                                continue
                            rlat  = clat + (di * REFINE_STEP_M) / m_per_dlat
                            rlon  = clon + (dj * REFINE_STEP_M) / m_per_dlon
                            if _local_slope_deg(rlat, rlon) > MAX_SITE_SLOPE_DEG:
                                continue
                            if _excl_polygons and point_in_exclusion_zone(
                                rlat, rlon, _excl_polygons, _excl_grid, _excl_cell_deg
                            ):
                                continue
                            ridx  = len(_refine_args) + _refine_base
                            _refine_args.append((
                                ridx, rlat, rlon, antenna_height_m,
                                track_pts, freq_mhz, tx_power_dbm,
                                tx_gain_dbi + WIDE_APRS_RX_GAIN_DBI,
                                sensitivity_dbm, veg_type, fade_margin_db,
                                backbone_pts, max_practical_range_m,
                            ))
                            _refine_meta[ridx] = sel_i

                if _refine_args:
                    _refine_pool    = _get_advisor_pool()
                    _refine_futures = {_refine_pool.submit(score_candidate, a): a[0]
                                       for a in _refine_args}
                    _refine_pending = set(_refine_futures.keys())
                    _refine_best    = {i: site.get("coverage_pct", 0.0)
                                       for i, site in enumerate(selected)}
                    _refine_winner  = {}   # sel_i → best result dict
                    _refine_total   = len(_refine_args)
                    _refine_done_n  = 0
                    yield sse({"type": "refine_progress",
                               "current": 0, "total": _refine_total,
                               "message": f"Refining {len(selected)} site(s): 0/{_refine_total}…"})

                    while _refine_pending:
                        _rdone, _refine_pending = cf_wait(_refine_pending, timeout=8)
                        if not _rdone:
                            yield sse({"type": "refine_progress",
                                       "current": _refine_done_n, "total": _refine_total,
                                       "message": f"Refining positions… {_refine_done_n}/{_refine_total}"})
                            continue
                        for rfut in _rdone:
                            try:
                                rres = rfut.result()
                                if rres.get("backbone_blocked"):
                                    _refine_done_n += 1
                                    continue
                                sel_i = _refine_meta.get(rres["cand_idx"])
                                if sel_i is None:
                                    _refine_done_n += 1
                                    continue
                                if rres["coverage_pct"] > _refine_best[sel_i]:
                                    _refine_best[sel_i]  = rres["coverage_pct"]
                                    _refine_winner[sel_i] = rres
                            except Exception as rexc:
                                app.logger.warning("refine_candidate failed: %s", rexc)
                            _refine_done_n += 1
                        yield sse({"type": "refine_progress",
                                   "current": _refine_done_n, "total": _refine_total,
                                   "message": f"Refining positions… {_refine_done_n}/{_refine_total}"})

                    for sel_i, rres in _refine_winner.items():
                        site = selected[sel_i]
                        site["original_lat"] = site["lat"]
                        site["original_lon"] = site["lon"]
                        site["lat"]          = rres["lat"]
                        site["lon"]          = rres["lon"]
                        site["coverage_pct"] = rres["coverage_pct"]
                        site["refined"]      = True

            for loc in selected:
                yield sse({"type": "suggestion", **loc})

            final_pct    = selected[-1]["cumulative_pct"] if selected else \
                           round(len(pre_covered) / total_pts * 100, 1)
            existing_pct = round(len(pre_covered) / total_pts * 100, 1)
            yield sse({
                "type":                    "complete",
                "selected_count":          len(selected),
                "total_candidates":        len(scored),
                "final_coverage_pct":      final_pct,
                "existing_coverage_pct":   existing_pct,
                "target_coverage_pct":     target_cov_pct,
                "backbone_blocked_count":  backbone_blocked_count,
                "zero_coverage_count":     zero_coverage_count,
                "best_marginal_pct":       best_marginal_pct,
                "min_contribution_pct":    min_contribution_pct,
                "locations":               selected,
            })

        except GeneratorExit:
            _stop_flag[0] = True
        except BaseException as exc:
            _stop_flag[0] = True
            import traceback
            app.logger.exception("Advisor SSE generator crashed: %r", exc)
            try:
                yield sse({"type": "error", "message": f"{exc!r}\n{traceback.format_exc()}"})
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# Route – Single-location RF tester (SSE, parallelised across all CPUs)
# ---------------------------------------------------------------------------

@app.route("/api/test-location", methods=["POST"])
def test_location():
    data            = request.get_json()
    lat             = float(data["lat"])
    lon             = float(data["lon"])
    height_agl      = float(data.get("height_agl_m",      4))
    kml_file        = data.get("kml_file")
    freq_mhz        = float(data.get("freq_mhz",        915))
    tx_power_dbm    = float(data.get("tx_power_dbm",     22))
    tx_gain_dbi     = float(data.get("tx_gain_dbi",       0))
    sensitivity_dbm = float(data.get("sensitivity_dbm", -135))
    veg_type        = data.get("veg_type",             "none")
    fade_margin_db  = float(data.get("fade_margin_db",    0))

    if not kml_file:
        return jsonify({"error": "kml_file required"}), 400
    kml_p = KML_DIR / secure_filename(kml_file)
    if not kml_p.exists():
        return jsonify({"error": "Track file not found"}), 404

    try:
        waypoints = parse_track_file(
            kml_p.read_text(encoding="utf-8", errors="replace"), kml_p.name
        )
    except Exception as exc:
        return jsonify({"error": f"Parse error: {exc}"}), 400
    if not waypoints:
        return jsonify({"error": "No track coordinates found"}), 400

    track_pts = interpolate_path(waypoints, max_pts=300)
    total     = len(track_pts)

    # Represent the test site as a single-element receiver list so _point_task
    # can be reused directly — one future per track point, all CPUs engaged.
    test_rx = [{
        "latitude":         lat,
        "longitude":        lon,
        "height_agl_m":     height_agl,
        "antenna_gain_dbi": 0,
        "enabled":          "1",
    }]

    def generate():
        try:
            yield sse({"type": "status", "message": f"Analyzing {total} track points…"})

            pool    = _get_analysis_pool()
            fmap    = {
                pool.submit(_point_task, (
                    i, _rc(float(pt[0])), _rc(float(pt[1])), test_rx,
                    freq_mhz, tx_power_dbm, tx_gain_dbi,
                    sensitivity_dbm, veg_type, fade_margin_db,
                    False, frozenset(),
                )): i
                for i, pt in enumerate(track_pts)
            }
            pending = set(fmap)
            results = {}
            done_n  = 0

            while pending:
                just_done, pending = cf_wait(pending, timeout=8)
                if not just_done:
                    yield sse({"type": "status",
                               "message": f"Testing… {done_n}/{total}"})
                    continue
                for f in just_done:
                    try:
                        r = f.result()
                        results[r["idx"]] = r
                    except Exception as exc:
                        app.logger.warning("test_loc point failed: %s", exc)
                    done_n += 1
                yield sse({"type": "status",
                           "message": f"Testing… {done_n}/{total}"})

            covered_set  = {idx for idx, r in results.items() if r.get("coverage")}
            coverage_pct = round(len(covered_set) / total * 100, 1) if total else 0.0

            longest_gap_m = 0.0
            current_gap_m = 0.0
            last_uncov    = None
            for i, pt in enumerate(track_pts):
                if i not in covered_set:
                    if last_uncov is not None:
                        current_gap_m += haversine(last_uncov[0], last_uncov[1], pt[0], pt[1])
                        longest_gap_m  = max(longest_gap_m, current_gap_m)
                    last_uncov = pt
                else:
                    current_gap_m = 0.0
                    last_uncov    = None

            yield sse({
                "type":            "complete",
                "coverage_pct":    coverage_pct,
                "covered_indices": sorted(covered_set),
                "track_pts":       [[round(p[0], 5), round(p[1], 5)] for p in track_pts],
                "longest_gap_km":  round(longest_gap_m / 1000, 1),
            })

        except GeneratorExit:
            pass
        except BaseException as exc:
            import traceback
            app.logger.exception("test-location SSE crashed: %r", exc)
            try:
                yield sse({"type": "error",
                           "message": f"{exc!r}\n{traceback.format_exc()}"})
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Link coverage map — radio horizon from a single test point
# ---------------------------------------------------------------------------

def _make_circle_grid(
    center_lat: float, center_lon: float,
    radius_m: float, spacing_m: float,
) -> list[tuple[float, float]]:
    """Return lat/lon points on a uniform rectangular grid inside a circle."""
    lat_step = spacing_m / 111_320.0
    lon_step = spacing_m / (111_320.0 * math.cos(math.radians(center_lat)))
    n = int(radius_m / spacing_m) + 1
    pts: list[tuple[float, float]] = []
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            lat = center_lat + i * lat_step
            lon = center_lon + j * lon_step
            d   = haversine(center_lat, center_lon, lat, lon)
            if 50.0 <= d <= radius_m:
                pts.append((_rc(lat), _rc(lon)))
    return pts


def _make_rect_grid(
    sw_lat: float, sw_lon: float,
    ne_lat: float, ne_lon: float,
    spacing_m: float,
) -> list[tuple[float, float]]:
    """Return lat/lon points on a uniform rectangular grid inside the given bounds."""
    mid_lat  = (sw_lat + ne_lat) / 2.0
    lat_step = spacing_m / 111_320.0
    lon_step = spacing_m / (111_320.0 * max(1e-6, math.cos(math.radians(mid_lat))))
    pts: list[tuple[float, float]] = []
    lat = sw_lat
    while lat <= ne_lat:
        lon = sw_lon
        while lon <= ne_lon:
            pts.append((_rc(lat), _rc(lon)))
            lon += lon_step
        lat += lat_step
    return pts


@app.route("/api/link-coverage", methods=["POST"])
def link_coverage():
    data             = request.get_json(force=True)
    lat              = float(data["lat"])
    lon              = float(data["lon"])
    height_agl_m     = float(data.get("height_agl_m",      4))
    grid_agl_m       = float(data.get("grid_agl_m",        4))
    radius_m         = float(data.get("radius_m",      10_000))
    freq_mhz         = float(data.get("freq_mhz",        915))
    tx_power_dbm     = float(data.get("tx_power_dbm",     22))
    tx_gain_dbi      = float(data.get("tx_gain_dbi",       0))
    sensitivity_dbm  = float(data.get("sensitivity_dbm", -135))
    veg_type         = data.get("veg_type",              "none")
    fade_margin_db   = float(data.get("fade_margin_db",    0))

    # Auto-size spacing to keep grid ≈ 3 000–5 000 cells
    if "spacing_m" in data:
        spacing_m = float(data["spacing_m"])
    elif radius_m <= 6_000:
        spacing_m = 150.0
    elif radius_m <= 12_000:
        spacing_m = 250.0
    else:
        spacing_m = 500.0

    def generate():
        try:
            yield sse({"type": "status", "message": "Generating grid…"})
            grid_pts = _make_circle_grid(lat, lon, radius_m, spacing_m)
            total    = len(grid_pts)
            test_elev_m = _get_elev(_rc(lat), _rc(lon)) + height_agl_m

            yield sse({"type": "status", "message": f"Analyzing {total} grid cells…"})

            pool      = _get_analysis_pool()
            args_list = [
                (gi,
                 lat, lon, test_elev_m,
                 glat, glon, grid_agl_m,
                 freq_mhz, tx_power_dbm, tx_gain_dbi,
                 sensitivity_dbm, veg_type, fade_margin_db)
                for gi, (glat, glon) in enumerate(grid_pts)
            ]

            _fmap    = {}
            for _a in args_list:
                try:
                    _fmap[pool.submit(_grid_link_task, _a)] = _a[0]
                except Exception as _se:
                    app.logger.warning("grid_link submit failed: %s", _se)
            _pending = set(_fmap)
            batch: list  = []
            done_n       = 0
            viable_ct    = 0
            FLUSH        = 200

            while _pending:
                _done, _pending = cf_wait(_pending, timeout=8)
                if not _done:
                    yield sse({"type": "status",
                               "message": f"Analyzing grid… {done_n}/{total}"})
                    continue
                for _f in _done:
                    try:
                        cell = _f.result()
                        batch.append(cell)
                        if cell.get("viable"):
                            viable_ct += 1
                    except Exception as _fe:
                        app.logger.warning("grid_link_task failed: %s", _fe)
                    done_n += 1
                    if len(batch) >= FLUSH:
                        yield sse({"type": "link_grid_batch", "cells": batch,
                                   "done": done_n, "total": total})
                        batch = []

            if batch:
                yield sse({"type": "link_grid_batch", "cells": batch,
                           "done": done_n, "total": total})

            yield sse({"type": "complete",
                       "total": total, "viable": viable_ct,
                       "radius_m": radius_m})

        except GeneratorExit:
            pass
        except BaseException as exc:
            import traceback
            app.logger.exception("link-coverage SSE crashed: %r", exc)
            try:
                yield sse({"type": "error",
                           "message": f"{exc!r}\n{traceback.format_exc()}"})
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------------------
# Area coverage heat map — network coverage across the visible viewport,
# independent of any loaded track/roads/trails. Every grid cell is scored
# against ALL enabled receivers (reusing _point_task) and the best result
# wins, same as the per-track-point analysis in /api/analyze.
# ---------------------------------------------------------------------------

# Base grid spacing per resolution tier, further coarsened if the estimated
# work (cells × enabled receivers) exceeds AREA_COVERAGE_WORK_BUDGET — each
# cell costs one terrain profile per receiver, so cost scales with both.
AREA_COVERAGE_RESOLUTION_M: dict[str, float] = {
    "fast":     400.0,
    "balanced": 200.0,
    "detailed": 100.0,
}
AREA_COVERAGE_WORK_BUDGET = 40_000   # target cells × enabled-receiver-count
AREA_COVERAGE_MAX_SPAN_M  = 60_000.0  # reject viewports wider/taller than this


@app.route("/api/area-coverage", methods=["POST"])
def area_coverage():
    data            = request.get_json(force=True)
    sw_lat          = float(data["sw_lat"])
    sw_lon          = float(data["sw_lon"])
    ne_lat          = float(data["ne_lat"])
    ne_lon          = float(data["ne_lon"])
    resolution      = data.get("resolution", "balanced")
    freq_mhz        = float(data.get("freq_mhz",         915))
    tx_power_dbm    = float(data.get("tx_power_dbm",      22))
    tx_gain_dbi     = float(data.get("tx_gain_dbi",        0))
    sensitivity_dbm = float(data.get("sensitivity_dbm", -135))
    veg_type        = data.get("veg_type",              "none")
    fade_margin_db  = float(data.get("fade_margin_db",     0))
    chain_mode      = bool(data.get("chain_mode", False))
    body_receivers  = data.get("receivers")   # list[dict] | None — live UI state

    width_m  = haversine(sw_lat, sw_lon, sw_lat, ne_lon)
    height_m = haversine(sw_lat, sw_lon, ne_lat, sw_lon)

    def generate():
        try:
            if not body_receivers:
                yield sse({"type": "error", "message": "No receivers loaded"}); return
            receivers = body_receivers
            if not any(str(rx.get("enabled", "1")).strip() != "0" for rx in receivers):
                yield sse({"type": "error",
                           "message": "All receivers are disabled — enable at least one in the CSV editor"})
                return

            if max(width_m, height_m) > AREA_COVERAGE_MAX_SPAN_M:
                yield sse({"type": "error",
                           "message": f"Visible area is too large "
                                      f"({max(width_m, height_m) / 1000:.0f} km across) — "
                                      f"zoom in further and try again"})
                return

            enabled_ct = sum(1 for rx in receivers if str(rx.get("enabled", "1")).strip() != "0")

            spacing_m = AREA_COVERAGE_RESOLUTION_M.get(resolution, 200.0)

            def _cell_estimate(sp: float) -> int:
                return (max(1, int(width_m / sp) + 1)) * (max(1, int(height_m / sp) + 1))

            while _cell_estimate(spacing_m) * enabled_ct > AREA_COVERAGE_WORK_BUDGET and spacing_m < 2000.0:
                spacing_m *= 1.5

            yield sse({"type": "status", "message": "Prefetching terrain tiles…"})
            _prog = [0, 1]

            def _tile_cb(done, total):
                _prog[0], _prog[1] = done, max(1, total)

            tile_thread = threading.Thread(
                target=lambda: _tiles.prefetch_area(sw_lat, ne_lat, sw_lon, ne_lon, _tile_cb),
                daemon=True,
            )
            tile_thread.start()
            while tile_thread.is_alive():
                yield sse({"type": "elev_progress",
                           "current": _prog[0], "total": _prog[1],
                           "message": f"Tile {_prog[0]}/{_prog[1]} cached…"})
                time.sleep(0.6)
            tile_thread.join()

            pool = _get_analysis_pool()

            # ---- Chain-mode backbone check (shared with /api/analyze) ----
            viable_w1_idxs: frozenset[int] = frozenset()
            if chain_mode:
                _lgen = _run_link_analysis(
                    receivers, freq_mhz, sensitivity_dbm, fade_margin_db, veg_type,
                    chain_mode, False, pool,
                )
                try:
                    while True:
                        yield sse(next(_lgen))
                except StopIteration as _lsi:
                    _, viable_w1_idxs = _lsi.value

            grid_pts = _make_rect_grid(sw_lat, sw_lon, ne_lat, ne_lon, spacing_m)
            total    = len(grid_pts)
            yield sse({"type": "status",
                       "message": f"Analyzing {total} cells × {enabled_ct} receiver(s) "
                                  f"(spacing ≈ {spacing_m:.0f} m)…"})

            args_list = [
                (gi, glat, glon, receivers,
                 freq_mhz, tx_power_dbm, tx_gain_dbi,
                 sensitivity_dbm, veg_type, fade_margin_db,
                 chain_mode, viable_w1_idxs)
                for gi, (glat, glon) in enumerate(grid_pts)
            ]
            _fmap: dict = {}
            for _a in args_list:
                try:
                    _fmap[pool.submit(_point_task, _a)] = _a[0]
                except Exception as _se:
                    app.logger.warning("area cell submit failed: %s", _se)
            _pending   = set(_fmap)
            batch: list = []
            done_n     = 0
            covered_ct = 0
            FLUSH      = 200

            while _pending:
                _done, _pending = cf_wait(_pending, timeout=8)
                if not _done:
                    yield sse({"type": "status", "message": f"Analyzing area… {done_n}/{total} cells"})
                    continue
                for _f in _done:
                    try:
                        cell = _f.result()
                        if cell["coverage"]:
                            covered_ct += 1
                        batch.append({
                            "gi":          cell["idx"],
                            "lat":         cell["lat"],
                            "lon":         cell["lon"],
                            "coverage":    cell["coverage"],
                            "hard_fail":   cell["hard_fail"],
                            "best_rx_idx": cell["best_rx_idx"],
                            "best_rssi":   cell["best_rssi"],
                        })
                    except Exception as _fe:
                        app.logger.warning("area cell task failed: %s", _fe)
                    done_n += 1
                    if len(batch) >= FLUSH:
                        yield sse({"type": "area_batch", "cells": batch, "done": done_n, "total": total})
                        batch = []

            if batch:
                yield sse({"type": "area_batch", "cells": batch, "done": done_n, "total": total})

            yield sse({"type": "complete",
                       "total": total, "covered": covered_ct, "spacing_m": spacing_m})

        except GeneratorExit:
            pass
        except BaseException as exc:
            import traceback
            app.logger.exception("area-coverage SSE crashed: %r", exc)
            try:
                yield sse({"type": "error",
                           "message": f"{exc!r}\n{traceback.format_exc()}"})
            except Exception:
                pass

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
