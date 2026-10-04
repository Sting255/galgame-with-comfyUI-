/**
 * e2e/smoke-all-modules.mjs —— **全业务模块冒烟**（2026-10-03 用户：「完整所有业务模块全部测一下」）
 *
 * 与 `run-e2e.mjs`（浏览器点点点）分工不同：这里不看界面，直接把**每一个路由模块的 GET 端点**
 * 在**真实的 app.js + 真实数据副本**上跑一遍，专门抓那类"某个模块悄悄 500 / 404 / 挂载错了"的问题
 * （仓库已经栽过好几次：迁移失效、事件名发错、通配挂载顺序吃路径）。
 *
 * 做法：
 *   1. 真实库 `VACUUM INTO` 出一份副本（**绝不碰 `agent-core/data/agent.db`**）；
 *   2. 用打包的 node 起 `app.js`（空闲端口），等 `/api/health`；
 *   3. 读 `src/routes/*.js`，把每个文件里的 `router.get('…')` 字面量路径抽出来，
 *      按 `app.js` 的挂载表拼成完整 URL（`:id` / `:characterId` 用真实角色 id，`:groupId` 用真实群 id）；
 *   4. 逐个 GET：
 *        · 2xx            → PASS
 *        · 5xx            → **FAIL**（服务端崩了）
 *        · 404            → **FAIL**（代码里明明有这个 GET，挂载/参数有问题）
 *        · 其它 4xx       → WARN（多数是"这个接口要 query/状态不满足"，打印错误码供人看）
 *   5. 汇总成表格 + JSON 报告，退出码 = 有 FAIL ? 1 : 0。
 *
 * 环境变量：
 *   SMOKE_PORT=3410        后端端口
 *   SMOKE_CHAR_ID=<n>      抽查角色（默认取好感最高的）
 *   SMOKE_KEEP=1           跑完不删副本库（排查用）
 *   SMOKE_VERBOSE=1        打印每个端点的结果（默认只打印模块汇总与异常项）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CORE = path.join(ROOT, 'agent-core')
const NODE = path.join(ROOT, 'runtime', 'nodejs', process.platform === 'win32' ? 'node.exe' : 'node')
const REAL_DB = path.join(CORE, 'data', 'agent.db')
const PORT = Number(process.env.SMOKE_PORT || 3410)
const BASE = `http://127.0.0.1:${PORT}`
const VERBOSE = process.env.SMOKE_VERBOSE === '1'
const KEEP = process.env.SMOKE_KEEP === '1'
const DB = path.join(os.tmpdir(), `linshe-smoke-${Date.now()}.db`)
const OUT_DIR = path.join(os.tmpdir(), 'linshe-smoke')

const rows = []
let backend = null

const log = (...a) => console.log(...a)
function record(module, method, url, status, note) {
  const ok = status >= 200 && status < 300
  const fail = status >= 500 || status === 404
  const result = ok ? 'PASS' : (fail ? 'FAIL' : 'WARN')
  rows.push({ module, method, url, status, result, note: String(note || '').slice(0, 220) })
  if (VERBOSE || result !== 'PASS') {
    const mark = result === 'PASS' ? '✅' : result === 'WARN' ? '⚠️' : '❌'
    log(`  ${mark} [${module}] ${method} ${url} → ${status}${note ? ' | ' + String(note).slice(0, 120) : ''}`)
  }
}

async function fetchJson(url, init) {
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  } catch (err) {
    return { status: 0, json: null, text: String(err?.message || err) }
  }
}

// ── 0. 真实库副本 ─────────────────────────────────────────────────────────────
function copyRealDb() {
  if (!fs.existsSync(REAL_DB)) {
    log(`⚠️ 找不到真实库：${REAL_DB}（跳过需要数据的用例）`)
    return false
  }
  const Database = require(path.join(CORE, 'node_modules', 'better-sqlite3'))
  const db = new Database(REAL_DB, { readonly: true, fileMustExist: true })
  try {
    db.exec(`VACUUM INTO '${DB.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  const kb = Math.round(fs.statSync(DB).size / 1024)
  log(`✅ 真实库副本已就绪：${DB}（${kb} KB，真实库只读未动）`)
  return true
}

// ── 1. 起后端 ────────────────────────────────────────────────────────────────
async function startBackend() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = fs.openSync(path.join(OUT_DIR, 'backend.log'), 'w')
  backend = spawn(NODE, ['app.js'], {
    cwd: CORE,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, LOG_TO_FILE: 'false' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const res = await fetchJson(`${BASE}/api/health`)
    if (res.status === 200) {
      log(`✅ 后端已启动：${BASE}（DB_PATH=${DB}）`)
      return true
    }
    if (backend.exitCode !== null) throw new Error(`后端进程提前退出（exit ${backend.exitCode}），日志见 ${OUT_DIR}\\backend.log`)
    await new Promise(r => setTimeout(r, 800))
  }
  throw new Error(`后端 90 秒没起来，日志见 ${OUT_DIR}\\backend.log`)
}

function stopBackend() {
  if (backend && backend.exitCode === null) {
    try { backend.kill() } catch { /* ignore */ }
  }
  backend = null
}

