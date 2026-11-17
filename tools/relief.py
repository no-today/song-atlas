#!/usr/bin/env python3
"""宋代疆域图：离线 DEM → 页面坐标的分层设色与多光源晕渲小样。

Setup:
  python3 -m venv .cache/venv
  .cache/venv/bin/python -m pip install -r tools/relief-requirements.txt
Sample (full resolution unless --suite):
  .cache/venv/bin/python tools/relief.py sample --bbox 102,28,112,36 \
      --scale 16 --palette A --out /path/sample-A.jpg --suite
--suite saves an overview <=2400 px, two 1600×1000 native crops, an orange
30% tint crop, old-image comparisons, vector alignment evidence and JSON metrics.
The bbox is geographic, so its projected footprint has curved edges; the tiny
areas outside it in the rectangular image are paper, not invented DEM coverage.

Sources: Copernicus DEM GLO-90 COGs (DSM, ~90 m, WGS84 / EGM2008 heights).
https://copernicus-dem-90m.s3.amazonaws.com/readme.html
Licence: Copernicus DEM Licence (free use/adaptation, attribution required).
Derivative attribution: “produced using Copernicus WorldDEM-90 © DLR e.V.
2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under
COPERNICUS by the European Union and ESA; all rights reserved”. This renderer changes the original data by resampling,
colouring and hillshading it. It does not render bathymetry.
Coarse source outside the battle area: NOAA ETOPO 2022
60 arc-second surface GeoTIFF, CC0-1.0; cite doi:10.25921/fd45-gt74.
https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
Only public Copernicus/NOAA endpoints are used. No GDAL CLI is required.
Full output (cache and tiles may live in the durable main checkout):
  .cache/venv/bin/python tools/relief.py tiles --palette D --quality 90 \
      --cache /path/to/main/.cache/dem --out /path/to/main/tiles \
      --embed assets/relief.jpg --shots /path/to/shots
512px tiles use {z}/{x}_{y}.jpg; parameters are fingerprinted inside each JPEG.
Existing matching tiles are skipped, including after an interrupted run; --force
re-renders them. Blocks have physical halos for seamless local enhancement.
GLO-90 and ETOPO blend through a smoothstep ramp 0.75° inside the battle bbox.
"""
from __future__ import annotations

import colorsys
import argparse
from contextlib import ExitStack
import shutil
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import inspect
import json
import math
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import rasterio
from rasterio import Affine
from rasterio.features import rasterize
from rasterio.io import MemoryFile
from rasterio.warp import reproject, Resampling, transform as crs_transform
from scipy.ndimage import binary_dilation, gaussian_filter, distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache' / 'dem'
BUCKET = 'https://copernicus-dem-90m.s3.amazonaws.com/'
RADIUS = 6371000.0  # cancels with the affine; geo.mjs uses a unit sphere
WATER = '#b3c2ba'
PAPER = '#eee5d0'
LEVELS = [0, 300, 600, 1000, 2000, 3500, 5000, 6500]
PALETTES = {
    'A': ['#eee3c6', '#ece0c0', '#e7d7b5', '#ddc9a8', '#cbb18f', '#b8a18a', '#d6cbbb', '#eee8df'],
    'B': ['#dbe2cf', '#c7d5bb', '#c8d0af', '#ddd3b0', '#c9b58f', '#afa28f', '#ddd8cc', '#f0ece4'],
    'C': ['#f5ecd6', '#eee4cc', '#d9cfb4', '#c3b697', '#a4977e', '#a09989', '#d2cdc3', '#eeeae2'],
}
# D: desaturate B's 0–600 m colours by 1/3, then mix 25% warm paper.
_low = []
for _colour in PALETTES['B'][:3]:
    _r, _g, _b = [int(_colour[i:i+2], 16)/255 for i in (1, 3, 5)]
    _h, _s, _v = colorsys.rgb_to_hsv(_r, _g, _b)
    _muted = colorsys.hsv_to_rgb(_h, _s*2/3, _v)
    _paper = (238/255, 229/255, 208/255)
    _low.append('#'+''.join(f'{round(255*(.75*a+.25*b)):02x}' for a, b in zip(_muted, _paper)))
PALETTES['D'] = _low + ['#ddd3b0', '#c9b58f', '#b6a07f', '#c4ad88', '#e2d8c6']
D = {'strength': 1.05, 'local_sigma_m': 2400, 'gain_max': 4.0,
     'std_floor_m': 5, 'std_gate_m': 25, 'std_decay_m': 85,
     'relative_amount': .08, 'relative_floor_m': 18,
     'shade_min': .65, 'shade_max': 1.10}
BATTLE = (98, 20, 123, 42)
FEATHER_DEGREES = .75  # ~60–83 km: avoid a visible fine/coarse texture boundary
ETOPO_URL = 'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif'
ATTRIBUTION = ('produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 '
               'provided under COPERNICUS by the European Union and ESA; all rights reserved. '
               'NOAA NCEI ETOPO 2022, doi:10.25921/fd45-gt74, CC0-1.0. '
               'Resampled, blended, coloured and hillshaded.')
ALIASES = {'paper': 'A', 'green': 'B', 'contrast': 'C'}
CROPS = {'diaoyu': (106.3, 30.0), 'qinling': (107.5, 33.6)}


def rgb(value):
    return tuple(bytes.fromhex(value.lstrip('#')))


