/**
 * 上下文窗口用量与压缩（「上下文面板」数据源）
 *
 * 四件事：
 *   1. 模型上下文窗口的取值与三级回退：declared（用户添加/编辑模型时自己填的）
 *      → provider（上游 GET /v1/models 的 context_length）→ default（128000）。
 *      面板打开时若当前窗口还停在 default（真机上游报 1000000，却因为"只在保存模型配置时探过一次"
 *      而一直显示出厂值 128000），会**惰性探测一次**上游（ensureActiveContextWindow，
 *      1.8s 短超时；成功进进程内缓存，失败如实回落 default，接口不慢也不报错）。
 *   2. 最近一次请求各段的规模（system / memory / transcript / directive / other）：
 *      由 prompt 组装点（routes/chat.js、services/groupChatEngine.js）调用
 *      recordContextUsage 落进快照，键为 conversationId。快照**同时落库**
 *      （system_settings，键 `context_usage:<conversationId>`，只留最近 200 个会话），
 *      重启后能读回上一次用量，此时 source='snapshot'（绝不标成 last-request）。
 *   3. 真实 token 用量：llm-client 解析到 usage 后调 notePromptUsage，通过
 *      AsyncLocalStorage 把 prompt_tokens 贴到同一会话的快照上（source = 'last-request'）。
 *      没拿到真实 usage 时如实退化为按分段字符数的估算（source = 'estimate'），
 *      从不把估算值伪装成精确值。
 *   4. 分项标定：分项 tokens 是字符估算（中文 ≈ 字数/1.6，实测与真实总量差 −14%），
 *      与顶层真实 usedTokens 对不上。标定**不覆盖估算值**，而是额外给一份
 *      按真实总量等比摊派的 tokensCalibrated，让分项之和与 usedTokens 自洽；
 *      没有真实用量时不摊派（breakdownCalibrated=false，tokensCalibrated=null）。
 *
 * 快照的内存部分最多 500 条（单条很小，最多 5 个分段，超出按插入序淘汰最早的）；
 * 落库部分只留最近 200 个会话（按 updatedAt 淘汰），写库同会话 1s 内合并，
 * 写失败只 warn —— 面板的持久化绝不能影响聊天主链路。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { blockTag, estimateTokens } from './contextAssembler.js';

/** 上游没报、用户也没声明时的保守默认窗口 */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/** 窗口来源：declared = 用户声明，provider = 上游模型列表，default = 保守默认 */
export const CONTEXT_WINDOW_SOURCES = Object.freeze(['declared', 'provider', 'default']);

// 用量来源（顶层 source 字段），取值集合就这四个：
//   last-request = 本进程内最近一次真实请求的 usage
//   estimate     = 本进程内的组装快照，只有按字符估算（还没拿到真实 usage）
//   snapshot     = 从**持久化快照**里读到的上一次用量（进程重启后走这条；历史 usage 已不是"最后一次请求"，
//                  所以绝不标成 last-request）
//   none         = 连组装快照都没有（找不到会话 / 还没发过请求）
export const USAGE_SOURCES = Object.freeze(['none', 'estimate', 'last-request', 'snapshot']);

// ── 分段口径 ──

export const SEGMENT_KEYS = Object.freeze(['system', 'memory', 'transcript', 'directive', 'other']);

export const SEGMENT_LABELS = Object.freeze({
  system: '系统提示词',
  memory: '记忆与档案',
  transcript: '对话消息',
  directive: '本轮指令',
  other: '其他',
});

/**
 * 块标签 → 分段。只看块自己的 XML 标签（contextAssembler.blockTag 的口径），
 * 因此预算降级改写块内容后依然分得准（降级不会改标签）。
 * memory     = 记忆、RAG、档案、画像注入
 * transcript = 历史对话与滚动摘要
 * directive  = 本轮指令、催眠块、群聊 round_directive
 * other      = 时间/小镇场景等环境块与无法归类的块
 */
const TAG_SEGMENTS = Object.freeze({
  // 记忆与档案
  rag_memories: 'memory',
  memory_recall_result: 'memory',
  user_portrait: 'memory',
  affinity_attitude: 'memory',
  attitude_reminder: 'memory',
  cross_reference: 'memory',
  group_chat_log: 'memory',
  group_town_life_records: 'memory',
  member_private_memory: 'memory',
  // 对话消息
  active_chat_history: 'transcript',
  group_transcript: 'transcript',
  // 本轮指令
  reply_length: 'directive',
  style_override: 'directive',
  current_event: 'directive',
  round_directive: 'directive',
  round_message_limit: 'directive',
  hypnosis_state: 'directive',
  hypnosis_command: 'directive',
  hypnosis_memory_return: 'directive',
  hypnosis_amnesia: 'directive',
  // 环境与其他
  time_context: 'other',
  town_scene_context: 'other',
  member_context: 'other',
});

