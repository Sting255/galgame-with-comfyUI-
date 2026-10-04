/**
 * 催眠手机 × 聊天链路集成回归（task-29）
 *
 * 本文件覆盖两块：
 *   A. **行为级（主力）**：`getSplitHistory` 的 `excludeWindows` 区间屏蔽——遗忘窗口内的 raw
 *      不进模型上下文（activeText / checkpointHistory 两条路径都要生效），窗口外照旧，
 *      末尾"当前输入"永不屏蔽，不传参数时零行为变化。
 *   B. **源码级**：contextAssembler.js 里 `isRawInWindows` 与 `excludeWindows` 的挂点存在且
 *      作用于两处 SELECT；chat.js 里三块注入、一次性指令只消费一次、遗忘窗口传参（防静默回归）。
 *   C. **行为级（服务侧）**：`forced_climax` 在"会话真有 raw"时的记账与幂等。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`hypnosis chat integration fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { getSplitHistory } = await import('../src/services/contextAssembler.js');
const { grantHypnosisPhone, hypnotize, issueCommand } = await import('../src/services/hypnosisService.js');
const { saveAffinity, setOath } = await import('../src/services/emotionEngine.js');

const CONV = 'char_1';

/** 造 4 轮对话：u1/a1/u2/a2/u3/a3 + 末尾未回复的当前输入 u4 */
function seedConversation(t) {
  const db = getDb();
  t.after(() => closeDb());
  const insert = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  const script = [
    ['user', '[u1] 第一轮'],
    ['assistant', '[a1] 第一轮回复'],
    ['user', '[u2] 第二轮'],
    ['assistant', '[a2] 第二轮回复'],
    ['user', '[u3] 第三轮'],
    ['assistant', '[a3] 第三轮回复'],
    ['user', '[u4] 当前输入'],
  ];
  const ids = script.map(([role, content]) => Number(insert.run(CONV, role, content).lastInsertRowid));
  return { db, ids };
}

const split = (windows, extra = {}) => getSplitHistory(
  getDb(), CONV, 10, 10, { userName: '我', characterName: '她', ...(windows ? { excludeWindows: windows } : {}), ...extra },
);

const historyText = result => result.checkpointHistory.map(m => m.content).join('\n');

// ──────────────── A. 行为级 ────────────────

test('不传 excludeWindows：全部消息照旧进入上下文（零行为变化）', async t => {
  const { db, ids } = seedConversation(t);
  const result = split(null);
  for (const marker of ['[u1]', '[a1]', '[u2]', '[a2]', '[u3]', '[a3]']) {
    assert.ok(result.activeText.includes(marker), `activeText 应含 ${marker}`);
  }
  // 末尾未回复的当前输入走 checkpointHistory（不是 activeText），这是既有口径
  assert.ok(historyText(result).includes('[u4] 当前输入'));
  assert.equal(ids.length, 7);
  // 不传参数 === 传空数组（保持既有调用点兼容）
  assert.deepEqual(split(null), split([]));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(CONV).n, 7, '原记录必须仍在库里');
});

test('行为级：窗口内的 active raw 不进 activeText，窗口外的仍在', async t => {
  const { ids } = seedConversation(t);
  const base = split(null);
  const filtered = split([{ fromRawId: ids[2], toRawId: ids[3] }]);   // 屏蔽 u2 / a2

  assert.ok(!filtered.activeText.includes('[u2]'), '窗口内的 user 不应进入上下文');
  assert.ok(!filtered.activeText.includes('[a2]'), '窗口内的 assistant 不应进入上下文');
  assert.ok(filtered.activeText.includes('[u1]'), '窗口外（更早）的仍在');
  assert.ok(filtered.activeText.includes('[a3]'), '窗口外（更晚）的仍在');
  assert.ok(filtered.activeText.length < base.activeText.length, '上下文确实变短了');
  // 屏蔽只作用于"喂给模型的文本"，库里原记录不动（可审计/可撤销）
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(CONV).n, 7);
});

