# 五代两宋舆地沿革图

单页历史地图：936 年（后晋立国、割燕云）至 1279 年宋亡的疆域态势、大事、战役分步解说。产物是一个可离线打开的单文件 HTML。

## 命令

- `npm run dev`：开发服务器 http://localhost:5173，改 src/ data/ assets/ 自动 check + build 并刷新浏览器
- `npm run deploy`：build 后部署到 Cloudflare Workers（https://song-atlas.notoday.dev，配置见 `wrangler.jsonc`）
- `npm run build`：先跑 `check`，再拼出 `dist/五代两宋舆地沿革图.html`（dist 不入库）
- `npm run check`：数据互相引用的一致性检查（下标、形状、年份范围）
- `npm run derive`：按 `data/snap-edits.json` 派生新态势（写回 snaps/shapes）；`npm run fmt`：统一 data 格式
- `npm run voice -- --dry`：统计待配音；`--only 文字前缀`、`--from 段 --to 段`（段号同 `#f=`）限量合成并上传 R2，`--redo` 强制重合成选中段，`--fix` 只重做自检不过的段（尾部没读、多出无字幕语音、长停顿；合成时也自动补尾、裁剪），`--verify` 检查音频；凭据只读 `.env`，缓存 `.cache/voice/`
- `npm run read`：生成按播放顺序、一句一行的通读稿 `dist/全片讲稿-通读稿.md`；`node tools/readthrough.mjs --apply 文件` 按段号把改过的通读稿写回 data/film
- `npm run smoke`：用本机 Chrome 无头打开产物，逐年拖动、讲大势、走完每个战役的每一步，有脚本异常即失败。改了 `src/app.js` 必跑

产物无依赖；工具需 Node ≥ 22（smoke 用全局 `WebSocket`），derive/geo 需 `npm i`（polygon-clipping）。

## 结构

- `src/index.html`：页面骨架，`/*@css*/ /*@data*/ /*@js*/` 三个占位由 build 填入
- `src/style.css`、`src/app.js`：样式与逻辑。app.js 读全局 `BASE` `HIST` `C` `RELIEF`（由 `tools/data.mjs` 从 data/ 组装）
- `data/*.json`：每行一条记录，方便 diff
  - `base` 底图（海岸、湖、河，兰伯特投影后的 SVG 路径，W×H 坐标系）
  - `shapes` 疆域形状 `hash → path`；`snaps` 各幅态势 `{y, era, t, p:[[政权id, hash]], g:[新易手区域]}`
  - `polities` 政权 `pol{id:[名,色,字号级,简介]}`、标注位置 `lab{id:{年:[x,y]}}`、别名 `names{id:{年:名}}`、宋/蒙/交趾分期简介
  - `narrative` 每幅态势的格局提要 `shi`、疆土变化 `chg`、兵力 `force`（按年取最近一条）
  - `labels` 山川部族名 `[名,x,y,起,止,类]`；`cities` `[名,x,y,起,止,级,注记方位]`；`rivers` 分期河道；`garrisons` 驻军
  - `routes` 进军路线 `[将帅,起,止,方,path,标注点,所属战役名,[部队名,人数(0=不详),口径 约/号/空,兵种 骑/步/舟/混]]`，第 8 项显示为行军箭头处的部队标记
  - `events` 大事 `[年,名,类,x,y,简述,战役?,范围,相关城邑下标]`；战役 `steps` 里 `["m",路线下标,起,止]` 按**下标**引用 routes，`["z",hash,…]` 引用 shapes
  - `film/*.json` 全片讲稿（文件名顺序即播放顺序，格式见 tools/data.mjs 文件头），链接 `#f=段序号`
  - `voice` 配音清单 `{base,au:{文字哈希:音频文件名},tm:{文字哈希:[厘秒差,字下标差,…]}}`（首词为绝对值，后续为差值），`tools/voice.mjs` 生成，`--tm` 只补时间戳；build 填入音频地址与时间戳（站点/结语 `tm`、战役步骤 `[4]`）；`lexicon` 为复刻音色读音表
  - `snap-edits` 派生态势的 ops（见 tools/derive.mjs 文件头）；派生出的态势不要手改 snaps/shapes
- `assets/relief.jpg`：晕渲地形底图
- `tools/`：build / check / smoke / dev / fmt / derive；`geo.mjs` 有投影常数与 `city`/`border`/`ll` 查询命令
- 地址：`#y=年`、`#b=战役名&s=步`、`#f=段`，状态变化即写回地址，可直接分享
- `docs/`：史实核查与讲稿出处记录（`勘误*.md`、`战役出处-*.md`、`大事出处-*.md`）

## 约定

- routes、cities 被 events 按数组下标引用：新增只追加到末尾；删除或插入必须同步重排下标，跑 `check` 确认。
- 时间起点 `Y0` 在 app.js；早于首幅态势（938）的年份沿用首幅。改起点要同时改 `index.html` 里滑块的 `min` 和「资料与说明」。
- 年份键的字典（lab、names、force、各 `*txt`）不得有早于首幅态势的键，check 会拦。

## 播放与配音

- 镜头一律走 `flyTo(view)`（先拉远再推近）；`boxView(框, 最小跨度)` 算取景。开章先回全景（`homeV`）再飞到站点；战役先飞全貌再逐步推近，动画在镜头到位后开始。
- 讲解统一经 `narrate(文字, 音频, 最短毫秒, 时间戳)`：音频与时间戳由 build 按 `data/voice.json` 填进讲稿每段（`au` `tm`）。音频失败或离线时用浏览器朗读，关配音时按字数计时。全片播放在点击时解锁音频（Safari）。
