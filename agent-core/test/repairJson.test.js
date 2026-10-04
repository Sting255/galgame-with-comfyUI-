/**
 * `repairJson` 对照表（2026-10-04）。
 *
 * 起因是真机事故：报纸日报**整个生成失败**，日志里是
 *   `[newspaper] LLM generation failed: Bad escaped character in JSON at position 1711`
 * 而 `newspaperService` 明明调了 `repairJson` —— 说明**修复器本身有洞**。
 *
 * 实测挖出两个（本文件把每个都钉住，且都是"先证明原始行为，再要求修复后合法"）：
 *   ① `\\`（合法转义）被原实现拆坏：`{"a":"C:\\\\path"}` 本来能 parse，过一遍反而抛错；
 *   ② 坏 `\u`（后面不是 4 位十六进制）原实现整条不匹配、原样放行 ⇒ 仍抛 `Bad Unicode escape`。
 *
 * 判据一律是**行为**（`JSON.parse` 能不能过 + 解析出来的值对不对），不是"字符串长什么样"——
 * 这样以后谁改了实现，只要行为还对就不会误报。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';

const { closeDb } = await import('../src/db/index.js');
const { repairJson } = await import('../src/services/eventGenerator.js');

after(() => { closeDb() });

/** 断言「修复后能 parse，且解析出的值等于期望」 */
function ok(raw, expected, label) {
  const fixed = repairJson(raw);
  let parsed;
  try {
    parsed = JSON.parse(fixed);
  } catch (err) {
    assert.fail(`${label}：修复后仍无法解析（${err.message}）\n  原始=${JSON.stringify(raw)}\n  修复=${JSON.stringify(fixed)}`);
  }
  assert.deepEqual(parsed, expected, `${label}：修复后解析出的值不对\n  修复=${JSON.stringify(fixed)}`);
  return fixed;
}

// ── ① 合法输入必须**原样通过**（修复器不该改坏好东西）───────────────────────

test('① 合法 JSON 一律原样通过（含 C:\\path 这种转义反斜杠、\\n\\t\\" 标准转义、\\uXXXX）', () => {
  const cases = [
    ['转义反斜杠（原实现会拆坏）', '{"a":"C:\\\\path"}', { a: 'C:\\path' }],
    ['标准转义 \\n \\t \\"', '{"a":"x\\ny\\tz\\"q"}', { a: 'x\ny\tz"q' }],
    ['合法 \\uXXXX', '{"a":"\\u4f60\\u597d"}', { a: '你好' }],
    ['连续两个转义反斜杠', '{"a":"a\\\\\\\\b"}', { a: 'a\\\\b' }],
    ['正斜杠转义 \\/', '{"a":"x\\/y"}', { a: 'x/y' }],
    ['回退 / 换页 \\b \\f', '{"a":"p\\bq\\fr"}', { a: 'p\bq\fr' }],
    ['没有反斜杠的普通文本（含中文）', '{"a":"邻舍日报 第一期"}', { a: '邻舍日报 第一期' }],
  ];
  for (const [label, raw, expected] of cases) {
    const fixed = repairJson(raw);
    assert.equal(fixed, raw, `${label}：合法输入不许被改动`);
    ok(raw, expected, label);
  }
});

// ── ② 非法转义必须被修好 ───────────────────────────────────────────────────

test('② 非法转义一律修好：\\( \\) \\x …（去掉反斜杠，与历史口径一致）', () => {
  ok('{"a":"\\( soft light \\)"}', { a: '( soft light )' }, '图片规则的 \\( \\)');
  ok('{"a":"x\\xq"}', { a: 'xxq' }, '单个 \\x');
  ok('{"a":"\\a \\c \\d"}', { a: 'a c d' }, '多个不同的坏转义');
});

