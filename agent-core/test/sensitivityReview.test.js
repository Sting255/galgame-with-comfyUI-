/**
 * 敏感度系统的**复查**（2026-10-03 用户问「有没有逻辑漏洞」之后逐条查出来的洞）
 *
 * 四个洞，本文件逐条钉死：
 *  ① **发情模式到点没人写回**：`heatActive` 到点返回 false，但读路径只读不写 ⇒ 库里躺着 100，
 *     而衰减 0.125/小时 ⇒ 要 **360 小时（15 天）**才掉到 55。2 小时的发情变成半个月的"极度敏感"。
 *  ② **关掉发情会把真实值砍掉**：原来一律 `min(当前, 55)`；她本来就 80 的话，开关一次就没了。
 *  ①+② 的修法：开的时候把发情前的值存进 `sensitivity_before_heat`，结束（手动关 / 自然到点）时还给她。
 *  ③ **「缓慢累加」没有闸门**：推进一下 +0.5，而"自动插入"是服务端定时器在推 ——
 *     冲刺档 1.5 秒一下 = **每分钟 +20**，五分钟顶满；手点连点同理 ⇒ 与"发情模式直接拉满"没区别。
 *     修法：性相关来源 15 秒内只记一次（高潮不受限）+ 每天最多 +20（跨日归零）。
 *  ④ **退出来之后自动还在**：`stop` 不清 auto ⇒ 胶囊还亮着，他一"进入"她就自己动起来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const S = await import('../src/services/sensitivityService.js')
const { getDb } = await import('../src/db/index.js')

const db = getDb()
const CID = 9001

/** 造一个角色（`base_prompt` 是 NOT NULL 且没有默认值 ⇒ 必须给，否则 INSERT OR IGNORE 会静默不插） */
function seed(id = CID) {
  db.prepare(`INSERT OR REPLACE INTO characters (id, name, display_name, base_prompt)
              VALUES (?, ?, ?, '')`).run(id, `A${id}`, `甲${id}`)
  return id
}
const raw = (id = CID) => db.prepare('SELECT sensitivity, heat_mode, heat_until, sensitivity_before_heat FROM characters WHERE id = ?').get(id)
/** 直接写一个已知的旧值（`at` 要给：否则"上次变化时间"是真实 now，与用例里的 now 打架会算出衰减尾巴） */
const setRaw = (id, value, at = Date.now()) => db
  .prepare('UPDATE characters SET sensitivity = ?, sensitivity_updated_at = ? WHERE id = ?')
  .run(value, new Date(at).toISOString(), id)

// ── ① 发情模式到点必须真的回落 ───────────────────────────────────────────────

test('★① 发情模式到点：读的时候就把 100 写回发情前的值（不然要 15 天才掉下来）', () => {
  seed()
  const t0 = Date.parse('2026-10-03T00:00:00Z')
  setRaw(CID, 30, t0)
  // 开 2 小时发情
  const on = S.setHeatMode(CID, true, { minutes: 120, now: t0 })
  assert.equal(on.value, 100)
  assert.equal(on.before, 30, '要记住发情前的值')
  assert.equal(S.getSensitivity(CID, { now: t0 + 60000 }).value, 100, '发情中 ⇒ 满格')

  // 到点之后：第一次读就必须回落（惰性写回）
  const after = S.getSensitivity(CID, { now: t0 + 121 * 60000 })
  assert.equal(after.heat, false)
  assert.equal(after.heatExpired, true, '要标出"这次是刚到点"')
  assert.equal(after.value, 30, '回到发情前的 30，而不是从 100 慢慢衰减')
  const row = raw()
  assert.equal(Number(row.heat_mode), 0, 'heat_mode 要落库清掉')
  assert.equal(row.heat_until, null)
  assert.equal(Number(row.sensitivity), 30, '库里的值也必须是 30（下次读不用再算）')
  // 再读一次：值已经在库里了（不会又跳回 100），只是**正常衰减**继续走（9 分钟 ≈ -0.02）
  const later = S.getSensitivity(CID, { now: t0 + 130 * 60000 }).value
  assert.ok(later >= 29.9 && later <= 30, `恢复后再读应仍在 30 附近（正常衰减），实际 ` + later)
})

test('★① 到点后再"累加"要从回落后的值起算（不能从 100 起算）', () => {
  seed(9002)
  const t0 = Date.parse('2026-10-03T00:00:00Z')
  setRaw(9002, 20, t0)
  S.setHeatMode(9002, true, { minutes: 60, now: t0 })
  const r = S.addSensitivity(9002, 'manual', { weight: 1, now: t0 + 61 * 60000 })
  assert.equal(r.gain, S.GROWTH.manual, '手动的增益照给')
  assert.equal(r.value, 21, '从 20 起算 ⇒ 21（不是 100 或 101）')
})

