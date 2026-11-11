/**
 * dsh-steward · v0.2.2 action hub — plan / execute, single-use fingerprint,
 * human-readable previews, attribution gate, mute (ack) store.
 *
 * Authorization model (user-approved, m01226/m01239):
 *  - `plan` is ZERO-WRITE (writes never happen here; read-only IO is allowed).
 *    The result carries a sha256[:16] fingerprint of its canonical form.
 *  - `execute` refuses anything without confirm:true AND a live plan hash.
 *    The pending plan is consumed BEFORE the effect runs — a hash is single-use,
 *    failures never become replays.
 *  - Every execute attempt (success or failure) is appended to an audit line.
 *    Passwords are NEVER persisted, logged, or echoed anywhere.
 *
 * v0.2.2 additions (m01541 gaps + m01550/m01557 human-first rendering):
 *  - Every plan and every executed result carries `human`: server-computed
 *    plain-language lines. The GUI renders ONLY these — raw JSON never reaches
 *    the user ("智能管家是用户和系统的桥梁，GUI 是给人看的").
 *  - Attribution gate: `disable` must be backed by a CURRENT (non-stale)
 *    boot-crash evidence that names that exact plugin as a suspect.
 *  - Counterparts: `enable` (undo disable), `ack`/`unack` (mute a finding in
 *    the report display; reversible; the underlying evidence is kept).
 * Red lines unchanged: never touches the boot path, never runs elevated
 * commands, never whole-restore of old configs.
 */
import { createHash, scrypt as scryptCb, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { ackTtlDays as settingsAckTtl } from './settings.js';

const scryptAsync = promisify(scryptCb);

// DCA1 container verification (v0.3.1 ①). Format re-derived from observed
// bytes (encryption.js constants): header = 4 magic + 1 version + 16 salt +
// 12 iv + 16 authTag; body = AES-256-GCM ciphertext. Implemented locally with
// node:crypto — NO import from dsh-config-manager (red line: no cross-package
// coupling that could drift with host updates).
const DCA1_MAGIC = 'DCA1';
// Header layout (re-derived from security/encryption.js):
//   0..4 magic · 4 version · 5..21 salt(16) · 21..33 iv(12) · 33..49 authTag(16)
// HEADER_LENGTH = 4 + 1 + 16 + 12 + 16 = 49. Body ciphertext starts at 49.
const DCA1_HEADER = 49;
async function verifyDca1Blob(bytes, password) {
  if (!bytes || bytes.length < DCA1_HEADER) return { ok: false, reason: '文件太小，不是完整容器' };
  if (bytes.subarray(0, 4).toString('latin1') !== DCA1_MAGIC) return { ok: false, reason: '容器头不是 DCA1（可能不是加密档）' };
  if (bytes[4] !== 1) return { ok: false, reason: '容器版本 ' + bytes[4] + ' 不受校验' };
  const salt = bytes.subarray(5, 21);
  const iv = bytes.subarray(21, 33);
  const tag = bytes.subarray(33, 49);
  const body = bytes.subarray(49);
  let key;
  try {
    key = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  } catch (e) { return { ok: false, reason: '口令派生失败：' + String(e && e.message || e) }; }
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(body), d.final()]);
    return { ok: true, isZip: plain.subarray(0, 2).toString('latin1') === 'PK', plainBytes: plain.length };
  } catch { return { ok: false, reason: 'GCM 校验未通过：口令不匹配或文件被篡改' }; }
}

const PENDING_LIMIT = 20;

export const BACKUP_SECTIONS = ['sessions', 'pluginData', 'pluginAssets'];

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hashPlan(action, plan) {
  return createHash('sha256').update(action + '|' + canonical(plan)).digest('hex').slice(0, 16);
}