/**
 * 没有 XML 标签、但语义明确的动态块（项目里有两条用中文方括号开头的指令块）。
 * 命中即归入对应分段；未命中一律 'other' —— 宁可少算进 system/transcript，也不猜错。
 */
const PREFIX_SEGMENTS = Object.freeze([
  ['【当前情绪状态', 'directive'],
  ['【⚠️ 重逢提示', 'directive'],
]);

/** 按块文本判断它属于哪个分段 */
export function segmentKeyForBlock(text) {
  const tag = blockTag(text);
  if (tag && TAG_SEGMENTS[tag]) return TAG_SEGMENTS[tag];
  const body = String(text ?? '').trimStart();
  for (const [prefix, key] of PREFIX_SEGMENTS) {
    if (body.startsWith(prefix)) return key;
  }
  return 'other';
}

/** 统一取文本：允许直接传字符串，也允许传 { role, content } 消息对象 */
function normalizeTexts(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  return list
    .map(item => (item && typeof item === 'object' ? item.content : item))
    .filter(item => typeof item === 'string' && item.length > 0)
    .map(item => String(item));
}

/**
 * 组装 breakdown（固定 5 段、固定顺序，无内容的段 tokens/chars 为 0）。
 * chars 是该段原始字符数（精确值）；tokens 是按字符的估算值（中文 ≈ 字数 / 1.6，
 * 见 contextAssembler.estimateTokens）——真实总量以顶层 source='last-request' 的
 * usedTokens 为准，两者本就不等。**估算值永远原样保留**；与真实总量的对齐另走
 * calibrateBreakdown 给出的 tokensCalibrated（按真实总量等比摊派），不在这里改口径。
 * @param {{system?:Array,memory?:Array,transcript?:Array,directive?:Array,other?:Array}} segments
 */
export function buildBreakdown(segments = {}) {
  return SEGMENT_KEYS.map(key => {
    const texts = normalizeTexts(segments[key]);
    return {
      key,
      label: SEGMENT_LABELS[key],
      tokens: texts.reduce((sum, text) => sum + estimateTokens(text), 0),
      chars: texts.reduce((sum, text) => sum + text.length, 0),
    };
  });
}

/** 按标签把一个块数组（dynamicBlocks / directiveBlocks / preHistoryMessages …）分桶 */
export function splitBlocksBySegment(blocks = []) {
  const buckets = { system: [], memory: [], transcript: [], directive: [], other: [] };
  for (const block of normalizeTexts(blocks)) {
    buckets[segmentKeyForBlock(block)].push(block);
  }
  return buckets;
}

/**
 * 私聊一次组装用到的材料 → 分段（routes/chat.js 的组装点调用）。
 *
 * 分桶只看块自己的 XML 标签，因此与 buildChatContext 的实际拼装口径一致；
 * dynamicBlocks 传**预算降级之后**的数组——预算裁掉多少，面板就该少算多少。
 * system 段要把 preSummarySystem 先按空行拼成一条，与 buildChatContext 的拼法一致，
 * 否则字符数会跟真正发出去的那条差几个换行。
 */
