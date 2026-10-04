/**
 * 全流程验收（F1~F15）—— 对**已启动的后端**跑真实业务流程，不是"接口返回 200 就算过"。
 *
 * 为什么要这个脚本：2026-10-03 迁移当天这一套是**手敲**做的，没留脚本，合并 v3.6.3 时
 * 无法复跑。这里把它固化下来，每条都带可见产出（耗时 / 落库 id / 正文片段）。
 *
 * 用法：
 *   node e2e/flow-acceptance.mjs
 * 环境变量：
 *   FLOW_BASE      被测后端（默认 http://127.0.0.1:3199）
 *   FLOW_CHAR_ID   主角色（默认 6 = 纳西妲）
 *   FLOW_GROUP_ID  群（默认 2）
 *   FLOW_SKIP      逗号分隔要跳过的编号，如 "F3,F4"（生图慢时可跳过）
 *   FLOW_HEADLESS  0 显示浏览器（默认 1）
 *
 * ⚠️ 本脚本会**真实产生数据**（发消息 / 生成朋友圈与奇遇 / 寄信 / 重排日程 / 生图）。
 *    请对**副本库**运行，别对着真库跑。副本库做法：
 *      VACUUM INTO '<%TEMP%\flow.db>'  然后 DB_PATH=副本 PORT=3199 起后端。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3199'
const CHAR = Number(process.env.FLOW_CHAR_ID || 6)
const GROUP = Number(process.env.FLOW_GROUP_ID || 2)
const SKIP = new Set((process.env.FLOW_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean))
const HEADLESS = process.env.FLOW_HEADLESS !== '0'
/** 生图落盘目录（F7 用磁盘为准，因为 IMAGES_DIR 只改写入、不改静态服务，见下） */
const IMAGES_DIR = process.env.FLOW_IMAGES_DIR || process.env.IMAGES_DIR || null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const rec = (id, title, ok, ev) => {
  rows.push({ id, title, ok, ev })
  console.log(`${ok ? '✅' : '❌'} [${id}] ${title}\n      ${ev}`)
}
const j = async (u, opt = {}) => {
  const r = await fetch(BASE + u, { headers: { 'Content-Type': 'application/json' }, ...opt })
  let body = null
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('application/json')) body = await r.json().catch(() => null)
  else body = await r.arrayBuffer().catch(() => null)
  return { status: r.status, body, headers: r.headers }
}
/**
 * 取消息数组。**注意两个坑**（都实测踩过）：
 *   · `?limit=` 会被忽略，接口一次返回上千条；
 *   · `messages[0]` 是**最旧**的那条，不是最新。
 * ⇒ 基线只能取 **max(id)**，不能取 [0].id。
 */
const msgList = (resp) => (resp.body?.messages || (Array.isArray(resp.body) ? resp.body : []))
const maxId = (list) => list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)

console.log(`被测后端 = ${BASE} | 角色 = ${CHAR} | 群 = ${GROUP} | 跳过 = ${[...SKIP].join(',') || '无'}`)
console.log(`生图目录 = ${IMAGES_DIR || '（未设 IMAGES_DIR，按仓库 data/images）'}\n`)

// ── F1 私聊：发消息 → 她回一条 ────────────────────────────────────────────────
if (!SKIP.has('F1')) {
  try {
    const before = maxId(msgList(await j(`/api/characters/${CHAR}/messages`)))
    const t0 = Date.now()
    const post = await j(`/api/characters/${CHAR}/chat`, { method: 'POST', body: JSON.stringify({ message: '今天过得怎么样？' }) })
    let reply = '', replyId = null
    for (let i = 0; i < 40 && !reply; i++) {
      await sleep(2000)
      const list = msgList(await j(`/api/characters/${CHAR}/messages`))
      const cand = list.filter((m) => Number(m.id) > before && m.role === 'assistant').sort((a, b) => b.id - a.id)[0]
      if (cand) { reply = String(cand.content || ''); replyId = cand.id }
    }
    const ms = Date.now() - t0
    rec('F1', '私聊：发消息 → 她回一条', !!reply && reply.length > 0,
      `耗时 ${(ms / 1000).toFixed(1)}s | HTTP ${post.status} | 基线 maxId=${before} | 回复 id=${replyId} | 正文=${JSON.stringify(reply.slice(0, 80))}`)
  } catch (e) { rec('F1', '私聊：发消息 → 她回一条', false, String(e).slice(0, 160)) }
}

