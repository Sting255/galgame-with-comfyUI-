/**
 * SQL 语句缓存（2026-10-01 · 代码优化规划 §一-1「prepare 风暴」）
 *
 * ## 问题
 * `chat.js` 单文件 93 处 `db.prepare(...)`，其中大量是**同一段 SQL 在多处重复编译**：
 * 实测形状分布里 `INSERT INTO raw_messages (...)` 5 处、`INSERT INTO messages (...)` 5+2 处、
 * `SELECT * FROM characters WHERE id = ?` 4 处、`SELECT id FROM raw_messages WHERE client_msg_id = ?` 3 处……
 * better-sqlite3 每次 `prepare()` 都要解析 SQL → 编译字节码 → 建 statement（20~80µs），
 * 而这批编译**全在同步阻塞链路上、赶在 LLM 流式开始之前**，每轮聊天都付一遍。
 *
 * ## 修法
 * `db/index.js` 导出 `stmt(sql)`：懒编译 + **按库实例缓存**（WeakMap 键＝db 实例），
 * 热路径上的重复语句改用 `stmt(...)`，其余 `.get/.all/.run` 写法不变。
 *
 * ## 本文件钉住什么
 * 1. **同一 SQL 只编译一次**（计数器可证），跨调用/跨"轮"都复用。
 * 2. **换库必须重新编译** —— 这条是关键安全属性：测试用内存库、`closeDb()` 后重开，
 *    都不能复用"另一个库（或已关闭的库）"编译出来的 statement。WeakMap 让缓存天然跟着实例走。
 * 3. **chat.js 的热点重复语句确实换到了 `stmt(`**，且没有留下"同一段 SQL 又用 db.prepare"的残留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-stmt-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb, stmt, stmtCacheStats, resetStmtCacheStats } = await import('../src/db/index.js')

test('① 同一 SQL 只编译一次，之后全是命中', () => {
  resetStmtCacheStats()
  const db = getDb()
  const sql = 'SELECT COUNT(*) AS n FROM characters'
  const before = stmtCacheStats()
  for (let i = 0; i < 50; i++) stmt(sql)
  const after = stmtCacheStats()
  assert.equal(after.compiles - before.compiles, 1, '50 次调用只应编译 1 次')
  assert.ok(after.hits - before.hits >= 49, '其余应全部命中缓存')
  // 复用同一对象（不是每次新建 statement）
  assert.equal(stmt(sql), stmt(sql), '拿到的必须是同一个 statement 实例')
})

test('② 换库必须重新编译（绝不复用别的库/已关闭库的 statement）', () => {
  const a = new Database(':memory:')
  const b = new Database(':memory:')
  a.exec('CREATE TABLE t (x INTEGER)')
  b.exec('CREATE TABLE t (x INTEGER)')
  const sa = stmt('SELECT COUNT(*) AS n FROM t', a)
  const sb = stmt('SELECT COUNT(*) AS n FROM t', b)
  assert.notEqual(sa, sb, '不同库实例不能共用同一条 statement')
  a.prepare('INSERT INTO t (x) VALUES (1)').run()
  assert.equal(sa.get().n, 1, 'a 库的语句只应看到 a 的数据')
  assert.equal(sb.get().n, 0, 'b 库的语句只应看到 b 的数据')
  a.close()
  b.close()
})

test('③ 语句缓存条目数有上限语义：键就是 SQL 全文（同文只一份）', () => {
  const sql = 'SELECT 1 AS one'
  const first = stmtCacheStats().size
  stmt(sql)
  stmt(sql)
  assert.equal(stmtCacheStats().size, first + 1, '同一段 SQL 只占一个缓存条目')
})

test('④ chat.js 的热点重复语句已换到 stmt(，且没有残留同文 db.prepare', () => {
  const src = fs.readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*\bstmt\b[^}]*\} from '\.\.\/db\/index\.js'/, '要导入 stmt')
  const hot = [
    'SELECT id FROM raw_messages WHERE client_msg_id = ?',
    'SELECT * FROM characters WHERE id = ?',
    'INSERT INTO raw_messages (conversation_id, role, content, client_msg_id) VALUES (?, \'user\', ?, ?)',
    'INSERT INTO messages (conversation_id, raw_id, role, content, images, seq) VALUES (?, ?, \'user\', ?, ?, 0)',
    'INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, \'assistant\', ?, ?)',
  ]
  for (const sql of hot) {
    const escaped = sql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(src, new RegExp(`stmt\\([\`']${escaped}`), `热点语句应走 stmt(：${sql.slice(0, 40)}…`)
    assert.equal(
      new RegExp(`db\\.prepare\\([\`']${escaped}`).test(src), false,
      `不许残留同一段 SQL 的 db.prepare：${sql.slice(0, 40)}…`
    )
  }
  // 转换后 chat.js 里 stmt( 的处数要够（不是只改了一两处做样子）
  const stmtCount = (src.match(/\bstmt\(/g) || []).length
  assert.ok(stmtCount >= 12, `chat.js 里 stmt( 至少 12 处，实际 ${stmtCount}`)
})

test('⑤ 行为等价：缓存的语句照样能 get/all/run（含参数绑定与 lastInsertRowid）', () => {
  const db = getDb()
  db.exec('CREATE TABLE IF NOT EXISTS _stmt_demo (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)')
  const ins = stmt('INSERT INTO _stmt_demo (label) VALUES (?)')
  const info = ins.run('a')
  assert.ok(Number(info.lastInsertRowid) > 0, 'run 要返回 lastInsertRowid')
  ins.run('b')
  assert.equal(stmt('SELECT COUNT(*) AS n FROM _stmt_demo').get().n, 2)
  assert.equal(stmt('SELECT label FROM _stmt_demo ORDER BY id').all().length, 2)
  db.exec('DROP TABLE _stmt_demo')
})

test('⑥ ★ 作用域守卫：db 是函数参数的地方必须 `stmt(sql, db)`（这里是真踩过坑的地方）', () => {
  // 事实：`groupChatEngine.js` 里有一批把 db 当参数的函数
  // （`buildRecentGroupLogBlock(db, …)` / `buildTranscript(db, …)` / `countCompletedGroupRoundsAfter(db, …)`…）。
  // 把它们的 `db.prepare(sql)` 直接换成 `stmt(sql)` ⇒ stmt 会默认用 `getDb()`，
  // 单测传入的测试库被无视、真机也可能查错库。第一版就是这样，**17 条群聊测试红**。
  // 更阴的是：插入 `, db` 时如果差一位（写进字符串里），`node --check` 仍然通过、SQL 内容却被破坏。
  // 所以这里用**结构扫描**钉住："函数形参里有 db ⇒ 该作用域内的 stmt( 必须显式透传 db"。
  const src = fs.readFileSync(new URL('../src/services/groupChatEngine.js', import.meta.url), 'utf8')

  const scopes = []
  const re = /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+[\w$]+[ \t]*\(([^)]*)\)/gm
  let m
  while ((m = re.exec(src)) !== null) {
    scopes.push({ at: m.index, name: m[0].match(/function[ \t]+([\w$]+)/)[1], hasDb: /\bdb\b/.test(m[1]) })
  }
  const scopeAt = (offset) => { let last = null; for (const s of scopes) { if (s.at < offset) last = s; else break } return last }

  let checked = 0
  let missing = 0
  for (const call of src.matchAll(/\bstmt\(/g)) {
    // 排除 import 行里的 stmt
    if (/^\s*import\b/m.test(src.slice(src.lastIndexOf('\n', call.index) + 1, call.index + 5))) continue
    const scope = scopeAt(call.index)
    if (!scope?.hasDb) continue
    let depth = 0
    let end = -1
    for (let j = call.index + 4; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') { depth--; if (depth === 0) { end = j; break } }
    }
    const fragment = src.slice(call.index, end + 1)
    checked++
    if (!/,\s*db\s*\)$/.test(fragment)) {
      missing++
      console.log(`  ❌ ${scope.name}() 里的 stmt( 没透传 db：${fragment.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  assert.ok(checked >= 8, `应至少检查到 8 处 db 作用域内的 stmt(，实际 ${checked}`)
  assert.equal(missing, 0, `有 ${missing} 处 db 作用域内的 stmt( 没透传 db（会查错库）`)
  // 拼接 SQL 的站点必须仍是 db.prepare（缓存键＝SQL 全文，拼接会让缓存无限增长）
  const interp = (src.match(/db\.prepare\(/g) || []).length
  assert.ok(interp >= 4, `拼接 SQL 的 ${interp} 处应保留为 db.prepare，不要被批量替换`)
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