export function buildChatContextSegments({
  stableBlocks = [],
  preSummarySystem = null,
  summaryBlock = null,
  preHistoryMessages = [],
  history = [],
  dynamicBlocks = [],
} = {}) {
  const split = splitBlocksBySegment(dynamicBlocks);
  const preSummaryJoined = (Array.isArray(preSummarySystem) ? preSummarySystem : [preSummarySystem])
    .map(part => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  return {
    system: [...stableBlocks, preSummaryJoined],
    memory: split.memory,
    transcript: [
      summaryBlock,
      ...preHistoryMessages.map(item => item?.content),
      ...history.map(item => item?.content),
      ...split.transcript,
    ],
    directive: split.directive,
    other: split.other,
  };
}

export function sumBreakdownTokens(breakdown = []) {
  return breakdown.reduce((sum, item) => sum + (Number(item?.tokens) || 0), 0);
}

export function sumBreakdownChars(breakdown = []) {
  return breakdown.reduce((sum, item) => sum + (Number(item?.chars) || 0), 0);
}

/**
 * 分项标定：按真实总量等比分摊，给每一项补一个 tokensCalibrated。
 *
 * **不覆盖** breakdown[].tokens —— 那一份是字符估算（中文 ≈ 字数/1.6，见
 * contextAssembler.estimateTokens），保留给"没有真实用量"的场景（source='estimate'
 * 时分项之和本来就等于顶层 usedTokens，再摊派只会把同一套估算值改口径）。
 * 标定只在**拿到真实 usedTokens** 时做：把估算值整体缩放成真实总量，让分项之和自洽，
 * 分量之间的相对占比沿用估算（更细分的真实占比上游并不提供，不编）。
 *
 * 取整用最大余数法（先取整再把余数分给小数部分最大的几项），因此分项之和
 * **严格等于** usedTokens，而不是规范允许的 ±项数。
 *
 * @param {Array<{tokens:number,chars:number}>} breakdown
 * @param {number} usedTokens 真实总量（上游报的 prompt_tokens）
 * @returns {Array|null} 带 tokensCalibrated 的新数组；无从摊派（没有真实总量 / 分项全空）时 null
 */
export function calibrateBreakdown(breakdown = [], usedTokens = 0) {
  const target = Math.round(Number(usedTokens) || 0);
  if (!(target > 0)) return null;
  if (sumBreakdownChars(breakdown) <= 0) return null;

  // 权重优先用估算 tokens；估算全为 0 但确实有内容（只有换行/标点这类）时退化为按字符数摊派
  const tokenSum = sumBreakdownTokens(breakdown);
  const weights = breakdown.map(item => (tokenSum > 0
    ? (Number(item?.tokens) || 0)
    : (Number(item?.chars) || 0)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(weightSum > 0)) return null;

  const exact = weights.map(weight => (weight * target) / weightSum);
  const values = exact.map(value => Math.floor(value));
  const remainder = target - values.reduce((sum, value) => sum + value, 0);
  if (remainder > 0) {
    const order = exact
      .map((value, index) => ({ index, frac: value - Math.floor(value) }))
      .sort((a, b) => (b.frac - a.frac) || (a.index - b.index));
    for (let i = 0; i < remainder; i += 1) values[order[i % order.length].index] += 1;
  }
  return breakdown.map((item, index) => ({
    ...item,
    tokensCalibrated: Math.max(0, values[index]),
  }));
}

/**
 * 给没有真实用量的分项补上 tokensCalibrated=null（形状稳定：恒有该键，前端不用判断 undefined）。
 * @param {Array} breakdown
 */
export function withoutCalibration(breakdown = []) {
  return breakdown.map(item => ({ ...item, tokensCalibrated: null }));
}

// ── 用量与余量计算 ──

/**
 * usedPercent 是 0~100 的百分数（不是 0~1）；remainingTokens 不小于 0。
 * @returns {{usedTokens:number,usedPercent:number,remainingTokens:number}}
 */
export function computeUsageFields({ usedTokens = 0, contextWindow = DEFAULT_CONTEXT_WINDOW } = {}) {
  const window = normalizeContextWindow(contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
  const used = Math.max(0, Math.round(Number(usedTokens) || 0));
  return {
    usedTokens: used,
    usedPercent: Math.min(100, Math.round((used / window) * 10000) / 100),
    remainingTokens: Math.max(0, window - used),
  };
}

// ── 上下文窗口：声明 / 上游 / 默认 ──

/** 规整用户声明的窗口：正整数（token）有效，其余（含 '' / null / NaN）视为未声明 */
export function normalizeContextWindow(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** 规整窗口来源；非法值返回 null（由后续回退决定） */
export function normalizeContextWindowSource(value) {
  return CONTEXT_WINDOW_SOURCES.includes(value) ? value : null;
}

/**
 * 三级回退：declared → provider → default。
 * @param {{declared?:*, provider?:*, fallback?:number}} options
 * @returns {{contextWindow:number, contextWindowSource:'declared'|'provider'|'default'}}
 */
export function resolveContextWindow({ declared = null, provider = null, fallback = DEFAULT_CONTEXT_WINDOW } = {}) {
  const declaredValue = normalizeContextWindow(declared);
  if (declaredValue) return { contextWindow: declaredValue, contextWindowSource: 'declared' };
  const providerValue = normalizeContextWindow(provider);
  if (providerValue) return { contextWindow: providerValue, contextWindowSource: 'provider' };
  return {
    contextWindow: normalizeContextWindow(fallback) ?? DEFAULT_CONTEXT_WINDOW,
    contextWindowSource: 'default',
  };
}

function entryId(entry) {
  return String(entry?.id || entry?.name || entry?.model || '').replace(/^models\//, '');
}

/** 从 /v1/models 的返回里挑出目标模型那条（字段名各网关不统一，尽量容忍） */
export function pickModelEntry(payload, model) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const entries = rows
    .map(item => (typeof item === 'string' ? { id: item } : item))
    .filter(item => item && typeof item === 'object');
  if (entries.length === 0) return null;

  const wanted = String(model || '').trim().replace(/^models\//, '');
  // 没指定模型时（调用方没传）才允许"只有一条就用它"；指定了就必须真匹配上——
  // 拿别的模型的窗口当自己的窗口就是猜，宁可回退到保守默认值。
  if (!wanted) return entries.length === 1 ? entries[0] : null;
  return entries.find(entry => entryId(entry) === wanted)
    || entries.find(entry => entryId(entry).toLowerCase() === wanted.toLowerCase())
    || entries.find(entry => entryId(entry).endsWith(`/${wanted}`) || wanted.endsWith(`/${entryId(entry)}`))
    || null;
}

/** 从一条模型记录里取上下文窗口（按可靠性依次尝试几个常见字段名） */
export function contextWindowFromModelEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const field of ['context_length', 'context_window', 'max_allowed_size', 'contextLength']) {
    const value = normalizeContextWindow(entry[field]);
    if (value) return value;
  }
  return null;
}

/**
 * 从上游 GET /v1/models 读取某个模型的上下文窗口。任何失败都返回 null（调用方继续回退到默认值）。
 * @returns {Promise<{contextWindow:number, endpoint:string}|null>}
 */
export async function fetchProviderContextWindow({
  baseURL = '',
  apiKey = '',
  headers = {},
  model = '',
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base || typeof fetchImpl !== 'function') return null;

  let modelsURL;
  try {
    modelsURL = new URL(`${base}/models`);
    if (!['http:', 'https:'].includes(modelsURL.protocol)) return null;
  } catch {
    return null;
  }

  const requestHeaders = {
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {}),
  };

  try {
    const response = await fetchImpl(modelsURL, {
      method: 'GET',
      headers: requestHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    const value = contextWindowFromModelEntry(pickModelEntry(payload, model));
    if (!value) return null;
    return { contextWindow: value, endpoint: modelsURL.toString() };
  } catch {
    return null;
  }
}

// 上游查到的窗口按「地址|模型」缓存在内存里，避免每次打开面板都打一次 /v1/models
const providerWindowCache = new Map();

function providerCacheKey(baseURL, model) {
  return `${String(baseURL || '').trim().replace(/\/+$/, '')}|${String(model || '').trim()}`;
}

export function setCachedProviderContextWindow(baseURL, model, contextWindow) {
  const value = normalizeContextWindow(contextWindow);
  if (!value) return null;
  providerWindowCache.set(providerCacheKey(baseURL, model), value);
  return value;
}

export function getCachedProviderContextWindow(baseURL, model) {
  return providerWindowCache.get(providerCacheKey(baseURL, model)) ?? null;
}

export function clearProviderContextWindowCache() {
  providerWindowCache.clear();
}

/**
 * 添加/编辑模型时用的窗口决策：用户填了就用用户填的（declared）；
 * 没填则尝试上游 GET /v1/models（provider，命中后进缓存）；再取不到用保守默认（default）。
 * @returns {Promise<{contextWindow:number, contextWindowSource:'declared'|'provider'|'default', endpoint?:string}>}
 */
export async function resolveDeclaredOrProviderWindow({
  declared = null,
  baseURL = '',
  apiKey = '',
  headers = {},
  model = '',
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const declaredValue = normalizeContextWindow(declared);
  if (declaredValue) return { contextWindow: declaredValue, contextWindowSource: 'declared' };

  const cached = getCachedProviderContextWindow(baseURL, model);
  if (cached) return { contextWindow: cached, contextWindowSource: 'provider' };

  const found = await fetchProviderContextWindow({ baseURL, apiKey, headers, model, timeoutMs, fetchImpl });
  if (found) {
    setCachedProviderContextWindow(baseURL, model, found.contextWindow);
    return { contextWindow: found.contextWindow, contextWindowSource: 'provider', endpoint: found.endpoint };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowSource: 'default' };
}

/**
 * 解析"当前生效模型"的窗口：用户声明 → 上游缓存 → 默认。
 * 只读 config 与内存缓存、不发网络请求，面板随时可调。
 *
 * config.llm.contextWindow 里既可能是用户声明值，也可能是上游查到的值，
 * 因此必须配合 contextWindowSource 一起看：只有 source='declared' 才算声明。
 */
export function resolveActiveContextWindow({ model = config.llm.model, baseURL = config.llm.baseURL } = {}) {
  const stored = config.llm.contextWindow;
  const storedSource = normalizeContextWindowSource(config.llm.contextWindowSource);
  if (storedSource === 'declared') {
    return resolveContextWindow({ declared: stored });
  }
  const cached = getCachedProviderContextWindow(baseURL, model);
  if (cached) return { contextWindow: cached, contextWindowSource: 'provider' };
  // 存的是上游查到的值（provider）或上一次的保守默认（default）——照原样回报，不升级成"上游"
  if (stored) return { contextWindow: stored, contextWindowSource: storedSource || 'provider' };
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, contextWindowSource: 'default' };
}

// ── 面板窗口的惰性探测（真机出厂值 128000 → 上游 1000000） ──

/**
 * 惰性探测的预算：1.8s（藏在 1.5~2s 档里）。
 * 面板接口最坏也就慢这么一下，之后命中的是进程内缓存，不再打上游。
 */
export const LAZY_PROVIDER_PROBE_TIMEOUT_MS = 1800;

/** 同一「地址|模型」的探测在途合并：面板被连点/并发轮询时只打一次上游 */
const inflightProbes = new Map();

/**
 * 面板要用的"当前生效窗口"：还停在 default 且没有 declared 值时，惰性探测一次上游 /v1/models。
 *
 * 为什么需要：上游窗口此前只在**保存模型配置**时探一次（PUT /api/config/llm 与
 * resolveDeclaredOrProviderWindow），出厂/老配置于是长期显示 default 128000，而真机上游
 * 其实是 1000000。面板打开时补一次探测，成功就把窗口与来源升级成 provider 并进进程内缓存
 * （与保存路径共用 providerWindowCache，第二次起不再探测）。
 *
 * 失败（超时 / 上游报错 / 字段缺失）一律**如实回落**给 resolveActiveContextWindow 的结论
 * （default），不抛错、不报 500、不改接口形状；失败不写缓存，下次打开面板会再试一次。
 *
 * @returns {Promise<{contextWindow:number, contextWindowSource:'declared'|'provider'|'default'}>}
 */
export async function ensureActiveContextWindow({
  timeoutMs = LAZY_PROVIDER_PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const active = resolveActiveContextWindow();
  // declared（用户填了）或 provider（已有上游值/缓存）都已经有答案，不探测
  if (active.contextWindowSource !== 'default') return active;

  const baseURL = config.llm.baseURL;
  const model = config.llm.model;
  const key = providerCacheKey(baseURL, model);
  try {
    let probe = inflightProbes.get(key);
    if (!probe) {
      probe = fetchProviderContextWindow({
        baseURL,
        apiKey: config.llm.apiKey,
        headers: config.llm.headers,
        model,
        timeoutMs,
        fetchImpl,
      }).finally(() => inflightProbes.delete(key));
      inflightProbes.set(key, probe);
    }
    const found = await probe;
    if (!found) return active;
    setCachedProviderContextWindow(baseURL, model, found.contextWindow);
    return { contextWindow: found.contextWindow, contextWindowSource: 'provider' };
  } catch {
    return active;
  }
}

// ── 会话快照（内存 + system_settings 持久化） ──

const MAX_SNAPSHOTS = 500;
const snapshots = new Map(); // conversationId → snapshot

/** 落库上限：只留最近 200 个会话（内存的 500 条是另一档，面板只读一条） */
export const MAX_PERSISTED_SNAPSHOTS = 200;
/** system_settings 里的键前缀：键 = conversationId，加前缀是为了能按前缀枚举做淘汰 */
const SNAPSHOT_KEY_PREFIX = 'context_usage:';
/** 写库节流：同一会话 1s 内只写一次（多次组装合并成一次落库） */
export const SNAPSHOT_WRITE_THROTTLE_MS = 1000;

const lastPersistAt = new Map(); // conversationId → 上次写库时间戳（节流用）

function snapshotKeyOf(conversationId) {
  return `${SNAPSHOT_KEY_PREFIX}${conversationId}`;
}

/** 落库形态：把内存标记（persisted）剔掉，其余字段（含 breakdown/breakdownExtra）原样存 */
function serializableSnapshot(snapshot) {
  const { persisted, ...rest } = snapshot;
  return rest;
}

/**
 * 超出 200 个会话时按 updatedAt 淘汰最旧的。
 * 排序键优先取值里的 updatedAt（ISO，写的时候统一），取不到才退回落库时间。
 */
function evictPersistedSnapshots(db) {
  const total = db.prepare(`SELECT COUNT(*) AS count FROM system_settings WHERE setting_key LIKE ?`)
    .get(`${SNAPSHOT_KEY_PREFIX}%`)?.count || 0;
  if (total <= MAX_PERSISTED_SNAPSHOTS) return 0;

  const rows = db.prepare(`SELECT setting_key, setting_value, updated_at FROM system_settings WHERE setting_key LIKE ?`)
    .all(`${SNAPSHOT_KEY_PREFIX}%`);
  const decorated = rows.map(row => {
    let updatedAt = String(row.updated_at || '');
    try {
      const parsed = JSON.parse(row.setting_value);
      if (parsed?.updatedAt) updatedAt = String(parsed.updatedAt);
    } catch { /* 值坏了就按落库时间排 */ }
    return { key: row.setting_key, updatedAt };
  });
  decorated.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const doomed = decorated.slice(0, decorated.length - MAX_PERSISTED_SNAPSHOTS);
  const remove = db.prepare('DELETE FROM system_settings WHERE setting_key = ?');
  for (const row of doomed) remove.run(row.key);
  return doomed.length;
}

/**
 * 把快照写进 system_settings（键 = `context_usage:<conversationId>`）。
 *
 * 节流：同一会话 1s 内的多次写入合并成第一次（下一次组装会把最新状态补上）。
 * 全程 try/catch：面板的持久化失败只 warn，**绝不能影响聊天主链路**。
 * @returns {boolean} 是否真的写了库
 */
export function persistContextUsageSnapshot(snapshot) {
  const conversationId = String(snapshot?.conversationId || '').trim();
  if (!conversationId) return false;
  const key = snapshotKeyOf(conversationId);
  const now = Date.now();
  if (now - (lastPersistAt.get(key) || 0) < SNAPSHOT_WRITE_THROTTLE_MS) return false;
  lastPersistAt.set(key, now);
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
    ).run(key, JSON.stringify(serializableSnapshot(snapshot)));
    evictPersistedSnapshots(db);
    return true;
  } catch (err) {
    console.warn(`[contextUsage] 用量快照写库失败（不影响聊天）: ${err?.message || err}`);
    return false;
  }
}

/**
 * 从库里读回某个会话上一次的用量快照（进程重启后走这条）。
 * 读到的快照打上 persisted 标记 → 顶层 source 报 'snapshot'。
 * @returns {object|null}
 */
export function loadContextUsageSnapshot(conversationId) {
  const key = String(conversationId || '').trim();
  if (!key) return null;
  try {
    const raw = getDb()
      .prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?')
      .pluck()
      .get(snapshotKeyOf(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.breakdown)) return null;
    return { ...parsed, conversationId: key, persisted: true };
  } catch (err) {
    console.warn(`[contextUsage] 用量快照读库失败（按键当没有快照）: ${err?.message || err}`);
    return null;
  }
}

/** 库里的快照条数（面板/测试用） */
export function countPersistedSnapshots() {
  try {
    return getDb()
      .prepare(`SELECT COUNT(*) AS count FROM system_settings WHERE setting_key LIKE ?`)
      .get(`${SNAPSHOT_KEY_PREFIX}%`)?.count || 0;
  } catch { return 0; }
}

/**
 * 记录一次 prompt 组装的分段规模（由组装点调用，键为 conversationId）。
 * 真实 usage 到位前 source 就是 'estimate'，绝不先写成精确值再补。
 * @param {{conversationId:string, model?:string, contextWindow?:number, contextWindowSource?:string,
 *          prefixHashes?:{stablePrefixHash?:string|null, fullPrefixHash?:string|null, requestHash?:string|null},
 *          segments?:{system?:Array,memory?:Array,transcript?:Array,directive?:Array,other?:Array}}} options
 *        prefixHashes：稳定前缀指纹（来自 buildChatContext 的 metadata）。纯记录，面板据此判断
 *        "这轮缓存命中掉了是稳定前缀变了、还是只有动态尾部变了"（代码审查改进 §2.3）。
 */
export function recordContextUsage({ conversationId, model = '', contextWindow = null, contextWindowSource = null, prefixHashes = null, segments = {} } = {}) {
  const key = String(conversationId || '').trim();
  if (!key) return null;

  const breakdown = buildBreakdown(segments);
  const snapshot = {
    conversationId: key,
    model: String(model || ''),
    contextWindow: normalizeContextWindow(contextWindow),
    contextWindowSource: normalizeContextWindowSource(contextWindowSource),
    breakdown,
    breakdownExtra: [],
    estimatedTokens: sumBreakdownTokens(breakdown),
    usedTokens: null,          // 真实 usage 到位后填；没到位就用 estimatedTokens
    source: 'estimate',
    updatedAt: new Date().toISOString(),
    // 稳定前缀指纹（可为 null：老调用点/群聊不传）。面板用它判断"哪个稳定块动了"
    stablePrefixHash: prefixHashes?.stablePrefixHash ?? null,
    fullPrefixHash: prefixHashes?.fullPrefixHash ?? null,
    requestHash: prefixHashes?.requestHash ?? null,
  };

  // 重插到 Map 末尾：Map 的插入序即淘汰序
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value);
  }
  persistContextUsageSnapshot(snapshot);
  return snapshot;
}

/**
 * 给最近一次快照补一段（组装之后才追加的块，例如群聊的小镇生活记录）。
 * 没有快照时忽略——不凭一段文本凭空造出一个会话记录。
 */
export function appendContextSegment(conversationId, key, text) {
  const snapshot = snapshots.get(String(conversationId || '').trim());
  if (!snapshot || !SEGMENT_KEYS.includes(key)) return null;
  const content = normalizeTexts([text])[0];
  if (!content) return null;
  const item = buildBreakdown({ [key]: [content] }).find(entry => entry.key === key);
  snapshot.breakdownExtra.push(item);
  snapshot.estimatedTokens += item.tokens;
  persistContextUsageSnapshot(snapshot);
  return snapshot;
}

/**
 * 读某个会话最近的用量快照：
 *   1. 先看本进程的内存快照（最新）；
 *   2. 没有就回落到库里上一次的快照（进程重启后的路径）——读到即标 persisted，
 *      顶层 source 报 'snapshot'，updatedAt 用存下来的时间（前端要显示"更新于 xx:xx"）。
 */
export function getContextUsageSnapshot(conversationId) {
  const key = String(conversationId || '').trim();
  if (!key) return null;
  const cached = snapshots.get(key);
  if (cached) return cached;
  const loaded = loadContextUsageSnapshot(key);
  if (!loaded) return null;
  // 缓存进内存：同一会话的后续读不必每次都查库（新一轮组装会用新快照覆盖它）
  snapshots.set(key, loaded);
  while (snapshots.size > MAX_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value);
  }
  return loaded;
}

