/**
 * 玩具玩法扩充 · 组合佩戴 / 振动模式 / 强度曲线（2026-10-02，用户原话「玩具玩法有点太少了」）
 *
 * 这一份钉的是**机制本身**，全部用**注入的假时钟**（`now` 参数）验时间推进 —— 一条 sleep 都没有：
 *   ① 清单加厚：11 件、每件有 part/上限/刺激类型/正文效果语义；首期 5 件的旧契约一个字符没动；
 *   ② 组合佩戴：叠加、互相影响、过载；
 *   ③ 振动模式：持续/脉冲/渐变/随机（随机是**确定性伪随机**，所以测得住）；
 *   ④ 强度曲线：随时间自动升降 + `tickToys` 真的推进（不是只在装备那一刻算一次）；
 *   ⑤ 向后兼容：没设模式/曲线的行为和加功能前一致（含 `<worn_toys>` 旧文案）。
 *
 * 注意（本仓血泪教训）：断言只钉**行为**，不去断言"源码里有没有某一行"。
 */

import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
// LLM 只打桩：只放行本测试自己的服务器，其余出网一律拒（反应是增强项，失败不影响状态）
const realFetch = globalThis.fetch
let base = ''
globalThis.fetch = async (url, init) => {
  if (base && String(url).startsWith(base)) return realFetch(url, init)
  throw new Error('toy play fixture forbids network: ' + url)
}

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const toys = await import('../src/services/toyService.js')
const toysRoutes = (await import('../src/routes/toys.js')).default

let server = null
before(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/characters', toysRoutes)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = 'http://127.0.0.1:' + server.address().port
})
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  closeDb()
})

const db = () => getDb()
let seq = 0
function mkChar(name) {
  seq += 1
  return Number(db().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('tp' + seq + '_' + name, name).lastInsertRowid)
}
const T0 = new Date('2026-10-02T10:00:00Z')
const at = (sec) => new Date(T0.getTime() + sec * 1000)
const liveOf = (id, key, when) => toys.listWornToys(id, { now: when }).find(t => t.toyKey === key)

