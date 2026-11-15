// 先按 data/shape-fixes.json 修整基础态势，再由 data/snap-edits.json 派生，写回 snaps.json / shapes.json / snaps-raw.json。
// shape-fixes: [{years:[起,止],ops:[…]}]，只作用于非派生幅，不生成「新易手」g。
// data/snaps-raw.json 保存修形幅底稿 {年:[[政权id,原形状键,原路径],…]}，每次从底稿重算；不装入页面。
// snap-edits: {"<年>":{from:<基准态势年>,era,t,ops:[…]}}，按年处理，基准可以是另一幅派生态势。
// ops 依次执行，area 的顶点为 [经度,纬度] 或 cities.json 城邑全名：
//   {op:"move",to:"song",from:["xia","tibet"],area:[…]}  交集划给 to，省略 area 则全并；派生时记入 g
//   {op:"remove",id:"tsongkha"}                         删去该政权（领土留空）
//   {op:"set",id:"x",area:[…]}                          以 area 覆盖疆域，并从同幅其他政权扣除
//   {op:"set",id:"x",like:[1044,"xia"],area:[…]}         以指定年政权形状 ∩ area 覆盖；模板取修形前的态势
//   {op:"add",id:"x",like:[1044,"xia"],area:[…]}         将模板 ∩ area 并入 x，并从其他政权扣除；派生时新增部分记 g
//   {op:"cut",id:"x",area:[…]}                          从 x 挖掉 area，留作无主地，不记 g
//   {op:"rename",id:"liao",as:"beiliao"}                 换政权 id（沿用形状）
// 海岸由渲染按陆地裁切；不手改派生结果。重复 derive 应得到完全相同的文件。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {proj,parsePath,toPath,hash,union,difference,intersection} from './geo.mjs';
import {writeJson} from './json.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..'),D=f=>join(root,'data',f+'.json');
const rd=f=>JSON.parse(readFileSync(D(f),'utf8'));
const edits=rd('snap-edits'),fixes=rd('shape-fixes'),raw=rd('snaps-raw'),shapes=rd('shapes'),cities=rd('cities'),events=rd('events');
const original=rd('snaps').map(s=>{const {rawP,...base}=s;return raw[s.y]?{...base,p:raw[s.y].map(([id,h,d])=>{shapes[h]=d;return [id,h]})}:base});
let snaps=original.filter(s=>!edits[s.y]);
const cityAt=n=>{const c=cities.find(c=>c[0]===n);if(!c)throw new Error(`城邑「${n}」不在 cities.json`);return [c[1],c[2]]};
// 经纬度反投影所得的 area 与模板可能共边；压掉浮点尾差，避免裁切库把同一条边误认成极细环。
const poly=area=>{const r=area.map(p=>(typeof p==='string'?cityAt(p):proj(p[0],p[1])).map(v=>Math.round(v*1e8)/1e8));r.push(r[0]);return [[r]]};
const put=mp=>{const d=toPath(mp);if(!d)return null;const h=hash(d);shapes[h]=d;return h};
const mpArea=mp=>mp.reduce((sum,p)=>sum+p.reduce((sum,r,i)=>sum+(i?-1:1)*Math.abs(r.reduce((a,v,j)=>{const n=r[(j+1)%r.length];return a+v[0]*n[1]-n[0]*v[1]},0)/2),0),0);

