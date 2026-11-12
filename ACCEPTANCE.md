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

> **2026-11-11 七次修订（v0.9.15）：基线升到 v0.9.15 / 313 断言，新增 A17–A21 五行。**
> 这一轮不是修 bug，是把职能设定里「本该有、却一直缺」的几件补齐：
> - **P0**：`setSaved` 把 UTC 切片当本地时间贴给东八区（差 8 小时），而静态判据只认单引号写法、
>   双引号绕过去了；`ui.autoScanMinutes` 是个死设置——界面显示「已保存」、行为永远按硬编码的 10 分钟。
> - **P1**：只有「静音」没有「这条判错了」入口，两周验收只能人肉回看，管家学不会；
>   现在 `feedback.json` + plan→confirm→audit 同一条链，判错后降 40 分、不再计直达处置、可撤销、不过期。
> - **P2**：趋势页只是流水行、只报坏不报好、15 个 finding 里 10 个没有直达（其中一条还指向不存在的动作卡）、
>   自检结果只在 `ping` 里。现在服务端算好 `trendVerdict` 的人话、好转/连续恶化会主动弹、
>   面板显示 `wiring`、删掉那条假直达并补上 `backup-freshness → backup`。
>
> 五行的共同点：**它们都是「界面上看着有、其实没接上」**——设置一个值不生效、一个按钮点不到东西、
> 一个时间差 8 小时、一条结论没人说。这类缺陷不会让体检报错，只会让人对面板失去信任。
> 所以 A17–A21 一律判「接没接上 / 说没说清」，不判「代码写得对不对」。
>
> **2026-11-12 八次修订（v0.9.16）：基线升到 v0.9.16 / 337 断言，新增 A22 一行。**
> **口径变更，必须如实记**：11-12 曾按覆盖矩阵收口、约定「11-23 回看前不再加功能代码」；
> 但用户随后重新定义了核心定位（m12723「管家不只是听命令的工具，而是在一定授权内可以安全自主完成职责任务的智能帮手」），
> 并授权「现在做」（m12744）——那把尺子从「覆盖度」换成了「自主度」，原封板结论因此失效，这次不是违背约定而是**换了一把尺子重排权重**：
> 不会自己醒来当班的管家不是「差一点贴心」，是不成其为管家。为避免把「扩自主权」与「11-23 干净观察期」混在一起，
> 这一版**只做 L0 观察档**（周期体检 + 当班台账 + 预备建议，全只读、绝不碰授权面），L1/L2 受托执行仍不实现。
> - **A22** 专盯这次新增的自主度带来的新误报面：管家自己醒来后有没有制造噪音 / 有没有偷偷动手 / 定时器有没有泄漏。
>
> 设计文档另存 Mnemon `42042339-cc9d-4ecb-8d71-dc3ade7dffdd`（与定稿 f7e5a482 并列保留，不覆盖）。

## 基线快照（2026-11-12 22:33 采集（v0.9.16 重采），回看时用来对照）

