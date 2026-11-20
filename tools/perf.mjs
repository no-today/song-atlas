// 手机性能矩阵。先 npm run build。每个样本新开无头浏览器，场景串行。
// WebKit：在 worktree 外安装 playwright 和 WebKit，NODE_PATH 指向该安装的 node_modules。
// node tools/perf.mjs --engine webkit [--variants 开关,开关 | --probes 文件] [--scenes 场景,场景]
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, readdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';

const {values} = parseArgs({options:{cpu:{type:'string',default:'4'},file:{type:'boolean'},out:{type:'string'},
  engine:{type:'string',default:'chrome'},probes:{type:'string'},'trace-layout':{type:'boolean'},variants:{type:'string'},scenes:{type:'string'},gpu:{type:'string',default:'全部'},runs:{type:'string',default:'3'}}});
const webkitMode=values.engine==='webkit';
if(!['chrome','webkit'].includes(values.engine))throw new Error('--engine 可选 chrome、webkit');
const runs=Number(values.runs);
if (!Number.isSafeInteger(runs)||runs<1) throw new Error('--runs 应为正整数');
const cpu = Number(values.cpu);
if (!Number.isFinite(cpu) || cpu < 1) throw new Error('--cpu 应为不小于 1 的数');
const root = fileURLToPath(new URL('../',import.meta.url));
const html = (await readdir(join(root,'dist'))).find(f=>f.endsWith('.html'));
if (!html) throw new Error('请先 npm run build');
const page = join(root,'dist',html);
const variants = {
  '基线':'',
  '去混色':'.free-gray{mix-blend-mode:normal!important}',
  '去遮罩':'[mask="url(#mfree)"]{mask:none!important}',
  '去背景模糊':'#opening,#narr{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
  '去投影':'#g-bt .supply-cut path,#g-btm .forts path{filter:none!important}',
  '收回舞台':'#stage{will-change:auto!important;inset:0!important}',
  '藏瓦片':'#g-tiles{display:none!important}',
  '藏地形':'#relief,#g-tiles{display:none!important}',
  '藏标注':'#map text{display:none!important}',
  '去字描边':'#map text{paint-order:normal!important;stroke:none!important}',
  '系统字体':':root{--body:"Songti SC","STSong","SimSun",serif!important;--display:"STKaiti","KaiTi","Kaiti SC",serif!important}'
};
const scenes = ['首载','拖图','捏合','年份','飞行','战役','全片'];
function select(key,all) {
  if(values[key]===undefined)return all;
  const names=values[key].split(',').map(s=>s.trim());
  if(names.some(n=>!all.includes(n)))throw new Error(`--${key} 可选：${all.join(',')}`);
  return all.filter(n=>names.includes(n));
}
const experiments=['分离文字层','行军跳终态','文字层contain'];
// --probes 是工作区外的 JSON 数组 [{name,css}]，相机对照用 {name,camera:'scale'|'viewBox'}。
const probes=values.probes?JSON.parse(await readFile(values.probes,'utf8')):[];
for(const probe of Array.isArray(probes)?probes:[]) {
  const css=typeof probe?.css==='string'&&probe.css.length>0;
  const camera=['scale','viewBox'].includes(probe?.camera);
  if(typeof probe?.name!=='string'||!probe.name||probe.name in variants||experiments.includes(probe.name)||
    !(css&&probe.camera===undefined||camera&&probe.css===undefined))throw new Error('--probes 每项需要独立的名称以及 CSS 或相机对照');
}
if(!Array.isArray(probes)||new Set(probes.map(p=>p.name)).size!==probes.length)throw new Error('--probes 需要名称唯一的数组');
if(values.probes&&(!probes.length||values.variants))throw new Error('--probes 自带交替基线，请单独指定非空列表');
const wkScenes=['拖图','缩放','飞行','战役','全片'];
const wkProbes=webkitMode?[
  ...['hriv','nat','tribe','circ','rt','pl','btm','city','gar','ev','bt'].map(id=>({name:`藏${id}文字`,css:`#g-${id} text{display:none!important}`})),
  {name:'固定字号比例',camera:'scale'}, {name:'固定视框',camera:'viewBox'},
  {name:'藏路线',css:'#g-rt{display:none!important}'},
  {name:'藏疆域',css:'#g-terr{display:none!important}'},
  {name:'疆域不透明去混色',css:'#g-terr .f{fill-opacity:1!important}#g-terr .free-gray{mix-blend-mode:normal!important}'}
]:[];
const wkNames=[...Object.keys(variants),...wkProbes.map(p=>p.name)];
if(webkitMode&&probes.some(p=>wkNames.includes(p.name)))throw new Error('--probes 名称与内置 WebKit 开关重复');
const selectedVariants=probes.length?['基线',...probes.map(p=>p.name)]:webkitMode?select('variants',wkNames):values.variants===undefined?Object.keys(variants):select('variants',[...Object.keys(variants),...experiments]);
const selectedScenes=select('scenes',webkitMode?wkScenes:scenes);
if(webkitMode&&(values['trace-layout']||values.gpu==='禁用'||process.argv.some(a=>a==='--cpu'||a.startsWith('--cpu='))))throw new Error('WebKit 使用原生 CPU/GPU 与 rAF 指标');
if(!['默认','禁用','全部'].includes(values.gpu))throw new Error('--gpu 可选：默认、禁用、全部');
const gpus=values.gpu==='全部'?['默认','禁用']:[values.gpu];

