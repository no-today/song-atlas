const TILE_BASE='tiles/';
const W=BASE.W, H=BASE.H, NS='http://www.w3.org/2000/svg', M=260;
const $=id=>document.getElementById(id);
const el=(n,a={},p)=>{const e=document.createElementNS(NS,n);for(const k in a)e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e};
const svg=$('map'), wrap=$('mapwrap'), stage=$('stage');
const REDUCED=matchMedia('(prefers-reduced-motion:reduce)').matches;
// ---------- 底图 ----------
$('relief').setAttribute('href',RELIEF);$('relief').setAttribute('width',W);$('relief').setAttribute('height',H);
$('landp').setAttribute('d',BASE.land);$('lakes').setAttribute('d',BASE.lakes);
['rv0','rv1','rv2','rv3'].forEach((id,i)=>$(id).setAttribute('d',BASE.rivers[i]));
for(const h in HIST.shapes){const cp=el('clipPath',{id:'c'+h},$('clips'));el('path',{d:HIST.shapes[h]},cp)}

// ---------- 高清地形瓦片：只在视野提交后加载，整批解码后换层 ----------
const TILE_ON=/^https?:$/.test(location.protocol)&&TILES, TILE_LIMIT=60;
const tileCache=new Map(),tileLevels=TILE_ON?TILES.levels.map(([z,scale,cols,rows,present])=>({z,scale,cols,rows,present:present?new Set(present):null})):[];
let tileTurn=0;
if(TILE_ON){const clip=el('clipPath',{id:'ctiles'},svg.querySelector('defs'));el('rect',{width:W,height:H},clip);$('g-tiles').setAttribute('clip-path','url(#ctiles)')}
function tileSync(){if(!TILE_ON||flying)return;
  const turn=++tileTurn,sc=base*view.k,need=sc*Math.min(devicePixelRatio||1,2),g=$('g-tiles');
  let li=tileLevels.findIndex(l=>l.scale>=need);if(li<0)li=tileLevels.length-1;
  if(li<=1&&need<=TILES.embed/W){g.replaceChildren();return}
  const bounds=[Math.max(0,view.cx-(cw/2+M)/sc),Math.max(0,view.cy-(ch/2+M)/sc),Math.min(W,view.cx+(cw/2+M)/sc),Math.min(H,view.cy+(ch/2+M)/sc)];
  const wanted=new Map(),add=(i,x,y)=>{const l=tileLevels[i],key=`${l.z}/${x}_${y}`;
    if(l.present&&!l.present.has(`${x}_${y}`)){if(i>0){const p=tileLevels[i-1];add(i-1,Math.floor(x*p.scale/l.scale),Math.floor(y*p.scale/l.scale))}return}
    wanted.set(key,{key,l,x,y})};
  const select=()=>{wanted.clear();const l=tileLevels[li],s=TILES.tile/l.scale;
    for(let y=Math.max(0,Math.floor(bounds[1]/s));y<Math.min(l.rows,Math.ceil(bounds[3]/s));y++)for(let x=Math.max(0,Math.floor(bounds[0]/s));x<Math.min(l.cols,Math.ceil(bounds[2]/s));x++)add(li,x,y)};
  select();while(wanted.size>TILE_LIMIT&&li>0){li--;select()}
  const jobs=[...wanted.values()].map(t=>{let c=tileCache.get(t.key);
    if(c){tileCache.delete(t.key);tileCache.set(t.key,c);return c.ready}
    const img=new Image();c={...t,node:null,ready:null};tileCache.set(t.key,c);
    c.ready=new Promise(resolve=>{img.onload=async()=>{try{await img.decode();const s=TILES.tile/t.l.scale,e=.25/t.l.scale,x=t.x*s,y=t.y*s;
          c.node=el('image',{x:x-e,y:y-e,width:s+2*e,height:s+2*e,preserveAspectRatio:'none',href:img.src,'data-z':t.l.z});
        }catch{}resolve(c)};img.onerror=()=>resolve(c);img.src=TILE_BASE+t.key+'.jpg'});return c.ready});
  for(const [key] of tileCache){if(tileCache.size<=TILE_LIMIT)break;if(!wanted.has(key))tileCache.delete(key)}
  Promise.all(jobs).then(tiles=>{if(turn!==tileTurn)return;const nodes=tiles.filter(t=>t.node).sort((a,b)=>a.l.z-b.l.z).map(t=>t.node);
    for(const n of [...g.children])if(!nodes.includes(n))n.remove();for(const n of nodes)g.appendChild(n)})}

const SNAP=HIST.snaps, YEARS=SNAP.map(s=>s.y);
const Y0=936,CORE=new Set(['song','houjin','houhan','houzhou']);
const REIGN=[[936,'后晋'],[947,'汉'],[951,'后周'],[960,'太祖'],[976,'太宗'],[997,'真宗'],[1022,'仁宗'],[1063,'英宗'],[1067,'神宗'],[1085,'哲宗'],[1100,'徽宗'],[1126,'钦宗'],[1127,'高宗'],[1162,'孝宗'],[1189,'光宗'],[1194,'宁宗'],[1224,'理宗'],[1264,'度宗'],[1274,'恭帝'],[1276,'端宗'],[1278,'帝昺'],[1280,'']];
const pick=(obj,y)=>{let best=null;for(const k in obj){if(+k<=y&&(best===null||+k>best))best=+k}return best===null?null:obj[best]};
const SIZE={1:30,2:21,3:15};
const RCOL={s:'#a8301f',l:'#2f6170',j:'#7a5c08',m:'#27457c',x:'#4f6a16',o:'#6a4a8a'};
for(const k in RCOL){const m=el('marker',{id:'ah-'+k,viewBox:'0 0 10 10',refX:8,refY:5,markerWidth:5.5,markerHeight:5.5,orient:'auto'},svg.querySelector('defs'));el('path',{d:'M0,0L10,5L0,10L3,5Z',fill:RCOL[k]},m)}
const SIDECOL=n=>/^(宋|后周|后唐|石敬瑭)/.test(n)?RCOL.s:/^(辽|契丹)/.test(n)?RCOL.l:/^金/.test(n)?RCOL.j:/^(蒙古|元)/.test(n)?RCOL.m:/^(西夏|党项)/.test(n)?RCOL.x:RCOL.o;
let year=960, snapIdx=-1, sel=null, mode='grand', battle=-1, savedView=null;
let view={cx:W/2,cy:H/2,k:1}, com={cx:W/2,cy:H/2,k:1}, base=1, cw=1, ch=1;

// ---------- 静态图层（一次建好，之后只切换显隐） ----------
function pt(parent,x,y,cls){return el('g',{class:'pt '+(cls||''),style:`transform:translate(${x}px,${y}px) scale(var(--s))`},parent)}
const TIMED=[],TXT=[];const timed=(g,a,b)=>{g._r=[a,b];g._v=true;TIMED.push(g);return g};
C.txt.forEach(t=>{const k=t[5],par=k==='t'||k==='f'?$('g-tribe'):k==='c'?$('g-circ'):$('g-nat');
  const cls=k==='M'||k==='R'||k==='c'?'lod2':(k==='r'||k==='m')&&!/黄河|大江|淮水|秦岭|太行山|祁连山|昆仑山|天山|阴山/.test(t[0])?'lod':'';
  const g=timed(pt(par,t[1],t[2],cls),t[3],t[4]),n=labelText(el('text',{class:'tx-'+k.toLowerCase(),y:4},g),t[0]);
  const fs={m:[11,.12],r:[10.5,0],s:[15,.5],d:[12,.5],t:[12,.1],f:[16,.3],c:[11.5,.35]}[k.toLowerCase()]||[11,0];g._tl=[t[1],t[2],n,fs[0],fs[1]];TXT.push(g)});
// 括注拆成小一号浅色字（只改显示）：「临安府（行在）」→ 临安府 + 小字「行在」；返回折算字数（括注按 .78 计）
function labelText(t,name){const m=name.match(/^(.+?)（(.+)）$/);if(!m){t.textContent=name;return name.length}
  t.textContent=m[1];el('tspan',{class:'pa',dx:'.25em'},t).textContent=m[2];return m[1].length+m[2].length*.78+.3}
// 城邑注记方位：r 右、l 左、a 上、b 下；ANC[方位](符号半径, 字号) → 文字属性。cull 里同一套几何算占位
const ANC={r:(q,f)=>({x:q+3,y:f*.36,'text-anchor':'start'}),l:(q,f)=>({x:-q-3,y:f*.36,'text-anchor':'end'}),
  a:(q,f)=>({x:0,y:-q-3,'text-anchor':'middle'}),b:(q,f)=>({x:0,y:q+2+f*.82,'text-anchor':'middle'})};
const CFS={3:13.5,2:11.5,1:11,4:10,0:10}, CRAD={3:5.5,2:3.8,1:2.6,4:1.8,0:4};
function cityAnchor(g,an){if(g._a===an)return;g._a=an;const a=ANC[an](g._c[7],g._c[3]);for(const k in a)g._t.setAttribute(k,a[k])}
const CITY=C.city.map(c=>{const lv=c[5];const g=timed(pt($('g-city'),c[1],c[2],'ct c'+lv+(lv===4?' lod2':lv===1||lv===0?' lod':'')),c[3],c[4]);
  // 都城：双框朱印；府：圈中加点；州：空心圈；小州：小点；关隘：三角
  if(lv===3){el('rect',{x:-5,y:-5,width:10,height:10,fill:'#f3e8cc',stroke:'#2b2118','stroke-width':1.1},g);el('rect',{x:-3,y:-3,width:6,height:6,fill:'#a8301f'},g)}
  else if(lv===2){el('circle',{r:3.6,fill:'#f3e8cc',stroke:'#2b2118','stroke-width':1.2},g);el('circle',{r:1.4,fill:'#2b2118'},g)}
  else if(lv===1){el('circle',{r:2.5,fill:'#f3e8cc',stroke:'#2b2118','stroke-width':1},g)}
  else if(lv===4){el('circle',{r:1.6,fill:'#4a3a2a'},g)}
  else{el('path',{d:'M-3.6,2.8L0,-3.6L3.6,2.8Z',fill:'#5d4c3a',stroke:'#f3e8cc','stroke-width':.6},g)}
  const t=g._t=el('text',{},g),n=labelText(t,c[0]);
  g._c=[c[1],c[2],n,CFS[lv],[0,4,2,1,5][lv],c[6]||'r',lv,CRAD[lv]];cityAnchor(g,g._c[5]);return g});
const GAR=C.gar.map(a=>{const g=timed(pt($('g-gar'),a[1],a[2],'gar lod2'),a[3],a[4]);g._c=[a[1],a[2],a[0].length,10.5,3,'g',5];g.style.pointerEvents='auto';g.style.cursor='pointer';
  const col=RCOL[a[5]];el('path',{d:'M0,0V-13',stroke:'#2b2118','stroke-width':1.1},g);el('path',{d:'M0,-13L9,-10L0,-7Z',fill:col,stroke:'#2b2118','stroke-width':.6},g);
  el('text',{x:-2,y:19,'text-anchor':'middle',class:'gn',fill:col},g).textContent=a[0];el('text',{x:-2,y:30,'text-anchor':'middle',class:'gd lod3'},g).textContent=a[6];
  g.addEventListener('click',ev=>{ev.stopPropagation();$('card').innerHTML=`<h2><i style="background:${col}"></i>${a[0]}</h2><p>${a[6]}</p><p class="hint">驻军 · ${a[3]}—${a[4]}年前后</p>`});return g});
C.riv.forEach(r=>{const g=timed(el('g',{},$('g-hriv')),r[1],r[2]);
  if(r[0]==='canal')el('path',{class:'cn',d:r[3],fill:'none',stroke:'#35606f'},g);
  else el('path',{d:r[3],fill:'none',stroke:r[0]==='he'?'#35606f':'#3f6878',opacity:.9},g);
  if(r[4]){const t=pt(g,r[5][0],r[5][1],r[0]==='canal'?'lod':''),n=labelText(el('text',{class:'tx-r',y:4},t),r[4]);t._v=true;t._tl=[r[5][0],r[5][1],n,10.5,0];t._rv=g;TXT.push(t)}});
