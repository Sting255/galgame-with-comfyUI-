/**
 * groupAntiRepetition.js —— 群聊反重复簇（§5.1 第 4 刀，纯搬家，2026-09-30）
 *
 * **纯搬家产物**：常量 / isWholeGroupHypnotized / buildGroupAntiRepetitionBlock / 两个私有 helper /
 * collectGroupAntiRepetitionBlock 从 groupChatEngine.js **逐字节**搬来，逻辑一行未动、导出名未改；
 * 引擎 re-export 原本公开的 4 个符号（routes/chat.js、routes/context.js、routes/groups.js、
 * services/groupIdleScheduler.js 都还在从引擎取，对外面不变）。
 *
 * 检测器本身全部来自 antiRepetition.js（b1-antirep 的领地）：**本模块只 import 不改**。
 *
 * 随行依赖：`resolveTranscriptExcludeRanges`（遗忘区间解析）——反重复取数要用它算 excludeWindows，
 * 而 buildGroupContext / buildTranscript 也要用；放在本模块是为了避免它反向依赖引擎（无环）。
 *
 * 依赖方向：db / config / antiRepetition / hypnosisService / groupConversationId —— 不 import 引擎。
 */

import { getDb } from '../db/index.js';
import { config } from '../config.js';
import {
  buildAntiRepetitionInjection,
  fetchRecentAssistantTurns,
  fetchRecentEmotionSnapshots,
  formatAntiRepetitionLog,
} from './antiRepetition.js';
import { getHypnosisState } from './hypnosisService.js';
// 「0.5 刀」：遗忘屏蔽区间解析抽到 groupTranscriptExcludes.js（反重复与上下文组装共用）
import { resolveTranscriptExcludeRanges } from './groupTranscriptExcludes.js';
import { groupConvId } from './groupConversationId.js';

/** 群聊反重复看几轮：与私聊 chat.js 的默认窗口一致（6 轮）。 */
export const GROUP_ANTI_REPETITION_TURNS = 6;

/**
 * 是否**整群**都处于催眠「完全控制」（深度催眠 + 身体受控 + 意志未醒）。
 *
 * 私聊里 hypnosisNeedsFullPerformance 时会跳过反重复（她被命令重复执行，两个块打架）。
 * 群聊是「一次调用演所有人」，所以口径取**全群**：只有所有人都处在完全控制态时，
 * 「本轮就是该重复」才成立、才跳过；只要还有没被控制的成员，反重复块照常注入
 * （被控制的那位由**排在他之后的**催眠块压过，位置越靠后优先级越高 —— 见块序注释）。
 */
export function isWholeGroupHypnotized(members = []) {
  const ids = (Array.isArray(members) ? members : [])
    .map(m => Number(m?.id))
    .filter(id => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return false;
  try {
    return ids.every(id => {
      const state = getHypnosisState(id);
      return Boolean(state?.active && state.bodyControlled && !state.mindAwake);
    });
  } catch {
    return false;   // 读不到状态就当没被控制：反重复是增强项，宁可多注入一次
  }
}

/**
 * 面向**全群**的合并反重复块（纯函数，检测全部来自 antiRepetition.js，一行都没复制）。
 *
 * 为什么是「一个块」而不是按成员各成一块：群聊每轮只有**一次** LLM 调用、输出是一份剧本，
 * 约束本来就该是全局的；fetchRecentAssistantTurns 取回来的每一条 raw 就是那一轮**所有人**的
 * 发言合体，所以「该群最近几轮的剧本」天然给出全群口径的重复判定。
 *
 * 同一轮只给一条最强约束（escalated > topic_progress > anti_repetition），
 * 这个优先级来自 buildAntiRepetitionInjection 自身，不做二次判定。
 *
 * @returns {{enabled:boolean, block:string|null, result:object|null}}
 */
export function buildGroupAntiRepetitionBlock({
  turns = [],
  emotionSnapshots = [],
  hypnosisActive = false,
  escalationEnabled = true,
  // 群聊口径固定：**纯文本**话题锁（不再传情绪判定）。理由见 collectGroupAntiRepetitionBlock 的注释。
  textOnly = true,
  enabled = true,
} = {}) {
  if (!enabled) return { enabled: false, block: null, result: null };
  const result = buildAntiRepetitionInjection({
    recentAssistantTurns: turns,
    emotionSnapshots,
    hypnosisActive,
    escalationEnabled,
    textOnlyTopicLock: textOnly,
  });
  return { enabled: true, block: result?.topicProgressBlock || result?.block || null, result };
}

/** 群会话的摘要 checkpoint（与 buildTranscript 同一口径）：反重复只看还在上下文里的轮次 */
function groupSummaryCheckpointEndId(db, conversationId) {
  try {
    const row = db.prepare(`
      SELECT end_msg_id FROM rolling_summaries
      WHERE conversation_id = ? AND end_msg_id > 0 AND checkpoint_version = 1
      ORDER BY end_msg_id DESC, id DESC LIMIT 1
    `).get(conversationId);
    return Number(row?.end_msg_id) || 0;
  } catch {
    return 0;
  }
}

/**
 * 把群侧的**遗忘时间区间**换算成 raw id 区间，喂给 fetchRecentAssistantTurns 的 excludeWindows
 * （那个接口只认 raw id，不认时间）。算不出来就不过滤：反重复是增强项，读失败不能拖垮群聊。
 */
function resolveForgottenRawWindows(db, conversationId, timeRanges) {
  const ranges = Array.isArray(timeRanges) ? timeRanges : [];
  if (ranges.length === 0) return [];
  const windows = [];
  for (const range of ranges) {
    const from = String(range?.fromAt || '').trim();
    const to = String(range?.toAt || '').trim();
    if (!to) continue;
    try {
      const row = from
        ? db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM raw_messages
            WHERE conversation_id = ? AND role IN ('user','assistant') AND created_at >= ? AND created_at <= ?`).get(conversationId, from, to)
        : db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM raw_messages
            WHERE conversation_id = ? AND role IN ('user','assistant') AND created_at <= ?`).get(conversationId, to);
      if (row?.lo && row?.hi) windows.push({ fromRawId: Number(row.lo), toRawId: Number(row.hi) });
    } catch {
      /* 单条区间读失败就跳过它 */
    }
  }
  return windows;
}

