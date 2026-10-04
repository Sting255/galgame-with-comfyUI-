/**
 * 主聊天「今日首次互动 +5」奖励（从 chat.js L658-674 抽出，2026-09-30）
 *
 * ## 为什么单独成文件 + 为什么改判据
 * 原实现读 `user_relationships.last_interaction_at` 并按日期比较，判「今天是否已经奖励过」。
 * 但这一列**会被系统写入污染**：`saveAffinity(charId, x, true)` 会顺手把它写成系统时刻，而这条路径
 * 至少在三处是**非用户互动**：
 *   · chat.js 的情绪评估落库（每轮聊天后都会更新好感度）
 *   · routes/touch.js 的触摸互动（applyTouchEmotion → saveAffinity 系）
 *   · emotionEngine.giveGift（送礼/誓约）
 * 后果：用户今天一句话都没说，只要被系统写过一次，这一列就是「今天」，用户当天真正来聊天时 +5 拿不到。
 *
 * ## 现在的口径（真实互动）
 * 判据改成 **`messages` 表里 current 那条 user 之前最近一条 user 的 created_at**
 * —— 与主动聊天调度器读 `messages.role='user'` 同一数据源、同一理由：
 * 「用户上次真的来聊天」只有消息表说得清，关系表那一列是系统也会碰的状态位。
 *
 * · 奖励是**真实世界行为**（用户今天有没有来）⇒ 日期用真实 UTC 日，**不吃程序时间**（有意口径）。
 * · 真实互动发生时仍会写 `last_interaction_at`（保持这一列对人可读/可审计的历史语义），
 *   但它**不再是判据**。
 */

import { loadAffinity, saveAffinity } from './emotionEngine.js';

/** 每日首次互动奖励（原有数值，不改） */
export const DAILY_INTERACTION_BONUS = 5;

/** 真实 UTC 日（`YYYY-MM-DD`）：与落库时间戳口径一致（无时区 UTC 串） */
function realUtcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 取「上一条 user 消息」的时间（真实瞬间 Date）；没有则 null。
 *
 * ⚠️ 用 `messages` 表而不是 `raw_messages`：与主动聊天调度器同一口径（那边也只认 messages.role='user'），
 * 且 messages 一行 = 一个用户可见气泡，不会因为系统插话（如 @memory 续写）而错位。
 * `OFFSET 1` 成立的前提是**当前这条 user 已经落库**（chat.js 组装上下文前就写了）。
 *
 * @param {object} db
 * @param {string} conversationId
 * @returns {Date|null}
 */
export function lastRealUserInteractionAt(db, conversationId) {
  const row = db.prepare(
    `SELECT created_at FROM messages
     WHERE conversation_id = ? AND role = 'user' AND created_at IS NOT NULL
     ORDER BY id DESC LIMIT 1 OFFSET 1`
  ).get(conversationId);
  if (!row?.created_at) return null;
  // created_at 是无时区 UTC 串：必须自己补 Z（V8 会把它当本地时间，历史上因此整体偏移一个时区）
  const raw = String(row.created_at);
  const ms = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * 「今日首次互动 +5」：用户真实上一条消息不在今天（或从未来过）→ 加 +5 并返回 5，否则 0。
 *
 * 副作用（与旧实现一致）：命中时把好感度 +5 写回（`saveAffinity(..., true)` 同时更新
 * `last_interaction_at`，供首页/看板阅读）；未命中时不做任何写入。
 *
 * @param {object} db
 * @param {number|string} characterId
 * @param {{conversationId:string}} opts
 * @returns {number} 实际加上的好感度（命中 = DAILY_INTERACTION_BONUS，未命中 = 0）
 */
export function saveDailyInteractionBonus(db, characterId, { conversationId } = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return 0;
  const lastReal = lastRealUserInteractionAt(db, convId);
  const today = realUtcDay(Date.now());
  if (lastReal && realUtcDay(lastReal.getTime()) === today) return 0;   // 今天已经真的来过
  // 返回值语义：saveAffinity 回的是新好感度；本函数统一回"实际加了多少"，调用点直接记日志
  saveAffinity(characterId, loadAffinity(characterId) + DAILY_INTERACTION_BONUS, true);
  return DAILY_INTERACTION_BONUS;
}
