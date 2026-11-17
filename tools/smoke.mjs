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
let tabs;for(let i=0;i<50&&!tabs;i++){await sleep(200);try{tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json()}catch{}}
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const wait=new Map(),errs=[];
ws.onmessage=m=>{const d=JSON.parse(m.data);if(d.id&&wait.has(d.id)){wait.get(d.id)(d);wait.delete(d.id)}
  if(d.method==='Runtime.exceptionThrown')errs.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text)};
const send=(method,params={})=>new Promise(r=>{const request=++id,timer=setTimeout(()=>{console.error('Chrome 调试请求超时：'+method+' '+(params.expression?.slice(0,100)||''));ws.close();proc.kill();process.exit(1)},60000);wait.set(request,d=>{clearTimeout(timer);r(d)});ws.send(JSON.stringify({id:request,method,params}))});
const run=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});if(r.result.exceptionDetails)errs.push(r.result.exceptionDetails.exception?.description);return r.result.result?.value};
await send('Runtime.enable');await send('Page.enable');
await send('Page.navigate',{url:pathToFileURL(join(root,'dist',file)).href});
// 等页面脚本跑完（产物变大后固定等待会偶发抢跑）
for(let i=0;i<75;i++){await sleep(200);const r=await send('Runtime.evaluate',{expression:"typeof year!=='undefined'&&typeof C!=='undefined'",returnByValue:true});if(r.result.result?.value)break}
const features=await run(`(async()=>{const out={},key=(k,target=document.body)=>{const e=new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented};
  out.metadata=C.chapters.length===10&&C.chapters.every((c,ch)=>FILM[c.i].ch===ch&&FILM[c.i+c.n-1].ch===ch&&c.d>0);
  out.opening=!$('opening').hidden&&!$('op-start').hidden&&$('op-resume').hidden;$('op-explore').click();await wait(320);out.explore=$('opening').hidden&&!film.on;
  openingShow();$('op-start').click();out.start=film.on&&film.i===0&&film.playing;filmPlay(false);
  progress.i=C.chapters[2].i+2;storeWrite('song-atlas.film',progress);openingShow();out.resumeButton=!$('op-resume').hidden&&$('op-resume').textContent.includes(C.chapters[2].t);$('op-resume').click();out.resume=film.i===C.chapters[2].i+2&&film.playing;filmPlay(false);
  chaptersOpen();out.chapters=$('chapter-list').children.length===10;$('chapter-list').querySelector('[data-ch="2"]').click();out.jump=film.i===C.chapters[2].i&&film.playing&&$('chapters').hidden;filmPlay(false);
  const wav=new ArrayBuffer(44+32000),dv=new DataView(wav),str=(p,s)=>[...s].forEach((c,i)=>dv.setUint8(p+i,c.charCodeAt(0)));str(0,'RIFF');dv.setUint32(4,32036,true);str(8,'WAVEfmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,8000,true);dv.setUint32(28,16000,true);dv.setUint16(32,2,true);dv.setUint16(34,16,true);str(36,'data');dv.setUint32(40,32000,true);
  const url=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));narrate('倍速检查',url,600);await wait(100);const initial=filmRate;out.rate=true;for(let n=0;n<4;n++){$('nr-rate').click();out.rate&&=AU.playbackRate===filmRate&&JSON.parse(localStorage.getItem('song-atlas.rate'))===filmRate}out.rate&&=filmRate===initial;narrStop();URL.revokeObjectURL(url);return out})()`);
console.log('开场、目录与音频倍速检查完成');
Object.assign(features,await run(`(async()=>{const out={},initial=filmRate;
  $('nr-voice').click();out.voiceToggle=!VOICE.on&&$('nr-voice').getAttribute('aria-pressed')==='false';filmRate=1.5;const start=performance.now();let timedDone=false;const timed=narrate('计时',null,600).done.then(()=>timedDone=true);await Promise.race([timed,wait(2000)]);out.timing=timedDone&&performance.now()-start>=350&&performance.now()-start<850;filmRate=initial;$('nr-voice').click();out.voiceToggle&&=VOICE.on&&$('nr-voice').getAttribute('aria-pressed')==='true';return out})()`));
