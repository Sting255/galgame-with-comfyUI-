/**
 * 统一 SSE 连接管理器
 *
 * 替代 3 个独立 SSE 长连接（events / moments / notifications），
 * 复用单一 HTTP 连接接收所有事件。Store 通过 onEvent/offEvent 订阅。
 *
 * 重连策略：断开后立即重连，指数退避 1s→2s→4s→8s→16s→30s(max)，
 * 成功连接后重置退避。关闭期间丢失的事件由各 store 的 30s poll timer 兜底。
 *
 * 使用方式：
 *   import { onEvent, startUnifiedStream, stopUnifiedStream } from './unifiedStream.js'
 *   onEvent('new_event', (data) => { ... })
 *   // NavBar onMounted: startUnifiedStream()
 *   // NavBar onUnmounted: stopUnifiedStream()
 */

import * as api from '../api/index.js'

const BACKOFF_INITIAL = 1000   // 首次重连等待 1s
const BACKOFF_MAX = 30000      // 最大退避 30s
const BACKOFF_MULTIPLIER = 2

let _conn = null
let _reconnectTimer = null
let _stableTimer = null
let _started = false
let _connected = false
export const isUnifiedStreamConnected = () => _connected
let _backoff = BACKOFF_INITIAL

/** Map<eventType, Set<handler>> */
const _handlers = new Map()

/**
 * 订阅特定 SSE 事件类型
 * @param {string} eventType - 如 'new_event', 'event_update', 'new_post', 'proactive_message'
 * @param {Function} handler - (data) => void
 * @returns {Function} 取消订阅函数
 */
export function onEvent(eventType, handler) {
  if (!_handlers.has(eventType)) _handlers.set(eventType, new Set())
  _handlers.get(eventType).add(handler)
  return () => {
    const set = _handlers.get(eventType)
    if (set) set.delete(handler)
  }
}

/** @deprecated 别名，向后兼容 */
export const offEvent = (eventType, handler) => {
  const set = _handlers.get(eventType)
  if (set) set.delete(handler)
}

function _dispatch(eventType, data) {
  if (eventType === 'connected') _connected = true
  const handlers = _handlers.get(eventType)
  if (handlers) {
    for (const fn of handlers) {
      try { fn(data) } catch (e) { console.warn('[unifiedSSE] handler error:', eventType, e) }
    }
  }
}

/** 创建 SSE 连接并注册 onClose 回调。
 *  收到 'connected' 事件后启动 15s 稳定计时器，到时重置退避。*/
