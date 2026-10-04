/**
 * 两条只在**真实日志**里才看得见的玩具 bug（2026-10-01，用户玩了一整轮的 9MB 日志）
 *
 * ## bug 1：`saveEmotionSnapshot(conversationId, 0, …)` —— 玩具的情绪影响全部被外键挡回
 * 日志原文（出现 **31 次**）：
 * ```
 * [warn] [toys] emotion write failed: FOREIGN KEY constraint failed
 * ```
 * `emotion_snapshots.after_msg_id` 外键指向 `raw_messages(id)`，而 `0` 这个 id 不存在
 * ⇒ 每次玩具的情绪变化都写不进去 ⇒ 玩具对心情、对后续对话**毫无影响**。
 * 正确写法对照：`touch.js` 传真实 anchor 消息 id；`itemService.js` 传 `null`。
 *
 * ## bug 2：`toyService.js` 用 `config` 却没 import
 * 日志原文（同样 **31 次**）：
 * ```
 * [warn] [toys] 出图异常（不影响穿戴）: config is not defined
 * ```
 * `generateToyImageForReaction` 里读 `config.features.toyImageMode`，模块顶部没有 import config
 * ⇒ 每次都 ReferenceError，被"不影响穿戴"的 catch 吞掉 ⇒ **玩具永远配不出图**、界面也没有任何提示。
 *
 * 这两条都是「增强项，失败只 warn」的写法把它们藏起来的，所以断言必须打到**真实行为**上，
 * 而不是"源码里有没有那句话"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-toyfix-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { loadEmotionState, evolveEmotion, saveEmotionSnapshot } = await import('../src/services/emotionEngine.js')
const { generateToyImageForReaction } = await import('../src/services/toyService.js')

/** 建一个能用的角色（characters 有几列是 NOT NULL，照其它测试的写法） */
let seq = 0
function seedCharacter(label) {
  return Number(getDb().prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`toyfix_${++seq}`, label, '你是她。').lastInsertRowid)
}

test('bug1 复现：after_msg_id=0 会被外键挡回（这就是日志里那 31 次的真因）', () => {
  const id = seedCharacter('玩具测试甲')
  const conv = 'char_' + id
  const state = loadEmotionState(conv)
  const next = evolveEmotion(state, { valence: 0.1, arousal: 0.2, dominance: -0.1 })

  // 旧写法：字面量 0 —— 必须抛外键错误（钉住"修的是什么"，而不是笼统断言"不报错"）
  assert.throws(
    () => saveEmotionSnapshot(conv, 0, next, null),
    /FOREIGN KEY|constraint/i,
    'after_msg_id=0 会撞外键，这正是不该再传 0 的原因'
  )
})

test('bug1 修法：after_msg_id=null 时情绪快照能正常落库，且数值真的变了', () => {
  const id = seedCharacter('玩具测试乙')
  const conv = 'char_' + id
  const before = loadEmotionState(conv)
  const next = evolveEmotion(before, { valence: 0.1, arousal: 0.25, dominance: -0.1 })
  saveEmotionSnapshot(conv, null, next, 'joy', 60, null, '玩具穿戴')

  const row = getDb().prepare('SELECT * FROM emotion_snapshots WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conv)
  assert.ok(row, '情绪快照要写进去')
  assert.equal(row.after_msg_id, null, '没有对应消息就该是 null')
  assert.ok(Number(row.arousal) > Number(before.instant.arousal), 'arousal 应该真的涨了（玩具效果落到心情上）')
  assert.equal(row.reason, '玩具穿戴')
})

test('bug2 修法：generateToyImageForReaction 不再因 config 未定义而失败', async () => {
  const id = seedCharacter('玩具测试丙')
  const char = { id, display_name: '玩具测试丙', base_prompt: 'p', short_prompt: 's', loras: '[]' }
  const calls = []
  const result = await generateToyImageForReaction({
    character: char,
    imagePrompt: 'a girl in a dim room, trembling slightly',
    options: {
      generateImage: async (prompt, opts) => {
        calls.push({ prompt, opts })
        return { success: true, images: [{ base64: 'data:image/png;base64,' + Buffer.from('x').toString('base64'), filename: 't.png' }], wfMode: 'turbo' }
      },
    },
  })
  assert.equal(calls.length, 1, '生图函数要被真的调用一次（旧代码会先抛 config is not defined）')
  assert.ok(result && result.urls && result.urls.length === 1, '要回可用的图片 URL')
  assert.match(calls[0].prompt, /trembling slightly/, 'LLM 现写的 image_prompt 要进 prompt（图文同源口径）')
})

test('bug2 源码级：toyService 必须 import config，且不许再出现 after_msg_id=0 的写法', () => {
  const svc = fs.readFileSync(new URL('../src/services/toyService.js', import.meta.url), 'utf8')
  assert.match(svc, /import \{ config \} from '\.\.\/config\.js'/, 'toyService 要用 config 就必须先 import')
  const routes = fs.readFileSync(new URL('../src/routes/toys.js', import.meta.url), 'utf8')
  assert.equal(
    /saveEmotionSnapshot\(\s*conversationId\s*,\s*0\s*,/.test(routes), false,
    '不许再把 0 当 after_msg_id 传给 saveEmotionSnapshot（会撞外键，静默丢掉玩具的情绪影响）'
  )
  assert.match(routes, /saveEmotionSnapshot\(\s*conversationId,\s*null,/, '没有对应消息时要用 null')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
