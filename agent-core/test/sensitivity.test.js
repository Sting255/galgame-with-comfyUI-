/**
 * 敏感度系统守卫（2026-10-02 用户提的新数值系统）
 *
 * 用户原话：
 *   「新增一个数值 叫敏感度 所有和性爱相关的内容 都会和这个挂钩 数值高了低了会有不一样的表现」
 *   「然后再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」
 *   「正常情况的敏感度 会和角色发生性爱相关内容的时候 缓慢累加 玩具也算性爱相关
 *     触摸里的敏感哪一款私处那一块也算」
 *   「敏感度越高角色高潮的强度越高 也越频繁 性爱的频率也会越频繁」
 *
 * 钉四层：
 *   ① 纯计算：分档边界 / 倍率单调 / 衰减只减不增 / 拉满与回落；
 *   ② 持久化：累加真的写进 characters.sensitivity（含"发情模式下不再累加"）；
 *   ③ 接线：推进面板读它、刺激下游喂它、聊天 prompt 写它、催眠手机有发情模式接口；
 *   ④ 不会因为数值系统崩掉性爱链（读失败一律按 0 / 倍率 1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const S = await import('../src/services/sensitivityService.js')

const db = getDb()
db.pragma('foreign_keys = OFF')

test('① 分档与倍率：边界正确、倍率随敏感度单调上升', () => {
  assert.equal(S.sensitivityTier(0).key, 'cold')
  assert.equal(S.sensitivityTier(19).key, 'cold')
  assert.equal(S.sensitivityTier(20).key, 'normal')
  assert.equal(S.sensitivityTier(59).key, 'warm')
  assert.equal(S.sensitivityTier(60).key, 'high')
  assert.equal(S.sensitivityTier(100).key, 'extreme')
  const seq = [0, 20, 40, 60, 80, 100].map(v => S.sensitivityMultiplier(v))
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] >= seq[i - 1], `倍率必须单调不减：${JSON.stringify(seq)}`)
  }
  assert.ok(seq.at(-1) > seq[0], '极度敏感必须比冷淡更容易被推上去')
  assert.equal(S.clampSensitivity(999), 100, '越界夹住')
  assert.equal(S.clampSensitivity(-5), 0)
  assert.equal(S.clampSensitivity('x'), 0, '脏数据按 0')
})

test('① 衰减：随时间只减不增，且不会减到负数', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  assert.equal(S.decayedSensitivity(50, new Date(now).toISOString(), { now }), 50, '刚更新过 ⇒ 不变')
  const after8h = S.decayedSensitivity(50, new Date(now - 8 * 3600_000).toISOString(), { now })
  assert.ok(after8h < 50 && after8h > 48, `8 小时掉约 1 点，实际 ${after8h}`)
  assert.equal(S.decayedSensitivity(1, new Date(now - 1000 * 3600_000).toISOString(), { now }), 0, '不许减成负数')
  assert.equal(S.decayedSensitivity(30, null, { now }), 30, '没有时间戳 ⇒ 原值')
})

test('② 持久化：累加写进 characters.sensitivity，且每类来源都算数', () => {
  db.prepare(`INSERT OR REPLACE INTO characters
    (id, name, display_name, base_prompt, short_prompt, sensitivity, sensitivity_updated_at, heat_mode)
    VALUES (901, ?, ?, ?, ?, 30, NULL, 0)`)
    .run('敏感度测试', '敏感度测试', '你是敏感度测试用角色。', '敏感度测试')
  assert.equal(S.getSensitivity(901).value, 30)

  const before = S.getSensitivity(901).value
  const r1 = S.addSensitivity(901, 'intimate_action')
  assert.ok(r1 && r1.value > before, '推进一下要涨一点')
  const r2 = S.addSensitivity(901, 'toy')
  assert.ok(r2.value >= r1.value, '玩具也算性爱相关')
  const r3 = S.addSensitivity(901, 'climax', { weight: 2 })
  assert.ok(r3.value > r2.value, '高潮权重更大 ⇒ 涨得更多')
  // 写库了吗（不是只在内存里）
  const row = db.prepare('SELECT sensitivity, sensitivity_updated_at FROM characters WHERE id = 901').get()
  assert.ok(row.sensitivity >= r3.value - 0.001, '必须有落库')
  assert.ok(row.sensitivity_updated_at, '要记时间戳（衰减靠它）')
  // 未知来源不涨（点数 0 ⇒ 不写库，直接返回 null）
  assert.equal(S.addSensitivity(901, 'unknown_source'), null)
})

test('② 发情模式：拉满 100、期间不再累加、关掉后回落到常态上沿', () => {
  const on = S.setHeatMode(901, true, { minutes: 60 })
  assert.equal(on.heat, true)
  assert.equal(S.getSensitivity(901).value, 100, '发情模式 = 敏感度直接拉满')
  assert.equal(S.getSensitivity(901).heat, true)

  const during = S.addSensitivity(901, 'intimate_action')
  assert.equal(during.gain, 0, '已经满了 ⇒ 不再累加')

  const off = S.setHeatMode(901, false)
  assert.equal(off.heat, false)
  assert.ok(off.value <= 55, `关掉后要回落到常态上沿（≤55），实际 ${off.value}`)
  assert.equal(db.prepare('SELECT heat_mode FROM characters WHERE id = 901').get().heat_mode, 0, '标志要落库')
})

test('② 发情模式会自然过期（到点后 heat 自动为 false）', () => {
  S.setHeatMode(901, true, { minutes: 1, now: Date.parse('2026-10-02T12:00:00Z') })
  const later = S.getSensitivity(901, { now: Date.parse('2026-10-02T12:05:00Z') })
  assert.equal(later.heat, false, '过了 heat_until ⇒ 不再是发情模式')
  assert.ok(later.value < 100, '也不再是满格')
})

test('③ 接线：四条链都真的读了/写了它', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  const intimate = read('routes/intimateActions.js')
  assert.match(intimate, /getSensitivity\(id\)/, '推进面板要按她自己的敏感度放大增益')
  assert.match(intimate, /sensitivity: readHerState\(id\)\.sensitivity|sensitivity,/, '要把倍率传给状态机')

  const stimulus = read('services/intimateStimulus.js')
  assert.match(stimulus, /addSensitivity\(id, sensSource/, '所有性爱相关事件都要缓慢累加敏感度')

  const chat = read('routes/chat.js')
  assert.match(chat, /buildSensitivityPromptLine/, '聊天 prompt 要写她的敏感度（她表现不一样）')

  const hyp = read('routes/hypnosis.js')
  assert.match(hyp, /router\.post\('\/:id\/heat'/, '催眠手机要有发情模式接口')
  assert.match(hyp, /setHeatMode\(/, '发情模式要真的把她拉满')

  // 状态机确实收 sensitivity 这个参数（跨文件契约）
  // ⚠️ 守卫**只钉参数名，不钉参数表结尾**：原来是 `/sensitivity = 1 \}/`（要求它是最后一个参数），
  //    2026-10-03 加了 `pace` / `autoRun`（自动速度）之后这条就红了 —— 钉得太死的"实现写法守卫"
  //    会在正常演进时误报。现在把签名切出来看，既保住契约也不会因为多一个参数而假红。
  const svc = read('services/intimateActionService.js')
  const sigStart = svc.indexOf('export function planIntimateAction')
  const planSig = svc.slice(sigStart, svc.indexOf(') {', sigStart))
  assert.match(planSig, /sensitivity = 1/, 'planIntimateAction 要收 sensitivity')
  assert.match(planSig, /pace = null/, 'planIntimateAction 要收 pace（自动速度用）')
  assert.match(planSig, /autoRun = false/, 'planIntimateAction 要收 autoRun（自动轮标记）')
  assert.match(svc, /Number\(sensitivity\) \|\| 1/, '并且真的用它放大增益')
})

test('④ 数值系统坏了也不许拖垮性爱链（读失败按 0 处理）', () => {
  const real = console.warn
  console.warn = () => {}
  try {
    const st = S.getSensitivity(999999)   // 不存在的角色
    assert.equal(st.value, 0)
    assert.equal(st.multiplier, S.sensitivityMultiplier(0))
    assert.equal(S.addSensitivity(999999, 'toy'), null, '不存在的角色 ⇒ null，不抛')
    assert.equal(S.setHeatMode(999999, true), null, '同上')
  } finally { console.warn = real }
})
