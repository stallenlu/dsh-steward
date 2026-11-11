/**
 * dsh-steward · report.js
 *
 * Pure, read-only health-check data collection. ZERO imports from other DSH
 * packages on purpose: this bundle must not inherit version drift from
 * dshmarket / dsh-config-manager internals (that drift is pain point #1).
 *
 * Everything here is injectable so smoke.mjs can exercise it with fixtures
 * without touching the real machine. All IO is best-effort: a failure becomes
 * an entry in `errors`, never an exception that reaches the host boot fiber.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { defaults as defaultSettings, value as settingValue } from './settings.js';

/**
 * 不可由用户调整的硬限流（防止一份异常数据把体检拖死）。
 *
 * v0.8.0：原来这里还有 maxLogs / maxBytesPerLog，现在它们由用户在「设置」页
 * 调（collect.maxLogs / collect.maxBytesPerLog），因为「读多少份日志」属于使用
 * 偏好而不是安全底线。这两个仍留作兜底上限——即使用户填了极端值也不会越过。
 */
export const LIMITS = {
  maxLogs: 200,
  maxBytesPerLog: 16 * 1024 * 1024,
  maxPatchBackups: 50,
  maxBackups: 20,
};

/** 由用户设置算出本次采集的实际限流（夹在用户值上，再夹在硬上限下）。 */
function limitsFor(settings) {
  const logs = settingValue(settings, 'collect.maxLogs');
  const bytesKb = settingValue(settings, 'collect.maxBytesPerLog');
  return {
    maxLogs: Math.min(LIMITS.maxLogs, logs),
    maxBytesPerLog: Math.min(LIMITS.maxBytesPerLog, bytesKb * 1024),
    maxPatchBackups: LIMITS.maxPatchBackups,
    maxBackups: LIMITS.maxBackups,
  };
}



/** `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` and profile dirs. */
export function defaultPaths(env = process.env, platform = process.platform) {
  const home = os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const dshHome = env.DSH_HOME || path.join(home, '.dsh');
  const logDirs = [path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs')];
  if (platform !== 'win32') {
    logDirs.push(path.join(home, 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop', 'logs'));
    logDirs.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), '@deepseek-ai', 'dsh-desktop', 'logs'));
  }
  return {
    logDirs,
    profileDirs: [
      path.join(dshHome, 'profiles', 'desktop'),
      path.join(dshHome, 'profiles', 'default'),
    ],
    dshHome,
    appData,
  };
}

/** Reproduces dshmarket/lib/recovery.js:92 `parseBootFailure` without importing it. */
export function parseBootFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);
  let didNotActivate = null;
  let bootLine = null;
  const suspects = [];
  for (const line of lines) {
    const m = /(\d+)\s+entr(?:y|ies) did not activate/i.exec(line);
    if (m && didNotActivate === null) {
      didNotActivate = Number(m[1]);
      bootLine = line.trim();
    }
    const im = /([A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)?)\s*:\s*import failed/i.exec(line);
    if (im && !suspects.includes(im[1])) suspects.push(im[1]);
  }
  // v0.9.3: parse the CAUSE, not just the victim. The renderer console section
  // of a real crash log says it outright —
  //   client-modules: duplicate factory registration for "dsh-steward"
  //   (bundle executed twice without invalidate?)
  // — while the `X: import failed` line only names the plugin that happened to
  // lose the race. Reporting the second as the suspect is how a broken
  // directory layout gets misdiagnosed as a broken plugin: the victim's own
  // module imports fine.
  const clientDuplicates = [];
  for (const line of lines) {
    const dm = /duplicate factory registration for ["']([^"']+)["']/i.exec(line);
    if (dm && !clientDuplicates.includes(dm[1])) clientDuplicates.push(dm[1]);
  }
  const isBoot = didNotActivate !== null || suspects.length > 0 || clientDuplicates.length > 0 || /web boot/i.test(text);
  if (!isBoot) return null;
  return { didNotActivate, suspects, clientDuplicates, bootLine, isBoot };
}

function extractMeta(text) {
  const meta = {};
  // Real crash logs put a plain `key: value` header BEFORE `--- error ---`.
  // Read that block first. JSON-style "key":"value" is only a fallback for
  // synthetic fixtures; otherwise a stray "phase":"started" in the
  // operation-history JSON further down would be misread as the boot phase.
  const header = String(text).split(/---\s*error\s*---/i)[0];
  const grab = (out, lineKey, jsonRe) => {
    const lineRe = new RegExp('^\\s*' + lineKey + '\\s*:\\s*(.+?)\\s*$', 'im');
    const lm = lineRe.exec(header);
    if (lm && lm[1] && lm[1].trim()) { meta[out] = lm[1].trim(); return; }
    const jm = jsonRe.exec(text);
    if (jm) meta[out] = jm[1];
  };
  grab('app', 'app', /"app"\s*:\s*"([^"]+)"/);
  grab('electron', 'electron', /"electron"\s*:\s*"([^"]+)"/);
  grab('node', 'node', /"node"\s*:\s*"([^"]+)"/);
  grab('source', 'source', /"source"\s*:\s*"([^"]+)"/);
  grab('phase', 'phase', /"phase"\s*:\s*"([^"]+)"/);
  grab('shellPid', 'shell pid', /"pid"\s*:\s*(\d+)/);
  return meta;
}

export function parseCrashLog(text, file) {
  const failure = parseBootFailure(text);
  if (!failure) return null;
  return {
    file: file.name,
    size: file.size,
    mtime: file.mtime,
    didNotActivate: failure.didNotActivate,
    bootLine: failure.bootLine,
    suspects: failure.suspects,
    clientDuplicates: failure.clientDuplicates || [],
    meta: extractMeta(text),
  };
}

function safeIo(io) {
  return {
    readDir(dir) {
      try { return (io?.readDir || fs.readdirSync)(dir, { withFileTypes: false }); }
      catch (e) { return { __error: String(e && e.message || e) }; }
    },
    stat(file) {
      try { return (io?.stat || fs.statSync)(file); }
      catch (e) { return { __error: String(e && e.message || e) }; }
    },
    readText(file) {
      try { return (io?.readText || ((p) => fs.readFileSync(p, 'utf8')))(file); }
      catch (e) { return { __error: String(e && e.message || e) }; }
    },
    realpath(target) {
      // Resolve a symlinked package dir to its true location. Two different
      // names pointing at one realpath is exactly the state that broke boot on
      // 2026-11-09 — and it is invisible to every name-based check.
      try {
        const fn = io?.realpath || (fs.realpathSync.native || fs.realpathSync);
        return fn(target);
      } catch { return null; }
    },
  };
}

function isAbsentDirError(err) {
  return /ENOENT|no such file or directory/i.test(String(err || ''));
}

function collectCrashLogs(paths, io, errors, limits) {
  const found = [];
  for (let di = 0; di < paths.logDirs.length; di += 1) {
    const dir = paths.logDirs[di];
    const names = io.readDir(dir);
    if (names && names.__error) {
      // A missing CANDIDATE dir (non-primary platform layout) is expected.
      // Don't let benign absence masquerade as a degraded report.
      if (!(di > 0 && isAbsentDirError(names.__error))) {
        errors.push({ step: 'crash-dir', dir, error: names.__error });
      }
      continue;
    }
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (!/^crash-.*\.log$/i.test(name)) continue;
      const full = path.join(dir, name);
      const st = io.stat(full);
      if (st && st.__error) { errors.push({ step: 'crash-stat', file: full, error: st.__error }); continue; }
      if (!st || !st.isFile || !st.isFile()) continue;
      if (st.size > limits.maxBytesPerLog) {
        errors.push({ step: 'crash-size', file: full, error: 'exceeds maxBytesPerLog=' + limits.maxBytesPerLog });
        continue;
      }
      if (found.length >= limits.maxLogs) { errors.push({ step: 'crash-limit', error: 'maxLogs=' + limits.maxLogs + ' reached' }); break; }
      const text = io.readText(full);
      if (text && text.__error) { errors.push({ step: 'crash-read', file: full, error: text.__error }); continue; }
      const parsed = parseCrashLog(text, { name, size: st.size, mtime: st.mtime ? st.mtime.toISOString() : null });
      if (parsed) found.push(parsed);
    }
  }
  found.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
  return found;
}

function collectPatchBackups(paths, io, errors) {
  const found = [];
  for (let di = 0; di < paths.profileDirs.length; di += 1) {
    const dir = paths.profileDirs[di];
    const names = io.readDir(dir);
    if (names && names.__error) {
      if (!(di > 0 && isAbsentDirError(names.__error))) {
        errors.push({ step: 'profile-dir', dir, error: names.__error });
      }
      continue;
    }
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      const m = /^cordis\.patch\.yml\.bak-(\d{10,16})$/.exec(name);
      if (!m) continue;
      if (found.length >= LIMITS.maxPatchBackups) break;
      const full = path.join(dir, name);
      const st = io.stat(full);
      const live = io.stat(path.join(dir, 'cordis.patch.yml'));
      const liveText = io.readText(path.join(dir, 'cordis.patch.yml'));
      const bakText = io.readText(full);
      found.push({
        file: name,
        dir,
        epochMs: Number(m[1]),
        size: st && st.size != null ? st.size : null,
        liveBytes: live && live.size != null ? live.size : null,
        liveText: typeof liveText === 'string' ? liveText : '',
        text: typeof bakText === 'string' ? bakText : '',
      });
    }
  }
  return found;
}

/**
 * ① Backup freshness (v0.7.6). Reads ONLY the export directory that
 * dsh-config-manager already writes to — it does not produce backups itself and
 * does not import the backup engine. The point is narrow and load-bearing: the
 * report already says "volatile data is not in the default backup set", but it
 * never knew whether the user had actually backed up recently. A caretaker that
 * cannot answer "how many days since the last backup" is just a linter.
 */
export function collectBackupExports(paths, io, errors) {
  const dir = path.join(paths.dshHome, 'dsh-config-manager', 'exports');
  const names = io.readDir(dir);
  if (names && names.__error) {
    if (!isAbsentDirError(names.__error)) {
      errors.push({ step: 'backup-dir', dir, error: names.__error });
    }
    return { dir, found: false, backups: [] };
  }
  if (!Array.isArray(names)) return { dir, found: false, backups: [] };
  const backups = [];
  for (const name of names) {
    if (!/\.zip$/i.test(name)) continue;
    if (backups.length >= LIMITS.maxBackups) break;
    const full = path.join(dir, name);
    const st = io.stat(full);
    if (!st || st.__error || (st.isFile && !st.isFile())) continue;
    backups.push({
      file: name,
      size: st.size != null ? st.size : null,
      mtime: st.mtime ? st.mtime.toISOString() : null,
    });
  }
  backups.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
  return { dir, found: true, backups };
}

/**
 * ④ Config drift (v0.7.6). Hashes cordis.patch.yml and package.json.
 *
 * Why this is load-bearing: host-recovery's sanitizeProfile renames
 * cordis.patch.yml to <patch>.bak-<epoch>, writes a default stub, and one
 * reported incident silently dropped 22 KB of providers/models/permission
 * presets. It is far cheaper to notice "my 2692-line patch became 40 lines" than
 * to reconstruct it. We never edit the file — we only record its digest.
 */
