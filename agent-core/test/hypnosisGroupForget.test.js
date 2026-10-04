/**
 * 群聊侧的催眠遗忘 + 群聊「强制高潮」出图回归（task-1）
 *
 * 覆盖三块：
 *   A. **群聊 transcript 屏蔽**：被遗忘时间段（窗口自身的 from_at → to_at）内的群聊 raw
 *      不再进入 `group_transcript`；窗口外照旧；不传区间时与改动前逐字节一致。
 *      区间判定是纯函数 `isRawInTimeRanges`，另单独钉边界（闭区间 / 半开 / 空 created_at）。
 *   B. **群聊长期记忆归档 + 精确恢复**：`forgetWindow` 除私聊记忆外，还按时间区间归档该角色
 *      所在群会话里的长期记忆；`restoreForgottenWindow` 按 memory_ids 精确还原（含群聊侧）。
 *   C. **群聊强制高潮必须出图**：模型不发图时由 `ensureForcedClimaxImage` 兜底补一次，
 *      `image_tasks` 必须出现 status='done' 行（对齐私聊 chat.js 路径 D' 的用户可见结果）。
 *
 * 口径（lead 预冻结，2026-09-29）：群聊侧一律按**时间区间**判定，因为群会话（group_<gid>）与
 * 私聊会话（char_<cid>）是两条独立的 raw_messages 自增序列；且一轮群聊是一次调用演全部角色，
 * 无法按成员分片 ⇒ 「任一成员遗忘该区间即对全体屏蔽」。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import（与其余 hypnosis 测试同口径）。
 * 边界：本模块只服务成年角色档案。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = ':memory:';
// 生图产物目录重定向到临时目录：本文件会走真实的 generateGroupImage 落盘（saveBase64Image），
// 不重定向就会把测试 PNG 写进 agent-core/data/images/chat（违反"仓库不留测试产物"）。
// imagePaths.js 在**模块加载时**读取 IMAGES_DIR，所以必须在任何 import 之前设好。
const TEST_IMAGES_DIR = await mkdtemp(path.join(tmpdir(), 'linshe-gf-images-'));
process.env.IMAGES_DIR = TEST_IMAGES_DIR;
process.on('exit', () => { try { rmSync(TEST_IMAGES_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响测试退出 */ } });
globalThis.fetch = async url => { throw new Error(`group forget fixture forbids network: ${url}`); };

// ── LLM 通道加固（2026-09-30）──
// 本文件所有走模型的轮次都由 deps 注入（chatStream / chatSync / imagePromptChat），**不依赖网络**。
// 血泪教训：兜底出图读的是 `deps.imagePromptChat`（不是 chatSync），只注 chatSync 会漏到真实网关 ——
// 本机 .env 配了可达的真网关，全量回归时真实回复混进 C4（报出拼音 jiǎ）把它打红，单跑却因为
// "这次模型恰好返回空"而全绿。所以 C4 现在**同时断言"走的就是兜底分支"**（raw 花括号逐字节等于兜底文案）。
// ⚠️ 不要在这里给 `config.llm._baseURL` 指本地假上游：空回复会让上层重试链把整个文件拖到分钟级（实测超时）。

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  grantHypnosisPhone, hypnotize, issueCommand, forgetWindow, restoreForgottenWindow,
  listForgottenWindows, collectForgottenWindowsForMembers,
} = await import('../src/services/hypnosisService.js');
const {
  buildGroupContext, isRawInTimeRanges, collectHypnosisDirectiveBlocks,
  ensureForcedClimaxImage, defaultForcedClimaxPrompt, runGroupRound,
} = await import('../src/services/groupChatEngine.js');

// ──────────────── 夹具 ────────────────

/**
 * 时间戳全部显式写死，避免依赖"当前时间"造成秒级边界抖动。
 * 记忆/transcript 的屏蔽区间是 [from_at, to_at]：**落在里面 = 被屏蔽**，
 * 落在外面（更早或更晚）都必须照常保留。
 */
