/**
 * 小镇清理任务「跑不起来」的回归测试（2026-10-01，用户真机日志）
 *
 * ## 日志原文
 * ```
 * [warn] [town] action purge failed: near ",": syntax error
 * ```
 * 整条清理路径**从未成功过**（每次启动 90 秒后触发一次，必然失败）。
 *
 * ## 根因（在副本库上实测复现）
 * `town_domain_events` 的主键是 **`seq INTEGER PRIMARY KEY`**。SQLite 里这是 rowid 的别名，
 * 于是 `SELECT rowid FROM town_domain_events` 返回的字段名会被别名成 **`seq`**：
 * ```
 * rows = [{ seq: 1, event_id: 'item:…' }, …]      // 注意：没有 rowid 字段
 * rows.map(r => r.rowid)  → [undefined, undefined, …]
 * join(',')               → ",,,,,,,,,,,,"
 * 拼出的 SQL              → WHERE rowid IN (,,,,,,,,,)   ⇒ near ",": syntax error
 * ```
 * （同文件 `purgeEcosystemHistory` 里的写法是对的：`SELECT rowid AS rid` + 读 `r.rid`。）
 *
 * ## 本文件钉住什么
 * 1. **行为**：造一批"旧 epoch 的事件 + 它的投递记录"，调 `purgeTownActionHistory()`，
 *    旧事件与旧投递要被真的删掉、当前 epoch 的要留着。（修之前这一步直接抛语法错误。）
 * 2. **口径**：`SELECT rowid` 必须显式起别名，且代码里不许再读 `.rowid`——
 *    否则换个主键名（比如哪天把 `seq` 改名）就会再次静默拼出 `IN (,,,)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-townpurge-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { purgeTownActionHistory } = await import('../src/services/town/townService.js')

test('rowid 被主键别名遮蔽 —— 这就是当初拼出 IN (,,,,) 的原因（钉住机制，不钉住表名）', () => {
  const db = getDb()
  db.exec('CREATE TABLE IF NOT EXISTS _rowid_demo (seq INTEGER PRIMARY KEY, label TEXT NOT NULL)')
  db.prepare('INSERT INTO _rowid_demo (label) VALUES (?)').run('a')
  db.prepare('INSERT INTO _rowid_demo (label) VALUES (?)').run('b')

  // 未起别名：字段名跟着主键走 ⇒ 读 r.rowid 会拿到 undefined
  const bad = db.prepare('SELECT rowid, label FROM _rowid_demo').all()
  assert.equal(bad[0].rowid, undefined, 'INTEGER PRIMARY KEY 叫 seq 时，SELECT rowid 的字段名就是 seq')

  // 起别名：字段名由我们说了算
  const good = db.prepare('SELECT rowid AS rid, label FROM _rowid_demo').all()
  assert.ok(good.every(r => Number.isInteger(r.rid)), '起了别名才能稳定拿到 rowid 值')
  db.exec('DROP TABLE _rowid_demo')
})

test('行为：清理要真的能删掉旧 epoch 的事件与投递（修之前这里抛 near "," 语法错误）', async () => {
  const db = getDb()
  // 世界状态：当前 epoch = 2
  db.prepare(`INSERT OR REPLACE INTO town_world_state (singleton, world_id, epoch, seed, schema_version)
    VALUES (1, 'w-test', 2, 'seed', 0)`).run()

  const insEvent = db.prepare(`INSERT INTO town_domain_events
    (event_id, world_id, world_epoch, type, root_event_id, depth, envelope)
    VALUES (?, 'w-test', ?, 'item.changed', ?, 0, '{}')`)
  insEvent.run('old-1', 1, 'old-1')
  insEvent.run('old-2', 1, 'old-2')
  insEvent.run('new-1', 2, 'new-1')      // 当前 epoch，必须留着

  const insDelivery = db.prepare(`INSERT INTO town_event_deliveries
    (event_id, consumer_key, status, attempts, next_attempt_at) VALUES (?, 'consumer', ?, 0, 0)`)
  insDelivery.run('old-1', 'done')
  insDelivery.run('old-2', 'done')
  // ⚠️ 当前 epoch 那条要用 **pending**：`purgeEcosystemHistory` 里有一条 sweep 是
  // 「不看 epoch，把 status IN ('done','dead') 的投递全部清掉」（那是刻意的：投递是过程数据）。
  // 第一版我把它也写成 done，于是被那条 sweep 正常清掉，断言误报成 bug。
  insDelivery.run('new-1', 'pending')

  const before = {
    oldEvents: db.prepare("SELECT COUNT(*) n FROM town_domain_events WHERE world_epoch = 1").get().n,
    oldDeliveries: db.prepare("SELECT COUNT(*) n FROM town_event_deliveries WHERE event_id LIKE 'old-%'").get().n,
  }
  assert.equal(before.oldEvents, 2, '夹具：2 条旧事件')
  assert.equal(before.oldDeliveries, 2, '夹具：2 条旧投递')

  // 修之前这一行会抛 `SqliteError: near ",": syntax error`
  const result = await purgeTownActionHistory()
  assert.ok(result && typeof result.deleted === 'number', '清理要正常返回结果，而不是抛异常')

  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM town_domain_events WHERE world_epoch = 1").get().n, 0,
    '旧 epoch 的事件要被清掉'
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM town_event_deliveries WHERE event_id LIKE 'old-%'").get().n, 0,
    '旧事件的投递记录也要一起清掉（否则 FK 残留）'
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM town_domain_events WHERE event_id = 'new-1'").get().n, 1,
    '当前 epoch 的事件绝不能被动'
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM town_event_deliveries WHERE event_id = 'new-1'").get().n, 1,
    '当前 epoch 的投递也要留着'
  )
})

test('源码级：不许再有未起别名的 SELECT rowid / 读 .rowid', () => {
  const src = fs.readFileSync(new URL('../src/services/town/townService.js', import.meta.url), 'utf8')
  const badSelects = src.match(/SELECT\s+rowid\s*(?:,|\s+FROM)/gi) || []
  assert.equal(badSelects.length, 0, `SELECT rowid 必须写成 rowid AS rid，实际还有 ${badSelects.length} 处：${badSelects.join(' / ')}`)
  assert.equal(/\.map\(\s*\w+\s*=>\s*\w+\.rowid\s*\)/.test(src), false, '不许再读 .rowid（字段名会被主键别名改掉）')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