// ── 2. 从源码抽出"每个模块有哪些 GET 端点" ────────────────────────────────────
/** 路由文件 → 挂载前缀（与 app.js 的 app.use 一一对应；顺序同 app.js） */
const MOUNTS = {
  'expressionStandings.js': ['/api'],
  'chat.js': ['/api'],
  'memory.js': ['/api/memory'],
  'images.js': ['/api/images'],
  'assetGeneration.js': ['/api/asset-generation'],
  'intimateActions.js': ['/api/intimate-actions'],
  'emoji.js': ['/api/characters/emoji'],
  'touch.js': ['/api/characters'],
  'toys.js': ['/api/characters'],
  'hypnosis.js': ['/api/characters'],
  'intimateAiEdit.js': ['/api/characters'],
  'intimate.js': ['/api/characters'],
  'characters.js': ['/api/characters'],
  'config.js': ['/api/config'],
  'moments.js': ['/api/moments'],
  'relationships.js': ['/api/relationships'],
  'userRelationships.js': ['/api/user-relationships'],
  'portraits.js': ['/api/portraits'],
  'notifications.js': ['/api/notifications'],
  'events.js': ['/api/events'],
  'stream.js': ['/api/stream'],
  'schedule.js': ['/api/schedule', '/api'],
  'time.js': ['/api/time'],
  'workflows.js': ['/api/workflows'],
  'mailbox.js': ['/api/mailbox'],
  'groups.js': ['/api/groups'],
  'library.js': ['/api/library'],
  'items.js': ['/api/items'],
  'newspaper.js': ['/api/newspaper'],
  'town.js': ['/api/town'],
  'context.js': ['/api/context'],
  'data.js': ['/api/data'],
}

/** 只保留"能安全 GET"的路径：不含查询串、参数只有 id / characterId / groupId */
const ID_PARAMS = new Set(['id', 'characterId', 'charId', 'groupId'])