/**
 * 时间基准全部相对"当前 UTC"取，不写死日期——后端时间串是无时区 UTC，写死一个年份（如 2029）
 * 在真实时钟还没走到那年时，会落在窗口右端 datetime('now') **之后**，夹具就变成"窗口外"了。
 *
 *   PAST   ：早于一切（用作 started_at / 区间左端）    → 必须保留
 *   FUTURE ：晚于 now（用作区间右端之外）              → 必须保留
 *   ago(n) ：now - 1 小时，恒落在真实窗口内            → 必须屏蔽
 */
const PAST = '2000-01-01 00:00:00';
const FUTURE = '2099-01-01 00:00:00';

/** now - N 小时（UTC，无时区串） */
function ago(db, hours = 1) {
  return db.prepare("SELECT datetime('now', ?) AS t").get('-' + hours + ' hours').t;
}
/** now（UTC，无时区串） */
function nowUtc(db) {
  return db.prepare("SELECT datetime('now') AS t").get().t;
}
/**
 * 会话起点常量（用于把 started_at 拨到一个明确的过去时刻）。
 * 刻意选得**晚于 PAST**：这样 createdAt=PAST 的 raw 一定落在区间左边之外（应保留）。
 */
const WINDOW_START = '2005-01-01 00:00:00';

/** 一个显式的"被遗忘区间"：左端在 PAST 之后、右端取 now —— ago(1) 必落在里面，PAST 必在外面 */
function rangeAround(db) {
  return { fromAt: WINDOW_START, toAt: nowUtc(db) };
}

function seedCharacter(db, displayName) {
  return Number(db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`gf_${displayName}`, displayName, `你是${displayName}，说话简短。`).lastInsertRowid);
}

function seedGroup(db, { name = '测试群', memberIds = [] } = {}) {
  const groupId = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run(name, '测试话题').lastInsertRowid);
  for (const memberId of memberIds) {
    db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(groupId, memberId);
  }
  return groupId;
}

