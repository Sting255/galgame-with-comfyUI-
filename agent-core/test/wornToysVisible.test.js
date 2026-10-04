/**
 * 「戴着玩具 ⇒ 任何场景的出图都看得见」守卫（2026-10-02 用户反馈）
 *
 * 用户原话：
 *   「如果戴上玩具之后 没有摘下的情况下 在其他的地方出图也得要看到玩具的所在 在群聊里也要让其他角色
 *     看到那种 比如在性爱的时候的图 动作的图 朋友圈的图 就算角色戴着玩具 但是就是没有出来玩具的图
 *     这个是很不真实的」
 *
 * 做法：外观段（`buildCharacterAppearanceSection`）是**所有生图路径的必经之处**，玩具接在那里
 * ⇒ 私聊图 / 群聊图 / 朋友圈图 / 亲密图 / 立绘 / 报纸全部自动带上。
 * 但 characterPersona 不能直接 import toyService（后者本来就 import 前者 ⇒ 成环）⇒ 走注册表叶子。
 *
 * 钉四层：
 *   ① 注册表语义：没登记 / 抛异常 / 返回非字符串 ⇒ 一律空串（零注入，绝不让生图失败）；
 *   ② 外观段：没戴 ⇒ **与改动前逐字节一致**；戴了 ⇒ 追加一行且**前缀不被破坏**；
 *   ③ 多角色：传 person + scene=group ⇒ 带「只对 X 生效」归属（别把她的玩具画到别人身上）；
 *   ④ 接线与不成环：toyService 登记、characterPersona 只 import 叶子（**不许** import toyService）。
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

const { buildCharacterAppearanceSection } = await import('../src/services/characterPersona.js')
const { registerWornToysProvider, resetWornToysProvider, wornToysBrief, hasWornToysProvider } =
  await import('../src/services/wornToysBrief.js')

const CHAR = { id: 9, display_name: '德丽莎', base_prompt: '你是德丽莎。\n\n## 你的外观\n银发蓝眼，白色修女服。' }
const pure = buildCharacterAppearanceSection(CHAR, { outfits: null })

test('① 注册表：没登记 / 抛异常 / 返回非字符串 ⇒ 空串（零注入，不拖垮生图）', () => {
  resetWornToysProvider()
  assert.equal(hasWornToysProvider(), false)
  assert.equal(wornToysBrief(9), '', '没登记 ⇒ 空串')

  registerWornToysProvider(() => { throw new Error('boom') })
  assert.equal(wornToysBrief(9), '', '产出函数抛异常 ⇒ 空串（生图是主线，不能被玩具拖垮）')

  registerWornToysProvider(() => 12345)
  assert.equal(wornToysBrief(9), '', '返回非字符串 ⇒ 空串')

  registerWornToysProvider(() => '   ')
  assert.equal(wornToysBrief(9), '', '空白 ⇒ 空串')

  registerWornToysProvider(null)
  assert.equal(hasWornToysProvider(), false, '登记 null ⇒ 视作撤销')
})

test('② 外观段：没戴逐字节一致；戴了追加一行且前缀不被破坏', () => {
  resetWornToysProvider()
  assert.equal(buildCharacterAppearanceSection(CHAR, { outfits: null }), pure, '没登记 ⇒ 与纯外观逐字节一致')

  registerWornToysProvider(() => '她身上正戴着：跳蛋（阴蒂，Lv3）')
  const withToys = buildCharacterAppearanceSection(CHAR, { outfits: null })
  assert.ok(withToys.startsWith(pure), '追加不得破坏原有前缀（既有多条逐字节断言依赖这点）')
  assert.equal(withToys, `${pure}\n她身上正戴着：跳蛋（阴蒂，Lv3）`)
  resetWornToysProvider()
  assert.equal(buildCharacterAppearanceSection(CHAR, { outfits: null }), pure, '撤销登记后回到一致')
})

test('③ 多角色：传 person + scene=group ⇒ 带归属（别把她的玩具画到别人身上）', () => {
  resetWornToysProvider()
  const seen = []
  registerWornToysProvider((id, opts) => {
    seen.push({ id, opts })
    return opts.scene === 'group' && opts.person ? `【只对「${opts.person}」生效】她身上正戴着：跳蛋` : '她身上正戴着：跳蛋'
  })
  const group = buildCharacterAppearanceSection(CHAR, { outfits: null, person: '德丽莎', scene: 'group' })
  assert.match(group, /【只对「德丽莎」生效】/, '群聊里要写清"只对她"')
  assert.deepEqual(seen.at(-1), { id: 9, opts: { scene: 'group', person: '德丽莎' } }, '要把 id / person / scene 透传下去')
  resetWornToysProvider()
})

test('④ 接线与不成环：toyService 登记，characterPersona 只 import 叶子（不许 import toyService）', () => {
  const persona = fs.readFileSync(path.join(SRC, 'services', 'characterPersona.js'), 'utf8')
  assert.match(persona, /import \{ wornToysBrief \} from '\.\/wornToysBrief\.js'/, 'characterPersona 要用叶子')
  assert.ok(!/from '\.\/toyService\.js'/.test(persona),
    'characterPersona 绝不能 import toyService（toyService 本来就 import 它 ⇒ 成环）')

  const toys = fs.readFileSync(path.join(SRC, 'services', 'toyService.js'), 'utf8')
  assert.match(toys, /registerWornToysProvider\(/, 'toyService 要登记自己的产出函数')
  assert.match(toys, /不要漏画，也不要画成没戴/, '生图用的那句话要明确"必须画出来"')
  assert.match(toys, /listWornToys\(characterId\)/, '产出来自真实的佩戴状态')
})