const ROUTE=C.rt.map((r,i)=>{const g=timed(el('g',{},$('g-rt')),r[1],r[2]);g._ev=r[6];g._side=r[3];g._i=i;
  g._halo=el('path',{class:'halo',d:r[4]},g);g._ln=el('path',{class:'ln',d:r[4],stroke:RCOL[r[3]],'marker-end':`url(#ah-${r[3]})`},g);
  g._ah=el('path',{class:'ah',d:'M-7.5,-3.8L0,0L-7.5,3.8L-5.3,0Z',fill:RCOL[r[3]],stroke:'#efe4c8','stroke-width':.8},g);
  g._lb=pt(g,r[5][0],r[5][1],'rl lod');el('text',{x:0,y:-7,fill:RCOL[r[3]],'text-anchor':'middle'},g._lb).textContent=r[0];return g});
const KCH={w:'战',p:'盟',g:'政',t:'疆'}, KCOL={w:'#a8301f',p:'#3d6470',g:'#5d4c3a',t:'#8a7010'};
const EVM=C.ev.map((e,i)=>{const g=pt($('g-ev'),e[3],e[4],'evm');g.style.pointerEvents='auto';g.style.cursor='pointer';g._v=true;
  // 大事符号：菱形色签（与城邑的圆、方区分），悬停或当年才显示名字
  g._ring=el('circle',{class:'ring',r:6},g);el('path',{class:'dm',d:'M0,-5.2L5.2,0L0,5.2L-5.2,0Z',fill:KCOL[e[2]]},g);el('circle',{r:1.3,fill:'#f5e6c8'},g);
  el('title',{},g).textContent=`${e[0]} ${e[1]}`;g._tx=el('text',{x:8,y:-6},g);g._tx.textContent=e[1];g.addEventListener('click',ev=>{ev.stopPropagation();pickEvent(i)});return g});
const BATTLES=C.ev.map((e,i)=>e[6]?i:-1).filter(i=>i>=0);

// ---------- 大事卷 ----------
const evwrap=$('evwrap');let lastHead=null;
const KNAME={w:'战事',p:'和盟',g:'政事',t:'疆域'};
{const lg=document.createElement('div');lg.className='evlg';lg.innerHTML='大事年表'+Object.keys(KCH).map(k=>`<span><i class="k ${k}"></i>${KCH[k]}</span>`).join('')+'<span class="lg-go">› 可解说</span>';evwrap.appendChild(lg)}
const EVB=C.ev.map((e,i)=>{const per=e[0]<960?'五代十国':e[0]<1127||(e[0]===1127&&e[1]==='靖康之变')?'北宋':'南宋';
  if(per!==lastHead){const h=document.createElement('h3');h.innerHTML=`<span>${per}</span><small>${per==='五代十国'?'936—960':per==='北宋'?'960—1127':'1127—1279'}</small>`;evwrap.appendChild(h);lastHead=per}
  const b=document.createElement('button');b.className='ev';b.innerHTML=`<span class="y">${e[0]}</span><i class="k ${e[2]}" title="${KNAME[e[2]]}"></i><span><span class="t">${e[1]}</span><span class="d">${e[5]}</span></span>${e[6]?'<span class="go" title="战役分步解说">›</span>':'<span></span>'}`;
  b.addEventListener('click',()=>pickEvent(i));evwrap.appendChild(b);return b});
// 年表滚到某行（约在上三分之一处），停在整行上：最上一行正好接在吸顶的分期标题之下
function evScroll(b,behavior){const o=evwrap.offsetTop,hh=evwrap.querySelector('h3').offsetHeight,want=b.offsetTop-o-evwrap.clientHeight/3;
  let top=want;for(const r of EVB){const t=r.offsetTop-o-hh;if(t>=want-16){top=t;break}}evwrap.scrollTo({top:Math.max(0,top),behavior})}
function pickEvent(i){const e=C.ev[i];filmEnd();if(e[6])return enterBattle(i);
  if(mode==='battle')leaveBattle(false);setYear(e[0]);flyTo({cx:e[3],cy:e[4],k:Math.max(1.25,Math.min(view.k,2.2))})}

// ---------- 年表 ----------
const pct=y=>(y-Y0)/(1279-Y0)*100;
REIGN.slice(0,-1).forEach((r,i)=>{const s=document.createElement('span');s.textContent=r[1];s.title=`${r[1]} ${r[0]}—${Math.min(REIGN[i+1][0],1279)}`;s.style.width=(pct(Math.min(REIGN[i+1][0],1279))-pct(r[0]))+'%';if(r[0]>=1127||r[0]<960)s.className='s';$('reigns').appendChild(s)});
const TICK=SNAP.map(s=>{const b=document.createElement('button');b.style.left=pct(s.y)+'%';b.title=`${s.y}年 ${s.era} ${s.t}`;b.innerHTML=`<span>${s.y}</span>`;
  if([947,951,963,965,971,975,978,979,1028,1038,1116,1122,1127,1131,1137,1215,1218,1227,1260,1273,1276].includes(s.y))b.classList.add('hide');b.addEventListener('click',()=>userYear(s.y));$('ticks').appendChild(b);return b});

// ---------- 疆域 ----------
function polInfo(id,sy){const p=C.pol[id];let name=p[0],desc=p[3];
  if(id==='song'){const t=pick(C.songtxt,sy);name=t[0];desc=t[1]}
  if(id==='mongol'){const t=pick(C.mongtxt,sy);name=t[0];desc=t[1]}
  if(id==='daiviet'){const t=pick(C.dvtxt,sy);name=t[0];desc=t[1]}
  if(C.names[id]){const n=pick(C.names[id],sy);if(n)name=n}
  if(id==='kara'&&sy>=1044)name='喀喇汗（东、西）';
  if(id==='xia'&&sy<1038)name='夏州李氏';
  return {name,desc,color:p[1],size:p[2]}}
function shade(hex){const n=parseInt(hex.slice(1),16);const f=v=>Math.round(v*.5).toString(16).padStart(2,'0');return '#'+f(n>>16)+f(n>>8&255)+f(n&255)}
function drawSnap(i){snapIdx=i;const s=SNAP[i],gt=$('g-terr'),gp=$('g-pl');gt.textContent='';gp.textContent='';gt.classList.remove('fresh');void gt.getBoundingClientRect();gt.classList.add('fresh');
  // 诸部底：无政权覆盖的陆地（部族杂处之地）只压一层淡纸色，露出地形；域外政权另以 f 类字样标出
  $('mfree-p').setAttribute('d',s.p.map(p=>HIST.shapes[p[1]]).join(''));el('rect',{class:'free',x:-3000,y:-3000,width:8000,height:8000,fill:'#f3ead2','fill-opacity':.2,mask:'url(#mfree)'},gt);
  s.p.forEach(([id,h])=>{const inf=polInfo(id,s.y),d=HIST.shapes[h];const loose=id==='tibet';const g=el('g',{'data-id':id,class:(CORE.has(id)?'core':'')+(loose?' loose':'')},gt);
    el('path',{class:'f',d,fill:inf.color,'fill-opacity':CORE.has(id)?.36:(loose?.17:.28)},g).addEventListener('click',ev=>{ev.stopPropagation();select(id)});
    el('path',{class:'e',d,stroke:inf.color,'stroke-opacity':.42,'clip-path':`url(#c${h})`},g);
    el('path',{class:'o',d,stroke:CORE.has(id)?'#7a1d10':'#4a3a2a','stroke-opacity':.75},g);
    const lp=pick(C.lab[id]||{},s.y);if(lp){const t=pt(gp,lp[0],lp[1]);t.dataset.id=id;const short=inf.name.replace(/（.*）/,'');
      const tx=el('text',{y:SIZE[inf.size]*.35,style:`font-size:${CORE.has(id)?40:SIZE[inf.size]}px;fill:${CORE.has(id)?'#8a1f12':shade(inf.color)}`},t);tx.textContent=short;if(short.length>3)tx.style.letterSpacing='.04em'}});
  $('loc-core').setAttribute('d',s.p.filter(p=>CORE.has(p[0])).map(p=>HIST.shapes[p[1]]).join(''));
  if(sel&&!s.p.some(p=>p[0]===sel))sel=null;markSel()}
function markSel(){for(const g of $('g-terr').children)g.classList.toggle('sel',g.dataset.id===sel);card()}
function select(id){if(mode==='battle')return;sel=sel===id?null:id;markSel()}
function card(){const s=SNAP[snapIdx];let h;
  if(sel){const inf=polInfo(sel,s.y);h=`<h2><i style="background:${inf.color}"></i>${inf.name}</h2><p>${inf.desc}</p><button class="link" id="unsel">‹ 回到格局提要</button>`}
  else h=`<p class="lead">${C.shi[s.y]}</p><h4>疆土变化</h4><p>${C.chg[s.y]}</p><h4>兵力</h4><p>${pick(C.force,s.y)}</p><p class="hint">${mode==='explore'?'细览已开：放大可见州府军、路名与驻军，点小旗看驻军说明':'点图上政权看简介，点年表中带 › 的战役看分步解说'}</p>`;
  $('card').innerHTML=h}
$('card').addEventListener('click',e=>{if(e.target.id==='unsel'){sel=null;markSel()}});

// ---------- 疆土变化高亮 ----------
let gainAn=[];
function showGains(i,hold){gainAn.forEach(a=>a.cancel());gainAn=[];const gg=$('g-gain');gg.textContent='';if(i<0)return;
  for(const [id,h] of SNAP[i].g){const col=C.pol[id][1],p=el('path',{d:HIST.shapes[h],fill:col,'fill-opacity':.55,stroke:shade(col)},gg);
    if(REDUCED||!p.animate){if(!hold)setTimeout(()=>p.remove(),3500);continue}
    gainAn.push(p.animate(hold?[{opacity:0},{opacity:1,offset:.25},{opacity:.35,offset:.5},{opacity:1,offset:.75},{opacity:.8}]:[{opacity:0},{opacity:1,offset:.15},{opacity:.35,offset:.3},{opacity:1,offset:.45},{opacity:1,offset:.75},{opacity:0}],{duration:hold?1800:4200,fill:'forwards'}))}}

// ---------- 年份 ----------
function setVis(g,on){if(g._v!==on){g._v=on;g.classList.toggle('off',!on)}}
function setYear(y){year=Math.max(Y0,Math.min(1279,y));$('yr').value=year;
  const i=Math.max(0,YEARS.filter(v=>v<=year).length-1);/* 首幅态势之前的年份沿用首幅 */if(i!==snapIdx){const fwd=i===snapIdx+1&&mode!=='battle';drawSnap(i);showGains(fwd?i:-1)}const s=SNAP[i];
  $('n-year').textContent=year;const r=REIGN.filter(r=>r[0]<=year).pop();
  $('n-reign').textContent=year===1279?'宋亡 · 元世祖至元十六年':year<960?'公元 · '+({'汉':'后汉'}[r[1]]||r[1])+'时期':`公元 · 宋${r[1]}在位`;
  $('n-snapyr').textContent=s.y+' 态势';$('n-snap').textContent=`${s.era} · ${s.t}`;
  TICK.forEach((b,j)=>b.classList.toggle('cur',j===i));
  for(const g of TIMED)setVis(g,g._r[0]<=year&&year<=g._r[1]);
  let first=null;
  C.ev.forEach((e,j)=>{const cur=e[0]===year,show=e[0]<=year&&e[0]>year-18,m=EVM[j];setVis(m,show);
    if(m._cur!==cur){m._cur=cur;m.classList.toggle('cur',cur);EVB[j].classList.toggle('on',cur)}
    const past=e[0]<year;if(EVB[j]._p!==past){EVB[j]._p=past;EVB[j].classList.toggle('past',past)}if(cur&&first===null)first=j});
  if(first===null){for(let j=C.ev.length-1;j>=0;j--)if(C.ev[j][0]<=year){first=j;break}}
  if(first!==null&&mode!=='battle')evScroll(EVB[first],film.playing||REDUCED?'auto':'smooth');
  scheduleCull();if(mode!=='battle'&&!film.on)setHash('y='+year)}