const api = async (path, init) => {
  const res = await fetch(base + path, init)
  let body = null
  try { body = await res.json() } catch (err) { body = null }
  return { status: res.status, body }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

// ── ① 清单加厚 ────────────────────────────────────────────────────────────────

test('① 清单加厚：11 件，每件都有部位/强度上限/刺激类型/正文效果语义', () => {
  // 首期 5 件是**旧契约**（既有测试、force_toy 枚举、available 列表都吃它）——一个都不能少/多/换序
  assert.deepEqual(toys.TOY_KEYS, ['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar'])
  assert.equal(toys.listToys().length, 5, 'listToys 仍是首期 5 件')
  assert.equal(toys.ALL_TOY_KEYS.length, 11, '全部清单 5 + 6')
  const required = ['part', 'partSection', 'maxIntensity', 'effect', 'stimulus']
  for (const key of toys.ALL_TOY_KEYS) {
    const toy = toys.getToy(key)
    assert.ok(toy, key + ' 要能查到')
    for (const field of required) {
      assert.ok(toy[field] !== undefined && toy[field] !== '', key + ' 缺字段 ' + field)
    }
    assert.ok(toys.STIMULUS_KINDS[toy.stimulus], key + ' 的刺激类型要在枚举里')
    assert.ok(toy.effect.length >= 8, key + ' 的正文效果语义要写清楚（不是占位）')
  }
  // 第二批：不同部位 + 不同刺激类型（不是同一件换个名字）
  const extraParts = toys.ALL_TOY_KEYS.slice(5).map(k => toys.getToy(k).part)
  assert.ok(new Set(extraParts).size >= 5, '第二批的部位要铺开：' + extraParts.join('/'))
  const kinds = new Set(toys.ALL_TOY_KEYS.map(k => toys.getToy(k).stimulus))
  assert.ok(kinds.size >= 4, '刺激类型至少 4 种：' + [...kinds].join('/'))
  assert.ok(kinds.has('suction') && kinds.has('beads'), '要有吸吮与串珠（不只是震动）')
})

test('① 新玩具同样**不再有任何门控**（2026-10-04「玩具限制全删」；只留 unknown_toy）', () => {
  const base = { affinity: 0, isOath: false, hypnotized: false, sleeping: false, intimateAuthorized: false, scene: 'chat', allowGroupAdult: false }
  // 第二批玩具与首批**同口径**：零条件一律放行（原先是「走触摸系统门控」= Lv4/Lv3 好感+授权）。
  // ⚠️ 不是删断言：下面把旧分支逐条复验，期望值从「拦」改成「放」；unknown_toy 仍钉死。
  for (const key of ['clit_sucker', 'thigh_vibe', 'anal_beads', 'nipple_sucker']) {
    const g = toys.gateToy({ ...base, toyKey: key })
    assert.equal(g.allowed, true, key + '：零条件必须放行')
    assert.equal(g.code, 'ok')
    assert.equal(g.message, '')
    assert.equal(g.toy.key, key, '仍要把 toy 带回去')
  }
  // 旧分支逐条复验
  assert.equal(toys.gateToy({ ...base, toyKey: 'clit_sucker', affinity: 85 }).allowed, true, '原先差「亲密」授权，现在放行')
  assert.equal(toys.gateToy({ ...base, toyKey: 'thigh_vibe', affinity: 59, intimateAuthorized: true }).allowed, true, '原先差好感 60，现在放行')
  // 催眠仍放行（玩具已不需要豁免，结果一致 —— 用户「催眠的权限是最高的」照旧成立）
  assert.equal(toys.gateToy({ ...base, toyKey: 'anal_beads', hypnotized: true }).allowed, true)
  // 群聊：原先 group_adult_blocked，现在放行
  assert.equal(toys.gateToy({ ...base, toyKey: 'nipple_sucker', scene: 'group' }).allowed, true, '群聊不再拦玩具')
  // 但 unknown_toy 仍要拦（参数错误 ≠ 内容限制）
  assert.equal(toys.gateToy({ ...base, toyKey: 'no_such_toy' }).code, 'unknown_toy')
})

// ── ② 组合佩戴 ────────────────────────────────────────────────────────────────

test('② 组合佩戴：叠加 / 互相影响 / 过载，负载不含象征物', () => {
  const list = (keys, intensities) => keys.map((k, i) => ({ toyKey: k, intensity: intensities[i], stimulus: toys.getToy(k)?.stimulus }))
  // 阴蒂 + 后庭 = 前后夹击
  const frontBack = toys.comboEffects(list(['vibe_egg', 'anal_plug'], [2, 2]))
  assert.ok(frontBack.labels.includes('前后夹击'), '阴蒂+后庭要成立前后夹击：' + frontBack.labels.join('/'))
  assert.ok(frontBack.notes.length >= 1 && frontBack.notes[0].length > 8, '要给出正文语义，不是空标签')
  // 里面 + 后面 = 双穴同时
  assert.ok(toys.comboEffects(list(['g_spot_vibe', 'anal_beads'], [2, 1])).labels.includes('双穴同时'), '第二批也要能组成双穴')
  // 下面 + 乳尖 = 上下两点
  assert.ok(toys.comboEffects(list(['clit_sucker', 'chain_clamp'], [3, 1])).labels.includes('上下两点'))
  // 两口同时吸
  assert.ok(toys.comboEffects(list(['clit_sucker', 'nipple_sucker'], [3, 2])).labels.includes('两口同时吸'))
  // 多点齐震：同类叠加按"命中件数"算（不是"有没有这一类"）
  assert.ok(toys.comboEffects(list(['vibe_egg', 'vibe_stick'], [2, 2])).labels.includes('多点齐震'))
  assert.equal(toys.comboEffects(list(['vibe_egg'], [2])).labels.includes('多点齐震'), false, '单件不算多点')
  // 项圈：象征物，自己不能成立"项圈在场"，得有别的玩具
  assert.deepEqual(toys.comboEffects(list(['collar'], [0])).labels, [])
  assert.ok(toys.comboEffects(list(['collar', 'vibe_egg'], [0, 2])).labels.includes('项圈在场'))
  // 负载：项圈不计；4 件 / 总档 ≥10 算过载；3 件只是"重"
  const one = toys.comboEffects(list(['collar'], [0]))
  assert.equal(one.load, 0, '项圈没有强度，不该计入负载')
  const three = toys.comboEffects(list(['vibe_egg', 'anal_plug', 'nipple_clamp'], [3, 3, 2]))
  assert.equal(three.load, 8)
  assert.equal(three.overload, false)
  assert.equal(three.heavy, true, '3 件/8 档算"叠加明显"，但还没过载')
  const heavy = toys.comboEffects(list(['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp'], [3, 3, 2, 2]))
  assert.equal(heavy.load, 10)
  assert.equal(heavy.overload, true, '总档 10 或 4 件 ⇒ 过载')
  assert.ok(heavy.summary.includes('过载'))
})

// ── ③ 振动模式 ────────────────────────────────────────────────────────────────

test('③ 振动模式：四种；脉冲/渐变/随机都要真的改变节奏（不是换个名字）', () => {
  assert.deepEqual(Object.keys(toys.VIBRATION_MODES), ['steady', 'pulse', 'wave', 'random'])
  // 未知模式：归一化成持续（旧调用不用知道模式这回事），但要能识别出"不认识"
  assert.equal(toys.normalizeMode('nope'), 'steady')
  assert.equal(toys.isVibrationMode('nope'), false)
  assert.equal(toys.isVibrationMode('pulse'), true)
  // 持续：不衰减
  assert.equal(toys.modePhase('steady', { elapsedSec: 999 }).factor, 1)
  // 脉冲：周期内有的时刻冲高、有的时刻退下去
  const pulseOn = toys.modePhase('pulse', { elapsedSec: 1 })
  const pulseOff = toys.modePhase('pulse', { elapsedSec: 4 })
  assert.equal(pulseOn.factor, 1)
  assert.ok(pulseOff.factor < 1, '脉冲退下去时要真的衰减')
  assert.notEqual(pulseOn.phase, pulseOff.phase, '两个相位的名字要不同（prompt 按它写节奏）')
  // 渐变：半个周期到顶，整周期回到底
  const waveMeta = toys.VIBRATION_MODES.wave
  assert.equal(toys.modePhase('wave', { elapsedSec: waveMeta.periodSec / 2 }).factor.toFixed(4), '1.0000')
  assert.ok(toys.modePhase('wave', { elapsedSec: 0 }).factor < 0.5)
  // 随机：同一时间片可复算，跨时间片真的会变（确定性伪随机 ⇒ 测试不用 sleep 也不用打桩 Math.random）
  const r1 = toys.modePhase('random', { elapsedSec: 1, seed: 42 }).factor
  const r2 = toys.modePhase('random', { elapsedSec: 2, seed: 42 }).factor
  assert.equal(r1, r2, '同一个 5 秒时间片内不能变（否则每帧都在抖）')
  assert.equal(toys.modePhase('random', { elapsedSec: 3, seed: 42 }).factor, r2, '同一时间片内的另一秒也一样')
  const slots = [0, 5, 10, 15, 20, 25].map(s => toys.modePhase('random', { elapsedSec: s, seed: 42 }).factor)
  assert.ok(new Set(slots).size > 1, '跨时间片要真的不一样')
  const other = [0, 5, 10, 15, 20, 25].map(s => toys.modePhase('random', { elapsedSec: s, seed: 7 }).factor)
  assert.notDeepEqual(other, slots, '不同种子给不同序列（每件玩具的随机不一样）')
})

test('③ 模式影响强度：同一档位下脉冲高峰 > 波谷（这是"反应节奏"的物理来源）', () => {
  const worn = toys.evaluateToyPlay({ baseIntensity: 4, maxIntensity: 5, mode: 'pulse', now: 3000, equippedAtMs: 0 })
  const peak = toys.evaluateToyPlay({ baseIntensity: 4, maxIntensity: 5, mode: 'pulse', now: 1000, equippedAtMs: 0 })
  assert.equal(peak.intensity, 4, '高峰=基准档')
  assert.ok(worn.intensity < peak.intensity, '波谷要低于高峰：' + worn.intensity + ' vs ' + peak.intensity)
  assert.ok(worn.modeFactor < 1 && worn.modeFactor > 0)
})

// ── ④ 强度曲线 + tick 推进（核心：随时间，不是只在装备那一刻）─────────────────

test('④ 强度曲线：随时间自动升降（假时钟推进，零 sleep）', () => {
  const id = mkChar('曲线')
  toys.equipToy(id, 'vibe_egg', { intensity: 2, now: T0 })
  assert.equal(toys.setToyCurve(id, 'vibe_egg', { type: 'ramp_up', from: 2, to: 5, durationSec: 100 }, { now: T0 }).ok, true)

  const t0 = liveOf(id, 'vibe_egg', at(0))
  const t25 = liveOf(id, 'vibe_egg', at(25))
  const t50 = liveOf(id, 'vibe_egg', at(50))
  const t100 = liveOf(id, 'vibe_egg', at(100))
  const t150 = liveOf(id, 'vibe_egg', at(150))
  // 档位随时间单调上升（曲线真的在走）
  assert.deepEqual([t0.liveIntensity, t25.liveIntensity, t50.liveIntensity, t100.liveIntensity], [2, 3, 4, 5])
  assert.equal(t50.curveIntensity, 4, '50% 处目标档 = 2 + (5-2)*0.5 = 3.5 → 取整 4')
  assert.ok(t50.remainingSec < 100 && t50.remainingSec > 0, '要报剩余时间')
  assert.equal(t100.curveFinished, true, '走完要标记结束')
  assert.equal(t150.liveIntensity, 5, '非循环曲线走完后停在 to')
  assert.equal(t50.intensity, 2, '基准档（用户设的那个）不跟着曲线漂')
  // 进度单调
  assert.ok(t25.curveProgress < t50.curveProgress && t50.curveProgress < t100.curveProgress)
  // 循环曲线：走完立刻从头再来
  toys.setToyCurve(id, 'vibe_egg', { type: 'wave', from: 1, to: 5, durationSec: 60, loop: true }, { now: T0 })
  const loopAt = liveOf(id, 'vibe_egg', at(70))
  assert.equal(loopAt.curveFinished, false, '循环曲线永远不会"结束"')
  assert.ok(Math.abs(loopAt.curveProgress - (1 / 6)) < 0.01, '70s 时进度落在第二个周期的 1/6')
  assert.ok(loopAt.liveIntensity >= 1 && loopAt.liveIntensity <= 5)
})

test('④ tickToys：真的把推进结算下来，并报出档位变化（不能只在装备时算一次）', () => {
  const id = mkChar('tick')
  toys.equipToy(id, 'vibe_egg', { intensity: 1, now: T0 })
  toys.setToyCurve(id, 'vibe_egg', { type: 'ramp_up', from: 1, to: 5, durationSec: 100 }, { now: T0 })
  // 第一次 tick：从基准档 1 → 曲线此刻的目标档（t=0 时还是 1，所以没有变化）
  const first = toys.tickToys(id, { now: at(0) })
  assert.deepEqual(first.transitions, [], 't=0 时目标档等于基准档 ⇒ 无变化')
  // 推进到 50s：目标档 3 ⇒ 必须报出 1→3
  const mid = toys.tickToys(id, { now: at(50) })
  assert.equal(mid.transitions.length, 1)
  assert.equal(mid.transitions[0].toyKey, 'vibe_egg')
  assert.equal(mid.transitions[0].from, 1)
  assert.equal(mid.transitions[0].to, 3)
  // 已结算：再 tick 一次同一时刻 ⇒ 没有新变化（幂等）
  assert.deepEqual(toys.tickToys(id, { now: at(50) }).transitions, [])
  // 继续推进：档位继续往上，tick 也继续报
  const late = toys.tickToys(id, { now: at(100) })
  assert.equal(late.transitions[0].to, 5)
  // tick 不改配置（模式/曲线还在）
  const after = liveOf(id, 'vibe_egg', at(100))
  assert.equal(after.curve.type, 'ramp_up')
  assert.equal(after.mode, 'steady')
  // 落库的玩法行真的存在（tick 是"结算"，不是纯计算）
  const row = db().prepare('SELECT * FROM toy_play_state WHERE character_id = ? AND toy_key = ?').get(id, 'vibe_egg')
  assert.ok(row, 'tick 要落库')
  assert.equal(Number(row.last_intensity), 5)
})

test('④ 模式 × 曲线一起作用：曲线给目标档、模式给节奏包络', () => {
  const id = mkChar('叠加')
  toys.equipToy(id, 'vibe_egg', { intensity: 5, now: T0 })
  toys.setToyCurve(id, 'vibe_egg', { type: 'ramp_up', from: 5, to: 5, durationSec: 100 }, { now: T0 })
  toys.setToyMode(id, 'vibe_egg', 'pulse', { now: T0 })
  const peak = liveOf(id, 'vibe_egg', at(1))   // 1s：脉冲高峰
  const trough = liveOf(id, 'vibe_egg', at(4)) // 4s：脉冲间隙
  assert.equal(peak.liveIntensity, 5)
  assert.ok(trough.liveIntensity < 5, '间隙期要被压下来：' + trough.liveIntensity)
  assert.equal(peak.intensity, 5, '基准档不受影响')
  assert.equal(peak.mode, 'pulse')
  assert.equal(peak.modeLabel, '脉冲')
})

// ── ⑤ 向后兼容 ────────────────────────────────────────────────────────────────

test('⑤ 兼容：不设模式/曲线时 liveIntensity === intensity，<worn_toys> 旧文案一字不改', () => {
  const id = mkChar('兼容')
  const t = at(0)
  toys.equipToy(id, 'vibe_egg', { intensity: 3, now: new Date(T0.getTime() - 40 * 60000) })
  const worn = liveOf(id, 'vibe_egg', t)
  assert.equal(worn.intensity, 3)
  assert.equal(worn.liveIntensity, 3, '没有模式/曲线时二者必须相等（旧行为）')
  assert.equal(worn.mode, 'steady')
  assert.equal(worn.curve, null)
  assert.equal(worn.remainingSec, null)
  const block = toys.buildWornToysBlock(id, { scene: 'chat', now: t })
  assert.ok(block.startsWith('<worn_toys>') && block.endsWith('</worn_toys>'))
  assert.ok(block.includes('强度3/5'), '旧强度文案保留')
  assert.ok(block.includes('已戴40分钟'), '旧时长文案保留')
  assert.ok(block.includes('强度3：持续的刺激') && block.includes('强度4~5：强烈刺激'), '分档指引五行保留')
  assert.equal(block.includes('节奏与曲线'), false, '没设模式/曲线就不该多出这一段')
})

test('⑤ 兼容：setToyMode/setToyCurve 的错误码分明（未佩戴 404 语义 / 参数非法 400 语义）', () => {
  const id = mkChar('错误码')
  assert.equal(toys.setToyMode(id, 'vibe_egg', 'pulse').code, 'toy_not_worn')
  assert.equal(toys.setToyCurve(id, 'vibe_egg', { type: 'ramp_up' }).code, 'toy_not_worn')
  assert.equal(toys.setToyMode(id, 'nope', 'pulse').code, 'unknown_toy')
  toys.equipToy(id, 'vibe_egg', { intensity: 2, now: T0 })
  assert.equal(toys.setToyMode(id, 'vibe_egg', 'not_a_mode').code, 'invalid_mode')
  assert.equal(toys.setToyCurve(id, 'vibe_egg', { type: 'not_a_curve' }).code, 'invalid_curve')
  // 曲线参数越界要被夹到 0~上限，时长有下限（不能让 setTimeout 式的用法把时间轴搞坏）
  const ok = toys.setToyCurve(id, 'vibe_egg', { type: 'ramp_up', from: -5, to: 99, durationSec: 1 }, { now: T0 })
  assert.equal(ok.ok, true)
  assert.equal(ok.toy.curve.from, 0)
  assert.equal(ok.toy.curve.to, 5)
  assert.ok(ok.toy.curve.durationSec >= 10, '时长下限 10 秒：' + ok.toy.curve.durationSec)
  // 关掉曲线：回到基准档
  const off = toys.setToyCurve(id, 'vibe_egg', null, { now: at(50) })
  assert.equal(off.ok, true)
  assert.equal(off.toy.curve, null)
  assert.equal(off.toy.liveIntensity, 2)
})

// ── 路由契约 ──────────────────────────────────────────────────────────────────

test('路由：GET /toys 的旧字段不变，新增 catalog/combos/options（available 仍是 5 件）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('路由读')
    const list = await api('/api/characters/' + id + '/toys')
    assert.equal(list.status, 200)
    assert.equal(list.body.unlocked, true)
    assert.equal(list.body.available.length, 5, 'available 是旧契约：还是首期 5 件')
    assert.deepEqual(list.body.available.map(a => a.toyKey), toys.TOY_KEYS)
    assert.equal(list.body.catalog.length, 11, 'catalog 才是完整清单')
    assert.equal(list.body.catalog.find(t => t.toyKey === 'vibe_egg').legacy, true)
    assert.equal(list.body.catalog.find(t => t.toyKey === 'clit_sucker').legacy, false)
    assert.equal(typeof list.body.catalog[0].allowed, 'boolean', '门控结论由服务端给')
    assert.ok(Array.isArray(list.body.options.modes) && list.body.options.modes.length === 4)
    assert.ok(Array.isArray(list.body.options.curves) && list.body.options.curves.length >= 4)
    assert.ok(list.body.combos && typeof list.body.combos.count === 'number')
    assert.ok(Array.isArray(list.body.transitions))
    // 开关关着时逐字节保持旧响应
    config.features.toys = false
    const off = await api('/api/characters/' + id + '/toys')
    assert.deepEqual(off.body, { unlocked: false, worn: [], available: [] })
  } finally { config.features.toys = prev }
})

