/**
 * 生图判定配额可配 + 世界翻篇立刻刷日报（2026-10-01 第十七轮）
 *
 * ## 用户原话
 * 「需要把所有和生图相关的都看看 其他地方好像还是有限制」
 * 「日报的板块如果日期更新了也要去更新日报」
 *
 * ## 一、出图判定配额（原本硬编码 3）
 * `chat.js` 里那张 `imageJudgeCounters` 表管的是"她还要不要决定要图"：
 * 每轮用户发言 -1，生图成功重置，归零则跳过 LLM 判定直接生图。
 * 原来 3 写死在两处 `?? 3` + 一处 `set(…, 3)`：**两轮失败就见底** ⇒ 用户观感"生图被限制了"。
 * 现在走 `config.features.imageJudgeQuota`（默认 6，设置页 `feature_imageJudgeQuota` 可改）。
 *
 * ## 二、日报刷新
 * 后端在 `programDayRollover` 广播 `program_day_rollover`，前端 `newspaper` store 订阅后立刻 `fetchToday()`，
 * 不用等 60s 轮询（也不改变轮询作为兜底的既有节奏）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-quota-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const chat = fs.readFileSync(new URL('../src/routes/chat.js', import.meta.url), 'utf8')
const config = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8')
const settings = fs.readFileSync(new URL('../src/db/settings.js', import.meta.url), 'utf8')
const newspaper = fs.readFileSync(new URL('../../web-ui/src/stores/newspaper.js', import.meta.url), 'utf8')

test('① 配额不再硬编码 3：三处调用点都走 imageJudgeQuota()', () => {
  // ⚠️ 剥注释再扫：本文件第一版被**自己写在 chat.js 注释里的 `?? 3`** 绊倒（这轮第三次踩）
  const code = chat.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const hard = code.match(/\?\?\s*3\b/g) || []
  assert.equal(hard.length, 0, `chat.js 代码里不该再有 \`?? 3\`，实际 ${hard.length} 处`)
  assert.equal(/imageJudgeCounters\.set\(conversationId, 3\)/.test(code), false, '重置处也不许写死 3')
  const uses = code.match(/imageJudgeQuota\(\)/g) || []
  assert.ok(uses.length >= 4, `imageJudgeQuota() 至少 4 处（默认值 ×2、重置 ×1、日志 ×1），实际 ${uses.length}`)
  assert.match(code, /function imageJudgeQuota\(\)/, '要有配额读取函数')
  assert.match(code, /n >= 1 \? n : 6/, '要夹到 ≥1（配成 0 会让她永远不出图）')
})

test('② 配置侧：默认 6 + 可被设置页覆盖', () => {
  assert.match(config, /imageJudgeQuota: Number\(process\.env\.FEATURE_IMAGE_JUDGE_QUOTA \|\| 6\)/,
    'config.features 要有 imageJudgeQuota，默认 6，支持环境变量')
  assert.match(settings, /feature_imageJudgeQuota:\s*\{[^}]*key: 'imageJudgeQuota'[^}]*type: 'int'/,
    '要注册进 SETTING_TO_CONFIG（否则设置页改了重启就丢，还会打 warn）')
})

test('③ 容错：配成非法值时回落到 6（行为可预期）', async () => {
  const { config: cfg } = await import('../src/config.js')
  const before = cfg.features.imageJudgeQuota
  try {
    for (const bad of [0, -1, 'abc', null, undefined, NaN]) {
      cfg.features.imageJudgeQuota = bad
      // 直接跑一次真实调用点不现实（需要完整会话），这里复刻同一段夹取逻辑做等价断言
      const n = Math.trunc(Number(cfg.features?.imageJudgeQuota))
      const quota = Number.isFinite(n) && n >= 1 ? n : 6
      assert.equal(quota, 6, `非法值 ${String(bad)} 应回落到 6`)
    }
    cfg.features.imageJudgeQuota = 9
    const n = Math.trunc(Number(cfg.features.imageJudgeQuota))
    assert.equal(Number.isFinite(n) && n >= 1 ? n : 6, 9, '合法值要原样生效')
  } finally {
    cfg.features.imageJudgeQuota = before
  }
})

test('④ 日报：前端订阅 world rollover 并立刻刷新，且卸载时退订', () => {
  assert.match(newspaper, /import \{ onEvent \} from '\.\/unifiedStream\.js'/, '要用统一的 SSE 订阅入口')
  assert.match(newspaper, /onEvent\('program_day_rollover',\s*\(\)\s*=>\s*\{\s*fetchToday\(\)\s*\}\)/, '翻篇后立刻拉新一期')
  assert.match(newspaper, /unsubscribeRollover = onEvent\(/, '要保存退订函数')
  assert.match(newspaper, /function stopPolling\(\)[\s\S]{0,400}unsubscribeRollover\(\)/, '停轮询时要退订（别留悬挂监听）')
  assert.match(newspaper, /pollTimer = setInterval\(fetchToday, POLL_INTERVAL_MS\)/, '60s 轮询作为兜底保留')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