let yearPicked=false; // 用户选过年份（拖滑块、点刻度、#y= 链接）后，播放全片从该年起；否则从头
function userYear(y){yearPicked=true;filmEnd();if(mode==='battle')leaveBattle(true);setYear(y)}
$('yr').addEventListener('input',e=>userYear(+e.target.value));
$('sprev').addEventListener('click',()=>userYear(YEARS[Math.max(0,(YEARS.indexOf(year)>=0?snapIdx-1:snapIdx))]));
$('snext').addEventListener('click',()=>userYear(YEARS[Math.min(YEARS.length-1,snapIdx+1)]));
$('play').addEventListener('click',()=>filmToggle());

// ---------- 读图方式 ----------
// 战役中自动细览（btX，svg.bx）：显示周边驻军与更多城邑关隘；开关在战役中只切本场的细览，退出战役恢复原来的 baseMode
let baseMode='grand',btX=true;
function setMode(m){mode=m;if(m!=='battle')baseMode=m;svg.classList.remove('m-grand','m-battle','m-explore');svg.classList.add('m-'+m);
  svg.classList.toggle('bx',m==='battle'&&btX);$('exptoggle').setAttribute('aria-checked',m==='battle'?btX:baseMode==='explore');
  const b=m==='battle';wrap.classList.toggle('in-battle',b);panelSync();if(!b)card();scheduleCull()}
$('exptoggle').addEventListener('click',()=>{if(mode==='battle'){btX=!btX;return setMode('battle')}if(mode==='explore')return setMode('grand');setMode('explore');if(base*view.k<=2.5){view.k=2.7/base;commit()}});
$('nr-exit').addEventListener('click',()=>film.on?filmEnd():leaveBattle(true));

// ---------- 战役分步演示 ----------
const SIDEN={s:'宋',l:'辽',j:'金',m:'蒙古',x:'夏',o:''};
const DARK={s:'#7a1d10',l:'#1f4652',j:'#5a4406',m:'#1b3260',x:'#3a4f0e',o:'#4a2f66'};
const STAR=(()=>{let p=[];for(let i=0;i<16;i++){const r=i%2?4.2:10,a=i*Math.PI/8-Math.PI/2;p.push((r*Math.cos(a)).toFixed(1)+','+(r*Math.sin(a)).toFixed(1))}return p.join(' ')})();
let bt={si:0,steps:[],tok:0,timer:0,playing:false,anims:[],stack:{}};
function routeFrac(g,f){if(!g._L)g._L=g._ln.getTotalLength();const L=g._L,d=`${L*(g._cut?Math.min(f,g._cut.f):f)} ${L+10}`;g._f=f;g._ln.style.strokeDasharray=d;g._halo.style.strokeDasharray=d;
  if(g._cut)g._cut.mask.style.strokeDasharray=`0 ${L*g._cut.f} ${L*Math.max(0,f-g._cut.f)} ${L+10}`;
  if(f<=0){g._ah.style.visibility='hidden';g._ln.style.visibility='hidden';g._halo.style.visibility='hidden'}
  else{g._ln.style.visibility=g._halo.style.visibility=g._ah.style.visibility='';const p=g._ln.getPointAtLength(L*f),q=g._ln.getPointAtLength(Math.max(0,L*f-3));
    g._ah.style.transform=`translate(${p.x}px,${p.y}px) rotate(${Math.atan2(p.y-q.y,p.x-q.x)*180/Math.PI}deg) scale(var(--s))`}
  g._ah.style.opacity=g._cut&&f>g._cut.f?.3:'';g._lb.style.opacity=g._cur&&f>=.45?1:0;
  const tk=armyTok(g);if(tk){if(f<=0)tk.style.display='none';else{const p=g._ln.getPointAtLength(g._L*f);tk.style.display='';tk.style.opacity=g._cur?1:.62;tk._tf=`translate(${p.x}px,${p.y}px) scale(calc(var(--s) * ${tk._z}))`;tk.style.transform=tk._tf+` translate(${tk._dx||0}px,${tk._dy||0}px)`}}}
// 部队标记：路线 r[7]=[部队名,人数,口径,兵种]，跟着行军箭头走；大小随兵力略增
const fmtN=(n,q)=>!n?'':(q==='号'?'号':q==='约'?'约':'')+(n>=10000?(Math.round(n/1000)/10)+'万':n+'人');
function armyTok(g){if(g._tk!==undefined)return g._tk;const a=g._army||C.rt[g._i][7];if(!a){g._tk=null;return null}
  // 旗签：左为兵种小印（朱/青等色底、纸色字），右为签条（部队名＋兵力），尾端燕尾
  const col=RCOL[g._side],t=el('g',{class:'tok'},g),num=a[1]?fmtN(a[1],a[2]):'';
  const wn=(s,f)=>[...s].reduce((w,ch)=>w+(/[\x00-\x7f]/.test(ch)?f*.6:f*1.06),0),w=wn(a[0],10.5)+(num?wn(num,10)+6:0)+12,x0=23,x1=x0+w;
  el('path',{d:`M${x0},-7.5H${x1+5}L${x1},0L${x1+5},7.5H${x0}Z`,fill:'#f6eedb','fill-opacity':.94,stroke:col,'stroke-width':.9},t);
  el('rect',{x:8,y:-7.5,width:15,height:15,fill:col,stroke:DARK[g._side],'stroke-width':.6},t);
  el('text',{x:15.5,y:3.6,'text-anchor':'middle',class:'tk-k'},t).textContent=a[3]==='混'?'军':a[3];
  const tl=el('text',{x:x0+5,y:3.6,class:'tk-l',fill:DARK[g._side]},t);tl.textContent=a[0];
  if(num)el('tspan',{class:'tk-n',dx:6},tl).textContent=num;
  g.classList.add('hastok');t._box={x:8,y:-7.5,width:x1-3,height:15};t._z=a[1]?Math.max(.9,Math.min(1.25,.9+.14*Math.log10(1+a[1]/8000))):.9;t.style.display='none';g._tk=t;return t}
function routeReset(g){if(g._tk)g._tk.style.display='none';g._ln.style.strokeDasharray='';g._halo.style.strokeDasharray='';g._ln.style.visibility=g._halo.style.visibility='';g._lb.style.opacity='';g._ln.setAttribute('marker-end',`url(#ah-${g._side})`)}
function tween(dur,delay,fn,tok){if(REDUCED||dur<=0){fn(1);return}let t0=null;const step=ts=>{if(tok!==bt.tok)return;if(t0===null)t0=ts+delay;const u=Math.max(0,Math.min(1,(ts-t0)/dur));fn(u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2);if(u<1)requestAnimationFrame(step)};requestAnimationFrame(step)}
function pop(node,delay,animate){if(!animate||REDUCED||!node.animate)return;const a=node.animate([{opacity:0,transform:'scale(.2)'},{opacity:1,transform:'scale(1.25)',offset:.7},{opacity:1,transform:'scale(1)'}],{duration:480,delay,fill:'backwards',easing:'ease-out'});bt.anims.push(a)}
function fade(node,delay,animate,to){if(!animate||REDUCED||!node.animate)return;bt.anims.push(node.animate([{opacity:0},{opacity:to??1}],{duration:600,delay,fill:'backwards'}))}
function actNote(g,x,y,text,side,y0=-20){if(!text)return;const lead=el('path',{class:'callout-lead'},g),n=el('g',{class:'act-note'},g);n._at=[x,y];n._lead=lead;el('text',{class:'sg-l',y:y0,style:`fill:${DARK[side]}`},n).textContent=text;return n}
function battlePre(e){if(!e[6]?.pre||bt.preNode)return;const root=el('g',{class:'battle-pre'},$('g-bt'));bt.preNode=root;
  for(const [x,y,side,text] of e[6].pre){const g=pt(root,x,y),col=RCOL[side];el('path',{d:'M0,4V-13L10,-10L0,-7',fill:col,stroke:col,'stroke-width':1.5},g);actNote(g,x,y,text,side);if(!REDUCED)bt.anims.push(g.animate([{opacity:0},{opacity:1}],{duration:220,fill:'backwards'}))}scheduleCull()}
