// data/*.json → 页面脚本用的 BASE / HIST / C 三个对象（字段名沿用 app.js）。
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
// 讲稿：data/film/*.json 按文件名顺序拼接即全片播放顺序。每条一种：
//   {e:大事名, t}         大事讲解（战役在其后逐步演示）
//   {e:大事名, s:k, t}    战役第 k 步（从 1 起）的讲解
//   {e:大事名, s:"end", t} 战役演完后的收尾
//   {y:态势年, t}         换一幅疆域态势时的格局
// 组装后 C.film=[{y, e:大事下标|-1, s, t, ch, au?, tm?}]，配音 narrations() 只来自讲稿。
const CHAPTERS={'01':'五代纷争与燕云','02':'太祖统一','03':'宋辽交兵','04':'澶渊以后','05':'变法与开边','06':'金灭辽与靖康','07':'南渡与宋金对峙','08':'采石至开禧','09':'蒙古崛起','10':'宋亡'};
export function narrations(C){
  return C.film.map(f=>({text:f.t,set:url=>{f.au=url},setTm:arr=>{f.tm=arr}}));
}
function loadFilm(root,C){
  const dir=join(root,'data','film');if(!existsSync(dir))return [];
  const out=[];
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.json')).sort())
    for(const r of JSON.parse(readFileSync(join(dir,file),'utf8'))){
      const e=r.e===undefined?-1:C.ev.findIndex(x=>x[1]===r.e);
      out.push({file,y:e>=0?C.ev[e][0]:r.y,e,name:r.e,s:r.s,t:r.t,ch:+file.slice(0,2)-1});
    }
  return out;
}
export function loadData(root){
  const j=f=>JSON.parse(readFileSync(join(root,'data',f+'.json'),'utf8'));
  const BASE=j('base'),HIST={shapes:j('shapes'),snaps:j('snaps')};
  const C={...j('polities'),...j('narrative'),txt:j('labels'),city:j('cities'),riv:j('rivers'),gar:j('garrisons'),rt:j('routes'),ev:j('events')};
  // 章节：v 可写城邑全名或 [x,y]，这里换成取景框 [x0,y0,x1,y1]
  C.chap=existsSync(join(root,'data','chapters.json'))?j('chapters'):[];
  for(const ch of C.chap)for(const st of ch.stops)if(st.v){const pts=st.v.map(p=>{if(Array.isArray(p))return p;const c=C.city.find(c=>c[0]===p);if(!c)throw new Error(`章节「${ch.t}」: 城邑「${p}」不存在`);return [c[1],c[2]]});
    st.v=[Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))]}
  C.alias=existsSync(join(root,'data','alias.json'))?j('alias'):{};
  C.film=loadFilm(root,C);
  if(existsSync(join(root,'data','voice.json'))){
    const voice=j('voice');
    for(const {text,set,setTm} of narrations(C)){
      const tsha=createHash('sha256').update(text).digest('hex').slice(0,16);
      if(voice.au[tsha])set(voice.base+'/'+voice.au[tsha]);
      if(voice.tm?.[tsha])setTm(voice.tm[tsha]);
    }
  }
  C.chapters=Object.entries(CHAPTERS).sort(([a],[b])=>a.localeCompare(b)).map(([key,t])=>{const ch=+key-1,rows=C.film.filter(f=>f.ch===ch);
    const d=rows.reduce((sum,f)=>{if(!f.tm?.length)return sum+f.t.length*.22;let cs=0;for(let k=0;k<f.tm.length;k+=2)cs+=f.tm[k];return sum+cs/100+.6},0);
    return {t,i:C.film.findIndex(f=>f.ch===ch),n:rows.length,d:Math.round(d)};});
  return {BASE,HIST,C};
}
