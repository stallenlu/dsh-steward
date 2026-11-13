# dsh-steward — 智能管家（体检 + 授权执行）插件

**状态：v0.9.16 已安装并热挂载（体检 + 授权执行 + 对话入口 + 设置项 + L0 当班）**

## v0.9.16（L0 当班环：管家会自己醒来，但只观察、只把建议备好）

「核心定位再思考」之后落地的第一档，也是**只做 L0** 的一版。此前管家只在开机 45 秒后
体检一次、或你打开面板时才动——它不像「管家」，更像一件等你用的工具。v0.9.16 补的是
「当班」这件事本身：不开面板，它也按设置周期自己醒来体检一遍。

- **周期当班**：`ui.autoScanMinutes`（原来只管面板缓存刷新，现在「一个数字管两处」）
  同时驱动后台 `setInterval`。改设置后下一班自动按新周期重排，不用重启。带重入保护
  （上一班没结束不开新班）与 1 秒去抖，不会因事件抖动连开好几班。
- **当班台账 `duty.jsonl`**：每班一条，写清「看了什么 / 判断 / 做了没做 / 为什么没做」。
  人话由服务端 `dutyBriefing()` 算好，客户端只渲染（沿用 USER.md 的口径）。
- **预备建议**：把仍在报、且没被静音/判错的发现的建议预先整理成清单，等你来动作中心
  确认；**预备 ≠ 执行**。
- **硬边界（L0 观察档）**：`runDuty()` 全程只读，一次都不调用 `plan`/`execute`；
  报告 / ping / audit 返回体带 `duty`，面板「体检总览」显示最近一班状态，「审计趋势」
  显示当班台账。加密备份口令、启动/boot/`cordis.patch.yml`、停用启用插件、改默认模型
  等一律不进任何自动层（见「明确不做」）。
- **档位路线**：L0 观察（本版，默认开）→ L1 预备（主动把计划推到面前，一次确认，默认关）
  → L2 受托（白名单内可逆动作按策略自动执行并回报，默认关、须逐项开）。L1/L2 **未实现**，
  设计见 Mnemon 文档 `42042339-cc9d-4ecb-8d71-dc3ade7dffdd`。扩大自主权要等 11-23 两周
  无误报回看之后，本版不碰授权面。

静态判据（smoke）钉住：周期定时器存在且带重入/去抖、当班全程不触碰 plan/execute、
`dutyBriefing` 是纯函数且排除静音/判错项、三处返回体都带 duty、面板显示当班状态与台账。

## v0.9.15（把「该有的职能」补齐：时间、设置、反馈、趋势、直达）

这一轮按职能设定逐条对照代码，补上八处「功能上没考虑到、但角色上应该有」的缺口。
顺序按影响排：先修真 bug 与死设置，再补反馈闭环，最后是趋势与直达。

### P0：两个「说了但没做」

- **设置页的「上次保存」差 8 小时**：`savedAt` 是 UTC ISO，旧代码用 `.replace("T"," ")` 切片
  当成当地时间贴出来。静态判据只认单引号写法，双引号那次悄悄绕过去了——现在两种引号都查，
  并且这一行改走 `localStamp()`。
- **`ui.autoScanMinutes` 是个死设置**：设置里能存 1–240 分钟、界面也回「已保存」，但客户端
  把刷新阈值写死成 10 分钟。现在服务端把夹取后的值随报告下发，客户端按它算阈值；
  「设置改了却没反应」正是验收表 A9 要抓的静默失效，不该长在自己家。

### P1：误报要能被纠正，管家才学得会

只有「已知晓（静音）」时，用户看到一条判错的结论，除了不理它没有别的办法。
新增 `feedback.json` 与面板按钮「这条判错了 / 撤销判错」，走与静音完全相同的
plan → 一次性指纹 → confirm → audit 链。标记后：证据仍然保留、不再计「有直达处置」、
重要性分数降 40 并写进 `scoreReasons`，所以它会排到后面而不是消失。
**这是可逆的判定，不是删除**。刻意不进语言层（brain.js / intent.js 不加这个 kind）：
「把某条具体发现判错」用自然语言说不清是哪一条，按钮更不易误触。

### P2：趋势要会说话，直达不许造假

- 服务端新增 `summarizeTrend()`，用上一次报告算出 `trendVerdict`（好转 / 连续变差 / 平稳）
  **和一句人话**，客户端只渲染——符合「服务端算好人话、客户端只渲染」。
  审计趋势顶部显示结论，恢复或连续两次变差时右下角主动弹一条（不再只报坏不报好）。
- `ACTION_FOR` 里 `model-health → model-default` 指向一张并不存在的动作卡，是假直达：
  删掉，并把 `backup-freshness → backup` 补上（备份新鲜度该能一步跳到备份卡）。
  其余只有文字建议的 finding 不给按钮——宁可少给，也不给一个点了没反应的按钮。
- `wiring`（路由 / 工具到底注册上没有，v0.9.14 起只在 ping 里）随报告下发，
  面板在生成时间旁显示「接口已挂上」；没挂上时给出可操作的提示。

### 边界

`feedback` 与 `ack` 都只写管家自己的数据目录，不动任何系统状态；口令仍绝不由 Agent 生成或代输。

## v0.9.14（冷启动竞态：路由与工具都注册了，只是没在最合适的那一刻）

### 症状和真正的原因不是同一件事

重启之后面板照旧报 `读取失败: 接口没有挂上（HTTP 404）`。v0.9.13 已经能把这句
话翻译成人话，但它把原因归给了「热重载」——而这一次是冷启动，热重载的解释
根本对不上。真正的原因更安静：

`apply()` 里原本是这样拿服务的：

```js
const webServer = getService(ctx, 'webServer');
if (webServer && typeof webServer.register === 'function') { ... }
```

