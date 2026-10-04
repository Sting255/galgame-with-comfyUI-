/**
 * services/reactionImageUpdate.js —— 「图好了补挂到那条气泡上」的**事件名与载荷口径**（唯一来源）
 *
 * ## 为什么单独抽一个叶子模块
 * 2026-10-03 真机反馈：「在群聊里性爱…光图词 没配图 但是生图又是成功的」。
 * 根因不是出图链，而是**广播事件名发错了**：亲密推进那条链不管什么场景都发 `proactive_message_update`，
 * 而群聊页的消息流只认 `group_message` / `group_message_update`（见 `routes/groups.js` 的 emit 与
 * `web-ui/src/stores/groups.js`）⇒ 图**真的生成成功、也确实写进了 `messages.images`**（刷新/相册能看到），
 * 但群里那句气泡永远收不到"补图"事件。
 *
 * 这个"两套 store 各认一条事件"的口径以前散在三处（touch 私聊 / touch 群聊 / 亲密），必然漂移。
 * 现在收口成本模块：**调用方只传数据，事件名与载荷形状由这里决定**，
 * `routes/touch.js`（触摸反应）与 `routes/intimateActions.js`（推进反应）共用同一份。
 *
 * ⚠️ 载荷里的字段名是**前端 store 的契约**，不是随便起的：
 *   · 私聊 `proactive_message_update`：`{ msg_id, raw_id, images }`（前端按 msg_id 找气泡挂图）
 *   · 群聊 `group_message_update`：`{ ...群消息 payload, group_id, images }` —— 群消息 payload 来自
 *     `groupInsertMessage.writeGroupInsertMessage`（`id / seq / speaker_character_id / …`），
 *     **必须整份带上**，少字段群聊 store 就认不出是哪条气泡。
 *
 * ⚠️ 锚点（2026-10-03 复查发现的不一致）：她的一条反应会被 `writeProactiveMessage` **分句成多条气泡**
 *   （`segments` / `msgIds` / `firstMsgId` / `lastMsgId`），而图片是写进**最后一条**的
 *   `messages.images`（`attachImagesToMessage(lastMsgId)` / `attachToyImagesToMessage(lastMsgId)`）。
 *   这里以前只认 `firstMsgId` ⇒ 直播时图挂在**第一条**气泡后面，刷新一次又跳到**最后一条**（用户看到"图会跑"）。
 *   现在统一锚到 **lastMsgId**（落库口径为准；单段回复时两者本来就是同一个 id）。
 */

/** 私聊补图事件名 */
export const CHAT_IMAGE_UPDATE_EVENT = 'proactive_message_update';
/** 群聊补图事件名（**别和上面混用**：两套 store 各认一条） */
export const GROUP_IMAGE_UPDATE_EVENT = 'group_message_update';

/**
 * 组装"补图"广播。
 *
 * @param {object} input
 * @param {'chat'|'group'|string} input.scene 场景（'group' 走群聊事件，其余走私聊事件）
 * @param {object|null} input.groupPayload `writeGroupInsertMessage` 返回的 `payload`（群聊必传）
 * @param {{firstMsgId?:number, lastMsgId?:number, msgId?:number, rawId?:number}} [input.target] 私聊消息标识
 *   **优先 `lastMsgId`**（图片就挂在那一行；见上方"锚点"说明），缺了才回落到 firstMsgId / msgId
 * @param {string[]} input.images 已经挂进 `messages.images` 的图片 URL
 * @param {number|string} [input.groupId] 群 id（群聊必传）
 * @param {string} [input.reactionText] 兜底 payload 里的正文（群聊 payload 缺失时用）
 * @param {string} [input.source] 兜底 payload 里的来源标记
 * @returns {{event:string, payload:object}|null} `images` 为空 → null（调用方据此不发广播）
 */
export function reactionImageUpdate({
  scene = 'chat', groupPayload = null, target = null, images = [], groupId = null,
  reactionText = '', source = 'reaction',
} = {}) {
  const urls = Array.isArray(images) ? images.filter(Boolean) : [];
  if (urls.length === 0) return null;
  // 锚点：落库写的是最后一条（见模块头"锚点"），直播必须指同一个，否则刷新前后图会在两条气泡之间跳
  const anchorMsgId = Number(target?.lastMsgId ?? target?.firstMsgId ?? target?.msgId) || 0;

  if (scene === 'group') {
    const gid = Number(groupId) || 0;
    // 群消息 payload 缺失时给一份最小可用形状（宁可少字段也不要发错事件名）
    const base = groupPayload && typeof groupPayload === 'object' ? groupPayload : {
      id: anchorMsgId,
      group_id: gid,
      role: 'assistant',
      content: String(reactionText || ''),
      source,
    };
    return { event: GROUP_IMAGE_UPDATE_EVENT, payload: { ...base, group_id: gid || base.group_id || 0, images: urls } };
  }

  return {
    event: CHAT_IMAGE_UPDATE_EVENT,
    payload: {
      msg_id: anchorMsgId,
      raw_id: Number(target?.rawId) || 0,
      images: urls,
    },
  };
}
