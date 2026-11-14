// 把 src/ + data/ + assets/ 拼成一个可离线打开的单文件 HTML，输出到 dist/。
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {loadData} from './data.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rd=p=>readFileSync(join(root,p),'utf8');
const {BASE,HIST,C}=loadData(root);
const relief='data:image/jpeg;base64,'+readFileSync(join(root,'assets/relief.jpg')).toString('base64');
const J=v=>JSON.stringify(v).replace(/<\//g,'<\\/');
const data=`const BASE=${J(BASE)};\nconst HIST=${J(HIST)};\nconst C=${J(C)};\nconst RELIEF=${J(relief)};`;
let html=rd('src/index.html');
const put=(mark,s)=>{if(!html.includes(mark))throw new Error('模板缺少 '+mark);html=html.replace(mark,()=>s)};
put('/*@css*/',rd('src/style.css'));put('/*@data*/',data);put('/*@js*/',rd('src/app.js'));
const title=html.match(/<title>(.*?)<\/title>/)[1];
mkdirSync(join(root,'dist'),{recursive:true});
const out=join(root,'dist',title+'.html');writeFileSync(out,html);
console.log(`dist/${title}.html  ${(html.length/1024).toFixed(0)} KB`);
