/**
 * Vue 生命周期/组合式 API 的 import 守卫（2026-10-02，真机事故回归）
 *
 * 真事：`IntimateActionPanel.vue` 里用了 `onBeforeUnmount(...)` 清理自动抽插的计时器，
 * 但顶部 `import { computed, inject, ref, watch } from 'vue'` **漏了 onBeforeUnmount**。
 * 后果不是"清理没生效"，而是**组件 setup 阶段直接 ReferenceError** ⇒ 整个面板挂不出来
 * ⇒ 用户看到的就是「性爱系统的按钮直接点不出来」（点 ❤ 毫无反应，页面上却"看起来没报错"）。
 *
 * 为什么既有测试全绿：源码守卫只检查"模板里调用的处理函数存在"，而这是在 `<script setup>` 里
 * 调用一个**没 import 的组合式 API** —— 只有真跑起来才会炸。浏览器探针抓到的报错原文：
 *     ReferenceError: onBeforeUnmount is not defined
 *         at setup (…/assets/index-*.js)
 *
 * 所以：扫全部 `.vue`，**凡在 `<script setup>` 里被当函数调用、却没从 vue import 的 API，一律红**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

/** 需要从 'vue' 引入的组合式 API（用到就必须 import；漏了就是 setup 期 ReferenceError） */
const VUE_APIS = [
  'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'nextTick', 'inject', 'provide',
  'onMounted', 'onBeforeMount', 'onUnmounted', 'onBeforeUnmount', 'onActivated', 'onDeactivated',
  'onUpdated', 'onBeforeUpdate', 'onErrorCaptured', 'toRef', 'toRefs', 'shallowRef', 'markRaw',
  'defineAsyncComponent', 'useSlots', 'useAttrs', 'h', 'getCurrentInstance',
]

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return walk(p)
  return e.name.endsWith('.vue') ? [p] : []
})

/** 去掉注释，避免把说明文字里的调用当代码 */
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')

test('全仓 .vue：`<script setup>` 里用到的组合式 API 必须从 vue import（漏一个就整页白）', () => {
  const problems = []
  for (const file of walk(SRC)) {
    const raw = fs.readFileSync(file, 'utf8')
    const m = /<script setup>([\s\S]*?)<\/script>/.exec(raw)
    if (!m) continue
    const code = stripComments(m[1])
    const imported = new Set()
    for (const im of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g)) {
      for (const part of im[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (name) imported.add(name)
      }
    }
    if (imported.size === 0) continue   // 该文件根本没引 vue（纯模板组件）⇒ 交给别的规则
    for (const api of VUE_APIS) {
      if (imported.has(api)) continue
      // 当成函数调用：前面不是 . 或字母（排除 obj.api( )，且要求行首非注释
      const used = new RegExp(`(^|[^.\\w$])${api}\\s*\\(`, 'm').test(code)
      if (used) {
        problems.push(`${path.relative(SRC, file)}：用了 ${api}( ) 但没从 vue import ⇒ setup 阶段会 ReferenceError（组件挂不出来）`)
      }
    }
  }
  assert.equal(problems.length, 0, problems.join('\n  '))
})

test('定点回归：IntimateActionPanel 必须 import onBeforeUnmount（这次真机事故）', () => {
  const code = fs.readFileSync(path.join(SRC, 'components', 'IntimateActionPanel.vue'), 'utf8')
  assert.match(code, /import\s*\{[^}]*\bonBeforeUnmount\b[^}]*\}\s*from\s*['"]vue['"]/,
    'IntimateActionPanel 里有 onBeforeUnmount( ) 的清理逻辑，必须 import（否则面板整块挂不出来）')
  assert.match(code, /onBeforeUnmount\s*\(/, '清理逻辑本身要留着（自动抽插的计时器必须随组件卸载清掉）')
})