/** 造一条群聊 raw（created_at 显式给值，便于钉时间区间） */
function seedGroupRaw(db, groupId, { role = 'assistant', content = '', createdAt = FUTURE } = {}) {
  return Number(db.prepare(
    'INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(`group_${groupId}`, role, content, createdAt).lastInsertRowid);
}

function seedMemory(db, { memoryId, conversationId, startRawId, endRawId, judgment = '一段记忆', status = 'active' }) {
  db.prepare(
    `INSERT INTO memory_fragments (memory_id, conversation_id, fragment_type, content, status, memory_type, subject, judgment, source_raw_start_id, source_raw_end_id)
     VALUES (?, ?, 'fact', ?, ?, 'knowledge', 'user', ?, ?, ?)`
  ).run(memoryId, conversationId, judgment, status, judgment, startRawId, endRawId);
  return memoryId;
}

const statusOf = (db, memoryId) => db.prepare('SELECT status FROM memory_fragments WHERE memory_id = ?').get(memoryId)?.status;

// ──────────────── A. 群聊 transcript 屏蔽 ────────────────

test('A1 纯函数 isRawInTimeRanges：闭区间、半开区间、空 created_at、多个区间', () => {
  const w = [{ fromAt: '2026-09-29 10:00:00', toAt: '2026-09-29 11:00:00' }];
  assert.equal(isRawInTimeRanges('2026-09-29 10:00:00', w), true, '左端闭');
  assert.equal(isRawInTimeRanges('2026-09-29 11:00:00', w), true, '右端闭');
  assert.equal(isRawInTimeRanges('2026-09-29 10:30:00', w), true, '区间内');
  assert.equal(isRawInTimeRanges('2026-09-29 09:59:59', w), false, '早于左端');
  assert.equal(isRawInTimeRanges('2026-09-29 11:00:01', w), false, '晚于右端');
  assert.equal(isRawInTimeRanges(null, w), false, 'created_at 为空 → 不屏蔽（宁可不屏也不误屏）');
  assert.equal(isRawInTimeRanges('2026-09-29 10:30:00', []), false);
  assert.equal(isRawInTimeRanges('2026-09-29 12:00:00', [w[0], { fromAt: '2026-09-29 11:30:00', toAt: '2026-09-29 12:30:00' }]), true, '任一区间命中即命中');
  // 只有右端没有左端：等价于"截止到某个时刻"
  assert.equal(isRawInTimeRanges('2000-01-01 00:00:00', [{ toAt: '2026-09-29 11:00:00' }]), true);
});

test('A2 不传 excludeTimeRanges：transcript 与改动前逐字节一致（零行为变化）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [id] });
  seedGroupRaw(db, groupId, { content: '[甲]: 早安', createdAt: PAST });
  seedGroupRaw(db, groupId, { role: 'user', content: '大家早', createdAt: FUTURE });

  const group = { id: groupId, name: '测试群', topic: '', members: [{ id, display_name: '甲', name: 'gf_甲' }] };
  const withDefault = buildGroupContext(group, []);
  const withEmpty = buildGroupContext(group, [], { excludeTimeRanges: [] });
  const transcriptOf = msgs => msgs.find(m => String(m.content).startsWith('<group_transcript>')).content;
  assert.equal(transcriptOf(withDefault), transcriptOf(withEmpty), '不传区间 === 传空数组');
  assert.ok(transcriptOf(withDefault).includes('[甲]: 早安'));
  assert.ok(transcriptOf(withDefault).includes('大家早'));
});

test('A3 遗忘窗口内的群聊 raw 不再进入 <group_transcript>，窗口外的仍在', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [id] });
  const beforeId = seedGroupRaw(db, groupId, { content: '[甲]: 很久以前', createdAt: PAST });
  const insideId = seedGroupRaw(db, groupId, { content: '[甲]: 被遗忘期间的发言', createdAt: ago(db, 1) });
  const afterId = seedGroupRaw(db, groupId, { role: 'user', content: '后来的发言', createdAt: FUTURE });

  const group = { id: groupId, name: '测试群', topic: '', members: [{ id, display_name: '甲', name: 'gf_甲' }] };
  const ranges = [{ characterId: id, windowId: 1, ...rangeAround(db) }];
  const msgs = buildGroupContext(group, [], { excludeTimeRanges: ranges });
  const transcript = msgs.find(m => String(m.content).startsWith('<group_transcript>')).content;
  assert.ok(!transcript.includes('被遗忘期间的发言'), '窗口内的 raw 必须被屏蔽');
  assert.ok(transcript.includes('很久以前'), '窗口左侧（更早）的仍在');
  assert.ok(transcript.includes('后来的发言'), '窗口右侧（更晚）的仍在');
  // 屏蔽只作用于"喂给模型的文本"：库里原记录一条都不能少（可审计、可撤销）
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`group_${groupId}`).n, 3);
  assert.deepEqual([beforeId, insideId, afterId].every(Number.isInteger), true);
});

test('A4 群成员真的遗忘后，buildGroupContext 自动屏蔽该区间（端到端：forgetWindow → 上下文）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [id] });
  // "催眠期间在群里说过话"的 raw：时间点取 now-1h（与真实时钟无关地落在窗口内），
  // 并把会话起点拨到更早，模拟真实的「催眠开始 → 群里发言 → 点遗忘」时序。
  seedGroupRaw(db, groupId, { content: '[甲]: 催眠期间的群聊内容', createdAt: ago(db, 1) });
  grantHypnosisPhone();
  hypnotize(id, { minutes: 60 });
  db.prepare('UPDATE character_hypnosis SET started_at = ? WHERE character_id = ?').run(WINDOW_START, id);

  const group = { id: groupId, name: '测试群', topic: '', members: [{ id, display_name: '甲', name: 'gf_甲' }] };
  const before = buildGroupContext(group, [])
    .find(m => String(m.content).startsWith('<group_transcript>')).content;
  assert.ok(before.includes('催眠期间的群聊内容'), '遗忘之前它当然在 transcript 里');

  forgetWindow(id, {});

  const after = buildGroupContext(group, [])
    .find(m => String(m.content).startsWith('<group_transcript>')).content;
  assert.ok(!after.includes('催眠期间的群聊内容'), '遗忘之后不再进入群 transcript');
});

