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
Planned coarse source (not downloaded/implemented here): NOAA ETOPO 2022
60 arc-second surface GeoTIFF, CC0-1.0; cite doi:10.25921/fd45-gt74.
https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
Only sample rendering is implemented; tiles deliberately exits without work.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
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
from scipy.ndimage import binary_dilation, gaussian_filter

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


def download(name):
    """Range resume, validate length/ETag, atomic rename; no personal headers."""
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / (name+'.tif')
    part = target.with_suffix('.tif.part')
    url = BUCKET + name + '/' + name + '.tif'
    if target.exists():
        with rasterio.open(target) as ds:
            if ds.count != 1 or ds.crs.to_epsg() != 4326:
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
                ds.read(1, out_shape=(8, 8))
            part.replace(target)
            meta_path.unlink(missing_ok=True)
            return target, transferred, 'downloaded'
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None, transferred, 'ocean/missing'
            if attempt == 3:
                raise
        except (OSError, ValueError):
            if attempt == 3:
                raise
        time.sleep(attempt+1)
    raise RuntimeError('Unreachable download retry state')


def fetch_tiles(bbox, workers):
    west, south, east, north = bbox
    names = [tile_name(lon, lat) for lat in range(math.floor(south), math.ceil(north))
             for lon in range(math.floor(west), math.ceil(east))]
    paths, counts, byte_count = [], {}, 0
    start = time.monotonic()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(download, name): name for name in names}
        for i, future in enumerate(as_completed(futures), 1):
            path, size, status = future.result()
            if path:
                paths.append(path)
            counts[status] = counts.get(status, 0)+1
            byte_count += size
            if i % 10 == 0 or i == len(names):
                print(f'DEM {i}/{len(names)}; downloaded {byte_count/1e6:.1f} MB', flush=True)
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


def render(proj, paths, bbox, scale, palette, base):
    x0, y0, width, height = projected_grid(proj, bbox, scale)
    if width*height > 80_000_000:
        raise ValueError('sample limited to 80 million pixels; tiles is a future phase')
    # Halo keeps gradients and smoothing independent of crop boundaries.
    halo = 8
    affine = proj.affine(x0-halo/scale, y0-halo/scale, scale)
    dem = np.full((height+2*halo, width+2*halo), np.nan, dtype='float32')
    with MemoryFile(mosaic_vrt(paths)) as memory, memory.open() as source:
        reproject(rasterio.band(source, 1), dem, src_nodata=-32767, dst_nodata=np.nan,
                  dst_transform=affine, dst_crs=proj.crs, resampling=Resampling.bilinear,
                  num_threads=4, warp_mem_limit=128)
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
    gy, gx = np.gradient(dem, abs(affine.e), affine.a)
    # Correct map scale at each row (conformal Lambert; small variation across sample).
    _, lat = proj.unproj(x0+width/scale/2, y0+(np.arange(dem.shape[0])-halo+.5)/scale)
    rho = proj.f/np.tan(np.pi/4+np.radians(lat)/2)**proj.n
    factor = (proj.n*rho/np.cos(np.radians(lat))).astype('float32')[:, None]
    gx *= factor
    gy *= factor
    length = np.sqrt(1+gx*gx+gy*gy)
    illumination = np.zeros_like(dem)
    flat = 0.0
    for azimuth, altitude, weight in [(315, 45, .55), (270, 50, .20), (0, 55, .15), (45, 60, .10)]:
        az, alt = np.radians([azimuth, altitude])
        # Pixel y is southwards: surface normal (-gx, +gy, 1) in E/N/up.
        illumination += weight*np.maximum(0, (-gx*np.sin(az)*np.cos(alt)+gy*np.cos(az)*np.cos(alt)+np.sin(alt))/length)
        flat += weight*np.sin(alt)
    strength = {'A': .85, 'B': .90, 'C': 1.05}[palette]
    shade = np.clip(1+strength*(illumination/flat-1), .62 if palette != 'C' else .65, 1.10)
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


def evidence_overlay(image, proj, base, metrics, crop=None):
    result = image.copy()
    draw = ImageDraw.Draw(result)
    x0, y0, _, _ = metrics['page_bounds']
    scale = metrics['scale']
    ox, oy = crop or (0, 0)
    for name, colour, width in [('land', '#385e71', 2), ('rivers', '#326c85', 2), ('lakes', '#385e71', 2)]:
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


