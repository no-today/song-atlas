#!/usr/bin/env python3
"""首批 15 条路线：缓存 DEM / 底图河道 → 平滑折线 → 语义停点与反向撤退。

主检出 .cache/venv/bin/python tools/route-trace.py --write --report /tmp/routes.json
可传单个路线下标及可选 JSON 途经点表；--write 同步保存显式途经点。
--verify 只核对与 --reference（默认 main）的字段边界、端点、途经城邑、
步骤停点、撤退重合及最终路径指标。重算比例始终按 STEP_STOPS 的地点，
无独立地点坐标的动作才沿用基线最近点法；起点连续继承上一动作止点。

陆路采用 8 邻域、0.05 页面单位网格，0.025 单位 DEM 检查边内坡度，
代价同时惩罚陡坡、翻岭、相对高地。仅使用已有缓存，绝不下载 DEM。
2 号归州至忠州、65 号全线裁取底图河道；局部变形接入固定城标和旧端点。
输出先 DP，再 Chaikin 两遍（南汉南段、剑州—大获城四遍），再对曲线作细化以符合 120 点上限。
每段锁住途经点，保留原路线端点。全部坡度按最终一位小数 SVG 约每 95m
采样计算，不能用寻路中间结果冒充成品。报告同时列 main、dee716b 和成品。
"""
import argparse
import copy
import heapq
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
from scipy.ndimage import gaussian_filter, map_coordinates, distance_transform_edt
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from relief import Projection, RADIUS, mosaic_vrt, tile_name

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE = Path('/Users/whoog/Notoday/song-atlas/.cache/dem')
BATCH = {1, 2, 3, 26, 27, 28, 29, 30, 38, 39, 40, 41, 61, 64, 65}
# Explicit editorial decisions: step numbers are 1-based; None means retained
# nearest-point mapping because there is no independent plotted stop position.
STEP_STOPS = {
    1: {1:'三泉', 2:'剑门关', 4:'成都府'},
    2: {3:'夔州', 4:'成都府'},
    3: {1:'贺州', 2:'韶州', 3:'马迳', 4:'兴王府'},
    26: {1:'天都山'}, 27: {4:'灵州'}, 28: {5:'灵州'},
    29: {2:'夏州'}, 30: {3:'宥州'}, 38: {1:'富平'},
    39: {2:'下邽'}, 40: {2:'下邽'}, 41: {1:'和尚原'},
    61: {1:'兴元府', 2:'阳平关', 3:'剑门关', 4:'成都府'},
    64: {1:'兴元府', 2:'青居城', 3:'钓鱼城'}, 65: {4:'三槽山'},
}
# event, step, action index -> corresponding route; 'a' is the unchanged
# embedded Xianrenguan attack, whose retreat must reverse that exact attack.
RETREATS = {('五路伐夏',6,0):28, ('五路伐夏',6,1):29,
            ('富平之战',4,0):38, ('和尚原、仙人关之战',4,0):'a',
            ('蒙古军入蜀',4,2):61, ('钓鱼城之战',6,0):64}


