/**
 * D2 重写兜底的**替换语义**（docs/anti-repetition.md §12.4，形状已冻结）。
 *
 * 后端事件：`replace_last_assistant{ content, segments:[{content, emojiKeys, images}], reason:'reroll', turn }`
 * 语义：把**刚显示的那轮** assistant 气泡整段换成新内容 —— **复用既有气泡（不追加）**、
 * **末尾多出来的删掉（旧文本不残留）**，并且**不能丢表情包与图片**。
 *
 * 抽成纯函数（只吃数组、只改传进来的这两个数组）是为了能 `node --test` 直接覆盖：
 * 它原本内联在那个巨大的流式 onEvent 闭包里，行为无法单测。
 *
 * 已知边界（emojiKeys 是 **key 不是 url**）：
 *   · emojiKeys === []（显式「这轮没表情」）→ 清掉 sticker_images；
 *   · emojiKeys 非空 → 前端只有 key、没有 key→url 的映射，**保留原有 sticker_images**
 *     （宁可不换，也不丢表情）；后端若后续直接下发 url，这里改成覆盖即可。
 *   · emojiKeys 字段缺失 → 完全不动表情。
 *
 * @returns {{messages:Array, bubbleIds:Array}} 原对象（就地改），方便链式核对
 */
/** url 数组 → 消息上的图片项（与既有 sticker_images / images 完全同形） */
function toImageList(urls) {
  return (Array.isArray(urls) ? urls : []).map(url => ({ url, base64: null }))
}

export function applyAssistantReplace({ messages, bubbleIds, segments, uid, now } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const ids = Array.isArray(bubbleIds) ? bubbleIds : []
  const segs = Array.isArray(segments) ? segments : []
  const stamp = now || new Date().toISOString()
  const makeId = typeof uid === 'function' ? uid : () => 'seg-' + Math.random().toString(36).slice(2)

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i] && typeof segs[i] === 'object' ? segs[i] : {}
    const content = seg.content === undefined || seg.content === null ? '' : String(seg.content)
    let m = ids[i] ? list.find(x => x.id === ids[i]) : null
    if (!m) {
      const id = ids[i] || makeId()
      ids[i] = id
      m = { id, role: 'assistant', type: 'text', content, created_at: stamp }
      list.push(m)
    } else {
      m.content = content
    }
    // 图片：给了非空 urls 才换；没给 / 空数组 → **保持原样**（不丢）
    if (Array.isArray(seg.images) && seg.images.length > 0) {
      m.images = toImageList(seg.images)
    }
    // 表情包：**优先级 = 有 stickerUrls 用 url；没 url 才退回 emojiKeys 的兜底规则**
    // 契约（docs/anti-repetition.md §12.4，Lead 定名）：segments[i].stickerUrls = url 字符串数组，
    // 与 sticker_images 同源 ⇒ 用与 images 同一套映射覆盖；**缺失 / 空数组一律保持原样**（向后兼容）。
    let stickerFromUrls = false
    if (Array.isArray(seg.stickerUrls) && seg.stickerUrls.length > 0) {
      m.sticker_images = toImageList(seg.stickerUrls)
      stickerFromUrls = true
    }
    // 兜底（旧后端 / 契约未更新）：emojiKeys 是 **key 不是 url**，前端换不出 url ⇒
    // 空数组＝显式「这轮没表情」（清掉）；非空＝保留原有 sticker_images（宁可不换，也不丢表情）。
    if (!stickerFromUrls && Array.isArray(seg.emojiKeys)) {
      if (seg.emojiKeys.length === 0) m.sticker_images = []
    }
  }

  // 末尾多出来的气泡删掉 —— 这一段就是「旧文本不残留」的保证
  for (let i = ids.length - 1; i >= segs.length; i -= 1) {
    const dead = ids[i]
    const at = list.findIndex(x => x.id === dead)
    if (at >= 0) list.splice(at, 1)
  }
  ids.length = segs.length
  return { messages: list, bubbleIds: ids }
}