export function clearContextUsageSnapshots() {
  snapshots.clear();
  // 节流窗口一起清掉：这个函数是"模拟进程重启"用的，重启后节流状态本来就该是空的
  lastPersistAt.clear();
}

/** 快照的 5 段（含后续补记的段）——固定顺序、固定 5 项 */
export function snapshotBreakdown(snapshot) {
  if (!snapshot) return [];
  const base = snapshot.breakdown || buildBreakdown({});
  const extras = snapshot.breakdownExtra || [];
  if (extras.length === 0) return base;
  return base.map(item => {
    const related = extras.filter(extra => extra.key === item.key);
    if (related.length === 0) return item;
    return {
      ...item,
      tokens: item.tokens + related.reduce((sum, extra) => sum + extra.tokens, 0),
      chars: item.chars + related.reduce((sum, extra) => sum + extra.chars, 0),
    };
  });
}

/**
 * 快照当前的有效用量与来源：
 *   从库里读回来的（persisted）→ source='snapshot'（是"上一次用量"，不是"最近一次请求"）；
 *   本进程内有真实 usage → 'last-request'；否则用估算值 → 'estimate'；没有快照 → 'none'。
 */
export function snapshotUsage(snapshot) {
  if (!snapshot) return { usedTokens: 0, source: 'none' };
  if (snapshot.persisted) {
    const real = Number.isFinite(snapshot.usedTokens) && snapshot.usedTokens > 0 ? snapshot.usedTokens : null;
    return { usedTokens: real ?? (snapshot.estimatedTokens || 0), source: 'snapshot' };
  }
  if (Number.isFinite(snapshot.usedTokens) && snapshot.usedTokens > 0) {
    return { usedTokens: snapshot.usedTokens, source: 'last-request' };
  }
  return { usedTokens: snapshot.estimatedTokens || 0, source: 'estimate' };
}

