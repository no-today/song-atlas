// 手机性能矩阵。先 npm run build。每个样本新开 Chrome，七个场景串行。
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile, readdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';

const {values} = parseArgs({options:{cpu:{type:'string',default:'4'},file:{type:'boolean'},out:{type:'string'}}});
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
async function measure(c,action,load=false) {
  const spans=[], marks={};
  const listener=({detail})=>{for(const e of detail.value){
    if (e.name==='atlas-start' || e.name==='atlas-end') marks[e.name]=e;
    else if (kind.has(e.name) && e.ph==='X') spans.push([e.pid,e.tid,kind.get(e.name),e.ts,e.ts+e.dur]);
  }};
  c.events.addEventListener('Tracing.dataCollected',listener);
  await c.send('Tracing.start',{categories:'-*,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline',options:'record-until-full',transferMode:'ReportEvents'});
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
  await c.send('Page.addScriptToEvaluateOnNewDocument',{source:`(${install})(${JSON.stringify(variants[variant])})`});
  results.首载=await measure(c,async()=>{
    await c.send('Page.navigate',{url}); await c.until('!!window.atlasPerf?.load',90000);
  },true);
  await tap('op-explore'); await c.until("document.getElementById('opening').hidden");
  await c.evaluate('document.fonts.ready.then(()=>true)');
  results.首载.font=await c.evaluate(`[...document.fonts].filter(f=>f.family.includes('Noto Serif SC')&&f.status==='loaded').length`);
  results.拖图=await measure(c,()=>swipe(3008,t=>[[195+100*Math.sin(2*Math.PI*t),370+40*Math.sin(4*Math.PI*t)]]));
  results.捏合=await measure(c,()=>swipe(1600,t=>{const d=36+98*Math.sin(Math.PI*t);return [[195-d,370],[195+d,370]]}));
  await tap('drawer-handle'); await c.until("document.getElementById('yr').offsetWidth>0");
  const r=await rect('yr'), pt=t=>[[r.x+2+(r.width-4)*t,r.y+r.height/2]];
  await swipe(160,t=>pt(1-t)); await c.until('year===936');
  results.年份=await measure(c,async()=>{await swipe(3008,pt);await c.until('year===1279')});
  await tap('drawer-handle');
  // 暂停的全片分享入口提供配音和倍速按钮。先设好静音、1.5×，随后各场自然计时。
  await hash('f=1');await c.until('film.on && !flying');await tap('nr-voice');await tap('nr-rate');await tap('nr-rate');
  await c.until('!VOICE.on && filmRate===1.5');await tap('nr-exit');
  const battle=await c.evaluate('C.ev.filter(e=>e[6]).sort((a,b)=>b[6].steps.length-a[6].steps.length)[0][1]');
  const enter=()=>hash('b='+encodeURIComponent(battle)+'&s=0');
  await tap('zin');
  results.飞行=await measure(c,async()=>{
    await tap('zfit');await c.until('!flying && view.k===1');await enter();
    // 两段飞行之间有停留；第一步开始讲解时，入场的两个镜头均已提交。
    await c.until("mode==='battle' && bt.playing && bt.si===0 && narrCur!==null && !flying");
  });
  await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await c.until("mode!=='battle' && !flying");
  results.战役=await measure(c,async()=>{
    await enter(); await c.until("mode==='battle' && bt.playing");
    await c.until('!bt.playing && bt.si===bt.steps.length-1',240000);
  });
  await tap('nr-exit');await hash('f=1');await c.until('film.on && film.i===0 && !film.playing && !flying');
  results.全片=await measure(c,async()=>{await tap('nr-play');await c.until('film.playing && film.i===3',120000)});
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
function median(list) {
  const a=list.filter(Number.isFinite).sort((a,b)=>a-b);
  return a.length>=2?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;
}
export function render(rows) {
  const keys=Object.keys(metrics),lines=[`390×844 · DPR 3 · CPU ×${cpu} · ${values.file?'file':'HTTP'} · 各列三次中位数，括号为同 GPU 同场景相对基线差值。时长单位 ms。`, '',
    '|GPU 设置|场景|开关|'+Object.values(metrics).join('|')+'|','|'+Array(3+keys.length).fill('---').join('|')+'|'];
  for (const gpu of ['默认','禁用']) for (const scene of scenes) {
    const base={};
    for (const variant of Object.keys(variants)) {
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
async function main() {
  const server=values.file?null:await serve();
  const url=server?`http://127.0.0.1:${server.address().port}/`:pathToFileURL(page).href;
  try {
    const rows=[],names=Object.keys(variants);
    for (let round=0;round<3;round++) for (let i=0;i<names.length;i++) {
      const variant=names[(i+round*4)%names.length]; // 轮换顺序，减少升温/后台负载与开关的关联
      for (const gpu of (round%2?['禁用','默认']:['默认','禁用'])) {
        console.error(`${new Date().toLocaleTimeString()} ${rows.length+1}/66 ${gpu} ${variant} 第 ${round+1} 次`);
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
