/**
 * 测试全局准备（用法：`node --test --import ./test/setup.mjs …`）
 *
 * 为什么需要（2026-10-02，两轮全量被测出来的坑）：
 *   `townCharacterAssetsForce` / `toyPlayModes` / `toyRoutes` 三个文件在**文件级 90s 超时**，
 *   日志里是 `Connection error` 打到旧网关 `127.0.0.1`。它们**自己装了 fetch 桩**，
 *   但请求是在**模块 import 阶段**发出去的（comfyClient 轮询、玩具反应）——桩还没装上就出去了。
 *   网关一换 IP，这些请求就一路重试到超时；换回可达地址又"自己好了"，属于**假绿**。
 *
 * 这里在任何测试模块之前把网络**默认关掉**：
 *   · 非本机地址的 fetch 一律 reject（本机 127.0.0.1 / localhost 放行 —— 路由测试要起本地服务）；
 *   · DB 用内存库、不写文件日志（与各测试文件里的设置一致，重复设置无副作用）。
 *
 * 149 个测试文件自己装了桩 ⇒ 它们会覆盖这里，行为不变；要联网的用例自己 `globalThis.fetch = …` 即可。
 */
process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/|$)/i
const realFetch = globalThis.fetch?.bind(globalThis)

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ? String(input.url) : String(input))
  if (LOCAL.test(url)) {
    if (!realFetch) throw new Error(`测试里没有可用的 fetch，本地请求也无法发出：${url}`)
    return realFetch(input, init)
  }
  throw new Error(
    `测试禁止联网：${url}\n` +
    '  这是**故意**的 —— 测试必须离线可跑。要用真实网络请在该用例里自己覆盖 globalThis.fetch。'
  )
}