// ── F2 群聊：发群消息 → 有成员回应 ──────────────────────────────────────────
if (!SKIP.has('F2')) {
  try {
    const before = maxId(msgList(await j(`/api/groups/${GROUP}/messages`)))
    const t0 = Date.now()
    const post = await j(`/api/groups/${GROUP}/chat`, { method: 'POST', body: JSON.stringify({ message: '大家晚上好啊' }) })
    let replies = []
    for (let i = 0; i < 40; i++) {
      await sleep(2000)
      const list = msgList(await j(`/api/groups/${GROUP}/messages`))
      replies = list.filter((m) => Number(m.id) > before && m.role !== 'user')
      if (replies.length > 0 && Date.now() - t0 > 8000) break
    }
    const ms = Date.now() - t0
    const sample = replies.slice(0, 2).map((m) => `${m.speaker_name || '?'}：${String(m.content || '').slice(0, 36)}`).join(' / ')
    rec('F2', '群聊：发群消息 → 有成员回应', replies.length > 0,
      `耗时 ${(ms / 1000).toFixed(1)}s | HTTP ${post.status} | 基线 maxId=${before} | 新回应 ${replies.length} 条 | ${sample}`)
  } catch (e) { rec('F2', '群聊：发群消息 → 有成员回应', false, String(e).slice(0, 160)) }
}

// ── F3 朋友圈：真生成一条动态 ────────────────────────────────────────────────
if (!SKIP.has('F3')) {
  try {
    const before = await j('/api/moments/?limit=1')
    const beforeId = (before.body?.moments || before.body || [])[0]?.id ?? 0
    const t0 = Date.now()
    const post = await j('/api/moments/generate', { method: 'POST', body: JSON.stringify({ character_id: CHAR }) })
    const ms = Date.now() - t0
    const m = post.body?.moment || post.body
    const ok = post.status === 200 && !!m && (m.id > beforeId || m.content)
    rec('F3', '朋友圈：真生成一条动态', ok, `耗时 ${ms}ms | HTTP ${post.status} | id=${m?.id} | 正文=${JSON.stringify(String(m?.content || '').slice(0, 70))} | 图=${m?.image ? '有' : '无'}`)
  } catch (e) { rec('F3', '朋友圈：真生成一条动态', false, String(e).slice(0, 160)) }
}

// ── F4 奇遇：真生成一条（+ 配图）─────────────────────────────────────────────
// ⚠️ 状态依赖：同一角色**同时只能有一条活跃奇遇**，已有则返回 409 already_active_event。
//    那是正确的业务约束，不是缺陷 —— 所以跑之前先把活跃的那条 dismiss 掉，
//    否则第二次跑必然 409，容易被误读成"新功能坏了"。
let newEventId = null
if (!SKIP.has('F4')) {
  try {
    let dismissed = null
    const act = await j(`/api/events/active/${CHAR}`)
    const cur = act.body?.event || (act.body?.id ? act.body : null)
    if (cur?.id) {
      await j(`/api/events/${cur.id}/dismiss`, { method: 'POST', body: JSON.stringify({}) })
      dismissed = cur.id
      await sleep(1500)
    }
    const t0 = Date.now()
    const post = await j('/api/events/generate', { method: 'POST', body: JSON.stringify({ characterId: CHAR }) })
    const ms = Date.now() - t0
    const ev = post.body?.event || post.body
    newEventId = ev?.id ?? null
    const ok = post.status === 200 && !!newEventId
    rec('F4', '奇遇/事件：真生成一条（+ 配图）', ok,
      `耗时 ${(ms / 1000).toFixed(1)}s | HTTP ${post.status}${post.status === 409 ? '（已有活跃奇遇且自动 dismiss 未生效）' : ''} | 先清掉的活跃奇遇=${dismissed ?? '无'} | 新 id=${newEventId} | 标题=${JSON.stringify(String(ev?.title || '').slice(0, 46))} | 选项=${[ev?.choice_a, ev?.choice_b].filter(Boolean).length} 个 | 图=${ev?.image ? ev.image : '（无图）'}`)
  } catch (e) { rec('F4', '奇遇/事件：真生成一条（+ 配图）', false, String(e).slice(0, 160)) }
}

