/**
 * 性爱里的四件新玩法（2026-10-02 用户原话）
 *
 * 「拍打的玩法是和性爱在一起的 是一种玩法 再加上一个捆绑类吧 也是一种玩法 和拍屁股一起 会累积快感高潮那种」
 * 「插入之后可以选一个自动继续插入 然后我可以继续去抚摸或者拍屁股捏其他地方或者插入玩具之类的」
 * 「催眠手机里加上一个 禁止高潮 高潮值就可以一直累加 直到手动解锁后瞬间释放高潮爽感 这个禁止高潮的按钮不需要催眠也可以点击操作」
 *
 * 这一份钉**机制与边界**（纯函数 + 真落库两条路都走）：
 *   ① 拍打：不用插进去也能拍、把累积往上推；捆绑时更狠
 *   ② 捆绑：开关；推类累积 ×1.25；手绑着换不了姿势（有代价的玩法）
 *   ③ 自动抽插：开关（要求已插入）+ **服务端补算**（时间过去 = 她在自己动）+ 最多 5 个 tick
 *   ④ 禁止高潮：能一路涨过 100 且不收口；解开时若已憋到 100 以上 ⇒ 当场释放（记一次高潮 + 清零）；
 *      没憋到就只是解开，不硬造高潮；**不需要催眠**（不传 hypnotized 也照常工作）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-newplay-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async () => { throw new Error('intimateNewPlays.test: 测试不出网') }

const { getDb } = await import('../src/db/index.js')
const db = getDb()
/** 服务层：下面统一用 `S.xxx` 调用（纯函数 + 落库两条路都在这一份里） */
const S = await import('../src/services/intimateActionService.js')

/** 造一场"已经在做"的状态 */
function active(patch = {}) {
  return {
    ...S.emptySceneState(1), active: true, penetrating: true, positionKey: 'missionary',
    actKey: 'vaginal', pace: 2, accumulation: 30, rounds: 5,
    lastActionAt: new Date(Date.now()).toISOString(),
    ...patch,
  }
}

test('① 拍打：不用插进去也能拍，且把累积往上推（捆绑时更狠）', () => {
  const plain = S.planIntimateAction(active({ penetrating: false, accumulation: 20 }), { actionKey: 'spank', affinity: 90 })
  assert.equal(plain.ok, true, plain.message)
  assert.ok(plain.next.accumulation > 20, '拍打必须推进累积（用户：和拍屁股一起会累积快感高潮）')
  assert.equal(plain.effects.spanked, true)

  const bound = S.planIntimateAction(active({ penetrating: false, accumulation: 20, bondage: 1 }), { actionKey: 'spank', affinity: 90 })
  assert.ok(bound.next.accumulation > plain.next.accumulation, '绑着躲不开 ⇒ 同一记拍得更狠')
})