function fadePre(){const n=bt.preNode;if(!n)return;bt.preNode=null;if(REDUCED)return n.remove();const a=n.animate([{opacity:1},{opacity:0}],{duration:350,fill:'forwards'});bt.anims.push(a);a.onfinish=()=>n.remove()}
function doAct(a,animate,t1,cur){ // 返回该动作结束的时间（毫秒），t1 为行军结束时刻
  const k=a[0],gb=$('g-bt'),sc=base*view.k;if('swknfv'.includes(k))animate=animate&&cur;
  if(k==='m'){const g=ROUTE[a[1]];g._cur=cur;if(!g._L)g._L=g._ln.getTotalLength();const dur=animate?Math.max(650,Math.min(2600,g._L*(a[3]-a[2])*sc*6)):0;
    if(animate){const tok=bt.tok;routeFrac(g,a[2]);tween(dur,0,u=>routeFrac(g,a[2]+(a[3]-a[2])*u),tok)}else routeFrac(g,a[3]);return dur}
  if(k==='a'||k==='r'){const col=RCOL[a[2]],p=el('path',{class:'adhoc'+(k==='r'?' ret':''),d:a[1],stroke:col},gb);
    const h=el('path',{d:'M-7.5,-3.8L0,0L-7.5,3.8L-5.3,0Z',fill:col,stroke:'#efe4c8','stroke-width':.8,style:`transform:translate(${a[3][0]}px,${a[3][1]}px) rotate(${Math.atan2(a[3][1]-a[4][1],a[3][0]-a[4][0])*180/Math.PI}deg) scale(var(--s))`},gb);
    if(k==='r'){fade(p,t1+300,animate,.85);fade(h,t1+700,animate);return t1+900}
    const L=p.getTotalLength(),dur=animate?Math.max(650,Math.min(2200,L*sc*6)):0;
    if(animate&&!REDUCED){p.style.strokeDasharray=`0 ${L+10}`;h.style.opacity=0;const tok=bt.tok;tween(dur,0,u=>{p.style.strokeDasharray=`${L*u} ${L+10}`;if(u>=1)h.style.opacity=1},tok)}return dur}
  if(k==='c'){const key=a[1]+','+a[2],n=bt.stack[key]||0;bt.stack[key]=n+1;const g=pt(gb,a[1],a[2]),col=RCOL[a[4]];
    const inner=el('g',{},g);if(n===0){el('polygon',{points:STAR,fill:col,stroke:'#f5e6c8','stroke-width':1.4},inner);el('path',{d:'M-3.2,-3.2L3.2,3.2M3.2,-3.2L-3.2,3.2',stroke:'#f5e6c8','stroke-width':1.6,'stroke-linecap':'round'},inner)}
    if(!cur){inner.setAttribute('opacity',.8);return 0}
    const lead=el('path',{class:'callout-lead'},g),note=el('g',{class:'cl-note'},inner);note._at=[a[1],a[2]];note._lead=lead;
    const y0=24;el('text',{class:'cl-t',x:0,y:y0,'text-anchor':'middle',fill:DARK[a[4]]},note).textContent=a[3]+((a[6]??SIDEN[a[4]])?' · '+(a[6]??SIDEN[a[4]])+'胜':'');
    if(a[5])el('text',{class:'cl-l',x:0,y:y0+13,'text-anchor':'middle'},note).textContent=a[5];
    pop(inner,t1+150,animate);
    if(animate&&!REDUCED&&n===0){const ring=el('circle',{r:8,fill:'none',stroke:col,'stroke-width':2},g);bt.anims.push(ring.animate([{r:'8px',opacity:.9},{r:'34px',opacity:0}],{duration:900,delay:t1+150,iterations:2,fill:'both'}))}
    return t1+900}
  if(k==='t'){const g=pt(gb,a[1],a[2]),col=RCOL[a[4]],lead=el('path',{class:'callout-lead'},g),inner=el('g',{},g),flag=el('g',{class:'take'},inner);flag._at=[a[1],a[2]];flag._lead=lead;
    el('path',{d:'M0,1V-12',stroke:'#2b2118','stroke-width':1},flag);el('path',{d:'M0,-12L8.5,-9.2L0,-6.4Z',fill:col,stroke:'#2b2118','stroke-width':.5},flag);
    if(!a[5])el('text',{class:'tk',x:6,y:4,fill:DARK[a[4]]},flag).textContent=a[3];
    pop(inner,t1+350,animate);return t1+850}
  if(k==='z'){const col=RCOL[a[2]],p=el('path',{d:HIST.shapes[a[1]],fill:col,'fill-opacity':.3,stroke:DARK[a[2]]},$('g-zone'));fade(p,t1+500,animate);
    if(cur){const g=pt(gb,a[4],a[5]);el('text',{class:'zl',y:6,fill:DARK[a[2]]},g).textContent=a[3];fade(g,t1+900,animate)}return t1+1600}
  if(k==='s'){const g=pt(gb,a[1],a[2]),col=RCOL[a[3]],r=a[4]||5,inner=el('g',{class:'siege'},g),R=r*sc/(Math.pow(view.k,.2)||1);
    const ring=el('circle',{r:R,fill:'none',stroke:col},inner),tick=el('g',{stroke:col},inner);
    for(let i=0;i<8;i++){const q=i*Math.PI/4,c=Math.cos(q),s=Math.sin(q);el('path',{d:`M${(c*(R+7)).toFixed(1)},${(s*(R+7)).toFixed(1)}L${(c*(R+1.5)).toFixed(1)},${(s*(R+1.5)).toFixed(1)}`},tick)}
    if(a[5]&&cur)actNote(g,a[1],a[2],a[5],a[3],-R-11);
    if(animate&&!REDUCED&&inner.animate){bt.anims.push(inner.animate([{opacity:0,transform:'scale(1.9)'},{opacity:1,transform:'scale(1)'}],{duration:1200,delay:t1,easing:'cubic-bezier(.3,.6,.3,1)',fill:'both'}));
      bt.anims.push(ring.animate([{strokeDashoffset:0},{strokeDashoffset:-24}],{duration:1600,delay:t1+1200,iterations:Infinity}))}
    return t1+1300}
  if(k==='w'){const g=pt(gb,a[1],a[2]),R=a[4]*sc/Math.pow(view.k,.2),p=[];
    for(let i=0;i<24;i++){const q=i*Math.PI/12,r=R*(1+.16*Math.sin(i*2.3)+.12*Math.cos(i*1.7));p.push(`${i?'L':'M'}${(Math.cos(q)*r).toFixed(1)},${(Math.sin(q)*r*.7).toFixed(1)}`)}
    const water=el('g',{class:'flood'},g);el('path',{d:p.join('')+'Z'},water);el('path',{class:'ripples',d:`M${-R*.6},-3q${R*.15},-6 ${R*.3},0t${R*.3},0t${R*.3},0M${-R*.4},6q${R*.15},-6 ${R*.3},0t${R*.3},0`},water);
    if(cur)actNote(g,a[1],a[2],a[5],a[3],-R*.7-12);
    if(animate&&!REDUCED)bt.anims.push(water.animate([{opacity:0,transform:'scale(.12)'},{opacity:1,transform:'scale(1)'}],{duration:1200,delay:t1,fill:'backwards',easing:'ease-out'}));return t1+1200}
  if(k==='k'){const r=ROUTE[a[1]],L=r._L||(r._L=r._ln.getTotalLength()),p=r._ln.getPointAtLength(L*a[2]),g=pt(gb,p.x,p.y),mark=el('g',{class:'supply-cut',stroke:RCOL[a[3]]},g);
    el('path',{d:'M-9,3L-3,-6M-3,6L3,-3M5,-3L11,3M11,-3L5,3'},mark);if(cur)actNote(g,p.x,p.y,a[4],a[3]);pop(mark,t1,animate);
    if(cur){const id=`cut-${bt.tok}-${a[1]}`,defs=el('defs',{},gb),mask=el('mask',{id,maskUnits:'userSpaceOnUse',x:-100,y:-100,width:W+200,height:H+200},defs),mp=el('path',{d:C.rt[a[1]][4],fill:'none',stroke:'white','stroke-width':20},mask);
      el('path',{class:'cut-tail',d:C.rt[a[1]][4],stroke:RCOL[r._side],mask:`url(#${id})`},gb);r._cut={f:a[2],mask:mp};routeFrac(r,r._f||0)}return t1+500}
  if(k==='n'){const g=pt(gb,a[1],a[2]),navy=el('g',{class:'naval'},g);
    el('path',{class:'ripples',d:'M-25,9q6,-5 12,0t12,0t12,0t12,0M-18,16q6,-5 12,0t12,0t12,0'},navy);
    for(let i=0;i<3;i++){const boat=el('g',{transform:`translate(${(i-1)*15},${i===1?-7:2})`},navy);el('path',{class:'boat',d:'M-9,0L-5,5H5L9,0ZM0,0V-11L6,-3H0',fill:RCOL[a[3]],stroke:DARK[a[3]]},boat);
      if(animate&&!REDUCED)bt.anims.push(boat.animate([{opacity:0,transform:`translate(${(i-1)*27}px,${i===1?-16:7}px)`},{opacity:1,transform:`translate(${(i-1)*15}px,${i===1?-7:2}px)`}],{duration:950,delay:t1+i*100,fill:'backwards',easing:'ease-out'}))}
    if(cur)actNote(g,a[1],a[2],a[4],a[3],-30);return t1+1200}
  if(k==='f'){a[2].forEach(([x,y],i)=>{const g=pt(gb,x,y),fort=el('g',{class:'forts',fill:RCOL[a[1]],stroke:DARK[a[1]]},g);el('path',{d:'M-8,5V-6H-5V-2H-2V-6H2V-2H5V-6H8V5ZM-2,5V0H2V5'},fort);if(cur&&i===a[2].length-1)actNote(g,x,y,a[3],a[1]);pop(fort,t1+i*150,animate)});return t1+(a[2].length-1)*150+480}
  if(k==='v'){const r=ROUTE[a[1]],a0=C.rt[a[1]][7];if(!a0)return 0;r._army=[a0[0],a[2],a[3],a0[3]];if(r._tk)r._tk.remove();r._tk=undefined;routeFrac(r,r._f||0);const p=r._ln.getPointAtLength((r._L||0)*(r._f||0)),g=pt(gb,p.x,p.y,'strength');
    if(cur){actNote(g,p.x,p.y,a[4],r._side);if(animate&&!REDUCED)bt.anims.push(r._tk.animate([{filter:'brightness(1.6)'},{filter:'brightness(1)'}],{duration:1000,delay:t1,fill:'backwards'}))}return t1+1000}
  return 0}
function clearStage(){bt.tok++;bt.pre=null;bt.preNode=null;clearTimeout(bt.timer);bt.anims.forEach(a=>a.cancel());bt.anims=[];bt.stack={};for(const g of ROUTE){if(g._cut){g._cut=null;routeFrac(g,g._f||0)}if(g._army){g._army=null;if(g._tk)g._tk.remove();g._tk=undefined}}$('g-bt').textContent='';$('g-zone').textContent=''}
function showStep(k,animate){k=Math.max(0,Math.min(k,bt.steps.length-1));const pre=C.ev[battle][6].pre?bt.pre:null,preNode=k===0?bt.preNode:null;if(preNode)preNode.remove();clearStage();if(preNode){$('g-bt').append(preNode);bt.preNode=preNode}narrStop();bt.si=k;const tok=bt.tok,e=C.ev[battle];
  let b=null;for(let s=Math.max(0,k-1);s<=k;s++){const q=bt.steps[s][2];if(q)b=b?[Math.min(b[0],q[0]),Math.min(b[1],q[1]),Math.max(b[2],q[2]),Math.max(b[3],q[3])]:q.slice()}
  for(const g of ROUTE)if(g._ev===e[1]){g._ln.removeAttribute('marker-end');g._cur=false;routeFrac(g,0)}
  bt.ends=new Map();for(let s=0;s<=k;s++)for(const a of bt.steps[s][1])if(a[0]==='m')bt.ends.set(ROUTE[a[1]],a[3]);bt.layout=null;
  const draw=(s,an)=>{const acts=bt.steps[s][1];let t1=0;
    for(const a of acts)if(a[0]==='m'||a[0]==='a')t1=Math.max(t1,doAct(a,an,0,s===k));
    let t2=t1;for(const a of acts)if(a[0]!=='m'&&a[0]!=='a')t2=Math.max(t2,doAct(a,an,t1,s===k));return t2};
  for(let s=0;s<k;s++)draw(s,false);
  if(film.on)filmCap();else{setHash('b='+encodeURIComponent(e[1])+'&s='+(k+1));
    capSet(`<b class="cy">${e[0]}</b>${e[1]} · 第 ${k+1}/${bt.steps.length} 步`);$('nr-n').textContent=`${k+1} / ${bt.steps.length}`;
    $('nr-prev').disabled=k===0;$('nr-next').disabled=k===bt.steps.length-1}
  document.querySelectorAll('#battlebox .steps li').forEach((li,i)=>{li.classList.toggle('cur',i===k);li.classList.toggle('done',i<k);if(i===k)li.scrollIntoView({block:'nearest'})});
  const go=()=>{fadePre();const end=draw(k,animate);scheduleCull();if(end)setTimeout(()=>{if(tok===bt.tok)scheduleCull()},end+80);
    if(film.on){if(film.playing)filmSay(end);return}
    if(!bt.playing)return;const n=stepNarr(k),say=narrate(n.t,n.au,2400,n.tm);
    Promise.all([say.done,wait(end)]).then(()=>{if(tok!==bt.tok||!bt.playing)return;
      if(k<bt.steps.length-1)return showStep(k+1,true);
      bt.timer=setTimeout(()=>setPlay(false),400)})};
  if(!animate&&!pre){if(b){view=boxView(b,55);commit()}return go()}
  let p=pre||Promise.resolve();
  if(b)p=p.then(()=>tok===bt.tok&&flyTo(boxView(b,55)));
  p.then(()=>{if(tok===bt.tok)go()})}