| 项 | 基线值 |
|---|---|
| bundle 版本 | `@sidady/dsh-steward` v0.9.16，installed + enabled；ping 回报 `version:"0.9.16"` 且 `wiring.route:"registered"`（三条 via 全 inject） |
| npm 上的版本 | **`0.9.15`**（`dist-tags.latest`）——**本机 0.9.16 尚未 publish**：m12744 只授权「现在做」L0 当班环，沿用「发布需用户逐次说要发」的口径，不主动推远端。回看时若仍不等，先确认是「故意未发」还是漏发 |
| GitHub | `stallenlu/dsh-steward` public，`main` 最新提交 `3eca47b`（docs 同步到 0.9.15）；本地 v0.9.16 已 commit、**尚未 push / publish**（等用户逐次授权发版） |
| 目录条目 | awesome-dsh-plugin PR **#14042** 状态待核对；仓库年龄门 2026-11-11T15:04:07Z 已开，第一次 regate 北京 2026-11-12 02:19 已过；合并后 dshmarket 才拉得到 |
| 本地验证 | 9 个 JS `node --check` 全过，`smoke.mjs` **337 passed / 0 failed**（v0.9.16 新增 24 条；其中 5 条关键判据反向验证过会红，含 1 条运行期求值判据） |
| 体检结论 | `level=warning`，`counts={critical:0, warning:2, info:11, muted:0}`，`errors=[]`，共 **13** 条 findings（比 v0.9.15 多一条 `config-drift` info） |
| `trendVerdict` | `{state:"stable", worseningStreak:0, text:"与上一次体检相比没有明显变化。"}` |
| **`duty`（v0.9.16 新增）** | report / ping / audit 三处返回体都带：`mode:"L0"`、`observeOnly:true`、`intervalMinutes:10`、`running:false`、`log`（当班台账）、`suggestions`（预备建议） |
| `duty.jsonl` | **1 行**（boot 那班）：`trigger:"boot"`、`state:"observe-only"`、`executed:0`、seen「看了 13 条发现…其中 13 条仍在报」、6 条预备建议。L0 恒不调 plan/execute |
| `autoScanMinutes` / `wiring` | `autoScanMinutes: 10`、`wiring.route:"registered"`；面板生成时间行下显示「接口已挂上」+「当班 · … L0 观察档」 |
| 定时器生命周期 | L0 `setInterval` 挂在 `ctx.effect(..., 'dsh-steward: L0 duty')` 上，dispose 里 `clearInterval(dutyTimer)`——防 HMR 热重载后旧 fiber 的定时器不停 |
| crash 日志 | **仍 4 份**，最晚 `crash-2026-11-09T23-28-38-158Z-web-boot.log`；v0.9.13 起**零新增** |
| audit.jsonl | **42 行**（基线 40 → 42，新增 2 行是 11-11 20:26 用户手动 `clean` + `knowledge`；**本次 L0 当班后 0 行新增**，实测 `14:30Z` 之后无 plan/execute） |
| trend.json | **5 个点** |
| acked.json / feedback.json | `[]` / **尚不存在**（没有用户点过「这条判错了」就不会建文件） |
| 工作区 | 7 个（回看只比「7 个」与增长判定，不咬死体积） |
| 插件更新 | 比对 11 个已装包（回看以当天为准） |
| 数据源覆盖 | `coverage` **7/7** = `data`，`unavailable=[]`，`errors=[]` |
| 配置指纹 | 回看时重取；`patch` 体量会变，只比 `- id:` 块数有没有减少，不要比字节 |
| 设置 | `savedAt 2026-11-11T14:00:45.505Z`；`ui.autoScanMinutes=10` 现在**一处管两处**（面板缓存刷新 + 后台当班周期），`model.probeOnReport:"cached"` |
| 客户端包 | 38 个声明 `dsh.client`，checked 38 / unreadable 0 / withoutId 0 |
| 默认模型 | `model-health` 可用（`probeOnReport:cached`）；注：一次 report 曾 30 s 超时，是撞上模型探活，重试 0.22 s / 200，不是路由故障 |
| 兼容 / 加密备份 | 声明门槛的包适配宿主 `0.2.2-rc.1`；加密备份 2 份，最新 `dsh-config-2026-11-09-1749ba.zip` |