`getService` 只做 `ctx.get(key)` 或 `ctx[key]`，而 **`ctx.get` 在 Cordis 里只能拿到
那一刻已经 apply 完的服务**。冷启动时 `webServer` 与 `tools` 的 apply 都排在本插件
之后，于是那一次探测拿到 `null`，整个 `if` 被跳过：前缀路由没注册、两个
`dsh_steward_*` 工具也没注册。外面的 `try { ... } catch { /* ignore */ }` 是刻意的
fail-soft（注册失败不该拖垮 boot），代价是**失败完全无声**——面板照常从 manifest
画出来，然后每个请求都撞在「没有命名路由匹配 → 404」上。

所以这不是「路由写错了」，是「注册发生在错误的时刻」。热重载会是同一个症状，
但它们是两个不同的病因，v0.9.13 的诊断文案只认识其中一种。

### 改法：等它就绪，再注册

新增 `whenService(ctx, keys, fn)`：优先走 `ctx.inject(keys, cb)`，回调在服务真正
存在之后才执行；`:root` 上没有 `inject` 时退回旧的一次性探测（行为与从前一致，不会
更差）。三处注册（`systemPrompt` 段、前缀路由、tools）全部改走它。

- 用 `ctx.inject` 而不是 `export const inject = [...]`，是因为硬 inject 会让本插件
  成为 **boot 依赖**——它的 apply 一旦抛错，整个 Web UI 起不来。这个插件的第一原则
  是「不许让面板成为新的崩溃源」，所以宁可延迟注册，也不升级成硬依赖。
- `ctx.effect` 仍然包在回调里，所以热重载时 dispose 依旧会被正确回收。

### 失败必须能看见

注册结果记在 `wiring.route` 里，`ping` 的返回体多一个字段：

```
{"ok":true,...,"wiring":{"route":"registered"}}
```

下次再出现「面板画出来了但每个请求都 404」，只需要看一眼 ping：`registered` 说明
路由在，问题在别处；`pending` 或 `failed: ...` 直接指到病因。**静默的 fail-soft 是
这次真正的坑**——比注册失败本身更难查，因为它连一条可搜的日志都不留。

### 这一版钉住的判据

`smoke.mjs` 新增五条静态判据（291 条断言）：必须用 `ctx.inject` 延迟注册；三处注册
全都走 `whenService`；**旧的裸 `try { const webServer = getService(...)` 写法必须彻底
消失**；`wiring.route` 要记录成功与失败两种结果；`ping` 要把它带出来。反向验证过：
把路由那段改回一次性探测，立刻 `289 passed, 2 failed`。

## v0.9.13（路由没挂上时，别只说 HTTP 404）

改插件源码会让宿主热重载：旧 fiber 被销毁，新 fiber 重新跑一遍 `apply()`。
真机踩到的形态是——重载过后 `apply()` 里那段 `webServer.register({ kind: 'prefix', path: ROUTE_PREFIX })`
没有接上，面板打开就只剩一行红字 `读取失败: HTTP 404`：bundle 是 enabled + installed，
源码 `node --check` 全过，`import()` 也正常，只有路由不见了。

`HTTP 404` 这句话的问题不是不准，是**没法行动**：它和「服务端主动回了个 404」长得一模一样，
而这两种情况的处置完全不同。所以这一版：

1. **认得出来** —— 自己这条路由上的 404 单独成句：说清「面板加载了，但 /api/dsh-steward/ 没注册」，
   并点名最常见的原因（热重载后旧路由被销毁、新的没接上）。
2. **说得出怎么办** —— 提示「设置里停用再启用一次」或「直接重启 DSH Web」，两者都真的能修。
3. **重试一次就够** —— 热重载有一个几百毫秒的窗口，这时路由确实不在；重试一次不会把
   真正的故障藏起来，也不会让用户对着一个会自动好的状态点按钮。
4. **别的错误不许挪用这套话** —— 非 404 的失败仍然原样报服务端给的原因，
   否则「热重载」就成了一个什么都往里装的筐。

五条断言全部是**静态判据**（读 `lib/client.js` 自己的源码），并且反向验证过：把
`response.status === 404 && tries === 0` 改成 `if (false)`，`285 passed / 1 failed`。

> 顺带记一条运维经验：这个状态下**只有重启/重挂**能修，改代码不会修好它。
> 而 `plugin_manager set_bundle enabled:false` → `enabled:true` 就是重挂。
## v0.9.12（配色：从「自造一套蓝」改成 baseline 的六个 accent）

面板里原本散着 12 处私有颜色：`rgba(90,159,212,.14)` 这种自造的蓝、`#e05555` 这种自造的红、
`rgba(79,180,119,.14)` 这种自造的绿。`dsh-design-baseline` 的 `check.mjs` 抓不到它们，因为那不是
「硬编码的灰」——它只是另一套饱和度、另一种色相，checker 无从判断谁对。

按 baseline 的铁律改了三件事：

1. **颜色只来自六个 accent**。自造蓝 → `C.info`（`#06b6d4`），自造红 → `C.critical`（`#f43f5e`），
   自造绿 → `C.ok`（`#22c55e`）。剩下的几档透明度不再手写，统一用 `mix(accent, pct)` 派生，
   与 baseline 的 15% `wash()` 同源。
2. **选中态反相，不染色**。胶囊按钮、单选行、排序药丸、发送键原来是「被选中就变蓝」，这直接违反
   baseline 那条「选中若是颜色，颜色就不再表示数据」。改成 `C.solid` / `C.on`（宿主反相背景/前景）——
   和 FreeLLMAPI 的 segmented 控件是同一个做法。
3. **红点不是另一种红**。侧栏图标那个 7px 红点原本是 `#e05555` + 一圈黑边；现在点用 `C.critical`、
   边用 `THEME.surface`（那是背景的镂空，不是描边）。

