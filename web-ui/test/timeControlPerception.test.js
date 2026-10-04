/**
 * 「调时」页改版：角色感知预览 + 翻篇反馈 + 组件源码守卫（task-3）
 *
 * 用户原话：「调时的选项设置页面还是太简陋了 而且不在其他的覆盖范围 需要把时间优先级调高
 *   让角色也感受时间 这样才像真实世界」
 *
 * 本文件只测**纯逻辑 + 结构与口径**，不 mount 组件：
 *   1. 8 段时段的边界（凌晨…深夜），与后端 timeLight.LIGHT_MAP 的区间逐条对齐；
 *   2. 感知预览：`timeTag` **原样透出**（这是注入提示词的那一行，前端不许重拼）；
 *   3. 翻篇文案：程序日期真变了才说"世界已翻篇"，同日调钟不许喊狼来了；
 *   4. 接口形状（mock fetch，不联网）：`GET /api/time/perception`，只读、无 body，错误翻成人话；
 *   5. 组件源码守卫：不许裸控件、要有 0.3s 过渡、要订阅 `program_day_rollover`、
 *      **不许在面板里自己算时间**（`new Date()` / `Date.now()`）。
 *
 * 血泪教训自带一条：所有源码扫描**先剥注释**再断言（本仓已被自己的注释绊倒三次）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  PERIOD_SEGMENTS,
  QUICK_ADVANCE_DAYS,
  ROLLOVER_PHASES,
  characterPerceptionText,
  perceptionViewModel,
  periodSegmentText,
  rolloverEventText,
  rolloverNotice,
  rolloverReasonText,
  rolloverTimeoutText,
  weatherTextOf,
} from '../src/components/timeControlLogic.js'

const PANEL = fs.readFileSync(new URL('../src/components/TimeControlPanel.vue', import.meta.url), 'utf8')
const LOGIC = fs.readFileSync(new URL('../src/components/timeControlLogic.js', import.meta.url), 'utf8')

/** 剥掉三种注释（HTML / 块 / 整行行内）后再做源码断言 */
function stripComments(src) {
  return String(src)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

// ── 1. 8 段时段 ───────────────────────────────────────────────────────────

test('8 段时段边界：凌晨/清晨/上午/中午/下午/傍晚/晚上/深夜 各归各位', () => {
  const cases = [
    ['00:00', '凌晨'], ['04:59', '凌晨'],
    ['05:00', '清晨'], ['06:59', '清晨'],
    ['07:00', '上午'], ['11:59', '上午'],
    ['12:00', '中午'], ['12:59', '中午'],
    ['13:00', '下午'], ['16:59', '下午'],
    ['17:00', '傍晚'], ['18:59', '傍晚'],
    ['19:00', '晚上'], ['21:59', '晚上'],
    ['22:00', '深夜'], ['23:59', '深夜'],
  ]
  for (const [clock, label] of cases) {
    assert.equal(periodSegmentText(clock), label, `${clock} 应当是「${label}」`)
  }
  // 非法输入不编造
  assert.equal(periodSegmentText('24:00'), '')
  assert.equal(periodSegmentText('12:60'), '')
  assert.equal(periodSegmentText(''), '')
  assert.equal(periodSegmentText(null), '')
  assert.equal(periodSegmentText('9:5'), '上午', '不补零的写法也要认')
})

test('8 段时段表自检：0~24 无缝无重叠（与后端 timeLight 的区间一一对应）', () => {
  assert.equal(PERIOD_SEGMENTS.length, 8)
  assert.equal(PERIOD_SEGMENTS[0].from, 0)
  assert.equal(PERIOD_SEGMENTS[PERIOD_SEGMENTS.length - 1].to, 24)
  for (let i = 1; i < PERIOD_SEGMENTS.length; i += 1) {
    assert.equal(PERIOD_SEGMENTS[i].from, PERIOD_SEGMENTS[i - 1].to, '区间必须首尾相接')
  }
  // 24 小时每一小时都能落进一段
  for (let hour = 0; hour < 24; hour += 1) {
    const clock = `${String(hour).padStart(2, '0')}:00`
    assert.ok(periodSegmentText(clock), `${clock} 必须能落进某一段`)
  }
})

// ── 2. 感知预览（prompt 同源）─────────────────────────────────────────────

const SAMPLE = {
  timeTag: '[2026-10-02 周五 08:56 | 秋天·上午 | 天气:多云、挺热]',
  timeLightTag: '[当前时间 周五 10/02 08:56 / 秋天/上午 — 外面多云、挺热]',
  lightText: '秋天的上午时分。外面多云、挺热、光线柔和偏散。室内散射自然光为主',
  lightIndoor: '若有室内场景以窗边散射自然光为主',
  season: '秋天',
  periodText: '上午',
  weather: { text: '多云', temperature: '挺热', windSpeed: '' },
  characters: [
    { id: 1, name: '阿岚', awake: true, isSleeping: false, activity: '事务所整理档案', light: '若有室内场景以窗边散射自然光为主', summary: '醒着，事务所整理档案' },
    { id: 2, name: '小满', awake: false, isSleeping: true, isTempWoken: false, activity: '就寝安眠 · 卧室', light: '房间里没有灯光（她正在睡）', summary: '正在睡觉（房间里没有灯光（她正在睡））' },
  ],
}

test('感知预览：timeTag 原样透出（注入提示词的那一行，前端一个字都不改）', () => {
  const view = perceptionViewModel(SAMPLE)
  assert.equal(view.ok, true)
  assert.equal(view.timeTag, SAMPLE.timeTag, 'timeTag 必须逐字节等于后端给的那一行')
  assert.equal(view.timeLightTag, SAMPLE.timeLightTag)
  assert.equal(view.season, '秋天')
  assert.equal(view.segmentText, '上午')
  assert.equal(view.weatherText, '多云、挺热', '空的风速不要留多余的顿号')
  assert.equal(view.castLine, '秋天 · 上午 · 多云、挺热')
  assert.equal(view.lightText, SAMPLE.lightText, '光线描述也是后端原文')
  assert.equal(view.characters.length, 2)
  assert.equal(view.awakeCount, 1)
  assert.equal(view.sleepingCount, 1)
  assert.match(view.countText, /共 2 个角色：1 个醒着 \/ 1 个在睡/)
})

test('感知预览：脏数据 / 空态不炸，也不编造', () => {
  const empty = perceptionViewModel(null)
  assert.equal(empty.ok, false)
  assert.equal(empty.timeTag, '')
  assert.deepEqual(empty.characters, [])
  assert.equal(empty.countText, '还没有角色')

  const dirty = perceptionViewModel({ timeTag: '  [x]  ', characters: 'nope', weather: 42, periodText: '' })
  assert.equal(dirty.ok, true)
  assert.equal(dirty.timeTag, '[x]', '两端空白可以裁，内容不许改')
  assert.deepEqual(dirty.characters, [])
  assert.equal(dirty.weatherText, '')

  // 角色条目缺字段：用状态兜一句话，不编日程
  const partial = perceptionViewModel({ timeTag: '[x]', characters: [{ id: 'a', isSleeping: true }] })
  assert.equal(partial.characters[0].name, '角色')
  assert.equal(partial.characters[0].awake, false)
  assert.equal(partial.characters[0].summary, '正在睡觉')
  assert.equal(partial.characters[0].id, null, '非数字 id 给 null，别塞 NaN')
})

test('角色状态文案：睡 / 刚被叫醒 / 小憩 / 醒着 四种口径', () => {
  assert.equal(characterPerceptionText({ isSleeping: true }), '正在睡觉')
  assert.equal(characterPerceptionText({ isTempWoken: true }), '刚被叫醒，睡眼惺忪')
  assert.equal(characterPerceptionText({ isNapping: true }), '正在小憩')
  assert.equal(characterPerceptionText({ sleepKind: 'nap' }), '正在小憩')
  assert.equal(characterPerceptionText({ activity: '在河堤散步' }), '醒着，在河堤散步')
  assert.equal(characterPerceptionText({}), '醒着')
})

test('天气文案：对象 / 字符串 / 缺失三种输入都能收敛', () => {
  assert.equal(weatherTextOf({ text: '小雨', temperature: '微凉', windSpeed: '微风' }), '小雨、微凉、微风')
  assert.equal(weatherTextOf('晴'), '晴')
  assert.equal(weatherTextOf(null), '')
  assert.equal(weatherTextOf({}), '')
})

// ── 3. 翻篇反馈 ───────────────────────────────────────────────────────────

test('翻篇反馈：程序日期变了才说"世界已翻篇"，同日调钟不喊狼来了', () => {
  const moved = rolloverNotice('2026-10-02', '2026-10-03')
  assert.equal(moved.changed, true)
  assert.equal(moved.phase, 'pending')
  assert.match(moved.text, /世界已翻篇/)
  assert.match(moved.text, /正在出当天的《邻舍日报》/)
  assert.match(moved.text, /2026年10月2日 → 2026年10月3日/)

  const sameDay = rolloverNotice('2026-10-02', '2026-10-02')
  assert.equal(sameDay.changed, false)
  assert.equal(sameDay.phase, 'unchanged')
  assert.ok(!sameDay.text.includes('世界已翻篇'), '同一天不许说翻篇')
  assert.match(sameDay.text, /不会重印/)

  const unknown = rolloverNotice('', '2026-10-03')
  assert.deepEqual(unknown, { phase: 'idle', changed: false, text: '' })
  assert.deepEqual(rolloverNotice(null, null), { phase: 'idle', changed: false, text: '' })
})

test('翻篇广播：来源翻成人话，认不出的来源原样透出（不猜）', () => {
  assert.equal(rolloverReasonText('advance'), '快进')
  assert.equal(rolloverReasonText('tick'), '时间自然流过午夜')
  assert.equal(rolloverReasonText('startup'), '启动补跑')
  assert.equal(rolloverReasonText('set'), '设定日期时间')
  assert.equal(rolloverReasonText('period'), '切换白天黑夜')
  assert.equal(rolloverReasonText('reset'), '回到真实时间')
  assert.equal(rolloverReasonText('something-new'), 'something-new')
  assert.equal(rolloverReasonText(undefined), '')

  const text = rolloverEventText({ from: '2026-10-02', to: '2026-10-03', reason: 'advance' })
  assert.match(text, /世界已翻篇/)
  assert.match(text, /2026年10月2日 → 2026年10月3日/)
  assert.match(text, /快进/)
  assert.match(text, /《邻舍日报》/)

  // 载荷不全也不炸
  assert.match(rolloverEventText({ to: '2026-10-03' }), /2026年10月3日/)
  assert.match(rolloverEventText(null), /世界已翻篇/)
  assert.match(rolloverEventText({ reason: 'tick' }), /时间自然流过午夜/)
})

test('等不到广播 / 阶段枚举：文案如实，阶段名固定', () => {
  assert.match(rolloverTimeoutText(), /还没收到翻篇广播/)
  assert.deepEqual([...ROLLOVER_PHASES], ['idle', 'pending', 'confirmed', 'timeout', 'unchanged'])
  // 面板用的阶段名必须都在枚举里（防止组件里写错一个字符串就静默失去样式）
  for (const phase of ['pending', 'confirmed', 'timeout', 'unchanged']) {
    assert.ok(ROLLOVER_PHASES.includes(phase))
  }
})

test('快捷推进天数：1 天与 7 天两个按钮共用一份常量', () => {
  assert.deepEqual([...QUICK_ADVANCE_DAYS], [1, 7])
})

// ── 4. 接口形状（mock fetch，不联网）──────────────────────────────────────

test('感知接口：GET /api/time/perception，只读且不带 body', async t => {
  const calls = []
  const response = body => ({ ok: true, status: 200, json: async () => body })
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (url, options = {}) => { calls.push({ url: String(url), options }); return response(SAMPLE) },
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'fetch', original)
    else delete globalThis.fetch
  })

  const { getTimePerception } = await import('../src/api/index.js')
  const result = await getTimePerception()
  assert.deepEqual(calls.map(c => c.url), ['/api/time/perception'])
  assert.equal(calls[0].options.method || 'GET', 'GET')
  assert.equal(calls[0].options.body, undefined, '只读接口不该带 body')
  assert.equal(result.timeTag, SAMPLE.timeTag)
  // 与面板口径一致：拿到的串原样进视图
  assert.equal(perceptionViewModel(result).timeTag, SAMPLE.timeTag)
})

