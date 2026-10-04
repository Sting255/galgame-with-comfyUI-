/**
 * 玩具系统（专题-玩具系统与真机反馈三期 §二）· 服务层红测试。
 *
 * 覆盖：清单/门槛档、门控矩阵（含催眠豁免与群聊口径）、强度 clamp、多玩具叠加与摘戴生命周期、
 * <worn_toys> 分档文案（私聊/群聊两版）、摘戴反应 prompt（含 image_prompt 字段）、记忆 dedupeKey。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('toy fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const toys = await import('../src/services/toyService.js')

after(() => closeDb())

const db = () => getDb()
let seq = 0
function mkChar(name) {
  seq += 1
  return Number(db().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')").run('toy' + seq + '_' + name, name).lastInsertRowid)
}

test('① 玩具清单：5 种，部位/最大强度/门槛档齐全', () => {
  assert.deepEqual(toys.TOY_KEYS, ['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar'])
  const egg = toys.getToy('vibe_egg')
  assert.equal(egg.label, '跳蛋')
  assert.equal(egg.maxIntensity, 5)
  assert.equal(egg.level, 4)
  assert.equal(toys.getToy('anal_plug').maxIntensity, 3)
  assert.equal(toys.getToy('nipple_clamp').maxIntensity, 3)
  assert.equal(toys.getToy('nipple_clamp').level, 3)
  assert.equal(toys.getToy('collar').maxIntensity, 0)
  assert.equal(toys.getToy('collar').requiresIntimateAuth, false)
  assert.equal(toys.getToy('vibe_egg').requiresIntimateAuth, true)
  assert.equal(toys.getToy('nope'), null)
})

test('② 门控矩阵（装上）：2026-10-04 起「玩具限制全删」⇒ 一律放行；只留 unknown_toy 与 wakesOnIntensity', () => {
  const base = { affinity: 0, isOath: false, hypnotized: false, sleeping: false, intimateAuthorized: false, scene: 'chat', allowGroupAdult: false }
  // ① 新口径：任何好感/誓约/授权/场景组合都放行 —— 玩具不再委派 getTouchGate。
  //    ⚠️ 这不是"把旧断言删掉"：下面 ①b 把旧矩阵里**每一个**分支都逐个复验了一遍，
  //       只是期望值从「拦」改成「放」；`unknown_toy` / `wakesOnIntensity` / `level` 三条仍被钉死。
  for (const key of toys.TOY_KEYS) {
    const g = toys.gateToy({ ...base, toyKey: key })
    assert.equal(g.allowed, true, key + '：零条件必须放行')
    assert.equal(g.code, 'ok')
    assert.equal(g.message, '', '放行不该带拒绝文案')
    assert.equal(g.toy.key, key, '仍要把 toy 带回去（调用方要用）')
    assert.equal(g.exempt, null, '没被门控 ⇒ 也没有催眠豁免这回事')
  }
  // ①b 旧矩阵逐条复验（原断言保留在案，语义从"拦"变"放"）
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_egg', affinity: 85 }).allowed, true, '原先差「亲密」授权，现在放行')
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_stick', isOath: true }).allowed, true, '原先差授权，现在放行')
  assert.equal(toys.gateToy({ ...base, toyKey: 'anal_plug', affinity: 79, intimateAuthorized: true }).allowed, true, '原先差好感 80，现在放行')
  assert.equal(toys.gateToy({ ...base, toyKey: 'nipple_clamp', affinity: 59, intimateAuthorized: true }).allowed, true, '原先差好感 60，现在放行')
  assert.equal(toys.gateToy({ ...base, toyKey: 'collar', affinity: 55 }).allowed, true, '原先差好感 60，现在放行')
  // 群聊：原先 group_adult_blocked（开关关着时），现在也放行
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_egg', scene: 'group', allowGroupAdult: false }).allowed, true, '群聊不再拦玩具')
  assert.equal(toys.gateToy({ ...base, toyKey: 'nipple_clamp', scene: 'group' }).allowed, true)
  assert.equal(toys.gateToy({ ...base, toyKey: 'collar', scene: 'group' }).code, 'ok')
  // 催眠仍然"最高权限"，但玩具已经不需要豁免了 —— 结果一样是放行
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_egg', hypnotized: true }).allowed, true)

  // ② unknown_toy 仍要拦：那是**参数错误**（这个 key 根本不存在），不是内容限制
  const bad = toys.gateToy({ ...base, toyKey: 'nope' })
  assert.equal(bad.allowed, false)
  assert.equal(bad.code, 'unknown_toy')
  assert.equal(bad.toy, null)

  // ③ wakesOnIntensity 仍要算对（它不是门控，是"调高强度会把她弄醒"的表现开关）
  const asleep = toys.gateToy({ ...base, toyKey: 'vibe_egg', sleeping: true })
  assert.equal(asleep.allowed, true, '睡着也能轻柔装上')
  assert.equal(asleep.wakesOnIntensity, true)
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_egg' }).wakesOnIntensity, false, '没睡就不标记')
  assert.equal(toys.gateToy({ ...base, toyKey: 'collar', sleeping: true }).wakesOnIntensity, false, '项圈 maxIntensity=0 ⇒ 不会弄醒')

  // ④ level 仍要带回去（面板分组 / 文案用），且与玩具自身分档一致
  assert.equal(toys.gateToy({ ...base, toyKey: 'vibe_egg' }).level, 4)
  assert.equal(toys.gateToy({ ...base, toyKey: 'anal_plug' }).level, 4)
  assert.equal(toys.gateToy({ ...base, toyKey: 'nipple_clamp' }).level, 3)
})

test('③ 强度 clamp：0~max，项圈恒 0，非数字回落', () => {
  assert.equal(toys.clampIntensity('vibe_egg', 7), 5)
  assert.equal(toys.clampIntensity('vibe_egg', -1), 0)
  assert.equal(toys.clampIntensity('vibe_egg', '3.7'), 3)
  assert.equal(toys.clampIntensity('anal_plug', 9), 3)
  assert.equal(toys.clampIntensity('collar', 4), 0)
  assert.equal(toys.clampIntensity('vibe_egg', 'abc'), 0)
})

test('④ 佩戴生命周期：多件叠加 / 调强度 / 摘下保留行 / 重戴 upsert / 统计戴过次数', () => {
  const id = mkChar('A')
  const t0 = new Date('2026-09-30T10:00:00Z')
  const first = toys.equipToy(id, 'vibe_egg', { intensity: 3, now: t0 })
  assert.equal(first.toyKey, 'vibe_egg')
  assert.equal(first.intensity, 3)
  assert.equal(first.status, 'worn')
  assert.ok(first.equippedAt)
  toys.equipToy(id, 'anal_plug', { intensity: 1, now: t0 })
  toys.equipToy(id, 'nipple_clamp', { intensity: 2, now: t0 })
  assert.equal(toys.listWornToys(id).length, 3)
  const up = toys.setToyIntensity(id, 'vibe_egg', 5)
  assert.equal(up.intensity, 5)
  assert.equal(toys.listWornToys(id).find(t => t.toyKey === 'vibe_egg').intensity, 5)
  const removed = toys.removeToy(id, 'vibe_egg', { now: t0 })
  assert.equal(removed.status, 'removed')
  assert.deepEqual(toys.listWornToys(id).map(t => t.toyKey).sort(), ['anal_plug', 'nipple_clamp'])
  // 行保留 ⇒ 可统计「戴过几次」
  assert.equal(toys.countEquipHistory(id, 'vibe_egg'), 1)
  const again = toys.equipToy(id, 'vibe_egg', { intensity: 2, now: new Date('2026-09-30T11:00:00Z') })
  assert.equal(again.status, 'worn')
  assert.equal(toys.listWornToys(id).length, 3, '重戴是 upsert（UNIQUE(character_id, toy_key)）')
  assert.equal(toys.countEquipHistory(id, 'vibe_egg'), 2)
  const rows = db().prepare('SELECT COUNT(*) AS n FROM character_worn_toys WHERE character_id = ?').get(id).n
  assert.equal(rows, 3, '同种玩具永远只有一行')
})

test('⑤ <worn_toys> 块：零佩戴不注入；分档文案/已戴时长/多件分节', () => {
  const id = mkChar('B')
  assert.equal(toys.buildWornToysBlock(id, { scene: 'chat' }), null)
  const now = new Date('2026-09-30T10:00:00Z')
  toys.equipToy(id, 'vibe_egg', { intensity: 3, now: new Date(now.getTime() - 40 * 60000) })
  const block = toys.buildWornToysBlock(id, { scene: 'chat', now })
  assert.ok(block.startsWith('<worn_toys>') && block.endsWith('</worn_toys>'))
  assert.ok(block.includes('跳蛋'))
  assert.ok(block.includes('强度3/5'))
  assert.ok(block.includes('已戴40分钟'))
  assert.ok(block.includes('强度3：持续的刺激'), '要带分档描写指引')
  assert.ok(block.includes('强度4~5：强烈刺激'))
  assert.ok(!block.includes('本节只对'), '私聊版不带成员限定行')
  toys.equipToy(id, 'anal_plug', { intensity: 0, now })
  toys.equipToy(id, 'collar', { now })
  const multi = toys.buildWornToysBlock(id, { scene: 'chat', now })
  assert.ok(multi.includes('跳蛋') && multi.includes('肛塞') && multi.includes('项圈'))
  assert.ok(multi.includes('强度0：只是异物感'))
  assert.ok(/阴蒂|阴道|后庭|颈部/.test(multi), '按部位分节')
  const group = toys.buildWornToysBlock(id, { scene: 'group', now })
  assert.ok(group.includes('本节只对「'))
  assert.ok(group.includes('看得到她的异样但不知道原因'))
  // 已戴 >1 小时
  toys.removeToy(id, 'vibe_egg', { now })
  toys.equipToy(id, 'vibe_egg', { intensity: 2, now: new Date(now.getTime() - 75 * 60000) })
  assert.ok(toys.buildWornToysBlock(id, { scene: 'chat', now }).includes('超过1小时'))
})

test('⑥ 摘戴反应 prompt：三种事件都要求 JSON 且含 image_prompt 字段（与 §一① 同字段名）', () => {
  const prompt = toys.buildToyReactionPrompt({ event: 'equip', toyKey: 'vibe_egg', intensity: 3, minutesWorn: 0, userName: '用户' })
  const joined = prompt.messages.map(m => m.content).join('\n')
  assert.ok(joined.includes('image_prompt'), '出图 prompt 字段名与 §一① 一致（A 未落地也先按字段名写）')
  assert.ok(joined.includes('reaction_text'))
  assert.ok(joined.includes('emotion_delta') && joined.includes('facial_expression') && joined.includes('annoyed'))
  assert.ok(joined.includes('JSON'))
  for (const event of ['remove', 'set_intensity']) {
    const p = toys.buildToyReactionPrompt({ event, toyKey: 'anal_plug', intensity: 1, minutesWorn: 30, userName: '用户' })
    assert.ok(p.messages.map(m => m.content).join('\n').includes('image_prompt'), event + ' 也要 image_prompt')
  }
  assert.equal(prompt.temperature > 0, true)
})

test('⑦ 记忆挂点：dedupeKey 与内容（戴上/摘下各一条）', () => {
  const id = mkChar('C')
  const at = '2026-09-30 10:00:00'
  assert.equal(toys.toyMemoryDedupeKey(id, 'vibe_egg', at), 'toy:' + id + ':vibe_egg:' + at)
  const equip = toys.buildToyMemoryEntry({ characterId: id, toyKey: 'vibe_egg', event: 'equip', intensity: 3, at })
  assert.equal(equip.dedupe_key, toys.toyMemoryDedupeKey(id, 'vibe_egg', at))
  assert.ok(equip.content.includes('跳蛋'))
  const remove = toys.buildToyMemoryEntry({ characterId: id, toyKey: 'vibe_egg', event: 'remove', intensity: 5, at })
  assert.ok(remove.dedupe_key.endsWith(':remove:' + at) || remove.dedupe_key !== equip.dedupe_key, '摘下与戴上不互相覆盖')
  assert.ok(remove.content.includes('摘下') || remove.content.includes('取'))
})
