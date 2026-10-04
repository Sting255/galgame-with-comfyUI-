/**
 * 「对话预测必须猜**玩家**会说什么」的口吻护栏（2026-10-02）
 *
 * 用户原话：「对话预测的哪个时不时会变成猜测角色的想法而不是玩家的想法」。
 * 提示词里已经写了「绝对不要预测 assistant」，但模型偶尔还是会把角色的话/心理写进建议里；
 * 所以加了输出侧兜底 `sanitizeReplyGuesses`（chat.js）：像"角色在说话"的一律丢弃。
 *
 * 这一份直接钉住那个护栏：**真机上出现过的坏形态必须被拦下**，正常玩家口吻必须放行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async (url) => { throw new Error(`no network in test: ${url}`) }

const { sanitizeReplyGuesses } = await import('../src/routes/chat.js')

const KEQING = { id: 1, display_name: '刻晴' }

test('① 玩家口吻：放行（并去掉首尾空白）', () => {
  assert.deepEqual(sanitizeReplyGuesses({ a: ' 好耶，我想吃火锅！ ', b: '不了吧，点外卖吃吃就好' }, KEQING),
    { a: '好耶，我想吃火锅！', b: '不了吧，点外卖吃吃就好' })
  assert.deepEqual(sanitizeReplyGuesses({ a: '你是不是又想赖账', b: '那我陪你走一趟' }, KEQING),
    { a: '你是不是又想赖账', b: '那我陪你走一趟' })
})

test('② 玩家喊她名字 ⇒ **放行**（最正常的说话方式；2026-10-02 收窄判据）', () => {
  // ⚠️ 这一条原来写的是反的（"出现角色名就丢"）—— 后果是玩家喊一句「刻晴你别这样」时
  //    两条建议**全被丢掉**（因为"有一条不合格就整体放弃"），用户感觉"预测时好时坏"。
  //    收窄后：只有"名字 + 冒号"的演讲式写法才算角色在说话（见 ③），喊名字属于玩家口吻。
  assert.deepEqual(sanitizeReplyGuesses({ a: '刻晴你别这样', b: '好吧' }, KEQING),
    { a: '刻晴你别这样', b: '好吧' })
  // 名字出现在句中/句尾同样放行
  assert.deepEqual(sanitizeReplyGuesses({ a: '我刚还在想刻晴会不会来', b: '走吧' }, KEQING),
    { a: '我刚还在想刻晴会不会来', b: '走吧' })
  // 名字里带正则元字符也不能把判据弄坏（有些角色名里有括号/点号）
  assert.deepEqual(sanitizeReplyGuesses({ a: '走吧', b: '好' }, { display_name: 'A.I.(改)' }),
    { a: '走吧', b: '好' })
  assert.equal(sanitizeReplyGuesses({ a: 'A.I.(改)：我们走', b: '好' }, { display_name: 'A.I.(改)' }), null,
    '带元字符的名字 + 冒号 ⇒ 仍然是"角色在说话"，必须丢')
})

test('③ 「角色名：台词」形态 ⇒ 丢弃', () => {
  assert.equal(sanitizeReplyGuesses({ a: '刻晴：我们走吧', b: '好的' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '走吧走吧', b: '云璃：我也去' }, { display_name: '云璃' }), null)
})

test('④ 括号里的心理 / 神态 ⇒ 丢弃（这是最典型的"猜角色的想法"）', () => {
  assert.equal(sanitizeReplyGuesses({ a: '（她想：他怎么这样）好吧', b: '那我们走吧' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '好啊', b: '（脸红）你别说了' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '(*轻轻叹气*) 嗯', b: '好' }, KEQING), null)
})

test('⑤ 旁白 / 第三人称 / 动作描写 ⇒ 丢弃', () => {
  assert.equal(sanitizeReplyGuesses({ a: '她低声说了一句', b: '好' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '好', b: '**轻轻叹气**那我们走吧' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '暗自想了一下', b: '好' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: 'assistant 说的话', b: '好' }, KEQING), null)
})

test('⑥ 空值 / 缺字段 / 完全没给 ⇒ null（不炸）', () => {
  assert.equal(sanitizeReplyGuesses(null, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '', b: '' }, KEQING), null)
  assert.equal(sanitizeReplyGuesses({ a: '好' }, KEQING), null)          // 缺 b ⇒ 不放行（否则会返回字符串 "undefined"）
  assert.equal(sanitizeReplyGuesses({ a: '好', b: null }, KEQING), null)
  // ⚠️ 对象比较必须用 deepEqual —— 我第一版写成 assert.equal，两个不同的对象永远不相等，
  //    结果是"代码没错、测试红了"，还差点带着红测试打包（教训记在这）。
  assert.deepEqual(sanitizeReplyGuesses({ a: '好', b: '嗯' }, null), { a: '好', b: '嗯' })  // 没有角色名时不做名字检查
})

test('⑦ 面板契约：两条都通过才返回，返回的就是 {a,b} 两个字符串', () => {
  const ok = sanitizeReplyGuesses({ a: '你吃了吗', b: '我先去忙了' }, KEQING)
  assert.equal(typeof ok.a, 'string')
  assert.equal(typeof ok.b, 'string')
  assert.ok(ok.a.length > 0 && ok.b.length > 0)
})
