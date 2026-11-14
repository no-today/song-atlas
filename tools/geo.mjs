// 地理工具：投影、SVG 路径 ⇄ 多边形、布尔运算。
// 底图为兰伯特等角圆锥（中央经线 105°E，标准纬线 25°N、45°N），以下常数由 12 个已知城邑反推，误差 < 1 单位。
// 命令行：
//   node tools/geo.mjs city <名称片段>        城邑的图上坐标与经纬度
//   node tools/geo.mjs border <政权id> <年>   该年态势里此政权疆域的经纬度轮廓（每 N 点取一，默认 8）
//   node tools/geo.mjs ll <经度> <纬度>        经纬度 → 图上坐标
import pc from 'polygon-clipping';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const R=Math.PI/180,P1=25*R,P2=45*R,L0=105*R;
const N=Math.log(Math.cos(P1)/Math.cos(P2))/Math.log(Math.tan(Math.PI/4+P2/2)/Math.tan(Math.PI/4+P1/2));
const F=Math.cos(P1)*Math.pow(Math.tan(Math.PI/4+P1/2),N)/N;
const AX=1671.3154,BX=800.1196,AY=-1671.1172,BY=-1782.1234;
export function proj(lon,lat){const r=F/Math.pow(Math.tan(Math.PI/4+lat*R/2),N),t=N*(lon*R-L0);return [AX*r*Math.sin(t)+BX,AY*-r*Math.cos(t)+BY]}
export function unproj(x,y){const u=(x-BX)/AX,v=(y-BY)/AY;const r=Math.hypot(u,v),t=Math.atan2(u,-v);
  return [(t/N+L0)/R,(2*Math.atan(Math.pow(F/r,1/N))-Math.PI/2)/R]}

const ringsOf=d=>d.split(/Z/i).map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/^M/,'').split('L').map(p=>p.split(',').map(Number)));
const inside=(pt,r)=>{let c=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const [xi,yi]=r[i],[xj,yj]=r[j];if((yi>pt[1])!==(yj>pt[1])&&pt[0]<(xj-xi)*(pt[1]-yi)/(yj-yi)+xi)c=!c}return c};
// 路径 → MultiPolygon（按嵌套深度判定外环/洞，奇偶规则）
export function parsePath(d){const rs=ringsOf(d);
  const depth=rs.map((r,i)=>rs.filter((o,j)=>j!==i&&inside(r[0],o)).length);
  const polys=[];rs.forEach((r,i)=>{if(depth[i]%2===0)polys.push({outer:r,holes:[],i})});
  rs.forEach((r,i)=>{if(depth[i]%2===1){const host=polys.filter(p=>inside(r[0],p.outer)).sort((a,b)=>depth[b.i]-depth[a.i])[0];if(host)host.holes.push(r)}});
  return pc.union(...polys.map(p=>[p.outer,...p.holes].map(close)))}
const close=r=>{const a=r[0],b=r[r.length-1];return a[0]===b[0]&&a[1]===b[1]?r:[...r,a]};
const f1=v=>(Math.round(v*10)/10).toFixed(1);
export function toPath(mp){return mp.map(poly=>poly.map(ring=>{const pts=ring.slice(0,-1);return 'M'+pts.map(p=>f1(p[0])+','+f1(p[1])).join('L')+'Z'}).join('')).join('')}
export const hash=d=>createHash('sha1').update(d).digest('hex').slice(0,8);
export const {union,difference,intersection}=pc;
export const isEmpty=mp=>!mp.length;

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const {loadData}=await import('./data.mjs');const {join,dirname}=await import('node:path');
  const {HIST,C}=loadData(join(dirname(fileURLToPath(import.meta.url)),'..'));
  const [cmd,a,b,c]=process.argv.slice(2);const ll=([x,y])=>unproj(x,y).map(v=>v.toFixed(2)).join(',');
  if(cmd==='city')for(const t of C.city.filter(t=>t[0].includes(a)))console.log(`${t[0]}  图上 ${t[1]},${t[2]}  经纬 ${ll([t[1],t[2]])}  ${t[3]}—${t[4]}`);
  else if(cmd==='ll')console.log(proj(+a,+b).map(f1).join(','));
  else if(cmd==='border'){const s=HIST.snaps.filter(s=>s.y<=+b).at(-1);const e=s.p.find(p=>p[0]===a);if(!e)throw new Error(`${s.y} 年态势里没有 ${a}`);
    const step=+c||8;parsePath(HIST.shapes[e[1]]).forEach((poly,i)=>console.log(`#${i} (${s.y} 年态势) `+poly[0].filter((_,k)=>k%step===0).map(ll).join(' ')))}
  else console.log('用法见文件头注释');
}
