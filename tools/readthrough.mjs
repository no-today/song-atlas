// 通读稿：把 data/film/*.json 按播放顺序排成一份 Markdown，一句一行，段号即 #f=段号。
// 用法：node tools/readthrough.mjs              → 写 dist/全片讲稿-通读稿.md
//       node tools/readthrough.mjs --apply 文件  → 把改过的通读稿（可只含部分段）按段号写回 data/film
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..'),dir=join(root,'data/film');
const files=readdirSync(dir).filter(f=>f.endsWith('.json')).sort();
const film=files.map(f=>({f,a:JSON.parse(readFileSync(join(dir,f),'utf8'))}));
const save=({f,a})=>writeFileSync(join(dir,f),'[\n'+a.map(x=>JSON.stringify(x)).join(',\n')+'\n]\n');

const ai=process.argv.indexOf('--apply');
if(ai>0){
  const segs={};let cur=null;
  for(const l of readFileSync(process.argv[ai+1],'utf8').split('\n')){
    const m=/^(###|\*\*).*#(\d+)\**\s*$/.exec(l);if(m){cur=+m[2];segs[cur]=[];continue}
    if(cur&&l.trim()&&!/^##\s/.test(l))segs[cur].push(l.trim())}
  let n=0,ch=0;const dirty=new Set();
  for(const F of film)for(const x of F.a){n++;if(segs[n]){const t=segs[n].join('');if(t!==x.t){x.t=t;ch++;dirty.add(F)}}}
  dirty.forEach(save);console.log(`读到 ${Object.keys(segs).length} 段，改了 ${ch} 段`);process.exit(0)}

const E=JSON.parse(readFileSync(join(root,'data/events.json'),'utf8'));
const yr=n=>E.find(e=>e[1]===n)?.[0]??'';
const lines=t=>t.match(/[^。！？]+[。！？]+[”」]?|[^。！？]+$/g).map(s=>s.trim()).join('\n\n');
const out=['# 五代两宋舆地沿革图 · 全片讲稿通读稿','','按播放顺序排列，一句一行。段号即页面地址 `#f=段号`。改完可用 `node tools/readthrough.mjs --apply 文件` 写回（只含部分段也可）。',''];
let n=0,chars=0,cur=null;
for(const {f,a} of film){out.push(`## ${f.replace('.json','')}`,'');
  for(const x of a){n++;chars+=x.t.length;
    if(x.y){out.push(`### 【态势】${x.y}　#${n}`);cur=null}
    else if(x.s===undefined){out.push(`### 【大事】${yr(x.e)} ${x.e}　#${n}`);cur=x.e}
    else{if(cur!==x.e){out.push(`### 【大事】${yr(x.e)} ${x.e}（续）`,'');cur=x.e}out.push(x.s==='end'?`**【收尾】#${n}**`:`**${x.s}.　#${n}**`)}
    out.push('',lines(x.t),'')}}
out.splice(3,0,`共 ${n} 段，约 ${Math.round(chars/1000)} 千字。`,'');
mkdirSync(join(root,'dist'),{recursive:true});
writeFileSync(join(root,'dist/全片讲稿-通读稿.md'),out.join('\n'));console.log(`dist/全片讲稿-通读稿.md  ${n} 段 ${chars} 字`);