function setPlay(p){bt.playing=p;if(!p)clearTimeout(bt.timer);uiSync();if(film.on)return;if(!p)narrStop();$('nr-play').textContent=p?'❚❚':'▶';$('nr-play').setAttribute('aria-label',p?'暂停':'播放')}
$('nr-prev').addEventListener('click',()=>{if(film.on)return filmShow(film.i-1);setPlay(false);showStep(Math.max(0,bt.si-1),true)});
$('nr-next').addEventListener('click',()=>{if(film.on)return filmShow(film.i+1);setPlay(false);showStep(Math.min(bt.steps.length-1,bt.si+1),true)});
$('nr-play').addEventListener('click',()=>{if(film.on)return filmToggle();if(bt.playing)return setPlay(false);setPlay(true);showStep(bt.si>=bt.steps.length-1?0:bt.si+1,true)});
// inFilm：由全片驱动（不自动连播，每步读完由全片决定下一段）
function enterBattle(i,step0,inFilm){const e=C.ev[i],b0=e[6];if(mode!=='battle'){savedView={...view};btX=true}else clearStage();battle=i;sel=null;
  for(const g of ROUTE){if(g._f!==undefined){routeReset(g);g._f=undefined}g.classList.toggle('foc',g._ev===e[1])}
  EVM.forEach((m,j)=>m.classList.toggle('foc',j===i));CITY.forEach(g=>g.classList.remove('rel'));e[8].forEach(j=>CITY[j].classList.add('rel'));
  setMode('battle');setYear(e[0]);
  // 先飞到整场战役的全貌、停一下，再进入第一步（showStep 接着 bt.pre）
  const entryTok=bt.tok+1;bt.pre=flyTo(boxView(e[7],40)).then(()=>{if(!step0&&entryTok===bt.tok&&!(inFilm&&bt.preNode))battlePre(e);return wait(REDUCED?0:700)});
  const n=BATTLES.indexOf(i);bt.steps=b0.steps;
  $('battlebox').innerHTML=`<div class="hd"><b>${e[0]}</b><h2>${e[1]}</h2></div><p>${e[5]}</p>
    <div class="sec">战事经过</div><ol class="steps">${b0.steps.map(s=>`<li><span>${s[0]}</span></li>`).join('')}</ol>
    <div class="sec">参战各方与伤亡</div><div class="bat">${b0.s.map((s,q)=>`<div class="sd" style="--sc:${SIDECOL(s[0])}"><b>${s[0]}</b><dl><dt>将帅</dt><dd>${s[1]}</dd><dt>兵力</dt><dd>${s[2]||'不详'}</dd><dt>伤亡</dt><dd class="ls">${b0.loss[q]||'不详'}</dd></dl></div>`).join('')}</div>
    <div class="sec">结果</div><p class="res">${b0.res}</p>
    <div class="acts"><button class="ghost" id="b-prev"${n<=0?' disabled':''}>‹ 上一战</button><button class="ghost" id="b-next"${n>=BATTLES.length-1?' disabled':''}>下一战 ›</button></div>`;
  $('battlebox').scrollTop=0;
  $('b-prev').onclick=()=>{filmEnd();enterBattle(BATTLES[n-1])};$('b-next').onclick=()=>{filmEnd();enterBattle(BATTLES[n+1])};
  document.querySelectorAll('#battlebox .steps li').forEach((li,q)=>li.addEventListener('click',()=>{
    if(film.on){const j=FILM.findIndex(f=>f.e===i&&f.s===q+1);if(j>=0)return filmShow(j)}setPlay(false);showStep(q,true)}));
  setPlay(!inFilm&&!REDUCED&&!step0);showStep(step0||0,true)}
function leaveBattle(restore){setPlay(false);clearStage();battle=-1;for(const g of ROUTE){g.classList.remove('foc');if(g._f!==undefined){routeReset(g);g._f=undefined}}
  EVM.forEach(m=>m.classList.remove('foc'));CITY.forEach(g=>g.classList.remove('rel'));
  setMode(baseMode);if(restore&&savedView)flyTo(savedView);savedView=null;if(!film.on)setHash('y='+year)}

// ---------- 分享链接：#y=年 | #b=战役名&s=步 | #f=全片第几段 ----------
let lastHash='';
function setHash(h){h='#'+h;if(h===lastHash)return;lastHash=h;history.replaceState(null,'',h)}
function route(){const q=new URLSearchParams(location.hash.slice(1));lastHash=location.hash;
  if(q.has('f')&&FILM.length){filmOpen((+q.get('f')||1)-1);return true}
  if(q.has('b')){const i=C.ev.findIndex(e=>e[1]===q.get('b')&&e[6]);if(i>=0){filmEnd();enterBattle(i,(+q.get('s')||1)-1);return true}}
  if(q.has('y')){const y=+q.get('y');if(y>=Y0&&y<=1279){userYear(y);return true}}
  return false}

// ---------- 全片播放 ----------
// 讲稿 C.film 按序连播：态势段读格局；大事段飞到大事、读讲解；战役逐步演示，每步读一句，end 段在最后一步的画面上读收尾。
// 缺讲稿的战役步骤退回读 events 里的步骤短句（au/tm 同取步骤的）；没有讲稿的大事不播。
const HOME=[700,330,1260,1064]; // 默认视野：宋与南方诸国、燕云
function homeV(){const b=HOME;return {cx:(b[0]+b[2])/2,cy:(b[1]+b[3])/2,k:Math.max(1,Math.min(cw*.94/(base*(b[2]-b[0])),ch*.94/(base*(b[3]-b[1]))))}}
function homeView(){view=homeV();commit()}
const FILM=(()=>{const F=(C.film||[]).filter(f=>f.e>=0||f.y!=null),out=[];
  for(let j=0;j<F.length;){const f=F[j],ev=f.e>=0&&C.ev[f.e];if(!ev||!ev[6]){out.push(f);j++;continue}
    const g=[];while(j<F.length&&F[j].e===f.e)g.push(F[j++]);
    for(const x of g)if(x.s===undefined)out.push(x);
    ev[6].steps.forEach((st,k)=>out.push(g.find(x=>x.s===k+1)||{y:ev[0],e:f.e,s:k+1,t:st[0],au:st[3],tm:st[4]}));
    for(const x of g)if(x.s==='end')out.push(x)}
  return out})();
const FSTEP=new Map((C.film||[]).filter(f=>typeof f.s==='number').map(f=>[f.e+'|'+f.s,f]));
// 战役第 k 步（从 0 起）读什么：全片中读当前段；手动打开的战役优先读讲稿，没有则读步骤短句
function stepNarr(k){const f=film.on?FILM[film.i]:FSTEP.get(battle+'|'+(k+1)),st=bt.steps[k];return f?{t:f.t,au:f.au,tm:f.tm}:{t:st[0],au:st[3],tm:st[4]}}
let film={on:false,i:0,playing:false,tok:0,timer:0,ended:false,mk:-1};
function panelSync(){const b=mode==='battle';
  $('card').hidden=b;$('evwrap').hidden=b;$('battlebox').hidden=!b;$('narr').hidden=$('nr-cap').hidden=!(b||film.on);wrap.classList.toggle('in-film',film.on);
  $('nr-exit').title=film.on?'退出全片播放（Esc）':'退出战役解说（Esc）';uiSync()}
function filmPlay(p){film.playing=p;if(!p){narrStop();clearTimeout(film.timer)}uiSync();
  for(const id of ['play','nr-play']){$(id).textContent=p?'❚❚':'▶';$(id).setAttribute('aria-label',p?'暂停全片':'播放全片')}}
function filmOpen(i,play){if(!film.on){if(mode==='battle')leaveBattle(false);film.on=true;panelSync()}filmPlay(!!play);filmShow(i)}
// 播放/暂停：暂停后再点从当前段重读；否则从第一条年份 ≥ 当前年份的段起（没选过年份则从头）
// 在点击里先放一段静音、念一句空话：Safari 等只认点击当下的出声，之后镜头飞完再播的音频与朗读才不会被拦下（拦下会退回机器朗读）
const SILENT='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';let unlocked=false;
function unlockAudio(){if(unlocked)return;unlocked=true;AU.src=SILENT;AU.play().then(()=>{if(AU.src===SILENT)AU.pause()}).catch(()=>{});
  if('speechSynthesis' in window)speechSynthesis.speak(new SpeechSynthesisUtterance(''))}
function filmToggle(){unlockAudio();if(film.playing)return filmPlay(false);if(!FILM.length)return;
  let i=film.i;if(!film.on||film.ended){i=yearPicked?FILM.findIndex(f=>f.y>=year):0;if(i<0)i=0}
  filmOpen(i,true)}
function filmEnd(){if(!film.on)return;filmPlay(false);film.tok++;film.on=false;filmMark(-1);if(mode==='battle')leaveBattle(false);else clearStage();showGains(-1);panelSync();card();setHash('y='+year)}
// 在地图与大事年表里标出当前大事（年表滚动到它）
function filmMark(e){if(film.mk>=0){EVM[film.mk].classList.remove('fm');EVB[film.mk].classList.remove('fm')}film.mk=e;if(e<0)return;
  EVM[e].classList.add('fm');EVB[e].classList.add('fm');if(mode!=='battle')evScroll(EVB[e],'auto')}
function filmCap(){const f=FILM[film.i],e=f.e>=0&&C.ev[f.e];let h;
  if(!e)h=`<b class="cy">${f.y}</b>天下大势`;
  else if(f.s===undefined)h=`<b class="cy">${e[0]}</b>${e[1]}`;
  else{const n=e[6].steps.length;h=`<b class="cy">${e[0]}</b>${e[1]} · `+(f.s==='end'?'战后':`第 ${f.s}/${n} 步`)}
  capSet(h);$('nr-n').textContent=`${film.i+1} / ${FILM.length}`;
  $('nr-prev').disabled=film.i===0;$('nr-next').disabled=film.i===FILM.length-1;setHash('f='+(film.i+1))}
// 读当前段；读完（并等动画 extra 毫秒）停一下进下一段，播完最后一段停住
function filmSay(extra){const tok=film.tok,f=FILM[film.i],say=narrate(f.t,f.au,f.s!==undefined?2400:4000,f.tm);
  Promise.all([say.done,wait(extra||0)]).then(()=>{if(tok!==film.tok||!film.playing)return;
    if(film.i>=FILM.length-1){film.ended=true;return filmPlay(false)}
    film.timer=setTimeout(()=>{if(tok===film.tok&&film.playing)filmShow(film.i+1)},600)})}
// 显示第 i 段（从 0 起）；暂停中只摆好画面，不读
function filmShow(i){if(!film.on||!FILM.length)return;i=Math.max(0,Math.min(i,FILM.length-1));film.i=i;film.ended=false;
  const f=FILM[i],tok=++film.tok,isB=f.s!==undefined;clearTimeout(film.timer);narrStop();if(sel){sel=null;markSel()}
  if(mode==='battle'&&(!isB||battle!==f.e))leaveBattle(false);else if(!isB)clearStage();
  if(isB){filmMark(f.e);const n=C.ev[f.e][6].steps.length,k=f.s==='end'?n-1:f.s-1;filmCap();
    if(battle!==f.e)return enterBattle(f.e,k,true);
    if(f.s==='end'&&bt.si===k){if(film.playing)filmSay(0);return}
    return showStep(k,f.s!=='end')}
  let v;
  if(f.e<0){filmMark(-1);setYear(f.y);showGains(snapIdx,true);v=homeV()}
  else{const e=C.ev[f.e];setYear(e[0]);showGains(-1);
    if(e[6])v=boxView(e[7],300);
    else{const P=[[e[3],e[4]],...(e[8]||[]).map(j=>[C.city[j][1],C.city[j][2]])];
      v=boxView([Math.min(...P.map(p=>p[0])),Math.min(...P.map(p=>p[1])),Math.max(...P.map(p=>p[0])),Math.max(...P.map(p=>p[1]))],300)}
    filmMark(f.e)}
  filmCap();
  flyTo(v).then(()=>{if(tok!==film.tok)return;if(f.e>=0)battlePre(C.ev[f.e]);if(film.playing)filmSay(0)})}

// ---------- 图层 ----------
$('ptoggle').addEventListener('click',()=>{const off=document.body.classList.toggle('nopanel');$('ptoggle').textContent=off?'‹ 展开右栏':'收起 ›';$('ptoggle').setAttribute('aria-expanded',!off)});
$('lytoggle').addEventListener('click',()=>{const h=$('layers').hidden=!$('layers').hidden;$('lytoggle').setAttribute('aria-expanded',!h)});
[['ly-terr',['g-terr','g-pl']],['ly-nat',['g-nat']],['ly-city',['g-city']],['ly-ev',['g-ev']],['ly-rt',['g-rt']],['ly-water',['g-water']],['ly-gar',['g-gar']],['ly-circ',['g-circ']]].forEach(([id,gs])=>
  $(id).addEventListener('change',e=>gs.forEach(g=>$(g).style.display=e.target.checked?'':'none')));

