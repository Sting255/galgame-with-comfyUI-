/**
 * AI 整理亲密档案（propose / apply + 待确认提议）
 *
 * 职责：从角色最近的私聊对话里抽取档案信息，按 aiEditFields 逐字段分流：
 *   - 已授权字段（isAiEditAllowed）→ 立即写入身体档案 / 敏感带 / 备注 / 初次
 *   - 未授权字段 → 只落一条 pending 提议，等用户在面板上"采纳"才写库
 *
 * 为什么必须有待确认提议：档案是用户自己的设定，AI 只能提议不能替用户拍板。
 * 权限键与 services/intimateService.js 的 AI_EDIT_KEYS 完全同源
 * （body / sensitiveZones / note / firsts / stats），默认只放开 stats，
 * 所以默认配置下这里的一切改动都会进提议列表，不会静默改档案。
 *
 * 幂等与清理：同一 (角色, 字段) 同一时间只保留一条 pending 提议，新的提议替换旧的
 * pending（accepted / rejected 的历史行保留，供审计）。
 *
 * 素材：raw_messages 中 conversation_id = `char_<id>` 的最近 user/assistant 消息，
 * 倒序累计到 sourceCharLimit 字符为止；素材为空时直接返回 empty，**不调 LLM**（零成本）。
 *
 * 测试可注入：proposeProfileEdits(characterId, { llmCall }) 可传入假的 LLM 调用，
 * 单测据此完全离线（网络被 globalThis.fetch 挡死）。
 *
 * 边界声明：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { getDb } from '../db/index.js';
import { chatSync } from '../llm/llm-client.js';
import {
  ACT_DEFINITIONS,
  ACT_KEYS,
  isAiEditAllowed,
  getBodyProfile,
  upsertBodyProfile,
  setFirstAt,
  listFirsts,
} from './intimateService.js';

/**
 * LLM 调用注入点：单测（含路由层的真实 HTTP 用例）必须完全离线，
 * 所以除 proposeProfileEdits 的 llmCall 参数外，再留一个模块级开关；传非函数即恢复真实 chatSync。
 */
let llmCallImpl = chatSync;
export function setLlmCallForTest(fn) {
  llmCallImpl = typeof fn === 'function' ? fn : chatSync;
}

/** 参与整理的素材上限（字符）；太小会让模型只能瞎猜，太大则白烧 token */
const DEFAULT_SOURCE_LIMIT = 6000;
const MAX_SOURCE_LIMIT = 40000;
/** 单条消息最多喂给模型的字符数，防一条超长消息把预算吃光 */
const MAX_SOURCE_MESSAGE = 2000;
/** 倒序最多回看多少条消息（在字数上限之外再兜一层） */
const MAX_SOURCE_ROWS = 200;

const MAX_BODY_LEN = 60;   // 身高 / 三围（与 intimateService 的 str() 默认上限一致）
const MAX_CUP_LEN = 12;
const MAX_NOTE_LEN = 120;  // 比 intimateService 的 300 更严：模型只该给一句短描述
const MAX_ZONES = 30;

/** level 1~5 的展示文案（与注入块的 "脖颈(较强)" 口径保持一致） */
const ZONE_LEVEL_TEXT = ['', '轻微', '一般', '较强', '很强', '极强'];

/** 权限键 → 面板中文名 */
const FIELD_LABELS = { body: '身体信息', sensitiveZones: '敏感带', note: '备注', firsts: '初次' };

const BODY_FIELDS = [['height', MAX_BODY_LEN], ['bust', MAX_BODY_LEN], ['waist', MAX_BODY_LEN], ['hip', MAX_BODY_LEN], ['cup', MAX_CUP_LEN]];
const BODY_LABELS = [['height', '身高'], ['bust', '胸围'], ['waist', '腰围'], ['hip', '臀围'], ['cup', '罩杯']];

const PENDING_REASON = '未开启该字段的 AI 修改权限，AI 只做了提议，采纳后才写入';

const nowIso = () => new Date().toISOString();

const clampInt = (value, min, max, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 角色 / 提议 id：非法（0、负数、NaN）一律归 0，由各入口抛 invalid */
function toPositiveId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * 文本清洗：折叠换行与连续空格；**超长一律判非法丢弃**，不写半截值。
 * 允许数字（模型常把身高写成 168 而不是 "168cm"），其余类型一律丢弃。
 */
function cleanText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return '';
  return text;
}

