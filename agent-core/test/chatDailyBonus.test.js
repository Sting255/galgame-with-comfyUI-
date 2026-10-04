/**
 * 主聊天「每日首次互动 +5」的口径回归（代码审查改进 §4.1 的姊妹问题 + 顺带核实 chat.js:658）
 *
 * ## 这条链在做什么
 * `chat.js` 的情绪引擎段（原 L658-674）有一个「今日首次和这个角色互动 → 好感度 +5」的奖励：
 * 读 `user_relationships.last_interaction_at`，**按日期比较**决定今天是否已经奖励过。
 *
 * ## 缺陷（本文件先红后绿）
 * 1. **写入污染**：`saveAffinity(charId, affinity, /*updateLastInteraction*\/ true)` 会顺手把
 *    `last_interaction_at` 写成**系统时刻** —— 情绪评估落库（chat.js:1718）、触摸互动
 *    （touch.js:737 走 applyTouchEmotion）、送礼（emotionEngine.giveGift）都会写它。
 *    于是「用户今天一句话都没说，只要情绪评估/被摸过一次」就已经把这行写成今天，
 *    用户当天真正来聊天时 **+5 拿不到**。
 * 2. **程序时间拨动会翻双倍**：用户在设置页把程序时间 +1 天，真实日期仍是今天，
 *    奖励边界与程序钟无关 —— 这条要作为「有意口径」钉住（奖励是真实世界行为，不吃程序时间）。
 *
 * ## 修法与口径
 * 判据改成 **用户真实互动**：`messages` 表里 current 那条 user 之前最近一条 user 的 `created_at`
 * （与主动聊天调度器同一数据源、同一理由）。系统写入不再影响奖励；日期口径仍是**真实 UTC 日**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`chat time context fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { toSqlUtc, resetProgramTime, setProgramOffsetMs, invalidateProgramTimeCache } = await import('../src/services/programTime.js');
const { saveAffinity } = await import('../src/services/emotionEngine.js');
const { saveDailyInteractionBonus, DAILY_INTERACTION_BONUS, lastRealUserInteractionAt } = await import('../src/services/chatDailyBonus.js');

test.after(() => { resetProgramTime(); invalidateProgramTimeCache(); closeDb(); });

const CONV = 'char_daily_bonus';
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** 造一轮"用户消息 + 她回复"：raw_messages 与 messages 两表都写（与 chat.js 落库口径一致） */
function seedTurn(characterId, createdAt) {
  const db = getDb();
  const createdAtSql = toSqlUtc(new Date(createdAt));
  const rawId = Number(db.prepare("INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, 'user', 'u', ?)").run(CONV, createdAtSql).lastInsertRowid);
  // messages.raw_id 有外键；seq 必须递增，否则拿不到稳定的先后语义
  const seq = Number(db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS s FROM messages WHERE conversation_id = ?').get(CONV).s);
  const msgId = Number(db.prepare("INSERT INTO messages (conversation_id, raw_id, role, content, seq, created_at) VALUES (?, ?, 'user', 'u', ?, ?)").run(CONV, rawId, seq, createdAtSql).lastInsertRowid);
  db.prepare("INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', 'a', ?)").run(CONV, createdAtSql);
  return { rawId, msgId };
}

function resetState(characterId, { lastInteractionAt = null } = {}) {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(CONV);        // 先删子表（raw_id 外键）
  db.prepare('DELETE FROM raw_messages WHERE conversation_id = ?').run(CONV);
  db.prepare('DELETE FROM emotion_snapshots WHERE conversation_id = ?').run(CONV);
  db.prepare('DELETE FROM user_relationships WHERE character_id = ?').run(characterId);
  db.prepare("INSERT INTO user_relationships (character_id, relationship_text, affinity, last_interaction_at) VALUES (?, '', 50, ?)")
    .run(characterId, lastInteractionAt);
}

/** UTC 日期串（与实现同一口径） */
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

// ── 1. 红：系统写入污染（last_interaction_at 被非用户行为写成"今天"） ──

test('【修复前为红】系统写入 last_interaction_at=今天 ⇒ 旧判据误判"今天已领"，用户真正首条消息拿不到 +5', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();

  // 昨天用户来过一次 → 给过奖励，last_interaction_at 停在昨天
  resetState(characterId, { lastInteractionAt: toSqlUtc(new Date(now - DAY_MS)) });
  seedTurn(characterId, now - DAY_MS);

  // 今天用户没说话，但系统（情绪评估 / 触摸 / 送礼）调了 saveAffinity(..., true) 把这一行写成今天
  saveAffinity(characterId, 55, true);
  const stamped = db.prepare('SELECT last_interaction_at FROM user_relationships WHERE character_id = ?').pluck().get(characterId);
  assert.equal(stamped.slice(0, 10), utcDay(now), '前提：系统写入确实把这行标成今天');

  // 【红证据】旧判据（读这一列 + 比日期）在这里就会判定"今天已领" ⇒ 不加分。
  // 这段代码逐字复刻修复前的 chat.js L658-670，是这条 bug 的可执行证据。
  const oldRuleWouldAward = stamped.slice(0, 10) !== utcDay(now);
  assert.equal(oldRuleWouldAward, false, '修复前：系统写入把这一列写成今天 ⇒ 旧判据不给奖励（红）');

  // 今天用户真正来聊天（当前这条 user 已在库里，与 chat.js 的时序一致）
  seedTurn(characterId, now);
  assert.equal(saveDailyInteractionBonus(db, characterId, { conversationId: CONV }), DAILY_INTERACTION_BONUS,
    '修复后：判据是"上一条真实 user 在昨天" ⇒ 用户今天的第一条真实消息拿到 +5');
});