// ---------- 镜头：平滑飞行。远距离时先拉远再推近（van Wijk & Nuij 2003 的最优缩放路径） ----------
const wait=ms=>new Promise(r=>setTimeout(r,ms));
let flyTok=0,flying=false;
function boxView(b,minSpan){const cx=(b[0]+b[2])/2,cy=(b[1]+b[3])/2,w=Math.max(b[2]-b[0],minSpan),h=Math.max(b[3]-b[1],minSpan*.6),padX=150,padT=90,padB=230;
  const k=Math.min((cw-2*padX)/(base*w),(ch-padT-padB)/(base*h)),v={cx,cy,k:Math.max(1.3,Math.min(k,8.5))};v.cy+=(padB-padT)/2/(base*v.k);return v}
function flyTo(v){flying=true;const tok=++flyTok,W0=cw/(base*view.k),W1=cw/(base*v.k),dx=v.cx-view.cx,dy=v.cy-view.cy,d2=dx*dx+dy*dy,x0=view.cx,y0=view.cy;
  const R=Math.SQRT2;let S,at;
  if(d2<1e-6){S=Math.log(W1/W0)/R;at=t=>[x0+t*dx,y0+t*dy,W0*Math.exp(R*t*S)]}
  else{const d1=Math.sqrt(d2),b0=(W1*W1-W0*W0+4*d2)/(2*W0*2*d1),b1=(W1*W1-W0*W0-4*d2)/(2*W1*2*d1),r0=Math.log(Math.sqrt(b0*b0+1)-b0),r1=Math.log(Math.sqrt(b1*b1+1)-b1);S=(r1-r0)/R;
    at=t=>{const s=t*S,c0=Math.cosh(r0),u=W0/(2*d1)*(c0*Math.tanh(R*s+r0)-Math.sinh(r0));return [x0+u*dx,y0+u*dy,W0*c0/Math.cosh(R*s+r0)]}}
  if(REDUCED||!isFinite(S)||Math.abs(S)<.03){flying=false;view={...v};commit();return Promise.resolve()}
  const dur=Math.max(700,Math.min(3000,Math.abs(S)*900));
  return new Promise(res=>{let t0=null;const step=ts=>{if(tok!==flyTok)return res();if(t0===null)t0=ts;const u=Math.min(1,(ts-t0)/dur),e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2,p=at(e);
    if(u<1){view={cx:p[0],cy:p[1],k:cw/(base*p[2])};preview();requestAnimationFrame(step)}else{flying=false;view={...v};commit();res()}};requestAnimationFrame(step)})}
function flyStop(){flyTok++;flying=false}

// ---------- 方位小图：左上角全图缩略，红框为当前视野，点击回到全景 ----------
function locSync(){const sc=base*view.k,w=cw/sc,h=ch/sc,r=$('loc-rect');
  r.setAttribute('x',view.cx-w/2);r.setAttribute('y',view.cy-h/2);r.setAttribute('width',w);r.setAttribute('height',h);
  $('loc').classList.toggle('show',view.k>1.15)}
$('loc').setAttribute('viewBox',`240 160 ${W-480} ${H-260}`);$('loc-land').setAttribute('d',BASE.land);
$('loc').addEventListener('click',()=>{if(mode==='battle')return;flyTo(homeV())});

// ---------- 配音 ----------
// 自动播放的每段讲解都经 narrate(文字, 音频地址, 最短毫秒, 时间戳)，返回 {done, stop}：
//   开了配音且数据里有音频（讲稿各段的 au，build 按 data/voice.json 填入）→ 播音频，播完才往下；
//   开了配音而无音频，或音频加载/播放失败（离线等）→ 用浏览器朗读（音色取决于系统）；没开配音 → 按字数估算阅读时长。
// 音频地址与逐词时间戳 tm 由 build 按 data/voice.json 填入（tools/voice.mjs 合成并上传）。
// 读字位置：播放中约每帧调用 narrPos(text, i)，i 为当前读到的字下标（只在变化时调用），自然读完以 text.length 收尾；
//   被打断（换站、暂停、新的 narrate）时调用 narrPos(null)。来源：音频按 tm 换算（无 tm 按时长比例）、浏览器朗读用 onboundary、
//   计时按经过时间线性估算。画面同步（字幕、闪标、镜头）只读这一个信号。
// 全程复用一个 Audio 元素：首次由点击播放解锁后，自动连播不会被浏览器（尤其 Safari）的自动播放策略拦下而退回机器朗读。
const VOICE={on:true},AU=new Audio();AU.preload='auto';let narrCur=null;
// tm：[厘秒, 字下标, Δ厘秒, Δ字下标, …] → {T:秒[], P:字下标[]}
function tmDecode(tm){if(!tm||!tm.length)return null;const T=[],P=[];let t=0,p=0;for(let i=0;i+1<tm.length;i+=2){t+=tm[i];p+=tm[i+1];T.push(t/100);P.push(p)}return {T,P}}
function tmAt(m,sec){let lo=0,hi=m.T.length-1;if(sec<m.T[0])return 0;while(lo<hi){const mid=(lo+hi+1)>>1;if(m.T[mid]<=sec)lo=mid;else hi=mid-1}return m.P[lo]}
function narrate(text,au,minMs,tm){narrStop();let fin,timer,raf,audio,tts=false,fell=false,live=true,pos=-1;const t0=performance.now(),map=tmDecode(tm);
  const report=i=>{i=Math.max(0,Math.min(i,text.length));if(i!==pos){pos=i;narrPos(text,i)}};
  const done=new Promise(r=>fin=r),end=()=>{if(live){live=false;cancelAnimationFrame(raf);report(text.length);fin()}};
  const est=Math.max(minMs||4500,text.length*85);
  const speak=()=>{if(!('speechSynthesis' in window)){timer=setTimeout(end,est);return}tts=true;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.onend=end;u.onerror=end;u.onboundary=e=>{if(live)report(e.charIndex)};speechSynthesis.speak(u);timer=setTimeout(end,est*4)};
  const fall=()=>{if(fell||!live)return;fell=true;audio.onended=audio.onerror=null;audio.pause();speak()};
  const tick=()=>{if(!live)return;
    if(audio&&!fell){const ct=audio.currentTime,d=audio.duration;if(ct>0)report(map?tmAt(map,ct):Math.floor(ct/(d>0?d:est/1000)*text.length))}
    else if(!tts)report(Math.floor((performance.now()-t0)/est*text.length));
    raf=requestAnimationFrame(tick)};
  if(VOICE.on&&au){audio=AU;audio.pause();audio.src=au;audio.onended=end;audio.onerror=fall;audio.play().catch(fall)}
  else if(VOICE.on)speak();
  else timer=setTimeout(end,est);
  report(0);raf=requestAnimationFrame(tick);
  return narrCur={done,stop(){if(live)narrPos(null);live=false;cancelAnimationFrame(raf);clearTimeout(timer);if(audio){audio.onended=audio.onerror=null;audio.pause()}if(tts)speechSynthesis.cancel()}}}
function narrStop(){if(narrCur){narrCur.stop();narrCur=null}}
$('nr-voice').addEventListener('click',()=>{VOICE.on=!VOICE.on;$('nr-voice').setAttribute('aria-pressed',VOICE.on);if(!VOICE.on)narrStop()});

// ---------- 画面同步：字幕、城邑闪标、政权高亮、镜头缓推（只读 narrPos 信号） ----------
// 每段文字的分句与专名按 年份+文字 缓存；narrPos 里只做下标比较和少量 DOM 改动。
const SY={cache:new Map(),dict:new Map(),cur:null,last:new Map(),hideT:0,user:false},STOPS='。！？；',CLOSE='”’」』）》',ONE='军朝国人廷主帝兵将境';
const esc=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function syncDict(){let d=SY.dict.get(year);if(d)return d;d=new Map();
  const add=(n,e)=>{if(!n)return;const a=d.get(n[0])||[];if(!a.some(x=>x.n===n)){a.push({n,...e});d.set(n[0],a)}};
  // 政权先入：与城邑同名（大理、于阗）时算政权
  for(const [id] of SNAP[snapIdx].p){const e={k:'p',id,col:shade(C.pol[id][1])};for(const n of [polInfo(id,SNAP[snapIdx].y).name,C.pol[id][0]]){add(n,e);add(n.replace(/（.*?）/g,''),e)}}
  // 城邑：全名、去括注名（临安府（行在）→临安府）、去京号名（东京开封府→开封府）、去「府州军…」的简称，以及 data/alias.json 的别名
  const short=n=>{const s=n.replace(/[府州军城寨堡]$/,'');return s!==n&&s.length>=2?s:null};
  C.city.forEach((c,k)=>{if(c[3]<=year&&year<=c[4]){const e={k:'c',id:k},n0=c[0].replace(/（.*?）/g,''),n1=n0.replace(/^(东京|西京|南京|北京|中都|上京)(?=.{2,}府$)/,'');
    for(const n of new Set([c[0],n0,n1,short(n0),short(n1),...(C.alias[n0]||[]),...(C.alias[n1]||[])]))add(n,e)}});
  for(const a of d.values())a.sort((x,y)=>y.n.length-x.n.length);SY.dict.set(year,d);return d}
function syncParse(text){const key=year+'|'+text;let r=SY.cache.get(key);if(r)return r;const d=syncDict(),S=[],M=[];
  let a=0;for(let i=0;i<text.length;i++)if(STOPS.includes(text[i])){let b=i+1;while(b<text.length&&CLOSE.includes(text[b]))b++;S.push([a,b]);a=b;i=b-1}
  if(a<text.length||!S.length)S.push([a,text.length]);
  // 长词优先、不重叠；单字政权名须后接「军朝国人廷主帝兵将境」之一
  for(let i=0,s=0;i<text.length;){let hit=null;for(const e of d.get(text[i])||[])if(text.startsWith(e.n,i)&&(e.n.length>1||ONE.includes(text[i+1]||''))){hit=e;break}
    if(!hit){i++;continue}while(S[s][1]<=i)s++;M.push({a:i,b:i+hit.n.length,k:hit.k,id:hit.id,col:hit.col,s});i+=hit.n.length}
  r={S,M,H:S.map((q,j)=>{let h='',p=q[0];for(const m of M)if(m.s===j){h+=esc(text.slice(p,m.a))+`<b class="n${m.k}"${m.col?` style="color:${m.col}"`:''}>${esc(text.slice(m.a,m.b))}</b>`;p=m.b}return h+esc(text.slice(p,q[1]))})};
  SY.cache.set(key,r);return r}
function narrPos(text,i){if(text==null)return syncClear();
  let c=SY.cur;
  if(!c||c.text!==text){SY.user=false;c=SY.cur={text,P:syncParse(text),s:-1,m:0,ft:flyTok};camPush(text)}
  const P=c.P;let s=Math.max(0,c.s);if(i<P.S[s][0])s=0;while(s<P.S.length-1&&P.S[s][1]<=i)s++;
  if(s!==c.s){c.s=s;
    if(film.on||mode==='battle'){const sub=$('nr-sub');clearTimeout(SY.hideT);sub.innerHTML=P.H[s];sub.classList.toggle('long',P.S[s][1]-P.S[s][0]>34);sub.hidden=false;if(!REDUCED&&sub.animate)sub.animate([{opacity:0},{opacity:1}],{duration:150})}}
  // 读到的专名：只触发当前句里的（跳读时略过前句）；同一实体两次触发至少隔 6 秒
  while(c.m<P.M.length&&P.M[c.m].a<=i){const m=P.M[c.m++],key=m.k+m.id,now=performance.now();if(m.s!==s||now-(SY.last.get(key)??-1e9)<6000)continue;SY.last.set(key,now);
    if(m.k==='c')flashCity(m.id);else flashPol(m.id)}
  if(i>=text.length){SY.cur=null;SY.hideT=setTimeout(()=>{$('nr-sub').hidden=true},900)}}
