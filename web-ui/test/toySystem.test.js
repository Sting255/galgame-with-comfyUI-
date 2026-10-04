/**
 * 第 2 批 · 玩具系统前端（专题 §2.8 + §2.9-7）
 *
 * 用户已拍板：① 获取方式 = **设置页一次性解锁开关**（同 touchGroupAdult 先例）；② 首批 5 种、**项圈不给强度档**。
 * 后端现状：`services/toyService.js` 已落地（5 种定义，权威口径）；`routes/toys.js` **尚未落地**
 * ⇒ 前端按 §二 的字段名先写并标注，最终形状不同再对。
 * 门控口径：**服务端说了算，前端只渲染**（不许自己算 allowed）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse as parseSfc, compileTemplate } from '@vue/compiler-sfc'

import { TOYS, TOY_KEYS, getToy, maxIntensityOf, clampIntensity, intensityLabel, hasIntensity } from '../src/components/toyLogic.js'

const api = readFileSync(new URL('../src/api/index.js', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/views/SettingsView.vue', import.meta.url), 'utf8')
const sDesc = parseSfc(settings).descriptor
const sTpl = sDesc.template.content
const sScript = sDesc.scriptSetup.content
const panelRaw = readFileSync(new URL('../src/components/TouchActionPanel.vue', import.meta.url), 'utf8')
const pDesc = parseSfc(panelRaw).descriptor
const pTpl = pDesc.template.content
const pScript = pDesc.scriptSetup.content

test('玩具镜像与后端 toyService.js 一致：5 种、key/label/最大强度都对得上', () => {
  assert.deepEqual(TOY_KEYS, ['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar'])
  const expect = {
    vibe_egg: ['跳蛋', 5],
    vibe_stick: ['振动棒', 5],
    anal_plug: ['肛塞', 3],
    nipple_clamp: ['乳夹', 3],
    collar: ['项圈', 0],
  }
  for (const [k, [label, max]] of Object.entries(expect)) {
    assert.equal(TOYS[k].label, label, k + ' 名称')
    assert.equal(TOYS[k].maxIntensity, max, k + ' 最大强度')
  }
  assert.equal(maxIntensityOf('vibe_egg'), 5)
  assert.equal(maxIntensityOf('nope'), 0, '不认识的玩具 → 0（不炸）')
})

test('项圈不给强度档（用户拍板）：hasIntensity=false，clamp 恒为 0', () => {
  assert.equal(hasIntensity('collar'), false, '项圈没有强度档')
  assert.equal(hasIntensity('vibe_egg'), true)
  assert.equal(clampIntensity('collar', 3), 0, '项圈强度恒 0')
  assert.equal(clampIntensity('vibe_egg', 99), 5, '向上夹到最大')
  assert.equal(clampIntensity('vibe_egg', -1), 0, '向下夹到 0')
  assert.equal(clampIntensity('vibe_egg', 2.6), 3, '四舍五入到整数档')
  assert.equal(clampIntensity('nope', 3), 0, '不认识的 → 0')
})

test('强度展示：0~max 的档位点，项圈显示「无档位」', () => {
  assert.equal(intensityLabel('vibe_egg', 3), '3/5')
  assert.equal(intensityLabel('anal_plug', 9), '3/3', '越界先夹')
  assert.equal(intensityLabel('collar', 0), '无档位')
})

test('API：四个端点按 §2.9-2 的路径写（🔌 routes/toys.js 未落地，形状待对）', () => {
  assert.ok(/export function fetchToys\s*\(/.test(api), 'GET 清单+状态')
  assert.ok(api.includes("/toys'"), '走 /toys（第一版正则里带反引号，永远匹配不上——是我写错了）')
  assert.ok(/export function equipToy\s*\(/.test(api))
  // 2026-10-01：URL 拼接里的 `encodeURIComponent(toyKey)` 收进了共用闸门 `requireToyKey(toyKey)`
  // （真机出现过 `/toys/undefined/equip`），路径本身没变 —— 断言改成「路径 + 走闸门」两条。
  // 真正「拼出来的 URL 对不对」由 test/toyKeyGuard.test.js 的**行为级**用例钉住（换掉 fetch 看实参）。
  assert.ok(api.includes("/toys/' + requireToyKey(toyKey) + '/equip'"), 'POST …/:toyKey/equip（key 过闸门）')
  assert.ok(/function requireToyKey\(toyKey\)/.test(api), '必须有 key 闸门')
  assert.ok(/toy_key_missing/.test(api), '缺 key 时要抛可识别的人话错误')
  assert.ok(/\/set-intensity/.test(api), 'POST …/set-intensity')
  assert.ok(/\/remove/.test(api), 'POST …/remove')
})

test('设置页：一次性解锁开关 features.toys（默认关 + 一行说明）', () => {
  const compiled = compileTemplate({ source: sTpl, filename: 'SettingsView.vue', id: 's' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(sScript.includes('toys:'), 'features 里要有 toys')
  assert.ok(/toys:\s*(false|TOYS_DEFAULT)/.test(sScript), '默认关')
  assert.ok(sTpl.includes('features.toys'), '要有绑定')
  assert.ok(/saveFeatureWithToast|updateFeatureFlag/.test(sScript), '走通用 features 保存')
  assert.ok(sTpl.includes('解锁成人玩具'), '开关标题')
  assert.ok(sTpl.includes('默认关'), '说明要写清默认关')
  assert.ok(/默认关[^<]*<\/div>/.test(sTpl) || sTpl.includes('（默认关）'), '默认关写在说明里')
  const at = sTpl.indexOf('features.toys')
  const block = sTpl.slice(Math.max(0, at - 900), at + 100)
  assert.ok(/linshe-switch/i.test(block), '用 LinsheSwitch')
  // 直接量说明那一句本身（窗口行数不是「简短」的好代理 —— 第一版就是这么误判的）
  const before = sTpl.slice(0, at)
  const tdStart = before.lastIndexOf('<div class="td">')
  const desc = before.slice(tdStart, before.lastIndexOf('</div>') + 6)
  assert.ok(desc.length < 240, '说明要简短（实测 ' + desc.length + ' 字符）')
})

// 用户要求玩具要有独立模块后，玩具 UI 已搬到 components/ToyPanel.vue（详见 toyPanel.test.js）；
// 这两条改成对着新组件断言，动作面板只保留「不再有玩具区」那条（在 toyPanel.test.js 里钉）。
const toyD = parseSfc(readFileSync(new URL('../src/components/ToyPanel.vue', import.meta.url), 'utf8')).descriptor
const tTpl = toyD.template.content
const tScript = toyD.scriptSetup.content

test('玩具面板：门控只渲染服务端结论（前端不自算）', () => {
  const compiled = compileTemplate({ source: tTpl, filename: 'ToyPanel.vue', id: 'p' })
  assert.deepEqual(compiled.errors, [])
  assert.ok(tTpl.includes('toy-panel'), '要有玩具面板根类')
  assert.ok(/gate/.test(tTpl), '门控照服务端结论渲染')
  assert.equal(/affinity\s*[><]=?\s*\d/.test(tScript), false, '前端不许自己算门槛（服务端说了算）')
  assert.ok(tTpl.includes('linshe-button'), '按钮用 Linshe')
  assert.ok(tTpl.includes('linshe-modal'), '外壳用 LinsheModal')
})

test('玩具面板：已戴列表 / 强度 ± / 摘下 / 未戴时给背包入口', () => {
  assert.ok(/worn/i.test(tTpl), '渲染已戴列表')
  assert.ok(tScript.includes('bumpIntensity'), '强度 ± 入口')
  assert.ok(tScript.includes('unequipToy') || tScript.includes('removeToy'), '摘下入口')
  assert.ok(tTpl.includes('toy-worn-empty'), '未戴时给空态 + 背包入口')
  assert.ok(/TOYS|toyOptions|toyList/.test(tTpl + tScript), '可戴清单来自镜像/服务端')
})
