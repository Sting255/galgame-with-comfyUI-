/**
 * groupConversationId.js —— 群聊会话 id + 消息序列化（§5.1「0.5 刀」纯搬家，2026-09-30）
 *
 * **为什么要独立成最小模块**：第 3 刀（groupImagePipeline.js）与第 4 刀（groupAntiRepetition.js）
 * 都要用 `groupConvId`；让它住在任一业务模块里，都会逼另一个反向依赖"别人的业务模块"。
 * 抽成 0 依赖的最小共享块后，依赖方向是 业务模块 → 本模块（无环）。
 *
 * 对外面不变：`groupConvId` 原本就从 groupChatEngine 导出，引擎继续 re-export（routes/groups.js 等照旧）；
 * `serializeMsg` 原本是引擎私有，现在引擎从本模块 import。
 */

export function groupConvId(groupId) { return `group_${groupId}`; }

export function serializeMsg(rec, groupId) {
  return {
    id: rec.id,
    group_id: groupId,
    role: 'assistant',
    content: rec.content,
    ...(rec.images && rec.images.length > 0 ? { images: rec.images } : {}),
    seq: rec.seq,
    speaker_character_id: rec.speaker_character_id,
    speaker_name: rec.speaker_name,
    created_at: new Date().toISOString(),
  };
}