test('感知接口错误翻译：功能关闭 / 后端还没接口 / 其它原样透出', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const reply = (status, body) => async () => ({ ok: false, status, json: async () => body })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'fetch', original)
    else delete globalThis.fetch
  })
  const { getTimePerception } = await import('../src/api/index.js')

  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: reply(409, { error: 'time control disabled' }) })
  await assert.rejects(() => getTimePerception(), /程序时间功能当前已关闭/)

  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: reply(404, {}) })
  await assert.rejects(() => getTimePerception(), /后端还没有时间感知接口/)

  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: reply(500, { error: 'database is locked' }) })
  await assert.rejects(() => getTimePerception(), /database is locked/)
})

// ── 5. 组件源码守卫（先剥注释）────────────────────────────────────────────

test('面板源码守卫：只用 Linshe 组件，没有裸控件', () => {
  const code = stripComments(PANEL)
  assert.equal(/<button[\s>]/.test(code), false, '不许裸 <button>')
  assert.equal(/<input[\s>]/.test(code), false, '不许裸 <input>')
  assert.equal(/<select[\s>]/.test(code), false, '不许裸 <select>')
  assert.equal(/<textarea[\s>]/.test(code), false, '不许裸 <textarea>')
  for (const component of ['LinsheButton', 'LinsheInput', 'LinsheModal', 'LinsheTabs']) {
    assert.ok(code.includes(`import ${component} from './ui/${component}.vue'`), `要用 ${component}`)
  }
})

