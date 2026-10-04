/**
 * groupTouchConsumption.js —— 群聊「动作消费 + 围观决策」簇（§5.1 纯搬家，2026-09-30）
 *
 * **本文件是纯搬家产物**：下列函数/常量从 groupChatEngine.js **逐字节**搬来，逻辑一行未动、
 * 导出名一个未改；groupChatEngine.js 仍从本文件 re-export 同一批符号（对外面完全不变）。
 *
 * 职责（自包含，无 DB 表变更）：
 *   1. 围观概率与决策（task-22）：DEFAULT_TOUCH_BYSTANDER_CHANCE / resolveTouchBystanderChance /
 *      planTouchBystander / buildTouchBystanderRule —— 纯函数 + 只读 config；
 *   2. 待消费触摸事件 → 注入块（task-17）：collectTouchActionBlocks（读 touch_events、置 injected、
 *      expired/dropped 清扫）；
 *   3. 围观者落库（D4）：stampGroupRoundOnlooker + messages.onlooker_char_id 列探测。
 *
 * 依赖方向：只依赖 db / config / scheduleManager / hypnosisService / hypnosisPrompt / touchActionService，
 * 不 import groupChatEngine（避免循环依赖 / TDZ）。
 */

import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { isSleeping } from './scheduleManager.js';
import { isBodyControlled } from './hypnosisService.js';
import { buildSubjectScopeLine } from './hypnosisPrompt.js';
import { TOUCH_MODES, buildTouchActionBlock, getTouchAction, touchEventCutoff } from './touchActionService.js';

/** 围观插话的默认概率（task-22）：30%。`config.features.touchBystanderChance` 可覆盖；null / false = 关闭概率模型。 */
export const DEFAULT_TOUCH_BYSTANDER_CHANCE = 0.3;

/**
 * 解析本轮围观概率（task-22）。
 *
 * 口径：
 *   · `undefined` / 非数字 → **默认 0.3**（概率模型生效）；
 *   · `0 ~ 1` 的数字 → 用配置值（0 = 永远不让别人插话，1 = 每轮都可以）；
 *   · `null` / `false` → **关闭**，返回 null（块文案退回 task-17 版本，逐字节一致）。
 *
 * 设置键是 `features.touchBystanderChance`（config.js 归 Lead，本模块只读；缺省即默认值）。
 */
export function resolveTouchBystanderChance(raw = config.features?.touchBystanderChance) {
  if (raw === null || raw === false) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TOUCH_BYSTANDER_CHANCE;
  return Math.min(1, Math.max(0, value));
}

/**
 * 围观决策（纯函数，注入随机源便于单测）。
 * @returns {{chance:number|null, roll:number, allowed:boolean, member:object|null}}
 */
export function planTouchBystander({ members = [], excludeId = null, chance = DEFAULT_TOUCH_BYSTANDER_CHANCE, random = Math.random } = {}) {
  const roll = Number(random());
  const others = (Array.isArray(members) ? members : []).filter(m => Number(m?.id) !== Number(excludeId));
  if (chance === null || others.length === 0) return { chance, roll, allowed: false, member: null };
  const allowed = roll < chance;
  if (!allowed) return { chance, roll, allowed: false, member: null };
  // 允许围观时**点名一位**成员：仍然满足用户裁决的"单轮最多 1 人"
  const index = Math.min(others.length - 1, Math.max(0, Math.floor(Number(random()) * others.length)));
  return { chance, roll, allowed: true, member: others[index] };
}

/**
 * 群聊动作的围观规则块。
 *
 * task-17：用户裁决"单轮只 1 人插话"——被摸的那位演反应，其他成员至多 1 人应一声。
 * task-22：做成**真概率**——`planTouchBystander` 掷一次骰子决定本轮是否允许围观；
 * 允许时点名一位成员（仍然最多 1 人），不允许时明确"其他成员这一轮都不要发言"。
 * `chance === null`（关闭）时返回的字符串与 task-17 版本**逐字节一致**。
 */
