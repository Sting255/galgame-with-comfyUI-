/**
 * 角色资产「一键后台生成」队列的回归（2026-10-01，用户原话「弄个按钮一键后台生成得了」）
 *
 * ## 它要解决什么
 * 立绘是**同步阻塞**接口（出完图才响应）、表情包的「全部生成」是**前端 while 循环**（关窗即停）、
 * 只有表情立绘是正经后台 job ⇒ 全量 8 角色 × 32 张 ≈ 256 张 / 35~50 分钟只能靠人一个个点开硬等。
 *
 * ## 本文件钉住的契约
 * 1. **只补缺靠文件真相**：`skipExisting` 判的是 `imageUrlExists()`，**不是** DB 里的 `status='done'`。
 *    真机事实：三类资产的图片文件磁盘上一张都没有、DB 却全是 done ⇒ 按 DB 判会一张都不生成。
 * 2. **全局单任务 + 严格串行**：同时只允许一个活跃 job（409），单元串行 ⇒ ComfyUI 只有 1 路请求。
 * 3. **失败不拖死整批**：单元失败只记账并继续；跑完按失败数给 `partial_failed`。
 * 4. **断点续跑**：重启把 running/queued 置 `interrupted`（不假成 failed），cursor 保留，resume 从断点续。
 * 5. **编排而非重写**：单元执行走既有三类入口（立绘 generate-standing / 表情包 prompts+images /
 *    表情立绘 generate），本模块里不出现任何生图或提示词逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmpImages = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-assetgen-'))
process.env.IMAGES_DIR = tmpImages
process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { config } = await import('../src/config.js')
const q = await import('../src/services/assetGenerationQueue.js')

/**
 * 本机 stub 探针：`createAssetJob` 现在开跑前会 ping ComfyUI（用户「ComfyUI关了」那条），
 * 而跑测试时真实 ComfyUI 通常是**关着**的 ⇒ 不给它一个能答话的 /system_stats，
 * 所有建任务的用例都会被守卫正确拦下（第一版就是这样红的）。
 * 用真 HTTP 而不是打桩内部函数，等于顺带把 `isComfyReachable()` 的正路也验了。
 */
const stubServer = await new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/system_stats')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('{"system":{"comfyui_version":"stub"}}')
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const stubPort = stubServer.address().port
// ⚠️ 必须 unref：server 句柄会让事件循环一直有活干，`node --test` 就永远不退出
//（第一版漏了这行，测试卡到十分钟后被挪进后台任务）。
stubServer.unref()
config.comfyui.url = `http://127.0.0.1:${stubPort}`
process.on('exit', () => { try { stubServer.close() } catch { /* 退出时不重要 */ } })

function seedCharacter(label) {
  return Number(getDb().prepare(
    'INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)'
  ).run(`assetgen_${label}_${Math.random().toString(36).slice(2, 6)}`, label, '你是她。').lastInsertRowid)
}
/** 造一个"文件真的存在"的立绘图，用来验跳过逻辑 */
function seedStandingFile(characterId, fileName = `stand_${characterId}.png`) {
  fs.writeFileSync(path.join(tmpImages, 'standing', fileName), Buffer.from('x'))
  getDb().prepare('UPDATE characters SET standing_url = ? WHERE id = ?')
    .run(`/images/standing/${fileName}`, characterId)
  return `/images/standing/${fileName}`
}
fs.mkdirSync(path.join(tmpImages, 'standing'), { recursive: true })

q.ensureAssetJobTable()

test('★ 建完任务必须**自动启动**（真机验收抓到过：只建行不启动 ⇒ 永远停在 queued）', () => {
  const src = fs.readFileSync(new URL('../src/services/assetGenerationQueue.js', import.meta.url), 'utf8')
  const at = src.indexOf('export async function createAssetJob')
  assert.ok(at > 0, 'createAssetJob 要还在（现在是 async：开跑前要 await 探针）')
  const body = src.slice(at, src.indexOf('\n}', at))
  assert.match(body, /startAssetJob\(jobId\)/, 'createAssetJob 里必须踢起 worker（放在服务层，任何调用方都不会漏）')
  // 而且 worker 自己是幂等的：同一个 job 重复 start 不会起两份
  assert.match(src, /if \(runningJobId === jobId\) return getAssetJob\(jobId\)/, 'startAssetJob 要幂等')
  assert.match(src, /if \(runningJobId\) return getAssetJob\(runningJobId\)/, '全局只跑一个 job')
})