console.log('配音开关与静音计时检查完成');
Object.assign(features,await run(`(async()=>{const out={};
  const tail=C.chapters[0].i+C.chapters[0].n-1;progress.seen=[];filmShow(tail);out.skip=!progress.seen.length;film.playing=true;filmSay(0);AU.dispatchEvent(new Event('ended'));await wait(20);out.seen=progress.seen.includes(0)&&JSON.parse(localStorage.getItem('song-atlas.film')).seen.includes(0);filmPlay(false);return out})()`));
console.log('章节观看进度检查完成');
Object.assign(features,await run(`(async()=>{const out={},key=(k,target=document.body)=>{const e=new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true});target.dispatchEvent(e);return e.defaultPrevented};
  filmOpen(1);key(' ');out.space=film.playing;key(' ');out.space&&=!film.playing;key('ArrowRight');out.arrows=film.i===2;key('ArrowLeft');out.arrows&&=film.i===1;out.input=!key('ArrowRight',$('yr'))&&film.i===1;
  chaptersOpen();key('Escape');out.escape=$('chapters').hidden&&film.on;$('aboutbtn').click();key('Escape');out.escape&&=!$('about').classList.contains('open')&&film.on;
  filmEnd();key(' ');out.space&&=film.on&&film.playing;filmEnd();enterBattle(BATTLES[0],1);setPlay(false);key(' ');out.space&&=bt.playing;key(' ');out.space&&=!bt.playing;showStep(0,false);key('ArrowRight');out.arrows&&=bt.si===1;key('ArrowLeft');out.arrows&&=bt.si===0;key('Escape');out.escape&&=mode!=='battle';return out})()`));
if(!features||Object.values(features).some(v=>!v))errs.push('全片入口/目录/续播/倍速/键盘失败：'+JSON.stringify(features));
console.log('全片入口、目录、续播、倍速与键盘',JSON.stringify(features));
const combat={actErrors:[],actions:new Set()};
for(const battleIndex of await run('BATTLES')){const result=await run(`(async()=>{const out={actErrors:[]},seen=new Set(),nodes={s:'.siege',w:'.flood',k:'.supply-cut',n:'.naval',f:'.forts',v:'.strength'},i=${battleIndex};
  enterBattle(i);setPlay(false);for(let k=0;k<bt.steps.length;k++){showStep(k,false);for(const a of bt.steps[k][1])if(nodes[a[0]]){if(!$('g-bt').querySelector(nodes[a[0]]))out.actErrors.push(C.ev[i][1]+' 第'+(k+1)+'步未画出 '+a[0]);else seen.add(a[0]);
    if(a[0]==='v'){const g=ROUTE[a[1]];if(g._army?.[1]!==a[2]||!g._tk?.textContent.includes(fmtN(a[2],a[3])))out.actErrors.push('兵力旗签未更新');if(k>0){showStep(k-1,false);if(g._army||!g._tk?.textContent.includes(fmtN(C.rt[a[1]][7][1],C.rt[a[1]][7][2])))out.actErrors.push('回退兵力未恢复');showStep(k,false)}}
    if(a[0]==='k'){const g=ROUTE[a[1]];if(!g._cut||!$('g-bt').querySelector('.cut-tail'))out.actErrors.push('断粮路线未变淡');showStep(k>0?k-1:Math.min(k+1,bt.steps.length-1),false);if(g._cut)out.actErrors.push('换步后断粮路线未恢复');showStep(k,false)}}}
  out.actions=[...seen];leaveBattle(false);await wait(0);return out})()`);combat.actErrors.push(...result.actErrors);for(const k of result.actions)combat.actions.add(k)}
