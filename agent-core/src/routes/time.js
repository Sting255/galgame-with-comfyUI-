/**
 * 程序时间（"现实模拟游戏"的世界钟）HTTP 接口
 *
 * 用户口径：「可以控制程序里的时间 控制是白天黑夜 是第一天还是第二天…我要完全控制时间…
 * 给我一个按钮 我可以让所有知道角色 过了一天了 或者是很多天 总之就是要让这个程序和游戏一样
 * 现实模拟游戏 我可以控制这一切」。
 *
 * ## 挂载（同一个 router 挂两处，路径与返回形状完全一致）
 *   · `app.js`：`app.use('/api/time', wrapRouterAsync(timeRoutes))`  ← **前端契约路径**
 *   · `routes/schedule.js`：`router.use('/time', timeRoutes)` → `/api/schedule/time*`（旧路径，保留）
 * 两处指向同一个模块实例，接口语义与返回形状没有第二个版本。
 *
 * ## 返回形状（**裸状态对象**，不做外层包装）
 *   { date:'YYYY-MM-DD', time:'HH:mm', period:'day'|'night', dayIndex, totalDays,
 *     phase, datetime, stamp, weekday, minuteOfDay, epochDate,
 *     offsetMs, offsetDays, offsetHours, offsetMinutes,
 *     real:{date,time,datetime,stamp}, message }
 *   · `dayIndex` = "今天是第几天"（epochDate 当天 = 1）；`totalDays` = 相对第 1 天推进了多少天
 *     （两者不等价：dayIndex = totalDays + 1）
 *   · `period` 与 `phase` 同值（`phase` 是历史字段，前端两个都收）
 *   · 写操作额外带 `applied`：{ days, dayKeys, skippedTempWakes, characters, ... }（附加信息）
 *   · `message` 如实说明"哪些模块仍只跟真实时间走"
 *
 * ## `GET /api/time/perception`（2026-10-02 task-3 追加，只读）
 * 「角色此刻看到的时间」预览：**与注入 prompt 的字符串同源**——直接调
 * `timeLight.getTimeTag()` / `getTimeLightTag()` / `getLightHint()`（不传 now ⇒ 内部
 * `resolveNow(undefined)` → `getProgramNow()`，与 chat.js 传 `new Date()` 的结果逐字节一致，
 * 且**不会**加两遍偏移）。再附上各角色此刻的时段 / 光线 / 在做什么（`scheduleManager.getAllOverview`）。
 * 形状见 `buildTimePerception()` 的文件注释；**只读**，不写库、不触发翻篇、无副作用。
 *
 * ## 错误映射
 *   400 `{ error: 'invalid days' | 'invalid datetime' | 'invalid date' | 'invalid time' | 'invalid period' }`
 *   409 `{ error: 'time control disabled' }`（`features.schedule === false`；读取口也一样，保持一个开关口径）
 */

import { Router } from 'express';
import { config } from '../config.js';
import { getAllOverview } from '../services/scheduleManager.js';
import { getProgramState } from '../services/programTime.js';
// 2026-10-02：调时后核对当天报纸（用户原话「日报还是不跟着时间走」）。幂等：当天已有就跳过。
import { maybeGenerateDailyNewspaper } from '../services/newspaperService.js';
import {
  getCurrentWeather,
  getLightHint,
  getSeason,
  getTimeLight,
  getTimeLightTag,
  getTimeTag,
} from '../services/timeLight.js';
import {
  TimeControlError,
  advanceTimeDays,
  getTimeState,
  resetTime,
  setTimeDateTime,
  setTimePeriod,
} from '../services/timeControl.js';

const router = Router();

function disabled() {
  return config.features.schedule === false;
}

/**
 * 统一出口：开关检查 → 跑服务 → 参数非法翻 400 → 其他翻 500。
 * 这里**必须吞掉异常**：本 router 可能被挂在一个没有 errorHandler 的 app 上
 * （测试夹具就是这样），漏出去的 rejection 会变成 500 HTML 而不是契约里的 JSON。
 */