function apply(base,ops,w,highlight){
  const geo=new Map(base.p.map(([id,h])=>[id,parsePath(shapes[h])])),order=base.p.map(p=>p[0]),gain=[],changed=new Set(),hashes=new Map(base.p);
  const need=id=>{if(!geo.has(id))throw new Error(`${w}: ${base.y} 年态势里没有 ${id}`);return geo.get(id)};
  const drop=id=>{geo.delete(id);order.splice(order.indexOf(id),1)};
  const save=(id,g)=>{changed.add(id);if(!g.length){if(geo.has(id))drop(id);return}if(!geo.has(id))order.push(id);geo.set(id,g)};
  for(const o of ops){
    const area=o.area?poly(o.area):null;
    if(o.op==='move'){let got=[];
      for(const id of o.from){const g=need(id),part=area?intersection(g,area):g;if(!part.length){console.warn(`${w}: move→${o.to} 与 ${id} 无交集`);continue}
        got=got.length?union(got,part):part;save(id,area?difference(g,area):[])}
      if(!got.length)continue;
      save(o.to,geo.has(o.to)?union(geo.get(o.to),got):got);
      if(highlight)gain.push([o.to,got])}
    else if(o.op==='remove'){need(o.id);drop(o.id)}
    else if(o.op==='set'||o.op==='add'){
      if(!area)throw new Error(`${w}: ${o.op} 缺少 area`);
      if(o.op==='add'&&!o.like)throw new Error(`${w}: add 缺少 like`);
      let a=area;
      if(o.like){const [y,id]=o.like,h=original.find(s=>s.y===y)?.p.find(p=>p[0]===id)?.[1];
        if(!h)throw new Error(`${w}: 模板 ${y} 年 ${id} 不存在`);
        a=intersection(parsePath(shapes[h]),area)}
      const added=o.op==='add'&&geo.has(o.id)?difference(a,geo.get(o.id)):a;
      // 共边反投影会产生约 1e-8 图上单位的薄边，不让这种数值噪声改写邻国路径。
      for(const [id,g] of geo)if(id!==o.id&&mpArea(intersection(g,a))>1e-5)save(id,difference(g,a));
      save(o.id,o.op==='add'&&geo.has(o.id)?union(geo.get(o.id),a):a);if(highlight&&added.length)gain.push([o.id,added])}
    else if(o.op==='cut'){
      if(!area)throw new Error(`${w}: cut 缺少 area`);
      save(o.id,difference(need(o.id),area))}
    else if(o.op==='rename'){const g=need(o.id);geo.delete(o.id);geo.set(o.as,g);changed.add(o.as);order[order.indexOf(o.id)]=o.as}
    else throw new Error(`${w}: 未知 op ${o.op}`)}
  return {p:order.map(id=>[id,changed.has(id)?put(geo.get(id)):hashes.get(id)]).filter(p=>p[1]),g:highlight?gain.map(([id,g])=>[id,put(g)]).filter(p=>p[1]):base.g};
}

const fixed=new Set();
for(const f of fixes){
  const [from,to]=f.years;
  if(!Number.isInteger(from)||!Number.isInteger(to)||from>to)throw new Error('shape-fixes: years 应为 [起年,止年]');
  snaps=snaps.map(s=>{if(s.y<from||s.y>to)return s;
    fixed.add(s.y);raw[s.y]??=s.p.map(([id,h])=>[id,h,shapes[h]]);
    return {...s,...apply(s,f.ops,`修形 ${s.y}`,false)}});
}
for(const y of Object.keys(edits).map(Number).sort((a,b)=>a-b)){
  const e=edits[y],w=`派生 ${y}`,base=snaps.find(s=>s.y===e.from);if(!base)throw new Error(`${w}: 基准态势 ${e.from} 不存在`);
  const s={y,era:e.era,t:e.t,...apply(base,e.ops,w,true)};
  snaps.push(s);snaps.sort((a,b)=>a.y-b.y);console.log(`${y} ← ${e.from}：${s.p.length} 个政权，新易手 ${s.g.map(g=>g[0]).join('、')||'无'}`)
}

// 清掉不再被引用的形状
const used=new Set([...snaps.flatMap(s=>[...s.p,...s.g].map(p=>p[1])),...events.flatMap(e=>e[6]?e[6].steps.flatMap(st=>st[1].filter(a=>a[0]==='z').map(a=>a[1])):[])]);
for(const h in shapes)if(!used.has(h))delete shapes[h];
writeJson(D('snaps'),snaps);writeJson(D('shapes'),shapes);
writeJson(D('snaps-raw'),Object.fromEntries([...fixed].sort((a,b)=>a-b).map(y=>[y,raw[y]])));
