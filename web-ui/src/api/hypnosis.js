/**
 * 催眠手机接口封装（**只负责请求与错误翻译**）。
 *
 * 独立维护一个请求基元（与 src/api/intimate.js 同口径），不改公共 api 模块。
 * 面板的判定口径（时长 clamp / 剩余时间 / 状态视图 / 按钮矩阵 / 门控文案 / 遗忘记录 / 恢复文案）
 * 在 `components/hypnosisLogic.js`，不要在本文件里再长规则。
 *
 * 契约（后端 task-28 实现）：
 *   GET    /api/characters/:id/hypnosis                          状态
 *   POST   /api/characters/:id/hypnosis/hypnotize   { minutes }  1~720
 *   POST   /api/characters/:id/hypnosis/wake        { mode }     'full' | 'mind'
 *   POST   /api/characters/:id/hypnosis/command     { kind }     'body_control' | 'forced_climax'
 *   POST   /api/characters/:id/hypnosis/forget                   遗忘被控制这段时间
 *   GET    /api/characters/:id/hypnosis/forgotten                遗忘记录
 *   POST   /api/characters/:id/hypnosis/forgotten/:wid/restore   让她恢复这段记忆
 *   POST   /api/hypnosis/phone/grant                             背包直接领取手机（幂等）
 * 错误：400 非法 id / 404 角色不存在 / 403 hypnosis gate not met / 409 not hypnotized
 *
 * 睡眠控制（**不属于催眠指令**，面板上是独立一区；由睡眠/日程那一侧的同事实现）：
 *   POST   /api/characters/:id/hypnosis/sleep                    让她去睡
 *   POST   /api/characters/:id/hypnosis/wake                     把她叫醒
 *   返回形状：{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }
 *   读取侧不额外发明接口：优先用这两个 POST 的返回，其次用既有的 GET /hypnosis 状态里
 *   可能携带的睡眠字段，最后退回角色行上已有的 is_sleeping / sleep_until（状态归一化在
 *   `components/hypnosisLogic.js` 的 resolveSleep / normalizeSleep，api 层只发请求）。
 *
 * ⚠️ 路径撞名提示：`POST .../hypnosis/wake` 同时也是**催眠唤醒**的既有路径（body `{ mode }`）。
 *    这里按交付约定调用（睡眠唤醒**不带 mode**）。若后端最终把睡眠唤修改到别的路径，
 *    只需改本文件的两个函数，面板与纯逻辑无需改动。
 */

const BASE = '/api'

/** 后端错误 → 可读中文（不把内部英文串抛给用户） */
export function translateHypnosisError(status, message) {
  const text = String(message == null ? '' : message)
  if (/hypnosis gate not met/i.test(text)) return '还不满足使用催眠手机的条件'
  if (/not hypnotized/i.test(text)) return '她当前不在催眠状态'
  if (/hypnosis .*disabled|feature disabled/i.test(text)) return '催眠手机功能当前已关闭'
  if (/character not found|invalid character id/i.test(text)) return '角色不存在或已被删除'
  if (/invalid minutes|invalid mode|invalid kind|invalid argument/i.test(text)) return '参数不合法'
  // 睡眠控制（独立于催眠指令）的专属错误：把后端的英文码翻成人话
  if (/already sleeping/i.test(text)) return '她已经在睡了'
  if (/not sleeping/i.test(text)) return '她现在是醒着的'
  if (/cannot sleep|sleep .*(disabled|not allowed)/i.test(text)) return '她现在不能睡（可能在日程中）'
  if (/phone not found|no hypnosis phone/i.test(text)) return '还没有领取催眠手机'
  if (text) return text
  if (status === 403) return '还不满足使用催眠手机的条件'
  if (status === 409) return '她当前不在催眠状态'
  if (status === 404) return '角色不存在或已被删除'
  return status ? `请求失败 (${status})` : '请求失败'
}

// 统一请求基元：非 2xx 抛可读错误，成功返回解析后的 JSON
async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(translateHypnosisError(res.status, result.error || result.message))
  return result
}

function charPath(characterId) {
  return `/characters/${encodeURIComponent(characterId)}/hypnosis`
}

/** 状态：{ characterId, bodyControlled, mindAwake, active, activeUntil, startedAt, pendingDirective, commandCount, lastCommand, gate } */
export function getHypnosisState(characterId, { signal } = {}) {
  return request(charPath(characterId), { signal })
}

