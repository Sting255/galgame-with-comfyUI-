/**
 * 催眠面板的「命令她用玩具」（force_toy）UI 回归（2026-10-01）
 *
 * ## 用户原话
 * 「催眠状态也不能强制让角色用上玩具」，一天后又报「催眠玩具不能点击」。
 *
 * ## ⚠️ 这里曾经钉错了东西（重要教训）
 * 第一版这条断言写的是 `:disabled="!matrix.body_control…"` —— 而 `actionMatrix()` 的键是
 * `hypnotize/wake/wakeMind/forcedClimax/forget`，**根本没有 body_control** ⇒ `!undefined === true`
 * ⇒ 按钮永远置灰、真机上点不动。测试当时"通过"了，因为它钉的是**实现写法**而不是**行为**。
 * 现在改成结构性守卫：面板里引用的每个 `matrix.X` 都必须是矩阵真的产出的键。
 *
 * ## 本文件钉住什么
 * 1. **入口真的在**：选玩具 + 选强度 + 按钮，全部走 Linshe 组件（禁止裸控件）。
 * 2. **可点性只看矩阵真有的键**（`matrix.forceToy`），且"在催眠中即可"。
 * 3. **请求形状对**：`commandCharacter(id, 'force_toy', { toyKey, intensity })`。
 * 4. **清单来自服务端**：走 `fetchToys`；换玩具时强度夹进该玩具上限。
 * 5. **指令文案**：编码值 `force_toy|vibe_egg|4` 显示成中文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panel = readFileSync(new URL('../src/components/HypnosisPhonePanel.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api/hypnosis.js', import.meta.url), 'utf8')
const { directiveText, actionMatrix } = await import('../src/components/hypnosisLogic.js')

const tpl = panel.slice(panel.indexOf('<template>'), panel.indexOf('</template>'))
const script = panel.slice(panel.indexOf('<script setup>'), panel.indexOf('</script>'))
// ⚠️ 扫源码前必须先剥注释：这次修 bug 时把 `matrix.body_control` 写进了注释里解释历史，
// 结果守卫被自己的注释绊倒（第二次踩同一个坑，另一次是 `new Date()`）。
const tplCode = tpl.replace(/<!--[\s\S]*?-->/g, '')
const scriptCode = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

test('入口：面板里有"命令她用玩具"这一块，且用 Linshe 组件（无裸控件）', () => {
  assert.match(tpl, /命令她用玩具/, '要有这一节')
  assert.match(tpl, /<linshe-select/, '选玩具/选强度要用 LinsheSelect')
  assert.match(tpl, /<linshe-button[\s\S]{0,400}命令她戴上/, '要有"命令她戴上"按钮')
  assert.match(tpl, /v-if="toysView\.visible"/, '玩具开关关着时不显示这一节')
  assert.equal(/<button[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <button>')
  assert.equal(/<select[\s>]/.test(tplCode), false, 'AGENTS.md：不许裸 <select>')
})

test('★ 可点性用矩阵真有的键（真机 bug：matrix.body_control 不存在 ⇒ 永远置灰）', () => {
  assert.match(tplCode, /:disabled="!matrix\.forceToy[^"]*"/, '按钮要随 matrix.forceToy 置灰')
  assert.equal(/matrix\.body_control/.test(tplCode), false, '不许再用矩阵里不存在的键')
})

test('★ 结构性守卫：面板引用的每个 matrix.X 都必须是 actionMatrix 产出的键', () => {
  // 用一份"什么都能点"的视图跑一遍，拿到矩阵的真实键集合
  const keys = Object.keys(actionMatrix({
    gate: { allowed: true },
    hypnotized: true, active: true, mindAwake: false,
  }, new Date()))
  assert.ok(keys.length >= 5, `矩阵应至少 5 个键，实际 ${keys.join(',')}`)
  assert.ok(keys.includes('forceToy'), `矩阵要产出 forceToy，实际 ${keys.join(',')}`)

  const referenced = [...tplCode.matchAll(/matrix\.([A-Za-z_$][\w$]*)/g)].map(m => m[1])
  assert.ok(referenced.length > 0, '面板应当引用矩阵键')
  const unknown = [...new Set(referenced)].filter(k => !keys.includes(k))
  assert.deepEqual(unknown, [], `面板引用了矩阵里不存在的键（会永远置灰）：${unknown.join(',')}；矩阵实际键：${keys.join(',')}`)
})

test('请求形状：commandCharacter(id, "force_toy", { toyKey, intensity })', () => {
  assert.match(script, /commandCharacter\(id, 'force_toy', \{ toyKey: toyKey\.value, intensity:/,
    '少传 extra 会被后端当成未知玩具 400')
  assert.match(api, /export function commandCharacter\(characterId, kind, extra = \{\}\)/, 'api 层要收 extra')
  assert.match(api, /body: \{ kind, \.\.\.extra \}/, 'extra 要展开进 body')
})

test('清单来自服务端 + 换玩具时强度夹上限', () => {
  assert.match(script, /fetchToys\(id\)/, '要读服务端清单（服务端 gate 说了算）')
  assert.match(script, /toysState\.value = \{ unlocked: res\?\.unlocked === true, available \}/, '要认 unlocked')
  assert.match(script, /watch\(toyKey,[\s\S]{0,200}maxIntensityOf\(toyKey\.value\)/, '换玩具要夹强度')
  assert.match(script, /if \(ok\) await loadToys\(\)/, '戴上是真落库，成功要刷回清单')
})

test('directiveText：编码值显示成中文，未知值仍原样返回（不吞）', () => {
  assert.equal(directiveText('force_toy|vibe_egg|4'), '强制用玩具：跳蛋 强度 4')
  assert.equal(directiveText('force_toy'), '强制用玩具')
  assert.equal(directiveText('body_control'), '身体控制')
  assert.equal(directiveText('something_new'), 'something_new')
  assert.equal(directiveText(''), '')
  assert.equal(directiveText('force_toy|gone|2'), '强制用玩具：gone 强度 2', '玩具表里没有也要给出可读文案')
})

test('0.3 秒过渡：新块用既有 hp-fade（不引入新节奏）', () => {
  assert.match(tpl, /<Transition name="hp-fade">[\s\S]{0,120}hp-sec-toys/, '新块要用既有 hp-fade')
  assert.match(panel, /\.hp-fade-enter-active[^{]*\{[^}]*transition: opacity 0\.3s/, '过渡时长 0.3s')
})