test('② 捆绑：分型位掩码（可叠加）+ 绑得越多涨得越快 + 换姿势仍由玩家控制', () => {
  // 单点「捆手」= 位 1；再点解开
  const tie = S.planIntimateAction(active({ bondage: 0 }), { actionKey: 'bondage', affinity: 90 })
  assert.equal(tie.next.bondage, 1)
  assert.equal(tie.effects.bondageChanged, 'tied')
  const untie = S.planIntimateAction(active({ bondage: 1 }), { actionKey: 'bondage', affinity: 90 })
  assert.equal(untie.next.bondage, 0)
  assert.equal(untie.effects.bondageChanged, 'untied')

  // 2026-10-02 分型捆绑：各点一次可叠加（手腕 1｜龟甲缚 2｜脚踝 4｜全身 8｜口球 16）
  let s = active({ bondage: 1 })
  s = S.planIntimateAction(s, { actionKey: 'bind_box', affinity: 90 }).next
  s = S.planIntimateAction(s, { actionKey: 'bind_gag', affinity: 90 }).next
  assert.equal(s.bondage, 19, '手腕+龟甲缚+口球 = 1|2|16')
  assert.deepEqual(S.listBonds(s.bondage).sort(), ['bind_box', 'bind_gag', 'bondage'].sort())
  const unGag = S.planIntimateAction(s, { actionKey: 'bind_gag', affinity: 90 })
  assert.equal(unGag.next.bondage, 3, '解开只清掉自己那一位（别把别的也解了）')

  // 涨得更快，且**绑得越多越快**（只捆手腕仍是 ×1.25，老口径逐字不变）
  const free = S.planIntimateAction(active({ accumulation: 30, bondage: 0 }), { actionKey: 'thrust', affinity: 90 })
  const one = S.planIntimateAction(active({ accumulation: 30, bondage: 1 }), { actionKey: 'thrust', affinity: 90 })
  const many = S.planIntimateAction(active({ accumulation: 30, bondage: 31 }), { actionKey: 'thrust', affinity: 90 })
  const gain = (r) => r.next.accumulation - 30
  assert.ok(gain(one) > gain(free), `绑着涨得更快：${gain(one)} vs ${gain(free)}`)
  assert.ok(Math.abs(gain(one) - Math.round(gain(free) * S.BONDAGE_SENSITIVITY)) <= 1, '只捆手腕 = ×1.25 口径')
  assert.ok(gain(many) > gain(one), `绑得越多涨得越快：${gain(many)} vs ${gain(one)}`)
  assert.equal(S.bondageMultiplier(31), 2, '五处全绑封顶 2×')

  // 2026-10-02 用户原话：「换姿势是我控制角色 捆绑后不需要角色自己去换姿势」
  // ⇒ 换姿势是**玩家**点出来的动作，绑着也该能换（绑着的"动不了"体现在叙事与累积倍率里）
  const swap = S.planIntimateAction(active({ bondage: 1 }), { actionKey: 'position', positionKey: 'doggystyle', affinity: 90 })
  assert.equal(swap.ok, true, '绑着也能换姿势（姿势由玩家控制）')
  assert.equal(swap.next.positionKey, 'doggystyle')
})

test('③ 自动抽插：要求已插入；时间过去 = 她在自己动（服务端补算，且有上限）', () => {
  const noPen = S.planIntimateAction(active({ penetrating: false }), { actionKey: 'auto', affinity: 90 })
  assert.equal(noPen.ok, false)
  assert.equal(noPen.code, 'not_penetrating')

  const on = S.planIntimateAction(active({ autoThrust: 0 }), { actionKey: 'auto', affinity: 90 })
  assert.equal(on.next.autoThrust, 1)
  assert.equal(on.effects.autoChanged, 'on')

  // 不传 now ⇒ 零补算（老口径逐字节不变）
  const noNow = S.planIntimateAction(active({ autoThrust: 1, accumulation: 30 }), { actionKey: 'thrust', affinity: 90 })
  assert.equal(noNow.effects.autoTicks, undefined)

  // 传了 now 且过了 9 秒 ⇒ 3 个 tick（每 3 秒一个）
  const t0 = Date.now()
  const elapsed = S.planIntimateAction(
    active({ autoThrust: 1, accumulation: 30, lastActionAt: new Date(t0 - 9000).toISOString() }),
    { actionKey: 'thrust', affinity: 90, now: t0 }
  )
  // 传了 now 且过了 9 秒 ⇒ 本该 3 个 tick，但 2026-10-02 把补算上限从 5 收到 2（配合节奏重定：
  // 服务端 ticker 每 3 秒真的会推，补算只是"错过了几次"的兜底，不该一次补一大截把累积顶到高潮）
  assert.equal(elapsed.effects.autoTicks, S.AUTO_MAX_CATCHUP_TICKS, '9 秒 ⇒ 受补算上限约束')
  assert.ok(elapsed.next.accumulation > 30, '她自己动着 ⇒ 累积涨')

  // 挂机很久也最多 5 个 tick（不许"回来直接满格"）
  const longIdle = S.planIntimateAction(
    active({ autoThrust: 1, accumulation: 0, lastActionAt: new Date(t0 - 3600_000).toISOString() }),
    { actionKey: 'thrust', affinity: 90, now: t0 }
  )
  assert.equal(longIdle.effects.autoTicks, S.AUTO_MAX_CATCHUP_TICKS)

  // 没开自动 ⇒ 补算不生效
  const off = S.planIntimateAction(
    active({ autoThrust: 0, accumulation: 30, lastActionAt: new Date(t0 - 9000).toISOString() }),
    { actionKey: 'thrust', affinity: 90, now: t0 }
  )
  assert.equal(off.effects.autoTicks, undefined)
})

