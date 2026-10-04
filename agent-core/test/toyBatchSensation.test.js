/**
 * 玩具系统 · **批量装卸的"一次性感受"口径**（2026-10-04 用户第二轮反馈：
 * 「一次性拿掉的话不要一个一个的去反馈 直接让角色一次性感受到然后再去反馈」）。
 *
 * 上一版的问题（真机日志实证）：批量确实只调了一次模型，但**事实句只提了 `applied[0]` 一件**
 * ——摘了 2 件，事实句只写「项圈」，整批清单被塞进 `额外上下文：` 兜底，
 * 模型眼里那还是"一次一件"。所以这里钉四件事：
 *
 *   ① ≥2 件：事实句**列全清单**（每件的名字、位置、档位都在），并点明"同一瞬间"；
 *   ② ≥2 件：写作要求**禁止**"一件接一件"的时间顺序，并要求每件都被感受到、画面里都出现；
 *   ③ **1 件回落单件口径**（逐字节一致）——一件不算"一批"，措辞不许变成"一次性…1 件"；
 *   ④ 不传 `batchToys` 时与改造前**逐字节一致**（老链路的回归保护）。
 *
 * 另钉批量记忆：**一次批量一条**（原来一件都不写），dedupeKey 与 key 顺序无关。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const {
  buildToyReactionPrompt, normalizeBatchToys, buildToyBatchMemoryEntry, getToy,
} = await import('../src/services/toyService.js')

/** 取出 prompt 里那一行「事实：…」 */
function factLine(prompt) {
  const line = String(prompt.messages[0].content).split('\n').find(l => l.startsWith('事实：'))
  assert.ok(line, 'prompt 里必须有事实句')
  return line
}
const systemOf = (prompt) => String(prompt.messages[0].content)
const build = (opts) => buildToyReactionPrompt({ userName: '阿强', ...opts })

test('① ≥2 件：事实句列全清单（名字/位置/档位）+ 点明"同一瞬间"，不再只提第一件', () => {
  const p = build({
    event: 'equip',
    toyKey: 'vibe_egg',
    batchToys: [{ toyKey: 'vibe_egg', intensity: 3 }, { toyKey: 'collar', intensity: 0 }],
  })
  const fact = factLine(p)
  // 两件的名字都在（这是上一版的 bug：只写「跳蛋」）
  assert.ok(fact.includes('「跳蛋」'), '缺跳蛋：' + fact)
  assert.ok(fact.includes('「项圈」'), '缺项圈（上一版就是这个 bug）：' + fact)
  // 位置与档位逐件写清（整批糊成一个档位 = 给模型编假数据）
  assert.ok(fact.includes('阴蒂'), fact)
  assert.ok(fact.includes('颈部'), fact)
  assert.ok(fact.includes('强度 3'), fact)
  assert.ok(fact.includes('强度 0'), fact)
  // "一起到位"的措辞 —— 她要把这一批当成**一次**感受
  assert.ok(fact.includes('2 件'), fact)
  assert.ok(fact.includes('同一瞬间一起到位'), fact)
  assert.ok(fact.includes('不是一件一件戴上的'), fact)
  // 必须**不**再是单件模板（这个词组只属于 EVENT_TEXT.equip 的单件路径）
  assert.ok(!fact.includes('你给她戴上了'), '批量路径不许再用单件事实句：' + fact)
})

test('② ≥2 件：写作要求禁止"一件接一件"，并要求每件被感受到、画面里都出现', () => {
  const s = systemOf(build({
    event: 'equip',
    toyKey: 'vibe_egg',
    batchToys: ['vibe_egg', 'nipple_clamp'],
  }))
  assert.ok(s.includes('这一批是同一次动作'), '要写明"一次动作"')
  assert.ok(s.includes('禁止'), '要显式禁止逐件推进')
  assert.ok(s.includes('一件接一件') || s.includes('时间顺序'), '要点明被禁的写法')
  assert.ok(s.includes('每一件都要'), '要求每件都被感受到')
  assert.ok(s.includes('这几件的作用方式：'), '作用方式的措辞要切到"这几件"')
  assert.ok(s.includes('这几件同时'), '画面要求也要切到"这几件同时"')
  assert.ok(!s.includes('这件玩具的作用方式：'), '不许再写"这件玩具"')
})

test('③ 1 件回落单件口径：与完全不传 batchToys **逐字节一致**（一件不算一批）', () => {
  const base = { event: 'equip', toyKey: 'vibe_egg', intensity: 2, minutesWorn: 0 }
  const without = build(base)
  const withOne = build({ ...base, batchToys: ['vibe_egg'] })
  assert.equal(systemOf(withOne), systemOf(without))
  assert.ok(!systemOf(withOne).includes('同一瞬间'), '1 件不许出现"同一瞬间"')
  assert.ok(factLine(withOne).includes('你给她戴上了'), '1 件要走单件事实句')
})

