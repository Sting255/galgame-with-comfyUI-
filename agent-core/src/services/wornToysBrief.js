/**
 * 「她身上戴着什么」的**注册表叶子模块**（2026-10-02）
 *
 * 为什么要有这个叶子：用户原话——
 *   「如果戴上玩具之后 没有摘下的情况下 在其他的地方出图也得要看到玩具的所在 在群聊里也要让其他角色看到
 *     那种 比如在性爱的时候的图 动作的图 朋友圈的图 就算角色戴着玩具 但是就是没有出来玩具的图
 *     这个是很不真实的」
 * ⇒ 穿戴必须**跨场景可见**（出图 / 群聊成员卡 / 朋友圈 / 亲密图…），而不是只在玩具页自己的图里。
 *
 * 实现上的两难：文本由 `services/toyService.js` 的 `buildWornToysBlock()` 产出（它依赖 listWornToys /
 * catalog / combo… 一大串），而**所有生图路径的唯一入口**是 `services/characterPersona.js`；
 * 若后者直接 import toyService 就**成环**（toyService 本来就 import characterPersona）。
 *
 * 解法：一个零依赖的注册表叶子。
 *   · 模块加载时 `toyService` 调 `registerWornToysProvider(fn)` 把自己的产出函数登记进来；
 *   · `characterPersona` 只 import 本文件，用 `wornToysBrief(id, opts)` 取文本；
 *   · 没登记（或没戴）⇒ 返回空串 ⇒ **零注入**，与加功能前逐字节一致。
 *
 * 为什么不是"调用方自己传"：生图调用点有 58 处，靠人逐个传必然漏（这正是"以前只有玩具页有玩具"的原因）。
 */

let provider = null;

/** 由 toyService 在模块加载期调用一次（重复调用以后者为准，方便测试替换） */
export function registerWornToysProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

/** 测试用：清空登记 */
export function resetWornToysProvider() {
  provider = null;
}

/** 是否已登记（测试断言 / 排障用） */
export function hasWornToysProvider() {
  return typeof provider === 'function';
}

/**
 * 取"她身上戴着什么"的简短描述（**给生图用**：只描述可见的佩戴物与强度，不带情绪指引）。
 *
 * 与 `toyService.buildWornToysBlock()`（那是给聊天叙事用的完整块）分开：生图 prompt 里塞整块
 * `<worn_toys>` 会太长且跑题，这里只要一句"她身上戴着：跳蛋（内裤里，Lv3）"。
 *
 * @param {number|string} characterId
 * @param {{scene?:'chat'|'group', person?:string}} [opts]
 * @returns {string} 空串 = 没戴 / 没登记（调用方据此零注入）
 */
export function wornToysBrief(characterId, opts = {}) {
  if (typeof provider !== 'function') return '';
  try {
    const text = provider(characterId, opts);
    return typeof text === 'string' ? text.trim() : '';
  } catch (err) {
    // 生图是主线：玩具描述拿不到绝不能让它失败
    console.warn('[wornToysBrief] 取穿戴描述失败（按"没戴"处理）:', err?.message || err);
    return '';
  }
}
