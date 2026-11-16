// 开发服务器：改 src/ data/ assets/ 即自动 check + build，浏览器自动刷新。
// 用法：npm run dev [-- --port 5173]
import {createServer} from 'node:http';
import {watch,readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const pi=process.argv.indexOf('--port'),port=pi>0?+process.argv[pi+1]:5173;
const clients=new Set();let ok=true,timer=0;
function build(){
  const r=spawnSync(process.execPath,['tools/check.mjs'],{cwd:root,encoding:'utf8'});
  if(r.status!==0){ok=false;process.stdout.write(r.stdout+r.stderr);return}
  const b=spawnSync(process.execPath,['tools/build.mjs'],{cwd:root,encoding:'utf8'});
  ok=b.status===0;process.stdout.write(`[${new Date().toLocaleTimeString()}] `+b.stdout+b.stderr);
  if(ok)for(const c of clients)c.write('data: reload\n\n');
}
build();
for(const d of ['src','data','assets'])watch(join(root,d),{recursive:true},()=>{clearTimeout(timer);timer=setTimeout(build,120)});

const reload=`<script>new EventSource('/__reload').onmessage=()=>location.reload()</script>`;
createServer((req,res)=>{
  if(req.url==='/__reload'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write('\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
  if(/^\/tiles\//.test(req.url)){
    const path=new URL(req.url,'http://localhost').pathname;
    if(!/^\/tiles\/\d+\/\d+_\d+\.jpg$/.test(path)){res.writeHead(404);return res.end()}
    try{const tile=readFileSync(join(root,path));res.writeHead(200,{'content-type':'image/jpeg','cache-control':'public, max-age=86400'});return res.end(tile)}
    catch{res.writeHead(404);return res.end()}
  }
  if(!ok){res.writeHead(500,{'content-type':'text/html; charset=utf-8'});return res.end(`<p style="font:16px sans-serif">构建失败，看终端输出；修好后自动刷新。</p>${reload}`)}
  const f=readdirSync(join(root,'dist')).find(f=>f.endsWith('.html'));
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
  res.end(readFileSync(join(root,'dist',f),'utf8').replace('</body>',reload+'</body>'));
}).listen(port,()=>console.log(`开发服务器：http://localhost:${port}  （改动自动重建并刷新，Ctrl+C 退出）`));
