// data/*.json 的统一写法：一条记录一行，便于 diff 与合并。
// 顶层是对象且值也是对象（如 pol、lab、shi）时，再展开一层。
import {writeFileSync} from 'node:fs';
const J=v=>JSON.stringify(v);
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const inner=(v,ind)=>isObj(v)?'{\n'+Object.entries(v).map(([k,x])=>ind+'  '+J(k)+': '+J(x)).join(',\n')+'\n'+ind+'}':J(v);
export const fmt=v=>Array.isArray(v)?(v.length?'[\n'+v.map(J).join(',\n')+'\n]\n':'[]\n'):!Object.keys(v).length?'{}\n':'{\n'+Object.entries(v).map(([k,x])=>J(k)+': '+inner(x,'')).join(',\n')+'\n}\n';
export const writeJson=(p,v)=>writeFileSync(p,fmt(v));