function collectEndpoints(charId, groupId) {
  const dir = path.join(CORE, 'src', 'routes')
  const list = []
  const skipped = []
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const prefixes = MOUNTS[file]
    if (!prefixes) { skipped.push({ file, reason: 'app.js 里没找到挂载（可能是子路由）' }); continue }
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    const re = /router\.get\(\s*'([^']+)'/g
    let m
    while ((m = re.exec(src))) {
      const sub = m[1]
      const params = [...sub.matchAll(/:([A-Za-z_]+)/g)].map(x => x[1])
      if (params.some(p => !ID_PARAMS.has(p))) { skipped.push({ file, path: sub, reason: `参数 ${params.join(',')} 需要真实值` }); continue }
      const filled = sub
        .replace(/:characterId|:charId|:id/g, String(charId))
        .replace(/:groupId/g, String(groupId))
      // 裸 `:id` 的含义因路由而异（消息 id / 信件 id / NPC id …）：我们用角色 id 代替**必然对不上**，
      // 所以给这类端点打上 ambiguous 标记 —— 处理器自己回 404（"信不存在"）算 SKIP，不算产品问题；
      // 只有 Express 默认的 HTML 404（= 根本没有路由接住）才算 FAIL。
      const ambiguousId = params.includes('id')
      list.push({ module: file.replace(/\.js$/, ''), method: 'GET', path: filled, prefixes, ambiguousId })
    }
  }
  return { list, skipped }
}