class Projection:
    """Read geo.mjs, never maintain a second independent set of constants."""
    def __init__(self):
        source = (ROOT / 'tools/geo.mjs').read_text()
        self.source_hash = hashlib.sha256(source.encode()).hexdigest()
        for key in ('AX', 'BX', 'AY', 'BY', 'P1', 'P2', 'L0'):
            pattern = rf'\b{key}=(-?[\d.]+)' + (r'\*R' if key in ('P1', 'P2', 'L0') else r'(?=[,;])')
            match = re.search(pattern, source)
            if not match:
                raise ValueError(f'geo.mjs constant {key} changed format; update parser')
            setattr(self, key, float(match[1]))
        p1, p2 = np.radians([self.P1, self.P2])
        self.n = math.log(math.cos(p1) / math.cos(p2)) / math.log(math.tan(math.pi/4+p2/2) / math.tan(math.pi/4+p1/2))
        self.f = math.cos(p1) * math.tan(math.pi/4+p1/2)**self.n / self.n
        self.crs = rasterio.crs.CRS.from_string(
            f'+proj=lcc +lat_1={self.P1} +lat_2={self.P2} +lat_0=90 '
            f'+lon_0={self.L0} +R={RADIUS} +units=m +no_defs')

    def proj(self, lon, lat):
        rho = self.f / np.tan(np.pi/4 + np.radians(lat)/2)**self.n
        theta = self.n * np.radians(np.asarray(lon) - self.L0)
        return self.AX*rho*np.sin(theta)+self.BX, -self.AY*rho*np.cos(theta)+self.BY

    def unproj(self, x, y):
        u, v = (np.asarray(x)-self.BX)/self.AX, (np.asarray(y)-self.BY)/self.AY
        rho, theta = np.hypot(u, v), np.arctan2(u, -v)
        return np.degrees(theta/self.n)+self.L0, np.degrees(2*np.arctan((self.f/rho)**(1/self.n))-np.pi/2)

    def affine(self, x, y, scale):
        return Affine(RADIUS/self.AX/scale, 0, (x-self.BX)*RADIUS/self.AX,
                      0, RADIUS/self.AY/scale, (y-self.BY)*RADIUS/self.AY)


def rings(path):
    """base.json has only absolute M/L/Z paths; fail on other commands."""
    if re.search(r'[A-Za-z]', re.sub(r'[MLZ]', '', path)):
        raise ValueError('Unsupported SVG path command')
    return [np.asarray([[float(v) for v in point.split(',')] for point in part.strip('LZ').split('L')])
            for part in re.split(r'[MZ]', path) if part.strip()]


def bbox_values(value):
    try:
        west, south, east, north = map(float, value.split(','))
        if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
            raise ValueError()
        return west, south, east, north
    except ValueError:
        raise argparse.ArgumentTypeError('bbox must be west,south,east,north, in degrees')


def tile_name(lon, lat):
    return f'Copernicus_DSM_COG_30_{"N" if lat >= 0 else "S"}{abs(lat):02d}_00_{"E" if lon >= 0 else "W"}{abs(lon):03d}_00_DEM'


def download(name, url=None):
    """Range resume, validate length/ETag, atomic rename; no personal headers."""
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / (name+'.tif')
    part = target.with_suffix('.tif.part')
    url = url or BUCKET + name + '/' + name + '.tif'
    expected_epsg = (4326, 9518) if url == ETOPO_URL else (4326,)
    if target.exists():
        with rasterio.open(target) as ds:
            if ds.count != 1 or ds.crs.to_epsg() not in expected_epsg:
                raise ValueError(f'Unexpected cached raster: {target}')
        return target, 0, 'cached'
    transferred = 0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=45) as response:
                length = int(response.headers['Content-Length'])
                etag = response.headers.get('ETag', '')
            meta_path = part.with_suffix('.part.json')
            meta = {'length': length, 'etag': etag}
            if part.exists() and (not meta_path.exists() or json.loads(meta_path.read_text()) != meta or part.stat().st_size > length):
                part.unlink()
            meta_path.write_text(json.dumps(meta))
            offset = part.stat().st_size if part.exists() else 0
            if offset < length:
                headers = {'Range': f'bytes={offset}-', 'If-Range': etag} if offset else {}
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
                    if offset and response.status == 206:
                        expected = f'bytes {offset}-{length-1}/{length}'
                        if response.headers.get('Content-Range') != expected:
                            raise ValueError('Unexpected resume Content-Range')
                    elif offset and response.status == 200:
                        offset = 0  # server ignored Range / entity changed: restart safely
                    elif response.status != 200:
                        raise ValueError(f'Unexpected download status: {response.status}')
                    with part.open('ab' if offset else 'wb') as output:
                        while chunk := response.read(1024*1024):
                            output.write(chunk)
                            transferred += len(chunk)
            if part.stat().st_size != length:
                raise OSError('Incomplete download; resume on next attempt')
            # Single-part S3 ETag is a content checksum, not just a length check.
            if re.fullmatch(r'"[a-f0-9]{32}"', etag):
                with part.open('rb') as content:
                    digest = hashlib.file_digest(content, 'md5').hexdigest()
                if digest != etag.strip('"'):
                    part.unlink()
                    raise OSError('ETag checksum mismatch')
            with rasterio.open(part) as ds:
                if ds.count != 1 or ds.crs.to_epsg() not in expected_epsg:
                    raise ValueError(f'Unexpected downloaded raster: {part}')
                ds.read(1, out_shape=(8, 8))
            part.replace(target)
            meta_path.unlink(missing_ok=True)
            return target, transferred, 'downloaded'
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                if attempt == 3:
                    raise
            elif attempt == 3:
                raise
        except (OSError, ValueError):
            if attempt == 3:
                raise
        time.sleep(attempt+1)
    raise RuntimeError('Unreachable download retry state')


def fetch_tiles(bbox, workers):
    CACHE.mkdir(parents=True, exist_ok=True)
    catalog_path = CACHE/'glo90-tile-list.txt'
    if not catalog_path.exists():
        with urllib.request.urlopen(BUCKET+'tileList.txt', timeout=45) as response:
            listing = response.read().decode()
        if 'Copernicus_DSM_COG_30_' not in listing:
            raise ValueError('Unexpected Copernicus tile catalog')
        catalog_path.write_text(listing)
    available = {line.strip().rstrip('/') for line in catalog_path.read_text().splitlines()}
    west, south, east, north = bbox
    names = [tile_name(lon, lat) for lat in range(math.floor(south), math.ceil(north))
             for lon in range(math.floor(west), math.ceil(east))]
    absent = [name for name in names if name not in available]
    names = [name for name in names if name in available]
    paths, counts, byte_count = [], {'catalog_ocean_cells': len(absent)}, 0
    failures = {}
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download, name): name for name in names}
        for i, future in enumerate(as_completed(futures), 1):
            try:
                path, size, status = future.result()
            except Exception as exc:
                failures[futures[future]] = str(exc)
                print(f'DEM FAILED {futures[future]}: {exc}', flush=True)
                continue
            if path:
                paths.append(path)
            counts[status] = counts.get(status, 0)+1
            byte_count += size
            if i % 10 == 0 or i == len(names):
                print(f'DEM {i}/{len(names)}; downloaded {byte_count/1e6:.1f} MB', flush=True)
    if failures:
        (CACHE/'download-failures.json').write_text(json.dumps(failures, indent=2)+'\n')
        raise RuntimeError(f'{len(failures)} DEM downloads failed; see {CACHE}/download-failures.json')
    (CACHE/'download-failures.json').unlink(missing_ok=True)
    if not paths:
        raise ValueError('No DEM tiles: cannot render this sample')
    return sorted(paths), {'tiles': counts, 'download_bytes': byte_count,
                           'cached_source_bytes': sum(p.stat().st_size for p in paths),
                           'download_seconds': time.monotonic()-start}