function _connect() {
  if (_conn && !_conn._closed) _conn.close()

  _conn = api.connectUnifiedStream({
    connected:         () => { _dispatch('connected', {}); _stableTimer = setTimeout(_onStable, 15000) },
    // 断线是**连接生命周期事件**（由本文件 onClose 内部 `_dispatch('disconnected')` 发出，
    // 不是服务端 SSE 事件名）。2026-10-04 合并上游 v3.6.3 时补进白名单：
    // 上游新增的 `components/standing/StandingInteractionControls.vue` 订阅了它，
    // 而本地守卫 `test/timeControlSseWhitelist.test.js` 要求「有订阅就必须在白名单里」。
    // 服务端不会发这个名字，所以这一行实际不会触发；它只是让静态守卫能对上账。
    disconnected:      d => _dispatch('disconnected', d),
    // 批量装卸玩具（2026-10-04）：后端 `POST /:id/toys/batch` 是**静默操作**（不逐件产反应消息），
    // 所以它只能靠这条广播把"穿戴清单变了"告诉别的窗口/设备（PC 与手机同时开着时）。
    // 订阅方：`components/ToyPanel.vue`（收到就重取清单）。
    toys_batch_changed: d => _dispatch('toys_batch_changed', d),
    standing_display_state: d => _dispatch('standing_display_state', d),
    expression_standings_updated: d => _dispatch('expression_standings_updated', d),
    new_event:         d => _dispatch('new_event', d),
    event_update:      d => _dispatch('event_update', d),
    event_concluded:   d => _dispatch('event_concluded', d),
    event_expired:     d => _dispatch('event_expired', d),
    event_urgency:     d => _dispatch('event_urgency', d),
    new_post:          d => _dispatch('new_post', d),
    new_comment:       d => _dispatch('new_comment', d),
    user_moment_vision_error: d => _dispatch('user_moment_vision_error', d),
    proactive_message: d => _dispatch('proactive_message', d),
  // 私聊两段式（专题 §八 8.2）：文字先上屏，图好了再补 —— 后端 payload { msg_id, raw_id, images }
  proactive_message_update: d => _dispatch('proactive_message_update', d),
    reply_processing:  d => _dispatch('reply_processing', d),
    reply_ready:       d => _dispatch('reply_ready', d),
    delayed_reply:     d => _dispatch('delayed_reply', d),
    // 世界翻篇（程序日期变了）：后端 programDayRollover 广播，newspaper store 收到立刻拉新一期；
    // 2026-10-02 补进白名单 —— 此前广播发得出来、这里没放行 ⇒ 订阅方永远收不到（死订阅）。
    program_day_rollover: d => _dispatch('program_day_rollover', d),
    schedule_peek_ready: d => _dispatch('schedule_peek_ready', d),
    schedule_peek_progress: d => _dispatch('schedule_peek_progress', d),
    schedule_reset_progress: d => _dispatch('schedule_reset_progress', d),
    schedule_state_change: d => _dispatch('schedule_state_change', d),
    schedule_changed: d => _dispatch('schedule_changed', d),
    image_compress_progress: d => _dispatch('image_compress_progress', d),
    group_message:     d => _dispatch('group_message', d),
    group_message_update: d => _dispatch('group_message_update', d),
    // 亲密刺激下游（累积/心情/敏感度）：后端 intimateStimulus.js 一直在广播，
    // **这里漏了**⇒ 推进面板的"实时更新"从来没生效过（2026-10-03 复查抓到的死广播：
    // 自动插入开着、面板看别处时，库里在涨而界面一动不动）。推进面板已订阅它刷新 HUD。
    intimate_stimulus: d => _dispatch('intimate_stimulus', d),
    group_created:     d => _dispatch('group_created', d),
    // 群聊「撤回一轮」：groups.js 有订阅，2026-10-02 补进白名单（同 program_day_rollover，原先收不到）
    group_round_undone: d => _dispatch('group_round_undone', d),
    group_image_start: d => _dispatch('group_image_start', d),
    group_image_done:  d => _dispatch('group_image_done', d),
    group_image_error: d => _dispatch('group_image_error', d),
    image_edit_task_start:    d => _dispatch('image_edit_task_start', d),
    image_edit_task_progress: d => _dispatch('image_edit_task_progress', d),
    image_edit_task_done:     d => _dispatch('image_edit_task_done', d),
    image_edit_task_error:    d => _dispatch('image_edit_task_error', d),
    // 角色资产「一键后台生成」进度：AssetGenerationModal 有订阅，2026-10-02 补进白名单
    // （它另有 2.5s 轮询兜底，所以这条死订阅一直没被用户发现）
    asset_generation_progress: d => _dispatch('asset_generation_progress', d),
    // AI 小镇（世界页）
    town_move:            d => _dispatch('town_move', d),
    town_bubble:          d => _dispatch('town_bubble', d),
    town_encounter_start: d => _dispatch('town_encounter_start', d),
    town_encounter_end:   d => _dispatch('town_encounter_end', d),
    town_ping:            d => _dispatch('town_ping', d),
    town_state_updated:   d => _dispatch('town_state_updated', d),
    town_init_progress:   d => _dispatch('town_init_progress', d),
    town_map_updated:     d => _dispatch('town_map_updated', d),
    // 玩家换图（出行）：player 级事件，不受地图过滤，是别的标签页/设备出行时本端换场的入口
    town_player_map_changed: d => _dispatch('town_player_map_changed', d),
    town_assets_updated:  d => _dispatch('town_assets_updated', d),
    // 小镇 NPC 服务 / 打工（图片叙事）与货架换货
    town_npc_service_ready:    d => _dispatch('town_npc_service_ready', d),
    town_npc_service_progress: d => _dispatch('town_npc_service_progress', d),
    town_npc_stock_ready:      d => _dispatch('town_npc_stock_ready', d),
    town_npc_stock_rolled:     d => _dispatch('town_npc_stock_rolled', d),
    town_npc_stock_progress:   d => _dispatch('town_npc_stock_progress', d),
    // 小镇货摊买来的道具送给角色：礼物叙事（图片 + 描述）
    item_gift_ready:           d => _dispatch('item_gift_ready', d),
    item_gift_progress:        d => _dispatch('item_gift_progress', d),
    // 宝箱 / 道具出图完成：backpack store 有订阅，2026-10-02 补进白名单
    item_ready:                d => _dispatch('item_ready', d),
  }, {
    onClose: _scheduleReconnect,
  })
}

/** 连接持续稳定 15s → 重置退避时间 */
function _onStable() {
  _backoff = BACKOFF_INITIAL
}

/** 断开后立即调度重连（指数退避 1s→2s→4s→...→30s） */
function _scheduleReconnect() {
  _connected = false
  if (!_started) return
  _dispatch('disconnected', {})
  if (_reconnectTimer) clearTimeout(_reconnectTimer)
  if (_stableTimer) { clearTimeout(_stableTimer); _stableTimer = null }

  console.log(`[unifiedSSE] disconnected, reconnecting in ${(_backoff / 1000).toFixed(0)}s...`)
  _reconnectTimer = setTimeout(() => {
    if (!_started) return
    _connect()
  }, _backoff)

  _backoff = Math.min(_backoff * BACKOFF_MULTIPLIER, BACKOFF_MAX)
}

/** 启动统一 SSE 连接（NavBar onMounted 调用一次） */
export function startUnifiedStream() {
  if (_started) return
  _started = true
  _backoff = BACKOFF_INITIAL
  _connect()
}

/** 停止统一 SSE 连接（NavBar onUnmounted 调用） */
export function stopUnifiedStream() {
  _connected = false
  _started = false
  _backoff = BACKOFF_INITIAL
  if (_conn) { _conn.close(); _conn = null }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_stableTimer) { clearTimeout(_stableTimer); _stableTimer = null }
}
