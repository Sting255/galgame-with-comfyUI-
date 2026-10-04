/**
 * 「程序时间」面板的纯逻辑层（无 Vue 依赖、无请求，可被 node:test 直接引入）。
 *
 * 与 `components/hypnosisLogic.js` 同一定位：组件只负责画，
 * 判定与格式化口径（日期/时刻/白天黑夜/第几天、快进天数清洗、设置弹窗的时间拼装、
 * "什么会跟着变"的说明文案）都在这里，便于单测覆盖。
 *
 * 请求与错误翻译在 `api/timeControl.js`；「角色此刻看到的时间」的请求在 `api/index.js`
 * 的 `getTimePerception()`（task-3 追加，只读、prompt 同源）。
 *
 * 后端形状（`GET /api/time`，与 `agent-core/src/services/programTime.js` 的 `getProgramState()` 对齐）：
 *   { date, time, datetime, stamp, weekday, minuteOfDay, phase: 'day'|'night', dayIndex, totalDays,
 *     epochDate, offsetMs, offsetDays, offsetHours, offsetMinutes, real: { date, time, datetime, stamp } }
 *   · date   形如 '2026-09-28'（也兼容 ISO 串与 'YYYY/MM/DD'）
 *   · time   形如 '14:05' 或 '14:05:00'
 *   · phase  **后端字段名是 `phase`**（交付时口径写作 `period`，两者都收：`phase` 优先）
 *   · weekday 缺失时按日期推算；phase 缺失时按 hour 推断（06:00~17:59 = 白天）
 *   · dayIndex = 第几天（epochDate 当天 = 第 1 天）；totalDays = 相对第 1 天推进了多少天
 *   · real / offset* 用来如实告诉用户"现实世界现在几点、程序钟比现实快多少"
 *
 * 感知预览形状（`GET /api/time/perception`，见 `agent-core/src/routes/time.js`）：
 *   { timeTag, timeLightTag, lightText, season, periodText, lightOutdoor, lightIndoor,
 *     weather: { text, temperature, windSpeed } | null, characters: [...] }
 *   · `timeTag` 就是注入提示词的那一行（后端 `timeLight.getTimeTag()`）；**前端绝不自己拼这个串**。
 */

/** 快进天数边界：1 ~ 3650 天（十年），空/非法回落 1 天 */
export const DAY_ADVANCE_MIN = 1
export const DAY_ADVANCE_MAX = 3650
export const DAY_ADVANCE_DEFAULT = 1

/** 合法时段枚举 */
export const PERIODS = Object.freeze(['day', 'night'])

/** 白天的起止小时（仅用于 period 缺失时的推断，不参与后端判定） */
export const DAY_START_HOUR = 6
export const NIGHT_START_HOUR = 18

/** 快进天数清洗：能解析成数字的按 1~3650 夹取（四舍五入），空 / 非数字 → 1 天 */
export function clampAdvanceDays(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return DAY_ADVANCE_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n)) return DAY_ADVANCE_DEFAULT
  return Math.min(DAY_ADVANCE_MAX, Math.max(DAY_ADVANCE_MIN, Math.round(n)))
}

function pad2(n) { return String(n).padStart(2, '0') }

/** 日期归一：'2026-09-28' / '2026-09-28T12:00:00Z' / '2026/09/28' → 'YYYY-MM-DD'；认不出给 '' */
export function normalizeProgramDate(date) {
  const raw = String(date == null ? '' : date).trim()
  if (!raw) return ''
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (!match) return ''
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''
  return `${match[1]}-${pad2(month)}-${pad2(day)}`
}