async function respond(res, fn) {
  if (disabled()) return res.status(409).json({ error: 'time control disabled' });
  try {
    const payload = await fn();
    // 2026-10-02：调时之后**核对当天的报纸**（用户原话：「日报还是不跟着时间走」）。
    // 只在**写操作**上做（调时就是写），且 `maybeGenerateDailyNewspaper()` 自身幂等
    // （当天已有就跳过）⇒ 不会重复出报、也不会在只读接口上误触发模型调用。
    // 不 await：出报要调模型，别拖慢调时的回执（失败也只 warn，不影响调时本身）。
    if (String(res.req?.method || 'GET').toUpperCase() !== 'GET') {
      Promise.resolve()
        .then(() => maybeGenerateDailyNewspaper())
        .catch(err => console.warn('[time] 调时后核对报纸失败（不影响调时）:', err?.message || err));
    }
    return res.json(payload);
  } catch (err) {
    if (err instanceof TimeControlError) return res.status(400).json({ error: err.code });
    console.error(`[time] ${res.req?.method || ''} ${res.req?.originalUrl || ''} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ── 角色感知投影（只读）─────────────────────────────────────────────────────

/** 睡觉时的光线口径（与 timeLight.LIGHT_MAP 里 [0,5) 那句"如果睡觉，房间里没有灯光"同口径） */
const ASLEEP_LIGHT = '房间里没有灯光（她正在睡）';

/**
 * 「角色此刻看到的时间」——投影成接口形状（**前端契约，只加不减**）：
 *
 *   {
 *     // 世界钟（与 GET /api/time 同口径，前端不必再读一次 /api/time）
 *     date, time, datetime, weekday, dayIndex, totalDays, period, phase, epochDate,
 *     offsetMs, offsetDays, offsetHours, offsetMinutes, real:{date,time,datetime,stamp},
 *     // prompt 同源字符串（三个都来自 timeLight，本文件**不拼第二份**时间文案）
 *     timeTag,       // 主聊天流注入的那一行：`[2026-10-02 周五 08:56 | 秋天·上午 | 天气:多云、挺热]`
 *     timeLightTag,  // 生图场景那一行：`[当前时间 周五 10/02 08:56 / 秋天/上午 — 外面多云、挺热]`
 *     lightText,     // getLightHint()：季节 + 时段 + 天气 + 室内外光线
 *     season,        // 春天/夏天/秋天/冬天
 *     periodText,    // 8 段时段：凌晨/清晨/上午/中午/下午/傍晚/晚上/深夜
 *     lightOutdoor, lightIndoor,
 *     weather: { text, temperature, windSpeed } | null,
 *     // 角色摘要（同一口世界钟 ⇒ timeTag 对所有角色相同；差异在"睡/醒"与在做什么）
 *     sharedClock: true,
 *     characters: [{ id, name, awake, isSleeping, isTempWoken, sleepKind, activity, light, summary }],
 *     source: 'timeLight.getTimeTag() / getTimeLightTag() / getLightHint()',
 *   }
 *
 * 口径说明：**不传 now** 给 timeLight（它内部对 `undefined` 走 `getProgramNow()`）；
 * 传 `new Date()` 也是同一结果——`resolveNow` 只对真实瞬间加偏移，两种写法都只加一遍。
 */
export function buildTimePerception() {
  const state = getProgramState();
  const light = getTimeLight();
  const timeTag = getTimeTag();
  const timeLightTag = getTimeLightTag();
  const season = getSeason(Number(state.date.slice(5, 7))); // 'YYYY-MM-DD' → 月份（程序世界的月份）
  const weather = getCurrentWeather(Math.floor(state.minuteOfDay / 60));

  const characters = getAllOverview().map(row => {
    const isSleeping = !!row.is_sleeping && !row.is_temp_woken;
    const isTempWoken = !!row.is_temp_woken;
    const isNapping = !isSleeping && !isTempWoken && row.sleep_kind === 'nap';
    const activity = String(row.current_activity || '未设置日程');
    const lightText = isSleeping ? ASLEEP_LIGHT : indoorLightOf(light);
    const stateText = isSleeping
      ? '正在睡觉'
      : isTempWoken
        ? '刚被叫醒，睡眼惺忪'
        : isNapping
          ? '正在小憩'
          : '醒着';
    return {
      id: row.id,
      name: row.display_name,
      awake: !isSleeping,
      isSleeping,
      isTempWoken,
      isNapping,
      sleepKind: row.sleep_kind || null,
      activity,
      light: lightText,
      summary: isSleeping ? `${stateText}（${lightText}）` : `${stateText}，${activity}`,
    };
  });

  return {
    ok: true,
    // —— 世界钟（与 GET /api/time 同一份投影）——
    date: state.date,
    time: state.time,
    datetime: state.datetime,
    weekday: state.weekday,
    dayIndex: state.dayIndex,
    totalDays: state.totalDays,
    period: state.phase,
    phase: state.phase,
    epochDate: state.epochDate,
    offsetMs: state.offsetMs,
    offsetDays: state.offsetDays,
    offsetHours: state.offsetHours,
    offsetMinutes: state.offsetMinutes,
    real: state.real,
    // —— prompt 同源 ——
    timeTag,
    timeLightTag,
    lightText: getLightHint(),
    season,
    periodText: light.timeDesc,
    lightOutdoor: light.lightNote,
    lightIndoor: light.lightNoteIndoor,
    weather: weather ? { text: weather.weather, temperature: weather.temperature, windSpeed: weather.windSpeed } : null,
    sharedClock: true,
    characters,
    source: 'timeLight.getTimeTag() / getTimeLightTag() / getLightHint()',
  };
}

/** 醒着时的室内光线口径（就是 timeLight 里那条 lightNoteIndoor，原样透出，不另写一份文案） */
function indoorLightOf(light) {
  return light?.lightNoteIndoor || '室内场景以灯光为主';
}

// ── GET /api/time — 读当前程序时间 ──
router.get('/', (req, res) => respond(res, async () => getTimeState()));

// ── GET /api/time/perception — 「角色此刻看到的时间」只读预览（prompt 同源）──
router.get('/perception', (req, res) => respond(res, async () => buildTimePerception()));

// ── POST /api/time/advance — 快进 N 天（1~3650，逐天推进）──
router.post('/advance', (req, res) => respond(res, async () => advanceTimeDays(req.body?.days)));

// ── POST /api/time/period — 只切白天 / 黑夜（日期与天数不动）──
// body：{ period: 'day'|'night'（也认 '白天'/'黑夜'）, time?: 'HH:mm' }（`phase` 也认）
router.post('/period', (req, res) => respond(res, async () => {
  const raw = req.body?.period ?? req.body?.phase;
  return setTimePeriod(raw, { time: req.body?.time });
}));

// ── POST /api/time/set — 设定具体日期时间（程序世界的墙上时间）──
// body：{ datetime: 'YYYY-MM-DD HH:mm[:ss]' | ISO }，也兼容 { date, time } / { time }
router.post('/set', (req, res) => respond(res, async () => setTimeDateTime(req.body || {})));

// ── POST /api/time/reset — 回到真实时间（偏移归零，第 1 天重锚到今天）──
router.post('/reset', (req, res) => respond(res, async () => resetTime()));

export default router;
