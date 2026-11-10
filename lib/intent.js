// L2 意图解析：一句话 → 一个「要去哪」的结论。
//
// 三条硬约束，写在这里是为了以后别被改坏：
//
// 1. 零 token、零网络、纯函数。这个模块不调用任何模型，只做规则匹配。
//    面板要的是「毫秒级、离线可用、结果可复现」，模型理解走聊天窗口那条路。
// 2. 只产出意图，绝不执行。所有意图最终都落到既有链路：
//    plan（零写入预览）→ confirm:true + 一次性指纹 → audit.jsonl。
//    这里没有、也不许出现任何 execute 的直接调用。
// 3. 听不懂就说听不懂，不猜。歧义或没命中时返回 clarify，让用户补一句；
//    宁可多问一句，也不要因为「猜对过一次」就养成替用户拍板的习惯。

const RULES = [
  {
    kind: 'clean',
    words: ['清理', '清一下', '清缓存', '清垃圾', '腾空间', '腾出', '释放空间',
      '占空间', '太大了', '清掉', '删除缓存', '瘦身', 'clean'],
  },
  {
    kind: 'backup',
    // 只收「动作词」。「易失」「危险数据」这类是名词描述，不构成指令：
    // 用户说「静音易失数据那条提醒」时，命中的应该是 ack，不是 backup。
    // 名词单独出现时就该回去问，而不是替用户决定要备份。
    words: ['备份', '加密备份', '存档', '存一份', '打包', '备份一下', 'backup'],
  },
  {
    kind: 'disable',
    words: ['禁用', '停用', '关掉', '关闭', '禁掉', '停掉', 'disable'],
  },
  {
    kind: 'enable',
    words: ['启用', '开启', '打开', '重新启用', '恢复启用', 'enable'],
  },
  {
    kind: 'knowledge',
    words: ['沉淀', '记录', '记一下', '记住这次', '留个记录', '存档结论', 'knowledge'],
  },
  {
    kind: 'ack',
    words: ['静音', '别提醒', '不用管', '忽略', '别再报', 'ack'],
  },
  {
    kind: 'unack',
    words: ['恢复提醒', '取消静音', '别静音', '恢复显示', 'unack'],
  },
  {
    // 只读导航：不碰任何动作，只是把面板切到对应 Tab。
    // 截图里那句「去到审计趋势」就该落在这里——它不是 intent 解析不了，
    // 而是之前根本没有「去哪一页」这个意图。
    kind: 'goto',
    words: ['审计趋势', '审计', '台账', '趋势', '操作记录', '动作中心', '总览', '首页'],
  },
  {
    // 只读意图：命中后直接重新体检，不走动作链路。
    kind: 'report',
    words: ['看看', '体检', '检查', '怎么样', '有问题吗', '什么问题', '毛病', '情况', '状态',
      '健康', '报告', '还好吗', 'report', 'status'],
  },
];

// 否定前缀：出现在命中词之前 3 个字符内，视为「不要做这件事」。
// 注意 '别提醒' / '不用管' 这类本身就是意图词，它们匹配段在否定词之后，
// 所以不会被自己的否定前缀误伤（前缀窗口取的是命中词之前）。
const NEGATORS = ['不要', '不用', '别', '勿', '无需', '不必', '算了', '先不'];

// 同分时的偏向：动作类优先于只读类（「看看有什么能清理的」→ 清理，不是体检）。
const ACTION_KINDS = new Set(['clean', 'backup', 'disable', 'enable', 'knowledge', 'ack', 'unack']);

// 长词优先，避免「审计趋势」里的「趋势」抢在前面导致同义不同 Tab。
const TAB_WORDS = [
  ['audit', ['审计趋势', '审计', '台账', '操作记录', '趋势']],
  ['actions', ['动作中心', '动作']],
  ['overview', ['总览', '首页']],
];

function tabOf(text) {
  for (const [tab, words] of TAB_WORDS) {
    for (const word of words) if (text.includes(word)) return tab;
  }
  return null;
}

