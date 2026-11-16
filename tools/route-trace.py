#!/usr/bin/env python3
"""按固定途经点在缓存 DEM 上寻路；不联网、不修改讲稿或内嵌动作。

主检出 .cache/venv/bin/python tools/route-trace.py --write --report /tmp/routes.json
  默认重算 data/route-waypoints.json 全表；可传下标及 JSON 途经点列表：
  ... tools/route-trace.py 1 '["凤州","兴州","剑门关","成都府"]'
  --verify 只核对 main 与工作区的数据边界、端点、比例及最终路径坡度。
  --reference main 可指定未改路线的 git 基线；重算始终从基线映射比例，避免累计漂移。

寻路栅格 0.10 页面单位（约 380 m），16 邻接，双向坡度代价相同。
代价 = 距离 × (1 + 45 地表坡度² + 160 行进坡度²
                    + 2 正相对高差/100m + 绝对高程/2500m)。
相对高差取 2 页面单位范围的地形均值；地表坡度仅用于惩罚山坡，
沿边高差惩罚翻岭，低地偏好避免沿山脊横行。不是古道路实测复原。
65 舟师裁取 base.rivers 中两端最接近的同一河道，缺河道才按谷底寻路。
轻微平滑后按段 DP（陆路 0.3、河道 0.15 单位）简化，锁住途经点；
陆路用细 DEM 检查捷径，峰值超旧线时保留弯折，原始栅格边仍可能有超限局部。
超 120 点时小幅提高几何容差，实际容差记入报告。坡度按最终一位小数 SVG，每约 95m 在 GLO-90 重采样，
报告纵向坡度最大值（atan(|高差|/球面距离)），新旧使用完全相同的方法。
"""
import argparse
import copy
import json
import math
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.warp import reproject, Resampling
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from relief import Projection, RADIUS, mosaic_vrt, tile_name

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE = Path('/Users/whoog/Notoday/song-atlas/.cache/dem')
BATCH = {1, 2, 3, 26, 27, 28, 29, 30, 38, 39, 40, 41, 61, 64, 65}


def load(name):
    return json.loads((ROOT / 'data' / (name + '.json')).read_text())


def baseline(ref, name):
    return json.loads(subprocess.check_output(
        ['git', 'show', f'{ref}:data/{name}.json'], cwd=ROOT, text=True))


def points(path):
    if re.search('[A-KN-Z a-kn-z]', path):
        raise ValueError('Only absolute M/L route paths are supported')
    return np.array([[float(v) for v in p.split(',')]
                     for p in path[1:].split('L')])


def lengths(p):
    return np.r_[0., np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]


def at(p, fraction):
    ls = lengths(p)
    return np.array([np.interp(fraction * ls[-1], ls, p[:, j]) for j in (0, 1)])


def nearest(p, q):
    d = np.diff(p, axis=0)
    u = np.clip(np.sum((q - p[:-1]) * d, axis=1) / np.maximum(np.sum(d*d, axis=1), 1e-12), 0, 1)
    hits = p[:-1] + u[:, None] * d
    dist = np.linalg.norm(hits-q, axis=1)
    k = int(dist.argmin())
    ls = lengths(p)
    return (ls[k] + u[k]*(ls[k+1]-ls[k]))/ls[-1], hits[k], float(dist[k])


