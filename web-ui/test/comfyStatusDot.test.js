/**
 * 出图服务状态灯（2026-10-01 · 规划 `规划-剩余修改项` §一-4）
 *
 * ## 为什么做
 * 用户的原话场景是「**ComfyUI关了**」，而当时的体验是：没开就开始玩，一路上每个要图的功能
 * （聊天配图、朋友圈、奇遇配图、一键生成）都失败，"图呢？"只能靠猜。
 * 第十一轮已在一键生成的开跑前加了 409 守卫，这条是把守卫**往前推一格**：
 * 让"没开"这件事一眼可见，从源头消掉一整类反馈。
 *
 * ## 本文件钉住什么
 * 1. 状态灯在**全局常驻**位置（`NavBar` 底部的 `.nav-bottom`），不是某个页面里的。
 * 2. 复用**既有**健康端点 `comfyuiHealth()`（`GET /api/images/comfyui-health`）——不新增端点、不重复实现探测。
 * 3. 30 秒轮询 + 卸载时清定时器（不能留下永远跑的 interval）。
 * 4. 提示文案要能**指导动作**（说清"没在跑会导致什么"+"怎么开"），不能只写"不在线"。
 * 5. 非交互元素用自包含样式（AGENTS.md 第 4 条），不要套按钮组件、也不写裸交互控件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const nav = readFileSync(new URL('../src/components/NavBar.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
const tpl = nav.slice(nav.indexOf('<template>'), nav.indexOf('</template>'))
const script = nav.slice(nav.indexOf('<script setup>'), nav.indexOf('</script>'))

test('① 位置：常驻在 NavBar 的底部区（不是某个页面里）', () => {
  const bottomAt = tpl.indexOf('class="nav-bottom"')
  const comfyAt = tpl.indexOf('class="nav-comfy"')
  assert.ok(bottomAt > 0 && comfyAt > bottomAt, '状态灯要落在 .nav-bottom 里')
  assert.match(tpl, /:class="comfy\.online \? 'is-online' : 'is-offline'"/, '要有在线/离线两种态')
  assert.match(tpl, /role="status"[\s\S]{0,80}aria-live="polite"/, '状态变化要让读屏能播报')
})

test('② 复用既有端点，不新增探测实现', () => {
  assert.match(script, /import \{ comfyuiHealth \} from '\.\.\/api\/index\.js'/, '要用既有 api 封装')
  assert.match(api, /export async function comfyuiHealth[\s\S]{0,160}\/images\/comfyui-health/, 'api 打的是既有端点')
  assert.match(api, /catch \{ return \{ connected: false \} \}/, '异常要吞成离线（页面不能因此报错）')
  // 后端那侧：既有端点已经在探 /system_stats
  const images = readFileSync(new URL('../../agent-core/src/routes/images.js', import.meta.url), 'utf8')
  assert.match(images, /router\.get\('\/comfyui-health'/, '后端既有端点要还在（别另起一个）')
  assert.match(images, /system_stats/, '探测走 /system_stats')
})

test('③ 轮询 30 秒 + 卸载清理（不许留常驻 interval）', () => {
  assert.match(script, /setInterval\(refreshComfyStatus, 30000\)/, '30 秒一次')
  assert.match(script, /onMounted\(\(\) => \{[\s\S]{0,600}startComfyPolling\(\)/, '挂载时开轮询')
  assert.match(script, /onUnmounted\(\(\) => \{[\s\S]{0,600}clearInterval\(comfyTimer\)/, '卸载必须清掉')
  assert.match(script, /refreshComfyStatus\(\)/, '启动时先立刻查一次（不等 30 秒）')
})

test('④ 文案要能指导动作（说清后果 + 怎么开），不能只说"不在线"', () => {
  assert.match(script, /ComfyUI）没在跑/, '要说清是 ComfyUI 没跑')
  assert.match(script, /都会失败/, '要说清后果（哪些功能会坏）')
  assert.match(script, /先把 ComfyUI 启动起来/, '要给出怎么做')
  assert.match(script, /这个灯会自己变绿/, '要告诉用户这里是自动刷新的，不用重启页面')
  assert.match(tpl, /出图在线|出图离线/, '标签要短到能塞进 75px 侧栏')
})

test('⑤ 非交互元素：自包含样式，不用按钮组件也不写裸控件', () => {
  assert.equal(/<button[\s>]/.test(tpl), false, '不许裸 <button>')
  assert.equal(/<linshe-button/.test(tpl), false, '这不是按钮，不该套 LinsheButton')
  assert.match(nav, /\.nav-comfy-dot \{[\s\S]{0,200}border-radius: 50%/, '小圆点用自包含样式')
  assert.match(nav, /transition: background 0\.3s/, '状态切换要有过渡（AGENTS.md：避免生硬跳变）')
  assert.match(nav, /rgba\(var\(--accent-rgb\)/, '发光用既有 token，不硬编码色值')
})

process.on('exit', () => {})
