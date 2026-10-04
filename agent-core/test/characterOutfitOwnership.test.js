/**
 * 着装/外观的**归属**守卫（2026-10-02 用户：「角色的衣服容易串到一起」「所有的提示词都要改」）
 *
 * 根因：`characterPersona.js` 的着装注入块原本是**无主**的 ——
 *   【限时服饰（当前生效，优先级最高，多套同时叠加）——画面必须完整呈现以下全部要素】
 *   【着装裁定（优先级：限时服饰 > 角色专属形态 > 基础外观，逐条执行）】
 * 单角色生图没问题；但**多人同场**（群聊成员资料卡 / 多人事件 / 朋友圈 / 梦境 / 小镇）时，
 * 「画面必须完整呈现全部要素」会被模型读成"这张图里每个人都穿这个" ⇒
 * 把限时服饰穿到所有人身上、把各人的衣服配饰混着写 —— 就是用户说的"衣服串到一起"。
 *
 * 修法（只改唯一入口，58 个调用点自动受益）：调用方给了 owner（= 角色名）时，
 * 每段都写成「XX的限时服饰 / XX的着装裁定」，并追加一条"不得混穿"的硬约束；
 * **不给 owner 时输出与改动前逐字节一致** —— 单角色路径不许被写坏。
 *
 * 这一份就是那次修复的回归钉：带归属的必须带到底，不带归属的必须一字不改。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async (url) => { throw new Error(`no network in test: ${url}`) }

const {
  buildOutfitInjectionBlocks, buildCharacterAppearanceSection, buildCharacterPersona, buildImageCrossRefInfo,
} = await import('../src/services/characterPersona.js')

const LIM = [{ name: '女仆装', description: '黑白女仆装，白色蕾丝围裙' }]
const EXC = { name: '花嫁形态', description: '白色婚纱，头纱' }
const char = (name) => ({
  id: 1,
  display_name: name,
  short_prompt: `${name}是第三人的简短人设。`,
  base_prompt: `你是${name}。\n\n## 你的外观\n- 黑长直，红瞳，深蓝校服`,
})

/** 旧的"无主"句式：在有归属的输出里必须彻底消失，在无归属的输出里必须原样保留 */
const UNOWNED_LEAD = '【限时服饰（当前生效，优先级最高，多套同时叠加）——画面必须完整呈现以下全部要素】'
const OWNERSHIP_LINE = '只属于'

test('① 交叉参考（多人同框）永远带归属，且旧的"无主"句式消失', () => {
  const s = buildImageCrossRefInfo(char('德丽莎'), { outfits: { limited: LIM, exclusive: EXC } })
  assert.ok(s.includes('德丽莎的限时服饰'), '限时服饰段要写明是谁的')
  assert.ok(s.includes('德丽莎的角色专属形态'), '专属形态段要写明是谁的')
  assert.ok(s.includes('德丽莎的着装裁定'), '着装裁定要写明只适用于谁')
  assert.ok(s.includes('只属于德丽莎一个人'), '要带"不得混穿"的硬约束')
  assert.ok(!s.includes('画面必须完整呈现以下全部要素'), '无主句式必须消失（它就是串味的来源）')
})

test('② 多角色 persona（给了 person）带归属，且不会把别人的衣服写进来', () => {
  const a = buildCharacterPersona(char('甲'), {
    variant: 'short', person: '甲',
    outfits: { limited: [{ name: '甲的和服', description: '樱色和服' }], exclusive: null },
  })
  assert.ok(a.includes('甲的限时服饰'), '甲的着装段要写"甲的"')
  assert.ok(a.includes('只属于甲一个人'), '要有硬约束')
  assert.ok(!a.includes('乙'), '甲的段落里不该出现别的角色')
  assert.ok(!a.includes(UNOWNED_LEAD), '无主句式必须消失')
})

test('③ 单角色路径（不给 owner）与改动前逐字节一致 —— 不许把单人场景写啰嗦', () => {
  const plain = buildCharacterAppearanceSection(char('路人'), { outfits: { limited: LIM, exclusive: null } })
  // 旧句式原样保留（这就是"零影响"的硬证据）
  assert.ok(plain.includes(UNOWNED_LEAD), '无 owner 时必须原样保留旧句式')
  assert.ok(plain.includes('【着装裁定（优先级：限时服饰 > 基础外观，逐条执行）】'), '无 owner 时裁定标题也要原样')
  assert.ok(!plain.includes(OWNERSHIP_LINE), '无 owner 时不许冒出"只属于…"这种归属句')
  assert.ok(!plain.includes('路人的'), '无 owner 时不许擅自加名字前缀')

  // persona 不给 person 时同理
  const p = buildCharacterPersona(char('路人'), { variant: 'short', outfits: { limited: LIM, exclusive: null } })
  assert.ok(p.includes(UNOWNED_LEAD), 'short persona 不给 person 时也要保持旧口径')
  assert.ok(!p.includes('只属于'), 'short persona 不给 person 时不许加硬约束')

  // 纯函数层：owner 为空 ⇒ 三段里一处归属痕迹都不该有
  const blocks = buildOutfitInjectionBlocks({ limited: LIM, exclusive: EXC })
  assert.ok(blocks.lead.includes(UNOWNED_LEAD))
  assert.ok(!blocks.lead.includes('只用在'))
  assert.ok(!blocks.tail.includes(OWNERSHIP_LINE))
})

test('④ 两种来源（通用限时服饰 / 角色专属形态）都带归属', () => {
  const onlyLim = buildImageCrossRefInfo(char('银狼'), { outfits: { limited: LIM, exclusive: null } })
  assert.ok(onlyLim.includes('银狼的限时服饰'))
  assert.ok(onlyLim.includes('只属于银狼一个人'))

  const onlyExc = buildImageCrossRefInfo(char('云璃'), { outfits: { limited: [], exclusive: EXC } })
  assert.ok(onlyExc.includes('云璃的角色专属形态'))
  assert.ok(onlyExc.includes('只用在云璃身上'), '只有专属形态时要写"只用在某人身上"')
  assert.ok(onlyExc.includes('只属于云璃一个人'))
})

test('⑤ 没有生效外观时完全不注入（不许凭空加归属句）', () => {
  const s = buildImageCrossRefInfo(char('纳西妲'), { outfits: { limited: [], exclusive: null } })
  assert.ok(!s.includes('只属于'))
  assert.ok(!s.includes('限时服饰'))
  assert.equal(buildOutfitInjectionBlocks({ limited: [], exclusive: null }), null)
})

test('⑥ 归属用的是各自的名字：两个人一起拼，互不串味', () => {
  const one = buildCharacterPersona(char('甲'), { variant: 'short', person: '甲', outfits: { limited: [{ name: '甲的和服', description: '樱色和服' }], exclusive: null } })
  const two = buildCharacterPersona(char('乙'), { variant: 'short', person: '乙', outfits: { limited: [{ name: '乙的皮衣', description: '黑色皮衣' }], exclusive: null } })
  assert.ok(one.includes('甲的和服') && !one.includes('乙的皮衣'), '甲的段落里不能出现乙的衣服')
  assert.ok(two.includes('乙的皮衣') && !two.includes('甲的和服'), '乙的段落里不能出现甲的衣服')
  assert.ok(!one.includes('## 乙的外观') && !two.includes('## 甲的外观'))
})