test('A5 批量窗口查询 + 总开关关闭时零屏蔽', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  const w = forgetWindow(a, {});

  const windows = collectForgottenWindowsForMembers([a, b, 'x', 0, null]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].characterId, a);
  assert.equal(windows[0].windowId, w.windowId);
  assert.ok(windows[0].fromAt && windows[0].toAt, '必须带上窗口自己的 from_at / to_at');
  assert.deepEqual(collectForgottenWindowsForMembers([]), []);
  assert.deepEqual(collectForgottenWindowsForMembers([b]), [], '没有窗口的成员不产出');

  const saved = config.features.hypnosis;
  config.features = { ...config.features, hypnosis: false };
  try {
    assert.deepEqual(collectForgottenWindowsForMembers([a]), [], '总开关关闭 ⇒ 不查库、零屏蔽');
  } finally {
    config.features = { ...config.features, hypnosis: saved };
  }
});

// ──────────────── B. 群聊长期记忆归档 + 精确恢复 ────────────────

test('B1 forgetWindow 归档窗口内的**群聊**长期记忆，窗口外/别的群/非成员都不动', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const other = seedCharacter(db, '丙');
  const groupId = seedGroup(db, { memberIds: [a] });
  const insideRaw = seedGroupRaw(db, groupId, { content: '[甲]: 被遗忘期间', createdAt: ago(db, 1) });
  const outsideRaw = seedGroupRaw(db, groupId, { content: '[甲]: 更早以前', createdAt: PAST });

  // 甲所在群、落在窗口内 → 必须归档
  seedMemory(db, { memoryId: 'gf_inside', conversationId: `group_${groupId}`, startRawId: insideRaw, endRawId: insideRaw });
  // 甲所在群、但源 raw 早于催眠开始 → 不动
  seedMemory(db, { memoryId: 'gf_outside', conversationId: `group_${groupId}`, startRawId: outsideRaw, endRawId: outsideRaw });
  // 别群（甲不是成员）→ 不动
  const otherGroupId = seedGroup(db, { name: '别人的群', memberIds: [other] });
  const otherRaw = seedGroupRaw(db, otherGroupId, { content: '[丙]: 另一个群', createdAt: ago(db, 1) });
  seedMemory(db, { memoryId: 'gf_other_group', conversationId: `group_${otherGroupId}`, startRawId: otherRaw, endRawId: otherRaw });
  // 甲自己的私聊记忆 → 走原口径（这里源 raw 不存在，不应被误归档）
  seedMemory(db, { memoryId: 'gf_private', conversationId: `char_${a}`, startRawId: 9999, endRawId: 9999 });

  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  // 把会话起点拨到窗口内 raw 之前：模拟"催眠开始 → 群里发言 → 点遗忘"的真实时序
  db.prepare('UPDATE character_hypnosis SET started_at = ? WHERE character_id = ?').run(WINDOW_START, a);
  const result = forgetWindow(a, {});

  assert.equal(statusOf(db, 'gf_inside'), 'archived', '窗口内的群聊记忆必须归档');
  assert.equal(statusOf(db, 'gf_outside'), 'active', '窗口外的群聊记忆不动');
  assert.equal(statusOf(db, 'gf_other_group'), 'active', '不是成员所在的群，不能碰');
  assert.equal(statusOf(db, 'gf_private'), 'active', '无 raw 锚点/不在私聊区间内的记忆不动');

  const win = listForgottenWindows(a).find(x => x.id === result.windowId);
  assert.ok(win.memoryIds.includes('gf_inside'), 'memory_ids 必须精确记下群聊侧被归档的记忆');
  assert.equal(win.memoriesArchived, 1);
});

