/**
 * 主动聊天里的玩具状态块（专题 §2.9-6）—— 2026-10-01 真机日志抓到的静默失败
 *
 * 现象（backend-2026-10-01.log）：
 *   `[warn] [toys] proactive inject failed: candidate is not defined`
 * 真因：`generateGreeting()` 的作用域里**没有 `candidate`**（形参名是 `character`），
 *      玩具注入那几行被 try/catch 吞成一行 warn，于是「她主动发消息也带玩具状态」这条
 *      从上线起**从未生效**，而所有单测都是绿的（没有任何断言看这段）。
 *
 * 这里守的是契约：注入用函数签名里的 `character.id`，且该作用域内不许出现 `candidate`。
 * 纯源码级守卫（不开库），因为该分支只在真跑一轮主动聊天时才会执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/services/proactiveChatScheduler.js', import.meta.url)
const src = readFileSync(SRC, 'utf8')
/** 断言前剥掉注释：修复注释里**逐字写了**旧标识符（candidate），不剥会被误判成代码里还在用 */
const stripJsComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const code = stripJsComments(src)

/** 截出 generateGreeting 的函数体（到紧随其后的 writeProactiveMessage 导出为止） */
function generateGreetingSource() {
  const start = src.indexOf('async function generateGreeting(')
  assert.ok(start > 0, '要能定位到 generateGreeting')
  const end = src.indexOf('\nexport function writeProactiveMessage', start)
  assert.ok(end > start, '要能定位到 generateGreeting 的结束边界')
  return stripJsComments(src.slice(start, end))
}

test('generateGreeting：形参名是 character（别处才叫 candidate）', () => {
  const sig = src.slice(src.indexOf('async function generateGreeting('))
  assert.match(sig.slice(0, 200), /async function generateGreeting\(character\b/,
    '签名第一个形参仍是 character —— 改名的话本测试与注入点要一起改')
})

test('主动聊天的玩具状态块用 character.id，且该作用域不引用 candidate', () => {
  const body = generateGreetingSource()

  assert.ok(body.includes('buildWornToysBlock('), '要注入玩具状态块')
  assert.match(body, /buildWornToysBlock\(character\.id/, '注入必须用 character.id')
  assert.equal(/\bcandidate\b/.test(body), false,
    'generateGreeting 作用域里没有 candidate（那是 scheduler 里的局部变量）—— 引用了就会每轮 ReferenceError')

  // 开关口径不变：features.toys 为真才注入（关着时零注入）
  assert.match(body, /config\.features\.toys === true/, '仍受 features.toys 开关门控')
})

test('整份 scheduler 里不存在「把一个不存在的标识符喂给玩具注入」的写法', () => {
  // 泛化守卫：所有 buildWornToysBlock( 调用点的实参都必须是当前作用域真的有的名字
  const calls = [...code.matchAll(/buildWornToysBlock\(([^)]*)\)/g)].map(m => m[1].trim())
  assert.ok(calls.length >= 1, `至少要有一处调用（现在 ${calls.length} 处）`)
  for (const arg of calls) {
    assert.match(arg, /^[A-Za-z_$][\w$]*\.id\b/, `调用实参形状异常：${arg}`)
    const holder = arg.split('.')[0]
    // holder 必须是模块里出现过的形参 / 局部变量声明
    assert.ok(new RegExp(`\\b${holder}\\b`).test(code), `标识符 ${holder} 在模块里应存在`)
  }
})
