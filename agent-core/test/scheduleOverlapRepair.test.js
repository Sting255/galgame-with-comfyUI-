/**
 * 日程生成失败的**真机根因**与修复（2026-10-01）
 *
 * ## 用户反馈的现象
 * 日志（9MB 真机日志）里：
 * ```
 * [warn] [scheduleGen] JSON parse failed for 三月七        ×3
 * [warn] [scheduleGen] Validation failed for 三月七
 * [error] [replyQueue] Schedule refresh failed for 三月七: Failed to generate valid schedule for 三月七 after 2 attempts
 * ```
 * 当时的结论是"证据不足"——因为日志把 LLM 返回体**静默截断到 ~320 字符且不加标记**，
 * 成功样本与失败样本看起来停在同一位置，无法判断根因。
 *
 * ## 这次把证据拿到了（对着真实 LLM 复现）
 * 先补上失败回显（`parseAndValidateSchedule` 现在会打带长度标记的预览，`SCHEDULE_GEN_DUMP=1` 出全文），
 * 然后把 8 个角色各跑一遍，**当场抓到一条失败样本**：
 * ```
 * [scheduleGen] Overlapping activities for 德丽莎·阿波卡利斯: "深夜学生宿舍巡查" and "就寝安眠"
 * 原始输出：{ "startTime": "00:00", "endTime": "05:00", "activity": "深夜学生宿舍巡查" … }
 * ```
 * 模型同时排了「00:00→05:00 深夜巡查」**和**一个跨零点的睡眠块（如 22:00→07:00）——
 * 两段在真实时间里重叠（深夜巡查整段被睡眠盖住）。**校验器拒绝得没错，错的是靠重试碰运气**：
 * 8 个角色跑一轮，4 次失败里 3 次被第二次尝试救回来，剩下那次就是用户看到的失败。
 *
 * ## 修法（本文件钉住的三条）
 * 1. **确定性修复**：睡眠块优先，把被它盖住的非睡眠分钟裁掉。裁掉的每一分钟都仍在睡眠块里
 *    ⇒ **24 小时覆盖不变**（只做减法，不可能造出新空档）；没冲突时**逐字节返回原数组**。
 * 2. **prompt 补规则**：跨零点的睡眠块已覆盖零点之后，禁止再排与之重叠的活动，并给出两种合法写法。
 * 3. **max_tokens 2048 → 4096**：实测 14~16 段输出已到 1500+ tokens / 5000+ 字符，话多的角色会顶到上限被截断
 *    ——那正是 `JSON parse failed` 的另一种来源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-sched-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { parseAndValidateSchedule, repairScheduleOverlaps } = await import('../src/services/scheduleGenerator.js')

/** 真机失败样本的结构：00:00→05:00 深夜巡查 + 22:00→07:00 跨零点睡眠（去掉巡查后的合法形） */
const ACT = (startTime, endTime, activity, replyDelay = 0) => ({
  startTime, endTime, activity,
  location: '宿舍', replyDelay,
  description: '三月七在夜里慢慢做完这件事，灯光昏黄，动作轻而慢。',
})

/** 把日程拼成 LLM 的原始 JSON 输出（json_object 模式） */
const asRaw = (activities) => JSON.stringify({ activities })

/** 各段时长之和（>1440 就说明必然存在重叠——这是与"校验器怎么看"无关的客观证据） */
function totalMinutes(activities) {
  return activities.reduce((sum, a) => {
    const [sh, sm] = a.startTime.split(':').map(Number)
    const [eh, em] = a.endTime.split(':').map(Number)
    let s = sh * 60 + sm
    let e = eh * 60 + em
    if (e <= s) e += 1440
    return sum + (e - s)
  }, 0)
}

test('★ 真机失败样本：跨零点睡眠块与深夜活动重叠 → 修复后通过（不再靠重试）', () => {
  const broken = [
    ACT('00:00', '05:00', '深夜学生宿舍巡查'),          // ← 与下面睡眠块重叠的元凶
    ACT('05:00', '07:00', '清晨洗漱与早课准备'),
    ACT('07:00', '12:00', '上午课程'),
    ACT('12:00', '13:00', '午饭'),
    ACT('13:00', '18:00', '下午课程与社团'),
    ACT('18:00', '22:00', '晚饭、整理照片'),
    ACT('22:00', '07:00', '就寝安眠', -1),               // 跨零点睡眠：盖住 00:00~05:00
  ]
  // 客观证据：各段时长之和 1500 > 1440 ⇒ 必然重叠（与校验器实现无关）
  assert.ok(totalMinutes(broken) > 1440, '夹具本身必须真的重叠')

  const repaired = repairScheduleOverlaps(broken)
  assert.notEqual(repaired, broken, '有冲突时要返回新数组')
  // 睡眠块是 22:00→07:00，所以 00:00~07:00 里的**两段**（深夜巡查、清晨洗漱）都被它盖住 ⇒ 7 → 5 段
  assert.equal(repaired.length, broken.length - 2, '落在睡眠窗口里的段都要被丢掉')
  assert.ok(repaired.some(a => a.replyDelay === -1), '睡眠块必须保留')
  assert.equal(repaired.some(a => a.activity === '深夜学生宿舍巡查'), false, '重叠段要删掉')
  assert.equal(repaired.some(a => a.activity === '清晨洗漱与早课准备'), false, '同样落在睡眠窗口里的段也要删掉')
  assert.equal(totalMinutes(repaired), 1440, '修复后总时长必须正好是 24 小时（覆盖不变性）')

  // 校验器里已经接了修复，所以从外面看是"直接通过"；这里同时确认结果里没有重叠段
  const ok = parseAndValidateSchedule(asRaw(broken), '德丽莎')
  assert.ok(ok, '带这类冲突的输出要能通过（靠修复，不再靠重试碰运气）')
  assert.equal(ok.some(a => a.activity === '深夜学生宿舍巡查'), false, '校验结果里不该再有那段巡查')
  assert.equal(ok.some(a => a.replyDelay === -1), true, '睡眠块仍要在')
})

