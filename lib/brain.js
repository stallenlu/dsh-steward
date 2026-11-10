// L2+ 模型理解层：一句话 → 模型 → 结构化结论（仍然只产出意图，绝不执行）。
//
// 与 intent.js 的分工：
//   intent.js  规则匹配，零 token、毫秒级、离线可用，覆盖常见说法。
//   brain.js   模型理解，覆盖规则覆盖不到的自然语言；每一句都花一次 token，
//              所以是「用户显式选了模型理解」时才走这条路。
//
// 三条硬约束与 intent.js 完全一致，任何改动都不许放宽：
//   1. 只产出意图，绝不执行。返回值最终仍落到 plan → confirm → audit。
//   2. 模型输出必须是一个 JSON 对象，且 kind 只能取既有七类之一；解析不出来
//      就返回 clarify，绝不把模型的原话当指令。
//   3. 不 import 任何其它插件的内部模块（跨包版本漂移会重造问题①）。

export const KINDS = ['clean', 'backup', 'disable', 'enable', 'knowledge', 'ack', 'unack', 'report', 'goto'];

const SYSTEM = [
  '你是 DSH 智能管家的语言层。你的唯一职责：把用户的一句话翻译成一个 JSON 对象。',
  '可选 kind：clean（清理纯缓存）、backup（易失数据加密备份）、disable（停用插件）、',
  'enable（启用插件）、knowledge（沉淀本次结论）、ack（静音某条提醒）、',
  'unack（恢复某条提醒）、report（只想看看状况）、goto（只是想去某一页：总览/动作中心/审计趋势）。',
  '输出格式（只输出 JSON，不要解释、不要 markdown 代码块）：',
  '{"kind":"clean|backup|disable|enable|knowledge|ack|unack|report|goto","plugin":"包名(仅 disable/enable)","findingId":"报告条目 id(仅 ack/unack)","tab":"overview|actions|audit(仅 goto)","reply":"一句中文回话，告诉用户你理解成了什么"}',
  '规则：听不懂、或同时说了两件事、或拿不准参数时，kind 输出 "none"，并在 reply 里问一句最关键的澄清。',
  '你只做翻译，不做决定：永远不要说"我已经帮你清理/备份/停用了"。',
].join('');

function textOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text;
  // 少数适配器把增量放在 content 上；只在明确是文本增量时采用。
  if (chunk.type === 'text' && typeof chunk.text === 'string') return chunk.text;
  return '';
}

/**
 * 跑一次模型调用，把增量拼成纯文本。
 * deps.llm 由调用方经 ctx.get('llm') 容错取得——本模块不持有 ctx。
 */
export async function runModel(deps, options) {
  const llm = deps && deps.llm;
  if (!llm || typeof llm.stream !== 'function') {
    const error = new Error('宿主没有可用的模型服务（llm 不可用）');
    error.code = 'no-llm';
    throw error;
  }
  const provider = String((options && options.provider) || '');
  const model = String((options && options.model) || '');
  if (!provider || !model) {
    const error = new Error('没有选模型');
    error.code = 'no-model';
    throw error;
  }
  const signal = options && options.signal;
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: String((options && options.prompt) || '') }],
  }];
  let text = '';
  let finish = null;
  for await (const chunk of llm.stream({
    provider,
    model,
    messages,
    system: (options && options.system) || SYSTEM,
    maxTokens: (options && options.maxTokens) || 400,
    signal,
  })) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' || chunk.type === 'text') { text += textOf(chunk); continue; }
    // 结束/错误块只记录，不抛：让调用方拿到已经收到的部分再判断。
    if (chunk.type === 'finish' || chunk.type === 'message-stop' || chunk.type === 'error') finish = chunk;
  }
  return { text: text.trim(), finish };
}

/** 从模型输出里取出第一个 JSON 对象；容忍 ```json 围栏与前后废话。 */
export function extractJson(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * 把模型输出规范成与 intent.js 相同形状的结论。
 * 任何不合规的字段一律丢弃：宁可少一层理解，也不要多一条写入口。
 */
export function normalizeBrainOutput(raw, ctx) {
  const parsed = extractJson(raw);
  const options = ctx || {};
  if (!parsed) {
    return {
      ok: true, intent: null, via: 'model',
      clarify: '模型这句我没解析成明确动作——不猜。可以换个说法，或者直接用规则式理解。',
      suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
    };
  }
  const kind = String(parsed.kind || '').trim().toLowerCase();
  const reply = typeof parsed.reply === 'string' ? parsed.reply.slice(0, 300) : '';
  if (kind === 'none' || !KINDS.includes(kind)) {
    return {
      ok: true, intent: null, via: 'model',
      clarify: reply || '这句我听不出要做什么——不猜。',
      suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
    };
  }
  const params = {};
  if (kind === 'disable' || kind === 'enable') {
    const plugin = String(parsed.plugin || '').trim();
    const known = Array.isArray(options.bundles) ? options.bundles : [];
    const hit = known.find((b) => String(b && b.name || '').toLowerCase() === plugin.toLowerCase());
    if (!plugin || !hit) {
      return {
        ok: true, intent: null, via: 'model',
        clarify: plugin
          ? `模型给的包名「${plugin}」不在当前已装列表里，不敢照着停/启。`
          : '模型没给出要停用/启用哪个插件。',
        suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
      };
    }
    params.plugin = hit.name;
  }
  if (kind === 'goto') {
    const tab = String(parsed.tab || '').trim().toLowerCase();
    const ok = ['overview', 'actions', 'audit'];
    if (!ok.includes(tab)) {
      return {
        ok: true, intent: null, via: 'model',
        clarify: '指南一页是哪里？面板只有「体检总览」「动作中心」「审计趋势」三页。',
        suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
      };
    }
    params.tab = tab;
  }
  if (kind === 'ack' || kind === 'unack') {
    const findings = options.report && Array.isArray(options.report.findings) ? options.report.findings : [];
    const wanted = String(parsed.findingId || '').trim();
    const hit = findings.find((f) => String(f && f.id || '') === wanted);
    if (!hit) {
      return {
        ok: true, intent: null, via: 'model',
        clarify: wanted
          ? `模型指的条目「${wanted}」不在当前报告里。`
          : '模型没指清要静音/恢复哪一条。',
        suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
      };
    }
    params.id = hit.id;
    params.title = hit.title;
  }
  return {
    ok: true,
    via: 'model',
    intent: { kind, params, matched: ['model'], score: 0 },
    reply: reply ? [reply] : [`我理解成「${kind}」，先给你出零写入预览。`],
    suggestions: Array.isArray(options.suggestions) ? options.suggestions : [],
  };
}

export default runModel;
