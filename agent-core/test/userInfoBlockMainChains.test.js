/**
 * 玩家信息块的**主链**契约（私聊 `<user_info>` / 群聊「用户信息：」）—— 2026-10-02
 *
 * 用户原话：「角色对话还是有一些不**遵**从设定，和玩家的**性别**与**自我描述**」
 *
 * ## 为什么单独一份（与 `test/userInfoBlock.test.js` 的关系）
 * 同名构造器现在有**两份**（都知道这不好，收尾要合并，但两条链的**话术**必须此刻就一致）：
 *   · `services/wakeService.js` 的 `buildUserInfoBlock(显示名)` —— 服务"叫醒 / 延迟回复"两条链，
 *     返回**带 `<user_info>` 标签的整块**，四字段全空时返回 `null`（那份文件自己的测试在 `test/userInfoBlock.test.js`）；
 *   · `services/characterPersona.js` 的 `buildUserInfoBlock(config.user, opts)` —— 服务**私聊 / 群聊**两条主链，
 *     返回**不含标签的内容**（标签由调用方保留：私聊是 `<user_info>…</user_info>`，群聊是「用户信息：」那一行）。
 * 本文件只钉**后者**以及它的两个调用点，**不碰**前者那份测试。
 *
 * ## 修复的实质
 * 主链原先是纯"事实陈述"（"性别：男。其他说明：学校的老师"），而同一 prompt 里 `<user_relation>`
 * 写着"这个身份为最高优先级" ⇒ 模型把玩家信息当**参考**而不是**设定**，
 * 于是写反性别、或拿角色自己的性别/身份顶替玩家。现在每条链都带**遵从约束**，且四链话术逐字一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUserInfoBlock } from '../src/services/characterPersona.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

/** 用户真库里的真实值（`user_nickname=Tester` / `user_gender=男` / `user_persona=学校的老师` / 外观为空） */
const REAL = { nickname: 'Tester', gender: '男', persona: '学校的老师', appearance: '' }

/** 四条链必须给模型同一句话 —— 逐字取自 `wakeService.js` 那份实现 */
const MUST_CONTAIN = ['以此为准', '不要写成相反性别', '不要用你自己的性别或身份替代']

test('① 真值：私聊口径 —— 事实 + 约束句都在，appearance 为空不留空壳', () => {
  const s = buildUserInfoBlock(REAL, { style: 'chat' })
  assert.match(s, /消息中标记为"user"的人是"Tester"/)
  assert.match(s, /性别：男/)
  assert.match(s, /其他说明：学校的老师/, 'persona（玩家的自我描述）必须进块')
  assert.doesNotMatch(s, /外观特征：/, 'appearance 为空时不许出现空壳字段')
  for (const w of MUST_CONTAIN) assert.ok(s.includes(w), `缺约束句片段：${w}`)
})

test('② 群聊口径：按群里昵称称呼，且同样带约束句；两种口径不互相串', () => {
  const g = buildUserInfoBlock(REAL, { style: 'group' })
  assert.match(g, /群里标记为「Tester」的发言来自真实用户/)
  assert.ok(!g.includes('消息中标记为"user"'), '群聊不该出现私聊叫法')
  for (const w of MUST_CONTAIN) assert.ok(g.includes(w))
  const c = buildUserInfoBlock(REAL, { style: 'chat' })
  assert.ok(!c.includes('群里标记为'), '私聊不该出现群聊叫法')
  // displayName 优先（群聊用的是 group 显示名）
  assert.match(buildUserInfoBlock(REAL, { style: 'group', displayName: '老王' }), /「老王」/)
})

test('③ 字段缺失/全空：不留空壳、也不返回空串（调用方不做二次兜底）', () => {
  const onlyPersona = buildUserInfoBlock({ persona: '学校的老师' })
  assert.match(onlyPersona, /其他说明：学校的老师/)
  assert.doesNotMatch(onlyPersona, /性别：|外观特征：/)

  const empty = buildUserInfoBlock({})
  assert.ok(empty.length > 0, '主链这里全空也要给内容（与 wakeService 那份"返回 null"是不同契约，见文件头）')
  assert.doesNotMatch(empty, /性别：|外观特征：|其他说明：/)
  for (const w of MUST_CONTAIN) assert.ok(empty.includes(w), '没填资料时约束句也在')

  // 非字符串字段当作"没填"
  assert.doesNotMatch(buildUserInfoBlock({ gender: null, persona: undefined, appearance: 0 }), /性别：|外观特征：|其他说明：/)
  assert.ok(buildUserInfoBlock(null).length > 0 && buildUserInfoBlock(undefined).length > 0)
})

test('④ worldHint：默认开（抵消"世界观面向女性而玩家为男"的冲突），可显式关', () => {
  assert.match(buildUserInfoBlock(REAL), /世界观里出现的性别措辞/)
  assert.ok(!buildUserInfoBlock(REAL, { worldHint: false }).includes('世界观里出现的性别措辞'))
})

test('⑤ 接线守卫：两条主链都必须走这个入口，不许再各自内联拼性别/自述', () => {
  const chatSrc = fs.readFileSync(path.join(SRC, 'routes', 'chat.js'), 'utf8')
  const groupSrc = fs.readFileSync(path.join(SRC, 'services', 'groupChatEngine.js'), 'utf8')

  assert.ok(/<user_info>\$\{buildUserInfoBlock\(/.test(chatSrc), '私聊要把它包在 <user_info> 里（标签被下游依赖）')
  assert.ok(/buildUserInfoBlock\(config\.user/.test(groupSrc), '群聊要调用同一个构造器')
  assert.ok(/import\s*\{[^}]*buildUserInfoBlock[^}]*\}\s*from\s*'\.\/characterPersona\.js'/.test(groupSrc),
    '群聊要从 characterPersona 引入（不许自己拼）')

  // 回归：老的内联拼装写法必须消失，否则口径会再次分叉
  assert.ok(!/infoParts/.test(chatSrc), 'chat.js 里不该再有内联 infoParts 拼装')
  assert.ok(!/userInfoLines/.test(groupSrc), 'groupChatEngine.js 里不该再有内联 userInfoLines 拼装')
})
