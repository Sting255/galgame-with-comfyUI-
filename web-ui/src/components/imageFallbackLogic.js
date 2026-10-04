/**
 * 坏图兜底的**判定逻辑**（纯函数，可单测）—— 2026-10-02
 *
 * 背景（实测数据）：交付包页面出现 404，抓下来全部是 `/images/**` 的图片，
 * 库里这类引用共 **606 条**指向早已不存在的文件（`ComfyUI_temp_*` 临时产物被清），
 * 而 `data/images` 只剩 19 个文件。前端对坏图**没有任何兜底** ⇒ 用户看到浏览器碎图图标。
 *
 * 这里只回答一个问题：**这张图挂了，该怎么处理？**
 *   · `'none'` —— 不归我们管（外链 / data: / 空 src）⇒ 保持浏览器原样，别多改；
 *   · `'hide'` —— 我们自己的图（同源 `/images/**`、`/avatars/**`）⇒ 直接隐藏，
 *                网格布局里最稳（不会撑出空白或换行跳动）；
 *   · `'text'` —— 同上，但**显式要求**显示一句中文占位（`data-img-fallback="text"`），
 *                适合聊天/事件这种"图看不到会让人以为坏了"的位置。
 *
 * ⚠️ 为什么判定要独立于 DOM：本仓的测试约定是"钉行为、不钉源码行"，
 *    纯函数才能把上面三条口径逐条钉住（照 `groupPanelLogic.js` 的写法）。
 */

/** 缺失时显示的中文占位（用户看到的是"清理过"，不是"坏了"） */
export const BROKEN_IMAGE_TEXT = '（图片已在本地清理）'

/** 处理过的图片会打上这个属性，避免同一个元素被反复处理（也方便 e2e 断言） */
export const MISSING_ATTR = 'data-img-missing'

/** 走本地存储的图片目录（与后端 `express.static(DATA_DIR/images)`、`DATA_DIR/avatars` 对应） */
const MANAGED_PREFIXES = ['/images/', 'images/', '/avatars/', 'avatars/']

/**
 * 是不是"我们自己的、存在本地磁盘上的图"。
 * 只认同源：外链（哪怕路径里带 /images/）一律不管 —— 别越界改别人的东西。
 */
export function isManagedImageSrc(src, origin = '') {
  const s = String(src ?? '').trim()
  if (!s) return false
  if (/^(data|blob|javascript):/i.test(s)) return false
  if (/^https?:\/\//i.test(s)) {
    if (!origin) return false
    if (!s.startsWith(origin)) return false
    const rest = s.slice(origin.length)
    return MANAGED_PREFIXES.some((p) => rest.startsWith(p.startsWith('/') ? p : '/' + p))
  }
  if (s.startsWith('//')) return false           // 协议相对 = 外链
  return MANAGED_PREFIXES.some((p) => s.startsWith(p))
}

/**
 * 坏图处理方案。
 * @param {string} src 图片地址（`<img>` 的 src）
 * @param {{origin?: string, preferText?: boolean}} [opts] origin = 当前站点源；preferText = 元素显式要文字占位
 * @returns {'none'|'hide'|'text'}
 */
export function fallbackPlanFor(src, { origin = '', preferText = false } = {}) {
  if (!isManagedImageSrc(src, origin)) return 'none'
  return preferText ? 'text' : 'hide'
}