test('④ 不传 batchToys：事实句与改造前逐字节一致（老链路回归保护）', () => {
  const p = build({ event: 'equip', toyKey: 'vibe_egg', intensity: 2, minutesWorn: 0 })
  assert.equal(factLine(p), '事实：阿强你给她戴上了「跳蛋」（阴蒂），当前强度 2，已戴 0 分钟。')
  assert.ok(systemOf(p).includes('这件玩具的作用方式：'))
  assert.ok(!systemOf(p).includes('这一批是同一次动作'))

  const r = build({ event: 'remove', toyKey: 'collar', intensity: 0, minutesWorn: 12 })
  assert.equal(factLine(r), '事实：阿强你把她身上的玩具摘了下来「项圈」（颈部），当前强度 0，已戴 12 分钟。')
})

test('⑤ 摘下 ≥2 件：措辞是"同一瞬间一起消失"（不是"一起到位"）', () => {
  const fact = factLine(build({
    event: 'remove',
    toyKey: 'collar',
    batchToys: ['collar', 'vibe_egg', 'nipple_clamp'],
  }))
  assert.ok(fact.includes('一次从她身上取了下来'), fact)
  assert.ok(fact.includes('3 件'), fact)
  assert.ok(fact.includes('同一瞬间一起消失'), fact)
  assert.ok(fact.includes('不是一件一件拿走的'), fact)
  assert.ok(!fact.includes('一起到位'), '摘下不该用"到位"：' + fact)
})

test('⑥ 档位不齐时不编档位（宁可不说，也不给模型一个假的"统一强度"）', () => {
  const fact = factLine(build({
    event: 'equip',
    toyKey: 'vibe_egg',
    batchToys: [{ toyKey: 'vibe_egg', intensity: 3 }, 'collar'], // 第二件没给档位
  }))
  assert.ok(!fact.includes('强度'), '档位不齐就别写档位：' + fact)
  assert.ok(fact.includes('「跳蛋」') && fact.includes('「项圈」'), fact)
})

test('⑦ normalizeBatchToys：<2 件返回 []（回落单件）、未知 key 保底成原字符串、脏输入不炸', () => {
  assert.deepEqual(normalizeBatchToys(null), [])
  assert.deepEqual(normalizeBatchToys(['a']), [])
  assert.deepEqual(normalizeBatchToys([]), [])
  assert.deepEqual(normalizeBatchToys(['', '']), [])
  const two = normalizeBatchToys(['vibe_egg', 'collar'])
  assert.deepEqual(two.map(t => t.key), ['vibe_egg', 'collar'])
  assert.deepEqual(two.map(t => t.label), ['跳蛋', '项圈'])
  assert.deepEqual(two.map(t => t.part), ['阴蒂', '颈部'])
  // 未知 key 不许静默丢（前端传了新 key 时，至少事实句里要有它）
  const unknown = normalizeBatchToys(['vibe_egg', 'ghost_toy'])
  assert.equal(unknown.length, 2)
  assert.equal(unknown[1].label, 'ghost_toy')
  assert.equal(unknown[1].part, '身上')
  // 对象形态：档位透传
  const objs = normalizeBatchToys([{ toyKey: 'vibe_egg', intensity: 4 }, { key: 'collar', intensity: 0 }])
  assert.deepEqual(objs.map(t => t.intensity), [4, 0])
  // 脏输入（null / 数字 / 空对象）不炸，也不占位
  assert.equal(normalizeBatchToys([null, 3, {}, 'vibe_egg', 'collar']).length, 2)
})

test('⑧ 批量记忆：一次批量**一条**、措辞是"一次一批"、dedupeKey 与 key 顺序无关', () => {
  const e = buildToyBatchMemoryEntry({ characterId: 7, toyKeys: ['vibe_egg', 'collar'], event: 'equip', userName: '阿强' })
  assert.ok(e, '要有记忆条目')
  assert.ok(e.content.includes('阿强一次给我戴上了'), e.content)
  assert.ok(e.content.includes('跳蛋') && e.content.includes('项圈'), e.content)
  assert.ok(e.content.includes('一次 2 件'), e.content)
  assert.deepEqual(e.toyKeys, ['vibe_egg', 'collar'])

  const r = buildToyBatchMemoryEntry({ characterId: 7, toyKeys: ['vibe_egg', 'collar'], event: 'remove', userName: '阿强' })
  assert.ok(r.content.includes('全取了下来'), r.content)

  // dedupeKey：顺序无关（同一批换个顺序不算新事件）
  const a = buildToyBatchMemoryEntry({ characterId: 7, toyKeys: ['vibe_egg', 'collar'], at: '2026-10-04 10:00:00' })
  const b = buildToyBatchMemoryEntry({ characterId: 7, toyKeys: ['collar', 'vibe_egg'], at: '2026-10-04 10:00:00' })
  assert.equal(a.dedupe_key, b.dedupe_key)
  // 事件不同 → 不同 key（摘下不能把戴上那条顶掉）
  const c = buildToyBatchMemoryEntry({ characterId: 7, toyKeys: ['collar', 'vibe_egg'], at: '2026-10-04 10:00:00', event: 'remove' })
  assert.notEqual(a.dedupe_key, c.dedupe_key)
  // 空清单不产记忆（没有事件就没有记忆）
  assert.equal(buildToyBatchMemoryEntry({ characterId: 7, toyKeys: [] }), null)

  // 实测标签来自目录（防止有人改了标签而记忆里写的是旧词）
  assert.equal(getToy('vibe_egg').label, '跳蛋')
})