/** 只接受 YYYY-MM-DD 且是真实日历日期（模型常给 2024-13-45 这类假日期） */
function cleanDate(value) {
  const text = cleanText(value, 10);
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!matched) return '';
  const [year, month, day] = [Number(matched[1]), Number(matched[2]), Number(matched[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return text;
}

/** 身体尺寸：只留非空且长度合法的项（空串 = 对话里没提到，不算"改档案"） */
function sanitizeBody(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [field, max] of BODY_FIELDS) {
    const value = cleanText(input[field], max);
    if (value) out[field] = value;
  }
  return out;
}

/**
 * 敏感带：level 必须是 1~5 的整数（非法整条丢弃），key / label 至少有一个，
 * 同 key 去重，最多 30 条（与 intimateService 的 MAX_ZONES 一致）。
 */
function sanitizeZones(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = cleanText(item.key, 32).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = cleanText(item.label, 24);
    if (!key && !label) continue;
    const level = Number.parseInt(item.level, 10);
    if (!Number.isInteger(level) || level < 1 || level > 5) continue;
    const dedupe = key || label;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ key: key || label, label: label || key, level });
    if (out.length >= MAX_ZONES) break;
  }
  return out;
}

/** 初次里程碑：actKey 必须在 ACT_DEFINITIONS 词表里，日期必须合法，同 actKey 只留第一条 */
function sanitizeFirsts(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const actKey = cleanText(item.actKey, 48).toLowerCase();
    if (!ACT_KEYS.has(actKey) || seen.has(actKey)) continue;
    const firstAt = cleanDate(item.firstAt);
    if (!firstAt) continue;
    seen.add(actKey);
    out.push({ actKey, firstAt });
  }
  return out;
}

/** 逐字段清洗 LLM 输出：任何一项不合法都只是"不写"，不影响其它字段 */
function sanitizeEdits(parsed) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return {
    body: sanitizeBody(source),
    zones: sanitizeZones(source.sensitiveZones),
    note: cleanText(source.note, MAX_NOTE_LEN),
    firsts: sanitizeFirsts(source.firsts),
  };
}