test('③ 坏 \\u（后面不是 4 位十六进制）也要修好 —— 原实现整条漏掉', () => {
  ok('{"a":"\\u你"}', { a: 'u你' }, '\\u 后跟中文');
  ok('{"a":"\\u12"}', { a: 'u12' }, '\\u 后只有 2 位 hex');
  ok('{"a":"\\uxyzw"}', { a: 'uxyzw' }, '\\u 后完全不是 hex');
  // 反向：**合法**的 \\uXXXX 不许被当成坏的（4 位 hex 的边界）
  ok('{"a":"\\u0041\\uFFFD"}', { a: 'A\uFFFD' }, '合法 \\uXXXX 边界');
});

test('④ 结尾孤立反斜杠（LLM 输出被截断）也要修好', () => {
  const fixed = repairJson('{"a":"abc\\');
  assert.equal(fixed.startsWith('{"a":"abc'), true);
  // 截断的 JSON 本身不可能 parse 完整，这里只钉"反斜杠被去掉了、不会再制造 Bad escaped character"
  assert.equal(fixed.endsWith('\\'), false, '结尾不该还留着孤立反斜杠');
});

// ── ③ 幂等与顺序 ───────────────────────────────────────────────────────────

test('⑤ 幂等：修好的结果再过一遍不许变（防止"修一次好、修两次坏"）', () => {
  const raws = [
    '{"a":"C:\\\\path"}', '{"a":"\\( x \\)"}', '{"a":"\\u你"}', '{"a":"x\\ny"}',
    '{"a":"\\u4f60"}', '{"a":"a\\\\\\\\b"}',
  ];
  for (const raw of raws) {
    const once = repairJson(raw);
    assert.equal(repairJson(once), once, `不幂等：${JSON.stringify(raw)} → ${JSON.stringify(once)}`);
  }
});

test('⑥ 分支顺序：合法 \\uXXXX 与 \\\\ 必须排在宽泛的坏转义分支之前', () => {
  // 如果顺序反了，`\u4f60` 会被 `\u` 那条吃掉变成 `u4f60`、`\\` 会被拆成坏转义。
  // 这条用"解析出的值"来钉，比查字符串更硬。
  ok('{"a":"\\u4f60\\u597d"}', { a: '你好' }, '合法 unicode 不被坏分支吃');
  ok('{"a":"x\\\\y"}', { a: 'x\\y' }, '合法转义反斜杠不被拆坏');
});

test('⑦ 非字符串输入不炸（null / undefined / 数字都当空串处理）', () => {
  for (const v of [null, undefined, 0, '']) {
    assert.doesNotThrow(() => repairJson(v), `输入 ${String(v)} 不该抛`);
  }
  assert.equal(repairJson(null), '');
  assert.equal(repairJson(undefined), '');
});

// ── ④ 真机形态的端到端复现 ────────────────────────────────────────────────

test('⑧ 端到端：模拟报纸那种"正文里带 Windows 路径 + 图片规则括号"的输出', () => {
  // 这就是 2026-10-04 那天报纸失败的可疑形态：image_prompt 里既有 \( 又有 \\ 路径。
  const llmOutput = [
    '```json',
    '{',
    '  "headline": "邻舍日报 · 第一期",',
    '  "items": [',
    '    { "title": "操场上的事", "body": "她看了一眼 C:\\\\Photos\\\\today.png 里的照片，\\(小声\\)说了句什么。" }',
    '  ]',
    '}',
    '```',
  ].join('\n');
  // 先按报纸链的实际做法取出 JSON 片段（这里手工切，避免依赖另一条链的实现）
  const jsonStr = llmOutput.slice(llmOutput.indexOf('{'), llmOutput.lastIndexOf('}') + 1);
  const parsed = JSON.parse(repairJson(jsonStr));
  assert.equal(parsed.headline, '邻舍日报 · 第一期');
  assert.equal(parsed.items.length, 1);
  assert.ok(parsed.items[0].body.includes('C:\\Photos\\today.png'), '路径里的反斜杠要保住一个');
  assert.ok(parsed.items[0].body.includes('(小声)'), '图片规则括号的反斜杠要去掉');
});
