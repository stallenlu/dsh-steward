// 模型健康：巡检、台账、只标不判死。
//
// 三件事，一个文件，因为它们共用同一套「判据」——判据分开写，三处口径迟早漂。
//
//   1. 哨兵（sentinel）：只探默认模型和每个 provider 的头几个模型，不探全量。
//      232 个模型全探一遍要几十分钟，那不叫体检，那叫拿用户的机器跑压测。
//   2. 台账（ledger）：每次巡检把「哪些 provider 现在就答不上来」记进 trend，
//      多次对比才能看出是偶发还是真的坏了。
//   3. 只标不判死：只有明确的「这个模型不存在」才算死。429/5xx/超时/401
//      都只是「此刻不行」，一律记 busy —— 把忙当死会把好模型从选择器里赶走，
//      比不巡检更糟。
//
// 本模块零外部依赖（只用宿主注入的 llm.stream），不 import 任何其它插件的内部
// 模块 —— 跨包版本漂移正是这个项目要防的头号问题。

/** 一次探测结果的有效期。和 dsh-freellmapi 的 PROBE_TTL_MS 同量级。 */
export const MODEL_VERDICT_TTL_MS = 3 * 60 * 60 * 1000;

/** 单次探测超时。免费模型经常几十秒才吐第一个字，10 秒会把它们全判死。 */
export const MODEL_PROBE_TIMEOUT_MS = 45_000;

/**
 * 只有这两个状态码表示「上游确实不再提供这个模型」。
 * 其余（429 配额、5xx 网关、401 凭据、超时、空响应）都是「此刻」，不是「事实」。
 */
export const DEAD_STATUS = new Set([404, 422]);

const PROBE_PROMPT = 'Reply with exactly OK';

/** 把各种失败形态压成三态之一：ok / dead / busy。绝不返回第四态。 */
export function classifyProbe(err) {
  if (!err) return 'ok';
  const raw = err.status != null ? err.status : err.statusCode;
  const status = Number(raw);
  if (Number.isFinite(status)) return DEAD_STATUS.has(status) ? 'dead' : 'busy';
  const text = String(err.code || err.message || err || '');
  // 适配器常把状态码塞进 message：「404 model not found」
  const m = /(?:^|\D)(404|422|429|401|403|5\d\d)(?:\D|$)/.exec(text);
  if (m) return DEAD_STATUS.has(Number(m[1])) ? 'dead' : 'busy';
  return 'busy';
}

/**
 * 探一个模型：问它一句最短的话，看有没有字回来。
 *
 * 三种可见结局：
 *   ok    有非空回复
 *   busy  抛错（状态码决定 dead 还是 busy）或什么都没有返回
 * 空回复单独处理：cline 的 nemotron 就出现过「一个字也不吐」，那是模型这次没
 * 干活，不代表它不存在 —— 记 busy，不记 dead。
 */
export async function probeModel(deps, target) {
  const llm = deps && deps.llm;
  const provider = target && target.provider;
  const model = target && target.model;
  const at = Date.now();
  if (!llm || typeof llm.stream !== 'function') {
    return { provider, model, verdict: 'busy', at, note: '宿主没有 llm 服务' };
  }
  if (!provider || !model) {
    return { provider, model, verdict: 'busy', at, note: '缺少 provider/model' };
  }
  const timeoutMs = (target && target.timeoutMs) || MODEL_PROBE_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* noop */ } }, timeoutMs) : null;
  let text = '';
  let failure = null;
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_PROMPT }] }],
      maxTokens: 16,
      signal: controller ? controller.signal : undefined,
    })) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; continue; }
      if (chunk.type === 'error') { failure = chunk.error || chunk; }
    }
  } catch (err) {
    failure = err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const ms = Date.now() - at;
  if (failure) {
    return {
      provider, model, verdict: classifyProbe(failure), at, ms,
      note: String((failure && (failure.message || failure.code)) || 'stream failed').slice(0, 160),
    };
  }
  if (text.trim().length === 0) {
    // 200 但没有内容：不算死。给一个明确的 note，面板上能看出区别。
    return { provider, model, verdict: 'busy', at, ms, note: '没有返回内容' };
  }
  return { provider, model, verdict: 'ok', at, ms };
}

/**
 * 挑出这次要探哪些模型（哨兵集）。
 *
 * 规则：
 *   - 默认模型必探（它是「用户此刻真的在用」的那一个）
 *   - 每个 provider 前 perProvider 个（目录顺序即其推荐顺序）
 *   - 总量上限 maxTotal，防止某个 provider 有 30 个模型时把预算吃光
 * 不去重同名跨 provider 的情况：同名不同 provider 是两个不同的服务。
 */
