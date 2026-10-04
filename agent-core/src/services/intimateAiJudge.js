/**
 * 亲密看板 · 「AI 判断行为」（task-32）
 *
 * 用户诉求：「流水记录记账系统可以让 AI 去判断是什么行为再记账」+「加个按钮 就叫 AI 判断行为 /
 * 再弄个按钮 是否默认开启 AI 判断」+「异步：回复完再判定」。
 *
 * 与既有的**确定性记账**（生图 prompt 的英文 tag 归类 + 中文正文兜底记『未归类』）的关系：
 *
 *   - 确定性记账是零成本、即时的，**先跑**；本模块是"事后补判"，**只补两类轮次**：
 *       ① 这一轮一条流水都没有（纯文字轮次没命中成人词表）；
 *       ② 这一轮只有 `unspecified`（未归类）——承认发生了但不知道是什么。
 *   - 判定结果写 `source='llm'`；一旦写出 ≥1 条具体行为，就把该轮的 `unspecified` 行**撤掉**
 *     （否则"发生了一次"会被算两次）。判定为"没有亲密行为"时不动任何东西。
 *   - 因此**不会重复计数**：已有具体行为（阴道/口交/…）的轮次不参与补判。
 *
 * 开关（`character_body_profile.ai_judge_enabled`，默认 0=关）：
 *   - 关：只有面板上「AI 判断行为」按钮会跑（手动补判最近若干轮）；
 *   - 开：每轮回复落库后**异步**补判该轮（不阻塞聊天，失败只 warn）。
 *
 * 每日配额（全局设置 `ai_judge_daily_limit`，默认 200 次/天，0 = 不限制）：
 *   - 计数按本地日期落 system_settings（`ai_judge_quota`，一行 { date, used }），重启不重置；
 *   - 额度用完：自动补判跳过且**不调用模型**（日志 `[intimateAiJudge] 今日配额已用完（N/N），跳过 raw=…`），
 *     手动补判在 errors 里给一句人话并回报 quota；
 *   - 设置与查看走 `GET /api/config`（顶层 aiJudge 对象）与 `PUT /api/config/ai-judge`。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import { config } from '../config.js';
import { ACT_DEFINITIONS, ACT_KEYS, SCENES, PARTNER_KINDS, recordIntimateActs } from './intimateService.js';

/** 可注入的 LLM 调用（测试用；传非函数即恢复真实 chatSync） */
let llmCallImpl = chatSync;
export function __setLlmCallForTest(fn) {
  llmCallImpl = typeof fn === 'function' ? fn : chatSync;
}

/** 送进判定的正文上限（超长截尾，避免把整轮长文塞给模型） */
const MAX_TEXT_CHARS = 1200;
/** 手动补判一次最多看多少轮 */
export const MAX_JUDGE_LIMIT = 20;
const DEFAULT_JUDGE_LIMIT = 8;

const PARTNER_TO_KIND = { user: 'user', character: 'character', self: 'self', npc: 'npc' };

// ── 每日配额（system_settings 持久化，按本地日期翻篇；0 = 不限制） ──
//
// 配额是"每天允许 AI 判断行为跑多少次"的全局设置（不是按角色的开关）：
//   - 自动补判（聊天 / 群聊挂点 judgeRoundInBackground）：额度用完直接跳过，**一次模型都不调**；
//   - 手动补判（POST …/intimate/ai-judge/run）：额度用完返回 quota（exhausted=true）并在 errors 里给一句人话；
//   - 计数按**本地**日期（YYYY-MM-DD）落库，重启不重置；同一天一个键一行。

/** 全局设置键：每天允许跑多少次（次/天） */
export const AI_JUDGE_LIMIT_SETTING_KEY = 'ai_judge_daily_limit';
/** 计数键：一行存"今天用了几次"（JSON { date, used }），跨天自动归零 */
export const AI_JUDGE_QUOTA_SETTING_KEY = 'ai_judge_quota';
/** 用户没配过时的默认上限 */
export const DEFAULT_AI_JUDGE_DAILY_LIMIT = 200;