刻意没做的：`sync.mjs` 在 tokens 模式下只给 `THEME`，不给 `BASELINE_CSS`，因为本插件的红线是
「不注入 `<style>`、不碰 `document.head`」。所以这里拿到的是同一组 token 与 accent，
而不是 FreeLLMAPI 那种整块样式表注入——**两者的相同点在取值，不在注入方式**。

`smoke.mjs` 加了 7 条静态判据（总数 274 → 281），其中最关键的两条都反向验证过会红：
块外出现 `rgba(90,159,212,.2)` → `FAIL no private accent survives outside the baseline block`；
块外出现 `#7a4dff` → `FAIL no stray hex colour outside the baseline block`。

## v0.9.11（时间戳：UTC 存、本地显示）

面板上「生成时间 · 2026-11-10T06:32:40.118Z」这类样子，是把 UTC 原样贴给了东八区的用户——
差了 8 小时，而读者无从判断该减还是该加。审计行、趋势行、静音项的「上次也出现过」三处都这样。

修法：加一个 `localStamp(iso)`，把 `Date.parse` 后的时间按 `getFullYear/getMonth/...` 本地化，
五个显示点全部改走它（审计行、趋势行、recall 时间、重启前存档时间、生成时间）。
生成时间那一行还顺手补了相对时间：「生成时间 · 2026-11-10 14:32（刚刚）」。

服务端 `renderReportText` 是给工具调用返回的纯文本报告，**显式标注 `（UTC）`** 而不是悄悄换成本地——
那份文本可能被下游程序或其他时区的人读，写清楚比猜对更有用。

smoke 从 271 项加到 274 项，其中一条是静态判据：**源码里不许出现「把 T 换成空格」这种假装本地化的写法**；
我当场把一处改回旧写法验证过它会红（`FAIL no render path formats a timestamp by swapping the ISO T`）。

## v0.9.10（把「说得对」修成「说得准」）

这一版没有加新体检项，只修三处「数字对、话不对」的地方。

**1. 崩溃的「多久以前」和「比启动早多少」是两个问题，不能共用一个数。**
旧代码用 `bootedAt - crashTime` 算小时数并四舍五入，真机上两者只差 49 秒，
于是正文写「约 0 小时前」——而那件事其实发生在 7 小时前。现在分开算：
`ageText` 用 `now - crashTime` 说人话（「7 小时前」），`bootLagText` 用
`bootedAt - crashTime` 说「比当前实例的启动还早 49 秒」。两个数都进 `data`
（`ageHours` / `ageText` / `bootLagHours` / `bootLagText`）。

**2. 列表截断必须自己说出来。**
标题写「7 个工作区」、正文只列 6 条，读者分不清少的那一个是不重要的还是最重要的。
现在工作区、备份 evidence、采集告警三处都在截断处补上「另有 N 个……（完整见 data.xxx）」，
并在 `data` 里给出真正的总数（`workspacesTotal` / `countNote` / `data.errors`）。

**3. 依赖声明不许虚挂。**
`dsh.client.inject` 里一直写着 `@deepseek-ai/dsh-client-locale`，但 client.js 全文
零调用 locale（红线本来就是「不用 locale」）。已删掉这条声明；`locale/*.json` 保留
（它由宿主读来显示插件名与简介），meta 文案同步到当前的「体检 + 授权执行」口径。

smoke 从 255 项加到 271 项：新增的四组断言专门钉这次的三个毛病——
「正文里不许出现『约 0 小时前』」「截断处必须带 N」「inject 只许写真用到的包」。

## v0.9.9（打包自检：测试全绿不等于包能装）

0.9.8 发布前跑 `npm pack --dry-run`，发现包里**没有 `lib/models.js`**——`package.json` 的 `files` 白名单漏了它。

这条缺陷的形状值得记住：**所有单元测试都是绿的**，因为测试从源码树 import，那里文件当然在；
而装包的人拿到的是 tarball，`import './models.js'` 会抛 `ERR_MODULE_NOT_FOUND`，
宿主在 boot 期审计 manifest，一条没进 active 就整个 Web UI 起不来——和 11-09 那次崩溃是同一类后果，只是从另一条路走到。

修法两层：把 `lib/models.js` 补进 `files`；再给 smoke 加一条**打包自检**——遍历 `lib/` 与 `files` 白名单取差集，
并解析所有 `from './x.js'` 确认目标文件会被发布。这条断言当场验证过会红
（拿掉 `lib/models.js` → `FAIL every file in lib/ is in the files whitelist — models.js`），不是写完就算数。

顺带修了 README 的安装一节：它还写着「`- insert:` 的 name 要等于 `dsh-steward`」，那是改名前的旧口径，
照它做会让从 npm 装的人整个界面起不来。

## v0.9.8（健壮性：一条会卡住，两条语义不对）

三条都是一次真实的压力测试打出来的，不是读代码猜的：

1. **请求可以永远等下去。** 前端 `call()` 没有 `AbortController`，服务端 `runModelScan`
   是严格串行的 for 循环。默认 12 个探针 × 45 秒超时 = 最坏 9 分钟。实测 `model-scan`
   用 115.6 秒、`probeOnReport=always` 时一次体检 151.2 秒——面板只是在转圈，
   用户分不清「还在跑」和「已经死了」。
   修法：服务端改 3 路并发（最坏 180 秒）；前端给每个请求一个预算——普通动作 30 秒，
   `report` / `model-scan` 240 秒（180 秒最坏 + 60 秒给报告自身的采集器），`ask` 120 秒。
   超时后说的是「服务端可能还在跑」，不是「失败了」。