const EXAMPLES = [
  '清理一下缓存',
  '给易失数据做个加密备份',
  '停用 dsh-guizang-design',
  '有什么问题吗',
  '静音易失数据那条提醒',
];

export function normalize(text) {
  return String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
}

function negatedBefore(text, index) {
  const window = text.slice(Math.max(0, index - 3), index);
  return NEGATORS.some((n) => window.includes(n));
}

function collectHits(text) {
  const hits = [];
  for (const rule of RULES) {
    for (const word of rule.words) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(word, from);
        if (at < 0) break;
        if (!negatedBefore(text, at)) hits.push({ kind: rule.kind, word, at, len: word.length });
        from = at + word.length;
      }
    }
  }
  return hits;
}

// 打分：命中词长度求和。长词（「加密备份」）压过短词（「备份」），
// 这样「加密备份」不会被算成两次普通备份。
function rankByKind(hits) {
  const scores = new Map();
  for (const hit of hits) {
    const cur = scores.get(hit.kind) || { score: 0, words: [] };
    cur.score += hit.len;
    cur.words.push(hit.word);
    scores.set(hit.kind, cur);
  }
  let best = null;
  for (const [kind, value] of scores) {
    if (!best) { best = { kind, ...value }; continue; }
    if (value.score > best.score) { best = { kind, ...value }; continue; }
    if (value.score === best.score) {
      // 同分：动作类赢只读类；同为动作类则真的歧义，交回去问。
      if (ACTION_KINDS.has(kind) && !ACTION_KINDS.has(best.kind)) best = { kind, ...value };
    }
  }
  return { best, ambiguous: [...scores.entries()].filter(([k, v]) => best && v.score === best.score && k !== best.kind) };
}

// 从一句话里挑出插件名：拿真实 bundle 列表做最长匹配，比正则猜要稳。
// 没给列表时退回一个保守的 token 形状（@scope/name 或 name），不猜相似度。
function pickPlugin(text, bundles) {
  const list = Array.isArray(bundles) ? bundles : [];
  let matched = null;
  for (const entry of list) {
    const name = String(entry && entry.name ? entry.name : '').toLowerCase();
    if (!name || name.length < 3) continue;
    if (!text.includes(name)) continue;
    if (!matched || name.length > matched.name.length) {
      matched = { name: entry.name, enabled: entry.enabled !== false, len: name.length };
    }
  }
  if (matched) return { plugin: matched.name, existed: true, enabled: matched.enabled };
  const token = /(?:^|\s)([@a-z0-9][\w./@-]{2,})/i.exec(text);
  if (token && /[a-z]/i.test(token[1]) && token[1].includes('-')) {
    return { plugin: token[1], existed: false, enabled: null };
  }
  return null;
}

function pickFinding(text, report) {
  const findings = report && Array.isArray(report.findings) ? report.findings : [];
  const pool = findings.filter((f) => !f.muted);
  // 标题匹配取两档前缀：用户很少逐字念全文，通常只说头四个字
  // （「静音易失数据」对「易失数据不在默认备份分区内」）。先长后短，
  // 长前缀优先，避免短前缀把另一条抢先命中。
  const hit = pool.find((f) => {
    const title = String(f.title || '').toLowerCase();
    if (!title) return false;
    return text.includes(title.slice(0, 6)) || text.includes(title.slice(0, 4))
      || text.includes(String(f.id || '').toLowerCase());
  });
  return hit || null;
}

