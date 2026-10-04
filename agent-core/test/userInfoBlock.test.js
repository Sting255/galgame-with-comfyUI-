/**
 * 玩家个人信息块（`<user_info>`）的口径回归（2026-10-02）
 *
 * 用户原话：「角色对话还是有一些不**遵**从设定，和玩家的**性别**与**自我描述**」
 *
 * ## 真事（先说清它怎么坏的）
 * 玩家信息存在 `system_settings`（`user_nickname` / `user_gender` / `user_persona` / `user_appearance`），
 * 映射到 `config.user.*`（`src/config.js:374-378`）。私聊主链（`routes/chat.js` 的 `<user_info>`）四个字段都推，
 * 但两条"非主链"——**叫醒**（`wakeService`）与**延迟回复**（`replyQueueScheduler`）——只推
 * `nickname/gender/appearance`，**`persona`（玩家的自我描述）被整条丢掉** ✗。
 * ⇒ 同一份用户设定在不同链路里口径不一致，用户感知就是"有时听设定、有时不听"。
 *
 * ## 本文件钉住的契约（以后改这两条链别退回去）
 * 1. `persona` 必须进块，措辞「其他说明：」与私聊主链**逐字一致**；
 * 2. **门控**也必须带上 `persona` —— 否则"只有 persona、其余为空"时整块被跳过（写了等于没写）；
 * 3. 块末尾必须有**遵从约束**（同 prompt 里 `<user_relation>` 写着身份优先级最高，而这里只是事实陈述，
 *    模型容易不当回事 ⇒ 写反性别、或拿角色自己的性别/身份顶替）；
 * 4. 四个字段全空 ⇒ 返回 `null`（调用方不推这一段），且**不许出现空壳字段**（如「外观特征：」后面没内容）；
 * 5. 两条链**共用同一个构造器**（`buildUserInfoBlock`），不允许各写一份再漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { config } = await import('../src/config.js')
const { buildUserInfoBlock } = await import('../src/services/wakeService.js')

/** 用户真库里的真实值（`user_nickname=Tester` / `user_gender=男` / `user_persona=学校的老师` / 外观为空） */
const REAL = { nickname: 'Tester', gender: '男', appearance: '', persona: '学校的老师' }

/** 改 config.user（和 updateUserConfig 改的是同一个对象），每次先清空再赋值，避免相互污染 */
function setUser(u) {
  Object.assign(config.user, { nickname: '', gender: '', appearance: '', persona: '' }, u || {})
}

test('① 真值：persona 进块且措辞与私聊主链一致；appearance 为空不出现空壳', () => {
  setUser(REAL)
  const s = buildUserInfoBlock('Tester')
  assert.ok(s && s.startsWith('<user_info>') && s.endsWith('</user_info>'), '要是一个完整的 <user_info> 块')
  assert.match(s, /消息中标记为"user"的人是"Tester"/)
  assert.match(s, /性别：男/)
  assert.match(s, /其他说明：学校的老师/, 'persona 必须进块（这就是"玩家的自我描述"）')
  assert.doesNotMatch(s, /外观特征：/, 'appearance 为空时不许拼出空壳字段')
})

test('② 门控边界：只有 persona、其余全空 ⇒ 仍然要出这一段（这正是原先被整块跳过的情形）', () => {
  setUser({ persona: '学校的老师' })
  const s = buildUserInfoBlock('Tester')
  assert.ok(s, '只有 persona 时不许整块跳过 —— 否则用户的自我描述写了等于没写')
  assert.match(s, /其他说明：学校的老师/)
})

test('③ 门控边界：只有 gender / 只有 appearance 也照样出块（原行为不能被改坏）', () => {
  setUser({ gender: '女' })
  assert.match(buildUserInfoBlock('Tester'), /性别：女/)
  setUser({ appearance: '戴眼镜' })
  assert.match(buildUserInfoBlock('Tester'), /外观特征：戴眼镜/)
})

test('④ 遵从约束必须在（钉"带着约束"这个行为，不钉具体行号）', () => {
  setUser(REAL)
  const s = buildUserInfoBlock('Tester')
  assert.match(s, /以此为准/)
  assert.match(s, /不要写成相反性别/)
  assert.match(s, /不要用你自己的性别或身份替代/)
})

test('⑤ 四个字段全空 ⇒ 返回 null（调用方据此不推这一段）', () => {
  setUser({})
  assert.equal(buildUserInfoBlock('Tester'), null)
})

test('⑥ 两条链共用同一个构造器，且只有构造器本体那一处拼字段（防漂移）', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services')
  const wake = fs.readFileSync(path.join(dir, 'wakeService.js'), 'utf8')
  const queue = fs.readFileSync(path.join(dir, 'replyQueueScheduler.js'), 'utf8')
  assert.match(queue, /import\s*\{[^}]*buildUserInfoBlock[^}]*\}\s*from\s*'\.\/wakeService\.js'/,
    '延迟回复链必须 import 同一个构造器（persona 就是在这条链上被丢掉的）')
  for (const [name, src] of [['wakeService', wake], ['replyQueueScheduler', queue]]) {
    assert.match(src, /buildUserInfoBlock\(/, `${name} 必须调用构造器`)
  }
  // 「外观特征：${…}」这种拼字段的写法**只允许出现在唯一实现里**。
  // ⚠️ 2026-10-02 第二次收口：构造器正文已从 wakeService **搬到 `characterPersona.js`**
  //    （私聊/群聊两条主链也要同一份措辞，两份实现迟早"改一处漏一处"——persona 就是这么被漏掉的）。
  //    所以这条断言钉的**对象**跟着搬了位置，但钉的**行为**没变：拼字段的地方有且只有一处。
  //    原先写的是"wakeService 里恰好 1 处（就是构造器自己）"，那是按当时的位置写的；
  //    收口后正确值是 wakeService 0 处、characterPersona 1 处、replyQueueScheduler 0 处。
  //    这里没有为了让旧断言变绿去留一句注释糊弄正则 —— 位置变了就把断言挪到新位置，别把守卫做成摆设。
  const inline = (s) => (s.match(/外观特征：\$\{/g) || []).length
  const personaSrc = fs.readFileSync(path.join(dir, 'characterPersona.js'), 'utf8')
  assert.equal(inline(personaSrc), 1, '拼字段只能有一处，且必须在唯一实现（characterPersona）里')
  assert.equal(inline(wake), 0, 'wakeService 现在只是适配层，不许再自己拼字段（否则又变成两份实现）')
  assert.equal(inline(queue), 0, 'replyQueueScheduler 不许再自己内联拼 <user_info>（会与主链漂移）')
})
