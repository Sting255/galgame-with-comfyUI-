/**
 * `touch_events` 的读取 / 消费 / 过期清扫（task-24 · P2-2 搬家）
 *
 * 为什么单独成服务：这两条链都要消费 `touch_events` ——
 *   · 私聊：`routes/chat.js` 的 5.55 段（`takePendingTouchEvent` → 注入 → `markTouchEventInjected`）；
 *   · 群聊：`services/groupChatEngine.js` 的 `collectTouchActionBlocks`（自带过滤与钉状态）。
 * 搬家前 `chat.js` 为了拿清扫函数反向 `import './touch.js'`（路由 ← 路由），层次颠倒；
 * 现在两边都从本服务 import，**行为逐字节不变**（SQL、过滤条件、返回值形状全照搬）。
 *
 * 口径：
 *   · 新鲜度判定**只有一处**：`touchActionService.touchEventCutoff()`（纯函数，SQL 侧比较它返回的
 *     SQLite 无时区 UTC 串）；
 *   · 消费顺序 **ASC（先点先演）** —— 与群聊链同口径；即时模式成功的事件是 `'done'`，同样会被消费
 *     （注入「已发过别再演」块），这是刻意的弱影响，不为它加复杂分支；
 *   · 只认私聊事件（`group_id IS NULL`）：群聊事件由群聊链消费。
 */

import { getDb } from '../db/index.js';
import { touchEventCutoff } from './touchActionService.js';

/**
 * 过期清扫：把该角色 / 该群里**超过新鲜度窗口**的 pending / done 事件标成 `'expired'`。
 *
 * 判断口径只有一处：`touchActionService.touchEventCutoff()`；私聊链与群聊链都调同一个函数。
 * 调用点：`routes/touch.js` 的入口（GET/POST），以及本文件的 `takePendingTouchEvent`。
 * 失败只 warn：清扫是旁路，不能影响这一次请求。
 *
 * @param {{characterId?:number, groupId?:number, now?:number}} [scope] 二选一；都给了就按 groupId
 * @returns {number} 被标成 expired 的行数
 */
export function expireStaleTouchEvents({ characterId = 0, groupId = 0, now = Date.now() } = {}) {
  const group = Number.parseInt(groupId, 10);
  const character = Number.parseInt(characterId, 10);
  const column = Number.isSafeInteger(group) && group > 0 ? 'group_id' : 'character_id';
  const id = column === 'group_id' ? group : character;
  if (!Number.isSafeInteger(id) || id <= 0) return 0;
  try {
    const result = getDb().prepare(
      `UPDATE touch_events SET status = 'expired', updated_at = datetime('now')
        WHERE ${column} = ? AND status IN ('pending', 'done') AND created_at < ?`
    ).run(id, touchEventCutoff(now));
    return Number(result.changes) || 0;
  } catch (err) {
    console.warn('[touch] 过期清扫失败:', err?.message || err);
    return 0;
  }
}

/**
 * 取该角色**最旧**的一条待消费私聊事件（先点先演）。
 *
 * 顺带做一次过期清扫 + 按 cutoff 过滤（双保险）；返回 `null` = 没有可消费的事件。
 * 返回值形状（chat.js 的 5.55 段直接吃）：`{ id, actionKey, mode, annoyance, likeRatio }`。
 */
export function takePendingTouchEvent(characterId) {
  try {
    expireStaleTouchEvents({ characterId });
  } catch (err) {
    console.warn('[touch] 过期清扫失败（读取仍按 cutoff 过滤）:', err?.message || err);
  }
  // 顺序 = **ASC（先点先演）**：与群聊链 `groupChatEngine.collectTouchActionBlocks` 同口径
  //（task-24 P0-2；改前是 DESC = 后点的先演，用户连点三个动作时演出顺序会颠倒）。
  // 注：即时模式成功的事件是 'done'，同样会被消费（注入「已发过别再演」块）—— 改 ASC 后
  // 旧的 done 块可能延迟一轮注入，属**弱影响**，有意不为它加复杂分支。
  const row = getDb().prepare(
    `SELECT id, action_key, mode, annoyance, like_ratio
       FROM touch_events
      WHERE character_id = ? AND status IN ('pending', 'done') AND group_id IS NULL
        AND created_at >= ?
      ORDER BY id ASC LIMIT 1`
  ).get(characterId, touchEventCutoff());
  if (!row) return null;
  return {
    id: Number(row.id),
    actionKey: row.action_key,
    mode: row.mode === 'instant' ? 'instant' : 'implicit',
    annoyance: Number(row.annoyance) || 0,
    likeRatio: Number(row.like_ratio) || 1,
  };
}