test('路由：mode / curve / tick 三个写接口（含 404 与 400 分支）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('路由写')
    const { saveAffinity } = await import('../src/services/emotionEngine.js')
    saveAffinity(id, 65, false)   // 项圈 Lv3 门槛：好感 60 即可、免授权
    const equip = await post('/api/characters/' + id + '/toys/collar/equip', {})
    assert.equal(equip.status, 200)

    const mode404 = await post('/api/characters/' + id + '/toys/vibe_egg/mode', { mode: 'pulse' })
    assert.equal(mode404.status, 404, '没戴的玩具不能设模式')
    const badMode = await post('/api/characters/' + id + '/toys/collar/mode', { mode: 'xg' })
    assert.equal(badMode.status, 400)
    assert.equal(badMode.body.error, 'invalid_mode')
    const modeOk = await post('/api/characters/' + id + '/toys/collar/mode', { mode: 'wave' })
    assert.equal(modeOk.status, 200)
    assert.equal(modeOk.body.toy.mode, 'wave')

    const badCurve = await post('/api/characters/' + id + '/toys/collar/curve', { curve: { type: 'nope' } })
    assert.equal(badCurve.status, 400)
    assert.equal(badCurve.body.error, 'invalid_curve')
    const curveOk = await post('/api/characters/' + id + '/toys/collar/curve', { curve: { type: 'ramp_up', from: 0, to: 0, durationSec: 30 } })
    assert.equal(curveOk.status, 200)
    assert.equal(curveOk.body.toy.curve.type, 'ramp_up')
    // 关曲线：null 与 'off' 两种写法都要能关
    assert.equal((await post('/api/characters/' + id + '/toys/collar/curve', { curve: null })).body.toy.curve, null)
    assert.equal((await post('/api/characters/' + id + '/toys/collar/curve', { curve: 'off' })).body.toy.curve, null)

    const tick = await post('/api/characters/' + id + '/toys/tick', {})
    assert.equal(tick.status, 200)
    assert.ok(Array.isArray(tick.body.worn) && tick.body.worn.length === 1)
    assert.ok(Array.isArray(tick.body.transitions))
    assert.ok(tick.body.selfPlay && typeof tick.body.selfPlay.decision === 'object', 'tick 顺带给出她的主动判定预览')

    // 开关关着：三个写接口都 403
    config.features.toys = false
    for (const path of ['/toys/collar/mode', '/toys/collar/curve', '/toys/tick']) {
      const r = await post('/api/characters/' + id + path, { mode: 'pulse' })
      assert.equal(r.status, 403, path + ' 应 403')
      assert.equal(r.body.error, 'toys_disabled')
    }
  } finally { config.features.toys = prev }
})

