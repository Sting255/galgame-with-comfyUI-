/**
 * 前端"英文选项"回归守卫（2026-10-02，用户：「检查前端是不是还有英文选项」）
 *
 * 背景（真机踩过两次）：
 *   · 玩具面板一度显示 `clit_sucker · · 最多 5 档` —— 选项的 label 拿到了**键名**；
 *   · 新建的"振动模式"下拉第一版用 `m.key ?? m.value`，而镜像里的字段叫 `value` ⇒ **碰巧**对；
 *     哪天镜像加个 key 字段，就会静默显示成英文键名。
 *
 * 这个测试把口径钉死：**给用户看的选项标签必须是中文**（产品名与尺寸数字除外，见白名单）。
 * 它扫的是源码字面量，所以"新加一个英文选项"会当场红 —— 这正是我们要防的那类退化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

/** 白名单：本来就该是英文的（产品名 / 尺寸 / 单位 / 文件名 / 技术标识）
 *  —— 2026-10-02 全仓扫过一遍，剩下 18 处纯英文全在设置页，都是"必须保持英文"的技术名：
 *     采样器 Euler / DPM++ 2M / DDIM…（要和 ComfyUI 里的名字一致，翻译了反而对不上）、
 *     调度器 Native / Karras / Exponential / Polyexponential、
 *     供应商 DeepSeek、模型档案 turbo / base / base+turbo（都带中文 desc）。 */
const ALLOW = [
  /^ComfyUI$/i, /^NovelAI$/i, /^SDXL?$/i, /^PNG$/i, /^JPE?G$/i, /^WebP$/i, /^GIF$/i,
  /^\d+×\d+$/,                 // 512×512、832×1216
  /^\d+x\d+$/,                 // 1x1、2x1（内部值，同时不会展示）
  /^[A-Za-z0-9_.-]+\.(json|png|jpg|webp|safetensors|ckpt|pt|bin)$/i,   // 文件名
  // 采样器 / 调度器：**逐个列名**，不要写成"任意英文单词都放过"的宽正则 ——
  // 那样 pulse / sustain / clit_sucker 这类**键名泄漏**（本测试存在的唯一理由）就漏网了。
  /^(euler|euler ancestral|dpm 2|dpm 2 ancestral|dpm\+\+ 2m|dpm\+\+ 2m sde|dpm\+\+ 2s ancestral|dpm\+\+ sde|ddim|ddim v3)$/i,
  /^(native|karras|exponential|polyexponential|normal|simple|ddim_uniform|sgm_uniform|beta)$/i,
  /^(deepseek|openai|anthropic|google|moonshot|zhipu|qwen|ollama|custom)$/i,   // 供应商
  /^(turbo|base|base\+turbo)$/i,             // 画风模型档案（Anima_turbo / Anima_base）
]

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return walk(p)
  return /\.(vue|js)$/.test(e.name) ? [p] : []
})

const hasCjk = (s) => /[\u4e00-\u9fff]/.test(s)

test('① 源码里的选项标签：除白名单外必须是中文（不许把键名给用户看）', () => {
  const offenders = []
  for (const file of walk(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/label\s*:\s*'([^']{1,40})'/g)) {
        const v = m[1]
        if (hasCjk(v)) continue
        if (ALLOW.some((re) => re.test(v))) continue
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  label: '${v}'`)
      }
      for (const m of line.matchAll(/label\s*:\s*"([^"]{1,40})"/g)) {
        const v = m[1]
        if (hasCjk(v)) continue
        if (ALLOW.some((re) => re.test(v))) continue
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  label: "${v}"`)
      }
    })
  }
  assert.equal(offenders.length, 0, `有 ${offenders.length} 处选项标签是纯英文（用户会看到它的键名）：\n  ${offenders.join('\n  ')}`)
})