def mosaic_vrt(paths):
    """A virtual mosaic before warping avoids seams from independent tile warps.

    Respect original COG pixel origins (including their half-pixel offset).
    This sample implementation requires the uniform 3-arcsecond grid <=50°N/S.
    """
    records = []
    for path in paths:
        with rasterio.open(path) as ds:
            records.append((path, ds.width, ds.height, ds.transform, ds.bounds))
    resolution = records[0][3].a
    if any(abs(row[3].a-resolution) > 1e-10 or abs(row[3].e+resolution) > 1e-10 for row in records):
        raise ValueError('Sample mosaic requires uniform GLO-90 pixels (within 50° latitude)')
    left = min(row[4].left for row in records)
    top = max(row[4].top for row in records)
    right = max(row[4].right for row in records)
    bottom = min(row[4].bottom for row in records)
    width, height = round((right-left)/resolution), round((top-bottom)/resolution)
    sources = []
    for path, w, h, _, bounds in records:
        x, y = round((bounds.left-left)/resolution), round((top-bounds.top)/resolution)
        sources.append(f'<SimpleSource><SourceFilename relativeToVRT="0">{escape(str(path))}</SourceFilename>'
                       f'<SourceBand>1</SourceBand><SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}"/>'
                       f'<DstRect xOff="{x}" yOff="{y}" xSize="{w}" ySize="{h}"/></SimpleSource>')
    return (f'<VRTDataset rasterXSize="{width}" rasterYSize="{height}"><SRS>EPSG:4326</SRS>'
            f'<GeoTransform>{left},{resolution},0,{top},0,{-resolution}</GeoTransform>'
            '<VRTRasterBand dataType="Float32" band="1"><NoDataValue>-32767</NoDataValue>'
            + ''.join(sources) + '</VRTRasterBand></VRTDataset>').encode()


def projected_grid(proj, bbox, scale):
    west, south, east, north = bbox
    # Sample edges, not just corners: parallels curve in this projection.
    lon = np.linspace(west, east, 1001)
    lat = np.linspace(south, north, 1001)
    x, y = proj.proj(np.r_[lon, lon, np.full(1001, west), np.full(1001, east)],
                     np.r_[np.full(1001, south), np.full(1001, north), lat, lat])
    x0, y0 = math.floor(x.min()*scale)/scale, math.floor(y.min()*scale)/scale
    width = math.ceil((x.max()-x0)*scale)
    height = math.ceil((y.max()-y0)*scale)
    return x0, y0, width, height


def water_mask(base, x0, y0, scale, shape):
    # Match the exact page coast/lake geometry, with no bathymetric shading.
    affine = Affine(1/scale, 0, x0, 0, 1/scale, y0)
    land = rasterize([({'type': 'Polygon', 'coordinates': [ring.tolist()]}, 1)
                      for ring in rings(base['land'])], out_shape=shape, transform=affine, dtype='uint8')
    lakes = rasterize([({'type': 'Polygon', 'coordinates': [ring.tolist()]}, 1)
                       for ring in rings(base['lakes'])], out_shape=shape, transform=affine, dtype='uint8')
    return (land == 0) | (lakes == 1)


def terrain_shade(dem, proj, affine, palette):
    gy, gx = np.gradient(dem, abs(affine.e), affine.a)
    xs = (affine.c+(np.arange(dem.shape[1])+.5)*affine.a)/RADIUS*proj.AX+proj.BX
    ys = (affine.f+(np.arange(dem.shape[0])+.5)*affine.e)/RADIUS*proj.AY+proj.BY
    # Exact per-pixel scale: independent blocks/resume windows must shade identically.
    factor = np.empty_like(dem)
    for row in range(0, dem.shape[0], 128):
        _, lat = proj.unproj(xs[None, :], ys[row:row+128, None])
        rho = proj.f/np.tan(np.pi/4+np.radians(lat)/2)**proj.n
        factor[row:row+128] = proj.n*rho/np.cos(np.radians(lat))
    gx *= factor
    gy *= factor
    relative = 0
    if palette == 'D':
        sigma = max(.65, D['local_sigma_m']/affine.a)
        local = gaussian_filter(dem, sigma)
        variance = np.maximum(0, gaussian_filter(dem*dem, sigma)-local*local)
        std = np.sqrt(variance)
        gate = np.clip((std-D['std_floor_m'])/(D['std_gate_m']-D['std_floor_m']), 0, 1)
        gate = gate*gate*(3-2*gate)
        adapt = gate*(D['std_decay_m']/(std+D['std_decay_m']))**2
        gain = 1+(D['gain_max']-1)*adapt
        gx *= gain
        gy *= gain
        # Small relative-elevation component makes valley floors distinct;
        # smooth gates suppress enhancement on truly flat plains and high mountains.
        relative = D['relative_amount']*adapt*np.tanh((dem-local)/np.maximum(std, D['relative_floor_m']))
    length = np.sqrt(1+gx*gx+gy*gy)
    illumination = np.zeros_like(dem)
    flat = 0.0
    for azimuth, altitude, weight in [(315, 45, .55), (270, 50, .20), (0, 55, .15), (45, 60, .10)]:
        az, alt = np.radians([azimuth, altitude])
        illumination += weight*np.maximum(0, (-gx*np.sin(az)*np.cos(alt)+gy*np.cos(az)*np.cos(alt)+np.sin(alt))/length)
        flat += weight*np.sin(alt)
    strength = {'A': .85, 'B': .90, 'C': 1.05, 'D': D['strength']}[palette]
    lower = D['shade_min'] if palette == 'D' else (.65 if palette == 'C' else .62)
    upper = D['shade_max'] if palette == 'D' else 1.10
    return np.clip(1+strength*(illumination/flat-1)+relative, lower, upper)