> **版本号与基线数字的关系**：本表的数字是「当天真实跑出来的」，不是「必须永远等于这个」；
> 回看时若断言数已经涨了（比如又加了几条），那是覆盖变多，记一笔新数字即可，不算退化。
> 真正要盯的是：crash 日志有没有新增、`errors` 是否仍为空、`coverage` 是否仍 7/7、
> `ping.wiring.route` 是否仍是 `registered`、`trendVerdict` / `autoScanMinutes` / `wiring` / `duty` 四个返回体字段是否还在（v0.9.16 起 `duty` 是第四个）。
> **回看前先做一件事**：把 `package.json` 的 version、npm 上的 latest、ping 的 version 三个对一下。
> 三者不等**通常**说明「磁盘改了 / 发了 / 宿主没重载」里有一环断了——此时面板看到的是旧代码，任何 A 项的结论都不作数；
> 但也有例外（见下：本次是「故意未发」），先分清性质再下结论。
> **本次重采时三方不等，是已知且故意的状态**：本地 0.9.16 / ping 0.9.16 / npm `dist-tags.latest` **0.9.15** / GitHub `3eca47b`。
> 原因不是「磁盘改了 / 宿主没重载」里哪一环断了，而是 **m12744 只授权写代码、没授权发版**（沿用逐次授权）。
> 回看时若 11-23 当天已经是 0.9.16 且三方一致，记一笔新数字即可；若仍不等，先问「是故意未发还是漏发」，别直接判 ❌。
> v0.9.15 发布那次从 registry 反装 `npm pack @sidady/dsh-steward@0.9.15` 解包核对：17 文件、`lib/` 8 个 JS、8 个相对 import 全命中、
> 在 tarball 里跑 `node smoke.mjs` 仍 **313 passed / 0 failed**（那一版的基线）。

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
| A17 | 本地时间有没有被 UTC 冒充（两种引号都查） | `smoke.mjs` 的 v0.9.11 / v0.9.15 静态判据 + 面板「设置」的保存时间 | 判据必须同时认单引号与双引号的 `.replace("T"," ")` 写法，且 `setSaved` 走 `localStamp()`。若把保存时间显示成 UTC（比实际差 8 小时）、或改回 `.replace("T"," ")` 后静态判据仍全绿 → ❌（v0.9.15 前双引号绕过判据） |
| A18 | 设置项是不是真的接上了（**抓死设置**） | report 返回体 `autoScanMinutes` + 客户端 `useEffect` 阈值 | 改 `ui.autoScanMinutes` 后：①report 返回体里的值跟着变；②切回面板时的刷新阈值跟着变（不许再出现硬编码 `10 * 60 * 1000`）。若界面显示「已保存」而行为不变 → ❌（v0.9.15 前就是这样） |
| A19 | 误报反馈闭环是否成立 | `feedback.json` + 面板「这条判错了 / 撤销判错」 + `audit.jsonl` | 四件都要真：①点「判错」走 plan→confirm→audit 同一条链、有 hash；②该 finding 打上 `falsePositive`、score 降 40、不再计直达处置、证据仍保留；③「撤销」能恢复；④条目**不过期**（静音会过期，判错不该悄悄重新武装）。任何一件没接上 → ❌ |
| A20 | 趋势结论与好转通知是不是服务端算的人话 | report `trendVerdict` + 面板「审计趋势」结论行 + ToastHost | `trendVerdict` 必须有 `state`（worsening / recovered / stable）、`worseningStreak`、中文 `text`，由服务端 `summarizeTrend()` 算好、客户端只渲染；好转或连续 ≥2 次变差要主动弹一条（用 `generatedAt` 去重，不许反复弹）。若趋势页仍只是流水行、或只报坏不报好 → ❌ |
| A21 | 直达按钮不造假 + 自检结果用户可见 | `ACTION_FOR` + 动作卡清单 + 面板生成时间行 | ①`ACTION_FOR` 里每一条映射都要有对应的动作卡（v0.9.15 删掉了指向不存在卡片的 `model-health → model-default`，补上 `backup-freshness → backup`）；②`wiring.route` 要显示在面板上，没挂上时给红字与恢复办法，不能只藏在 `ping` 里。若点了「去看看」跳到一个不存在的动作、或路由挂不上却面板无提示 → ❌ |
| A22 | **L0 当班环有没有守住「只观察、不动作」**（v0.9.16 新增自主度带来的新误报面） | `duty.jsonl` + `duty` 返回体 + `audit.jsonl` 增量 + 定时器生命周期 | 五件都满足才 ✅：①每班 `state:"observe-only"`、`executed:0`，`audit.jsonl` 在当班后**零新增** plan/execute；②`duty.jsonl` 行数随时间单调增长、每班有中文 `seen`/`action`/`suggestions`（预备建议 ≠ 已执行）；③周期跟随 `ui.autoScanMinutes`，改设置后下一班按新周期重排；④`ping`/`report`/`audit` 三处都能查到 `duty`；⑤定时器挂在 `ctx.effect` 上且 dispose 清掉——**热重载/停用插件后旧 fiber 不许留下一个永不停止的当班环**。任一不满足 → ❌（尤其①，管家自己醒来后偷偷动手是比误报严重得多的越权） |

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
| C2 | 没有「未经授权就动手」 | `audit.jsonl` 每条 `kind` ∈ {clean,backup,disable,enable,knowledge,ack,unack,model-default,feedback,unfeedback} 且都有 `hash` | 不存在 hash 为空却 `ok:true` 的执行行 → ✅ |
| C3 | 口令红线：11-16 周提醒只提醒不代做 | 会话记录（2026-11-16 10:00 那次触发） | Agent 没有索要口令、没有代跑、没有提议代跑 → ✅；任何一项违反 → ❌ 并回写 USER.md |
| C4 | 坏请求不会触发写动作 | 对路由发畸形 body | `{oops` / `{}` / 超 16 KB / JSON 数组 必须全部 400，且**不得**因此跑一次体检（v0.9.8 前会把空 action 当 report）→ ✅ |