/** 时刻归一：'14:05' / '14:05:00' / '9:5' → 'HH:MM'；认不出给 '' */
export function normalizeProgramClock(time) {
  const raw = String(time == null ? '' : time).trim()
  if (!raw) return ''
  const match = raw.match(/^(\d{1,2}):(\d{1,2})(?::\d{2})?$/)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${pad2(hour)}:${pad2(minute)}`
}

/** 时段归一：只认 'day' / 'night'（大小写与 '白天'/'黑夜' 都收）；认不出给 '' */
export function normalizePeriod(period) {
  const raw = String(period == null ? '' : period).trim().toLowerCase()
  if (raw === 'day' || raw === '白天' || raw === 'd') return 'day'
  if (raw === 'night' || raw === '黑夜' || raw === 'n') return 'night'
  return ''
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 日期键 → '周一'（用 UTC 反查，避免本地时区把日期挪一天）；认不出给 '' */
export function weekdayOfDateKey(date) {
  const normalized = normalizeProgramDate(date)
  if (!normalized) return ''
  const [year, month, day] = normalized.split('-').map(Number)
  const stamp = Date.UTC(year, month - 1, day)
  const derived = new Date(stamp).getUTCDay()
  return Number.isFinite(derived) ? WEEKDAYS[derived] : ''
}

/** 星期文案：优先后端给的 weekday（白名单校验），缺失时按日期推算 */
export function weekdayText(raw) {
  const given = String(raw ?? '').trim()
  if (WEEKDAYS.includes(given)) return given
  return ''
}

/**
 * 程序钟与现实钟的差距 → 人话（面板上"我现在比现实快多少"）。
 * 认 `offsetMs`（毫秒，权威），退化到 `offsetDays` / `offsetHours`；0 明说"一致"。
 */
export function offsetText(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const offsetMs = source.offsetMs
  const offsetDays = source.offsetDays
  const offsetHours = source.offsetHours
  const ms = Number(offsetMs)
  if (Number.isFinite(ms) && ms !== 0) {
    const days = ms / 86400000
    if (Number.isInteger(days)) return `比现实时间${days > 0 ? '快' : '慢'} ${Math.abs(days)} 天`
    const hours = Number((ms / 3600000).toFixed(1))
    if (Math.abs(hours) >= 1) return `比现实时间${hours > 0 ? '快' : '慢'} ${Math.abs(hours)} 小时`
    return `比现实时间${hours > 0 ? '快' : '慢'} ${Math.abs(Math.trunc(ms / 60000))} 分钟`
  }
  if (Number.isFinite(ms) && ms === 0) return '与现实时间一致'
  const days = Number(offsetDays)
  if (Number.isFinite(days) && days !== 0) return `比现实时间${days > 0 ? '快' : '慢'} ${Math.abs(days)} 天`
  const hours = Number(offsetHours)
  if (Number.isFinite(hours) && hours !== 0) return `比现实时间${hours > 0 ? '快' : '慢'} ${Math.abs(hours)} 小时`
  return Number.isFinite(ms) || Number.isFinite(days) || Number.isFinite(hours) ? '与现实时间一致' : ''
}

/** 现实世界这一刻（后端 `real` 字段）→ '2026-09-28 20:31'；没有给就空串 */
export function realTimeText(raw) {
  const real = raw && typeof raw === 'object' ? raw.real : null
  if (!real || typeof real !== 'object') return ''
  const date = normalizeProgramDate(real.date)
  const time = normalizeProgramClock(real.time)
  if (!date && !time) return ''
  return `${date || '—'} ${time || '--:--'}`
}

/** 时刻推断时段（只在后端没给 period 时用）：06:00~17:59 = 白天，其余 = 黑夜 */
export function inferPeriodFromClock(time) {
  const clock = normalizeProgramClock(time)
  if (!clock) return ''
  const hour = Number(clock.slice(0, 2))
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? 'day' : 'night'
}

/** 时段 → 中文（未知给 ''） */
export function periodText(period) {
  const key = normalizePeriod(period)
  if (key === 'day') return '白天'
  if (key === 'night') return '黑夜'
  return ''
}

/**
 * 8 段时段表：与后端 `agent-core/src/services/timeLight.js` 的 `LIGHT_MAP` **区间一一对应**
 * （凌晨 0-5 / 清晨 5-7 / 上午 7-12 / 中午 12-13 / 下午 13-17 / 傍晚 17-19 / 晚上 19-22 / 深夜 22-24）。
 * 用途只有两个：① 接口没给 `periodText` 时的展示兜底；② 让"程序日期 + 时段"一眼看清是清晨还是深夜。
 * ⚠️ 这只是**读一个时刻字符串**得出的标签，不参与任何偏移计算（偏移只在后端 `programTime.js`）。
 */
export const PERIOD_SEGMENTS = Object.freeze([
  Object.freeze({ from: 0, to: 5, label: '凌晨' }),
  Object.freeze({ from: 5, to: 7, label: '清晨' }),
  Object.freeze({ from: 7, to: 12, label: '上午' }),
  Object.freeze({ from: 12, to: 13, label: '中午' }),
  Object.freeze({ from: 13, to: 17, label: '下午' }),
  Object.freeze({ from: 17, to: 19, label: '傍晚' }),
  Object.freeze({ from: 19, to: 22, label: '晚上' }),
  Object.freeze({ from: 22, to: 24, label: '深夜' }),
])

/** 时刻（'HH:MM'）→ 8 段时段名；认不出给 '' */
export function periodSegmentText(time) {
  const clock = normalizeProgramClock(time)
  if (!clock) return ''
  const hour = Number(clock.slice(0, 2))
  const hit = PERIOD_SEGMENTS.find(s => hour >= s.from && hour < s.to)
  return hit ? hit.label : ''
}

/** 快捷推进的天数（面板上的「+1 天 / +7 天」两个按钮共用，避免两处写死数字） */
export const QUICK_ADVANCE_DAYS = Object.freeze([1, 7])

/** 日期 → '2026年9月28日'（不补零，中文读法）；认不出给 '未知日期' */
export function formatProgramDate(date) {
  const normalized = normalizeProgramDate(date)
  if (!normalized) return '未知日期'
  const [year, month, day] = normalized.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

/** 时刻 → 'HH:MM'；认不出给 '--:--' */
export function formatProgramClock(time) {
  return normalizeProgramClock(time) || '--:--'
}

/** 第几天 / 累计天数文案；缺字段时如实显示占位，不编造数字 */
export function dayProgressText(dayIndex, totalDays) {
  const nth = Number(dayIndex)
  const total = Number(totalDays)
  const nthText = Number.isFinite(nth) && nth > 0 ? `第 ${Math.round(nth)} 天` : '第 — 天'
  const totalText = Number.isFinite(total) && total > 0 ? `累计 ${Math.round(total)} 天` : ''
  return totalText ? `${nthText} · ${totalText}` : nthText
}

/**
 * 把后端返回整理成面板直接可渲染的视图。
 * `ok` 表示"这一份数据看起来是程序时间"（date 或 time 至少有一个能认出来），
 * 用来区分"后端接口还没上线 / 返回了空对象"和"真的是零点整"。
 */
export function programTimeViewModel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const date = normalizeProgramDate(source.date)
  const time = normalizeProgramClock(source.time)
  // 后端字段名是 phase；交付口径写的 period 也一并收（phase 优先）
  const period = normalizePeriod(source.phase) || normalizePeriod(source.period) || inferPeriodFromClock(source.time)
  const weekday = weekdayText(source.weekday) || weekdayOfDateKey(date)
  return {
    ok: !!(date || time),
    date,
    time,
    period,
    weekday,
    dateText: formatProgramDate(date),
    clockText: formatProgramClock(time),
    periodText: periodText(period),
    weekdayText: weekday,
    dayText: dayProgressText(source.dayIndex, source.totalDays),
    dayIndex: Number.isFinite(Number(source.dayIndex)) ? Number(source.dayIndex) : null,
    totalDays: Number.isFinite(Number(source.totalDays)) ? Number(source.totalDays) : null,
    epochDate: normalizeProgramDate(source.epochDate),
    offsetText: offsetText(source),
    realText: realTimeText(source),
    // 8 段时段（后端 `periodText` 优先，缺失时按时刻兜底）：清晨 / 上午 / 深夜…
    segmentText: String(source.periodText ?? '').trim() || periodSegmentText(time),
  }
}

/** 拼装 `POST /time/set` 的 datetime（本项目 SQLite 时间戳写法，补秒）；任一非法给 '' */
export function composeDatetime(date, time) {
  const day = normalizeProgramDate(date)
  const clock = normalizeProgramClock(time)
  if (!day || !clock) return ''
  return `${day} ${clock}:00`
}

/** 反过来：把当前程序时间拆成设置弹窗的初始值（date / time 两个输入框） */
export function splitDatetime(raw) {
  const date = normalizeProgramDate(raw?.date)
  const time = normalizeProgramClock(raw?.time)
  return { date, time }
}

/**
 * 说明文案：**哪些东西会跟着程序时间变、哪些仍按真实时间走**。
 *
 * 口径直接对齐后端 `agent-core/src/services/programTime.js` 的文件头（"程序时间只影响世界钟"）：
 *   · 跟着变：日程 / 睡眠判定、时段描述、prompt 时间标签、`daily_schedules.schedule_date`（程序日期键）；
 *   · 不变：所有真实时间的定时器（心跳、临时唤醒 5~15 分钟窗口、`next_proactive_at`、
 *     `next_schedule_refresh_at`、邮件 / 朋友圈排期），以及写入库的时间戳
 *     （`sleep_until` / `temporary_wake_until` / `reply_queue.scheduled_reply_at` 仍是真实瞬间）。
 */
export const TIME_SCOPE_NOTES = Object.freeze({
  changes: Object.freeze([
    '所有角色的日程与睡眠 / 起床判定（会按新的程序日期重算，逐天补齐快照）',
    '白天 / 黑夜与 8 段时段（凌晨…深夜）的描述，以及提示词里的时间标签',
    '程序日期一翻篇，当天的日常任务立刻重跑：《邻舍日报》重印、记忆整理敲一次门',
    '日程页与小镇里显示的日期、时刻、第几天（日程按程序日期键存）',
  ]),
  unchanged: Object.freeze([
    '真实时间的定时器：心跳、临时唤醒 5~15 分钟窗口、主动聊天与日程刷新排期、邮件 / 朋友圈排期',
    '写进库的时间戳（sleep_until / temporary_wake_until / 排队回复时间）仍是真实瞬间',
    '聊天记录、日志文件与数据备份上的日期',
  ]),
})

/** 操作成功后的 toast 文案（统一带上"已重算所有角色日程/睡眠"） */
export const TIME_RECALC_NOTICE = '已重算所有角色日程/睡眠'

/**
 * 把后端 `applied` 里的重算明细补进提示语。
 * 后端三个写接口都会带 `applied: { days, skippedTempWakes: number[], characters: Array }`
 * （`characters` = 重算过的角色及其睡眠状态）。拿不到就只说固定那句，不编造数量。
 */
export function recalculationText(applied) {
  const parts = [TIME_RECALC_NOTICE]
  const characters = Array.isArray(applied?.characters) ? applied.characters.length : 0
  if (characters > 0) parts.push(`共 ${characters} 个角色`)
  const skipped = Array.isArray(applied?.skippedTempWakes) ? applied.skippedTempWakes.length : 0
  if (skipped > 0) parts.push(`同时收掉 ${skipped} 个过期的临时唤醒窗口`)
  return parts.join('，')
}

/** 一次操作的结果 → 一句人话（面板 toast / 结果行共用） */
export function timeActionResultText(action, raw, extra = {}) {
  const view = programTimeViewModel(raw)
  const suffix = [view.periodText, view.dayText, view.weekday].filter(Boolean).join(' · ')
  const nowText = `${view.dateText} ${view.clockText}${suffix ? `（${suffix}）` : ''}`
  const recalc = recalculationText(raw?.applied)
  if (action === 'advance') {
    const days = Number(extra.days) || DAY_ADVANCE_DEFAULT
    return `已快进 ${days} 天：现在是 ${nowText}。${recalc}`
  }
  if (action === 'period') {
    const label = periodText(extra.period) || '新的时段'
    return `已切到${label}：现在是 ${nowText}。${recalc}`
  }
  if (action === 'set') return `已设定程序时间：现在是 ${nowText}。${recalc}`
  if (action === 'reset') return `已回到真实时间：现在是 ${nowText}。${recalc}`
  return recalc
}

/** 回到真实时间前的二次确认文案（会重锚"第 1 天"，值得先讲清楚） */
export function resetConfirmMessage() {
  return '程序时间会立刻与真实时间对齐，并重新锚定「第 1 天」为今天；\n所有角色的日程与睡眠状态都会按真实时间重算。'
}

// ══════════════════════════════════════════════════════════════════════════
// 「角色此刻看到的时间」预览（`GET /api/time/perception`，task-3 追加）
//
// 这一段的纪律：**时间串只有后端一份**。前端把 `timeTag` 原样显示，
// 只做"取不到就说明取不到"的兜底，绝不自己拼一个看起来一样的串
// （自己拼就会和 prompt 里真正注入的那一行慢慢跑偏 —— 正是要避免的事）。
// 时段/季节/光线/天气同理：都以后端字段为准，缺失时才用本地时段表兜底展示。
// ══════════════════════════════════════════════════════════════════════════

/** 天气对象 → '多云、挺热、微风'（也认后端直接给字符串）；没有给空串 */
export function weatherTextOf(weather) {
  if (typeof weather === 'string') return weather.trim()
  if (!weather || typeof weather !== 'object') return ''
  return [weather.text, weather.temperature, weather.windSpeed].map(v => String(v ?? '').trim()).filter(Boolean).join('、')
}

/** 单个角色条目 → 面板视图（后端 summary 优先；缺失时按睡/醒状态拼一句，不编造她的日程） */
export function characterPerceptionText(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const sleeping = source.isSleeping === true
  const tempWoken = source.isTempWoken === true
  const napping = source.isNapping === true || source.sleepKind === 'nap'
  if (sleeping) return '正在睡觉'
  if (tempWoken) return '刚被叫醒，睡眼惺忪'
  if (napping) return '正在小憩'
  const activity = String(source.activity ?? '').trim()
  return activity ? `醒着，${activity}` : '醒着'
}

/**
 * 感知快照 → 面板可渲染的视图。
 * `ok` = 后端给了非空 `timeTag`（也就是"真的读到了她们此刻看到的那一行"）。
 */
export function perceptionViewModel(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const timeTag = typeof source.timeTag === 'string' ? source.timeTag.trim() : ''
  const season = String(source.season ?? '').trim()
  const segment = String(source.periodText ?? '').trim()
  const weatherText = weatherTextOf(source.weather)
  const characters = (Array.isArray(source.characters) ? source.characters : []).map(item => {
    const c = item && typeof item === 'object' ? item : {}
    const sleeping = c.isSleeping === true
    return {
      id: Number.isFinite(Number(c.id)) ? Number(c.id) : null,
      name: String(c.name ?? '').trim() || '角色',
      awake: c.awake === true || (c.awake === undefined && !sleeping),
      isSleeping: sleeping,
      isTempWoken: c.isTempWoken === true,
      isNapping: c.isNapping === true || c.sleepKind === 'nap',
      activity: String(c.activity ?? '').trim(),
      light: String(c.light ?? '').trim(),
      summary: String(c.summary ?? '').trim() || characterPerceptionText(c),
    }
  })
  const awakeCount = characters.filter(c => c.awake).length
  return {
    ok: !!timeTag,
    timeTag,
    timeLightTag: typeof source.timeLightTag === 'string' ? source.timeLightTag.trim() : '',
    season,
    segmentText: segment || periodSegmentText(source.time),
    lightText: String(source.lightText ?? '').trim(),
    lightIndoor: String(source.lightIndoor ?? '').trim(),
    weatherText,
    characters,
    // 一行摘要：她们现在认为是什么季节、什么时段、外面什么天气
    castLine: [season, segment || periodSegmentText(source.time), weatherText].filter(Boolean).join(' · '),
    awakeCount,
    sleepingCount: characters.length - awakeCount,
    countText: characters.length > 0
      ? `共 ${characters.length} 个角色：${awakeCount} 个醒着 / ${characters.length - awakeCount} 个在睡`
      : '还没有角色',
  }
}

// ── 翻篇反馈（调时 → 世界翻篇 → 当天的《邻舍日报》）──────────────────────

/** 翻篇反馈的阶段机（面板用它切样式；'unchanged' = 调了钟但程序日期没变） */
export const ROLLOVER_PHASES = Object.freeze(['idle', 'pending', 'confirmed', 'timeout', 'unchanged'])

/**
 * 调时**成功返回**后立刻给的反馈。
 * **只有程序日期真的变了才算"世界已翻篇"**：同一天内改钟点不会重印报纸，
 * 这里如实说，不喊狼来了（翻篇任务由后端 `programDayRollover` 决定跑不跑）。
 */
export function rolloverNotice(fromDate, toDate) {
  const from = normalizeProgramDate(fromDate)
  const to = normalizeProgramDate(toDate)
  if (!from || !to) return { phase: 'idle', changed: false, text: '' }
  if (from === to) {
    return {
      phase: 'unchanged',
      changed: false,
      text: `世界时间已调整：程序日期仍是 ${formatProgramDate(to)}——《邻舍日报》按天出，不会重印`,
    }
  }
  return {
    phase: 'pending',
    changed: true,
    text: `世界已翻篇：${formatProgramDate(from)} → ${formatProgramDate(to)}，正在出当天的《邻舍日报》…`,
  }
}

/** SSE 广播里的触发来源 → 人话（认不出就原样透出，不猜） */
export function rolloverReasonText(reason) {
  const key = String(reason ?? '').trim()
  const map = {
    advance: '快进',
    set: '设定日期时间',
    period: '切换白天黑夜',
    reset: '回到真实时间',
    tick: '时间自然流过午夜',
    startup: '启动补跑',
  }
  return map[key] || key
}

/** SSE `program_day_rollover` 到达（后端载荷 `{ from, to, reason }`）→ 完成文案 */
export function rolloverEventText(data) {
  const from = normalizeProgramDate(data?.from)
  const to = normalizeProgramDate(data?.to)
  const range = from && to
    ? `${formatProgramDate(from)} → ${formatProgramDate(to)}`
    : (to ? formatProgramDate(to) : '新的一天')
  const reason = rolloverReasonText(data?.reason)
  return `世界已翻篇：${range}${reason ? `（${reason}）` : ''}，《邻舍日报》正在印，记忆整理也已敲过门`
}

/** 等了一会儿仍没等到广播 → 如实说明（不假装翻篇成功） */
export function rolloverTimeoutText() {
  return '还没收到翻篇广播：后端可能正在生成《邻舍日报》（十几秒起）；日报页会自己刷新，稍后再看即可'
}