export function buildTouchBystanderRule(name, { chance = DEFAULT_TOUCH_BYSTANDER_CHANCE, allowed = false, otherName = '' } = {}) {
  const who = String(name || '').trim() || '她';
  if (chance === null) {
    return `<touch_bystander>本轮是群聊：只让「${who}」演出这一下接触的反应；其他成员**最多 1 个人**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>`;
  }
  const other = String(otherName || '').trim();
  if (allowed && other) {
    return `<touch_bystander>本轮是群聊：只让「${who}」演出这一下接触的反应；其他成员**只让「${other}」**可以插一句围观 / 起哄的话（其余人这一轮不要发言），不要整群跟着刷屏。</touch_bystander>`;
  }
  return `<touch_bystander>本轮是群聊：只让「${who}」演出这一下接触的反应；**其他成员这一轮都不要发言**，不要整群跟着刷屏。</touch_bystander>`;
}

/**
 * 群聊动作系统（task-17 · 阶段二）：把本群**待消费**的触摸事件变成注入块。
 *
 * 与私聊链（`routes/chat.js` 的 5.55 段）**同一条消费语义**：
 *   · 读一条 `status IN ('pending','done')` 的事件 → 生成带**成员限定行**的 `<touch_action>` 块
 *     （一次调用演多个角色，不限定会把"你"算到所有人头上）→ 立刻置 `'injected'`：**一次动作只注入一次**；
 *   · `mode='instant'`（反应已作为独立消息发过）照传，块里写"别再演一遍"。
 *
 * 三条本模块特有的口径：
 *   1. **单轮最多消费 1 条事件**（用户裁决"单轮只 1 人插话"）⇒ `LIMIT 1`，其余留到下一轮；
 *   2. 块后追加 `<touch_bystander>`：其他成员最多 1 人围观，别让全群刷屏；
 *      task-22 起是**真概率**（默认 30%，features.touchBystanderChance 可配、null/false 关闭）：
 *      允许时点名一位成员（仍然最多 1 人），不允许时明确「其他成员这一轮都不要发言」；
 *   3. 过期清扫：`created_at < touchEventCutoff()` 的 pending/done 一律标 `'expired'`（**判断只有一处**，
 *      与私聊链调同一个纯函数）；事件指向的成员已不在群里 / 动作已下架则标 `'dropped'`，并**继续往下找**
 *      下一条可用事件（坏行不占本轮的"单轮 1 条"名额，也不会把后面的正常事件堵住）。
 *
 * 失败只 warn（群聊主流程不能被它拖垮）；`config.features.touch === false` 或非法 group 直接返回空。
 *
 * @param {{id:number, members?:Array}} group
 * @param {{now?:number, bystanderChance?:number|null, bystanderRandom?:Function}} [options]
 *   bystanderChance：本轮围观概率（不传 = resolveTouchBystanderChance()；null = 关闭概率模型，
 *   块文案退回 task-17 版本逐字节一致）；bystanderRandom：注入随机源（单测用，默认 Math.random）。
 * @returns {{blocks:string[], consumed:object|null, expired:number, dropped:number, bystander?:object}}
 */
/**
 * D4（2026-09-30）· 把本轮「谁围观」落库到该轮群消息上。
 *
 * 围观者由 `planTouchBystander` 程序选定（掷中才有）。本函数把选择写进
 * `messages.onlooker_char_id`（同一 raw 的所有气泡写同一个值），使「谁围观」可查询、可统计：
 *   `SELECT onlooker_char_id, COUNT(*) FROM messages WHERE conversation_id = 'group_<id>' AND onlooker_char_id IS NOT NULL GROUP BY 1`
 *
 * `onlookerCharId` 为空（掷不中 / 关闭概率模型）⇒ **什么都不写**（零落库，与 task-17 行为一致）。
 * 列不存在（老库还没跑迁移）⇒ **安全 no-op** 并返回 false —— 绝不因为少一列让整轮群聊失败。
 */
export function stampGroupRoundOnlooker(db, { rawId, onlookerCharId } = {}) {
  if (!rawId || !onlookerCharId) return false
  try {
    if (!messagesHasOnlookerColumn(db)) {
      console.warn('[group] messages.onlooker_char_id 列不存在（迁移未跑？），本轮围观者不落库');
      return false
    }
    db.prepare('UPDATE messages SET onlooker_char_id = ? WHERE raw_id = ?').run(Number(onlookerCharId), rawId)
    return true
  } catch (err) {
    console.warn('[group] 围观者落库失败:', err.message)
    return false
  }
}