// ── 2. 绿：判据是"用户真实互动"（messages 表），不是被系统写的那一列 ──

test('修后口径：判据取 messages 表里"上一条 user"的时间；系统怎么写这一列都不影响', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  resetState(characterId, { lastInteractionAt: toSqlUtc(new Date(now)) });   // 这一列被写成今天
  seedTurn(characterId, now - DAY_MS);                                      // 但用户真实上一条是昨天
  seedTurn(characterId, now);                                               // 当前这条

  assert.equal(utcDay(lastRealUserInteractionAt(db, CONV).getTime()), utcDay(now - DAY_MS),
    'lastRealUserInteractionAt 必须取"上一条 user"（昨天的真实互动）');
  assert.equal(saveDailyInteractionBonus(db, characterId, { conversationId: CONV }), DAILY_INTERACTION_BONUS,
    '真实互动跨天 ⇒ 给 +5，与 last_interaction_at 无关');
});

test('同一天第二条消息不再给（幂等靠"上一条 user 是今天"）', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  // ⚠️ 「今天稍早」**不能**写成 `now - 2h`：UTC 日界之后的头两小时里，"2 小时前"其实是**昨天**
  //    ⇒ 这条用例会在北京时间 08:00~10:00 之间假红（2026-10-03 发布门禁就是这么被挡下的：
  //    同一个提交我这边跑绿、门禁跑红，差别只在跨过了 UTC 00:00）。
  //    改成"从今天 UTC 00:00 起算的稍早时刻"，与当前钟点无关（与下面「昨天 23:30」那条同款写法）。
  const todayStart = Date.parse(utcDay(now) + 'T00:00:00Z');
  const earlierToday = Math.max(todayStart, now - 2 * HOUR_MS);
  assert.equal(utcDay(earlierToday), utcDay(now), '前提：稍早的时刻必须落在同一个 UTC 日');
  assert.ok(earlierToday <= now, '前提：稍早的时刻不能晚于现在');
  resetState(characterId);
  seedTurn(characterId, earlierToday);   // 今天稍早说过话（= 上一条真实互动）
  seedTurn(characterId, now);            // 当前这条（chat.js 在判定前已落库）

  assert.equal(saveDailyInteractionBonus(db, characterId, { conversationId: CONV }), 0, '上一条真实互动就在今天 ⇒ 不再给');
});

