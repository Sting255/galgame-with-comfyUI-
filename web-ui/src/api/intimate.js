/**
 * 亲密看板接口封装。
 *
 * 独立维护一个请求基元（与 src/api/index.js 的 request 同口径），
 * 不修改公共 api 模块：看板是自包含功能，接口契约与生命周期都由本文件收口。
 *
 * 契约（后端 task-1 / task-2 / task-4 实现）：
 *   GET    /api/characters/:id/intimate                    看板数据
 *   PUT    /api/characters/:id/intimate/profile             身体档案
 *   PUT    /api/characters/:id/intimate/inject              注入开关
 *   PUT    /api/characters/:id/intimate/settings            面板设置（AI 权限 / 口径 / 回填开关）
 *   GET    /api/characters/:id/intimate/vocabulary          行为与体位词表
 *   GET    /api/characters/:id/intimate/log                 流水明细
 *   POST   /api/characters/:id/intimate/log                 人工补录
 *   PUT    /api/characters/:id/intimate/firsts/:actKey      人工里程碑
 *   DELETE /api/characters/:id/intimate/log/:logId          删除单条流水
 *   POST   /api/characters/:id/intimate/backfill            启动 / 继续回填
 *   GET    /api/characters/:id/intimate/backfill            回填进度
 *   PUT    /api/characters/:id/intimate/ai-judge            默认开启 AI 判断开关（task-32）
 *   POST   /api/characters/:id/intimate/ai-judge/run        手动补判最近若干轮
 *   POST   /api/characters/:id/intimate/ai-edit             AI 整理档案（task-12）
 *   GET    /api/characters/:id/intimate/ai-edit/suggestions 待确认提议
 *   POST   /api/characters/:id/intimate/ai-edit/suggestions/:sid/accept
 *   POST   /api/characters/:id/intimate/ai-edit/suggestions/:sid/reject
 */

const BASE = '/api'

/** 后端错误 → 可读中文（不把 openai SDK / 内部英文原文抛给用户） */
export function translateIntimateError(status, message) {
  const text = String(message == null ? '' : message)
  if (status === 409 || /intimate feature disabled/i.test(text)) return '看板功能当前已关闭'
  if (status === 503 || /llm not configured/i.test(text)) return '尚未配置 LLM，无法整理'
  // 提议可能被另一处（或上一次点击）处理掉，这时后端回 404 英文
  if (/suggestion not found/i.test(text)) return '这条提议已不存在，可能已被处理过'
  if (/invalid character id|character not found/i.test(text)) return '角色不存在或已被删除'
  if (text) return text
  return status ? `请求失败 (${status})` : '请求失败'
}

// 统一请求基元：非 2xx 抛出可读错误，成功返回解析后的 JSON
async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(translateIntimateError(res.status, result.error || result.message))
  }
  return result
}

function charPath(characterId) {
  return `/characters/${encodeURIComponent(characterId)}/intimate`
}

/** 看板一次读取：{ characterId, profile, firsts, stats, counts, backfill? } */
export function getIntimatePanel(characterId, { signal } = {}) {
  return request(charPath(characterId), { signal })
}

/** 身体档案：只传要改的字段，未传字段后端保持原值 */
export function saveIntimateProfile(characterId, patch) {
  return request(`${charPath(characterId)}/profile`, { method: 'PUT', body: patch })
}

/** 注入开关（面板顶部「让 ta 知晓这些信息」） */
export function setIntimateInject(characterId, enabled) {
  return request(`${charPath(characterId)}/inject`, { method: 'PUT', body: { enabled: !!enabled } })
}

/**
 * AI 判断开关（面板设置「默认开启 AI 判断」）
 * 开关本身只是默认值：关闭时不阻断下面手动补判的按钮。
 */
export function setIntimateAiJudge(characterId, enabled) {
  return request(`${charPath(characterId)}/ai-judge`, { method: 'PUT', body: { enabled: !!enabled } })
}

