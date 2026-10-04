/**
 * 迁移守卫：敏感度四列必须能补进**已存在的老库**（2026-10-02，第五十一轮）
 *
 * ## 这个文件是为一次真实事故写的
 * 敏感度系统第一版把"补列"的迁移**嵌进了** `if (!cols.find(c => c.name === 'next_schedule_refresh_at'))` 里。
 * 而 `characters` 的建表语句里**已经有** `next_schedule_refresh_at` ⇒ 这个判断在**任何**正常的库上都是假，
 * 整段迁移永远不执行。后果：四列不存在 → `getSensitivity` 的 try/catch 把它兜成「0 / 冷淡」、
 * `addSensitivity` 兜成 null ⇒ 所有单测与前端守卫**全绿**，只有真机上的 `POST /api/characters/:id/heat`
 * 直接 500。抓到它的是浏览器 E2E（H1 证据行里的 `500 POST /api/characters/6/heat`）——
 * 单测永远造不出"老库"这个前提，所以这里**显式造一个**。
 *
 * ## 为什么直接调 `migrateScheduleSchema`
 * 走完整 `getDb()` 会顺带建表/写默认角色，把"老库"这个前提冲掉（我第一版就撞在
 * `table characters has no column named emotion_baseline` 上）。迁移函数是纯的"看表补列"，直接喂一个老表最准确。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { migrateScheduleSchema } = await import('../src/db/index.js')

const SENSITIVITY_COLS = ['sensitivity', 'sensitivity_updated_at', 'heat_mode', 'heat_until']

/** 造一个"老库"：`characters` 已经有 next_schedule_refresh_at，但没有敏感度四列 */
function legacyDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      display_name TEXT,
      next_schedule_refresh_at DATETIME
    );
  `)
  const cols = () => db.prepare(`PRAGMA table_info(characters)`).all().map(c => c.name)
  assert.ok(cols().includes('next_schedule_refresh_at'), '前提：老库里已经有 next_schedule_refresh_at')
  for (const col of SENSITIVITY_COLS) assert.ok(!cols().includes(col), `前提：老库里没有 ${col}`)
  return db
}

test('① 老库跑迁移：敏感度四列全部补齐（缺一列，整条数值链会静默按 0 处理）', () => {
  const db = legacyDb()
  migrateScheduleSchema(db)
  const cols = db.prepare(`PRAGMA table_info(characters)`).all().map(c => c.name)
  for (const col of SENSITIVITY_COLS) {
    assert.ok(cols.includes(col),
      `characters.${col} 必须补上 —— 没有它 getSensitivity 会静默返回 0/冷淡、POST /heat 直接 500`)
  }
  db.close()
})

test('② 迁移幂等：再跑一次不报错、列还在、已有数值不被清', () => {
  const db = legacyDb()
  migrateScheduleSchema(db)
  db.prepare(`INSERT INTO characters (name, display_name) VALUES ('a', 'a')`).run()
  db.prepare('UPDATE characters SET sensitivity = 42 WHERE id = 1').run()
  migrateScheduleSchema(db)   // 再跑一次（模拟第二次启动）
  const cols = db.prepare(`PRAGMA table_info(characters)`).all().map(c => c.name)
  for (const col of SENSITIVITY_COLS) assert.ok(cols.includes(col))
  assert.equal(db.prepare('SELECT sensitivity FROM characters WHERE id = 1').get().sensitivity, 42, '重复迁移不许改值')
  db.close()
})

test('③ 真的能用：补完列之后 UPDATE / SELECT 那套语句跑得通（真机 500 的直接原因）', () => {
  const db = legacyDb()
  migrateScheduleSchema(db)
  db.prepare(`INSERT INTO characters (name, display_name) VALUES ('她', '她')`).run()
  // 与 sensitivityService.setHeatMode 同形的两条语句
  db.prepare('UPDATE characters SET heat_mode = 1, heat_until = ?, sensitivity = ?, sensitivity_updated_at = ? WHERE id = ?')
    .run('2026-10-02T14:00:00.000Z', 100, '2026-10-02T12:00:00.000Z', 1)
  const row = db.prepare('SELECT sensitivity, heat_mode, heat_until FROM characters WHERE id = ?').get(1)
  assert.equal(row.sensitivity, 100)
  assert.equal(row.heat_mode, 1)
  assert.equal(row.heat_until, '2026-10-02T14:00:00.000Z')
  db.close()
})

test('④ 反向确认：空表（列都齐）跑迁移也不动它 —— 迁移只补缺的', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, display_name TEXT,
    next_schedule_refresh_at DATETIME, sensitivity REAL DEFAULT 7, sensitivity_updated_at DATETIME,
    heat_mode INTEGER DEFAULT 0, heat_until DATETIME
  );`)
  migrateScheduleSchema(db)
  db.prepare(`INSERT INTO characters (name, display_name) VALUES ('x','x')`).run()
  assert.equal(db.prepare('SELECT sensitivity FROM characters WHERE id = 1').get().sensitivity, 7, '已有的列/默认值不许被重建')
  db.close()
})