def stop_position(name):
    special = {'三泉':Projection().proj(106.15,32.92),
               '下邽':Projection().proj(109.50841,34.72558), '马迳':(1023.2,883.7),
               '富平':(898.6,561.2), '钓鱼城':(832.7,699.7), '三槽山':(833.8,704)}
    if name in special:
        return np.asarray(special[name],float)
    matches = [c for c in load('cities')+load('labels') if c[0]==name]
    if len(matches)!=1:
        raise ValueError(f'Stop must resolve uniquely: {name}')
    return np.asarray(matches[0][1:3],float)


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

    def trace(self, a, b, avoid=None):
        step = .05
        pad = min(8., max(2., float(np.linalg.norm(b-a))*.18))
        lo, fine = self.grid(np.minimum(a,b)-pad, np.maximum(a,b)+pad, step/2)
        z = fine[::2,::2]
        _, lat = self.proj.unproj(*((a+b)/2))
        rho = self.proj.f / np.tan(np.pi/4+np.radians(lat)/2)**self.proj.n
        factor = self.proj.n*rho/np.cos(np.radians(lat))
        metres = step*RADIUS/self.proj.AX/factor
        gy,gx = np.gradient(z,metres)
        relative = np.maximum(0,z-gaussian_filter(z,2/step))
        cost = 1+60*(gx*gx+gy*gy)+3*relative/100+np.maximum(z,0)/2500
        h,w = z.shape
        if avoid is not None and len(avoid)>1:
            mask = np.ones((h,w),bool)
            dense = resample(avoid,.04)
            ij = np.rint((dense-lo)/step).astype(int)
            ij = ij[(ij[:,0]>=0)&(ij[:,0]<w)&(ij[:,1]>=0)&(ij[:,1]<h)]
            mask[ij[:,1],ij[:,0]] = False
            distance = distance_transform_edt(mask)*step
            # Endpoints necessarily share a short city approach. Elsewhere an
            # outgoing route must find another valley, not retrace the corridor.
            yy,xx = np.mgrid[:h,:w]
            city_distance = np.hypot(lo[0]+xx*step-a[0],lo[1]+yy*step-a[1])
            cost += np.where(city_distance>1.8, 500*np.maximum(0,2.3-distance)**2,0)
        ids = np.arange(h*w,dtype=np.int32).reshape(h,w)
        rows,cols,weights = [],[],[]
        for dy,dx in ((0,1),(1,0),(1,1),(1,-1)):
            y0,y1 = max(0,-dy),min(h,h-dy)
            x0,x1 = max(0,-dx),min(w,w-dx)
            sa,sb = np.s_[y0:y1,x0:x1],np.s_[y0+dy:y1+dy,x0+dx:x1+dx]
            yy,xx = np.mgrid[y0:y1,x0:x1]
            heights = [z[sa]]
            for f in (.25,.5,.75):
                heights.append(map_coordinates(fine,np.array([(yy+dy*f)*2,(xx+dx*f)*2]),order=1))
            heights.append(z[sb])
            distance = math.hypot(dx,dy)
            peak = np.max(np.abs(np.diff(heights,axis=0)),axis=0)/(metres*distance/4)
            climb = (z[sa]-z[sb])/(metres*distance)
            weight = distance*((cost[sa]+cost[sb])/2+240*climb*climb+
                               1800*np.maximum(0,peak-.22)**2)
            rows.append(ids[sa].ravel());cols.append(ids[sb].ravel());weights.append(weight.ravel())
        rr,cc,ww = map(np.concatenate,(rows,cols,weights))
        graph = coo_matrix((np.r_[ww,ww],(np.r_[rr,cc],np.r_[cc,rr])),shape=(h*w,h*w)).tocsr()
        ai,bi = [np.rint((p-lo)/step).astype(int) for p in (a,b)]
        source,target = ai[1]*w+ai[0],bi[1]*w+bi[0]
        _,prev = dijkstra(graph,indices=source,return_predecessors=True)
        walk = [target]
        while walk[-1]!=source:
            n = int(prev[walk[-1]])
            if n<0:
                raise ValueError('Disconnected DEM path')
            walk.append(n)
        walk = np.asarray(walk[::-1])
        p = lo+np.c_[walk%w,walk//w]*step
        p[0],p[-1] = a,b
        return p


def resample(p, step):
    ls = lengths(p)
    t = np.linspace(0,ls[-1],max(2,math.ceil(ls[-1]/step)+1))
    return np.c_[np.interp(t,ls,p[:,0]),np.interp(t,ls,p[:,1])]


def simplify(p, tolerance):
    if len(p)<=2:
        return p
    d = p[-1]-p[0]
    u = np.clip((p-p[0])@d/max(float(d@d),1e-12),0,1)
    dist = np.linalg.norm(p-p[0]-u[:,None]*d,axis=1)
    k = int(dist.argmax())
    if dist[k]<=tolerance:
        return p[[0,-1]]
    return np.vstack((simplify(p[:k+1],tolerance)[:-1],simplify(p[k:],tolerance)))


def chaikin(p):
    for _ in range(2):
        q = np.stack((.75*p[:-1]+.25*p[1:],.25*p[:-1]+.75*p[1:]),axis=1).reshape(-1,2)
        p = np.vstack((p[0],q,p[-1]))
    return p


def finish(parts, route):
    if route==3:
        hard = [stop_position(name) for name in STEP_STOPS[3].values()]
        hard += [stop_position(name) for name in load('route-waypoints')['3'] if isinstance(name,str)]
        # Keep the two passes between Lianzhou and Shaozhou: removing these
        # anonymous controls lets a long smoothed chord cut across the ridge.
        hard += [np.array(Projection().proj(*q)) for q in ((112.65,24.78),(113.04,24.78))]
        merged,group = [],[]
        for k,part in enumerate(parts):
            group.append(part)
            if k==len(parts)-1 or min(np.linalg.norm(part[-1]-q) for q in hard)<.1:
                merged.append(np.vstack([p[:-1] for p in group]+[group[-1][-1:]]))
                group = []
        parts = merged
    # Preserve fine bends near the two narrow passages which caused the previous
    # slope regressions; spend the limited vertex budget on those passages.
    critical = []
    southern = []
    for part in parts:
        dsg = any(846<=p[0]<=851 and 575<=p[1]<=580 for p in (part[0],part[-1]))
        gorge = any(819<=p[0]<=826 and 620<=p[1]<=630 for p in (part[0],part[-1]))
        southern.append((route==64 and any(810<=p[0]<=825 and 635<=p[1]<=651 for p in (part[0],part[-1])))
                        or (route==3 and any(p[1]>=850 for p in (part[0],part[-1]))))
        ridge = route==3 and any(995<=p[0]<=1030 and 838<=p[1]<=847 for p in (part[0],part[-1]))
        critical.append(route==41 or route in (61,64) and (dsg or gorge) or ridge)
    curves = [chaikin(simplify(part,.05 if fine and not south else .30))
              for part,fine,south in zip(parts,critical,southern)]
    curves = [chaikin(curve) if south else curve for curve,south in zip(curves,southern)]
    if route in (3,64):
        return budget_curve(curves,[8 if south else 3 if fine else 1
                                    for fine,south in zip(critical,southern)])
    tolerance = .015 if route==41 else .025
    while True:
        p = np.vstack([simplify(part,(min(.015,tolerance) if route==41 else max(.015,tolerance*.2)) if fine else tolerance)[:-1]
                       for part,fine in zip(curves,critical)]+[curves[-1][-1:]])
        p = np.round(p,1)
        p = p[np.r_[True,np.any(np.diff(p,axis=0)!=0,axis=1)]]
        if len(p)<=120:
            return p,tolerance
        tolerance = round(tolerance+.005,3)
        if tolerance>1.0:
            raise ValueError('Cannot fit smoothed route into 120 points')


def budget_curve(curves, weights):
    """Best-first DP on the already smoothed curve, with an exact vertex budget.

    All part endpoints are mandatory. Spend remaining vertices on the largest
    weighted curve error, emphasizing the flagged southern bends rather than
    letting a long northern approach consume the whole 120-point budget.
    """
    chosen = [{0,len(p)-1} for p in curves]
    heap = []
    def push(i,left,right):
        p = curves[i][left:right+1]
        if len(p)<3:
            return
        d = p[-1]-p[0]
        u = np.clip((p-p[0])@d/max(float(d@d),1e-12),0,1)
        error = np.linalg.norm(p-p[0]-u[:,None]*d,axis=1)
        k = int(error.argmax())
        if k not in (0,len(p)-1) and error[k]>.001:
            heapq.heappush(heap,(-float(error[k])*weights[i],i,left,right,left+k))
    for i,p in enumerate(curves):
        push(i,0,len(p)-1)
    count = len(curves)+1
    while heap and count<120:
        score,i,left,right,k = heapq.heappop(heap)
        if -score<.015:
            break
        chosen[i].add(k)
        count += 1
        push(i,left,k);push(i,k,right)
    p = np.vstack([curve[sorted(indices)][:-1] for curve,indices in zip(curves,chosen)]+[curves[-1][-1:]])
    p = np.round(p,1)
    p = p[np.r_[True,np.any(np.diff(p,axis=0)!=0,axis=1)]]
    error = max((-v[0]/weights[v[1]] for v in heap),default=0.)
    return p,round(error,3)


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
    if score>6:
        return None
    ls = lengths(p)/lengths(p)[-1]
    middle = p[(ls>min(fa,fb))&(ls<max(fa,fb))]
    if fa>fb:
        middle = middle[::-1]
    p = np.vstack((pa,middle,pb))
    # Taper the registration correction along the channel rather than sailing
    # out to a city and immediately returning along the same short connector.
    chain = lengths(p)
    span = max(.1,min(6.,chain[-1]/3))
    p += np.maximum(0,1-chain/span)[:,None]*(a-pa)
    p += np.maximum(0,1-(chain[-1]-chain)/span)[:,None]*(b-pb)
    p[0],p[-1] = a,b
    return [p]


def controls(values, cities, proj):
    out = []
    for value in values:
        if isinstance(value,str):
            out.append(stop_position(value))
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
            'max_slope_lonlat':np.round(dem.proj.unproj(*q[int(degrees.argmax())]),5).tolist(),
            'p95_slope_deg':round(float(np.percentile(degrees,95)),2)}


