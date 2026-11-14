// 时间戳与音频对齐自检：豆包偶发返回错位的逐词时间戳（音频完好，字幕却越走越偏，曾见于 #f=42）。
// 做法：把 mp3 解成 10 ms 一帧的能量包络（需本机 ffmpeg，没有就返回 null 跳过），找两类矛盾——
//   幻停：时间戳说这里停了 ≥ 0.4 s，这段里最安静的 80 ms 仍明显在出声（> 语音能量 30%）；
//   漏停：音频里有 ≥ 0.4 s 的静音（< 语音能量 15%），时间戳却说正在读某个词。
// 标定（2026-11，全片 370 段）：正常段幻停几乎都是 0、最多 2，错位段成串出现；漏停未见。
// 不用「词很短」判错：列举地名（幽、蓟、瀛、莫）时豆包的词尾时间常很短，起点却是准的，前端只用起点。
import {execFileSync} from 'node:child_process';

function envelope(mp3){
  let pcm;
  try{pcm=execFileSync('ffmpeg',['-v','quiet','-i','pipe:0','-ac','1','-ar','8000','-f','s16le','-'],{input:mp3,maxBuffer:1<<28})}
  catch{return null}
  const out=[];
  for(let i=0;i+80<=pcm.length>>1;i+=80){let s=0;for(let k=0;k<80;k++){const x=pcm.readInt16LE((i+k)*2);s+=x*x}out.push(Math.sqrt(s/80))}
  return out.length?out:null;
}
export function alignStats(mp3,sentences){
  const e=envelope(mp3);if(!e)return null;
  const loud=[...e].sort((a,b)=>a-b)[Math.floor(e.length*0.6)],quiet=loud*0.15,speaking=loud*0.3;
  const ws=sentences.flatMap(s=>s.words||[]),at=t=>Math.max(0,Math.min(e.length-1,Math.round(t*100)));
  let phantom=0,missed=0;const where=[];
  for(let j=0;j+1<ws.length;j++){
    const a=at(ws[j].endTime??ws[j].startTime),b=at(ws[j+1].startTime);if(b-a<40)continue;
    let min=Infinity;for(let t=a;t+8<=b;t++){let s=0;for(let k=0;k<8;k++)s+=e[t+k];min=Math.min(min,s/8)}
    if(min>speaking){phantom++;where.push(a/100)}
  }
  for(const w of ws){
    const a=at(w.startTime),b=at(w.endTime??w.startTime);let run=0,max=0;
    for(let t=a;t<b;t++){run=e[t]<quiet?run+1:0;max=Math.max(max,run)}
    if(max>=40){missed++;where.push(a/100)}
  }
  return {phantom,missed,first:where.length?Math.min(...where):null};
}
// 返回问题描述；'' 为通过；null 为无法检查（没有 ffmpeg）
export function alignIssue(mp3,sentences){
  const r=alignStats(mp3,sentences);if(!r)return null;
  if(r.phantom+r.missed>=3)return `时间戳与音频错位（幻停 ${r.phantom}、漏停 ${r.missed}，约从 ${r.first.toFixed(0)} 秒起）`;
  return '';
}