test('② 玩具模式 / 强度曲线两份表：每个条目都有中文 label（面板直接吃它）', async () => {
  const { VIBRATION_MODES, INTENSITY_CURVES } = await import('../src/components/toyLogic.js')
  for (const [name, list] of [['VIBRATION_MODES', VIBRATION_MODES], ['INTENSITY_CURVES', INTENSITY_CURVES]]) {
    assert.ok(list.length >= 2, `${name} 至少两种`)
    for (const item of list) {
      assert.ok(item.value, `${name} 的条目要有 value（面板按它取值）`)
      assert.ok(hasCjk(item.label || ''), `${name} 的 ${item.value} 缺中文 label ⇒ 面板会显示英文键名`)
    }
  }
})

test('②b 【真机 bug 回归】全部 11 件玩具的显示名都必须是中文（不许回落到键名）', async () => {
  // 用户截图：后 6 件显示成 `clit_sucker · · 最多 5 档` —— 根因是面板自己写的
  // `listAllToys().find(t => t.toyKey === key)`，而记录字段叫 `key` ⇒ 永远找不到。
  // 现在解析统一走 toyLabelOf，这条测试就是那次事故的回归钉。
  const { ALL_TOY_KEYS, ALL_TOYS, toyLabelOf, toyPartOf, listAllToys } = await import('../src/components/toyLogic.js')
  assert.ok(ALL_TOY_KEYS.length >= 11, `清单至少 11 件（两批合并），实际 ${ALL_TOY_KEYS.length}`)
  assert.equal(listAllToys().length, ALL_TOY_KEYS.length, 'listAllToys 要覆盖全部')
  for (const key of ALL_TOY_KEYS) {
    const label = toyLabelOf(key)
    assert.ok(hasCjk(label), `${key} 的显示名不是中文：「${label}」⇒ 用户会看到英文键名`)
    assert.notEqual(label, key, `${key} 回落到了键名`)
    assert.notEqual(label, '未知玩具', `${key} 没被解析出来`)
    assert.ok(hasCjk(toyPartOf(key)), `${key} 的部位不是中文：「${toyPartOf(key)}」`)
    assert.ok(ALL_TOYS[key]?.key === key, `${key} 的记录里 key 字段要和键一致（查表就靠它）`)
  }
  assert.equal(toyLabelOf('definitely_not_a_toy'), '未知玩具', '不认识的键要给中文兜底，不是把键名糊上去')
})

test('②c 面板不许再自己写"按 toyKey 字段找记录"的解析（那正是英文键名的来源）', () => {
  const raw = fs.readFileSync(path.join(SRC, 'components', 'ToyPanel.vue'), 'utf8')
  // 先剥注释再断言 —— 修复说明里会把旧写法原样写出来，不剥就会自己把自己判红
  const panel = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(panel, /find\(\s*t\s*=>\s*t\.toyKey\s*===/, '面板里不许再有按 t.toyKey 查表的写法（记录字段是 key）')
  assert.match(panel, /toyLabelOf\(/, '面板的显示名要走 toyLabelOf（唯一来源）')
})

test('③ 催眠手机的模式/曲线下拉：选项 label 全中文、且第一项是"不变"（空值＝不改）', () => {
  const file = path.join(SRC, 'components', 'HypnosisPhonePanel.vue')
  const src = fs.readFileSync(file, 'utf8')
  for (const [name, table] of [['toyModeOptions', 'VIBRATION_MODES'], ['toyCurveOptions', 'INTENSITY_CURVES']]) {
    const block = src.match(new RegExp(`${name}\\s*=\\s*computed\\(\\(\\)\\s*=>\\s*\\[[\\s\\S]{0,400}?\\]\\)`))
    assert.ok(block, `找不到 ${name} 的定义`)
    assert.match(block[0], /\{\s*label:\s*'[^']*不变[^']*',\s*value:\s*''\s*\}/, `${name} 第一项要是"不变"（空值＝不改）`)
    assert.match(block[0], new RegExp(table), `${name} 要复用 ${table}（别自己写一份）`)
    assert.match(block[0], /label:\s*[a-z]\.label\s*\|\|\s*[a-z]\.value/, `${name} 的 label 必须取 .label（镜像字段是 value/label，没有 key）`)
  }
})