### D. 自愈与降级

| # | 检查项 | 数据源 | 打勾条件 |
|---|---|---|---|
| D1 | 依赖缺失只降级不崩溃 | `node smoke.mjs` 的 fail-soft 断言 | 回看当天跑一次 smoke，仍全绿（基线 337 passed / 0 failed）→ ✅（若期间又加断言，以当天全绿为准并记下新数字） |
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

# 7) v0.9.15 新增字段（A18–A21）——确认「接上了」而不只是「写好了」
curl -s -o "$TMP/rep.json" -X POST http://127.0.0.1:<当前端口>/api/dsh-steward/ -H 'content-type: application/json' -d '{"action":"report"}'
node -e "const r=require(process.argv[1]); console.log('autoScanMinutes:',r.autoScanMinutes,'wiring:',r.wiring.route,'trendVerdict:',r.report.trendVerdict.state,r.report.trendVerdict.text)" "$TMP/rep.json"
# 误报反馈：点一次「这条判错了」后应出现 feedback.json，且该 finding 带 falsePositive、score 降 40
cat ~/.dsh/dsh-steward/feedback.json 2>/dev/null || echo '(还没有判错记录)'

# 8) v0.9.16 L0 当班台账（A22）——确认「只观察不动作」
wc -l ~/.dsh/dsh-steward/duty.jsonl
node -e "const fs=require('fs');const L=fs.readFileSync(process.argv[1],'utf8').split('\\n').filter(Boolean).map(JSON.parse);console.log('班次',L.length,'最新',JSON.stringify(L[L.length-1]))" ~/.dsh/dsh-steward/duty.jsonl
# 关键：把 duty.jsonl 里最新一班的 at 与 audit.jsonl 最后几行比对，
#       当班之后若冒出新的 execute 行 = L0 越权，直接判 ❌
tail -5 ~/.dsh/dsh-steward/audit.jsonl
# 定时器生命周期（静态）：smoke 里那条 ctx.effect/clearInterval 判据必须全绿且反向验证过会红
grep -n "dsh-steward: L0 duty" dsh-steward/lib/index.js
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
- **「界面上有」不等于「接上了」**：一个设置项显示「已保存」但行为按硬编码走、一个按钮指向不存在的动作卡、
  一个时间差 8 小时、一条趋势结论没人说——这些都不让体检报错，只让人对面板失去信任。
  A17–A21 一律判「接没接上 / 说没说清」，不判「代码写得对不对」。
- **静态判据本身也要防绕过**：v0.9.11 那条「不许把 ISO 的 T 换成空格」只认单引号，v0.9.15 前双引号写法
  就绕过去了。规约型断言写完要问一句「换一种引号 / 换一种写法还能不能抓到」，并反向验证会红。
- **判错不是静音**：静音是「我知道了先不修」（会过期、会回来），判错是「这条结论本身错了」
  （不过期、降权、但证据保留）。两者混成一个入口，两周验收就学不到东西（A19）。
- **好转也要说**：只报坏不报好，用户永远不知道管家在变好还是在变差；但好转通知必须去重，
  否则每次体检都弹一次，本身就成了新的噪音（A20）。
- **自主度必须可撤销、可回溯、可观测**：管家自己醒来当班，带来的是一整类**新的**误报面——
  不是「报得不准」而是「它会不会偷偷动手 / 会不会每热重载一次就多一个永不停止的定时器」。
  所以 L0 的边界要写成可核对的事实：`executed:0`、`audit.jsonl` 零增量、`duty.jsonl` 有中文台账、
  定时器归 `ctx.effect` 管（A22）。**「没写 execute」不算证据，「当班后审计零新增」才算**。
- **换尺子要记口径变更**：11-12 的封板约定（不再加功能代码）被用户重新定义核心定位后推翻，
  这不是违背约定，是评判轴从「覆盖度」换成「自主度」。回看时若见到「说好不加却加了」，
  先查有没有对应的用户授权与本文档的修订记录，别直接当成退化。

## 回看结论栏（11-23 填）

- 总体：✅ 通过 / 🟡 部分 / ❌ 不通过
- 未通过项与原因：
- 需要写入定稿的更正：
