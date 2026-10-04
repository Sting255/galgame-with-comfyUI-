/**
 * 坏图兜底测试（2026-10-02）
 *
 * 钉住两件事：
 *   ① 判定口径：只处理**同源**的 `/images/**` 与 `/avatars/**`；外链 / data: / 空 src 一律不碰；
 *      默认隐藏，显式要文字时给「（图片已在本地清理）」。
 *   ② 安装器行为：`error` 事件在**捕获阶段**被接住、同一个元素只处理一次、非 `<img>` 不误伤、
 *      卸载后不再生效 —— 都用最朴素的假对象喂（组件不好挂载，判定抽成纯函数后就能钉行为）。
 *
 * 事故背景：交付包页面上有 606 条 /images/** 死引用，坏图时只显示浏览器碎图图标。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fallbackPlanFor, isManagedImageSrc, BROKEN_IMAGE_TEXT, MISSING_ATTR } from '../src/components/imageFallbackLogic.js'
import { installImageFallback } from '../src/imageFallback.js'

const ORIGIN = 'http://127.0.0.1:3199'

test('① 判定：同源 /images/** 与 /avatars/** 才算我们的图（相对与绝对都认）', () => {
  for (const src of [
    '/images/chat/1712_ComfyUI_temp_vixbe_00071_.png',
    '/images/events/event_1_.png',
    '/images/moments/a.png', '/images/avatargen/a.png',
    '/images/expression_standing/a.png', '/images/standing/a.png',
    '/images/gifts/a.png', '/images/newspaper/a.png', '/images/items/a.png',
    'images/chat/a.png',                       // 不带前导斜杠的相对路径也要认
    `${ORIGIN}/images/chat/a.png`,             // 绝对同源
    `${ORIGIN}/avatars/1.png`,
  ]) {
    assert.equal(isManagedImageSrc(src, ORIGIN), true, `${src} 应当算我们的图`)
  }
})

test('② 判定：外链 / data: / 空值一律不碰（别越界改别人的东西）', () => {
  for (const src of [
    '', null, undefined,
    'data:image/svg+xml,<svg/>', 'blob:http://x/y',
    'https://cdn.jsdelivr.net/npm/a.png',
    'https://fonts.googleapis.cn/x.png',
    '//evil.example.com/images/a.png',
    'https://other.example.com/images/a.png',   // 路径带 /images/ 但是外域 ⇒ 不管
  ]) {
    assert.equal(isManagedImageSrc(src, ORIGIN), false, `${String(src)} 不该被我们处理`)
    assert.equal(fallbackPlanFor(src, { origin: ORIGIN }), 'none')
  }
})

test('③ 方案：默认隐藏；元素显式要文字时才给中文占位（网格里隐藏更稳，不留空洞）', () => {
  const src = '/images/chat/a.png'
  assert.equal(fallbackPlanFor(src, { origin: ORIGIN }), 'hide')
  assert.equal(fallbackPlanFor(src, { origin: ORIGIN, preferText: true }), 'text')
  assert.equal(fallbackPlanFor(src, { origin: '' }), 'hide', '没给 origin 时，同源相对路径照常处理')
  assert.equal(BROKEN_IMAGE_TEXT, '（图片已在本地清理）')
})

/** 极简假 DOM：只实现被测代码真正用到的那几样 */
function fakeEnv() {
  const listeners = []
  const doc = {
    addEventListener: (t, fn, cap) => listeners.push({ t, fn, cap }),
    removeEventListener: (t, fn, cap) => {
      const i = listeners.findIndex((l) => l.t === t && l.fn === fn && l.cap === cap)
      if (i >= 0) listeners.splice(i, 1)
    },
    createElement: () => {
      const span = {
        tagName: 'SPAN', textContent: '', style: { cssText: '' }, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v },
      }
      return span
    },
  }
  return { listeners, target: { document: doc, location: { origin: ORIGIN } }, doc }
}

function fakeImg(src, { preferText = false } = {}) {
  const el = {
    tagName: 'IMG', style: { display: '' }, attrs: {}, replacedWith: null,
    getAttribute(k) {
      if (k === 'src') return src
      if (k === 'data-img-fallback') return preferText ? 'text' : null
      return this.attrs[k] ?? null
    },
    setAttribute(k, v) { this.attrs[k] = v },
    replaceWith(node) { this.replacedWith = node },
  }
  return el
}

const fire = (env, el) => {
  const l = env.listeners.find((x) => x.t === 'error')
  assert.ok(l, '应当在 document 上注册 error 监听')
  assert.equal(l.cap, true, '⚠️ error 事件不冒泡 ⇒ 必须在**捕获阶段**监听')
  l.fn({ target: el })
}

test('④ 安装器：缺图默认被隐藏并打标记（同一元素只处理一次）', () => {
  const env = fakeEnv()
  const uninstall = installImageFallback(env.target)
  const img = fakeImg('/images/chat/gone.png')
  fire(env, img)
  assert.equal(img.style.display, 'none', '缺图要被隐藏（不再显示碎图）')
  assert.equal(img.attrs[MISSING_ATTR], '1', '要打上标记，便于断言与幂等')
  // 再来一次（同一元素重复 error）：不再改动，也不抛
  img.style.display = ''
  fire(env, img)
  assert.equal(img.style.display, '', '已经处理过的元素不再重复处理')
  uninstall()
  assert.equal(env.listeners.length, 0, '卸载后监听要摘干净')
})

test('⑤ 安装器：data-img-fallback="text" 时换成中文占位（不撑布局，自包含样式）', () => {
  const env = fakeEnv()
  installImageFallback(env.target)
  const img = fakeImg('/images/events/gone.png', { preferText: true })
  fire(env, img)
  assert.ok(img.replacedWith, '要替换成占位节点')
  assert.equal(img.replacedWith.textContent, BROKEN_IMAGE_TEXT)
  assert.match(img.replacedWith.style.cssText, /font-size:12px/, '占位用自包含小字号样式')
  assert.equal(img.replacedWith.attrs[MISSING_ATTR], '1')
})

test('⑥ 安装器：非 <img>（脚本/样式表加载失败）与外链图都不误伤', () => {
  const env = fakeEnv()
  installImageFallback(env.target)
  const script = { tagName: 'SCRIPT', style: {} }
  fire(env, script)
  assert.equal(script.style.display, undefined, '非 IMG 一律不碰')
  const external = fakeImg('https://cdn.jsdelivr.net/npm/a.png')
  fire(env, external)
  assert.equal(external.style.display, '', '外链图不归我们管')
  assert.equal(external.attrs[MISSING_ATTR], undefined)
})

test('⑦ 安装器：没有 document 时安全返回（不炸），并且幂等安装不重复注册', () => {
  const noop = installImageFallback({})
  assert.equal(typeof noop, 'function')
  noop()
  const env = fakeEnv()
  installImageFallback(env.target)
  installImageFallback(env.target)
  assert.equal(env.listeners.filter((l) => l.t === 'error').length, 2, '两次安装 = 两个监听（生产只装一次；这里只钉"每次都安全"）')
})
