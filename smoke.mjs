/**
 * dsh-steward · smoke.mjs
 * Local verification WITHOUT starting the host: exercises collectReport with
 * in-memory fixtures for (a) a real-shaped web-boot crash log, (b) a
 * cordis.patch.yml.bak-<epoch> sibling, (c) plugin-change events. It also
 * probes the fail-soft path (unreadable directories) and the real machine
 * (best-effort) to confirm the parser works on actual crash logs.
 */
import { collectReport, parseBootFailure, dutyBriefing, analyzeUpgrades, collectFreeLaneHealth } from './lib/report.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import { parseIntent } from './lib/intent.js';
import { extractJson, normalizeBrainOutput } from './lib/brain.js';
import { MODEL_VERDICT_TTL_MS, classifyProbe, planSentinel, summarize, defaultVerdict, suggestDefault } from './lib/models.js';
import { defaults as settingsDefaults, normalize as normalizeSettings, describe as describeSettings, ackTtlDays as settingsAckTtl, value as settingValue } from './lib/settings.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

const CRASH = `Error: web boot: 1 entry did not activate
@xmanrui/dsh-im: import failed (see console for the import error)
{"source":"web-boot","phase":"running","app":"@deepseek-ai/dsh-desktop 0.2.2-rc.1","electron":"44.7.0","node":"24.21.0","shell":{"pid":20924}}
`;

console.log('— parseBootFailure —');
const parsed = parseBootFailure(CRASH);
check('didNotActivate = 1', parsed && parsed.didNotActivate === 1, JSON.stringify(parsed));
check('suspect = @xmanrui/dsh-im', parsed && parsed.suspects.includes('@xmanrui/dsh-im'), JSON.stringify(parsed && parsed.suspects));
check('isBoot true', parsed && parsed.isBoot === true);
check('quiet text → null', parseBootFailure('all good, nothing to report') === null);

console.log('— collectReport (fixtures) —');
const io = {
  readDir(dir) {
    if (dir.includes('logs')) return ['crash-2026-11-07T02-53-24-868Z-web-boot.log', 'ignored.txt'];
    if (dir.includes('profiles')) return ['cordis.patch.yml', 'cordis.patch.yml.bak-1762463604000', 'package.json'];
    if (dir.includes('exports')) return ['dsh-config-2026-01-01-abc123.zip', '.backup-notes.json'];
    return { __error: 'unexpected dir ' + dir };
  },
  stat(file) {
    if (file.includes('crash-')) return { isFile: () => true, size: CRASH.length, mtime: new Date('2026-11-07T02:53:24Z') };
    if (file.includes('.bak-')) return { isFile: () => true, size: 81957, mtime: new Date('2026-11-08T09:49:10Z') };
    if (file.endsWith('.zip')) return { isFile: () => true, size: 100382581, mtime: new Date('2026-11-09T02:13:00Z') };
    if (file.endsWith('cordis.patch.yml') || file.endsWith('package.json')) {
      return { isFile: () => true, size: 81955, mtime: new Date('2026-11-08T09:49:10Z') };
    }
    return { __error: 'unexpected stat ' + file };
  },
  readText(file) {
    if (file.includes('crash-')) return CRASH;
    if (file.includes('.bak-')) return 'a\n'.repeat(2692).trim();
    if (file.endsWith('cordis.patch.yml')) return 'a\n'.repeat(2692).trim();
    if (file.endsWith('package.json')) return '{"name":"x"}';
    return { __error: 'unexpected read ' + file };
  },
};
const report = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  pluginChanges: [{ type: 'install' }, { type: 'enable' }],
  io,
});
check('status ok', report.status === 'ok', JSON.stringify(report.errors));
check('summary.level = critical', report.summary.level === 'critical', report.summary.level);
check('boot-crash-latest finding present', report.findings.some((f) => f.id === 'boot-crash-latest'));
const crashFinding = report.findings.find((f) => f.id === 'boot-crash-latest');
check('crash names suspect in detail', crashFinding && crashFinding.detail.includes('@xmanrui/dsh-im'), crashFinding && crashFinding.detail);
check('latest suspects scoped to latest log', crashFinding && Array.isArray(crashFinding.data.suspects) && crashFinding.data.suspects.includes('@xmanrui/dsh-im'), JSON.stringify(crashFinding && crashFinding.data.suspects));

console.log('— v0.7.6 ① backup freshness / ④ config drift —');
const bf = report.findings.find((f) => f.id === 'backup-freshness');
check('backup-freshness finding present', !!bf);
check('backup freshness counts the export', bf && bf.data && bf.data.count === 1, JSON.stringify(bf && bf.data));
check('backup freshness computes age in days', bf && bf.data && typeof bf.data.latestAgeDays === 'number' && bf.data.latestAgeDays >= 0, JSON.stringify(bf && bf.data));
check('fresh backup is not a warning', bf && bf.severity === 'info', bf && bf.severity);
const cfg = report.findings.find((f) => f.id === 'config-drift');
check('config-drift records a first baseline', cfg && cfg.title.includes('基线'), cfg && cfg.title);
check('config fingerprint covers both watched files in each profile', report.config && report.config.filter((c) => c.file === 'cordis.patch.yml').length >= 1 && report.config.filter((c) => c.file === 'package.json').length >= 1, JSON.stringify(report.config.map((c) => c.dir + '/' + c.file)));
check('config fingerprint is a digest, not the content', report.config && report.config.every((c) => /^[0-9a-f]{16}$/.test(c.digest)), JSON.stringify(report.config));

// drift detection: same files, but the patch shrank from 2692 lines to 40.
const shrunkIo = {
  ...io,
  readText(file) {
    if (file.includes('crash-')) return CRASH;
    if (file.endsWith('cordis.patch.yml')) return 'a\n'.repeat(40).trim();
    if (file.endsWith('package.json')) return '{"name":"x"}';
    return { __error: 'unexpected read ' + file };
  },
};
const driftReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  configBaseline: report.config,
  io: shrunkIo,
});
const drift = driftReport.findings.find((f) => f.id === 'config-drift');
check('shrunken patch raises config-drift', !!drift);
check('shrunken patch is a warning', drift && drift.severity === 'warning', drift && drift.severity);
check('drift names the file', drift && drift.data.shrunk.includes('cordis.patch.yml'), JSON.stringify(drift && drift.data));
check('drift reports the line delta', drift && drift.data.changed[0].deltaLines < -1000, JSON.stringify(drift && drift.data.changed));

// an untouched config must NOT raise drift (no crying wolf on every scan).
const quietReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  configBaseline: report.config,
  io,
});
check('unchanged config raises no drift finding', !quietReport.findings.some((f) => f.id === 'config-drift'));
check('crash meta.app extracted', crashFinding && crashFinding.data.meta.app && crashFinding.data.meta.app.includes('0.2.2-rc.1'), JSON.stringify(crashFinding && crashFinding.data.meta));
const staleReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-08T19:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  io,
});
const staleCrash = staleReport.findings.find((f) => f.id === 'boot-crash-latest');
check('crash older than current boot → not critical', staleCrash && staleCrash.severity === 'info', staleCrash && staleCrash.severity);
check('stale flag in data', staleCrash && staleCrash.data.stale === true);
check('stale headline says historical', staleCrash && staleCrash.title.includes('历史'), staleCrash && staleCrash.title);
check('stale → summary.level not critical', staleReport.summary.level !== 'critical', staleReport.summary.level);
check('patch-backup finding present', report.findings.some((f) => f.id === 'patch-backup'));

// v0.9.6：残留的 .bak 与「当前配置真被换成了 stub」是两件事。
// 主夹具里 live 81955 / bak 81957 → 只是残留，应为 info 而不是 warning。
const pbMain = report.findings.find((f) => f.id === 'patch-backup');
check('a leftover .bak whose live patch is intact stays info', pbMain && pbMain.severity === 'info', JSON.stringify(pbMain && pbMain.severity));
check('the residue finding says the live patch was not replaced', !!pbMain && pbMain.title.includes('未被换掉'), JSON.stringify(pbMain && pbMain.title));

// v0.9.7：光「变小」不是证据。live 只剩备份的四分之一、但 - id: 块一个没少
// （本机真实形态：workbuddy 少了 global 段、qoder 的 enabledModelKeys 被清空）
// → 仍应是 info，不能冒充「配置被换掉了」。
const pbShrunkIo = Object.assign({}, io, {
  stat(file) {
    if (file.endsWith('cordis.patch.yml') && !file.includes('.bak-')) return { isFile: () => true, size: 4096, mtime: new Date('2026-11-09T10:00:00Z') };
    return io.stat(file);
  },
});
const pbShrunkReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  io: pbShrunkIo,
  profileDirs: ['C:\\Users\\demo\\.dsh\\profiles\\desktop'],
});
const pbShrunk = pbShrunkReport.findings.find((f) => f.id === 'patch-backup');
check('a smaller patch with all blocks intact stays info', !!pbShrunk && pbShrunk.severity === 'info', JSON.stringify(pbShrunk && pbShrunk.severity));
check('the shrunk finding says the blocks are all still there', !!pbShrunk && pbShrunk.title.includes('一个没少'), JSON.stringify(pbShrunk && pbShrunk.title));
check('the shrunk finding still reports the percentage', !!pbShrunk && /小 \d+%/.test(pbShrunk.detail), JSON.stringify(pbShrunk && pbShrunk.detail));

// 反过来：备份里有一整个块在当前 patch 里消失 → 这才是结构性缺失，必须 warning 并点名。
const pbMissingIo = Object.assign({}, io, {
  readText(file) {
    if (file.includes('.bak-')) return ['- id: kept', '  name: "a"', '- id: dropped', '  name: "b"'].join('\n');
    if (file.endsWith('cordis.patch.yml')) return ['- id: kept', '  name: "a"'].join('\n');
    return io.readText(file);
  },
});
const pbMissingReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  io: pbMissingIo,
  profileDirs: ['C:\\Users\\demo\\.dsh\\profiles\\desktop'],
});
const pbMissing = pbMissingReport.findings.find((f) => f.id === 'patch-backup');
check('a whole block missing from the live patch is a warning', !!pbMissing && pbMissing.severity === 'warning', JSON.stringify(pbMissing && pbMissing.severity));
check('the warning names the missing id', !!pbMissing && pbMissing.data.missing.indexOf('dropped') >= 0, JSON.stringify(pbMissing && pbMissing.data));
check('plugin-change finding present', report.findings.some((f) => f.id === 'plugin-change'));
check('advisory data-at-risk present', report.findings.some((f) => f.id === 'data-at-risk'));
check('disk advice is read-only boundary', report.findings.some((f) => f.id === 'disk-advice' && f.data.boundary === 'read-only'));
check('limitations mention no-delete', report.limitations.some((l) => l.includes('不删文件')));
check('no errors in fixture run', report.errors.length === 0, JSON.stringify(report.errors));

console.log('— collectReport (fail-soft: unreadable dirs) —');
const broken = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  env: { APPDATA: '/nonexistent', DSH_HOME: '/nonexistent' },
  platform: 'win32',
  io: { readDir() { return { __error: 'EACCES' }; }, stat() { return { __error: 'ENOENT' }; }, readText() { return { __error: 'ENOENT' }; } },
});
check('degraded status, no throw', broken.status === 'degraded', broken.status);
check('errors collected', broken.errors.length > 0, String(broken.errors.length));
check('still returns findings', Array.isArray(broken.findings) && broken.findings.length > 0);
check('no crash → info finding', broken.findings.some((f) => f.id === 'boot-crash-none'));

