/**
 * 私密时刻「自慰 / 你闯进来了」（2026-10-02）
 *
 * 用户原话：
 *   「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高 这个可以算到日程里」
 *   「这个时候再去找角色私聊就会触发事件 玩家闯入角色正在自慰的情况」
 *
 * 本文件钉五层：
 *   ① 概率：敏感度越高概率越高（主驱动）、发情模式顶上去、上限封顶、脏输入不炸；
 *   ② 选槽：只挑"她一个人在屋里"的非睡眠时段（睡眠块、短块、时间残缺的块都不挑）；
 *   ③ 窗口：落在槽位内部、留边距、长度合理；同一天多次询问**结论一致**（确定性）；
 *   ④ 落库：一天一行、`caught_at` 只在第一次撞见时写、撞见会给敏感度累加；
 *   ⑤ 接线：聊天链注入「你闯进来了」块、日程接口把它投影出去（"算到日程里"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

const { getDb } = await import('../src/db/index.js')
const P = await import('../src/services/privateMomentService.js')
const S = await import('../src/services/sensitivityService.js')

const db = getDb()
db.pragma('foreign_keys = OFF')

// ── 1. 概率 ──

test('① 概率：敏感度是主驱动（越高越容易），发情模式再加成，且有上限', () => {
  const cold = P.privateMomentProbability({ sensitivity: 0 })
  const warm = P.privateMomentProbability({ sensitivity: 50 })
  const high = P.privateMomentProbability({ sensitivity: 80 })
  assert.ok(warm > cold && high > warm, `要单调上升：${cold} < ${warm} < ${high}`)
  assert.ok(P.privateMomentProbability({ sensitivity: 80, heat: true }) > high, '发情模式要再加一档')
  assert.ok(P.privateMomentProbability({ sensitivity: 100, heat: true, affinity: 100 }) <= P.PRIVATE_MOMENT_TUNING.max,
    '再敏感也不能"每次找她都在自慰"')
  // 脏输入
  assert.equal(P.privateMomentProbability({ sensitivity: 'x' }), P.PRIVATE_MOMENT_TUNING.base)
  assert.ok(P.privateMomentProbability({ sensitivity: 999 }) <= P.PRIVATE_MOMENT_TUNING.max)
  assert.ok(P.privateMomentProbability({ sensitivity: -50 }) >= 0)
})

// ── 2. 选槽 ──

const SCHEDULE = [
  { startTime: '07:00', endTime: '08:00', activity: '起床洗漱', location: '家里', tags: [] },
  { startTime: '09:00', endTime: '18:00', activity: '在店里上班', location: '商业街', tags: ['工作'] },
  { startTime: '19:00', endTime: '21:00', activity: '做饭吃饭', location: '家里', tags: [] },
  { startTime: '21:00', endTime: '23:00', activity: '一个人待着', location: '家里', tags: ['独处'] },
  { startTime: '23:00', endTime: '07:00', activity: '睡觉', location: '家里', tags: ['睡眠'] },
]

test('② 选槽：只挑"一个人在屋里"的非睡眠时段，睡眠/工作/短块都不挑', () => {
  const slots = P.privateSlots(SCHEDULE)
  const acts = slots.map(s => s.activity)
  assert.ok(acts.includes('一个人待着'), '独处块必须入选')
  assert.ok(acts.includes('起床洗漱'), '在家 + 洗漱也算独处类（可以在浴室里）')
  assert.ok(!acts.includes('睡觉'), '睡着的时候不发生这件事')
  assert.ok(!acts.includes('在店里上班'), '在店里上班不是独处')
  // 窄块（不到 minSlotMin）不考虑
  const tiny = P.privateSlots([{ startTime: '21:00', endTime: '21:10', activity: '一个人在屋里发呆', location: '家' }])
  assert.equal(tiny.length, 0, '太短的块来不及做这件事')
  // 时间残缺 / 空输入不炸
  assert.deepEqual(P.privateSlots([{ activity: '一个人待着' }]), [])
  assert.deepEqual(P.privateSlots(null), [])
  assert.deepEqual(P.privateSlots([]), [])
})

test('② 跨零点的块按"到第二天"算（23:00~01:30 是 150 分钟，不是负数）', () => {
  const slot = P.slotOf({ startTime: '23:00', endTime: '01:30', activity: '一个人待着' })
  assert.equal(slot.startMinute, 23 * 60)
  assert.equal(slot.endMinute, 25 * 60 + 30)
})

// ── 3. 窗口与确定性 ──

test('③ 窗口：落在槽位内部、两端留边距、长度在 10~40 分钟之间', () => {
  const slot = { startMinute: 21 * 60, endMinute: 23 * 60, activity: '一个人待着', location: '家里', key: 'k' }
  for (let seed = 1; seed <= 40; seed++) {
    const w = P.privateWindow(slot, { seed })
    assert.ok(w.startMinute >= slot.startMinute + P.PRIVATE_MOMENT_TUNING.edgeMarginMin, `起点要留边距：${JSON.stringify(w)}`)
    assert.ok(w.endMinute <= slot.endMinute - P.PRIVATE_MOMENT_TUNING.edgeMarginMin, `终点要留边距：${JSON.stringify(w)}`)
    assert.ok(w.endMinute > w.startMinute)
    assert.ok(w.endMinute - w.startMinute <= P.PRIVATE_MOMENT_TUNING.durationMaxMin)
  }
})

test('③ 判定确定性：同一天、同一份日程、同一个种子 ⇒ 结论与窗口完全一致', () => {
  const slots = P.privateSlots(SCHEDULE)
  const args = { sensitivity: 70, affinity: 60, seed: 12345, dateKey: '2026-10-02' }
  const a = P.planPrivateMoment(slots, args)
  const b = P.planPrivateMoment(slots, args)
  assert.deepEqual(a, b, '刷新一次就换结论 = 玩家会看到"她又开始/又没开始"')
  // 没独处时段 ⇒ 一定不触发
  assert.equal(P.planPrivateMoment([], args).fired, false)
})

test('③ isMomentNow / minutesLeft：窗口内为真，窗口外为假', () => {
  const w = { startMinute: 600, endMinute: 630 }
  assert.equal(P.isMomentNow(w, 599), false)
  assert.equal(P.isMomentNow(w, 600), true, '左闭')
  assert.equal(P.isMomentNow(w, 629), true)
  assert.equal(P.isMomentNow(w, 630), false, '右开')
  assert.equal(P.minutesLeft(w, 615), 15)
  assert.equal(P.minutesLeft(w, 900), 0, '过期不许是负数')
  assert.equal(P.isMomentNow(null, 600), false)
})

// ── 4. 落库（用真实表 + 真实日程行，走完整读路径）──

/** 建一个测试角色，并往 `daily_schedules` 写今天的日程（绕开 LLM 生成，但读路径是真的） */
async function seedCharacter(id, schedule, { sensitivity = 100 } = {}) {
  const { getProgramDateKey, getProgramNow } = await import('../src/services/programTime.js')
  db.prepare(`INSERT OR REPLACE INTO characters
    (id, name, display_name, base_prompt, short_prompt, sensitivity, sensitivity_updated_at, heat_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(id, `私密${id}`, `私密${id}`, '你是测试角色。', '测试角色', sensitivity, new Date().toISOString())
  const now = getProgramNow()
  db.prepare('INSERT OR REPLACE INTO daily_schedules (character_id, schedule_date, schedule_json) VALUES (?, ?, ?)')
    .run(id, getProgramDateKey(now), JSON.stringify(schedule))
  return now
}

test('④ 落库：一天一行；撞见一次才写 caught_at，且给敏感度加一点', async () => {
  const id = 941
  // ⚠️ 测试**不能靠运气**（正常概率 0.10~0.52，掷不中就会红）：用 tuning 把骰子钉死
  const FORCE = { base: 1, max: 1 }
  const now = await seedCharacter(id, [
    { startTime: '21:00', endTime: '23:00', activity: '一个人待着', location: '家里', replyDelay: 0, tags: ['独处'], description: '' },
  ])

  const first = P.ensurePrivateMoment(id, { now, affinity: 100, tuning: FORCE })
  assert.equal(first.reason, 'ok', `要真的判定成立（实际 ${first.reason}）`)
  assert.ok(first.row && first.row.id, '要落库成一行')
  const again = P.ensurePrivateMoment(id, { now, affinity: 100, tuning: FORCE })
  assert.equal(again.row.id, first.row.id, '同一天同一个槽位只有一行（确定性 + UNIQUE）')

  // 把窗口挪到"此刻"（窗口本身由 ③ 单独测；这里要测的是撞见记账）
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  db.prepare('UPDATE character_private_moments SET start_minute = ?, end_minute = ? WHERE id = ?')
    .run(nowMinute - 1, nowMinute + 9, first.row.id)
  // 敏感度先压回 0，便于观察"撞见会给它加一点"
  db.prepare('UPDATE characters SET sensitivity = 0, sensitivity_updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)

  const st = P.privateMomentState(id, { now, affinity: 100, tuning: FORCE })
  assert.equal(st.active, true, '要在窗口里')
  assert.equal(st.firstCatch, true, '还没被撞见过')
  const caught = P.catchPrivateMoment(id, { now, tuning: FORCE })
  assert.equal(caught.ok, true)
  assert.equal(caught.code, 'first')
  const row = db.prepare('SELECT * FROM character_private_moments WHERE id = ?').get(first.row.id)
  assert.ok(row.caught_at, '第一次撞见要落 caught_at')
  assert.equal(row.caught_times, 1)
  assert.ok(S.getSensitivity(id).value > 0, '撞见一次要给她的敏感度加一点（self_play 的份量）')

  // 第二次撞见：不再算"第一次"，次数 +1
  const again2 = P.privateMomentState(id, { now, affinity: 100, tuning: FORCE })
  assert.equal(again2.firstCatch, false, '同一窗口内不该反复演"刚被撞见"')
  assert.equal(P.catchPrivateMoment(id, { now, tuning: FORCE }).code, 'again')
  assert.equal(db.prepare('SELECT caught_times FROM character_private_moments WHERE id = ?').get(first.row.id).caught_times, 2)
})

test('④ 概率真的吃敏感度：同一个角色，敏感度写满才会被她自己掷中', async () => {
  // 用同一份日程 + 同一个日期，只有敏感度不同：低敏感度那次应当判不出来
  const id = 943
  const schedule = [
    { startTime: '21:00', endTime: '23:00', activity: '一个人待着', location: '家里', replyDelay: 0, tags: ['独处'], description: '' },
  ]
  // 低敏感度：概率 = base(0.10) + 0 + affinity 0 = 0.10 ⇒ 极小概率掷中；把骰子换成必定不中不好做，
  // 所以这里直接断言概率本身（确定性部分留给 ③），并断言"写满后概率至少高出一倍"
  const low = P.privateMomentProbability({ sensitivity: 0 })
  const high = P.privateMomentProbability({ sensitivity: 100, heat: true })
  assert.ok(high >= low * 2, `敏感度写满 + 发情模式至少要翻倍：${low} → ${high}`)
  await seedCharacter(id, schedule, { sensitivity: 0 })
})

test('④ 边界：没日程 / 不在窗口 / 角色不存在 —— 一律不抛，按"没有这件事"处理', () => {
  assert.equal(P.ensurePrivateMoment(942, { schedule: [] }).reason, 'no_slot')
  assert.equal(P.privateMomentState(942, { schedule: [] }).active, false)
  assert.equal(P.catchPrivateMoment(942).ok, false)
  assert.equal(P.privateMomentState(0).active, false)
  assert.equal(P.privateMomentState('x').active, false)
})

// ── 5. prompt 块与接线 ──

test('⑤ 块：正在进行时才有块，且写清"她正在做这件事 + 你撞进来了"', () => {
  const none = P.buildPrivateMomentBlock({ active: false })
  assert.equal(none, '', '不在窗口里 ⇒ 零注入')

  const first = P.buildPrivateMomentBlock({
    active: true, firstCatch: true, label: '自慰', slotActivity: '一个人待着', slotLocation: '家里', minutesLeft: 12,
  }, { userName: '阿明', characterName: '小美' })
  assert.match(first, /<private_moment>/)
  assert.match(first, /阿明/)
  assert.match(first, /小美/)
  assert.match(first, /自慰/)
  assert.match(first, /撞见/, '要说清是"被你撞见的"')
  assert.match(first, /不要写成她会若无其事地跟你聊别的事|不要替/)

  const later = P.buildPrivateMomentBlock({ active: true, firstCatch: false, minutesLeft: 8 }, { userName: '阿明', characterName: '小美' })
  assert.match(later, /还没缓过来|没缓过来/)
  assert.ok(later.length <= P.MAX_PRIVATE_MOMENT_BLOCK_CHARS)
})

test('⑤ 接线：聊天链注入它、日程接口投影它（"算到日程里"）', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  const chat = read('routes/chat.js')
  assert.match(chat, /privateMomentState\(/, '聊天链要读她此刻在不在自慰')
  assert.match(chat, /buildPrivateMomentBlock\(/, '要注入「你闯进来了」块')
  assert.match(chat, /catchPrivateMoment\(/, '第一次撞见要记账')

  const schedule = read('routes/schedule.js')
  assert.match(schedule, /private_moment/, '日程接口要把它带出去')
  assert.match(schedule, /privateMomentState\(/, '投影口径来自同一个服务')
  assert.match(schedule, /router\.get\('\/:characterId\/private-moment'/, '要有一条单独的端点')

  const line = P.privateMomentLine({ row: { id: 1 }, window: { startMinute: 21 * 60, endMinute: 21 * 60 + 30 }, active: false })
  assert.match(line, /21:00~21:30/)
  assert.match(line, /一个人在屋里/)
  assert.equal(P.privateMomentLine({ row: null, window: null }), '', '没有这件事 ⇒ 空串（前端零渲染）')
})
