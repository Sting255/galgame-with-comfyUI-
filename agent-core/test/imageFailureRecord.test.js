/**
 * 生图失败必须**落库**（2026-10-01 补）
 *
 * ## 为什么
 * 奇遇 / 朋友圈 / 镇民奇遇的出图失败原来只打一行 console：真机实测 `image_tasks` 里
 * events 相关 **120 条全部 done、0 条 failed**，而同一时段的日志里明明有两次
 * `All ComfyUI submit attempts exhausted`。于是「没触发配图 / 生成失败 / 图片文件丢了」
 * 这三种原因事后完全分不开 —— 用户一律报成「有时候生不出来」，而三者修法完全不同。
 *
 * 同时覆盖导入后的「图片引用自检」：那 578 条死链当时没有任何地方会提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-imgfail-'))
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
process.env.LINSHE_DATA_DIR = tmpRoot

const { getDb } = await import('../src/db/index.js')
const { recordCompletedImageTask, recordFailedImageTask } = await import('../src/services/imageTaskRecorder.js')
const { countMissingImageRefs } = await import('../src/services/dataBackup.js')

const src = (rel) => readFileSync(new URL('../src/' + rel, import.meta.url), 'utf8')

test('recordFailedImageTask：写 status=failed + error_message + 空 output_paths', () => {
  const db = getDb()
  const id = recordFailedImageTask({
    conversationId: 'char_1_events',
    promptOriginal: 'a dim dorm room, 1girl',
    promptRefined: 'a dim dorm room, 1girl, night',
    errorMessage: 'ComfyUI 连不上（没启动或还在加载），最后一次错误：fetch failed',
    style: 'anima',
    resolution: '768x512',
    workflowTemplate: 'turbo',
    db,
  })
  assert.ok(Number.isInteger(id) && id > 0, '应返回新行 id')
  const row = db.prepare('SELECT * FROM image_tasks WHERE id = ?').get(id)
  assert.equal(row.status, 'failed')
  assert.equal(row.prompt_original, 'a dim dorm room, 1girl')
  assert.equal(row.prompt_refined, 'a dim dorm room, 1girl, night', 'refined 缺失时才回落 original')
  assert.equal(row.output_paths, '[]', '失败任务没有产物路径')
  assert.match(row.error_message, /fetch failed/)
  assert.equal(row.resolution, '768x512', 'resolution 要落在该链路自己的尺寸上')
  assert.ok(row.finished_at, '必须有 finished_at')
})

test('recordFailedImageTask：没有 prompt 就不写（不制造无意义的空行）', () => {
  const db = getDb()
  const before = db.prepare('SELECT count(*) n FROM image_tasks').get().n
  assert.equal(recordFailedImageTask({ promptOriginal: '', db }), null)
  assert.equal(recordFailedImageTask({ db }), null)
  assert.equal(db.prepare('SELECT count(*) n FROM image_tasks').get().n, before, '不该多出行')
})

test('recordFailedImageTask：超长报错截断，且记账失败不带崩业务', () => {
  const db = getDb()
  const id = recordFailedImageTask({ promptOriginal: 'x', errorMessage: 'E'.repeat(5000), db })
  const row = db.prepare('SELECT error_message FROM image_tasks WHERE id = ?').get(id)
  assert.equal(row.error_message.length, 500, '截断到 500 字，别把整段 ComfyUI 报错塞进库')
  // 传一个坏 db：必须吞掉异常并返回 null，而不是把调用方的生图链路带崩
  assert.equal(recordFailedImageTask({ promptOriginal: 'x', db: { prepare() { throw new Error('boom') } } }), null)
})

test('recordCompletedImageTask 的口径没被改坏（done 行仍然是 done）', () => {
  const db = getDb()
  const id = recordCompletedImageTask({
    conversationId: 'char_1_chat',
    promptOriginal: 'p',
    promptRefined: 'p, refined',
    outputPaths: ['/images/chat/a.png'],
    db,
  })
  const row = db.prepare('SELECT status, output_paths FROM image_tasks WHERE id = ?').get(id)
  assert.equal(row.status, 'done')
  assert.deepEqual(JSON.parse(row.output_paths), ['/images/chat/a.png'])
})

test('四类「静默失败」链路都接上了 recordFailedImageTask（源码级防回退）', () => {
  const cases = [
    ['services/eventGenerator.js', /recordFailedImageTask/, 4],   // 初始(else+catch) + 分支(else+catch)
    ['routes/moments.js', /recordFailedImageTask/, 4],            // 角色帖(else+catch) + 镇民帖(else)
    ['services/town/townNpcEventGenerator.js', /recordFailedImageTask/, 2],
    ['services/town/townNpcMomentGenerator.js', /recordFailedImageTask/, 2],
  ]
  for (const [file, re, minCount] of cases) {
    const text = src(file)
    assert.match(text, /import \{[^}]*recordFailedImageTask[^}]*\}/, `${file} 必须 import 它`)
    // ⚠️ 必须带 `g`：不带的话 `String.match` 只返回**第一个**匹配，计数恒为 1
    const uses = (text.match(new RegExp(re.source, 'g')) || []).length
    assert.ok(uses >= minCount + 1, `${file} 里的调用点应 ≥ ${minCount} 处（含 import 行），实际 ${uses}`)
  }
  // eventGenerator 的 import 曾经漏过（加了调用但没加 import ⇒ 运行时 ReferenceError）
  assert.match(src('services/eventGenerator.js'), /import \{ recordCompletedImageTask, recordFailedImageTask \}/)
})

test('countMissingImageRefs：数得准，且只算 /images/ 本地引用', () => {
  const db = getDb()
  // 同一个内存库被上面几条用例共用过，先清干净再断言（否则会把它们写的引用一起数进来）
  db.prepare('DELETE FROM image_tasks').run()
  db.prepare('DELETE FROM moment_posts').run()
  const imgRoot = path.join(tmpRoot, 'images', 'chat')
  fs.mkdirSync(imgRoot, { recursive: true })
  fs.writeFileSync(path.join(imgRoot, 'exists.png'), Buffer.from('x'))
  db.prepare('INSERT INTO image_tasks (prompt_original, output_paths, status) VALUES (?, ?, ?)')
    .run('p', JSON.stringify(['/images/chat/exists.png', '/images/chat/gone.png', 'https://cdn.example.com/a.png']), 'done')

  const r = countMissingImageRefs(db, tmpRoot)
  assert.equal(r.total, 2, 'https 外链不该算进本地引用')
  assert.equal(r.missing, 1)
  assert.deepEqual(r.samples, ['/images/chat/gone.png'])
})

test('countMissingImageRefs：库里没有引用时返回 0/0（不误报）', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-empty-'))
  const db = getDb()
  db.prepare('DELETE FROM image_tasks').run()
  const r = countMissingImageRefs(db, empty)
  assert.equal(r.total, 0)
  assert.equal(r.missing, 0)
})

test('导入结果：restored 形状不变，缺失图片只在 message 里追加一句话', () => {
  const text = src('services/dataBackup.js')
  assert.match(text, /restored: \{\s*files: checked\.files\.size,\s*bytes: checked\.totalBytes,\s*counts,/)
  assert.match(text, /条图片引用找不到文件/, '缺失要写进 message（用户看得到），不能只打日志')
})

process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {} })