class DEM:
    def __init__(self, cache, proj):
        self.cache, self.proj = cache, proj

    def grid(self, lo, hi, step):
        lo = np.floor(np.asarray(lo)/step)*step
        shape = np.ceil((np.asarray(hi)-lo)/step).astype(int)+1
        corners = np.array([[x, y] for x in (lo[0], hi[0]) for y in (lo[1], hi[1])])
        lon, lat = self.proj.unproj(corners[:, 0], corners[:, 1])
        paths = [self.cache / (tile_name(x, y)+'.tif')
                 for y in range(math.floor(min(lat)) - 1, math.ceil(max(lat))+1)
                 for x in range(math.floor(min(lon)) - 1, math.ceil(max(lon))+1)]
        paths = [p for p in paths if p.exists()]
        if not paths:
            raise ValueError('No cached DEM coverage')
        out = np.full((shape[1], shape[0]), np.nan, dtype='float32')
        with MemoryFile(mosaic_vrt(paths)) as mem, mem.open() as source:
            reproject(rasterio.band(source, 1), out, src_nodata=-32767, dst_nodata=np.nan,
                      dst_transform=self.proj.affine(lo[0]-step/2, lo[1]-step/2, 1/step),
                      dst_crs=self.proj.crs, resampling=Resampling.bilinear)
        if not np.isfinite(out).all():
            raise ValueError('Missing cached DEM pixels; refusing to download or fill')
        return lo, out

    def sample(self, p):
        # Separate small windows keeps detailed metrics memory bounded on long routes.
        result = []
        for start in range(0, len(p), 150):
            q = p[start:start+150]
            lo, z = self.grid(q.min(axis=0)-.08, q.max(axis=0)+.08, .025)
            rc = ((q-lo)/.025).T[::-1]
            result.extend(map_coordinates(z, rc, order=1, mode='nearest'))
        return np.asarray(result)

    def trace(self, a, b, valley=False):
        step = .10
        pad = min(10., max(2., float(np.linalg.norm(b-a))*.20))
        lo, z = self.grid(np.minimum(a,b)-pad, np.maximum(a,b)+pad, step)
        # Projection scale is evaluated at this segment's middle latitude.
        _, lat = self.proj.unproj(*((a+b)/2))
        rho = self.proj.f / np.tan(np.pi/4+np.radians(lat)/2)**self.proj.n
        factor = self.proj.n*rho/np.cos(np.radians(lat))
        metres = step*RADIUS/self.proj.AX/factor
        gy, gx = np.gradient(z, metres)
        slope2 = gx*gx+gy*gy
        relative = np.maximum(0, z-gaussian_filter(z, 2/step))
        cost = 1 + 45*slope2 + 2*relative/100 + np.maximum(z,0)/2500
        if valley:
            cost += 10*np.maximum(z-gaussian_filter(z, 5/step), 0)/100
        h, w = z.shape
        ids = np.arange(h*w, dtype=np.int32).reshape(h,w)
        rows, cols, weights = [], [], []
        for dy, dx in ((0,1),(1,0),(1,1),(1,-1),(1,2),(1,-2),(2,1),(2,-1)):
            y0,y1 = max(0,-dy), min(h,h-dy)
            x0,x1 = max(0,-dx), min(w,w-dx)
            sa = np.s_[y0:y1, x0:x1]
            sb = np.s_[y0+dy:y1+dy, x0+dx:x1+dx]
            distance = math.hypot(dx,dy)
            climb = (z[sa]-z[sb])/(metres*distance)
            weight = distance*((cost[sa]+cost[sb])/2+160*climb*climb)
            rows.append(ids[sa].ravel()); cols.append(ids[sb].ravel()); weights.append(weight.ravel())
        rr, cc, ww = map(np.concatenate, (rows,cols,weights))
        graph = coo_matrix((np.r_[ww,ww], (np.r_[rr,cc],np.r_[cc,rr])), shape=(h*w,h*w)).tocsr()
        ai, bi = [np.rint((p-lo)/step).astype(int) for p in (a,b)]
        source, target = ai[1]*w+ai[0], bi[1]*w+bi[0]
        _, prev = dijkstra(graph, indices=source, return_predecessors=True)
        walk = [target]
        while walk[-1] != source:
            n = int(prev[walk[-1]])
            if n < 0:
                raise ValueError('Disconnected DEM path')
            walk.append(n)
        walk = np.asarray(walk[::-1])
        p = lo + np.c_[walk % w, walk // w]*step
        p[0], p[-1] = a, b
        # One binomial pass removes raster stair steps without moving anchors.
        if len(p)>2:
            p[1:-1] = (p[:-2]+2*p[1:-1]+p[2:])/4
        return p


def simplify(p, tolerance, terrain=None, max_slope=90):
    if len(p)<=2:
        return p
    d = p[-1]-p[0]
    u = np.clip((p-p[0]) @ d/max(float(d@d),1e-12),0,1)
    dist = np.linalg.norm(p-p[0]-u[:,None]*d,axis=1)
    k = int(dist.argmax())
    safe = terrain is None or terrain(p[0],p[-1]) <= max_slope
    if dist[k] <= tolerance and safe:
        return p[[0,-1]]
    if k in (0,len(p)-1):
        k = len(p)//2
    return np.vstack((simplify(p[:k+1], tolerance, terrain, max_slope)[:-1],
                      simplify(p[k:], tolerance, terrain, max_slope)))


def terrain_sampler(part, dem):
    """Check the rendered, rounded shortcut at the same resolution as metrics.

    DP's geometric tolerance alone can jump across a narrow ridge. Keep its
    otherwise removable bends whenever a shortcut exceeds the old maximum.
    A two-point raw edge cannot be subdivided further: expose any remaining
    excess in the final report rather than reporting the unsimplified path.
    """
    lo,z = dem.grid(part.min(axis=0)-.08,part.max(axis=0)+.08,.025)
    def slope(a,b):
        distance = float(np.linalg.norm(b-a))
        q = np.linspace(a,b,max(2,math.ceil(distance/.025)+1))
        heights = map_coordinates(z,((q-lo)/.025).T[::-1],order=1,mode='nearest')
        lon,lat = np.radians(dem.proj.unproj(q[:,0],q[:,1]))
        dh = np.sin(np.diff(lat)/2)**2+np.cos(lat[:-1])*np.cos(lat[1:])*np.sin(np.diff(lon)/2)**2
        metres = 2*RADIUS*np.arcsin(np.sqrt(dh))
        return float(np.degrees(np.arctan(np.abs(np.diff(heights))/np.maximum(metres,1e-8))).max())
    return slope


def river_parts(a, b, anchors):
    candidates = []
    river_paths = load('base')['rivers'] + [r[3] for r in load('rivers')]
    for path in river_paths:
        # A base river may contain several disconnected M subpaths.
        for subpath in re.findall(r'M[^M]+', path):
            p = points(subpath)
            if len(p)<2:
                continue
            fa, pa, da = nearest(p,a)
            fb, pb, db = nearest(p,b)
            candidates.append((da+db, p, fa, fb, pa, pb))
    score, p, fa, fb, pa, pb = min(candidates, key=lambda r:r[0])
    if score > 2:
        return None
    ls = lengths(p)/lengths(p)[-1]
    middle = p[(ls>min(fa,fb)) & (ls<max(fa,fb))]
    if fa>fb:
        middle = middle[::-1]
    p = np.vstack((a,pa,middle,pb,b))
    # River positions are authoritative: snap approximate intermediate geographic
    # controls to the same channel rather than sailing over a bank to reach them.
    cuts = sorted({0, len(p)-1, *(int(np.linalg.norm(p-q,axis=1).argmin()) for q in anchors)})
    return [p[i:j+1] for i,j in zip(cuts,cuts[1:])]


def controls(values, cities, proj):
    out = []
    for value in values:
        if isinstance(value,str):
            matches = [c for c in cities if c[0]==value]
            if len(matches)!=1:
                raise ValueError(f'Ambiguous or unknown city: {value}')
            out.append(np.array(matches[0][1:3],float))
        else:
            out.append(np.array(proj.proj(*value)))
    return out


def label(p, cities):
    candidates = [at(p,f) for f in np.linspace(.38,.62,49)]
    # Keep the text's anchor clear of city symbols; UI handles actual label boxes.
    return np.round(max(candidates, key=lambda q:min(np.linalg.norm(q-np.array(c[1:3])) for c in cities)),1).tolist()


def metrics(p, dem):
    ls = lengths(p)
    samples = np.linspace(0,ls[-1],max(2,math.ceil(ls[-1]/.025)+1))
    q = np.c_[np.interp(samples,ls,p[:,0]),np.interp(samples,ls,p[:,1])]
    z = dem.sample(q)
    lon,lat = np.radians(dem.proj.unproj(q[:,0],q[:,1]))
    dh = np.sin(np.diff(lat)/2)**2 + np.cos(lat[:-1])*np.cos(lat[1:])*np.sin(np.diff(lon)/2)**2
    metres = 2*RADIUS*np.arcsin(np.sqrt(dh))
    degrees = np.degrees(np.arctan(np.abs(np.diff(z))/metres))
    return {'length_page':round(float(ls[-1]),3), 'points':len(p),
            'max_slope_deg':round(float(degrees.max()),2),
            'max_slope_at':np.round(q[int(degrees.argmax())],3).tolist(),
            'p95_slope_deg':round(float(np.percentile(degrees,95)),2)}


def remap(events, old, new, anchors, selected, current):
    out = copy.deepcopy(current)
    mappings = {}
    for e in events:
        for s in (e[6] or {}).get('steps',[]):
            for a in s[1]:
                if a[0]=='m' and a[1] in selected:
                    i = a[1]
                    for f in a[2:4]:
                        if (i,f) in mappings:
                            continue
                        if f in (0,1):
                            mappings[i,f] = f
                            continue
                        q = at(points(old[i][4]),f)
                        # Prefer a nearby fixed control; otherwise project to a segment.
                        ap = anchors[i]
                        k = int(np.linalg.norm(ap-q,axis=1).argmin())
                        target = ap[k] if np.linalg.norm(ap[k]-q)<2 else q
                        nf, _, _ = nearest(points(new[i][4]),target)
                        mappings[i,f] = round(float(nf),3)
    for i in selected:
        seq = sorted((f,n) for (j,f),n in mappings.items() if j==i)
        if any(b[1]<=a[1] for a,b in zip(seq,seq[1:])):
            raise ValueError(f'Route {i}: nearest-point mapping is not strictly monotone: {seq}; review controls')
    for e, reference_event in zip(out, events):
        for s, reference_step in zip((e[6] or {}).get('steps',[]), (reference_event[6] or {}).get('steps',[])):
            for a, reference_action in zip(s[1], reference_step[1]):
                if a[0]=='m' and a[1] in selected:
                    a[2:4] = [mappings[a[1],f] for f in reference_action[2:4]]
    return out, {str(i):{str(f):n for (j,f),n in mappings.items() if j==i} for i in sorted(selected)}


def verify(oldr, newr, olde, newe):
    assert len(oldr)==len(newr)
    changed = []
    for i,(a,b) in enumerate(zip(oldr,newr)):
        if a==b:
            continue
        assert i in BATCH, ('unexpected route',i)
        assert a[:4]+a[6:]==b[:4]+b[6:], ('route fields',i)
        p,q = points(a[4]),points(b[4])
        assert np.array_equal(p[[0,-1]],q[[0,-1]]), ('endpoints',i)
        assert len(q)<=120, ('point limit',i)
        assert nearest(q,np.array(b[5]))[2]<.08, ('label off path',i)
        changed.append(i)
    def compare(a,b,path=()):
        if isinstance(a,list):
            assert isinstance(b,list) and len(a)==len(b),path
            if a and a[0]=='m' and len(a)>=4 and a[1] in BATCH:
                assert a[:2]==b[:2] and a[4:]==b[4:],path
                assert 0<=b[2]<=b[3]<=1,path
                for k in (2,3):
                    if a[k] in (0,1):
                        assert a[k]==b[k],path
                return
            for k,(x,y) in enumerate(zip(a,b)):
                compare(x,y,path+(k,))
        elif isinstance(a,dict):
            assert a.keys()==b.keys(),path
            for k in a:
                compare(a[k],b[k],path+(k,))
        else:
            assert a==b,path
    compare(olde,newe)
    for e in newe:
        ends = {}
        for s in (e[6] or {}).get('steps',[]):
            for a in s[1]:
                if a[0]=='m' and a[1] in BATCH:
                    assert a[2]==ends.get(a[1],0), ('discontinuous',e[1],a)
                    ends[a[1]]=a[3]
    return {'reference_events_equal_except_m_fractions':True,'routes_changed':changed,
            'endpoints_preserved':True,'fractions_continuous_monotone':True}


def write_rows(name, rows):
    file = ROOT/'data'/f'{name}.json'
    original = file.read_text().splitlines(keepends=True)
    assert len(original)==len(rows)+2, 'Expected one record per line'
    for i,row in enumerate(rows):
        if json.loads(original[i+1].rstrip().rstrip(',')) != row:
            original[i+1] = json.dumps(row,ensure_ascii=False,separators=(',',':'))+(',' if i<len(rows)-1 else '')+'\n'
    file.write_text(''.join(original))


def main():
    parser = argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('route',nargs='?',type=int)
    parser.add_argument('waypoints',nargs='?',help='JSON array of city names or [lon,lat]')
    parser.add_argument('--cache',type=Path,default=DEFAULT_CACHE)
    parser.add_argument('--reference',default='main')
    parser.add_argument('--write',action='store_true')
    parser.add_argument('--verify',action='store_true')
    parser.add_argument('--report',type=Path)
    args = parser.parse_args()
    if args.verify and args.write:
        parser.error('--verify and --write are mutually exclusive')
    if args.waypoints and args.route is None:
        parser.error('Inline waypoints require a route index')
    oldr, olde = baseline(args.reference,'routes'),baseline(args.reference,'events')
    newr, newe = load('routes'),load('events')
    table, cities, proj = load('route-waypoints'),load('cities'),Projection()
    selected = {args.route} if args.route is not None else {int(k) for k in table}
    if not selected <= BATCH:
        parser.error('This pilot only authorizes the listed 15 route indexes')
    dem = DEM(args.cache.resolve(),proj)
    anchors, tolerances = {}, {}
    if not args.verify:
        for i in sorted(selected):
            old = points(oldr[i][4])
            values = json.loads(args.waypoints) if args.waypoints else table[str(i)]
            cp = [old[0], *controls(values,cities,proj), old[-1]]
            cp = np.array([p for k,p in enumerate(cp) if k==0 or np.linalg.norm(p-cp[k-1])>.02])
            anchors[i] = cp
            parts = river_parts(cp[0],cp[-1],cp[1:-1]) if oldr[i][7][3]=='舟' else None
            if parts is None:
                parts = [dem.trace(a,b,valley=oldr[i][7][3]=='舟') for a,b in zip(cp,cp[1:])]
            # Round before testing shortcuts: these are the coordinates the SVG uses.
            parts = [np.round(part,1) for part in parts]
            boat = oldr[i][7][3]=='舟'
            samplers = [None if boat else terrain_sampler(part,dem) for part in parts]
            cap = metrics(old,dem)['max_slope_deg']-.5
            tolerance = .15 if boat else .3
            while True:
                p = np.vstack([simplify(part,tolerance,sampler,cap)[:-1]
                               for part,sampler in zip(parts,samplers)]+[parts[-1][-1:]])
                if len(p)<=120:
                    break
                tolerance = round(tolerance+.025,3)
                if tolerance>2:
                    raise ValueError(f'Route {i} cannot satisfy point budget near 0.3 tolerance')
            p = np.round(p,1)
            p = p[np.r_[True,np.any(np.diff(p,axis=0)!=0,axis=1)]]
            p[0],p[-1] = old[0],old[-1]
            newr[i][4] = 'M'+'L'.join(f'{x:.1f},{y:.1f}' for x,y in p)
            newr[i][5] = label(p,cities)
            tolerances[str(i)] = tolerance
            print(f'Traced {i}: {len(p)} points; DP {tolerance}',flush=True)
        newe, mapping = remap(olde,oldr,newr,anchors,selected,newe)
    else:
        mapping = {}
    report = {'reference':args.reference,'verification':verify(oldr,newr,olde,newe),
              'dp_tolerances':tolerances,'fractions':mapping,'routes':{}}
    for i in sorted(selected):
        before,after = metrics(points(oldr[i][4]),dem),metrics(points(newr[i][4]),dem)
        report['routes'][str(i)] = {'old':before,'new':after,
                                    'length_ratio':round(after['length_page']/before['length_page'],3)}
        print(i,json.dumps(report['routes'][str(i)]),flush=True)
    if args.write:
        write_rows('routes',newr)
        write_rows('events',newe)
        if args.waypoints:
            table[str(args.route)] = json.loads(args.waypoints)
            (ROOT/'data/route-waypoints.json').write_text(
                '{\n'+',\n'.join('  '+json.dumps(k)+': '+json.dumps(v,ensure_ascii=False,separators=(',',':'))
                                for k,v in table.items())+'\n}\n')
    if args.report:
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report['verification'],ensure_ascii=False))


if __name__=='__main__':
    main()
