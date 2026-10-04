/**
 * 历史对话回填引擎（确定性、零 LLM）
 *
 * 背景：自动记账只从"当下这一轮"的生图 prompt 里归类，早期聊天记录里的亲密行为不会进流水，
 * 看板的初次里程碑与统计就缺了前史。本引擎扫已有 raw_messages，用**纯规则**把过去补进流水。
 *
 * 两条扫描线（各自独立断点，互不影响）：
 *
 *   【线 1｜私聊】conversation_id = `char_<characterId>`（chat.js 的 convId()）
 *     - raw_messages.prompt 存的是**生图 prompt 字符串**（英文 tag 逗号串），不是数组也不是 JSON；
 *       写入口只有 chat.js 的 `INSERT/UPDATE raw_messages (… prompt …)` 与 `tags.prompt || null`
 *     - 有些路径把 prompt 折进 content：`(图片) {"prompt":"…"}`，或往已有正文尾部追加 `{"prompt":"…"}`
 *     - 因此取 tag 的顺序是：prompt 列 → content 里的 JSON；两处都没有就跳过，绝不猜
 *
 *   【线 2｜群聊】conversation_id = `group_<groupId>`（groupChatEngine 的 groupConvId）
 *     - 一轮群聊只落 **一条** assistant raw（多角色剧本合并），raw_messages.prompt **从不写**；
 *       生图 prompt 以 `[显示名]: {英文画面描述}` 的行留在 content 里（formatGroupImageLine 的格式）
 *     - 归属角色：`[显示名]` 在本群成员里反查 characters.display_name（重名取最小 id 并 warn），
 *       查不到/不是本群成员就跳过 —— 与实时路径（membersByName）同口径，绝不跨群瞎挂
 *     - 一条 raw 里多个发言角色各带 prompt → **各自记各的那笔**（与群聊实时记账
 *       recordGroupIntimateFromRound 一致，不按群人数放大、也不只记第一个）
 *       · 顺带后果：为 A 回填时，同群里 B 的那笔也会写进 B 的流水（B 自己的回填线再跑时
 *         命中同一 raw_id 会 inserted=0）。这与实时路径行为一致，也保证 B 的面板不会缺历史。
 *     - 只有"回填发起人自己"被权限拦下才停线重扫（此时不推进游标）；其他角色被拦只跳过该行，
 *       因为每个角色都有自己的群聊回填线，不会漏
 *     - 第一版只扫"该角色所属的群"（group_members 里有行）；已解散/已退出群的历史不追
 *
 * 幂等与续跑：
 *   - 断点存在 character_intimate_backfill：私聊线用既有列 last_raw_id/scanned/inserted，
 *     群聊线用 group_last_raw_id/group_scanned/group_inserted（只加列，不改既有列语义）
 *   - 去重不靠游标而靠 recordIntimateActs 的 source_uid（同一 raw_id 重复扫描只落一行），
 *     所以游标回退 / 重扫也不会把数字翻倍 —— 这是 resetBackfill 与"重复启动"都安全的前提
 *
 * 调度：默认 setImmediate 异步推进，不阻塞 HTTP；测试用可注入的 schedule 同步推进，
 *      不依赖真实定时器（避免 flaky）。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { config } from '../config.js';
import { getDb } from '../db/index.js';
import {
  getBodyProfile,
  tagsFromPromptString,
  classifyPromptTags,
  recordIntimateActs,
  getBackfillState,
  saveBackfillState,
} from './intimateService.js';
import { recordFromPrompt, recordUnspecifiedFromText } from './intimateAutoRecord.js';

const DEFAULT_MAX_MESSAGES = 5000;
const DEFAULT_BATCH_SIZE = 200;
const MAX_MESSAGES_CAP = 200000;
const MAX_BATCH_SIZE = 2000;
const CONVERSATION_PREFIX = 'char_';
const GROUP_CONVERSATION_PREFIX = 'group_';

/** 群聊画面描述的单行长度上限，与 groupChatEngine.MAX_GROUP_IMAGE_PROMPT_CHARS 同口径 */
const MAX_GROUP_IMAGE_PROMPT_CHARS = 2000;

/**
 * 群聊线进度列：只加列、不改既有列语义。
 * 为什么要在这里补列而不是改 db/index.js：那是别人的 write scope，而本引擎自带幂等 DDL
 * 才能保证老库升级后直接可用（ALTER + PRAGMA 判存在，重复调用无副作用）。
 */