test('B2 restoreForgottenWindow 按 memory_ids 精确还原群聊记忆，且不误伤同区间无关归档', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [a] });
  const insideRaw = seedGroupRaw(db, groupId, { content: '[甲]: 被遗忘期间', createdAt: ago(db, 1) });
  seedMemory(db, { memoryId: 'gf_inside2', conversationId: `group_${groupId}`, startRawId: insideRaw, endRawId: insideRaw });
  // 同一区间里"因为别的原因"已经归档的记忆：不在 memory_ids 里，恢复时绝不能被顺手还原
  seedMemory(db, { memoryId: 'gf_unrelated', conversationId: `group_${groupId}`, startRawId: insideRaw, endRawId: insideRaw, status: 'archived' });

  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  db.prepare('UPDATE character_hypnosis SET started_at = ? WHERE character_id = ?').run(WINDOW_START, a);
  const result = forgetWindow(a, {});
  assert.equal(statusOf(db, 'gf_inside2'), 'archived');

  const restored = restoreForgottenWindow(result.windowId, { characterId: a });
  assert.equal(restored.restored, 1, '只还原 memory_ids 里的那一条');
  assert.equal(statusOf(db, 'gf_inside2'), 'active', '群聊记忆被精确还原');
  assert.equal(statusOf(db, 'gf_unrelated'), 'archived', '同区间的无关归档不受影响');
  assert.equal(restored.window.status, 'restored');
  assert.equal(listForgottenWindows(a).length, 0, 'restored 之后不再出现在 active 列表 ⇒ 群聊屏蔽随之解除');
});

// ──────────────── C. 群聊「强制高潮」必须出图 ────────────────

test('C1 强制高潮的硬指令：要求点名角色本轮发出图行，并记录成员供出图兜底', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  issueCommand(a, 'forced_climax');

  const { blocks, forcedClimax } = collectHypnosisDirectiveBlocks([{ id: a, display_name: '甲' }]);
  assert.deepEqual(forcedClimax, [{ id: a, name: '甲' }]);
  const imageBlock = blocks.find(b => b.includes('<forced_climax_image>'));
  assert.ok(imageBlock, '必须带一块"本轮必须发图行"的硬指令');
  assert.ok(imageBlock.includes('甲'), '要点名到被下令的角色');
  assert.ok(imageBlock.includes('{'), '要给出合法发图行的形态');
});

test('C2 模型不发图时兜底出图：image_tasks 出现 status=done 行（对齐私聊路径 D\'）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  const groupId = seedGroup(db, { memberIds: [a, b] });
  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  issueCommand(a, 'forced_climax');

  // 剧本里只有台词，**没有**任何发图行（模拟模型没听话）
  const script = ['甲: 嗯……', '乙: 你怎么了', '[END]'].join('\n') + '\n';
  const generated = [];
  const result = await runGroupRound(groupId, {
    trigger: 'user',
    userMessage: '继续',
    emit: () => {},
    deps: {
      chatStream: async function* () { yield script; },
      chatSync: async () => { throw new Error('本用例外层不允许调用模型'); },
      generateImage: async (prompt) => {
        generated.push(prompt);
        return {
          success: true,
          images: [{ filename: 'gf_test.png', base64: 'data:image/png;base64,AAAA' }],
          wfMode: 'turbo',
        };
      },
    },
  });

  assert.ok(result.rawId, '这一轮必须落库了 raw');
  const done = db.prepare(`SELECT * FROM image_tasks WHERE conversation_id = ? AND status = 'done'`).all(`group_${groupId}`);
  assert.equal(done.length, 1, '必须真的生成了一张图（image_tasks.status=done）');
  assert.ok(generated.length === 1, '生图执行器被调用一次');
  assert.ok(generated[0].trim().length > 0, '画面描述不能是空串');
  // 兜底出图必须写回 raw：下一轮 transcript 里才有这张图的记录
  const raw = db.prepare('SELECT content FROM raw_messages WHERE id = ?').get(result.rawId).content;
  assert.ok(raw.includes('{'), 'raw 剧本里应补上发图行');
  // 图挂在被下令角色自己的气泡上
  const imgMsg = db.prepare('SELECT speaker_character_id, images FROM messages WHERE conversation_id = ? AND images IS NOT NULL')
    .get(`group_${groupId}`);
  assert.ok(imgMsg, '应有气泡承载图片');
  assert.equal(Number(imgMsg.speaker_character_id), a);
});

