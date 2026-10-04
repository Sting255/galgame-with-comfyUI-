/**
 * 催眠指令 `force_toy`（2026-10-01 用户原话：「催眠状态也不能强制让角色用上玩具」）
 *
 * ## 玩法语义（与用户确认后定下的口径，本文件把它钉住）
 * · **归催眠域**：与 body_control 同档，只在「完全控制」（active && body_controlled）下可下发；
 *   未催眠时下发 → NOT_HYPNOTIZED（forced_climax 是唯一例外）。
 * · **真的是"强制用上"**：服务端当场把玩具戴到身上（写 character_worn_toys），
 *   不是只写一句让她"照做"的台词 —— 用户要的就是真的用上。
 * · **门控归属**：她的**意愿**被强制（催眠本来就在玩具门控里豁免，实测 exempt=hypnosis）；
 *   但**系统约束不越过**：玩具必须存在（INVALID）、强度按该玩具上限 clamp、玩具总开关关着时整条不可用（TOYS_DISABLED）。
 * · **一次性**：写进 pending_directive（编码 `force_toy|<toyKey>|<intensity>`），由 chat.js / 群聊当轮消费即清。
 *
 * ## 为什么编码进同一个 TEXT 列
 * 该列是"读一次就清空"的一次性字段；加列会让清空语义分散到两列、容易漏清；
 * 编码进同一列则沿用既有链路，且非 force_toy 的取值仍是裸 kind ⇒ 对旧值完全向后兼容。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-forcetoy-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { config } = await import('../src/config.js')
const hypno = await import('../src/services/hypnosisService.js')
const prompt = await import('../src/services/hypnosisPrompt.js')
const { getToy, listWornToys, TOY_KEYS } = await import('../src/services/toyService.js')

config.features.hypnosis = true
config.features.toys = true

let seq = 0
function seedCharacter(label) {
  return Number(getDb().prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`forcetoy_${++seq}`, label, '你是她。').lastInsertRowid)
}
function enterHypnosis(id) {
  hypno.grantHypnosisPhone(id)
  hypno.hypnotize(id, { minutes: 60 })
}

test('★ 门控：在催眠中（active）即可命令她用玩具，不要求"完全控制"', () => {
  // 2026-10-01 用户第二次报：「催眠玩具不能点击」。
  // 前端那一层当时引用了不存在的矩阵键（永远置灰），后端这一层则要求 active && bodyControlled。
  // 两层都放宽到「催眠中即可」：她是不是"完全受控"由叙事与其它状态决定，
  // 这里只负责把指令下发出去（用户要的就是"在催眠里能命令她"）。
  const id = seedCharacter('半控')
  enterHypnosis(id)
  // 手工把 body_controlled 压成 0：模拟"在催眠中、但不是完全控制"
  getDb().prepare('UPDATE character_hypnosis SET body_controlled = 0 WHERE character_id = ?').run(id)
  const st = hypno.getHypnosisState(id)
  assert.equal(st.active, true, '夹具：她确实在催眠中')
  assert.equal(st.bodyControlled, false, '夹具：不是完全控制')

  const toyKey = TOY_KEYS[0]
  const res = hypno.issueCommand(id, 'force_toy', { toyKey, intensity: 2 })
  assert.ok(res && res.toy, '在催眠中应当允许下发 force_toy')
  assert.equal(res.toy.toyKey, toyKey)
  // 指令要真的写进去（这条路径走 else 分支的 upsert：只写指令两列，不动催眠状态列）
  const row = getDb().prepare('SELECT pending_directive, body_controlled FROM character_hypnosis WHERE character_id = ?').get(id)
  assert.match(String(row.pending_directive), /^force_toy\|/, '指令要落库')
  assert.equal(row.body_controlled, 0, '放宽门控不许顺手改动她的受控状态')
  // 催眠仍然有效（active 是 active_until 的比较结果，用服务读回，别自己拼 SQL）
  assert.equal(hypno.getHypnosisState(id).active, true, '也不许把催眠状态改掉')
})

test('★ 门控：没在催眠里仍然拒绝（NOT_HYPNOTIZED）', () => {
  const id = seedCharacter('没催眠')
  hypno.grantHypnosisPhone(id)
  const toyKey = TOY_KEYS[0]
  assert.throws(
    () => hypno.issueCommand(id, 'force_toy', { toyKey, intensity: 2 }),
    err => err?.code === 'NOT_HYPNOTIZED' || /not hypnotized/i.test(err?.message || ''),
    '未催眠时不能命令她用玩具'
  )
})

test('编码往返：force_toy|toyKey|intensity[|mode][|curve] 可解析；裸 kind 与空值一律 null', () => {
  const enc = hypno.encodeForceToyDirective('vibe_egg', 4)
  assert.equal(enc, 'force_toy|vibe_egg|4', '都不给时必须与旧编码**逐字一致**（老存档、老消费方都吃它）')
  assert.deepEqual(hypno.parseForceToyDirective(enc), { toyKey: 'vibe_egg', intensity: 4, mode: null, curve: null })
  // 2026-10-02 扩展：第三段（振动模式）可选 —— 给了就带上，也解析得回来
  const encMode = hypno.encodeForceToyDirective('vibe_egg', 4, 'pulse')
  assert.equal(encMode, 'force_toy|vibe_egg|4|pulse')
  assert.deepEqual(hypno.parseForceToyDirective(encMode), { toyKey: 'vibe_egg', intensity: 4, mode: 'pulse', curve: null })
  // 第四段（强度曲线）可选；只给曲线时中间留空段
  const encCurve = hypno.encodeForceToyDirective('vibe_egg', 4, '', 'ramp_up')
  assert.equal(encCurve, 'force_toy|vibe_egg|4||ramp_up')
  assert.deepEqual(hypno.parseForceToyDirective(encCurve), { toyKey: 'vibe_egg', intensity: 4, mode: null, curve: 'ramp_up' })
  const encBoth = hypno.encodeForceToyDirective('vibe_egg', 4, 'pulse', 'surge')
  assert.equal(encBoth, 'force_toy|vibe_egg|4|pulse|surge')
  assert.deepEqual(hypno.parseForceToyDirective(encBoth), { toyKey: 'vibe_egg', intensity: 4, mode: 'pulse', curve: 'surge' })
  assert.equal(hypno.encodeForceToyDirective('vibe_egg', 4, '', ''), 'force_toy|vibe_egg|4', '空 = 不给')
  // ⚠️ `force_toy|vibe_egg|4|` 现在**是合法的**（空模式段 = 只给曲线时的形态，见上面的 encCurve），
  //    所以它不在坏值清单里；真正非法的长这样：
  for (const bad of ['', 'body_control', 'force_toy', 'force_toy|vibe_egg', 'force_toy|vibe_egg|-1', 'force_toy|vibe_egg|4|pulse|surge|extra']) {
    assert.equal(hypno.parseForceToyDirective(bad), null, `${JSON.stringify(bad)} 不该被当成 force_toy 指令`)
  }
  assert.equal(hypno.isForceToyDirective(enc), true)
  assert.equal(hypno.isForceToyDirective(encBoth), true)
  assert.equal(hypno.isForceToyDirective('forced_climax'), false)
})

test('枚举一致性：三处取值域都要有 force_toy（漏一处就会静默不生效）', () => {
  assert.ok(hypno.HYPNOSIS_COMMANDS.includes('force_toy'), 'HYPNOSIS_COMMANDS 要收')
  assert.ok(hypno.PENDING_DIRECTIVES.includes('force_toy'), 'PENDING_DIRECTIVES 要收')
  assert.ok(prompt.DIRECTIVE_KINDS.includes('force_toy'), 'hypnosisPrompt.DIRECTIVE_KINDS 要收')
})

test('语义①：未催眠时下发 force_toy 被拒（与 body_control 同档）', () => {
  const id = seedCharacter('未催眠')
  const err = (() => { try { hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 2 }) } catch (e) { return e } })()
  assert.ok(err, '应当抛错')
  assert.equal(err.code, 'NOT_HYPNOTIZED')
  assert.equal(listWornToys(id).length, 0, '被拒时绝不能留下佩戴记录')
})

test('语义②：催眠中下发 → 玩具**真的戴上**，且指令编码进一次性字段', () => {
  const id = seedCharacter('已催眠')
  enterHypnosis(id)
  const result = hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 4 })
  assert.equal(result.toy.toyKey, 'vibe_egg')
  assert.equal(result.toy.intensity, 4)

  const worn = listWornToys(id)
  assert.equal(worn.length, 1, '服务端要当场真的戴上（不只是写台词）')
  assert.equal(worn[0].toyKey, 'vibe_egg')
  assert.equal(worn[0].intensity, 4)
  assert.equal(worn[0].status, 'worn')

  const row = getDb().prepare('SELECT pending_directive, last_command FROM character_hypnosis WHERE character_id = ?').get(id)
  assert.equal(row.pending_directive, 'force_toy|vibe_egg|4', '一次性指令要带上是哪个玩具、强度多少')
  assert.equal(row.last_command, 'force_toy')
})

test('语义③：强度按玩具上限 clamp（不越过物理上限）', () => {
  const id = seedCharacter('超限')
  enterHypnosis(id)
  const toy = getToy('vibe_egg')
  const r = hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 999 })
  assert.equal(r.toy.intensity, toy.maxIntensity, `要 clamp 到 ${toy.maxIntensity}`)
  assert.equal(listWornToys(id)[0].intensity, toy.maxIntensity)
})

test('语义③：未知玩具 → INVALID；玩具总开关关着 → TOYS_DISABLED', () => {
  const id = seedCharacter('未知玩具')
  enterHypnosis(id)
  const e1 = (() => { try { hypno.issueCommand(id, 'force_toy', { toyKey: 'not_a_toy', intensity: 1 }) } catch (e) { return e } })()
  assert.equal(e1?.code, 'INVALID')
  assert.equal(getDb().prepare('SELECT pending_directive FROM character_hypnosis WHERE character_id = ?').get(id).pending_directive, '', '失败时不许留下指令')

  config.features.toys = false
  const e2 = (() => { try { hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 1 }) } catch (e) { return e } })()
  assert.equal(e2?.code, 'TOYS_DISABLED')
  config.features.toys = true
})

test('展示载荷：directiveToyPayload 给出注入块要用的名字/位置/强度', () => {
  const raw = hypno.encodeForceToyDirective('vibe_stick', 3)
  const payload = hypno.directiveToyPayload(raw)
  assert.equal(payload.toyKey, 'vibe_stick')
  assert.equal(payload.label, getToy('vibe_stick').label)
  assert.equal(payload.maxIntensity, getToy('vibe_stick').maxIntensity)
  assert.ok(payload.part && payload.part.length > 0, '要给出佩戴位置（模型照着演）')
  assert.equal(hypno.directiveToyPayload('body_control'), null)
  assert.equal(hypno.directiveToyPayload('force_toy|gone_now|2'), null, '玩具已被删掉时回 null，不抛错')
})

test('注入块：说明"已经在身上 + 不许取下 + 按强度档演出"，且标签正确', () => {
  const raw = hypno.encodeForceToyDirective('vibe_egg', 5)
  const block = prompt.buildDirectiveBlock(raw, { toy: hypno.directiveToyPayload(raw), subject: '流萤' })
  assert.match(block, /<hypnosis_command kind="force_toy">/)
  assert.match(block, /跳蛋/, '要写出玩具名')
  assert.match(block, /已经戴上/, '必须说清"已经戴上"，不是"将要"')
  assert.match(block, /强度 5\/5/, '强度要写进块里')
  // 注意措辞顺序：块里是「无法自己取下…（不许写这类结果…）」——取下在"不许"之前，
  // 所以不能写 /不许.*取下/（第一版就是这么写的，匹配不上却看着像功能坏了）。
  assert.match(block, /无法自己取下、推开或挣脱/, '要说清她做不到取下')
  assert.match(block, /不许写这类结果/, '要明确禁止演成"挣脱成功"')
  // 块有 300 字上限，超了会被 wrapTaggedBlock **直接截断**（不报错）——所以这里必须钉住长度，
  // 否则以后往块里加一句话就可能把关键禁令切掉，而所有测试仍然绿。
  assert.ok(
    block.length <= prompt.MAX_COMMAND_BLOCK_CHARS,
    `force_toy 块 ${block.length} 字，超过上限 ${prompt.MAX_COMMAND_BLOCK_CHARS}，会被截断`
  )
  assert.match(block, /本节只对「流萤」生效/, '群聊成员限定行')
  // 没有载荷时也要退化出块（不能因为缺展示信息就整块消失）
  assert.match(prompt.buildDirectiveBlock('force_toy'), /<hypnosis_command kind="force_toy">/)
  // 旧的裸 kind 行为不受影响
  assert.equal(prompt.buildDirectiveBlock('nonsense'), '')
  assert.match(prompt.buildDirectiveBlock('body_control'), /<hypnosis_command kind="body_control">/)
})

test('路由契约：/command 接受 toyKey / intensity，并把 TOYS_DISABLED 映射成 403', () => {
  const route = fs.readFileSync(new URL('../src/routes/hypnosis.js', import.meta.url), 'utf8')
  assert.match(route, /issueCommand\(id, kind, \{ toyKey: req\.body\?\.toyKey, intensity: req\.body\?\.intensity, mode: req\.body\?\.mode, curve: req\.body\?\.curve \}\)/)
  assert.match(route, /kind === 'force_toy'/, '要有 force_toy 分支（点完立刻触发一轮）')
  assert.match(route, /TOYS_DISABLED[\s\S]{0,120}403/, 'TOYS_DISABLED 要映射 403')
  // 消费侧：私聊与群聊都要把玩具载荷传进注入块
  for (const file of ['../src/routes/chat.js', '../src/services/groupChatEngine.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(src, /directiveToyPayload\(directive\)/, `${file} 要把玩具载荷传进 buildDirectiveBlock`)
  }
})

test('振动模式 / 强度曲线（2026-10-02 扩展）：给对了就真的设上并写进指令；给错了就当没给（不许写假指令）', async () => {
  const id = seedCharacter('模式巡检')
  enterHypnosis(id)
  // 用玩具服务自己的表（不硬编码键名 —— 猜键名会"看着通过、其实没设上"）
  const { VIBRATION_MODE_KEYS, INTENSITY_CURVE_KEYS } = await import('../src/services/toy/mechanics.js')
  const modes = [...VIBRATION_MODE_KEYS]
  const curves = [...INTENSITY_CURVE_KEYS]
  assert.ok(modes.length >= 2, `模式表至少要两种，实际 ${modes.join('/')}`)
  assert.ok(curves.length >= 2, `曲线表至少要两种，实际 ${curves.join('/')}`)

  const ok = hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 2, mode: modes[0] })
  assert.equal(ok.toy.mode, modes[0], '模式设上了就要回报给调用方（面板/日志都看它）')

  const okCurve = hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 2, mode: modes[0], curve: curves[0] })
  assert.equal(okCurve.toy.mode, modes[0], '模式与曲线可以一起给')
  assert.equal(okCurve.toy.curve, curves[0], '曲线设上了也要回报')

  // 不存在的模式/曲线：当没给 —— 绝不能写一条"她现在是 xxx"的假指令
  // （setToyMode / setToyCurve 返回的是对象不是布尔，这里正是那条"看着通过其实没设上"的防线）
  const bogus = hypno.issueCommand(id, 'force_toy', { toyKey: 'vibe_egg', intensity: 2, mode: 'definitely_not_a_mode', curve: 'definitely_not_a_curve' })
  assert.equal(bogus.toy.mode, null, '无效模式必须被丢掉')
  assert.equal(bogus.toy.curve, null, '无效曲线必须被丢掉')
  const worn = listWornToys(id).find(t => t.toyKey === 'vibe_egg')
  assert.ok(worn, '玩具仍然要戴上（模式/曲线无效不影响戴上）')
})

test('全玩具巡检：5 件玩具逐个都能被强制戴上（不漏某项）', () => {
  const id = seedCharacter('全玩具')
  enterHypnosis(id)
  for (const key of TOY_KEYS) {
    const r = hypno.issueCommand(id, 'force_toy', { toyKey: key, intensity: 1 })
    assert.equal(r.toy.toyKey, key, `${key} 要能下发`)
    assert.ok(listWornToys(id).some(t => t.toyKey === key), `${key} 要真的戴上`)
  }
  assert.equal(listWornToys(id).length, TOY_KEYS.length)
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
