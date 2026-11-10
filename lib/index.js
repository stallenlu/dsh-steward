/**
 * dsh-steward · host entry (index.js) — v0.6
 *
 * Deliberately declares NO `export const inject`. Pain points #1/#4 of this
 * project are literally "one plugin that fails to activate crashes the whole
 * web boot". A hard `inject: ['tools','webServer']` makes this bundle a boot
 * dependency; instead every capability is looked up programmatically with
 * ctx.get(name) (confirmed inject-free in dsh-config-manager/lib/core/model-tools.js:268,275
 * and @michengai/dsh-archive-manager/lib/plugin-updater.js:77 optionalService)
 * and each registration is fail-soft: any error is contained so the steward
 * degrades to "event counter only" instead of failing the boot fiber.
 *
 * v0.2 adds the ACTION hub (plan/execute with a single-use fingerprint).
 * Plans are zero-write; executes are audited; passwords never persist.
 * Contract for routes/tools mirrors the running dsh-disk-cleaner@1.6.2 host entry.
 */
import { collectReport } from './report.js';
import { createActionHub } from './actions.js';
import { parseIntent } from './intent.js';
import { runModel, normalizeBrainOutput } from './brain.js';
import { defaults as defaultSettings, merge as mergeSettings, normalize as normalizeSettings, describe as describeSettings, value as settingValue } from './settings.js';
import { MODEL_VERDICT_TTL_MS, MODEL_PROBE_TIMEOUT_MS, probeModel, planSentinel, summarize, defaultVerdict, suggestDefault } from './models.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

export const name = 'dsh-steward';

// v0.6.0 L2: the conversational entry. `intent` turns one sentence into ONE
// target (which action card to open) and never executes anything by itself —
// the sentence is a shortcut to the same plan→confirm→audit chain a click uses.
// Kept host-side so the parsing logic is testable with plain node (client
// bundles cannot be unit-tested here at all).

const ROUTE_PREFIX = '/api/dsh-steward/';
const MAX_BODY = 16384;

// Version is read on every ping, NOT cached at module load. The Host process
// reuses the already-imported host module across remove→install of a link:
// dependency, so a load-time constant would keep reporting the old version.
let versionFallback = '0.4.x';
function pkgVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const v = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || '').trim();
    if (v) { versionFallback = v; return v; }
  } catch { /* file briefly absent during reinstall — keep last good value */ }
  return versionFallback;
}

/** Programmatic, inject-free service lookup. Never throws. */
function getService(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const svc = ctx.get(key);
      if (svc) return svc;
    }
  } catch { /* get() unavailable or service missing — fall through */ }
  try {
    const svc = ctx[key]; // property access requires inject; may throw — contained
    if (svc) return svc;
  } catch { /* "cannot get property X without inject" — expected without inject */ }
  return null;
}

function sendJson(res, status, value) {
  try {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch { /* response already gone */ }
}

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  const host = req.headers && req.headers.host;
  if (origin === undefined || host === undefined) return true;
  return origin === `http://${host}` || origin === `https://${host}`;
}

// v0.9.8: "the body was unreadable" and "the body was an empty object" are two
// different facts, and collapsing them was a real bug: readBody returned {} for a
// broken body, and run() treated action === '' as "run a full checkup". So a
// malformed request — or one 17 KB payload — silently triggered the most
// expensive thing this plugin does. Callers can now tell the two apart.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) { finish({ parsed: false, reason: 'body exceeds ' + MAX_BODY + ' bytes' }); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') { finish({ parsed: true, value: {} }); return; }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          finish({ parsed: false, reason: 'body must be a JSON object' });
          return;
        }
        finish({ parsed: true, value });
      } catch { finish({ parsed: false, reason: 'invalid JSON' }); }
    });
    req.on('error', () => finish({ parsed: false, reason: 'request stream failed' }));
  });
}

/** In-memory, bounded plugin-change counter (resets on restart; no disk IO in callback). */
function createChangeStore() {
  const changes = [];
  return {
    push(evt) {
      try {
        changes.push({ at: new Date().toISOString(), type: String((evt && (evt.type || evt.action)) || 'change') });
        if (changes.length > 50) changes.shift();
      } catch { /* never throw from an event listener */ }
    },
    snapshot() { return changes.slice(); },
  };
}

