/**
 * groupTranscriptExcludes.js —— 群聊 transcript 的遗忘屏蔽区间解析（§5.1「0.5 刀」纯搬家，2026-09-30）
 *
 * **为什么独立**：反重复取数（groupAntiRepetition）与上下文组装（buildGroupContext / buildTranscript）
 * 都要用它；让它住在任一业务模块里都会造成「业务模块 → 另一个业务模块」的反向依赖。
 * 口径没变（task-1 预冻结）：**任一成员遗忘该区间即对全体屏蔽**；不传成员 / 无窗口 / 读库失败 → []。
 */

import { collectForgottenWindowsForMembers } from './hypnosisService.js';


/**
 * 本轮群聊要屏蔽的遗忘时间区间。
 *
 * 口径（task-1，lead 预冻结，2026-09-29）：**任一成员遗忘该区间即对全体屏蔽**——
 * 一轮群聊是一次调用演全部角色、一条 raw 里混着所有人的发言，无法按成员分片裁 transcript；
 * 反过来按行拆 raw 的代价与出错面都大得多。区间取窗口自身的 from_at/to_at（不是 raw id：
 * 群会话与私聊会话是两条独立的自增序列）。不传成员 / 无窗口 / 总开关关闭 → []（零行为变化）。
 */
export function resolveTranscriptExcludeRanges(members) {
  try {
    const ids = (Array.isArray(members) ? members : [])
      .map(m => Number(m?.id))
      .filter(id => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return [];
    return collectForgottenWindowsForMembers(ids);
  } catch (err) {
    // 遗忘窗口查库失败只 warn：群聊不能被隐私侧的一次读失败拖垮（与 chat.js 同口径）
    console.warn('[hypnosis] group forgotten windows lookup failed:', err.message);
    return [];
  }
}
