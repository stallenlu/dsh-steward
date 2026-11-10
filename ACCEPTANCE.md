# 两周无误报验收表（回看日：2026-11-23）

> 用途：管理逻辑总纲第 3 条验收标准「连续两周无误报」的可执行检查口径。
> 起点 = 2026-11-09（v0.2.1 新鲜度门落地后 level 首次稳定在 ok）。
> 回看时逐条打勾，任何一条 ✗ 都要写清原因；标 N/A 的条目要写明「为什么两周内不具备条件」。
>
> **2026-11-10 修订（v0.7.7）：基线整体重采，并新增 A5–A8 四行。** 原因是 11-09 之后管家新增了四个检测项
> （工作区体积、插件更新、可信度自检、静音到期），每一个都带来**新的误报面**，而旧表只覆盖了崩溃/归因那一条线。
> 拿旧尺子量新报告，会让最该被检查的四项恰好无人检查。
>
> **2026-11-10 二次修订（v0.8.0）：新增 A9「设置项是否可被越界值带偏」，基线升到 v0.8.0 / 162 断言。**
> 理由是这轮把 11 项判据的松紧打开了，等于把「阈值」从代码常量变成了用户数据。
> 一旦用户把某个阈值调到失真（填 0、填负数、填字符串、填一个等于关闭该项的极端值），
> 报告会变得**比误报更难发现**——它会安静地什么都不报，而你以为它在看着。
> A9 要抓的正是这种「静默失效」，它比误报更危险，因为误报会喊、它会闭嘴。
>
> **2026-11-10 三次修订（v0.9.8）：基线升到 v0.9.8 / 252 断言，并新增 A10–A12 三行。**
> 这轮又加了三类检测（patch 备份结构、client 标识、模型健康），它们各自有独立的误报面；
> 更重要的是其间真实发生过一次**「修法本身变成误报」**——v0.9.6 把「patch 比备份小 20%」判成
> warning，真机立刻打脸（14 个 `- id:` 块一个没少，变小发生在块内字段），v0.9.7 才改成按结构判。
> A10 就是把这次教训钉成一条可复查的判据：**检测项自己的判据也要被验收**，不能因为「新加的」就免检。
>
> **2026-11-10 四次修订（v0.9.11）：基线升到 v0.9.11 / 274 断言，新增 A13 与 D5 两行。**
> v0.9.9–v0.9.11 这三轮没有新增检测项，改的全是「说得对但说得不准」；但这两行还是必须加，
> 因为它们抓的是**修完之后仍然没人看的地方**：
> - **A13**「一个数字被两个问题共用」——崩溃条目把「距当前启动多久」（49 秒）当成「多久以前」（实际 7 小时）。
>   两个数各自都算对了，合在一句话里就错。同一类错误还包括列表截断（只列 6 个却写「7 个工作区」）。
> - **D5**「测试全绿但包装不上」——v0.9.9 的 `files` 漏了 `lib/models.js`，
>   从源码树跑的 255 条断言全绿，装包的人一启动就 `ERR_MODULE_NOT_FOUND`，整个 Web UI 起不来。
>
> 两者的共同点值得单独记一笔：**本地一切正常，只有换一个人装、或换一个时间点读，才暴露**。
> 前者要换视角，后者要换读者——这正是自测最容易漏的两类。
>
> 另外**基线必须跟着换**：否则 11-23 回看时会拿 v0.9.8 的断言数（252）去比当时的 281，
> 把「覆盖变多了」误读成「有东西坏了」。
>
> 还有一条**静态判据**的用法：像「渲染处不许把 ISO 的 T 换成空格」这类规约（v0.9.11），
> 与其等它在界面上出错，不如直接扫源码——但静态判据必须**验证过会红**，否则它只是装饰。

