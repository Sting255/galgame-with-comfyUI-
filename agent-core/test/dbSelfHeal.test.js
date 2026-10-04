/**
 * 库句柄被关掉 ⇒ `getDb()` 自愈（2026-10-02，真机日志）
 *
 * 日志现场（用户真机）：
 *   10:07:24 [error] [replyQueue] Schedule refresh failed for 德丽莎·阿波卡利斯: 404 404 page not found
 *   10:07:24 [error] [replyQueue] tick error: The database connection is not open
 *
 * 第二条是**次生噪音**：进程里有人直接 `db.close()`（`closeDb()` 会把 db 置空从而正常重开，
 * 但直接 `db.close()` 只关句柄、`db` 仍非空）⇒ 之后每个调度器、每条请求都撞
 * `The database connection is not open`，每分钟刷一条，把真正的根因（第一条 404）埋掉。
 *
 * 修法：`getDb()` 是**唯一入口** ⇒ 在那里就地重开（并只提醒一次），而不是让几十个调用方各自判断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const dbMod = await import('../src/db/index.js')

test('① isDbOpen：开着 true，关掉 false（不抛）', () => {
  const db = dbMod.getDb()
  assert.equal(dbMod.isDbOpen(), true)
  assert.equal(typeof db.prepare, 'function')
})

test('② 直接 db.close() 之后，getDb() 自动重开（而不是让调用方撞 "connection is not open"）', () => {
  const first = dbMod.getDb()
  first.close() // ← 模拟"某个路径直接关了句柄"（closeDb() 会置空，这条路不会）
  assert.equal(dbMod.isDbOpen(), false, '关掉之后应当被识别出来')

  const second = dbMod.getDb() // 不许抛
  assert.equal(dbMod.isDbOpen(), true, 'getDb 应当把它重开')
  assert.notEqual(second, first, '重开的应当是**新句柄**（旧的形成不了语句）')
  // 真的能用（不是只换了个对象）
  assert.equal(second.prepare('SELECT 1 AS n').get().n, 1)
})

test('③ 提醒只发一次（否则日志还是会被刷屏）', () => {
  dbMod.resetDbReopenWarning()
  const warns = []
  const real = console.warn
  console.warn = (...args) => { warns.push(args.join(' ')) }
  try {
    for (let i = 0; i < 3; i++) {
      dbMod.getDb().close()
      dbMod.getDb()
    }
  } finally {
    console.warn = real
  }
  const mine = warns.filter(w => w.includes('已自动重开'))
  assert.equal(mine.length, 1, `自愈提醒只该出现一次，实际 ${mine.length} 次：${JSON.stringify(warns)}`)
})
