/**
 * 奇遇「补图」入口（§3.5，2026-10-01）
 *
 * ## 为什么
 * 奇遇配图只在创建时生成一次。那次失败（ComfyUI 没开 / 模型没加载完 / 显存不够）之后，
 * 这条奇遇**永远没有图**，而前端只会显示「配图生成中…」——
 * 用户既不知道失败了，也没有任何补救入口，只能删掉重开。
 *
 * ## 这条测试钉住什么
 * 1. `character_events.error_message` 真的会被写（新建时带失败原因；补图成功要**清掉**它）；
 * 2. 补图用行里存的 `prompt` / `style` / `resolution`，不是另起一套；
 * 3. 失败时把**人话原因**回给调用方（前端要显示它），并且照样留一条失败任务记录；
 * 4. 不该在单测里真连 ComfyUI —— 所以对 `generate` 做了可注入的缝（默认 generateImageRaw）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-eventimg-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { regenerateEventImage } = await import('../src/services/eventGenerator.js')

function seedEvent({ prompt = 'a quiet rooftop at dusk, wind in the curtains', description = '她在天台上', style = null, resolution = '1024x768' } = {}) {
  const db = getDb()
  const charId = Number(db.prepare(`
    INSERT INTO characters (name, display_name, base_prompt, short_prompt, loras)
    VALUES (?, ?, 'p', 's', '[]')
  `).run('evt_regen_' + Math.random().toString(36).slice(2, 8), '测试角色').lastInsertRowid)
  const id = Number(db.prepare(`
    INSERT INTO character_events (character_id, event_type_key, status, title, description, image, prompt, style, resolution, expires_at)
    VALUES (?, 'test_type', 'open', '标题', ?, NULL, ?, ?, ?, datetime('now', '+1 hour'))
  `).run(charId, description, prompt, style, resolution).lastInsertRowid)
  return { db, charId, id }
}

test('不存在的奇遇 → not_found，不炸', async () => {
  const r = await regenerateEventImage(999999)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'not_found')
  assert.ok(r.error, '要有人话原因')
})

test('没存提示词 → no_prompt（并如实告诉用户只能重开一条）', async () => {
  const { id } = seedEvent({ prompt: '' })
  const r = await regenerateEventImage(id)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_prompt')
  assert.match(r.error, /提示词|重开/)
})

test('补图成功：写回 image、描边 prompt 更新、清掉 error_message、留一条完成记录', async () => {
  const { db, id } = seedEvent()
  // 先假装它以前失败过
  db.prepare(`UPDATE character_events SET error_message = 'ComfyUI 连不上（没启动或还在加载）' WHERE id = ?`).run(id)

  const pngBytes = Buffer.from('FAKE-PNG-BYTES')
  const calls = []
  const r = await regenerateEventImage(id, {
    generate: async (prompt, opts) => {
      calls.push({ prompt, opts })
      return {
        success: true,
        promptRefined: prompt + ', refined',
        wfMode: 'turbo',
        images: [{ base64: 'data:image/png;base64,' + pngBytes.toString('base64'), filename: 'x.png' }],
      }
    },
  })

  assert.equal(r.ok, true)
  assert.match(r.image, /^\/images\/events\//, '要返回可用的 /images/events/... URL')
  const filePath = path.join(tmpImages, 'events', path.basename(r.image))
  assert.ok(fs.existsSync(filePath), '文件要真的落盘')
  assert.deepEqual(fs.readFileSync(filePath), pngBytes, '字节要一致')

  const row = db.prepare('SELECT image, prompt, error_message FROM character_events WHERE id = ?').get(id)
  assert.equal(row.image, r.image)
  assert.equal(row.prompt, calls[0].prompt + ', refined', 'prompt 要更新成精修后的（与创建路径同口径）')
  assert.equal(row.error_message, null, '补图成功后必须清掉失败原因，否则前端一直显示失败态')

  // 用的是行里的 style/resolution，不是当前配置的默认值
  assert.equal(calls[0].opts.scene, 'events')
  assert.equal(calls[0].opts.width, 1024)
  assert.equal(calls[0].opts.height, 768)
})

test('补图失败：把原因写回 error_message 并原样回报给前端（不抛异常）', async () => {
  const { db, id } = seedEvent()
  const r = await regenerateEventImage(id, {
    generate: async () => ({ success: false, error: 'ComfyUI 连不上（没启动或还在加载），最后一次错误：fetch failed', wfMode: 'turbo', images: [] }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no_images')
  assert.match(r.error, /ComfyUI 连不上/)
  assert.equal(
    db.prepare('SELECT error_message FROM character_events WHERE id = ?').get(id).error_message,
    r.error,
    '失败原因要落库，前端才分得出"生成中"和"生成失败"'
  )
})

test('生图抛异常：同样落库 + 回报，不让异常冒到路由层', async () => {
  const { db, id } = seedEvent()
  const r = await regenerateEventImage(id, { generate: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8188') } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'threw')
  assert.match(r.error, /ECONNREFUSED/)
  assert.match(db.prepare('SELECT error_message FROM character_events WHERE id = ?').get(id).error_message, /ECONNREFUSED/)
})

test('接口与接线：路由存在、真的导入并调用、创建路径会把失败写进 error_message', () => {
  const routes = fs.readFileSync(new URL('../src/routes/events.js', import.meta.url), 'utf8')
  assert.match(routes, /regenerateEventImage/, '路由要导入它')
  assert.match(routes, /router\.post\('\/:id\/image'/, '要有 POST /:id/image')
  const gen = fs.readFileSync(new URL('../src/services/eventGenerator.js', import.meta.url), 'utf8')
  assert.match(gen, /let imageError = null/, '创建路径要记录失败原因')
  assert.match(gen, /choice_history, expires_at, error_message/, '创建时就要把 error_message 一起写进去')
  assert.match(gen, /error_message = NULL WHERE id = \?/, '补图成功要清掉它')

  const card = fs.readFileSync(new URL('../../web-ui/src/components/EventCard.vue', import.meta.url), 'utf8')
  assert.match(card, /regenerateEventImage/, '卡片要调用补图接口')
  assert.match(card, /重新配图/, '要有补图按钮文案')
  assert.equal(/<button[\s>]/.test(card), false, '按仓库约定不许裸 button（用 LinsheButton）')
  const api = fs.readFileSync(new URL('../../web-ui/src/api/index.js', import.meta.url), 'utf8')
  assert.match(api, /export async function regenerateEventImage/, 'api 层要有这个函数')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
