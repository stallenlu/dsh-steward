/**
 * dsh-steward · settings — v0.8.0
 *
 * 用户可改的设置项。设计原则（三条，写在这里是为了以后不要走偏）：
 *
 * 1. **只开放「判据的松紧」，不开放「判据的有无」。** 用户可以把「多久没备份算
 *    陈旧」从 7 天改成 3 天，但不能把备份体检关掉——否则管家会退化成只报好消息
 *    的东西，那比没有更危险。
 * 2. **每一项都要能夹紧。** 数字不是自由文本：超出范围一律 clamp 到边界并在返回
 *    里说明被夹了，而不是静默接受一个会让检测失真的值（比如 0 天）。
 * 3. **默认值就是推荐值。** 没配过的用户拿到的行为和 v0.7.8 完全一致；改设置是
 *    可选动作，不是配置负担。
 *
 * 这份 spec 同时是「设置页渲染」的数据源：host 把 SPEC 发给 client，client 照着
 * 画控件。这样标签、单位、范围、解释只有一份，不会出现界面和逻辑两套口径。
 */

const SETTINGS_VERSION = 1;

/**
 * 一个 spec 条目：
 *   key      扁平键（点号分组，落盘时按组存）
 *   group    设置页分组
 *   label    界面上的名字
 *   unit     单位后缀
 *   min/max  合法区间（clamp 用）
 *   def      默认值
 *   why      为什么有这一项 / 调大调小分别意味着什么（界面上直接显示，不藏文档）
 */
