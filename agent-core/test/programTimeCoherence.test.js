/**
 * 角色感受到的时间：一钟到底（2026-10-01，用户"角色感受到的时间很混乱 / 调时开关没什么作用"）
 *
 * ## 这一轮修了什么（都有真实日志证据）
 * 1. **双重偏移**（`timeLight.js`）：每个非叶子函数先 `resolveNow(now)`（真实瞬间 → 程序时间，加一次偏移），
 *    又调内部**还会 resolve 一次**的 `getTimeLight(now)` ⇒ 时段标签与天气钟点被加了两遍偏移。
 *    日志逐字：`[2026-10-02 周五 08:56 | 秋天·深夜]` —— 08:56 + 13h17m = 22:13 ⇒ 落进「深夜」区间。
 *    修法：抽出不解析的纯函数 `pickTimeLight(date)`，resolve 全程只做一次。
 * 2. **两套基准**（`proactiveChatScheduler.js`）：主动聊天 prompt 的 `【当前时间】` 用 `new Date()`（真实时间），
 *    而群聊 `<time_context>` 用程序时间。日志逐字：同一现实分钟里
 *    群聊 `[2026-10-02 周五 09:19 | …]` vs 主动聊天 `周四 10月1日 19:47`。
 *    修法：改吃 `getProgramNow()`；兜底问候语的时段分组也一起吃程序时间。
 * 3. **日报跟真实日期走**（`newspaperService.js`）：`getTodayNewspaper()` 用 `getLocalDateKey()` ⇒
 *    时间推到明天后新的一天没有报纸。修法：全文件 6 处日期口径统一换成 `getProgramDateKey()`。
 * 4. **世界翻篇**（`programDayRollover.js`）：程序日期变了就自动跑日常任务（日报 / 记忆整理），
 *    手动调时立即触发、tick 覆盖自然跨零点、启动补一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-progtime-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const timeLight = await import('../src/services/timeLight.js')
const programTime = await import('../src/services/programTime.js')
const rollover = await import('../src/services/programDayRollover.js')
const { getDb } = await import('../src/db/index.js')

const readSrc = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('① 双重偏移已修：时段标签与时刻串必须来自同一个钟点', () => {
  // 复现日志那一次：程序时间被拨快 13h17m，块里该显示「程序 08:56」，而修复前时段按 22:13 判成「深夜」。
  // 输入必须是"真实瞬间"（调用方 chatTimeContext 的约定：程序时间减掉偏移再喂进来）。
  const offsetMs = 13 * 3600000 + 17 * 60000
  const programTarget = new Date(2026, 9, 1, 8, 56, 0) // 本地 08:56 的**程序时间**
  const asReal = new Date(programTarget.getTime() - offsetMs)
  programTime.resetProgramTime()
  programTime.setProgramOffsetMs(offsetMs)
  try {
    const tag = timeLight.getTimeTag(asReal, false)
    assert.match(tag, /08:56/, `时刻串应是程序时间 08:56：${tag}`)
    assert.equal(/深夜|凌晨|晚上/.test(tag), false, `上午 08:56 不能出现夜间时段：${tag}`)
    assert.match(tag, /上午/, `08:56 应落在「上午」：${tag}`)

    const light = timeLight.getTimeLight(asReal)
    assert.equal(light.hour, 8, 'getTimeLight 的钟点必须是程序时间的 8 点（不能是 22）')
    assert.equal(tag.includes(light.timeDesc), true, 'getTimeTag 的时段必须与 getTimeLight 完全一致')
    // 修复前的病征：时段取的是"加两遍偏移"的 22:13
    assert.equal(light.timeDesc !== '深夜', true, '修复后不能再判成深夜')
  } finally {
    programTime.resetProgramTime()
  }
})

test('② 公共 API 形状不变：外部仍可传真实瞬间 / 传程序时间（chatTimeContext 的减法约定）', () => {
  programTime.resetProgramTime()
  const local1100 = new Date(2026, 9, 1, 11, 0, 0)
  assert.match(timeLight.getTimeTag(local1100, false), /11:00/, '偏移为 0：传入即所得')

  const offsetMs = 5 * 3600000
  programTime.setProgramOffsetMs(offsetMs)
  try {
    assert.match(timeLight.getTimeTag(local1100, false), /16:00/, '偏移 +5h：真实 11:00 ⇒ 程序 16:00')
    // chatTimeContext 的做法：程序时间减掉偏移再喂进来 ⇒ 得到的就是程序时间本身
    const programNow = programTime.getProgramNow()
    const asReal = new Date(programNow.getTime() - offsetMs)
    assert.equal(timeLight.getTimeLight(asReal).hour, programNow.getHours(), '与 getProgramNow 的钟点一致')
  } finally {
    programTime.resetProgramTime()
  }
})

test('③ 单聊主动聊天的【当前时间】不再用真实时间（两套基准的根源）', () => {
  const src = readSrc('services/proactiveChatScheduler.js')
  assert.match(src, /import \{[^}]*getProgramNow[^}]*\} from '\.\/programTime\.js'/, '要导入 getProgramNow')
  assert.match(src, /\$\{formatProactiveClock\(getProgramNow\(\)\)\}/, '【当前时间】要用程序时间格式化')
  // ⚠️ 只查**代码行**：注释里为了解释历史 bug 会提到 `new Date()`（第一版测试就是被自己的注释绊倒的）
  const offenderLines = src.split('\n').filter(line => {
    const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')
    return code.includes('【当前时间】') && code.includes('new Date()')
  })
  assert.deepEqual(offenderLines, [], '【当前时间】所在代码行不许再出现 new Date()')
  // 兜底问候语的时段分组同理
  assert.match(src, /function pickFallbackGreeting\(userName\) \{[\s\S]{0,400}getProgramNow\(\)\.getHours\(\)/, '兜底问候语按时段分组也要用程序时间')
  // 格式化输出与修复前同形（周几 几月几日 HH:mm）
  const m = src.match(/function formatProactiveClock\(date\) \{([\s\S]*?)\n\}/)
  assert.ok(m, 'formatProactiveClock 必须存在')
  assert.match(m[1], /月/, '格式里要有"月"')
  assert.match(m[1], /padStart\(2, '0'\)/, 'HH:mm 要补零')
})

test('④ 日报跟着程序日期走（日期翻篇 = 新一期报纸）', () => {
  const src = readSrc('services/newspaperService.js')
  assert.equal(
    /getLocalDateKey/.test(src), false,
    '日报不许再用真实日期 getLocalDateKey（6 处口径全换成程序日期）'
  )
  assert.match(src, /getProgramDateKey\(\)/, '要用程序日期')
  assert.match(src, /maybeGenerateDailyNewspaper\(now = getProgramNow\(\)\)/, '生成时点判断也吃程序时间')
})

test('⑤ 世界翻篇：程序日期变了才跑任务，同一天重复调用是空操作', async () => {
  getDb() // 初始化内存库（system_settings 就位）
  const calls = []
  const jobs = [{ name: 'fake_newspaper', run: async () => { calls.push('newspaper') } }]

  // 首次：只记录基准，不补跑历史任务
  rollover.setLastProcessedProgramDate('2026-10-01')
  const same = await rollover.runProgramDayRollover({ reason: 'test', today: '2026-10-01', jobs })
  assert.equal(same.ran, false, '同一天不该触发')
  assert.deepEqual(calls, [], '同一天不该跑任务')

  const next = await rollover.runProgramDayRollover({ reason: 'test', today: '2026-10-02', jobs })
  assert.equal(next.ran, true, '日期变了要触发')
  assert.deepEqual(calls, ['newspaper'], '任务跑了一次')
  assert.equal(rollover.getLastProcessedProgramDate(), '2026-10-02', '处理过的日期要落库')

  await rollover.runProgramDayRollover({ reason: 'test', today: '2026-10-02', jobs })
  assert.deepEqual(calls, ['newspaper'], '同一天再触发是空操作（幂等）')

  // 回拨也算翻篇（否则"回到昨天"看不到昨天那一期）
  await rollover.runProgramDayRollover({ reason: 'test', today: '2026-10-01', jobs })
  assert.deepEqual(calls, ['newspaper', 'newspaper'], '回拨也要触发')
})

test('⑥ 世界翻篇：单个任务失败不拖垮其它任务，且失败会被记录', async () => {
  getDb()
  rollover.setLastProcessedProgramDate('2026-10-05')
  const ran = []
  const res = await rollover.runProgramDayRollover({
    reason: 'test',
    today: '2026-10-06',
    jobs: [
      { name: 'boom', run: async () => { throw new Error('LLM 挂了') } },
      { name: 'ok', run: async () => { ran.push('ok') } },
    ],
  })
  assert.equal(res.ran, true)
  assert.deepEqual(ran, ['ok'], '前一个任务抛异常，后一个必须照跑')
  assert.equal(res.jobs[0].ok, false)
  assert.match(res.jobs[0].error, /LLM 挂了/)
  assert.equal(res.jobs[1].ok, true)
})

test('⑦ 三个触发点都在（手动调时立即 / tick 自然跨零点 / 启动补一次）', () => {  const tc = readSrc('services/timeControl.js')
  for (const reason of ['advance', 'set', 'period', 'reset']) {
    assert.match(tc, new RegExp(`scheduleDayRollover\\('${reason}'\\)`), `调时 ${reason} 之后要立即触发翻篇`)
  }
  assert.match(tc, /runProgramDayRollover\(\{ reason \}\)/, 'scheduleDayRollover 要真的调 runProgramDayRollover')
  const rq = readSrc('services/replyQueueScheduler.js')
  assert.match(rq, /runProgramDayRollover\(\{ reason: 'tick' \}\)/, 'tick 要检查翻篇（覆盖自然跨零点）')
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  assert.match(app, /runProgramDayRollover\(\{ reason: 'startup' \}\)/, '启动要补一次（覆盖关机跨天）')
})

test('⑧ 调时要留下可追溯的状态快照（第八轮日志取证的结论：这是观测盲区）', () => {
  // 真机日志里 `timeOffset/timeScale/程序时间/OFFSET` 全文 0 命中、`[timeControl]` 只有 3 行且只有"设到几点"
  // ⇒ 用户报的"调时开关没什么作用"当时**无法定罪**。所以每次调时都要打一行能直接读出来的快照。
  const tc = readSrc('services/timeControl.js')
  assert.match(tc, /function logTimeStateChange\(reason, applied\)/, '要有统一的状态快照函数')
  for (const [reason, label] of [['快进', 'advance'], ['切到白天', 'period'], ['设到', 'set'], ['重置回真实时间', 'reset']]) {
    assert.match(tc, new RegExp(`logTimeStateChange\\([^)]*${reason}[^)]*\\)`), `${label} 之后要打快照`)
  }
  // 快照内容必须含：程序日期/时刻、第几天、时段、**偏移量**（这正是当年 0 命中的那个值）
  for (const needle of ['程序时间', '第 ${s.dayIndex} 天', '偏移 ', '推进 ', '同步 ']) {
    assert.match(tc, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `快照要含「${needle}」`)
  }
  // 日志失败绝不能影响调时本身
  assert.match(tc, /catch \(err\) \{[\s\S]{0,120}状态快照日志失败（不影响调时）/, '日志要自己吞异常')
  // 角色数必须渲染成**数字**：`applied.characters` 是数组，第一版直接拼模板 ⇒ 真链路日志里打出
  // `同步 [object Object],[object Object]…`（我在真链路验证时抓到的）
  assert.match(tc, /Array\.isArray\(applied\?\.characters\) \? applied\.characters\.length/, '数组要取 length')
  assert.equal(/同步 \$\{applied\.characters\}/.test(tc), false, '不许把数组直接插进模板')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