/** 消费即完成：置 `injected`（一次动作只注入一次；写失败只 warn，最坏下轮再注入一次） */
export function markTouchEventInjected(eventId) {
  try {
    getDb().prepare(
      `UPDATE touch_events SET status = 'injected', updated_at = datetime('now')
        WHERE id = ? AND status IN ('pending', 'done')`
    ).run(eventId);
  } catch (err) {
    console.warn('[touch] mark injected failed:', err?.message || err);
  }
}

/**
 * groupId 的**严格**解析（独立验证者报的边界：旧实现用 parseInt ⇒ `1.5` 被截成 1、`3abc` 被截成 3）。
 *
 * 口径：数字入参必须是安全正整数；字符串 `String(raw).trim()` 后必须**全是数字**（`/^\d+$/`）且 > 0。
 * 于是 —— `1` / `'1'` / `' 1 '` ✅；`1.5` / `'1.5'` / `'3abc'` / `'+3'` / `'-1'` / `'1e3'` / `''` / 数组 / null ❌（返回 null）。
 * 返回 `null` 的语义由调用方决定：`countPendingTouchEvents` 当"没给群"回落私聊口径，
 * `routes/touch.js` 的 `/state` 直接 400 `INVALID_GROUP_ID`。
 *
 * @returns {number|null}
 */
export function parseStrictGroupId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * 还有多少条**待回应**的事件（`GET /touch/state` 的 `pendingCount`）。
 *
 * 两种口径（task-28 复审问题 2）：
 *   · **私聊（默认）**：`character_id = ? AND group_id IS NULL` —— **与改动前逐字节一致**；
 *   · **群聊**：传 `groupId`（正整数）时数 **该群全体成员**的待消费事件（`group_id = ?`，
 *     不再按 character_id 过滤 —— 群聊页要显示的是"这个群里还有几件事没演"）。
 *
 * 计数口径（2026-09-30 真机问题 3 修正）：**只数 `status = 'pending'`** ——「等她回应」的语义是
 * **还没反应**；`done` 表示**反应已经作为独立消息发过了**（即时模式成功），不该再占「等她回应」的计数，
 * 否则用户不回话时计数只涨不减（30 分钟 TTL 内连过期都不会）。`injected` / `expired` / `dropped` 同样不算。
 *
 * ⚠️ **只改计数，不改消费**：`takePendingTouchEvent` 仍然吃 `pending + done`（`done` 要注入
 * 「已发过别再演」块，是刻意设计）。
 * 本函数**不做清扫**（调用方先调 `expireStaleTouchEvents`，见 `routes/touch.js` 的 `/state`）。
 *
 * @param {number} characterId 私聊口径用；群聊口径下不参与过滤
 * @param {{groupId?:number|string}} [options] 传**严格正整数** = 群聊口径；其余（含 `1.5` / `'3abc'` / `'+3'` / 0）= 私聊口径
 */
export function countPendingTouchEvents(characterId, { groupId = 0 } = {}) {
  const gid = parseStrictGroupId(groupId);
  try {
    if (gid !== null) {
      return Number(getDb().prepare(
        "SELECT COUNT(*) AS n FROM touch_events WHERE group_id = ? AND status = 'pending'"
      ).get(gid)?.n) || 0;
    }
    return Number(getDb().prepare(
      "SELECT COUNT(*) AS n FROM touch_events WHERE character_id = ? AND group_id IS NULL AND status = 'pending'"
    ).get(characterId)?.n) || 0;
  } catch (err) {
    console.warn('[touch] pendingCount 读取失败:', err?.message || err);
    return 0;
  }
}

/**
 * 同上口径，但**按 mode 分开**（供前端分场本文案：隐式才需要「跟她说句话吧」，即时反应天生不需要等）。
 *
 * 作用域与 `countPendingTouchEvents` 完全一致（`groupId` 严格正整数 = 群聊口径，只数 `pending`）。
 * @returns {{instant:number, implicit:number}}
 */
export function countPendingTouchEventsByMode(characterId, { groupId = 0 } = {}) {
  const gid = parseStrictGroupId(groupId);
  const out = { instant: 0, implicit: 0 };
  try {
    const rows = gid !== null
      ? getDb().prepare("SELECT mode, COUNT(*) AS n FROM touch_events WHERE group_id = ? AND status = 'pending' GROUP BY mode").all(gid)
      : getDb().prepare("SELECT mode, COUNT(*) AS n FROM touch_events WHERE character_id = ? AND group_id IS NULL AND status = 'pending' GROUP BY mode").all(characterId);
    for (const row of rows) {
      const key = row.mode === 'instant' ? 'instant' : 'implicit';
      out[key] += Number(row.n) || 0;
    }
    return out;
  } catch (err) {
    console.warn('[touch] pendingByMode 读取失败:', err?.message || err);
    return out;
  }
}
