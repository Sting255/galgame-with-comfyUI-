/**
 * L6 浏览器点击验证 · **群聊版**：🧸 玩具 / ❤ 性爱推进入口（2026-10-02）
 *
 * 为什么单独一份：私聊版 `e2e/check-panels.mjs` 里 `:character-id` 就是当前会话角色，点开就行；
 * 而**群里有很多人**，这两个面板一次只能作用于一个人 ⇒ 必须先「对谁」。所以群聊版多验三件事：
 *   ① 未选目标不许打开、也不许默认拿 members[0]；② 选中后必须作用在**那个成员**身上（不是 chat.activeCharId）；
 *   ③ 选人流程本身（✋ → 面板顶部「对 谁？」→ 点成员）走不走得通。
 * 另外按功能 Agent 的提示补了两条它没验过的：🧸 的「戴上」是 emit 给父组件的（接线断了就点了没反应）、
 * 以及**换目标时两个面板会自动关掉**。
 *
 * 怎么跑（两步，别合成一条命令）：
 *   1) 起后端（**副本库**，绝不碰真库）：
 *        $src='<ComfyUI 安装目录>'; $snap="$env:TEMP\e2eg.db"
 *        & "$src\runtime\nodejs\node.exe" --input-type=module -e "import {createRequire} from 'node:module'; const r=createRequire('file:///C:/3.6.2-r/agent-core/package.json'); const D=r('better-sqlite3'); const s=new D('C:/3.6.2-r/agent-core/data/agent.db',{readonly:true,fileMustExist:true}); s.prepare('VACUUM INTO ?').run(process.argv[1]); s.close()" $snap
 *        cd web-ui; node build.mjs; cp -r ../agent-core/public/assets/* C:\3.6.2-r\agent-core\public\assets\   # 让浏览器看到最新前端
 *        $env:DB_PATH=$snap; $env:PORT='3199'; $env:NODE_ENV='production'; $env:LOG_TO_FILE='false'
 *        Start-Process -FilePath "$src\runtime\nodejs\node.exe" -ArgumentList 'app.js' -WorkingDirectory 'C:\3.6.2-r\agent-core' -WindowStyle Hidden
 *   2) 等 /api/config 起来后：node e2e/check-group-panels.mjs
 *   ⚠️ 要停服务请**单独**一条命令只干这一件事（同一个调用里既干重活又 Stop-Process 会让作业运行器崩）。
 *
 * 选择器出处（全部来自功能 Agent 实测契约 + 我只读核对过的源码行）：
 *   · 三个入口：`div.touch-icon-btn[aria-label="动作"|"玩具"|"推进"]`（GroupChatView.vue 252/272/291 行附近）
 *     · 最稳的钩子是 `title` 三态：`玩具（先选一个人）` / `玩具（对 XXX）` / `收起玩具面板`
 *     · 开/关状态另有 `.is-open`
 *   · 目标列表：`#touch-target-list.mention-panel[role="listbox"]`，条目 `div.mention-item[role="option"]`
 *     ⚠️ `.is-active` 是**悬停/键盘高亮**，不是"已选中"；点完列表就关，选中与否只能看 title / ✋ 面板头部
 *   · 🧸 面板在 LinsheModal 外壳里 ⇒ `.modal-overlay.linshe-modal-overlay` + `.modal-panel.linshe-modal`（v-if 卸载）
 *   · ❤ 面板：`div.ia-panel[role="dialog"][aria-label="性爱推进"]`，HUD 是 `.ia-chip`
 *   · 提示走全局 toast：`.live-toast-message`（Toast.vue 37 行），文案来自 components/groupPanelLogic.js
 *   · ⚠️ 接口路径：玩具是 `/api/characters/<id>/toys…`，但**推进不是** —— 它是 `/api/intimate-actions/<id>/state`
 *     （我第一版按 `/api/characters/<id>/intimate-actions` 抓，结果永远抓不到，白判了一条 FAIL）
 */
import { chromium } from 'playwright'

// 目标地址可覆盖：红测 / 多份包并行时要指向别的端口。
// 两个变量名都收：GROUP_PANEL_CHECK_BASE 是本文件专用，PANEL_CHECK_BASE 与 check-panels.mjs 保持同名口径。
const BASE = process.env.GROUP_PANEL_CHECK_BASE || process.env.PANEL_CHECK_BASE || 'http://127.0.0.1:3199'
const NO_TARGET_HINT = '先在「✋ 动作」里选一个人'

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
/**
 * 明确区分"没测到"和"测了没过" —— 任务要求不许为了让输出好看而放宽断言，
 * 反过来也一样：**驱动不到**（比如按钮被面板遮罩挡住）不能算成功能坏了，但必须显式列出来。
 * SKIP 不计入 PASS/FAIL，只在末尾单独列一段。
 */