export function collectConfigFingerprint(paths, io, errors) {
  const watched = ['cordis.patch.yml', 'package.json'];
  const out = [];
  for (const dir of paths.profileDirs) {
    for (const name of watched) {
      const full = path.join(dir, name);
      const st = io.stat(full);
      if (!st || st.__error) continue; // absent profile layout is normal
      const text = io.readText(full);
      if (text && text.__error) {
        errors.push({ step: 'config-read', file: full, error: text.__error });
        continue;
      }
      const buf = Buffer.from(String(text), 'utf8');
      out.push({
        file: name,
        dir,
        bytes: buf.length,
        lines: String(text).split('\n').length,
        digest: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
      });
    }
  }
  return out;
}

/**
 * ② Workspace / session inventory (v0.7.7).
 *
 * Reads the workspace index the host itself maintains
 * ($DSH_HOME/storages/workspace.json) and measures each workspace's session
 * directory. Strictly read-only: it never archives or deletes anything — it can
 * only tell you which workspace is eating the disk and how long since it moved.
 *
 * Session directories are named after the workspace path by replacing path
 * separators with '-', so "C:\\work" becomes "--C-work--". We encode
 * the same way rather than guessing from the directory listing, so a workspace
 * whose sessions were all deleted shows up as 0 B instead of being invisible.
 */
export function encodeWorkspaceDir(wsPath) {
  if (typeof wsPath !== 'string' || !wsPath.trim()) return null;
  const slug = wsPath.replace(/[:\\/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;
  return '--' + slug + '--';
}

function dirSize(io, dir, depth = 0) {
  if (depth > 3) return 0;
  const names = io.readDir(dir);
  if (!Array.isArray(names)) return 0;
  let total = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const st = io.stat(full);
    if (!st || st.__error) continue;
    if (st.isFile && st.isFile()) { total += st.size || 0; continue; }
    if (st.isDirectory && st.isDirectory()) total += dirSize(io, full, depth + 1);
  }
  return total;
}

export function collectWorkspaces(paths, io, errors) {
  const file = path.join(paths.dshHome, 'storages', 'workspace.json');
  const raw = io.readText(file);
  const sessionsDir0 = path.join(paths.dshHome, 'sessions');
  // Optional source: absence or an unreadable index means "not available", which
  // the confidence layer reports as degraded evidence. It must NOT push an error
  // entry — that would flip the whole report to 'degraded' over an optional file.
  if (!raw || raw.__error || !String(raw).trim()) {
    return { available: false, workspaces: [], totalBytes: 0, sessionsDir: sessionsDir0 };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { available: false, workspaces: [], totalBytes: 0, sessionsDir: sessionsDir0 };
  }
  const table = (parsed && parsed.tables && parsed.tables.workspaces) || {};
  const ids = (parsed && parsed.global && Array.isArray(parsed.global.workspaceIds))
    ? parsed.global.workspaceIds
    : Object.keys(table);
  const sessionsDir = path.join(paths.dshHome, 'sessions');
  const out = [];
  for (const id of ids) {
    const w = table[id];
    if (!w) continue;
    const enc = encodeWorkspaceDir(w.path);
    const dir = enc ? path.join(sessionsDir, enc) : null;
    let bytes = 0;
    let ageDays = null;
    if (dir) {
      const st = io.stat(dir);
      if (st && !st.__error) {
        bytes = dirSize(io, dir);
        if (st.mtime) ageDays = Math.max(0, Math.floor((Date.now() - st.mtime.getTime()) / 864e5));
      }
    }
    let exists = false;
    try { exists = !!(w.path && fs.existsSync(w.path)); } catch { exists = false; }
    out.push({
      id,
      title: w.title || path.basename(w.path || '') || id,
      path: w.path || null,
      dirName: enc,
      exists,
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
      bytes,
      ageDays,
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = out.reduce((s, w) => s + w.bytes, 0);
  return { available: true, workspaces: out, totalBytes, sessionsDir };
}

/**
 * ③ Plugin update inventory (v0.7.7).
 *
 * The comparison itself is trivial; the hard part is where to read it from. The
 * market keeps a single cache file at $DSH_HOME/plugin-update-cache.json
 * (311 KB on this machine, refreshed whenever the market checks for updates).
 * We read THAT instead of rebuilding a registry client: no network, no auth, no
 * inferred format. If the file is missing or stale we say so rather than
 * pretending everything is current.
 */
/**
 * Direction between two published versions: 1 = a is newer, -1 = older,
 * 0 = same, null = can't tell. `verCmp` is fed by the semver-range matcher and
 * treats junk as 0, which is fine there but dangerous here — reading a tag like
 * "beta" as "same version" would silently drop a real update. So gate on shape
 * first and refuse to guess.
 */
function versionDirection(a, b) {
  const shaped = (v) => typeof v === 'string' && /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(v.trim());
  if (!shaped(a) || !shaped(b)) return null;
  return verCmp(a, b);
}

export function collectUpdates(paths, io, errors) {
  const file = path.join(paths.dshHome, 'plugin-update-cache.json');
  const raw = io.readText(file);
  const empty = { available: false, reason: '没有找到市场更新缓存', outdated: [], checked: 0, cacheAgeHours: null };
  // Optional source, same rule as the workspace index: absence is information
  // (and gets surfaced by the confidence layer), not a degraded report.
  if (!raw || raw.__error || !String(raw).trim()) return empty;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { ...empty, reason: '更新缓存无法解析' };
  }
  const packages = (parsed && parsed.packages) || {};
  const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
  const cacheAgeHours = fetchedAt ? Math.max(0, Math.round((Date.now() - fetchedAt) / 36e5)) : null;

  // Installed versions come from each profile's node_modules — the same place
  // the compat check already reads, so no new contract is introduced.
  const installed = new Map();
  for (const dir of paths.profileDirs) {
    const nm = path.join(dir, 'node_modules');
    const entries = io.readDir(nm);
    if (!Array.isArray(entries)) continue;
    for (const name of entries) {
      const readOne = (pkgName, base) => {
        const pj = io.readText(path.join(base, 'package.json'));
        if (!pj || pj.__error) return;
        try {
          const v = JSON.parse(pj);
          if (v && v.name && v.version) installed.set(v.name, v.version);
        } catch { /* unreadable package.json is not our problem */ }
      };
      if (name.startsWith('@')) {
        const scoped = io.readDir(path.join(nm, name));
        if (!Array.isArray(scoped)) continue;
        for (const sub of scoped) readOne(name + '/' + sub, path.join(nm, name, sub));
      } else {
        readOne(name, path.join(nm, name));
      }
    }
  }

  const outdated = [];
  const aheadOfCache = [];
  let checked = 0;
  let undetermined = 0;
  for (const [pkgName, info] of Object.entries(packages)) {
    const cur = installed.get(pkgName);
    if (!cur) continue; // not installed here — the market cache lists everything
    checked += 1;
    const latest = info && typeof info.latest === 'string' ? info.latest : null;
    if (!latest || latest === cur) continue;
    // v0.9.4: "different" is not "newer". This machine's cache listed
    // dsh-disk-cleaner 1.6.3 → 1.6.2 — a plain inequality test turned a stale
    // cache into an "upgrade available" that would have been a DOWNGRADE.
    // Compare direction, and say "undetermined" when a version is not parseable
    // rather than guessing which way it points.
    const dir = versionDirection(latest, cur);
    if (dir === null) { undetermined += 1; continue; }
    if (dir > 0) outdated.push({ name: pkgName, installed: cur, latest });
    else if (dir < 0) aheadOfCache.push({ name: pkgName, installed: cur, latest });
  }
  outdated.sort((a, b) => a.name.localeCompare(b.name));
  aheadOfCache.sort((a, b) => a.name.localeCompare(b.name));
  return { available: true, reason: null, outdated, aheadOfCache, checked, undetermined, cacheAgeHours };
}

/**
 * Advisory-only coverage notes. The steward does NOT re-implement disk scanning
 * (dsh-disk-cleaner owns it), backup (dsh-config-manager), archiving or memory
 * (Mnemon). It only points at the right existing capability and states the
 * boundaries it will not cross. This is the "thin orchestration" layer.
 */
function advisoryFindings() {
  return [
    {
      id: 'data-at-risk',
      severity: 'warning',
      category: '备份覆盖',
      title: '易失数据不在默认备份分区内',
      detail: '定时/默认备份只含 defaultIncluded=true 分区；sessions、pluginData、pluginAssets、pluginFiles、secrets 不在其中，Mnemon 知识落在 sessions/*/mnemon-run-* 同样不进任何默认分区。会话历史与知识沉淀是最怕丢的部分。',
      evidence: 'dsh-config-manager/lib/schema/section-registry.js:193-247、:307；lib/sync/backup-scheduler.js:163-200（导出不传 only）；lib/core/exporter.js:268',
      recommendation: '手动做一次带口令的加密导出（GUI 的加密导出，或 config_backup 后整体封成 DCA1），覆盖 sessions/pluginData/pluginAssets；恢复走合并式定向恢复，旧配置禁止整体回灌。凭据永不进备份。',
      data: { sections: ['sessions', 'pluginData', 'pluginAssets', 'Mnemon'] },
    },
    {
      id: 'disk-advice',
      severity: 'info',
      category: 'C 盘治理',
      title: '可自动清 / 不可自动清必须分开',
      detail: 'C 盘占用通常分成两类：一类是纯缓存（包管理器 store、浏览器缓存、日志、回收站），删掉可重建；另一类是 WSL ext4.vhdx、已安装程序、WinSxS 组件库、下载/文档等，属于「不可自动清理」。后者往往占大头，且清理需要提权、卸载或压缩虚拟盘，必须由用户自己决定。',
      evidence: '判据：C 盘占用按「可自动清 / 不可自动清」分类，具体体积以 disk_cleaner action=audit 的实时结果为准（本条不写死数字，以免把某次快照当成现状）',
      recommendation: '用现成的 disk_cleaner 看分级建议；管家只呈现「可清 vs 不可清」，不代跑 DISM / diskpart / 卸载命令，不自动删。',
      data: { boundary: 'read-only' },
    },
    {
      id: 'knowledge',
      severity: 'info',
      category: '知识积累',
      title: '有效模式靠 Mnemon 沉淀，不靠重复造轮子',
      detail: '核查结论、契约坑、设计定稿应写入项目知识库，供后续同风格工作复用；管家本轮只读不改任何知识。',
      evidence: '定稿 mnemon 文档 f7e5a482（rev6）；逐轮文档 7f939c34 / 19a0a790 / dcb90e6e',
      recommendation: '有价值的结论经用户确认后写入 Mnemon；管家不自动写记忆、不自动改 profile。',
      data: { boundary: 'read-only' },
    },
  ];
}

/**
 * Build the full report. Pure and side-effect-free apart from injected IO.
 * options: { now, env, platform, logDirs, profileDirs, pluginChanges, io }
 */
/**
 * Importance scoring — one auditable formula, four factors, each explained.
 * Stays pure: reads only finding.data that already exists, mutates nothing
 * outside the finding. Score is 0–100; `priority` is a coarse band so users
 * can talk about it ("top-priority") without reading the number.
 */
const SEV_BASE = { critical: 60, warning: 40, info: 20 };
const ACTIONABLE_IDS = new Set(['boot-crash-latest', 'data-at-risk', 'disk-advice', 'knowledge', 'backup-freshness', 'model-health']);
/** Human-readable byte size, used by the backup/config findings. */
function mbLabel(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes)) return '未知大小';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
function scoreFindings(findings, ctx) {
  const bootedAt = ctx && ctx.bootedAt ? ctx.bootedAt : null;
  for (const f of findings) {
    const reasons = [];
    const base = SEV_BASE[f.severity] != null ? SEV_BASE[f.severity] : 20;
    reasons.push('级别 ' + f.severity + ' +' + base);
    let score = base;

    // freshness: evidence produced in this process lifetime counts more.
    let fresh = 0;
    if (f.id === 'boot-crash-latest') {
      if (f.data && f.data.stale === false) { fresh = 15; reasons.push('崩溃是本次运行期内 +' + fresh); }
      else if (f.data && f.data.stale === true) { fresh = -15; reasons.push('崩溃是历史记录 −' + Math.abs(fresh)); }
    } else if (f.id === 'plugin-change') {
      fresh = 10; reasons.push('变更是本会话内存计数 +' + fresh);
    } else if (f.id === 'patch-backup') {
      fresh = 10; reasons.push('备份文件此刻就在磁盘上 +' + fresh);
    } else if (f.id === 'compat-check') {
      fresh = 10; reasons.push('按当前宿主实测 +' + fresh);
    } else if (f.id === 'client-identity') {
      // Read straight off the install tree in this run — a live conflict is a
      // live boot hazard, not a historical note.
      fresh = 10; reasons.push('按当前安装目录实测 +' + fresh);
    } else {
      reasons.push('常备建议，不加分');
    }
    score += fresh;

    // actionable: a one-click authorized path exists (or the user can act now).
    // A stale crash does NOT count: its disable action is blocked by the
    // attribution gate, so promising a shortcut there would be dishonest.
    const gateBlocked = f.id === 'boot-crash-latest' && f.data && f.data.stale === true;
    if (ACTIONABLE_IDS.has(f.id) && !f.muted && !f.falsePositive && !gateBlocked) {
      score += 15; reasons.push('有直达处置动作 +15');
    } else if (gateBlocked) {
      reasons.push('处置被归因门封锁，不计可直达');
    }

    // magnitude: how large the underlying evidence is.
    let mag = 0;
    const d = f.data || {};
    if (f.id === 'boot-crash-latest') {
      if (d.crashCount > 1) mag += Math.min(10, d.crashCount * 3);
      if (Array.isArray(d.suspects) && !d.stale && d.suspects.length > 0) mag += 5;
    } else if (f.id === 'patch-backup') {
      if (Array.isArray(d.backups)) mag += Math.min(10, d.backups.length * 5);
    } else if (f.id === 'plugin-change') {
      if (Array.isArray(d.changes)) mag += Math.min(10, d.changes.length * 3);
    } else if (f.id === 'compat-check') {
      if (Array.isArray(d.mismatched) && d.mismatched.length > 0) mag += Math.min(10, d.mismatched.length * 3);
      else if (d.declared) mag += Math.min(5, Math.floor(d.declared / 10));
    } else if (f.id === 'model-health') {
      if (f.severity === 'warning') mag += 10; // 默认模型挂了是当下真的用不了
      if (Array.isArray(d.deadModels) && d.deadModels.length > 0) mag += Math.min(6, d.deadModels.length * 2);
    } else if (f.id === 'data-at-risk') {
      mag += 8; // the gap is constant but its blast radius is the whole volatile set
    } else if (f.id === 'client-identity') {
      // Every distinct kind of conflict is another way boot can die; a live one
      // is by definition worth more than a declaration-mismatch tally.
      const kinds = [d.sameReal, d.drifted, d.collisions].filter((x) => Array.isArray(x) && x.length > 0).length;
      if (kinds > 0) mag += Math.min(10, kinds * 4);
    }
    if (mag) { score += mag; reasons.push('体量/条数 +' + mag); }
    if (f.falsePositive) { score -= 40; reasons.push('用户标记判错 -40'); }

    score = Math.max(0, Math.min(100, Math.round(score)));
    f.score = score;
    f.priority = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
    f.scoreReasons = reasons;
    // muted items never lead the queue regardless of raw score; the UI puts
    // them in the last tier, so we record the intent without faking the number.
  }
}

// ---- minimal semver-range helpers (v0.3.0 ③ compat check) ----
// Honest scope: handles the comparator forms actually observed in installed
// packages (">=x", "<x", "^x", plain "=" and "||" unions). Anything fancier
// degrades to "undetermined" — never a false all-clear.
function verCmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('-');
  const pb = String(b).replace(/^v/, '').split('-');
  const na = pa[0].split('.').map((x) => parseInt(x, 10) || 0);
  const nb = pb[0].split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (na[i] || 0) - (nb[i] || 0); if (d) return d; }
  if (pa[1] && !pb[1]) return -1; if (!pa[1] && pb[1]) return 1;
  if (pa[1] && pb[1]) return pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0;
  return 0;
}
// caret 上界：^1.2.3 → <2.0.0；^0.2.3 → <0.3.0；^0.0.3 → <0.0.4；^0 → <1.0.0。
// 只取 '-' 前的数字段（prerelease 不参与上界计算），按 semver caret 语义递增
// 第一个非零段；全零（如 '0' / '0.0'）退回 <1.0.0。
function caretUpperBound(val) {
  const parts = val.replace(/^v/, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
  const major = parts[0] || 0, minor = parts[1] || 0, patch = parts[2] || 0;
  if (major > 0) return (major + 1) + '.0.0';
  if (minor > 0) return '0.' + (minor + 1) + '.0';
  if (patch > 0) return '0.0.' + (patch + 1);
  return '1.0.0';
}
function satisfiesToken(token, version) {
  const m = /^(>=|<=|\^|>|<|=)?\s*(.+)$/.exec(String(token).trim());
  if (!m) return null;
  const [, op, valRaw] = m;
  const val = valRaw.trim();
  if (/[a-zA-Z*]/.test(val) && !/^\d/.test(val)) return null; // ranges like "latest", "*" → undetermined
  switch (op) {
    case '>=': return verCmp(version, val) >= 0;
    case '<=': return verCmp(version, val) <= 0;
    case '>': return verCmp(version, val) > 0;
    case '<': return verCmp(version, val) < 0;
    case '^': return verCmp(version, val) >= 0 && verCmp(version, caretUpperBound(val)) < 0;
    default: return verCmp(version, val) === 0;
  }
}
function satisfiesRange(range, version) {
  const parts = String(range).split('||');
  let sawUndetermined = false;
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    let all = true; let anyUnknown = false;
    for (const t of tokens) {
      const r = satisfiesToken(t, version);
      if (r === null) anyUnknown = true; else if (!r) all = false;
    }
    if (!anyUnknown && all) return true;
    if (anyUnknown) sawUndetermined = true;
  }
  return sawUndetermined ? null : false;
}