test('路由：tick 推进后 GET 能读到新的 liveIntensity（曲线在真实接口上真的会走）', async () => {
  const prev = config.features.toys
  config.features.toys = true
  try {
    const id = mkChar('路由时间')
    const { saveAffinity } = await import('../src/services/emotionEngine.js')
    saveAffinity(id, 65, false)
    await post('/api/characters/' + id + '/toys/collar/equip', {})
    // 项圈没有强度档 ⇒ 换成能验数值的路径：直接用服务装备跳蛋（门控在别的用例里已覆盖）
    toys.equipToy(id, 'vibe_egg', { intensity: 1, now: new Date() })
    await post('/api/characters/' + id + '/toys/vibe_egg/curve', { curve: { type: 'ramp_up', from: 1, to: 5, durationSec: 10 } })
    const before = (await api('/api/characters/' + id + '/toys')).body.worn.find(t => t.toyKey === 'vibe_egg')
    assert.ok(before.liveIntensity >= 1, '刚设完曲线在起点附近')
    // 用 tick 把时间往前推：直接改 curve_started_at（等价于"已经过去 9 秒"），避免 sleep
    db().prepare("UPDATE toy_play_state SET curve_started_at = datetime('now', '-9 seconds') WHERE character_id = ? AND toy_key = 'vibe_egg'").run(id)
    const after = (await api('/api/characters/' + id + '/toys')).body.worn.find(t => t.toyKey === 'vibe_egg')
    assert.ok(after.liveIntensity > before.liveIntensity, '过了一段时间后强度要上去：' + before.liveIntensity + ' → ' + after.liveIntensity)
    assert.ok(after.curveProgress > 0.5)
  } finally { config.features.toys = prev }
})