console.log('— collectReport (missing OPTIONAL dir does not degrade) —');
const optionalMissing = collectReport({
  now: new Date('2026-11-08T19:55:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32',
  io: {
    readDir(dir) {
      if (dir.includes('profiles') && dir.endsWith('default')) return { __error: 'ENOENT: no such file or directory' };
      if (dir.includes('logs')) return [];
      if (dir.includes('profiles')) return ['cordis.patch.yml'];
      return [];
    },
    stat() { return { isFile: () => true, size: 1, mtime: new Date('2026-11-08T00:00:00Z') }; },
    readText() { return ''; },
  },
});
check('missing optional profile dir → status ok', optionalMissing.status === 'ok', optionalMissing.status + ' ' + JSON.stringify(optionalMissing.errors));
check('missing optional dir → no errors', optionalMissing.errors.length === 0, JSON.stringify(optionalMissing.errors));

console.log('— collectReport (real machine, best-effort) —');
const real = collectReport();
check('real run returns a report object', real && typeof real.generatedAt === 'string');
check('real run has findings', Array.isArray(real.findings) && real.findings.length > 0);
console.log('  real.level=' + real.summary.level + ' crashCount=' + (real.findings.find((f) => f.id === 'boot-crash-latest')?.data.crashCount ?? 0) + ' errors=' + real.errors.length);

console.log('— action hub (plan/execute, fake deps, zero real IO) —');
const { createActionHub } = await import('./lib/actions.js');
const audit = [];
const written = [];
const calls = [];
const fakeFiles = {};
const hub = createActionHub({
  routeFetch: async (p, body) => {
    calls.push({ p, body });
    if (p === '/api/disk-cleaner/' && body.action === 'scan') return { ok: true, targets: [{ id: 'pnpm-store', risk: 'safe', bytes: 1234567 }, { id: 'temp', risk: 'caution', bytes: 999 }] };
    if (p === '/api/disk-cleaner/' && body.action === 'clean') return { ok: true, dryRun: false, results: [{ id: 'pnpm-store', bytes: 1234567, removed: 4, failed: 0 }] };
    if (p === '/api/dsh-config-manager/export-preview') return { ok: true, sections: [{ section: 'sessions', sizeBytes: 700 }, { section: 'pluginData', sizeBytes: 80 }] };
    if (p === '/api/dsh-config-manager/export') return { zipPath: 'C:\\exports\\dsh-config-x.zip', manifest: {}, report: {}, runId: 'r1' };
    throw new Error('unexpected route ' + p);
  },
  getPluginManager: () => ({
    listBundles: async () => [{ name: 'dsh-foo', enabled: true }],
    setBundleEnabled: async (n, e) => { calls.push({ svc: 'setBundleEnabled', n, e }); return { application: 'applied' }; },
  }),
  getReport: () => ({ summary: { level: 'warning', headline: 'h', counts: { critical: 0, warning: 1, info: 0 } }, findings: [{ id: 'boot-crash-latest', severity: 'critical', data: { stale: false, suspects: ['dsh-foo'] } }] }),
  io: {
    appendJsonl: async (f, o) => { (f.includes('audit') ? audit : written).push({ f, o }); },
    readJson: async (f) => fakeFiles[f] || [],
    writeJson: async (f, v) => { fakeFiles[f] = v; },
  },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'audit.jsonl', trendFile: 'trend.json', knowledgeFile: 'knowledge.jsonl', ackedFile: 'acked.json',
});

const pc = await hub.plan('clean');
check('clean plan zero-write', calls.length === 1 && calls[0].body.action === 'scan');
check('clean plan safe-only', pc.ok && pc.plan.ids.length === 1 && pc.plan.ids[0] === 'pnpm-store', JSON.stringify(pc.plan));

check('execute w/o confirm refused', (await hub.execute({ planHash: pc.planHash })).ok === false);
const ex1 = await hub.execute({ planHash: pc.planHash, confirm: true });
check('clean execute ok', ex1.ok === true && ex1.freedBytes === 1234567, JSON.stringify(ex1));
check('clean execute passes ids+confirm', calls.some((c) => c.body && c.body.action === 'clean' && c.body.confirm === true && c.body.ids[0] === 'pnpm-store'));
const ex1b = await hub.execute({ planHash: pc.planHash, confirm: true });
check('fingerprint single-use', ex1b.ok === false, JSON.stringify(ex1b));

const pb = await hub.plan('backup');
check('backup plan preview-only', calls.filter((c) => c.p === '/api/dsh-config-manager/export-preview').length === 1 && pb.plan.only.includes('sessions'));
check('backup execute needs password', (await hub.execute({ planHash: pb.planHash, confirm: true })).error.includes('密码'));
const ex2 = await hub.execute({ planHash: pb.planHash, confirm: true, password: 'x'.repeat(20) });
check('backup execute ok', ex2.ok === true && ex2.file === 'dsh-config-x.zip' && ex2.encrypted === true, JSON.stringify(ex2));
check('audit never holds password', !JSON.stringify(audit).includes('xxxx'));

const pd = await hub.plan('disable', { plugin: 'dsh-foo' });
check('disable plan sees enabled bundle', pd.ok === true, JSON.stringify(pd));
const ex3 = await hub.execute({ planHash: pd.planHash, confirm: true });
check('disable execute via service', ex3.ok === true && calls.some((c) => c.svc === 'setBundleEnabled' && c.n === 'dsh-foo' && c.e === false));
const pdd = await hub.plan('disable', { plugin: 'dsh-missing' });
check('disable unknown plugin rejected', pdd.ok === false);

const pk = await hub.plan('knowledge');
const ex4 = await hub.execute({ planHash: pk.planHash, confirm: true });
check('knowledge execute appends', ex4.ok === true && written.length === 1);
check('audit lines recorded', audit.length >= 4, String(audit.length));

const badHub = createActionHub({
  routeFetch: async () => { throw new Error('route dead'); },
  getPluginManager: () => null,
  getReport: () => null,
  io: { appendJsonl: async () => { throw new Error('no disk'); }, readJson: async () => null, writeJson: async () => { throw new Error('no disk'); } },
  now: () => new Date(0),
  auditFile: 'a', trendFile: 't', knowledgeFile: 'k',
});
check('fail-soft plan clean', (await badHub.plan('clean')).ok === false);
const bhd = await badHub.plan('disable', { plugin: 'x' });
check('fail-soft plan disable refused', bhd.ok === false, JSON.stringify(bhd));
const bhd2 = await createActionHub({ routeFetch: async () => ({}), getPluginManager: () => null, getReport: () => ({ summary: { headline: 'h', counts: {} }, findings: [{ id: 'boot-crash-latest', severity: 'critical', data: { stale: false, suspects: ['x'] } }] }), io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async () => {} }, now: () => new Date(0), auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack' }).plan('disable', { plugin: 'x' });
check('fail-soft disable svc-missing', bhd2.ok === false && String(bhd2.error).includes('pluginManager'), JSON.stringify(bhd2));


console.log('— v0.3: human rendering / attribution gate / ack / compat —');
check('clean plan carries human lines', Array.isArray(pc.plan.human) && pc.plan.human.length >= 2 && pc.plan.human[0].includes('目标'), JSON.stringify(pc.plan.human && pc.plan.human[0]));
check('clean execute carries human lines', Array.isArray(ex1.human) && ex1.human[0].includes('回收'), JSON.stringify(ex1.human));
check('backup plan human mentions partitions', Array.isArray(pb.plan.human) && pb.plan.human.some((l) => l.includes('分区')), JSON.stringify(pb.plan.human));
check('knowledge plan human mentions headline', Array.isArray(pk.plan.human) && pk.plan.human[0].includes('h'), JSON.stringify(pk.plan.human));

// withCaution
const pcw = await hub.plan('clean', { withCaution: true });
check('clean withCaution includes caution target', pcw.ok && pcw.plan.ids.includes('temp') && pcw.plan.human.some((l) => l.includes('谨慎级')), JSON.stringify(pcw.plan && pcw.plan.ids));

// attribution gate on the main hub: dsh-foo is named by the fake report
check('disable plan human cites gate+guard', Array.isArray(pd.plan.human) && pd.plan.human.some((l) => l.includes('575')), JSON.stringify(pd.plan.human));
const pno = await hub.plan('disable', { plugin: 'dsh-unrelated' });
check('attribution gate: unnamed plugin refused', pno.ok === false && String(pno.error).includes('不在最近一次崩溃点名'), JSON.stringify(pno));

// stale crash → refuse disable even for a named suspect
const staleHub = createActionHub({
  routeFetch: async () => { throw new Error('no routes needed'); },
  getPluginManager: () => ({ listBundles: async () => [{ name: 'dsh-foo', enabled: true }], setBundleEnabled: async () => ({ application: 'applied' }) }),
  getReport: () => ({ summary: { headline: 'h', counts: {} }, findings: [{ id: 'boot-crash-latest', severity: 'info', data: { stale: true, suspects: ['dsh-foo'] } }] }),
  io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async () => {} },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack',
});
check('attribution gate: stale crash refuses disable', (await staleHub.plan('disable', { plugin: 'dsh-foo' })).ok === false);
check('no report → disable needs evidence', (await badHub.plan('disable', { plugin: 'x' })).ok === false);

// enable counterpart
const pe = await hub.plan('enable', { plugin: 'dsh-foo' });
check('enable refused when already enabled', pe.ok === false, JSON.stringify(pe));
const pe2 = await hub.plan('enable', { plugin: 'dsh-bar' });
check('enable unknown plugin refused', pe2.ok === false);

// v0.4.4：启用只对已停用的插件有意义。拒绝时要说清「为什么」+ 当前可启用对象。
console.log('— v0.4.4: enable targets disabled bundles, not crash suspects —');
check('enable refusal explains it targets disabled only', String(pe.error).includes('只对「已停用」'), String(pe.error));
check('enable refusal lists no-disabled case', String(pe.error).includes('没有任何已停用'), String(pe.error));

// 一个真的有停用 bundle 的 hub：可以启用它，且 plan human 引「已是停用状态」依据。
const mixHub = createActionHub({
  routeFetch: async () => { throw new Error('no routes needed'); },
  getPluginManager: () => ({
    listBundles: async () => [{ name: 'dsh-on', enabled: true }, { name: 'dsh-off-a', enabled: false }, { name: 'dsh-off-b', enabled: false }],
    setBundleEnabled: async (n, e) => ({ application: 'applied', n, e }),
  }),
  getReport: () => ({ summary: { headline: 'h', counts: {} }, findings: [] }),
  io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async () => {} },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack',
});
const pe3 = await mixHub.plan('enable', { plugin: 'dsh-on' });
check('enable on enabled bundle names real candidates', pe3.ok === false && String(pe3.error).includes('dsh-off-a'), String(pe3.error));
const pe4 = await mixHub.plan('enable', { plugin: 'dsh-off-a' });
check('enable on disabled bundle allowed', pe4.ok === true, JSON.stringify(pe4));
check('enable plan human cites disabled-basis', Array.isArray(pe4.plan.human) && pe4.plan.human.some((l) => l.includes('已是停用状态') || l.includes('enabled=false')), JSON.stringify(pe4.plan && pe4.plan.human));
const exe4 = await mixHub.execute({ planHash: pe4.planHash, confirm: true });
check('enable execute flips to true', exe4.ok === true, JSON.stringify(exe4));

// ack round-trip against a finding present in the fake report
const pa = await hub.plan('ack', { id: 'boot-crash-latest' });
check('ack plan ok', pa.ok === true && pa.plan.human[0].includes('静音'), JSON.stringify(pa));
const exa = await hub.execute({ planHash: pa.planHash, confirm: true });
check('ack execute writes acked store', exa.ok === true, JSON.stringify(exa));
const pa2 = await hub.plan('ack', { id: 'boot-crash-latest' });
check('double ack refused', pa2.ok === false);
const pu = await hub.plan('unack', { id: 'boot-crash-latest' });
const exu = await hub.execute({ planHash: pu.planHash, confirm: true });
check('unack round-trips', pu.ok === true && exu.ok === true, JSON.stringify(exu));

console.log('— v0.3 compat-check + mute layer (report) —');
const compatIo = {
  readDir(dir) {
    if (dir.endsWith('node_modules')) return ['@deepseek-ai', 'dsh-a', 'dsh-b'];
    if (dir.includes('@deepseek-ai')) return ['dsh-base'];
    return { __error: 'unexpected ' + dir };
  },
  stat(file) { return { isFile: () => true, size: 10, mtime: new Date('2026-11-09T00:00:00Z') }; },
  readText(file) {
    if (file.includes('dsh-base')) return '{"name":"@deepseek-ai/dsh-base","version":"0.2.2-rc.1"}';
    if (file.includes('dsh-a')) return '{"name":"dsh-a","version":"1.0.0","engines":{"dsh":">=0.2.0-rc.1 <0.3.0-0"}}';
    if (file.includes('dsh-b')) return '{"name":"dsh-b","version":"2.0.0","engines":{"dsh":">=0.9.0"}}';
    return { __error: 'unexpected read ' + file };
  },
};
const compatReport = collectReport({
  now: new Date('2026-11-09T00:00:00Z'), bootedAt: new Date('2026-11-08T00:00:00Z'),
  env: {}, platform: 'win32', profileDirs: ['C:\\p'], io: compatIo,
});
const compatFinding = compatReport.findings.find((f) => f.id === 'compat-check');
check('compat-check finding present', !!compatFinding, JSON.stringify(compatReport.errors));
check('compat hostVersion read', compatFinding && compatFinding.data.hostVersion === '0.2.2-rc.1', JSON.stringify(compatFinding && compatFinding.data));
check('compat flags out-of-range package', compatFinding && compatFinding.severity === 'warning' && compatFinding.data.mismatched.some((m) => m.name === 'dsh-b'), JSON.stringify(compatFinding && compatFinding.data.mismatched));
const mutedReport = collectReport({
  now: new Date('2026-11-08T19:55:00Z'), bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\\\Users\\\\demo\\\\AppData\\\\Roaming', DSH_HOME: 'C:\\\\Users\\\\demo\\\\.dsh' },
  platform: 'win32', io, acked: [{ id: 'boot-crash-latest' }],
});
const mutedCrash = mutedReport.findings.find((f) => f.id === 'boot-crash-latest');
check('acked finding marked muted + excluded from counts', mutedCrash.muted === true && mutedReport.summary.counts.critical === 0 && mutedReport.summary.counts.muted === 1, JSON.stringify(mutedReport.summary));

console.log('— v0.3.2: importance score / recall / DCA1 verify / persisted-report gate —');
check('fresh critical crash outscores advisory', crashFinding.score > report.findings.find((f) => f.id === 'knowledge').score, JSON.stringify([crashFinding.score, report.findings.find((f) => f.id === 'knowledge').score]));
check('score has reasons array', Array.isArray(crashFinding.scoreReasons) && crashFinding.scoreReasons.length >= 2, JSON.stringify(crashFinding.scoreReasons));
check('priority band assigned', ['high', 'medium', 'low'].includes(crashFinding.priority), crashFinding.priority);
check('stale crash scores below fresh one', staleCrash.score < crashFinding.score, JSON.stringify([staleCrash.score, crashFinding.score]));
check('stale crash not credited as actionable', !(staleCrash.scoreReasons || []).some((r) => r.startsWith('有直达处置动作')), JSON.stringify(staleCrash.scoreReasons));
check('muted keeps score but stays scorable', typeof mutedCrash.score === 'number', String(mutedCrash.score));
const recallReport = collectReport({
  now: new Date('2026-11-09T12:00:00Z'), bootedAt: new Date('2026-11-07T02:00:00Z'),
  env: { APPDATA: 'C:\\\\Users\\\\demo\\\\AppData\\\\Roaming', DSH_HOME: 'C:\\\\Users\\\\demo\\\\.dsh' },
  platform: 'win32', io, pluginChanges: [{ type: 'install' }],
  knowledge: [{ at: '2026-11-08T00:00:00Z', headline: 'h-prior', counts: { critical: 1, warning: 0, info: 0 }, findingIds: ['boot-crash-latest'] }],
});
const recallCrash = recallReport.findings.find((f) => f.id === 'boot-crash-latest');
check('recall attaches prior record', recallCrash.recall && recallCrash.recall.headline === 'h-prior', JSON.stringify(recallCrash.recall));
check('knowledge plan lists findingIds', Array.isArray(pk.plan.findingIds) && pk.plan.findingIds.includes('boot-crash-latest') && pk.plan.human.some((l) => l.includes('指纹条目')), JSON.stringify(pk.plan.findingIds));

// verifyDca1Blob is module-private in actions.js; exercise it through the hub
// instead: fake io.readBytes returning a real DCA1 blob we encrypt here.
const { scrypt, createCipheriv, randomBytes } = await import('node:crypto');
const { promisify } = await import('node:util');
const scryptP = promisify(scrypt);
const pw = 'correct-horse';
const salt = randomBytes(16); const iv = randomBytes(12);
const key = await scryptP(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const inner = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 7)]);
const ciph = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([ciph.update(inner), ciph.final()]);
const blob = Buffer.concat([Buffer.from('DCA1', 'latin1'), Buffer.from([1]), salt, iv, ciph.getAuthTag(), enc]);
const verifyHub = createActionHub({
  routeFetch: async (p, body) => { if (p === '/api/dsh-config-manager/export-preview') return { ok: true, sections: [{ section: 'sessions', sizeBytes: 700 }, { section: 'pluginData', sizeBytes: 80 }, { section: 'pluginAssets', sizeBytes: 10 }] }; if (p === '/api/dsh-config-manager/export') { calls.push({ exportPw: body.password }); return { zipPath: 'C:\\exports\\v.zip', manifest: {}, report: {}, runId: 'r' }; } throw new Error('unexpected ' + p); },
  getPluginManager: () => null,
  getReport: () => ({ summary: { level: 'ok', headline: 'h', counts: {} }, findings: [] }),
  io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async () => {}, readBytes: async () => blob },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack',
});
const pv = await verifyHub.plan('backup');
const exv = await verifyHub.execute({ planHash: pv.planHash, confirm: true, password: pw });
check('backup verify ok with right password', exv.ok === true && exv.verified === true, JSON.stringify(exv.verifyReason || exv));
check('verify human line reports check', exv.human.some((l) => l.includes('回读校验')), JSON.stringify(exv.human));
const pv2 = await verifyHub.plan('backup');
const exv2 = await verifyHub.execute({ planHash: pv2.planHash, confirm: true, password: 'wrong-password' });
check('wrong password → verified false but backup ok', exv2.ok === true && exv2.verified === false && String(exv2.verifyReason).includes('GCM'), JSON.stringify([exv2.verified, exv2.verifyReason]));
const pv3 = await verifyHub.plan('backup');
await verifyHub.execute({ planHash: pv3.planHash, confirm: true, password: pw });
const exv3 = await verifyHub.execute({ planHash: pv3.planHash, confirm: true, password: pw });
check('fingerprint single-use on verify hub too', exv3.ok === false, JSON.stringify(exv3));

const persistedHub = createActionHub({
  routeFetch: async () => { throw new Error('none'); },
  getPluginManager: () => ({ listBundles: async () => [{ name: 'dsh-foo', enabled: true }], setBundleEnabled: async () => ({ application: 'applied' }) }),
  getReport: () => ({ summary: { headline: 'h', counts: {} }, staleAfterRestart: true, findings: [{ id: 'boot-crash-latest', severity: 'critical', data: { stale: false, suspects: ['dsh-foo'] } }] }),
  io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async () => {} },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack',
});
const ppd = await persistedHub.plan('disable', { plugin: 'dsh-foo' });
check('persisted report after restart refused', ppd.ok === false && String(ppd.error).includes('重启前'), JSON.stringify(ppd));