def remap(events, old, new, selected, current):
    out = copy.deepcopy(current)
    table = []
    for e,ref in zip(out,events):
        ends = {}
        for si,(s,rs) in enumerate(zip((e[6] or {}).get('steps',[]),(ref[6] or {}).get('steps',[])),1):
            for a,ra in zip(s[1],rs[1]):
                if a[0]!='m' or a[1] not in selected:
                    continue
                i = a[1]
                name = STEP_STOPS[i][si]
                target = stop_position(name) if name else at(points(old[i][4]),ra[3])
                f,hit,gap = nearest(points(new[i][4]),target)
                f = round(float(f),3)
                a[2:4] = [ends.get(i,0),f]
                if a[3]<=a[2]:
                    raise ValueError(f'Non-monotone semantic stop: {e[1]} step {si} route {i}')
                ends[i] = f
                end = at(points(new[i][4]),f)
                table.append({'battle':e[1],'step':si,'route':i,'stop':name or '下邽（沿用）',
                              'method':'语义地点' if name else '沿用最近点',
                              'fraction':f,'target':np.round(target,3).tolist(),
                              'endpoint':np.round(end,3).tolist(),
                              'gap':round(float(np.linalg.norm(end-target)),3)})
    return out,table


def section(p, first, last):
    ls = lengths(p)/lengths(p)[-1]
    middle = p[(ls>min(first,last)+1e-8)&(ls<max(first,last)-1e-8)]
    if first>last:
        middle = middle[::-1]
    return np.vstack((at(p,first),middle,at(p,last)))