const SPEC = [
  // ── 静音有效期 ────────────────────────────────────────────────
  {
    key: 'ttl.plugin-updates', group: '静音有效期', label: '插件更新提醒',
    unit: '天', min: 1, max: 180, def: 14,
    why: '「有新版本可用」你点了「已知晓」之后，隔多久再提。新版本来得频繁，所以默认只有 14 天；嫌吵可以拉长，但拉太长等于关掉这条提醒。',
  },
  {
    key: 'ttl.workspace-inventory', group: '静音有效期', label: '工作区体积提醒',
    unit: '天', min: 1, max: 365, def: 30,
    why: '会话数据明显长胖时的提醒。长胖是渐进的，一个月提醒一次够用。',
  },
  {
    key: 'ttl.data-at-risk', group: '静音有效期', label: '易失数据未备份提醒',
    unit: '天', min: 1, max: 365, def: 42,
    why: '这是结构性缺口（sessions 永远不在默认备份里），不是一次性事件。默认 6 周提一次，太短会变成唠叨。',
  },
  {
    key: 'ttl.backup-freshness', group: '静音有效期', label: '备份陈旧提醒',
    unit: '天', min: 1, max: 90, def: 7,
    why: '备份这件事的价值全在新鲜度上。默认一周，不建议拉长超过一个月。',
  },
  {
    key: 'ttl.compat-check', group: '静音有效期', label: '升级兼容提醒',
    unit: '天', min: 1, max: 180, def: 30,
    why: '宿主升级后这条会重新变真，所以有效期不宜太长，否则升级完看不到。',
  },
  {
    key: 'ttl.default', group: '静音有效期', label: '其它条目（缺省）',
    unit: '天', min: 1, max: 365, def: 90,
    why: '没单独列出的发现项用这个值。',
  },

  // ── 判定阈值 ──────────────────────────────────────────────────
  {
    key: 'threshold.growthWarnMb', group: '判定阈值', label: '工作区增长算「长胖」的净增',
    unit: 'MB', min: 1, max: 2048, def: 20,
    why: '比上一次体检净增超过这个数才升 warning。调小 = 更敏感（也更容易吵），调大 = 只有真的暴涨才说话。',
  },
  {
    key: 'threshold.backupStaleDays', group: '判定阈值', label: '备份多久算「陈旧」',
    unit: '天', min: 1, max: 365, def: 7,
    why: '最新一份导出超过这个天数就升 warning。和上面那条「备份陈旧提醒」是两个东西：这条决定**什么时候算问题**，那条决定**静音多久后再提**。',
  },
  {
    key: 'threshold.driftShrinkLines', group: '判定阈值', label: '配置文件少这么多行算「被吞」',
    unit: '行', min: 5, max: 5000, def: 20,
    why: 'cordis.patch.yml / package.json 比基线少超过这么多行，就当作 sanitizeProfile 写默认 stub 的痕迹。正常编辑删几行不该报警，所以别调到 5 以下。',
  },

  // ── 采集 ──────────────────────────────────────────────────────
  {
    key: 'collect.maxLogs', group: '采集', label: '最多读几份崩溃日志',
    unit: '份', min: 1, max: 200, def: 50,
    why: '崩溃日志通常只有几份。调大只影响极端情况下的读取量，不影响结论。',
  },
  {
    key: 'collect.maxBytesPerLog', group: '采集', label: '单份日志读取上限',
    unit: 'KB', min: 64, max: 16384, def: 2048,
    why: '超过这个大小的日志会被跳过并记进 errors（防止一份巨大日志卡住体检）。默认 2 MB 已远超正常崩溃日志（本机最大 61 KB）。',
  },

  // ── 界面 ──────────────────────────────────────────────────────
  {
    key: 'ui.autoScanMinutes', group: '界面', label: '自动体检 / 后台当班周期',
    unit: '分钟', min: 1, max: 240, def: 10,
    why: '一个数字管两处：切回面板时缓存超过这个时间就后台重体检一次；管家不开面板时也按这个周期自己醒来体检一遍（v0.9.16 L0 当班）。设为 1 分钟 = 几乎每次都刷；设大 = 更省，但看到的可能是几分钟前的样子。改完下一班就按新周期走，不用重启。',
  },
  {
    key: 'ui.entry', group: '界面', label: '面板入口', type: 'choice', def: 'both',
    options: [
      { value: 'both', label: '左侧栏 + 右侧栏' },
      { value: 'left', label: '仅左侧栏' },
      { value: 'right', label: '仅右侧栏' },
    ],
    why: '管家面板挂在哪。只想要一个入口就用「仅左侧栏」或「仅右侧栏」，省得两处重复。故意不提供「完全不显示」——那会让你再也点不到这里改回来，属于把自己锁在门外。保存后立刻生效，不用刷新页面。',
  },
  {
    key: 'ui.toast', group: '界面', label: '严重问题弹窗', type: 'choice', def: 'critical',
    options: [
      { value: 'critical', label: '只弹「严重」' },
      { value: 'warning', label: '「严重」和「留意」都弹' },
      { value: 'off', label: '不弹' },
    ],
    why: '屏幕右下角临时弹窗。这是**通知渠道**的开关，不是检测的开关——关掉它，体检照做、报告照写、静音与归因门一律不变，只是不主动弹出来。默认只弹「严重」：不打扰是设计目标之一，天天弹的东西会被无视，真出事那天也会被无视。',
  },
  {
    key: 'ui.toastSeconds', group: '界面', label: '弹窗停留时长',
    unit: '秒', min: 3, max: 60, def: 12,
    why: '弹窗自动消失的时间。太短看不清，太长会挡视线；鼠标移上去会暂停计时。',
  },

  // ── 模型巡检 ──────────────────────────────────────────────────
  {
    key: 'model.probeOnReport', group: '模型巡检', label: '体检时顺便探一下默认模型', type: 'choice', def: 'cached',
    options: [
      { value: 'cached', label: '用缓存（最快）' },
      { value: 'always', label: '每次都探' },
      { value: 'off', label: '不探' },
    ],
    why: '默认模型是你此刻真正在用的那一个，它挂了比任何配置问题都直接。默认「用缓存」：一次体检用上次的探测结果（3 小时内有效），不为了体检去花你的配额。「每次都探」会把每次体检变成一次真实模型调用。',
  },
  {
    key: 'model.perProvider', group: '模型巡检', label: '每个服务商探几个模型',
    unit: '个', min: 0, max: 5, def: 2,
    why: '只探每个服务商目录里的前几个（那是它们自己的推荐顺序），不探全量。设 0 = 只探默认模型自己。',
  },
  {
    key: 'model.maxTotal', group: '模型巡检', label: '一轮最多探几个模型',
    unit: '个', min: 1, max: 30, def: 12,
    why: '硬上限。每个探针是一次真实模型调用，免费额度不是无限的。',
  },
];

/** 扁平键 → 嵌套对象，例如 ttl.plugin-updates → { ttl: { 'plugin-updates': 14 } } */
function setDeep(target, flatKey, value) {
  const parts = flatKey.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cursor[k] || typeof cursor[k] !== 'object') cursor[k] = {};
    cursor = cursor[k];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function getDeep(source, flatKey, fallback) {
  const parts = flatKey.split('.');
  let cursor = source;
  for (let i = 0; i < parts.length; i += 1) {
    if (!cursor || typeof cursor !== 'object') return fallback;
    cursor = cursor[parts[i]];
  }
  return cursor === undefined || cursor === null ? fallback : cursor;
}

