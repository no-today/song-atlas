// 数据互相引用的一致性检查。任何一条失败都以非零码退出，build 前自动运行。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {loadData,narrations} from './data.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const {HIST,C}=loadData(root);
const Y0=+readFileSync(join(root,'src/app.js'),'utf8').match(/const Y0=(\d+)/)[1], Y1=1279;
const err=[],warn=[];const bad=m=>err.push(m);
const pick=(o,y)=>{let b=null;for(const k in o)if(+k<=y&&(b===null||+k>b))b=+k;return b===null?null:o[b]};
const used=new Set();
const shape=(h,w)=>{used.add(h);if(!HIST.shapes[h])bad(`${w}: 疆域形状 ${h} 不存在`)};

let prev=0;
for(const s of HIST.snaps){const w=`态势 ${s.y}`;
  if(s.y<=prev)bad(`${w}: 年份未递增`);prev=s.y;if(s.y<Y0||s.y>Y1)bad(`${w}: 超出 ${Y0}—${Y1}`);
  if(!C.shi[s.y])bad(`${w}: 缺格局提要 shi`);if(!C.chg[s.y])bad(`${w}: 缺疆土变化 chg`);
  if(!pick(C.force,s.y))bad(`${w}: 无兵力 force`);
  for(const [id,h] of [...s.p,...s.g]){shape(h,w);if(!C.pol[id])bad(`${w}: 政权 ${id} 不在 pol`)}
  for(const [id] of s.p)if(C.lab[id]&&!pick(C.lab[id],s.y))warn.push(`${w}: ${id} 无标注位置`)}
const S0=HIST.snaps[0].y;
for(const k of Object.keys(C.shi))if(!HIST.snaps.some(s=>s.y===+k))bad(`shi ${k}: 无对应态势`);
for(const k of ['songtxt','mongtxt','dvtxt','force'])for(const y in C[k])if(+y<S0)bad(`${k} ${y}: 早于首幅态势 ${S0}，永远取不到`);
for(const id in C.lab)for(const y in C.lab[id])if(+y<S0)bad(`lab.${id} ${y}: 早于首幅态势`);
for(const id in C.names)for(const y in C.names[id])if(+y<S0)bad(`names.${id} ${y}: 早于首幅态势`);
const inSnap=new Set(HIST.snaps.flatMap(s=>s.p.map(p=>p[0])));
for(const id in C.pol)if(!inSnap.has(id))warn.push(`pol.${id}: 没有任何态势用到`);

const range=(r,w)=>{if(r[0]>r[1])bad(`${w}: 起止颠倒`);if(r[0]<Y0||r[1]>Y1)bad(`${w}: ${r[0]}—${r[1]} 超出 ${Y0}—${Y1}`)};
C.txt.forEach(t=>range([t[3],t[4]],`地名 ${t[0]}`));
C.city.forEach(c=>range([c[3],c[4]],`城邑 ${c[0]}`));
C.gar.forEach(g=>range([g[3],g[4]],`驻军 ${g[0]}`));
C.riv.forEach(r=>range([r[1],r[2]],`河道 ${r[4]||r[0]}`));

const evNames=new Set(C.ev.map(e=>e[1]));
C.rt.forEach((r,i)=>{range([r[1],r[2]],`路线#${i} ${r[0]}`);
  if(r[7]!==undefined){const [u,n,q,k]=r[7],w=`路线#${i} ${r[0]} 兵力`;
    if(typeof u!=='string'||!u||u.length>8)bad(`${w}: 部队名须为 1—8 字`);if(!Number.isInteger(n)||n<0)bad(`${w}: 人数须为非负整数（不详写 0）`);
    if(!['约','号',''].includes(q))bad(`${w}: 口径须为 约/号/空`);if(!['骑','步','舟','混'].includes(k))bad(`${w}: 兵种须为 骑/步/舟/混`)}
  else if(process.env.STRICT_ARMY)bad(`路线#${i} ${r[0]}: 缺兵力 r[7]`);if(r[6]&&!evNames.has(r[6]))bad(`路线#${i} ${r[0]}: 所属战役「${r[6]}」不存在`)});
prev=0;
C.ev.forEach((e,i)=>{const w=`大事 ${e[0]} ${e[1]}`;if(e[0]<prev)bad(`${w}: 未按年份排序`);prev=e[0];if(e[0]<Y0||e[0]>Y1)bad(`${w}: 超出范围`);
  if(!e[6])return;
  (e[8]||[]).forEach(j=>{if(!C.city[j])bad(`${w}: 相关城邑 #${j} 不存在`)});
  e[6].steps.forEach((st,k)=>st[1].forEach(a=>{
    if(a[0]==='m'){const r=C.rt[a[1]];if(!r)bad(`${w} 第${k+1}步: 路线 #${a[1]} 不存在`);else if(r[6]!==e[1])bad(`${w} 第${k+1}步: 路线 #${a[1]} 属于「${r[6]}」`)}
    if(a[0]==='z')shape(a[1],`${w} 第${k+1}步`)}));
  if(e[6].s.length!==e[6].loss.length)bad(`${w}: 参战方与伤亡条数不一致`)});