def readability(crop, palette, out, labels):
    """Keep clean required crops; put typography/tint comparisons in a separate proof."""
    font_path = next((p for p in [Path('/System/Library/Fonts/Supplemental/Songti.ttc'),
                                 Path('/System/Library/Fonts/PingFang.ttc'),
                                 Path('/System/Library/Fonts/STHeiti Medium.ttc'),
                                 Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')]
                      if p.exists()), None)
    font = ImageFont.truetype(str(font_path), 32) if font_path else ImageFont.load_default(size=32)
    proof = Image.new('RGB', (3200, 2000))
    variants = [('原色', None), ('橙红 30%', '#c8553a'), ('灰蓝 30%', '#687d8a'), ('黄绿 30%', '#a8ad62')]
    for i, (title, colour) in enumerate(variants):
        panel = Image.blend(crop, Image.new('RGB', crop.size, colour), .30) if colour else crop.copy()
        draw = ImageDraw.Draw(panel)
        # The same dark brown as page labels, without a halo: a demanding readability check.
        draw.text((28, 24), f'{palette} · {title}' if font_path else f'{palette} / panel {i+1}', font=font, fill='#4a3a2a')
        for x, y, text in labels:
            draw.text((x+8, y+5), text if font_path else 'City', font=font, fill='#4a3a2a')
        proof.paste(panel, ((i % 2)*1600, (i//2)*1000))
    proof.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(proof, out.with_name(f'readability-{palette}.jpg'))


def suite(image, proj, base, metrics, palette, out):
    overview = image.copy()
    overview.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(overview, out)
    aligned = evidence_overlay(image, proj, base, metrics)
    aligned.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
    save_jpeg(aligned, out.with_name(f'alignment-{palette}.jpg'))
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
            save_jpeg(crop, out.with_name(f'crop-{palette}-{name}.jpg'))
            evidence = evidence_overlay(crop, proj, base, metrics, (left, top))
            save_jpeg(evidence, out.with_name(f'alignment-{palette}-{name}.jpg'))
            if name == 'diaoyu':
                labels = []
                for label, lo, la in [('钓鱼城', 106.427, 29.990), ('重庆', 106.55, 29.56), ('华蓥山', 106.86, 30.23)]:
                    px, py = proj.proj(lo, la)
                    labels.append(((px-x0)*scale-left, (py-y0)*scale-top, label))
                readability(crop, palette, out, labels)
                tint = Image.blend(crop, Image.new('RGB', crop.size, '#c8553a'), .30)
                save_jpeg(tint, out.with_name(f'crop-{palette}-{name}-tint.jpg'))
            old_path = out.with_name(f'crop-old-{name}.jpg')
            # Reproduce page stretching to BASE.W × BASE.H, not the JPEG's aspect ratio.
            page_box = (x0+left/scale, y0+top/scale, x0+(left+1600)/scale, y0+(top+1000)/scale)
            source_box = tuple(v*old.width/base['W'] if i % 2 == 0 else v*old.height/base['H'] for i, v in enumerate(page_box))
            save_jpeg(old.transform((1600, 1000), Image.Transform.EXTENT, source_box,
                                   resample=Image.Resampling.BICUBIC), old_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    sample = commands.add_parser('sample', help='Render only the specified geographic bbox')
    sample.add_argument('--bbox', type=bbox_values, required=True)
    sample.add_argument('--scale', type=float, default=16, help='Pixels per page unit')
    sample.add_argument('--palette', choices=[*PALETTES, *ALIASES], required=True)
    sample.add_argument('--out', type=Path, required=True)
    sample.add_argument('--workers', type=int, default=6, help='Concurrent public DEM downloads (1–8)')
    sample.add_argument('--suite', action='store_true', help='2400px overview + required native crops and alignment evidence')
    tiles = commands.add_parser('tiles', help='Parameter skeleton only; not implemented')
    tiles.add_argument('--bbox', type=bbox_values, default=(98, 20, 123, 42))
    tiles.add_argument('--zooms', default='0-4', help='Planned: scales 1,2,4,8,16; z0–z3 full page, z4 bbox')
    tiles.add_argument('--tile-size', type=int, default=512, help='Provisional; no tiles are generated')
    tiles.add_argument('--coarse-source', choices=['etopo2022-60s'], default='etopo2022-60s')
    tiles.add_argument('--palette', choices=[*PALETTES, *ALIASES], default='A')
    tiles.add_argument('--out', type=Path, default=ROOT/'tiles')
    args = parser.parse_args()
    if args.command == 'tiles':
        parser.exit(2, 'tiles 仅预留参数；全量 DEM、混合粗层、切片与金字塔尚未实现。\n')
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