/**
 * Read installed bundles' engines.dsh declarations and the host dsh-base
 * version straight off the profile's node_modules (read-only file IO).
 * Returns { hostVersion: string|null, entries: [{name,version,range}], checked }.
 */
function collectCompat(paths, io, hostVersionOverride) {
  const entries = [];
  let hostVersion = hostVersionOverride || null;
  const seen = new Set();
  for (const dir of paths.profileDirs) {
    const nm = dir.replace(/[\\/]+$/, '') + '/node_modules';
    if (!hostVersion) {
      try {
        const pkg = JSON.parse(io.readText(nm + '/@deepseek-ai/dsh-base/package.json'));
        if (pkg && typeof pkg.version === 'string') hostVersion = pkg.version;
      } catch { /* not readable — try next dir / stay null */ }
    }
    let tops = [];
    try { tops = io.readDir(nm); if (tops && tops.__error) tops = []; } catch { tops = []; }
    if (!Array.isArray(tops)) continue;
    for (const t of tops.slice(0, 300)) {
      const candidates = [];
      if (String(t).startsWith('@')) {
        let scoped = [];
        try { scoped = io.readDir(nm + '/' + t); if (scoped && scoped.__error) scoped = []; } catch { scoped = []; }
        if (Array.isArray(scoped)) for (const s of scoped.slice(0, 100)) candidates.push(nm + '/' + t + '/' + s + '/package.json');
      } else {
        candidates.push(nm + '/' + t + '/package.json');
      }
      for (const file of candidates) {
        try {
          const pkg = JSON.parse(io.readText(file));
          if (!pkg || typeof pkg.name !== 'string' || seen.has(pkg.name)) continue;
          const range = pkg.engines && (pkg.engines.dsh || pkg.engines['@deepseek-ai/dsh-base']);
          if (typeof range !== 'string' || !range.trim()) continue;
          seen.add(pkg.name);
          entries.push({ name: pkg.name, version: String(pkg.version || ''), range: range.trim() });
        } catch { /* package unreadable or not JSON — skip silently */ }
      }
    }
  }
  const checked = [];
  for (const e of entries) {
    if (!hostVersion) { checked.push({ ...e, state: 'unknown' }); continue; }
    const r = satisfiesRange(e.range, hostVersion);
    checked.push({ ...e, state: r === true ? 'ok' : r === false ? 'mismatch' : 'unknown' });
  }
  return { hostVersion, entries: checked };
}

/**
 * v0.9.3 client identity check.
 *
 * DSH client bundles self-register by id inside `window.__ModuleLoader__.load(
 * { id: 'X', ... })`. The renderer keeps a Map of factories keyed by that id,
 * so a SECOND registration of the same id throws
 *   client-modules: duplicate factory registration for "X"
 * and takes the whole web boot down with it — one duplicate id, no UI at all.
 *
 * Three ways to get there, none of which any existing check looks at:
 *   1. one package installed under two node_modules names (this is what
 *      actually happened on 2026-11-09: bare `dsh-steward/` plus
 *      `@sidady/dsh-steward/` both linking to the same source dir);
 *   2. a client.js whose declared id no longer matches its package name
 *      (renaming a package without touching the client bundle);
 *   3. two unrelated packages picking the same id.
 *
 * dshmarket's static analysis and trial boot both stay green on all three:
 * trialValidate replays the LOADER tree, and the loader is perfectly happy with
 * duplicate client ids because it never sees them. Verified on synthetic
 * fixtures 2026-11-10 — see the report section in the design doc.
 *
 * Read-only, and deliberately NOT actionable: the fix is deleting a symlink or
 * renaming an id, i.e. edits to other packages' install state. We name the
 * exact directories and stop there.
 */