// 这两个键走的是 system_settings 的既有口径（db/settings.js 的 getSetting/setSetting 是同一张表），
// 但没有复用 setSetting：它会对"没登记进 SETTING_TO_CONFIG"的键打一句"重启后会丢"的 warn，
// 而本模块是自己把值读回来用的（确实存活），要登记映射得改 config.js（不在本次改动范围）。
// 于是这里用同一张表的裸 SQL —— 与 services/weatherService.js、services/town/townService.js
// 等既有服务写 system_settings 的做法一致。
function readSettingValue(key) {
  return getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(key) ?? null;
}

function writeSettingValue(key, value) {
  getDb().prepare(
    'INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
  ).run(key, String(value));
}

// 配额相关的降级日志只打一次，避免每轮判断都刷屏
let quotaWarned = false;
function warnQuotaOnce(message) {
  if (quotaWarned) return;
  quotaWarned = true;
  console.warn(`[intimateAiJudge] ${message}`);
}

/** 本地日期键（YYYY-MM-DD）：按**本地**日期翻篇，不用 UTC —— 否则东八区要到早上 8 点才归零 */
export function localDateKey(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = number => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** 规整 dailyLimit：0（不限制）或正整数有效，其余（负数 / 小数 / 非数字 / 空）返回 null */
export function normalizeAiJudgeDailyLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 全局每日上限（读不到/读坏了就是默认 200） */
export function getAiJudgeDailyLimit() {
  try {
    const parsed = normalizeAiJudgeDailyLimit(readSettingValue(AI_JUDGE_LIMIT_SETTING_KEY));
    return parsed === null ? DEFAULT_AI_JUDGE_DAILY_LIMIT : parsed;
  } catch (err) {
    warnQuotaOnce(`读取每日配额上限失败，按默认 ${DEFAULT_AI_JUDGE_DAILY_LIMIT} 计: ${err?.message || err}`);
    return DEFAULT_AI_JUDGE_DAILY_LIMIT;
  }
}

/** 写每日上限；非法值返回 { ok:false }（路由翻成 400），写库失败返回 { ok:false, error } */
export function setAiJudgeDailyLimit(value) {
  const parsed = normalizeAiJudgeDailyLimit(value);
  if (parsed === null) return { ok: false, error: 'dailyLimit must be 0 (unlimited) or a positive integer' };
  try {
    writeSettingValue(AI_JUDGE_LIMIT_SETTING_KEY, parsed);
    return { ok: true, dailyLimit: parsed };
  } catch (err) {
    return { ok: false, error: err?.message || 'failed to persist aiJudge dailyLimit' };
  }
}

// 库读写都挂掉时的内存兜底：至少同进程内还数得住（重启会重置，已在 warn 里说明）
let memoryQuota = { date: null, used: 0 };

/** 今天已用次数；@returns {number|null} null 表示读不到（交给内存兜底） */
function readUsedToday(date) {
  try {
    const raw = readSettingValue(AI_JUDGE_QUOTA_SETTING_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (parsed?.date !== date) return 0;   // 跨天：昨天的不算今天
    const used = Number.parseInt(parsed?.used, 10);
    return Number.isFinite(used) && used > 0 ? used : 0;
  } catch (err) {
    warnQuotaOnce(`配额计数读库失败，暂用内存计数: ${err?.message || err}`);
    return null;
  }
}

export function getAiJudgeUsedToday({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  if (stored !== null) return stored;
  return memoryQuota.date === date ? memoryQuota.used : 0;
}

/** 配额状态五件套：上限 / 今日已用 / 剩余 / 是否不限制 / 是否耗尽 */
export function buildAiJudgeQuotaStatus(dailyLimit, usedToday) {
  const limit = normalizeAiJudgeDailyLimit(dailyLimit) ?? DEFAULT_AI_JUDGE_DAILY_LIMIT;
  const used = Math.max(0, Number.parseInt(usedToday, 10) || 0);
  const unlimited = limit === 0;
  return {
    dailyLimit: limit,
    usedToday: used,
    // 不限制时剩余次数没有意义，如实给 null（不编一个大数字）
    remaining: unlimited ? null : Math.max(0, limit - used),
    unlimited,
    exhausted: !unlimited && used >= limit,
  };
}

export function getAiJudgeQuotaStatus({ now = new Date() } = {}) {
  return buildAiJudgeQuotaStatus(getAiJudgeDailyLimit(), getAiJudgeUsedToday({ now }));
}

/** GET/PUT /api/config 用的四字段形态（exhausted 只出现在 AI 判断的返回里） */
export function getAiJudgeQuotaPayload({ now = new Date() } = {}) {
  const status = getAiJudgeQuotaStatus({ now });
  return {
    dailyLimit: status.dailyLimit,
    usedToday: status.usedToday,
    remaining: status.remaining,
    unlimited: status.unlimited,
  };
}

/** 真正要调模型之前消耗一次配额；返回消耗后的状态 */
export function consumeAiJudgeQuota({ now = new Date() } = {}) {
  const date = localDateKey(now);
  const stored = readUsedToday(date);
  const base = stored !== null ? stored : (memoryQuota.date === date ? memoryQuota.used : 0);
  const used = base + 1;
  memoryQuota = { date, used };
  try {
    writeSettingValue(AI_JUDGE_QUOTA_SETTING_KEY, JSON.stringify({ date, used }));
  } catch (err) {
    warnQuotaOnce(`配额计数写库失败，计数暂只存在内存（重启会重置）: ${err?.message || err}`);
  }
  return buildAiJudgeQuotaStatus(getAiJudgeDailyLimit(), used);
}

/** 额度用完时给用户/日志的一句人话 */
export function quotaExhaustedMessage(status = getAiJudgeQuotaStatus()) {
  return `今日 AI 判断配额已用完（${status.usedToday}/${status.dailyLimit}），本次未调用模型；可在设置页调大「AI 判断行为·每日上限」或明天再试`;
}

/** 额度用完时自动补判（聊天/群聊挂点）的跳过日志 */
function logQuotaExhausted(status, rawId) {
  console.log(`[intimateAiJudge] 今日配额已用完（${status.usedToday}/${status.dailyLimit}），跳过 raw=${rawId || 0}`);
}

/**
 * 组装判定 prompt（AGENTS.md 口径：要求 JSON 时必须给出完整示例与字段约束）。
 * @param {{characterName?:string, userName?:string, lines?:string[], scene?:string}} opts
 */
export function buildJudgePrompt({ characterName = 'TA', userName = '用户', lines = [], scene = 'chat' } = {}) {
  const actList = ACT_DEFINITIONS
    .filter(a => a.key !== 'unspecified')
    .map(a => `${a.key}（${a.label}）`)
    .join('、');
  return [
    `你在为成年向角色扮演应用做**流水记账**：判断下面这一轮里，「${characterName}」实际发生了哪些亲密行为。`,
    `act_key 只能从这些里选：${actList}。这一轮没有任何亲密行为时，acts 必须是空数组。`,
    '',
    '严格按下面的 JSON 格式输出，不要输出任何解释、也不要输出 JSON 以外的文字：',
    '```json',
    '{',
    '  "acts": [',
    '    { "act_key": "hand", "partner": "user", "confidence": 0.9, "count": 1, "climax_count": 0 }',
    '  ],',
    '  "reason": "一句话依据，不超过30字"',
    '}',
    '```',
    '字段要求：',
    '- `act_key`：必须取自上面的 key；拿不准就不要写进 acts。',
    `- \`partner\`：只能是 "user"（与${userName}）、"character"（与其它角色）、"self"（自己一个人）。`,
    '- `confidence`：0~1 的小数，表示你的确信程度。',
    '- `count`：这一轮该行为发生次数（整数，默认 1）；`climax_count`：其中高潮次数（没有写 0）。',
    '- `reason`：一句话说明依据。',
    '',
    `【场景】${scene}`,
    `【这一轮的对话】`,
    ...(lines.length > 0 ? lines.map(line => `- ${line}`) : ['-（无内容）']),
  ].join('\n');
}

/** 容忍 ```json 代码块包裹的解析；不是合法对象就返回 null */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // 兜底：截取第一个 { 到最后一个 }（模型偶尔前后带话）
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * 解析判定输出 → 规范化的 acts（白名单过滤 + 数值夹取）。
 * @returns {{acts:Array<{actKey:string,partnerKind:string,confidence:number,count:number,climaxCount:number}>, reason:string, ok:boolean}}
 */
export function parseJudgeOutput(text) {
  const parsed = parseJsonLoose(text);
  if (!parsed) return { acts: [], reason: '', ok: false };
  const list = Array.isArray(parsed.acts) ? parsed.acts : [];
  const acts = [];
  for (const item of list) {
    const actKey = String(item?.act_key ?? item?.actKey ?? '').trim();
    if (!ACT_KEYS.has(actKey) || actKey === 'unspecified') continue; // 白名单 + 不允许再写"未归类"
    const partnerRaw = String(item?.partner ?? item?.partner_kind ?? 'user').trim().toLowerCase();
    const partnerKind = PARTNER_KINDS.includes(PARTNER_TO_KIND[partnerRaw]) ? PARTNER_TO_KIND[partnerRaw] : 'user';
    const confidence = Math.min(1, Math.max(0, Number(item?.confidence ?? 0.6) || 0));
    const count = Math.max(1, Math.min(99, Number.parseInt(item?.count ?? 1, 10) || 1));
    const climaxCount = Math.max(0, Math.min(99, Number.parseInt(item?.climax_count ?? item?.climaxCount ?? 0, 10) || 0));
    acts.push({ actKey, partnerKind, confidence, count, climaxCount });
  }
  return { acts, reason: String(parsed.reason || '').slice(0, 120), ok: true };
}

/** 该轮已有的流水行为（用来判断"要不要补判"以及"哪些行为已经记过"） */
export function existingActsForRaw(characterId, rawId) {
  if (!rawId) return [];
  return getDb().prepare(
    'SELECT act_key, source FROM character_intimate_log WHERE character_id = ? AND raw_id = ?'
  ).all(characterId, rawId);
}

/** 这一轮是否值得补判：一条都没有，或只有"未归类" */
export function needsAiJudge(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  return rows.every(r => r.act_key === 'unspecified');
}

/**
 * 判定并记账一轮。
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {number} [opts.rawId] 这一轮的 assistant raw id（幂等锚点）
 * @param {string} [opts.scene] SCENES 之一（默认 chat）
 * @param {string[]} [opts.lines] 送判正文（一般是这一轮的用户消息 + 她的回复）
 * @param {string} [opts.occurredAt] 发生时间（默认 now）
 * @param {number} [opts.partnerId]
 * @param {boolean} [opts.replaceUnspecified] 判定出具体行为后是否撤掉该轮的"未归类"（默认 true）
 * @returns {Promise<{ok:boolean, reason:string, acts:Array, recorded:number, skipped:number, blocked:boolean, superseded:number, quota?:object, quotaExhausted?:boolean, error?:string}>}
 */
export async function judgeRound({
  characterId, rawId = 0, scene = 'chat', lines = [], occurredAt,
  partnerId = 0, replaceUnspecified = true, characterName = '', userName = '',
} = {}) {
  const id = Number(characterId);
  const empty = { ok: false, reason: '', acts: [], recorded: 0, skipped: 0, blocked: false, superseded: 0 };
  if (!Number.isInteger(id) || id <= 0) return { ...empty, error: 'invalid character id' };
  if (config.features?.intimate === false) return { ...empty, blocked: true };
  if (!needsAiJudge(existingActsForRaw(id, rawId))) return { ...empty, ok: true, reason: 'already-recorded' };

  // 每日配额：用完就跳过且**一次模型都不调**（自动补判的挂点靠这行留痕）
  const quotaBefore = getAiJudgeQuotaStatus();
  if (quotaBefore.exhausted) {
    logQuotaExhausted(quotaBefore, rawId);
    return { ...empty, quota: quotaBefore, quotaExhausted: true, error: quotaExhaustedMessage(quotaBefore) };
  }
  // 检查与扣减在同一个同步块里：并发调用不会都通过检查（Node 单线程，中间没有 await）
  const quota = consumeAiJudgeQuota();

  const prompt = buildJudgePrompt({
    characterName: characterName || '她',
    userName: userName || config.user?.nickname || '用户',
    lines: (Array.isArray(lines) ? lines : []).map(l => String(l || '').slice(0, MAX_TEXT_CHARS)).filter(Boolean),
    scene: SCENES.includes(scene) ? scene : 'chat',
  });

  let text = '';
  try {
    const res = await llmCallImpl([
      { role: 'system', content: '你是记账助手，只输出 JSON。' },
      { role: 'user', content: prompt },
    ], { temperature: 0.2, max_tokens: 500, response_format: { type: 'json_object' }, label: 'AI判断行为' });
    text = typeof res === 'string' ? res : (res?.content || '');
  } catch (err) {
    // 尝试过就算用掉一次（否则可以靠"让上游失败"无限重试绕过配额）
    return { ...empty, quota, error: err?.message || 'LLM 调用失败' };
  }

  const parsed = parseJudgeOutput(text);
  if (!parsed.ok) return { ...empty, quota, error: 'LLM 输出不是合法 JSON' };
  if (parsed.acts.length === 0) return { ...empty, quota, ok: true, reason: parsed.reason || 'no-intimate-act' };

  // 同一轮多个行为可能对象不同（与 user / 与别的角色）→ 按 partnerKind 分组写入
  const byKind = new Map();
  for (const act of parsed.acts) {
    if (!byKind.has(act.partnerKind)) byKind.set(act.partnerKind, []);
    byKind.get(act.partnerKind).push({
      actKey: act.actKey, count: act.count, climaxCount: act.climaxCount,
      sourceUid: `ai:${rawId || 0}:${act.actKey}:${act.partnerKind}`,
    });
  }

  let recorded = 0;
  let skipped = 0;
  let blocked = false;
  for (const [partnerKind, acts] of byKind) {
    const result = recordIntimateActs(id, {
      scene: SCENES.includes(scene) ? scene : 'chat',
      partnerKind,
      partnerId,
      rawId,
      source: 'llm',
      confidence: Math.min(...parsed.acts.filter(a => a.partnerKind === partnerKind).map(a => a.confidence)),
      occurredAt,
      acts,
    });
    recorded += result.inserted;
    skipped += result.skipped;
    blocked = blocked || result.blocked;
  }

  // 记到了具体行为 → 撤掉这一轮的"未归类"，避免同一次发生被算两遍
  let superseded = 0;
  if (replaceUnspecified && recorded > 0 && rawId) {
    try {
      const r = getDb().prepare(
        `DELETE FROM character_intimate_log WHERE character_id = ? AND raw_id = ? AND act_key = 'unspecified'`
      ).run(id, rawId);
      superseded = r.changes || 0;
    } catch { /* 撤不掉就留着，不影响本次写入 */ }
  }

  return { ok: true, reason: parsed.reason, acts: parsed.acts, recorded, skipped, blocked, superseded, quota };
}

/** 这个角色所在的所有会话（私聊 + 她参与的群聊） */
export function characterConversationIds(characterId) {
  const db = getDb();
  const ids = [`char_${characterId}`];
  try {
    const groups = db.prepare('SELECT group_id FROM group_members WHERE character_id = ?').all(characterId);
    for (const g of groups) ids.push(`group_${g.group_id}`);
  } catch { /* 群表异常时只判私聊 */ }
  return ids;
}

/** 连续剧主名（群聊 raw 要从整段剧本里挑出"她"的台词） */
function displayNameOf(characterId) {
  try {
    const row = getDb().prepare('SELECT display_name, name FROM characters WHERE id = ?').get(characterId);
    return row?.display_name || row?.name || '';
  } catch { return ''; }
}

/** 早于该 raw 的最近一条 user（私聊把"用户说了什么"一起送判，避免只看回复判不准） */
function previousUserLine(conversationId, rawId) {
  try {
    const row = getDb().prepare(
      `SELECT content FROM raw_messages WHERE conversation_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1`
    ).get(conversationId, rawId);
    return row?.content || '';
  } catch { return ''; }
}

/**
 * 挑出"值得 AI 补判"的最近若干轮（一条流水都没有，或只有未归类）。
 * @returns {Array<{id:number, conversationId:string, lines:string[], scene:string, occurredAt:string|null}>}
 */
export function listJudgeCandidates(characterId, { limit = DEFAULT_JUDGE_LIMIT } = {}) {
  const id = Number(characterId);
  const max = Math.max(1, Math.min(MAX_JUDGE_LIMIT, Number(limit) || DEFAULT_JUDGE_LIMIT));
  if (!Number.isInteger(id) || id <= 0) return [];
  const db = getDb();
  const convIds = characterConversationIds(id);
  const name = displayNameOf(id);
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, conversation_id, content, created_at, speaker_character_id
         FROM raw_messages
        WHERE role = 'assistant' AND conversation_id IN (${convIds.map(() => '?').join(',')})
        ORDER BY id DESC LIMIT ?`
    ).all(...convIds, Math.max(max * 8, 40));
  } catch { return []; }

  const out = [];
  for (const row of rows) {
    if (!needsAiJudge(existingActsForRaw(id, row.id))) continue;
    const isGroup = String(row.conversation_id).startsWith('group_');
    let lines = [];
    if (isGroup) {
      // 群聊 raw 是"多角色剧本"：只挑她说的话，别把别人的台词算到她头上
      const mine = String(row.content || '').split('\n')
        .map(l => /^\[([^\]]+)\]:\s*(.*)$/.exec(l.trim()))
        .filter(m => m && name && m[1].trim() === name)
        .map(m => m[2].trim())
        .filter(Boolean);
      if (mine.length === 0) continue;
      lines = mine;
    } else {
      const userLine = previousUserLine(row.conversation_id, row.id);
      lines = [userLine, row.content].filter(Boolean);
    }
    out.push({
      id: row.id,
      conversationId: row.conversation_id,
      scene: isGroup ? 'group' : 'chat',
      occurredAt: row.created_at || null,
      lines,
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 手动「AI 判断行为」：补判最近若干轮（串行，逐轮记账）。
 *
 * 每日配额：用完时**一次模型都不调**，只在 errors 里给一句人话、并如实回报 quota；
 * 正常跑完也回报 quota（用于面板显示"今日已用 N/M"）。
 * @returns {Promise<{scanned:number, judged:number, recorded:number, skipped:number, superseded:number, errors:string[], quota:object}>}
 */
export async function judgeRecentRounds(characterId, { limit = DEFAULT_JUDGE_LIMIT } = {}) {
  const id = Number(characterId);
  const summary = { scanned: 0, judged: 0, recorded: 0, skipped: 0, superseded: 0, errors: [], quota: null };
  const withQuota = () => { summary.quota = getAiJudgeQuotaStatus(); return summary; };

  if (!Number.isInteger(id) || id <= 0) { summary.errors.push('invalid character id'); return withQuota(); }
  if (config.features?.intimate === false) { summary.errors.push('intimate feature disabled'); return withQuota(); }

  // 额度用完：连候选都不扫，直接如实回报（不调模型）
  const quotaBefore = getAiJudgeQuotaStatus();
  if (quotaBefore.exhausted) {
    summary.errors.push(quotaExhaustedMessage(quotaBefore));
    summary.quota = quotaBefore;
    return summary;
  }

  const candidates = listJudgeCandidates(id, { limit });
  summary.scanned = candidates.length;
  for (const item of candidates) {
    const res = await judgeRound({
      characterId: id,
      rawId: item.id,
      scene: item.scene,
      lines: item.lines,
      occurredAt: item.occurredAt || undefined,
      characterName: displayNameOf(id),
    });
    if (res.error) {
      // 配额用完本身就是一句人话，不套 "raw N: " 前缀（前端会把它当提示文案直接用）
      summary.errors.push(res.quotaExhausted ? res.error : `raw ${item.id}: ${res.error}`);
      // 这一批跑到一半没额度了：剩下的轮次不用再试（每一轮都会得到同一句"配额已用完"）
      if (res.quotaExhausted) break;
      continue;
    }
    if (res.reason === 'already-recorded') continue;
    summary.judged += 1;
    summary.recorded += res.recorded || 0;
    summary.skipped += res.skipped || 0;
    summary.superseded += res.superseded || 0;
  }
  return withQuota();
}

/**
 * 异步补判某一轮（自动开关开启后由聊天链路 fire-and-forget 调用，绝不阻塞聊天）。
 * 失败只 warn；额度用完的跳过日志由 judgeRound 打，这里不再重复告警。
 */
export function judgeRoundInBackground(params = {}) {
  try {
    judgeRound(params).then(res => {
      if (res?.quotaExhausted) return;   // judgeRound 已打"今日配额已用完…跳过 raw=…"
      if (res?.error) console.warn('[intimateAijudge] 判定失败:', res.error);
      else if (res?.recorded > 0) {
        console.log(`[intimateAijudge] raw=${params.rawId} 记入 ${res.recorded} 笔（${res.acts.map(a => a.actKey).join('、')}）${res.superseded ? `，撤掉未归类 ${res.superseded} 笔` : ''}`);
      }
    }).catch(err => console.warn('[intimateAijudge] 判定异常:', err?.message || err));
  } catch (err) {
    console.warn('[intimateAijudge] 判定调度异常:', err?.message || err);
  }
}