/** 默认设置（扁平键 → 值），每次返回新对象，调用方可随意改。 */
function defaults() {
  const out = {};
  for (const row of SPEC) setDeep(out, row.key, row.def);
  return out;
}

/** 扁平键 → 值；缺省或未在 spec 里登记的键一律回落默认。 */
function flatten(settings) {
  const out = {};
  for (const row of SPEC) setDeep(out, row.key, getDeep(settings, row.key, row.def));
  return out;
}

/**
 * 校验并夹紧一份用户输入。
 * 返回：
 *   ok       是否至少接受了一项（全被丢弃时 false）
 *   settings 规范化后的嵌套设置
 *   applied  真正被接受的项（扁平键 → 值）
 *   clamped  被夹紧的项 [{key, from, to}]
 *   rejected 被拒的项 [{key, reason}]
 */
function normalize(input) {
  const applied = {};
  const clamped = [];
  const rejected = [];
  const source = input && typeof input === 'object' ? input : {};
  for (const row of SPEC) {
    // 两种形态都接受：嵌套 {ttl:{'plugin-updates':7}} 和扁平 {'ttl.plugin-updates':7}。
    // 面板提交的是扁平键（每个输入框知道自己那一个键），外部脚本常提交嵌套。
    // 只认一种形态会让另一种静默变成「没有收到任何可保存的项」。
    let raw = getDeep(source, row.key, undefined);
    if (raw === undefined && Object.prototype.hasOwnProperty.call(source, row.key)) {
      raw = source[row.key];
    }
    if (raw === undefined) continue;              // 没提到就不动，保留原值
    if (raw === null || raw === '') {             // 显式清空 = 回默认
      applied[row.key] = row.def;
      continue;
    }
    if (row.type === 'choice') {
      const pick = String(raw);
      if (!row.options.some((o) => o.value === pick)) {
        rejected.push({ key: row.key, reason: '不是可选值' });
        continue;
      }
      applied[row.key] = pick;
      continue;
    }
    const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(num)) {
      rejected.push({ key: row.key, reason: '不是数字' });
      continue;
    }
    const rounded = Math.round(num);
    if (rounded < row.min) {
      clamped.push({ key: row.key, from: rounded, to: row.min });
      applied[row.key] = row.min;
    } else if (rounded > row.max) {
      clamped.push({ key: row.key, from: rounded, to: row.max });
      applied[row.key] = row.max;
    } else {
      applied[row.key] = rounded;
    }
  }
  const settings = defaults();
  for (const [key, value] of Object.entries(applied)) setDeep(settings, key, value);
  return { ok: Object.keys(applied).length > 0, settings, applied, clamped, rejected };
}

/** 把磁盘上存的设置与默认值合并（存的内容可能来自旧版本，缺项用默认）。 */
function merge(saved) {
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  const { settings } = normalize(saved);
  return settings;
}

/** 单值读取，带边界保护 —— 调用方不用自己记范围。 */
function value(settings, flatKey) {
  const row = SPEC.find((r) => r.key === flatKey);
  if (!row) return undefined;
  const raw = getDeep(settings, flatKey, row.def);
  if (row.type === 'choice') {
    const pick = typeof raw === 'string' ? raw : row.def;
    return row.options.some((o) => o.value === pick) ? pick : row.def;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return row.def;
  return Math.min(row.max, Math.max(row.min, Math.round(num)));
}

/** 静音有效期（天）；settings 里 ttl.<id> 优先，其次 ttl.default。 */
function ackTtlDays(settings, findingId) {
  const perItem = value(settings, 'ttl.' + findingId);
  if (perItem !== undefined) return perItem;
  return value(settings, 'ttl.default');
}

/** 给设置页用的可渲染描述：分组 + 每项的当前值与范围。 */
function describe(settings) {
  const groups = [];
  for (const row of SPEC) {
    let group = groups.find((g) => g.name === row.group);
    if (!group) { group = { name: row.group, items: [] }; groups.push(group); }
    group.items.push({
      key: row.key, label: row.label, unit: row.unit, min: row.min, max: row.max,
      def: row.def, why: row.why, value: value(settings, row.key),
      isDefault: value(settings, row.key) === row.def,
      ...(row.type === 'choice' ? { type: 'choice', options: row.options } : {}),
    });
  }
  return groups;
}

export {
  SETTINGS_VERSION, SPEC, defaults, flatten, normalize, merge, value,
  ackTtlDays, describe,
};