const GROUP_PROGRESS_COLUMNS = [
  ['group_last_raw_id', 'group_last_raw_id INTEGER NOT NULL DEFAULT 0'],
  ['group_scanned', 'group_scanned INTEGER NOT NULL DEFAULT 0'],
  ['group_inserted', 'group_inserted INTEGER NOT NULL DEFAULT 0'],
];
let groupColumnsEnsured = false;

/** 进程内真在跑的角色。DB 里的 running 可能是上次进程崩溃留下的，只有这个集合才是活凭据 */
const inFlight = new Set();

const scheduleImmediate = fn => setImmediate(fn);

function parseId(characterId) {
  const id = Number.parseInt(characterId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid character id');
  return id;
}

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** SQLite 的 CURRENT_TIMESTAMP 是 UTC 的 'YYYY-MM-DD HH:MM:SS'，转成 ISO 便于和别的写入口径排序一致 */
function toIso(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw)) {
    const date = new Date(`${raw.slice(0, 19).replace(' ', 'T')}Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

/**
 * 从 content 里剥出生图 prompt：兼容 `(图片) {"prompt":"…"}` 与"正文尾部追加 JSON"两种写法。
 * @param {string} content
 * @returns {string} 取不到返回 ''
 */
export function extractPromptFromContent(content) {
  const raw = String(content ?? '').trim();
  if (!raw) return '';
  const start = raw.search(/\{\s*"prompt"\s*:/);
  if (start < 0) return '';
  const tail = raw.slice(start);
  try {
    const parsed = JSON.parse(tail);
    const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : '';
    if (prompt) return prompt;
  } catch { /* JSON 被截断或后面还有正文：走正则兜底 */ }
  const matched = tail.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!matched) return '';
  try {
    return JSON.parse(`"${matched[1]}"`).trim();
  } catch {
    return matched[1].trim();
  }
}

/** prompt 列优先，content 兜底 */
function readPromptText(row) {
  const direct = String(row?.prompt ?? '').trim();
  return direct || extractPromptFromContent(row?.content);
}

// ── 线 2：群聊内容解析与归因 ──

/** `[显示名]: 正文`（与 groupChatEngine.parseScriptLine 的行协议同一形态，名字最多 20 字） */
const GROUP_LINE_RE = /^\[?([^:：\[\]]{1,20})\]?\s*[:：]\s*([\s\S]*)$/;
/** 群聊协议把花括号留给生图，正文里的 `{…}` 就是画面描述 */
const GROUP_BRACE_RE = /\{([^{}]*)\}/g;

/**
 * 从一行群聊正文里取出生图 prompt。
 * 清洗口径对齐 groupChatEngine.extractEmbeddedGroupImagePrompt（兼容 `{"prompt":"…"}` 包裹、
 * 剔除空串/`...` 占位与超长复读）。这里不 import 那个模块：它会把整个群聊引擎（LLM 客户端、
 * 调度器等）拖进回填路径，而回填只需要这条行协议。
 * @param {string} body
 * @returns {string} 取不到返回 ''
 */
function extractLineImagePrompt(body) {
  const matches = [...String(body || '').matchAll(GROUP_BRACE_RE)];
  if (matches.length === 0) return '';
  const prompts = [];
  for (const match of matches) {
    let prompt = match[1].trim();
    const wrapped = prompt.match(/^["'“”]?prompt["'“”]?\s*:\s*([\s\S]+)$/i);
    if (wrapped) prompt = wrapped[1].trim().replace(/^["'“]|["'”]$/g, '').trim();
    if (!prompt || /^\.{3}$/.test(prompt)) continue;
    if (prompt.length > MAX_GROUP_IMAGE_PROMPT_CHARS) continue;
    prompts.push(prompt);
  }
  // 一行里多个花括号块仍然只算这一个角色的一次发图（与实时路径合并成一次图片任务一致）
  return prompts.join(', ');
}

/**
 * 解析一条群聊 raw 的 content → [{ name, prompt }]，只返回"带生图 prompt 的行"。
 * @param {string} content
 */
function parseGroupContentLines(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matched = trimmed.match(GROUP_LINE_RE);
    if (!matched) continue;
    const name = matched[1].trim();
    const prompt = extractLineImagePrompt(matched[2]);
    if (name && prompt) out.push({ name, prompt });
  }
  return out;
}

/**
 * 解析一条群聊 raw 的 content → [{ name, text }]，只返回"**没有**生图 prompt 的正文行"。
 * 与 parseGroupContentLines 配对：带 `{…}` 的行走画面描述口径，其余行走正文兜底口径。
 * @param {string} content
 */
function parseGroupTextLines(content) {
  const out = [];
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matched = trimmed.match(GROUP_LINE_RE);
    if (!matched) continue;
    const name = matched[1].trim();
    const body = String(matched[2] || '').trim();
    if (!name || !body) continue;
    if (extractLineImagePrompt(body)) continue; // 发图行已由画面描述口径处理
    out.push({ name, text: body });
  }
  return out;
}

/**
 * 加载若干群的成员显示名 → 角色 id 映射。
 * 重名（同一个群里两个成员显示名相同）取 id 最小者并 warn —— 宁可明确告警，也不静默挂错人。
 * @param {number[]} groupIds
 * @returns {Map<number, Map<string, number>>}
 */
function loadMembersByGroup(groupIds) {
  const result = new Map();
  if (groupIds.length === 0) return result;
  const rows = getDb().prepare(
    `SELECT gm.group_id AS groupId, c.id AS characterId, c.display_name AS displayName
     FROM group_members gm JOIN characters c ON c.id = gm.character_id
     WHERE gm.group_id IN (${groupIds.map(() => '?').join(', ')})
     ORDER BY c.id ASC`
  ).all(...groupIds);
  for (const row of rows) {
    const name = String(row.displayName || '').trim();
    if (!name) continue;
    if (!result.has(row.groupId)) result.set(row.groupId, new Map());
    const byName = result.get(row.groupId);
    if (byName.has(name)) {
      console.warn(`[intimate] backfill: group ${row.groupId} has duplicate display_name "${name}", keeping character ${byName.get(name)}`);
      continue;
    }
    byName.set(name, row.characterId);
  }
  return result;
}

/** conversation_id `group_<id>` → groupId（取不到返回 0） */
function groupIdFromConversation(conversationId) {
  const raw = String(conversationId || '');
  if (!raw.startsWith(GROUP_CONVERSATION_PREFIX)) return 0;
  return clampInt(raw.slice(GROUP_CONVERSATION_PREFIX.length), 0, Number.MAX_SAFE_INTEGER, 0);
}

/**
 * 扫一批群聊：只扫"该角色所属的群"里 lastRawId 之后的助手 raw，按 id 升序。
 * 一条 raw 里可能有多个发言角色，各自记各自的账（见文件头）。
 */
function scanGroupBatch(characterId, { lastRawId, batchSize }) {
  const db = getDb();
  const empty = { rows: 0, scanned: 0, inserted: 0, blocked: false, cursor: lastRawId };
  const groupIds = db.prepare('SELECT group_id FROM group_members WHERE character_id = ? ORDER BY group_id').pluck().all(characterId);
  if (groupIds.length === 0) return empty;
  const conversations = groupIds.map(gid => `${GROUP_CONVERSATION_PREFIX}${gid}`);
  const rows = db.prepare(
    `SELECT id, content, conversation_id AS conversationId, created_at AS createdAt FROM raw_messages
     WHERE role = 'assistant' AND id > ? AND conversation_id IN (${conversations.map(() => '?').join(', ')})
     ORDER BY id ASC LIMIT ?`
  ).all(lastRawId, ...conversations, batchSize);
  if (rows.length === 0) return empty;

  const membersByGroup = loadMembersByGroup(
    [...new Set(rows.map(row => groupIdFromConversation(row.conversationId)))]
  );

  let scanned = 0;
  let inserted = 0;
  let cursor = lastRawId;
  let blocked = false;
  for (const row of rows) {
    const byName = membersByGroup.get(groupIdFromConversation(row.conversationId)) || new Map();
    let ownerBlocked = false;
    const promptLines = parseGroupContentLines(row.content);
    const promptedSpeakers = new Set();
    for (const line of promptLines) {
      const speakerId = byName.get(line.name) || 0;
      if (!speakerId) continue; // 不是本群成员 / 查不到：跳过，绝不瞎挂
      promptedSpeakers.add(speakerId);
      const result = recordFromPrompt({
        characterId: speakerId,
        prompt: line.prompt,
        rawId: row.id,
        scene: 'group',
        partnerKind: 'character',
        partnerId: 0,
        occurredAt: toIso(row.createdAt),
      });
      if (result.blocked) {
        // 只有发起人自己被拦才值得停线（不推进游标，授权后可重扫）；
        // 其他角色被拦就跳过这一行——每个角色都有自己的群聊回填线，不会漏。
        if (speakerId === characterId) ownerBlocked = true;
        continue;
      }
      inserted += result.inserted || 0;
    }
    // 正文兜底：本轮没发图（或画面描述无可归类行为）的成员，正文命中成人内容判定就补一笔「未归类」。
    // 已有发图行的成员排除掉，避免同一条 raw 上"具体行为 + 未归类"双重计数。
    if (!ownerBlocked) {
      for (const line of parseGroupTextLines(row.content)) {
        const speakerId = byName.get(line.name) || 0;
        if (!speakerId || promptedSpeakers.has(speakerId)) continue;
        const fallback = recordUnspecifiedFromText({
          characterId: speakerId,
          rawId: row.id,
          text: line.text,
          scene: 'group',
          partnerKind: 'character',
          partnerId: 0,
          occurredAt: toIso(row.createdAt),
        });
        if (fallback.blocked) {
          if (speakerId === characterId) ownerBlocked = true;
          continue;
        }
        inserted += fallback.inserted || 0;
      }
    }
    if (ownerBlocked) { blocked = true; break; }
    scanned += 1;
    cursor = row.id;
  }
  return { rows: rows.length, scanned, inserted, blocked, cursor };
}

/**
 * 扫一批私聊：从 lastRawId 之后按 id 升序取最多 batchSize 条助手消息。
 * 只认 role='assistant'：生图 prompt 只会挂在助手回复上，用户消息不可能有。
 */
function scanPrivateBatch(characterId, { lastRawId, batchSize }) {
  const rows = getDb().prepare(
    `SELECT id, prompt, content, created_at FROM raw_messages
     WHERE conversation_id = ? AND role = 'assistant' AND id > ?
     ORDER BY id ASC LIMIT ?`
  ).all(`${CONVERSATION_PREFIX}${characterId}`, lastRawId, batchSize);

  let scanned = 0;
  let inserted = 0;
  let cursor = lastRawId;
  let blocked = false;
  for (const row of rows) {
    const promptText = readPromptText(row);
    // 没有可归类 tag 的回合（普通聊天 / 纯文字对话 / 画面描述里没有成人 tag）：
    // 先用**正文兜底**补一笔「未归类」——正文命中成人内容判定才算，不把中文正文喂给 tag 词表（会误报）。
    // 这一笔同样是幂等 + 可回滚的（锚点 raw_id），所以重复回填不会翻倍。
    const acts = promptText ? classifyPromptTags(tagsFromPromptString(promptText)) : [];
    if (acts.length === 0) {
      const fallback = recordUnspecifiedFromText({
        characterId,
        rawId: row.id,
        text: promptText || row.content,
        scene: 'chat',
        partnerKind: 'user',
        occurredAt: toIso(row.created_at),
      });
      if (fallback.blocked) {
        // 被权限拦下：不推进游标也不计 scanned，重新授权后这一条还能被扫到
        blocked = true;
        break;
      }
      inserted += fallback.inserted || 0;
      scanned += 1;
      cursor = row.id;
      continue;
    }
    const result = recordIntimateActs(characterId, {
      scene: 'chat',
      partnerKind: 'user',
      rawId: row.id,
      source: 'auto',
      occurredAt: toIso(row.created_at),
      acts,
    });
    if (result.blocked) {
      // 被权限拦下：不推进游标也不计 scanned，重新授权后这一条还能被扫到
      blocked = true;
      break;
    }
    scanned += 1;
    cursor = row.id;
    inserted += result.inserted;
  }
  return { rows: rows.length, scanned, inserted, blocked, cursor };
}

// ── 群聊线进度存取（只加列，老库自动补） ──

/** 幂等补列：表还没建（老库未迁移完）就跳过，由既有迁移函数负责建表 */
function ensureGroupProgressColumns() {
  if (groupColumnsEnsured) return;
  const db = getDb();
  try {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'character_intimate_backfill'`).get();
    if (!exists) return;
    const columns = new Set(db.prepare('PRAGMA table_info(character_intimate_backfill)').all().map(c => c.name));
    for (const [name, ddl] of GROUP_PROGRESS_COLUMNS) {
      if (columns.has(name)) continue;
      db.exec(`ALTER TABLE character_intimate_backfill ADD COLUMN ${ddl}`);
    }
    groupColumnsEnsured = true;
  } catch (err) {
    console.warn('[intimate] backfill: ensure group progress columns failed:', err.message);
  }
}