test('覆盖不变性：修复只做减法，24 小时覆盖与无重叠都要成立', () => {
  const cases = [
    // 睡眠夹在某段内部（应把该段切成相邻两段）
    [ACT('00:00', '10:00', '通宵打游戏'), ACT('02:00', '06:00', '补觉', -1),
     ACT('10:00', '18:00', '白天活动'), ACT('18:00', '24:00', '晚上活动')],
    // 睡眠跨零点且与非睡眠段部分重叠
    [ACT('00:00', '03:00', '剪视频'), ACT('03:00', '09:00', '睡觉', -1),
     ACT('09:00', '20:00', '白天活动'), ACT('20:00', '24:00', '夜间活动')],
  ]
  for (const [i, activities] of cases.entries()) {
    const repaired = repairScheduleOverlaps(activities)
    // 逐分钟核对：修复后恰好覆盖 0~1440 且无重叠
    const mask = new Uint8Array(1440)
    for (const a of repaired) {
      let s = Number(a.startTime.slice(0, 2)) * 60 + Number(a.startTime.slice(3, 5))
      let e = Number(a.endTime.slice(0, 2)) * 60 + Number(a.endTime.slice(3, 5))
      if (e <= s) e += 1440
      for (let m = s; m < e; m++) {
        const idx = m % 1440
        assert.equal(mask[idx], 0, `用例 ${i}：第 ${idx} 分钟被两段覆盖（重叠）`)
        mask[idx] = 1
      }
    }
    for (let m = 0; m < 1440; m++) assert.equal(mask[m], 1, `用例 ${i}：第 ${m} 分钟没人覆盖（空档）`)
  }
})

test('干净日程逐字节不变（修复不许动它）', () => {
  const clean = [
    ACT('00:00', '07:00', '就寝安眠', -1),
    ACT('07:00', '09:00', '晨间梳洗'),
    ACT('09:00', '12:00', '上午活动'),
    ACT('12:00', '14:00', '午饭与休息'),
    ACT('14:00', '18:00', '下午活动'),
    ACT('18:00', '22:00', '晚间活动'),
    ACT('22:00', '24:00', '睡前的安静时间'),
  ]
  assert.equal(totalMinutes(clean), 1440, '夹具本身必须是完整 24 小时')
  assert.equal(repairScheduleOverlaps(clean), clean, '没有冲突时必须返回同一个数组引用')
  assert.ok(parseAndValidateSchedule(asRaw(clean), '干净'), '干净日程必须直接通过')
})

test('没有睡眠块 / 空输入：原样返回（不制造副作用）', () => {
  const empty = []
  assert.equal(repairScheduleOverlaps(empty), empty, '空数组要原样返回同一个引用')
  assert.equal(repairScheduleOverlaps(null), null)
  const noSleep = [ACT('00:00', '12:00', 'A'), ACT('12:00', '24:00', 'B')]
  assert.equal(repairScheduleOverlaps(noSleep), noSleep, '没有睡眠块就没有可修复的东西')
})

test('真正无法修复的情形仍然失败（修复不是"什么都放行"）', () => {
  // 两段非睡眠活动互相重叠 ⇒ 不是本修复的目标，必须继续判死
  const overlapping = [
    ACT('00:00', '10:00', 'A'), ACT('05:00', '12:00', 'B'),
    ACT('12:00', '20:00', 'C'), ACT('20:00', '24:00', 'D'),
    ACT('24:00', '24:00', 'X', -1),
  ]
  assert.equal(parseAndValidateSchedule(asRaw(overlapping), '无解'), null)
})

test('源码级：prompt 有跨零点规则、max_tokens 已提到 4096、失败会回显原文', () => {
  const src = fs.readFileSync(new URL('../src/services/scheduleGenerator.js', import.meta.url), 'utf8')
  assert.match(src, /跨零点睡眠块（极容易出错，务必照做）/, 'prompt 要写清跨零点规则')
  assert.match(src, /禁止再安排任何与它重叠的活动/, '要明确禁止重复覆盖')
  assert.match(src, /max_tokens: 4096/, 'max_tokens 要够长（2048 会截断话多角色的输出）')
  assert.match(src, /原始输出预览/, '失败必须回显原始输出（否则又是"证据不足"）')
  assert.match(src, /SCHEDULE_GEN_DUMP/, '要有出全文的开关')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