// ── 真实 usage 回填（AsyncLocalStorage） ──
//
// 组装点调 beginContextCapture 把"这次请求属于哪个会话"绑到异步上下文上；
// llm-client 拿到 usage 后调 notePromptUsage，标签匹配才回填——
// 同一轮里的其它调用（planner、生图判断、记忆整理…）标签不同，不会污染主回复的用量。

const captureAls = new AsyncLocalStorage();

export function beginContextCapture({ conversationId, model = '', expectLabel = null } = {}) {
  const key = String(conversationId || '').trim();
  if (!key) return;
  captureAls.enterWith({
    conversationId: key,
    model: String(model || ''),
    expectLabel: expectLabel ? String(expectLabel) : null,
  });
}

/**
 * 由 llm-client 在每次调用拿到 usage 后调用；只认当前异步上下文里的会话与标签。
 * @param {string} label 调用用途标签
 * @param {object|null} usage OpenAI 风格 usage
 */
export function notePromptUsage(label, usage) {
  const ctx = captureAls.getStore();
  if (!ctx) return;
  if (ctx.expectLabel && String(label || '') !== ctx.expectLabel) return;
  const promptTokens = Number(usage?.prompt_tokens);
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;

  const snapshot = snapshots.get(ctx.conversationId);
  if (!snapshot) return;
  snapshot.usedTokens = Math.round(promptTokens);
  snapshot.updatedAt = new Date().toISOString();
  snapshot.source = 'last-request';
  // 真实用量是面板最想留到重启后的那一份，落库（节流 + 失败只 warn）
  persistContextUsageSnapshot(snapshot);
}