/** 读群聊线进度；列还没补上时按"未扫过"处理，不影响私聊线 */
function readGroupProgress(characterId) {
  const empty = { lastRawId: 0, scanned: 0, inserted: 0 };
  try {
    const row = getDb().prepare(
      `SELECT group_last_raw_id AS lastRawId, group_scanned AS scanned, group_inserted AS inserted
       FROM character_intimate_backfill WHERE character_id = ?`
    ).get(characterId);
    if (!row) return empty;
    return {
      lastRawId: clampInt(row.lastRawId, 0, Number.MAX_SAFE_INTEGER, 0),
      scanned: clampInt(row.scanned, 0, Number.MAX_SAFE_INTEGER, 0),
      inserted: clampInt(row.inserted, 0, Number.MAX_SAFE_INTEGER, 0),
    };
  } catch {
    return empty;
  }
}

/** 写群聊线进度（行不存在时先补一行，保证进度不丢） */
function saveGroupProgress(characterId, { lastRawId, scanned, inserted }) {
  ensureGroupProgressColumns();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO character_intimate_backfill (character_id) VALUES (?)').run(characterId);
  db.prepare(
    `UPDATE character_intimate_backfill
     SET group_last_raw_id = ?, group_scanned = ?, group_inserted = ?, updated_at = ?
     WHERE character_id = ?`
  ).run(
    clampInt(lastRawId, 0, Number.MAX_SAFE_INTEGER, 0),
    clampInt(scanned, 0, Number.MAX_SAFE_INTEGER, 0),
    clampInt(inserted, 0, Number.MAX_SAFE_INTEGER, 0),
    new Date().toISOString(),
    characterId
  );
}

