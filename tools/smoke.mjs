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
// 一次遍历数百个分享地址，关闭 Chrome 的历史记录 IPC 限流，避免 replaceState 被静默丢弃。
const proc=spawn(chrome,['--headless=new','--disable-gpu','--disable-extensions','--disable-ipc-flooding-protection','--mute-audio',`--remote-debugging-port=${port}`,`--user-data-dir=${mkdtempSync(join(tmpdir(),'smoke-'))}`,'--window-size=1440,900','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<100&&!tabs;i++){await sleep(100);try{tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json()}catch{}}
if(!tabs){proc.kill();throw new Error('等待 Chrome 调试页面超时（10 秒）')}
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const wait=new Map(),errs=[];
ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&wait.has(d.id)){wait.get(d.id)(d);wait.delete(d.id)}
  if(d.method==='Runtime.exceptionThrown')errs.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text)};
const send=(method,params={})=>new Promise(r=>{const request=++id,timer=setTimeout(()=>{console.error('Chrome 调试请求超时（60 秒）：'+method+' '+(params.expression?.slice(0,100)||''));ws.close();proc.kill();process.exit(1)},60000);wait.set(request,d=>{clearTimeout(timer);r(d)});ws.send(JSON.stringify({id:request,method,params}))});
// 交互、逐段遍历与异步就绪均由 Node 侧分次调用，不用 awaitPromise 包住多步操作。
const run=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,userGesture:true});if(r.result.exceptionDetails)errs.push(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text);return r.result.result?.value};
const until=async(name,expr,timeout=10000)=>{const start=performance.now();for(;;){if(await run(expr))return true;const left=timeout-(performance.now()-start);if(left<=0)break;await sleep(Math.min(100,left))}errs.push(`等待条件超时（${timeout}ms）：${name}；${expr}`);return false};
// 持续性要求也逐次检查，防止只看时间段末尾漏掉提前进入步骤或控件闪现。
const during=async(name,expr,ms)=>{const start=performance.now();do{if(!await run(expr)){errs.push(`持续条件失败：${name}（${Math.round(performance.now()-start)}ms）`);return false}await sleep(100)}while(performance.now()-start<ms);return true};
const key=k=>run(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true}))`);
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:pathToFileURL(join(root,'dist',file)).href});
await until('页面脚本初始化',"typeof year!=='undefined'&&typeof C!=='undefined'");
const features=await run(`(()=>{const out={};
  out.metadata=C.chapters.length===10&&C.chapters.every((c,ch)=>FILM[c.i].ch===ch&&FILM[c.i+c.n-1].ch===ch&&c.d>0);
  out.opening=!$('opening').hidden&&!$('op-start').hidden&&$('op-resume').hidden;$('op-explore').click();return out})()`);
features.explore=await until('自由探索关闭开场页',"$('opening').hidden&&!film.on");
Object.assign(features,await run(`(()=>{const out={};
  openingShow();$('op-start').click();out.start=film.on&&film.i===0&&film.playing;filmPlay(false);
  progress.i=C.chapters[2].i+2;storeWrite('song-atlas.film',progress);openingShow();out.resumeButton=!$('op-resume').hidden&&$('op-resume').textContent.includes(C.chapters[2].t);$('op-resume').click();out.resume=film.i===C.chapters[2].i+2&&film.playing;filmPlay(false);
  chaptersOpen();out.chapters=$('chapter-list').children.length===10;$('chapter-list').querySelector('[data-ch="2"]').click();out.jump=film.i===C.chapters[2].i&&film.playing&&$('chapters').hidden;filmPlay(false);return out})()`));
const audio=await run(`(()=>{const wav=new ArrayBuffer(44+32000),dv=new DataView(wav),str=(p,s)=>[...s].forEach((c,i)=>dv.setUint8(p+i,c.charCodeAt(0)));str(0,'RIFF');dv.setUint32(4,32036,true);str(8,'WAVEfmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,8000,true);dv.setUint32(28,16000,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);str(36,'data');dv.setUint32(40,32000,true);
  const url=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));narrate('倍速检查',url,600);return {url,initial:filmRate}})()`);
await until('倍速检查音频已就绪','AU.readyState>=2');
features.rate=true;
for(let n=0;n<4;n++)features.rate=await run("$('nr-rate').click();AU.playbackRate===filmRate&&JSON.parse(localStorage.getItem('song-atlas.rate'))===filmRate")&&features.rate;
features.rate=await run(`filmRate===${audio.initial}`)&&features.rate;
await run(`narrStop();URL.revokeObjectURL(${JSON.stringify(audio.url)})`);
console.log('开场、目录与音频倍速检查完成');
features.voiceToggle=await run("$('nr-voice').click();!VOICE.on&&$('nr-voice').getAttribute('aria-pressed')==='false'");
await run("filmRate=1.5;globalThis.smokeTimed={start:performance.now(),elapsed:0};narrate('计时',null,600).done.then(()=>smokeTimed.elapsed=performance.now()-smokeTimed.start)");
features.timing=await until('1.5 倍静音计时完成（至少 350ms）','smokeTimed.elapsed>=350');
features.voiceToggle=await run(`filmRate=${audio.initial};$('nr-voice').click();VOICE.on&&$('nr-voice').getAttribute('aria-pressed')==='true'` )&&features.voiceToggle;
await run('delete globalThis.smokeTimed');
console.log('配音开关与静音计时检查完成');
features.skip=await run("progress.seen=[];filmShow(C.chapters[0].i+C.chapters[0].n-1);!progress.seen.length");
await run("film.playing=true;filmSay(0);AU.dispatchEvent(new Event('ended'))");
features.seen=await until('章节观看进度写入存储',"progress.seen.includes(0)&&JSON.parse(localStorage.getItem('song-atlas.film')).seen.includes(0)");
await run('filmPlay(false)');
console.log('章节观看进度检查完成');
Object.assign(features,await run(`(()=>{const out={},key=(k,target=document.body)=>{const e=new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented};
  filmOpen(1);key(' ');out.space=film.playing;key(' ');out.space&&=!film.playing;key('ArrowRight');out.arrows=film.i===2;key('ArrowLeft');out.arrows&&=film.i===1;out.input=!key('ArrowRight',$('yr'))&&film.i===1;
  chaptersOpen();key('Escape');out.escape=$('chapters').hidden&&film.on;$('aboutbtn').click();key('Escape');out.escape&&=!$('about').classList.contains('open')&&film.on;
  filmEnd();key(' ');out.space&&=film.on&&film.playing;filmEnd();return out})()`));
await run('enterBattle(BATTLES[0],1);setPlay(false)');
features.battleReady=await until('战役键盘检查入场镜头完成','!flying');
Object.assign(features,await run(`(()=>{const out={},key=k=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  key(' ');out.battleSpace=bt.playing;key(' ');out.battleSpace&&=!bt.playing;showStep(0,false);key('ArrowRight');out.battleArrows=bt.si===1;key('ArrowLeft');out.battleArrows&&=bt.si===0;key('Escape');out.battleEscape=mode!=='battle';return out})()`));
if(!features||Object.values(features).some(v=>!v))errs.push('全片入口/目录/续播/倍速/键盘失败：'+JSON.stringify(features));
console.log('全片入口、目录、续播、倍速与键盘',JSON.stringify(features));
const combat={actErrors:[],actions:new Set()};
for(const battleIndex of await run('BATTLES')){const result=await run(`(()=>{const out={actErrors:[]},seen=new Set(),nodes={s:'.siege',w:'.flood',k:'.supply-cut',n:'.naval',f:'.forts',v:'.strength'},i=${battleIndex};
  enterBattle(i);setPlay(false);for(let k=0;k<bt.steps.length;k++){showStep(k,false);for(const a of bt.steps[k][1])if(nodes[a[0]]){if(!document.querySelector('#g-bt '+nodes[a[0]]+',#g-btm '+nodes[a[0]]))out.actErrors.push(C.ev[i][1]+' 第'+(k+1)+'步未画出 '+a[0]);else seen.add(a[0]);
    if(a[0]==='v'){const g=ROUTE[a[1]];if(g._army?.[1]!==a[2]||!g._tk?.textContent.includes(fmtN(a[2],a[3])))out.actErrors.push('兵力旗签未更新');if(k>0){showStep(k-1,false);if(g._army||!g._tk?.textContent.includes(fmtN(C.rt[a[1]][7][1],C.rt[a[1]][7][2])))out.actErrors.push('回退兵力未恢复');showStep(k,false)}}
    if(a[0]==='k'){const g=ROUTE[a[1]];if(!g._cut||!$('g-bt').querySelector('.cut-tail'))out.actErrors.push('断粮路线未变淡');showStep(k>0?k-1:Math.min(k+1,bt.steps.length-1),false);if(g._cut)out.actErrors.push('换步后断粮路线未恢复');showStep(k,false)}}}
  out.actions=[...seen];leaveBattle(false);return out})()`);combat.actErrors.push(...result.actErrors);for(const k of result.actions)combat.actions.add(k)}
for(const k of 'fwknsv')if(!combat.actions.has(k))combat.actErrors.push('新动作 '+k+' 没有在战役里画出');
console.log('逐战逐步检查完成');
for(let y=936;y<=1279;y+=24)await run(`(()=>{for(let y=${y};y<=Math.min(${y+23},1279);y++)userYear(y)})()`);
const res=await run(`(()=>{const out={init:[year,$('n-snap').textContent]};
  history.replaceState(null,'','#f=3');route();out.f3=film.on&&film.i===2&&!film.playing;out.routeState={hash:location.hash,i:film.i,on:film.on,playing:film.playing};
  // 电影式界面：题签有字；播放中静止后控制条隐去，暂停即常驻
  film.playing=true;uiHide();const hid=wrap.classList.contains('idle');film.playing=false;uiShow();out.ui=!!$('nr-cap').textContent&&hid&&!wrap.classList.contains('idle');
  history.replaceState(null,'','#c=x&s=2');route();filmEnd();
  // 战役中自动细览：开关可点、只切本场；退出战役恢复原来的细览状态
  enterBattle(BATTLES[0]);const bx0=svg.classList.contains('bx');$('exptoggle').click();const bx1=svg.classList.contains('bx');leaveBattle(true);
  out.bx=bx0&&!bx1&&$('exptoggle').getAttribute('aria-checked')==='false'&&!svg.classList.contains('bx');
  $('exptoggle').click();userYear(1111);out.film=FILM.length;
  out.battles=BATTLES.length;out.snaps=SNAP.length;return out})()`);
// 画面同步：全片每段、每战每步按 0、1/3、2/3、末尾 喂读字位置再打断（不等音频）；每段单独调用。
const feed=`const feed=s=>{for(const f of [0,1/3,2/3,1])narrPos(s,Math.floor(s.length*f));narrPos(null)}`;
let sync=0;await run('filmOpen(0)');
for(const ch of await run('C.chapters'))for(let i=ch.i;i<ch.i+ch.n;i++)sync+=await run(`(()=>{${feed};filmShow(${i});film.playing=true;feed(FILM[${i}].t);film.playing=false;return 1})()`);
await run('filmEnd()');
for(const i of await run('BATTLES'))sync+=await run(`(()=>{${feed};enterBattle(${i});setPlay(false);for(let k=0;k<bt.steps.length;k++){showStep(k,false);feed(stepNarr(k).t)}const n=bt.steps.length;leaveBattle(false);return n})()`);
// 布势走真实入场与全片 intro；不改镜头、讲解或动画时钟。
const pre={},preBattle=await run("C.ev.findIndex(e=>e[1]==='五路伐夏')");
const hold="!!bt.hold&&!!bt.preNode&&!flying&&$('nr-cap').textContent==='战前布势'&&$('g-bt').children.length===1&&!$('g-zone').childElementCount&&ROUTE.filter(g=>g._ev===C.ev[battle][1]).every(g=>!g._f)&&[...bt.preNode.children].every(n=>+getComputedStyle(n).opacity>.97)";
const started="!bt.hold&&!bt.preNode&&!$('g-bt').querySelector('.battle-pre')&&!flying&&bt.si===0&&$('nr-cap').textContent.includes('第 1/')&&ROUTE.some(g=>g._ev===C.ev[battle][1]&&g._f>0)";
await run(`filmEnd();if(mode==='battle')leaveBattle(false);enterBattle(${preBattle});setPlay(false)`);
pre.manual=await until('手动五路伐夏布势完全显现、第一步尚未绘制',hold);
pre.held=await during('手动入场第 2 秒仍显示布势且未画第一步',hold,2000);
await key('ArrowRight');
pre.arrow=await until('按 → 后布势淡出并开始第一步',started,2000);
for(const [name,action] of [['space',"document.body.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))"],['next',"$('nr-next').click()"],['map',"svg.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))"]]){
  await run(`leaveBattle(false);enterBattle(${preBattle});setPlay(false)`);
  pre[name+'Hold']=await until(`${name} 跳过前布势就绪`,hold);
  await run(action);pre[name]=await until(`${name} 跳过后布势淡出并开始第一步`,started,1000);
}
await run(`leaveBattle(false);enterBattle(${preBattle});setPlay(false)`);
pre.autoHold=await until('自然结束检查布势开始停留',"!!bt.hold&&!!bt.preNode&&$('nr-cap').textContent==='战前布势'");
pre.threeSeconds=await during('布势停留的 3 秒内不绘制第一步',"!!bt.preNode&&$('g-bt').children.length===1&&!$('g-zone').childElementCount&&ROUTE.filter(g=>g._ev===C.ev[battle][1]).every(g=>!g._f)",3000);
pre.auto=await until('3 秒停留后自动进入第一步',started);
await run(`leaveBattle(false);enterBattle(${preBattle});setPlay(false)`);
await until('退出清理前布势就绪',hold);
await run('leaveBattle(false)');
pre.clean=await during('退出后计时及地图跳过监听清除',"!bt.hold&&!bt.preNode&&!$('g-bt').childElementCount&&mode!=='battle'",3200);
await run(`enterBattle(${preBattle});setPlay(false)`);await until('换战役前布势就绪',hold);
await run(`enterBattle(BATTLES.find(i=>i!==${preBattle}),1);setPlay(false)`);
pre.changed=await during('换战役后旧布势计时不触发',"!bt.hold&&bt.si===1&&$('nr-cap').textContent.includes('第 2/')",3200);
await run(`leaveBattle(false);enterBattle(${preBattle},0);setPlay(false)`);
pre.explicit=await until('指定 step0=0 不进入手动停留',started);
await run(`leaveBattle(false);filmOpen(FILM.findIndex(f=>f.e===${preBattle}&&f.s===undefined))`);
pre.intro=await until('全片 intro 布势显现','!!bt.preNode&&!flying');
pre.filmHeld=await during('全片 intro 布势保持原时机','!!bt.preNode&&!bt.hold',1000);
await run('filmShow(film.i+1)');
pre.step=await until('全片第一步布势消失',"!flying&&!bt.preNode&&!$('g-bt').querySelector('.battle-pre')");
await run('filmEnd()');pre.filmClean=await run("!bt.hold&&!$('g-bt').childElementCount");
if(Object.values(pre).some(v=>!v))errs.push('战前布势时机/清理失败：'+JSON.stringify(pre));
console.log('战前布势时机/清理',JSON.stringify(pre));
console.log('年表末尾',res?.init?.join(' · '),`| 态势 ${res?.snaps}，战役 ${res?.battles}，全片 ${res?.film} 段，画面同步 ${sync} 段`);
if(combat.actErrors.length)errs.push(...combat.actErrors);
console.log('新动作实际绘制',[...combat.actions].sort().join(''));
if(res&&!res.f3)errs.push('#f=3 打开后应停在第 3 段、处于暂停：'+JSON.stringify(res.routeState));
if(res&&!res.bx)errs.push('战役中应自动细览、开关只切本场，退出后恢复原细览状态');
if(res&&!res.ui)errs.push('题签应有字；播放中静止后控制条应隐去、暂停时应常驻');
if(await run("location.protocol!=='file:'||$('g-tiles').childElementCount!==0||performance.getEntriesByType('resource').some(r=>/\\/tiles\\//.test(r.name))"))errs.push('file:// 下 g-tiles 应为空，且不应请求瓦片');
// 桌面收起右栏：轮询真实闲置与淡出条件，再用地图 pointermove 唤出。
const immersive={};
await run("filmEnd();if(mode==='battle')leaveBattle(false);openingClose()");await until('桌面沉浸前开场页关闭',"$('opening').hidden");
await run("if(document.body.classList.contains('nopanel'))$('ptoggle').click();$('ptoggle').click();view.k=2;commit()");
const opacity=value=>`['.tools','#ptoggle','#loc'].every(s=>getComputedStyle(document.querySelector(s)).opacity==='${value}')`;
immersive.hidden=await until('桌面收栏后控件完全隐去',opacity(0));
await run("capSet('闲置换段检查')");immersive.title=await until('闲置换题头仍隐藏',"getComputedStyle($('nr-cap')).opacity==='0'");
await key('ArrowRight');immersive.keyboard=await run("wrap.classList.contains('idle')");
await run("wrap.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',bubbles:true}))");immersive.shown=await until('鼠标移动后桌面控件完全显现',opacity(1));
await run("$('lytoggle').click()");immersive.layers=await during('图层浮层打开期间不隐藏',"!wrap.classList.contains('idle')",2800);
Object.assign(immersive,await run(`(()=>{const out={};$('lytoggle').click();chaptersOpen();uiHide();out.chapters=!wrap.classList.contains('idle');chaptersClose();$('aboutbtn').click();uiHide();out.about=!wrap.classList.contains('idle');$('aboutclose').click();openingShow();uiHide();out.opening=!wrap.classList.contains('idle');openingClose();$('ptoggle').click();return out})()`));
await until('沉浸浮层检查结束开场页关闭',"$('opening').hidden");immersive.panel=await during('桌面右栏展开期间不隐藏',"!wrap.classList.contains('idle')",2800);
if(Object.values(immersive).some(v=>!v))errs.push('桌面沉浸/浮层/键盘失败：'+JSON.stringify(immersive));
console.log('桌面沉浸',JSON.stringify(immersive));
const hover={};await run("$('ptoggle').click();uiShow()");
for(const selector of ['.tools','#ptoggle','#loc']){await run('uiShow()');const r=await run(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...r});hover[selector]=await during(`鼠标停在 ${selector} 时保持显示`,"!wrap.classList.contains('idle')",2800)}
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:700,y:400});await run("$('ptoggle').click()");
if(Object.values(hover).some(v=>!v))errs.push('鼠标停在控件上不应隐藏：'+JSON.stringify(hover));
// 窄屏逐步核对旗签、注记外框；视口与触摸采用真实移动设备参数。
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true});
await run('openingClose();drawerSet(false)');await until('手机布局完成',"innerWidth===390&&$('panel').offsetHeight===52&&$('opening').hidden");
const touch=async(type,y)=>send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:195,y}]});
await touch('touchStart',801);await touch('touchEnd');
await until('手机点击拖柄展开抽屉',"$('panel').classList.contains('drawer-open')");
await run('drawerSet(false)');await touch('touchStart',801);await touch('touchMove',736);await touch('touchEnd');
await until('手机短拖后抽屉收起',"!$('panel').classList.contains('drawer-open')");
await touch('touchStart',801);await touch('touchMove',550);await touch('touchEnd');
await until('手机上拖超过三分之一展开抽屉',"$('panel').classList.contains('drawer-open')");
await touch('touchStart',245);await touch('touchMove',460);await touch('touchEnd');
await until('手机下拖超过三分之一收起抽屉',"!$('panel').classList.contains('drawer-open')");
const mobile=await run(`(()=>{filmEnd();if(mode==='battle')leaveBattle(false);openingClose();const out={bounds:[],steps:0};
  drawerSet(true);out.open=Math.abs($('panel').getBoundingClientRect().height-innerHeight*.72)<2;enterBattle(${preBattle},1);setPlay(true);out.closed=$('panel').getBoundingClientRect().height===52;setPlay(false);return out})()`);
await until('手机五路伐夏入场镜头完成','!flying');
const bounds=`const bounds=idle=>{cull();const out=[],r=wrap.getBoundingClientRect(),bottom=idle?innerHeight:Math.min(r.bottom,$('panel').getBoundingClientRect().top,$('narr').getBoundingClientRect().top);
  for(const n of document.querySelectorAll('#g-rt .foc .tok,#g-bt .cl-note,#g-bt .take,#g-bt .act-note')){const b=n.getBoundingClientRect();if(!b.width||getComputedStyle(n).display==='none')continue;if(b.left<r.left+7||b.right>r.right-7||b.top<r.top+7||b.bottom>bottom-1)out.push({step:bt.si+1,idle,text:n.textContent,box:[b.left,b.top,b.right,b.bottom],bottom})}return out}`;
for(let k=0;k<await run('bt.steps.length');k++){mobile.bounds.push(...await run(`(()=>{showStep(${k},false);${bounds};return bounds(false)})()`));mobile.steps++}
await run('showStep(4,false);setPlay(true);uiShow()');
mobile.idle=await until('手机播放闲置后抽屉与控件完全隐去',"wrap.classList.contains('idle')&&$('panel').getBoundingClientRect().bottom>innerHeight&&Math.abs($('panel').getBoundingClientRect().top-(innerHeight-6))<2&&getComputedStyle($('time')).display==='none'&&getComputedStyle($('narr')).opacity==='0'&&getComputedStyle($('nr-sub')).bottom==='24px'");
mobile.bounds.push(...await run(`(()=>{${bounds};return bounds(true)})()`));
await run('leaveBattle(false)');
// 再进入播放检查真实触屏唤出、再次点击与计时隐藏、6px 拖柄及暂停恢复。
await run(`enterBattle(${preBattle},4);setPlay(true);uiShow()`);
const mobileIdle=await until('手机触屏检查前进入闲置',"wrap.classList.contains('idle')");
await touch('touchStart',140);await touch('touchEnd');
const mobileShown=await until('触屏唤出后控件完全显现',"!wrap.classList.contains('idle')&&$('panel').getBoundingClientRect().bottom===innerHeight&&getComputedStyle($('narr')).opacity==='1'");
await touch('touchStart',140);await touch('touchEnd');
const mobileHidden=await until('触屏再次点击隐藏控件',"wrap.classList.contains('idle')&&$('panel').getBoundingClientRect().bottom>innerHeight");
await touch('touchStart',841);await touch('touchEnd');
const mobileHandle=await until('手机 6px 拖柄展开抽屉',"!wrap.classList.contains('idle')&&$('panel').classList.contains('drawer-open')");
const mobilePaused=await run("drawerSet(false);setPlay(false);!wrap.classList.contains('idle')&&$('panel').offsetHeight===52");
if(!mobileIdle||!mobileShown||!mobileHidden||!mobileHandle||!mobilePaused)errs.push('手机沉浸/触屏唤出/拖柄/暂停失败：'+JSON.stringify({mobileIdle,mobileShown,mobileHidden,mobileHandle,mobilePaused}));
if(!mobile||!mobile.open||!mobile.closed||!mobile.idle||mobile.bounds.length)errs.push('手机抽屉/五路伐夏旗签越界：'+JSON.stringify(mobile));
console.log('手机 390×844 五路伐夏',mobile?.steps,'步，越界',mobile?.bounds.length);
ws.close();proc.kill();
if(errs.length){errs.forEach(e=>console.error('异常',e));process.exit(1)}console.log('冒烟通过：无脚本异常');