for(const k of 'fwknsv')if(!combat.actions.has(k))combat.actErrors.push('新动作 '+k+' 没有在战役里画出');
console.log('逐战逐步检查完成');
for(let y=936;y<=1279;y+=24)await run(`(()=>{for(let y=${y};y<=Math.min(${y+23},1279);y++)userYear(y)})()`);
const res=await run(`(async()=>{const out={init:[year,$('n-snap').textContent]};
  history.replaceState(null,'','#f=3');route();out.f3=film.on&&film.i===2&&!film.playing;out.routeState={hash:location.hash,i:film.i,on:film.on,playing:film.playing};
  // 电影式界面：题签有字；播放中静止后控制条隐去，暂停即常驻
  film.playing=true;uiHide();const hid=wrap.classList.contains('idle');film.playing=false;uiShow();out.ui=!!$('nr-cap').textContent&&hid&&!wrap.classList.contains('idle');
  history.replaceState(null,'','#c=x&s=2');route();filmEnd();
  // 战役中自动细览：开关可点、只切本场；退出战役恢复原来的细览状态
  enterBattle(BATTLES[0]);const bx0=svg.classList.contains('bx');$('exptoggle').click();const bx1=svg.classList.contains('bx');leaveBattle(true);
  out.bx=bx0&&!bx1&&$('exptoggle').getAttribute('aria-checked')==='false'&&!svg.classList.contains('bx');
  $('exptoggle').click();userYear(1111);out.film=FILM.length;
  out.battles=BATTLES.length;out.snaps=SNAP.length;return out})()`);
// 画面同步：全片每段、每战每步按 0、1/3、2/3、末尾 喂读字位置再打断（不等音频）；全片里开着播放标记以走到镜头分支
const feed=`const feed=s=>{for(const f of [0,1/3,2/3,1])narrPos(s,Math.floor(s.length*f));narrPos(null)}`;
let sync=0;await run('filmOpen(0)');
for(const ch of await run('C.chapters'))sync+=await run(`(async()=>{${feed};for(let i=${ch.i};i<${ch.i+ch.n};i++){filmShow(i);film.playing=true;feed(FILM[i].t);film.playing=false;await wait(0)}return ${ch.n}})()`);
await run('filmEnd()');
for(const i of await run('BATTLES'))sync+=await run(`(async()=>{${feed};enterBattle(${i});setPlay(false);for(let k=0;k<bt.steps.length;k++){showStep(k,false);feed(stepNarr(k).t)}const n=bt.steps.length;leaveBattle(false);await wait(0);return n})()`);
// 布势走真实入场与全片 intro；等待节点出现，不改镜头、讲解或动画时钟。
const pre=await run(`(async()=>{const until=async fn=>{const start=performance.now();while(performance.now()-start<10000){if(fn())return true;await wait(25)}return false},i=C.ev.findIndex(e=>e[1]==='五路伐夏');
  filmEnd();if(mode==='battle')leaveBattle(false);enterBattle(i);setPlay(false);const manual=await until(()=>bt.preNode&&!flying&&[...bt.preNode.children].every(n=>+getComputedStyle(n).opacity>.97));
  showStep(0,false);const faded=await until(()=>!$('g-bt').querySelector('.battle-pre'));leaveBattle(false);
  filmOpen(FILM.findIndex(f=>f.e===i&&f.s===undefined));const intro=await until(()=>!!bt.preNode);await wait(800);const held=!!bt.preNode;
  filmShow(film.i+1);const step=await until(()=>!flying&&!bt.preNode&&!$('g-bt').querySelector('.battle-pre'));filmEnd();return {manual,faded,intro,held,step,clean:!$('g-bt').childElementCount}})()`);