2. **坏输入会静默触发最贵的动作。** `readBody` 解析失败一律返回 `{}`，而 `run()` 把
   `action === ''` 当成「做一次完整体检」。于是畸形 JSON、超长 body（>16 KB）、
   甚至空对象，都返回 200 加一份 29 KB 的完整报告。
   修法：`readBody` 改返回 `{parsed, value, reason}`，坏 body → 400 并说明原因；
   缺 action → 400 并告诉对方该发什么。**不再有默认动作。**

3. **两个 jsonl 没有上限。** `audit.jsonl` 和 `knowledge.jsonl` 只追加，而 `trend.json`
   早就有 400 行上限。同一种文件两套规则。
   修法：`LOG_LINE_CAP = 2000`，超了保留最新 2000 行；`io` 缺 `readText`/`writeText`
   时跳过裁剪而不是让写入失败。

一条断言写错过，而且错得有用：我原本给 `report` 写 200 秒预算，断言却是
`12 * 45000 / 3 + 60000`（= 240 秒）——两个数字对不上，说明我心里算的最坏情况
和写下的不一样。现在断言直接把 `Math.ceil(MAX_TOTAL / CONCURRENCY) * PROBE_TIMEOUT_MS`
算出来再比，不写死数字。

## v0.9.7（patch 备份：按结构判，不按字节判）

v0.9.6 把「当前 patch 比启动期备份小 20% 以上」判成 warning，真机立刻打脸：
本机 patch 52 KB vs 备份 82 KB（小 42%），报「明显小于」——
可逐块拆开对比，**14 个 `- id:` 块一个都没少**。少的是块内字段：
`dsh-connect-workbuddy` 少了 `global:` 段、`dsh-connect-qoder` 的 `enabledModelKeys` 被清空。
那可能是插件自己把默认值重写成空的，也可能是选择被重置——但这**不等于配置丢了**。
拿总字节数当判据，就是把「小」当成「丢」，正是这份报告一直在批评的毛病。

现在按结构判：

- 备份里的 `- id:` 块在当前 patch 里**缺了** → warning，标题点名缺哪几个 id；
- 块都在、只是块内字段变少 → info，标题直说「配置块一个没少」，正文给出缩小百分比并说明
  「不等于配置丢了，但值得你自己对着 .bak 看一眼具体是哪几个字段」。

smoke 由 235 增至 **238** 条，正反两个方向都锁住（变小不报警 / 真缺块必报警并点名）。
## v0.9.6（patch 备份与磁盘建议：别再拿旧快照当现状）

同一条毛病的另外两处，都是「把曾经发生过的事当成此刻的状态」。

**patch 备份**：以前只要目录里有 `cordis.patch.yml.bak-<epoch>` 就报 warning。
但那只是启动期 sanitizeProfile 改名留下的残留——真正要紧的是**现在的 patch 有没有被换成默认 stub**。
现在会比较两者体积：当前 patch 比备份小 20% 以上 → warning，并算出少了百分之多少；
否则 → info，标题直说「当前配置未被换掉」。本机实测就是后者（备份 82 KB / 当前 81 KB）。

**磁盘建议**：`disk-advice` 的 evidence 里写死了某一次 audit 的数字（131.9 GB / WSL 81.4 GB / WinSxS 12.9 GB），
报告却把它当现状读。现在改成只留判据与分类口径，具体体积以 `disk_cleaner action=audit` 的实时结果为准。

smoke 由 231 增至 **235** 条（新增「残留 → info」「被换成 stub → warning 且算出百分比」两条正反断言）。
## v0.9.5（client 标识体检：把「读不到」和「没问题」分开）

v0.9.3 的 client 标识体检有一个不诚实的角落：它说「38 个已装客户端包的 id 互不冲突」，
同时在括号里承认「10 个包的 client.js 读不到」——覆盖其实只有 28/38，结论却按 38 报通过。

两处漏检，都是同一个毛病：默认了一个并不成立的约定。

- **入口不一定是 `lib/client.js`**。10 个真机包把 client 入口写在 `exports["./client"]` 里
  （`dshmarket` → `client/client.js`、`ds-bot` → `client.js`、`deep-view` → `client.js`、
  `@liustack/modsearch` → `dsh/client.js`、`billion-context` → `dist/agent/dsh-native-client.js` …）。
  现在按 `exports["./client"]` → `dsh.client` → `lib/client.js` → `client.js` → `dist/client.js` 依次解析，
  并把解析到的路径记进 `entry` 字段。真机 `unreadable` 由 10 降到 **0**。
- **id 不一定用引号包**。压缩产物会用反引号：`@changfenhuang/dsh-genui`、`dsh-context` 都是
  ``id:`…` ``，只认 `'` 和 `"` 会把它们算成「没声明 id」。现在三种引号都接受；
  `dsh-cost-meter` 把调用包在 load-wrap 代理后面（模块体里根本没有 `__ModuleLoader__` 字面量），
  再加一条宽松回退取第一个带 `id` 的对象字面量。真机 `withoutId` 由 3 降到 **0**。

现在「读不到」和「没问题」在报告里长得不一样了：真的读不到会单独计数并写进 detail，
而不是混在「通过」里。smoke 由 227 增至 **231** 条。
## v0.9.4（插件更新体检：按方向比，不再「不同即升级」）

上一版把「缓存里的 latest 和已装版本不一样」当成「有新版本」。真机立刻暴露了它的错：
报告里出现 `dsh-disk-cleaner 1.6.3 → 1.6.2`、`dsh-game-center 1.2.1 → 1.0.1` —— 那是**降级**。
原因是市场缓存比磁盘旧，而代码只做了不等比较，没有判方向。

现在 `collectUpdates` 用 semver 比方向，分成三种结果：

- `latest > installed` → 进 `outdated`，才是「有新版本可用」；
- `latest < installed` → 进 `aheadOfCache`，那不是该升级，是**缓存比磁盘旧**；
- 版本号写法无法比较（如 `beta`）→ 计入 `undetermined`，不猜方向。

