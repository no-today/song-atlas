// 把 src/ + data/ + assets/ 拼成一个可离线打开的单文件 HTML，输出到 dist/。
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {loadData} from './data.mjs';
import {parsePath,union,difference,toPath} from './geo.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>readFileSync(join(root,p),'utf8');
const {BASE,HIST,C}=loadData(root);
// 先用原始绝对坐标求差集，再对底图和疆域做输出压缩。
const land=parsePath(BASE.land);
const territories=new Map();
for(const snap of HIST.snaps){
  const polygons=snap.p.map(([,hash])=>{
    if(!territories.has(hash))territories.set(hash,parsePath(HIST.shapes[hash]));
    return territories.get(hash);
  });
  snap.fr=toPath(polygons.length?difference(land,union(...polygons)):land);
}
// 构建期紧凑写法：逐点等价的相对折线，源数据与疆域形状键不变。
const compactPath=path=>{let x=0,y=0,line=false;const unit=10**(path.match(/\.\d+/g)||[]).reduce((n,s)=>Math.max(n,s.length-1),0),n=v=>String(v/unit).replace(/^(-?)0\./,'$1.');
  return path.replace(/([ML])(-?[\d.]+),(-?[\d.]+)/g,(all,cmd,a,b)=>{const nx=Math.round(+a*unit),ny=Math.round(+b*unit),out=cmd==='M'?all:`${line&&nx<x?'':'l'}${n(nx-x)}${ny<y?'':','}${n(ny-y)}`;line=cmd==='L';x=nx;y=ny;return out})};
BASE.land=compactPath(BASE.land);BASE.lakes=compactPath(BASE.lakes);BASE.rivers=BASE.rivers.map(compactPath);
for(const h in HIST.shapes)HIST.shapes[h]=compactPath(HIST.shapes[h]);
for(const snap of HIST.snaps)snap.fr=compactPath(snap.fr);
const relief='data:image/jpeg;base64,'+readFileSync(join(root,'assets/relief.jpg')).toString('base64');
const manifest=join(root,'tiles/manifest.json');
const tm=existsSync(manifest)?JSON.parse(readFileSync(manifest,'utf8')):null;
const tiles=tm?{tile:tm.tile,embed:tm.embed?.width||2200,levels:tm.levels.map(l=>[l.z,l.scale,l.cols,l.rows,...(l.present?[l.present]:[])])}:null;
const J=v=>JSON.stringify(v).replace(/<\//g,'<\\/');
const data=`const BASE=${J(BASE)};\nconst HIST=${J(HIST)};\nconst C=${J(C)};\nconst RELIEF=${J(relief)};\nconst TILES=${J(tiles)};`;
let html=rd('src/index.html');
const put=(mark,s)=>{if(!html.includes(mark))throw new Error('模板缺少 '+mark);html=html.replace(mark,()=>s)};
put('/*@css*/',rd('src/style.css'));put('/*@data*/',data);put('/*@js*/',rd('src/app.js'));
const title=html.match(/og:site_name" content="(.*?)"/)[1];
mkdirSync(join(root,'dist'),{recursive:true});
const out=join(root,'dist',title+'.html');writeFileSync(out,html);
console.log(`dist/${title}.html  ${(Buffer.byteLength(html)/1024).toFixed(0)} KB`);