const skips = []
const skip = (name, why) => { skips.push({ name, why }); console.log(`SKIP  ${name} — ${why}`) }

const pageErrors = []      // pageerror：一条都不许有
const consoleErrors = []   // console.error 原文（下面要分类）
const badResponses = []    // status >= 400 的响应（带资源类型）
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => pageErrors.push(String(e.message || e)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('response', (res) => {
  if (res.status() < 400) return
  const req = res.request()
  badResponses.push({ url: res.url().replace(BASE, ''), status: res.status(), type: req.resourceType() || '(未知)' })
})

/**
 * ⑨ 的判据（2026-10-02 与上级对齐口径）
 *
 * 规则：
 *   · `pageerror` —— **一条都不许有**；
 *   · `console.error` —— 只有「`Failed to load resource` 且对应响应是 `image`」允许；
 *   · 其余一律 FAIL：尤其 `script` / `stylesheet` / `font` / `xhr` / `fetch` 的失败，
 *     以及任何**非资源类**的 JS 报错（例如真机那个 `ReferenceError: onBeforeUnmount is not defined`
 *     —— 它让整个面板挂不出来，必须照旧红）。
 *
 * **为什么允许图片 404**：用户库里有 **606 条死图引用**（`/images/**`，清一色 `ComfyUI_temp_*`，
 * 文件真的没了）。前端已经做了坏图兜底（`web-ui/src/imageFallback.js`：缺图不再显示碎图、默认隐藏）
 * ⇒ **页面观感已经修好**；但浏览器仍会为那次 404 记一条 console error —— 兜底挡不住它，这是浏览器行为，
 * 不是产品缺陷。本仓 `e2e/check-assets.mjs` 同一口径：404 里不许出现 `.js/.css/.woff2`，图片 404 允许。
 *
 * **为什么按"资源类型"判、不猜文本**：`Failed to load resource` 的文本里**没有 URL**（Chromium 如此），
 * 字符串匹配分不清那是图片还是脚本 ⇒ 只能靠 `response` 事件记下的类型来对齐条数：
 *   允许的条数上限 = 图片类坏响应的条数；
 * 只要出现**任何非图片**的坏响应，或类型拿不到（按"不允许"处理，宁可红），就直接 FAIL。
 */
function evaluatePageErrors() {
  const RESOURCE_MSG = /Failed to load resource/i
  const resourceConsole = consoleErrors.filter((t) => RESOURCE_MSG.test(t))
  const otherConsole = consoleErrors.filter((t) => !RESOURCE_MSG.test(t))
  const imgBad = badResponses.filter((r) => r.type === 'image')
  const nonImageBad = badResponses.filter((r) => r.type !== 'image')   // '(未知)' 也会落在这里 ⇒ 宁可红
  const allowedImage = Math.min(resourceConsole.length, imgBad.length)
  const unmatchedResource = resourceConsole.length - allowedImage
  const ok = pageErrors.length === 0 && nonImageBad.length === 0 && otherConsole.length === 0 && unmatchedResource === 0
  const sample = (arr, n = 2) => arr.slice(0, n).join(' ; ')
  const parts = [
    `pageerror=${pageErrors.length}`,
    `产物类失败=${nonImageBad.length}${nonImageBad.length ? `（${sample(nonImageBad.map((r) => `${r.type} ${r.status} ${r.url}`))}）` : ''}`,
    `允许的图片 404×${allowedImage}`,
    `其它 console.error=${otherConsole.length}${otherConsole.length ? `（${sample(otherConsole.map((t) => t.slice(0, 60)))}）` : ''}`,
    `未匹配的资源失败=${unmatchedResource}`,
  ]
  if (pageErrors.length) parts.push(`pageerror 原文：${sample(pageErrors)}`)
  return { ok, detail: parts.join(' ｜ ') }
}

/** 角色级请求：玩具 / 推进 / 戴上等 —— 用来证明"作用在哪个成员身上" */
const roleReqs = []
page.on('request', (req) => {
  const u = req.url().replace(BASE, '')
  if (/\/api\/characters\/\d+\/toys/.test(u) || /\/api\/intimate-actions\/\d+/.test(u)) {
    roleReqs.push(`${req.method()} ${u}`)
  }
})
/** 从 URL 里抠角色 id（两种路径都覆盖） */
const idOf = (u) => {
  const m = /\/api\/(?:characters|intimate-actions)\/(\d+)/.exec(u)
  return m ? Number(m[1]) : null
}

async function dismissOverlays(p) {
  for (let i = 0; i < 3; i++) {
    if (await p.locator('.linshe-modal-overlay, .modal-overlay').count() === 0) return
    const closers = p.locator('.linshe-modal-close, [aria-label="关闭"], button:has-text("知道了"), button:has-text("关闭"), button:has-text("以后再说"), button:has-text("取消")')
    if (await closers.count() > 0) await closers.first().click({ timeout: 2000 }).catch(() => {})
    else await p.keyboard.press('Escape').catch(() => {})
    await p.waitForTimeout(600)
  }
}
async function topElementAt(p, loc) {
  const box = await loc.first().boundingBox().catch(() => null)
  if (!box) return '(取不到 boundingBox)'
  return await p.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return el ? `${el.tagName}.${String(el.className || '').slice(0, 60)}` : 'null'
  }, [box.x + box.width / 2, box.y + box.height / 2]).catch(() => '(evaluate 失败)')
}
const toyOpen = (p) => p.locator('.modal-panel.linshe-modal, .toy-panel, .tp-panel').count()
const iaOpen = (p) => p.locator('.ia-panel[aria-label="性爱推进"]').count()
const toastAll = async (p) => (await p.locator('.live-toast-message').allInnerTexts().catch(() => [])).join(' | ')