test('C3 模型自己发了图则不重复兜底（保持一轮一张，不翻倍）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [a] });
  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  issueCommand(a, 'forced_climax');

  const script = ['甲: 给你们看', '甲: {a girl in a yukata holding a sparkler, warm lantern light}', '[END]'].join('\n') + '\n';
  const generated = [];
  await runGroupRound(groupId, {
    trigger: 'user',
    userMessage: '继续',
    emit: () => {},
    deps: {
      chatStream: async function* () { yield script; },
      chatSync: async () => { throw new Error('已经发图了，不该再要画面描述'); },
      generateImage: async (prompt) => {
        generated.push(prompt);
        return { success: true, images: [{ filename: 'gf_test2.png', base64: 'data:image/png;base64,AAAA' }], wfMode: 'turbo' };
      },
    },
  });

  assert.equal(generated.length, 1, '模型自己发的图只算一次，兜底不能再补一张');
  const done = db.prepare(`SELECT COUNT(*) AS n FROM image_tasks WHERE conversation_id = ? AND status = 'done'`).get(`group_${groupId}`).n;
  assert.equal(done, 1);
});

test('C4 兜底画面描述：模型返回空串时也有可用的英文描述（生图管线不收到空 prompt）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const groupId = seedGroup(db, { memberIds: [a] });
  grantHypnosisPhone();
  hypnotize(a, { minutes: 60 });
  issueCommand(a, 'forced_climax');

  const generated = [];
  await runGroupRound(groupId, {
    trigger: 'user',
    userMessage: '继续',
    emit: () => {},
    deps: {
      chatStream: async function* () { yield '甲: 嗯\n[END]\n'; },
      // ⚠️ 兜底路径读的是 `deps.imagePromptChat`（不是 `deps.chatSync`，见 ensureForcedClimaxImage），
      // 只注 chatSync 会漏到真实网关 ⇒ 曾经全量回归时混进真实描述（拼音 jiǎ）把断言打红。
      imagePromptChat: async () => '',   // 模型连续两次都不给内容 ⇒ requestNonEmptyImagePrompt 返回空串
      chatSync: async () => '',
      generateImage: async (prompt) => {
        generated.push(prompt);
        return { success: true, images: [{ filename: 'gf_test3.png', base64: 'data:image/png;base64,AAAA' }], wfMode: 'turbo' };
      },
    },
  });

  const fallback = defaultForcedClimaxPrompt({ display_name: '甲' });
  assert.ok(generated.length === 1, '仍必须发起一次生图');
  // 生图管线自己会再过一遍 prepareImagePrompt（画面知识库补全），所以这里断言"喂进去的不是空串"
  // 且是一段真实描述，而不是逐字节相等。
  assert.ok(generated[0].trim().length > 0, '生图管线绝不能收到空 prompt');
  assert.ok(String(generated[0]).trim().length >= 20, '生图请求应是一段真实画面描述，不是一两个词');

  // task-5 口径：兜底描述必须**纯 ASCII 英文、不拼角色名**。
  // 理由：这一串会经 formatGroupImageLine 写成「名字: {描述}」落进 raw，下一轮 transcript 里模型看到的是
  // 花括号全文 —— 拼中文 display_name 就与"花括号内必须是全英文画面描述"的协议冲突，模型会照抄中文。
  // 角色身份已由生图管线负责（强制注入发图者 LoRA + applyGroupImageNameFallback 用 speaker.name 前置）。
  const isAscii = s => [...String(s)].every(ch => ch.charCodeAt(0) < 128);
  assert.ok(isAscii(fallback), `兜底描述必须是纯 ASCII：${fallback}`);
  assert.ok(!fallback.includes('甲'), '兜底描述不得拼角色显示名（身份由生图管线负责）');
  assert.ok(fallback.includes('intimate scene'), '兜底描述要保留画面关键词，便于画面知识库命中');

  // 用户可见后果：raw 的花括号里也不能出现中文
  const rawRow = db.prepare('SELECT content FROM raw_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
    .get(`group_${groupId}`);
  const braces = String(rawRow?.content || '').match(/\{([^{}]*)\}/);
  assert.ok(braces, 'raw 里应补出发图行');
  // 先钉住"走的是兜底分支"（raw 花括号里逐字节等于兜底文案），再谈 ASCII —— 否则模型真回复混进来时
  // 断言会以"ASCII 失败"的形式报警，掩盖真因（注入键写错 ⇒ 漏到真实网关）。
  assert.equal(braces[1], fallback, 'raw 花括号里必须是兜底文案（证明兜底分支被走到，而不是拿到模型回复）');
  assert.ok(!/[\u4e00-\u9fff]/.test(braces[1]), `raw 花括号内容不得含中文：${braces[1]}`);
  assert.ok(isAscii(braces[1]), `raw 花括号内容必须是纯 ASCII：${braces[1]}`);
  const done = db.prepare(`SELECT COUNT(*) AS n FROM image_tasks WHERE conversation_id = ? AND status = 'done'`).get(`group_${groupId}`).n;
  assert.equal(done, 1);
});

