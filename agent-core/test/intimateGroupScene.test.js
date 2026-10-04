/**
 * 亲密动作的「群聊维度」守卫（2026-10-02 用户反馈）
 *
 * 用户原话：「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的
 *            在哪里聊天就在哪里继续进行」
 *
 * 根因：`routes/intimateActions.js` 把会话**写死**成 `char_<id>`（旧注释还写着「本玩法只在私聊里
 * 发生，不进群聊」），而群聊页只认统一流 `group_message`（`routes/groups.js` emit →
 * `stores/groups.js` 的 `_enqueue`）⇒ 群里点的动作、她的反应、配图全落到私聊。
 *
 * 这条测试钉三层：
 *   ① 场景解析：不传 = 私聊（**老行为逐字不变**）；群聊必须群存在 + 她是成员；
 *   ② 写入形状：`group_<gid>` 会话 + `[名字]: ` 前缀 + seq 递增 + payload 键齐全（群聊页认这些）；
 *   ③ 接线：路由真的把 scene 传下去了（不是只写了个没人用的函数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROUTE = path.join(here, '..', 'src', 'routes', 'intimateActions.js')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { resolveSceneTarget, writeGroupInsertMessage, isGroupMember, groupExists } =
  await import('../src/services/groupInsertMessage.js')

const db = getDb()
const routeSrc = fs.readFileSync(ROUTE, 'utf8')

// 测试环境的内存库不建群表（那是运行期迁移建的），这里补最小 DDL ——
// 本测试验的是"写入器/场景解析的契约"，不是应用的 schema 演进。
// 同时关掉外键：messages.speaker_character_id 指向 characters，而本测试刻意不造角色行
// （写入器只用对象上的 id / display_name，不读角色表）⇒ 验形状就够了，不需要满足完整性约束。
db.pragma('foreign_keys = OFF')
db.exec(`
  -- ⚠️ 必须用**真实表名 group_chats**（不是 groups）：2026-10-02 真机报「这个群不存在（可能已经被删了）」，
  -- 根因就是服务里查了不存在的 groups 表，而这条测试当时自己造了个假 groups 表 ⇒ **假绿**。
  -- 用真表名之后，服务端再写错表名，这条测试会跟着红。
  -- （注意：这段是模板字符串，注释里**不能出现反引号** —— 那会把模板提前闭合、整个文件加载失败。）
  CREATE TABLE IF NOT EXISTS group_chats (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, character_id INTEGER, PRIMARY KEY (group_id, character_id));
`)

// 造最小场景（不依赖 characters 行：写入器只用对象上的 id / display_name）
db.prepare('INSERT OR REPLACE INTO group_chats (id, name) VALUES (3, ?)').run('测试群')
db.prepare('INSERT OR REPLACE INTO group_members (group_id, character_id) VALUES (3, 9)').run()

const req = (body = {}, query = {}) => ({ body, query })

test('① 不传 scene ⇒ 私聊（老行为逐字不变，老前端不受影响）', () => {
  const r = resolveSceneTarget(req(), 9)
  assert.equal(r.ok, true)
  assert.equal(r.scene, 'chat')
  assert.equal(r.groupId, null)
  assert.equal(r.conversationId, 'char_9')
})

test('① 群聊校验：缺 groupId / 群不存在 / 她不在群里 ⇒ 400 + 人话', () => {
  const noGid = resolveSceneTarget(req({ scene: 'group' }), 9)
  assert.equal(noGid.ok, false)
  assert.equal(noGid.code, 'invalid_group')
  assert.match(noGid.message, /groupId/)

  const noGroup = resolveSceneTarget(req({ scene: 'group', groupId: 999 }), 9)
  assert.equal(noGroup.ok, false)
  assert.equal(noGroup.code, 'group_not_found')

  const notMember = resolveSceneTarget(req({ scene: 'group', groupId: 3 }), 12345)
  assert.equal(notMember.ok, false)
  assert.equal(notMember.code, 'not_group_member')

  assert.equal(groupExists(3), true)
  assert.equal(isGroupMember(3, 9), true)

  const ok = resolveSceneTarget(req({ scene: 'group', groupId: 3 }), 9)
  assert.equal(ok.ok, true)
  assert.equal(ok.groupId, 3)
  assert.equal(ok.conversationId, 'group_3')
})

test('② 写入形状：落 group_<gid> 会话 + [名字] 前缀 + seq 递增 + payload 键齐全', () => {
  const before = db.prepare("SELECT COUNT(*) c FROM raw_messages WHERE conversation_id LIKE 'char_%'").get().c
  const ins = writeGroupInsertMessage(3, { id: 9, display_name: '德丽莎' }, '唔……你轻一点。', {
    source: 'intimate_action',
    extra: { intimate_action: { action: 'thrust' } },
  })
  assert.ok(ins, '写入应成功')
  assert.equal(ins.conversationId, 'group_3')

  const raw = db.prepare('SELECT conversation_id, content FROM raw_messages WHERE id = ?').get(ins.rawId)
  assert.equal(raw.conversation_id, 'group_3', 'raw 必须落在群会话里')
  assert.equal(raw.content, '[德丽莎]: 唔……你轻一点。', 'raw 正文要自带「[名字]: 」前缀（群聊引擎同口径）')

  const msg = db.prepare('SELECT conversation_id, seq, speaker_character_id, role FROM messages WHERE id = ?').get(ins.msgId)
  assert.equal(msg.conversation_id, 'group_3')
  assert.equal(msg.role, 'assistant')
  assert.equal(Number(msg.speaker_character_id), 9, 'speaker_character_id 必须是被操作的那个角色')
  assert.ok(Number.isFinite(Number(msg.seq)), 'seq 必须是数字')

  // 群聊页认的键（与 groupChatEngine.serializeMsg 对齐）
  for (const key of ['id', 'group_id', 'role', 'content', 'seq', 'speaker_character_id', 'speaker_name', 'created_at']) {
    assert.ok(key in ins.payload, `payload 缺少群聊页需要的键：${key}`)
  }
  assert.equal(ins.payload.group_id, 3)
  assert.equal(ins.payload.source, 'intimate_action')

  // 第二条要接在第一条后面（seq 递增），不能每次从 0 开始
  const ins2 = writeGroupInsertMessage(3, { id: 9, display_name: '德丽莎' }, '再来一次。')
  assert.equal(Number(ins2.seq), Number(msg.seq) + 1, 'seq 必须递增（否则群聊页排序会乱）')

  // **最关键**：私聊会话一点没被污染
  const after = db.prepare("SELECT COUNT(*) c FROM raw_messages WHERE conversation_id LIKE 'char_%'").get().c
  assert.equal(after, before, '群聊场景下绝不允许往 char_<id> 写任何东西')
})

test('③ 接线：路由按场景取会话 + 群聊走统一流广播（不是只写了个没人用的函数）', () => {
  assert.match(routeSrc, /const scene = resolveSceneTarget\(req, id\)/, '两个入口都要解析场景')
  // 消息与上下文按场景分叉……
  assert.match(routeSrc, /readRecentLines\(scene\.conversationId, \{[\s\S]{0,80}?group: scene\.scene === 'group'/, '上下文要按场景读且标 group')
  assert.match(routeSrc, /writeGroupInsertMessage\(scene\.groupId, character, parsed\.reactionText/, '群聊反应要走共享群写入器')
  assert.match(routeSrc, /broadcast\('group_message', written\.payload\)/, '群聊反应要广播 group_message（群聊页只认这条）')
  // 群聊分支不能再落到私聊广播上
  assert.match(routeSrc, /if \(written && scene\.scene !== 'group'\) \{\s*broadcastProactiveMessage\(/, '群聊时不许再发 proactive_message')
  // ……但**心情**必须留在她自己的会话里（函数内部就是 char_<characterId>，不随场景分叉；
  // 既有守卫 `saveEmotionSnapshot 不许写 group_ 会话` 也钉着这条 —— 别为了"按场景分叉"把它一起改了）。
  assert.match(routeSrc, /function applySceneEmotion\([\s\S]{0,700}?const conversationId = `char_\$\{characterId\}`/,
    '心情要写 char_<characterId>（不随场景分叉）')
})