export function planSentinel(catalog, options = {}) {
  // 注意不能用 `Number(x) || 2`：0 是合法值（只探默认模型自己），
  // 但 || 把 0 当 falsy 换成 2，设置里那个「设 0 = 只探默认模型」就永远是空话。
  const rawPer = Number(options.perProvider);
  const perProvider = Math.max(0, Number.isFinite(rawPer) ? rawPer : 2);
  const maxTotal = Math.max(1, Number(options.maxTotal) || 12);
  const out = [];
  const seen = new Set();
  const push = (provider, model) => {
    if (!provider || !model) return;
    const key = provider + '|' + model;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, model });
  };
  const def = catalog && catalog.default;
  const providers = Array.isArray(catalog && catalog.providers) ? catalog.providers : [];
  if (def && def.provider && def.model) push(def.provider, def.model);
  for (const p of providers) {
    const models = Array.isArray(p && p.models) ? p.models : [];
    for (const m of models.slice(0, perProvider)) push(p.id, m && m.id);
    if (out.length >= maxTotal) break;
  }
  return out.slice(0, maxTotal);
}

/**
 * 汇总探测结果 + 与上一轮台账对比。
 *
 * 台账口径：per provider 记 ok/dead/busy 计数与「哪些模型明确死」。
 * 只有当某个 provider 连续两轮都是 0 ok 且至少 1 dead 时，才算「整体不可用」——
 * 单轮全 busy 更可能是网断了或者都在冷却，不该报。
 */
export function summarize(probes, previous, now = new Date()) {
  const list = Array.isArray(probes) ? probes.filter(Boolean) : [];
  const byProvider = new Map();
  for (const p of list) {
    const key = String(p.provider || '');
    if (!byProvider.has(key)) byProvider.set(key, { provider: key, ok: 0, dead: 0, busy: 0, deadModels: [] });
    const row = byProvider.get(key);
    if (p.verdict === 'ok') row.ok += 1;
    else if (p.verdict === 'dead') { row.dead += 1; row.deadModels.push(p.model); }
    else row.busy += 1;
  }
  const prevRows = new Map();
  const prevList = previous && Array.isArray(previous.providers) ? previous.providers : [];
  for (const r of prevList) if (r && r.provider) prevRows.set(String(r.provider), r);

  const providers = Array.from(byProvider.values()).map((row) => {
    const prev = prevRows.get(row.provider);
    // 「上一轮也没一个能用」= 上一轮 ok === 0。曾经写成 dead === 0 是反的：
    // 上一轮若真有一个 dead，反而被判成「不满足」，连续两轮全灭永远报不出来。
    const prevOffline = !!(prev && prev.ok === 0);
    return {
      ...row,
      // 两轮都没有一个能用的，且这轮有明确的死模型 —— 这才是「坏了」。
      offlineTwoRounds: row.ok === 0 && row.dead > 0 && prevOffline,
      at: now.toISOString ? now.toISOString() : String(now),
    };
  });

  const okCount = list.filter((p) => p.verdict === 'ok').length;
  const deadCount = list.filter((p) => p.verdict === 'dead').length;
  const busyCount = list.filter((p) => p.verdict === 'busy').length;
  const deadModels = list.filter((p) => p.verdict === 'dead')
    .map((p) => ({ provider: p.provider, model: p.model, note: p.note || '', status: p.status }));

  return {
    probed: list.length,
    ok: okCount,
    dead: deadCount,
    busy: busyCount,
    deadModels,
    providers,
    at: now.toISOString ? now.toISOString() : String(now),
  };
}

/** 默认模型的结论：ok / dead / busy / unprobed / missing。 */
export function defaultVerdict(probes, defaultSelection) {
  if (!defaultSelection || !defaultSelection.provider || !defaultSelection.model) return { state: 'missing' };
  const hit = (Array.isArray(probes) ? probes : []).find(
    (p) => p && p.provider === defaultSelection.provider && p.model === defaultSelection.model,
  );
  if (!hit) return { state: 'unprobed' };
  if (hit.verdict === 'ok') return { state: 'ok', ms: hit.ms };
  if (hit.verdict === 'dead') return { state: 'dead', note: hit.note || '', status: hit.status };
  return { state: 'busy', note: hit.note || '' };
}

/**
 * 从哪里能换一个可用的默认模型。
 *
 * 不给「随便挑一个」：优先同一个 provider 里这轮探测 ok 的其它模型（换服务商
 * 是更大的动作），其次别的 provider 里 ok 的。都没有就返回空，让面板说
 * 「现在没有可推荐的替代」——这比推荐一个同样不可用的强。
 */
export function suggestDefault(probes, current) {
  const list = (Array.isArray(probes) ? probes : []).filter((p) => p && p.verdict === 'ok');
  const sameProvider = list.filter((p) => p.provider === (current && current.provider) && p.model !== (current && current.model));
  const pool = sameProvider.length > 0 ? sameProvider : list.filter((p) => p.model !== (current && current.model));
  if (pool.length === 0) return null;
  const pick = pool[0];
  return { provider: pick.provider, model: pick.model, sameProvider: sameProvider.length > 0, ms: pick.ms };
}