async function serve() {
  const server = createServer(async(req,res)=>{
    const path = new URL(req.url,'http://localhost').pathname;
    const tile = /^\/tiles\/\d+\/\d+_\d+\.jpg$/.test(path);
    if (path!=='/' && !tile) { res.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(tile ? join(root,path) : page);
      res.writeHead(200,{'Content-Type':tile?'image/jpeg':'text/html; charset=utf-8'}).end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  return server;
}

async function connect(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await once(ws,'open');
  let id = 0;
  const pending = new Map(), events = new EventTarget();
  ws.onmessage = ({data})=>{
    const msg = JSON.parse(data);
    if (msg.id) pending.get(msg.id)?.(msg);
    else events.dispatchEvent(new CustomEvent(msg.method,{detail:msg.params}));
  };
  function send(method,params={}) {
    return new Promise((resolve,reject)=>{
      const key=++id, timer=setTimeout(()=>{pending.delete(key);reject(new Error('CDP 超时 '+method))},90000);
      pending.set(key,msg=>{
        clearTimeout(timer); pending.delete(key);
        if (msg.error) reject(new Error(method+' '+msg.error.message)); else resolve(msg.result);
      });
      ws.send(JSON.stringify({id:key,method,params}));
    });
  }
  async function evaluate(expression) {
    const reply = await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }
  async function until(expr,ms=30000) {
    const end=Date.now()+ms;
    do {if (await evaluate(expr)) return; await sleep(100)} while (Date.now()<end);
    throw new Error('页面等待超时 '+expr);
  }
  return {send,evaluate,until,events,close:()=>ws.close()};
}

// 在 parser 之前启动探针。首载区间从 navigationStart 到同时观测到 load 和 year 的首个 rAF。
function install(css) {
  if (css) {
    const apply=()=>{const style=document.createElement('style');style.textContent=css;document.documentElement.append(style)};
    if (document.documentElement) apply(); else {
      const observer=new MutationObserver(()=>{if(document.documentElement){observer.disconnect();apply()}});
      observer.observe(document,{childList:true});
    }
  }
  let frames=[], ready=0, recording=true;
  const tasks=[];
  const collect=entries=>entries.forEach(e=>tasks.push([e.startTime,e.duration]));
  const observer=new PerformanceObserver(list=>collect(list.getEntries()));
  observer.observe({type:'longtask',buffered:true});
  const meter=window.atlasPerf={
    start(){frames=[];recording=true;performance.mark('atlas-start')},
    stop(){recording=false;performance.mark('atlas-end');return frames},
  };
  function frame(ts) {
    if (recording) frames.push(ts);
    if (!meter.load) {
      if (!ready && typeof year!=='undefined') ready=performance.now();
      const load=performance.getEntriesByType('navigation')[0]?.loadEventEnd;
      if (ready && load) {
        meter.stop(); collect(observer.takeRecords()); observer.disconnect();
        meter.load={frames,ready,load,long:tasks.reduce((n,[t,d])=>n+Math.max(0,Math.min(load-t,d)),0)};
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// 使用同一 renderer 的 User Timing 标记裁切 trace。每线程同类嵌套事件取并集，Raster 跨线程求和。
// Script 是 JS 入口的墙钟时间，可能包含同步样式/布局，几列不能相加当作墙钟时间。
const kind = new Map(Object.entries({FunctionCall:'script',EvaluateScript:'script',RunMicrotasks:'script',
  UpdateLayoutTree:'style',Layout:'layout',Paint:'paint',RasterTask:'raster'}));
// 在加载后的页面运行。三组互斥，每个样本都使用新配置目录。
function injectExperiment(name) {
  if(name==='行军跳终态') {
    const original=doAct;
    doAct=function(action,animate,...rest) {
      if(action[0]!=='m'||!animate)return original(action,animate,...rest);
      // 原操作返回动画时长，后续动作和讲解依赖这个值。仅替换这次行军的插值。
      const originalTween=tween;
      try {
        tween=(_duration,_delay,draw)=>draw(1);
        return original(action,animate,...rest);
      } finally {tween=originalTween}
    };
    return;
  }
  const groups=['g-nat','g-tribe','g-circ','g-pl','g-city','g-gar'].map(id=>document.getElementById(id));
  if(name==='文字层contain') {
    for(const group of groups)group.style.contain='layout paint';
    return;
  }
  const map=document.getElementById('map'),overlay=document.createElementNS(map.namespaceURI,'svg');
  overlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  const sync=()=>{
    for(const key of ['class','viewBox']){
      const value=map.getAttribute(key);
      if(overlay.getAttribute(key)!==value)overlay.setAttribute(key,value);
    }
    const scale=map.style.getPropertyValue('--s');
    if(overlay.style.getPropertyValue('--s')!==scale)overlay.style.setProperty('--s',scale);
  };
  const pointers=groups.map(group=>getComputedStyle(group).pointerEvents);
  map.after(overlay);sync();
  groups.forEach((group,i)=>{group.style.pointerEvents=pointers[i];overlay.append(group)});
  // commit 改镜头，setMode 也能单独改 class。只观察根属性，在下一帧绘制前同步。
  new MutationObserver(sync).observe(map,{attributes:true,attributeFilter:['class','viewBox','style']});
}

function injectProbe(probe){
  if(probe.css){const style=document.createElement('style');style.textContent=probe.css;document.head.append(style);return}
  if(probe.camera==='scale'){
    const frozen=getComputedStyle(svg).getPropertyValue('--s');
    const style=document.createElement('style');style.textContent=`#map{--s:${frozen}!important}`;document.head.append(style);return;
  }
  const origin={...com},set=svg.setAttribute.bind(svg),originalCommit=commit,originalPreview=preview;
  svg.setAttribute=(key,value)=>{if(key!=='viewBox')set(key,value)};
  const transform=()=>{const sc=base*view.k;stage.style.transform=`translate(${(origin.cx-view.cx)*sc}px,${(origin.cy-view.cy)*sc}px) scale(${view.k/origin.k})`};
  commit=(...args)=>{originalCommit(...args);transform()};preview=()=>{originalPreview();transform()};
}

function layoutSummary(events,start,end) {
  const layouts=[];
  for(const e of events){
    if(e.pid!==end.pid||e.tid!==end.tid)continue;
    const duration=(Math.min(end.ts,e.ts+e.dur)-Math.max(start,e.ts))/1000;
    if(duration<=0)continue;
    const data=e.args?.beginData??{},stack=data.stackTrace;
    const frames=Array.isArray(stack)?stack:stack?.callFrames;
    const forced=Boolean(frames?.length||(!frames&&stack));
    layouts.push({ms:duration,forced,dirty:data.dirtyObjects??null,total:data.totalObjects??null,
      partial:data.partialLayout??null,top:forced?(frames?.[0]?.functionName||'栈顶未具名或未解析'):'帧内'});
  }
  return layouts;
}

async function measure(c,action,load=false,traceLayout=false) {
  const spans=[], marks={},layoutEvents=[];
  const listener=({detail})=>{for(const e of detail.value){
    if(traceLayout&&e.name==='Layout'&&e.ph==='X')layoutEvents.push(e);
    if (e.name==='atlas-start' || e.name==='atlas-end') marks[e.name]=e;
    else if (kind.has(e.name) && e.ph==='X') spans.push([e.pid,e.tid,kind.get(e.name),e.ts,e.ts+e.dur]);
  }};
  c.events.addEventListener('Tracing.dataCollected',listener);
  const categories='-*,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline'+(traceLayout?',disabled-by-default-devtools.timeline.stack':'');
  await c.send('Tracing.start',{categories,options:'record-until-full',transferMode:'ReportEvents'});
  if (!load) await c.evaluate('atlasPerf.start()');
  await action();
  const {frames,...extra}=load?await c.evaluate('atlasPerf.load'):{frames:await c.evaluate('atlasPerf.stop()')};
  const done=once(c.events,'Tracing.tracingComplete',{signal:AbortSignal.timeout(90000)});
  await c.send('Tracing.end'); const [complete]=await done;
  c.events.removeEventListener('Tracing.dataCollected',listener);
  if (complete.detail.dataLossOccurred || !marks['atlas-end'] || (!load && !marks['atlas-start'])) throw new Error('trace 不完整');
  const end=marks['atlas-end'], start=load?0:marks['atlas-start'].ts;
  const totals={script:0,style:0,layout:0,paint:0,raster:0},last=new Map();
  for(const [pid,tid,k,t,u] of spans.sort((a,b)=>a[3]-b[3])) {
    if (pid!==end.pid || (k!=='raster' && tid!==end.tid)) continue;
    const key=tid+':'+k, hi=Math.min(end.ts,u), lo=Math.max(start,t,last.get(key)??0);
    if (hi>lo) {totals[k]+=(hi-lo)/1000;last.set(key,hi)}
  }
  if(probes.length){
    extra.layout300=0;extra.layoutMax=0;
    for(const [pid,tid,kind,t,u] of spans){
      if(kind!=='layout'||pid!==end.pid||tid!==end.tid)continue;
      const ms=(Math.min(u,end.ts)-Math.max(t,start))/1000;
      if(ms>=300)extra.layout300++;
      extra.layoutMax=Math.max(extra.layoutMax,ms);
    }
  }
  if(traceLayout)extra.layoutEvents=layoutSummary(layoutEvents,start,end);
  const gaps=frames.slice(1).map((v,i)=>v-frames[i]).sort((a,b)=>a-b);
  const quantile=p=>gaps[Math.ceil(p*gaps.length)-1]??null;
  return {frames:gaps.length,fps:gaps.length?1000*gaps.length/(frames.at(-1)-frames[0]):null,
    p50:quantile(.5),p95:quantile(.95),max:quantile(1),slow:gaps.filter(x=>x>50).length,...totals,...extra};
}

function inputs(c) {
  const touch=(type,points=[])=>c.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y],id)=>({x,y,id}))});
  async function rect(id) {
    return c.evaluate(`(()=>{const {x,y,width,height}=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x,y,width,height}})()`);
  }
  async function tap(id) {
    const r=await rect(id), x=r.x+r.width/2,y=r.y+r.height/2;
    if (!await c.evaluate(`document.elementFromPoint(${x},${y})?.closest('#${id}')!=null`)) throw new Error('控件不可点 '+id);
    await touch('touchStart',[[x,y]]);await touch('touchEnd');
  }
  async function swipe(ms,points) {
    await touch('touchStart',points(0));
    // 定时发输入，不让上一个 move 的 CDP 应答延迟拉长手势；Chrome 可合并事件。
    const start=performance.now(), moves=[];
    for (let t=16;t<=ms;t+=16) {
      await sleep(Math.max(0,start+t-performance.now()));
      moves.push(touch('touchMove',points(t/ms)));
    }
    await Promise.all(moves); await touch('touchEnd'); await sleep(240); // 含 140ms 防抖后的 commit
  }
  return {tap,rect,swipe,hash:h=>c.evaluate(`location.hash=${JSON.stringify(h)}`)};
}

async function sample(c,url,variant) {
  const {tap,rect,swipe,hash}=inputs(c), results={};
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
  await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
  await c.send('Emulation.setCPUThrottlingRate',{rate:cpu});
  if (variant==='系统字体') {
    await c.send('Network.enable'); await c.send('Network.setBlockedURLs',{urls:['*://fonts.googleapis.com/*']});
  }
  await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${install})(${JSON.stringify(variants[variant]||'')})`});
  const want=s=>selectedScenes.includes(s);
  const navigate=async()=>{
    await c.send('Page.navigate',{url}); await c.until('!!window.atlasPerf?.load',90000);
  };
  if(want('首载'))results.首载=await measure(c,navigate,true);else await navigate();
  await tap('op-explore'); await c.until("document.getElementById('opening').hidden");
  await c.evaluate('document.fonts.ready.then(()=>true)');
  const probe=probes.find(p=>p.name===variant);
  if(probe){
    await c.evaluate(`(${injectProbe})(${JSON.stringify(probe)})`);
    await c.evaluate('document.body.getBoundingClientRect();document.fonts.ready.then(()=>true)');
  }
  if(experiments.includes(variant))await c.evaluate(`(${injectExperiment})(${JSON.stringify(variant)})`);
  if(want('首载'))results.首载.font=await c.evaluate(`[...document.fonts].filter(f=>f.family.includes('Noto Serif SC')&&f.status==='loaded').length`);
  if(want('拖图'))results.拖图=await measure(c,()=>swipe(3008,t=>[[195+100*Math.sin(2*Math.PI*t),370+40*Math.sin(4*Math.PI*t)]]));
  if(want('捏合'))results.捏合=await measure(c,()=>swipe(1600,t=>{const d=36+98*Math.sin(Math.PI*t);return [[195-d,370],[195+d,370]]}));
  if(want('年份')){
    await tap('drawer-handle'); await c.until("document.getElementById('yr').offsetWidth>0");
    const r=await rect('yr'), pt=t=>[[r.x+2+(r.width-4)*t,r.y+r.height/2]];
    await swipe(160,t=>pt(1-t)); await c.until('year===936');
    results.年份=await measure(c,async()=>{await swipe(3008,pt);await c.until('year===1279')});
    await tap('drawer-handle');
  }
  if(!['飞行','战役','全片'].some(want))return results;
  // 暂停的全片分享入口提供配音和倍速按钮。先设好静音、1.5×，随后各场自然计时。
  await hash('f=1');await c.until('film.on && !flying');await tap('nr-voice');await tap('nr-rate');await tap('nr-rate');
  await c.until('!VOICE.on && filmRate===1.5');await tap('nr-exit');
  const battle=await c.evaluate('C.ev.filter(e=>e[6]).sort((a,b)=>b[6].steps.length-a[6].steps.length)[0][1]');
  const enter=()=>hash('b='+encodeURIComponent(battle)+'&s=0');
  if(want('飞行')){
    await tap('zin');
    results.飞行=await measure(c,async()=>{
      await tap('zfit');await c.until('!flying && view.k===1');await enter();
      // 第一步开始讲解时，入场的两个镜头均已提交。
      await c.until("mode==='battle' && bt.playing && bt.si===0 && narrCur!==null && !flying");
    },false,values['trace-layout']);
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
    await c.until("mode!=='battle' && !flying");
  }
  if(want('战役')){
    results.战役=await measure(c,async()=>{
      await enter(); await c.until("mode==='battle' && bt.playing");
      await c.until('!bt.playing && bt.si===bt.steps.length-1',240000);
    },false,values['trace-layout']);
    await tap('nr-exit');
  }
  if(want('全片')){
    await hash('f=1');await c.until('film.on && film.i===0 && !film.playing && !flying');
    results.全片=await measure(c,async()=>{await tap('nr-play');await c.until('film.playing && film.i===3',120000)});
  }
  return results;
}

async function runChrome(url,gpu,variant) {
  const profile=await mkdtemp(join(tmpdir(),'song-perf-'));
  const proc=spawn(process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new',...(gpu?[]:['--disable-gpu']),'--disable-extensions','--disable-ipc-flooding-protection','--mute-audio',
    '--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=390,844','about:blank'],{stdio:'ignore'});
  let c,err;
  const exited=new Promise(resolve=>proc.once('close',resolve));
  proc.on('error',e=>{err=e});
  const stop=()=>proc.kill();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    let port;
    for(let i=0;i<100&&!port;i++) {
      if(err || proc.exitCode!==null) throw err||new Error('Chrome 提前退出');
      try {port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])} catch {await sleep(100)}
    }
    if (!port) throw new Error('未发现 Chrome 调试端口');
    c=await connect(port);
    return await sample(c,url,variant);
  } finally {
    c?.close();proc.kill();await exited;await rm(profile,{recursive:true,force:true,maxRetries:3});
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
  }
}

const metrics={frames:'帧间隔数',fps:'FPS',p50:'p50',p95:'p95',max:'最大',slow:'>50ms',script:'Script',style:'Style',layout:'Layout',paint:'Paint',raster:'Raster',load:'load',ready:'year',long:'长任务',font:'已载 Noto 分片'};
if(probes.length)Object.assign(metrics,{layout300:'≥300ms Layout 次数',layoutMax:'最大 Layout ms'});
function median(list) {
  const a=list.filter(Number.isFinite).sort((a,b)=>a-b);
  return a.length>=(runs===1?1:2)?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;
}
function appendAttribution(lines,rows) {
  for(const [i,row] of rows.entries())for(const [scene,result] of Object.entries(row.results)){
    const events=result.layoutEvents;if(!events)continue;
    const sum=es=>es.reduce((n,e)=>n+e.ms,0),forced=events.filter(e=>e.forced);
    const totals=events.map(e=>e.total).filter(Number.isFinite),total=sum(events),ms=sum(forced);
    const percent=n=>total?(100*n/total).toFixed(1)+'%':'—';
    lines.push('',`### 样本 ${i+1} · ${row.gpu} GPU · ${row.variant} · ${scene}`,'',
      '|Layout 次数|强制次数|强制 ms（占比）|帧内 ms（占比）|平均 totalObjects|', '|---:|---:|---:|---:|---:|',
      `|${events.length}|${forced.length}|${ms.toFixed(1)}（${percent(ms)}）|${(total-ms).toFixed(1)}（${percent(total-ms)}）|${totals.length?(totals.reduce((a,b)=>a+b,0)/totals.length).toFixed(1):'—'}|`,
      '', '|耗时 ms|dirtyObjects|totalObjects|partialLayout|JS 栈顶|','|---:|---:|---:|---|---|');
    for(const e of [...events].sort((a,b)=>b.ms-a.ms).slice(0,10))lines.push(`|${e.ms.toFixed(2)}|${e.dirty??'—'}|${e.total??'—'}|${e.partial??'—'}|${e.top}|`);
  }
  lines.push('','按 beginData.stackTrace 区分强制排版与帧内排版。此 trace 没有完整 DOM 写入日志，不能可靠给出每帧之前最后一次写入的来源。');
}
export function render(rows) {
  const keys=Object.keys(metrics),lines=[`390×844 · DPR 3 · CPU ×${cpu} · ${values.file?'file':'HTTP'} · 各列 ${runs} 次中位数，括号为同 GPU 同场景相对基线差值。时长单位 ms。`, '',
    '|GPU 设置|场景|开关|'+Object.values(metrics).join('|')+'|','|'+Array(3+keys.length).fill('---').join('|')+'|'];
  for (const gpu of gpus) for (const scene of selectedScenes) {
    const base={};
    for (const variant of selectedVariants) {
      const samples=rows.filter(r=>r.gpu===gpu&&r.variant===variant).map(r=>r.results[scene]);
      const cells=keys.map(k=>{
        const n=median(samples.map(s=>s[k]));if (variant==='基线') base[k]=n;
        if(n===null) return '—';const diff=n-base[k],fmt=x=>Number(x.toFixed(1));
        if (variant==='基线' || base[k]==null) return fmt(n);
        return `${fmt(n)} (${fmt(diff)>=0?'+':''}${fmt(diff)})`;
      });
      lines.push('|'+[gpu,scene,variant,...cells].join('|')+'|');
    }
  }
  if(probes.length)lines.push('','每项每轮先测一次基线，再测该项。基线行汇总所有交替基线。最大 Layout 一列取各轮单事件最大值的中位数。');
  if(values['trace-layout'])appendAttribution(lines,rows);
  // 跨场景、跨 GPU 的总榜只对完整矩阵有意义。
  if(gpus.length!==2||selectedScenes.length!==scenes.length||!Object.keys(variants).every(name=>selectedVariants.includes(name)))return lines.join('\n')+'\n';
  const value=(gpu,variant,scene,key)=>median(rows.filter(r=>r.gpu===gpu && r.variant===variant).map(r=>r.results[scene][key]));
  const ranked=Object.keys(variants).slice(1).map(variant=>{
    const scores=['默认','禁用'].map(gpu=>{
      const fps=(v,s)=>value(gpu,v,s,'fps');
      return scenes.slice(1).reduce((sum,s)=>sum+100*(1-fps('基线',s)/fps(variant,s)),0)/(scenes.length-1);
    });
    return {variant,scores};
  }).sort((a,b)=>b.scores[0]-a.scores[0]);
  lines.push('','## 瓶颈排序','','六个交互场景等权，按默认 GPU 一列降序。数值为开启单个开关后平均帧间隔相对基线的缩短百分比，负数表示变慢。首载单独看 load 和长任务。','','|开关|默认 GPU|禁用 GPU|','|---|---:|---:|');
  for (const {variant,scores} of ranked) lines.push(`|${variant}|${scores.map(s=>s.toFixed(1)+'%').join('|')}|`);
  lines.push('','## 基线与场景差异','', '|交互|默认 FPS|禁用 GPU FPS|默认 p95 → 禁用 GPU（ms）|默认 trace 耗时最大项|默认 GPU 提升 FPS 最多的单项|','|---|---:|---:|---|---|---|');
  for (const scene of scenes.slice(1).sort((a,b)=>value('默认','基线',a,'fps')-value('默认','基线',b,'fps'))) {
    const v=(key,gpu='默认',variant='基线')=>value(gpu,variant,scene,key);
    const heavy=['script','style','layout','paint','raster'].sort((a,b)=>v(b)-v(a))[0];
    const best=ranked.map(r=>r.variant).sort((a,b)=>v('fps','默认',b)-v('fps','默认',a))[0];
    lines.push(`|${scene}|${v('fps').toFixed(1)}|${v('fps','禁用').toFixed(1)}|${v('p95').toFixed(1)} → ${v('p95','禁用').toFixed(1)}|${metrics[heavy]} ${Math.round(v(heavy))} ms|${best} ${v('fps','默认',best).toFixed(1)} FPS|`);
  }
  lines.push('','手机布局使用「全图」按钮。战役分享地址触发两段入场飞行，最长战役从入场自动播至末步停止。全片从第一段按播放键到第四段切入。两种播放均关闭配音并使用页面提供的 1.5× 倍速。',
    '', '帧间隔来自页面 rAF。load 是 Navigation Timing 的 loadEventEnd，year 是首个读到该变量的 rAF，长任务仅累计与首载到 load 区间的交集。Script、Style、Layout、Paint 统计渲染主线程的 trace 区间，Raster 累加栅格线程时间，几列可能重叠。',
    '', '藏瓦片仍会请求、解码瓦片。藏地形同时隐藏底图和瓦片。收回舞台会改变 SVG 显示比例。系统字体会同时拦截 Noto Serif SC 与 Ma Shan Zheng 的共享样式表。这些差值包含相应的画面变化。无头桌面 Chrome 的降速测量不能换算成真机 Safari 的帧率。');
  return lines.join('\n')+'\n';
}
async function wkFrames(page,action){
  await page.evaluate(()=>{
    const meter=window.atlasMeter={frames:[]};
    function tick(t){meter.frames.push(t);meter.raf=requestAnimationFrame(tick)}
    meter.raf=requestAnimationFrame(tick);
  });
  await action();
  const frames=await page.evaluate(()=>{cancelAnimationFrame(atlasMeter.raf);return atlasMeter.frames});
  const gaps=frames.slice(1).map((t,i)=>t-frames[i]).sort((a,b)=>a-b);
  if(!gaps.length)throw new Error('WebKit 场景没有 rAF 样本');
  const q=p=>gaps[Math.ceil(p*gaps.length)-1];
  return {frames:gaps.length,fps:1000*gaps.length/(frames.at(-1)-frames[0]),p50:q(.5),p95:q(.95),max:q(1)};
}