// ── 两条扫描线的推进 ──

/** 私聊线：分批扫到表尾 / 达到预算 / 被权限阻断为止 */
function advancePrivateLine(characterId, { maxMessages, batchSize }) {
  const progress = getBackfillState(characterId);
  let cursor = progress.lastRawId;
  let scannedTotal = progress.scanned;
  let insertedTotal = progress.inserted;
  let runScanned = 0;
  let done = false;
  let blocked = false;

  while (runScanned < maxMessages) {
    const size = Math.min(batchSize, maxMessages - runScanned);
    const batch = scanPrivateBatch(characterId, { lastRawId: cursor, batchSize: size });
    if (batch.rows === 0) { done = true; break; }
    runScanned += batch.scanned;
    scannedTotal += batch.scanned;
    insertedTotal += batch.inserted;
    cursor = batch.cursor;
    // 每批落一次盘：进程中途挂掉也只丢最后一批，续跑从 last_raw_id 接着来
    saveBackfillState(characterId, {
      status: 'running', lastRawId: cursor, scanned: scannedTotal, inserted: insertedTotal,
    });
    if (batch.blocked) { blocked = true; break; }
    if (batch.rows < size) { done = true; break; }
  }
  return { done, blocked, runScanned };
}

/** 群聊线：语义与私聊线一致，只是断点/计数走 group_* 列 */
function advanceGroupLine(characterId, { maxMessages, batchSize }) {
  const progress = readGroupProgress(characterId);
  let cursor = progress.lastRawId;
  let scannedTotal = progress.scanned;
  let insertedTotal = progress.inserted;
  let runScanned = 0;
  let done = false;
  let blocked = false;

  while (runScanned < maxMessages) {
    const size = Math.min(batchSize, maxMessages - runScanned);
    const batch = scanGroupBatch(characterId, { lastRawId: cursor, batchSize: size });
    if (batch.rows === 0) { done = true; break; }
    runScanned += batch.scanned;
    scannedTotal += batch.scanned;
    insertedTotal += batch.inserted;
    cursor = batch.cursor;
    saveGroupProgress(characterId, { lastRawId: cursor, scanned: scannedTotal, inserted: insertedTotal });
    if (batch.blocked) { blocked = true; break; }
    if (batch.rows < size) { done = true; break; }
  }
  return { done, blocked, runScanned };
}