test('★ ComfyUI 没开时必须**在开始前拦住**（用户「ComfyUI关了」）', async () => {
  const before = getDb().prepare('SELECT COUNT(*) n FROM asset_generation_jobs').get().n
  const original = config.comfyui.url
  config.comfyui.url = 'http://127.0.0.1:1'   // 必然连不上
  try {
    const err = await (async () => {
      try { await q.createAssetJob({ characterIds: [1], kinds: ['standing'], skipExisting: false }) } catch (e) { return e }
    })()
    assert.equal(err?.code, 'COMFY_DOWN', '要抛 COMFY_DOWN')
    assert.match(err.message, /ComfyUI 连不上/, '文案要说清是 ComfyUI 没启动/还在加载')
    assert.equal(
      getDb().prepare('SELECT COUNT(*) n FROM asset_generation_jobs').get().n, before,
      '被拦住时不许留下任务行（否则前端会看到一个永远不动的任务）'
    )
  } finally {
    config.comfyui.url = original
  }
  // 路由要把 COMFY_DOWN 映射成 409（"环境没就绪"不是程序出错）
  const route = fs.readFileSync(new URL('../src/routes/assetGeneration.js', import.meta.url), 'utf8')
  assert.match(route, /COMFY_DOWN[\s\S]{0,120}409/, 'COMFY_DOWN → 409')
  assert.match(route, /await createAssetJob\(/, '路由要 await（createAssetJob 现在是异步的）')
})

test('★ 表情立绘要认 jobId 的真实状态（真机验收抓到过"虚假成功"）', () => {
  const src = fs.readFileSync(new URL('../src/services/assetGenerationQueue.js', import.meta.url), 'utf8')
  // 早先版本轮询槽位状态：批次还没开始写时槽位仍是上一次的 done ⇒ 立刻判定完成，任务被标 done
  // 而图还在生成（实测：我的 job done @07:43:08，立绘 job 仍 generating completed=5）。
  assert.match(src, /SELECT status, completed, error FROM expression_standing_jobs WHERE id = \?/,
    '要直接读 job 行判定终态')
  assert.match(src, /if \(!jobId\) throw new Error\('表情立绘任务未返回 jobId/, '拿不到 jobId 必须报错，不许假装完成')
  assert.match(src, /waitExpressionStandingSettled\(jobId, UNIT_TIMEOUT_MS\.expressionStanding\)/, '轮询要用 jobId')
  assert.equal(/pending = slots\.filter/.test(src), false, '不许再按槽位状态判定完成')
})

test('★ 表情立绘要**槽位级只补缺**（规划 §一-3：原来总是全量重出 16 张）', () => {
  const id = seedCharacter('槽位级')
  // 三个槽位：一个文件在、一个指向不存在的文件、一个从没生成过
  fs.mkdirSync(path.join(tmpImages, 'expression_standing'), { recursive: true })
  fs.writeFileSync(path.join(tmpImages, 'expression_standing', 'ok.png'), Buffer.from('x'))
  getDb().prepare("INSERT INTO character_expression_standings (character_id, slot_id, image_url, status) VALUES (?, 'normal', '/images/expression_standing/ok.png', 'done')").run(id)
  getDb().prepare("INSERT INTO character_expression_standings (character_id, slot_id, image_url, status) VALUES (?, 'emoji:1', '/images/expression_standing/没了.png', 'done')").run(id)

  const missing = q.missingExpressionStandingSlots(id)
  assert.ok(missing.includes('normal') === false, '文件真在的槽位不该进"缺"名单')
  assert.ok(missing.includes('emoji:1'), 'DB 说 done 但文件不在 ⇒ 算缺（真机就是这种）')
  assert.ok(missing.length > 1, '期望槽位来自 standingSlots()：没生成过的类别也算缺，不能漏')

  // 单元执行要把 slotIds 传下去（不传 = 全量重出）
  const src = fs.readFileSync(new URL('../src/services/assetGenerationQueue.js', import.meta.url), 'utf8')
  assert.match(src, /expression-standings\/generate`\s*,\s*\{ slotIds: missing \}/, '要把缺失槽位交给批次')
  assert.match(src, /if \(missing\.length === 0\) return;/, '计划时齐了就不要再开批次（防御另一入口刚补过）')
})

test('只补缺判的是**文件**：DB 说 done 但文件不在 ⇒ 不能跳过（真机上就是这种）', () => {
  const withFile = seedCharacter('有文件')
  const withoutFile = seedCharacter('假 done')
  seedStandingFile(withFile)
  // 假 done：standing_url 有值、状态 whatever，但磁盘上没有这个文件
  getDb().prepare('UPDATE characters SET standing_url = ? WHERE id = ?')
    .run('/images/standing/不存在.png', withoutFile)

  const { units, skipped } = q.buildAssetPlan({ characterIds: [withFile, withoutFile], kinds: ['standing'], skipExisting: true })
  assert.equal(skipped, 1, '只有文件真在的那个才算跳过')
  assert.equal(units.length, 1, '假 done 必须进计划（否则"一键生成"一张都不会生成）')
  assert.equal(units[0].characterId, withoutFile)

  // skipExisting:false 时两个都要重画
  const forced = q.buildAssetPlan({ characterIds: [withFile, withoutFile], kinds: ['standing'], skipExisting: false })
  assert.equal(forced.units.length, 2)
  assert.equal(forced.skipped, 0)
})

test('计划展开：角色 × 类别，且单元带角色名与类别标签（前端进度要显示）', () => {
  const id = seedCharacter('展开')
  const { units } = q.buildAssetPlan({ characterIds: [id], kinds: q.ASSET_KINDS, skipExisting: false })
  assert.equal(units.length, 3)
  assert.deepEqual(units.map(u => u.kind), ['standing', 'emoji', 'expressionStanding'])
  assert.equal(units[0].characterName, '展开')
  assert.equal(q.ASSET_KIND_LABEL.expressionStanding, '表情立绘')
})

test('全局单任务：已有活跃任务时再建 → JOB_ACTIVE（不把 ComfyUI 打爆）', async () => {
  const id = seedCharacter('单任务')
  const first = await q.createAssetJob({ characterIds: [id], kinds: ['standing'], skipExisting: false })
  const err = await (async () => {
    try { await q.createAssetJob({ characterIds: [id], kinds: ['emoji'], skipExisting: false }) } catch (e) { return e }
  })()
  assert.equal(err?.code, 'JOB_ACTIVE')
  // 收尾：取消第一个（它的 worker 会因 cancelled 自行退出）
  q.cancelAssetJob(first.job.jobId)
})

test('进度形状：total/completed/failed/currentLabel/failures 都要有（前端只认这个）', async () => {
  const id = seedCharacter('进度')
  const { job } = await q.createAssetJob({ characterIds: [id], kinds: ['standing'], skipExisting: false })
  const view = q.getAssetJob(job.jobId)
  assert.equal(view.total, 1)
  assert.equal(view.completed, 0)
  assert.equal(view.failed, 0)
  assert.equal(view.status, 'queued')
  assert.ok(Array.isArray(view.failures))
  assert.equal(view.done, false)
  q.cancelAssetJob(job.jobId)
  assert.equal(q.getAssetJob(job.jobId).status, 'cancelled')
})

test('断点续跑：重启把 running/queued 置 interrupted（不假成 failed），cursor 保留', async () => {
  const id = seedCharacter('续跑')
  const { job } = await q.createAssetJob({ characterIds: [id], kinds: ['standing', 'emoji'], skipExisting: false })
  q.cancelAssetJob(job.jobId)  // 先确保没有活跃任务干扰
  // 手工造一个"跑了一半"的 running 任务
  q.ensureAssetJobTable()
  getDb().prepare(`INSERT INTO asset_generation_jobs (id, status, plan_json, cursor, total, completed, skipped)
    VALUES ('job_running_1', 'running', ?, 1, 2, 1, 0)`)
    .run(JSON.stringify([
      { characterId: id, characterName: '续跑', kind: 'standing', done: true, attempts: 1, error: '' },
      { characterId: id, characterName: '续跑', kind: 'emoji', done: false, attempts: 0, error: '' },
    ]))

  const recovered = q.recoverInterruptedAssetJobs()
  assert.ok(recovered >= 1)
  const view = q.getAssetJob('job_running_1')
  assert.equal(view.status, 'interrupted', '不许标成 failed（failed 语义是"跑过了、错了"）')
  assert.equal(view.cursor, 1, 'cursor 要保留，续跑才知道从哪接')
  assert.equal(view.completed, 1, '已完成数也要保留')
  assert.equal(view.total, 2)
})

test('resume 从断点继续：已完成的单元不再重跑', () => {
  const src = fs.readFileSync(new URL('../src/services/assetGenerationQueue.js', import.meta.url), 'utf8')
  assert.match(src, /if \(unit\.done\) \{ cursor\+\+/, 'worker 必须跳过已完成单元')
  assert.match(src, /status: 'interrupted'/, '重启要落 interrupted')
  assert.match(src, /export function resumeAssetJob/, '要有 resume')
  assert.match(src, /export function retryFailedAssetJob/, '失败项要能单独重试')
})

test('编排而非重写：单元执行只调既有入口，本模块不含生图/提示词逻辑', () => {
  const src = fs.readFileSync(new URL('../src/services/assetGenerationQueue.js', import.meta.url), 'utf8')
  assert.match(src, /generate-standing/, '立绘走既有同步入口')
  assert.match(src, /characters\/emoji\/prompts/, '表情包提示词走既有入口')
  assert.match(src, /characters\/emoji\/images/, '表情包出图走既有入口')
  assert.match(src, /expression-standings\/generate/, '表情立绘走既有 job 入口')
  assert.match(src, /includeDone: true/, '假 done（文件不在）要能重画')
  // 不许自己拼生图调用
  assert.equal(/\bgenerateImageRaw\b|\bchatSync\b/.test(src), false, '本模块不该直接调用生图/LLM')
  // 单元超时与串行间隔
  assert.match(src, /AbortSignal\.timeout/, '每个 HTTP 调用都要带超时')
  assert.match(src, /UNIT_GAP_MS/, '单元之间要有礼貌间隔（让前台请求插进来）')
})

process.on('exit', () => { try { fs.rmSync(tmpImages, { recursive: true, force: true }) } catch {} })
