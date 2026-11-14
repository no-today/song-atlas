// 复刻音色 → 本地缓存 → R2；npm run voice -- --dry / --only 文字前缀 / --from 段 / --to 段 / --redo / --verify / --tm。
// 段号同页面地址 #f=段号（从 1 起）；--redo 对选中段丢掉本地缓存重新合成；--fix 只重做自检不过的段。
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadData,narrations} from './data.mjs';
import {writeJson} from './json.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=join(root,'data/voice.json'),cache=join(root,'.cache/voice');
const sha=value=>createHash('sha256').update(value).digest('hex');
const short=value=>sha(value).slice(0,16);
const params={audio_params:{format:'mp3',sample_rate:24000,speech_rate:25,enable_subtitle:true},tone_fidelity:true};
const stats={synth:0,upload:0,skip:0,words:0,tm:0,unaligned:0},failures=[];
let env={};

// 不读取 process.env，不执行变量替换；支持引号、空行、注释与 export。
function readEnv(){
  const out={};
  for(const line of readFileSync(join(root,'.env'),'utf8').split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if(!m)continue;
    let value=m[2];
    if(value.startsWith('"')){
      const q=value.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
      if(!q)throw new Error(`.env 的 ${m[1]} 引号不完整`);
      value=q[1].replace(/\\([nrt"\\])/g,(_,c)=>({n:'\n',r:'\r',t:'\t','"':'"','\\':'\\'}[c]));
    }else if(value.startsWith("'")){
      const q=value.match(/^'([^']*)'\s*(?:#.*)?$/);
      if(!q)throw new Error(`.env 的 ${m[1]} 引号不完整`);
      value=q[1];
    }else value=value.replace(/\s+#.*$/,'').trim();
    out[m[1]]=value;
  }
  return out;
}
function requireEnv(keys){
  const missing=keys.filter(k=>!env[k]);
  if(missing.length)throw new Error('缺少 .env 字段：'+missing.join('、'));
}
function safe(message){
  let result=String(message);
  for(const k of ['VOLC_API_KEY','VOLC_SPEAKER','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'])
    if(env[k])result=result.split(env[k]).join('[已隐藏]');
  return result;
}
function options(){
  const opts={dry:false,verify:false,tm:false,redo:false,fix:false,only:undefined,from:1,to:Infinity},args=process.argv.slice(2);
  while(args.length){
    const arg=args.shift();
    if(arg==='--dry')opts.dry=true;
    else if(arg==='--verify')opts.verify=true;
    else if(arg==='--tm')opts.tm=true;
    else if(arg==='--only'){
      if(!args[0]||args[0].startsWith('--'))throw new Error('--only 需要非空文字前缀');
      opts.only=args.shift();
    }else if(arg==='--from'||arg==='--to'){
      const n=Number(args.shift());
      if(!Number.isInteger(n)||n<1)throw new Error(arg+' 需要段号（正整数）');
      opts[arg.slice(2)]=n;
    }else if(arg==='--redo')opts.redo=true;
    else if(arg==='--fix')opts.fix=true;
    else throw new Error('仅支持 --dry、--only <文字前缀>、--from <段>、--to <段>、--redo、--fix、--verify、--tm');
  }
  const narrow=opts.dry||opts.redo||opts.fix||opts.only!==undefined||opts.from!==1||opts.to!==Infinity;
  if(opts.verify&&(opts.tm||narrow))throw new Error('--verify 请单独使用');
  if(opts.tm&&narrow)throw new Error('--tm 请单独使用');
  if(opts.from>opts.to)throw new Error('--from 不能大于 --to');
  return opts;
}
function voiceBase(){
  requireEnv(['VOICE_BASE']);
  const url=new URL(env.VOICE_BASE);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)
    throw new Error('VOICE_BASE 须为不含认证信息、查询参数或片段的 HTTPS 地址');
  return url.href.replace(/\/+$/,'');
}
function parseObjects(raw){
  const objs=[];let depth=0,start=-1,inStr=false,esc=false;
  for(let i=0;i<raw.length;i++){
    const c=raw[i];
    if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c==='"')inStr=false;continue}
    if(c==='"'){if(!depth)throw new Error('响应 JSON 对象不完整');inStr=true}
    else if(c==='{'){if(depth++===0)start=i}
    else if(c==='}'){
      if(!depth)throw new Error('响应 JSON 对象不完整');
      if(--depth===0)objs.push(JSON.parse(raw.slice(start,i+1)));
    }else if(!depth&&!/\s/.test(c))throw new Error('响应不是 JSON 对象流');
  }
  if(depth||inStr||!objs.length)throw new Error('响应 JSON 对象不完整');
  return objs;
}
// 豆包偶发两种坏结果，且同一段文字往往重现：①读到一半就结束（尾部没读）；②读完后又多出一截没有时间戳的语音。
// 对策：①把没读的尾巴单独再合成一次，接在后面（最多 4 截）；②按最后一个词的结束时间裁掉多余的音频。
// mp3 为 24 kHz MPEG-2 Layer III，每帧 576 样本 = 24 ms，按帧裁剪与拼接。
const FRAME=0.024;
function mp3Frames(buf){
  let p=0;if(buf.slice(0,3).toString('latin1')==='ID3')p=10+((buf[6]&127)<<21|(buf[7]&127)<<14|(buf[8]&127)<<7|buf[9]&127);
  const BR=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],SR=[22050,24000,16000],out=[];
  while(p+4<=buf.length){
    if(buf[p]!==0xff||(buf[p+1]&0xe0)!==0xe0){p++;continue}
    const br=BR[buf[p+2]>>4],sr=SR[(buf[p+2]>>2)&3],pad=(buf[p+2]>>1)&1;
    if(!br||!sr){p++;continue}
    const len=Math.floor(72*br*1000/sr)+pad;if(p+len>buf.length)break;
    const tag=buf.slice(p+4,p+40).toString('latin1');
    if(!(out.length===0&&/Xing|Info/.test(tag)))out.push(buf.slice(p,p+len));
    p+=len;
  }
  return out;
}
async function synthOnce(item,text){
  const response=await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional',{
    method:'POST',signal:AbortSignal.timeout(120000),
    headers:{'Content-Type':'application/json','X-Api-Key':env.VOLC_API_KEY,
      'X-Api-Resource-Id':'seed-icl-2.0','X-Api-Request-Id':randomUUID(),
      'X-Control-Require-Usage-Tokens-Return':'*'},
    body:JSON.stringify({req_params:{text,speaker:env.VOLC_SPEAKER,
      audio_params:params.audio_params,additions:JSON.stringify({tone_fidelity:params.tone_fidelity,
        pronunciation_dict:{tone:item.dict.filter(entry=>text.includes(entry.split('/')[0]))}})}})
  });
  const logid=response.headers.get('x-tt-logid')||'无';
  item.logid=logid;
  console.log(`合成 ${item.tsha} logid=${safe(logid)}`);
  const raw=await response.text();
  let objs;
  try{objs=parseObjects(raw)}catch{throw new Error(`合成 HTTP ${response.status}：响应 JSON 无法解析`)}
  // text_words 是本次请求的用量汇总，响应可能在多个对象中重复携带。
  const usage=objs.find(o=>o.usage?.text_words!==undefined)?.usage.text_words;
  if(Number.isFinite(Number(usage)))stats.words+=Number(usage);
  const bad=objs.find(o=>o.code&&o.code!==20000000&&o.code!==0);
  const audio=Buffer.concat(objs.filter(o=>o.data).map(o=>Buffer.from(o.data,'base64')));
  if(!response.ok||bad||!audio.length)
    throw new Error(`合成 HTTP ${response.status}，code=${bad?.code??'无'}，${bad?.message??'无音频或请求失败'}`);
  const sentences=objs.filter(o=>o.sentence).map(o=>o.sentence);
  if(!sentences.length)throw new Error('合成成功但没有返回时间戳');
  return {frames:mp3Frames(audio),sentences};
}
async function synthesize(item){
  let rest=item.text,t0=0;const frames=[],sentences=[];
  for(let piece=0;rest&&piece<4;piece++){
    const r=await synthOnce(item,rest);
    let cursor=0,lastEnd=0;const words=[];
    for(const s of r.sentences)for(const w of s.words||[]){const i=rest.indexOf(w.word,cursor);if(i<0)continue;cursor=i+w.word.length;lastEnd=w.endTime??w.startTime;words.push(w)}
    if(!words.length)throw new Error('合成不完整：一个字也没读');
    // 裁到最后一个词后 0.5 秒（多读的那截没有时间戳）
    const keep=Math.min(r.frames.length,Math.ceil((lastEnd+0.5)/FRAME));
    frames.push(...r.frames.slice(0,keep));
    sentences.push({text:rest.slice(0,cursor),words:words.map(w=>({...w,startTime:w.startTime+t0,endTime:(w.endTime??w.startTime)+t0}))});
    t0+=keep*FRAME;
    rest=[...rest.slice(cursor)].some(c=>!PUNCT.test(c))?rest.slice(cursor).replace(/^[，。！？；：、”」\s]+/,''):'';
    if(rest)console.log(`  ${item.tsha} 尾部 ${rest.length} 字没读，补合成第 ${piece+2} 截`);
  }
  const audio=Buffer.concat(frames);
  checkTake(item.text,sentences,audio);
  // 完整收到并确认成功后才让缓存文件可见；上传重试无需再次计费合成。先写时间戳，mp3 落盘即视为缓存完整。
  writeFileSync(item.timing,JSON.stringify(sentences));
  writeFileSync(item.local+'.tmp',audio);
  renameSync(item.local+'.tmp',item.local);
  stats.synth++;
}
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
async function upload(file,local,type,base){
  const audio=readFileSync(local),payload=sha(audio);
  const prefix=decodeURIComponent(new URL(base).pathname).replace(/^\/+|\/+$/g,'');
  const key=(prefix?prefix+'/':'')+file;
  const url=new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`+
    [env.R2_BUCKET,...key.split('/')].map(encode).join('/'));
  const date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
  const headers={'cache-control':'public, max-age=31536000, immutable','content-type':type,
    host:url.host,'x-amz-content-sha256':payload,'x-amz-date':date};
  const names=Object.keys(headers).sort(),signed=names.join(';');
  const canonical=['PUT',url.pathname,'',names.map(k=>k+':'+headers[k]+'\n').join(''),signed,payload].join('\n');
  const scope=day+'/auto/s3/aws4_request';
  const signing=hmac(hmac(hmac(hmac('AWS4'+env.R2_SECRET_ACCESS_KEY,day),'auto'),'s3'),'aws4_request');
  const signature=createHmac('sha256',signing).update('AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+sha(canonical)).digest('hex');
  const response=await fetch(url,{method:'PUT',signal:AbortSignal.timeout(120000),headers:{...headers,
    authorization:`AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed}, Signature=${signature}`},body:audio});
  if(!response.ok){
    // 不输出响应原文，避免服务端错误回显认证头。
    await response.body?.cancel();
    throw new Error(`R2 上传 HTTP ${response.status}`);
  }
  await response.body?.cancel();
  stats.upload++;
}
const cached=item=>existsSync(item.local)&&existsSync(item.timing);
async function pool(items,fn){
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{
    while(next<items.length)await fn(items[next++]);
  }));
}
async function verify(voice,base){
  const files=[...new Set(Object.values(voice.au))];let failed=0;
  await pool(files,async file=>{
    try{
      const response=await fetch(base+'/'+file,{method:'HEAD',signal:AbortSignal.timeout(30000)});
      if(!response.ok){failed++;console.error(`音频 HTTP ${response.status}：${file}`)}
    }catch{failed++;console.error(`音频 HEAD 请求失败：${file}`)}
  });
  console.log(`校验 ${files.length} 个文件 / 失败 ${failed} 个`);
  if(failed)process.exitCode=1;
}
// 合成结果自检：偶发整段尾部没读（音频在中途结束）、尾部长静音、句中长停顿——都会让字幕与声音对不上，抛错触发重合成。
const PUNCT=/[，。！？；：、“”「」《》\s]/;
function takeIssue(text,sentences,bytes){
  let cursor=0,prevEnd=0,pause=0;
  for(const sentence of sentences)for(const {word,startTime,endTime} of sentence.words||[]){
    const i=text.indexOf(word,cursor);if(i<0)continue;
    pause=Math.max(pause,startTime-prevEnd);prevEnd=endTime??startTime;cursor=i+word.length;
  }
  const tail=[...text.slice(cursor)].filter(c=>!PUNCT.test(c)).length,dur=bytes;
  if(tail)return `末尾 ${tail} 字没读`;
  if(dur-prevEnd>3)return `尾部多出无字幕的音频 ${(dur-prevEnd).toFixed(1)} 秒`;
  if(pause>4)return `句中停顿 ${pause.toFixed(1)} 秒`;
  return '';
}
function checkTake(text,sentences,bytes){const issue=takeIssue(text,sentences,mp3Frames(bytes).length*FRAME);if(issue)throw new Error('合成不完整：'+issue)}
function compressTiming(text,sentences){
  const out=[];let cursor=0,prevTime=0,prevIndex=0;
  for(const sentence of sentences)for(const {word,startTime} of sentence.words||[]){
    const i=text.indexOf(word,cursor);
    if(i<0){stats.unaligned++;continue}
    const time=Math.round(startTime*100);
    if(!Number.isSafeInteger(time)||time<prevTime)throw new Error('时间戳须为非负、递增的秒数');
    out.push(time-prevTime,i-prevIndex);
    prevTime=time;prevIndex=i;cursor=i+word.length;
  }
  return out;
}
async function readTiming(text,file){
  const timingFile=file.replace(/\.mp3$/,'.json'),local=join(cache,timingFile);
  let sentences;
  if(existsSync(local))sentences=JSON.parse(readFileSync(local,'utf8'));
  else{
    const response=await fetch(voiceBase()+'/'+timingFile,{signal:AbortSignal.timeout(30000)});
    if(!response.ok){await response.body?.cancel();throw new Error(`时间戳 GET HTTP ${response.status}`)}
    sentences=await response.json();
  }
  return compressTiming(text,sentences);
}
async function completeTiming(voice,items,save){
  await pool(items.filter(item=>voice.au[item.tsha]&&!voice.tm[item.tsha]),async item=>{
    try{
      const tm=await readTiming(item.text,voice.au[item.tsha]);
      voice.tm[item.tsha]=tm;stats.tm++;save();
    }catch(error){failures.push({tsha:item.tsha,message:safe(error.message),logid:'无'})}
  });
}
function reportTiming(){
  console.log(`时间戳补全 ${stats.tm} 段 / 未对齐 ${stats.unaligned} 词`);
}
async function main(){
  const opts=options();env=opts.tm&&!existsSync(join(root,'.env'))?{}:readEnv();
  const voice=existsSync(manifest)?JSON.parse(readFileSync(manifest,'utf8')):{base:'',au:{}};
  voice.tm??={};
  if(opts.verify){await verify(voice,voiceBase());return}
  const {C}=loadData(root);
  // 同文的段只合成一次；segs 记下它出现的段号
  const byTsha=new Map();
  narrations(C).forEach(({text},i)=>{const tsha=short(text);if(!byTsha.has(tsha))byTsha.set(tsha,{text,tsha,segs:[]});byTsha.get(tsha).segs.push(i+1)});
  const texts=[...byTsha.values()];
  const current=new Set(texts.map(item=>item.tsha));
  const save=()=>{
    voice.au=Object.fromEntries(Object.entries(voice.au).filter(([tsha])=>current.has(tsha)).sort(([a],[b])=>a.localeCompare(b)));
    voice.tm=Object.fromEntries(Object.keys(voice.au).filter(tsha=>voice.tm[tsha]).map(tsha=>[tsha,voice.tm[tsha]]));
    writeJson(manifest,voice);
  };
  if(opts.tm){
    save();await completeTiming(voice,texts,save);
    for(const failure of failures)console.error(`失败 ${failure.tsha}：${failure.message}`);
    reportTiming();
    if(failures.length)process.exitCode=1;
    return;
  }
  requireEnv(['VOLC_SPEAKER']);
  const dict=JSON.parse(readFileSync(join(root,'data/lexicon.json'),'utf8'));
  const items=texts.map(({text,tsha,segs})=>{
    const localDict=dict.filter(entry=>text.includes(entry.split('/')[0])).sort();
    const fsha=short(JSON.stringify({text,speaker:env.VOLC_SPEAKER,params,dict:localDict}));
    const file=fsha+'.mp3';
    return {text,tsha,segs,file,dict:localDict,local:join(cache,file),timing:join(cache,fsha+'.json'),logid:'无'};
  });
  const selected=items.filter(item=>(opts.only===undefined||item.text.startsWith(opts.only))&&item.segs.some(n=>n>=opts.from&&n<=opts.to));
  // --fix：已合成的段里，自检不过的（尾部没读、长静音、长停顿）强制重合成
  if(opts.fix){
    for(const item of selected)if(cached(item)){const issue=takeIssue(item.text,JSON.parse(readFileSync(item.timing,'utf8')),mp3Frames(readFileSync(item.local)).length*FRAME);if(issue){item.redo=true;console.log(`#${item.segs.join(',')} ${issue}`)}}
  }
  const pending=selected.filter(item=>opts.redo||item.redo||voice.au[item.tsha]!==item.file);
  stats.skip=selected.length-pending.length;
  if(opts.dry){
    console.log(`待合成 ${pending.length} 段 / 总字数 ${pending.reduce((n,item)=>n+Array.from(item.text).length,0)}（选中 ${selected.length} 段 / 已完成 ${stats.skip} 段）`);
    return;
  }
  const base=voiceBase();
  if(pending.length){
    requireEnv(['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET']);
    if(opts.redo||opts.fix||pending.some(item=>!cached(item)))requireEnv(['VOLC_API_KEY']);
  }
  voice.base=base;
  mkdirSync(cache,{recursive:true});
  save();
  await completeTiming(voice,items,save);
  await pool(pending,async item=>{
    for(let attempt=0;attempt<3;attempt++){
      try{
        if(opts.redo||item.redo||!cached(item)){await synthesize(item);item.redo=false}
        const tm=await readTiming(item.text,item.file);
        await upload(item.file,item.local,'audio/mpeg',base);
        await upload(item.file.replace(/\.mp3$/,'.json'),item.timing,'application/json',base);
        voice.au[item.tsha]=item.file;voice.tm[item.tsha]=tm;stats.tm++;save();
        console.log(`完成 ${item.tsha} → ${item.file}`);
        return;
      }catch(error){
        const message=safe(error.message);
        if(attempt<2){
          console.error(`重试 ${attempt+1}/2 ${item.tsha}：${message}，logid=${safe(item.logid)}`);
          await delay((attempt+1)*1000);
        }else failures.push({tsha:item.tsha,message,logid:safe(item.logid)});
      }
    }
  });
  for(const failure of failures)console.error(`失败 ${failure.tsha}：${failure.message}，logid=${failure.logid}`);
  console.log(`合成 ${stats.synth} 段 / 上传 ${stats.upload} 段 / 跳过 ${stats.skip} 段 / 失败 ${failures.length} 段；计费字数合计 ${stats.words}`);
  reportTiming();
  if(failures.length)process.exitCode=1;
}
main().catch(error=>{console.error(safe(error.message));process.exitCode=1});