function dataDir() {
  const root = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(root, 'dsh-steward');
}

const io = {
  async appendJsonl(file, obj) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
  },
  async readJson(file) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
  },
  async writeJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value), 'utf8');
  },
  async readBytes(file) {
    return await fsp.readFile(file);
  },
  // v0.9.8: append-only jsonl files need a way to be read back and rewritten when
  // they cross a cap. Optional by contract — a caller whose io lacks these simply
  // skips trimming rather than failing the write.
  async readText(file) {
    return await fsp.readFile(file, 'utf8');
  },
  async writeText(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
  },
};

function renderReportText(report) {
  const lines = [];
  lines.push(`# 智能管家 · 体检报告 (${report.summary.level.toUpperCase()})`);
  lines.push(report.summary.headline);
  lines.push('');
  lines.push(`生成时间: ${report.generatedAt}（UTC） | 状态: ${report.status} | 计数: critical=${report.summary.counts.critical} warning=${report.summary.counts.warning} info=${report.summary.counts.info}`);
  lines.push('');
  for (const f of report.findings) {
    lines.push(`## [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(f.detail);
    if (f.evidence) lines.push(`证据: ${f.evidence}`);
    if (f.recommendation) lines.push(`建议: ${f.recommendation}`);
    lines.push('');
  }
  lines.push('边界: ' + report.limitations.join(' '));
  if (report.errors.length) lines.push('采集告警: ' + JSON.stringify(report.errors));
  return lines.join('\n');
}

/**
 * Loopback call into another plugin's host route. Uses this process's own
 * advertised origin — 127.0.0.1 loopback is not behind the browser-session
 * trust fence (verified against /api/disk-cleaner/ and
 * /api/dsh-config-manager/export-preview this session).
 */
function makeRouteFetch(ctx) {
  return async function routeFetch(routePath, body, opts = {}) {
    let base = '';
    try {
      const webApp = getService(ctx, 'webApp');
      if (webApp && typeof webApp.getAdvertisedUrl === 'function') base = String(webApp.getAdvertisedUrl()).replace(/\/+$/, '');
    } catch { /* fall through */ }
    if (!base) {
      const webServer = getService(ctx, 'webServer');
      if (webServer && typeof webServer.getOrigin === 'function') base = String(webServer.getOrigin()).replace(/\/+$/, '');
    }
    if (!base) throw new Error('无法解析本机 GUI origin（webApp/webServer 服务不可用）。');
    const response = await fetch(base + routePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(180_000),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error(`${routePath} → HTTP ${response.status}`); }
    if (!response.ok || (opts.requireOk !== false && (!data || data.ok !== true))) {
      throw new Error(`${routePath}: ${(data && (data.error || data.message)) || 'HTTP ' + response.status}`);
    }
    return data;
  };
}

export function apply(ctx) {
  const changes = createChangeStore();
  let lastReport = null;
  const files = {
    audit: path.join(dataDir(), 'audit.jsonl'),
    trend: path.join(dataDir(), 'trend.json'),
    knowledge: path.join(dataDir(), 'knowledge.jsonl'),
    acked: path.join(dataDir(), 'acked.json'),
    lastReport: path.join(dataDir(), 'last-report.json'),
    configBaseline: path.join(dataDir(), 'config-baseline.json'),
    settings: path.join(dataDir(), 'settings.json'),
    modelProbes: path.join(dataDir(), 'model-probes.json'),
  };
  // v0.8.0 设置：内存缓存 + 落盘。读不到/坏了 → 全默认（旧行为），绝不拦住体检。
  let settingsCache = null;
  let settingsSavedAt = null;
  async function loadSettings() {
    if (settingsCache) return settingsCache;
    let saved = null;
    try { saved = await io.readJson(files.settings); } catch { saved = null; }
    if (saved && typeof saved === 'object' && saved.settings) {
      settingsCache = mergeSettings(saved.settings);
      settingsSavedAt = typeof saved.at === 'string' ? saved.at : null;
    } else {
      settingsCache = defaultSettings();
    }
    return settingsCache;
  }
  function currentSettings() {
    return settingsCache || defaultSettings();
  }
  async function saveSettings(input) {
    const before = currentSettings();
    const result = normalizeSettings(input);
    if (!result.ok) {
      // 报错要说人话：choice 项被拒不是「不是数字」，分两种原因分开报，
      // 否则用户填了一个不存在的选项，却被告知「这些值不是数字」。
      const badNumber = result.rejected.filter((r) => r.reason !== '不是可选值');
      const badChoice = result.rejected.filter((r) => r.reason === '不是可选值');
      const parts = [];
      if (badNumber.length) parts.push('这些值不是数字：' + badNumber.map((r) => r.key).join('、'));
      if (badChoice.length) parts.push('这些值不是可选值：' + badChoice.map((r) => r.key).join('、'));
      return {
        ok: false,
        error: parts.length ? parts.join('；') : '没有收到任何可保存的项。',
        rejected: result.rejected,
        groups: describeSettings(before),
      };
    }
    // 合并到现有设置上（只改提交的项，其余保持原值）。
    const next = before;
    for (const [flat, val] of Object.entries(result.applied)) {
      const parts = flat.split('.');
      let cursor = next;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
        cursor = cursor[parts[i]];
      }
      cursor[parts[parts.length - 1]] = val;
    }
    settingsCache = next;
    settingsSavedAt = new Date().toISOString();
    try { await io.writeJson(files.settings, { at: settingsSavedAt, settings: next }); }
    catch (error) {
      return { ok: false, error: '写入设置失败：' + (error && error.message ? error.message : String(error)), groups: describeSettings(next) };
    }
    const human = ['设置已保存。'];
    if (result.clamped.length) {
      human.push('有 ' + result.clamped.length + ' 项超出范围被夹到边界：' + result.clamped.map((c) => c.key + ' ' + c.from + '→' + c.to).join('、') + '。');
    }
    if (result.rejected.length) {
      human.push('有 ' + result.rejected.length + ' 项因不是数字被忽略：' + result.rejected.map((r) => r.key).join('、') + '。');
    }
    human.push('下一次体检会用新阈值；静音有效期只影响新静音的条目，已有的到期时间不变。');
    return { ok: true, settings: next, groups: describeSettings(next), savedAt: settingsSavedAt, clamped: result.clamped, rejected: result.rejected, human };
  }
  let knowledgeLog = null; // loaded once per process, shared with recall
  async function loadKnowledge() {
    if (Array.isArray(knowledgeLog)) return knowledgeLog;
    knowledgeLog = [];
    try {
      const raw = await fsp.readFile(files.knowledge, 'utf8');
      knowledgeLog = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* no knowledge yet — empty recall */ }
    return knowledgeLog;
  }
  // ② v0.3.1 cross-restart persistence: on first request after a process
  // restart, restore the last persisted report so the panel is not blank.
  // It is explicitly marked staleAfterRestart — a persisted report may carry
  // CURRENT crash evidence generated in the PREVIOUS process, and the
  // attribution gate in actions.js refuses to act on it until a fresh scan.
  let restoredTried = false;
  async function ensureRestored() {
    if (lastReport || restoredTried) return;
    restoredTried = true;
    try {
      const saved = await io.readJson(files.lastReport);
      if (saved && saved.report && typeof saved.report.generatedAt === 'string') {
        const bootedIso = new Date(Date.now() - Math.floor(process.uptime()) * 1000).toISOString();
        saved.report.staleAfterRestart = saved.report.generatedAt < bootedIso;
        saved.report.restoredFrom = saved.report.generatedAt;
        lastReport = saved.report;
      }
    } catch { /* nothing persisted — start clean */ }
  }
  const hub = createActionHub({
    routeFetch: makeRouteFetch(ctx),
    getPluginManager: () => getService(ctx, 'pluginManager'),
    getDefaultModel: () => getService(ctx, 'agentDefaultModel'),
    getReport: () => lastReport,
    getSettings: () => currentSettings(),
    io,
    now: () => new Date(),
    auditFile: files.audit,
    trendFile: files.trend,
    knowledgeFile: files.knowledge,
    ackedFile: files.acked,
  });

  // ---------- v0.9.1 模型健康 ----------
  // 目录读取抽成一处：models 与 model-now 走同一份，避免两处口径漂。
  async function readCatalog() {
    const out = { ok: true, available: false, providers: [], default: null, error: '', cachedAt: null };
    try {
      const llm = getService(ctx, 'llm');
      if (llm && typeof llm.listProviders === 'function') {
        out.available = true;
        const list = await llm.listProviders();
        for (const p of Array.isArray(list) ? list : []) {
          const id = p && (p.id || p.provider);
          if (!id) continue;
          const models = [];
          try {
            const ms = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
            for (const m of Array.isArray(ms) ? ms : []) {
              const mid = m && (m.id || m.model);
              if (mid) models.push({ id: String(mid), name: String(m.name || mid) });
            }
          } catch { /* one provider's catalog failing never hides the rest */ }
          if (models.length) out.providers.push({ id: String(id), name: String(p.name || id), models });
        }
      }
    } catch (e) { out.error = e && e.message ? e.message : String(e); }
    try {
      const sel = getService(ctx, 'agentDefaultModel');
      const cur = sel && typeof sel.currentSelection === 'function' ? sel.currentSelection() : null;
      if (cur && cur.provider && cur.model) out.default = { provider: String(cur.provider), model: String(cur.model) };
    } catch { /* no default selection is fine */ }
    if (!out.default && out.providers.length) out.default = { provider: out.providers[0].id, model: out.providers[0].models[0].id };
    return out;
  }
  function sentinelOptions(settings) {
    return {
      perProvider: settingValue(settings, 'model.perProvider'),
      maxTotal: settingValue(settings, 'model.maxTotal'),
    };
  }
  async function readProbeCache() {
    try {
      const saved = await io.readJson(files.modelProbes);
      if (saved && typeof saved === 'object') return saved;
    } catch { /* no cache yet */ }
    return null;
  }
  function cacheIsFresh(cached) {
    if (!cached || typeof cached.at !== 'string') return false;
    const t = Date.parse(cached.at);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t < MODEL_VERDICT_TTL_MS;
  }
  // 跑一轮哨兵探针。只读：不改任何插件配置、不动默认模型。
  async function runModelScan() {
    const catalog = await readCatalog();
    const settings = currentSettings();
    const plan = planSentinel(catalog, sentinelOptions(settings));
    const llm = getService(ctx, 'llm');
    // v0.9.8: was a strictly sequential loop. With 12 probes at a 45 s timeout the
    // worst case is 9 minutes, and a panel request that hangs that long is
    // indistinguishable from a dead plugin (measured: 115.6 s for one scan, 151.2 s
    // for a report with probeOnReport=always). Three at a time keeps the provider
    // side polite and cuts the wall clock roughly threefold.
    const PROBE_CONCURRENCY = 3;
    const probes = new Array(plan.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= plan.length) return;
        probes[i] = await probeModel({ llm }, { ...plan[i], timeoutMs: MODEL_PROBE_TIMEOUT_MS });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(PROBE_CONCURRENCY, plan.length)) }, worker));
    const prev = await readProbeCache();
    const summary = summarize(probes, prev && prev.summary ? prev.summary : null);
    const dv = defaultVerdict(probes, catalog.default);
    const prevBusy = prev && Number.isFinite(prev.defaultBusyRounds) ? prev.defaultBusyRounds : 0;
    // 连续「忙」的轮数：只有连续两轮都拿不到内容，才值得提示——
    // 一次 429 冷却就把默认模型报成故障，是制造噪音。
    const defaultBusyRounds = dv.state === 'busy' ? prevBusy + 1 : 0;
    const suggest = suggestDefault(probes, catalog.default);
    const payloadOut = { at: summary.at, verdicts: probes, summary, default: catalog.default, defaultVerdict: dv, defaultBusyRounds, suggest };
    try { await io.writeJson(files.modelProbes, payloadOut); } catch { /* cache is an optimization, never a requirement */ }
    return { ok: true, ...payloadOut, catalog };
  }
  // 报告里用的那份：按设置决定读缓存 / 真跑 / 跳过。异常一律降级为 null。
  async function modelHealthForReport() {
    try {
      const mode = settingValue(currentSettings(), 'model.probeOnReport');
      if (mode === 'off') return null;
      let cached = await readProbeCache();
      if (mode === 'always' || !cacheIsFresh(cached)) {
        const scanned = await runModelScan();
        cached = { at: scanned.at, verdicts: scanned.verdicts, summary: scanned.summary, default: scanned.default, defaultVerdict: scanned.defaultVerdict, defaultBusyRounds: scanned.defaultBusyRounds, suggest: scanned.suggest };
      }
      if (!cached) return null;
      // 目录一并带上：model-default 的 plan 要用它确认目标模型真的存在。
      // 它只是 listProviders/listModels，不花配额、不动任何状态。
      const catalog = await readCatalog();
      return {
        at: cached.at,
        catalog,
        default: cached.default || null,
        defaultVerdict: cached.defaultVerdict || { state: 'unprobed' },
        defaultBusyRounds: Number.isFinite(cached.defaultBusyRounds) ? cached.defaultBusyRounds : 0,
        suggest: cached.suggest || null,
        summary: cached.summary || null,
        fresh: cacheIsFresh(cached),
      };
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    }
  }

  async function run(action, payload) {
    if (action === 'ping') return { ok: true, plugin: name, version: pkgVersion(), readOnly: false, hub: true };
    // v0.8.0 settings: 只读设置页需要的一切（值 + 范围 + 为什么），以及一次写入。
    if (action === 'settings') {
      await loadSettings();
      return { ok: true, settings: currentSettings(), groups: describeSettings(currentSettings()), defaults: defaultSettings(), savedAt: settingsSavedAt };
    }
    if (action === 'settings-save') {
      await loadSettings();
      return await saveSettings(payload && payload.settings);
    }
    await ensureRestored();
    await loadSettings();
    if (action === 'report') {
      let acked = [];
      try { acked = (await io.readJson(files.acked)) || []; } catch { acked = []; }
      const knowledge = await loadKnowledge();
      // ④ v0.7.6 config drift: compare against the baseline recorded on the
      // previous scan, then renew it. The baseline is ours (data dir), never the
      // DSH config itself — the steward does not write cordis.patch.yml.
      let configBaseline = [];
      try {
        const saved = await io.readJson(files.configBaseline);
        if (saved && Array.isArray(saved.entries)) configBaseline = saved.entries;
      } catch { configBaseline = []; }
      // v0.7.8: a fixed threshold is not a detection. Load the previous report so
      // the workspace check can compare growth instead of an absolute size — the
      // same numbers that always fire on a machine that did not change. Only the
      // workspace block consumes it today; it is passed as a plain object so more
      // collectors can adopt it without another signature change.
      let previous = null;
      try {
        const saved = await io.readJson(files.lastReport);
        if (saved && saved.report && typeof saved.report === 'object') previous = saved.report;
      } catch { previous = null; }
      const modelHealth = await modelHealthForReport();
      lastReport = collectReport({ pluginChanges: changes.snapshot(), acked: Array.isArray(acked) ? acked : [], knowledge, configBaseline, previous, settings: currentSettings(), modelHealth });
      // Persist best-effort; a failed persist never fails the report itself.
      io.writeJson(files.lastReport, { report: lastReport }).catch(() => {});
      if (Array.isArray(lastReport.config) && lastReport.config.length > 0) {
        io.writeJson(files.configBaseline, { at: lastReport.generatedAt, entries: lastReport.config }).catch(() => {});
      }
      return { report: lastReport, text: renderReportText(lastReport) };
    }
    if (action === 'plan') return await hub.plan(payload.kind, payload);
    if (action === 'execute') {
      const out = await hub.execute(payload);
      if (out && out.ok === true && out.recorded) {
        // ③ keep the in-process recall log consistent with what was just written.
        const log = await loadKnowledge();
        log.push(out.recorded);
      }
      return out;
    }
    if (action === 'plans') return { ok: true, plans: hub.listPending() };
    // v0.6.0 L2: one sentence → one intent. Read-only w.r.t. the system: it
    // only decides WHICH card to open. Enriching the haystack (bundle list +
    // current findings) happens here, not in the pure parser.
    if (action === 'intent') {
      const text = typeof payload.text === 'string' ? payload.text : '';
      const bundles = [];
      try {
        const mgr = getService(ctx, 'pluginManager');
        if (mgr && typeof mgr.listBundles === 'function') {
          const list = await mgr.listBundles();
          for (const b of Array.isArray(list) ? list : []) {
            const n = b && (b.name || b.package);
            if (n) bundles.push({ name: n, enabled: b.enabled !== false });
          }
        }
      } catch { /* no bundle list → parser falls back to shape check */ }
      const out = parseIntent(text, { bundles, report: lastReport });
      return { ...out, text, bundlesKnown: bundles.length };
    }
    // v0.7.0: model-backed understanding. Read-only catalog for the picker; the
    // catalog is cached in-process because listModels may hit a provider.
    if (action === 'models') return await readCatalog();
    // v0.9.1: 面板要的模型健康快照（不跑探针，只回目录 + 计划 + 已有缓存）。
    if (action === 'model-now') {
      const catalog = await readCatalog();
      const settings = currentSettings();
      const plan = planSentinel(catalog, sentinelOptions(settings));
      const cached = await readProbeCache();
      const verdicts = cached && Array.isArray(cached.verdicts) ? cached.verdicts : [];
      return {
        ok: true,
        catalog, plan, verdicts,
        fresh: cacheIsFresh(cached),
        at: cached && cached.at ? cached.at : null,
        summary: cached && cached.summary ? cached.summary : null,
        default: catalog.default,
        defaultVerdict: cached && cached.defaultVerdict ? cached.defaultVerdict : defaultVerdict(verdicts, catalog.default),
        defaultBusyRounds: cached && Number.isFinite(cached.defaultBusyRounds) ? cached.defaultBusyRounds : 0,
        suggest: cached && cached.suggest ? cached.suggest : null,
        probeOnReport: settingValue(settings, 'model.probeOnReport'),
      };
    }
    // 真跑一轮哨兵探针并写缓存。这是一次性动作，不改任何插件配置。
    if (action === 'model-scan') return await runModelScan();
    // One sentence through the chosen model. The model only TRANSLATES: its
    // answer is normalized back into the same intent shape the rule parser
    // returns, so the caller walks the identical plan→confirm→audit chain.
    // A model that is unreachable or answers rubbish never becomes an action.
    if (action === 'ask') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) return { ok: false, code: 'empty', error: '先输入一句话。' };
      const bundles = [];
      try {
        const mgr = getService(ctx, 'pluginManager');
        if (mgr && typeof mgr.listBundles === 'function') {
          const list = await mgr.listBundles();
          for (const b of Array.isArray(list) ? list : []) {
            const n = b && (b.name || b.package);
            if (n) bundles.push({ name: n, enabled: b.enabled !== false });
          }
        }
      } catch { /* an unknown bundle list only narrows what the model may name */ }
      try {
        const raw = await runModel({ llm: getService(ctx, 'llm') }, {
          provider: payload.provider,
          model: payload.model,
          prompt: text,
          signal: AbortSignal.timeout(60_000),
        });
        const out = normalizeBrainOutput(raw.text, { bundles, report: lastReport });
        return { ...out, text, bundlesKnown: bundles.length, modelChars: raw.text.length };
      } catch (e) {
        const code = e && e.code ? e.code : 'llm-failed';
        return { ok: false, code, error: e && e.message ? e.message : String(e) };
      }
    }
    // v0.4.4: read-only view of bundle enable state, so the enable card can offer
    // real candidates (currently-disabled bundles) instead of guessing from a
    // crash suspect list. Zero writes; missing service → degraded, never throws.
    if (action === 'bundles') {
      const out = { ok: true, disabled: [], enabled: [], available: false };
      try {
        const mgr = getService(ctx, 'pluginManager');
        if (mgr && typeof mgr.listBundles === 'function') {
          const list = await mgr.listBundles();
          for (const b of Array.isArray(list) ? list : []) {
            const n = b && (b.name || b.package);
            if (!n) continue;
            if (b.enabled === false) out.disabled.push(n); else out.enabled.push(n);
          }
          out.available = true;
        }
      } catch (e) {
        out.ok = false;
        out.error = e && e.message ? e.message : String(e);
      }
      return out;
    }
    if (action === 'audit') {
      let auditLines = [];
      try {
        const raw = await fsp.readFile(files.audit, 'utf8');
        const all = raw.split('\n').filter(Boolean).slice(-20);
        for (const line of all) {
          try { auditLines.push(JSON.parse(line)); } catch { auditLines.push({ raw: line.slice(0, 200) }); }
        }
      } catch { auditLines = []; }
      let trend = [];
      try { const t = await io.readJson(files.trend); if (Array.isArray(t)) trend = t.slice(-20); } catch { trend = []; }
      return { ok: true, audit: auditLines, trend };
    }
    return { ok: false, error: `unknown action: ${String(action)}` };
  }

  // 1) Event subscription — best-effort, never throws, no disk IO in the callback.
  try {
    ctx.effect(() => {
      try {
        if (typeof ctx.on === 'function') return ctx.on('plugin-manager/changed', (payload) => changes.push(payload));
      } catch { /* event bus unavailable */ }
      return undefined;
    }, 'dsh-steward: events');
  } catch { /* effect registration failed — ignore */ }

  // 1b) v0.4 proactive exit, part 1: one lightweight checkup shortly after boot,
  // so the FIRST session and the FIRST panel open already have a fresh report —
  // without waiting for a human to ask. Read-only, fail-soft, never throws.
  try {
    const bootTimer = setTimeout(() => {
      run('report', {}).catch(() => {});
    }, 45_000);
    if (typeof bootTimer.unref === 'function') bootTimer.unref();
  } catch { /* timer unavailable */ }

  // 1c) v0.4 proactive exit, part 2: systemPrompt.section — PROVEN shape from
  // @changfenhuang/dsh-genui/lib/index.js:7772 ({name, order, text}, order via
  // getSectionOrder). Guarded: if the service or getSectionOrder is missing we
  // skip entirely (探针先行 red line: never guess, never endanger boot).
  try {
    const sp = getService(ctx, 'systemPrompt');
    if (sp && typeof sp.section === 'function' && typeof sp.getSectionOrder === 'function') {
      ctx.effect(() => {
        try {
          return sp.section({
            name: 'dsh-steward:guardian',
            order: sp.getSectionOrder('STRUCTURED_OUTPUT'),
            text: 'DSH steward plugin is active. When the user reports the app crashed / failed to boot / a plugin broke, call dsh_steward_report (read-only) FIRST and follow its named suspect instead of guessing. Authorized fixes go through dsh_steward_act: plan first, then execute with planHash + confirm:true. For encrypted backups (kind=backup) NEVER ask for or type the password into chat — the user must enter it in the steward panel themselves.',
          });
        } catch (e) {
          try { if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-steward] systemPrompt section skipped: ' + String(e && e.message || e)); } catch { /* noop */ }
          return undefined;
        }
      }, 'dsh-steward: prompt section');
    }
  } catch { /* systemPrompt lookup failed — passive mode, panel red dot only */ }

  // 2) Host prefix route (panel + same-origin callers).
  try {
    const webServer = getService(ctx, 'webServer');
    if (webServer && typeof webServer.register === 'function') {
      ctx.effect(() => {
        try {
          return webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            handler: async (req, res) => {
              if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
              if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden origin' }); return; }
              try {
                const body = await readBody(req);
                if (!body.parsed) { sendJson(res, 400, { ok: false, error: 'bad request body: ' + body.reason }); return; }
                const payload = body.value;
                const action = typeof payload.action === 'string' ? payload.action : '';
                // No default action: an omitted action is a caller mistake, not a
                // request for a full scan.
                if (action === '') { sendJson(res, 400, { ok: false, error: 'missing action (send {"action":"report"} to run a checkup)' }); return; }
                const result = await run(action, payload);
                sendJson(res, 200, { ok: result.ok !== false, ...result });
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          });
        } catch (e) {
          // Contained: a route registration failure must NOT fail the boot fiber.
          try { if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-steward] route registration skipped: ' + String(e && e.message || e)); } catch { /* noop */ }
          return undefined;
        }
      }, 'dsh-steward: routes');
    }
  } catch { /* webServer lookup failed — ignore */ }

  // 3) Read-only health tool (kept from v0.1).
  try {
    const tools = getService(ctx, 'tools');
    if (tools && typeof tools.register === 'function') {
      ctx.effect(() => {
        try {
          return tools.register({
            name: 'dsh_steward_report',
            description: 'Read-only DeepSeek Harness health check. Diagnoses the last web-boot crash (names the suspect plugin), flags cordis.patch.yml .bak backups and recent plugin changes, and points at existing backup/disk/knowledge capabilities. Never deletes, never runs elevated commands, never touches the boot path.',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['report', 'ping'], description: 'report (default) returns the full health report; ping is a liveness probe.' },
              },
              required: [],
              additionalProperties: false,
            },
            output: {
              schema: { type: 'string' },
              render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
            },
            timeoutMs: 30_000,
            isConcurrencySafe: () => true,
            presentCall: (args) => ({ card: 'generic', title: '智能管家 · 体检', kind: 'dsh-steward', rawInput: args }),
            async execute(args) {
              const action = args && typeof args.action === 'string' ? args.action : 'report';
              const result = await run(action, {});
              return result.text || JSON.stringify(result, null, 2);
            },
          });
        } catch (e) {
          try { if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-steward] tool registration skipped: ' + String(e && e.message || e)); } catch { /* noop */ }
          return undefined;
        }
      }, 'dsh-steward: tool');

      // 4) v0.2 action tool — plan is zero-write; execute needs confirm + fingerprint.
      ctx.effect(() => {
        try {
          return tools.register({
            name: 'dsh_steward_act',
            description: 'Authorized steward actions (plan first, then execute with the returned planHash + confirm:true). Kinds: "clean" (safe-level rebuildable caches via dsh-disk-cleaner; withCaution=true also includes caution-level targets), "backup" (encrypted DCA1 export of volatile data: sessions/pluginData/pluginAssets via config-manager; the password must NOT be typed in chat — ask the user to run this card in the steward panel), "disable" (stop the plugin named by the CURRENT boot-crash evidence; attribution gate refuses stale crashes; reversible, protected by the host #575 enable guard), "enable" (its counterpart: re-enable a bundle by name), "knowledge" (append this checkup to the local trend log of the steward), "ack"/"unack" (mute or unmute a report finding by id; reversible, evidence kept), "model-default" (switch the default model of the host to provider/model — only that one selection changes, no plugin config is touched, fully reversible). Never touches the boot path, never runs elevated commands, never restores whole old configs, never edits the settings of another plugin.',
            parameters: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['plan', 'execute', 'plans'], description: 'plan = zero-write preview; execute = needs planHash + confirm:true; plans = list pending.' },
                kind: { type: 'string', enum: ['clean', 'backup', 'disable', 'enable', 'knowledge', 'ack', 'unack', 'model-default'], description: 'which action to plan (required for action=plan).' },
                plugin: { type: 'string', description: 'for kind=disable/enable: exact bundle package name (for disable it must be the suspect named by the current boot-crash finding).' },
                withCaution: { type: 'boolean', description: 'for kind=clean: also include caution-level targets (may be in-use data; defaults false).' },
                id: { type: 'string', description: 'for kind=ack/unack: the finding id from the last report.' },
                provider: { type: 'string', description: 'for kind=model-default: LLM provider id (e.g. "our-free-model").' },
                model: { type: 'string', description: 'for kind=model-default: model id within that provider.' },
                only: { type: 'array', items: { type: 'string' }, description: 'for kind=backup: sections to include; default ["sessions","pluginData","pluginAssets"].' },
                planHash: { type: 'string', description: 'for action=execute: the hash returned by the matching plan.' },
                confirm: { type: 'boolean', description: 'for action=execute: must be true (the authorization gate).' },
              },
              required: ['action'],
              additionalProperties: false,
            },
            output: {
              schema: { type: 'string' },
              render: (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
            },
            timeoutMs: 180_000,
            isConcurrencySafe: () => false,
            presentCall: (args) => ({ card: 'generic', title: `智能管家 · 动作 ${String((args && args.kind) || (args && args.action) || '')}`, kind: 'dsh-steward', rawInput: args }),
            async execute(args) {
              const result = await run(args && args.action, args || {});
              return JSON.stringify(result, null, 2);
            },
          });
        } catch (e) {
          try { if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('[dsh-steward] act tool registration skipped: ' + String(e && e.message || e)); } catch { /* noop */ }
          return undefined;
        }
      }, 'dsh-steward: act tool');
    }
  } catch { /* tools lookup failed — ignore */ }
}

export default apply;