def retreat_path(e,si,ai,route,routes,reference):
    a = e[6]['steps'][si-1][1][ai]
    old = reference[6]['steps'][si-1][1][ai]
    oldp = points(old[1])
    if route=='a':
        attack = next(x for s in e[6]['steps'] for x in s[1] if x[0]=='a')
        p = points(attack[1])[::-1]
    else:
        p = points(routes[route][4])
        start = nearest(p,oldp[0])[0]
        end = nearest(p,oldp[-1])[0]
        if route==38:
            # The army first retraces its advance to Qinzhou, then continues
            # to Xingzhou: preserve the original non-retracing southern leg.
            index = int(np.linalg.norm(oldp-np.array([817.,568.1]),axis=1).argmin())
            p = np.vstack((section(p,start,0),chaikin(oldp[index:])[1:]))
        else:
            p = section(p,start,end)
        if np.linalg.norm(p[0]-oldp[0])>.08:
            p = np.vstack((oldp[0],p))
        if np.linalg.norm(p[-1]-oldp[-1])>.08:
            p = np.vstack((p,oldp[-1]))
    p = np.round(p,1)
    p[0],p[-1] = oldp[0],oldp[-1]
    p = p[np.r_[True,np.any(np.diff(p,axis=0)!=0,axis=1)]]
    a[1] = svg(p)
    # a[3] is the arrow's fixed endpoint; a[4] sets its final tangent.
    a[3] = old[3]
    a[4] = np.round(at(p,max(0,1-2/lengths(p)[-1])),1).tolist()
    return p


def retreats(events, routes, reference):
    for e,old in zip(events,reference):
        for (name,si,ai),route in RETREATS.items():
            if e[1]==name:
                retreat_path(e,si,ai,route,routes,old)


def svg(p):
    return 'M'+'L'.join(f'{x:.1f},{y:.1f}' for x,y in p)


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
                assert 0<=b[2]<b[3]<=1,path
                return
            if a and a[0]=='r' and len(a)>=5:
                event_name = olde[path[0]][1]
                key = (event_name,path[3]+1,path[5]) if len(path)==6 else None
                if key in RETREATS:
                    assert a[0]==b[0] and a[2]==b[2] and a[5:]==b[5:],path
                    assert a[3]==b[3],('retreat arrow endpoint',path)
                    assert np.array_equal(points(a[1])[[0,-1]],points(b[1])[[0,-1]]),path
                    assert nearest(points(b[1]),np.array(b[4]))[2]<.08,path
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
    city_gaps = {}
    table = load('route-waypoints')
    for i in BATCH:
        p = points(newr[i][4])
        for name in table[str(i)]:
            if isinstance(name,str):
                gap = nearest(p,stop_position(name))[2]
                assert gap<=.3,('waypoint city off path',i,name,gap)
                city_gaps[f'{i}:{name}'] = round(gap,3)
    for e,ref in zip(newe,olde):
        for (name,si,ai),route in RETREATS.items():
            if e[1]==name:
                expected = copy.deepcopy(e)
                retreat_path(expected,si,ai,route,newr,ref)
                assert expected[6]['steps'][si-1][1][ai]==e[6]['steps'][si-1][1][ai],('retreat not reversed',name,si,ai)
    return {'reference_events_equal_except_m_and_r':True,'routes_changed':changed,
            'endpoints_preserved':True,'fractions_continuous_monotone':True,
            'waypoint_city_gaps':city_gaps,'retreats_match_reversed_routes':True,
            'nanhan_valley_separation':round(nanhan_separation(points(newr[3][4])),3)}