/**
 * 推进一轮（同步）：先扫完私聊线，再用剩余预算扫群聊线。
 * 顺序固定（私聊 → 群聊）是为了让断点语义确定、并与第一版"只有私聊"时的进度数字完全兼容。
 * maxMessages 是两条线共享的运行预算。
 */
function advance(characterId, { maxMessages, batchSize }) {
  const priv = advancePrivateLine(characterId, { maxMessages, batchSize });
  const remaining = maxMessages - priv.runScanned;

  // 群聊线只在私聊线扫完、且还有预算时才推进；否则保持 partial，下次接着扫
  let group = { done: false, blocked: false };
  if (priv.done && remaining > 0) {
    group = advanceGroupLine(characterId, { maxMessages: remaining, batchSize });
  }

  if (priv.blocked || group.blocked) {
    // status 是扩展状态：saveBackfillState 明确不白名单，前端只需照实展示
    saveBackfillState(characterId, { status: 'blocked', error: 'AI 自动记账权限未开启（stats）' });
    return;
  }
  // 两条线都到表尾才算 done；否则 partial = 还有没扫到的行，再调一次接着扫
  const done = priv.done && group.done;
  saveBackfillState(characterId, { status: done ? 'done' : 'partial', error: '' });
}

/** 回填总闸：看板总开关 + 回填总开关 + 角色级开关（角色级默认开） */
function backfillAllowed(profile) {
  if (config?.features?.intimate === false) return false;
  if (config?.features?.intimateBackfill === false) return false;
  return profile?.backfillEnabled !== false;
}

