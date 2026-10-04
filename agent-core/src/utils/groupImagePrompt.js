/**
 * 群聊生图 prompt 行协议。
 *
 * 新格式为 {description}，旧 JSON 格式仅用于历史兼容。该模块同时供群聊
 * transcript 构建和摘要/后处理使用，避免 prompt 规则更新后各端失同步。
 */
// 规范回显剥离要用规范原文做逐句比对；builtinRules.js 是纯常量模块（无 import），不会成环。
import { IMAGE_PROMPT_RULE } from '../builtinRules.js';

export const LEGACY_IMG_LINE_RE = /\{["'“”]?prompt["'“”]?\s*:\s*["“]((?:[^"”\\]|\\.)*)["”]\s*\}/i;
export const DIRECT_IMG_LINE_RE = /^\{([\s\S]+)\}$/;

/**
 * 生图规范原文（<image_prompt_rules>）的特征片段。
 * 模型偶尔把规范当成 {} 里要填的内容原样输出，甚至输出到一半被截断（花括号未闭合），
 * 这种行既不是画面描述也不是聊天内容，一律丢弃。
 */
const IMAGE_RULE_ECHO_MARKERS = [
  'describe the image as a flowing',
  'follow this progression',
  'scene-appropriate clothing',
  'hard rules:',
];

// 规范全文约 40 行，上限取双倍余量：只在「块首花括号被模型吞掉」时兜底放行。
const MAX_RULE_ECHO_LINES = 80;

const braceDelta = (text) => (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length;

export function isImageRuleEcho(text) {
  const value = String(text ?? '').toLowerCase();
  if (!value) return false;
  return IMAGE_RULE_ECHO_MARKERS.some(marker => value.includes(marker));
}

/**
 * 规范原文出现在行首——模型把整条规范当成一条消息输出（常见半截、花括号未闭合）。
 * 允许前面有 {、[、" 等包裹符，但前面已经有正常台词的行不算：
 * 那些行只丢花括号里的内容、保留台词。
 */
export function isImageRuleEchoStart(text) {
  const value = String(text ?? '').trim().replace(/^[{\["“”'\s]+/, '').toLowerCase();
  if (!value) return false;
  return IMAGE_RULE_ECHO_MARKERS.some(marker => value.startsWith(marker));
}

// 格式模板本身被当成答案输出：占位词、省略号、"待填写"这类写法都不是画面描述。
const PLACEHOLDER_PROMPT_RE = /^(?:prompt|prompts|描述|画面描述|画面|占位符|placeholder|待填写|待补全|xxx*|\.{2,}|…+|<[^>]*>|\[[^\]]*\])$/i;

/**
 * 花括号里填的不是画面描述（占位词、中文、纯符号）。
 * 群聊协议要求 {} 内是全英文画面描述，命中说明模型在复读模板，直接丢弃该发图行。
 */
export function isPlaceholderImagePrompt(prompt) {
  const value = String(prompt ?? '').trim();
  if (!value) return true;
  if (PLACEHOLDER_PROMPT_RE.test(value)) return true;
  return !/[A-Za-z]/.test(value);
}

/** 多行块的第一行去掉「[名字]:」前缀后的正文，用于判定整块性质。 */
const blockBody = (lines) => {
  const whole = lines.join('\n');
  const separator = whole.match(/^\[?[^:：\[\]]{1,20}\]?\s*[:：]\s*([\s\S]*)$/);
  return (separator ? separator[1] : whole).trim();
};

/** 整块都是模型复读的生图规范原文。 */
const isRuleEchoBlock = (lines) => isImageRuleEchoStart(blockBody(lines));

/**
 * 按花括号把内容拼回多行块（与流式解析同口径：花括号没闭合就继续攒），
 * 由 shouldDropBlock 决定整块留不留，返回保留的原始行。
 */
function partitionBlocks(content, shouldDropBlock) {
  const kept = [];
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    if (!shouldDropBlock(block)) kept.push(...block);
    block = [];
  };
  for (const line of String(content ?? '').split('\n')) {
    block.push(line);
    // 超过上限说明花括号被模型吞了，不再继续攒，交给整块判定兜底
    if (braceDelta(block.join('\n')) > 0 && block.length < MAX_RULE_ECHO_LINES) continue;
    flush();
  }
  flush();
  return kept;
}

/** 提取群聊发图画面描述；不是 prompt 行时返回 null。 */
export function extractGroupImagePrompt(body) {
  const text = String(body || '').trim();
  const legacy = text.match(LEGACY_IMG_LINE_RE);
  if (legacy) return legacy[1].replace(/\\"/g, '"').trim() || null;

  const direct = text.match(DIRECT_IMG_LINE_RE);
  if (!direct) return null;
  const prompt = direct[1].trim();
  return prompt && !/^["'“”]?prompt["'“”]?\s*:/i.test(prompt) ? prompt : null;
}

/**
 * 去掉整条生图 prompt 行（含 [名字]: 前缀），保留普通对话行。
 * 与流式解析同口径：先按花括号把多行内容拼回一个 candidate，再整块判定——
 * 多行画面描述、以及被模型当成模板整篇复读的规范原文，都不会进 transcript
 * （前者是噪声，后者留在聊天记录里会让模型下一轮继续复读）。
 * 纯函数：同一 raw 输出稳定，不破坏 transcript 的 append-only 前缀缓存。
 */
export function stripImagePromptLines(content) {
  if (!content.includes('{') && !isImageRuleEcho(content)) return content;
  return partitionBlocks(content, (lines) => {
    const whole = lines.join('\n');
    const body = blockBody(lines);
    if (isImageRuleEchoStart(body)) return true;          // 复读的规范原文
    if (extractGroupImagePrompt(body)) return true;       // 完整发图行
    return body.startsWith('{') && braceDelta(whole) > 0; // 被截断的未闭合发图行
  }).join('\n');
}

/** 移除消息中嵌入的旧版 {"prompt":"..."} JSON 块，保留同一行里的对话文本。 */
export function stripLegacyPromptJson(content) {
  return String(content || '').replace(new RegExp(LEGACY_IMG_LINE_RE.source, 'gi'), '');
}

// ═══════════════════════════════════════════════════════════════════════════
// 「规范回显」剥离 —— 送进 CLIP 之前把写作规范原文从画面描述里摘掉
//
// 真机现场（logs/backend-2026-10-01.log:201/223，2026-10-01）：
//   奇遇生成返回的 JSON 里 `"prompt"` 是「规范原文 + 它自己写的场景」的拼接：
//   "Describe the image as a flowing, detailed scene in natural English — one continuous
//    paragraph.\n\nFollow this progression:\n\n1. Scene Setting — Open with the overall
//    environment, framing, and mood. This is a nursing training room…"
//   代码原样把它送进 ComfyUI ⇒ CLIP 的**起始 token 全是写作说明**而不是画面，
//   出图和文字描述完全对不上（用户报的「图和文字描述完全都不一样」）。
//   根因是调用方把规范正文当成了 JSON 示例值（已同步修 eventGenerator.js），
//   这里是不依赖任何调用方的**兜底**：宁可少几个词，也不能让「Describe the image…」进 CLIP。
//
// 为什么按句删而不是按前缀截断：模型会把场景**穿插**在规范的标题之间
// （"1. Scene Setting — <规范句> This is a nursing training room…"），
// 前缀截断会把真正的画面一起切掉。回显是**逐字照抄**，所以逐句比对规范原文最稳。
// ═══════════════════════════════════════════════════════════════════════════

/** 规范里的章节标题（可能带编号、加粗、破折号或冒号） */
const SECTION_LABELS = [
  'scene setting', 'environment & props', 'lighting', 'atmosphere',
  'scene-appropriate clothing', 'two people share the frame', 'hard rules',
  'follow this progression',
];
const SECTION_LABEL_ALT = SECTION_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** 段首的「1. 」「- 」「**Scene Setting — **」这类只起排版作用的残渣 */
const LEADING_AFFIX_RE = new RegExp(
  // 顺序有讲究：**加粗小标题** 必须排在「项目符号」前面，
  // 否则 `[-•*]+` 会先把 `**MUST:**` 的头两个星号吃掉，剩下 `MUST:** When…` 判不出是回显。
  '^(?:'
  + '\\s*\\*\\*[^*]*\\*\\*\\s*[—–:-]?\\s*'          // **MUST:** / **Scene Setting —**
  + '|\\s*\\d+\\s*[.、]\\s*'                       // 1. / 2、
  + '|\\s*[-•]+\\s*'                              // - / •
  + '|\\s*(?:' + SECTION_LABEL_ALT + ')\\s*[—–:-]\\s*'
  + ')+',
  'i',
);

/** 只用于**比对**的归一化：去排版残渣、去加粗、合并空白、去句末标点、转小写 */
function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(LEADING_AFFIX_RE, '')
    .replace(/\*\*/g, '')
    // 标点变体统一：模型回显时经常把破折号抄成普通连字符、把弯引号抄成直引号
    // （规范原文用的是 `—` 和 `'`）。不归一化就会「差一个字符 ⇒ 整句认不出来被留下」。
    .replace(/[—–−]/g, '-')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?。！？；;：:]+$/, '')
    .trim()
    .toLowerCase();
}

/** 把规范原文拆成「句子」集合（与正文同样的拆句口径），用于逐句比对 */
function boilerplateSentenceSet(ruleText) {
  const set = new Set();
  for (const line of String(ruleText ?? '').split(/\n+/)) {
    for (const seg of line.split(/(?<=[.!?])\s+/)) {
      const norm = normalizeForCompare(seg);
      if (norm.length >= 8) set.add(norm);
    }
  }
  for (const label of SECTION_LABELS) set.add(label);
  return set;
}

/**
 * 规范原文的「句子拼接串」，用 ` || ` 当分隔（归一化后的句子里不可能出现它）。
 * 回显是逐字照抄 ⇒ 真正的规范片段一定是**某一句规范原文的子串**；
 * 用子串而不是全等，是为了兜住模型抄的时候掉了个把词 / 把加粗符号抄歪的情况。
 */
function boilderplateBlob(ruleText) {
  const parts = [];
  for (const line of String(ruleText ?? '').split(/\n+/)) {
    for (const seg of line.split(/(?<=[.!?])\s+/)) {
      const norm = normalizeForCompare(seg);
      if (norm) parts.push(norm);
    }
  }
  return ' || ' + parts.join(' || ') + ' || ';
}

/** 这段（归一化后）是不是规范原文的回显 */
function isBoilerplateFragment(norm, boilerplate, blob) {
  if (!norm) return true;
  if (boilerplate.has(norm)) return true;
  // 阈值取 3：短到 3 个字符还能命中规范原文的，只可能是 "e.g" 这类排版残渣；
  // 真正的画面描述不会整个句子都是规范里的某个词组。
  return norm.length >= 3 && blob.includes(norm);
}

/**
 * 剥离画面描述里被模型回显的生图规范原文。
 *
 * @param {string} prompt            送进 ComfyUI 的画面描述（可能是「规范 + 场景」的拼接）
 * @param {object} [opts]
 * @param {string} [opts.ruleText]   规范原文；缺省用内置 `image_prompt` 规则
 * @returns {{ prompt: string, changed: boolean, droppedChars: number, isEmpty: boolean }}
 *          `isEmpty=true` 表示剥完什么都不剩（整条都是规范），调用方应放弃本次生图
 */
export function stripImagePromptRuleEcho(prompt, { ruleText } = {}) {
  const original = String(prompt ?? '').trim();
  if (!original) return { prompt: '', changed: false, droppedChars: 0, isEmpty: true };

  const lowered = original.toLowerCase();
  // 快路径：没有规范特征词就直接放行（绝大多数生图调用都走这里，零额外开销）
  if (!IMAGE_RULE_ECHO_MARKERS.some(marker => lowered.includes(marker))) {
    return { prompt: original, changed: false, droppedChars: 0, isEmpty: false };
  }

  const ruleSource = ruleText ?? IMAGE_PROMPT_RULE.rule_content;
  const boilerplate = boilerplateSentenceSet(ruleSource);
  const blob = boilderplateBlob(ruleSource);
  const kept = [];
  for (const rawSeg of original.split(/(?<=[.!?])\s+/)) {
    const norm = normalizeForCompare(rawSeg);
    if (isBoilerplateFragment(norm, boilerplate, blob)) continue;   // 规范回显 → 丢
    kept.push(rawSeg.replace(LEADING_AFFIX_RE, '').trim());
  }
  const cleaned = kept
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s.,;:—–-]+/, '')
    .trim();
  const droppedChars = original.length - cleaned.length;
  // 「没有可用场景」的判据（两道，取或）：
  //   · 剥完什么都不剩；或
  //   · **剥掉的占了大头（≥2/3）** —— 说明这条本来就是规范原文，留下的只是零碎标题/示例句，
  //     送进 CLIP 同样只会得到与剧情无关的图。
  //   真机那条（规范 + 完整场景）只掉 13%，离阈值很远，不会被误判。
  const isEmpty = cleaned.length === 0 || droppedChars >= original.length * (2 / 3);
  return { prompt: cleaned, changed: cleaned !== original, droppedChars, isEmpty };
}

// 成对花括号块：群聊协议把花括号保留给生图，私聊旧格式为 {"prompt":"..."}。
// 与 groupChatEngine 的兜底提取同口径，只吃成对块，不碰未闭合的孤立 `{`。
const BRACE_BLOCK_RE = /\{[^{}]*\}/g;

/**
 * 去掉文本里被 {...} 包裹的生图 prompt：整行都是 prompt 的行整行删除，
 * 粘在台词里的内联块只删块本身、保留同行真实发言（含旧版 {"prompt":"..."} JSON）。
 *
 * 专供"要把聊天记录上传给模型"的非生图链路（记忆整理、用户画像提取等）：
 * 这些链路只要真实发言，prompt 是噪声，还可能被模型抄进记忆或画像。
 * 生图链路（配图判断、prompt 提取、群聊 transcript）不要用这个函数。
 */
export function stripBracePromptBlocks(content) {
  const source = String(content ?? '');
  if (!source.includes('{') && !isImageRuleEcho(source)) return source;
  return partitionBlocks(stripLegacyPromptJson(source), isRuleEchoBlock)
    .map(line => line
      .replace(BRACE_BLOCK_RE, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([，。！？、；：,.!?;:])/g, '$1')
      .trim())
    .filter(line => line !== '')
    .join('\n');
}