test('当前这条是今天的第一条（库里没有更早的 user）⇒ 给 +5', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  resetState(characterId);
  seedTurn(characterId, now);   // 只有当前这条
  assert.equal(lastRealUserInteractionAt(db, CONV), null, '没有"上一条 user"（当前这条不算）');
  assert.equal(saveDailyInteractionBonus(db, characterId, { conversationId: CONV }), DAILY_INTERACTION_BONUS);
});

test('昨天 23:30 来过（UTC 口径跨天）⇒ 今天给 +5', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  // 取"昨天"的固定钟点：today 00:10 - 40 分钟 = 昨天 23:30（与当前时刻无关，避免测试在午夜前后抖动）
  const todayStart = Date.parse(utcDay(now) + 'T00:00:00Z');
  const lastNight = todayStart - 40 * 60 * 1000;
  resetState(characterId);
  seedTurn(characterId, lastNight);
  seedTurn(characterId, now);
  assert.equal(saveDailyInteractionBonus(db, characterId, { conversationId: CONV }), DAILY_INTERACTION_BONUS);
});

// ── 3. 有意口径：奖励吃真实日期，不吃程序时间 ──

test('有意口径：奖励按真实日界，拨动程序时间不改变奖励判定', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  resetState(characterId);
  seedTurn(characterId, now - DAY_MS);
  seedTurn(characterId, now);

  // 第一次：当前这条 user 已落库（chat.js 的真实时序），上一条真互动在昨天 ⇒ 给 +5
  const before = saveDailyInteractionBonus(db, characterId, { conversationId: CONV });
  assert.equal(before, DAILY_INTERACTION_BONUS, '真实跨天 ⇒ 给 +5');
  try {
    setProgramOffsetMs(3 * DAY_MS);      // 程序时间 +3 天
    invalidateProgramTimeCache();
    seedTurn(characterId, now);          // 今天又来说了一条（真实日期仍是今天）
    const again = saveDailyInteractionBonus(db, characterId, { conversationId: CONV });
    assert.equal(again, 0, '上一条真实互动仍是今天 ⇒ 拨钟不产生额外奖励（真实日界口径）');
  } finally {
    resetProgramTime();
    invalidateProgramTimeCache();
  }
});

test('只有真实互动才更新 last_interaction_at（系统写入不再被当成互动）', () => {
  const db = getDb();
  const characterId = 1;   // 复用 seed 出来的角色（user_relationships.character_id 有外键）
  const now = Date.now();
  resetState(characterId);
  seedTurn(characterId, now - DAY_MS);
  seedTurn(characterId, now);

  saveDailyInteractionBonus(db, characterId, { conversationId: CONV });
  const stamped = db.prepare('SELECT last_interaction_at FROM user_relationships WHERE character_id = ?').pluck().get(characterId);
  assert.ok(stamped, '真实互动后这一列应被更新（保持既有可读性）');
  assert.equal(stamped.slice(0, 10), utcDay(now), '更新时间=真实今天');
});

// ── 4. 源码级：chat.js 不再拿 last_interaction_at 判"今天是否已互动" ──

test('源码级：chat.js 的每日奖励改走 chatDailyBonus（不再自己读 last_interaction_at 做日界判断）', async () => {
  const src = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(src.includes("from '../services/chatDailyBonus.js'"), 'chat.js 应 import chatDailyBonus');
  assert.ok(src.includes('saveDailyInteractionBonus(db, characterId'), '应调用 saveDailyInteractionBonus');
  assert.ok(!/SELECT last_interaction_at FROM user_relationships/.test(src),
    'chat.js 里不该再有直接读 last_interaction_at 做日界判断的副本（已抽到 chatDailyBonus.js）');
});