test('C5 本轮第一行就是发图行时：所有气泡的 seq 严格递增且不重复（task-5 回归）', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const a = seedCharacter(db, '甲');
  const b = seedCharacter(db, '乙');
  const groupId = seedGroup(db, { memberIds: [a, b] });

  // 剧本**第一行**就是发图行：此刻还没有任何文字气泡，必须新建一条空文本气泡承载图片。
  // task-1 把这段搬进 emitGroupImageFor 时漏了外层 seq++，会让紧随其后的文字气泡拿到重复 seq。
  const script = [
    '甲: {a girl in a yukata holding a sparkler, warm lantern light}',
    '乙: 好看',
    '甲: 谢谢',
    '[END]',
  ].join('\n') + '\n';
  const generated = [];
  await runGroupRound(groupId, {
    trigger: 'user',
    userMessage: '继续',
    emit: () => {},
    deps: {
      chatStream: async function* () { yield script; },
      chatSync: async () => { throw new Error('本轮没有强制高潮，不该请求兜底画面描述'); },
      generateImage: async (prompt) => {
        generated.push(prompt);
        return { success: true, images: [{ filename: 'gf_seq.png', base64: 'data:image/png;base64,AAAA' }], wfMode: 'turbo' };
      },
    },
  });

  const rows = db.prepare('SELECT id, seq, speaker_character_id, content, images FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(`group_${groupId}`);
  assert.ok(rows.length >= 3, `应至少有 3 条气泡（图片承接 + 2 条文字），实际 ${rows.length}`);

  // 核心断言：seq 严格递增且不重复（旧 refactor 下第 1、2 条会都是 0）
  const seqs = rows.map(r2 => Number(r2.seq));
  assert.equal(new Set(seqs).size, seqs.length, `seq 不能重复：${JSON.stringify(seqs)}`);
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `seq 必须严格递增：${JSON.stringify(seqs)}`);
  }

  // 顺序与归属不变：首条是承载图片的空文本气泡（归甲），后面两条文字属乙、甲
  assert.equal(Number(rows[0].speaker_character_id), a, '首条气泡（承载图片）应归甲');
  assert.ok(rows[0].images, '首条气泡应带图');
  assert.equal(rows[0].content, '', '承载图片的首条气泡是空文本气泡');
  assert.equal(Number(rows[1].speaker_character_id), b, '第二条文字应属乙');
  assert.equal(Number(rows[2].speaker_character_id), a, '第三条文字应属甲');
  assert.equal(generated.length, 1, '本轮图片真的生成了');
});