> **2026-11-11 六次修订（v0.9.14）：基线升到 v0.9.14 / 292 断言，新增 A15 与 A16 两行。**
> v0.9.13 与 v0.9.14 修的是同一个真机故障的两层：面板画得出来、每个请求都 404。
> 第一层（v0.9.13）是**说法**问题——把 404 翻译成「接口没挂上」，但它把原因只归给了热重载。
> 第二层（v0.9.14）才是**病因**：冷启动时 `webServer` 与 `tools` 的 apply 排在本插件之后，
> 旧的 `getService(ctx,'webServer')` 一次性探测拿到 null，路由与两个工具都没注册，
> 而三处注册外面都包着 fail-soft `try/catch`，于是**失败完全无声**。
> 这两行分别钉住「说得准」和「挂得上」：
> - **A15**「路由/工具是否注册成功，能不能被看见」——错把「面板画出来了」当成「插件在工作」。
> - **A16**「冷启动与热重载是不是被当成同一个病因」——症状相同、修法不同，说错会让人白等一次重启。
>
> 还有一条更一般的教训值得记在这里：**fail-soft 是正确设计，但它的代价必须是可观测**。
> 这次不是注册逻辑写错了，是「注册失败」这个事实没有任何出口——面板照常渲染、`ping` 照常回
> `{"ok":true}`、日志里只有一行 warn。**一个不会喊的守卫，和没有守卫是一样的。**

## 基线快照（2026-11-11 05:05 采集（v0.9.14 重采），回看时用来对照）

| 项 | 基线值 |
|---|---|
| bundle 版本 | `@sidady/dsh-steward` v0.9.14，installed + enabled；ping 回报 `version:"0.9.14"` 且 `wiring.route:"registered"` |
| npm 上的版本 | **`0.9.14`**（`dist-tags.latest`，2026-11-11 发布；0.9.13 未单独发布，被 0.9.14 覆盖） |
| GitHub | `stallenlu/dsh-steward` public，`main` 最新提交 `6c7f43e`（v0.9.14） |
| 目录条目 | awesome-dsh-plugin PR **#14042** 开着；仓库年龄门到 2026-11-11T15:04:07Z（北京 23:04）才开，之后第一次 regate 是北京 2026-11-12 02:19；合并后 dshmarket 才拉得到 |
| 本地验证 | 9 个 JS `node --check` 全过，`smoke.mjs` **292 passed / 0 failed** |
| 体检结论 | `level=warning`，`counts={critical:0, warning:2, info:10, muted:0}`，`errors=[]`，共 12 条 findings |
| 两条 warning | `plugin-change`（本会话记录到 1 次插件变更，属事实非异常）+ `data-at-risk`（易失数据不在默认备份分区，长期项） |
| crash 日志 | **仍 4 份**，最晚 `crash-2026-11-09T23-28-38-158Z-web-boot.log`；v0.9.13/0.9.14 期间**零新增** |
| audit.jsonl | 40 行（v0.9.8 起 2000 行上限） |
| trend.json | **4 个点**，`cFreeBytes` 本轮 92.8 GB（此前 87.3 / 89.4 GB，不是恒定值） |
| acked.json | 空数组 `[]` |
| 工作区 | 7 个 / 合计约 **212 MB**（采集时 222699779 B；只看「7 个」与增长判定，不要咬死体积） |
| 插件更新 | 比对 11 个已装包：**0 个落后、0 个缓存偏旧、0 个无法比较**（全部最新） |
| 数据源覆盖 | `coverage` **7/7** = `data`，`unavailable=[]`，`errors=[]` |
| 配置指纹 | `cordis.patch.yml` `00751eb445af7595`（89178 B / 2816 行） / `profile package.json` `f48eb28205491760`（2837 B / 87 行）。**注意 patch 体量这两小时内从 60159 B 长到 89178 B**，回看时只比 `- id:` 块数有没有减少，不要比字节 |
| 设置 | `savedAt=2026-11-10T03:58:45.090Z`；`ttl` 六项默认、`threshold.growthWarnMb=20`、`collect.maxLogs=50/maxBytesPerLog=2048`、`ui.entry=right`、`ui.toast=critical`、`ui.toastSeconds=12`、`model.probeOnReport=cached`、`perProvider=2`、`maxTotal=12` |
| 客户端包 | 38 个声明 `dsh.client`，checked 38 / unreadable 0 / withoutId 0；`inject` 只声明 `@deepseek-ai/dsh-client-ui-slots` |
| 默认模型 | 12 个哨兵：**6 ok / 0 dead / 6 busy**（busy = 「没有返回内容」，不算坏）；默认 `workbuddy/hy4free` 可用，本轮耗时 40714 ms（免费额度吃紧时会明显变慢，仍属 ok） |
| 加密备份 | 2 份，最新 `dsh-config-2026-11-09-1749ba.zip`（100382581 B / 95.7 MB）1 天前；另一份 `dsh-config-20261108-180014-ab10fd.zip`（68776969 B） |

