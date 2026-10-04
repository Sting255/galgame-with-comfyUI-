/**
 * 程序时间（"现实模拟"时钟）接口封装 —— **只负责请求与错误翻译**。
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…
 * 给我一个按钮 我可以让所有知道角色 过了一天了 或者是很多天…现实模拟游戏」。
 *
 * 约定契约（**以后端同事的实际实现为准**，这里已按他落地的 `agent-core/src/routes/time.js` 对齐）：
 *
 *   GET  /api/schedule/time               → getProgramState()：{ date, time, datetime, stamp, weekday,
 *                                            minuteOfDay, phase: 'day'|'night', dayIndex, totalDays,
 *                                            epochDate, offsetMs, offsetDays, offsetHours, offsetMinutes,
 *                                            real: { date, time, datetime, stamp } }
 *   POST /api/schedule/time/advance { days }        → 同 GET + `applied`（快进 N 天并重算所有角色）
 *   POST /api/schedule/time/set     { datetime }    → 同 GET + `applied`（按**程序世界墙上时间**解释）
 *   POST /api/schedule/time/period  { period, phase, time? } → 同 GET + `applied`（只切白天/黑夜）
 *   POST /api/schedule/time/reset                   → 同 GET + `applied`（回到真实时间，第 1 天重锚今天）
 *
 * ⚠️ 与交付时口述形状的**差异（以他的实现为准，前端已按实际对齐）**：
 *   · 路径前缀是 **`/api/schedule/time*`**，不是 `/api/time*`
 *     （`routes/schedule.js` 里 `router.use('/time', timeRoutes)`；他刻意不动 app.js）；
 *   · 时段字段是 **`phase`**（口述写作 `period`）——前端两个都收，`phase` 优先；
 *   · 切时段的 body `period` / `phase` 他都收（他的注释里写明"前端两个都带"），所以两个都发；
 *   · 多了一个 `POST /reset`（回到真实时间），面板给了对应按钮；
 *   · 总开关 `features.schedule === false` 时全部返回 409 `time control disabled`。
 *
 * datetime 一律发 **`YYYY-MM-DD HH:MM:SS`**（本项目 SQLite 时间戳的既有写法，他的解析正则
 * 同时接受空格与 'T' 分隔，并把它当**程序世界的墙上时间**）。
 */

const BASE = '/api'

/** 后端错误 → 可读中文（不把内部英文串抛给用户） */
export function translateTimeError(status, message) {
  const text = String(message == null ? '' : message)
  if (/invalid days|invalid date|invalid datetime|invalid period|invalid argument/i.test(text)) return '时间参数不合法'
  if (/time .*(disabled|not allowed)|clock .*disabled/i.test(text)) return '程序时间功能当前已关闭'
  if (/not found|unknown route|Cannot POST|Cannot GET/i.test(text)) return '后端还没有时间接口（等更新）'
  if (text) return text
  if (status === 404) return '后端还没有时间接口（等更新）'
  if (status === 400) return '时间参数不合法'
  return status ? `请求失败 (${status})` : '请求失败'
}

// 统一请求基元（与 api/hypnosis.js 同口径，自包含，不改公共 api 模块）
async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(translateTimeError(res.status, result.error || result.message))
  return result
}

/**
 * 程序时间接口的公共前缀。
 * 后端实际挂在 `routes/schedule.js` 的 `router.use('/time', timeRoutes)` 上 → `/api/schedule/time`。
 * 若他以后按 `routes/time.js` 文件头的说明在 app.js 另挂一条 `/api/time`，把这里改成 '/time' 即可。
 */
const TIME_BASE = '/schedule/time'

/** 当前程序时间（返回裸状态对象：date / time / phase / dayIndex / totalDays / offset* / real …） */
export function getProgramTime({ signal } = {}) {
  return request(TIME_BASE, { signal })
}

/** 快进 N 天（days 为正整数，前端会夹到 1~3650，后端再校一次）；返回同 GET + applied */
export function advanceProgramTime(days) {
  return request(`${TIME_BASE}/advance`, { method: 'POST', body: { days } })
}

/** 设定具体日期时间（datetime 形状见文件头；后端按程序世界墙上时间解释）；返回同 GET + applied */
export function setProgramTime(datetime) {
  return request(`${TIME_BASE}/set`, { method: 'POST', body: { datetime } })
}

/** 只切白天 / 黑夜（日期与天数不动；后端默认 08:00 / 22:00）。body 同时带 period / phase，两个键后端都收 */
export function setProgramPeriod(period) {
  return request(`${TIME_BASE}/period`, { method: 'POST', body: { period, phase: period } })
}

/** 回到真实时间（偏移归零，"第 1 天"重锚到今天）；返回同 GET + applied */
export function resetProgramTime() {
  return request(`${TIME_BASE}/reset`, { method: 'POST', body: {} })
}