test('④ 禁止高潮：能涨过 100 且不收口；解开才释放（不需要催眠）', () => {
  const lock = S.planIntimateAction(active({ denial: 0, accumulation: 40 }), { actionKey: 'denial', affinity: 90 })
  assert.equal(lock.next.denial, 1, '开启禁止高潮')
  assert.equal(lock.effects.denialChanged, 'locked')
  assert.equal(lock.effects.climaxed, undefined, '开启本身不是高潮')

  // 憋着的时候可以一路涨过 100，而且**不**自动高潮
  let st = active({ denial: 1, accumulation: 96, penetrating: true })
  const r1 = S.planIntimateAction(st, { actionKey: 'thrust', affinity: 90 })
  assert.ok(r1.next.accumulation > S.MAX_ACCUMULATION, `应该涨过满格：${r1.next.accumulation}`)
  assert.equal(r1.next.climaxCount, 0, '禁高潮期间绝不许收口')
  assert.equal(r1.effects.climaxed, undefined)

  // 一路顶到上限也不收口
  const r2 = S.planIntimateAction(active({ denial: 1, accumulation: S.DENIAL_MAX_ACCUMULATION }), { actionKey: 'faster', affinity: 90 })
  assert.equal(r2.next.accumulation, S.DENIAL_MAX_ACCUMULATION, '到上限只是不再涨')
  assert.equal(r2.next.climaxCount, 0)

  // 解开：已憋过 100 ⇒ 当场释放
  const release = S.planIntimateAction(active({ denial: 1, accumulation: 150 }), { actionKey: 'denial', affinity: 90 })
  assert.equal(release.next.denial, 0)
  assert.equal(release.effects.denialChanged, 'released')
  assert.equal(release.effects.climaxed, true, '瞬间释放 = 记一次高潮')
  assert.equal(release.next.climaxCount, 1)
  assert.equal(release.next.accumulation, 0, '释放后清零')
  assert.ok(release.effects.denialRelease?.peak >= 100, '要记住她憋到了多高（写 prompt 用）')

  // 没憋到阈值就解开 ⇒ 只是解开，不硬造一场高潮
  const early = S.planIntimateAction(active({ denial: 1, accumulation: 40 }), { actionKey: 'denial', affinity: 90 })
  assert.equal(early.next.denial, 0)
  assert.equal(early.effects.climaxed, undefined)
  assert.equal(early.next.climaxCount, 0)

  // 不需要催眠：全程没传 hypnotized，开关照样工作
  assert.equal(S.planIntimateAction(active({ denial: 0 }), { actionKey: 'denial' }).next.denial, 1)
})

test('⑤ 提示块：三个开关与拍打都要写进块 / 反应 prompt（模型看不见 = 没做）', () => {
  const block = S.buildIntimateSceneBlock(active({ bondage: 1, denial: 1, autoThrust: 1, accumulation: 130 }), { chatUserName: '阿远' })
  assert.match(block, /【捆绑 \/ SM】/, '场景块要写捆绑 —— 并且要说明这是她的快感来源，不只是服从')
  assert.match(block, /快感来源之一/, 'SM = 受虐本身给她快感（用户 2026-10-02 的澄清）；缺了模型只会写成"她在忍耐"')
  assert.match(block, /【禁止高潮】/, '场景块要写禁止高潮')
  // 2026-10-03 用户澄清：「自动的意思是自动插入 不是自己动」⇒ 这一行必须是"他在自动插送"
  assert.match(block, /【他正在自动插送】/, '场景块要写自动插入（而且主语是他）')
  assert.equal(/【她自己动着】/.test(block), false, '不许再写成她自己动（用户明确纠正过）')
  assert.match(block, /130/, '要把"已经涨到多少"写出来')
  assert.match(block, /绝对不许写她到/, '禁高潮要有硬约束')

  const text = (p) => [p.system, p.user, ...(p.messages || []).map(x => x?.content || '')].join('\n')
  const released = S.buildIntimateActionPrompt({
    characterName: '纳西妲', userName: '阿远', actionKey: 'denial',
    state: active({ denial: 1, accumulation: 150 }),
    next: active({ denial: 0, accumulation: 0, climaxCount: 1 }),
    beat: '他把它解开了', position: { key: 'missionary', label: '传教士体位' },
  })
  assert.match(text(released), /他放开了/, '解锁那一轮要走"释放"文案，不是普通的"推过顶点"')
})