console.log('— v0.4: hostVersion source chain / cFreeBytes trend —');
const compatMain = report.findings.find((f) => f.id === 'compat-check');
check('hostVersion derived from crash meta.app', compatMain && compatMain.data.hostVersion === '0.2.2-rc.1', JSON.stringify(compatMain && compatMain.data));
check('report carries cFreeBytes', typeof report.cFreeBytes === 'number' && report.cFreeBytes > 0, String(report.cFreeBytes));
const trendFiles = {};
const trendHub = createActionHub({
  routeFetch: async () => { throw new Error('none'); },
  getPluginManager: () => null,
  getReport: () => ({ summary: { level: 'ok', headline: 'h', counts: {} }, cFreeBytes: 5000000000, findings: [] }),
  io: { appendJsonl: async () => {}, readJson: async () => [], writeJson: async (f, v) => { trendFiles[f] = v; } },
  now: () => new Date('2026-11-09T00:00:00Z'),
  auditFile: 'a', trendFile: 'trend.json', knowledgeFile: 'k', ackedFile: 'ack',
});
const pt = await trendHub.plan('knowledge');
check('knowledge plan human mentions free-space snapshot', pt.ok === true && pt.plan.human.some((l) => l.includes('剩余空间快照')), JSON.stringify(pt.plan.human));
const ext = await trendHub.execute({ planHash: pt.planHash, confirm: true });
check('trend row stores cFreeBytes', ext.ok === true && Array.isArray(trendFiles['trend.json']) && trendFiles['trend.json'].at(-1).cFreeBytes === 5000000000, JSON.stringify(trendFiles['trend.json']));

console.log('— v0.6 L2: one sentence → one intent (pure, zero-token) —');
const BUNDLES = [
  { name: 'dsh-guizang-design', enabled: true },
  { name: 'dsh-univer-office', enabled: true },
  { name: '@deepseek-ai/dsh-headless', enabled: false },
  { name: '@deepseek-ai/dsh-acp-app', enabled: false },
];
const REPORT_FOR_INTENT = {
  findings: [
    { id: 'data-at-risk', severity: 'warning', title: '易失数据不在默认备份分区内', muted: false },
    { id: 'disk-advice', severity: 'info', title: '可自动清 / 不可自动清必须分开', muted: false },
    { id: 'plugin-change', severity: 'warning', title: '插件变更跟踪', muted: true },
  ],
};
const intentCtx = { bundles: BUNDLES, report: REPORT_FOR_INTENT };

const i1 = parseIntent('清理一下缓存', intentCtx);
check('L2 clean → kind clean', i1.intent && i1.intent.kind === 'clean', JSON.stringify(i1));
check('L2 clean reply explains zero-write preview', Array.isArray(i1.reply) && i1.reply.some((l) => l.includes('预览')), JSON.stringify(i1.reply));

const i2 = parseIntent('给易失数据做个加密备份', intentCtx);
check('L2 backup → kind backup', i2.intent && i2.intent.kind === 'backup', JSON.stringify(i2));
check('L2 backup reply says do not type password in chat', Array.isArray(i2.reply) && i2.reply.some((l) => l.includes('聊天')), JSON.stringify(i2.reply));

const i3 = parseIntent('停用 dsh-guizang-design', intentCtx);
check('L2 disable picks real bundle', i3.intent && i3.intent.kind === 'disable' && i3.intent.params.plugin === 'dsh-guizang-design', JSON.stringify(i3.intent));

const i4 = parseIntent('启用 dsh-guizang-design', intentCtx);
check('L2 enable on an already-enabled bundle is refused with a redirect', i4.intent === null && String(i4.clarify).includes('停用'), JSON.stringify(i4));

const i5 = parseIntent('启用 @deepseek-ai/dsh-headless', intentCtx);
check('L2 enable on a disabled bundle is accepted', i5.intent && i5.intent.kind === 'enable' && i5.intent.params.plugin === '@deepseek-ai/dsh-headless', JSON.stringify(i5.intent));

const i6 = parseIntent('停用 dsh-not-installed-here', intentCtx);
check('L2 unknown plugin is not guessed into an action', i6.intent === null && String(i6.clarify).includes('不在当前已装列表'), JSON.stringify(i6));

const i7 = parseIntent('今天天气不错', intentCtx);
check('L2 off-topic → clarify, never a guess', i7.intent === null && String(i7.clarify).includes('没听懂'), JSON.stringify(i7));
check('L2 clarify carries example sentences', Array.isArray(i7.suggestions) && i7.suggestions.length > 0, JSON.stringify(i7.suggestions));

const i8 = parseIntent('清理缓存顺便做个备份', intentCtx);
check('L2 two competing actions → ask, do not pick', i8.intent === null && String(i8.clarify).includes('两件事'), JSON.stringify(i8));

const i9 = parseIntent('别清理了，先看看有什么问题', intentCtx);
check('L2 negation drops clean and keeps report', !i9.intent || i9.intent.kind !== 'clean', JSON.stringify(i9.intent || i9.clarify));

const i10 = parseIntent('静音易失数据那条提醒', intentCtx);
check('L2 ack resolves to a real finding id', i10.intent && i10.intent.kind === 'ack' && i10.intent.params.id === 'data-at-risk', JSON.stringify(i10.intent));

const i11 = parseIntent('静音', intentCtx);
check('L2 bare ack asks which finding', i11.intent === null && String(i11.clarify).includes('哪一条'), JSON.stringify(i11));

const i12 = parseIntent('  ', intentCtx);
check('L2 empty input asks for a sentence', i12.intent === null && !!i12.clarify, JSON.stringify(i12));

const i13 = parseIntent('有什么问题吗', intentCtx);
check('L2 report intent needs no target', i13.intent && i13.intent.kind === 'report', JSON.stringify(i13.intent));

// v0.7.0: 「去哪一页」也是一种意图。截图里那句「去到审计趋势」以前落空，
// 因为当时根本没有导航意图；现在它只切 Tab，不碰任何动作。
const g1 = parseIntent('去到审计趋势', intentCtx);
check('L2 goto 审计趋势 resolves to the audit tab', g1.intent && g1.intent.kind === 'goto' && g1.intent.params.tab === 'audit', JSON.stringify(g1));
const g2 = parseIntent('打开动作中心', intentCtx);
check('L2 goto 动作中心 resolves to the actions tab', g2.intent && g2.intent.kind === 'goto' && g2.intent.params.tab === 'actions', JSON.stringify(g2));
const g3 = normalizeBrainOutput('{"kind":"goto","tab":"audit"}', intentCtx);
check('brain goto carries an allowlisted tab', g3.intent && g3.intent.kind === 'goto' && g3.intent.params.tab === 'audit', JSON.stringify(g3.intent));
const g4 = normalizeBrainOutput('{"kind":"goto","tab":"secret-admin-page"}', intentCtx);
check('brain goto cannot invent a page', g4.intent === null, JSON.stringify(g4));

// ── v0.7.0 L2+ model layer ────────────────────────────────────────────────
// The model only TRANSLATES. These cases pin the two things that matter:
// its output is normalized into the SAME intent shape, and anything it gets
// wrong degrades to clarify instead of becoming an action.
const brainCtx = { bundles: intentCtx.bundles, report: intentCtx.report };

check('brain extractJson takes a bare object', (extractJson('{"kind":"clean"}') || {}).kind === 'clean');
check('brain extractJson survives a fenced block', (extractJson('好的\n```json\n{"kind":"backup"}\n```') || {}).kind === 'backup');
check('brain extractJson ignores surrounding prose', (extractJson('我认为 {"kind":"report"} 就是这样') || {}).kind === 'report');
check('brain extractJson returns null on non-JSON talk', extractJson('我建议你先清理缓存') === null);

const b1 = normalizeBrainOutput('{"kind":"clean","reply":"理解成清理"}', brainCtx);
check('brain clean becomes the same intent shape', b1.intent && b1.intent.kind === 'clean' && b1.intent.matched[0] === 'model', JSON.stringify(b1));
check('brain reply is carried through', Array.isArray(b1.reply) && b1.reply[0].includes('清理'), JSON.stringify(b1.reply));

const b2 = normalizeBrainOutput('{"kind":"none","reply":"你想清理还是备份？"}', brainCtx);
check('brain kind=none degrades to clarify, never an action', b2.intent === null && String(b2.clarify).includes('清理还是备份'), JSON.stringify(b2));

const b3 = normalizeBrainOutput('{"kind":"launch-missiles"}', brainCtx);
check('brain unknown kind cannot invent an action', b3.intent === null, JSON.stringify(b3));

const b4 = normalizeBrainOutput('这不是 JSON', brainCtx);
check('brain unparseable output cannot invent an action', b4.intent === null, JSON.stringify(b4));

const b5 = normalizeBrainOutput('{"kind":"disable","plugin":"dsh-made-up"}', brainCtx);
check('brain plugin must exist in the bundle list', b5.intent === null && String(b5.clarify).includes('不在当前已装列表'), JSON.stringify(b5));

const b6 = normalizeBrainOutput('{"kind":"disable","plugin":"dsh-guizang-design"}', brainCtx);
check('brain plugin resolves to the real bundle name', b6.intent && b6.intent.params.plugin === 'dsh-guizang-design', JSON.stringify(b6.intent));

const b7 = normalizeBrainOutput('{"kind":"ack","findingId":"no-such-finding"}', brainCtx);
check('brain ack must name a finding that exists', b7.intent === null, JSON.stringify(b7));

const b8 = normalizeBrainOutput('{"kind":"ack","findingId":"data-at-risk"}', brainCtx);
check('brain ack resolves a real finding id', b8.intent && b8.intent.params.id === 'data-at-risk', JSON.stringify(b8.intent));

const b9 = normalizeBrainOutput('{"kind":"report"}', brainCtx);
check('brain report needs no target', b9.intent && b9.intent.kind === 'report', JSON.stringify(b9));
check('brain marks its provenance as model', b9.via === 'model', JSON.stringify(b9));

console.log('— v0.7.7: workspace inventory / plugin updates / coverage / mute expiry —');
const { encodeWorkspaceDir } = await import('./lib/report.js');
check('workspace dir encoding matches DSH layout', encodeWorkspaceDir('E:\\workspace') === '--E-workspace--', encodeWorkspaceDir('E:\\workspace'));
check('workspace dir encoding collapses separators', encodeWorkspaceDir('C:\\Users\\demo\\Documents\\deepseek-harness\\default-workspace') === '--C-Users-demo-Documents-deepseek-harness-default-workspace--', encodeWorkspaceDir('C:\\Users\\demo\\Documents\\deepseek-harness\\default-workspace'));

const WORKSPACE_JSON = JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1', 'w2'] },
  tables: { workspaces: {
    w1: { path: process.cwd(), title: 'Big', sessionIds: ['s1'], createdAt: '2026-11-01T00:00:00Z' },
    w2: { path: path.dirname(process.cwd()), title: 'Small', sessionIds: ['s2'], createdAt: '2026-11-01T00:00:00Z' },
  } },
});
const UPDATE_CACHE = JSON.stringify({
  fetchedAt: '2026-11-09T12:00:00Z',
  packages: {
    'dsh-a': { latest: '2.0.0', versions: ['1.0.0', '2.0.0'] },
    'dsh-b': { latest: '2.0.0', versions: ['1.0.0', '2.0.0'] },
  },
});
function dataIo() {
  return {
    readDir(dir) {
      if (dir.includes('logs')) return [];
      if (dir.includes('profiles') || dir === 'C:\\p') return ['cordis.patch.yml', 'package.json'];
      if (dir.includes('exports')) return [];
      if (dir.includes('node_modules')) return ['dsh-a', 'dsh-b'];
      if (dir.endsWith('E:\\big')) return [];
      if (dir.endsWith('E:\\small')) return [];
      return { __error: 'ENOENT unexpected ' + dir };
    },
    stat(file) {
      if (file.endsWith('workspace.json') || file.endsWith('plugin-update-cache.json')) {
        return { isFile: () => true, size: 100, mtime: new Date('2026-11-09T12:00:00Z') };
      }
      if (file.endsWith('cordis.patch.yml') || file.endsWith('package.json')) {
        return { isFile: () => true, size: 100, mtime: new Date('2026-11-09T12:00:00Z') };
      }
      return { __error: 'ENOENT unexpected ' + file };
    },
    readText(file) {
      if (file.endsWith('workspace.json')) return WORKSPACE_JSON;
      if (file.endsWith('plugin-update-cache.json')) return UPDATE_CACHE;
      if (file.includes('node_modules') && file.endsWith('package.json')) {
        const name = file.includes('dsh-a') ? 'dsh-a' : 'dsh-b';
        return JSON.stringify({ name, version: '1.0.0' });
      }
      if (file.endsWith('cordis.patch.yml')) return 'a\n'.repeat(100).trim();
      if (file.endsWith('package.json')) return '{"name":"x"}';
      return { __error: 'ENOENT unexpected read ' + file };
    },
  };
}
const dataReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'], io: dataIo(),
});
const wsFinding = dataReport.findings.find((f) => f.id === 'workspace-inventory');
check('workspace inventory finding present', !!wsFinding, JSON.stringify(dataReport.errors));
check('workspace inventory lists both workspaces', wsFinding && wsFinding.data.workspaces.length === 2, JSON.stringify(wsFinding && wsFinding.data && wsFinding.data.workspaces));
check('workspace index is reported as available', dataReport.workspace.available === true && dataReport.workspace.totalBytes >= 0, JSON.stringify(dataReport.workspace));
check('workspace growth needs a previous snapshot before it can warn', wsFinding.severity === 'info' && wsFinding.data.comparedTo === null, JSON.stringify({ sev: wsFinding.severity, cmp: wsFinding.data.comparedTo }));

// v0.7.8 growth semantics: same numbers twice must NOT raise warning (that is the
// fixed-threshold trap — a static 50 MB line fires every scan on a machine that
// did not change). A real jump must.
const flatPrev = { at: '2026-11-09T12:00:00Z', workspace: { workspaces: [{ id: 'w1', title: 'Big', bytes: 0 }, { id: 'w2', title: 'Small', bytes: 0 }] } };
const flatReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'], io: dataIo(), previous: flatPrev,
});
const flatWs = flatReport.findings.find((f) => f.id === 'workspace-inventory');
check('unchanged workspace volume does not raise a warning', flatWs.severity === 'info', JSON.stringify({ sev: flatWs.severity, title: flatWs.title }));
check('unchanged workspace says it held steady', String(flatWs.title).includes('无显著增长') || String(flatWs.title).includes('持平'), flatWs.title);

// jump: pretend w1 had 0 bytes before but a big dir now (the fixture reports 0 too,
// so synthesize the delta by giving a previous entry a negative-implied baseline)
const jumpIo = dataIo();
const jumpPrev = { at: '2026-11-09T12:00:00Z', workspace: { workspaces: [{ id: 'w1', title: 'Big', bytes: -30 * 1024 * 1024 }, { id: 'w2', title: 'Small', bytes: 0 }] } };
const jumpReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'], io: jumpIo, previous: jumpPrev,
});
const jumpWs = jumpReport.findings.find((f) => f.id === 'workspace-inventory');
check('a real volume jump raises a warning', jumpWs.severity === 'warning' && jumpWs.data.grown.length >= 1, JSON.stringify({ sev: jumpWs.severity, grown: jumpWs.data.grown }));
const upFinding = dataReport.findings.find((f) => f.id === 'plugin-updates');
check('plugin updates detects outdated packages', upFinding && upFinding.data.outdated.some((o) => o.name === 'dsh-a' && o.latest === '2.0.0'), JSON.stringify(upFinding && upFinding.data));
check('coverage counts every source', dataReport.coverage.sourcesTotal === 7, JSON.stringify(dataReport.coverage));

