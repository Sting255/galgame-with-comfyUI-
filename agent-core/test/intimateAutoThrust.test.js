/**
 * 「自动继续抽插」服务端 ticker 守卫（2026-10-02 用户反馈）
 *
 * 用户原话：「而且自动抽插并没有自动 只是点一下 后面就没有角色的反应和图了」
 *
 * 根因：服务端没有定时器，只在"下一条动作进来"时按 lastActionAt 补算 tick；前端也只在面板
 * 开着时自己 tick 一次。点了「自动抽插」之后不动别的东西 ⇒ 她完全静止。
 *
 * 这条测试钉四层：
 *   ① 到点判定（isTickDue）与"补算口径"一致：距上次动作 ≥ 3 秒才算该推一下；
 *   ② 扫描只捞"自动抽插 + 进行中 + 已插入"的场次（别的行不许被推）；
 *   ③ **场景不回退**：群里开的自动抽插，内部推进请求必须带 scene=group + groupId
 *      （否则她的反应会写进私聊 —— 用户报过的那个问题会从这条新链路再犯一次）；
 *   ④ 接线：app.js 真的起了它、路由真的登记了场景。
 *
 * 2026-10-03 复查补两层（代码审查的两条 finding）：
 *   ⑤ **场景登记有时效 + 玩家侧覆盖**：私聊动作立刻压掉群登记；登记过 TTL 就作废，
 *      作废后这一跳**只推状态**（silent）—— 不许把她的反应正文与配图写进猜出来的会话；
 *   ⑥ **反应闸门两边共用**：面板那一拍 / 玩家点的那一下（路由 noteReaction）记的账，
 *      必须让服务端反应跳退让（否则 20s + 20s 两条节拍叠成每 ~10 秒一次 LLM 调用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const tick = await import('../src/services/intimateAutoThrust.js')

const db = getDb()
// 测试环境的内存库不建这张运行期迁移表（下面补最小表），且刻意不造 characters 行
// ⇒ 关掉外键（`character_intimate_scene.character_id` 指向 characters）
db.pragma('foreign_keys = OFF')
// 最小表 —— 只保留本测试用到的列
db.exec(`
  CREATE TABLE IF NOT EXISTS character_intimate_scene (
    character_id INTEGER PRIMARY KEY,
    pace INTEGER,
    auto_thrust INTEGER,
    active INTEGER,
    penetrating INTEGER,
    last_action_at TEXT
  );
`)
db.prepare('DELETE FROM character_intimate_scene').run()

test('① isTickDue：距上次动作满 3 秒才算到点（与 planIntimateAction 的补算口径一致）', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  assert.equal(tick.isTickDue(null, { now }), true, '没有上次动作 ⇒ 立刻推')
  assert.equal(tick.isTickDue('2026-10-02T11:59:58Z', { now }), false, '才过 2 秒 ⇒ 不推')
  assert.equal(tick.isTickDue('2026-10-02T11:59:57Z', { now }), true, '过了 3 秒 ⇒ 推')
  assert.equal(tick.isTickDue('这不是时间', { now }), true, '解析不出来就当作该推（别卡死）')
})

test('①b 频率跟着节奏档（用户：「不能控制自动抽插的频率 不能控制快慢」）', () => {
  assert.equal(tick.intervalForPace(1), 5000, '缓 ⇒ 5 秒一下')
  assert.equal(tick.intervalForPace(2), 3000, '正常 ⇒ 3 秒（与旧口径一致）')
  assert.equal(tick.intervalForPace(3), 2000, '快 ⇒ 2 秒')
  assert.equal(tick.intervalForPace(4), 1500, '冲刺 ⇒ 1.5 秒')
  // 脏数据不许把间隔搞成 0/NaN（那会变成死循环式猛推）
  assert.equal(tick.intervalForPace(0), 3000, '非法档位回落"正常"')
  assert.equal(tick.intervalForPace(99), 1500, '越界夹到最快档')
  assert.equal(tick.intervalForPace('x'), 3000)
  for (const p of [1, 2, 3, 4]) assert.ok(tick.intervalForPace(p) > 0)
})

test('② 只扫「自动抽插 + 进行中 + 已插入」的场次', () => {
  const ins = db.prepare(`INSERT INTO character_intimate_scene
    (character_id, pace, auto_thrust, active, penetrating, last_action_at) VALUES (?,?,?,?,?,?)`)
  ins.run(1, 2, 1, 1, 1, '2026-10-02T11:00:00Z')   // ✅ 该被推
  ins.run(2, 3, 0, 1, 1, '2026-10-02T11:00:00Z')   // ✗ 没开自动
  ins.run(3, 2, 1, 0, 1, '2026-10-02T11:00:00Z')   // ✗ 没在进行
  ins.run(4, 2, 1, 1, 0, '2026-10-02T11:00:00Z')   // ✗ 没插进去（自动抽插无从谈起）
  const rows = tick.listAutoThrustScenes(db)
  assert.equal(rows.length, 1, '只有 1 号场次该被推到')
  assert.equal(rows[0].characterId, 1)
  assert.equal(rows[0].pace, 2)
})

test('③ 群里开的自动抽插 ⇒ 内部请求带 scene=group + groupId（不许回退成私聊）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') })
    return { ok: true, status: 200 }
  }
  try {
    tick.resetAutoThrustState()
    // 显式时钟（登记时刻参与 TTL 判定）：别让假 now 与真实 Date.now 混着比 —— 本仓踩过时间相关的坑
    const t0 = Date.parse('2026-10-02T12:00:00Z')
    // 群里登记的场次
    tick.noteScene(1, { scene: 'group', groupId: 7, now: t0 })
    const r1 = await tick.runAutoThrustTick({ db, now: t0 })
    assert.equal(r1.fired, 1, '应当推 1 次')
    assert.match(calls.at(-1).url, /\/api\/intimate-actions\/1\/thrust$/)
    assert.deepEqual(calls.at(-1).body, { auto: true, scene: 'group', groupId: 7, internal: true },
      '群里开的自动抽插必须带场景（否则她的反应会写进私聊）+ `auto: true`（这一下是"他自己动的"）'
      + ' + `internal: true`（自报"这一跳是 ticker 发的" ⇒ 路由不拿它续期场景登记，见 SCENE_MEMO_TTL_MS）')

    // 私聊登记的场次（同一角色换回私聊 ⇒ 请求不带场景参数，但仍要带 auto 标记）
    tick.noteScene(1, { scene: 'chat', now: t0 + 10 * 60_000 })
    const r2 = await tick.runAutoThrustTick({ db, now: t0 + 10 * 60_000 })
    assert.equal(r2.fired, 1)
    assert.deepEqual(calls.at(-1).body, { auto: true, internal: true }, '私聊场景不带场景参数（后端默认就是私聊）')

    // 防叠加：真正的机制是"这个角色的请求还在飞时不再发"（inFlight），
    // 而不是靠 last_action_at（那是**路由处理完**才更新的；测试里请求被桩掉了，库里的时间不会变）。
    let release
    const pending = new Promise((resolve) => { release = resolve })
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body || '{}') })
      await pending
      return { ok: true, status: 200 }
    }
    tick.resetAutoThrustState()
    tick.noteScene(1, { scene: 'chat', now: Date.parse('2026-10-02T13:00:00Z') })
    const flying = tick.runAutoThrustTick({ db, now: Date.parse('2026-10-02T13:00:00Z') })
    const second = await tick.runAutoThrustTick({ db, now: Date.parse('2026-10-02T13:00:01Z') })
    assert.equal(second.fired, 0, '同一个角色的请求还在飞 ⇒ 不许再发一条（否则她的动作会叠着发生）')
    release()
    assert.equal((await flying).fired, 1, '先发的那一条要正常完成')
    assert.equal(calls.length, 3, '整段测试总共只该发出 3 条请求（群聊 1 + 私聊 1 + 防叠加 1）')
  } finally {
    globalThis.fetch = realFetch
    tick.resetAutoThrustState()
  }
})

test('④ 定时器起停幂等，且 app.js / 路由真的接上了', () => {
  assert.equal(tick.isIntimateAutoThrustRunning(), false, '测试里默认不该在跑')
  assert.equal(tick.startIntimateAutoThrust({ intervalMs: 60_000 }), true)
  assert.equal(tick.startIntimateAutoThrust({ intervalMs: 60_000 }), false, '重复启动应当被忽略（否则会有两个 timer）')
  assert.equal(tick.isIntimateAutoThrustRunning(), true)
  tick.stopIntimateAutoThrust()
  assert.equal(tick.isIntimateAutoThrustRunning(), false)

  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  assert.match(app, /import \{ startIntimateAutoThrust \} from '\.\/src\/services\/intimateAutoThrust\.js'/, 'app.js 要导入 ticker')
  assert.match(app, /startIntimateAutoThrust\(\)/, 'app.js 要真的启动它（不启动 = 又变回"只是点一下"）')

  const route = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'intimateActions.js'), 'utf8')
  assert.match(route, /import \{ noteScene, noteReaction \} from '\.\.\/services\/intimateAutoThrust\.js'/,
    '路由要导入 noteScene（场景登记）+ noteReaction（完整反应记账）')
  assert.match(route, /noteScene\(id, \{[\s\S]{0,300}?scene: scene\.scene[\s\S]{0,300}?internal: req\.body\?\.internal === true/,
    '每次动作都要登记场景（ticker 靠它知道写哪里），且 ticker 自己的回声（internal）不许续期 —— 否则 TTL 永远不生效')
  // 完整反应**只记一笔**，且必须在"模型真的写出反应"之后（静默跳 / 省额度 / 失败分支都在它之前返回）
  assert.equal((route.match(/noteReaction\(/g) || []).length, 1, '完整反应只记一笔（静默跳与失败分支不许记）')
  assert.match(route.slice(route.indexOf("reason: 'instant_failed'")), /noteReaction\(id\)/,
    '模型真的写出反应之后才记账 —— 否则失败那一下也会把服务端反应跳封 20 秒')
})

// ── ⑤ 场景登记：立刻覆盖 + TTL（代码审查 finding：stale scene 劫持会话）──────────

test('⑤ 私聊动作**立刻**覆盖群登记（切回私聊后她的反应不许再写到群里）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') })
    return { ok: true, status: 200 }
  }
  try {
    tick.resetAutoThrustState()
    const t0 = Date.parse('2026-10-02T12:00:00Z')
    tick.noteScene(1, { scene: 'group', groupId: 7, now: t0 })
    await tick.runAutoThrustTick({ db, now: t0 })
    assert.deepEqual(calls.at(-1).body, { auto: true, scene: 'group', groupId: 7, internal: true },
      '群里开的自动 ⇒ 这一跳写回群里')

    // 玩家回到私聊点了一下（路由用同一个 noteScene 登记）⇒ 下一跳必须**立刻**改走私聊口径
    tick.noteScene(1, { scene: 'chat', now: t0 + 60_000 })
    await tick.runAutoThrustTick({ db, now: t0 + 63_000 })
    assert.equal('scene' in calls.at(-1).body, false,
      '私聊动作之后不许再带 group/groupId（覆盖必须立刻生效 —— 否则她的反应会落在错的聊天里）')
  } finally {
    globalThis.fetch = realFetch
    tick.resetAutoThrustState()
  }
})

test('⑤b 登记过 TTL 就作废（ticker 自己的回声不许续命）⇒ 这一跳只推状态，不猜会话', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') })
    return { ok: true, status: 200 }
  }
  try {
    tick.resetAutoThrustState()
    const t0 = Date.parse('2026-10-02T12:00:00Z')
    tick.noteScene(1, { scene: 'group', groupId: 7, now: t0 })
    // ticker 每一跳都会经过同一条路由（回声）—— 那种登记**不许**续期，否则 TTL 永远不到
    tick.noteScene(1, { scene: 'group', groupId: 7, internal: true, now: t0 + 9 * 60_000 })
    assert.equal(tick.sceneFor(1, { now: t0 + 9 * 60_000 + 1000 })?.scene, 'group', 'TTL 内仍认这份登记')
    assert.equal(tick.sceneFor(1, { now: t0 + tick.SCENE_MEMO_TTL_MS + 1 }), null,
      '过了 TTL 登记作废（回声没给它续命 —— 否则"群里开自动、人回私聊"之后它会一直往群里写）')

    // 作废之后推一跳：state 照常推进（她的累积不能停），但不许再写任何会话、也不许让她说话
    tick.noteScene(1, { scene: 'group', groupId: 7, now: t0 })
    const r = await tick.runAutoThrustTick({ db, now: t0 + tick.SCENE_MEMO_TTL_MS + 1000 })
    assert.equal(r.fired, 1, '状态跳照发（自动插入不能因为"不知道她在哪儿"就停住）')
    assert.deepEqual(calls.at(-1).body, { auto: true, silent: true, internal: true },
      '场景过期 ⇒ 不带 scene/groupId（不发到群里）且 silent（宁可这一跳她不出声，也不写进猜出来的会话）')
  } finally {
    globalThis.fetch = realFetch
    tick.resetAutoThrustState()
  }
})

// ── ⑥ 反应闸门：面板那一拍与服务端反应跳不许叠加 ──────────────────────────────

test('⑥ 反应闸门：面板/玩家刚出过一轮完整反应 ⇒ 服务端这一跳退化成状态跳（不再 20s+20s 叠加）', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(init.body || '{}') })
    return { ok: true, status: 200 }
  }
  try {
    tick.resetAutoThrustState()
    const t0 = Date.parse('2026-10-02T12:00:00Z')
    tick.noteScene(1, { scene: 'chat', now: t0 })
    assert.equal(tick.reactionDue(1, { now: t0 }), true, '从没出过反应 ⇒ 闸门开着')
    // 面板那一拍走 HTTP，路由在成功分支记账（这里等价地记一次）
    tick.noteReaction(1, { at: t0 })
    assert.equal(tick.reactionDue(1, { now: t0 + tick.AUTO_REACTION_INTERVAL_MS - 1 }), false, '闸门关着')
    assert.equal(tick.reactionDue(1, { now: t0 + tick.AUTO_REACTION_INTERVAL_MS }), true, '满 20 秒才重开')

    // 闸门关着 ⇒ 服务端这一跳只能是状态跳（不调模型）
    await tick.runAutoThrustTick({ db, now: t0 + 3000 })
    assert.equal(calls.at(-1).body.silent, true, '面板刚说完 ⇒ 服务端这一跳 silent（一次 LLM 都不许多烧）')
    // 闸门重开 ⇒ 反应跳（她真的说一句 + 配图）
    await tick.runAutoThrustTick({ db, now: t0 + tick.AUTO_REACTION_INTERVAL_MS + 1000 })
    assert.equal('silent' in calls.at(-1).body, false, '闸门开了 ⇒ 走完整链路')
    assert.equal(tick.reactionDue(1, { now: t0 + tick.AUTO_REACTION_INTERVAL_MS + 2000 }), false,
      '反应跳成功之后重新关闸（否则下一秒的下一跳会再来一次）')
  } finally {
    globalThis.fetch = realFetch
    tick.resetAutoThrustState()
  }
})