function replyFor(kind, target) {
  switch (kind) {
    case 'goto':
      return ['这就带你过去。'];
    case 'clean':
      return ['我理解成「清理纯缓存」。', '先给你出一份零写入预览：会删哪些、能回收多少，看清了再点执行。'];
    case 'backup':
      return ['我理解成「给易失数据做加密备份」。', '先出预览（分区与体积）。加密口令请在动作卡里填，不要发在聊天里。'];
    case 'disable':
      return ['我理解成「停用 ' + target + '」。',
        '注意：停用要过归因门——只有最近一次崩溃点名了它、且那次崩溃发生在本实例启动之后，才会放行。'];
    case 'enable':
      return ['我理解成「启用 ' + target + '」。', '启用只对当前已停用的插件有意义，先出预览。'];
    case 'knowledge':
      return ['我理解成「把这次体检结论沉淀下来」。', '只增不改，写入本地知识文件；项目知识库仍要你确认。'];
    case 'ack':
      return ['我理解成「静音这条提醒」。', '静音只影响展示与排序，不改判定结论，随时能恢复。'];
    case 'unack':
      return ['我理解成「恢复这条提醒的显示」。'];
    case 'report':
      return ['这就给你重新体检一次。'];
    default:
      return [];
  }
}

/**
 * @param {string} raw 用户那句话
 * @param {{bundles?: Array<{name:string, enabled?:boolean}>, report?: object}} ctx
 */
export function parseIntent(raw, ctx) {
  const options = ctx || {};
  const text = normalize(raw);
  if (!text) {
    return { ok: true, intent: null, clarify: '先跟我说一句吧，比如「清理一下缓存」。', suggestions: EXAMPLES };
  }

  const hits = collectHits(text);
  if (!hits.length) {
    return {
      ok: true, intent: null,
      clarify: '这句我没听懂——我不猜。你可以换个说法，或者直接用下面的动作卡。',
      suggestions: EXAMPLES,
    };
  }

  const { best, ambiguous } = rankByKind(hits);
  if (ambiguous && ambiguous.length) {
    return {
      ok: true, intent: null,
      clarify: '这句里同时提到两件事（' + [best.kind, ...ambiguous.map(([k]) => k)].join(' / ')
        + '），我不替你选。分开说一句就行。',
      suggestions: EXAMPLES,
    };
  }

  const intent = { kind: best.kind, matched: best.words, score: best.score, params: {} };

  if (best.kind === 'goto') {
    const tab = tabOf(text);
    if (!tab) {
      return {
        ok: true, intent: null,
        clarify: '要看哪一页？说「体检总览」「动作中心」或「审计趋势」都行。',
        suggestions: EXAMPLES,
      };
    }
    intent.params.tab = tab;
  }

  if (best.kind === 'disable' || best.kind === 'enable') {
    const found = pickPlugin(text, options.bundles);
    if (!found) {
      return {
        ok: true, intent: null,
        clarify: '要' + (best.kind === 'disable' ? '停用' : '启用') + '哪个插件？把包名带上，比如「停用 dsh-example-plugin」。',
        suggestions: EXAMPLES,
      };
    }
    if (!found.existed) {
      return {
        ok: true, intent: null,
        clarify: '我按形状猜到「' + found.plugin + '」，但它不在当前已装列表里，不敢照着停/启。请确认完整包名。',
        suggestions: EXAMPLES,
      };
    }
    intent.params.plugin = found.plugin;
    if (best.kind === 'enable' && found.enabled) {
      return {
        ok: true, intent: null,
        clarify: '「' + found.plugin + '」现在就是启用状态——启用动作对它没有意义。要停用它请说「停用 ' + found.plugin + '」。',
        suggestions: EXAMPLES,
      };
    }
    if (best.kind === 'disable' && !found.enabled) {
      return {
        ok: true, intent: null,
        clarify: '「' + found.plugin + '」已经是停用状态了。要恢复请说「启用 ' + found.plugin + '」。',
        suggestions: EXAMPLES,
      };
    }
  }

  if (best.kind === 'ack' || best.kind === 'unack') {
    const finding = pickFinding(text, options.report);
    if (!finding) {
      return {
        ok: true, intent: null,
        clarify: '要' + (best.kind === 'ack' ? '静音' : '恢复') + '哪一条？说个关键词就行，比如「静音易失数据」。',
        suggestions: EXAMPLES,
      };
    }
    intent.params.id = finding.id;
    intent.params.title = finding.title;
  }

  return {
    ok: true,
    intent,
    reply: replyFor(best.kind, intent.params.plugin || ''),
    suggestions: EXAMPLES,
  };
}

export default parseIntent;