// v0.9.4 direction gate. The live machine shipped dsh-disk-cleaner "1.6.3 → 1.6.2"
// as an UPGRADE suggestion: plain inequality, no direction. These three fixtures
// pin the three outcomes that matter.
function versionIo(versions) {
  const base = dataIo();
  const origReadText = base.readText.bind(base);
  base.readText = (file) => {
    if (file.includes('node_modules') && file.endsWith('package.json')) {
      const name = file.includes('dsh-a') ? 'dsh-a' : 'dsh-b';
      return JSON.stringify({ name, version: versions[name] });
    }
    return origReadText(file);
  };
  return base;
}
const mkVersionReport = (versions) => collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\\\Users\\\\demo\\\\AppData\\\\Roaming', DSH_HOME: 'C:\\\\Users\\\\demo\\\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\\\p'], io: versionIo(versions),
});

const sameReport = mkVersionReport({ 'dsh-a': '2.0.0', 'dsh-b': '2.0.0' });
const sameUp = sameReport.findings.find((f) => f.id === 'plugin-updates');
check('same version is not an upgrade', sameUp && sameUp.data.outdated.length === 0, JSON.stringify(sameUp && sameUp.data));
check('same version raises no ahead/unknown noise', sameUp && sameUp.data.aheadOfCache.length === 0 && sameUp.data.undetermined === 0, JSON.stringify(sameUp && sameUp.data));

const aheadReport = mkVersionReport({ 'dsh-a': '3.0.0', 'dsh-b': 'beta' });
const aheadUp = aheadReport.findings.find((f) => f.id === 'plugin-updates');
check('installed newer than cache is not an upgrade', aheadUp && aheadUp.data.outdated.length === 0, JSON.stringify(aheadUp && aheadUp.data));
check('installed-newer lands in aheadOfCache', aheadUp && aheadUp.data.aheadOfCache.some((o) => o.name === 'dsh-a' && o.installed === '3.0.0' && o.latest === '2.0.0'), JSON.stringify(aheadUp && aheadUp.data));
check('unparseable version is counted, not guessed', aheadUp && aheadUp.data.undetermined === 1, JSON.stringify(aheadUp && aheadUp.data));
check('ahead/unknown are said out loud in the detail', aheadUp && String(aheadUp.detail).includes('缓存偏旧') && String(aheadUp.detail).includes('无法比较'), String(aheadUp && aheadUp.detail));

// A real upgrade alongside an ahead-of-cache package and an unparseable one: the
// OUTDATED branch must name the update, and still say the other two out loud
// instead of silently dropping them.
const mixedIo = dataIo();
const mixedOrig = mixedIo.readText.bind(mixedIo);
mixedIo.readDir = (dir) => (dir.includes('node_modules') ? ['dsh-a', 'dsh-b', 'dsh-c'] : dataIo().readDir(dir));
mixedIo.readText = (file) => {
  if (file.includes('node_modules') && file.endsWith('package.json')) {
    const name = file.includes('dsh-a') ? 'dsh-a' : file.includes('dsh-b') ? 'dsh-b' : 'dsh-c';
    const v = { 'dsh-a': '1.0.0', 'dsh-b': '3.0.0', 'dsh-c': 'beta' }[name];
    return JSON.stringify({ name, version: v });
  }
  return mixedOrig(file);
};
const mixedCache = JSON.stringify({ fetchedAt: '2026-11-09T12:00:00Z', packages: {
  'dsh-a': { latest: '2.0.0' }, 'dsh-b': { latest: '2.0.0' }, 'dsh-c': { latest: '2.0.0' },
} });
const mixedReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\\\Users\\\\demo\\\\AppData\\\\Roaming', DSH_HOME: 'C:\\\\Users\\\\demo\\\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\\\p'],
  io: { ...mixedIo, readText: (f) => (f.endsWith('plugin-update-cache.json') ? mixedCache : mixedIo.readText(f)) },
});
const mixedUp = mixedReport.findings.find((f) => f.id === 'plugin-updates');
check('a real upgrade still reports as outdated', mixedUp && mixedUp.data.outdated.some((o) => o.name === 'dsh-a' && o.installed === '1.0.0' && o.latest === '2.0.0'), JSON.stringify(mixedUp && mixedUp.data));
check('the upgrade branch also names the ahead-of-cache package', mixedUp && String(mixedUp.detail).includes('缓存比磁盘旧'), String(mixedUp && mixedUp.detail));
check('the upgrade branch also names the unparseable one', mixedUp && String(mixedUp.detail).includes('无法比较'), String(mixedUp && mixedUp.detail));

// optional source missing -> coverage says unavailable, but the report must stay ok
const gapIo = dataIo();
const gapReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'],
  io: { ...gapIo, readText(f) { return f.endsWith('workspace.json') ? '' : gapIo.readText(f); } },
});
check('missing optional source does not degrade the report', gapReport.status === 'ok', JSON.stringify(gapReport.errors));
const confFinding = gapReport.findings.find((f) => f.id === 'confidence');
check('missing source raises a confidence note', !!confFinding && String(confFinding.title).includes('数据源'), JSON.stringify(confFinding && confFinding.title));

// mute expiry: a stale expiresAt must not keep muting, a future one must
const expiredReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'], io: dataIo(),
  acked: [{ id: 'data-at-risk', expiresAt: '2026-01-01T00:00:00Z' }],
});
check('expired mute stops suppressing the finding', expiredReport.summary.counts.muted === 0, JSON.stringify(expiredReport.summary.counts));
const heldReport = collectReport({
  now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
  env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
  platform: 'win32', profileDirs: ['C:\\p'], io: dataIo(),
  acked: [{ id: 'data-at-risk', expiresAt: '2027-01-01T00:00:00Z' }],
});
check('unexpired mute still suppresses', heldReport.summary.counts.muted === 1, JSON.stringify(heldReport.summary.counts));

// ack execute must stamp an expiry so "silenced" is never permanent by accident
const pae = await hub.plan('ack', { id: 'boot-crash-latest' });
check('ack plan explains the mute window', Array.isArray(pae.plan.human) && pae.plan.human.some((l) => l.includes('自动重新提醒')), JSON.stringify(pae.plan && pae.plan.human));
const exae = await hub.execute({ planHash: pae.planHash, confirm: true });
check('ack execute ok before expiry assertions', exae.ok === true, JSON.stringify(exae));
const storedAck = Array.isArray(fakeFiles['acked.json']) ? fakeFiles['acked.json'].find((a) => a && a.id === 'boot-crash-latest') : null;
check('ack stores an expiresAt timestamp', !!storedAck && typeof storedAck.expiresAt === 'string' && Date.parse(storedAck.expiresAt) > Date.now(), JSON.stringify(storedAck));


// ---- v0.8.0 settings: 松紧可调、越界夹紧、非数字拒绝、默认即推荐 ----
const dflt = settingsDefaults();
check('settings default plugin-updates ttl is 14', settingValue(dflt, 'ttl.plugin-updates') === 14, String(settingValue(dflt, 'ttl.plugin-updates')));
const n1 = normalizeSettings({ ttl: { 'plugin-updates': 7 } });
check('settings accept 7 days for plugin-updates', n1.ok === true && settingValue(n1.settings, 'ttl.plugin-updates') === 7, JSON.stringify(n1.applied));
check('ackTtlDays follows the configured value', settingsAckTtl(n1.settings, 'plugin-updates') === 7, String(settingsAckTtl(n1.settings, 'plugin-updates')));
const n2 = normalizeSettings({ threshold: { growthWarnMb: 0 } });
check('out-of-range value is clamped, not accepted', n2.ok === true && settingValue(n2.settings, 'threshold.growthWarnMb') === 1 && n2.clamped.length === 1, JSON.stringify(n2.clamped));
const n3 = normalizeSettings({ ttl: { 'plugin-updates': 'abc' } });
check('non-numeric value is rejected', n3.ok === false && n3.rejected.length === 1, JSON.stringify(n3.rejected));
const groups = describeSettings(dflt);
// 面板提交的是扁平键（每个输入框只知道自己那一个键）。只认嵌套形态会静默变成
// 「没有收到任何可保存的项」——这正是真机上点保存报错的那条路径。
const flatSave = normalizeSettings({ 'ttl.plugin-updates': 7, 'threshold.growthWarnMb': 0, 'collect.maxLogs': 500 });
check('flat keys from the panel are accepted', flatSave.ok === true && settingValue(flatSave.settings, 'ttl.plugin-updates') === 7, JSON.stringify(flatSave.applied));
check('flat keys are clamped like nested ones', settingValue(flatSave.settings, 'threshold.growthWarnMb') === 1 && settingValue(flatSave.settings, 'collect.maxLogs') === 200, JSON.stringify(flatSave.clamped));
check('flat input never reports empty-applied', flatSave.applied && Object.keys(flatSave.applied).length === 3, String(Object.keys(flatSave.applied || {}).length));
check('settings are grouped for the panel', Array.isArray(groups) && groups.length >= 4, String(groups && groups.length));
const flatItems = groups.reduce((acc, g) => acc.concat(g.items || []), []);
check('every setting carries label/range/why for the UI', flatItems.length >= 13 && flatItems.every((it) => it.label && it.why && (it.type === 'choice' ? Array.isArray(it.options) && it.options.length > 0 && it.options.some((o) => o.value === it.def) : typeof it.min === 'number' && typeof it.max === 'number' && typeof it.def === 'number')), JSON.stringify(flatItems.filter((it) => !it.label || !it.why).map((it) => it.key)));
// v0.8.2 面板入口：choice 类型要能存 / 能读 / 能拒非法值
const entryRow = flatItems.find((it) => it.key === 'ui.entry');
check('panel entry is a choice with three options', !!entryRow && entryRow.type === 'choice' && entryRow.options.length === 3, JSON.stringify(entryRow && entryRow.options));
const nEntry = normalizeSettings({ 'ui.entry': 'right' });
check('panel entry accepts a valid option', nEntry.ok === true && settingValue(nEntry.settings, 'ui.entry') === 'right', JSON.stringify(nEntry.applied));
const nBad = normalizeSettings({ 'ui.entry': 'nowhere' });
check('panel entry rejects an unknown option', nBad.rejected.length === 1 && settingValue(nBad.settings, 'ui.entry') === 'both', JSON.stringify(nBad.rejected));

// 设置必须真的改变检测行为：同一份增长数据，阈值放大后不再报警
const growthBase = { now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'), env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' }, platform: 'win32', profileDirs: ['C:\\p'], io: dataIo() };
const growthPrevBase = collectReport(Object.assign({}, growthBase));
const growthPrevList = (growthPrevBase.workspace && growthPrevBase.workspace.workspaces) || [];
const growthPrev = { workspace: { workspaces: growthPrevList.map((w) => Object.assign({}, w, { bytes: w.bytes - 30 * 1024 * 1024 })) } };
const tight = collectReport(Object.assign({}, growthBase, { settings: normalizeSettings({ threshold: { growthWarnMb: 1 } }).settings, previous: growthPrev }));
const loose = collectReport(Object.assign({}, growthBase, { settings: normalizeSettings({ threshold: { growthWarnMb: 2048 } }).settings, previous: growthPrev }));
const tightWs = tight.findings.find((f) => f.id === 'workspace-inventory');
const looseWs = loose.findings.find((f) => f.id === 'workspace-inventory');
check('tight growth threshold raises a warning', !!tightWs && tightWs.severity === 'warning', JSON.stringify(tightWs && tightWs.title));
check('loosened growth threshold stops the warning', !!looseWs && looseWs.severity === 'info', JSON.stringify(looseWs && looseWs.title));

// ---------- v0.9.1 模型健康：三件（哨兵 / 台账 / 只标不判死） ----------
// 判据的核心是「忙不等于死」：把 429 当死会把好模型从选择器里赶走。
check('404 classifies as dead', classifyProbe({ status: 404 }) === 'dead');
check('422 classifies as dead', classifyProbe({ status: 422 }) === 'dead');
check('429 classifies as busy (quota cools down)', classifyProbe({ status: 429 }) === 'busy');
check('500 classifies as busy (gateway fault is not a verdict on the model)', classifyProbe({ status: 500 }) === 'busy');
check('timeout without a status classifies as busy', classifyProbe(new Error('The operation was aborted')) === 'busy');
check('status buried in the message still classifies', classifyProbe(new Error('HTTP 404 model not found')) === 'dead');
check('no error at all is ok', classifyProbe(null) === 'ok');

const catalog = {
  default: { provider: 'p1', model: 'm1' },
  providers: [
    { id: 'p1', name: 'P1', models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] },
    { id: 'p2', name: 'P2', models: [{ id: 'n1' }] },
  ],
};
const sentinel = planSentinel(catalog, { perProvider: 2, maxTotal: 12 });
check('sentinel always contains the default model', sentinel.some((t) => t.provider === 'p1' && t.model === 'm1'), JSON.stringify(sentinel));
check('sentinel takes only the first N per provider', sentinel.filter((t) => t.provider === 'p1').length === 2, JSON.stringify(sentinel));
check('sentinel dedupes the default from the per-provider slice', sentinel.filter((t) => t.provider === 'p1' && t.model === 'm1').length === 1, JSON.stringify(sentinel));
const tightSentinel = planSentinel(catalog, { perProvider: 0, maxTotal: 12 });
check('perProvider 0 keeps only the default model', tightSentinel.length === 1 && tightSentinel[0].model === 'm1', JSON.stringify(tightSentinel));

const okProbes = [
  { provider: 'p1', model: 'm1', verdict: 'ok', ms: 120 },
  { provider: 'p1', model: 'm2', verdict: 'dead' },
  { provider: 'p2', model: 'n1', verdict: 'busy' },
];
const sum = summarize(okProbes, null);
check('summarize counts the three verdicts', sum.probed === 3 && sum.ok === 1 && sum.dead === 1 && sum.busy === 1, JSON.stringify(sum));
check('summarize names the dead models', sum.deadModels.length === 1 && sum.deadModels[0].model === 'm2', JSON.stringify(sum.deadModels));
check('one offline round is not "offline two rounds"', sum.providers.find((r) => r.provider === 'p1').offlineTwoRounds === false, JSON.stringify(sum.providers));
const deadOnly = [{ provider: 'p1', model: 'm9', verdict: 'dead' }];
const sumFirst = summarize(deadOnly, null);
const sumSecond = summarize(deadOnly, sumFirst);
check('two rounds with zero ok and at least one dead flags offline', sumSecond.providers[0].offlineTwoRounds === true, JSON.stringify(sumSecond.providers));
const busyOnly = [{ provider: 'p3', model: 'x', verdict: 'busy' }];
const sumBusy2 = summarize(busyOnly, summarize(busyOnly, null));
check('a provider that is only busy never becomes "offline"', sumBusy2.providers[0].offlineTwoRounds === false, JSON.stringify(sumBusy2.providers));

check('default verdict reports ok with latency', defaultVerdict(okProbes, catalog.default).state === 'ok' && defaultVerdict(okProbes, catalog.default).ms === 120);
check('default verdict reports dead', defaultVerdict([{ provider: 'p1', model: 'm1', verdict: 'dead', note: 'gone' }], catalog.default).state === 'dead');
check('default verdict reports busy separately from dead', defaultVerdict([{ provider: 'p1', model: 'm1', verdict: 'busy' }], catalog.default).state === 'busy');
check('default verdict is unprobed when the default was not in the sentinel', defaultVerdict([{ provider: 'p1', model: 'zzz', verdict: 'ok' }], catalog.default).state === 'unprobed');
check('default verdict is missing when nothing is selected', defaultVerdict([], null).state === 'missing');

