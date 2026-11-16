// 冒烟测试：用本机 Chrome 无头打开 dist 产物，逐年拖动、逐段走完全片、逐个战役走完每一步，收集脚本异常。
// 用法：npm run smoke（需先 build；CHROME 环境变量可指定浏览器路径）
import {spawn} from 'node:child_process';
import {readdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const file=readdirSync(join(root,'dist')).find(f=>f.endsWith('.html'));
if(!file){console.error('dist/ 里没有产物，先 npm run build');process.exit(1)}
const chrome=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port=9300+Math.floor(Math.random()*500);
const proc=spawn(chrome,['--headless=new','--disable-gpu','--mute-audio',`--remote-debugging-port=${port}`,`--user-data-dir=${mkdtempSync(join(tmpdir(),'smoke-'))}`,'--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<50&&!tabs;i++){await sleep(200);try{tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json()}catch{}}
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const wait=new Map(),errs=[];
ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&wait.has(d.id)){wait.get(d.id)(d);wait.delete(d.id)}
  if(d.method==='Runtime.exceptionThrown')errs.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text)};
const send=(method,params={})=>new Promise(r=>{wait.set(++id,r);ws.send(JSON.stringify({id,method,params}))});
const run=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.result.exceptionDetails)errs.push(r.result.exceptionDetails.exception?.description);return r.result.result?.value};
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:pathToFileURL(join(root,'dist',file)).href});
// 等页面脚本跑完（产物变大后固定等待会偶发抢跑）
for(let i=0;i<75;i++){await sleep(200);const r=await send('Runtime.evaluate',{expression:"typeof year!=='undefined'&&typeof C!=='undefined'",returnByValue:true});if(r.result.result?.value)break}
const res=await run(`(async()=>{const t=()=>new Promise(r=>setTimeout(r,0));
  const out={init:[year,$('n-snap').textContent]};
  for(let y=Y0;y<=1279;y++)userYear(y);
  for(const i of BATTLES){enterBattle(i);for(let k=0;k<bt.steps.length;k++)showStep(k,false);await t()}
  leaveBattle(true);
  history.replaceState(null,'','#f=3');route();out.f3=film.on&&film.i===2&&!film.playing;
  // 电影式界面：题签有字；播放中静止后控制条隐去，暂停即常驻
  film.playing=true;uiHide();const hid=wrap.classList.contains('idle');film.playing=false;uiShow();out.ui=!!$('nr-cap').textContent&&hid&&!wrap.classList.contains('idle');
  history.replaceState(null,'','#c=x&s=2');route();filmEnd();
  // 战役中自动细览：开关可点、只切本场；退出战役恢复原来的细览状态
  enterBattle(BATTLES[0]);const bx0=svg.classList.contains('bx');$('exptoggle').click();const bx1=svg.classList.contains('bx');leaveBattle(true);
  out.bx=bx0&&!bx1&&$('exptoggle').getAttribute('aria-checked')==='false'&&!svg.classList.contains('bx');
  $('exptoggle').click();userYear(1111);out.film=FILM.length;
  out.battles=BATTLES.length;out.snaps=SNAP.length;return out})()`);
// 画面同步：全片每段、每战每步按 0、1/3、2/3、末尾 喂读字位置再打断（不等音频）；全片里开着播放标记以走到镜头分支
const sync=await run(`(async()=>{const t=()=>new Promise(r=>setTimeout(r,0));let n=0;
  const feed=s=>{for(const f of [0,1/3,2/3,1])narrPos(s,Math.floor(s.length*f));narrPos(null);n++};
  filmOpen(0);for(let i=0;i<FILM.length;i++){filmShow(i);film.playing=true;feed(FILM[i].t);film.playing=false;await t()}
  filmEnd();
  for(const i of BATTLES){enterBattle(i);setPlay(false);for(let k=0;k<bt.steps.length;k++){showStep(k,false);feed(stepNarr(k).t)}await t()}
  leaveBattle(true);return n})()`);
console.log('初始',res?.init?.join(' · '),`| 态势 ${res?.snaps}，战役 ${res?.battles}，全片 ${res?.film} 段，画面同步 ${sync} 段`);
if(res&&!res.f3)errs.push('#f=3 打开后应停在第 3 段、处于暂停');
if(res&&!res.bx)errs.push('战役中应自动细览、开关只切本场，退出后恢复原细览状态');
if(res&&!res.ui)errs.push('题签应有字；播放中静止后控制条应隐去、暂停时应常驻');
if(await run("location.protocol!=='file:'||$('g-tiles').childElementCount!==0||performance.getEntriesByType('resource').some(r=>/\\/tiles\\//.test(r.name))"))errs.push('file:// 下 g-tiles 应为空，且不应请求瓦片');
ws.close();proc.kill();
if(errs.length){errs.forEach(e=>console.error('异常',e));process.exit(1)}console.log('冒烟通过：无脚本异常');