def render(proj, paths, bbox, scale, palette, base):
    x0, y0, width, height = projected_grid(proj, bbox, scale)
    if width*height > 80_000_000:
        raise ValueError('sample limited to 80 million pixels; use tiles for larger output')
    # Halo keeps gradients and smoothing independent of crop boundaries.
    halo = max(8, math.ceil(4*D['local_sigma_m']/(RADIUS/proj.AX/scale))) if palette == 'D' else 8
    affine = proj.affine(x0-halo/scale, y0-halo/scale, scale)
    dem = np.full((height+2*halo, width+2*halo), np.nan, dtype='float32')
    with MemoryFile(mosaic_vrt(paths)) as memory, memory.open() as source:
        reproject(rasterio.band(source, 1), dem, src_nodata=-32767, dst_nodata=np.nan,
                  dst_transform=affine, dst_crs=proj.crs, resampling=Resampling.bilinear,
                  num_threads=4, tolerance=0, warp_mem_limit=128)
    valid = np.isfinite(dem)
    # COGs drop the shared east/south sample, so their coverage stops half a
    # native pixel short of an integer-degree bbox. Extend only that outer rim
    # by <=1 output pixel, using normalized smoothing (never fill internal gaps).
    xx = x0+(np.arange(dem.shape[1])-halo+.5)/scale
    outer_rim = np.zeros(dem.shape, dtype=bool)
    for row in range(0, dem.shape[0], 128):
        yy = y0+(np.arange(row, min(row+128, dem.shape[0]))-halo+.5)/scale
        lon, lat = proj.unproj(xx[None, :], yy[:, None])
        outer_rim[row:row+128] = (np.abs(lon-bbox[2]) <= 1/2400) | (np.abs(lat-bbox[1]) <= 1/2400)
    extended = ~valid & binary_dilation(valid) & outer_rim
    # Normalized smoothing prevents nodata at geographic edges from darkening land.
    weights = gaussian_filter(valid.astype('float32'), 0.65)
    dem = gaussian_filter(np.nan_to_num(dem), 0.65) / np.maximum(weights, 1e-6)
    shade = terrain_shade(dem, proj, affine, palette)
    valid |= extended
    core = np.s_[halo:-halo, halo:-halo]
    dem, shade, valid = dem[core], shade[core], valid[core]
    water = water_mask(base, x0, y0, scale, dem.shape)
    # Strict geographic footprint: do not fill the projected rectangle's outer wedges.
    west, south, east, north = bbox
    footprint = np.empty(dem.shape, dtype=bool)
    xx = x0+(np.arange(width)+.5)/scale
    for row in range(0, height, 128):
        yy = y0+(np.arange(row, min(row+128, height))+.5)/scale
        lon, lat = proj.unproj(xx[None, :], yy[:, None])
        footprint[row:row+128] = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
    missing = footprint & ~valid & ~water
    if missing.any():
        raise ValueError(f'{missing.sum()} inland pixels without DEM; refusing to invent terrain')
    output = np.empty((*dem.shape, 3), dtype='uint8')
    colours = np.array([rgb(c) for c in PALETTES[palette]], dtype='float32')
    for channel in range(3):
        output[:, :, channel] = np.clip(np.interp(dem, LEVELS, colours[:, channel])*shade, 0, 255).astype('uint8')
    output[water] = rgb(WATER)
    output[~footprint] = rgb(PAPER)
    metrics = {'page_bounds': [x0, y0, x0+width/scale, y0+height/scale],
               'native_pixels': [width, height], 'scale': scale,
               'metres_per_pixel_at_map_scale': affine.a,
               'missing_inland_pixels': int(missing.sum()),
               'cog_outer_half_pixel_extensions': int((extended[core] & footprint).sum())}
    return Image.fromarray(output), metrics


def validate_alignment(proj, base):
    # Compare both Python projection AND rasterio's actual warp CRS with JS.
    points = np.concatenate(rings(base['land'])+rings(base['lakes'])+
                            [r for path in base['rivers'] for r in rings(path)])
    lon, lat = proj.unproj(points[:, 0], points[:, 1])
    east, north = crs_transform('EPSG:4326', proj.crs, lon.tolist(), lat.tolist())
    x = np.asarray(east)/RADIUS*proj.AX+proj.BX
    y = np.asarray(north)/RADIUS*proj.AY+proj.BY
    warp_error = np.hypot(x-points[:, 0], y-points[:, 1]).max()
    script = "import {proj,unproj} from './tools/geo.mjs';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(p=>[proj(...p),unproj(...proj(...p))])));"
    controls = [[102, 28], [112, 36], [106.3, 30], [107.5, 33.6], [98, 20], [123, 42]]
    js = json.loads(subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                  input=json.dumps(controls), text=True, capture_output=True, check=True).stdout)
    py = np.array([proj.proj(*p) for p in controls])
    js_error = float(np.linalg.norm(py-np.array([p[0] for p in js]), axis=1).max())
    if max(warp_error, js_error) > 1:
        raise ValueError('Projection alignment exceeds one page unit')
    return {'base_vertices_checked': len(points), 'warp_max_error_page_units': float(warp_error),
            'javascript_max_error_page_units': js_error,
            'note': 'Numerical registration only; simplified/historical base rivers are not a survey of modern DEM channels.'}


def evidence_overlay(image, proj, base, metrics, crop=None, layers=('land', 'rivers', 'lakes')):
    result = image.copy()
    draw = ImageDraw.Draw(result)
    x0, y0, _, _ = metrics['page_bounds']
    scale = metrics['scale']
    ox, oy = crop or (0, 0)
    for name, colour, width in [('land', '#385e71', 2), ('rivers', '#326c85', 2), ('lakes', '#385e71', 2)]:
        if name not in layers:
            continue
        paths = base[name] if isinstance(base[name], list) else [base[name]]
        for path in paths:
            for ring in rings(path):
                coords = [((x-x0)*scale-ox, (y-y0)*scale-oy) for x, y in ring]
                if len(coords) > 1:
                    draw.line(coords + ([coords[0]] if name != 'rivers' else []), fill=colour, width=width)
    return result


def save_jpeg(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, quality=94, subsampling=0, optimize=True)