def nanhan_separation(p):
    f = {name:nearest(p,stop_position(name))[0] for name in ('贺州','昭州','连州')}
    incoming = resample(section(p,f['贺州'],f['昭州']),.1)
    outgoing = resample(section(p,f['昭州'],f['连州']),.1)
    city = stop_position('昭州')
    incoming = incoming[np.linalg.norm(incoming-city,axis=1)>2]
    outgoing = outgoing[np.linalg.norm(outgoing-city,axis=1)>2]
    gap = min(nearest(incoming,q)[2] for q in outgoing)
    assert gap>=1.5,('Zhaozhou return retraces the incoming valley',gap)
    return gap


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
    parser.add_argument('--only',type=lambda v:{int(i) for i in v.split(',')},help='Comma-separated route indexes')
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
    if args.only and args.route is not None:
        parser.error('--only and positional route are mutually exclusive')
    oldr, olde = baseline(args.reference,'routes'),baseline(args.reference,'events')
    newr, newe = load('routes'),load('events')
    table, cities, proj = load('route-waypoints'),load('cities'),Projection()
    selected = args.only or ({args.route} if args.route is not None else {int(k) for k in table})
    if not selected <= BATCH:
        parser.error('This pilot only authorizes the listed 15 route indexes')
    dem = DEM(args.cache.resolve(),proj)
    previous = baseline('dee716b','routes')
    tolerances = {}
    if not args.verify:
        for i in sorted(selected):
            original = points(oldr[i][4])
            values = json.loads(args.waypoints) if args.waypoints else table[str(i)]
            cp = [original[0],*controls(values,cities,proj),original[-1]]
            cp = np.array([p for k,p in enumerate(cp) if k==0 or np.linalg.norm(p-cp[k-1])>.02])
            if i==65:
                parts = river_parts(cp[0],cp[-1],[])
                if parts is None:
                    raise ValueError('Missing Jialing river channel')
            else:
                parts = []
                for k,(a,b) in enumerate(zip(cp,cp[1:])):
                    river = river_parts(a,b,[]) if i==2 and k<3 else None
                    if i==2 and k<3 and river is None:
                        raise ValueError('Missing Yangtze channel')
                    avoid = np.vstack(parts) if i==3 and 8<=k<=11 else None
                    if river is not None:
                        parts.extend(river)
                    elif i in {1,26,28,30,38}:
                        # The operator accepted these corridors. Smooth their
                        # existing DEM solution instead of choosing another valley.
                        guide = points(previous[i][4])
                        fa,_,da = nearest(guide,a)
                        fb,_,db = nearest(guide,b)
                        if max(da,db)>3:
                            parts.append(dem.trace(a,b,avoid))
                        elif abs(fa-fb)<1e-7:
                            parts.append(np.array([a,b]))
                        else:
                            part = section(guide,fa,fb)
                            chain = lengths(part)
                            span = max(.1,min(3.,chain[-1]/3))
                            part += np.maximum(0,1-chain/span)[:,None]*(a-part[0])
                            part += np.maximum(0,1-(chain[-1]-chain)/span)[:,None]*(b-part[-1])
                            part[0],part[-1] = a,b
                            parts.append(part)
                    else:
                        parts.append(dem.trace(a,b,avoid))
            p,tolerance = finish(parts,i)
            p[0],p[-1] = original[0],original[-1]
            newr[i][4],newr[i][5] = svg(p),label(p,cities)
            tolerances[str(i)] = tolerance
            print(f'Traced {i}: {len(p)} points; curve tolerance {tolerance}',flush=True)
        newe,stops = remap(olde,oldr,newr,selected,newe)
        retreats(newe,newr,olde)
    expected,stops = remap(olde,oldr,newr,BATCH,newe)
    assert expected==newe,'Stored m fractions differ from semantic stop table'
    for row in stops:
        if row['method']=='语义地点' and row['route']!=65:
            assert row['gap']<=.3,('Semantic stop too far from city',row)
    verification = verify(oldr,newr,olde,newe)
    report = {'reference':args.reference,'verification':verification,
              'curve_tolerances':tolerances,'stops':stops,'routes':{}}
    for i in sorted(selected):
        before,prior,after = (metrics(points(r[i][4]),dem) for r in (oldr,previous,newr))
        report['routes'][str(i)] = {'old':before,'previous':prior,'new':after,
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
    print(json.dumps(verification,ensure_ascii=False))


if __name__=='__main__':
    main()