/**
 * 群聊轮的反重复取数 + 判定（接线入口）。
 *
 * 开关（**复用既有键，不新增**）：
 *   · features.antiRepetition === false → 早退：零查询、零块，与加功能前逐字节一致；
 *   · features.antiRepetitionLock === false → 不注入 <topic_progress>（该键的语义就是"钻牛角尖"）；
 *   · features.antiRepetitionEscalation → 透传升级开关（关掉 = 完全按基础阈值判定）。
 *
 * ⚠️ **群聊侧不做情绪判定**（P1 / task-27，方案 B）：`emotion_snapshots` 的写入点全在 `char_<id>` 会话，
 * 全仓没有任何代码给 `group_<gid>` 写快照 ⇒ 喂进 detectTopicLock 必然恒为 0 行、`<topic_progress>` 永不触发
 * （三天内第三次同款"检测器输入在真实存储里不存在"）。所以群聊改用 `textOnlyTopicLock`：
 * **纯文本 ≥ TOPIC_LOCK_MIN_TEXT_ONLY_TURNS(6) 轮同话题**即注入，比私聊的 4 轮保守（说话的持续性 ≠ 钻牛角尖）。
 * 这里仍会查一次快照用于**日志对照**，但不参与判定。
 */
export function collectGroupAntiRepetitionBlock(group, { sinceRawId = 0 } = {}) {
  const skipped = { enabled: false, block: null, result: null, turns: [], emotionSnapshots: [] };
  if (config.features.antiRepetition === false) return skipped;
  const groupId = Number(group?.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return skipped;
  const db = getDb();
  const conversationId = groupConvId(groupId);
  try {
    const from = sinceRawId > 0 ? sinceRawId : groupSummaryCheckpointEndId(db, conversationId);
    const turns = fetchRecentAssistantTurns(db, conversationId, {
      limit: GROUP_ANTI_REPETITION_TURNS,
      sinceRawId: from,
      excludeWindows: resolveForgottenRawWindows(db, conversationId, resolveTranscriptExcludeRanges(group?.members || [])),
    });
    // 群会话的快照事实上恒为 0 行（没有写入点）；这里查一次只为日志对照，不参与判定。
    const emotionSnapshots = config.features.emotion
      ? fetchRecentEmotionSnapshots(db, conversationId, { limit: 6 })
      : [];
    const built = buildGroupAntiRepetitionBlock({
      turns,
      emotionSnapshots,
      hypnosisActive: isWholeGroupHypnotized(group?.members || []),
      escalationEnabled: config.features.antiRepetitionEscalation !== false,
      // <topic_progress> 在群聊由 antiRepetitionLock 这个既有键控制（不做情绪判定）
      textOnly: true,
      enabled: config.features.antiRepetitionLock !== false,
    });
    // 与私聊同一行格式（可 grep [anti-repetition]），前缀 [group] 以区分群聊轮
    console.log('[group] ' + formatAntiRepetitionLog({ result: built.result, turns, emotionSnapshots }));
    return { ...built, turns, emotionSnapshots };
  } catch (err) {
    // 反重复是增强项：任何异常都退回不注入，绝不影响群聊主流程
    console.warn('[anti-repetition] group detection failed:', err.message);
    return skipped;
// resolveTranscriptExcludeRanges：定义已搬到 groupTranscriptExcludes.js（§5.1「0.5 刀」共享模块）
  }
}