test('⑥ 落库往返：三个开关态重启后还在（真 DB）', () => {
  const id = 987
  // 角色表这一路迁移下来列很多，这里按"非空且无默认值的列"动态补一个合法行 —— 免得写死列名被后续迁移打红
  const cols = db.prepare("SELECT name, type FROM pragma_table_info('characters') WHERE \"notnull\" = 1 AND dflt_value IS NULL AND name <> 'id'").all()
  const names = ['id', ...cols.map(c => c.name)]
  const values = [id, ...cols.map(c => (/INT|REAL|NUM/i.test(c.type) ? 0 : '测试'))]
  db.prepare(`INSERT OR IGNORE INTO characters (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...values)
  const st = { ...S.emptySceneState(id), active: true, penetrating: true, positionKey: 'missionary', actKey: 'vaginal', pace: 3, accumulation: 120, bondage: 1, autoThrust: 1, denial: 1 }
  S.saveIntimateScene(id, st, { now: new Date().toISOString() })
  const back = S.getIntimateScene(id)
  assert.equal(back.bondage, 1, '捆绑要落库')
  assert.equal(back.autoThrust, 1, '自动抽插要落库')
  assert.equal(back.denial, 1, '禁止高潮要落库')
  assert.equal(back.accumulation, 120, '过满格的累积不许被夹回去')
})

test('⑦ 新动作都进了清单与拒绝码（前端/路由按它渲染与分类）', () => {
  for (const key of ['command', 'spank', 'bondage', 'auto', 'denial',
    // 2026-10-02 分型捆绑（用户：「不只是捆上手 还有龟甲缚 脚 身体 口球」）
    'bind_box', 'bind_legs', 'bind_body', 'bind_gag']) {
    assert.ok(S.getIntimateAction(key), `${key} 必须在 INTIMATE_ACTIONS 里`)
  }
  // 7 条老动作 + command + spank / bondage / auto / denial + 4 条分型捆绑 = 16
  assert.equal(S.INTIMATE_ACTION_KEYS.length, 16, '7 条老动作 + 5 条玩法 + 4 条分型捆绑')
  assert.deepEqual(Object.keys(S.BONDAGE_BITS), ['bondage', 'bind_box', 'bind_legs', 'bind_body', 'bind_gag'],
    '位掩码的键要与动作键一一对应（加分型必须同时进 BONDAGE_BITS）')
  const src = fs.readFileSync(new URL('../src/services/intimateActionService.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''), /action === '(thrust|faster|slower)'/,
    '比对动作要用 actionKey（action 是对象 —— 上一轮踩过这个坑）')
})

test('⑧ 面板/手机的投影必须带出三个开关态（真链路第一次跑就漏了这三个字段）', () => {
  const snap = S.buildPanelSnapshot(active({ bondage: 1, autoThrust: 1, denial: 1, accumulation: 130 }), { affinity: 90 })
  assert.equal(snap.state.bondage, true, 'bondage 要投影出去，不然面板显示不出"绑着"')
  assert.equal(snap.state.autoThrust, true, 'autoThrust 要投影出去，不然自动抽插的按钮状态是错的')
  assert.equal(snap.state.denial, true, 'denial 要投影出去 —— 手机上的"高潮控制"全靠它')
  assert.equal(snap.state.denialPeak, 130, '禁高潮时要把"憋到多高"带给 UI')
  const off = S.buildPanelSnapshot(active(), { affinity: 90 })
  assert.equal(off.state.bondage, false)
  assert.equal(off.state.autoThrust, false)
  assert.equal(off.state.denial, false)
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
