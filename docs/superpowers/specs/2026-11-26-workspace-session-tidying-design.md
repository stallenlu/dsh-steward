# 工作区 / 会话定期巡检与内容归类建议 — 设计文档

- 日期：2026-11-26
- 状态：**设计已定稿，待用户批准**（brainstorming HARD-GATE：批准前不写产品代码、不调用实施类 skill）
- 归属：dsh-steward（会话边界 m11030：本会话只负责 dsh-steward）
- 用户诉求来源：m16682 / m16688（含三条「继续」m16685–m16687）
- 用户已选：方案 C「按需深读 · 统一决策台」（m16733）；深读路径 = **经宿主服务深读**（m16819）
- Builder check：已完成（fresh subagent 冷读文档 + report.js/index.js/actions.js/client.js，2026-11-26），结果见 §10

## 1. 意图与为什么

用户希望智能管家对 DSH 的**所有工作区与所有会话**做定期巡检，提醒做合理的内容归类整理：垃圾文件清理、可复用内容的复用建议、可归档内容的归档等。目标是工作区随持续使用仍对用户友好，而不是越堆越乱。

`dsh-mnemon` 已做了一部分：记忆自进化建议、`dsh-mnemon-source-documents`（项目档案 Markdown 的检索/修订/归档）、Git 同步与「记忆整理」。但它做的是**记忆 / wiki 层**的老化与归档；本需求面向的是**会话 / 工作区文件层**的垃圾、复用、归档。两者互补，不重叠，不互相替代。

用户明确的核心边界：**「建议 + 安全原则下的处理与执行建议，决定权在用户手里。」** 与管家既有安全模型一致：L0 恒观察、plan 零写入、execute 必须 `confirm:true` + 单次指纹、每次动作留审计、口令永不持久化。

## 2. 目标 / 非目标 / 反目标

**目标**
- 在既有 L0 当班环里增加「工作区/会话巡检」层，默认只读、只产出观察与建议。
- 平时只算元数据：体积、陈旧度、重复、孤儿；不做内容读取。
- 用户点某一条时，**经宿主服务深读该会话内容**，给出归类理由与证据路径。
- 归类分三类：垃圾 / 可复用 / 可归档，每条带「为什么这样判」和证据路径；低置信度标「需你确认」。
- 产出「处理建议」：服务端算好的中文说明 + 指向对应插件的入口；决定权与执行都在用户。

**非目标**
- 不改 `dsh-mnemon` 的记忆/wiki 整理能力，也不重复它。
- 不做自动清理 / 自动归档执行器；不新增 ActionKind；不动 `actions.js`/`brain.js`/`intent.js`；不写审计台账（§10-D4）。
- 不解析口令、不碰加密备份、不碰启动/boot 与 `cordis.patch.yml`、不改其他插件配置。
- 不把「规格数达标」当验收（USER.md critical：验收看真实需求与功能到位，不是自证闭环）。

**反目标（即使技术上跑通也算失败）**
- 任何形式的「管家替用户决定了并已执行删/移」。
- 把元数据层面的「看起来像」写成结论性断言（例如仅凭体积大就说「这是垃圾」）。
- 读不到内容时冒充「已核对」，或用覆盖率掩盖未核对（v0.9.5/A11 的教训）。

## 3. 约束

- **只读 L0**：`lib/index.js:427-458` `runDuty` 复用 `run('report')`，`dutySnapshot()`（:400-411）`observeOnly:true`。巡检只在采集/建议层增加，不能变成自动动作。
- **report 层零宿主包依赖**：`lib/report.js:4-10` 只 import `fs/path/os/crypto` 与 `./settings.js`。**深读不放在 report 采集路径**（见 §6）。
- **人话由服务端算、客户端只渲染**（USER.md critical）：归类理由与建议必须是服务端算好的中文，客户端不拼句子。
- **规模**：实测 13 个工作区目录、**911** 个会话；巡检必须采样/分页/按需，不能每次全量深读。

## 4. 已查清的现状（写码依据）

### 4.1 现有工作区体检
`lib/report.js:376-426` `collectWorkspaces(paths, io, errors)`：读 `dshHome/storages/workspace.json` 的 `tables.workspaces` + `global.workspaceIds`；每 ws 用 `dirSize(io, dir)` 算体积、`sessionCount`、`ageDays`（目录 mtime）、`exists`。

`lib/report.js:1398-1468` `workspace-inventory` finding 只判 orphan / grown(≥`threshold.growthWarnMb` 默认 20MB) / normal 三种；recommendation 已有一句「旧会话可用 @michengai/dsh-archive-manager 归档，管家只报告不删不移」，但没有逐会话的内容归类。

### 4.2 动作层
`lib/brain.js:14` `KINDS = ['clean','backup','disable','enable','knowledge','ack','unack','report','goto']`；`lib/intent.js:67` `ACTION_KINDS` 不含 report/goto；`lib/client.js:103` `ACTION_FOR` 无 workspace-inventory 归档动作。本版不碰这些。