/** 进程级一次的列探测（老库/测试库都可能没有这一列） */
let onlookerColumnChecked = null
function messagesHasOnlookerColumn(db) {
  if (onlookerColumnChecked !== null) return onlookerColumnChecked
  try {
    onlookerColumnChecked = db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'onlooker_char_id')
  } catch {
    onlookerColumnChecked = false
  }
  return onlookerColumnChecked
}

export function collectTouchActionBlocks(group, { now = Date.now(), bystanderChance, bystanderRandom } = {}) {
  const empty = { blocks: [], consumed: null, expired: 0, dropped: 0 };
  if (config.features.touch === false) return empty;
  const groupId = Number(group?.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return empty;
  const members = Array.isArray(group?.members) ? group.members : [];
  const db = getDb();
  const cutoff = touchEventCutoff(now);
  let expired = 0;
  let dropped = 0;
  try {
    expired = Number(db.prepare(
      `UPDATE touch_events SET status = 'expired', updated_at = datetime('now')
        WHERE group_id = ? AND status IN ('pending', 'done') AND created_at < ?`
    ).run(groupId, cutoff).changes) || 0;

    // 一次取几条候选：坏行（成员退群 / 动作已下架）就地作废并**继续往下找**——
    // 否则一条坏行会白占掉本轮的"单轮 1 条"名额，用户要点的那一下要等到再下一轮。
    const rows = db.prepare(
      `SELECT id, character_id, action_key, mode, annoyance, like_ratio
         FROM touch_events
        WHERE group_id = ? AND status IN ('pending', 'done') AND created_at >= ?
        ORDER BY id LIMIT 5`
    ).all(groupId, cutoff);
    if (rows.length === 0) return { ...empty, expired };

    for (const row of rows) {
      const member = members.find(m => Number(m?.id) === Number(row.character_id));
      const action = member ? getTouchAction(row.action_key) : null;
      if (!member || !action) {
        db.prepare(`UPDATE touch_events SET status = 'dropped', updated_at = datetime('now') WHERE id = ?`).run(row.id);
        dropped += 1;
        continue;
      }

      const name = member.display_name || member.name || `角色${member.id}`;
      const block = buildTouchActionBlock({
        actionKey: action.key,
        userName: config.user?.nickname || '用户',
        mode: row.mode === 'instant' ? TOUCH_MODES.INSTANT : TOUCH_MODES.IMPLICIT,
        annoyance: Number(row.annoyance) || 0,
        likeRatio: Number(row.like_ratio) || 1,
        hypnotized: isBodyControlled(member.id),
        sleeping: Boolean(isSleeping(member.id).sleeping),
        scopeLine: buildSubjectScopeLine(name),
      });
      // 消费即完成（与私聊链一致）：先把状态推到 injected，再交给调用方拼 prompt
      db.prepare(
        `UPDATE touch_events SET status = 'injected', updated_at = datetime('now')
          WHERE id = ? AND status IN ('pending', 'done')`
      ).run(row.id);

      // task-22：围观真概率——掷一次骰子决定本轮是否允许「别人插一句」，允许时点名一位成员（仍然最多 1 人）
      const chance = bystanderChance !== undefined ? bystanderChance : resolveTouchBystanderChance();
      const bystander = planTouchBystander({
        members,
        excludeId: member.id,
        chance,
        random: bystanderRandom || Math.random,
      });
      const bystanderName = bystander.member ? (bystander.member.display_name || bystander.member.name || ('角色' + bystander.member.id)) : '';
      console.log('[group] touch bystander conv ' + groupId + ': ' + (bystander.allowed ? ('allow ' + bystanderName) : 'deny') + ' (p=' + (chance === null ? 'off' : chance) + ', roll=' + bystander.roll.toFixed(2) + ')');
      return {
        blocks: block ? [block, buildTouchBystanderRule(name, { chance, allowed: bystander.allowed, otherName: bystanderName })] : [],
        consumed: { id: Number(row.id), characterId: Number(row.character_id), actionKey: action.key, name, mode: row.mode },
        bystander: { chance, roll: bystander.roll, allowed: bystander.allowed, memberId: bystander.member ? Number(bystander.member.id) : null },
        expired,
        dropped,
      };
    }
    return { ...empty, expired, dropped };
  } catch (err) {
    console.warn('[touch] group collect failed:', err.message);
    return { ...empty, expired, dropped };
  }
}