function collectClientIdentity(paths, io, errors) {
  const entries = [];
  // v0.9.5: where the host actually looks. package.json exports["./client"]
  // first (that is the documented hook and what most packages use), then an
  // explicit dsh.client.entry, then the two conventional paths.
  const entryCandidates = (pkg) => {
    const out = [];
    const push = (v) => {
      if (typeof v === 'string' && v) out.push(v.replace(/^\.\//, ''));
      else if (v && typeof v === 'object') {
        if (typeof v.default === 'string') out.push(v.default.replace(/^\.\//, ''));
      }
    };
    const ex = pkg.exports;
    if (ex && typeof ex === 'object') push(ex['./client']);
    const dc = pkg.dsh && pkg.dsh.client;
    if (typeof dc === 'string') push(dc);
    else if (dc && typeof dc === 'object') { push(dc.entry); push(dc.path); push(dc.file); }
    out.push('lib/client.js', 'client.js', 'dist/client.js');
    return [...new Set(out)];
  };
  const seenDirs = new Set();
  let scanned = 0;
  const readId = (text) => {
    // Quotes may be ', " or ` — minified bundles switch between them freely.
    const m = /__ModuleLoader__\.load\(\s*\{[^}]*?\bid:\s*['"`]([^'"`]+)['"`]/.exec(text);
    if (m) return m[1];
    // Some bundles (dsh-cost-meter) route the call through a load-wrap proxy, so the
    // literal __ModuleLoader__ token never appears in the module body. Fall back to
    // the first object literal that carries an id, which is that same call argument.
    const loose = /\{\s*id\s*:\s*['"`]([^'"`]+)['"`]/.exec(text);
    return loose ? loose[1] : null;
  };
  for (const dir of paths.profileDirs) {
    const nm = dir.replace(/[\\/]+$/, '') + '/node_modules';
    let tops = [];
    try { tops = io.readDir(nm); if (tops && tops.__error) tops = []; } catch { tops = []; }
    if (!Array.isArray(tops)) continue;
    scanned += 1;
    const pkgDirs = [];
    for (const t of tops.slice(0, 400)) {
      const name = String(t);
      if (name.startsWith('@')) {
        let scoped = [];
        try { scoped = io.readDir(nm + '/' + name); if (scoped && scoped.__error) scoped = []; } catch { scoped = []; }
        if (Array.isArray(scoped)) for (const s of scoped.slice(0, 120)) pkgDirs.push(nm + '/' + name + '/' + s);
        continue;
      }
      // Skip node_modules/.bin and friends — they never carry a package.json.
      if (name.startsWith('.')) continue;
      pkgDirs.push(nm + '/' + name);
    }
    for (const pkgDir of pkgDirs) {
      if (seenDirs.has(pkgDir)) continue;
      seenDirs.add(pkgDir);
      let pkg = null;
      try { pkg = JSON.parse(io.readText(pkgDir + '/package.json')); } catch { continue; }
      if (!pkg || typeof pkg.name !== 'string') continue;
      if (!(pkg.dsh && pkg.dsh.client)) continue;
      let text = null;
      let usedPath = null;
      for (const rel of entryCandidates(pkg)) {
        try {
          const raw = io.readText(pkgDir + '/' + rel);
          if (typeof raw === 'string' && raw.trim()) { text = raw; usedPath = rel; break; }
        } catch { /* try the next candidate */ }
      }
      const id = text ? readId(text) : null;
      entries.push({
        dir: pkgDir.slice(nm.length + 1),
        name: pkg.name,
        id,
        entry: usedPath,
        readable: text !== null,
        realpath: io.realpath(pkgDir),
      });
    }
  }

  // C1: same real directory answering to more than one node_modules name.
  const byReal = new Map();
  for (const e of entries) {
    if (!e.realpath) continue;
    if (!byReal.has(e.realpath)) byReal.set(e.realpath, []);
    byReal.get(e.realpath).push(e.dir);
  }
  const sameReal = [...byReal.entries()]
    .filter(([, dirs]) => dirs.length > 1)
    .map(([realpath, dirs]) => ({ realpath, dirs }));

  // C2: declared client id != package name.
  const drifted = entries.filter((e) => e.id && e.id !== e.name);

  // C3: two packages claiming one id.
  const byId = new Map();
  for (const e of entries) {
    if (!e.id) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e.name);
  }
  const collisions = [...byId.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .map(([id, names]) => ({ id, names: [...new Set(names)] }));

  const unreadable = entries.filter((e) => !e.readable).length;
  const withoutId = entries.filter((e) => e.readable && !e.id).length;
  return { entries, sameReal, drifted, collisions, unreadable, withoutId, scanned };
}

/**
 * v0.9.15: turn 'better / worse / flat' into one Chinese sentence on the
 * server. The client only renders it (USER.md: GUI is for humans, the host
 * computes the words). previous is last run's persisted report; current is
 * this run's { level, counts }. worseningStreak rides along in the report so
 * consecutive declines can be counted without a second data store.
 */
export function summarizeTrend(previous, current) {
  const cur = current || {};
  const rank = (lv) => (lv === 'critical' ? 3 : lv === 'warning' ? 2 : 0);
  const bad = (c) => (Number(c && c.critical) || 0) * 3 + (Number(c && c.warning) || 0) + rank(cur.level) * 2;
  const curBad = bad(cur.counts);
  const prev = previous && previous.summary ? previous.summary : null;
  if (!prev) return { state: 'stable', worseningStreak: 0, text: '这是第一次体检，还没有可比的上一轮结论。' };
  const prevBad = (Number(prev.counts && prev.counts.critical) || 0) * 3 + (Number(prev.counts && prev.counts.warning) || 0) + rank(prev.level) * 2;
  const prevStreak = Number(previous.trendVerdict && previous.trendVerdict.worseningStreak) || 0;
  if (curBad < prevBad) {
    return { state: 'recovered', worseningStreak: 0, text: '比上一次体检好转了：风险项减少或严重项已消除。' };
  }
  if (curBad > prevBad) {
    const streak = prevStreak + 1;
    return { state: 'worsening', worseningStreak: streak,
      text: streak >= 2
        ? '连续 ' + streak + ' 次体检都在变差，值得回头看审计趋势里这几次改了什么。'
        : '比上一次体检多了风险项，先看看新出现的是哪一条。' };
  }
  return { state: 'stable', worseningStreak: 0, text: '与上一次体检相比没有明显变化。' };
}

export function collectReport(options = {}) {
  const now = options.now || new Date();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const paths = {
    ...defaultPaths(env, platform),
    ...(options.logDirs ? { logDirs: options.logDirs } : {}),
    ...(options.profileDirs ? { profileDirs: options.profileDirs } : {}),
  };
  const io = safeIo(options.io);
  const errors = [];
  // v0.8.0：判据阈值与采集限流全部来自用户设置（默认值 = v0.7.8 行为）。
  const settings = options.settings && typeof options.settings === 'object' ? options.settings : defaultSettings();
  const limits = limitsFor(settings);

  const bootedAt = options.bootedAt || new Date(Date.now() - Math.floor(process.uptime()) * 1000);
  const crashes = collectCrashLogs(paths, io, errors, limits);
  const patchBackups = collectPatchBackups(paths, io, errors);
  const pluginChanges = Array.isArray(options.pluginChanges) ? options.pluginChanges.slice(0, 50) : [];

  // v0.4 disk trend: system-drive free bytes via fs.statfsSync (native, zero
  // deps, sync-safe at report time). Best-effort — failure yields null.
  let cFreeBytes = null;
  try {
    const diskPath = platform === 'win32' ? 'C:\\' : '/';
    const st = typeof fs.statfsSync === 'function' ? fs.statfsSync(diskPath) : null;
    if (st && typeof st.bavail === 'number' && typeof st.bsize === 'number') cFreeBytes = st.bavail * st.bsize;
  } catch { /* unavailable — trend row just omits it */ }

  const findings = [];

  if (crashes.length > 0) {
    const latest = crashes[0];
    const allSuspects = [...new Set(crashes.flatMap((c) => c.suspects))];
    const latestSuspects = latest.suspects || [];
    // Staleness gate: this report is produced INSIDE a running host, so the
    // current instance booted successfully. DSH boot is all-or-nothing — if a
    // crash log predates the current boot, every plugin it named has by
    // construction loaded fine since. Reporting that as "critical" is noise.
    const latestTime = latest.mtime ? new Date(latest.mtime) : null;
    const stale = !!(latestTime && latestTime.getTime() <= bootedAt.getTime());
    // v0.9.10: two different questions were sharing one number.
    //   "how long ago did this happen"  -> now - latestTime   (what the prose says)
    //   "how much earlier than this boot" -> bootedAt - latestTime (what the gate uses)
    // Rounding the second one to whole hours printed "约 0 小时前" for a crash
    // 49 seconds before boot, seven hours after it actually happened.
    const ageMs = latestTime ? Math.max(0, now.getTime() - latestTime.getTime()) : null;
    const bootLagMs = latestTime ? Math.max(0, bootedAt.getTime() - latestTime.getTime()) : null;
    const ageHours = ageMs == null ? null : Math.round((ageMs / 36e5) * 10) / 10;
    const ageText = ageMs == null ? null
      : ageMs < 6e4 ? "不到 1 分钟前"
        : ageMs < 36e5 ? Math.round(ageMs / 6e4) + " 分钟前"
          : ageMs < 864e5 ? Math.round(ageMs / 36e5) + " 小时前"
            : Math.round(ageMs / 864e5) + " 天前";
    const bootLagText = bootLagMs == null ? null
      : bootLagMs < 6e4 ? "不到 1 分钟"
        : bootLagMs < 36e5 ? Math.round(bootLagMs / 6e4) + " 分钟"
          : bootLagMs < 864e5 ? Math.round(bootLagMs / 36e5) + " 小时"
            : Math.round(bootLagMs / 864e5) + " 天";
    // v0.9.3: when the log states the cause, report the CAUSE. `X: import failed`
    // names whoever lost the race; the renderer console line names the duplicate
    // id. Leading with the victim is how a directory problem gets misread as a
    // broken plugin.
    const causes = latest.clientDuplicates || [];
    const causeText = causes.length > 0
      ? 'client id "' + causes.join('"、"') + '" 被注册了两次'
      : null;
    findings.push({
      id: 'boot-crash-latest',
      severity: stale ? 'info' : 'critical',
      category: '启动诊断',
      title: (stale ? '历史 web-boot 崩溃（当前实例启动正常）：' : '最近一次 web-boot 崩溃：')
        + (causeText || (latest.didNotActivate != null ? latest.didNotActivate + ' 个条目未激活' : '插件导入失败')),
      detail: (causeText
        ? '病因（日志原文）：`client-modules: duplicate factory registration for "' + causes[0] + '"` —— '
          + '同一个 client id 被注册了两次，渲染端直接抛错。'
          + (latestSuspects.length > 0
            ? '\n被点名「import failed」的 ' + latestSuspects.join('、') + ' 是这一局的受害者而不是病因：它的包本身单独 import 是成功的，'
              + '输在 id 撞车。真正的修法是清理重复的安装目录或统一 id，不是去修那个插件。'
            : '')
        : (latestSuspects.length > 0
          ? '崩溃日志点名疑似插件：' + latestSuspects.join('、') + '。'
            + (stale
              ? '这份日志比当前运行实例的启动还早 ' + bootLagText + '，也就是 ' + ageText + '发生的事'
                + '；DSH 的 boot 是 all-or-nothing，当前界面能打开就证明这些插件后来全部加载成功了——属历史记录，不是现行风险。'
              : 'DSH 的 boot 是 all-or-nothing：一个插件没激活，整个 Web UI 起不来；这与「插件变更 → boot 风险」是同一条链。')
            + (crashes.length > 1 ? '另有 ' + (crashes.length - 1) + ' 份更早的崩溃日志，明细见 data.all。' : '')
          : '日志显示 boot 期导入失败但未点名具体插件，请结合 crash 日志全文排查。'))
        + (stale && causeText ? '\n这份日志比当前实例的启动还早 ' + bootLagText + '，是 ' + ageText + '发生的事，当前能打开就说明已经恢复。' : ''),
      evidence: latest.file + (latest.bootLine ? ' — ' + latest.bootLine : '') + (latest.meta.app ? ' — app ' + latest.meta.app : ''),
      recommendation: causeText
        ? '看下面「client 标识体检」列出的具体路径：同一份代码只留一个 node_modules 名字、id 与包名对齐。管家只读不代改。'
        : (stale
          ? '已恢复，无需处置。再次发生启动失败时优先看这里点名的第一个插件；恢复动作前先备份 cordis.patch.yml。管家不自动拉起、不碰启动流程。'
          : '先确认该插件的 node_modules 是否补齐、版本是否匹配宿主；恢复前备份 cordis.patch.yml，禁用坏插件而非反复重启。管家不自动拉起、不碰启动流程。'),
      data: {
        crashCount: crashes.length,
        stale,
        bootedAt: bootedAt.toISOString ? bootedAt.toISOString() : String(bootedAt),
        ageHours,
        bootLagHours: bootLagMs == null ? null : Math.round((bootLagMs / 36e5) * 100) / 100,
        ageText,
        bootLagText,
        suspects: latestSuspects,
        suspectsAllLogs: allSuspects,
        clientDuplicates: causes,
        meta: latest.meta,
        all: crashes.map((c) => ({ file: c.file, mtime: c.mtime, didNotActivate: c.didNotActivate, suspects: c.suspects, clientDuplicates: c.clientDuplicates || [] })),
      },
    });
  } else {
    findings.push({
      id: 'boot-crash-none',
      severity: 'info',
      category: '启动诊断',
      title: '未发现 web-boot 崩溃日志',
      detail: '在已知日志目录中没有解析到 crash-*.log 的「did not activate / import failed」记录。这不等于「从未崩过」——只代表当前可见日志里没有。',
      evidence: '扫描目录：' + paths.logDirs.join('、'),
      recommendation: '保持现状即可；崩溃日志由桌面端在下次启动时落盘，管家会在下次体检时读到。',
      data: { crashCount: 0 },
    });
  }

  if (patchBackups.length > 0) {
    // v0.9.7：字节数不是判据。本机实测 patch 比备份小 42%，但 14 个 - id: 块一个都没少——
    // 少的是块内字段（插件重写默认值，或用户改了选择）。拿总字节报「配置被换掉了」
    // 是把「小」当成「丢」，正是这份报告一直在批评的毛病。
    // 现在按结构判：块数少了 → 真丢了整块（warning）；块都在只是缩水 → info，
    // 把缩水的 id 与字节差列出来交给人判断，并明说「这不等于丢」。
    const livePatch = patchBackups[0].liveText || '';
    const liveIds = (livePatch.match(/^- id:\s*(.+)$/gm) || []).map((l) => l.replace(/^- id:\s*/, '').trim());
    const bakIds = [];
    for (const b of patchBackups) {
      if (!b.text) continue;
      for (const l of b.text.match(/^- id:\s*(.+)$/gm) || []) bakIds.push(l.replace(/^- id:\s*/, '').trim());
    }
    const missing = bakIds.filter((id) => liveIds.length > 0 && !liveIds.includes(id));
    const kb = (n) => (n == null ? '?' : (n / 1024).toFixed(1) + ' KB');
    const shrunk = patchBackups.filter((b) => b.size != null && b.liveBytes != null && b.liveBytes < b.size * 0.8);
    if (missing.length > 0) {
      findings.push({
        id: 'patch-backup',
        severity: 'warning',
        category: '配置备份',
        title: '启动期备份里有 ' + missing.length + ' 个配置块在当前 patch 里不存在了',
        detail: '启动期 sanitizeProfile 会把 patch 改名为 bak-<epoch> 再写默认 stub，该动作曾有静默丢 providers/模型/权限预设的报告。\n'
          + '当前 patch 少了这些 id 的整块：' + missing.join('、') + '\n'
          + '这是结构性缺失，不是「块内字段变了」——值得对照 .bak 补回来。',
        evidence: patchBackups.map((b) => b.file + '（' + kb(b.size) + '）').join('、'),
        recommendation: '对照 .bak 逐块补回缺的 id，补之前先把现有 patch 另存一份。旧配置禁止整体回灌——只拣缺的块。管家只读不改 patch。',
        data: { backups: patchBackups.map((b) => ({ file: b.file, size: b.size, liveBytes: b.liveBytes })), missing },
      });
    } else if (shrunk.length > 0) {
      findings.push({
        id: 'patch-backup',
        severity: 'info',
        category: '配置备份',
        title: '当前 patch 比启动期备份小，但配置块一个没少',
        detail: '对比结果：备份里的 ' + bakIds.length + ' 个 - id: 块在当前 patch 里全都还在，缩水发生在块内字段。\n'
          + shrunk.map((b) => '· ' + b.file + ' 是 ' + kb(b.size) + '，当前 ' + kb(b.liveBytes)
            + '（小 ' + (100 - Math.round((b.liveBytes / b.size) * 100)) + '%）').join('\n')
          + '\n块内字段变少有两种可能：插件把默认值重写成了空（如 enabledModelKeys: []），或者你的选择被清掉了。'
          + '这**不等于配置丢了**，但值得你自己对着 .bak 看一眼具体是哪几个字段。',
        evidence: patchBackups.map((b) => b.file + '（' + kb(b.size) + '）').join('、')
          + '；结构对比：- id: 块数 live ' + liveIds.length + ' / bak ' + bakIds.length,
        recommendation: '如果发现某个插件的设置被重置了，从 .bak 里把那一个块挑回来；不要整体回灌。管家只读不改 patch。',
        data: { backups: patchBackups.map((b) => ({ file: b.file, size: b.size, liveBytes: b.liveBytes })), liveIds, bakIds, shrunk: shrunk.map((b) => b.file) },
      });
    } else {
      findings.push({
        id: 'patch-backup',
        severity: 'info',
        category: '配置备份',
        title: '留有 ' + patchBackups.length + ' 个启动期 patch 备份（当前配置未被换掉）',
        detail: '这些 cordis.patch.yml.bak-<epoch> 是启动期 sanitizeProfile 改名留下的历史残留。'
          + '对比过结构：当前 patch 的配置块与体积都没有明显缺失。',
        evidence: patchBackups.map((b) => b.file + '（' + kb(b.size) + '）').join('、'),
        recommendation: '可以留着做参照，也可以自己删；管家不代删。要还原请用市场自带的 .bak 检测还原入口。',
        data: { backups: patchBackups.map((b) => ({ file: b.file, size: b.size, liveBytes: b.liveBytes })) },
      });
    }
  }

  if (pluginChanges.length > 0) {
    findings.push({
      id: 'plugin-change',
      severity: 'warning',
      category: '版本适配',
      title: '本会话记录到 ' + pluginChanges.length + ' 次插件变更',
      detail: '插件装/更/启停是 boot 风险的上游。DSH 市场在 enable 期已有 hostPeerGate 版本门槛与「#575 失败不落 enabled」守卫；管家不重复造拦截，只把变更标进报告供你对照。',
      evidence: '事件 plugin-manager/changed（本进程内存计数，重启清零）；dshmarket/lib/routes.js:912-930、:1088-1100',
      recommendation: '变更后若出现启动失败，回到上面「启动诊断」点名的插件核对版本；pre-flight 预警以市场已有守卫为准，管家不介入安装流程。',
      data: { changes: pluginChanges },
    });
  }

  findings.push(...advisoryFindings());

  // ③ v0.7.7 plugin updates. Only reports "installed vs available" — it never
  // upgrades. Upgrades are exactly the change that produces boot failures, so
  // this stays an information item with a pointer, not a button.
  let updateInfo = { available: false, outdated: [], checked: 0, cacheAgeHours: null };
  try {
    updateInfo = collectUpdates(paths, io, errors);
    if (!updateInfo.available) {
      findings.push({
        id: 'plugin-updates', severity: 'info', category: '版本适配',
        title: '插件更新体检未执行：' + (updateInfo.reason || '数据源不可用'),
        detail: '市场把可安装版本缓存在 $DSH_HOME/plugin-update-cache.json；没读到它就不猜有没有新版。这不影响其他体检项。',
        evidence: path.join(paths.dshHome, 'plugin-update-cache.json'),
        recommendation: '在插件市场里打开一次列表页（会刷新该缓存），然后重新体检。',
        data: { available: false },
      });
    } else if (updateInfo.outdated.length > 0) {
      // v0.9.4: also name the packages whose installed copy is AHEAD of the cache.
      // Those are not updates — they mean the cache is older than the disk, which is
      // worth saying out loud exactly once instead of silently hiding them.
      const ahead = updateInfo.aheadOfCache || [];
      const aheadNote = ahead.length > 0
        ? '\n另有 ' + ahead.length + ' 个包的已装版本比缓存里的 latest 还新（'
          + ahead.slice(0, 3).map((u) => u.name + ' ' + u.installed + ' > ' + u.latest).join('、')
          + (ahead.length > 3 ? ' 等' : '')
          + '）——那是缓存比磁盘旧，不是该升级。'
        : '';
      const unknownNote = updateInfo.undetermined > 0
        ? '\n还有 ' + updateInfo.undetermined + ' 个包的版本号写法无法比较，未计入。'
        : '';
      findings.push({
        id: 'plugin-updates',
        severity: 'info',
        category: '版本适配',
        title: updateInfo.outdated.length + ' 个已装插件有新版本可用',
        detail: updateInfo.outdated.slice(0, 10).map((u) => '· ' + u.name + '：' + u.installed + ' → ' + u.latest).join('\n')
          + (updateInfo.outdated.length > 10 ? '\n（共 ' + updateInfo.outdated.length + ' 个）' : '')
          + aheadNote + unknownNote
          + '\n\n升级是「插件变更 → boot 风险」的上游；升级前先确认真能备份到当前可用状态。',
        evidence: '来源：$DSH_HOME/plugin-update-cache.json（' + (updateInfo.cacheAgeHours != null ? updateInfo.cacheAgeHours + ' 小时前刷新' : '刷新时间未知') + '）；对比 ' + updateInfo.checked + ' 个已装包；版本方向按 semver 比，只把「更新」算作可用',
        recommendation: '逐个升而不是批量升，升完看「启动诊断」；不要在要赶活的时候动它们。管家不代升级。',
        data: { outdated: updateInfo.outdated.slice(0, 20), aheadOfCache: ahead.slice(0, 20), undetermined: updateInfo.undetermined || 0, checked: updateInfo.checked, cacheAgeHours: updateInfo.cacheAgeHours },
      });
    } else if (updateInfo.checked > 0) {
      findings.push({
        id: 'plugin-updates', severity: 'info', category: '版本适配',
        title: '插件更新体检：' + updateInfo.checked + ' 个已装包都是最新',
        detail: '与市场缓存里的 latest 按 semver 比方向，没有落后项。'
          + ((updateInfo.aheadOfCache || []).length > 0
            ? '\n其中 ' + updateInfo.aheadOfCache.length + ' 个已装版本比缓存更新（缓存偏旧，不是该升级）。'
            : '')
          + (updateInfo.undetermined > 0 ? '\n另有 ' + updateInfo.undetermined + ' 个包的版本号写法无法比较，未计入。' : ''),
        evidence: '来源：$DSH_HOME/plugin-update-cache.json（' + (updateInfo.cacheAgeHours != null ? updateInfo.cacheAgeHours + ' 小时前刷新' : '刷新时间未知') + '）',
        recommendation: '无需处理。',
        data: { outdated: [], aheadOfCache: (updateInfo.aheadOfCache || []).slice(0, 20), undetermined: updateInfo.undetermined || 0, checked: updateInfo.checked, cacheAgeHours: updateInfo.cacheAgeHours },
      });
    }
  } catch (e) {
    errors.push({ step: 'plugin-updates', error: String((e && e.message) || e) });
  }

  // ② v0.7.7 workspace / session inventory. The report previously mentioned
  // sessions only inside a prose string; this measures them.
  //
  // v0.7.8 — 「50 MB 超线」改判为增长而不是绝对体积。一个固定阀值在你没长胖时
  // 会天天亮，那不是发现问题，是把阀值当成了问题（ACCEPTANCE A5）。现在需要
  // 上一个快照才能判：体积没变化就降到 info，只有真涨了才 warning。没有上一个
  // 快照时（首跑、或日志被清）不给「超标」结论，只说当前体积。
  let workspaceInfo = { available: false, workspaces: [], totalBytes: 0 };
  try {
    workspaceInfo = collectWorkspaces(paths, io, errors);
    if (workspaceInfo.available && workspaceInfo.workspaces.length > 0) {
      const prev = options.previous && options.previous.workspace;
      const prevList = prev && Array.isArray(prev.workspaces) ? prev.workspaces : [];
      const prevAt = prev && prev.at ? Date.parse(prev.at) : NaN;
      const prevById = new Map(prevList.map((w) => [w.id || w.title, w]));
      const GROWTH_WARN_BYTES = settingValue(settings, 'threshold.growthWarnMb') * 1024 * 1024; // 由设置页控制，默认 20 MB
      const grown = [];
      for (const w of workspaceInfo.workspaces) {
        const before = prevById.get(w.id || w.title);
        if (!before || typeof before.bytes !== 'number') continue;
        const delta = w.bytes - before.bytes;
        if (delta >= GROWTH_WARN_BYTES) grown.push({ ...w, deltaBytes: delta, beforeBytes: before.bytes });
      }
      grown.sort((a, b) => b.deltaBytes - a.deltaBytes);
      const gone = workspaceInfo.workspaces.filter((w) => !w.exists);
      // v0.9.10: never let the list quietly stop earlier than the count in the title.
      const WS_SHOWN = 6;
      const wsRest = workspaceInfo.workspaces.length - WS_SHOWN;
      const lines = workspaceInfo.workspaces.slice(0, WS_SHOWN).map((w) => {
        const before = prevById.get(w.id || w.title);
        const delta = before && typeof before.bytes === 'number' ? w.bytes - before.bytes : null;
        const deltaTxt = delta == null ? ''
          : delta === 0 ? '，与上次持平'
            : '，较上次 ' + (delta > 0 ? '+' : '−') + mbLabel(Math.abs(delta));
        return '· ' + w.title + '：' + mbLabel(w.bytes) + '，' + w.sessionCount + ' 个会话'
          + deltaTxt
          + (w.ageDays != null ? '，目录 ' + w.ageDays + ' 天前有改动' : '')
          + (w.exists ? '' : '（目录已不存在）');
      }).join('\n');
      const compared = prevList.length > 0;
      const compareNote = compared
        ? '\n对照 ' + (isFinite(prevAt) ? new Date(prevAt).toISOString() : '上一次体检') + ' 的快照；净增 ≥ ' + mbLabel(GROWTH_WARN_BYTES) + ' 的工作区才升为 warning。'
        : '\n没有上一个快照可对照（首次或报告被清），本次只记体积，不判定是否「长胖」。';
      // Say how many were left out, and on what basis -- a title that says 7 while
      // the body lists 6 reads as a rendering bug, and a reader cannot tell whether
      // the missing one is the small one or the one that matters.
      const wsMoreNote = wsRest > 0
        ? '\n另有 ' + wsRest + ' 个工作区未逐条列出（上面按会话数据体积降序取前 ' + WS_SHOWN + ' 个，完整列表见 data.workspaces）。'
        : '';
      findings.push({
        id: 'workspace-inventory',
        severity: gone.length > 0 || grown.length > 0 ? 'warning' : 'info',
        category: '工作区与会话',
        title: gone.length > 0
          ? '有 ' + gone.length + ' 个工作区指向的目录已不存在'
          : grown.length > 0
            ? grown.length + ' 个工作区的会话数据在增长（合计净增 ' + mbLabel(grown.reduce((s, w) => s + w.deltaBytes, 0)) + '）'
            : workspaceInfo.workspaces.length + ' 个工作区，会话数据合计 ' + mbLabel(workspaceInfo.totalBytes) + '（与上次相比无显著增长）',
        detail: lines
          + compareNote
          + wsMoreNote
          + (gone.length > 0 ? '\n有 ' + gone.length + ' 个工作区指向的目录已不存在，其会话数据成了孤儿。' : ''),
        evidence: path.join(paths.dshHome, 'storages', 'workspace.json') + ' + ' + workspaceInfo.sessionsDir,
        recommendation: '会话数据不在默认备份分区内，建议先加密备份再清理；旧会话可用 @michengai/dsh-archive-manager 归档（它的入口在 Web UI，管家不代劳）。管家只报告，不删、不移。',
        data: {
          totalBytes: workspaceInfo.totalBytes,
          workspaces: workspaceInfo.workspaces.slice(0, 8),
          workspacesTotal: workspaceInfo.workspaces.length,
          grown: grown.map((w) => ({ title: w.title, deltaBytes: w.deltaBytes, bytes: w.bytes })),
          orphan: gone.map((w) => w.title),
          comparedTo: compared && isFinite(prevAt) ? new Date(prevAt).toISOString() : null,
          growthWarnBytes: GROWTH_WARN_BYTES,
        },
      });
    }
  } catch (e) {
    errors.push({ step: 'workspace-inventory', error: String((e && e.message) || e) });
  }

  // ① v0.7.6 backup freshness. The advisory above says "not in the default
  // backup set"; this one answers the operational question the advisory cannot:
  // how long has it been since a real encrypted export landed on disk?
  let backupInfo = { dir: null, found: false, backups: [], latestAgeDays: null, latestHuman: null };
  try {
    const scanned = collectBackupExports(paths, io, errors);
    backupInfo = { ...scanned, latestAgeDays: null, latestHuman: null };
    if (scanned.backups.length > 0) {
      const latest = scanned.backups[0];
      const t = latest.mtime ? new Date(latest.mtime) : null;
      const ageDays = t ? Math.max(0, Math.floor((now.getTime() - t.getTime()) / 864e5)) : null;
      backupInfo.latestAgeDays = ageDays;
      backupInfo.latestHuman = t
        ? ageDays + ' 天前（' + latest.file + '，' + mbLabel(latest.size) + '）'
        : latest.file;
    }
    const staleDays = settingValue(settings, 'threshold.backupStaleDays');
    const never = !scanned.found || scanned.backups.length === 0;
    const tooOld = backupInfo.latestAgeDays != null && backupInfo.latestAgeDays > staleDays;
    findings.push({
      id: 'backup-freshness',
      severity: never ? 'warning' : tooOld ? 'warning' : 'info',
      category: '备份覆盖',
      title: never
        ? '没有找到任何加密备份文件'
        : tooOld
          ? '上次加密备份是 ' + backupInfo.latestAgeDays + ' 天前（超过 ' + staleDays + ' 天）'
          : '上次加密备份：' + backupInfo.latestHuman,
      detail: never
        ? '在 ' + (scanned.dir || '导出目录') + ' 下未找到 .zip 备份。易失数据（sessions/pluginData/pluginAssets/Mnemon）不在默认备份分区里，且本机从未启用过定时备份（backup-schedule.json 不存在）。'
        : '共 ' + scanned.backups.length + ' 份导出；最新一份 ' + backupInfo.latestHuman + '。默认备份不包含 sessions/pluginData/pluginAssets，真实保护靠这份手动导出。'
          + (tooOld ? '超过 ' + staleDays + ' 天未更新，期间新增的会话与知识不在任何备份里。' : ''),
      evidence: (scanned.dir || '')
        + (scanned.backups.length
          ? ' → ' + scanned.backups.slice(0, 5).map((b) => b.file).join('、')
            + (scanned.backups.length > 5 ? ' 等共 ' + scanned.backups.length + ' 份' : '')
          : ''),
      recommendation: never || tooOld
        ? '在插件面板的「加密备份」卡里预览后执行（口令只在本次请求内存在，不经会话记录）；或在 GUI 里手动加密导出。'
        : '保持现状；下次会话量明显增长后再导一次。',
      data: {
        dir: scanned.dir,
        count: scanned.backups.length,
        countNote: scanned.backups.length > 5 ? 'evidence 只列前 5 份，data.backups 含全部' : null,
        latestAgeDays: backupInfo.latestAgeDays,
        staleDays,
        backups: scanned.backups.slice(0, 5),
      },
    });
  } catch (e) {
    errors.push({ step: 'backup-freshness', error: String((e && e.message) || e) });
  }

  // ④ v0.7.6 config drift. Compare cordis.patch.yml / package.json digests
  // against the baseline recorded on the previous run. We never write the
  // config: the only side effect is the baseline file the host passes back in.
  let configNow = [];
  try {
    configNow = collectConfigFingerprint(paths, io, errors);
    const prev = Array.isArray(options.configBaseline) ? options.configBaseline : [];
    const prevKey = (x) => x.dir + '|' + x.file;
    const prevMap = new Map(prev.map((x) => [prevKey(x), x]));
    const changed = [];
    const added = [];
    for (const cur of configNow) {
      const old = prevMap.get(prevKey(cur));
      if (!old) { added.push(cur); continue; }
      if (old.digest !== cur.digest) {
        changed.push({
          file: cur.file,
          dir: cur.dir,
          bytes: cur.bytes,
          lines: cur.lines,
          fromBytes: old.bytes,
          fromLines: old.lines,
          deltaLines: (cur.lines || 0) - (old.lines || 0),
        });
      }
    }
    const shrunk = changed.filter((c) => c.deltaLines < -settingValue(settings, 'threshold.driftShrinkLines'));
    if (changed.length > 0) {
      const lines = changed.map((c) =>
        '· ' + c.file + '：' + (c.fromLines != null ? c.fromLines + ' → ' : '') + c.lines + ' 行'
          + (c.deltaLines ? '（' + (c.deltaLines > 0 ? '+' : '') + c.deltaLines + '）' : '')
          + '，' + mbLabel(c.bytes)).join('\n');
      findings.push({
        id: 'config-drift',
        severity: shrunk.length > 0 ? 'warning' : 'info',
        category: '配置完整性',
        title: shrunk.length > 0
          ? '配置文件明显变短了：' + shrunk.map((c) => c.file).join('、')
          : '配置自上次体检后有改动（' + changed.length + ' 个文件）',
        detail: lines
          + (shrunk.length > 0
            ? '\n行数大幅减少是恢复/重置流程（sanitizeProfile 写默认 stub）的典型痕迹，曾有过静默丢 providers / 模型 / 权限预设的报告。'
            : '\n如果是你自己改的，忽略即可；如果没改过，值得看一眼。'),
        evidence: '指纹：' + changed.map((c) => c.file + '=' + (c.lines || 0) + '行').join('、') + '；基线来自上次体检（本机记录）',
        recommendation: shrunk.length > 0
          ? '先备份当前 cordis.patch.yml（或找 .bak-<epoch> 兄弟文件），再对比差异；旧配置禁止整体回灌。管家只读不改 patch。'
          : '无需处理。若确认改动是有意的，下次体检会以新内容作为基线。',
        data: { changed, shrunk: shrunk.map((c) => c.file), added: added.map((a) => a.file) },
      });
    } else if (configNow.length > 0 && prev.length === 0) {
      findings.push({
        id: 'config-drift',
        severity: 'info', category: '配置完整性',
        title: '已记录配置指纹作为基线（首次）',
        detail: configNow.map((c) => '· ' + c.file + '：' + c.lines + ' 行，' + mbLabel(c.bytes)).join('\n')
          + '\n从下一次体检起，这两个文件一旦变化就会在这里提示；变短会升为 warning。',
        evidence: 'cordis.patch.yml / package.json 的 sha256 前 16 位',
        recommendation: '无需处理。这条用于日后发现「配置被悄悄换掉」。',
        data: { baseline: configNow, added: [], shrunk: [], changed: [] },
      });
    }
  } catch (e) {
    errors.push({ step: 'config-drift', error: String((e && e.message) || e) });
  }

  // ③ v0.3.0 upgrade-compatibility check: engines.dsh declared by installed
  // bundles vs the actual host dsh-base version. This is the only half of pain
  // point ① nobody else covers (the host gate blocks NEW installs; it cannot
  // re-audit what is already installed after a host update).
  let compat = { hostVersion: null, entries: [] };
  try {
    // v0.4 hostVersion source chain: explicit option → newest crash log's
    // meta.app ("@deepseek-ai/dsh-desktop 0.2.2-rc.1" — the desktop app version
    // IS the host version) → null (只列声明不判等). @deepseek-ai/dsh-base is not
    // resolvable in the profile node_modules on this install (probed 2026-11-09,
    // MODULE_NOT_FOUND), so meta.app is the primary real source.
    let hostVersion = options.hostVersion || null;
    if (!hostVersion) {
      for (const c of crashes) {
        const app = c && c.meta && c.meta.app;
        if (typeof app !== 'string') continue;
        const m = /\s(\d+\.\d+\.\d+[^\s]*)/.exec(app);
        if (m) { hostVersion = m[1]; break; }
      }
    }
    compat = collectCompat(paths, io, hostVersion);
    const mismatched = compat.entries.filter((e) => e.state === 'mismatch');
    const unknown = compat.entries.filter((e) => e.state === 'unknown');
    if (!compat.hostVersion) {
      findings.push({
        id: 'compat-check', severity: 'info', category: '版本适配',
        title: '升级兼容体检：宿主版本未确定，只列声明',
        detail: `读到 ${compat.entries.length} 个包声明了 engines.dsh 门槛，但当前宿主版本无法确定（既没有显式传入，crash 日志 meta.app 也没有版本）。按红线不做猜测，只列声明不判等。`,
        evidence: '来源：profile node_modules 各包 package.json 的 engines.dsh；宿主版本源候选：options.hostVersion → crash meta.app',
        recommendation: '宿主升级后重新体检；若 crash 日志也没有版本行，可在体检时显式传 options.hostVersion。',
        data: { hostVersion: null, declared: compat.entries.length, entries: compat.entries.slice(0, 40) },
      });
    } else if (mismatched.length > 0) {
      findings.push({
        id: 'compat-check', severity: 'warning', category: '版本适配',
        title: `${mismatched.length} 个已装包的宿主版本门槛不满足当前宿主`,
        detail: '当前宿主 ' + compat.hostVersion + '，以下包声明的范围不含它——它们是「升级后最先出问题」的候选：\n'
          + mismatched.map((e) => `· ${e.name}@${e.version} 需要 ${e.range}`).join('\n')
          + (unknown.length ? `\n（另有 ${unknown.length} 个声明无法判定，未计入）` : ''),
        evidence: '判据：semver 范围本地实现（支持 >= <= > < ^ = 与 || 并集）；数据源 profile node_modules/*/package.json engines.dsh',
        recommendation: '优先核对这些包的更新版本；宿主已装清单里市场不会替你重审旧包，这是 pre-flight 的存量半边。管家不改安装状态。',
        data: { hostVersion: compat.hostVersion, mismatched, unknown: unknown.length, declared: compat.entries.length },
      });
    } else {
      findings.push({
        id: 'compat-check', severity: 'info', category: '版本适配',
        title: `升级兼容体检通过：${compat.entries.length} 个声明门槛的包都适配宿主 ${compat.hostVersion}`,
        detail: unknown.length
          ? `其中 ${unknown.length} 个声明写法超出本地判据范围，标记为未判定而非通过。`
          : '所有已声明 engines.dsh 的包，其范围都包含当前宿主版本。',
        evidence: '判据：semver 范围本地实现；数据源 profile node_modules/*/package.json engines.dsh',
        recommendation: '宿主升级后重新体检即可复查存量适配。',
        data: { hostVersion: compat.hostVersion, declared: compat.entries.length, unknown: unknown.length },
      });
    }
  } catch (e) {
    errors.push({ step: 'compat-check', error: String(e && e.message || e) });
  }

  // ⑨ v0.9.3 client 标识体检（boot 的第三道盲区）。dshmarket 的静态体检按
  // loader entry id / bundle 名统计，trial boot 回放的是 loader 组合树——两者
  // 都看不见渲染端的 client 工厂表。2026-11-09 那次「整个 Web UI 起不来」就是
  // 从这个缝里漏过去的。判据只看磁盘，不启动任何东西。
  let clientIdentity = { entries: [], sameReal: [], drifted: [], collisions: [], unreadable: 0, withoutId: 0, scanned: 0 };
  try {
    clientIdentity = collectClientIdentity(paths, io, errors);
    const realHits = clientIdentity.sameReal || [];
    const driftHits = clientIdentity.drifted || [];
    const collHits = clientIdentity.collisions || [];
    const total = (clientIdentity.entries || []).length;
    const blame = crashes.length > 0 ? (crashes[0].clientDuplicates || []) : [];
    if (realHits.length > 0 || driftHits.length > 0 || collHits.length > 0) {
      const lines = [];
      for (const hit of realHits) {
        lines.push('· 同一份代码被装成多个名字：' + hit.dirs.join(' 与 ') + ' 都指向 ' + hit.realpath);
      }
      for (const hit of driftHits) {
        lines.push('· ' + hit.dir + '：client.js 声明的 id 是 "' + hit.id + '"，但包名是 "' + hit.name + '"');
      }
      for (const hit of collHits) {
        lines.push('· 两个包用了同一个 client id "' + hit.id + '"：' + hit.names.join('、'));
      }
      findings.push({
        id: 'client-identity',
        severity: 'warning',
        category: '启动诊断',
        title: '发现 ' + (realHits.length + driftHits.length + collHits.length) + ' 处会让整个 Web UI 起不来的 client 标识冲突',
        detail: 'DSH 的渲染端按 `__ModuleLoader__.load({ id })` 里的 id 建工厂表，同一个 id 注册第二次会直接抛 '
          + '`client-modules: duplicate factory registration` 并让 boot 失败——一个重复 id，整个界面都打不开。\n'
          + lines.join('\n')
          + '\n这类状态不会被市场现有的体检抓到：静态体检按 loader entry id 与 bundle 名统计，trial boot 回放的也是 loader 层；'
          + 'client 工厂表在渲染端，两边都看不见。',
        evidence: '遍历 ' + total + ' 个含 dsh.client 的已装包，按 exports["./client"] 解析出入口，读其中 `__ModuleLoader__.load({ id })`，'
          + '并用 realpath 比对目录真身'
          + (blame.length > 0 ? '；最近一次崩溃日志也点名了重复 id：' + blame.join('、') : ''),
        recommendation: '按上面点名的路径清理：同一份代码只留一个 node_modules 名字（多出来的是旧改名残留，删链接即可）；'
          + 'id 与包名不一致的，把 client.js 里的 id 改成包名。管家只读不代改——这类动作会动别的包，不属于授权执行面。',
        data: {
          checked: total,
          sameReal: realHits.slice(0, 10),
          drifted: driftHits.slice(0, 10),
          collisions: collHits.slice(0, 10),
          unreadable: clientIdentity.unreadable,
          withoutId: clientIdentity.withoutId,
        },
      });
    } else if (total > 0) {
      findings.push({
        id: 'client-identity',
        severity: 'info',
        category: '启动诊断',
        title: 'client 标识体检通过：' + total + ' 个已装客户端包的 id 互不冲突且与包名一致',
        detail: '核对了三件事：没有同一份代码被装成两个名字、每个客户端入口声明的 id 与包名一致、没有两个包抢同一个 id。'
          + (clientIdentity.withoutId > 0
            ? '\n（其中 ' + clientIdentity.withoutId + ' 个包没在 client.js 里声明 id，按宿主约定走包名，不计入冲突。）'
            : '')
          + (clientIdentity.unreadable > 0
            ? '\n（另有 ' + clientIdentity.unreadable + ' 个包的 client.js 读不到，这次没能核对。）'
            : ''),
        evidence: '数据源：profile node_modules 下 ' + total + ' 个含 dsh.client 的包，入口按 exports["./client"] → dsh.client → lib/client.js 依次解析；realpath 用于识别同一份代码的多个名字',
        recommendation: '无需处理。这类冲突只在改包名或重复安装时出现，平时安静是正确的。',
        data: {
          checked: total,
          unreadable: clientIdentity.unreadable,
          withoutId: clientIdentity.withoutId,
        },
      });
    }
  } catch (e) {
    errors.push({ step: 'client-identity', error: String((e && e.message) || e) });
  }

  // ⑧ v0.9.1 模型健康：默认模型是你此刻真正在用的那一个，它挂了比任何配置问题
  // 都直接。判据来自 models.js（只探哨兵集、只标不判死）。这里只负责把结论
  // 变成一条 finding：没探过 -> 不报；探过且默认模型 ok -> info 一句；默认模型
  // 不是 ok -> warning，并给出可切换的替代。
  const health = options.modelHealth;
  // index.js 交给这里的是 { at, default, defaultVerdict, summary, suggest, ... }，
  // 摊平的计数在 summary 里。曾经直接读 health.probed，两边形状对不上，
  // 结果这条 finding 在真机上从不出现——单测用扁平形状喂进去反而过了。
  const mh = health && typeof health === 'object' && health.summary ? health.summary : health;
  if (mh && typeof mh === 'object' && Number(mh.probed) > 0) {
    const dv = health.defaultVerdict || { state: 'unprobed' };
    try {
      if (dv.state === 'dead' || (dv.state === 'busy' && health.defaultBusyRounds >= 2)) {
        const alt = health.suggest;
        findings.push({
          id: 'model-health',
          severity: 'warning',
          category: '模型可用性',
          title: '默认模型这会儿答不上来：' + health.default.provider + ' / ' + health.default.model,
          detail: (dv.state === 'dead'
            ? '探测结果是「这个模型已不存在」（404/422），不是网络问题。'
            : '探测连续两轮都拿不到内容（配额/网络/模型侧故障）。')
            + '\n这一轮共探了 ' + mh.probed + ' 个模型：' + mh.ok + ' 个正常、' + mh.dead + ' 个明确不可用、' + mh.busy + ' 个此刻不行。'
            + (alt
              ? '\n可切的替代：' + alt.provider + ' / ' + alt.model + (alt.sameProvider ? '（同一个服务商，换过去代价最小）' : '（另一个服务商）') + '。'
              : '\n这一轮没找到可推荐的替代——所有探过的模型都没正常回复，先查网络或配额。'),
          evidence: '探测口径：问答式单轮探针，超时 ' + Math.round((health.timeoutMs || 45000) / 1000) + ' 秒；判死仅限 HTTP 404/422，其余归为「此刻不行」；结果缓存 ' + Math.round((health.ttlMs || 3600000) / 60000) + ' 分钟。',
          recommendation: alt
            ? '在面板里点「切到这个模型」——走 plan→确认→审计，只改默认模型选择，不动任何插件配置。'
            : '先在模型设置里确认这个服务商的密钥/配额，再重新体检。',
          data: {
            default: health.default, state: dv.state, note: dv.note || '',
            probed: mh.probed, ok: mh.ok, dead: mh.dead, busy: mh.busy,
            deadModels: mh.deadModels || [], suggest: alt || null, at: health.at,
          },
        });
      } else if (dv.state === 'busy') {
        // 只忙了一轮：还不足以说它坏了（配额/冷却会自动恢复），但也不能一个字都不报 ——
        // 那条路会让用户以为「模型巡检根本没在跑」。给它 info：看得见、不报警。
        findings.push({
          id: 'model-health',
          severity: 'info',
          category: '模型可用性',
          title: '默认模型这一轮没答上来（第 ' + (Number(health.defaultBusyRounds) || 1) + ' 轮）：' + health.default.provider + ' / ' + health.default.model,
          detail: '探针没拿到内容，原因可能是配额、冷却或网络，不一定是模型坏了。'
            + '\n判据：只有 HTTP 404/422 才算「这个模型已不存在」；连续两轮都答不上来才会升成「严重」。'
            + (health.suggest ? '\n可以先切到 ' + health.suggest.provider + ' / ' + health.suggest.model + '，等它恢复再切回来。' : ''),
          evidence: health.at ? '最近一次巡检：' + health.at : '本轮巡检',
          recommendation: health.suggest
            ? '可以先点「切到这个模型」应急；不改也完全可以，下一轮巡检会再判一次。'
            : '不改也行，下一轮巡检会再判一次；连续两轮答不上来它才会变成严重。',
          data: {
            default: health.default, state: 'busy', ms: dv.ms,
            probed: mh.probed, ok: mh.ok, dead: mh.dead, busy: mh.busy,
            deadModels: mh.deadModels || [], suggest: health.suggest || null, at: health.at,
          },
        });
      } else if (dv.state === 'ok') {
        const suspect = (mh.providers || []).filter((p) => p && p.offlineTwoRounds);
        findings.push({
          id: 'model-health',
          severity: 'info',
          category: '模型可用性',
          title: '默认模型可用（' + (dv.ms != null ? dv.ms + ' ms' : '已探通') + '）',
          detail: '这一轮探了 ' + mh.probed + ' 个模型（默认模型 + 每个服务商前几个）：'
            + mh.ok + ' 个正常、' + mh.dead + ' 个明确不可用、' + mh.busy + ' 个此刻不行。'
            + (suspect.length > 0
              ? '\n连续两轮都不可用的服务商：' + suspect.map((p) => p.provider).join('、') + '。'
              : '')
            + '\n「此刻不行」不算坏：配额与冷却会自动恢复，所以管家只标出来，不把它们从选择器里删。',
          evidence: health.at ? '最近一次巡检：' + health.at : '本轮巡检',
          recommendation: suspect.length > 0
            ? '那些服务商可能是密钥或配额问题；默认模型不受影响，可以不当急事。'
            : '无需处理。',
          data: {
            default: health.default, state: 'ok', ms: dv.ms,
            probed: mh.probed, ok: mh.ok, dead: mh.dead, busy: mh.busy,
            deadModels: mh.deadModels || [], offlineTwoRounds: suspect.map((p) => p.provider), at: health.at,
          },
        });
      }
    } catch (e) {
      errors.push({ step: 'model-health', error: String((e && e.message) || e) });
    }
  }

  // ⑤ v0.7.7 confidence self-check. A report is only as good as what it managed
  // to read. This records, per collector, whether the source was actually
  // available — so "no problems found" can be distinguished from "I couldn't
  // look". The panel surfaces it as a banner when the coverage is thin; the
  // report never silently upgrades "unknown" to "fine".
  const coverage = {
    crashLogs: crashes.length > 0 ? 'data' : 'empty',
    patchConfig: (() => {
      const hit = configNow.find((c) => c.file === 'cordis.patch.yml');
      return hit ? 'data' : 'unavailable';
    })(),
    backupExports: !backupInfo.found ? 'unavailable' : backupInfo.backups.length > 0 ? 'data' : 'empty',
    workspaces: workspaceInfo.available ? (workspaceInfo.workspaces.length > 0 ? 'data' : 'empty') : 'unavailable',
    updates: updateInfo.available ? (updateInfo.checked > 0 ? 'data' : 'empty') : 'unavailable',
    compat: compat.entries.length > 0 ? 'data' : 'empty',
    clientIdentity: (clientIdentity.entries || []).length > 0
      ? 'data'
      : (clientIdentity.scanned > 0 ? 'empty' : 'unavailable'),
  };
  if (coverage.patchConfig === 'unavailable' && backupInfo.found) {
    // An empty profile dir is the only reason patch is unavailable; that is a
    // missing install, not a broken read. Keep it visible but not alarming.
    coverage.patchConfig = 'empty';
  }
  const unavailable = Object.entries(coverage).filter(([, v]) => v === 'unavailable').map(([k]) => k);
  const totalChecked = Object.values(coverage).filter((v) => v === 'data').length;
  coverage.unavailable = unavailable;
  coverage.sourcesWithData = totalChecked;
  coverage.sourcesTotal = Object.keys(coverage).filter((k) => k !== 'unavailable' && k !== 'sourcesWithData' && k !== 'sourcesTotal').length;
  try {
    if (unavailable.length > 0) {
      findings.push({
        id: 'confidence',
        severity: unavailable.length >= 3 ? 'warning' : 'info',
        category: '体检可信度',
        title: unavailable.length + ' 个数据源这次没读到，结论可能不完整',
        detail: '读不到：' + unavailable.join('、') + '。\n'
          + '这意味着对应体检项可能报「没发现问题」，但那不是「真的没问题」，是「没看见」。\n'
          + '其余 ' + totalChecked + ' 个数据源正常。',
        evidence: '采集告警 ' + errors.length + ' 条'
          + (errors.length
            ? '：' + errors.slice(0, 3).map((e) => e.step).join('、')
              + (errors.length > 3 ? ' 等 ' + errors.length + ' 条（完整见 data.errors）' : '')
            : ''),
        recommendation: '按对应项的取数路径排查（如市场缓存需先打开一次插件列表页）。管家宁可不报，也不会把「没读到」写成「合格」。',
        data: {
          coverage,
          errors: errors.map((e) => ({ step: e.step, error: String(e.error) })),
        },
      });
    } else if (errors.length > 0) {
      findings.push({
        id: 'confidence', severity: 'info', category: '体检可信度',
        title: '全部主要数据源都读到了（' + totalChecked + '/' + coverage.sourcesTotal + '），采集告警 ' + errors.length + ' 条',
        detail: '采集过程中有少量次要不完整，已在报告的 errors 里留档；不影响主要结论。',
        evidence: errors.slice(0, 5).map((e) => e.step + ': ' + e.error).join('\n')
          + (errors.length > 5 ? '\n… 另 ' + (errors.length - 5) + ' 条（完整见 data.errors）' : ''),
        recommendation: '无需处理。',
        data: {
          coverage,
          errors: errors.map((e) => ({ step: e.step, error: String(e.error) })),
        },
      });
    }
  } catch (e) {
    errors.push({ step: 'confidence', error: String((e && e.message) || e) });
  }

  // ③ v0.3.1 knowledge recall: match current active findings against the
  // steward's own append-only knowledge log. When the same finding was seen
  // before, surface that prior record inline — "上次也是这样、当时记了什么".
  // This is the line between a measuring instrument and a caretaker. Read-only;
  // a missing/corrupt knowledge log simply yields no recalls (never degrades).
  const knowledgeLog = Array.isArray(options.knowledge) ? options.knowledge : [];
  const priorById = new Map();
  for (const k of knowledgeLog) {
    if (!k || !Array.isArray(k.findingIds)) continue;
    for (const id of k.findingIds) {
      if (typeof id !== 'string') continue;
      const prev = priorById.get(id);
      // Keep the MOST RECENT record per finding id (recall the latest lesson).
      if (!prev || String(k.at || '') > String(prev.at || '')) priorById.set(id, k);
    }
  }
  for (const f of findings) {
    const hit = priorById.get(f.id);
    if (hit && String(hit.at || '') < String(now.toISOString ? now.toISOString() : now)) {
      f.recall = {
        at: hit.at,
        headline: hit.headline,
        counts: hit.counts,
      };
    }
  }

  // Mute (ack) layer: user-acknowledged findings keep their evidence but stop
  // counting toward risk level. Reversible via kind=unack. v0.7.7: an ack that
  // carried an expiresAt stops suppressing once it lapses — silence is a note
  // about "right now", not a permanent gag. Entries without expiresAt keep the
  // old permanent behaviour so pre-existing acks do not suddenly reappear.
  const ackedRaw = Array.isArray(options.acked) ? options.acked : [];
  const ackedIds = new Set(
    ackedRaw
      .filter((a) => {
        if (!a) return false;
        const exp = a && typeof a === 'object' ? a.expiresAt : null;
        if (!exp) return true;
        const t = Date.parse(exp);
        if (!isFinite(t)) return true;
        return t > now.getTime();
      })
      .map((a) => (a && typeof a === 'object' ? a.id : a))
      .filter((x) => typeof x === 'string'),
  );
  const feedbackRaw = Array.isArray(options.feedback) ? options.feedback : [];
  const feedbackIds = new Set(
    feedbackRaw
      .filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      .map((a) => a.id),
  );
  let mutedCount = 0;
  for (const f of findings) {
    f.muted = ackedIds.has(f.id);
    f.falsePositive = feedbackIds.has(f.id);
    if (f.muted) mutedCount += 1;
  }

  // Importance scoring (v0.3.2) — runs AFTER the mute layer so "actionable"
  // honours the user's ack. Four observable factors, each stated in
  // f.scoreReasons: severity base (60/40/20) ± freshness (this process
  // lifetime) + actionable (one-click authorized path exists) + magnitude
  // (how big the evidence is). Auditable number, never a black box.
  try {
    scoreFindings(findings, { bootedAt });
  } catch (e) {
    errors.push({ step: 'priority-score', error: String(e && e.message || e) });
  }

  const counts = { critical: 0, warning: 0, info: 0, muted: mutedCount };
  for (const f of findings) if (!f.muted && counts[f.severity] != null) counts[f.severity] += 1;
  const level = counts.critical > 0 ? 'critical' : counts.warning > 0 ? 'warning' : 'ok';
  const headline = counts.critical > 0
    ? '发现启动崩溃记录，请优先看「启动诊断」'
    : counts.warning > 0
      ? '有需要留意的风险项'
      : '当前未发现异常，以下为常备建议';
  const trendVerdict = summarizeTrend(options.previous, { level, counts });

  return {
    generatedAt: now.toISOString ? now.toISOString() : String(now),
    host: { platform, arch: process.arch, node: process.version, dshHome: paths.dshHome },
    cFreeBytes,
    backup: backupInfo,
    config: configNow,
    workspace: workspaceInfo,
    updates: updateInfo,
    coverage,
    status: errors.length > 0 ? 'degraded' : 'ok',
    findings,
    summary: { level, headline, counts },
    trendVerdict,
    limitations: [
      '只读：不删文件、不代跑提权命令、不自动拉起/重启、不改启动流程。',
      '不重复实现磁盘扫描 / 备份 / 归档 / 记忆，只指向现成能力。',
      '不 import 任何其它 DSH 包内部模块，避免版本漂移。',
      '崩溃检测是「启动后读日志」，不是实时守护；本进程内事件随宿主 fatal 消失。',
      '采集限流：日志 ≤ ' + limits.maxLogs + ' 份、单份 ≤ ' + limits.maxBytesPerLog + ' B（可在面板「设置」里调）。',
    ],
    errors,
  };
}

export default collectReport;