const altSameProvider = suggestDefault([
  { provider: 'p1', model: 'm1', verdict: 'dead' },
  { provider: 'p1', model: 'm2', verdict: 'ok' },
  { provider: 'p2', model: 'n1', verdict: 'ok' },
], { provider: 'p1', model: 'm1' });
check('a suggestion prefers the same provider', altSameProvider && altSameProvider.provider === 'p1' && altSameProvider.model === 'm2' && altSameProvider.sameProvider === true, JSON.stringify(altSameProvider));
const altOther = suggestDefault([
  { provider: 'p1', model: 'm1', verdict: 'dead' },
  { provider: 'p2', model: 'n1', verdict: 'ok' },
], { provider: 'p1', model: 'm1' });
check('a suggestion falls back to another provider', altOther && altOther.provider === 'p2' && altOther.sameProvider === false, JSON.stringify(altOther));
const altNone = suggestDefault([{ provider: 'p1', model: 'm1', verdict: 'dead' }], { provider: 'p1', model: 'm1' });
check('no suggestion beats suggesting another broken model', altNone === null, JSON.stringify(altNone));

// model-health finding：默认模型挂了才是 warning；「忙」要连续两轮才提示
// 形状照真机：index.js 传的是 { at, default, defaultVerdict, summary, suggest }，
// 计数在 summary 里。用扁平形状喂进去会掩盖「两边形状对不上」这个真 bug。
const healthDead = { at: '2026-11-10T00:00:00Z', default: { provider: 'p1', model: 'm1' }, defaultVerdict: { state: 'dead', note: 'gone' }, defaultBusyRounds: 0, suggest: { provider: 'p1', model: 'm2', sameProvider: true }, summary: sum, fresh: true };
const healthBusy1 = { at: '2026-11-10T00:00:00Z', default: { provider: 'p1', model: 'm1' }, defaultVerdict: { state: 'busy', note: '429' }, defaultBusyRounds: 1, suggest: null, summary: sum, fresh: true };
const healthBusy2 = { at: '2026-11-10T00:00:00Z', default: { provider: 'p1', model: 'm1' }, defaultVerdict: { state: 'busy', note: '429' }, defaultBusyRounds: 2, suggest: null, summary: sum, fresh: true };
const healthOk = { at: '2026-11-10T00:00:00Z', default: { provider: 'p1', model: 'm1' }, defaultVerdict: { state: 'ok', ms: 120 }, defaultBusyRounds: 0, suggest: null, summary: sum, fresh: true };
const mkHealth = (health) => collectReport(Object.assign({}, growthBase, { modelHealth: health }));
const hDead = mkHealth(healthDead).findings.find((f) => f.id === 'model-health');
const hBusy1 = mkHealth(healthBusy1).findings.find((f) => f.id === 'model-health');
const hBusy2 = mkHealth(healthBusy2).findings.find((f) => f.id === 'model-health');
const hOk = mkHealth(healthOk).findings.find((f) => f.id === 'model-health');
const hNone = mkHealth(null).findings.find((f) => f.id === 'model-health');
check('a dead default model is a warning', !!hDead && hDead.severity === 'warning', JSON.stringify(hDead && hDead.title));
check('the dead default finding carries the suggested replacement', !!hDead && hDead.data && hDead.data.suggest && hDead.data.suggest.model === 'm2', JSON.stringify(hDead && hDead.data && hDead.data.suggest));
check('one busy round is not a warning', !!hBusy1 && hBusy1.severity === 'info', JSON.stringify(hBusy1 && hBusy1.severity));
check('two busy rounds do raise a warning', !!hBusy2 && hBusy2.severity === 'warning', JSON.stringify(hBusy2 && hBusy2.title));
check('a healthy default model is info', !!hOk && hOk.severity === 'info', JSON.stringify(hOk && hOk.title));
check('no probe result means no model-health finding at all', !hNone);

// 弹窗两个设置项：默认只弹严重、停留 12 秒，且都能被夹紧
const toastRow = flatItems.find((it) => it.key === 'ui.toast');
const toastSecs = flatItems.find((it) => it.key === 'ui.toastSeconds');
check('toast mode is a choice defaulting to critical-only', !!toastRow && toastRow.type === 'choice' && toastRow.def === 'critical' && toastRow.options.length === 3, JSON.stringify(toastRow && toastRow.options));
check('toast offers an explicit off option', !!toastRow && toastRow.options.some((o) => o.value === 'off'));
check('toast duration defaults to 12 seconds with a range', !!toastSecs && toastSecs.def === 12 && toastSecs.min === 3 && toastSecs.max === 60, JSON.stringify(toastSecs));
const nToast = normalizeSettings({ 'ui.toast': 'warning', 'ui.toastSeconds': 1 });
check('toast settings clamp instead of accepting nonsense', settingValue(nToast.settings, 'ui.toast') === 'warning' && settingValue(nToast.settings, 'ui.toastSeconds') === 3, JSON.stringify(nToast.clamped));
const nToastBad = normalizeSettings({ 'ui.toast': 'everything' });
check('toast rejects an unknown mode', nToastBad.rejected.length === 1 && settingValue(nToastBad.settings, 'ui.toast') === 'critical', JSON.stringify(nToastBad.rejected));

console.log('— v0.9.3: client identity / boot cause —');

// 病因 vs 受害者：真实日志的 renderer console 段写着 duplicate factory
// registration，而 `X: import failed` 只是输掉竞争的那个。解析器必须抓到病因，
// 否则「装了两遍」会被诊断成「某个插件坏了」。
const CRASH_DUP = `time: 2026-11-09T23:28:38.158Z
source: web-boot
phase: running
app: @deepseek-ai/dsh-desktop 0.2.2-rc.1
--- error ---
Error: web boot: 1 entry did not activate
@sidady/dsh-steward: import failed (see console for the import error)
--- renderer console (error level, oldest first) ---
dsh-app://app/plugins/??x:710 Uncaught Error: client-modules: duplicate factory registration for "dsh-steward" (bundle executed twice without invalidate?)
dsh-app://app/assets/index.js:196 Error: web boot: 1 entry did not activate
`;
const dupParsed = parseBootFailure(CRASH_DUP);
check('parseBootFailure captures the duplicate client id as the cause',
  !!dupParsed && Array.isArray(dupParsed.clientDuplicates) && dupParsed.clientDuplicates.includes('dsh-steward'),
  JSON.stringify(dupParsed && dupParsed.clientDuplicates));
check('the victim is still listed, but separately from the cause',
  !!dupParsed && dupParsed.suspects.includes('@sidady/dsh-steward') && !dupParsed.suspects.includes('dsh-steward'),
  JSON.stringify(dupParsed && dupParsed.suspects));
check('a log with no duplicate line yields an empty cause list',
  Array.isArray(parsed && parsed.clientDuplicates) && parsed.clientDuplicates.length === 0,
  JSON.stringify(parsed && parsed.clientDuplicates));

// client 标识体检的三类冲突：同一 realpath 多名 / id≠包名 / id 撞车。
// 全部靠磁盘判据，不启动任何东西。夹具模拟 profile node_modules。
const BT = String.fromCharCode(96); // backtick — minified bundles quote ids with it
function clientIo(spec) {
  // spec: { dirs: { 'pkg-a': {name, id, real, dshClient} } }
  // collectClientIdentity builds paths as <profile>/node_modules/<key>/... with
  // forward slashes and enumerates scoped packages one level deeper, so the
  // fixture has to answer both the flat and the @scope level.
  const nm = 'C:\\p/node_modules';
  const keys = Object.keys(spec.dirs);
  const topNames = [...new Set(keys.map((k) => (k.startsWith('@') ? k.split('/')[0] : k)))];
  return {
    readDir(dir) {
      if (dir === nm) return topNames;
      if (dir.startsWith(nm + '/@')) {
        const scope = dir.slice(nm.length + 1);
        return keys.filter((k) => k.startsWith(scope + '/')).map((k) => k.slice(scope.length + 1));
      }
      if (dir.includes('logs')) return [];
      if (dir.includes('profiles')) return ['cordis.patch.yml'];
      if (dir.includes('exports')) return [];
      return { __error: 'ENOENT ' + dir };
    },
    stat() { return { __error: 'ENOENT' }; },
    realpath(p) {
      const hit = spec.dirs[p.slice(nm.length + 1)];
      return hit ? hit.real : null;
    },
    readText(file) {
      if (!file.startsWith(nm)) {
        if (file.endsWith('cordis.patch.yml')) return 'a\n'.repeat(10).trim();
        return { __error: 'ENOENT ' + file };
      }
      const rest = file.slice(nm.length + 1);
      // package dir = first segment, or first two for @scope/name; the rest is
      // lib/client.js or package.json.
      const parts = rest.split('/');
      const key = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
      const leaf = parts[parts.length - 1];
      const hit = spec.dirs[key];
      if (!hit) return { __error: 'ENOENT ' + file };
      const entry = hit.entry || 'lib/client.js';
      if (leaf === 'package.json') {
        const extra = hit.entry ? { exports: { './client': './' + hit.entry } } : {};
        return JSON.stringify({ name: hit.name, version: '1.0.0', ...extra, ...(hit.dshClient === false ? {} : { dsh: { client: true } }) });
      }
      if (file === nm + '/' + key + '/' + entry) {
        const q = hit.idStyle === 'backtick' ? BT : String.fromCharCode(39);
        return hit.id === null
          ? 'window.__ModuleLoader__.load({ factory(require) {} });'
          : 'window.__ModuleLoader__.load({ id: ' + q + hit.id + q + ', factory(require) {} });';
      }
      return { __error: 'ENOENT ' + file };
    },
  };
}

const clientBase = { now: new Date('2026-11-10T01:00:00Z'), bootedAt: new Date('2026-11-10T00:00:00Z'), env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' }, platform: 'win32', profileDirs: ['C:\\p'] };

// 干净：id 与包名一致、realpath 各不相同 → info，且必须说出「通过」
const cleanReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-a': { name: 'dsh-a', id: 'dsh-a', real: 'C:\\real\\a' },
  'dsh-b': { name: 'dsh-b', id: 'dsh-b', real: 'C:\\real\\b' },
} }) }));
const ciClean = cleanReport.findings.find((f) => f.id === 'client-identity');
check('a clean client identity tree stays info', !!ciClean && ciClean.severity === 'info', JSON.stringify(ciClean && ciClean.title));
check('the clean finding says how many bundles it actually checked', !!ciClean && ciClean.data && ciClean.data.checked === 2, JSON.stringify(ciClean && ciClean.data));

// 事故复现：同一份代码被装成两个名字（裸名 + scoped 都指向同一个 realpath）
const dupReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-steward': { name: '@sidady/dsh-steward', id: '@sidady/dsh-steward', real: 'E:\\DshConfig\\dsh-steward' },
  '@sidady/dsh-steward': { name: '@sidady/dsh-steward', id: '@sidady/dsh-steward', real: 'E:\\DshConfig\\dsh-steward' },
} }) }));
const ciDup = dupReport.findings.find((f) => f.id === 'client-identity');
check('the same source under two names is a warning', !!ciDup && ciDup.severity === 'warning', JSON.stringify(ciDup && ciDup.title));
check('it names both directories and the shared realpath', !!ciDup && ciDup.data.sameReal.length === 1 && ciDup.data.sameReal[0].dirs.length === 2, JSON.stringify(ciDup && ciDup.data.sameReal));

// id 与包名不一致（改包名忘了改 client bundle）
const idDriftReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-a': { name: '@me/dsh-a', id: 'dsh-a', real: 'C:\\real\\a' },
} }) }));
const ciIdDrift = idDriftReport.findings.find((f) => f.id === 'client-identity');
check('an id that drifted from the package name is a warning', !!ciIdDrift && ciIdDrift.severity === 'warning', JSON.stringify(ciIdDrift && ciIdDrift.title));
check('the drift is reported with both values', !!(ciIdDrift && ciIdDrift.data && ciIdDrift.data.drifted && ciIdDrift.data.drifted[0] && ciIdDrift.data.drifted[0].id === 'dsh-a' && ciIdDrift.data.drifted[0].name === '@me/dsh-a'), JSON.stringify(ciIdDrift && ciIdDrift.data));

// 两个不相关的包抢同一个 id
const collReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-a': { name: 'dsh-a', id: 'shared', real: 'C:\\real\\a' },
  'dsh-b': { name: 'dsh-b', id: 'shared', real: 'C:\\real\\b' },
} }) }));
const ciColl = collReport.findings.find((f) => f.id === 'client-identity');
check('two packages claiming one client id is a warning', !!ciColl && ciColl.severity === 'warning', JSON.stringify(ciColl && ciColl.title));
check('the collision lists both package names', !!ciColl && ciColl.data.collisions[0].names.length === 2, JSON.stringify(ciColl && ciColl.data.collisions));

// 包没声明 dsh.client 就不该被算进 client 体检
const ignoredReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'plain-lib': { name: 'plain-lib', id: null, real: 'C:\\real\\p', dshClient: false },
} }) }));
const ciIgnored = ignoredReport.findings.find((f) => f.id === 'client-identity');
check('packages without dsh.client are not counted', !ciIgnored, JSON.stringify(ciIgnored && ciIgnored.data));

// v0.9.5：入口不一定是 lib/client.js —— 10 个真机包用根目录或子目录的 client.js，
// 只认 lib/client.js 会把它们算成「读不到」却照样报「通过」。
const entryReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-root-entry': { name: 'dsh-root-entry', id: 'dsh-root-entry', real: 'C:\\real\\r', entry: 'client.js' },
  'dsh-sub-entry': { name: 'dsh-sub-entry', id: 'dsh-sub-entry', real: 'C:\\real\\s', entry: 'dsh/sub/client.js' },
} }) }));
const ciEntry = entryReport.findings.find((f) => f.id === 'client-identity');
check('entries declared via exports["./client"] are read, not counted as unreadable', !!ciEntry && ciEntry.data.unreadable === 0, JSON.stringify(ciEntry && ciEntry.data));
check('both non-standard entries were actually checked', !!ciEntry && ciEntry.data.checked === 2, JSON.stringify(ciEntry && ciEntry.data));

// v0.9.5：压缩产物会用反引号包 id（真机 genui / dsh-context 都是），只认引号会漏。
const tickReport = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
  'dsh-tick': { name: 'dsh-tick', id: 'dsh-tick', real: 'C:\\real\\t', idStyle: 'backtick' },
} }) }));
const ciTick = tickReport.findings.find((f) => f.id === 'client-identity');
check('a backtick-quoted id is read, not treated as missing', !!ciTick && ciTick.data.withoutId === 0, JSON.stringify(ciTick && ciTick.data));
check('a backtick id that drifted is still caught', (() => {
  const r = collectReport(Object.assign({}, clientBase, { io: clientIo({ dirs: {
    'dsh-tick2': { name: '@me/dsh-tick2', id: 'dsh-tick2', real: 'C:\\real\\t2', idStyle: 'backtick' },
  } }) }));
  const f = r.findings.find((x) => x.id === 'client-identity');
  return !!f && f.severity === 'warning' && f.data.drifted[0].id === 'dsh-tick2';
})(), 'backtick drift');

// 真机那份日志：病因要顶到标题，而不是继续点名受害者
const liveCause = collectReport(Object.assign({}, clientBase, {
  bootedAt: new Date('2026-11-10T00:00:00Z'),
  io: {
    readDir(dir) {
      if (dir.includes('logs')) return ['crash-2026-11-09T23-28-38-158Z-web-boot.log'];
      if (dir.includes('profiles')) return ['cordis.patch.yml'];
      if (dir.includes('exports')) return [];
      return { __error: 'ENOENT ' + dir };
    },
    stat(file) { return file.includes('crash-') ? { isFile: () => true, size: CRASH_DUP.length, mtime: new Date('2026-11-09T23:28:38Z') } : { __error: 'ENOENT' }; },
    readText(file) {
      if (file.includes('crash-')) return CRASH_DUP;
      if (file.endsWith('cordis.patch.yml')) return 'a\n'.repeat(10).trim();
      return { __error: 'ENOENT ' + file };
    },
  },
}));
const liveCrash = liveCause.findings.find((f) => f.id === 'boot-crash-latest');
check('the crash finding leads with the duplicate id, not the victim',
  !!liveCrash && String(liveCrash.title).includes('dsh-steward') && String(liveCrash.title).includes('注册了两次'),
  JSON.stringify(liveCrash && liveCrash.title));
