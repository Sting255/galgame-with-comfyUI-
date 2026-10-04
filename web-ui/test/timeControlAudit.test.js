/**
 * 前端「当前时间」口径审计守卫（task-3 追加，2026-10-02）
 *
 * ## 用户原话
 * 「调时的选项设置页面还是太简陋了 **而且不在其他的覆盖范围** 需要把时间优先级调高
 *   让角色也感受时间 这样才像真实世界」
 *
 * ## 这条守卫管什么
 * "现在几点 / 今天是哪天"这类**当前时间展示**必须吃**程序时间**（后端 `GET /api/time`，
 * 偏移只在后端算）；而"某条记录发生在什么时候"这类**历史时间戳**按真实时间是对的，不许动。
 * 本文件把审计结论钉下来，防止改回去：
 *
 *   ① `ScheduleFilterPanel.vue` 日程面板顶部时钟（原来是模块加载时 `new Date()` 算一次的常量）
 *   ② `App.vue` 日程约定 toast 的"今天"基准（原来是真实今天 vs 程序日期键，会指错天）
 *   ③ `TownView.vue` 昼夜滤镜的兜底钟点（原来回落到现实钟点）
 *
 * 源码扫描**先剥注释**（本仓已经被自己的注释绊倒三次）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = rel => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

const APP = read('App.vue')
const SCHEDULE_PANEL = read('components/ScheduleFilterPanel.vue')
const TOWN_VIEW = read('views/TownView.vue')

/** 剥掉三种注释（HTML / 块 / 整行行内） */
function stripComments(src) {
  return String(src)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// ── ① 日程面板顶部时钟 ────────────────────────────────────────────────────

test('日程面板时钟：吃程序时间，不再是模块加载时算一次的常量', () => {
  const code = stripComments(SCHEDULE_PANEL)
  assert.equal(/const now = new Date\(\)/.test(code), false,
    '模块级 `new Date()` 会在页面加载时算一次，拨钟后永远显示现实钟点')
  assert.match(code, /import \{ getProgramTime \} from '\.\.\/api\/timeControl\.js'/, '世界钟走后端接口')
  assert.match(code, /programTimeViewModel/, '格式化复用统一视图模型（不自己拼时间串）')
  assert.match(code, /onMounted\(\(\) => \{[\s\S]*?refreshClock\(\)/, '挂载时拉一次')
  assert.match(code, /setInterval\(refreshClock, CLOCK_POLL_MS\)/, '30s 静默刷新')
  assert.match(code, /onUnmounted\(\(\) => \{[\s\S]*?clearInterval\(clockTimer\)/, '卸载时清定时器')
  // 读不到程序时间就让这行空着，不拿现实钟点冒充世界钟（剥注释后 catch 体是空的）
  assert.match(code, /catch \{\s*\}/, '失败静默第一段：catch 里不做任何回落到现实时间的动作')
  assert.match(SCHEDULE_PANEL, /读不到程序时间/, '口径要写在注释里（注释即口径）')
})

// ── ② App.vue 的"今天"基准 ───────────────────────────────────────────────

test('App.vue：日程约定的"今天"来自程序日期键，不是真实今天', () => {
  const code = stripComments(APP)
  assert.equal(/toLocaleDateString\('sv-SE'\)/.test(code), false, '不许再拿现实今天当基准')
  assert.match(code, /async function programDateKeyNow\(\)/, '要有一个"程序世界的今天"取值口')
  assert.match(code, /getProgramTime/, '程序日期走后端接口')
  assert.match(code, /const todayKey = await programDateKeyNow\(\)/, 'toast 里用程序今天')
  assert.match(code, /describeTargetDate\(data\.target_date, todayKey\)/, '相对日期以程序今天为基准')
  // 不许在前端自己加偏移（只读接口给的 date）
  assert.equal(/offsetMs/.test(code), false, '前端不许碰偏移量')
  // 除注释外，不再有"取当前时刻"的写法（new Date('YYYY-MM-DD') 这种解析日期键是允许的）
  assert.equal(/new Date\(\)/.test(code), false, 'App.vue 里不该再有 new Date()')
})

/** 从 App.vue 里取出 describeTargetDate 的真身，直接跑行为（不 mount 组件） */
function loadDescribeTargetDate() {
  const code = stripComments(APP)
  const at = code.indexOf('function describeTargetDate')
  assert.ok(at >= 0, 'App.vue 要有 describeTargetDate')
  const end = code.indexOf('\n}', at)
  assert.ok(end > at, '能截出函数体')
  return new Function(`${code.slice(at, end + 2)}; return describeTargetDate`)()
}

test('describeTargetDate 行为：基准是程序今天；判断不了就说日期，不说"明天"', () => {
  const describe = loadDescribeTargetDate()
  assert.equal(describe('2026-10-03', '2026-10-02'), '明天')
  assert.equal(describe('2026-10-04', '2026-10-02'), '后天')
  assert.equal(describe('2026-10-05', '2026-10-02'), '大后天')
  assert.equal(describe('2026-11-11', '2026-10-02'), '11月11日')
  assert.equal(describe('2026-10-02', '2026-10-02'), '10月2日', '同一天不给相对说法')
  // 世界钟被拨到过去时，"明天"要按程序日期算（这正是原来会指错天的地方）
  assert.equal(describe('2026-10-03', '2026-10-01'), '后天')
  assert.equal(describe('2026-10-03', ''), '10月3日', '拿不到程序日期时宁可少说，也不拿现实日期冒充')
  assert.equal(describe('不是日期', '2026-10-02'), '不是日期', '非法输入原样透出')
})

// ── ③ 小镇昼夜滤镜兜底 ───────────────────────────────────────────────────

test('小镇昼夜滤镜兜底：吃程序时间，不再回落到现实钟点', () => {
  const code = stripComments(TOWN_VIEW)
  assert.equal(/w\?\.hour \?\? new Date\(\)\.getHours\(\)/.test(code), false,
    '兜底钟点不许再用现实时间')
  assert.match(code, /const hour = w\?\.hour \?\? fallbackHour\.value/, '兜底改吃程序钟点')
  assert.match(code, /async function refreshFallbackHour\(\)/, '要有一处刷新它的地方')
  assert.match(code, /setInterval\(refreshFallbackHour, 60000\)/, '60s 刷新一次')
  assert.match(code, /clearInterval\(fallbackHourTimer\)/, '卸载时清定时器')
  // 中性兜底：两个来源都没有时给 12（三种滤镜都不命中），不上错色
  assert.match(code, /const fallbackHour = ref\(12\)/)
  // 小镇自己那套 daylight 口径没被碰（它归 utils/townWeather.js）
  assert.equal(/daylightHour|daylightLook/.test(code), false, '不要在 TownView 里重写 daylight 口径')
})

// ── ④ 历史时间戳：故意不改的清单（钉住"不要顺手改"）─────────────────────

test('历史记录类时间戳保持真实时间口径（审计里的"故意不改"要有据可查）', () => {
  // 相对时间戳展示：刚刚 / 分钟前 / 昨天 —— 它们比的是"真实瞬间"，程序钟偏移不该影响先后顺序
  const sidebar = stripComments(read('components/Sidebar.vue'))
  assert.match(sidebar, /const now = new Date\(\)/, '侧栏最近消息时间仍是真实时间')

  const mailbox = stripComments(read('views/MailboxView.vue'))
  assert.match(mailbox, /function timeAgo\(ts\)[\s\S]*?const now = new Date\(\)/, '信件时间仍是真实时间')

  // 相册按图片落盘时间分组（"今天/昨天"说的是文件真实时间）
  const gallery = stripComments(read('components/Gallery.vue'))
  assert.match(gallery, /const todayStart = new Date\(now\.getFullYear\(\)/, '相册分组仍按真实日期')

  // 小镇动态流 / 居民活动记录：发生时刻是真实瞬间
  const town = stripComments(read('views/TownView.vue'))
  assert.match(town, /function formatActivityTime\(occurredAt\)[\s\S]*?const now = new Date\(\)/, '小镇动态时间仍是真实时间')
})