/**
 * 手动补判最近若干轮回复（「AI 判断行为」按钮）。
 * @param {number} [limit] 1~20，缺省由后端取默认值（8）；不传就不带该字段
 * @returns {Promise<{scanned:number, judged:number, recorded:number, skipped:number, superseded:number, errors:string[]}>}
 * 可能抛出：409 看板功能当前已关闭。
 */
export function runIntimateAiJudge(characterId, limit) {
  const body = limit === undefined || limit === null ? {} : { limit: Number(limit) }
  return request(`${charPath(characterId)}/ai-judge/run`, { method: 'POST', body })
}

/** 面板设置：aiEditFields / viewScope / backfillEnabled 任选 */
export function saveIntimateSettings(characterId, patch) {
  return request(`${charPath(characterId)}/settings`, { method: 'PUT', body: patch })
}

/** 行为分类 + 体位词表 */
export function getIntimateVocabulary(characterId, { signal } = {}) {
  return request(`${charPath(characterId)}/vocabulary`, { signal })
}

/**
 * 流水明细
 * @param {string} [partnerKinds] 逗号分隔的口径（user / character / npc），不传空数组
 */
export function listIntimateLogs(characterId, { limit = 50, offset = 0, partnerKinds = '' } = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  if (partnerKinds) params.set('partnerKinds', partnerKinds)
  return request(`${charPath(characterId)}/log?${params.toString()}`)
}

/** 人工补录一条流水 */
export function createIntimateLog(characterId, payload) {
  return request(`${charPath(characterId)}/log`, { method: 'POST', body: payload })
}

/** 人工设定 / 清空某个行为的初次时间（firstAt 传 null 即清空） */
export function setIntimateFirst(characterId, actKey, payload) {
  return request(`${charPath(characterId)}/firsts/${encodeURIComponent(actKey)}`, { method: 'PUT', body: payload })
}

/** 删除单条流水 */
export function deleteIntimateLog(characterId, logId) {
  return request(`${charPath(characterId)}/log/${encodeURIComponent(logId)}`, { method: 'DELETE' })
}

/** 启动 / 继续历史回填，返回最新状态 */
export function startIntimateBackfill(characterId) {
  return request(`${charPath(characterId)}/backfill`, { method: 'POST', body: {} })
}

/** 轮询回填进度：{ status, scanned, inserted, lastRawId } */
export function getIntimateBackfill(characterId, { signal } = {}) {
  return request(`${charPath(characterId)}/backfill`, { signal })
}

/**
 * 让 AI 根据最近的对话整理档案。
 * 已授权的字段直接落库（applied），未授权的返回待确认提议（suggestions）。
 * 素材为空时后端不调 LLM，返回 empty: true。
 * 可能抛出：409 看板功能当前已关闭 / 503 尚未配置 LLM，无法整理。
 */
export function proposeIntimateProfileEdits(characterId) {
  return request(`${charPath(characterId)}/ai-edit`, { method: 'POST', body: {} })
}

/** 待确认提议列表（只取 status='pending' 由前端过滤，后端可能返回全部以利于审计） */
export function listIntimateSuggestions(characterId, { signal } = {}) {
  return request(`${charPath(characterId)}/ai-edit/suggestions`, { signal })
}

/** 采纳一条提议：后端按 field 走与自动应用相同的写入路径 */
export function acceptIntimateSuggestion(characterId, suggestionId) {
  return request(`${charPath(characterId)}/ai-edit/suggestions/${encodeURIComponent(suggestionId)}/accept`, {
    method: 'POST',
    body: {},
  })
}

/** 忽略一条提议（后端保留行以便审计，状态置 rejected） */
export function rejectIntimateSuggestion(characterId, suggestionId) {
  return request(`${charPath(characterId)}/ai-edit/suggestions/${encodeURIComponent(suggestionId)}/reject`, {
    method: 'POST',
    body: {},
  })
}