面板文案跟着分叉：有真更新时，也把「缓存偏旧」和「无法比较」的数量说出来，不再静默丢掉；
全部最新时同样说明有几项是缓存偏旧。**一个不报的项和一项没查的项，在报告里必须长得不一样。**


## v0.9.3（client 标识体检 + 崩溃病因解析）

上次那次「整个 Web UI 起不来」暴露了两道盲区，这一版各补一条：

1. **client 标识体检**（info 级，新增第 7 个数据源）。DSH 渲染端按 `__ModuleLoader__.load({ id })` 的 id 建工厂表，同一个 id 注册第二次直接抛 `duplicate factory registration` 并让 boot 失败。体检核对三件事：同一份代码是否被装成多个 node_modules 名字（用 `realpath` 比目录真身）、client.js 的 id 是否与包名一致、两个包是否抢同一个 id。**这是市场现有体检的盲区**：`dshmarket` 的静态分析按 loader entry id / bundle 名统计，`trialValidate` 回放的也是 loader 组合树，两者都看不见渲染端的工厂表（实测 `grep ModuleLoader|dsh.client|clientId|client.js check.js trial.js` 零匹配；三个合成夹具上市场体检全绿，本项全命中）。
2. **崩溃病因解析**。真实崩溃日志的 renderer console 段写着 `client-modules: duplicate factory registration for "X"`，而 `X: import failed` 只是输掉竞争的那个。旧解析只抓后者，于是「装了两遍」被诊断成「某个插件坏了」。现在 `parseBootFailure` 同时抓病因，`boot-crash-latest` 的标题以病因开头，并明说被点名的插件是受害者。

这条检测**有意不给一键处置**：修法是删一个 symlink 或改别的包的 id，属于动别人安装状态，超出授权执行面——只点名路径，不代改。

## 为什么 client id 必须等于包名（v0.9.2 事故复盘）

包名从 `dsh-steward` 改成 `@sidady/dsh-steward` 时只改了 package.json 与 cordis.patch.yml 的 name，漏了两处：`lib/client.js` 的 `__ModuleLoader__.load({ id })` 仍写裸名，profile 的 `node_modules/dsh-steward` 旧 symlink 没删。两者叠加，同一个 bundle 的 client factory 被注册两次，渲染端抛 `duplicate factory registration for "dsh-steward"`，宿主按 boot all-or-nothing 直接退出（应用起不来）。修法：client id 改成完整 scoped 名（同机 @nagi-ovo/dsh-visualize、@michengai/dsh-archive-manager 都是这个约定），并删掉旧裸名链接。

## 是什么
一个 DSH Cordis bundle，host + client 两侧。默认态是只读体检；授权后可执行七类动作（clean 纯缓存清理 / backup 易失数据加密备份 / disable 停用崩溃插件 / enable 恢复启用 / knowledge 结论沉淀+trend / ack 静音某项发现 / unack 恢复显示）。体检做三件**只读**的事：

