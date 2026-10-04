/**
 * 独立生图接口要**落盘**（2026-10-01 真实流程实测发现）
 *
 * ## 现场
 * 真机跑 `POST /api/images/generate`（聊天之外的独立生图入口）→ 任务 5 秒 done，但：
 *   · `output_paths` 存的是 **裸文件名** `["ComfyUI_temp_otauu_00009_.png"]`
 *   · 那张图躺在 **`C:\ComfyUI\ComfyUI\temp\`** 里 —— ComfyUI 自己的临时目录，会被它清理
 * ⇒ 调用方按 `/images/ComfyUI_temp_otauu_00009_.png` 取必然 404，图迟早也没了。
 * 其它链路（聊天 / 朋友圈 / 奇遇 / 报纸）都是 `saveBase64Image` 落进 data/images 再存 `/images/...` URL。
 *
 * 这条路径当前**没有任何前端调用**（是调试/脚本入口），所以危害有限；但正因为它没人看，
 * 更容易在下次「图呢？」里浪费半天 —— 所以按同一口径修掉并钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// IMAGES_DIR 必须在 import 之前设好（imagePaths 在模块顶层解析它）
const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-standalone-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { IMAGE_CATEGORIES, saveBase64Image, getImageDir } = await import('../src/services/imagePaths.js')

test('standalone 是一个正式分类（有自己的目录）', () => {
  assert.ok(IMAGE_CATEGORIES.standalone, 'IMAGE_CATEGORIES 里要有 standalone')
  assert.equal(IMAGE_CATEGORIES.standalone.dir, 'standalone')
  assert.ok(IMAGE_CATEGORIES.standalone.label, '要有给相册筛选用的人话标签')
  assert.ok(getImageDir('standalone').endsWith('standalone'))
})

test('saveBase64Image 落盘并返回 /images/... URL（不再可能存裸文件名）', () => {
  const bytes = Buffer.from('PNGDATA-standalone-test')
  const url = saveBase64Image('standalone', 'standalone_1.png', 'data:image/png;base64,' + bytes.toString('base64'))
  assert.equal(url, '/images/standalone/standalone_1.png')
  const onDisk = path.join(tmpImages, 'standalone', 'standalone_1.png')
  assert.ok(fs.existsSync(onDisk), '文件要真的落盘')
  assert.deepEqual(fs.readFileSync(onDisk), bytes, '字节要一致')
})

test('源码级：/generate 的成功分支必须走 saveBase64Image，不许再存 i.filename', () => {
  const src = readFileSync(new URL('../src/routes/images.js', import.meta.url), 'utf8')
  const at = src.indexOf("router.post('/generate'")
  assert.ok(at > 0, '找不到 /generate 路由')
  const branch = src.slice(at, at + 2600)
  assert.match(branch, /saveBase64Image\('standalone'/, '成功分支必须落进 standalone 目录')
  assert.equal(/output_paths = \?[\s\S]{0,400}result\.images\.map\(i => i\.filename\)/.test(branch), false,
    '不许再把裸文件名写进 output_paths')
  assert.match(branch, /JSON\.stringify\(urls\)/, 'output_paths 要写落盘后拿到的 URL 数组')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
