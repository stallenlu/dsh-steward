# 工作区/会话巡检与归类建议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 L0 当班环只读巡检所有工作区/会话，产出带理由的「垃圾 / 可复用 / 可归档」归类建议；用户点某条才经宿主服务深读正文，决定权与执行完全在用户，管家不删不移、不写审计。

**Architecture:** 三层分离。① 巡检层放 `lib/report.js`（纯元数据、零宿主包依赖红线不变）；② 深读层放 `lib/index.js` 的独立 action，经 `getService(ctx, ...)` 调宿主服务，失败降级元数据措辞；③ 决策台放 `lib/client.js` 体检总览内的一块，展示服务端算好的中文建议 + 指向插件的入口，完全不碰 plan/execute/audit。

**Tech Stack:** Node ESM、React `createElement`（`h`）、`node:fs` / `node:path`、宿主 Cordis `ctx.get`、smoke.mjs 内存夹具 + `new Function` 运行期 harness。

**Spec:** `docs/superpowers/specs/2026-11-26-workspace-session-tidying-design.md`（已获用户批准，含深读路径 O1 = 经宿主服务）

## Global Constraints

- `lib/report.js:4-10` 零宿主包依赖红线不变；深读不得放进 `report.js`，只能放 `index.js` 层 `getService(ctx, ...)`。
- L0 恒 `observeOnly:true`（`lib/index.js:400-411` `dutySnapshot()`）；`runDuty()`（:427-458）只读。
- 不新增 ActionKind：`lib/brain.js:14` 的 `KINDS`、`lib/intent.js:67` 的 `ACTION_KINDS` 一律不动。
- 不动 `lib/actions.js`（plan 零写入 / execute `confirm:true` + 单次指纹 / 审计 / 口令永不持久化），不写审计台账。
- 服务端算好人话，客户端只渲染（USER.md critical）。
- 每版号递增一个 patch：当前 0.9.24 → **0.9.25**（沿用本项目「一次改动一个 patch」既有惯例；发版工具链里的 workspace exclude 字符串同步）。
- 发版链（源码树改完不会自动生效，本机为 registry tarball）：本地 commit → push → `npm publish` → 轮询 registry 传播完成 → 改 profile dep → bundled pnpm 11.28.5 先 `install --lockfile-only` 再 `install --frozen-lockfile --ignore-scripts` → `set_bundle enabled:false→true` → `list_bundles` 确认 source → 告知用户刷新页面。
- 临时产物一律 `dsh-*` 前缀放 `E:/DshConfig`（`_` 前缀会被宿主清理）；补丁写脚本文件按锚点恰好 1 命中、全内存变换后原子写盘，不用 `node -e`（反引号被 bash 命令替换）。

## Review Focus

以下 5 类输入/失败模式是规格暗示但任何单任务测试都不易覆盖的，实现者要特别当心；括号里是钉住它的测试所在任务：

1. **深读服务不存在或抛错** → 必须降级成「未读到内容、需你本人确认」的元数据措辞，绝不写「已读/已核对」。(Task 3)
2. **911 个会话 / 单个 51MB 会话** → 巡检必须采样有上限（≤20 条/次），绝不一次全量深读。(Task 1、Task 4)
3. **多帧 zstd 只有第一帧可读** → 绝不把 header-only 内容当成「读过正文」，深读走宿主服务而非 Node zstd。(Task 3)
4. **零候选 / 全健康** → 出 info、不出 warning，不制造噪音。(Task 2)
5. **用户从未点击** → 零自动删移、零审计写入、`observeOnly` 仍 true；深读按钮是唯一触发点。(Task 2、Task 4)

---

### Task 1: 巡检层 — 纯元数据候选分类

**Files:**
- Modify: `lib/report.js`（在 `collectWorkspaces`（:376-426）之后新增 `export function collectTidyingCandidates(...)`）
- Test: `smoke.mjs`（新增夹具 + 断言组）

**Interfaces:**
- Consumes: `collectWorkspaces(paths, io, errors)` → `{ available, workspaces:[{id,title,path,dirName,exists,sessionCount,bytes,ageDays}], totalBytes, sessionsDir }`（`lib/report.js:376-426`）。
- Produces: `collectTidyingCandidates(workspaces, options, errors)` → `{ candidates:[{ key, kind:'garbage'|'reusable'|'archivable'|'pending', confidence:'high'|'low', title, why, evidencePath, signals:[string] }], scanned, truncated }`。`options = { limit:20, now }`。纯函数，不读文件、不调服务。