> **版本号与基线数字的关系**：本表的数字是「当天真实跑出来的」，不是「必须永远等于这个」；
> 回看时若断言数已经涨了（比如又加了几条），那是覆盖变多，记一笔新数字即可，不算退化。
> 真正要盯的是：crash 日志有没有新增、`errors` 是否仍为空、`coverage` 是否仍 7/7、
> 以及 `ping.wiring.route` 是否仍是 `registered`。
> **回看前先做一件事**：把 `package.json` 的 version、npm 上的 latest、ping 的 version 三个对一下。
> 三者不等说明「磁盘改了 / 发了 / 宿主没重载」里有一环断了——此时面板看到的是旧代码，任何 A 项的结论都不作数。

## 检查表

### A. 稳定性（核心：误报）

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| A1 | critical 是否为 0，或每条 critical 都有现行证据 | 面板「体检总览」+ crash 日志目录 | critical=0 → ✅ 直接打勾；critical>0 → 逐条回答「这条有对应的、晚于本次启动的崩溃日志吗」，全部有证才算 ✅ |
| A2 | 是否新增了 crash 日志 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` 文件数 | 仍为 **4 份** → ✅；新增的话，每份都必须在报告里被正确点名并给出建议，且没有连坐错点名 |
| A3 | 被点名的插件「此刻是否仍在坏」 | 报告 `data.suspects` + `plugin_manager list_bundles` | 没有出现「点名了一个其实正常运行的插件」→ ✅（这是 v0.2.2 归因门要守的那条线） |
| A4 | 陈旧证据是否都不再冒充现行风险 | 报告里 boot-crash-latest 的 `data.stale` | 若有历史崩溃，其 severity 必须是 info 且标题带「历史…当前实例启动正常」→ ✅ |

### A5–A9：v0.7.7 / v0.8.0 新检测项各自的误报面

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| A5 | 工作区体检是否成了「永远在喊的固定阈值」 | 报告 `workspace-inventory` 的 severity、连续 N 次体检里是否一直 warning | 口径已改为**增长判定**（净增 ≥ 20 MB 才升 warning，另有孤儿目录判定）。若体积没长还天天 warning → ❌；若两周内确有增长并报了 → ✅ |
| A6 | 插件更新检出是否把常态当发现 | 报告 `plugin-updates` 的 severity | 必须是 **info**，不得升 warning；若它哪次升了 warning → ❌ 记原因 |
| A7 | 可信度自检是否制造了恒常噪音 | 报告 `confidence` finding + `coverage.unavailable` | `unavailable` 为空时不产生 confidence finding（零噪音）→ ✅；若某个源长期 `unavailable` 导致每次体检都有一条 info，且你从未按它的话去修 → 记 ❌ |
| A8 | 静音到期是否变成「反复催同一件事」 | `acked.json` 的 `expiresAt` + 审计里的 ack/unack 记录 | 同一 finding 在一个月内因过期回来 **超过 2 次**，且你两次都没有采取行动 → ❌ |
| A9 | 设置项是否可被越界值带偏（**抓静默失效**） | `settings.json` + `POST {"action":"settings"}` 的 `groups` | 四项都满足才 ✅：①每个值在 SPEC `[min,max]` 内；②填 `0`/负数/`"abc"` 返回 `clamped`/`rejected` 且不静默吞；③阈值调极端时对应 finding **确实不再报**（仍按默认报=没接上，整份空白=波及别的检测）；④恢复默认立刻回基线 |

### A10–A13：v0.9.x 新检测项各自的误报面（本次新增）

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| A10 | patch 备份是否又退化成「按字节判丢」 | 报告 `patch-backup` 的 severity + `data.missing` | 判据必须是**结构式**：把 `.bak-<epoch>` 与当前 patch 的 `- id:` 块取差集，只有「整块消失」才 warning；仅体积变小必须是 info 且标题带「一个没少」。若两周内出现过「只小没丢却报 warning」→ ❌（v0.9.6 犯过一次，v0.9.7 修） |
| A11 | client 标识体检是否把「读不到」当「没问题」 | 报告 `client-identity` 的 `data` 三计数 | 必须 `unreadable` 与 `withoutId` 单独计数，且标题里的「N 个包」只等于 `checked`（不是「声明了 client 的包总数」）。若 `unreadable>0` 而标题仍报「通过」→ ❌（v0.9.5 前犯过：实际只核对 28/38 却按 38 报通过） |
| A12 | 模型健康是否把「忙」当「坏」 | 报告 `model-health` 的 `data.state` + `deadModels` | 只把 404/422（上游明确拒绝路由）与「连续两轮拿不到内容」算坏；429/5xx/超时/空回复一律记 busy 且不升 warning、不进 `deadModels`。若某个免费模型只是一时冷却却被写成「已不存在」→ ❌（这是最容易被免费额度误伤的一项） |
| A13 | 「多久以前」与「比启动早多久」有没有被混成一个数 | 报告 `boot-crash-latest` 的 `data.ageHours` / `bootLagHours` / `ageText` / `bootLagText` | 四个数各司其职：`ageHours` 是**距现在**多久、`bootLagHours` 是**距本次启动**多久，两者可以相差很大（真机 7.3 小时 vs 0.01 小时）。标题/正文里出现「约 0 小时前」而事件实际已过去数小时 → ❌（v0.9.10 前就是这样）。同类要一并查：列表截断有没有说出「另有 N 个」（工作区 / 备份 / 采集告警，v0.9.10） |
| A14 | 配色是不是又从 baseline 溜回自造色 | `node check.mjs ../dsh-steward/lib/client.js` + `smoke.mjs` 的配色静态判据 | 两个都必过：checker 报 `no hardcoded neutral` 不给 error 只说明「没有硬编码的灰」，**抓不到「自造一套蓝」**（那是另一种饱和度，不是灰）；所以真正的判据是 smoke 那 7 条 —— baseline 块外不许出现非中性的 `rgba()/rgb()`、不许出现 `var(--dsw` 之外的裸 hex、选中态必须用 `C.solid`/`C.on` 反相。若面板上又出现 `rgba(90,159,212,…)` 这类蓝、或选中态靠变蓝表示 → ❌（v0.9.12 前就是这样，12 处） |
| A15 | 路由与工具是不是「注册了但没说」 | `ping` 的 `wiring.route` / `wiring.via` + 面板能不能出报告 | 必须 `wiring.route === "registered"`，且 `wiring.via` 里 `systemPrompt` / `webServer` / `tools` 三条都是 `inject`。若面板画得出来但每个请求 404、`dsh_steward_*` 工具又「未知工具」→ ❌（v0.9.14 前就是这样：冷启动竞态下三处注册全被静默跳过，而 `ping` 还回 `{"ok":true}`） |
| A16 | 冷启动与热重载有没有被当成同一个病因 | 面板 404 时的提示文案 + 复现条件 | 两种情境都要能讲对：**热重载**=改插件文件后旧路由被销毁；**冷启动**=`webServer` 比插件晚 apply。文案里只写其中一种 → ❌（v0.9.13 只写热重载，于是用户重启后看到同一句提示，等于被指错了方向）。判据不看措辞好不好听，看它有没有把「我刚重启过」这个人排除掉 |

### B. 可回溯（每次动作都能查账）

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| B1 | 每次执行都有审计行 | `audit.jsonl` 与面板「审计趋势」Tab | 台账条数 = 文件行数、时间戳单调递增 → ✅ |
| B2 | 口令从未落盘 | `audit.jsonl` 全文 | grep `password` / `passwd` / `口令` / `secret` 零命中 → ✅ |
| B3 | 拒绝路径在干活（门没形同虚设） | `audit.jsonl` 的 `ok:false` 行 | 两周内至少出现过一次 `unknown-or-expired-plan` 或 `confirm-missing` → ✅ |

### C. 守底线

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| C1 | 没有代跑提权命令 | 会话记录 + `audit.jsonl` | 全期零次 `DISM` / `diskpart compact` / 卸载程序被 Agent 执行（只呈现过建议）→ ✅ |
| C2 | 没有「未经授权就动手」 | `audit.jsonl` 每条 `kind` ∈ {clean,backup,disable,enable,knowledge,ack,unack,model-default} 且都有 `hash` | 不存在 hash 为空却 `ok:true` 的执行行 → ✅ |
| C3 | 口令红线：11-16 周提醒只提醒不代做 | 会话记录（2026-11-16 10:00 那次触发） | Agent 没有索要口令、没有代跑、没有提议代跑 → ✅；任何一项违反 → ❌ 并回写 USER.md |
| C4 | 坏请求不会触发写动作 | 对路由发畸形 body | `{oops` / `{}` / 超 16 KB / JSON 数组 必须全部 400，且**不得**因此跑一次体检（v0.9.8 前会把空 action 当 report）→ ✅ |

### D. 自愈与降级

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| D1 | 依赖缺失只降级不崩溃 | `node smoke.mjs` 的 fail-soft 断言 | 回看当天跑一次 smoke，仍全绿（基线 292 passed / 0 failed）→ ✅（若期间又加断言，以当天全绿为准并记下新数字） |
| D2 | 热挂载后落库一致 | profile `package.json` + `/api/dsh-steward/` 200 + ping 版本 | grep `dsh-steward`=2、路由 200、ping 的 `version` = `package.json` 的 `version` 三者一致 → ✅。**注意**：`remove_bundle` 会因 `bundle-in-use` 失败，实际路径是 `set_bundle enabled:false → true`；ping 版本正确也**不**等于新代码已加载（读的是磁盘 package.json），要看新文案是否出现 |
| D3 | 可选数据源缺失不拖垮报告 | 报告 `status` 与 `coverage` | 缺一个可选源时 `status` 仍是 `ok`、只在 `coverage` 里记 `unavailable` → ✅ |
| D4 | 慢请求不会无限等待 | 面板发一次 `model-scan` | 服务端 3 路并发（12 探针最坏 ≈180 s），前端 `report`/`model-scan` 预算 240 s、普通动作 30 s。若面板转圈超过 5 分钟仍无任何提示 → ❌ |
| D5 | 打包白名单是否覆盖全部源码（**发布前必做**） | `npm pack --dry-run` 的文件清单 vs `lib/*.js` | `files` 必须包含 `lib/` 下每一个 JS；`smoke.mjs` 里的打包自检必须全绿（它会把 `lib/` 与 `files` 取差集，并解析所有 `from './x.js'`）。反向验证过：临时抽掉一个文件，自检应当 FAIL 并点名（v0.9.9 补上漏掉的 `lib/models.js`，否则装包的人一启动就 `ERR_MODULE_NOT_FOUND`、整个 Web UI 起不来） |

### E. 知识闭环（智能的雏形）

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| E1 | 趋势有连续记录 | `trend.json` | ≥3 个时间点且 `cFreeBytes` 不是恒定值 → ✅；不足 3 点 → 标 N/A |
| E2 | 同类问题第二次出现时能召回上次结论 | 报告 finding 上的 `🧠 上次也出现过` 提示 | 两周内出现过同类问题 → 召回必须命中；没出现过 → 标 N/A |

## 打勾时怎么取数

```bash
# 1) 审计与趋势（v0.9.8 起 audit 上限 2000 行，行数不再无界增长）
wc -l ~/.dsh/dsh-steward/audit.jsonl && cat ~/.dsh/dsh-steward/trend.json

# 2) crash 日志基数（基线 4 份）
ls -la "$APPDATA/@deepseek-ai/dsh-desktop/logs/" | grep crash

# 3) 静音与到期时间
cat ~/.dsh/dsh-steward/acked.json

# 3b) 设置项现状
cat ~/.dsh/dsh-steward/settings.json
curl -s -X POST http://127.0.0.1:<当前端口>/api/dsh-steward/ -H 'content-type: application/json' -d '{"action":"settings"}'

# 4) 落库与版本一致（三者必须一致）
grep -c dsh-steward ~/.dsh/profiles/desktop/package.json
node -e "console.log(require('./dsh-steward/package.json').version)"
curl -s -X POST http://127.0.0.1:<当前端口>/api/dsh-steward/ -H 'content-type: application/json' -d '{"action":"ping"}'

# 5) 坏请求不该跑体检（C4）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:<当前端口>/api/dsh-steward/ -H 'content-type: application/json' -d '{oops'

# 6) 路由到底挂上没有（A15）——比「面板能不能画出来」可靠得多
#    期望：version 三方一致，且 wiring.route === registered
#          wiring.via 里 systemPrompt / webServer / tools 三条都是 inject
curl -s -o "$TMP/ping.json" -X POST http://127.0.0.1:<当前端口>/api/dsh-steward/ -H 'content-type: application/json' -d '{"action":"ping"}'
cat "$TMP/ping.json"
```

> 端口每轮启动都会变，用运行时上下文里的 GUI URL，不要沿用旧端口。
> 取数时**别把 curl 管进 head**：`curl | head -c 300` 会让 head 提前关管道触发 SIGPIPE，
> curl 自己死掉、拿到一串 `status=000`，看起来像服务端崩了。用 `-o 文件` 落盘再读。

## A9 预演记录（2026-11-10，真机跑过一遍，回看时当对照）

四个子条件当时全部通过，因此 11-23 回看时如果任一项反而坏了，就是**退化**而不是「本来就是那样」：

| 子条件 | 当时怎么验的 | 当时结果 |
|---|---|---|
| ①值在范围内 | `cat settings.json` + `{"action":"settings"}` 的 `groups` | 全部在 `[min,max]` 内 |
| ②越界夹紧 / 非数字拒绝 | 分别提交 `growthWarnMb:0` 与 `plugin-updates:"abc"` | `clamped=[{key:"threshold.growthWarnMb",from:0,to:1}]`；`ok=false` + `rejected=[{key:"ttl.plugin-updates"}]` |
| ③设置真的到达检测 | 把 `collect.maxLogs` 改成 1 后重跑 report | `limitations` 第 5 条真的变成「日志 ≤ 1 份」——证明值穿透到了采集层 |
| ④恢复默认立刻回基线 | 把 `maxLogs` 改回 50 再跑 report | 文案回到「≤ 50 份」、`counts` 与基线一致 |

值得记住的坑：③ 当时用的是 `collect.maxLogs` 而不是某个阈值，因为**阈值的失效不一定会马上显形**
（改了增长门槛，可能本轮恰好没有增长数据、报告还是那样，看不出设置到底接没接上）；
而 `limitations` 文案是每轮必出的，它变了就等于拿到了「值确实到了检测层」的直接证据。
回看时若想验阈值本身，得先造出能触发它的数据，再用「改前报 / 改后不报」两边对照。

## 判定口径（避免事后含糊）

- **误报**的定义：报告在**当下**要求你处置，但你实际去看时**无事可做**。不是「标题不好看」，也不是「这条算 info 还是 warning」。
- **可接受的降级**：依赖缺失导致某张动作卡不可用、报告里给的是可读错误 → 不算失误，算 fail-soft 正常表现。
- **不可接受的降级**：任何一次让界面起不来、让面板点不动、让体检结果为空却显示 ok → 直接判 ❌，并升级为事故记录。
- **静态阈值不等于检测**：一个固定数字（如「超过 50 MB」）在你没变化时会天天亮，那不是发现问题，是把阈值当成了问题。A5/A8 就是专门抓这个的。
- **静默失效比误报更危险**：误报会让你烦，静默失效会让你放心。设置项一旦被调成失真值，报告会安静地什么都不报——所以 A9 里「调极端值后对应 finding 真的不再报」与「默认值真的回到基线」**两个方向都要验**，只验一边等于没验。
- **覆盖率不许冒充结论**：核对 28 个包、漏掉 10 个，就写 28 个；标题里的数字必须是**真正核对过的**那个，不是「声明了的」那个（A11）。
- **新检测项自己也要被验收**：新增一条检测时，它自己的判据也在被检验范围内。v0.9.6 的 patch-backup 就是「新加的判据本身是误报」——**「这次修法是否把 A 误报换成了 B 误报」要成为每轮加检测后的固定一问**（A10 就是这个教训的落地）。
- **一个数字只能回答一个问题**：v0.9.10 之前崩溃条目把「距当前启动多久」（49 秒）当成「多久以前」（其实已过 7 小时）来措辞，两者都对、合起来就错。回看时若见到「约 0 小时前」「N 秒前」这类与墙钟明显不符的时间，先问这个数在回答哪个问题，再改文案（v0.9.10 / A13 的思路）。
- **时间戳只有两种合法写法**：存 UTC（ISO 带 Z），显示本地；不接受 `replace('T',' ')` 这种「看起来本地化」实则仍是 UTC 的写法（v0.9.11）。文本报告故意保留 UTC 并标明，因为那份可能被别时区的程序读——**标明时区比猜一个更负责**。
- **依赖声明必须与代码一致**：`dsh.client.inject` 里声明了却零调用的包就是虚挂，它今天不报错、将来宿主改注入方式时会以「找不到依赖」的形式炸掉（v0.9.10 去掉了 locale）。判定方式是 grep 实际调用，不是看别的插件怎么写。
- **静态判据也必须验证会红**：像「渲染处不许把 ISO 的 T 换成空格」这种扫源码的断言，写完要故意改回旧写法确认它 FAIL，否则它只是装饰（v0.9.11 做了这次反向验证）。这条对所有 `smoke.mjs` 里的规约型断言都适用。
- **测试全绿不等于包能装**：`files` 白名单漏一个文件时，从源码树跑的断言全绿、装包的人一启动就 `ERR_MODULE_NOT_FOUND` 并拖垮整个 Web UI（v0.9.9 的 `lib/models.js`）。发布前必须跑一次 `npm pack` 并解包核对相对 import（D5）。
- **fail-soft 的代价必须是可观测**：
注册失败、依赖缺失这类「不该拖垮启动」的降级是正确的，但如果它连一条能查到的状态都不留，
就等于没有守卫。v0.9.14 之前三处注册全包在 `try/catch` 里只 warn 一行，
结果面板照常渲染、`ping` 照常回 `{ok:true}`、路由却从未注册——
**一个不会喊的守卫和没有守卫是一样的**。
判据：任何 fail-soft 分支都要能把「我降级了」暴露到 ping / 报告 / 日志三处里至少一处（A15）。
- **info 不算打扰，warning 才算**：判误报时先看 severity。info 天天在、你从不理它，是噪音的候选而非误报；warning 天天在、你无事可做，就是误报。
- 出现 ❌ 时不改判定标准，只记原因；判定标准本身要改，必须写下「为什么原标准不可执行」，不许事后放宽。

## 回看结论栏（11-23 填）

- 总体：✅ 通过 / 🟡 部分 / ❌ 不通过
- 未通过项与原因：
- 需要写入定稿的更正：
