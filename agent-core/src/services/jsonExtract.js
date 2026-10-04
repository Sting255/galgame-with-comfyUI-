/**
 * LLM 输出里的 JSON 提取（括号配对扫描）—— 全仓统一口径
 *
 * ## 为什么单独成模块（2026-10-01）
 * 这段逻辑原本只住在 `eventGenerator.js`（13 个模块从那里 import）。
 * 但 `eventGenerator` 会**连带拉起生图栈**（`imageSkill` → `comfyClient`，import 时就会去打 ComfyUI
 * `/object_info`）—— 情绪评估只是想容错解析一段 JSON，不该顺手把整条生图依赖拖进来：
 * 启动变慢、单测凭空多出网络副作用。所以把扫描器抽到这里，谁要谁 import 这个小文件。
 *
 * `eventGenerator.js` 仍原样**再导出** `extractFirstJson`（13 处既有 import 不用改）。
 *
 * ## 它解决什么
 * 模型常见三种脏输出：
 *   ① 前后带话（"好的，这是结果：{…}"）
 *   ② 合法 JSON + **尾部多余字符**（真机日志逐字：`Unexpected non-whitespace character after JSON at position 169`）
 *   ③ ```json 代码块包裹
 * 关键点是**在第一个括号配平处收手**：尾部垃圾自然被丢掉。
 * 反例（曾经的写法）：取"第一个 `{` 到**最后**一个 `}`" ⇒ 把尾垃圾一起切进来、二次解析照样失败。
 *
 * 扫描时正确跳过字符串里的括号与转义（`{"a":"}"}` 这种不会提前收手）。
 */

/**
 * 从任意文本里取出**第一个完整的 JSON 对象**字符串。
 * @param {string} text
 * @returns {string|null} 未闭合 / 找不到 `{` 时返回 null
 */
export function extractFirstJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null; // 括号未闭合
}