### 4.3 会话文件的真实形态（决定深读路径的关键约束）
- 每个会话目录一个 `session.v4.jsonl.zstd`。
- 它是**多帧 zstd**：一个 51 MB 会话里有 **17,702 个** frame magic（`28 b5 2f fd`）。
- Node stdlib（host v24.15 / bundled v24.21）的 `zstdDecompressSync` / `createZstdDecompress` **只解第一帧**（session header：`type/version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset`），拿不到正文。
- 唯一现成的正文读取方是 `@michengai/dsh-archive-manager`：`lib/workspace.js:99-114` 暴露 `ARCHIVE_REMOTE_METHODS`（含 `previewSessionContent` / `searchSessionContent` / `archivedSessionMetadata` 等），通过 `@deepseek-ai/dsh-typert-protocol` 的 `Remote` + `bindTypertRemote` 绑定；`lib/workspace.js:21-49` 的 `jsonlSessionDirectory()` 把 header 映射到会话目录。
- **用户已裁决（m16819）**：走 (a) 经宿主服务深读，即点开时调用上述能力。落地时需先做一次小验证确认 steward 能否从 `ctx` 拿到该服务；拿不到则按 §6 降级，不让功能卡死。**这项可行性侦察属于实施阶段第一步，不是设计未决项。**

## 5. 方案取舍

| 方案 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| A. 全量深读 | 每次当班读完所有会话正文 | 911 会话 + 多帧 zstd，代价大；与 L0 轻量冲突 | 否决 |
| B. 只做元数据 | 永远只看体积/陈旧/孤儿 | 安全轻量，但「理由」只能靠猜 | 否决（仅作深读失败时的降级措辞） |
| C. 按需深读 · 统一决策台 | 平时只算元数据；用户点某条才读正文、给理由 | 兼顾轻量与「有理由的建议」 | **用户已选** |

## 6. 定稿的 how

- **巡检层（每次当班，report 采集路径内）**：复用 `collectWorkspaces` 元数据，为每条工作区/会话算「体积、陈旧度、重复、孤儿」四个信号，产出候选条目。只读、采样、有上限。
- **深读层（用户点某条触发，独立面板 action，不进 report 采集）**：经宿主服务（archive-manager 的 preview/search）读该会话正文，产出归类理由 + 证据路径（会话目录 / 文件 / 命中信号）。**可用性检测**：服务不存在或调用失败 → 降级为「未读到内容、需你本人确认」的元数据措辞，绝不冒充已读；深读只读、不改会话文件、不写审计。
- **决策台（统一入口）**：报告新增「工作区整理建议」一节，候选条目按三类列出；每条附「查看详情（按需深读）」与「处理建议」入口。处理建议是**文字 + 指向对应插件的入口**，不进 plan/execute 链、不写审计（§10-D4）。
- **安全**：决定权在用户；口令永不代输；低置信度写「需你确认」，不写成断言。

## 7. 已裁决项（原开放项）

**O1 — 深读读取路径：用户已选 (a) 经宿主服务深读**（m16819）。理由：用户点「按需深读」要的就是有内容的理由；但只在用户显式点击时耦合宿主服务，report 层零依赖红线保持不变；读不到就降级成元数据措辞。模块边界：深读是**独立的面板 action**（在 `index.js` 层调 `getService(ctx, ...)`，那里已有 pluginManager/agentDefaultModel/llm 的先例），不塞进 `report.js`。

## 8. 我做的决定（用户可在批准文档时推翻）

- **归类集合**：用户可见三类（垃圾/可复用/可归档）+ 内部置信度标记 `待核对`；低置信度一律显示「需你确认」，不许写成断言（§10-D2）。
- **「可复用」去向**：指含可提炼的决策/代码/笔记、值得提升为文档或记忆的会话；建议指向用户本人整理进 `dsh-mnemon-source-documents` 或笔记，**不自动搬运**（§10-Q4）。
- **验收口径**：11-09→11-23 回看截止日已过，本功能另立信号：①零自动删移、②建议被用户实际采纳的次数、③误报率（用户点「这条判错了」）。规格数只作护栏不作结论（§10-D5）。
- finding id/category/severity 命名、候选数据结构、采样上限（倾向 20 条/次，可翻页）、排序（体积降序 + 陈旧加权）、中文措辞、深读 UI 形态（条目右侧按钮、点击在位展开）：builder 自定。

## 9. 批准前状态

本文件是设计文档，**未写任何产品代码**。流程：写出 → builder check（已完成）→ 「theirs」问题带回用户并裁决（O1 已选 (a)）→ **用户批准文档** → 才进入 writing-plans 与实现。当前停在「待用户批准」。

## 10. Builder check 结果与处理

Builder（fresh subagent，已读文档 + 四个源码文件）提 5 问，处理如下：

- **#1（blocker，深读来源）→ §7，用户已裁决 (a) 经宿主服务深读。**
- **#2（high，plan/execute 到底执行什么）→ §2/§6，用户原话回答**：只产出文字建议 + 指向插件的入口，不新增 ActionKind、不动 actions.js/brain.js/intent.js、不写审计。原先 §5/§6「走 plan→confirm→execute→审计」措辞是我写宽了，已改。
- **#3（high，三类还是四类 + 置信度）→ §8 我的 call**：三类 + 内部「待核对」；低置信度显示「需你确认」。深读失败时理由明说「未读内容」。
- **#4（medium，「可复用」去向）→ §8 我的 call**：值得提炼为文档/记忆的会话，指向用户本人整理，不自动搬运。
- **#5（lower，11-23 窗口与验收信号）→ §8 已由项目上下文回答**：窗口已过，另立验收信号。