// ── ② 关发情不许砍掉她本来的高值 ─────────────────────────────────────────────

test('★② 关掉发情：还给发情前的值；她本来就 80 就还 80（不再一律砍成 55）', () => {
  seed(9003)
  const t0 = Date.parse('2026-10-03T00:00:00Z')
  setRaw(9003, 80, t0)
  S.setHeatMode(9003, true, { minutes: 120, now: t0 })
  const off = S.setHeatMode(9003, false, { now: t0 + 5 * 60000 })
  assert.equal(off.value, 80, '她本来 80 ⇒ 关掉还是 80')
  assert.equal(Number(raw(9003).sensitivity), 80)
})

test('② 老数据（没有 sensitivity_before_heat）：退回旧口径 min(当前, 55)', () => {
  seed(9004)
  db.prepare('UPDATE characters SET sensitivity = 100, sensitivity_before_heat = NULL, heat_mode = 1, heat_until = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), 9004)
  const v = S.getSensitivity(9004, { now: Date.now() })
  assert.equal(v.value, 55, '没有"发情前值"可还 ⇒ 至少不能停在 100')
})

test('② 发情中重复点开：保留最早那个"发情前的值"（别把 100 记成发情前值）', () => {
  seed(9005)
  const t0 = Date.parse('2026-10-03T00:00:00Z')
  setRaw(9005, 12, t0)
  S.setHeatMode(9005, true, { minutes: 120, now: t0 })
  S.setHeatMode(9005, true, { minutes: 120, now: t0 + 60000 })   // 又点了一次"开"
  assert.equal(S.setHeatMode(9005, false, { now: t0 + 2 * 60000 }).value, 12, '还是 12，不能变成 100')
})

// ── ③ 「缓慢累加」的闸门 ─────────────────────────────────────────────────────

test('★③ 只有**自动插入的每一跳**受 15 秒节流；玩家手点的每一下都算数', () => {
  seed(9006)
  const t0 = Date.parse('2026-10-03T03:00:00Z')
  setRaw(9006, 0, t0)
  const a = S.addSensitivity(9006, 'intimate_action', { weight: 1, now: t0 })
  assert.equal(a.gain, S.GROWTH.intimate_action, '第一下照给')
  const b = S.addSensitivity(9006, 'auto_tick', { weight: 1, now: t0 + 1500 })   // 冲刺档 1.5 秒一下
  assert.equal(b.gain, 0)
  assert.equal(b.rateLimited, true, '要标出"被限流了"')
  const c = S.addSensitivity(9006, 'intimate_action', { weight: 1, now: t0 + 16000 })
  assert.equal(c.gain, S.GROWTH.intimate_action, '过了 15 秒照给')

  // 算一下"没闸门会怎样"：冲刺档 1.5 秒一下，一分钟 40 下 × 0.5 = +20/分钟
  assert.equal(40 * S.GROWTH.intimate_action, 20, '口径：没有闸门时每分钟 +20（五分钟顶满）')
  // 有闸门：一分钟最多 4 次计账
  let gained = 0
  for (let i = 0; i < 40; i += 1) {
    const g = S.addSensitivity(9006, 'auto_tick', { weight: 1, now: t0 + 30000 + i * 1500 })
    gained += g.gain || 0
  }
  assert.ok(gained <= 4 * S.GROWTH.intimate_action + 0.001, `一分钟最多 +${4 * S.GROWTH.intimate_action}，实际 ${gained}`)
})

test('★③ 高潮不受 15 秒限流（那是决定性的那一下，不能被吞）', () => {
  seed(9007)
  const t0 = Date.parse('2026-10-03T04:00:00Z')
  setRaw(9007, 0, t0)
  S.addSensitivity(9007, 'intimate_action', { weight: 1, now: t0 })
  const cl = S.addSensitivity(9007, 'climax', { weight: 3, now: t0 + 1000 })
  assert.ok(Math.abs(cl.gain - S.GROWTH.climax * 3) < 1e-9, '高潮照给（1.2×3=3.6），实际 ' + cl.gain)
})

test('★③ 每日上限：跨日自动归零；额度只剩一点时**部分记账**而不是整笔丢掉', () => {
  seed(9008)
  const day1 = Date.parse('2026-10-03T05:00:00Z')
  setRaw(9008, 0, day1)
  // 一天里反复高潮（高潮不受 15 秒限流）⇒ 撞到 20 点上限
  let last = null
  for (let i = 0; i < 30; i += 1) last = S.addSensitivity(9008, 'climax', { weight: 5, now: day1 + i * 60000 })
  const total = S.getSensitivity(9008, { now: day1 + 30 * 60000 }).value
  // 闸门挡住的是"再往上加"，衰减照走（这 30 次调用模拟跨了 29 分钟 ≈ -0.06）
  assert.ok(total <= S.SEX_DAILY_CAP + 1e-9, `不许超过上限，实际 ${total}`)
  assert.ok(total >= S.SEX_DAILY_CAP - 0.3, `应该顶到上限附近，实际 ${total}`)
  assert.equal(last.capped, true, '撞上限时要标出来')

  // 跨日（UTC）：额度归零，继续能涨
  const day2 = Date.parse('2026-10-04T05:00:00Z')
  const next = S.addSensitivity(9008, 'climax', { weight: 5, now: day2 })
  assert.ok(next.gain > 0, '跨日额度归零 ⇒ 又能涨')
  // 跨了一天：额度归零，但**衰减也走了**（0.125/h × 24h = 3 点）⇒ 17 + 6 ≈ 23
  assert.ok(Math.abs(next.gain - S.GROWTH.climax * 5) < 0.02, '第二天这一下照给 6 点，实际 ' + next.gain)
  assert.ok(Math.abs(next.value - (S.SEX_DAILY_CAP - 3 + S.GROWTH.climax * 5)) < 0.1, '第二天 ≈ 17+6，实际 ' + next.value)

  // 部分记账：额度还剩 0.5 而这一下值 6 ⇒ 只涨 0.5，不用整笔记不上
  seed(9009)
  const d = Date.parse('2026-10-03T07:00:00Z')
  setRaw(9009, 0, d)
  db.prepare('UPDATE characters SET sensitivity_sex_day = ?, sensitivity_sex_day_gain = ? WHERE id = ?')
    .run('2026-10-03', S.SEX_DAILY_CAP - 0.5, 9009)
  const partial = S.addSensitivity(9009, 'climax', { weight: 5, now: d })
  assert.ok(Math.abs(partial.gain - 0.5) < 1e-9, '部分记账应给 0.5，实际 ' + partial.gain)
  assert.ok(Math.abs(partial.value - 0.5) < 0.02, '值应为 0.5，实际 ' + partial.value)
})

test('③ 手动设置 / 发情模式不受闸门限制（用户要能自己拨）', () => {
  seed(9010)
  const t0 = Date.parse('2026-10-03T08:00:00Z')
  db.prepare('UPDATE characters SET sensitivity_sex_day = ?, sensitivity_sex_day_gain = ? WHERE id = ?')
    .run('2026-10-03', S.SEX_DAILY_CAP, 9010)
  const m = S.addSensitivity(9010, 'manual', { weight: 1, now: t0 })
  assert.equal(m.gain, S.GROWTH.manual, 'manual 不受每日上限约束')
  const h = S.setHeatMode(9010, true, { minutes: 10, now: t0 })
  assert.equal(h.value, 100, '发情模式照样直接拉满')
})

test('③ 触摸 / 玩具 / 自慰都算性相关（都受闸门约束）', () => {
  for (const src of ['toy', 'touch_sensitive', 'touch_normal', 'self_play', 'hypnosis', 'auto_tick']) {
    assert.ok(S.SEX_SOURCES.has(src), `${src} 应受闸门约束`)
  }
  assert.ok(S.TICK_SOURCES.has('auto_tick'), '自动跳受 15 秒节流')
  assert.equal(S.TICK_SOURCES.has('intimate_action'), false, '玩家手点不受节流')
  assert.ok(!S.SEX_SOURCES.has('manual'), 'manual 不受限')
  assert.ok(!S.SEX_SOURCES.has('heat_mode'), 'heat_mode 只是拉满，不走累加')
})

// ── ④ 退出来要一起停自动 ────────────────────────────────────────────────────

test('★④ stop（退出来）必须把自动插入一起停掉', async () => {
  const A = await import('../src/services/intimateActionService.js')
  const st = { ...A.emptySceneState(CID), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', autoThrust: 1, autoPace: 4 }
  const r = A.planIntimateAction(st, { actionKey: 'stop' })
  assert.equal(r.ok, true)
  assert.equal(r.next.penetrating, false)
  assert.equal(r.next.autoThrust, 0, '退出来还挂着"自动插入中"的话，他一进入她自己就动起来了')
  assert.equal(r.next.autoPace, 4, '速度本身留着（下次开自动还是这个速度）')
})