def proof_path(out, name):
    prefix = out.stem.split('sample-')[0] if 'sample-' in out.stem else ''
    return out.with_name(prefix+name)


def readability(crop, palette, out, labels):
    """Keep clean required crops; put typography/tint comparisons in a separate proof."""
    font_path = next((p for p in [Path('/System/Library/Fonts/Supplemental/Songti.ttc'),
                                 Path('/System/Library/Fonts/PingFang.ttc'),
                                 Path('/System/Library/Fonts/STHeiti Medium.ttc'),
                                 Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')]
                      if p.exists()), None)
    font = ImageFont.truetype(str(font_path), 32) if font_path else ImageFont.load_default(size=32)
    proof = Image.new('RGB', (3200, 2000))
    variants = [('原色', None), ('橙红 30%', '#c8553a'), ('灰蓝 30%', '#687d8a'), ('黄绿 30%', '#9aa85a')]
    for i, (title, colour) in enumerate(variants):
        panel = Image.blend(crop, Image.new('RGB', crop.size, colour), .30) if colour else crop.copy()
        draw = ImageDraw.Draw(panel)
        # The same dark brown as page labels, without a halo: a demanding readability check.
        draw.text((28, 24), f'{palette} · {title}' if font_path else f'{palette} / panel {i+1}', font=font, fill='#4a3a2a')
        for x, y, text in labels:
            draw.text((x+8, y+5), text if font_path else 'City', font=font, fill='#4a3a2a')
        proof.paste(panel, ((i % 2)*1600, (i//2)*1000))
    proof.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(proof, proof_path(out, f'readability-{palette}.jpg'))


def suite(image, proj, base, metrics, palette, out):
    overview = image.copy()
    overview.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(overview, out)
    aligned = evidence_overlay(image, proj, base, metrics)
    aligned.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(aligned, proof_path(out, f'alignment-{palette}.jpg'))
    x0, y0, _, _ = metrics['page_bounds']
    scale = metrics['scale']
    with Image.open(ROOT / 'assets/relief.jpg') as old:
        for name, (lon, lat) in CROPS.items():
            x, y = proj.proj(lon, lat)
            left, top = round((x-x0)*scale-800), round((y-y0)*scale-500)
            box = (left, top, left+1600, top+1000)
            if left < 0 or top < 0 or box[2] > image.width or box[3] > image.height:
                raise ValueError(f'--suite requires bbox containing {name} 1600x1000 crop')
            crop = image.crop(box)
            save_jpeg(crop, proof_path(out, f'crop-{palette}-{name}.jpg'))
            evidence = evidence_overlay(crop, proj, base, metrics, (left, top))
            save_jpeg(evidence, proof_path(out, f'alignment-{palette}-{name}.jpg'))
            if name == 'diaoyu':
                labels = []
                for label, lo, la in [('钓鱼城', 106.427, 29.990), ('重庆', 106.55, 29.56), ('华蓥山', 106.86, 30.23)]:
                    px, py = proj.proj(lo, la)
                    labels.append(((px-x0)*scale-left, (py-y0)*scale-top, label))
                readability(crop, palette, out, labels)
                tint = Image.blend(crop, Image.new('RGB', crop.size, '#c8553a'), .30)
                save_jpeg(tint, proof_path(out, f'crop-{palette}-{name}-tint.jpg'))
            old_path = proof_path(out, f'crop-old-{name}.jpg')
            # Reproduce page stretching to BASE.W × BASE.H, not the JPEG's aspect ratio.
            page_box = (x0+left/scale, y0+top/scale, x0+(left+1600)/scale, y0+(top+1000)/scale)
            source_box = tuple(v*old.width/base['W'] if i % 2 == 0 else v*old.height/base['H'] for i, v in enumerate(page_box))
            save_jpeg(old.transform((1600, 1000), Image.Transform.EXTENT, source_box,
                                   resample=Image.Resampling.BICUBIC), old_path)


def colour_dem(dem, shade, palette, water):
    result = np.empty((*dem.shape, 3), dtype='uint8')
    colours = np.array([rgb(c) for c in PALETTES[palette]])
    for channel in range(3):
        result[:, :, channel] = np.clip(np.interp(dem, LEVELS, colours[:, channel])*shade, 0, 255).astype('uint8')
    result[water] = rgb(WATER)
    return Image.fromarray(result)


class Terrain:
    """Keep source rasters open; render any page window with a physical halo."""
    def __init__(self, proj, base, paths, coarse, bbox=BATTLE, feather=FEATHER_DEGREES):
        self.proj, self.base, self.bbox, self.feather = proj, base, bbox, feather
        self.stack = ExitStack()
        self.stack.enter_context(rasterio.Env(GDAL_CACHEMAX=256*1024*1024))
        memory = self.stack.enter_context(MemoryFile(mosaic_vrt(paths)))
        self.fine = self.stack.enter_context(memory.open())
        self.coarse = self.stack.enter_context(rasterio.open(coarse))

    def close(self):
        self.stack.close()

    def elevations(self, x0, y0, width, height, scale):
        affine = self.proj.affine(x0, y0, scale)
        shape = (height, width)
        coarse = np.full(shape, np.nan, dtype='float32')
        # ETOPO EPSG:9518 = WGS84 + EGM2008 height. Warp the horizontal
        # coordinates only; preserve the scalar EGM2008 elevations used by GLO.
        reproject(rasterio.band(self.coarse, 1), coarse, src_crs='EPSG:4326', dst_nodata=np.nan,
                  dst_transform=affine, dst_crs=self.proj.crs,
                  resampling=Resampling.bilinear, num_threads=4, tolerance=0, warp_mem_limit=128)
        if not np.isfinite(coarse).all():
            raise RuntimeError('ETOPO coverage gap: refusing incomplete output')
        fine = np.full(shape, np.nan, dtype='float32')
        west, south, east, north = self.bbox
        xx = x0+(np.arange(width)+.5)/scale
        blend = np.empty(shape, dtype='float32')
        for row in range(0, height, 128):
            yy = y0+(np.arange(row, min(row+128, height))+.5)/scale
            lon, lat = self.proj.unproj(xx[None, :], yy[:, None])
            edge = np.minimum(np.minimum(lon-west, east-lon), np.minimum(lat-south, north-lat))
            t = np.clip(edge/self.feather, 0, 1)
            blend[row:row+128] = t*t*(3-2*t)
        if blend.max() > 0:
            reproject(rasterio.band(self.fine, 1), fine, src_nodata=-32767, dst_nodata=np.nan,
                      dst_transform=affine, dst_crs=self.proj.crs,
                      resampling=Resampling.bilinear, num_threads=4, tolerance=0, warp_mem_limit=128)
        # Catalog-confirmed ocean cells have no GLO raster. ETOPO supplies those
        # cells, never a fabricated zero raster; failed listed cells abort prepare.
        blend[~np.isfinite(fine)] = 0
        combined = coarse*(1-blend)+np.nan_to_num(fine)*blend
        return combined, affine

    def window(self, x0, y0, width, height, scale, palette):
        water = water_mask(self.base, x0, y0, scale, (height, width))
        xs = x0+(np.arange(width)+.5)/scale
        ys = y0+(np.arange(height)+.5)/scale
        water |= (xs[None, :] >= self.base['W']) | (ys[:, None] >= self.base['H'])
        if water.all():
            return Image.new('RGB', (width, height), WATER)
        halo = max(8, math.ceil(4*D['local_sigma_m']/(RADIUS/self.proj.AX/scale))+4)
        dem, affine = self.elevations(x0-halo/scale, y0-halo/scale,
                                      width+2*halo, height+2*halo, scale)
        # No bathymetric slopes even where a simplified historic coast includes
        # present-day shallow sea. Water itself is always the exact base mask.
        dem = gaussian_filter(np.maximum(dem, 0), .65)
        shade = terrain_shade(dem, self.proj, affine, palette)
        core = np.s_[halo:-halo, halo:-halo]
        return colour_dem(dem[core], shade[core], palette, water)


def level_layout(proj, base, bbox, z):
    scale = 2**z
    cols = math.ceil(base['W']*scale/512)
    rows = math.ceil(base['H']*scale/512)
    present = [(x, y) for y in range(rows) for x in range(cols)]
    if z == 4:
        west, south, east, north = bbox
        lon, lat = np.linspace(west, east, 1001), np.linspace(south, north, 1001)
        x, y = proj.proj(np.r_[lon, np.full(1001, east), lon[::-1], np.full(1001, west)],
                         np.r_[np.full(1001, south), lat, np.full(1001, north), lat[::-1]])
        ring = list(zip(x.tolist(), y.tolist()))
        coverage = rasterize([({'type': 'Polygon', 'coordinates': [ring+[ring[0]]]}, 1)],
                             out_shape=(rows, cols), transform=Affine(512/scale, 0, 0, 0, 512/scale, 0),
                             all_touched=True, dtype='uint8')
        present = [(x, y) for x, y in present if coverage[y, x]]
    entry = {'z': z, 'scale': scale, 'cols': cols, 'rows': rows,
             'x0': min(x for x, y in present), 'y0': min(y for x, y in present),
             'x1': max(x for x, y in present), 'y1': max(y for x, y in present)}
    if z == 4:
        entry['present'] = [f'{x}_{y}' for x, y in present]
    return entry, present


def current_tile(path, fingerprint):
    try:
        with Image.open(path) as image:
            if image.format != 'JPEG' or image.size != (512, 512) or image.info.get('comment') != fingerprint.encode():
                return False
            image.load()
        return True
    except (OSError, ValueError):
        return False


def tile_crop(folder, proj, lon, lat, z=4, width=1600, height=1000):
    x, y = proj.proj(lon, lat)
    scale = 2**z
    left, top = round(x*scale-width/2), round(y*scale-height/2)
    result = Image.new('RGB', (width, height), WATER)
    for ty in range(top//512, (top+height-1)//512+1):
        for tx in range(left//512, (left+width-1)//512+1):
            with Image.open(folder/str(z)/f'{tx}_{ty}.jpg') as tile:
                result.paste(tile, (tx*512-left, ty*512-top))
    return result


def stitch(folder, level, base):
    scale, z = level['scale'], level['z']
    result = Image.new('RGB', (math.ceil(base['W']*scale), math.ceil(base['H']*scale)), WATER)
    for y in range(level['rows']):
        for x in range(level['cols']):
            with Image.open(folder/str(z)/f'{x}_{y}.jpg') as tile:
                result.paste(tile, (x*512, y*512))
    return result


def coast_audit(terrain, bbox, scale, out):
    """Independent zero-height DEM coast proxy vs base geometry, before masking.

    Distances are bidirectional raster boundary distances at the specified output
    scale. Lakes are excluded by only accepting ocean connected to image edges.
    """
    from scipy.ndimage import binary_erosion, binary_propagation
    proj, base = terrain.proj, terrain.base
    x0, y0, width, height = projected_grid(proj, bbox, scale)
    dem, _ = terrain.elevations(x0, y0, width, height, scale)
    # <=0.1 m: GLO-90 flattened ocean is zero; ETOPO ocean is negative.
    sea_candidates = dem <= .1
    seeds = np.zeros_like(sea_candidates)
    seeds[[0, -1], :] = sea_candidates[[0, -1], :]
    seeds[:, [0, -1]] = sea_candidates[:, [0, -1]]
    sea = binary_propagation(seeds, mask=sea_candidates)
    mask = water_mask(base, x0, y0, scale, dem.shape)
    vector_seeds = np.zeros_like(mask)
    vector_seeds[[0, -1], :] = mask[[0, -1], :]
    vector_seeds[:, [0, -1]] = mask[:, [0, -1]]
    vector_sea = binary_propagation(vector_seeds, mask=mask)
    dem_edge = sea & ~binary_erosion(sea)
    vector_edge = vector_sea & ~binary_erosion(vector_sea)
    margin = max(3, math.ceil(scale))
    interior = np.zeros_like(mask)
    interior[margin:-margin, margin:-margin] = True
    # Exclude artificial rectangle edges from BOTH reference distance fields.
    dem_edge &= interior
    vector_edge &= interior
    inside_bbox = np.empty_like(interior)
    west, south, east, north = bbox
    xx = x0+(np.arange(width)+.5)/scale
    for row in range(0, height, 128):
        yy = y0+(np.arange(row, min(row+128, height))+.5)/scale
        lon, lat = proj.unproj(xx[None, :], yy[:, None])
        inside_bbox[row:row+128] = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
    # The projected bbox has curved edges: do not count outside geographic
    # wedges as test samples, but retain their real coasts as distance references.
    vector_samples, dem_samples = vector_edge & inside_bbox, dem_edge & inside_bbox
    a = distance_transform_edt(~dem_edge)[vector_samples]/scale
    b = distance_transform_edt(~vector_edge)[dem_samples]/scale
    def summary(distances, edge):
        row, col = np.argwhere(edge)[int(np.argmax(distances))]
        lon, lat = proj.unproj(x0+(col+.5)/scale, y0+(row+.5)/scale)
        return {'median': float(np.median(distances)), 'p95': float(np.percentile(distances, 95)),
                'max': float(distances.max()), 'max_at_lon_lat': [float(lon), float(lat)]}
    stats = {'scale': scale, 'bbox': bbox, 'method': 'bidirectional distance to connected <=0.1m DEM ocean boundary; lakes excluded',
             'vector_to_dem': summary(a, vector_samples),
             'dem_to_vector': summary(b, dem_samples),
             'base_land_on_dem_ocean_pixels': int((~mask & sea).sum()),
             'base_water_on_dem_land_pixels': int((mask & ~sea).sum()),
             'negative_elevation_rendered': False}
    image = terrain.window(x0, y0, width, height, scale, 'D')
    # Ochre is the independent DEM zero-coast; blue is authoritative base coast.
    arr = np.array(image)
    arr[binary_dilation(dem_edge)] = rgb('#bb733a')
    image = evidence_overlay(Image.fromarray(arr), proj, base,
                             {'page_bounds': [x0, y0, 0, 0], 'scale': scale}, layers=('land', 'lakes'))
    draw = ImageDraw.Draw(image)
    draw.rectangle((8, 8, 700, 66), fill=PAPER)
    draw.text((20, 20), 'BLUE: base coast/lakes | OCHRE: DEM <=0.1m ocean', fill='#4a3a2a', font=ImageFont.load_default(size=20))
    image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(image, out)
    out.with_suffix('.json').write_text(json.dumps(stats, indent=2)+'\n')
    return stats


def run_tiles(args, proj, base):
    start = time.monotonic()
    paths, downloads = fetch_tiles(args.bbox, args.workers)
    coarse, transferred, status = download('ETOPO_2022_v1_60s_N90W180_surface', ETOPO_URL)
    downloads.update(etopo_download_bytes=transferred, etopo_status=status)
    palette = ALIASES.get(args.palette, args.palette)
    algorithm = ''.join(inspect.getsource(obj) for obj in
                        (Projection, mosaic_vrt, water_mask, terrain_shade, colour_dem, Terrain, level_layout))
    params = {'renderer': 2, 'algorithm_sha256': hashlib.sha256(algorithm.encode()).hexdigest(),
              'palette': palette, 'colours': PALETTES[palette], 'D': D,
              'quality': args.quality, 'subsampling': 0, 'feather_degrees': FEATHER_DEGREES,
              'bbox': args.bbox, 'tile': 512, 'projection': proj.source_hash,
              'base': hashlib.sha256((ROOT/'data/base.json').read_bytes()).hexdigest(),
              'sources': hashlib.sha256(''.join(p.name+str(p.stat().st_size) for p in [*paths, coarse]).encode()).hexdigest()}
    fingerprint = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)
    terrain = Terrain(proj, base, paths, coarse, args.bbox)
    levels, written, skipped = [], 0, 0
    render_start = time.monotonic()
    try:
        for z in range(5):
            entry, present = level_layout(proj, base, args.bbox, z)
            targets = set(present)
            folder = args.out/str(z)
            folder.mkdir(exist_ok=True)
            # Remove stale tiles outside the exact footprint when bbox changes.
            for path in folder.glob('*.jpg'):
                if path.stem not in {f'{x}_{y}' for x, y in present}:
                    path.unlink()
            pending = {(x, y) for x, y in present if args.force or not current_tile(folder/f'{x}_{y}.jpg', fingerprint)}
            skipped += len(targets)-len(pending)
            for by in range(0, entry['rows'], 4):
                for bx in range(0, entry['cols'], 4):
                    group = [(x, y) for x, y in sorted(pending) if bx <= x < bx+4 and by <= y < by+4]
                    if not group:
                        continue
                    # Anchor every block on the same page grid. A full physical
                    # halo makes independently rendered adjacent blocks agree.
                    x1, x2 = min(x for x, y in group), max(x for x, y in group)
                    y1, y2 = min(y for x, y in group), max(y for x, y in group)
                    image = terrain.window(x1*512/entry['scale'], y1*512/entry['scale'],
                                           (x2-x1+1)*512, (y2-y1+1)*512, entry['scale'], palette)
                    for x, y in group:
                        crop = image.crop(((x-x1)*512, (y-y1)*512, (x-x1+1)*512, (y-y1+1)*512))
                        path = folder/f'{x}_{y}.jpg'
                        temp = path.with_suffix('.jpg.part')
                        crop.save(temp, format='JPEG', quality=args.quality, subsampling=0, optimize=True, comment=fingerprint.encode())
                        temp.replace(path)
                        written += 1
                    print(f'z{z}: {written} written, {skipped} skipped; block {bx},{by}', flush=True)
            entry['count'] = len(present)
            entry['bytes'] = sum((folder/f'{x}_{y}.jpg').stat().st_size for x, y in present)
            levels.append(entry)
        render_seconds = time.monotonic()-render_start
        manifest = {'tile': 512, 'palette': palette, 'W': base['W'], 'H': base['H'],
                    'levels': levels, 'attribution': ATTRIBUTION, 'parameters': params,
                    'fingerprint': fingerprint, 'bounds_convention': 'x0/y0/x1/y1 are inclusive tile indices'}
        if args.shots or args.embed:
            full = stitch(args.out, levels[1], base)
            if args.shots:
                args.shots.mkdir(parents=True, exist_ok=True)
                save_jpeg(full, args.shots/'d-full-z1.jpg')
                for name, lon, lat in [('xiangyang', 112.1, 32), ('wuling', 113.6, 24.8),
                                       ('lingzhou', 106.3, 38.1), ('caishi', 118.5, 31.7)]:
                    save_jpeg(tile_crop(args.out, proj, lon, lat), args.shots/f'd-z4-{name}.jpg')
            if args.embed:
                embedded = full.resize((2200, round(base['H']*2200/base['W'])), Image.Resampling.LANCZOS)
                args.embed.parent.mkdir(parents=True, exist_ok=True)
                for quality in range(92, 49, -1):
                    encoded = io.BytesIO()
                    embedded.save(encoded, format='JPEG', quality=quality, subsampling=0, optimize=True)
                    if encoded.tell() <= args.embed_max_bytes:
                        args.embed.write_bytes(encoded.getvalue())
                        manifest['embed'] = {'width': 2200, 'quality': quality, 'bytes': encoded.tell()}
                        break
                else:
                    raise RuntimeError('Cannot satisfy embedded JPEG byte budget')
                if args.shots:
                    shutil.copyfile(args.embed, args.shots/'d-relief-embed.jpg')
            if args.shots:
                manifest['coast_audits'] = {
                    'bohai': coast_audit(terrain, (117, 36, 123, 41), 16, args.shots/'d-coast-bohai.jpg'),
                    'pearl': coast_audit(terrain, (108, 18, 115, 23.5), 8, args.shots/'d-coast-pearl.jpg')}
        metrics = {'downloads': downloads, 'written': written, 'skipped': skipped,
                   'render_seconds': render_seconds, 'total_seconds': time.monotonic()-start,
                   'tile_bytes': sum(level['bytes'] for level in levels)}
        # Publish ancillary metrics atomically too; no success marker before all work finishes.
        temp = args.out/'manifest.json.part'
        temp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+'\n')
        temp.replace(args.out/'manifest.json')
        (args.out/'render-metrics.json').write_text(json.dumps(metrics, indent=2)+'\n')
        print(json.dumps(metrics, indent=2), flush=True)
    finally:
        terrain.close()


def main():
    global CACHE
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    sample = commands.add_parser('sample', help='Render only the specified geographic bbox')
    sample.add_argument('--bbox', type=bbox_values, required=True)
    sample.add_argument('--scale', type=float, default=16, help='Pixels per page unit')
    sample.add_argument('--palette', choices=[*PALETTES, *ALIASES], required=True)
    sample.add_argument('--out', type=Path, required=True)
    sample.add_argument('--workers', type=int, default=6, help='Concurrent public DEM downloads (1–8)')
    sample.add_argument('--cache', type=Path, default=CACHE)
    sample.add_argument('--suite', action='store_true', help='2400px overview + required native crops and alignment evidence')
    tiles = commands.add_parser('tiles', help='Full page z0–z3 plus battle-area z4; resumable JPEG pyramid')
    tiles.add_argument('--bbox', type=bbox_values, default=(98, 20, 123, 42))
    tiles.add_argument('--zooms', choices=['0-4'], default='0-4', help='Scales 1,2,4,8,16; z0–z3 full page, z4 bbox')
    tiles.add_argument('--tile-size', type=int, choices=[512], default=512)
    tiles.add_argument('--coarse-source', choices=['etopo2022-60s'], default='etopo2022-60s')
    tiles.add_argument('--palette', choices=[*PALETTES, *ALIASES], default='D')
    tiles.add_argument('--quality', type=int, choices=range(85, 93), default=90)
    tiles.add_argument('--workers', type=int, choices=range(1, 9), default=6)
    tiles.add_argument('--force', action='store_true')
    tiles.add_argument('--embed', type=Path, help='Write the 2200px fallback JPEG here')
    tiles.add_argument('--embed-max-bytes', type=int, default=320000,
                       help='Default leaves room for UTF-8 data in the <=1600 KB standalone HTML')
    tiles.add_argument('--shots', type=Path, help='Write d- prefixed stitching, crop and coast proofs')
    tiles.add_argument('--cache', type=Path, default=CACHE)
    tiles.add_argument('--out', type=Path, default=ROOT/'tiles')
    args = parser.parse_args()
    CACHE = args.cache.resolve()
    if args.command == 'tiles':
        proj = Projection()
        base = json.loads((ROOT/'data/base.json').read_text())
        validate_alignment(proj, base)
        run_tiles(args, proj, base)
        return
    if not (0 < args.scale <= 16 and 1 <= args.workers <= 8):
        parser.error('sample requires 0 < scale <= 16 and 1 <= workers <= 8')
    if args.bbox[1] < -49 or args.bbox[3] > 49:
        parser.error('sample currently supports the uniform GLO-90 grid between 49°S and 49°N')
    proj = Projection()
    grid = projected_grid(proj, args.bbox, args.scale)
    if grid[2]*grid[3] > 80_000_000:
        parser.error('sample exceeds 80 million pixels; use a smaller bbox')
    if args.suite:
        for name, (lo, la) in CROPS.items():
            cx, cy = proj.proj(lo, la)
            left, top = round((cx-grid[0])*args.scale-800), round((cy-grid[1])*args.scale-500)
            if left < 0 or top < 0 or left+1600 > grid[2] or top+1000 > grid[3]:
                parser.error(f'--suite bbox/scale must contain the native {name} crop')
    start = time.monotonic()
    base = json.loads((ROOT/'data/base.json').read_text())
    alignment = validate_alignment(proj, base)
    paths, metrics = fetch_tiles(args.bbox, args.workers)
    render_start = time.monotonic()
    palette = ALIASES.get(args.palette, args.palette)
    image, rendering = render(proj, paths, args.bbox, args.scale, palette, base)
    metrics.update(rendering)
    metrics.update({'bbox': args.bbox, 'palette': palette, 'alignment': alignment,
                    'D_parameters': D if palette == 'D' else None,
                    'colours': PALETTES[palette],
                    'source': BUCKET, 'source_licence': 'Copernicus DEM Licence',
                    'source_licence_url': 'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
                    'attribution': 'produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved',
                    'geo_mjs_sha256': proj.source_hash,
                    'render_seconds': time.monotonic()-render_start})
    if args.suite:
        suite(image, proj, base, metrics, palette, args.out)
    else:
        save_jpeg(image, args.out)
    metrics['total_seconds'] = time.monotonic()-start
    metrics['jpeg_bytes'] = args.out.stat().st_size
    args.out.with_suffix('.json').write_text(json.dumps(metrics, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps(metrics, indent=2, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