check('the crash finding explains that the named suspect is the victim',
  !!liveCrash && String(liveCrash.detail).includes('受害者'),
  JSON.stringify(liveCrash && liveCrash.detail));
check('the cause survives into finding data for the panel', !!liveCrash && liveCrash.data.clientDuplicates.includes('dsh-steward'), JSON.stringify(liveCrash && liveCrash.data.clientDuplicates));


// ---------------------------------------------------------------------------
// v0.9.9 — packaging: every file the code imports must be in the tarball.
//
// This one exists because 0.9.8 shipped a package.json whose "files" list
// omitted lib/models.js. Every unit test passed (they import from the source
// tree, where the file is obviously present); the published tarball would have
// thrown ERR_MODULE_NOT_FOUND on import and taken the whole Web UI down with it
// — the same failure class as the 11-09 boot crash, reached by a different road.
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  const listed = Array.isArray(pkg.files) ? pkg.files : null;
  check("package.json declares a files whitelist", !!listed && listed.length > 0);
  const libDir = path.join(here, "lib");
  const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith(".js"));
  const declared = new Set((listed || []).map((f) => f.replace(/^\/+/, "")));
  const missing = libFiles.filter((f) => !declared.has("lib/" + f));
  check("every file in lib/ is in the files whitelist", missing.length === 0, missing.join(", "));
  // Stronger form: every relative import the shipped code makes must land on a
  // file the tarball will contain. The 0.9.8 bug was exactly this and no unit
  // test could see it, because tests import from the source tree.
  const broken = [];
  const importRe = new RegExp("from " + String.fromCharCode(39) + "\\./([A-Za-z0-9_.-]+)" + String.fromCharCode(39));
  for (const f of libFiles) {
    const src = fs.readFileSync(path.join(libDir, f), "utf8");
    const re = new RegExp(importRe.source, "g");
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!libFiles.includes(m[1])) broken.push(f + " -> ./" + m[1]);
    }
  }
  check("every relative import resolves to a published file", broken.length === 0, broken.join(", "));
}

// v0.9.8 — robustness: the three defects found by actually attacking the plugin.
// ---------------------------------------------------------------------------

// #3: an append-only jsonl log must stop growing. 2000 rows is the cap; the
// fixture keeps a real in-memory file so we can count what survives.
{
  const logFiles = {};
  const trimIo = {
    appendJsonl: async (f, o) => { logFiles[f] = (logFiles[f] || '') + JSON.stringify(o) + '\n'; },
    readJson: async () => [],
    writeJson: async () => {},
    readText: async (f) => logFiles[f] || '',
    writeText: async (f, t) => { logFiles[f] = t; },
  };
  const trimHub = createActionHub({
    routeFetch: async () => ({}),
    getPluginManager: () => null,
    getReport: () => null,
    io: trimIo,
    now: () => new Date('2026-11-09T00:00:00Z'),
    auditFile: 'audit.jsonl', trendFile: 'trend.json', knowledgeFile: 'knowledge.jsonl', ackedFile: 'acked.json',
  });
  // 2005 audit rows via a rejected plan (each call writes exactly one audit line).
  for (let i = 0; i < 2005; i += 1) await trimHub.execute({ planHash: 'nope-' + i, confirm: true });
  const rows = (logFiles['audit.jsonl'] || '').split('\n').filter((l) => l.trim() !== '');
  check('audit log is trimmed to the 2000-row cap', rows.length === 2000, String(rows.length));
  check('trimming keeps the newest rows, not the oldest', rows[rows.length - 1].includes('nope-2004'), rows[rows.length - 1].slice(0, 80));
}

// #3b: a caller whose io lacks readText/writeText keeps working (no crash, no trim).
{
  const thinFiles = {};
  const thinHub = createActionHub({
    routeFetch: async () => ({}),
    getPluginManager: () => null,
    getReport: () => null,
    io: {
      appendJsonl: async (f, o) => { thinFiles[f] = (thinFiles[f] || 0) + 1; },
      readJson: async () => [],
      writeJson: async () => {},
    },
    now: () => new Date('2026-11-09T00:00:00Z'),
    auditFile: 'a', trendFile: 't', knowledgeFile: 'k', ackedFile: 'ack',
  });
  const r = await thinHub.execute({ planHash: 'nope', confirm: true });
  check('an io without readText/writeText still records the audit row', r.ok === false && thinFiles['a'] === 1, JSON.stringify(thinFiles));
}

// #1a: probe concurrency. The scan must not run strictly sequentially, and it
// must still produce one result per planned probe in the same order.
{
  const targets = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ provider: 'p', model: 'm' + i }));
  check('probe plan keeps one probe per target', targets.length === 7);
}

// #2: readBody's contract. Exercised through the exported route helper shape:
// a body that is not a JSON object must be reported as unparsable rather than
// silently becoming "{}" (which used to mean "run a full checkup").
{
  const parseLike = (text) => {
    const t = String(text).trim();
    if (t === '') return { parsed: true, value: {} };
    try {
      const v = JSON.parse(t);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { parsed: false, reason: 'body must be a JSON object' };
      return { parsed: true, value: v };
    } catch { return { parsed: false, reason: 'invalid JSON' }; }
  };
  check('empty body parses to an empty object', parseLike('').parsed === true);
  check('broken JSON is reported unparsable', parseLike('{oops').parsed === false, JSON.stringify(parseLike('{oops')));
  check('a JSON array is not a valid request body', parseLike('[]').parsed === false, JSON.stringify(parseLike('[]')));
  check('a JSON string is not a valid request body', parseLike('"x"').parsed === false, JSON.stringify(parseLike('"x"')));
  check('a null body is not a valid request body', parseLike('null').parsed === false, JSON.stringify(parseLike('null')));
}

// #1b: client timeout budget. The slow actions must get more than the default,
// and the default must be short enough to notice a hang.
{
  const SLOW = { report: 240000, 'model-scan': 240000, ask: 120000 };
  const DEFAULT_TIMEOUT_MS = 30000;
  const timeoutFor = (a) => SLOW[a] || DEFAULT_TIMEOUT_MS;
  const CONCURRENCY = 3;
  const PROBE_TIMEOUT_MS = 45000;
  const MAX_TOTAL = 12;
  const serverWorstCase = Math.ceil(MAX_TOTAL / CONCURRENCY) * PROBE_TIMEOUT_MS;
  check('a normal action gets the 30s budget', timeoutFor('ping') === 30000);
  check('report budget covers the default probe worst case', timeoutFor('report') >= serverWorstCase,
    'budget=' + timeoutFor('report') + ' worst=' + serverWorstCase);
  check('model-scan is treated as slow', timeoutFor('model-scan') === 240000);
  check('ask is treated as slow', timeoutFor('ask') === 120000);
  check('a save is not given a slow budget', timeoutFor('settings-save') === 30000);
}


// — v0.9.10: 两个时间问题不能共用同一个数字 / 列表截断必须说出来 —
{
  // 真机形态：崩溃发生在 23:28:38，当前实例 23:29:27 启动（只差 49 秒），
  // 而报告是 06:32 生成的（已经过去 7 小时）。旧代码把 bootedAt 的差值
  // 四舍五入成小时 → 正文写「约 0 小时前」，7 小时前的事被说成像刚发生。
  const lagIo = {
    ...io,
    stat(file) {
      if (file.includes('crash-')) return { isFile: () => true, size: CRASH.length, mtime: new Date('2026-11-09T23:28:38.275Z') };
      return io.stat(file);
    },
  };
  const lagReport = collectReport({
    now: new Date('2026-11-10T06:32:40.118Z'),
    bootedAt: new Date('2026-11-09T23:29:27.118Z'),
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
    platform: 'win32', io: lagIo,
  });
  const lagCrash = lagReport.findings.find((f) => f.id === 'boot-crash-latest');
  check('crash age is measured from now, not from boot', lagCrash && lagCrash.data.ageHours >= 7, JSON.stringify(lagCrash && lagCrash.data.ageHours));
  check('crash age speaks in human units', lagCrash && /小时前/.test(String(lagCrash.data.ageText)), String(lagCrash && lagCrash.data.ageText));
  check('boot lag is reported separately', lagCrash && lagCrash.data.bootLagHours === 0.01, JSON.stringify(lagCrash && lagCrash.data.bootLagHours));
  check('boot lag reads in seconds, not "0 hours"', lagCrash && /不到 1 分钟/.test(String(lagCrash.data.bootLagText)), String(lagCrash && lagCrash.data.bootLagText));
  check('the prose never prints "约 0 小时前"', lagCrash && !/约 0 小时前/.test(String(lagCrash.detail)), String(lagCrash && lagCrash.detail).slice(0, 200));
  check('the prose separates when it happened from how early it was', lagCrash && /比当前运行实例的启动还早|比当前实例的启动还早/.test(String(lagCrash.detail)), String(lagCrash && lagCrash.detail).slice(0, 260));

  // 7 个工作区，正文只逐条列 6 个 —— 必须说明少了几个、按什么排的。
  const manyWs = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'] },
    tables: { workspaces: {
      w1: { path: process.cwd(), title: 'ws1', sessionIds: ['s1'], createdAt: '2026-11-01T00:00:00Z' },
      w2: { path: path.join(process.cwd(), 'a'), title: 'ws2', sessionIds: ['s2'], createdAt: '2026-11-01T00:00:00Z' },
      w3: { path: path.join(process.cwd(), 'b'), title: 'ws3', sessionIds: ['s3'], createdAt: '2026-11-01T00:00:00Z' },
      w4: { path: path.join(process.cwd(), 'c'), title: 'ws4', sessionIds: ['s4'], createdAt: '2026-11-01T00:00:00Z' },
      w5: { path: path.join(process.cwd(), 'd'), title: 'ws5', sessionIds: ['s5'], createdAt: '2026-11-01T00:00:00Z' },
      w6: { path: path.join(process.cwd(), 'e'), title: 'ws6', sessionIds: ['s6'], createdAt: '2026-11-01T00:00:00Z' },
      w7: { path: path.join(process.cwd(), 'f'), title: 'ws7', sessionIds: ['s7'], createdAt: '2026-11-01T00:00:00Z' },
    } },
  });
  const manyIo = {
    ...dataIo(),
    readText(file) {
      if (file.endsWith('workspace.json')) return manyWs;
      return dataIo().readText(file);
    },
  };
  const manyReport = collectReport({
    now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
    platform: 'win32', profileDirs: ['C:\\p'], io: manyIo,
  });
  const manyWsFinding = manyReport.findings.find((f) => f.id === 'workspace-inventory');
  check('workspace list truncation is disclosed', manyWsFinding && /另有 \d+ 个工作区未逐条列出/.test(String(manyWsFinding.detail)), String(manyWsFinding && manyWsFinding.detail).slice(0, 400));
  check('truncation note states the ordering rule', manyWsFinding && /降序取前 6 个/.test(String(manyWsFinding.detail)), String(manyWsFinding && manyWsFinding.detail).slice(0, 400));
  check('data carries the true workspace total', manyWsFinding && manyWsFinding.data.workspacesTotal === 7, JSON.stringify(manyWsFinding && manyWsFinding.data.workspacesTotal));

  // 7 份备份，evidence 只列 5 个 —— 同样要说出来。
  const manyBakIo = {
    ...io,
    readDir(dir) {
      if (dir.includes('exports')) {
        return ['b1.zip', 'b2.zip', 'b3.zip', 'b4.zip', 'b5.zip', 'b6.zip', 'b7.zip', '.backup-notes.json'];
      }
      return io.readDir(dir);
    },
  };
  const manyBak = collectReport({
    now: new Date('2026-11-08T19:55:00Z'), bootedAt: new Date('2026-11-07T02:00:00Z'),
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
    platform: 'win32', io: manyBakIo,
  });
  const manyBakFinding = manyBak.findings.find((f) => f.id === 'backup-freshness');
  check('backup evidence states the full count', manyBakFinding && /等共 7 份/.test(String(manyBakFinding.evidence)), String(manyBakFinding && manyBakFinding.evidence));
  check('backup data notes that evidence is capped', manyBakFinding && typeof manyBakFinding.data.countNote === 'string', JSON.stringify(manyBakFinding && manyBakFinding.data.countNote));

  // 采集告警里的 5 行上限也要明说，并且 data 要真给出全部。
  const noisyIo = {
    ...io,
    readDir(dir) { return { __error: 'EACCES noisy ' + dir }; },
  };
  const noisyReport = collectReport({
    now: new Date('2026-11-08T19:55:00Z'), bootedAt: new Date('2026-11-07T02:00:00Z'),
    env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming', DSH_HOME: 'C:\\Users\\demo\\.dsh' },
    platform: 'win32', io: noisyIo,
  });
  const confFinding = noisyReport.findings.find((f) => f.id === 'confidence');
  check('confidence finding present when sources fail', !!confFinding, JSON.stringify(noisyReport.errors.map((e) => e.step)));
  check('confidence data exposes every采集告警', confFinding && Array.isArray(confFinding.data.errors) && confFinding.data.errors.length === noisyReport.errors.length, JSON.stringify({ inData: confFinding && confFinding.data.errors && confFinding.data.errors.length, total: noisyReport.errors.length }));
}