const ids=new Set();let last=0;
for(const ch of C.chap){const w=`章节「${ch.t}」`;
  for(const k of ['id','t','span','q','stops','a'])if(!ch[k])bad(`${w}: 缺 ${k}`);
  if(ids.has(ch.id))bad(`${w}: id 重复`);ids.add(ch.id);if(!/^[a-z0-9-]+$/.test(ch.id||''))bad(`${w}: id 只用小写字母、数字、连字符`);
  if(ch.span&&ch.span[0]<last)bad(`${w}: 未按年代排序`);last=ch.span?.[0]||last;
  (ch.stops||[]).forEach((st,k)=>{const sw=`${w} 第${k+1}站`;if(!st.y||!st.h||!st.x)bad(`${sw}: 缺 y/h/x`);
    if(st.y<ch.span[0]||st.y>ch.span[1])bad(`${sw}: 年份 ${st.y} 不在本章 ${ch.span.join('—')}`);
    if(st.b){const e=C.ev.find(e=>e[1]===st.b);if(!e||!e[6])bad(`${sw}: 战役「${st.b}」不存在或没有解说`);else if(e[0]!==st.y)bad(`${sw}: 战役「${st.b}」在 ${e[0]} 年，不是 ${st.y}`)}})}
// 讲稿：引用存在、顺序按年、每场战役的步骤按序各一次；缺漏在 STRICT_FILM=1 时报错（改写完成前只提示）
{const snapY=new Set(HIST.snaps.map(s=>s.y)),seen=new Map(),miss=process.env.STRICT_FILM?bad:m=>warn.push(m);let py=0;
  C.film.forEach((f,i)=>{const w=`讲稿 ${f.file} 第${i+1}条`;
    if(typeof f.t!=='string'||!f.t.trim())bad(`${w}: 缺讲稿 t`);
    if(f.name!==undefined){if(f.e<0)return bad(`${w}: 大事「${f.name}」不存在`);const b=C.ev[f.e][6],n=b?b.steps.length:0,st=seen.get(f.e)||{intro:0,k:0,end:0};seen.set(f.e,st);
      if(f.s===undefined){if(st.intro||st.k||st.end)bad(`${w}: 「${f.name}」的大事讲解重复或在战役步骤之后`);st.intro++}
      else if(f.s==='end'){if(!n)bad(`${w}: 「${f.name}」没有战役，不能有 end`);if(st.end||(process.env.STRICT_FILM&&st.k!==n))bad(`${w}: 「${f.name}」的 end 须在全部 ${n} 步之后且只一条`);st.end++}
      else if(!Number.isInteger(f.s)||f.s<1||f.s>n)bad(`${w}: 「${f.name}」没有第 ${f.s} 步`);
      else{if(f.s!==st.k+1||st.end)bad(`${w}: 「${f.name}」第 ${f.s} 步顺序不对（上一步 ${st.k}）`);st.k=f.s}}
    else if(!snapY.has(f.y))bad(`${w}: ${f.y} 年没有态势`);
    if(f.y<py)bad(`${w}: 年份 ${f.y} 早于上一条 ${py}`);py=Math.max(py,f.y)});
  C.ev.forEach((e,i)=>{const st=seen.get(i),n=e[6]?e[6].steps.length:0;if(!st)miss(`讲稿缺大事 ${e[0]} ${e[1]}`);else if(st.k!==n)miss(`讲稿「${e[1]}」只有 ${st.k}/${n} 步`)})}
for(const h in HIST.shapes)if(!used.has(h))warn.push(`形状 ${h} 未被引用`);

warn.slice(0,20).forEach(m=>console.log('提示 '+m));if(warn.length>20)console.log(`提示 …共 ${warn.length} 条`);
err.forEach(m=>console.error('错误 '+m));
console.log(err.length?`检查未通过：${err.length} 处错误`:`检查通过（${HIST.snaps.length} 幅态势、${C.ev.length} 条大事、${C.rt.length} 条路线、${C.chap.length} 章）`);
console.log(`讲稿 ${C.film.length} 段，配音 ${C.film.filter(f=>f.au).length}/${C.film.length}`);
process.exit(err.length?1:0);