if(!pre||Object.values(pre).some(v=>!v))errs.push('战前布势时机/清理失败：'+JSON.stringify(pre));
console.log('年表末尾',res?.init?.join(' · '),`| 态势 ${res?.snaps}，战役 ${res?.battles}，全片 ${res?.film} 段，画面同步 ${sync} 段`);
if(combat.actErrors.length)errs.push(...combat.actErrors);
console.log('新动作实际绘制',[...combat.actions].sort().join(''));
if(res&&!res.f3)errs.push('#f=3 打开后应停在第 3 段、处于暂停：'+JSON.stringify(res.routeState));
if(res&&!res.bx)errs.push('战役中应自动细览、开关只切本场，退出后恢复原细览状态');
if(res&&!res.ui)errs.push('题签应有字；播放中静止后控制条应隐去、暂停时应常驻');
if(await run("location.protocol!=='file:'||$('g-tiles').childElementCount!==0||performance.getEntriesByType('resource').some(r=>/\\/tiles\\//.test(r.name))"))errs.push('file:// 下 g-tiles 应为空，且不应请求瓦片');
// 桌面收起右栏：真实等过闲置计时与淡出，再用地图 pointermove 唤出。
const immersive=await run(`(async()=>{filmEnd();if(mode==='battle')leaveBattle(false);openingClose();await wait(320);if(document.body.classList.contains('nopanel'))$('ptoggle').click();$('ptoggle').click();view.k=2;commit();await wait(3000);
  const opacity=()=>['.tools','#ptoggle','#loc'].map(s=>getComputedStyle(document.querySelector(s)).opacity),out={hidden:opacity().every(v=>v==='0')};
  capSet('闲置换段检查');await wait(100);out.title=getComputedStyle($('nr-cap')).opacity==='0';
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));out.keyboard=wrap.classList.contains('idle');
  wrap.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',bubbles:true}));await wait(450);out.shown=opacity().every(v=>v==='1');
  $('lytoggle').click();await wait(3000);out.layers=!wrap.classList.contains('idle');$('lytoggle').click();chaptersOpen();uiHide();out.chapters=!wrap.classList.contains('idle');chaptersClose();$('aboutbtn').click();uiHide();out.about=!wrap.classList.contains('idle');$('aboutclose').click();openingShow();uiHide();out.opening=!wrap.classList.contains('idle');openingClose();$('ptoggle').click();await wait(3000);out.panel=!wrap.classList.contains('idle');return out})()`);