async function wkSample(pw,url,variant){
  const browser=await pw.webkit.launch({headless:true});
  try{
    const context=await browser.newContext({...pw.devices['iPhone 15']});
    if(variant==='系统字体')await context.route('https://fonts.googleapis.com/**',r=>r.abort());
    const page=await context.newPage(),results={};
    page.on('pageerror',e=>console.error('WebKit 页面异常',e));
    const wait=(expr,timeout=30000)=>page.waitForFunction(expr,undefined,{timeout,polling:100});
    const tap=id=>page.locator('#'+id).tap({timeout:15000});
    const hash=h=>page.evaluate(s=>location.hash=s,h);
    await page.goto(url,{waitUntil:'load',timeout:90000});
    await tap('op-explore');await wait("document.getElementById('opening').hidden");
    const probe=[...wkProbes,...probes].find(p=>p.name===variant);
    if(probe)await page.evaluate(injectProbe,probe);
    else if(variants[variant])await page.addStyleTag({content:variants[variant]});
    await page.evaluate(async()=>{document.body.getBoundingClientRect();await document.fonts.ready});
    if(selectedScenes.includes('拖图')){
      // WebKit 的公开触屏 API 只支持 tap。用受信鼠标输入走同一 pointer 拖动处理器。
      const mouse=page.mouse;
      results.拖图=await wkFrames(page,async()=>{
        await mouse.move(195,370);await mouse.down();
        const start=performance.now();
        do{
          const angle=2*Math.PI*Math.min(1,(performance.now()-start)/3008);
          await mouse.move(195+100*Math.sin(angle),370+40*Math.sin(2*angle));
          await sleep(16);
        }while(performance.now()-start<3008);
        await mouse.move(195,370);await mouse.up();await sleep(240);
      });
    }
    if(selectedScenes.includes('缩放')){
      // 移动 WebKit 的公开 API 没有双指与滚轮。页面内派发两路 pointer 事件，走同一捏合处理器：3 秒内张开约 8 倍再合拢。
      results.缩放=await wkFrames(page,()=>page.evaluate(()=>new Promise(done=>{
        const wrap=document.getElementById('mapwrap'),send=(type,id,x,y)=>wrap.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y,bubbles:true,isPrimary:id===1}));
        const at=t=>20*Math.pow(8,t<.5?2*t:2-2*t);send('pointerdown',1,195-at(0),400);send('pointerdown',2,195+at(0),400);
        const start=performance.now(),step=()=>{const t=Math.min(1,(performance.now()-start)/3008),d=at(t);send('pointermove',1,195-d,400);send('pointermove',2,195+d,400);
          if(t<1)setTimeout(step,16);else{send('pointerup',1,195-d,400);send('pointerup',2,195+d,400);setTimeout(done,240)}};setTimeout(step,16)})));
    }
    if(selectedScenes.some(s=>s!=='拖图')){
      await hash('f=1');await wait('film.on&&!flying');await tap('nr-voice');await tap('nr-rate');await tap('nr-rate');
      await wait('!VOICE.on&&filmRate===1.5');await tap('nr-exit');
    }
    const battle=await page.evaluate(()=>C.ev.filter(e=>e[6]).sort((a,b)=>b[6].steps.length-a[6].steps.length)[0][1]);
    const enter=()=>hash('b='+encodeURIComponent(battle)+'&s=0');
    if(selectedScenes.includes('飞行')){
      await tap('zin');results.飞行=await wkFrames(page,async()=>{
        await tap('zfit');await wait('!flying&&view.k===1');await enter();
        await wait("mode==='battle'&&bt.playing&&bt.si===0&&narrCur!==null&&!flying");
      });
      await page.keyboard.press('Escape');await wait("mode!=='battle'&&!flying");
    }
    if(selectedScenes.includes('战役')){
      results.战役=await wkFrames(page,async()=>{
        await enter();await wait("mode==='battle'&&bt.playing");await wait('!bt.playing&&bt.si===bt.steps.length-1',240000);
      });await tap('nr-exit');
    }
    if(selectedScenes.includes('全片')){
      await hash('f=1');await wait('film.on&&film.i===0&&!film.playing&&!flying');
      results.全片=await wkFrames(page,async()=>{await tap('nr-play');await wait('film.playing&&film.i===3',120000)});
    }
    return results;
  }finally{await browser.close()}
}

