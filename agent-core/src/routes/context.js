/**
 * 上下文面板接口
 *
 *   GET  /api/context/usage     最近一次请求的用量 / 余量 / 分项（面板）
 *   POST /api/context/compress  手动触发上下文压缩（滚动摘要 + 记忆整理）
 *
 * 设计与边界：
 *   - usage 永不 500：找不到会话 / 还没发过请求都返回 200 空态（source='none'）；
 *     重启后从持久化快照读回来的那一次用量 source='snapshot'（不是"最近一次请求"）。
 *   - 窗口还停在 default 时，usage 与 compress 都会**惰性探测一次**上游 /v1/models
 *     （1.8s 短超时，失败回落 default，成功缓存并把来源升为 provider），
 *     见 services/contextUsage.js 的 ensureActiveContextWindow；接口最坏慢约 2s。
 *   - compress 复用既有压缩链路（summarizer.maybeSummarize + memoryExtractor.curateChatMemories），
 *     不新写摘要算法；同一会话并发压缩返回 409；总开关关闭或没有可压缩内容时返回 200 且 summaryCreated:false。
 *   - 摘要本身可能要几十秒，HTTP 最多等 COMPRESS_HTTP_BUDGET_MS：超时就把剩余的活放后台继续跑，
 *     如实返回"已开始压缩"，此时 summaryCreated 只能是 null（还不知道结果，不假装成功）。
 */
import { Router } from 'express';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { maybeSummarize, SUMMARIZE_INTERVAL } from '../services/summarizer.js';
import { curateChatMemories, CURATE_EVERY_N_MESSAGES } from '../services/memoryExtractor.js';
import { getGroupSummaryInterval } from '../services/groupChatEngine.js';
import { GROUP_LOG_LABEL } from '../services/chatLogPrompt.js';
import {
  buildUsagePayload,
  getContextUsageSnapshot,
  snapshotUsage,
  conversationExists,
  hasCompressibleContext,
  isContextCompressionEnabled,
  ensureActiveContextWindow,
} from '../services/contextUsage.js';

const router = Router();

/** 同一会话同时只允许一次压缩（重复点击 → 409） */
const compressing = new Set();

/** HTTP 等待预算：超过就改成 fire-and-forget（摘要可能很慢，绝不把请求挂死）。
 *  可用 CONTEXT_COMPRESS_HTTP_BUDGET_MS 覆盖——测试靠它把 8s 压到几十毫秒，
 *  否则"超时转后台"这条分支得真等 8 秒才跑得到。 */