if(!immersive||Object.values(immersive).some(v=>!v))errs.push('桌面沉浸/浮层/键盘失败：'+JSON.stringify(immersive));
console.log('桌面沉浸',JSON.stringify(immersive));
const hover={};await run("$('ptoggle').click();uiShow()");
for(const selector of ['.tools','#ptoggle','#loc']){await run('uiShow()');const r=await run(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...r});await sleep(3000);hover[selector]=await run("!wrap.classList.contains('idle')")}
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:700,y:400});await run("$('ptoggle').click()");
if(Object.values(hover).some(v=>!v))errs.push('鼠标停在控件上不应隐藏：'+JSON.stringify(hover));
// 窄屏逐步核对旗签、注记外框；视口与触摸采用真实移动设备参数。
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});await send('Emulation.setTouchEmulationEnabled',{enabled:true});
await run('openingClose();drawerSet(false)');await sleep(100);
const touch=async(type,y)=>send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x:195,y}]});
await touch('touchStart',801);await touch('touchEnd');
if(!await run("$('panel').classList.contains('drawer-open')"))errs.push('手机点击拖柄应展开抽屉');
await run('drawerSet(false)');await touch('touchStart',801);await touch('touchMove',736);await touch('touchEnd');
if(await run("$('panel').classList.contains('drawer-open')"))errs.push('拖动不足三分之一应回到收起状态');
await touch('touchStart',801);await touch('touchMove',550);await touch('touchEnd');
if(!await run("$('panel').classList.contains('drawer-open')"))errs.push('上拖超过三分之一应展开抽屉');
await touch('touchStart',245);await touch('touchMove',460);await touch('touchEnd');
if(await run("$('panel').classList.contains('drawer-open')"))errs.push('下拖超过三分之一应收起抽屉');
const mobile=await run(`(async()=>{await wait(100);filmEnd();if(mode==='battle')leaveBattle(false);openingClose();const out={bounds:[],steps:0},i=C.ev.findIndex(e=>e[1]==='五路伐夏');
  drawerSet(true);out.open=Math.abs($('panel').getBoundingClientRect().height-innerHeight*.72)<2;enterBattle(i,1);setPlay(true);out.closed=$('panel').getBoundingClientRect().height===52;setPlay(false);
  for(let t=0;t<300&&flying;t++)await wait(25);await wait(50);
  for(let k=0;k<bt.steps.length;k++){showStep(k,false);await wait(50);cull();const r=wrap.getBoundingClientRect(),bottom=Math.min(r.bottom,$('panel').getBoundingClientRect().top,$('narr').getBoundingClientRect().top);
    for(const n of document.querySelectorAll('#g-rt .foc .tok,#g-bt .cl-note,#g-bt .take,#g-bt .act-note')){const b=n.getBoundingClientRect();if(!b.width||getComputedStyle(n).display==='none')continue;if(b.left<r.left+7||b.right>r.right-7||b.top<r.top+7||b.bottom>bottom-1)out.bounds.push({step:k+1,text:n.textContent,box:[b.left,b.top,b.right,b.bottom],bottom})}out.steps++}
  showStep(4,false);setPlay(true);uiShow();await wait(3000);const r=$('panel').getBoundingClientRect();out.idle=wrap.classList.contains('idle')&&r.bottom>innerHeight&&Math.abs(r.top-(innerHeight-6))<2&&getComputedStyle($('time')).display==='none'&&getComputedStyle($('narr')).opacity==='0'&&getComputedStyle($('nr-sub')).bottom==='24px';
  for(const n of document.querySelectorAll('#g-rt .foc .tok,#g-bt .cl-note,#g-bt .take,#g-bt .act-note')){const b=n.getBoundingClientRect();if(b.width&&getComputedStyle(n).display!=='none'&&(b.left<7||b.right>innerWidth-7||b.top<7||b.bottom>innerHeight-1))out.bounds.push({idle:true,text:n.textContent,box:[b.left,b.top,b.right,b.bottom]})}
  leaveBattle(false);return out})()`);
// 再进入播放检查真实触屏唤出、再次点击与计时隐藏、6px 拖柄及暂停恢复。
const mobileIdle=await run(`(async()=>{enterBattle(C.ev.findIndex(e=>e[1]==='五路伐夏'),4);setPlay(true);uiShow();await wait(3000);return wrap.classList.contains('idle')})()`);
await touch('touchStart',140);await touch('touchEnd');await sleep(450);
const mobileShown=await run("!wrap.classList.contains('idle')&&$('panel').getBoundingClientRect().bottom===innerHeight&&getComputedStyle($('narr')).opacity==='1'");
await touch('touchStart',140);await touch('touchEnd');await sleep(450);
const mobileHidden=await run("wrap.classList.contains('idle')&&$('panel').getBoundingClientRect().bottom>innerHeight");
await touch('touchStart',841);await touch('touchEnd');await sleep(450);
const mobileHandle=await run("!wrap.classList.contains('idle')&&$('panel').classList.contains('drawer-open')");
const mobilePaused=await run("drawerSet(false);setPlay(false);!wrap.classList.contains('idle')&&$('panel').offsetHeight===52");
if(!mobileIdle||!mobileShown||!mobileHidden||!mobileHandle||!mobilePaused)errs.push('手机沉浸/触屏唤出/拖柄/暂停失败：'+JSON.stringify({mobileIdle,mobileShown,mobileHidden,mobileHandle,mobilePaused}));
if(!mobile||!mobile.open||!mobile.closed||!mobile.idle||mobile.bounds.length)errs.push('手机抽屉/五路伐夏旗签越界：'+JSON.stringify(mobile));
console.log('手机 390×844 五路伐夏',mobile?.steps,'步，越界',mobile?.bounds.length);
ws.close();proc.kill();
if(errs.length){errs.forEach(e=>console.error('异常',e));process.exit(1)}console.log('冒烟通过：无脚本异常');