test('行为级：末尾"当前输入"永不被屏蔽（哪怕窗口把它盖住）', async t => {
  const { ids } = seedConversation(t);
  const filtered = split([{ fromRawId: ids[0], toRawId: ids[6] }]);   // 覆盖全部
  assert.ok(historyText(filtered).includes('[u4] 当前输入'), '当前输入是本次请求，必须保留');
  assert.ok(!filtered.activeText.includes('[u1]'));
  assert.ok(!filtered.activeText.includes('[a3]'));
});

test('行为级：checkpoint 路径同样被屏蔽（checkpointHistory 变短、窗口外保留）', async t => {
  const { db, ids } = seedConversation(t);
  // 造一条摘要分界线：ids[0..1] 归 checkpoint，ids[2..] 归活跃侧
  db.prepare(`INSERT INTO rolling_summaries (conversation_id, start_msg_id, end_msg_id, summary, checkpoint_version)
              VALUES (?, ?, ?, ?, 1)`).run(CONV, ids[0], ids[1], '前两轮的摘要');

  const base = split(null);
  assert.ok(historyText(base).includes('[u1] 第一轮'));
  assert.ok(historyText(base).includes('[a1] 第一轮回复'));

  const filtered = split([{ fromRawId: ids[0], toRawId: ids[0] }]);   // 只屏蔽 u1
  assert.equal(filtered.checkpointHistory.length, base.checkpointHistory.length - 1, 'checkpoint 侧应少一条');
  assert.ok(!historyText(filtered).includes('[u1] 第一轮'), '被屏蔽的 checkpoint 消息不该出现');
  assert.ok(historyText(filtered).includes('[a1] 第一轮回复'), '同段窗口外的消息保留');
  assert.ok(historyText(filtered).includes('[u4] 当前输入'));
  // 活跃侧不受这条窗口影响
  assert.ok(filtered.activeText.includes('[a3]'));
});

test('行为级：端点反向 / 非法区间 / 多个区间 都按预期', async t => {
  const { ids } = seedConversation(t);
  // 反向端点（from > to）也要按闭区间生效
  const reversed = split([{ fromRawId: ids[3], toRawId: ids[2] }]);
  assert.ok(!reversed.activeText.includes('[u2]'));
  assert.ok(!reversed.activeText.includes('[a2]'));

  // 非法区间忽略、不抛错、不误伤
  const bogus = split([{ fromRawId: 'x', toRawId: null }, { fromRawId: 0, toRawId: 0 }]);
  assert.ok(bogus.activeText.includes('[u1]'));
  assert.ok(bogus.activeText.includes('[a3]'));

  // 多个区间叠加
  const multi = split([{ fromRawId: ids[0], toRawId: ids[0] }, { fromRawId: ids[4], toRawId: ids[5] }]);
  assert.ok(!multi.activeText.includes('[u1]'));
  assert.ok(!multi.activeText.includes('[u3]'));
  assert.ok(!multi.activeText.includes('[a3]'));
  assert.ok(multi.activeText.includes('[u2]'));
  assert.ok(multi.activeText.includes('[a2]'));
});

// ──────────────── B. 源码级挂点（防静默回归） ────────────────

test('contextAssembler.js 挂点：excludeWindows 入参 + isRawInWindows 作用于两处 SELECT', async () => {
  const source = await readFile(new URL('../src/services/contextAssembler.js', import.meta.url), 'utf8');
  assert.match(source, /function isRawInWindows\(rawId, windows\)/, '缺 isRawInWindows helper');
  assert.match(source, /excludeWindows = \[\]/, 'getSplitHistory 的 options 缺 excludeWindows（默认空数组）');

  // active 与 checkpoint 两条路径都必须过滤
  const first = source.indexOf('isRawInWindows(msg.id, excludeWindows)');
  assert.ok(first > 0, 'active 路径未见过滤调用');
  const second = source.indexOf('isRawInWindows(msg.id, excludeWindows)', first + 1);
  assert.ok(second > first, 'checkpoint 路径未见过滤调用（两条路径都要过滤）');

  // 末尾当前输入必须显式例外
  assert.ok(
    source.includes("index === activeFetched.length - 1 && msg.role === 'user'"),
    '必须显式保留末尾未回复的 user（当前输入）',
  );
  // 注释要写明"原记录保留、只是不进上下文"
  assert.match(source, /可审计、可撤销/);
});

