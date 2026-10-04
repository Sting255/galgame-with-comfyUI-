/**
 * 玩具接口的 key 闸门（2026-10-01 真机 bug 的第二道防线）
 *
 * 真机日志出现过 `POST /api/characters/13/toys/undefined/equip` ——
 * `encodeURIComponent(undefined)` **不会报错**，它会安静地变成字符串 `"undefined"`，
 * 于是请求打到 `/toys/undefined/equip`、服务端只能回 404/400，
 * 用户看到的就是「玩具一点就报错」，而根因在前端某条路径拿不到 key，日志里完全看不出来。
 *
 * 这里做**行为级**验证（不是只读源码）：断言 `equipToy(13, undefined)` 在**发网络请求之前**
 * 就抛出人话错误。调用方 ChatView 三个 handler 都有 try/catch + toast，所以抛错是安全出口。
 *
 * 顺带钉住「前端镜像常量 vs 后端 config」的一致性（接手指南-2.md §548 记的已知漂移边界）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { equipToy, setToyIntensity, removeToy } = await import('../src/api/index.js')

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')

test('key 缺失时当场抛人话错误，绝不拼出 /toys/undefined/...', () => {
  for (const bad of [undefined, null, '', '   ', 'undefined', 'null']) {
    for (const [name, fn] of [['equipToy', equipToy], ['setToyIntensity', setToyIntensity], ['removeToy', removeToy]]) {
      assert.throws(
        () => (name === 'setToyIntensity' ? fn(13, bad, 3) : fn(13, bad)),
        err => {
          assert.equal(err.code, 'toy_key_missing', `${name}(${JSON.stringify(bad)}) 的错误码`)
          assert.match(err.message, /玩具标识缺失/, `${name}(${JSON.stringify(bad)}) 要给人话`)
          return true
        },
        `${name}(${JSON.stringify(bad)}) 必须抛错`,
      )
    }
  }
})

test('合法 key 照旧：正常拼 URL，不误伤（含需要转义/有空白的写法）', async () => {
  // 不真的发网络：把 fetch 换掉，只检查它拿到的 URL 与 body
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    await equipToy(13, 'vibe_egg')
    await equipToy(13, '  nipple_clamp  ', { intensity: 3 })
    await removeToy(13, 'collar')
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls.map(c => c.url), [
    '/api/characters/13/toys/vibe_egg/equip',
    '/api/characters/13/toys/nipple_clamp/equip',   // 两端空白被 trim 掉
    '/api/characters/13/toys/collar/remove',
  ])
  assert.equal(calls[0].body, JSON.stringify({ intensity: 1 }), '默认强度仍是 1')
  assert.equal(calls[1].body, JSON.stringify({ intensity: 3 }))
  assert.equal(calls[2].body, JSON.stringify({}), 'remove 的 body 仍是空对象（不是 undefined）')
})

test('ToyPanel 的镜像回落项统一带 toyKey（形状本身也别留坑）', () => {
  const panel = read('../src/components/ToyPanel.vue')
  assert.match(panel, /toyKey: t\.toyKey \|\| t\.key/,
    '递归回落列表必须补齐 toyKey，否则 toy.key 缺失时整条链路拿不到 key')
  assert.match(panel, /const key = toy\.key \|\| toy\.toyKey/, '取 key 的顺序保持兼容两种形状')
})

test('前端镜像常量与后端 config 默认值不漂（接手指南-2.md §548 的已知边界）', () => {
  const settings = read('../src/views/SettingsView.vue')
  const config = read('../../agent-core/src/config.js')
  const feSteps = Number((settings.match(/HIRES_TURBO_STEPS\s*=\s*([\d.]+)/) || [])[1])
  const feCfg = Number((settings.match(/HIRES_TURBO_CFG\s*=\s*([\d.]+)/) || [])[1])
  const beSteps = Number((config.match(/hiresTurboSteps:\s*([\d.]+)/) || [])[1])
  const beCfg = Number((config.match(/hiresTurboCfg:\s*([\d.]+)/) || [])[1])
  assert.ok(Number.isFinite(feSteps) && Number.isFinite(beSteps), '两侧都要能解析出步数')
  assert.equal(feSteps, beSteps, `前端文案的步数(${feSteps}) 必须等于后端默认(${beSteps})，否则界面在说谎`)
  assert.equal(feCfg, beCfg, `前端文案的 CFG(${feCfg}) 必须等于后端默认(${beCfg})`)
})
