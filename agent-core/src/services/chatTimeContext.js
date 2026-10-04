/**
 * 主聊天 `<time_context>` 块的组装（从 chat.js L1184-1203 原样抽出，2026-09-30）
 *
 * ## 为什么单独成文件
 * 1. **可测**：这段逻辑原来是 chat.js 里 ~20 行内联代码，只能靠"读源码"验证；抽成纯函数后
 *    可以真正跑"播种历史 → 调用 → 断言块内容"的行为测试（含程序时间偏移）。
 * 2. **口径显式**：`<time_context>` 是**给模型看的叙事时间**，必须吃**程序时间**
 *    （与日程/睡眠/光线/催眠同一口径，见 services/programTime.js 的模块注释）。
 *
 * ## 口径（裁决记录，2026-09-30）
 * · **当前时间**：`getProgramNow()` —— 程序时间。用户把程序时间拨到夜里时，角色嘴里的"现在"
 *   必须也是夜里（改动前是 `new Date()`，靠 timeLight.resolveNow 内部加偏移，语义隐式）。
 * · **距上次聊天 gap**：两端都用程序时间（`now` 与 `created_at→程序时间`）。
 *   理由：`<上次对话 …>` 这行文字也在讲"上一次是什么时候"，跟当前时间同属叙事钟；
 *   如果当前是程序时间、这行却按真实钟算，拨钟后会出现"她认为现在是夜里，却宣称你两分钟前刚来过"。
 * · 偏移为 0（默认）时，与改动前逐字节一致（程序时间 = 真实时间）。
 *
 * ## 与"真实时间"的边界（别顺手改回）
 * 真实定时器（setTimeout 心跳、临时唤醒窗口、next_proactive_at、reply_queue.scheduled_reply_at）
 * 一律仍走真实时间；本模块只产出 prompt 文本。
 */

import { getProgramNow, parseSqlUtc, readProgramState, toProgramTime } from './programTime.js';
import { getTimeTag } from './timeLight.js';

/** 「距上次聊天」超过这个分钟数才写进 <time_context>（原有阈值，口径不变） */
export const TIME_CONTEXT_GAP_MINUTES = 10;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 取"上一次对话"的时间（真实瞬间 Date），没有则 null。
 *
 * ⚠️ `OFFSET 1` 的语义：**倒数第二条** user 消息。它成立的前提是**当前这条 user 消息已经落库**
 * （chat.js 在组装上下文之前就把 user raw 写进去了，见 L584-587）——所以"倒数第二条"正是
 * "上一条 user 消息"。这条 SQL 刻意不在参数里传当前 id：幂等重发（client_msg_id 命中）路径下
 * 当前 raw 也是那一行，OFFSET 语义仍然正确。
 *
 * @param {object} db
 * @param {string} conversationId
 * @returns {Date|null}
 */
export function loadPreviousUserMessageAt(db, conversationId) {
  const prevUserMsg = db.prepare(`
    SELECT created_at FROM raw_messages
    WHERE conversation_id = ? AND role = 'user'
    ORDER BY id DESC LIMIT 1 OFFSET 1
  `).get(conversationId);
  if (!prevUserMsg?.created_at) return null;
  return parseSqlUtc(prevUserMsg.created_at);
}

/**
 * 组装 `<time_context>` 内容（不含外层标签）。
 *
 * @param {object} db
 * @param {string} conversationId
 * @param {{now?:Date}} [opts] now 缺省 = 程序时间（测试可显式注入，注入值按**程序时间**解释）
 * @returns {string} 例：`[2026-09-30 周三 22:10 | 秋天·深夜]\n[上次对话 2026-09-30 周三 21:40]`
 */
export function buildTimeContextLines(db, conversationId, { now } = {}) {
  const programNow = now instanceof Date ? now : getProgramNow();
  // ⚠️ `getTimeTag()` 内部会走 `resolveNow → toProgramTime`，也就是**自己再加一次偏移**。
  // 直接喂 `programNow`（已经是程序时间）会把偏移加两遍：2026-10-01 实测把程序时间拨快 10 天，
  // 块里打出来的是 **+20 天**（real=10-01 03:23 / getProgramNow=10-11 03:23 / 块里=10-21 03:23）。
  // 所以喂进去之前先把偏移减掉，还它一个**真实瞬间**，让它自己换算回程序时间 —— 只加一次。
  const offsetMs = readProgramState().offsetMs || 0;
  const timeBlocks = [getTimeTag(offsetMs ? new Date(programNow.getTime() - offsetMs) : programNow)];

  const prevAt = loadPreviousUserMessageAt(db, conversationId);
  if (prevAt) {
    // gap 两端都换算到程序时间：created_at 是**真实瞬间**（落库口径），+offset 才是她感知到的时刻
    const prevProgram = toProgramTime(prevAt);
    const gapMinutes = (programNow.getTime() - prevProgram.getTime()) / 60000;
    if (gapMinutes > TIME_CONTEXT_GAP_MINUTES) {
      const prevWeekDay = WEEKDAYS[prevProgram.getDay()];
      const prevDateStr = `${prevProgram.getFullYear()}-${String(prevProgram.getMonth() + 1).padStart(2, '0')}-${String(prevProgram.getDate()).padStart(2, '0')}`;
      timeBlocks.push(`[上次对话 ${prevDateStr} ${prevWeekDay} ${String(prevProgram.getHours()).padStart(2, '0')}:${String(prevProgram.getMinutes()).padStart(2, '0')}]`);
    }
  }
  return timeBlocks.join('\n');
}

/** 组装完整的 `<time_context>` dynamicBlock（chat.js 只调它） */
export function buildTimeContextBlock(db, conversationId, opts = {}) {
  return `<time_context>\n${buildTimeContextLines(db, conversationId, opts)}\n</time_context>`;
}