test('面板源码守卫：0.3s 过渡（结果行 / 翻篇反馈 / 内容切换 / 弹窗由组件自己管）', () => {
  const code = stripComments(PANEL)
  assert.match(code, /\.tc-fade-enter-active[^{]*\{[^}]*transition:\s*opacity 0\.3s/, '结果与翻篇反馈要 0.3s 淡入淡出')
  assert.match(code, /\.tc-swap-enter-active[^{]*\{[^}]*0\.3s/, '感知预览两个视图之间要 0.3s 过渡')
  assert.ok(code.includes('<linshe-modal'), '精确设置走 LinsheModal（渐入渐出由组件负责）')
  assert.ok(code.includes('prefers-reduced-motion'), '要尊重"减少动效"偏好')
})

test('面板源码守卫：订阅翻篇广播 + 卸载退订 + 不靠轮询当唯一手段', () => {
  const code = stripComments(PANEL)
  assert.match(code, /import \{ onEvent \} from '\.\.\/stores\/unifiedStream\.js'/, '要走统一 SSE 订阅入口')
  assert.match(code, /onEvent\('program_day_rollover',\s*onProgramDayRollover\)/, '要订阅世界翻篇事件')
  assert.match(code, /onUnmounted\(\(\) => \{[\s\S]*?offRollover\(\)/, '卸载时要退订，别留悬挂监听')
  // 轮询只用于"钟跟着走"，且失败静默；翻篇状态由广播更新
  assert.match(code, /setInterval\(refreshQuiet, CLOCK_POLL_MS\)/, '世界钟刷新走静默轮询')
})

test('面板源码守卫：时间一律来自接口，面板里不许自己算', () => {
  const code = stripComments(PANEL)
  assert.equal(/new Date\(/.test(code), false, '面板不许自己取真实时间')
  assert.equal(/Date\.now\(/.test(code), false, '面板不许自己取时间戳（偏移只存在后端）')
  assert.ok(code.includes('perception.timeTag'), '要原样显示后端给的 prompt 时间串')
  assert.ok(code.includes('programTimeViewModel'), '世界钟展示走统一视图模型')
  assert.ok(code.includes('getTimePerception'), '感知预览走只读接口')
})

test('面板源码守卫：六个快捷操作齐全，翻篇文案不写死在组件里', () => {
  const code = stripComments(PANEL)
  assert.ok(code.includes('QUICK_ADVANCE_DAYS'), '推进 1 天 / 7 天由常量驱动，避免两处写死')
  assert.match(code, /跳到白天/)
  assert.match(code, /跳到黑夜/)
  assert.match(code, /精确设置日期时间/)
  assert.match(code, /回到真实时间/)
  assert.match(code, /推进这么多天/)
  assert.match(code, /clampAdvanceDays\(advanceDays\)/, '自定义天数要 clamp 后再发请求')
  assert.match(code, /@blur="normalizeAdvanceDays"/, '输入框失焦要把天数归一')
  // 文案收口在 logic：组件里不出现"世界已翻篇"，防止两份文案慢慢跑偏
  assert.equal(code.includes('世界已翻篇'), false, '翻篇文案只在 timeControlLogic.js 里')
  const logicCode = stripComments(LOGIC)
  assert.match(logicCode, /世界已翻篇/)
  assert.match(logicCode, /正在出当天的《邻舍日报》/)
})