// ── 对外载荷（严格按前端契约的字段与顺序） ──

/**
 * 组装 GET /api/context/usage 的返回体。
 *
 * model / contextWindow / contextWindowSource 报的是**当前生效模型**（也就是下一轮要用的窗口）——
 * 用户刚在设置页改完窗口，面板立刻就该显示新值；usedTokens / breakdown 则来自最近一次请求的快照。
 *
 * breakdown 的每一项都带 tokensCalibrated：
 *   - 有真实 usedTokens（快照的 usedTokens 有值）且分项字符和 > 0 → 按真实总量等比摊派，
 *     分项之和严格等于 usedTokens，顶层 breakdownCalibrated=true；
 *   - 没有真实用量 → tokensCalibrated=null、breakdownCalibrated=false，
 *     此时 tokens（估算）之和本来就等于顶层 usedTokens（同一套估算口径），不摊派。
 * 估算值 tokens 永远原样保留，不被标定覆盖。
 * @param {{conversationId:string, snapshot?:object|null, model?:string,
 *          contextWindow?:number, contextWindowSource?:string}} options
 */
export function buildUsagePayload({ conversationId, snapshot = null, model = '', contextWindow = null, contextWindowSource = null } = {}) {
  const usage = snapshotUsage(snapshot);
  const active = resolveActiveContextWindow();
  const window = normalizeContextWindow(contextWindow) ?? active.contextWindow;
  const source = normalizeContextWindowSource(contextWindowSource) || active.contextWindowSource;
  const fields = computeUsageFields({ usedTokens: usage.usedTokens, contextWindow: window });

  const rawBreakdown = snapshot ? snapshotBreakdown(snapshot) : [];
  // "拿到真实 usedTokens"：只看快照里 notePromptUsage 填进来的 usedTokens，
  // 不用顶层 usedTokens（estimate 时它等于估算和，拿来摊派等于把估算值改口径）
  const realUsedTokens = Number.isFinite(snapshot?.usedTokens) && snapshot.usedTokens > 0
    ? Math.round(snapshot.usedTokens)
    : null;
  const calibrated = realUsedTokens && sumBreakdownChars(rawBreakdown) > 0
    ? calibrateBreakdown(rawBreakdown, realUsedTokens)
    : null;

  return {
    conversationId: String(conversationId || ''),
    model: String(model || config.llm.model || ''),
    contextWindow: window,
    contextWindowSource: source,
    usedTokens: fields.usedTokens,
    usedPercent: fields.usedPercent,
    remainingTokens: fields.remainingTokens,
    source: usage.source,
    updatedAt: snapshot?.updatedAt || null,
    // 稳定前缀指纹（代码审查改进 §2.3）：新增可选字段，老前端忽略未知字段即可（纯加法）
    stablePrefixHash: snapshot?.stablePrefixHash ?? null,
    fullPrefixHash: snapshot?.fullPrefixHash ?? null,
    requestHash: snapshot?.requestHash ?? null,
    breakdown: calibrated ?? withoutCalibration(rawBreakdown),
    breakdownCalibrated: Boolean(calibrated),
  };
}