try {
  // ── 群 id + 成员表（成员表用来核对"请求里的 id 是不是我点的那个人"）──
  let groupId = null
  let members = []
  const groupsResp = await page.request.get(`${BASE}/api/groups`).catch(() => null)
  if (groupsResp?.ok()) {
    const body = await groupsResp.json().catch(() => null)
    const list = Array.isArray(body) ? body : (body?.groups || body?.data || [])
    groupId = list?.[0]?.id ?? null
    members = list?.[0]?.members || []
  }
  record('⓪ 拿到群与成员表', groupId != null, `groupId=${groupId ?? '(无)'} members=${members.length}`)
  if (groupId == null) throw new Error('没有群可测：/api/groups 没返回群列表')

  // ── ① 群聊视图 ──
  await page.goto(`${BASE}/#/group/${groupId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2800)
  await dismissOverlays(page)
  const msgList = await page.locator('.msg-list-inner').count()
  const wrap = await page.locator('.touch-group-wrap').count()
  record('① 群聊视图打开', msgList > 0 && wrap > 0, `msg-list-inner=${msgList} touch-group-wrap=${wrap}`)

  // ── ② 三个入口 ──
  const hand = page.locator('div.touch-icon-btn[aria-label="动作"]')
  const toyBtn = page.locator('div.touch-icon-btn.toy-icon-btn[aria-label="玩具"]')
  const iaBtn = page.locator('div.touch-icon-btn.intimate-icon-btn[aria-label="推进"]')
  const toyTitle0 = await toyBtn.first().getAttribute('title').catch(() => '')
  record('② ✋ / 🧸 / ❤ 三个入口都在', (await hand.count()) > 0 && (await toyBtn.count()) > 0 && (await iaBtn.count()) > 0,
    `hand=${await hand.count()} toy=${await toyBtn.count()} ia=${await iaBtn.count()}`)
  record('② 未选目标时 🧸 的 title 是「先选一个人」', /先选一个人/.test(toyTitle0 || ''), `title=「${toyTitle0}」`)

  // ── ③ 未选目标：点 🧸 不许打开面板，要有那句人话 ──
  const topBefore = await topElementAt(page, toyBtn)
  await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1200)
  record('③ 未选目标点 🧸 不打开面板', (await toyOpen(page)) === 0, `面板节点=${await toyOpen(page)}｜点击点最上层=${topBefore}`)
  const hint = await toastAll(page)
  record('③ 给了那句人话提示', hint.includes(NO_TARGET_HINT), `toast=「${hint || '(无)'}」`)
  record('③ 也**没有**偷偷默认成员 0', !(await page.locator('.modal-panel.linshe-modal').count()), '面板节点应为 0（没有回落到 members[0]）')

  // ── ④ 选人：✋ → 「对 谁？」 → 点第一个成员 ──
  let pickedName = ''
  let pickedId = null
  await hand.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1500)
  // 换人按钮靠 title 定位最稳（TouchActionPanel.vue 第 33 行）：
  //   有目标时 title=「更换动作对象」、没目标时「选择动作对象」、按钮文字是「对 XXX」/「对 谁？」
  const pickBtn = page.locator('[title="选择动作对象"], [title="更换动作对象"]').first()
  if (await pickBtn.count() > 0) { await pickBtn.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
  const listOk = (await page.locator('#touch-target-list').count()) > 0
  record('④ 「对谁」成员面板出现', listOk, `#touch-target-list=${await page.locator('#touch-target-list').count()}`)
  if (listOk) {
    const item = page.locator('#touch-target-list .mention-item').first()
    pickedName = (await item.innerText().catch(() => '')).trim().replace(/\s+/g, ' ')
    await item.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const title = await toyBtn.first().getAttribute('title').catch(() => '')
    pickedId = members.find((m) => String(m.display_name || '').trim() === pickedName)?.id ?? null
    record('④ 选中成员（title 变成「对 XXX」）', /对\s*\S/.test(title || ''), `点「${pickedName}」⇒ title=「${title}」｜成员表里它的 id=${pickedId ?? '(没匹配上)'}`)
  }

  // ── ⑤ 选中后点 🧸：打开 + 作用在那个人 + 「戴上」接线 ──
  if (pickedId != null) {
    roleReqs.length = 0
    await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(2200)
    const opened = await toyOpen(page)
    record('⑤ 选中后 🧸 面板打开', opened > 0, `面板节点=${opened}｜点击点最上层=${await topElementAt(page, toyBtn)}`)
    const reqIds = [...new Set(roleReqs.map(idOf).filter(Boolean))]
    record('⑤ 面板请求的是**我点的那个人**', reqIds.length === 0 || reqIds.every((i) => i === pickedId),
      `请求=${roleReqs.slice(0, 3).join(' , ') || '(没抓到请求)'}｜期望 id=${pickedId}｜实际=${reqIds.join(',') || '-'}`)
    record('⑤ 入口高亮 .is-open', /is-open/.test((await toyBtn.first().getAttribute('class')) || ''), `class=${await toyBtn.first().getAttribute('class')}`)

    // 「戴上」是 emit 给父组件做的（功能 Agent 自己没在浏览器里点过）—— 真点一次。
    // ⚠️ 两条收紧：
    //   1) 只看"有没有 POST 到 toys"会被面板自己的 `POST /toys/tick` 轮询骗过去（我第一版就是这样误判成 PASS）；
    //      现在必须见到 `…/<toyKey>/equip` 或那句「已给她戴上」的 toast。
    //   2) **门控没过的按钮点了也不会发请求**（ToyPanel.vue 132 行把 `gate.allowed === false` 写成 aria-disabled）
    //      ⇒ 必须挑"既没 disabled、也没 aria-disabled=true"的那个（例如项圈对 Lv3 就放行）。
    //      挑不到就如实说"全是门控拦着的"，不要算成接线断了。
    roleReqs.length = 0
    const anyBtn = page.locator('.toy-backpack-grid button')
    const equipBtn = page.locator('.toy-backpack-grid button:not([disabled]):not([aria-disabled="true"])').first()
    const equipCount = await equipBtn.count()
    if (equipCount > 0) {
      const equipLabel = (await equipBtn.innerText().catch(() => '')).trim().replace(/\s+/g, ' ')
      await equipBtn.click({ timeout: 4000 }).catch(() => {})
      await page.waitForTimeout(2500)
      const t = await toastAll(page)
      const equipReq = roleReqs.find((u) => /\/toys\/[^/]+\/equip/.test(u))
      record('⑤ 群里点「戴上」真的接上了（emit→父组件→接口）', Boolean(equipReq) || /已给她戴上|已经戴上了/.test(t),
        `点了「${equipLabel}」｜equip 请求=${equipReq || '(没抓到)'}｜其它 toys 请求=${roleReqs.filter((u) => !/equip/.test(u)).slice(0, 2).join(' , ') || '-'}｜toast=「${t || '(无)'}」`)
    } else {
      const total = await anyBtn.count()
      const reasons = (await page.locator('.toy-backpack-grid button').evaluateAll((els) => els.map((e) => e.getAttribute('title') || '').filter(Boolean))).slice(0, 3).join(' ; ')
      record('⑤ 群里点「戴上」真的接上了（emit→父组件→接口）', false,
        total === 0 ? '玩具背包里一个按钮都没有（选择器 .toy-backpack-grid button 落空 ⇒ 面板结构可能变了）'
          : `背包 ${total} 个按钮全部处于门控/已戴上状态，点哪个都不会发请求 ⇒ 这条**测不了**（门控文案：${reasons || '(无 title)'}）`)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator('[aria-label="关闭"]').first().click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(800)
  } else {
    record('⑤ 选中后 🧸 面板打开', false, '上一步没拿到成员 id ⇒ 没往下跑')
  }

  // ── ⑥ ❤ 三步 ──
  roleReqs.length = 0
  await iaBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(2200)
  const iaCount = await iaOpen(page)
  record('⑥ 选中后 ❤ 面板打开', iaCount > 0, `ia-panel=${iaCount} chip=${await page.locator('.ia-chip').count()}｜点击点最上层=${await topElementAt(page, iaBtn)}`)
  const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000)
  record('⑥ 面板文案含推进动作', /继续抽插|加速抽插|换姿势|进入她/.test(bodyText), bodyText.match(/继续抽插|加速抽插|换姿势|进入她/)?.[0] || '(未命中)')
  const iaIds = [...new Set(roleReqs.map(idOf).filter(Boolean))]
  record('⑥ 推进面板请求的是**我点的那个人**', iaIds.length === 0 || iaIds.every((i) => i === pickedId),
    `请求=${roleReqs.slice(0, 3).join(' , ') || '(没抓到)'}｜期望 id=${pickedId}｜实际=${iaIds.join(',') || '-'}`)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(700)

  // ── ⑦ 换目标 ⇒ 两个面板自动关掉 ──
  //    ⚠️ 这条**结构上就不好驱动**：要让"面板开着"才能验自动关，而面板一开，
  //    它自己的 LinsheModal 遮罩就压在下面那排图标上 ⇒ 点不到 ✋ / 换人按钮（Playwright 会一直重试到超时）。
  //    所以先探一下"✋ 的点击点最上层是谁"：被遮罩挡住就如实 SKIP，不硬算成功能坏了。
  if (await toyOpen(page) > 0) { await toyBtn.first().click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
  await toyBtn.first().click({ timeout: 4000 }).catch(() => {})
  await page.waitForTimeout(1500)
  const openedBefore = await toyOpen(page)
  const handTop = await topElementAt(page, hand)
  if (!/DIV\.touch-icon-btn|DIV\.input-area|BUTTON/.test(String(handTop))) {
    skip('⑦ 换目标后面板自动关掉', `玩具面板开着时 ✋ 被挡住（点击点最上层=${handTop}）⇒ 这条在本脚本里驱动不到；`
      + '该行为属"视图里的 watch(touchTargetId)"，纯函数单测覆盖不到，建议后面用组件测试或人工点一次')
  } else {
    await hand.first().click({ timeout: 4000 }).catch(() => {})
    await page.waitForTimeout(1200)
    // 换人按钮的 title 会随"有没有目标"变（选择动作对象 / 更换动作对象）⇒ 两个都匹配。
    const pick2 = page.locator('[title="选择动作对象"], [title="更换动作对象"]').first()
    if (await pick2.count() > 0) { await pick2.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(900) }
    const items = page.locator('#touch-target-list .mention-item')
    const itemCount = await items.count()
    if (itemCount > 1) {
      await items.nth(1).click({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(1400)
      const after = await toyOpen(page)
      const title = await toyBtn.first().getAttribute('title').catch(() => '')
      record('⑦ 换目标后面板自动关掉', openedBefore > 0 && after === 0, `换人前=${openedBefore} 换人后=${after}｜换后 title=「${title}」`)
    } else {
      skip('⑦ 换目标后面板自动关掉', `目标列表里只有 ${itemCount} 个成员 ⇒ 换不了人（换人按钮 count=${await pick2.count()}）`)
    }
  }

  // ── ⑧ 原有东西还在 ──
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(600)
  record('⑧ 动作快捷条与消息流仍在', (await page.locator('.touch-group-wrap').count()) > 0 && (await page.locator('.msg-list-inner').count()) > 0,
    `touch-group-wrap=${await page.locator('.touch-group-wrap').count()} msg-list-inner=${await page.locator('.msg-list-inner').count()}`)
} catch (err) {
  record('脚本异常', false, String(err?.message || err))
} finally {
  // ⑨ 见 evaluatePageErrors 的注释：图片 404 允许（606 条死引用 + 已做坏图兜底 + 与 check-assets 同口径），
  //    产物类失败与任何非资源类 JS 报错一律红。
  const errEval = evaluatePageErrors()
  record('⑨ 页面无 JS 报错（图片 404 例外）', errEval.ok, errEval.detail)
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}${skips.length ? `，SKIP ${skips.length}` : ''}`)
if (skips.length) console.log('未测到（不是"通过"）：\n  - ' + skips.map((s) => s.name + '：' + s.why).join('\n  - '))
if (failed.length) console.log('失败项：\n  - ' + failed.map((f) => f.name + (f.detail ? `（${f.detail}）` : '')).join('\n  - '))
process.exit(failed.length === 0 ? 0 : 1)