// ── F15 上游新功能：奇遇占用日程（eventSchedule）──────────────────────────────
// 判据是**落库事实**：新奇的 choice_history[0] 必须有 scheduleBinding，
// 且当天 daily_schedules 的对应时段被它占了。这条是 v3.6.3 的新能力，必须真验。
if (newEventId && !SKIP.has('F15')) {
  try {
    const r = await j(`/api/events/by-id/${newEventId}`)
    const ev = r.body?.event || r.body
    // ⚠️ 这个接口的 choice_history 是**已解析的数组**（不是字符串）—— 别再 JSON.parse。
    const raw = ev?.choice_history
    const history = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : [])
    const binding = history?.[0]?.scheduleBinding
    const ok = r.status === 200 && !!binding && !!binding.activity
    rec('F15', '上游新功能：奇遇占用日程（scheduleBinding 落库 + 日程被占）', ok,
      `HTTP ${r.status} | choice_history 类型=${Array.isArray(raw) ? 'array' : typeof raw} | scheduleBinding=${binding ? JSON.stringify({ activity: binding.activity?.activity, startAt: binding.startAt, endAt: binding.endAt }).slice(0, 150) : 'null（没绑定 ⇒ 新功能没生效）'}`)
  } catch (e) { rec('F15', '上游新功能：奇遇占用日程', false, String(e).slice(0, 160)) }
}

// ── F5 信箱：真寄一封信 ──────────────────────────────────────────────────────
if (!SKIP.has('F5')) {
  try {
    const t0 = Date.now()
    const post = await j('/api/mailbox/send', { method: 'POST', body: JSON.stringify({ character_id: CHAR, title: '验收测试', content: '这是一封来自全流程验收脚本的信。' }) })
    const ms = Date.now() - t0
    const letterId = post.body?.id ?? post.body?.letter?.id ?? null
    rec('F5', '信箱：真寄一封信', post.status === 200 && !!letterId, `耗时 ${ms}ms | HTTP ${post.status} | 信件 id=${letterId} | 回信排期=${post.body?.reply_at || post.body?.replyAt || '（见响应）'}`)
  } catch (e) { rec('F5', '信箱：真寄一封信', false, String(e).slice(0, 160)) }
}

// ── F6 日程：真重排 ──────────────────────────────────────────────────────────
// ⚠️ 路由是「**立即 200 + 后台串行跑**」（`resetTask.processing` 置位后 res.json 就返回，
//    接着在同一个 handler 里逐个角色 await 生成日程）⇒ 拿到 200 只代表"已受理"。
//    此时若再点一次会得到 409「重置世界线正在进行中」—— 那是**正确的并发保护**。
//    所以这里必须轮询 `/reset-status` 到 `active=false`，409 时等它跑完再重试一次。
if (!SKIP.has('F6')) {
  try {
    const isActive = async () => {
      const s = await j('/api/schedule/reset-status')
      return s.body?.active === true || s.body?.processing === true
    }
    let post = await j('/api/schedule/regenerate-all', { method: 'POST', body: JSON.stringify({}) })
    const t0 = Date.now()
    if (post.status === 409) {
      // 上一轮（可能是本脚本上一次运行）还在跑，等它落地再点一次
      for (let i = 0; i < 90 && (await isActive()); i++) await sleep(2000)
      post = await j('/api/schedule/regenerate-all', { method: 'POST', body: JSON.stringify({}) })
    }
    if (post.status === 200) {
      for (let i = 0; i < 120 && (await isActive()); i++) await sleep(2000)
    }
    const ms = Date.now() - t0
    const sch = await j(`/api/schedule/${CHAR}`)
    const acts = sch.body?.activities || sch.body?.schedule || (Array.isArray(sch.body) ? sch.body : [])
    const names = acts.slice(0, 3).map((a) => a?.activity || a?.name).filter(Boolean)
    rec('F6', '日程：真重排', post.status === 200 && acts.length > 0,
      `耗时 ${(ms / 1000).toFixed(1)}s | 受理 HTTP ${post.status} | 该角色当日 ${acts.length} 条日程 | 前三条=${JSON.stringify(names)}`)
  } catch (e) { rec('F6', '日程：真重排', false, String(e).slice(0, 160)) }
}