// ── 压缩总开关 ──

/**
 * 上下文压缩总开关。
 *
 * 项目里没有独立的「上下文压缩」开关，压缩链路的唯一总闸是既有的记忆/档案开关
 * （config.features.memory，即设置页「记忆」与 GET/PUT /api/config/memory 的 enabled）：
 * 它同时管着 RAG 召回、画像与长期记忆整理，而压缩产出的正是这些。关闭时不做压缩。
 */
export function isContextCompressionEnabled() {
  return config.features.memory !== false;
}

/** 面板与压缩共用的会话存在性判断（消息库里出现过该会话即算存在） */
export function conversationExists(db, conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return false;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM raw_messages WHERE conversation_id = ?`).get(id);
  return (row?.count || 0) > 0;
}

/**
 * 该会话是否还有可压缩的内容（只做廉价预检，真正的判断仍由摘要/整理链路自己决定）：
 *   - 滚动摘要：摘要 checkpoint 之后累计够 summaryInterval 条触发角色消息；
 *   - 记忆整理：记忆 checkpoint 之后累计够 memoryMinMessages 条消息。
 * 阈值由调用方从 summarizer / memoryExtractor 取（保持单一事实来源），此处不重复定义。
 * 预检通过但链路内部判定不需要压缩时，同样如实返回 summaryCreated: false。
 */
export function hasCompressibleContext(db, conversationId, { summaryInterval = 10, triggerRole = 'assistant', memoryMinMessages = 40 } = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return false;

  const summaryCheckpoint = db.prepare(`
    SELECT end_msg_id FROM rolling_summaries
    WHERE conversation_id = ? AND checkpoint_version = 1
    ORDER BY end_msg_id DESC, id DESC LIMIT 1
  `).get(id);
  const afterSummary = db.prepare(`
    SELECT COUNT(*) AS count FROM raw_messages
    WHERE conversation_id = ? AND id > ? AND role = ?
  `).get(id, summaryCheckpoint?.end_msg_id || 0, triggerRole);
  if ((afterSummary?.count || 0) >= summaryInterval) return true;

  const memoryCheckpoint = db.prepare(`
    SELECT last_raw_msg_id FROM memory_extraction_checkpoints WHERE conversation_id = ?
  `).get(id);
  const afterMemory = db.prepare(`
    SELECT COUNT(*) AS count FROM raw_messages
    WHERE conversation_id = ? AND id > ? AND role IN ('user','assistant')
  `).get(id, memoryCheckpoint?.last_raw_msg_id || 0);
  return (afterMemory?.count || 0) >= memoryMinMessages;
}