- [ ] **Step 1: 写失败测试** — 在 `smoke.mjs` 用夹具 workspaces（含：一个 `ageDays>90` 且 `bytes` 很小 → archivable；一个 `sessionCount=0` 且 `exists=false` → garbage；一个 `bytes` 巨大且有重复信号 → pending；一个健康 → 不入选）断言 `collectTidyingCandidates` 输出的 `kind` / `confidence` / `evidencePath` 及 `limit` 截断（`candidates.length <= 20 && truncated === true`）。同时断言 Review Focus #2：`scanned` 计数反映全部输入而 `candidates` 被截断。
- [ ] **Step 2: 跑测试确认红** — `node smoke.mjs`，预期 FAIL `collectTidyingCandidates is not a function`。
- [ ] **Step 3: 实现 `collectTidyingCandidates`** — 四信号（体积 / 陈旧 / 重复 / 孤儿）从 `w.bytes / w.ageDays / w.title / w.exists / w.sessionCount` 算；低置信度一律 `kind:'pending', confidence:'low'`；每条 `why` 是服务端中文短句；按体积降序 + 陈旧加权排序；`options.limit` 默认 20。孤儿（`exists=false`）标 `garbage` 但 `why` 必须写「目录已不存在，需你确认」而非断言式。
- [ ] **Step 4: 跑测试确认绿** — `node smoke.mjs`，预期 v0.9.25 候选断言全部 PASS。
- [ ] **Step 5: Commit** — `git add lib/report.js smoke.mjs && git commit -m "feat(v0.9.25): metadata-only workspace tidying candidates"`

### Task 2: 报告集成 — 新增 `workspace-tidying` finding（服务端算人话）

**Files:**
- Modify: `lib/report.js`（`collectReport` 内 workspace-inventory 块（:1398-1468）之后新增一块）
- Test: `smoke.mjs`

**Interfaces:**
- Consumes: Task 1 的 `collectTidyingCandidates(...)`；`currentSettings()` 值经 `settingValue(settings, ...)` 读取。
- Produces: finding `id:'workspace-tidying'`，`category:'工作区与会话'`，`severity`（有候选→`info`；零候选→`info`，**永不 warning**），`detail`（服务端中文，逐条列「类别 · 理由 · 证据路径」，并附「需你本人确认，管家不删不移」），`recommendation`（指向对应插件的入口文字），`data:{ candidates, scanned, truncated }`。`ACTIONABLE_IDS` **不**加此项（钉住 Review Focus #5）。

- [ ] **Step 1: 写失败测试** — 断言报告里出现 `workspace-tidying` finding、`data.candidates` 来自 Task 1 夹具、零候选夹具下 severity 仍 `info`、`detail` 含「需你本人确认」、且 `ACTIONABLE_IDS` 不含该 id。
- [ ] **Step 2: 跑测试确认红** — `node smoke.mjs`，预期 FAIL `workspace-tidying finding present`。
- [ ] **Step 3: 实现 finding** — try/catch 包裹，失败 `errors.push({step:'workspace-tidying', error})` 而不影响报告；coverage **不加键**（保持 `sourcesTotal===7`）。
- [ ] **Step 4: 跑测试确认绿** — `node smoke.mjs`，预期 PASS。
- [ ] **Step 5: Commit** — `git commit -m "feat(v0.9.25): report emits workspace-tidying advice finding"`

### Task 3: 深读 action — 经宿主服务，失败降级

**Files:**
- Modify: `lib/index.js`（新增 `run(action='tidying-detail')` 分支，位置在 `runModelScan` 附近；用 `getService(ctx, ...)`，签名见 `lib/index.js:54-66`）
- Test: `smoke.mjs`（用 `new Function` 抠 action body 注入假 ctx 的运行期 harness）

**Interfaces:**
- Consumes: 宿主服务（archive-manager 暴露的 `workspaceRegistry`，方法含 `previewSessionContent` / `searchSessionContent` / `archivedSessionMetadata`，经 `@deepseek-ai/dsh-typert-protocol` 的 `bindTypertRemote` 绑定；`lib/workspace.js:99-114` `ARCHIVE_REMOTE_METHODS`）。
- Produces: action 入参 `{ action:'tidying-detail', key }`，返回 `{ ok:true, key, reason:<服务端中文>, evidencePath, deepRead:boolean, degraded:boolean }`；服务缺失/抛错时返回 `deepRead:false, degraded:true, reason:'未读到内容，需你本人确认'`。

