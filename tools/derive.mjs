// 由 data/snap-edits.json 派生新的疆域态势，写回 snaps.json / shapes.json。可重复运行（同年份会被覆盖）。
//
// snap-edits.json 结构：{ "<年>": { from:<基准态势年>, era, t, ops:[…] } }，按年份顺序处理，基准可以是另一幅派生态势。
// ops 依次执行，area 是多边形顶点数组，每个点为 [经度,纬度] 或 cities.json 里的城邑全名（取其坐标）：
//   {op:"move", to:"song", from:["xia","tibet"], area:[…]}   area 与 from 各政权的交集划给 to（to 不存在则新建），记入「新易手」高亮
//   {op:"move", to:"jin",  from:["liao"]}                     不给 area = from 的全部疆域并入 to
//   {op:"remove", id:"tsongkha"}                               删去该政权（领土留空）
//   {op:"set", id:"x", area:[…]}                              直接以 area 为该政权疆域（会从其他政权中扣除）
//   {op:"rename", id:"liao", as:"beiliao"}                     换政权 id（沿用形状）
// 海岸会在渲染时按陆地裁切，area 伸进海里无妨。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {proj,parsePath,toPath,hash,union,difference,intersection} from './geo.mjs';
import {writeJson} from './json.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..'),D=f=>join(root,'data',f+'.json');
const rd=f=>JSON.parse(readFileSync(D(f),'utf8'));
const edits=rd('snap-edits'),shapes=rd('shapes'),cities=rd('cities'),events=rd('events');
let snaps=rd('snaps').filter(s=>!edits[s.y]);
const cityAt=n=>{const c=cities.find(c=>c[0]===n);if(!c)throw new Error(`城邑「${n}」不在 cities.json`);return [c[1],c[2]]};
const poly=area=>{const r=area.map(p=>typeof p==='string'?cityAt(p):proj(p[0],p[1]));r.push(r[0]);return [[r]]};
const put=mp=>{const d=toPath(mp);if(!d)return null;const h=hash(d);shapes[h]=d;return h};

for(const y of Object.keys(edits).map(Number).sort((a,b)=>a-b)){
  const e=edits[y],w=`派生 ${y}`;const base=snaps.find(s=>s.y===e.from);if(!base)throw new Error(`${w}: 基准态势 ${e.from} 不存在`);
  const geo=new Map(base.p.map(([id,h])=>[id,parsePath(shapes[h])])),order=base.p.map(p=>p[0]),gain=[];
  const need=id=>{if(!geo.has(id))throw new Error(`${w}: ${e.from} 年态势里没有 ${id}`);return geo.get(id)};
  for(const o of e.ops){
    if(o.op==='move'){let got=[];
      for(const id of o.from){const g=need(id),part=o.area?intersection(g,poly(o.area)):g;if(!part.length){console.warn(`${w}: move→${o.to} 与 ${id} 无交集`);continue}
        got=got.length?union(got,part):part;const rest=o.area?difference(g,poly(o.area)):[];if(rest.length)geo.set(id,rest);else{geo.delete(id);order.splice(order.indexOf(id),1)}}
      if(!got.length)continue;
      if(geo.has(o.to))geo.set(o.to,union(geo.get(o.to),got));else{geo.set(o.to,got);order.push(o.to)}
      gain.push([o.to,got])}
    else if(o.op==='remove'){need(o.id);geo.delete(o.id);order.splice(order.indexOf(o.id),1)}
    else if(o.op==='set'){const a=poly(o.area);for(const [id,g] of geo)if(id!==o.id){const r=difference(g,a);if(r.length)geo.set(id,r);else{geo.delete(id);order.splice(order.indexOf(id),1)}}
      if(!geo.has(o.id))order.push(o.id);geo.set(o.id,a);gain.push([o.id,a])}
    else if(o.op==='rename'){const g=need(o.id);geo.delete(o.id);geo.set(o.as,g);order[order.indexOf(o.id)]=o.as}
    else throw new Error(`${w}: 未知 op ${o.op}`)}
  const s={y,era:e.era,t:e.t,p:order.map(id=>[id,put(geo.get(id))]).filter(p=>p[1]),g:gain.map(([id,g])=>[id,put(g)]).filter(p=>p[1])};
  snaps.push(s);snaps.sort((a,b)=>a.y-b.y);console.log(`${y} ← ${e.from}：${s.p.length} 个政权，新易手 ${s.g.map(g=>g[0]).join('、')||'无'}`)}

// 清掉不再被引用的形状
const used=new Set([...snaps.flatMap(s=>[...s.p,...s.g].map(p=>p[1])),...events.flatMap(e=>e[6]?e[6].steps.flatMap(st=>st[1].filter(a=>a[0]==='z').map(a=>a[1])):[])]);
for(const h in shapes)if(!used.has(h))delete shapes[h];
writeJson(D('snaps'),snaps);writeJson(D('shapes'),shapes);