/**
 * 回填进度（两条线都报）。
 * 顶层字段 = 私聊线（保持与第一版完全兼容，前端只需读顶层）；
 * private / group 是两条扫描线各自的断点与计数，便于面板/文档表达"私聊 + 群聊"两条线的进度。
 * @returns {{characterId:number,status:string,lastRawId:number,scanned:number,inserted:number,error:string,updatedAt:string|null,
 *            private:{lastRawId:number,scanned:number,inserted:number},
 *            group:{lastRawId:number,scanned:number,inserted:number}}}
 */
export function getBackfillStatus(characterId) {
  const id = parseId(characterId);
  const privateLine = getBackfillState(id);
  return {
    ...privateLine,
    private: {
      lastRawId: privateLine.lastRawId,
      scanned: privateLine.scanned,
      inserted: privateLine.inserted,
    },
    group: readGroupProgress(id),
  };
}

/**
 * 启动 / 继续回填。幂等：同一角色已在跑时不重复起，直接返回当前状态。
 * @param {number} characterId
 * @param {{maxMessages?:number, batchSize?:number, schedule?:(fn:Function)=>void}} [options]
 * @returns {ReturnType<typeof getBackfillState>} 启动那一刻（同步调度下即最终）的状态
 */
export function startBackfill(characterId, { maxMessages, batchSize, schedule = scheduleImmediate } = {}) {
  const id = parseId(characterId);
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');

  const profile = getBodyProfile(id);
  if (!backfillAllowed(profile)) return getBackfillStatus(id); // 开关关闭：一个字都不写

  const current = getBackfillStatus(id);
  // 内存里有活 → 不重复起；DB 里挂着 running 但内存没活（上次进程崩溃）→ 落到下面按断点续跑
  if (inFlight.has(id)) return current;

  const limits = {
    maxMessages: clampInt(maxMessages, 1, MAX_MESSAGES_CAP, DEFAULT_MAX_MESSAGES),
    batchSize: clampInt(batchSize, 1, MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE),
  };

  saveBackfillState(id, { status: 'running', error: '' });
  inFlight.add(id);
  schedule(() => {
    try {
      advance(id, limits);
    } catch (err) {
      // 引擎不把异常抛给调用方：HTTP 已经返回，错误落进状态行给面板展示
      saveBackfillState(id, { status: 'error', error: String(err?.message || err).slice(0, 300) });
    } finally {
      inFlight.delete(id);
    }
  });
  return getBackfillStatus(id);
}

/**
 * 重扫：只回退两条线的游标与计数，不删已有流水。
 * 因为去重靠 source_uid，重扫不会把数字翻倍；要清数据请用 DELETE /api/characters/:id/intimate。
 */
export function resetBackfill(characterId) {
  const id = parseId(characterId);
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id)) throw new Error('character not found');
  saveBackfillState(id, { status: 'idle', lastRawId: 0, scanned: 0, inserted: 0, error: '' });
  try {
    saveGroupProgress(id, { lastRawId: 0, scanned: 0, inserted: 0 }); // 群聊线也回到起点
  } catch (err) {
    // 群聊线进度写不进去（老库缺列等）不该连累私聊线重置
    console.warn('[intimate] backfill: reset group progress failed:', err.message);
  }
  return getBackfillStatus(id);
}