function syncClear(){SY.cur=null;clearTimeout(SY.hideT);$('nr-sub').hidden=true;camStop();
  document.querySelectorAll('#g-city .flash,#g-terr .hl').forEach(g=>{clearTimeout(g._flT);g.classList.remove('flash','hl')})}
// 城邑闪标：脉冲环 + 名字临时显示（不受 LOD/避让隐藏），约 2.5 秒
function flashCity(k){const g=CITY[k];clearTimeout(g._flT);if(!g._fr)g._fr=g.insertBefore(el('circle',{class:'fl',r:6}),g.firstChild);
  g.classList.remove('flash');void g.getBoundingClientRect();g.classList.add('flash');g._flT=setTimeout(()=>g.classList.remove('flash'),2500)}
// 政权高亮：疆域描边加粗、填充略提亮，约 2.5 秒；与选中态 sel 各用各的 class
function flashPol(id){for(const g of $('g-terr').children)if(g.dataset.id===id){clearTimeout(g._flT);g.classList.add('hl');g._flT=setTimeout(()=>g.classList.remove('hl'),2500)}}
// 镜头缓推：只在全片播放中的非战役段、非减少动态、本段用户没动过地图时。view.k = kb × pm
const CAM={on:false,raf:0,cx:0,cy:0,kb:1,pm:1,push:null};
const camOk=c=>film.on&&film.playing&&mode!=='battle'&&!REDUCED&&!SY.user&&flyTok===c.ft;
function camInit(){if(CAM.on)return;CAM.on=true;CAM.cx=view.cx;CAM.cy=view.cy;CAM.kb=view.k;CAM.pm=1;CAM.raf=requestAnimationFrame(camStep)}
function camStop(){cancelAnimationFrame(CAM.raf);CAM.push=null;if(CAM.on){CAM.on=false;commit()}}
function camStep(){const c=SY.cur;if(!c||!camOk(c))return camStop();const now=performance.now();
  if(CAM.push){const u=Math.min(1,(now-CAM.push.t0)/CAM.push.dur);CAM.pm=1+.06*(1-Math.cos(Math.PI*u))/2;if(u>=1)CAM.push=null}
  view={cx:CAM.cx,cy:CAM.cy,k:CAM.kb*CAM.pm};preview();CAM.cx=view.cx;CAM.cy=view.cy;
  if(CAM.push)CAM.raf=requestAnimationFrame(camStep);else{CAM.on=false;commit()}}
// 缓推：本段时长取时间戳末词（配音），否则估算
function camPush(text){camStop();if(!camOk(SY.cur))return;const f=FILM[film.i],m=tmDecode(f.tm);
  const sec=!VOICE.on?Math.max(4.5,text.length*.085):m&&f.au?m.T[m.T.length-1]+.5:text.length*.22;
  camInit();CAM.push={t0:performance.now(),dur:sec*1000}}

// ---------- 电影式界面：题签与自动隐藏的控制条 ----------
// 题签：换段时淡入，4 秒后转淡常驻（随时看得出在哪一段，又不抢画面）
let capT=0;
function capSet(h){const c=$('nr-cap');if(c.innerHTML===h)return;c.innerHTML=h;c.classList.remove('dim');clearTimeout(capT);capT=setTimeout(()=>c.classList.add('dim'),4000);
  if(!REDUCED&&c.animate)c.animate([{opacity:0},{opacity:1}],{duration:600})}
// 控制条：播放中鼠标静止 2.5 秒（指针不在控制条上）淡出；鼠标在地图上移动、按键或暂停时出现；触屏点地图空白处切换
let uiT=0;
const uiPlaying=()=>film.on?film.playing:mode==='battle'&&bt.playing;
function uiShow(){clearTimeout(uiT);uiT=0;wrap.classList.remove('idle');if(uiPlaying())uiT=setTimeout(uiHide,2500)}
function uiHide(){clearTimeout(uiT);uiT=0;if(!uiPlaying())return wrap.classList.remove('idle');if($('narr').matches(':hover'))return uiShow();wrap.classList.add('idle')}
// 播放状态或界面切换时调用：暂停即显示；播放中已隐去的保持隐去，显示着的照常计时（换段不重新弹出）
function uiSync(){if(!uiPlaying()){clearTimeout(uiT);uiT=0;wrap.classList.remove('idle')}else if(!uiT&&!wrap.classList.contains('idle'))uiT=setTimeout(uiHide,2500)}
wrap.addEventListener('pointermove',e=>{if(e.pointerType==='mouse')uiShow()});
wrap.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&uiPlaying())uiHide()});
wrap.addEventListener('pointerup',e=>{if(e.pointerType==='mouse'||moved>4||$('narr').hidden||e.target.closest('#narr,.tools,#ptoggle,#loc,.evm,.ct'))return;
  wrap.classList.contains('idle')||!uiPlaying()?uiShow():uiHide()});

// ---------- 缩放与拖动：手势期间只做合成变换，停手后再重绘 ----------
function clampView(){view.k=Math.max(1,Math.min(16,view.k));const vw=cw/(base*view.k),vh=ch/(base*view.k);
  view.cx=Math.max(vw/2,Math.min(W-vw/2,view.cx));view.cy=Math.max(vh/2,Math.min(H-vh/2,view.cy))}
let comT=0;
function commit(loadTiles=true){clearTimeout(comT);const r=wrap.getBoundingClientRect();if(!r.width)return;cw=r.width;ch=r.height;base=Math.max(cw/W,ch/H);clampView();
  const sc=base*view.k;svg.setAttribute('viewBox',`${view.cx-(cw/2+M)/sc} ${view.cy-(ch/2+M)/sc} ${(cw+2*M)/sc} ${(ch+2*M)/sc}`);
  stage.style.transform='';com={...view};locSync();
  svg.style.setProperty('--s',(Math.pow(view.k,.2)/sc).toFixed(4));
  svg.classList.toggle('z1',sc>1.45);svg.classList.toggle('z2',sc>2.5);svg.classList.toggle('z3',sc>4.6);
  const km=6100/W,target=110/sc*km,nice=[20,50,100,200,300,500,1000].reduce((a,b)=>Math.abs(b-target)<Math.abs(a-target)?b:a);
  $('scale').firstElementChild.style.width=(nice/km*sc)+'px';$('scale').lastElementChild.textContent=nice+' 公里';scheduleCull();if(loadTiles)tileSync()}
function preview(){clampView();const sc=base*view.k,ratio=view.k/com.k,tx=(com.cx-view.cx)*sc,ty=(com.cy-view.cy)*sc;
  if(ratio>1.7||ratio<.62||Math.abs(tx)>M*.8||Math.abs(ty)>M*.8)commit(false);
  else stage.style.transform=`translate(${tx}px,${ty}px) scale(${ratio})`;locSync();clearTimeout(comT);comT=setTimeout(commit,140)}
function zoomAt(f,px,py,now){SY.user=true;px=px??cw/2;py=py??ch/2;const s0=base*view.k,mx=view.cx+(px-cw/2)/s0,my=view.cy+(py-ch/2)/s0;
  view.k=Math.max(1,Math.min(16,view.k*f));const s1=base*view.k;view.cx=mx-(px-cw/2)/s1;view.cy=my-(py-ch/2)/s1;now?commit():preview()}
wrap.addEventListener('wheel',e=>{if(e.target.closest('.tools,#narr,#ptoggle,#loc'))return;e.preventDefault();flyStop();const r=wrap.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*.0016),e.clientX-r.left,e.clientY-r.top)},{passive:false});
const ptrs=new Map();let pinch=0,moved=0;
wrap.addEventListener('pointerdown',e=>{if(e.target.closest('.tools,#narr,#ptoggle,#loc')){moved=0;return}flyStop();ptrs.set(e.pointerId,[e.clientX,e.clientY]);moved=0;wrap.classList.add('drag')});
wrap.addEventListener('pointermove',e=>{if(!ptrs.has(e.pointerId))return;const p=ptrs.get(e.pointerId),dx=e.clientX-p[0],dy=e.clientY-p[1];
  if(ptrs.size===1){moved+=Math.abs(dx)+Math.abs(dy);if(moved>4){SY.user=true;try{wrap.setPointerCapture(e.pointerId)}catch(_){}view.cx-=dx/(base*view.k);view.cy-=dy/(base*view.k);preview()}ptrs.set(e.pointerId,[e.clientX,e.clientY])}
  else{ptrs.set(e.pointerId,[e.clientX,e.clientY]);const a=[...ptrs.values()],d=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);const r=wrap.getBoundingClientRect();
    if(pinch)zoomAt(d/pinch,(a[0][0]+a[1][0])/2-r.left,(a[0][1]+a[1][1])/2-r.top);pinch=d}});
const up=e=>{ptrs.delete(e.pointerId);pinch=0;if(!ptrs.size)wrap.classList.remove('drag')};
wrap.addEventListener('pointerup',up);wrap.addEventListener('pointercancel',up);
wrap.addEventListener('click',e=>{if(moved>4){e.stopPropagation();e.preventDefault()}},true);
$('zin').addEventListener('click',()=>zoomAt(1.5,null,null,true));$('zout').addEventListener('click',()=>zoomAt(1/1.5,null,null,true));
$('zfit').addEventListener('click',()=>flyTo({cx:W/2,cy:H/2,k:1}));
new ResizeObserver(commit).observe(wrap);