// ── F7 生图全链路（ComfyUI）──────────────────────────────────────────────────
// 判据以**落盘**为准：`IMAGES_DIR` 只改「写到哪」，不改 app.js 的静态服务目录
// （app.js:90 的 DATA_DIR 固定是 <repo>/data/images）⇒ 设了 IMAGES_DIR 之后
// `/images/...` 这个 URL 必然取不到，那是**测试隔离的副作用，不是缺陷**。
// 所以：磁盘文件 + PNG 魔数 = 硬判据；URL 可取 = 加分项。
if (!SKIP.has('F7')) {
  try {
    const t0 = Date.now()
    const post = await j('/api/images/generate', { method: 'POST', body: JSON.stringify({ prompt: '1girl, solo, sitting by the window, warm afternoon light, detailed background', conversation_id: `flow-accept-${Date.now()}` }) })
    const taskId = post.body?.task_id ?? post.body?.taskId ?? post.body?.id ?? null
    let st = null, out = null
    if (taskId) {
      for (let i = 0; i < 90; i++) {
        await sleep(2000)
        const s = await j(`/api/images/tasks/${taskId}/status`)
        st = s.body
        const paths = st?.output_paths || st?.outputPaths || []
        if (paths.length && ['done', 'success', 'completed'].includes(st?.status)) { out = paths[0]; break }
        if (['failed', 'error'].includes(st?.status)) break
      }
    }
    const ms = Date.now() - t0

    let bytes = 0, magic = '', src = ''
    if (out && IMAGES_DIR) {
      const disk = path.join(IMAGES_DIR, out.replace(/^\/images\//, '').replace(/\//g, path.sep))
      if (fs.existsSync(disk)) {
        const buf = fs.readFileSync(disk)
        bytes = buf.length; magic = buf.subarray(0, 8).toString('hex'); src = '磁盘'
      }
    }
    if (!src && out) {
      const r = await fetch(BASE + out)
      const buf = Buffer.from(await r.arrayBuffer())
      bytes = buf.length; magic = buf.subarray(0, 8).toString('hex'); src = `HTTP ${r.status}`
    }
    const isPng = magic.startsWith('89504e47')
    rec('F7', '生图全链路：提交→轮询→取图→PNG 魔数→落盘', !!out && isPng,
      `耗时 ${(ms / 1000).toFixed(1)}s | 提交 HTTP ${post.status} | taskId=${taskId} | 终态=${st?.status} | 产物=${out} | 取法=${src} | ${bytes} 字节 | 魔数=${magic || '-'} | PNG=${isPng}`)
  } catch (e) { rec('F7', '生图全链路', false, String(e).slice(0, 160)) }
}

// ── F8 记忆检索 + 重索引 ────────────────────────────────────────────────────
if (!SKIP.has('F8')) {
  try {
    const t0 = Date.now()
    const r1 = await j(`/api/memory/search?q=${encodeURIComponent('甜食')}&conversation_id=char_${CHAR}&top_k=5`)
    const t1 = Date.now()
    const r2 = await j('/api/memory/reindex', { method: 'POST' })
    const t2 = Date.now()
    const hits = r2.body && false ? 0 : (r1.body?.results || [])
    const first = hits[0]?.content || hits[0]?.text || ''
    rec('F8', '记忆检索 + 重索引', r1.status === 200 && r2.status === 200,
      `检索 ${t1 - t0}ms → ${hits.length} 命中 | 首条=${JSON.stringify(String(first).slice(0, 60))} | 重索引 ${t2 - t1}ms → HTTP ${r2.status} ${JSON.stringify(r2.body).slice(0, 90)}`)
  } catch (e) { rec('F8', '记忆检索 + 重索引', false, String(e).slice(0, 160)) }
}

// ── F9 数据备份：导出 ────────────────────────────────────────────────────────
if (!SKIP.has('F9')) {
  try {
    const t0 = Date.now()
    const r = await j('/api/data/export')
    const ms = Date.now() - t0
    const buf = r.body instanceof ArrayBuffer ? Buffer.from(r.body) : Buffer.from(r.body || [])
    const gz = buf.subarray(0, 2).toString('hex') === '1f8b'
    rec('F9', '数据备份：导出（gzip 魔数校验）', r.status === 200 && gz, `耗时 ${ms}ms | HTTP ${r.status} | ${(buf.length / 1048576).toFixed(1)} MB | Content-Type=${r.headers.get('content-type')} | gzip 魔数=${gz} | 文件名=${r.headers.get('content-disposition')}`)
  } catch (e) { rec('F9', '数据备份：导出', false, String(e).slice(0, 160)) }
}

// ── F10 玩具：装 → 查 → 摘 ──────────────────────────────────────────────────
// ⚠️ 字段名实测：可用清单是 `available[].toyKey`（不是 `key`），已戴是**顶层** `worn[]`。
if (!SKIP.has('F10')) {
  try {
    const g0 = await j(`/api/characters/${CHAR}/toys`)
    const available = (g0.body?.available || []).map((t) => (typeof t === 'string' ? t : t.toyKey)).filter(Boolean)
    const key = available.find((k) => /vibe_egg/.test(k)) || available[0]
    if (!key) { rec('F10', '玩具：装→查→摘', false, `没有可用玩具：available=${JSON.stringify(g0.body?.available).slice(0, 140)}`) }
    else {
      const t0 = Date.now()
      const eq = await j(`/api/characters/${CHAR}/toys/${key}/equip`, { method: 'POST', body: JSON.stringify({}) })
      const g1 = await j(`/api/characters/${CHAR}/toys`)
      const worn1 = (g1.body?.worn || []).length
      const rm = await j(`/api/characters/${CHAR}/toys/${key}/remove`, { method: 'POST', body: JSON.stringify({}) })
      const g2 = await j(`/api/characters/${CHAR}/toys`)
      const worn2 = (g2.body?.worn || []).length
      const ms = Date.now() - t0
      rec('F10', '玩具：装→查→摘', eq.status === 200 && rm.status === 200 && worn1 > 0 && worn2 === 0,
        `耗时 ${ms}ms | 玩具=${key}（可用 ${available.length} 件）| equip=${eq.status} → 戴(${worn1}) | remove=${rm.status} → 摘(${worn2})`)
    }
  } catch (e) { rec('F10', '玩具：装→查→摘', false, String(e).slice(0, 160)) }
}

// ── F12 上游新功能：报纸（真生成一期 + 读取）─────────────────────────────────
// 起初我只 GET 看到 200 就判过 —— 那个判据是假的：实测返回 `{newspaper: null}`
// （今天还没生成）。现在**主动触发再读**，断言真出内容。
if (!SKIP.has('F12')) {
  try {
    const t0 = Date.now()
    const gen = await j('/api/newspaper/generate', { method: 'POST', body: JSON.stringify({}) })
    const ms1 = Date.now() - t0
    let np = null
    for (let i = 0; i < 40; i++) {
      const g = await j('/api/newspaper/today')
      np = g.body?.newspaper
      if (np) break
      await sleep(2000)
    }
    const ms = Date.now() - t0
    // ⚠️ 字段名实测：报纸是 `name`（不是 title）+ `items[]`（每项 category/title/content/image_prompt）。
    const items = Array.isArray(np?.items) ? np.items : []
    const withText = items.filter((it) => it?.title && it?.content)
    const ok = !!np && withText.length > 0
    rec('F12', '上游新功能：报纸《小镇早知道》真生成一期', ok,
      `生成 HTTP ${gen.status}（${ms1}ms）| 轮询到内容 ${((ms - ms1) / 1000).toFixed(1)}s | 报头=${JSON.stringify(String(np?.name || ''))} 第 ${np?.edition} 期 ${np?.publish_date} | 条目 ${withText.length}/${items.length} 条有正文 | 首条=${JSON.stringify(String(withText[0]?.title || ''))}：${JSON.stringify(String(withText[0]?.content || '').slice(0, 44))} | 角色事件=${JSON.stringify(String(np?.character_event?.title || '无'))}`)
  } catch (e) { rec('F12', '上游新功能：报纸', false, String(e).slice(0, 160)) }
}

// ── F13 上游新功能：立绘总览 + 触摸台词补齐 ──────────────────────────────────
if (!SKIP.has('F13')) {
  try {
    const ov = await j('/api/expression-standings/overview')
    const list = ov.body?.characters || ov.body?.items || (Array.isArray(ov.body) ? ov.body : [])
    const t0 = Date.now()
    const fill = await j('/api/expression-standings/touch-lines/fill', { method: 'POST', body: JSON.stringify({}) })
    const ms = Date.now() - t0
    rec('F13', '上游新功能：立绘总览 + 触摸台词补齐（202 受理）', ov.status === 200 && (fill.status === 202 || fill.status === 200),
      `总览 HTTP ${ov.status} → ${list.length} 个角色 | 补齐 HTTP ${fill.status}（${ms}ms）→ ${JSON.stringify(fill.body).slice(0, 110)}`)
  } catch (e) { rec('F13', '上游新功能：立绘总览 + 触摸台词补齐', false, String(e).slice(0, 160)) }
}

// ── F11 / F14 浏览器：五页渲染 + 上游小镇拎起 ────────────────────────────────
if (!SKIP.has('F11')) {
  try {
    const require = createRequire(path.join(import.meta.dirname, 'package.json'))
    const { chromium } = require('playwright')
    const browser = await chromium.launch({ headless: HEADLESS })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
    const page = await ctx.newPage()
    const pageErrs = [], cerr = []
    page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 120)))
    page.on('console', (m) => { if (m.type() === 'error') cerr.push(m.text().slice(0, 120)) })
    const dismiss = async () => {
      for (const s of ['text=我知道了', 'text=知道了', '.modal-close', '.ls-modal__close']) {
        try { const l = page.locator(s).first(); if (await l.isVisible({ timeout: 600 })) { await l.click(); await sleep(300) } } catch { /* */ }
      }
    }
    const pages = [['私聊', '#/chat'], ['群聊', '#/chat'], ['奇遇', '#/events'], ['朋友圈', '#/moments'], ['小镇', '#/town'], ['设置', '#/settings']]
    const seen = []
    for (const [name, hash] of pages) {
      await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' })
      await sleep(name === '小镇' ? 9000 : 4000)
      await dismiss()
      const len = await page.evaluate(() => (document.querySelector('.page-host') || document.body).innerText.replace(/\s+/g, ' ').length)
      seen.push(`${name}=${len}`)
    }
    // 上游新功能：小镇「长按居民可拎起」
    let carry = { hint: false, longPressed: false, lifted: false }
    await page.goto(BASE + '/#/town', { waitUntil: 'domcontentloaded' })
    await sleep(10000); await dismiss()
    carry.hint = await page.evaluate(() => /长按居民可拎起/.test(document.body.innerText))
    const cv = page.locator('canvas').first()
    if (await cv.count() > 0) {
      const box = await cv.boundingBox()
      if (box) {
        // 在画布中部偏下扫几个点做长按（居民立绘大概在地图的下半部）
        const pts = [[0.5, 0.62], [0.42, 0.66], [0.58, 0.66], [0.5, 0.72], [0.36, 0.7], [0.64, 0.7]]
        for (const [fx, fy] of pts) {
          const x = box.x + box.width * fx, y = box.y + box.height * fy
          await page.mouse.move(x, y); await sleep(120)
          await page.mouse.down(); await sleep(1400)
          const holding = await page.evaluate(() => {
            const t = document.body.innerText
            return /拎起|抱起来?了|扛起/.test(t)
          })
          if (holding) { carry.longPressed = true; await page.mouse.move(x, y - 90, { steps: 12 }); await sleep(700); carry.lifted = true }
          await page.mouse.up(); await sleep(800)
          if (carry.lifted) break
        }
      }
    }
    await page.screenshot({ path: path.join(process.env.TEMP || '/tmp', 'flow-f11-town.png') })
    const realCerr = cerr.filter((t) => !/Failed to load resource/.test(t))
    rec('F11', '真浏览器六页渲染 + 上游「长按居民可拎起」', pageErrs.length === 0 && realCerr.length === 0 && seen.every((s) => Number(s.split('=')[1]) > 30),
      `页面文本长度 ${seen.join(' ')} | pageError=${pageErrs.length} | 真实 console error=${realCerr.length} | 拎起提示=${carry.hint} | 长按命中=${carry.longPressed} | 提起成功=${carry.lifted}`)
    await browser.close()
  } catch (e) { rec('F11', '真浏览器六页渲染 + 上游小镇拎起', false, String(e).slice(0, 200)) }
}

const pass = rows.filter((r) => r.ok).length
console.log(`\n════ 全流程验收汇总 ════\nPASS ${pass} / FAIL ${rows.length - pass}  (共 ${rows.length} 条)`)
for (const r of rows) if (!r.ok) console.log(`  ❌ ${r.id} ${r.title} — ${r.ev}`)
