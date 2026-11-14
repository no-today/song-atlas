// 把 data/*.json 统一成 tools/json.mjs 的写法。手改数据后可跑：npm run fmt
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {writeJson} from './json.mjs';
const dir=join(dirname(fileURLToPath(import.meta.url)),'..','data');
for(const f of readdirSync(dir,{recursive:true}).filter(f=>f.endsWith('.json')))writeJson(join(dir,f),JSON.parse(readFileSync(join(dir,f),'utf8')));