// ---------- 标注避让（只在重绘后跑一次） ----------
let cullT=0;function scheduleCull(){cancelAnimationFrame(cullT);cullT=requestAnimationFrame(cull)}
const CULL=[...CITY,...GAR].sort((a,b)=>a._c[4]-b._c[4]);
// 路线上的采样点（svg 坐标与沿线比例），驻军让位用
function routePts(g){if(!g._pts){const L=g._L||(g._L=g._ln.getTotalLength());g._pts=[];for(let i=0;i<=40;i++){const p=g._ln.getPointAtLength(L*i/40);g._pts.push([p.x,p.y,i/40])}}return g._pts}
// 战役浮签在镜头落定后按本步终点排一次；行军帧只沿用偏移，不参与选位。
function battleLayout(fixed,box,sc,vx,vy,ls){const notes=[...document.querySelectorAll('#g-bt .cl-note,#g-bt .take,#g-bt .act-note')],key=[bt.tok,com.cx,com.cy,com.k,cw,ch,btX,notes.length].join('/');
  if(bt.layout?.key===key){fixed.push(...bt.layout.boxes);return}
  const occupied=fixed.slice(),placed=[],points=[],P=(x,y)=>[(x-vx)*sc,(y-vy)*sc];
  for(const g of CULL)if(g._v&&getComputedStyle(g).display!=='none')for(const n of g.children){if(n.classList.contains('fl'))continue;const b=box(n);if(b[2]-b[0]>4&&b[3]-b[1]>2)occupied.push(b)}
  if(mode==='battle')for(let s=0;s<=bt.si;s++)for(const a of bt.steps[s][1])if(a[0]==='c'){const [x,y]=P(a[1],a[2]);occupied.push([x-10*ls,y-10*ls,x+10*ls,y+10*ls])}
  for(const [g,f] of bt.ends||[])if(f>0)for(const q of routePts(g))if(q[2]<=f+.02)points.push(P(q[0],q[1]));
  for(const p of document.querySelectorAll('#g-bt .adhoc')){const L=p.getTotalLength();for(let i=0;i<=40;i++){const q=p.getPointAtLength(L*i/40);points.push(P(q.x,q.y))}}
  const place=(n,at,b,z)=>{const [x,y]=P(...at),u=ls*z,cx=b.x+b.width/2,cy=b.y+b.height/2,candidates=[[0,0]];
    for(let d=12;d<=212;d+=20)candidates.push([d-b.x,-cy],[-d-b.x-b.width,-cy],[-cx,d-b.y],[-cx,-d-b.y-b.height],[d-b.x,d-b.y],[-d-b.x-b.width,d-b.y],[d-b.x,-d-b.y-b.height],[-d-b.x-b.width,-d-b.y-b.height]);
    let best=null;for(const [dx,dy] of candidates){const r=[x+(b.x+dx)*u-3,y+(b.y+dy)*u-3,x+(b.x+b.width+dx)*u+3,y+(b.y+b.height+dy)*u+3];let cost=Math.hypot(dx,dy)*u;
      for(const a of occupied){const w=Math.min(r[2],a[2])-Math.max(r[0],a[0]),h=Math.min(r[3],a[3])-Math.max(r[1],a[1]);if(w>0&&h>0)cost+=1000000+w*h*1000}
      const spill=Math.max(0,2-r[0])+Math.max(0,2-r[1])+Math.max(0,r[2]-cw+2)+Math.max(0,r[3]-ch+2);cost+=spill?1000000+spill*10000:0;
      for(const p of points)if(p[0]>r[0]-3&&p[0]<r[2]+3&&p[1]>r[1]-3&&p[1]<r[3]+3)cost+=24;
      if(!best||cost<best.cost)best={dx,dy,r,cost}}
    n._dx=best.dx;n._dy=best.dy;occupied.push(best.r);placed.push(best.r);
    if(n.classList.contains('tok')){if(n._tf)n.style.transform=n._tf+` translate(${n._dx}px,${n._dy}px)`}
    else{n.setAttribute('transform',`translate(${n._dx},${n._dy})`);const x0=b.x+n._dx,y0=b.y+n._dy,tx=Math.max(x0,Math.min(x0+b.width,0)),ty=Math.max(y0,Math.min(y0+b.height,0));n._lead.setAttribute('d',Math.hypot(tx,ty)>12?`M0,0L${tx},${ty}`:'')}};
  const troops=[...(mode==='battle'?bt.ends||[]:[])].filter(([g,f])=>f>0&&armyTok(g));troops.sort((a,b)=>b[0]._tk._box.width-a[0]._tk._box.width);
  for(const [g,f] of troops){const p=g._ln.getPointAtLength((g._L||g._ln.getTotalLength())*f);place(g._tk,[p.x,p.y],g._tk._box,g._tk._z)}
  const flags=new Map();for(const n of notes)if(n.classList.contains('take')){const at=n._at.join(',');if(!flags.has(at))flags.set(at,[]);flags.get(at).push(n)}else place(n,n._at,n.getBBox(),1);
  // 同城先后易手仍由最后一面旗盖住旧旗，避免避让时把旧归属摊开。
  for(const group of flags.values()){const n=group.at(-1);place(n,n._at,n.getBBox(),1);for(const old of group.slice(0,-1)){old.setAttribute('transform',n.getAttribute('transform'));old._lead.setAttribute('d',n._lead.getAttribute('d'))}}
  bt.layout={key,boxes:placed};fixed.push(...placed)}
function cull(){const sc=base*com.k,vx=com.cx-cw/(2*sc),vy=com.cy-ch/(2*sc),ls=Math.pow(com.k,.2),z1=sc>1.45,z2=sc>2.5,acc=[],fixed=[],labs=[],bat=mode==='battle',bx=bat&&btX;
  // 1) 区域名、当前大事名、路线名先占位；战役浮签等城名排好再放
  const r0=wrap.getBoundingClientRect();
  const box=n=>{const b=n.getBoundingClientRect();return [b.left-r0.left-2,b.top-r0.top-1,b.right-r0.left+2,b.bottom-r0.top+1]};
  const hits=(x0,y0,w,h,arr)=>{for(const a of arr)if(x0<a[2]&&x0+w>a[0]&&y0<a[3]&&y0+h>a[1])return true;return false};
  for(const n of document.querySelectorAll('#g-bt text,#g-ev .evm.cur text,#g-rt .rl text')){if(n.closest('.cl-note,.take,.act-note'))continue;if(n.getBoundingClientRect().width&&getComputedStyle(n).opacity!=='0')fixed.push(box(n))}
  // 压在地图上的界面（题签、方位小图、工具条、控制条、比例尺）：注记不钻到它们底下
  for(const n of document.querySelectorAll('#nr-cap:not([hidden]),#loc.show,.tools,#narr:not([hidden]),#ptoggle,#scale'))if(n.getBoundingClientRect().width)fixed.push(box(n))
  // 战役中的行军线（已画出的部分）与临时箭头：驻军压上就让位
  const lines=[];if(bat){const P=(x,y)=>[(x-vx)*sc,(y-vy)*sc];
    for(const g of ROUTE)if(g._f>0&&g.classList.contains('foc'))for(const q of routePts(g))if(q[2]<=g._f+.02)lines.push(P(q[0],q[1]));
    for(const p of document.querySelectorAll('#g-bt .adhoc')){const L=p.getTotalLength();for(let i=0;i<=24;i++){const q=p.getPointAtLength(L*i/24);lines.push(P(q.x,q.y))}}}
  // 战役细览：本战全部路线（含未画出的部分）的屏幕点，小州只显示路线 110px 以内的
  const rtAll=[];if(bat)for(const g of ROUTE)if(g.classList.contains('foc'))for(const q of routePts(g))rtAll.push([(q[0]-vx)*sc,(q[1]-vy)*sc]);
  const nearRoute=(x,y)=>{for(const p of rtAll)if((p[0]-x)**2+(p[1]-y)**2<12100)return true;return false};
  const nearLine=(x0,y0,x1,y1)=>{for(const p of lines)if(p[0]>x0-6&&p[0]<x1+6&&p[1]>y0-6&&p[1]<y1+6)return true;return false};
  // 2) 城邑、驻军：按等级依次放（战役中相关城邑最先），首选方位撞上就依次试右、左、上、下，都不行才藏名字
  const shown=g=>{const lv=g._c[6],rel=g.classList.contains('rel');
    if(bat&&!bx)return lv===3||rel;if(bat&&rel)return true;
    if(lv===4&&bx&&!rtAll.length)return false;if(lv>=4)return (mode==='explore'||bx)&&z2;if(lv<=1)return z1;return true};
  const list=bat?[...CITY.filter(g=>g.classList.contains('rel')),...CULL.filter(g=>!g.classList.contains('rel'))]:CULL;
  const on=list.filter(g=>{if(!g._v||!shown(g))return false;const x=(g._c[0]-vx)*sc,y=(g._c[1]-vy)*sc;
    if(x<-80||y<-30||x>cw+80||y>ch+30){if(g._h){g._h=false;g.classList.remove('hid')}return false}
    if(bx&&g._c[6]===4&&!g.classList.contains('rel')&&!nearRoute(x,y)){if(!g._h){g._h=true;g.classList.add('hid')}return false}g._x=x;g._y=y;return true});
  // 「宋」是主角，大字不转淡：先占位，普通城邑名绕开它
  for(const t of $('g-pl').children)if(t.dataset.id==='song'){const b=box(t);if(b[2]>b[0])acc.push(b)}
  // 先把看得见的城邑符号都占上，名字不压别家的点
  for(const g of on)if(g._c[6]!==5){const q=(g._c[7]+1)*ls;acc.push([g._x-q,g._y-q,g._x+q,g._y+q])}
  for(const g of on){const c=g._c,lv=c[6],x=g._x,y=g._y;
    if(lv===5){const w=c[2]*c[3]*ls*1.05+4,h=c[3]*ls*1.25,x0=x-w/2,y0=y+10*ls,top=y-14*ls;
      const yd=bat&&(hits(x-6*ls,top,w>12*ls?w:12*ls,y0+h-top,fixed)||nearLine(x0,top,x0+w,y0+h));if(g._yd!==yd){g._yd=yd;g.classList.toggle('yd',yd)}
      const hit=yd||hits(x0,y0,w,h,fixed)||hits(x0,y0,w,h,acc);if(g._h!==hit){g._h=hit;g.classList.toggle('hid',hit)}if(!hit){acc.push([x0,y0,x0+w,y0+h]);labs.push(acc.at(-1))}continue}
    const rel=bat&&g.classList.contains('rel'),f=(rel?Math.max(c[3],12):c[3])*ls,R=c[7]*ls,w=c[2]*f*1.04+3,h=f*1.2;
    const at=an=>[an==='l'?x-R-3*ls-w:an==='r'?x+R+3*ls:x-w/2,an==='a'?y-R-3*ls-f*1.02:an==='b'?y+R+2*ls:y-h/2];
    let got=null;for(const an of [c[5],...'rlab'].filter((v,i,a)=>a.indexOf(v)===i)){const [x0,y0]=at(an);if(!hits(x0,y0,w,h,fixed)&&!hits(x0,y0,w,h,acc)){got=[an,x0,y0];break}}
    // 都城的名字只让位给第 1 类（战役标注、部队标记等）
    let hit=!got;if(hit&&lv===3)for(const an of [c[5],...'rlab']){const [x0,y0]=at(an);if(!hits(x0,y0,w,h,fixed)){hit=false;got=[an,x0,y0];break}}
    if(got)cityAnchor(g,got[0]);
    if(g._h!==hit){g._h=hit;g.classList.toggle('hid',hit)}
    if(got){acc.push([got[1],got[2],got[1]+w,got[2]+h]);labs.push(acc.at(-1))}}
  if(bat||bt.preNode)battleLayout(fixed,box,sc,vx,vy,ls);
  // 3) 山川、部族、路名、河名：最后放，撞上任何东西就藏
  for(const g of TXT){if(!(g._rv?g._rv._v:g._v))continue;const [tx,ty,n,fs,sp]=g._tl,x=(tx-vx)*sc,y=(ty-vy)*sc;
    if(x<-120||y<-30||x>cw+120||y>ch+30)continue;const w=n*fs*(1+sp)*ls,h=fs*ls*1.2,x0=x-w/2,y0=y-h/2;
    const hit=hits(x0,y0,w,h,fixed)||hits(x0,y0,w,h,acc);if(g._h!==hit){g._h=hit;g.classList.toggle('hid',hit)}if(!hit)acc.push([x0,y0,x0+w,y0+h])}
  // 4) 政权大字不让位，只在压到城邑注记时转淡
  for(const t of $('g-pl').children){if(t.dataset.id==='song'){if(t._d){t._d=false;t.classList.remove('dim')}continue}const b=box(t),d=hits(b[0],b[1],b[2]-b[0],b[3]-b[1],labs);if(t._d!==d){t._d=d;t.classList.toggle('dim',d)}}}

$('aboutbtn').addEventListener('click',()=>$('about').classList.add('open'));
$('aboutclose').addEventListener('click',()=>$('about').classList.remove('open'));
$('about').addEventListener('click',e=>{if(e.target.id==='about')$('about').classList.remove('open')});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if($('about').classList.contains('open'))$('about').classList.remove('open');else if(film.on)filmEnd();else if(mode==='battle')leaveBattle(true)}
  if(film.on||mode==='battle')uiShow();
  // 空格：全片播放/暂停（手动战役中为该战播放/暂停）；文字输入框与按钮聚焦时不拦，按钮的空格照常按下它
  if(e.key===' '&&!e.repeat&&!e.target.closest('textarea,select,button,[contenteditable],input:not([type=range])')&&!$('about').classList.contains('open')){e.preventDefault();if(mode==='battle'&&!film.on)$('nr-play').click();else filmToggle();return}
  if(e.target.tagName!=='INPUT'&&e.target.tagName!=='BUTTON'){if(film.on||mode==='battle'){if(e.key==='ArrowRight')$('nr-next').click();if(e.key==='ArrowLeft')$('nr-prev').click();return}if(e.key==='ArrowRight')userYear(year+1);if(e.key==='ArrowLeft')userYear(year-1)}});

{const r=wrap.getBoundingClientRect();cw=r.width||1;ch=r.height||1;base=Math.max(cw/W,ch/H)}
// 初始：960 年宋建国，视野框住宋与南方诸国
homeView();panelSync();if(!route())setYear(960);card();addEventListener('hashchange',()=>{if(location.hash!==lastHash)route()});
$('snapn').textContent=SNAP.length;