export const COMPRESS_HTTP_BUDGET_MS = (() => {
  const parsed = Number.parseInt(process.env.CONTEXT_COMPRESS_HTTP_BUDGET_MS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();

function isGroupConversationId(conversationId) {
  return /^group_\d+$/.test(String(conversationId || ''));
}

function characterIdOf(conversationId) {
  const match = String(conversationId || '').match(/^char_(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** 会话的展示名（只用于摘要/整理的记录块标签，取不到就用引擎默认值） */
function conversationLabels(db, conversationId) {
  const userName = config.user.nickname || '用户';
  if (isGroupConversationId(conversationId)) {
    return { characterName: GROUP_LOG_LABEL, userName };
  }
  const characterId = characterIdOf(conversationId);
  const row = characterId === null
    ? null
    : db.prepare(`SELECT display_name FROM characters WHERE id = ?`).get(characterId);
  return { characterName: row?.display_name || 'assistant', userName };
}

/** 该会话最后一条 assistant raw 的 id（记忆整理的 throughRawMsgId） */
function lastAssistantRawId(db, conversationId) {
  const row = db.prepare(`
    SELECT MAX(id) AS id FROM raw_messages
    WHERE conversation_id = ? AND role = 'assistant' AND content != ''
  `).get(conversationId);
  return row?.id || 0;
}

/**
 * 跑一次完整压缩：滚动摘要（可能要 LLM 生成）+ 记忆整理。
 * 两步都复用既有链路，各自内部已有阈值判断与失败兜底，这里只负责串起来并回报结果。
 */
async function runCompression({ conversationId }) {
  const db = getDb();
  const isGroup = isGroupConversationId(conversationId);
  const { characterName, userName } = conversationLabels(db, conversationId);

  const summary = isGroup
    ? await maybeSummarize(conversationId, {
      characterName,
      userName,
      triggerRole: 'assistant',
      interval: getGroupSummaryInterval(),
    })
    : await maybeSummarize(conversationId, { characterName, userName });

  let memoryCurated = false;
  if (config.features.memory !== false) {
    const throughRawMsgId = lastAssistantRawId(db, conversationId);
    if (throughRawMsgId > 0) {
      const saved = await curateChatMemories({ conversationId, throughRawMsgId, characterName, userName });
      memoryCurated = Array.isArray(saved) && saved.length > 0;
    }
  }

  return { summaryCreated: Boolean(summary), memoryCurated };
}

// GET /api/context/usage — 当前上下文窗口的用量、余量与最近一次请求的分项
//
// 窗口还停在 default（真机上游报 1000000 却只显示 128000）时惰性探测一次上游
// （见 ensureActiveContextWindow：1.8s 短超时，成功进进程内缓存、来源升为 provider，
// 失败如实回落 default）；探测本身从不抛错，所以接口该 200 还是 200。
// 快照：本进程内存优先，重启后从库里读回上一次用量（source='snapshot'）。
router.get('/usage', async (req, res) => {
  const conversationId = String(req.query?.conversationId || '').trim();
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  const db = getDb();
  // 找不到会话 → 一律空态（不 500、也不回上一次的残留数据）
  const snapshot = conversationExists(db, conversationId)
    ? getContextUsageSnapshot(conversationId)
    : null;
  const windowInfo = await ensureActiveContextWindow();

  res.json(buildUsagePayload({
    conversationId,
    snapshot,
    contextWindow: windowInfo.contextWindow,
    contextWindowSource: windowInfo.contextWindowSource,
  }));
});

// POST /api/context/compress — 手动触发上下文压缩
router.post('/compress', async (req, res) => {
  const conversationId = String(req.body?.conversationId || '').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId is required' });
  }

  const db = getDb();
  const before = { usedTokens: snapshotUsage(getContextUsageSnapshot(conversationId)).usedTokens };
  // 返回里也带上当前窗口（与 GET /usage 同一套惰性探测口径，成功才会是 provider）。
  // 探测结果 memo 一次：同一个请求里多条返回路径复用，不重复探测。
  let windowProbe = null;
  const windowFields = () => (windowProbe ??= ensureActiveContextWindow());
  // after 恒为 null：摘要/整理是异步生效的，下一轮组装才会真正变小，不假装立刻见效
  const reply = async (payload) => {
    const windowInfo = await windowFields();
    return res.json({
      ok: true,
      conversationId,
      after: null,
      before,
      contextWindow: windowInfo.contextWindow,
      contextWindowSource: windowInfo.contextWindowSource,
      ...payload,
    });
  };

  if (compressing.has(conversationId)) {
    return res.status(409).json({ error: 'compression in progress' });
  }
  if (!isContextCompressionEnabled()) {
    return reply({ summaryCreated: false, message: '上下文压缩总开关已关闭（记忆功能关闭），未执行压缩' });
  }
  if (!conversationExists(db, conversationId)) {
    return reply({ summaryCreated: false, message: '找不到该会话，没有可压缩的内容' });
  }

  const summaryInterval = isGroupConversationId(conversationId)
    ? getGroupSummaryInterval()
    : SUMMARIZE_INTERVAL;
  if (!hasCompressibleContext(db, conversationId, {
    summaryInterval,
    triggerRole: 'assistant',
    memoryMinMessages: CURATE_EVERY_N_MESSAGES,
  })) {
    return reply({ summaryCreated: false, message: '当前没有可压缩的内容（摘要与记忆都还没攒够一轮）' });
  }

  if (reason) console.log(`[context] compress requested for ${conversationId} (${reason})`);

  compressing.add(conversationId);
  // 失败不抛出：压缩失败不该影响 HTTP 返回，但要如实说明
  const work = runCompression({ conversationId })
    .catch(error => {
      console.error(`[context] compression failed for ${conversationId}:`, error.message);
      return { summaryCreated: false, memoryCurated: false, error: error.message };
    });
  // 在途标记必须跟着"活干完"释放：超时返回后后台还在跑，此时再点仍应是 409
  const release = () => compressing.delete(conversationId);
  work.then(release, release);

  let timer = null;
  const raced = await Promise.race([
    work.then(value => ({ done: true, value })),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ done: false }), COMPRESS_HTTP_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!raced.done) {
    return reply({ summaryCreated: null, message: '已开始压缩（后台继续执行，下一轮生效）' });
  }
  const result = raced.value;
  if (result.error) {
    return reply({ summaryCreated: false, message: `压缩失败：${result.error}` });
  }
  if (result.summaryCreated) {
    return reply({ summaryCreated: true, message: '已触发上下文压缩（滚动摘要已生成，下一轮生效）' });
  }
  if (result.memoryCurated) {
    return reply({ summaryCreated: false, message: '已整理记忆与档案（滚动摘要暂无可推进的内容）' });
  }
  return reply({ summaryCreated: false, message: '当前没有可压缩的内容' });
});

export default router;
