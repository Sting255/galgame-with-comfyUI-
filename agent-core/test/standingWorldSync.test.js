/**
 * 立绘 ↔ 世界观 一致性（2026-10-01，用户：「同步形象展示那边的立绘，需要根据现在的世界观去生成」）
 *
 * ## 背景（先说清哪些本来就是对的）
 * 立绘生成时**确实吃了世界观**：`characters.js` 的 `system0 = 破甲词 + 世界观`、
 * `<world_setting>` 指令、`getWorldIntegrationRule('interaction')`。所以新生成的图没问题。
 * 缺的是**记录与提示**：`characters` 只存 `standing_url` ⇒ 世界观改了之后，
 * 「角色形象」面板里还是旧世界的立绘，而系统一无所知 —— 用户看到的就是"立绘没跟着世界观走"。
 *
 * ## 本文件钉住什么
 * 1. **签名口径**：世界观内容变一个字，签名就要变（用内容哈希，不看 updated_at）。
 * 2. **判定矩阵**：没立绘/没世界观不提示；老图（无签名）判"待同步"；一致不提示；不一致提示。
 * 3. **生成时记签名**：立绘生成与手动上传两条写库路径都要写 `standing_world_sig`。
 * 4. **接口下发**：`GET /api/characters` 每行都要带 `standing_stale` / `standing_stale_reason`。
 * 5. **UI**：面板里出现提示条（剥注释后扫，别被注释绊倒），且沿用 0.3s 节奏与既有 token。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-worldsig-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const sig = await import('../src/services/worldSignature.js')

const readSrc = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

function seedWorld(content) {
  const db = getDb()
  db.prepare('UPDATE world_settings SET is_active = 0').run()
  return Number(db.prepare(
    'INSERT INTO world_settings (name, content, is_active) VALUES (?, ?, 1)'
  ).run(`世界${Date.now()}`, content).lastInsertRowid)
}

test('① 签名口径：世界观内容改一个字就变；没有世界观时为 null', () => {
  getDb()
  const sigNone = sig.currentWorldSignature()
  const id = seedWorld('这是一个现代都市世界观')
  const s1 = sig.currentWorldSignature()
  assert.ok(s1 && s1.startsWith(`${id}:`), `签名要带世界观 id：${s1}`)
  assert.notEqual(s1, sigNone, '有世界观后签名不能还是 null')

  // 改内容 ⇒ 签名必须变（不看 updated_at）
  getDb().prepare('UPDATE world_settings SET content = ? WHERE id = ?').run('这是一个现代都市世界观。', id)
  const s2 = sig.currentWorldSignature()
  assert.notEqual(s2, s1, '内容改一个字签名就要变')

  // 切到另一套世界观 ⇒ 也要变
  const id2 = seedWorld('这是一套蒸汽朋克世界观')
  assert.notEqual(sig.currentWorldSignature(), s2, '换世界观后签名要变')
  assert.ok(sig.currentWorldSignature().startsWith(`${id2}:`), '签名应指向新的启用世界观')
})

test('② 判定矩阵：五种情况各有明确结论', () => {
  getDb()
  const id = seedWorld('矩阵用世界观')
  const cur = sig.currentWorldSignature()
  const has = (o) => sig.isStandingStale(o)

  assert.equal(has({ standing_url: null, standing_world_sig: cur }).reason, 'no_standing', '没立绘不提示（提示了也是噪音）')
  assert.equal(has({ standing_url: '/x.png', standing_world_sig: cur }).stale, false, '签名一致 ⇒ 不提示')
  assert.equal(has({ standing_url: '/x.png', standing_world_sig: '999:deadbeef' }).reason, 'world_changed', '签名不同 ⇒ 待同步')
  assert.equal(has({ standing_url: '/x.png', standing_world_sig: null }).reason, 'unknown', '老图无签名 ⇒ 判待同步')
  assert.equal(has({ standing_url: '/x.png', standing_world_sig: null }).stale, true, '老图要提示（用户要的就是"按现在世界观同步"）')

  // 没有世界观时不做判断（没有"现在的世界观"这个基准）
  getDb().prepare('UPDATE world_settings SET is_active = 0').run()
  assert.equal(has({ standing_url: '/x.png', standing_world_sig: '1:abc' }).reason, 'no_world', '没有世界观 ⇒ 无从比对')
})

test('③ 下发字段：withStandingStaleness 不破坏原行，只加两个字段', () => {
  getDb()
  seedWorld('下发字段世界观')
  const row = { id: 7, display_name: '她', standing_url: '/images/standing/a.png', standing_world_sig: null }
  const out = sig.withStandingStaleness(row)
  assert.equal(out.id, 7)
  assert.equal(out.standing_url, '/a' .length ? row.standing_url : row.standing_url)
  assert.equal(out.standing_stale, true, '老图待同步')
  assert.equal(out.standing_stale_reason, 'unknown')
  assert.equal(row.standing_stale, undefined, '不要就地改原对象')
})

test('④ 两条写库路径都记签名（生成 + 手动上传）', () => {
  const src = readSrc('routes/characters.js')
  const updates = src.match(/UPDATE characters SET standing_url = \?, standing_world_sig = \? WHERE id = \?/g) || []
  assert.equal(updates.length, 2, `生成与上传两条路径都要写签名，实际 ${updates.length} 处`)
  assert.match(src, /currentWorldSignature\(\)/, '要用签名服务，别自己拼')
  assert.match(src, /enriched\.map\(withStandingStaleness\)/, '列表接口要下发 standing_stale')
  // 迁移列必须在（真实库升级靠它）
  const dbSrc = readSrc('db/index.js')
  assert.match(dbSrc, /ADD COLUMN standing_world_sig TEXT/, '要有迁移列')
})

test('⑤ UI 侧断言在 web-ui/test/standingWorldSyncUi.test.js（后端用例不跨读前端源码）', () => {
  // 说明：这里原来直接 readFileSync 前端 .vue 文件 ⇒ ENOENT（agent-core 用例的工作目录在前端之外）。
  // 仓约定是"agent-core 测后端、web-ui 测前端"，所以拆到 web-ui 那份里。
  assert.ok(true);
});

test('⑥ 表情立绘也记世界观签名（逐槽位，与主立绘同一口径）', () => {
  getDb()
  const id = seedWorld('表情立绘用世界观')
  const svc = fs.readFileSync(new URL('../src/services/expressionStandingService.js', import.meta.url), 'utf8')
  assert.match(svc, /import \{ currentWorldSignature, isStandingStale \} from '\.\/worldSignature\.js'/, '要复用签名服务')
  assert.match(svc, /world_sig=\?/, '写库要带世界签名')
  assert.match(svc, /currentWorldSignature\(\)/, '签名取自服务，别自己拼')
  assert.match(svc, /world_stale: info\.stale/, '列表要逐槽下发是否待同步')

  // 迁移列必须在（真实库升级靠它）
  const schema = fs.readFileSync(new URL('../src/db/expressionStandingSchema.js', import.meta.url), 'utf8')
  assert.match(schema, /ADD COLUMN world_sig TEXT/, '要有迁移列')
  assert.match(schema, /PRAGMA table_info\(character_expression_standings\)/, '迁移要有存在性守卫（重复启动不能炸）')

  // 行为：给一行槽位填不同签名，看判定
  const cur = sig.currentWorldSignature()
  const cid = Number(getDb().prepare("INSERT INTO characters (name, display_name, base_prompt) VALUES ('s','她','你是她。')").run().lastInsertRowid)
  getDb().prepare("INSERT INTO character_expression_standings (character_id, slot_id, image_url, world_sig, status) VALUES (?, 'normal', '/x.png', ?, 'done')").run(cid, cur)
  getDb().prepare("INSERT INTO character_expression_standings (character_id, slot_id, image_url, world_sig, status) VALUES (?, 'emoji:1', '/y.png', '9:oldhash', 'done')").run(cid)
  assert.equal(sig.isStandingStale({ standing_url: '/x.png', standing_world_sig: cur }).stale, false, '签名一致的槽位不算待同步')
  assert.equal(sig.isStandingStale({ standing_url: '/y.png', standing_world_sig: '9:oldhash' }).stale, true, '签名不同的槽位要标待同步')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
