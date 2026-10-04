/**
 * 「一键生成素材」弹窗 + 入口的回归（2026-10-01，用户原话「弄个按钮一键后台生成得了」）
 *
 * ## 用户痛点
 * 「这个表情包和立绘还得一个个去点开然后硬控好久」——立绘是同步阻塞接口、表情包的"全部生成"
 * 是前端 while 循环（关窗即停）。所以这个功能的**验收点**不是"能不能点"，而是：
 * ① 关窗之后任务还在跑；② 重开能看到进度；③ 不用一个个开角色。
 *
 * ## 本文件钉住什么
 * 1. 入口在角色页（与"表情包管理"同款卡片），弹窗全走 Linshe 组件（AGENTS.md 硬纪律）。
 * 2. **任务生命周期不绑组件**：`onBeforeUnmount` 只停轮询、**不发取消**；重开时读 `?active=1` 恢复进度。
 * 3. 进度双通道：SSE `asset_generation_progress` + 2.5s 轮询兜底，两者都在。
 * 4. 计划由后端展开：前端只传 character_ids / kinds / skipExisting（不许自己算张数）。
 * 5. 0.3 秒过渡：配置态 ↔ 运行态交叉淡入，进度条宽度过渡 0.3s。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('../src/components/AssetGenerationModal.vue', import.meta.url), 'utf8')
const tavern = readFileSync(new URL('../src/views/TavernView.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')

const tpl = modal.slice(modal.indexOf('<template>'), modal.indexOf('</template>'))
const script = modal.slice(modal.indexOf('<script setup>'), modal.indexOf('</script>'))

test('① 入口：角色页有一张"一键生成素材"卡片，点开弹窗', () => {
  assert.match(tavern, /一键生成素材/, '卡片文案要在')
  assert.match(tavern, /@click="showAssetGen = true"/, '点击要打开弹窗')
  assert.match(tavern, /<AssetGenerationModal v-if="showAssetGen"/, '弹窗要挂上')
  assert.match(tavern, /import AssetGenerationModal from '\.\.\/components\/AssetGenerationModal\.vue'/, '要 import')
  assert.match(tavern, /const showAssetGen = ref\(false\)/, '要有开关状态')
})

test('② 全走 Linshe 组件（不许裸 button/select/checkbox）', () => {
  for (const tag of ['linshe-modal', 'linshe-button', 'linshe-switch']) {
    assert.ok(tpl.includes(`<${tag}`), `要用 ${tag}`)
  }
  assert.equal(/<button[\s>]/.test(tpl), false, '不许裸 <button>')
  assert.equal(/<input[\s>]/.test(tpl), false, '不许裸 <input>')
  assert.equal(/<select[\s>]/.test(tpl), false, '不许裸 <select>')
  // LinsheModal 的 full 是布尔 prop（不是 size="full"）
  assert.match(tpl, /<linshe-modal[^>]*\bfull\b/, 'full 要当布尔 prop 用')
  assert.equal(/size="full"/.test(tpl), false, 'size="full" 是错的写法')
})

test('③ 关窗不等于取消；重开能恢复进度（这两条是这个功能的成败点）', () => {
  assert.match(script, /function onRequestClose\(\)[\s\S]{0,120}stopPolling\(\)/, '关窗只停轮询')
  assert.equal(/onControl\('cancel'\)/.test(script.slice(script.indexOf('function onRequestClose'))), false,
    '关窗路径里绝不能顺手取消任务')
  assert.match(script, /onBeforeUnmount\(\(\) => \{[\s\S]{0,200}stopPolling\(\)/, '卸载只停轮询')
  assert.match(script, /listAssetGenerationJobs\(\{ active: true \}\)/, '重开要读活跃任务恢复进度')
  assert.match(api, /listAssetGenerationJobs[\s\S]{0,120}active=1/, 'api 要带 ?active=1')
})

test('④ 进度双通道 + 0.3 秒过渡', () => {
  assert.match(script, /onEvent\('asset_generation_progress'/, 'SSE 为主')
  assert.match(script, /setInterval\(refresh, 2500\)/, '轮询兜底（与 ExpressionStandingManager 同节奏）')
  assert.match(modal, /\.ag-bar-fill[\s\S]{0,220}transition: width 0\.3s/, '进度条 0.3s 过渡')
  assert.match(modal, /\.ag-fade-enter-active[^{]*\{[^}]*transition: opacity 0\.3s/, '配置/运行态切换 0.3s')
  assert.match(tpl, /<Transition name="ag-fade" mode="out-in">/, '用 mode="out-in" 避免两态同屏')
})

test('⑤ 计划交给后端：前端只传 character_ids / kinds / skipExisting', () => {
  assert.match(script, /createAssetGenerationJob\(\{[\s\S]{0,200}character_ids: chosenIds\.value[\s\S]{0,120}kinds: chosenKinds\.value[\s\S]{0,120}skipExisting: skipExisting\.value/, '请求体三个字段')
  assert.equal(/total\s*=\s*chosenIds\.value\.length/.test(script), false, '前端不许自己算张数（计划由后端展开）')
  assert.match(api, /createAssetGenerationJob = body => request\('\/asset-generation\/jobs'/, 'api 路径要接后端路由')
  // 失败明细要能看到（真机上"虚假成功"是踩过的坑）
  assert.match(tpl, /job\.failures/, '失败清单要显示')
  assert.match(script, /const STATUS_TEXT/, '状态要有中文文案')
})

process.on('exit', () => {})
