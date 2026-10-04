/**
 * 坏图兜底的**安装器**（2026-10-02）
 *
 * 为什么用"全局捕获阶段监听"而不是逐个组件加 `@error`：
 *   渲染 `/images/**` 的位置实测有十几处（聊天气泡、事件页、朋友圈、图库、立绘、头像、
 *   报纸、信箱、背包……），逐个改既容易漏、又会和既有 `@error` 处理打架；
 *   而 `error` 事件**不冒泡**，在 `document` 上以**捕获阶段**监听就能一处覆盖全部 `<img>`，
 *   且**只在图片真的失败时**才动手 ⇒ 正常图片零影响（不改渲染、不改布局）。
 *
 * 判定口径全在 `imageFallbackLogic.js`（纯函数，有单测）：只处理同源的 `/images/**` 与 `/avatars/**`，
 * 外链与 data: 一律不碰。默认隐藏；元素上写了 `data-img-fallback="text"` 则换成一句中文占位。
 *
 * @param {any} target 注入点（默认 window）—— 传 `{ document, location }` 即可在测试里跑
 * @returns {() => void} 卸载函数（主要给测试用；生产里装一次即可）
 */
import { BROKEN_IMAGE_TEXT, MISSING_ATTR, fallbackPlanFor } from './components/imageFallbackLogic.js'

export function installImageFallback(target = globalThis) {
  const doc = target?.document
  if (!doc || typeof doc.addEventListener !== 'function') return () => {}

  const handler = (ev) => {
    const el = ev?.target
    // 用 tagName 判断（而不是 instanceof HTMLElement）⇒ 测试里可以喂最朴素的假对象
    if (!el || el.tagName !== 'IMG') return
    if (typeof el.getAttribute === 'function' && el.getAttribute(MISSING_ATTR)) return   // 幂等：同一张图只处理一次
    const src = (typeof el.getAttribute === 'function' ? el.getAttribute('src') : el.src) || ''
    const preferText = typeof el.getAttribute === 'function' && el.getAttribute('data-img-fallback') === 'text'
    const plan = fallbackPlanFor(src, { origin: target?.location?.origin || '', preferText })
    if (plan === 'none') return
    try {
      if (typeof el.setAttribute === 'function') el.setAttribute(MISSING_ATTR, '1')
      if (plan === 'text' && typeof doc.createElement === 'function' && typeof el.replaceWith === 'function') {
        const span = doc.createElement('span')
        span.textContent = BROKEN_IMAGE_TEXT
        // 自包含样式（不新增全局 CSS、不动设计系统）：小一号、次要色、不撑布局
        span.style.cssText = 'font-size:12px;color:var(--text-secondary,#8a8a8a);opacity:.85;'
        span.setAttribute(MISSING_ATTR, '1')
        el.replaceWith(span)
        return
      }
      if (el.style) el.style.display = 'none'   // 默认：藏起来（网格/气泡里都不会留空洞）
    } catch { /* 兜底本身绝不能把页面搞崩 */ }
  }

  // ⚠️ 第三个参数 true = 捕获阶段：error 事件不冒泡，只有捕获阶段能在 document 上收到
  doc.addEventListener('error', handler, true)
  return () => { try { doc.removeEventListener('error', handler, true) } catch { /* 忽略 */ } }
}