test('chat.js 挂点：三块注入在 features.hypnosis 守卫内、整块后置到动态块末尾，指令只消费一次', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  const at = (needle, label = needle) => {
    const i = source.indexOf(needle);
    assert.ok(i >= 0, `chat.js 缺挂点：${label}`);
    return i;
  };

  // 依赖导入
  // task-13：动作系统也给 chat.js 的同一行 import 加了 isBodyControlled（判断"催眠中"）⇒
  // 断言放宽为"必须含这三个函数、允许再带别的"，而不是逐字钉死整行。
  assert.match(source, /^import \{ getHypnosisState, consumePendingDirective, listForgottenWindows(?:, [^}]+)? \} from '\.\.\/services\/hypnosisService\.js';$/m, '未 import hypnosisService');
  assert.match(source, /^import \{ buildHypnosisStateBlock, buildDirectiveBlock, buildAmnesiaBlock, isAwakenedFromSleepRow \} from '\.\.\/services\/hypnosisPrompt\.js';$/m, '未 import hypnosisPrompt');

  // 三块注入：顺序 state → directive → amnesia，且都在 features.hypnosis 守卫内
  const stateAt = at('buildHypnosisStateBlock(hypnoState, { chatUserName })', '状态块注入');
  // task-42 起 mindAwake 多了「非催眠态按纯执行分流」的三元判断，只锚住调用与传参名
  const directiveAt = at('buildDirectiveBlock(directive, { mindAwake:', '指令块注入');
  const amnesiaAt = at('buildAmnesiaBlock(listForgottenWindows(characterId))', '遗忘提示注入');
  assert.ok(stateAt < directiveAt && directiveAt < amnesiaAt, '三块注入顺序应为 state → directive → amnesia');
  const guardAt = source.lastIndexOf('if (config.features.hypnosis !== false) {', stateAt);
  // 距离阈值只是「中间没有别的分支夹进来」的量级检查；task-42 在守卫后加了口径注释，放宽到 1200
  assert.ok(guardAt > 0 && stateAt - guardAt < 1200, '三块注入必须落在 features.hypnosis 守卫内');
  assert.ok(at('[hypnosis] context inject failed') > stateAt, '注入必须被 try/catch 包住（失败不影响聊天主流程）');

  // 位置（task-42 改口径）：三块**先攒进 hypnosisBlocks、再整块后置到所有动态块之后**。
  // 原先是「紧跟亲密档案」，但后面还压着 user_portrait / reply_length / 情绪 / 聊天历史 /
  // 风格 / 奇遇 / RAG —— 真机反馈「催眠之后也没有完全听命」就是这么被盖过去的。
  assert.ok(at('const hypnosisBlocks = [];', '催眠块容器') > 0, '需要独立的 hypnosisBlocks 容器');
  const deferAt = at('dynamicBlocks.push(...hypnosisBlocks);', '催眠块后置');
  const reminderAt = at('<attitude_reminder>', '态度重申');
  assert.ok(deferAt > reminderAt, '催眠块必须排在末尾（在 attitude_reminder 之后）');
  assert.ok(source.includes('if (hypnosisBlocks.length > 0) {'), '没有催眠内容时不得多注入任何东西');

  // 一次性指令：只消费一次
  const consumeCalls = source.match(/^\s*const directive = consumePendingDirective\(characterId\);/gm) || [];
  assert.equal(consumeCalls.length, 1, 'consumePendingDirective 必须只调用一次（一次性语义）');

  // task-30：三段各自 try/catch —— 以前一整块 try 时，任一片抛异常会把状态块与指令块一起丢掉，
  // 用户看到的现象就是"点了强制高潮、她毫无反应，日志只有一行 context inject failed"。
  for (const piece of ['state block inject failed', 'directive inject failed', 'amnesia block inject failed', 'context inject failed']) {
    assert.ok(source.includes(`[hypnosis] ${piece}`), `缺少分片容错日志：${piece}`);
  }

  // task-30：强制高潮那一轮必须出图（旧行为只改文案、不碰生图判断，实测 image_tasks 为空）
  assert.match(source, /let hypnosisDirective = '';/, '缺少指令轮次变量的初始化');
  assert.match(source, /if \(directive === 'forced_climax'\) hypnosisDirective = directive;/, 'forced_climax 要记下来供生图判断用');
  const climaxImageAt = at("} else if (hypnosisDirective === 'forced_climax') {", '强制高潮出图分支');
  const imageJudgeAt = at("if (imageMode === 'off') {", '生图判断链入口');
  assert.ok(climaxImageAt > imageJudgeAt, '强制出图分支必须落在生图判断链里');
  assert.match(
    source.slice(climaxImageAt, climaxImageAt + 700),
    /handleNeedImageFlow\(conversationId, character, send, preTaskId\)/,
    '强制高潮出图要走既有的 needImage 管线'
  );

  // 遗忘窗口传参：一次查库 + 交给组装器（不逐条查库）
  assert.match(source, /let hypnoExcludeWindows = \[\];/, '缺少遗忘窗口的初始化');
  assert.match(source, /hypnoExcludeWindows = listForgottenWindows\(characterId\)/, '遗忘窗口应一次查库');
  assert.match(source, /\.map\(w => \(\{ fromRawId: w\.fromRawId, toRawId: w\.toRawId \}\)\)/, '窗口应映射成组装器认的区间形状');
  assert.match(source, /excludeWindows: hypnoExcludeWindows/, 'getSplitHistory 未收到 excludeWindows');
});