/** 催眠 minutes 分钟（1~720，后端会再校一次） */
export function hypnotizeCharacter(characterId, minutes) {
  return request(`${charPath(characterId)}/hypnotize`, { method: 'POST', body: { minutes } })
}

/** 唤醒：mode='full' 完全唤醒；mode='mind' 只唤醒意志（身体仍受控） */
export function wakeCharacter(characterId, mode = 'full') {
  return request(`${charPath(characterId)}/wake`, { method: 'POST', body: { mode } })
}

/**
 * 下达指令：kind = 'body_control' | 'forced_climax' | 'force_toy'
 * `force_toy` 需要 `extra = { toyKey, intensity }` —— 2026-10-01 新增（用户原话「催眠状态也不能强制
 * 让角色用上玩具」）：服务端**当场真的把玩具戴上**，再写一次性指令，并立刻替她触发一轮反应。
 */
export function commandCharacter(characterId, kind, extra = {}) {
  return request(`${charPath(characterId)}/command`, { method: 'POST', body: { kind, ...extra } })
}

/** 遗忘「被控制这段时间」：后端把区间内长期记忆归档，返回 { windowId, fromRawId, toRawId, archived } */
export function forgetControlledWindow(characterId) {
  return request(`${charPath(characterId)}/forget`, { method: 'POST', body: {} })
}

/** 遗忘记录：[{ id, fromRawId, toRawId, fromAt, toAt, memoriesArchived, status, createdAt }]
 *  默认显式带 ?status=（空串 = 后端不过滤，active + restored 都返回，面板要显示「已恢复」的置灰行）。
 *  注意：不带 query 时后端默认只回 active——恢复后的记录会从面板消失。 */
export function listForgottenWindows(characterId, { status = '', signal } = {}) {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : '?status=';
  return request(`${charPath(characterId)}/forgotten${suffix}`, { signal })
}

/** 撤销某条遗忘（恢复归档的记忆） */
export function restoreForgottenWindow(characterId, windowId) {
  return request(`${charPath(characterId)}/forgotten/${encodeURIComponent(windowId)}/restore`, { method: 'POST', body: {} })
}

/**
 * 发情模式（2026-10-02 用户原话「再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」）。
 * 与催眠状态无关 ⇒ 挂 `/:id/heat`，不挂 `/:id/hypnosis/*`（不吃催眠门控）。
 *   GET  → { characterId, heat, value, tier, tierLabel }
 *   POST → { characterId, heat, value, ... }；`on=false` 关掉后回落到常态上沿。
 */
export function getHeatMode(characterId, { signal } = {}) {
  return request(`/characters/${encodeURIComponent(characterId)}/heat`, { signal })
}

/** 开关发情模式；`minutes` 省略＝后端默认时长（到点自然回落） */
export function setHeatMode(characterId, on, minutes) {
  const body = minutes ? { on, minutes } : { on }
  return request(`/characters/${encodeURIComponent(characterId)}/heat`, { method: 'POST', body })
}

/** 领取催眠手机（幂等；不需要角色 id） */
export function grantHypnosisPhone() {
  return request('/hypnosis/phone/grant', { method: 'POST', body: {} })
}

// ── 睡眠控制（**独立于催眠指令**：这是"她睡没睡"，不是"对她下指令"）──
//
// 返回 { characterId, isSleeping, sleepUntil, temporaryWakeUntil }。
// 形状归一化不在这里做：面板用 hypnosisLogic.resolveSleep / sleepViewModel 处理
// （后端可能给 camelCase / snake_case，也可能把这两个字段挂在 GET /hypnosis 的状态里）。

/** 让她去睡（不带参数：睡到日程规定的起床时间） */
export function sleepCharacter(characterId) {
  return request(`${charPath(characterId)}/sleep`, { method: 'POST', body: {} })
}

/**
 * 把她叫醒（**不带 mode**）。
 * 注意：这个路径与催眠唤醒 (`wakeCharacter(id, 'full'|'mind')`) 同名；
 * 这里刻意不带 body 里的 mode，语义是"从睡眠里醒来"，不是"解除催眠"。
 */
export function wakeFromSleepCharacter(characterId) {
  return request(`${charPath(characterId)}/wake`, { method: 'POST', body: {} })
}