1. **启动后诊断**：读 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`，解析 `N entries did not activate` 与 `X: import failed`，点名疑似触发 web-boot 崩溃的插件；带新鲜度门（崩溃早于当前实例启动 = 已自愈，降为历史提示）与归因门（连坐 skip 只点名第一个）。
2. **配置备份告警**：查 profile 下 `cordis.patch.yml.bak-<epoch>` 兄弟文件，提示启动期 `sanitizeProfile` 可能静默吞掉 providers/模型/权限预设，恢复前先备份、旧配置不整体回灌。
3. **插件变更风险**：订阅 `plugin-manager/changed`，在报告里标注本会话的插件变更（对应「插件变更 → boot 风险」链）。

另有升级兼容体检（读各包 `engines.dsh` 门槛对照宿主版本，hostVersion 源链：显式传参 → crash 日志 meta.app → dsh-base package.json）与知识召回（同类问题第二次出现时附「上次也出现过」记录）。

报告通过 host 前缀路由 `/api/dsh-steward/`（同源校验 + POST）、Agent 工具 `dsh_steward_report`、侧栏面板与右侧栏 Tab 四个出口暴露；执行走 `dsh_steward_act` 工具或面板动作卡，同一套 plan→指纹→confirm→审计门。v0.4 起有主动出口：boot 后 45 秒自动体检一次 + 向 systemPrompt 注入「用户报崩溃先调体检」护栏段（探针先行，注入不可用则降级为侧栏红点）。

v0.5 加拟人化外壳（侧栏头像 + 按时段问候 + 一句话结论 + 三件要紧事，纯前端零 token）；v0.6 加 L2 对话入口：面板总览页一个输入框，说一句话（「清理一下缓存」「停用 dsh-guizang-design」「有什么问题吗」）即定位到对应动作卡。**默认解析是规则式的，不花 token、不联网、不执行**，命中后仍然要你在卡里预览并确认。

v0.7.8 把「工作区体检」从固定阈值改成增长判定：旧的「有 1 个工作区超过 50 MB」是静态阈值——你没长胖它也会天天亮，那不是发现问题、是把阈值当成了问题。现在拿上一次报告做对照，只有 **净增 ≥ 20 MB** 或**工作区目录消失了**才算 warning，否则降为 info 并写明「与上次相比无显著增长」。没有上一份报告可对照时（首次或报告被清）只记体积、不判定涨跌，绝不凭空报警。同时把 `ACCEPTANCE.md` 基线重采到 v0.7.7/v0.7.8 并新增 A5–A8 四行检查（工作区阈值、更新检出、可信度噪音、静音到期反复），11-23 两周回看直接用新尺子。
v0.7.7 补上剩下四项日常体检：② **工作区体检**（读 storages/workspace.json，按目录编码算出每个工作区的会话数据体积，看板「有 N 个工作区超过 50 MB」并把消失的工作区标出来）；③ **插件更新检出**（读 plugin-update-cache.json 的市场缓存，对照已装版本列出「有新版本可用」的包，并注明升级正是「插件变更→boot 风险」的上游）；⑤ **体检可信度自检**（report.coverage 逐源记 data/empty/unavailable，读不到的源会让报告明说「这可能是没看见，不是没问题」）；⑥ **静音会过期**（ack 现在带 expiresAt，按发现项给 7–42 天不等的有效期，过期自动重新提醒——静音只代表「此刻我知道」）。
v0.7.6 新增两项日常体检（①备份新鲜度 / ④配置漂移）：① 读 dsh-config-manager/exports 下最新 .zip 的时间，算出「距上次加密备份 N 天」，超过 7 天或一份都没有就升 warning；④ 对 cordis.patch.yml 与 package.json 做 sha256 指纹，与上次体检的基线比，文件变短（超过 20 行）直接升 warning——这是 sanitizeProfile 静默丢配置留下的痕迹。源零 import、基线存在插件自己的数据目录，从不改 DSH 配置。

v0.7.5 修了体检结果的折叠语义：以前「折叠」实际是「只露前两张完整卡、其余消失」，同类项一多就只剩一条能看，而露出的两张又是占满屏的全尺寸卡片。现在折叠态把该组**所有**并列项各压成一条两行摘要（严重级别的色条 + ★分 + 标题 + 两行详情戳断），点「展开详情」才切回完整卡（证据/建议/动作按钮）；「严重」组默认就是展开的。

v0.7.4 把输入卡片的形状重做了一遍：一条圆角输入条（左模式/模型芯片、中无边框输入、右圆形发送键，聚焦时描边高亮），设置面板从条子上方那排胶囊挪到条子下方展开、不再挤压输入框，说明文字从三行收成一行小字。只改呈现，解析与授权链路一行未动。

v0.7 给这个输入框加了「模型理解」：可选的第二通话方式，把同一句话交给宿主 `llm` 服务里你选的模型翻译成**同形状的动作意图**。它仍然只翻译不执行——模型拿到的是一次性提示，不持有工具、不写文件、不碰授权，输出还要过一层白名单归一（kind 必须在那八类里、包名必须在真实 bundle 列表里、findingId 必须在现行报告里），不合法就退回「没听懂」。默认仍是规则式，零 token；切到模型式才花一次调用。v0.7.1 补 `goto` 意图（「去到审计趋势」这类导航）；v0.7.2 补「只看免费」筛选；v0.7.3 把该判据收窄为「名字带 free/免费，或过半模型带 :free」（否则 WorkBuddy 的 hy4free 单例也会被当成免费 provider）。

## 依赖与降级
本插件**零 npm 依赖**（只用 node:fs/crypto/path/url），也**不 import 任何其它插件的内部模块**。它依赖的是两个插件的 HTTP 路由和几个宿主服务，每个依赖缺失只降级不崩溃：

| 依赖 | 谁在用 | 缺了会怎样（fail-soft） |
| --- | --- | --- |
| dsh-disk-cleaner（路由 `/api/disk-cleaner/`） | clean 动作的 scan/clean | clean 卡 plan 报错拒绝，其余卡不受影响；disk-advice 建议仍在 |
| dsh-config-manager（路由 `/export-preview`、`/export`） | backup 动作的预览与真 DCA1 加密导出 | backup 卡 plan 报错拒绝；DCA1 回读校验由本插件用 node:crypto 自实现，不依赖对方模块 |
| 宿主 pluginManager 服务（`ctx.get` 免 inject） | disable/enable 动作 | 报「pluginManager 不可用」拒绝；#575 enable 守卫在宿主层保证失败不落 durable 状态 |
| 宿主 webApp / webServer 服务 | routeFetch 拼回环 base URL（①②动作的命脉） | 两者都缺 → clean/backup 执行层全拒；体检报告不受影响（report.js 直接读磁盘） |
| 宿主 systemPrompt 服务 | v0.4 主动出口注入 | 服务缺失或形态不符 → 跳过注入，降级为侧栏红点兜底 |
| 宿主 llm 服务（`ctx.get` 免 inject） | v0.7「模型理解」那一通话（`listProviders` / `listModels` / `stream`） | 模型区报「宿主没有可用的模型服务」，切回规则式照常用；规则式路径完全不碰 llm |
| 宿主 agentDefaultModel 服务 | 模型式默认选中项 | 取不到就回退到目录里第一个 provider 的第一个模型；再取不到则要求先选 |
| 宿主客户端包 locale / slots / sidebarRightTabs | 面板、侧栏入口、右侧栏 Tab | apply() 整体 try/catch：面板消失但 host 侧路由/工具照常——绝不让 UI 故障拖垮宿主（v0.1.0 整页卡死事故的直接教训） |

数据面依赖（宿主文件约定，非插件）：crash 日志目录与格式、profile `node_modules/*/package.json` 的 `engines.dsh`、`cordis.patch.yml.bak-<epoch>` 命名。宿主升级若变这些格式，后果是某项 finding 误报/漏报，不会崩。

## 明确不做（守底线）
不删文件（清理永远经 disk-cleaner 的 confirm 语义，只碰 safe 级，caution 需显式勾选）、不代跑提权命令（DISM/diskpart 永远只报告）、不自动拉起/重启、不改启动流程、不整体回灌配置、不碰 `cordis.patch.yml`、凭据不进任何产物（备份口令只在单请求内存过一遍，绝不由 Agent 生成或代输）。所有采集限流（日志 ≤50 份、单份 ≤2MB），任何单步失败都不向宿主抛错（fail-soft）。

## 关键设计取舍（为什么 host 不写 `export const inject`）
本项目第 ①④ 个痛点的根因就是「boot 期一个插件没激活，整个 Web UI 崩」。若本插件声明 `inject: ['tools','webServer']` 而某个可选服务异常，它自己就会变成那个坏插件。因此这里**零强依赖声明**：三处能力全部经 `ctx.get(name)` 容错获取，`apply(ctx)` 每一步包 try/catch，事件监听只在内存里计数、绝不在回调里做磁盘 IO。契约参照本机正在运行的 `dsh-disk-cleaner@1.6.2` 一手范本，但把「强依赖」换成「尽力而为」。

`lib/report.js` 刻意**重新实现** `parseBootFailure` / `.bak-<epoch>` 检测 / DCA1 容器校验，不 import `dshmarket/lib/*` 或 `dsh-config-manager/lib/*` 内部模块——避免跨包版本耦合（正是痛点①）。client 侧红线（v0.1.0 整页卡死事故二分定案）：零 `<style>` 注入、零 locale 依赖、全部内联样式、不用原生 `<select>`（系统绘制弹层不适配深色主题）、根节点自声明滚动。

## 文件结构
- `package.json` / `cordis.patch.yml` / `icon.svg` / `locale/{zh,en}.json`：bundle 清单与展示元数据。
- `lib/report.js`：纯函数报告生成（crash 解析、兼容体检、评分分级、静音层、知识召回），零外部依赖，可独立跑 `smoke.mjs`。
- `lib/actions.js`：授权执行层（plan 人话摘要 / 一次性指纹 / confirm 门 / 归因门 / DCA1 回读校验 / audit 留痕），deps 全注入式。
- `lib/intent.js`：L2 对话入口的规则式纯函数解析器。一句话 → 一个意图（clean/backup/disable/enable/knowledge/ack/unack/report）。**零 token、零网络、不执行任何东西**：它只决定打开哪张动作卡；听不懂就回去问，不猜。
- `lib/brain.js`：v0.7 模型理解层。把一句话交给宿主 `llm` 服务，把模型输出归一成与 `intent.js` **完全同形状**的意图；JSON 抽取容错（容忍围栏与前后废话），各字段走白名单校验，任何不合规都降级为 clarify。**只翻译，不执行。**
- `lib/index.js`：host（路由 + `dsh_steward_report` / `dsh_steward_act` 两个工具 + 事件订阅 + boot 后自动体检 + systemPrompt 注入）。
- `lib/client.js`：client（`__ModuleLoader__.load` + 三 Tab 面板 + 动作卡 + 侧栏/右侧栏入口，全内联样式）。
- `smoke.mjs`：本地验证（不启动宿主），341 项断言（含打包自检、时间戳、配色、「延迟注册」、L0 当班环与白色按钮回归等静态规约判据）。

## 本地验证（不装、不重启）
```
for f in dsh-steward/lib/*.js dsh-steward/smoke.mjs; do node --check "$f"; done
node dsh-steward/smoke.mjs
```
`smoke.mjs` 用注入的 IO/路由夹具覆盖：crash 解析与新鲜度/归因门、fail-soft 与可选目录缺失降级、plan 零写入、指纹一次性、confirm 门、审计不含密码、ack 往返、enable 对偶、DCA1 真字节回读校验（含错口令）、hostVersion 源链、trend 的 cFreeBytes、规则式意图解析的 15 例、模型输出归一的 15 例（含「模型编出不存在的东西不能变成动作」），并做一次真机 best-effort 探测（只读）。

## 安装（需用户另行确认后再做）
**从 npm 装（推荐）**：`plugin_manager` 的 `install_bundle`，target 传 `@sidady/dsh-steward`。

**从本地目录装（开发用）**：target 传本目录绝对路径。安装由宿主负责写 profile 的 `package.json` / `cordis.patch.yml` 并热挂载；**不要**手工改这两个文件。

装完必查三件（缺一就会出现「已安装但徽章不转 live」或更糟的 boot 失败）：

1. `cordis.patch.yml` 里 `- insert:` 的 `name` 必须等于 node_modules 里**实际的目录名**——从 npm 装是 `@sidady/dsh-steward`，本地 link 是 `dsh-steward`。写成另一个会导致启动时解析不到包，**整个 Web UI 起不来**。
2. 同一个包不许同时存在两个目录名（例如改名后旧链接没删）。两份相同的 `cordis.patch.yml` 会把同一个 client id 注册两次，渲染端抛 `duplicate factory registration`，同样是 boot 失败。
3. link: 依赖改码后必须 remove→install；install 回执 `applied` 不可全信，复查 profile `package.json` 落库 + 路由 200 + ping 版本三者一致。

## 运行数据（$DSH_HOME/dsh-steward/）
`audit.jsonl`（每次执行与被拒尝试）、`knowledge.jsonl`（沉淀的结论快照）、`trend.json`（体检趋势，≤400 条，含 cFreeBytes）、`acked.json`（静音清单）、`last-report.json`（跨重启回看，仅作展示，归因动作对其封锁）、`settings.json`（v0.8.0 起：面板「设置」存下的阈值）、`config-baseline.json`（配置指纹基线）。

## v0.9.2（模型巡检三件 + 严重问题右下角弹窗）

### 模型巡检：三件一起做

**① 默认模型健康哨兵。** 只探「默认模型 + 每个服务商前几个」（默认 2 个/服务商，总上限 12），
不是把 232 个模型全探一遍——每个探针都是一次真实的模型调用，免费额度不是无限的。
默认模型探不通就升 warning，并给出可切换的替代（同服务商优先，换过去代价最小）。

**② 跨插件可用率台账。** 每轮结果按服务商汇总成 ok / dead / busy 三个计数写进报告，
连续两轮零可用且至少一个明确不可用的服务商会被点名。这是历史，不是当前判定。

**③ 只标不判死。** 只有 HTTP 404 / 422（模型确实不存在）才算 dead；429 配额、5xx 网关、
超时、断网、以及「200 但一个字没返回」全部记 busy。理由很实在：把「此刻不行」当成「坏」
会把好模型从选择器里赶走，而配额与冷却本来就会自己恢复。**管家不删任何模型。**

### 严重问题右下角弹窗

挂 `shell.overlay`（frame-wide 浮层，replaceRisk none），默认只弹「严重」，
停留 12 秒、鼠标移上去暂停计时，带「去看看」（跳到对应动作卡）和「已知晓」（就地静音）。

这是**通知渠道**的开关，不是检测的开关：关掉它，体检照做、报告照写、静音与归因门一律不变。

### 本轮修掉的三个真 bug（都是「两边对不上」）

1. `report.js` 读 `health.probed`，而 `index.js` 传的是 `{ at, default, defaultVerdict, summary }`，
   计数在 `summary` 里 → 模型健康这条 finding 在真机上永远不会出现。单测用扁平形状喂进去反而过了。
2. `models.js` 的 `prevDead = prev.dead === 0 && prev.ok === 0` 判据写反：上一轮真有一个 dead
   反而被判「不满足」，连续两轮全灭永远报不出来。
3. `planSentinel` 的 `Number(options.perProvider) || 2` 把 0 吃掉了 —— 而 0 是合法值
   （「只探默认模型自己」），设置项里那句承诺原本是空话。

## v0.8.4（入口设置改完立刻生效，不再要求刷新页面）

- **真问题**：v0.8.2 的 `ui.entry` 只在 `apply()` 里读一次，改完必须重载整个 Web 界面；而桌面版里 Ctrl+R 未必有绑定（用户实测「好像没有效果」）。**一个设置项不该要求用户去猜快捷键**——把「改完要刷新」当成使用前提本身就是设计缺陷。
- 修法：`apply()` 改成 `mountFor(entry)` 可重入——先都挂上，读到设置再裁；并把当前重挂函数存进模块级 `ENTRY_APPLIER`。设置页保存成功后若 `ui.entry` 变化，直接调它就地重挂，**全程不刷新**。
- 顺带修掉一个语义重复：只留右侧栏时不再挂 `left`（导航项 + main 面板本体），避免两处重复；左侧栏的 `sidebar.panellist` 与 `main` 现在一起进出。
- `settings.js` 里 `ui.entry` 的说明文字去掉「改完要 Ctrl+R」，改为「保存后立刻生效，不用刷新页面」。
- smoke 仍 168 passed（入口重挂是 client 行为，靠 `node --check` + 真机验证，不进单元断言）。
## v0.8.3（拒绝措辞分清「不是数字」与「不是可选值」）

面板入口是第一个非数值设置项，于是暴露出旧错误文案的偷懒：任何被拒的值都报「这些值不是数字：…」。填了一个不存在的入口选项时看到「不是数字」会让人以为自己填错了格式，而实际上是那天公布的选项表里没有它。

现在按原因分组报：「这些值不是数字：ttl.plugin-updates；这些值不是可选值：ui.entry」。分组而不是合并成一句话，是因为两类错的改法完全不同。

## v0.8.2（面板入口可选：左侧栏 / 右侧栏 / 两个都要）

**问题**：管家在两个地方有入口（左侧栏图标 + 右侧栏标签页），有人只想要一个。

**做法**：设置页新增「界面 → 面板入口」，三选一（左侧栏 + 右侧栏 / 仅左侧栏 / 仅右侧栏）。

两个设计判断：

1. **不提供「完全不显示」**。那会让你再也点不到设置页改回来——把自己锁在门外的选项不是自由，是陷阱。
2. **先挂后撤，不是先读后挂**。`apply()` 是同步的、读设置是异步的，所以两个入口都先挂上，读到 `ui.entry` 之后再撤掉不要的那个。读失败就保持两个都在（默认态），不会出现一个入口都没有的空白。

另外 `ctx.slots` 服务没有 `unregister`（只有 `register` / `registerFactory` / `inject`），所以左侧入口的撤销走的是 `ctx.slots.inject(...)` 的返回函数，而不是按 key 解注册。

改完要 Ctrl+R 刷新一次面板才生效——槽位是挂载时建的，不会自己重画。

## v0.8.1（设置保存修复 + 输入条强调色）

- **修一个真 bug**：面板提交的是扁平键（`ttl.plugin-updates`），`normalize()` 原来只认嵌套形态（`ttl: {plugin-updates}`）→ 保存时全部 continue，返回「没有收到任何可保存的项」。现在两种形态都接受。
- 保存失败不再吃掉已填的值：错误从「整页替换」改成表单内的红条，读失败才允许整页替换。
- 输入条默认态改成强调色描边（`rgba(90,159,212,.42)`），聚焦态才升到实色 + 3px 光晕；圆形发送键同色系。
- smoke 165 passed（新增 3 条扁平键回归断言）。

## v0.8.0（设置项：判据松紧可调）

- 新增 `lib/settings.js`：11 项设置，分四组（静音有效期 6 / 判定阈值 3 / 采集 2 / 界面 1），每项带 `label/unit/min/max/def/why`。
- 面板新增第 4 个 Tab「设置」，控件由 host 下发的 SPEC 驱动——标签、范围、解释只有一份，前端不硬编码。
- 三条设计原则：只放开「判据的松紧」不放开「判据的有无」；越界夹到边界并回报；默认值即推荐值（没配过 = 与 v0.7.8 行为一致）。
- 阈值真正生效：`report.js` 的增长阈值 / 备份过期天数 / 配置漂移行数 / 采集上限、`actions.js` 的静音有效期全部读设置。
- 保存到 `~/.dsh/dsh-steward/settings.json`；静音有效期只影响**新**静音条目，已有的到期时间不变。