function mb(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** Human sentence explaining how long a mute will last. Pure. */
function ackTtlLine(id, settings) {
  const days = settingsAckTtl(settings, id);
  return '有效期限：' + days + ' 天后会自动重新提醒（静音只代表「此刻我知道」，不代表「永远别再说」）。可在面板「设置」里改。';
}

async function readAcked(deps) {
  let list = [];
  try { list = (await deps.io.readJson(deps.ackedFile)) || []; } catch { list = []; }
  if (!Array.isArray(list)) return [];
  // ⑥ v0.7.7 mute expiry: an ack says "I know about this right now", not
  // "never tell me again". Entries carrying an expiresAt drop out once it
  // passes, so a condition the user silenced months ago can come back if it
  // is still true. Entries without expiresAt keep the old permanent behaviour.
  const nowMs = Date.now();
  return list.filter((a) => {
    if (!a || typeof a !== 'object') return false;
    if (!a.expiresAt) return true;
    const t = Date.parse(a.expiresAt);
    if (!isFinite(t)) return true;
    return t > nowMs;
  });
}

/** v0.9.15: 'this judgement was wrong' is distinct from 'I know, be quiet'.
 * Entries are permanent until explicitly undone; expiry would silently
 * re-arm a finding the user already told us was a false positive. */
async function readFeedback(deps) {
  let list = [];
  try { list = (await deps.io.readJson(deps.feedbackFile)) || []; } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a === 'object' && typeof a.id === 'string');
}

/** Default mute duration per finding id — a mutable condition gets a shorter
 * leash than a structural one. These are FALLBACKS only: v0.8.0 起真正的值来自
 * 用户设置（settings.ttl.<id> → settings.ttl.default），这里只作为 settings.js
 * 默认值的一份镜像，防止旧调用方拿到 undefined。 */
const ACK_TTL_DAYS = {
  'data-at-risk': 42,      // the gap is structural; re-ask every ~6 weeks
  'compat-check': 30,      // becomes true again right after a host upgrade
  'plugin-updates': 14,    // new versions land constantly; short leash
  'workspace-inventory': 30,
  'backup-freshness': 7,   // the whole point is freshness; never long
};
const ACK_TTL_DEFAULT_DAYS = 90;

/** 取当前设置；deps.getSettings 缺失时回落空对象（= 全默认）。 */
function currentSettings(deps) {
  try {
    return typeof deps.getSettings === 'function' ? deps.getSettings() : null;
  } catch { return null; }
}

/**
 * deps:
 *  - routeFetch(path, body): loopback POST to another plugin's host route.
 *  - getPluginManager(): service or null (ctx.get('pluginManager'), inject-free).
 *  - getReport(): () => last collectReport() result (evidence for gates/knowledge).
 *  - io: { appendJsonl, readJson, writeJson, readBytes?, readText?, writeText? } — injectable for smoke.
 *    readText/writeText are optional: their only consumer is trimming over-long
 *    jsonl logs, and a caller without them simply keeps appending.
 *  - readBytes(file): Buffer|string — used ONLY to verify a freshly written
 *    DCA1 container in-request; never persisted, never logged.
 *  - now(): () => Date
 *  - auditFile / trendFile / knowledgeFile / ackedFile / feedbackFile: paths under plugin data dir.
 */