async function webkitMatrix(url){
  let pw;
  try{pw=createRequire(import.meta.url)('playwright')}catch{
    throw new Error('在临时目录 npm install playwright 并运行 npx playwright install webkit，然后以 NODE_PATH=该目录/node_modules 运行此命令');
  }
  const pairs=selectedVariants.filter(v=>v!=='基线');
  const names=pairs.length?pairs.flatMap(v=>['基线',v]):['基线'];
  const rows=[];
  for(let round=1;round<=runs;round++)for(const [i,variant] of names.entries()){
    const pairedWith=variant==='基线'?(names[i+1]??variant):variant;
    console.error(`${new Date().toLocaleTimeString()} 第 ${round}/${runs} 轮 ${i+1}/${names.length} ${variant}（${pairedWith}）`);
    const row={round,variant,pairedWith,results:await wkSample(pw,url,variant)};
    console.error(JSON.stringify(row));rows.push(row);
  }
  const lines=['WebKit · iPhone 15 · 原速 · 各列取中位数。每项紧邻一次基线。','','|开关|场景|FPS|p50 ms|p95 ms|最大 ms|','|---|---|---:|---:|---:|---:|'];
  for(const variant of new Set(names))for(const scene of selectedScenes){
    const samples=rows.filter(r=>r.variant===variant).map(r=>r.results[scene]);
    lines.push('|'+[variant,scene,...['fps','p50','p95','max'].map(k=>median(samples.map(s=>s[k])).toFixed(1))].join('|')+'|');
  }
  if(pairs.length){
    const ranking=pairs.map(variant=>{
      const base=rows.filter(r=>r.variant==='基线'&&r.pairedWith===variant);
      const samples=rows.filter(r=>r.variant===variant);
      const gains=selectedScenes.map(scene=>median(samples.map((r,i)=>100*(1-base[i].results[scene].fps/r.results[scene].fps))));
      return {variant,gains,mean:gains.reduce((a,b)=>a+b,0)/gains.length};
    }).sort((a,b)=>b.mean-a.mean);
    lines.push('',`各轮与相邻基线配对，以下为平均帧间隔缩短百分比。各场景取 ${runs} 轮中位数后等权排序。`,'',
      `|开关|均值|${selectedScenes.join('|')}|`,`|---|---:|${selectedScenes.map(()=>'---:').join('|')}|`);
    for(const {variant,mean,gains} of ranking)lines.push(`|${variant}|${[mean,...gains].map(x=>x.toFixed(1)+'%').join('|')}|`);
  }
  const report=lines.join('\n')+'\n';if(values.out)await writeFile(values.out,report);process.stdout.write(report);
}
async function main() {
  const server=values.file?null:await serve();
  const url=server?`http://127.0.0.1:${server.address().port}/`:pathToFileURL(page).href;
  try {
    if(webkitMode)return await webkitMatrix(url);
    const rows=[],names=probes.length?probes.flatMap(p=>['基线',p.name]):selectedVariants,total=runs*names.length*gpus.length;
    for (let round=0;round<runs;round++) for (let i=0;i<names.length;i++) {
      const variant=probes.length||experiments.some(name=>names.includes(name))?names[i]:names[(i+round*4)%names.length]; // 注入实验保持每轮基线、a、b、c；原矩阵轮换
      for (const gpu of (round%2?gpus.slice().reverse():gpus)) {
        console.error(`${new Date().toLocaleTimeString()} ${rows.length+1}/${total} ${gpu} ${variant} 第 ${round+1} 次`);
        const row={gpu,variant,results:await runChrome(url,gpu==='默认',variant)};
        rows.push(row);
        console.error(JSON.stringify(row));
      }
    }
    const report=render(rows);
    if (values.out) await writeFile(values.out,report);
    process.stdout.write(report);
  } finally {server?.close()}
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) await main();