// ──────────────── C. 服务侧行为：forced_climax 真有 raw 时的记账与幂等 ────────────────

test('forced_climax（会话真有 raw）：不抛错、记账 1 笔、同状态重复点击不重复计数', async t => {
  const db = getDb();
  t.after(() => closeDb());
  // 门控：手机 + 好感 ≥85 + 已誓约（沿用 service 的口径，不自造）
  grantHypnosisPhone();
  saveAffinity(1, 100, false);
  setOath(1, 1);
  // 造"像真会话"的历史：user/assistant 交替，messages 只有 assistant 气泡（两个自增序列天然不相等）
  const insRaw = db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)');
  const insMsg = db.prepare("INSERT INTO messages (conversation_id, raw_id, role, content, seq) VALUES (?, ?, 'assistant', ?, 0)");
  for (const [role, content] of [['user', '[u1]'], ['assistant', '[a1]'], ['user', '[u2]'], ['assistant', '[a2]']]) {
    const rawId = Number(insRaw.run(CONV, role, content).lastInsertRowid);
    if (role === 'assistant') insMsg.run(CONV, rawId, content);
  }

  hypnotize(1, { minutes: 60 });
  const first = issueCommand(1, 'forced_climax');
  assert.equal(first.intimate.inserted, 1, '应记 1 笔高潮流水');
  assert.equal(first.intimate.blocked, false);
  assert.match(first.intimate.sourceUid, /^hypnosis:.+:forced_climax$/, '幂等锚点应稳定可读');

  const rows = db.prepare("SELECT act_key, scene, source FROM character_intimate_log WHERE character_id = 1").all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ actKey: rows[0].act_key, scene: rows[0].scene, source: rows[0].source },
    { actKey: 'climax', scene: 'hypnosis', source: 'manual' });

  // 同一状态内再点一次：锚点相同 → 去重，不翻倍
  const again = issueCommand(1, 'forced_climax');
  assert.equal(again.intimate.inserted, 0);
  assert.equal(again.intimate.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_intimate_log').get().n, 1);

  // 已修（本轮）：nudgeEmotionForClimax 的 afterMsgId 改用 **messages.id**（
  // emotion_snapshots.after_msg_id 的 FK 指向 messages(id)），取不到就退化成空锚点 ——
  // 不再拿 raw_messages.id 顶替（那会必然 FOREIGN KEY 失败、被 try/catch 吞成 null）。
  // 本例 MAX(raw)=4、messages.id=[1,2]，所以锚点应是 2。
  assert.equal(first.emotion?.applied, true, '情绪副作用应真的生效（不再被静默跳过）');
  const snaps = db.prepare('SELECT after_msg_id, reason FROM emotion_snapshots').all();
  assert.equal(snaps.length, 1, '强制高潮应写入 1 行情绪快照');
  assert.equal(snaps[0].after_msg_id, 2, '锚点应是 messages.id（不是 raw id）');
  assert.match(String(snaps[0].reason || ''), /强制高潮/);
});