- [ ] **Step 1: 可行性侦察（结果可核对）** — 在宿主 profile 里查 archive-manager 暴露的**确切 service key 与方法签名**，把它写进本任务的实现注记。若查不到确切 key，实现必须让 action 恒走降级分支（而不是猜一个 key 调用后静默失败）。核对点：`lib/workspace.js:99-114` 的 `ARCHIVE_REMOTE_METHODS` 与 typert `bindTypertRemote` 的注册名。
- [ ] **Step 2: 写失败测试（运行期 harness）** — 假 ctx 三种：`get('workspaceRegistry')` 返回带 `previewSessionContent` 的对象 → 期望 `deepRead:true`；返回 null → `degraded:true`；方法抛错 → `degraded:true` 且**不冒泡**。断言三种情况下 `reason` 都不含「已核对」。
- [ ] **Step 3: 跑测试确认红。**
- [ ] **Step 4: 实现 action** — `getService(ctx, key)` 取服务；调用目标方法读内容、把结果交给一个纯函数拼中文理由（不塞进 report.js）；`try/catch` 全覆盖；**不调用 plan/execute、不写 audit**。
- [ ] **Step 5: 跑测试确认绿 + Commit** — `git commit -m "feat(v0.9.25): deep-read action with honest degradation"`

### Task 4: 决策台 UI — 候选列表 + 按需深读按钮

**Files:**
- Modify: `lib/client.js`（体检总览 tab 内、`Briefing` 之后新增 `TidyingPanel` 块；顶部 `ACTION_FOR`（:103）保持不动）
- Test: `smoke.mjs`（静态断言 + `new Function` 渲染 harness）

**Interfaces:**
- Consumes: Task 2 的 `workspace-tidying` finding `data.candidates`；Task 3 的 `tidying-detail` action（经既有 `call()`，:111-125 已有超时保护）。
- Produces: `TidyingPanel(props)` 组件；每行 = 类别 badge + 服务端中文理由 + 「查看详情」按钮；点击调 `call('tidying-detail', {key})`，结果在位展开显示 `reason` 与 `evidencePath`；`degraded` 时显示「未读到内容」。

- [ ] **Step 1: 写失败测试** — 静态断言 client.js 含 `TidyingPanel` 与 `tidying-detail`、且**不含** `ACTION_FOR['workspace-tidying']`；运行期 harness 注入假 `call` 与假 finding，断言渲染出「查看详情」、点击后 `degraded:true` 显示「未读到内容」、且不触发任何 plan/execute 调用。
- [ ] **Step 2: 跑测试确认红。**
- [ ] **Step 3: 实现 `TidyingPanel`** — 复用现有 `C` / `Badge` / `TinyBtn`；样式走 baseline token（不写死颜色/圆角，遵守 baseline 标记块外施工纪律）；所有用户可见文字来自服务端，不在客户端拼句。
- [ ] **Step 4: 跑测试确认绿 + 全量验证** — 9 个 JS `node --check` 全 OK；`node smoke.mjs` 全绿；记录断言总数。
- [ ] **Step 5: Commit** — `git commit -m "feat(v0.9.25): decision-console panel with on-demand deep read"`

### Task 5: 版本、文档、反向验证与发版

**Files:**
- Modify: `package.json:3`（0.9.24→0.9.25）、`lib/client.js:2` 头注释、`README.md`、`ACCEPTANCE.md`
- Test: 反向验证 + 真机

- [ ] **Step 1: 文档同步** — README 状态行 + 新段（讲三层架构、决定权在用户、按需深读）；ACCEPTANCE 新增修订块 + A34 判据（四类失败模式：服务缺失降级 / 采样上限 / 零候选不误报 / 零自动删移）+ 演进链 + D1 基线。
- [ ] **Step 2: 反向验证** — 复制 git 全量到 `dsh-p925-rev/`，`git show HEAD:` 退回四个产品文件、保留新 smoke/文档，跑 smoke：新断言必须转红、`OTHER FAILED` 必须为 0。
- [ ] **Step 3: commit 产品 + push。**
- [ ] **Step 4: 完整发版链** — 按 Global Constraints 逐步执行；每步留一手证据；publish 后**轮询传播完成**再 `--lockfile-only`；装前查 `dsh-our-free-model` 三处齐全（防 11-16 那种按 lockfile 连带移除）。
- [ ] **Step 5: 真机验证 + 文档同步 commit + push + 清理 + 交付** — ping 0.9.25 / `list_bundles` source / report 含 `workspace-tidying` / crash 日志仍 4 份；文档状态改成「已发布并本机重装」；清理 `dsh-p925*` / `dsh-rel925*`；交付时告知用户刷新页面，并按设计 §8 另立验收信号（零自动删移 / 采纳次数 / 误报数），不拿规格数自证。

---

## Self-Review

- **Spec coverage：** §2 目标→Task1/2/3/4；§6 巡检/深读/决策台→Task1/3/4；§3 约束→Global Constraints；Review Focus 五条→Task1/2/3/4 各有测试；§8 我的 call→Task1（三类+待核对）/Task2（不进 ACTIONABLE_IDS）/Task5（验收信号）。无遗漏。
- **Type consistency：** `collectTidyingCandidates` / `workspace-tidying` / `tidying-detail` / `TidyingPanel` 四个跨任务名字在 Interfaces 中一致。
- **Proportion：** 计划只钉签名、值、测试与边界，未抄写实现体。