// ── 3. 跑 ────────────────────────────────────────────────────────────────────
async function main() {
  log('════════ 全业务模块冒烟（GET 全扫）════════')
  if (!copyRealDb()) { log('没有真实库，无法做全模块冒烟。'); process.exit(0) }
  await startBackend()

  // 抽查角色 / 群：优先沿用 E2E 的"名字命中"，否则取第一个
  const chars = (await fetchJson(`${BASE}/api/characters`)).json
  const charList = Array.isArray(chars) ? chars : (chars?.characters || [])
  if (charList.length === 0) throw new Error('真实库里没有角色，冒烟无从下手')
  const charId = Number(process.env.SMOKE_CHAR_ID) || Number(charList.find(c => /纳西妲/.test(c.display_name || c.name || ''))?.id) || Number(charList[0].id)
  const charName = charList.find(c => Number(c.id) === charId)?.display_name || charList.find(c => Number(c.id) === charId)?.name || ''
  const groupsRes = (await fetchJson(`${BASE}/api/groups`)).json
  const groupList = Array.isArray(groupsRes) ? groupsRes : (groupsRes?.groups || [])
  const groupId = Number(groupList[0]?.id) || 1
  log(`抽查角色：${charId}（${charName}）· 抽查群：${groupId}（${groupList.length} 个群，${charList.length} 个角色）`)

  // 3.1 基础端点（手写，形状也顺手校验）
  record('health', 'GET', '/api/health', (await fetchJson(`${BASE}/api/health`)).status, '')
  record('version', 'GET', '/api/version', (await fetchJson(`${BASE}/api/version`)).status, '')
  const charsRes = await fetchJson(`${BASE}/api/characters`)
  record('characters', 'GET', '/api/characters', charsRes.status, `角色数=${charList.length}`)
  const cfg = await fetchJson(`${BASE}/api/config`)
  record('config', 'GET', '/api/config', cfg.status, `features=${Object.keys(cfg.json?.features || {}).length} 项`)

  // 3.2 手写"关键新功能"端点（这些是本轮/上轮的重点，形状要一起看）
  const key = [
    ['intimate-actions', `/api/intimate-actions/${charId}/state`, j => `动作数=${j?.actions?.length} 门槛=${j?.state?.climaxThreshold} 敏感度=${j?.her?.sensitivity?.value}(${j?.her?.sensitivity?.tierLabel}) 自动速度=${j?.state?.autoPaceLabel}/${j?.state?.autoIntervalMs}ms`],
    ['characters/heat', `/api/characters/${charId}/heat`, j => `heat=${j?.heat} value=${j?.value} ${j?.tierLabel}`],
    ['characters/hypnosis', `/api/characters/${charId}/hypnosis`, j => `active=${j?.active} gate=${j?.gate?.code || j?.gate}`],
    ['characters/touch', `/api/characters/${charId}/touch/state`, j => `档位数=${Object.keys(j?.states || {}).length}`],
    ['characters/toys', `/api/characters/${charId}/toys`, j => `清单=${j?.catalog?.length ?? j?.toys?.length ?? '?'} 已戴=${j?.worn?.length ?? '?'}`],
    ['characters/intimate', `/api/characters/${charId}/intimate`, j => `档案=${j?.profile ? '有' : '无'}`],
    ['schedule', `/api/schedule/${charId}`, j => `日程=${j?.activities?.length} 条 私密时刻 has=${j?.private_moment?.has}`],
    ['schedule/private-moment', `/api/schedule/${charId}/private-moment`, j => `has=${j?.has} active=${j?.active} line=${j?.line || '-'}`],
    ['schedule/current', `/api/schedule/${charId}/current`, j => `活动=${j?.activity || j?.currentActivity || '-'}`],
    ['groups', '/api/groups', j => `群数=${(Array.isArray(j) ? j : j?.groups || []).length}`],
    // ⚠️ 别凭想象写 URL：这里每一条都必须是真实存在的端点（`/api/memory/:id` 这种是我第一版编的，
    //    根本没有这个路由 ⇒ 白报一条 FAIL。宁可用真实端点少写几条。）
    ['memory stats', '/api/memory/stats', j => `碎片=${j?.fragments ?? j?.total ?? '?'} 记忆=${j?.memories ?? j?.vectors ?? '?'}`],
    ['memory fragments', '/api/memory/fragments', j => `条数=${(Array.isArray(j) ? j.length : j?.fragments?.length) ?? '?'}`],
    ['news newspaper', '/api/newspaper/today', j => `标题=${j?.title || j?.content?.slice?.(0, 12) || '-'}`],
    ['town', '/api/town/map', j => `瓦片=${(j?.tiles || j?.map?.tiles || []).length || '-'}`],
  ]
  for (const [mod, url, shape] of key) {
    const res = await fetchJson(`${BASE}${url}`)
    let note = ''
    try { note = res.status === 200 ? shape(res.json) : (res.json?.error || res.text?.slice(0, 80)) } catch { note = '' }
    record(mod, 'GET', url, res.status, note)
  }

  // 3.3 自动扫全部路由文件的 GET 端点
  const { list, skipped } = collectEndpoints(charId, groupId)
  log(`\n从 src/routes/*.js 抽出 ${list.length} 个可安全 GET 的端点（跳过 ${skipped.length} 个需要真实参数的）`)
  const seen = new Set()
  for (const ep of list) {
    const url = `${ep.prefixes[0]}${ep.path}`
    if (seen.has(url)) continue
    seen.add(url)
    // /api/stream 与 SSE 长连接：GET 会挂着不返回，跳过（由浏览器 E2E 覆盖）
    if (/\/stream/.test(url) || /\/chat$/.test(url)) { record(ep.module, 'GET', url, 200, '跳过（长连接/会触发模型）'); rows.at(-1).result = 'SKIP'; continue }
    const res = await fetchJson(`${BASE}${url}`)
    const note = res.status === 200 ? '' : (res.json?.error || res.json?.message || String(res.text || '').slice(0, 90))
    // 裸 `:id` 的端点：处理器自己回 404 ⇒ 路由是活的（我们只是拿不到那个真实 id）⇒ SKIP
    const handlerAnswered = res.json !== null && res.json !== undefined
    if (ep.ambiguousId && res.status === 404 && handlerAnswered) {
      record(ep.module, 'GET', url, 200, `跳过（参数 :id 需要真实值，处理器已正常应答：${note}）`)
      rows.at(-1).result = 'SKIP'
      continue
    }
    record(ep.module, 'GET', url, res.status, note)
    // 备用前缀（如 schedule 同时挂在 /api/schedule 与 /api）
    if (res.status === 404 && ep.prefixes.length > 1) {
      const alt = `${ep.prefixes[1]}${ep.path}`
      const altRes = await fetchJson(`${BASE}${alt}`)
      record(ep.module, 'GET', alt, altRes.status, altRes.status === 200 ? '（备用前缀命中）' : (altRes.json?.error || ''))
    }
  }

  // 3.4 **写路径**（2026-10-03 补）：只扫 GET 是不够的 —— 上面那 133 条全是"读得到吗"，
  //   而真正会返工的是"点下去状态对不对"。这里在副本库上把主要动作真跑一遍。
  //   省额度模式先打开（`features.touchInstant=false`）：动作照常推进状态，但不调模型 ⇒
  //   不用等网关、也不会烧用户的额度（副本库上的设置改动不影响任何真实数据）。
  log('\n── 写路径（真点，省额度模式，不调模型）──')
  const setFeature = async (key, value) => {
    const res = await fetchJson(`${BASE}/api/config/features`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }),
    })
    return res.status
  }
  record('config/features', 'PUT', '/api/config/features touchInstant=false', await setFeature('touchInstant', false), '省额度模式')
  const before = (await fetchJson(`${BASE}/api/config`)).json?.features?.touchInstant
  record('config/features', 'GET', '/api/config（复核 touchInstant）', before === false ? 200 : 500, `touchInstant=${before}`)

  const post = async (mod, url, body) => {
    const res = await fetchJson(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    return res
  }
  const st = async () => (await fetchJson(`${BASE}/api/intimate-actions/${charId}/state`)).json

  // ① 进入 → 自动插入（带速度）→ 只改速度 → 关 → 退出来
  const enter = await post('intimate-actions', `/api/intimate-actions/${charId}/enter`)
  record('intimate-actions', 'POST', `/api/intimate-actions/${charId}/enter`, enter.status,
    `active=${enter.json?.state?.active} penetrating=${enter.json?.state?.penetrating} mode=${enter.json?.mode}`)
  const auto1 = await post('intimate-actions', `/api/intimate-actions/${charId}/auto`, { pace: 4 })
  record('intimate-actions', 'POST', `…/auto {pace:4}`, auto1.status,
    `autoThrust=${auto1.json?.state?.autoThrust} autoPace=${auto1.json?.state?.autoPace} 间隔=${auto1.json?.state?.autoIntervalMs} 手动节奏=${auto1.json?.state?.pace}`)
  const auto2 = await post('intimate-actions', `/api/intimate-actions/${charId}/auto`, { pace: 1 })
  const keepOn = auto2.json?.state?.autoThrust === true && auto2.json?.state?.autoPace === 1 && auto2.json?.state?.pace !== 1
  record('intimate-actions', 'POST', `…/auto {pace:1}（只改速度）`, keepOn ? 200 : 500,
    `自动仍开=${auto2.json?.state?.autoThrust} 速度=${auto2.json?.state?.autoPace} 手动节奏没被动=${auto2.json?.state?.pace}`)
  const autoOff = await post('intimate-actions', `/api/intimate-actions/${charId}/auto`)
  record('intimate-actions', 'POST', '…/auto {}（关）', autoOff.json?.state?.autoThrust === false ? 200 : 500, `autoThrust=${autoOff.json?.state?.autoThrust}`)
  const stop = await post('intimate-actions', `/api/intimate-actions/${charId}/stop`)
  const stopped = stop.json?.state?.penetrating === false && stop.json?.state?.autoThrust === false
  record('intimate-actions', 'POST', '…/stop', stopped ? 200 : 500, `penetrating=${stop.json?.state?.penetrating} autoThrust=${stop.json?.state?.autoThrust}（都要 false）`)

  // ② 发情模式：开 ⇒ 100；关 ⇒ 回到发情前的值（不是一律 55）
  const sensBefore = (await st())?.her?.sensitivity?.value ?? 0
  const heatOn = await post('characters/heat', `/api/characters/${charId}/heat`, { on: true, minutes: 5 })
  record('characters/heat', 'POST', '/heat {on:true}', heatOn.json?.value === 100 ? 200 : 500, `value=${heatOn.json?.value} ${heatOn.json?.tierLabel}`)
  const heatOff = await post('characters/heat', `/api/characters/${charId}/heat`, { on: false })
  record('characters/heat', 'POST', '/heat {on:false}', Math.abs((heatOff.json?.value ?? -1) - sensBefore) < 0.01 ? 200 : 500,
    `回到发情前 ${sensBefore} ⇒ 现在 ${heatOff.json?.value}（旧口径会砍成 55）`)

  // ③ 触摸 / 玩具 / 私密时刻（省额度 ⇒ 不调模型）
  const touch = await post('touch', `/api/characters/${charId}/touch/pat_head`)
  record('touch', 'POST', '/touch/pat_head', touch.status, `allowed=${touch.json?.allowed} mode=${touch.json?.mode}`)
  const equip = await post('toys', `/api/characters/${charId}/toys/vibe_egg/equip`, { intensity: 1 })
  record('toys', 'POST', '/toys/vibe_egg/equip', equip.status, `code=${equip.json?.code ?? 'ok'}`)
  const remove = await post('toys', `/api/characters/${charId}/toys/vibe_egg/remove`)
  record('toys', 'POST', '/toys/vibe_egg/remove', remove.status, `code=${remove.json?.code ?? 'ok'}`)

  // 3.5 汇总
  const byModule = new Map()
  for (const r of rows) {
    if (!byModule.has(r.module)) byModule.set(r.module, { pass: 0, warn: 0, fail: 0, skip: 0 })
    const b = byModule.get(r.module)
    b[r.result === 'PASS' ? 'pass' : r.result === 'WARN' ? 'warn' : r.result === 'SKIP' ? 'skip' : 'fail'] += 1
  }
  log('\n════════ 模块汇总 ════════')
  for (const [mod, b] of [...byModule.entries()].sort()) {
    const mark = b.fail > 0 ? '❌' : (b.warn > 0 ? '⚠️' : '✅')
    log(`  ${mark} ${mod.padEnd(22)} PASS=${b.pass} WARN=${b.warn} FAIL=${b.fail}${b.skip ? ' SKIP=' + b.skip : ''}`)
  }
  const fails = rows.filter(r => r.result === 'FAIL')
  const warns = rows.filter(r => r.result === 'WARN')
  if (warns.length) {
    log('\n⚠️ WARN 明细（4xx：多是"这个 GET 需要 query 或状态不满足"，逐条看一眼）')
    for (const w of warns) log(`   ${w.status} ${w.method} ${w.url} — ${w.note}`)
  }
  if (fails.length) {
    log('\n❌ FAIL 明细（5xx 或 404：代码里有这个 GET，却拿不到正常响应）')
    for (const f of fails) log(`   ${f.status} ${f.method} ${f.url} — ${f.note}`)
  }
  const report = { at: new Date().toISOString(), charId, groupId, total: rows.length, pass: rows.filter(r => r.result === 'PASS').length, warn: warns.length, fail: fails.length, skipped: skipped.length, rows, skippedDetail: skipped }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const reportPath = path.join(OUT_DIR, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  log(`\n════════ 结论 ════════`)
  log(`  端点 ${rows.length} 个：PASS ${report.pass} · WARN ${report.warn} · FAIL ${report.fail}（另有 ${skipped.length} 个需参数未扫）`)
  log(`  报告：${reportPath}`)
  log(`  后端日志：${path.join(OUT_DIR, 'backend.log')}`)
  process.exitCode = fails.length ? 1 : 0
}

try {
  await main()
} catch (err) {
  console.error('❌ 冒烟脚本异常：', err?.stack || err)
  process.exitCode = 2
} finally {
  stopBackend()
  if (!KEEP) {
    try { fs.rmSync(DB, { force: true }) } catch { /* ignore */ }
    for (const ext of ['-wal', '-shm']) { try { fs.rmSync(DB + ext, { force: true }) } catch { /* ignore */ } }
  }
}