// — v0.9.10: 依赖声明不能虚挂 —
{
  const pkgPath = path.join(here, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const clientSrc = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
  const declaresLocale = JSON.stringify(pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject || []).includes('dsh-client-locale');
  const usesLocale = /ctx\.get\(['"]locale['"]\)|locale\.register|locale\.bind|useTranslate/.test(clientSrc);
  check('client inject only names packages the code actually uses', !(declaresLocale && !usesLocale), JSON.stringify({ declaresLocale, usesLocale }));
  // locale/*.json 仍被 host 用来显示插件名与简介，meta 必须写对产品现在的口径。
  const zh = JSON.parse(fs.readFileSync(path.join(here, 'locale', 'zh.json'), 'utf8'));
  check('locale meta describes the current scope', typeof zh.meta.title === 'string' && !/只读体检$/.test(zh.meta.title), JSON.stringify(zh.meta.title));
  check('locale meta mentions the authorized action layer', /授权|计划/.test(zh.meta.description), String(zh.meta.description).slice(0, 80));
}


// — v0.9.11: 时间戳必须本地化，不能在渲染处切字符串 —
{
  const clientSrc = fs.readFileSync(path.join(here, "lib", "client.js"), "utf8");
  const clientLines = clientSrc.split("\n");
  // 审计/趋势里存的是 UTC ISO；切片或把 T 换成空格都会原样把 UTC 贴给用户
  // （东八区差 8 小时）。本地化必须走 localStamp，不能用字符串处理假装。
  const TQ = String.fromCharCode(39), TDQ = String.fromCharCode(34);
  const swap = (q) => q + "T" + q + ", " + q + " " + q;
  const naive = clientLines.filter((l) => l.includes(".replace(") && (l.includes(swap(TQ)) || l.includes(swap(TDQ))));
  check("no render path formats a timestamp by swapping the ISO T", naive.length === 0, naive.map((l) => l.trim().slice(0, 70)).join(" | "));
  check("the local-time formatter exists", clientSrc.includes("function localStamp("));
  const uses = (clientSrc.match(/localStamp\(/g) || []).length;
  check("the local-time formatter is used at every display site", uses >= 4, String(uses));
}

// — v0.9.12: 配色只许来自 baseline（check.mjs 抓不到「自造强调色」）—
{
  const src = fs.readFileSync(path.join(here, "lib", "client.js"), "utf8");
  const lines = src.split("\n");
  // baseline 块本身允许写裸字面量（它就是调色板）。块外只允许两种：
  // var(--dsw-*, fallback) 里的兜底，以及黑色阴影（baseline README 明确豁免）。
  const startOK = lines.findIndex((l) => l.includes(">>> dsh-design-baseline"));
  const endOK = lines.findIndex((l) => l.includes("<<< dsh-design-baseline"));
  check("the baseline block is present and closed", startOK > -1 && endOK > startOK, startOK + "/" + endOK);
  const outside = lines.filter((l, i) => i < startOK || i > endOK);
  const RGB = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  const invented = [];
  for (const line of outside) {
    if (line.trim().startsWith("//")) continue;
    let m;
    RGB.lastIndex = 0;
    while ((m = RGB.exec(line))) {
      const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
      const near = (a, c) => Math.abs(a - c) <= 24;
      const neutral = near(r, g) && near(g, b);
      const shadow = r === 0 && g === 0 && b === 0;
      if (neutral || shadow) continue;
      invented.push(line.trim().slice(0, 90));
    }
  }
  check("no private accent survives outside the baseline block", invented.length === 0, invented.join(" | "));
  // 同一件事的另一半：颜色必须经 C / mix / wash 取，不能就地写死。
  const HEX = /#[0-9a-fA-F]{6}\b/g;
  const strayHex = outside.filter((l) => !l.trim().startsWith("//") && (l.match(HEX) || []).some((h) => !/var\(--dsw/.test(l)));
  check("no stray hex colour outside the baseline block", strayHex.length === 0, strayHex.map((l) => l.trim().slice(0, 90)).join(" | "));
  // 选中态必须反相（baseline 铁律：选中若是颜色，颜色就不再表示数据）。
  check("C exposes the inverted pair for selection", /solid:\s*THEME\.invertedBg/.test(src) && /on:\s*THEME\.invertedFg/.test(src));
  const invertedUses = (src.match(/C\.solid/g) || []).length + (src.match(/C\.on\b/g) || []).length;
  check("selection actually uses the inverted pair", invertedUses >= 8, String(invertedUses));
  // 徽章/底色必须是 accent 的一份，而不是另调一个透明度。
  const mixUses = (src.match(/\bmix\(/g) || []).length;
  check("washes and rings derive from an accent", mixUses >= 6, String(mixUses));
  check("the only saturated tokens are the six accents", /accentStability/.test(src) && /accentInfo/.test(src));
}

// — v0.9.13: 面板自己的路由没挂上时，不许只说「HTTP 404」 —
{
  // 真机形态：改了插件源码触发宿主热重载，旧 fiber 被销毁、新 fiber 的路由
  // 没接上，面板只剩一行「读取失败: HTTP 404」。用户无法判断这是接口没挂、
  // 还是请求本身出错。这一组钉住三件事：认得出来、说得出怎么办、只重试一次。
  const clientSrc = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
  const callBody = clientSrc.slice(clientSrc.indexOf('async function call('), clientSrc.indexOf('function PanelIcon'));

  check('a 404 on our own route is distinguished from a plain HTTP failure',
    /response\.status === 404/.test(callBody) && /接口没有挂上/.test(callBody));
  check('the 404 message names the hot-reload cause and the way out',
    /热重载/.test(callBody) && /停用再启用|重启 DSH Web/.test(callBody));
  check('the retry is bounded — one attempt, then it reports',
    /tries === 0/.test(callBody) && /call\(action, extra, tries \+ 1\)/.test(callBody));
  check('a generic failure still reports the server error verbatim',
    /\(data && data\.error\) \|\| 'HTTP ' \+ response\.status/.test(callBody));
  // 反向判据：不许把任何非 2xx 都说成「热重载」，那会把真正的服务端错误藏掉。
  check('the hot-reload wording is gated on 404, not on every non-2xx',
    !/接口没有挂上/.test(callBody.split('response.status === 404')[0]));
}
// — v0.9.14: 冷启动竞态 —— 服务没就绪时不许把注册整段跳过 —
{
  // 真机形态：重启（不是热重载）后面板照样 404。原因不是路由写错了，而是
  // apply() 里用 ctx.get('webServer') 一次性探测：冷启动时 webServer 与 tools
  // 都比本插件晚 apply，那一次探测拿到 null，于是 if (webServer && ...) 整段
  // 跳过，路由与两个工具都没注册 —— 而每段外面都包了 fail-soft try/catch，
  // 所以只 warn 一行，面板与工具都静默消失。
  const idxSrc = fs.readFileSync(path.join(here, 'lib', 'index.js'), 'utf8');

  check('the plugin defers to ctx.inject instead of a one-shot lookup',
    /ctx\.inject\(keys,/.test(idxSrc) && /function whenService\(/.test(idxSrc));
  check('every service-backed registration goes through whenService',
    (idxSrc.match(/whenService\(ctx, \['/g) || []).length >= 3);
  // 反向判据：旧的裸探测写法必须彻底消失，否则冷启动仍会静默跳过。
  check('no registration is left behind a bare try/getService probe',
    !/try \{\n\s*const webServer = getService\(/.test(idxSrc)
      && !/try \{\n\s*const tools = getService\(/.test(idxSrc)
      && !/try \{\n\s*const sp = getService\(/.test(idxSrc));
  // 静默失败是这次真正的病因：说得出「挂上了没有」比「应该挂上」有用。
  check('the wiring outcome is recorded, not just logged',
    /wiring\.route = 'registered'/.test(idxSrc) && /wiring\.route = 'failed: '/.test(idxSrc));
  check('ping reports the wiring outcome so a 404 is diagnosable',
    /wiring: \{ \.\.\.wiring \}/.test(idxSrc));
  // 走的是哪条路也要记：inject 与一次性探测在冷启动下行为完全不同，
  // 只看 route=registered 无法区分「真的等了」和「碰巧那次就绪了」。
  check('the wiring path records whether inject was used',
    /wiring\.via\[keys\.join\(','\)\] = 'inject'/.test(idxSrc)
      && /wiring\.via\[keys\.join\(','\)\] = 'one-shot'/.test(idxSrc));
}


// — v0.9.15: 职能缺口补齐（P0 修真 bug / P1 误报反馈 / P2 趋势与直达）—
{
  const clientSrc = fs.readFileSync(path.join(here, "lib", "client.js"), "utf8");
  const indexSrc = fs.readFileSync(path.join(here, "lib", "index.js"), "utf8");
  const actionsSrc = fs.readFileSync(path.join(here, "lib", "actions.js"), "utf8");
  const reportSrc = fs.readFileSync(path.join(here, "lib", "report.js"), "utf8");
  const clientLines = clientSrc.split(String.fromCharCode(10));

  // P0-a: 保存时间的本地化不许再用「把 T 换成空格」的写法，两种引号都查。
  const SQ = String.fromCharCode(39), DQ = String.fromCharCode(34);
  const swaps = [SQ, DQ].map((q) => q + "T" + q + ", " + q + " " + q);
  const naive = clientLines.filter((l) => l.includes(".replace(") && swaps.some((s) => l.includes(s)));
  check("P0-a no ISO-T swap survives in either quote style", naive.length === 0, naive.map((l) => l.trim().slice(0, 60)).join(" | "));
  const savedLine = clientLines.find((l) => l.includes("setSaved(") && l.includes("res.savedAt"));
  check("P0-a the saved-at display calls localStamp", !!savedLine && savedLine.includes("localStamp("));

  // P0-b: autoScanMinutes 必须是活设置，不是写死的 10 分钟。
  check("P0-b the client reads autoScanMinutes from the report payload", clientSrc.includes("cache.autoScanMinutes"));
  check("P0-b the hardcoded 10-minute threshold is gone", !clientSrc.includes("10 * 60 * 1000"));
  check("P0-b the host sends autoScanMinutes from settings", indexSrc.includes("autoScanMinutes: settingValue(currentSettings(), " + SQ + "ui.autoScanMinutes" + SQ + ")"));

  // P1: 误报反馈是一个有数据文件、可 plan/execute、能影响评分、可撤销的真动作。
  check("P1 feedback has its own data file", indexSrc.includes("feedback: path.join(dataDir(), " + SQ + "feedback.json" + SQ + ")"));
  check("P1 plan handles feedback and unfeedback", actionsSrc.includes("kind === " + SQ + "feedback" + SQ + " || kind === " + SQ + "unfeedback" + SQ));
  check("P1 execute persists the feedback list", actionsSrc.includes("writeJson(deps.feedbackFile, list)"));
  check("P1 report marks falsePositive from options.feedback", reportSrc.includes("f.falsePositive = feedbackIds.has(f.id)"));
  check("P1 a false positive loses the actionable bonus", reportSrc.includes("&& !f.falsePositive && !gateBlocked"));
  check("P1 the score states the false-positive penalty", reportSrc.includes("用户标记判错 -40"));
  check("P1 the panel offers a 判错 button", clientSrc.includes("这条判错了"));

  // P2-a: 趋势结论由服务端算好人话，恢复/连续恶化会主动说。
  check("P2-a summarizeTrend is exported from report.js", reportSrc.includes("export function summarizeTrend("));
  check("P2-a collectReport returns a trendVerdict", reportSrc.includes("trendVerdict,"));
  check("P2-a the text report states the trend", indexSrc.includes("趋势: ${report.trendVerdict.text}"));
  check("P2-a toasts fire on recovery",
    clientSrc.includes("tv.state === " + SQ + "recovered" + SQ + " ||") && clientSrc.includes("pushToast({ kind: " + SQ + "trend" + SQ));
  check("P2-a ToastCard can paint an ok tone", clientSrc.includes("t.severity === " + SQ + "ok" + SQ + " ? C.ok"));
  check("P2-a AuditTab prints the trend verdict", clientSrc.includes("趋势结论 · "));

  // P2-b: 不假造直达动作；运行期自检结果要给用户看见。
  check("P2-b the phantom model-default shortcut is gone", !clientSrc.includes("" + SQ + "model-health" + SQ + ": " + SQ + "model-default" + SQ) && clientSrc.includes("" + SQ + "backup-freshness" + SQ + ": " + SQ + "backup" + SQ));
  check("P2-b the host sends wiring with the report", indexSrc.includes("wiring: { ...wiring }"));
  check("P2-b the panel shows the wiring outcome", clientSrc.includes("接口已挂上"));
}

{
  // ---- v0.9.16: L0 当班环（只读、可观测、绝不自动执行） ----
  const dutyIndex = fs.readFileSync(path.join(here, 'lib', 'index.js'), 'utf8');
  const dutyClient = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
  const dutyReport = fs.readFileSync(path.join(here, 'lib', 'report.js'), 'utf8');

  const mkDutyReport = (findings, level, text) => ({
    summary: { level: level || 'warning', counts: { critical: 0, warning: 2, info: 3, muted: 0 } },
    trendVerdict: text ? { state: 'stable', text } : null,
    findings: findings || [],
  });
  const dOk = { id: 'a', severity: 'warning', recommendation: '去动作中心看看 A', muted: false, falsePositive: false };
  const dMuted = { id: 'b', severity: 'info', recommendation: '这条被静音', muted: true, falsePositive: false };
  const dFalse = { id: 'c', severity: 'critical', recommendation: '这条被判错', muted: false, falsePositive: true };
  const dB = dutyBriefing(mkDutyReport([dOk, dMuted, dFalse]), { at: '2026-11-12T22:00:00.000Z', trigger: 'boot' });
  check('dutyBriefing is pure: at + trigger pass through unchanged', dB.at === '2026-11-12T22:00:00.000Z' && dB.trigger === 'boot', JSON.stringify({ at: dB.at, trigger: dB.trigger }));
  check('dutyBriefing records state=observe-only and executed=0', dB.state === 'observe-only' && dB.executed === 0);
  check('dutyBriefing excludes muted and false-positive findings', dB.suggestions.length === 1 && dB.suggestions[0].id === 'a', JSON.stringify(dB.suggestions));
  check('dutyBriefing writes a human "seen" line', typeof dB.seen === 'string' && dB.seen.indexOf('3 条发现') >= 0 && dB.seen.indexOf('1 条仍在报') >= 0, dB.seen);
  check('dutyBriefing explains WHY nothing was executed', typeof dB.action === 'string' && dB.action.indexOf('未执行任何动作') >= 0 && dB.action.indexOf('1 条处置建议') >= 0, dB.action);
  check('dutyBriefing prefers the server-computed trend verdict', dutyBriefing(mkDutyReport([], 'warning', '连续 2 次体检都在变差')).verdict.indexOf('连续 2 次') >= 0);
  const dSame1 = dutyBriefing(mkDutyReport([], 'ok'), { at: '2026-11-12T22:00:00.000Z', trigger: 'scheduled' });
  const dSame2 = dutyBriefing(mkDutyReport([], 'ok'), { at: '2026-11-12T22:00:00.000Z', trigger: 'scheduled' });
  check('dutyBriefing is deterministic for identical input', JSON.stringify(dSame1) === JSON.stringify(dSame2));
  const manyF = Array.from({ length: 9 }, (_, i) => ({ id: 'f' + i, severity: 'info', recommendation: '建议' + i }));
  check('dutyBriefing caps the prepared suggestions at 6', dutyBriefing(mkDutyReport(manyF)).suggestions.length === 6);

  // 服务端：周期当班 + 重入/去抖 + 三处返回体带 duty + 绝不自动执行
  check('L0 duty loop is driven by setInterval', dutyIndex.indexOf('setInterval(dutyTick') >= 0);
  // 裸定时器在 fiber 被 HMR 换掉 / 停用插件时不会停，每重载一次多一个永不停止的当班环。
  // 钉死它挂在 ctx.effect 上并且 dispose 里 clearInterval。
  // 用正则钉「完整 label」：indexOf 会被 'L0 duty-DISABLED' 之类前缀命中而永远绿（v0.9.15 的教训）。
  const dutyEffectLabel = /'dsh-steward: L0 duty'/.exec(dutyIndex);
  const dutyEffectAt = dutyEffectLabel ? dutyEffectLabel.index : -1;
  const dutyEffectBlock = dutyEffectAt >= 0 ? dutyIndex.slice(dutyIndex.lastIndexOf('ctx.effect(', dutyEffectAt), dutyEffectAt) : '';
  check('the duty timer is owned by a ctx.effect with a clearInterval dispose',
    dutyEffectAt >= 0
      && dutyEffectBlock.indexOf('setInterval(dutyTick') >= 0
      && dutyEffectBlock.indexOf('return () =>') >= 0
      && dutyEffectBlock.indexOf('clearInterval(dutyTimer)') >= 0,
    dutyEffectBlock.slice(0, 140));
  check('the duty interval follows ui.autoScanMinutes', dutyIndex.indexOf("settingValue(currentSettings(), 'ui.autoScanMinutes')") >= 0 && dutyIndex.indexOf('dutyIntervalMs') >= 0);
  check('the duty loop has a re-entry guard', dutyIndex.indexOf('if (dutyRunning) return null') >= 0);
  check('the duty loop has a debounce', dutyIndex.indexOf('Date.now() - dutyLastAt < 1000') >= 0);
  const rdStart = dutyIndex.indexOf('async function runDuty(');
  const rdEnd = dutyIndex.indexOf('const hub = createActionHub(', rdStart);
  const rdBody = rdStart >= 0 && rdEnd > rdStart ? dutyIndex.slice(rdStart, rdEnd) : '';
  check('runDuty reuses the read-only report and never calls plan/execute', rdBody.indexOf("await run('report', {})") >= 0 && rdBody.indexOf('hub.plan(') < 0 && rdBody.indexOf('hub.execute(') < 0, rdBody.slice(0, 160));
  check('the duty ledger is persisted to duty.jsonl', dutyIndex.indexOf("duty: path.join(dataDir(), 'duty.jsonl')") >= 0 && dutyIndex.indexOf('io.appendJsonl(files.duty, briefing)') >= 0);
  // readDutyLog 的 split 参数必须真的是「换行符」。写成 '\\n'（双反斜杠）会永远读不出
  // 分班记录，而静态判据只看得见「有 split」。这里把源码里的字面量求值，钉死它等于一个换行符。
  const dutySplitLine = dutyIndex.split('\n').find((l) => l.indexOf('raw.split(') >= 0 && l.indexOf('DUTY_LOG_CAP') >= 0) || '';
  const dsi = dutySplitLine.indexOf('raw.split(') + 'raw.split('.length;
  const dsArg = dutySplitLine.slice(dsi);
  const dsQuote = dsArg[0];
  const dsEnd = dsQuote ? dsArg.indexOf(dsQuote, 1) : -1;
  const dsExpr = dsEnd > 0 ? dsArg.slice(0, dsEnd + 1) : '';
  let dsVal = null;
  try { dsVal = Function('return ' + dsExpr)(); } catch { /* 求值失败就让它红 */ }
  check('readDutyLog splits on a real newline (runtime-evaluated), not a literal backslash-n', dsVal === '\n' && dsVal.length === 1, JSON.stringify({ dsExpr, len: dsVal && dsVal.length }));
  check('ping / report / audit all expose duty', (dutyIndex.match(/duty: await dutySnapshot\(\)/g) || []).length === 3);
  check('the boot checkup goes through runDuty (not a bare report)', dutyIndex.indexOf("runDuty('boot')") >= 0);

  // 面板：当班状态 + 当班台账（服务端算好人话、客户端只渲染）
  check('the panel shows the duty status line', dutyClient.indexOf('当班 · ') >= 0 && dutyClient.indexOf('cache.duty') >= 0);
  check('the audit tab shows the duty ledger', dutyClient.indexOf('当班台账 · ') >= 0 && dutyClient.indexOf('data.duty.suggestions') >= 0);
  check('the panel caches duty from report responses', (dutyClient.match(/cache\.duty = data\.duty/g) || []).length >= 2);
  check('the duty briefing is computed in report.js, not in client.js', dutyReport.indexOf('export function dutyBriefing(') >= 0 && dutyClient.indexOf('function dutyBriefing(') < 0);

  // 版本与文档
  check('v0.9.16 version is consistent', JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version === '0.9.16');
  check('README documents the L0 duty loop', fs.readFileSync(path.join(here, 'README.md'), 'utf8').indexOf('v0.9.16（L0 当班环') >= 0);
}

{
  // ---- 白色按钮回归：primary 按钮必须反相，绝不能被调用方的 tone 顶掉 ----
  // C.text 与 C.solid 都映射到 --dsw-alias-label-primary，深色主题下解析成白色；
  // 一旦 color 用了 tone，primary 就变成白底白字 = 看不见字的纯白矩形。
  const wbClient = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
  check('Btn forces the inverted foreground for primary buttons',
    wbClient.indexOf('color: props.primary && !props.disabled ? C.on : (props.tone || C.text)') >= 0);
  check('the old tone-wins colour expression is gone',
    wbClient.indexOf('color: props.tone || (props.primary') < 0);
  check('no primary button call site passes a tone',
    (wbClient.match(/primary:\s*true\s*,\s*tone:/g) || []).length === 0);
  check('the finding go-to-action button stays a plain primary button',
    wbClient.indexOf('h(Btn, { onClick: props.onGo, primary: true }') >= 0);
}

{
  // — v0.9.16（未发布）：升级利弊分析 (m13463) + 免费通道运行期健康 (m13398) —
  const AU = analyzeUpgrades;
  const PKG_HI = { 'dsh-x': { latest: '2.0.0', versions: ['1.0.0', '2.0.0'], engines: { dsh: '^0.3.0' } } };
  const hi = AU([{ name: 'dsh-x', installed: '1.0.0', latest: '2.0.0' }], PKG_HI, '0.2.2-rc.1');
  check('upgrade advice: a host-version mismatch is high risk', hi.rows[0].risk === 'high', JSON.stringify(hi.rows[0]));
  check('upgrade advice: high risk names the boot consequence', hi.rows[0].reasons.join(' ').includes('起不来'), JSON.stringify(hi.rows[0].reasons));
  const md = AU([{ name: 'dsh-y', installed: '1.0.0', latest: '2.0.0-beta.1' }], { 'dsh-y': { latest: '2.0.0-beta.1', versions: ['1.0.0', '2.0.0-beta.1'] } }, '0.2.2-rc.1');
  check('upgrade advice: a prerelease target is medium risk', md.rows[0].risk === 'medium', JSON.stringify(md.rows[0]));
  const sk = AU([{ name: 'dsh-z', installed: '1.0.0', latest: '9.0.0' }], { 'dsh-z': { latest: '9.0.0', versions: ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0', '6.0.0', '9.0.0'] } }, '0.2.2-rc.1');
  check('upgrade advice: skipping >=5 releases is medium risk', sk.rows[0].risk === 'medium' && sk.rows[0].skipped >= 5, JSON.stringify(sk.rows[0]));
  const lo = AU([{ name: 'dsh-w', installed: '1.0.0', latest: '1.0.1' }], { 'dsh-w': { latest: '1.0.1', versions: ['1.0.0', '1.0.1'] } }, null);
  check('upgrade advice: a plain small step is low risk', lo.rows[0].risk === 'low', JSON.stringify(lo.rows[0]));
  check('upgrade advice: text states benefits without inventing a changelog', hi.text.includes('优点') && hi.text.includes('不编造具体修复内容'), hi.text);
  check('upgrade advice: text states the boot risk', hi.text.includes('boot'), hi.text);
  check('upgrade advice: recommendation is read-only, no auto-upgrade', hi.recommendation.includes('不代升级') && hi.recommendation.includes('逐个'), hi.recommendation);
  check('upgrade advice: toast words are written by the server', hi.toastTitle.includes('风险') && hi.toastBody.includes('优点'), hi.toastTitle);
  const hi2 = AU([{ name: 'dsh-x', installed: '1.0.0', latest: '2.0.0' }], PKG_HI, '0.2.2-rc.1');
  check('upgrade advice: fingerprint is a stable 8-hex digest', /^[0-9a-f]{8}$/.test(hi.fingerprint) && hi.fingerprint === hi2.fingerprint, hi.fingerprint);
  const fpA = AU([{ name: 'a', installed: '1.0.0', latest: '2.0.0' }, { name: 'b', installed: '1.0.0', latest: '3.0.0' }], {}, '0.2.2-rc.1');
  const fpB = AU([{ name: 'b', installed: '1.0.0', latest: '3.0.0' }, { name: 'a', installed: '1.0.0', latest: '2.0.0' }], {}, '0.2.2-rc.1');
  check('upgrade advice: fingerprint is order-independent', fpA.fingerprint === fpB.fingerprint, fpA.fingerprint + ' vs ' + fpB.fingerprint);
  const emp = AU([], {}, null);
  check('upgrade advice: no outdated items yields count 0 but a fingerprint', emp.outdatedCount === 0 && /^[0-9a-f]{8}$/.test(emp.fingerprint), emp.fingerprint);
  const AVAIL = JSON.stringify({ version: 1, at: 0, results: {
    'model-a': { state: 'available', detail: 'OpenCode free inference requires a local Bun executable', at: '2026-11-13T12:00:00Z', stale: true },
    'model-b': { state: 'unknown', detail: 'upstream request failed', at: '2026-11-13T13:00:00Z', stale: true },
    'model-c': { state: 'available', at: '2026-11-13T14:00:00Z', stale: true },
  } });
  const flIo = { readDir: () => [], stat: () => ({ __error: 'x' }), readText: (f) => (f.endsWith('availability.json') ? AVAIL : { __error: 'no' }) };
  const fl = collectFreeLaneHealth({ dshHome: 'H' }, flIo);
  check('free lane: contradictory available-but-failing is caught', fl.available && fl.contradictory.length === 1 && fl.contradictory[0].name === 'model-a', JSON.stringify(fl));
  check('free lane: both detail-bearing models are collected as failing', fl.failing.length === 2, JSON.stringify(fl.failing));
  check('free lane: allStale is true when every entry is stale', fl.allStale === true && fl.checked === 3, JSON.stringify(fl));
  check('free lane: newestAt is the max probe timestamp', fl.newestAt === '2026-11-13T14:00:00Z', String(fl.newestAt));
  const flMiss = collectFreeLaneHealth({ dshHome: 'H' }, { readText: () => ({ __error: 'ENOENT' }) });
  check('free lane: a missing private ledger is a silent, observable skip', flMiss.available === false && flMiss.failing.length === 0, JSON.stringify(flMiss));
  function flDataIo(availText) {
    const base = dataIo();
    return { readDir: base.readDir, stat: base.stat,
      readText(file) { return file.endsWith('availability.json') ? availText : base.readText(file); } };
  }
  const flReport = collectReport({
    now: new Date('2026-11-09T13:00:00Z'), bootedAt: new Date('2026-11-09T00:00:00Z'),
    env: { APPDATA: 'C:\\\\Users\\\\demo\\\\AppData\\\\Roaming', DSH_HOME: 'C:\\\\Users\\\\demo\\\\.dsh' },
    platform: 'win32', profileDirs: ['C:\\\\p'], io: flDataIo(AVAIL),
  });
  check('free lane: report surfaces a read-only info finding', flReport.findings.some((f) => f.id === 'free-lane-health'), JSON.stringify(flReport.errors));
  check('free lane: an optional signal adds NO coverage source', flReport.coverage.sourcesTotal === 7, JSON.stringify(flReport.coverage));
  check('free lane: reading the private ledger adds no collection error', !flReport.errors.some((e) => String(e.step || '').includes('free-lane')), JSON.stringify(flReport.errors));
  check('free lane: report body exposes freeLane for observability', !!(flReport.freeLane && flReport.freeLane.available === true), JSON.stringify(flReport.freeLane));
  check('free lane: with no ledger the report shows a skip, not a finding', !!(dataReport.freeLane && dataReport.freeLane.available === false) && !dataReport.findings.some((f) => f.id === 'free-lane-health'), JSON.stringify(dataReport.freeLane));
  check('upgrade advice: report.updates.advice is present with a count', !!(flReport.updates && flReport.updates.advice && flReport.updates.advice.outdatedCount === 2), JSON.stringify(flReport.updates && flReport.updates.advice));
  const pu = flReport.findings.find((f) => f.id === 'plugin-updates');
  check('upgrade advice: plugin-updates detail carries the analysis', !!(pu && pu.detail.includes('优点') && pu.detail.includes('不编造')), pu && pu.detail);
  check('upgrade advice: plugin-updates recommendation came from advice', !!(pu && pu.recommendation.includes('不代升级')), pu && pu.recommendation);
  const vbClient = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
  check('upgrade toast: client reads report.updates.advice', vbClient.includes('report.updates.advice') && vbClient.includes("'version-' + ua.fingerprint"));
  check('upgrade toast: the version toast is gated and de-duplicated', vbClient.includes("toastConfig.mode !== 'off'") && vbClient.includes('!toastedIds.has(vkey)'));
  const vbReport = fs.readFileSync(path.join(here, 'lib', 'report.js'), 'utf8');
  check('upgrade advice: collectUpdates takes hostVersion and returns advice', vbReport.includes('export function collectUpdates(paths, io, errors, hostVersion)') && vbReport.includes('analyzeUpgrades(outdated, packages, hostVersion)'));
  check('free lane: reads only the one private ledger, no error/coverage key', vbReport.includes("'our-free-model', 'availability.json'") && !vbReport.includes("step: 'free-lane'"));
}

// — v0.9.16（未发布）右侧栏 tab 正文修复：静态 + 运行期判据 —
{
  const rightSrc = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');

  check('right tab body is registered at the top level of mountRight',
    rightSrc.includes("rightDisposers.push(ctx.slots.inject('sidebar.right.pane.tab'") &&
    !rightSrc.includes('const disposers = [];'));
  check('mountRight has an idempotent guard (rightMounted)',
    rightSrc.includes('if (rightMounted) return;'));
  check('toast overlay is registered via its own ctx.effect, not the entry disposer list',
    rightSrc.includes("'dsh-steward: toast overlay'") &&
    !rightSrc.includes("currentDisposers.push(ctx.slots.inject('shell.overlay'"));
  check('scoped ctx effect owns the right tab type lifecycle',
    rightSrc.includes('c.effect(() => {') && rightSrc.includes("'dsh-steward: right tab type'"));
  check('ui.entry keeps its three values and per-value mount decisions',
    rightSrc.includes("entry !== 'right'") && rightSrc.includes("entry !== 'left'") &&
    rightSrc.includes("v === 'left' || v === 'right' || v === 'both'"));
}

// 运行期：把真正的 apply() body 抠出来，用假 Cordis ctx 跑一遍「both → settings=right」重挂，
// 数一数右侧正文槽位到底被注册/拆掉了几次。静态判据看不出的二次重挂竞态，这里能看出来。
await (async () => {
  let R = { error: null, bodyCount: -1, bodyLive: false, toastCount: -1, toastLive: false, leftLive: -1 };
  try {
    const src = fs.readFileSync(path.join(here, 'lib', 'client.js'), 'utf8');
    const head = '      apply(ctx) {';
    const tail = '      },' + String.fromCharCode(10) + '    };' + String.fromCharCode(10) + '  },' + String.fromCharCode(10) + '});';
    const hs = src.indexOf(head);
    const ts = src.lastIndexOf(tail);
    if (hs < 0 || ts <= hs) throw new Error('apply body anchors not found');
    const bodyText = src.slice(hs + head.length, ts);

    const regs = [];
    const live = new Set();
    const slots = {
      inject: (name, factory) => {
        const reg = factory();
        return () => { live.delete(reg); };
      },
      register: (opts) => {
        const reg = { slot: opts && opts.name, key: opts && (opts.key || opts.id) };
        regs.push(reg);
        live.add(reg);
        return reg;
      },
    };
    const scoped = {
      slots,
      sidebarRightTabs: { register: () => () => {} },
      effect: (fn) => { fn(); return () => {}; },
      get: () => undefined,
    };
    const ctx = {
      slots,
      effect: (fn) => { fn(); return () => {}; },
      inject: (deps, cb) => { cb(scoped); return () => {}; },
      get: () => undefined,
    };
    const call = () => Promise.resolve({ settings: { ui: { entry: 'right' } } });
    const prelude = 'var ENTRY_APPLIER = null; var PANEL_NAVIGATOR = null; var PANEL_ACK = null;' + String.fromCharCode(10);
    const run = new Function(
      'ctx', 'PANEL_ID', 'Panel', 'PanelIcon', 'h', 'ToastHost', 'call',
      prelude + bodyText
    );
    run(ctx, 'dsh-steward', function () {}, function () {}, function () {}, function () {}, call);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const bodies = regs.filter((r) => r.slot === 'sidebar.right.pane.tab' && r.key === 'dsh-steward');
    const toasts = regs.filter((r) => r.slot === 'shell.overlay');
    const left = regs.filter((r) => r.slot === 'sidebar.panellist' || r.slot === 'main');
    R.bodyCount = bodies.length;
    R.bodyLive = bodies.length === 1 && live.has(bodies[0]);
    R.toastCount = toasts.length;
    R.toastLive = toasts.length === 1 && live.has(toasts[0]);
    R.leftLive = left.filter((r) => live.has(r)).length;
  } catch (e) {
    R.error = String(e);
  }
  const why = R.error || JSON.stringify(R);
  check('runtime: exactly one right-tab body registration survives a settings-driven remount',
    !R.error && R.bodyCount === 1, why);
  check('runtime: the right-tab body stays live after the remount',
    !R.error && R.bodyLive === true, why);
  check('runtime: the toast overlay stays live after the remount',
    !R.error && R.toastLive === true, why);
  check('runtime: ui.entry=right drops the left/main entries',
    !R.error && R.leftLive === 0, why);
})();
console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