/** 解析 LLM 输出：容忍 ```json 代码块包装；不是对象就返回 null（全部字段按丢弃处理） */
function parseJsonObject(raw) {
  if (raw && typeof raw === 'object') return raw; // 便于单测直接注入对象
  const text = String(raw ?? '').trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 库里的载荷统一是 JSON；解析失败时按纯文本兼容处理（历史 / 手改过的行） */
function parseStoredPayload(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ── 展示用预览串（面板直接显示 suggestion / currentValue，避免把 JSON 甩到界面上） ──

function bodyPreview(body) {
  if (!body || typeof body !== 'object') return '';
  return BODY_LABELS.filter(([field]) => body[field]).map(([field, label]) => `${label} ${body[field]}`).join('、');
}

function zonesPreview(zones) {
  if (!Array.isArray(zones)) return '';
  return zones
    .map(zone => `${zone?.label || zone?.key || ''}(${ZONE_LEVEL_TEXT[Number(zone?.level)] || zone?.level || ''})`)
    .filter(text => text !== '()')
    .join('、');
}

function firstsPreview(firsts) {
  if (!Array.isArray(firsts)) return '';
  const labelOf = key => ACT_DEFINITIONS.find(def => def.key === key)?.label || key;
  return firsts
    .filter(item => item?.firstAt)
    .map(item => `${labelOf(item.actKey)} ${String(item.firstAt).slice(0, 10)}`)
    .join('、');
}

function previewOf(field, payload) {
  if (field === 'body') return bodyPreview(payload);
  if (field === 'sensitiveZones') return zonesPreview(payload);
  if (field === 'note') return typeof payload === 'string' ? payload : '';
  if (field === 'firsts') return firstsPreview(payload);
  return '';
}

function rowToSuggestion(row) {
  const payload = parseStoredPayload(row.suggestion);
  const currentPayload = parseStoredPayload(row.current_value);
  return {
    id: Number(row.id),
    field: row.field,
    fieldLabel: FIELD_LABELS[row.field] || row.field,
    // 面板直接显示这两个可读串；机器载荷另给 payload / currentPayload，采纳时无需回传
    suggestion: previewOf(row.field, payload),
    currentValue: previewOf(row.field, currentPayload),
    payload,
    currentPayload,
    reason: row.reason,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── 落库 ──

/**
 * 写档案的唯一入口：propose（已授权字段）与 accept（用户采纳）都走这里，
 * 保证两条路写入口径完全一致；载荷进来还要再校验一次，脏值一律不写。
 * @returns {{field: string, value: any}|null} null = 载荷非法 / 无可写内容
 */
function applyField(characterId, field, payload) {
  if (field === 'body') {
    const patch = sanitizeBody(payload);
    if (Object.keys(patch).length === 0) return null;
    upsertBodyProfile(characterId, patch);
    return { field, value: patch };
  }
  if (field === 'sensitiveZones') {
    const zones = sanitizeZones(payload);
    if (zones.length === 0) return null;
    upsertBodyProfile(characterId, { sensitiveZones: zones });
    return { field, value: zones };
  }
  if (field === 'note') {
    const note = cleanText(payload, MAX_NOTE_LEN);
    if (!note) return null;
    upsertBodyProfile(characterId, { note });
    return { field, value: note };
  }
  if (field === 'firsts') {
    const firsts = sanitizeFirsts(payload);
    if (firsts.length === 0) return null;
    for (const item of firsts) {
      // setFirstAt 的 source 固定写 'manual'：这是"人为断言"唯一可用的来源标记。
      // 好处是 AI 整理出的初次日期不会被之后补录的流水派生覆盖；代价是该 actKey 的
      // 流水派生被挡住（要恢复派生，用户在面板上清空这项即可）。note 写明来源便于识别。
      setFirstAt(characterId, item.actKey, { firstAt: item.firstAt, note: 'AI 整理' });
    }
    return { field, value: firsts };
  }
  return null;
}

/**
 * 落一条待确认提议（未授权字段）。
 * 同一字段只保留一条 pending：旧 pending 被新提议替换，避免面板上堆一列同字段的旧提议；
 * 已处理（accepted / rejected）的行不动，保留成审计记录。
 */
function savePendingSuggestion(characterId, field, payload, currentPayload) {
  const db = getDb();
  const stamp = nowIso();
  db.prepare(
    `DELETE FROM character_intimate_suggestions WHERE character_id = ? AND field = ? AND status = 'pending'`
  ).run(characterId, field);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO character_intimate_suggestions
       (character_id, field, current_value, suggestion, reason, status, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'ai', ?, ?)`
  ).run(characterId, field, JSON.stringify(currentPayload ?? null), JSON.stringify(payload), PENDING_REASON, stamp, stamp);
  return rowToSuggestion(db.prepare('SELECT * FROM character_intimate_suggestions WHERE id = ?').get(Number(lastInsertRowid)));
}

// ── 素材与 prompt ──

/**
 * 取该角色私聊会话最近的对话素材：倒序（最近优先）累计到字数上限，再还原成时间正序。
 * 只取 user / assistant 且 content 非空的行；system 提示词与生图 prompt 都不是"相处内容"。
 */
function collectSourceMessages(characterId, charLimit) {
  const rows = getDb().prepare(
    `SELECT role, content FROM raw_messages
     WHERE conversation_id = ? AND role IN ('user','assistant')
       AND content IS NOT NULL AND TRIM(content) <> ''
     ORDER BY id DESC LIMIT ?`
  ).all(`char_${characterId}`, MAX_SOURCE_ROWS);

  const picked = [];
  let used = 0;
  for (const row of rows) {
    let text = String(row.content).trim();
    if (!text) continue;
    if (text.length > MAX_SOURCE_MESSAGE) text = `${text.slice(0, MAX_SOURCE_MESSAGE)}…`;
    // 首条（最新的一条）即使超预算也保留，否则素材永远为空
    if (picked.length > 0 && used + text.length > charLimit) break;
    picked.push({ role: row.role, content: text });
    used += text.length;
    if (used >= charLimit) break;
  }
  return picked.reverse();
}

function formatTranscript(messages, characterName) {
  return messages
    .map(item => `${item.role === 'user' ? '用户' : characterName}：${item.content}`)
    .join('\n');
}

/**
 * 组装整理 prompt。
 * 按 AGENTS.md 的 LLM 输出规范：给完整 JSON 示例 + 逐字段的内容要求与约束 + 只输出 JSON。
 * actKey 的候选值直接从 ACT_DEFINITIONS 生成，模型没有机会编造不存在的键。
 */
function buildProposeMessages({ characterName, transcript }) {
  const actList = ACT_DEFINITIONS.map(def => `${def.key}(${def.label})`).join('、');
  const system = `你在为角色扮演游戏整理「${characterName}」的身体档案。你会读到玩家与${characterName}最近的对话记录，请只把对话里**明确提到**的信息整理成字段。

【输出格式】只输出一个 JSON 对象，字段名与下面示例完全一致：

{
  "height": "168cm",
  "bust": "88cm",
  "waist": "60cm",
  "hip": "89cm",
  "cup": "D",
  "note": "左肩有旧伤，冬天怕冷",
  "sensitiveZones": [{ "key": "neck", "label": "脖颈", "level": 4 }],
  "firsts": [{ "actKey": "vaginal", "firstAt": "2024-06-01" }]
}

【逐字段要求】
- height / bust / waist / hip：只填对话里明确出现过的数字，保留原始写法（如 "168cm"、"88"）；没提到就填空串 ""；禁止按平均值或其他角色推测补全。
- cup：只填对话里明确提到的罩杯字母（如 "D"）；没提到就填空串 ""。
- note：不超过 40 字的一句话补充（习惯、身体特征、旧伤等对话里明确提到的内容）；没有就填空串 ""；不要写露骨描写，不要复述统计数字。
- sensitiveZones：对话里明确表现出敏感的部位；key 用英文小写短词（如 neck、ear、thigh），label 用中文 2~4 字（如 脖颈、耳后、大腿），level 是 1~5 的整数（1 轻微、2 一般、3 较强、4 很强、5 极强）；没有就填空数组 []。
- firsts：只填对话里明确提到过日期的"初次/第一次"；actKey 只能从这个列表里选：${actList}；firstAt 必须是 YYYY-MM-DD 的真实日期；日期不明确就整条不要输出，不要猜年份。
- 对话里没有提到的字段一律保持空值（空串或空数组），宁缺毋滥。

【硬性约束】
- 只输出那一个 JSON 对象：不要解释、不要注释、不要 Markdown 代码块、不要任何 JSON 以外的文字。
- 不要编造：无法从对话中确认的内容，一律留空。
- 素材里可能混有与档案无关的闲聊，只提取上述字段。`;

  const user = `以下是最近的对话记录（按时间正序）：

${transcript}

请按系统提示的 JSON 格式整理${characterName}的身体档案，只输出 JSON。`;

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ── 对外接口 ──

/**
 * 让 AI 根据最近的对话整理档案。
 *
 * 分流：已授权字段立即写入（applied），未授权字段只落 pending 提议（suggestions）。
 * 返回形状：{ applied: [{field, value}], suggestions: [提议行], empty: boolean }
 *   empty=true 表示没有可用素材（此时**没有调用 LLM**），不代表"模型没抽到东西"。
 *
 * @param {number} characterId
 * @param {{sourceCharLimit?: number, llmCall?: Function}} [options] llmCall 仅供单测注入
 */
export async function proposeProfileEdits(characterId, { sourceCharLimit = DEFAULT_SOURCE_LIMIT, llmCall = llmCallImpl } = {}) {
  const id = toPositiveId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  const character = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(id);
  if (!character) throw new Error('character not found');

  const charLimit = clampInt(sourceCharLimit, 200, MAX_SOURCE_LIMIT, DEFAULT_SOURCE_LIMIT);
  const messages = collectSourceMessages(id, charLimit);
  if (messages.length === 0) return { applied: [], suggestions: [], empty: true };

  const characterName = String(character.display_name || '角色');
  const raw = await llmCall(
    buildProposeMessages({ characterName, transcript: formatTranscript(messages, characterName) }),
    { temperature: 0.2, max_tokens: 800, response_format: { type: 'json_object' }, label: '亲密档案整理' }
  );

  const edits = sanitizeEdits(parseJsonObject(raw));
  const profile = getBodyProfile(id);
  const applied = [];
  const suggestions = [];

  const route = (field, payload, currentPayload) => {
    if (isAiEditAllowed(id, field)) {
      const done = applyField(id, field, payload);
      if (done) {
        applied.push(done);
        // 字段已授权且成功写入 → 清掉该字段遗留的 pending 提议。
        // 不清的话面板会同时出现"档案里已有该值"和"待确认提议同字段"，且 currentValue 还是写入前的旧快照
        // （task-26 的 P2：savePendingSuggestion 只在"新建 pending"时替换旧行，已授权分支原先没有任何清理）。
        // 只清 pending：accepted / rejected 行保留成审计记录。
        getDb().prepare(
          `DELETE FROM character_intimate_suggestions WHERE character_id = ? AND field = ? AND status = 'pending'`
        ).run(id, field);
      }
      return;
    }
    suggestions.push(savePendingSuggestion(id, field, payload, currentPayload));
  };

  if (Object.keys(edits.body).length > 0) {
    route('body', edits.body, {
      height: profile.height, bust: profile.bust, waist: profile.waist, hip: profile.hip, cup: profile.cup,
    });
  }
  if (edits.zones.length > 0) route('sensitiveZones', edits.zones, profile.sensitiveZones);
  if (edits.note) route('note', edits.note, profile.note);
  if (edits.firsts.length > 0) route('firsts', edits.firsts, listFirsts(id).filter(item => item.firstAt));

  return { applied, suggestions, empty: false };
}

/**
 * 待确认提议列表（默认只看 pending）。
 * @param {number} characterId
 * @param {{status?: string|null, limit?: number}} [options] status=null 表示不过滤状态
 */
export function listSuggestions(characterId, { status = 'pending', limit = 50 } = {}) {
  const id = toPositiveId(characterId);
  if (!id) throw new Error('invalid character id');
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');
  const filter = status === null || status === undefined || status === '' ? '' : ' AND status = ?';
  const params = filter ? [id, String(status), clampInt(limit, 1, 200, 50)] : [id, clampInt(limit, 1, 200, 50)];
  return db.prepare(
    `SELECT * FROM character_intimate_suggestions WHERE character_id = ?${filter}
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(...params).map(rowToSuggestion);
}

/**
 * 采纳一条提议：把载荷写进档案，status → accepted。
 *
 * 这里是**人工授权路径**：用户点了"采纳"就是他自己的决定，不再看 aiEditFields 权限位
 * （否则未授权字段的提议永远无法落地，提议列表就没意义了）。写入仍走 applyField，
 * 载荷会再校验一次。
 *
 * @returns {{suggestion: object, applied: object|null}|null} null = 提议不存在 / 不属于该角色
 */
export function acceptSuggestion(characterId, suggestionId) {
  const id = toPositiveId(characterId);
  const sid = toPositiveId(suggestionId);
  if (!id || !sid) throw new Error('invalid argument');
  const db = getDb();
  const row = db.prepare('SELECT * FROM character_intimate_suggestions WHERE id = ? AND character_id = ?').get(sid, id);
  if (!row) return null;
  // 已处理过的提议不重复写入（幂等）
  if (row.status !== 'pending') return { suggestion: rowToSuggestion(row), applied: null };

  const applied = applyField(id, row.field, parseStoredPayload(row.suggestion));
  if (!applied) throw new Error('invalid suggestion payload');
  db.prepare(`UPDATE character_intimate_suggestions SET status = 'accepted', updated_at = ? WHERE id = ?`).run(nowIso(), sid);
  return { suggestion: rowToSuggestion(db.prepare('SELECT * FROM character_intimate_suggestions WHERE id = ?').get(sid)), applied };
}

/**
 * 忽略一条提议：只改状态（status → rejected），不动档案。
 * @returns {{suggestion: object}|null} null = 提议不存在 / 不属于该角色
 */
export function rejectSuggestion(characterId, suggestionId) {
  const id = toPositiveId(characterId);
  const sid = toPositiveId(suggestionId);
  if (!id || !sid) throw new Error('invalid argument');
  const db = getDb();
  const row = db.prepare('SELECT * FROM character_intimate_suggestions WHERE id = ? AND character_id = ?').get(sid, id);
  if (!row) return null;
  if (row.status === 'pending') {
    db.prepare(`UPDATE character_intimate_suggestions SET status = 'rejected', updated_at = ? WHERE id = ?`).run(nowIso(), sid);
  }
  return { suggestion: rowToSuggestion(db.prepare('SELECT * FROM character_intimate_suggestions WHERE id = ?').get(sid)) };
}