export function createActionHub(deps) {
  const pending = new Map(); // hash -> { kind, plan, createdAt }

  function remember(hash, entry) {
    pending.set(hash, entry);
    if (pending.size > PENDING_LIMIT) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
  }

  // v0.9.8: trend.json already capped itself at 400 rows; the two append-only jsonl
  // logs did not, so "same kind of file, two sets of rules". The cap is generous —
  // a row is ~200 B, so 2000 rows is still well under half a megabyte — but an
  // unbounded audit trail is a growth bug even when it grows slowly.
  const LOG_LINE_CAP = 2000;
  async function trimJsonl(file) {
    try {
      if (typeof deps.io.writeText !== 'function' || typeof deps.io.readText !== 'function') return;
      const text = await deps.io.readText(file);
      if (typeof text !== 'string') return;
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      if (lines.length <= LOG_LINE_CAP) return;
      await deps.io.writeText(file, lines.slice(-LOG_LINE_CAP).join('\n') + '\n');
    } catch { /* trimming is housekeeping: never let it break the record that just landed */ }
  }
  async function audit(record) {
    try {
      await deps.io.appendJsonl(deps.auditFile, { at: deps.now().toISOString(), ...record });
      await trimJsonl(deps.auditFile);
    } catch { /* audit failure must not mask the action result */ }
  }

  // ---------- PLAN (zero-write) ----------
  async function plan(kind, params = {}) {
    try {
      if (kind === 'clean') {
        const data = await deps.routeFetch('/api/disk-cleaner/', { action: 'scan' });
        const all = Array.isArray(data.targets) ? data.targets : [];
        const safe = all.filter((t) => t.risk === 'safe');
        const caution = all.filter((t) => t.risk === 'caution');
        const withCaution = params.withCaution === true;
        const selected = withCaution ? [...safe, ...caution] : safe;
        if (!selected.length) return { ok: false, error: withCaution ? 'disk-cleaner 没有报出任何目标。' : 'disk-cleaner 未报出 safe 级目标，无可清理项。' };
        const ids = selected.map((t) => t.id);
        const totalBytes = selected.reduce((s, t) => s + Number(t.bytes || 0), 0);
        const p = {
          kind: 'clean', ids, totalBytes, withCaution,
          humanTotal: mb(totalBytes),
          human: [
            `清理 ${selected.length} 个目标，预计回收约 ${mb(totalBytes)}。`,
            '明细：' + selected.map((t) => `${t.id} ≈ ${mb(t.bytes)}`).join('；') + '。',
            withCaution
              ? '范围含「谨慎级」目标（caution，可能是仍在使用的数据）——请核对明细后再执行。'
              : '范围仅「安全级」缓存：删后可自动重建，不含谨慎项。',
          ],
          note: withCaution ? 'safe + 用户显式勾选的 caution 项。' : '仅 safe 级纯缓存，删后可重建。',
        };
        const hash = hashPlan('clean', p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'backup') {
        const only = Array.isArray(params.only) && params.only.length ? params.only : BACKUP_SECTIONS;
        const prev = await deps.routeFetch('/api/dsh-config-manager/export-preview', { only, includeSecrets: false });
        const sections = Array.isArray(prev.sections) ? prev.sections : [];
        const sizeBytes = sections.reduce((s, x) => s + Number(x.sizeBytes || 0), 0);
        const p = {
          kind: 'backup', only: sections.map((s) => s.section), itemTotals: sections.map((s) => ({ section: s.section, sizeBytes: s.sizeBytes })),
          humanTotal: mb(sizeBytes),
          human: [
            `加密备份 ${sections.length} 个分区，共约 ${mb(sizeBytes)}。`,
            '分区：' + sections.map((s) => `${s.section} ≈ ${mb(s.sizeBytes)}`).join('；') + '。',
            '产物：exports/ 目录下一份 DCA1 加密档（AES-256-GCM）。',
            '口令只在执行那一次请求中出现，不落盘、不进审计、不回显；丢了口令档案无法恢复。',
          ],
          note: '真 DCA1 加密导出；这些分区不在任何自动备份里。',
        };
        const hash = hashPlan('backup', p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'disable' || kind === 'enable') {
        const plugin = typeof params.plugin === 'string' ? params.plugin.trim() : '';
        if (!plugin) return { ok: false, error: `需要 plugin 名（bundle 包名）。` };
        if (kind === 'disable') {
          const report = typeof deps.getReport === 'function' ? deps.getReport() : null;
          if (!report || !Array.isArray(report.findings)) return { ok: false, error: '还没有体检报告——停用插件需要现行崩溃证据，先做一次体检。' };
        if (report.staleAfterRestart) return { ok: false, error: '归因门拒绝：这是重启前持久化的历史报告，不能作现行崩溃证据。先点「重新体检」生成当前报告。' };
          const crash = report.findings.find((f) => f.id === 'boot-crash-latest');
          if (!crash) return { ok: false, error: '当前报告里没有启动崩溃记录，停用动作无的放矢。' };
          if (crash.data && crash.data.stale) return { ok: false, error: '归因门拒绝：那条崩溃早于当前实例启动（历史记录，当前启动正常）。没有现行崩溃就不该停用插件。' };
          const suspects = crash.data && Array.isArray(crash.data.suspects) ? crash.data.suspects.filter(Boolean) : [];
          if (!suspects.includes(plugin)) return { ok: false, error: `"${plugin}" 不在最近一次崩溃点名的疑似列表${suspects.length ? `（${suspects.join('、')}）` : '（无点名项）'}。` };
        }
        const mgr = deps.getPluginManager();
        if (!mgr || typeof mgr.setBundleEnabled !== 'function') return { ok: false, error: 'pluginManager 服务不可用（降级：只能建议，不能执行）。' };
        let exists = false; let enabled = null;
        const disabledBundles = [];
        try {
          if (typeof mgr.listBundles === 'function') {
            const list = await mgr.listBundles();
            const arr = Array.isArray(list) ? list : [];
            for (const b of arr) {
              const n = b && (b.name || b.package);
              if (n && b.enabled === false) disabledBundles.push(n);
            }
            const hit = arr.find((b) => b.name === plugin || b.package === plugin);
            exists = hit !== undefined;
            if (hit && typeof hit.enabled === 'boolean') enabled = hit.enabled;
          }
        } catch { /* listing optional — execute path still guarded by the service itself */ }
        if (!exists) return { ok: false, error: `bundle "${plugin}" 不在当前 profile。` };
        if (kind === 'disable' && enabled === false) return { ok: false, error: `bundle "${plugin}" 已是停用状态。` };
        if (kind === 'enable' && enabled === true) {
          // v0.4.4: 说清「为什么这次没用」而不只是拒绝。启用只对已停用的插件有意义。
          // 候选可能很多（官方默认停用的 bundle 有十几个），列前 6 个 + 总数即可。
          const head = disabledBundles.slice(0, 6).join('、');
          const tail = disabledBundles.length > 6 ? ` 等 ${disabledBundles.length} 个` : '';
          return {
            ok: false,
            disabled: disabledBundles,
            error: disabledBundles.length
              ? `bundle "${plugin}" 现在是启用状态——启用动作只对「已停用」的插件有意义。当前已停用、可以启用的有：${head}${tail}。`
              : `bundle "${plugin}" 现在是启用状态——启用动作只对「已停用」的插件有意义。当前没有任何已停用的插件，所以这个动作暂时无可对象。`,
          };
        }
        const p = kind === 'disable' ? {
          kind, plugin,
          human: [
            `停用插件「${plugin}」。`,
            '依据：最近一次启动崩溃点名的疑似插件（首个失败会连坐其余，优先处理被点名的）。',
            '保护：宿主 #575 守卫——状态变更失败不会写入启动配置，不会引发启动循环。',
            '可逆：随时可重新启用（本卡片的反向动作，或 Agent 工具 kind=enable）。',
          ],
          note: '经 pluginManager.setBundleEnabled(false)，可逆。',
        } : {
          kind, plugin,
          human: [
            `重新启用插件「${plugin}」。`,
            '依据：该 bundle 当前 enabled=false（启用动作只对已停用的插件有意义）。',
            '保护：同 #575 守卫——若它在导入期就会崩溃，宿主会拒绝持久化启用，不会拖垮界面。',
            '可逆：随时可再停用（本卡片的反向动作，或 Agent 工具 kind=disable）。',
          ],
          note: '经 pluginManager.setBundleEnabled(true)。',
        };
        const hash = hashPlan(kind, p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'knowledge') {
        const report = typeof deps.getReport === 'function' ? deps.getReport() : null;
        if (!report || !report.summary) return { ok: false, error: '还没有体检报告，先做一次体检。' };
        const c = report.summary.counts || {};
        const activeIds = Array.isArray(report.findings)
          ? report.findings.filter((f) => !f.muted && f.severity !== 'info').map((f) => f.id) : [];
        const p = {
          kind: 'knowledge',
          headline: report.summary.headline,
          counts: c,
          cFreeBytes: typeof report.cFreeBytes === 'number' ? report.cFreeBytes : null,
          findingIds: activeIds,
          human: [
            `记录本次体检结论：${report.summary.headline}。`,
            `计数：严重 ${c.critical || 0} · 留意 ${c.warning || 0} · 提示 ${c.info || 0}。`,
            typeof report.cFreeBytes === 'number' ? `系统盘剩余空间快照：${mb(report.cFreeBytes)}（趋势里可看变化）。` : '系统盘剩余空间：本次未读到（不影响记录）。',
            '指纹条目：' + (activeIds.length ? activeIds.join('、') : '（无现行风险项）') + '——同类问题下次体检时会自动召回这条记录。',
            '去向：管家本地知识/趋势日志（只增不改）。Mnemon 项目知识库写入仍由 Agent 经你确认。',
          ],
          note: '追加到本地 knowledge/trend 存储（只增不改）。',
        };
        const hash = hashPlan('knowledge', p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'ack' || kind === 'unack') {
        const report = typeof deps.getReport === 'function' ? deps.getReport() : null;
        const id = typeof params.id === 'string' ? params.id.trim() : '';
        if (!report || !Array.isArray(report.findings)) return { ok: false, error: '还没有体检报告——先做一次体检。' };
        if (!id) return { ok: false, error: '需要 finding id（报告条目的编号）。' };
        const f = report.findings.find((x) => x.id === id);
        if (!f) return { ok: false, error: `报告里没有编号 "${id}" 的条目。` };
        const list = await readAcked(deps);
        const isAcked = list.some((a) => a && a.id === id);
        if (kind === 'ack' && isAcked) return { ok: false, error: `「${f.title}」已经处于静音状态。` };
        if (kind === 'unack' && !isAcked) return { ok: false, error: `「${f.title}」没有被静音过。` };
        const p = {
          kind, findingId: id, title: f.title,
          human: kind === 'ack'
            ? [`静音报告条目：「${f.title}」。`,
               '效果：从下次体检起不再计入风险计数；证据本身保留在报告里，随时可恢复显示。',
               ackTtlLine(id, currentSettings(deps))]
            : [`恢复显示：「${f.title}」。`],
        };
        const hash = hashPlan(kind, p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'feedback' || kind === 'unfeedback') {
        const report = typeof deps.getReport === 'function' ? deps.getReport() : null;
        const id = typeof params.id === 'string' ? params.id.trim() : '';
        if (!report || !Array.isArray(report.findings)) return { ok: false, error: '还没有体检报告——先做一次体检。' };
        if (!id) return { ok: false, error: '需要 finding id（报告条目的编号）。' };
        const f = report.findings.find((x) => x.id === id);
        if (!f) return { ok: false, error: `报告里没有编号 "${id}" 的条目。` };
        const list = await readFeedback(deps);
        const marked = list.some((a) => a.id === id);
        if (kind === 'feedback' && marked) return { ok: false, error: `「${f.title}」已经标记为判错了。` };
        if (kind === 'unfeedback' && !marked) return { ok: false, error: `「${f.title}」没有被标记为判错。` };
        const p = {
          kind, findingId: id, title: f.title,
          human: kind === 'feedback'
            ? [`把「${f.title}」标记为这条判错了。`,
               '效果：从下次体检起这条不再计直达处置、重要性分数降 40，但证据仍然保留，随时可撤销。',
               '这只是告诉管家「这次的判断不准」，不会改动任何系统状态。']
            : [`撤销「${f.title}」的判错标记，恢复它的正常评分。`],
        };
        const hash = hashPlan(kind, p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      if (kind === 'model-default') {
        // 只改「默认模型是哪一个」这一项选择，不碰任何插件的配置。
        // 这是三个模型类动作里唯一会写宿主状态的，所以它必须有 plan 与指纹。
        const provider = typeof params.provider === 'string' ? params.provider.trim() : '';
        const model = typeof params.model === 'string' ? params.model.trim() : '';
        if (!provider || !model) return { ok: false, error: '需要 provider 与 model（可以点报告里推荐的「切到这个模型」）。' };
        const sel = typeof deps.getDefaultModel === 'function' ? deps.getDefaultModel() : null;
        if (!sel || typeof sel.saveSelection !== 'function') {
          return { ok: false, error: 'agentDefaultModel 服务不可用（降级：只能看，不能改默认模型）。' };
        }
        let current = null;
        try {
          const cur = typeof sel.currentSelection === 'function' ? sel.currentSelection() : null;
          if (cur && cur.provider && cur.model) current = { provider: String(cur.provider), model: String(cur.model) };
        } catch { current = null; }
        if (current && current.provider === provider && current.model === model) {
          return { ok: false, error: `默认模型已经是 ${provider} / ${model} 了。` };
        }
        // 目标必须真实存在于目录里：拒绝把一个不存在的名字写进宿主选择。
        let known = false;
        try {
          const report = typeof deps.getReport === 'function' ? deps.getReport() : null;
          const health = report && report.modelHealth ? report.modelHealth : null;
          const catalog = health && health.catalog;
          const providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
          for (const pv of providers) {
            if (pv.id !== provider) continue;
            if ((pv.models || []).some((m) => m.id === model)) known = true;
          }
        } catch { known = false; }
        const from = current ? current.provider + ' / ' + current.model : '（当前未设置）';
        const p = {
          kind: 'model-default', provider, model, from,
          human: [
            `把默认模型从 ${from} 换成 ${provider} / ${model}。`,
            '影响范围：只改宿主记住的「默认模型」这一项，不动任何插件的配置、不禁用任何模型、也不改选择器里列出的清单。',
            '可逆：换过去之后随时可以再换回来（再点一次就会给出反向计划）。',
            known ? '依据：这个模型在当前模型目录里存在。' : '注意：这次没能从模型目录确认它存在（目录可能没读到），执行前请确认名字没写错。',
          ],
        };
        const hash = hashPlan('model-default', p);
        remember(hash, { kind, plan: p, createdAt: deps.now().toISOString() });
        return { ok: true, planHash: hash, plan: p };
      }
      return { ok: false, error: `unknown plan kind: ${String(kind)}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ---------- EXECUTE (single-use fingerprint) ----------
  async function execute(input = {}) {
    const hash = typeof input.planHash === 'string' ? input.planHash : '';
    const entry = hash ? pending.get(hash) : undefined;
    if (!entry) { await audit({ op: 'execute', hash, ok: false, error: 'unknown-or-expired-plan' }); return { ok: false, error: '计划不存在或已过期——先重新 plan。' }; }
    if (input.confirm !== true) { await audit({ op: 'execute', hash, kind: entry.kind, ok: false, error: 'confirm-missing' }); return { ok: false, error: '必须 confirm:true（授权门）。' }; }
    pending.delete(hash); // single-use BEFORE the effect: no replay even on failure

    let result;
    try {
      if (entry.kind === 'clean') {
        const data = await deps.routeFetch('/api/disk-cleaner/', { action: 'clean', ids: entry.plan.ids, confirm: true });
        const rows = Array.isArray(data.results) ? data.results : [];
        const freedBytes = rows.reduce((s, r) => s + Number(r.bytes || 0), 0);
        const removedFiles = rows.reduce((s, r) => s + Number(r.removed || 0), 0);
        const failedFiles = rows.reduce((s, r) => s + Number(r.failed || 0), 0);
        result = {
          ok: true, dryRun: data.dryRun === true, freedBytes, humanFreed: mb(freedBytes), removedFiles, failedFiles, targets: rows.map((r) => r.id), plan: entry.plan,
          human: [
            data.dryRun === true ? '演练模式：未实际删除。' : `已回收约 ${mb(freedBytes)}。`,
            `删除 ${removedFiles} 个文件${failedFiles ? `，失败 ${failedFiles} 个（被占用，稍后可重试）` : '，无失败'}。`,
          ],
        };
      } else if (entry.kind === 'backup') {
        const password = typeof input.password === 'string' && input.password !== '' ? input.password : '';
        if (!password) { pending.set(hash, entry); return { ok: false, error: '加密备份需要密码（本次请求内提供，不落盘）。计划已保留，可直接重试。' }; }
        const data = await deps.routeFetch('/api/dsh-config-manager/export', { only: entry.plan.only, includeSecrets: false, password, note: 'steward: volatile data baseline' }, { requireOk: false });
        // requireOk:false 是必需的（真机成功返回 {zipPath,manifest,report,runId}，不带 ok 字段），
        // 但它也放行了「200 + 异常体」。没有 zipPath 就证明没有档案落盘，绝不能报「已生成」。
        // 一律抛给下方 catch 统一记审计、由客户端渲染，不在这里伪造成功人话。
        if (!data || data.ok === false || typeof data.zipPath !== 'string' || !data.zipPath) {
          throw new Error((data && (data.error || data.message)) || '导出接口未返回备份文件路径，未生成加密备份。');
        }
        const zipPath = typeof data.zipPath === 'string' ? data.zipPath : null;
        const file = zipPath ? zipPath.split(/[\\/]/).pop() : null;
        // ① v0.3.1 execute-then-verify: read the container back and decrypt-check
        // it in-request (password never leaves this scope). A failed verification
        // does NOT fail the backup — the file exists — it warns honestly.
        let verify = { ok: false, reason: '未校验（文件路径未返回或读文件能力不可用）' };
        if (zipPath && typeof deps.io.readBytes === 'function') {
          try { verify = await verifyDca1Blob(await deps.io.readBytes(zipPath), password); }
          catch (e) { verify = { ok: false, reason: '校验读取失败：' + String(e && e.message || e) }; }
        }
        result = {
          ok: true, file, sections: entry.plan.only, encrypted: true, verified: verify.ok === true, verifyReason: verify.ok ? undefined : verify.reason, manifestSize: data.manifest ? Object.keys(data.manifest).length : null, plan: entry.plan,
          human: [
            file ? `已生成加密备份：${file}` : '已生成加密备份（文件名未返回）。',
            verify.ok
              ? '已当场回读校验：DCA1 容器头正确、口令可解开、' + (verify.isZip ? '内层 ZIP 结构完整' : '内层不是 ZIP（异常，请核对文件）') + `（解密后约 ${mb(verify.plainBytes)}）。`
              : '⚠ 未能完成回读校验：' + (verify.reason || '原因未知') + '。文件已生成，但无法确认换口令后可恢复。',
            `分区：${entry.plan.only.join('、')}。口令只在刚才那一次请求里存在过。`,
            '恢复：GUI 导入向导 + 你设的口令；口令丢失无法恢复，请自己保管好。',
          ],
        };
      } else if (entry.kind === 'disable' || entry.kind === 'enable') {
        const target = entry.kind === 'enable';
        const mgr = deps.getPluginManager();
        if (!mgr || typeof mgr.setBundleEnabled !== 'function') { result = { ok: false, error: 'pluginManager 服务不可用。' }; }
        else {
          const cr = await mgr.setBundleEnabled(entry.plan.plugin, target);
          const app = cr && cr.application;
          result = (app === 'applied' || app === 'restart-required' || app === 'overridden')
            ? {
                ok: true, application: app, plugin: entry.plan.plugin,
                human: [
                  `${target ? '已启用' : '已停用'}「${entry.plan.plugin}」${app === 'restart-required' ? '（重启后完全生效）' : ''}。`,
                  target ? '若之后启动异常，可用本卡片反向操作再停用。' : '如需还原：面板或 Agent 工具 kind=enable 重新启用。',
                ],
              }
            : { ok: false, error: (cr && cr.error && cr.error.message) || `application=${String(app)}`, plugin: entry.plan.plugin };
        }
      } else if (entry.kind === 'knowledge') {
        const line = { at: deps.now().toISOString(), headline: entry.plan.headline, counts: entry.plan.counts, findingIds: entry.plan.findingIds || [], ...(typeof entry.plan.cFreeBytes === 'number' ? { cFreeBytes: entry.plan.cFreeBytes } : {}) };
        await deps.io.appendJsonl(deps.knowledgeFile, line);
        await trimJsonl(deps.knowledgeFile);
        let trend = [];
        try { trend = (await deps.io.readJson(deps.trendFile)) || []; } catch { trend = []; }
        trend.push({ at: line.at, counts: line.counts, ...(typeof line.cFreeBytes === 'number' ? { cFreeBytes: line.cFreeBytes } : {}) });
        if (trend.length > 400) trend = trend.slice(-400);
        await deps.io.writeJson(deps.trendFile, trend);
        result = { ok: true, recorded: line, human: ['已把本次结论与趋势快照写入管家本地记录（带条目指纹，供日后召回）。'] };
      } else if (entry.kind === 'ack' || entry.kind === 'unack') {
        let list = await readAcked(deps);
        const id = entry.plan.findingId;
        if (entry.kind === 'ack') {
          if (!list.some((a) => a && a.id === id)) {
            const ttlDays = settingsAckTtl(currentSettings(deps), id);
            const expiresAt = new Date(deps.now().getTime() + ttlDays * 864e5).toISOString();
            list.push({ id, title: entry.plan.title, at: deps.now().toISOString(), expiresAt });
          }
        } else {
          list = list.filter((a) => a && a.id !== id);
        }
        await deps.io.writeJson(deps.ackedFile, list);
        result = {
          ok: true, findingId: id,
          human: entry.kind === 'ack'
            ? [`已静音「${entry.plan.title}」——下次体检起不计入风险。`,
               ackTtlLine(id, currentSettings(deps)),
               '恢复：该条目上的「取消知晓」，或 Agent 工具 kind=unack。']
            : [`「${entry.plan.title}」已恢复计入风险计数。`],
        };
      } else if (entry.kind === 'feedback' || entry.kind === 'unfeedback') {
        let list = await readFeedback(deps);
        const id = entry.plan.findingId;
        if (entry.kind === 'feedback') {
          if (!list.some((a) => a.id === id)) list.push({ id, title: entry.plan.title, at: deps.now().toISOString() });
        } else {
          list = list.filter((a) => a.id !== id);
        }
        await deps.io.writeJson(deps.feedbackFile, list);
        result = {
          ok: true, findingId: id,
          human: entry.kind === 'feedback'
            ? [`已把「${entry.plan.title}」标记为判错——下次体检起它会排在后面，但证据仍在。`, '撤销：该条目上的「撤销判错」。']
            : [`「${entry.plan.title}」的判错标记已撤销，恢复正常评分。`],
        };
      } else if (entry.kind === 'model-default') {
        const sel = typeof deps.getDefaultModel === 'function' ? deps.getDefaultModel() : null;
        if (!sel || typeof sel.saveSelection !== 'function') {
          result = { ok: false, error: 'agentDefaultModel 服务不可用。' };
        } else {
          try {
            await sel.saveSelection({ provider: entry.plan.provider, model: entry.plan.model });
            let now = null;
            try {
              const cur = typeof sel.currentSelection === 'function' ? sel.currentSelection() : null;
              if (cur && cur.provider && cur.model) now = { provider: String(cur.provider), model: String(cur.model) };
            } catch { now = null; }
            // 回读确认：调用没抛错不等于真的换过去了。
            const applied = now && now.provider === entry.plan.provider && now.model === entry.plan.model;
            result = applied
              ? {
                  ok: true, provider: entry.plan.provider, model: entry.plan.model, from: entry.plan.from,
                  human: [
                    `默认模型已切到 ${entry.plan.provider} / ${entry.plan.model}（原来 ${entry.plan.from}）。`,
                    '新的会话会用这个模型；已经开着的会话可能仍用旧的。',
                    '改错了吗？再点一次「替换默认模型」就能换回去——它只是个选择，不动任何插件。',
                  ],
                }
              : { ok: false, error: '写入没有生效：回读到的默认模型仍是 ' + (now ? now.provider + ' / ' + now.model : '（空）') + '。' };
          } catch (e) {
            result = { ok: false, error: '切换默认模型失败：' + (e && e.message ? e.message : String(e)) };
          }
        }
      } else {
        result = { ok: false, error: `unknown kind ${entry.kind}` };
      }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // NEVER put input.password into the audit record.
    await audit({ op: 'execute', hash, kind: entry.kind, ok: result.ok === true, error: result.ok ? undefined : result.error, plugin: entry.plan && entry.plan.plugin });
    return result;
  }

  function listPending() {
    return [...pending.entries()].map(([hash, e]) => ({ planHash: hash, kind: e.kind, createdAt: e.createdAt, plan: e.plan }));
  }

  return { plan, execute, listPending };
}
