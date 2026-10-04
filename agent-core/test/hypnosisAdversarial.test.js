/**
 * 催眠手机 · 对抗式独立验收（非作者视角）
 *
 * 这份文件刻意**不重复** test/hypnosisService.test.js 的用例，专挑作者没测的接缝：
 *   - 惰性过期的旁路（不只看 getHypnosisState：forgetWindow / 指令）
 *   - 一次性指令的漏水（重复消费、陈旧 pending_at 无 TTL）
 *
 * 2026-09-28 补（用户裁决「按你推荐来吧」）：`consumePendingDirective` / `getPendingDirective`
 * 已自己带过期判定（读取侧收口），对应的【缺陷复现】用例已翻转为正确行为断言；
 * `forgetWindow` 的过期判断**留档不修**，理由写在该用例的注释里。
 *   - filterForgottenRawIds 的语义陷阱（它返回"仍可见"而不是"被隐藏"，反向接线会全反）
 *   - 遗忘窗口极端形态、恢复的越权/幂等、门控边界、scene 回归、总开关下的写路径
 *
 * 约定：断言"正确行为"的用例名不带前缀；断言当前**缺陷实际行为**的用例名带【缺陷复现】，
 * 并在注释里写清期望行为 —— 这类用例在缺陷修复后必须同步更新；纯观察项带【观察】。
 *
 * 全部内存库 + 禁网，不调模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`hypnosis adversarial fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  getHypnosisState, isHypnotized, isBodyControlled, isMindAwake, getPendingDirective,
  consumePendingDirective, hypnotize, wake, issueCommand, forgetWindow,
  listForgottenWindows, restoreForgottenWindow, isRawForgotten, filterForgottenRawIds,
  getHypnosisGate, grantHypnosisPhone,
  HYPNOSIS_MIN_MINUTES, HYPNOSIS_MAX_MINUTES, HYPNOSIS_DEFAULT_MINUTES,
} = await import('../src/services/hypnosisService.js');
const { saveAffinity, setOath } = await import('../src/services/emotionEngine.js');
const { listIntimateLogs, recordIntimateActs, SCENES } = await import('../src/services/intimateService.js');
const { getSplitHistory } = await import('../src/services/contextAssembler.js');

/** 干净库 + 角色（id 固定 1；需要第二个角色时传 withSecond） */
function seed(t, { phone = true, affinity = 100, oath = true, withSecond = false } = {}) {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'hypno', '催眠测试', '旅客')`).run();
  if (withSecond) {
    db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (2, 'other', '另一个', '旅客')`).run();
    if (phone) grantHypnosisPhone();
    saveAffinity(2, 100, false);
    setOath(2, 1);
  }
  if (phone) grantHypnosisPhone();
  if (affinity != null) saveAffinity(1, affinity, false);
  if (oath) setOath(1, 1);
  return 1;
}

function seedRaw(conversationId, role, content, createdAt = null) {
  const db = getDb();
  if (createdAt) {
    return Number(db.prepare(
      `INSERT INTO raw_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`
    ).run(conversationId, role, content, createdAt).lastInsertRowid);
  }
  return Number(db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`
  ).run(conversationId, role, content).lastInsertRowid);
}

function seedMemory({ memoryId, conversationId, startRawId, endRawId, status = 'active' }) {
  getDb().prepare(
    `INSERT INTO memory_fragments
       (memory_id, conversation_id, fragment_type, content, status, memory_type, subject, judgment,
        source_raw_start_id, source_raw_end_id)
     VALUES (?, ?, 'fact', ?, ?, 'knowledge', 'user', ?, ?, ?)`
  ).run(memoryId, conversationId, `记忆 ${memoryId}`, status, `记忆内容 ${memoryId}`, startRawId, endRawId);
}

/** 手工插入一条遗忘窗口（memory_ids 用 JSON.stringify，避免引号被外层吃掉） */
function seedWindow({ characterId = 1, fromRawId, toRawId, memoryIds = [], status = 'active' }) {
  return Number(getDb().prepare(
    `INSERT INTO hypnosis_forgotten_windows
       (character_id, from_raw_id, to_raw_id, memory_ids, memories_archived, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(characterId, fromRawId, toRawId, JSON.stringify(memoryIds), memoryIds.length, status).lastInsertRowid);
}

/** 关键表的行数快照：用于"被拒时是否真的零写入" */
function snapshotTables() {
  const db = getDb();
  const tables = ['character_hypnosis', 'hypnosis_forgotten_windows', 'memory_fragments', 'character_intimate_log', 'backpack_items'];
  const out = {};
  for (const table of tables) out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  return out;
}

/** 把状态行拨到"已过期"（不改 started_at：遗忘窗口左端要用它） */
function forceExpired(characterId = 1) {
  getDb().prepare(
    `UPDATE character_hypnosis SET active_until = datetime('now', '-5 minutes') WHERE character_id = ?`
  ).run(characterId);
}

// ──────────────── 门控 ────────────────

test('门控只剩「持有手机」一态：allowed ⇔ code===\'ok\'，被拒时全表零写入', async t => {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'hypno', '催眠测试', '旅客')`).run();
  setOath(1, 1);

  const cases = [
    { phone: false, affinity: 100, oath: true, code: 'no_phone' },
    { phone: true, affinity: 0, oath: true, code: 'ok', note: '好感度门槛已移除：0 好感也放行' },
    { phone: true, affinity: 100, oath: false, code: 'ok', note: '誓约门槛已移除：未誓约也放行' },
    { phone: true, affinity: 5, oath: true, code: 'ok' },
  ];
  for (const item of cases) {
    // 先把环境摆好（发道具/设好感/设誓约），再快照——否则快照里会包含"发道具"这一步的写入
    if (item.phone) grantHypnosisPhone();
    saveAffinity(1, item.affinity, false);
    setOath(1, item.oath ? 1 : 0);
    const before = snapshotTables();
    const gate = getHypnosisGate(1);
    assert.equal(gate.code, item.code, `affinity=${item.affinity} oath=${item.oath} phone=${item.phone}`);
    assert.equal(gate.allowed, gate.code === 'ok', 'allowed 必须与 code 严格等价');
    assert.equal(gate.isOath, Boolean(item.oath), 'isOath 仍是展示字段，不参与判定');
    if (gate.code !== 'ok') {
      assert.throws(() => hypnotize(1, { minutes: 30 }), err => err.code === 'GATE');
      assert.deepEqual(snapshotTables(), before, `被拒后不该有任何表写入（${gate.code}）`);
    }
  }
  // 达标后才写
  const state = hypnotize(1, { minutes: 30 });
  assert.equal(state.active, true);
  assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM character_hypnosis').get().n) === 1);
});

test('好感度与誓约都已不参与门控：0.4 好感 + 未誓约照样放行', async t => {
  seed(t, { affinity: 0.4, oath: false });
  const gate = getHypnosisGate(1);
  assert.equal(gate.affinity, 0, 'Math.round(0.4) = 0，只作展示字段');
  assert.equal(gate.isOath, false, 'isOath 只作展示字段');
  assert.equal(gate.code, 'ok',
    '好感度（2026-09-28 用户「不要好感度限制 直接给吧」）与誓约（同日「契约也不用 直接强制使用」）都不再参与判定');
});

// ──────────────── 正交状态 / 再次催眠 ────────────────

test('正交状态：wake(mind) 后再次 hypnotize 必须清掉意志清醒态，且不留旧指令', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  wake(1, { mode: 'mind' });
  assert.equal(isMindAwake(1), true);
  assert.equal(isBodyControlled(1), true);

  issueCommand(1, 'body_control'); // 留一条未消费的指令
  const again = hypnotize(1, { minutes: 30 });
  assert.equal(again.mindAwake, false, '再次催眠必须把意志打回沉睡');
  assert.equal(again.bodyControlled, true);
  assert.equal(again.pendingDirective, '', '重新开始一次不该继承上一次的待执行指令');
  assert.equal(getPendingDirective(1), '');
  // 文案侧也必须跟着变回"深度催眠"
  assert.equal(getHypnosisState(1).lastCommand, 'hypnotize');
});

test('wake(mind) 在"已过期"时按未催眠处理（409 语义），且不写 pending', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  forceExpired();
  assert.throws(() => wake(1, { mode: 'mind' }), err => err.code === 'NOT_HYPNOTIZED');
  const row = getDb().prepare('SELECT * FROM character_hypnosis WHERE character_id = 1').get();
  assert.equal(row.body_controlled, 0, '惰性过期已落库归零');
  assert.equal(row.pending_directive, '');
});

// ──────────────── 惰性过期的旁路 ────────────────

test('过期后 issueCommand 必须拒绝且不写指令；重新催眠可恢复', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  forceExpired();
  assert.throws(() => issueCommand(1, 'body_control'), err => err.code === 'NOT_HYPNOTIZED');
  assert.equal(getDb().prepare(`SELECT pending_directive FROM character_hypnosis WHERE character_id = 1`).get().pending_directive, '');
  assert.equal(isHypnotized(1), false);

  const revived = hypnotize(1, { minutes: 15 });
  assert.equal(revived.active, true);
  assert.equal(revived.mindAwake, false);
});

test('【缺陷复现】forgetWindow 不做过期判断：过期很久后仍能用旧 started_at 建遗忘窗口', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  // 会话在 2 天前就已过期。
  // ⚠️ 旧的 started_at 必须**先取一次复用**：断言处不要再重新 datetime('now','-2 days') 算一遍，
  // 两次运算跨过秒边界就会差 1 秒（全量回归里偶发红灯，与业务行为无关，纯粹是这条断言的竞态）。
  const staleAt = getDb().prepare(`SELECT datetime('now', '-2 days') AS t`).get().t;
  getDb().prepare(
    `UPDATE character_hypnosis SET started_at = ?, active_until = datetime('now', '-2 days') WHERE character_id = 1`
  ).run(staleAt);
  assert.equal(getHypnosisState(1).active, false, '读 state 已视为解除');

  // 期望：过期会话应视为"没有可遗忘的会话"（NO_SESSION）；实际：照样建窗口。
  // 2026-09-28 裁决：**留档不修**。理由：① UI 不可达 —— 面板「遗忘」由 matrix.forget = gateOk && view.active
  // 控制，后端一上报 active:false 按钮就置灰，真实竞态受面板轮询间隔限制（窗口右端 ≈ 会话结束时刻）；
  // ② 只有直连 API 能构造"2 天前的旧会话建窗口"；③ 修法（改判 NO_SESSION）会动到"同一区间可重复遗忘"
  // 这一被 hypnosisService.test.js 与本文件多处依赖的既有语义，收益不抵改动面。日后要修先定这两种语义取哪个。
  const forgotten = forgetWindow(1);
  assert.ok(forgotten.windowId > 0);
  const win = listForgottenWindows(1)[0];
  assert.equal(win.fromAt, staleAt, '窗口左端是 2 天前的旧 started_at');
  assert.equal(win.status, 'active', '窗口立刻生效：这 2 天的历史会被整段屏给模型');
});

test('consumePendingDirective / getPendingDirective 自带过期判定，不依赖调用顺序', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  forceExpired();

  // chat.js 的真实顺序：先 getHypnosisState（惰性过期会顺手清空 pending）→ 再 consume
  const stateFirst = getHypnosisState(1);
  assert.equal(stateFirst.active, false);
  assert.equal(consumePendingDirective(1), '', '有 state 读在前时不会漏');

  // service 层单独调用（或将来有人调整调用顺序）同样不会漏：两个入口自己先过期
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  forceExpired();
  assert.equal(getPendingDirective(1), '', '只读入口也不吐陈旧指令');
  assert.equal(consumePendingDirective(1), '', '过期即视为已解除 → 返回空串');
  const row = getDb().prepare(
    'SELECT pending_directive, pending_at, body_controlled, active_until FROM character_hypnosis WHERE character_id = 1'
  ).get();
  assert.equal(row.pending_directive, '', '过期清扫已把 pending 落库清空');
  assert.equal(row.pending_at, null);
  assert.equal(row.body_controlled, 0);
  assert.equal(row.active_until, null);
});

test('一次性指令的生命周期 = 会话生命周期：会话过期即作废（pending_at 本身不参与判定，留档）', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  // pending_at 只是留痕：会话还在时，陈旧 pending_at 不影响注入 —— 这条是留档的既有语义，
  // 不是漏（真实上限由催眠时长兜住：hypnotize 的 minutes 被 clamp 到 720 分钟）。
  getDb().prepare(
    `UPDATE character_hypnosis SET pending_at = datetime('now', '-10 days') WHERE character_id = 1`
  ).run();
  assert.equal(getHypnosisState(1).active, true, '会话本身还在（active_until 未过期）');
  assert.equal(consumePendingDirective(1), 'forced_climax', 'pending_at 不参与判定');

  // 真正的边界：会话一过期，指令立刻作废 —— "陈旧指令"最多陈旧 12 小时，
  // 不存在"下了指令、十天不聊、某天突然生效"的路径。
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  forceExpired();
  assert.equal(consumePendingDirective(1), '', '会话过期 → 指令作废');
});

test('一次性指令只被消费一次；恢复遗忘写入的 memory_restore 同样是一次性的', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'body_control');
  assert.equal(consumePendingDirective(1), 'body_control');
  assert.equal(consumePendingDirective(1), '', '同一次组装里调两次不会读到两遍');
  assert.equal(getPendingDirective(1), '');

  const wid = seedWindow({ fromRawId: 1, toRawId: 2 });
  restoreForgottenWindow(wid, { characterId: 1 });
  assert.equal(consumePendingDirective(1), 'memory_restore');
  assert.equal(consumePendingDirective(1), '');
});

// ──────────────── filterForgottenRawIds 的语义陷阱 ────────────────

test('filterForgottenRawIds 返回"仍可见"；getSplitHistory 的 excludeWindows 必须用窗口区间（反向接线会全反）', async t => {
  seed(t);
  const conv = 'char_1';
  const ids = [];
  for (let i = 1; i <= 6; i++) {
    ids.push(seedRaw(conv, i % 2 === 1 ? 'user' : 'assistant', `msg-${i}`));
  }
  const window = { fromRawId: ids[2], toRawId: ids[3] }; // 屏蔽 msg-3 / msg-4
  seedWindow({ fromRawId: window.fromRawId, toRawId: window.toRawId });

  const db = getDb();
  // ① 正确方向：把窗口区间喂给 excludeWindows
  const correct = getSplitHistory(db, conv, 10, 10, {
    excludeWindows: listForgottenWindows(1).map(w => ({ fromRawId: w.fromRawId, toRawId: w.toRawId })),
  });
  assert.match(correct.activeText, /msg-1/);
  assert.match(correct.activeText, /msg-2/);
  assert.match(correct.activeText, /msg-5/);
  assert.match(correct.activeText, /msg-6/);
  assert.ok(!correct.activeText.includes('msg-3'), '窗口内的 raw 不该进上下文');
  assert.ok(!correct.activeText.includes('msg-4'));

  // ② 陷阱演示：filterForgottenRawIds 返回的是"仍可见"的 id，
  //    把它当 excludeWindows 用就正好屏蔽掉可见的、留下被遗忘的
  const visible = filterForgottenRawIds(1, ids);
  assert.deepEqual(visible, [ids[0], ids[1], ids[4], ids[5]], '语义确认：返回的是仍可见 id');
  const inverted = getSplitHistory(db, conv, 10, 10, {
    excludeWindows: visible.map(id => ({ fromRawId: id, toRawId: id })),
  });
  assert.match(inverted.activeText, /msg-3/, '反向接线后：被遗忘的内容反而进了上下文');
  assert.match(inverted.activeText, /msg-4/);
  assert.ok(!inverted.activeText.includes('msg-1'), '而本该保留的被屏蔽');
});

test('源码级接线检查：chat.js 用 listForgottenWindows 造窗口，且没有把 filterForgottenRawIds 当 excludeWindows', async t => {
  const chatSource = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.match(chatSource, /listForgottenWindows\(characterId\)/);
  assert.match(chatSource, /excludeWindows:\s*hypnoExcludeWindows/);
  assert.ok(!chatSource.includes('filterForgottenRawIds'), '一旦有人把 filter 的输出接进 excludeWindows，就会整段屏蔽反掉');
});

test('getSplitHistory 的"末尾未回复 user 永远保留"例外：构造可见，但生产流程不可达', async t => {
  seed(t);
  const conv = 'char_1';
  const r1 = seedRaw(conv, 'user', 'old-user');
  const r2 = seedRaw(conv, 'assistant', 'old-assistant');
  const r3 = seedRaw(conv, 'user', 'inside-window-user'); // 落在窗口里的"当前输入"
  seedWindow({ fromRawId: r1, toRawId: r3 });

  const db = getDb();
  const windows = listForgottenWindows(1).map(w => ({ fromRawId: w.fromRawId, toRawId: w.toRawId }));
  const built = getSplitHistory(db, conv, 10, 10, { excludeWindows: windows });
  // "当前输入"被追加在 checkpointHistory 末尾（tailMsgs），不在 activeText 里
  const historyText = built.checkpointHistory.map(m => m.content).join('\n');
  assert.ok(historyText.includes('inside-window-user'), '末尾未回复的 user 是显式例外（当前输入必须保留）');
  assert.ok(!historyText.includes('old-user'));
  assert.ok(!historyText.includes('old-assistant'));
  assert.ok(!built.activeText.includes('old-user'), '窗口内的历史不进 activeText');

  // 可达性论证：真实流程里"当前输入"是遗忘之后新插入的 raw，id 必然大于窗口右端
  const after = listForgottenWindows(1)[0];
  const fresh = seedRaw(conv, 'user', 'fresh-input');
  assert.ok(fresh > after.toRawId, '遗忘之后的新输入一定在窗口之外 → 例外不会泄漏被遗忘内容');
});

// ──────────────── 窗口极端形态 ────────────────

test('窗口极端形态：空区间 / from>to / 重叠 / 先遗忘再催眠再遗忘', async t => {
  seed(t);
  const conv = 'char_1';
  // 显式时间戳：SQLite 的 datetime('now') 只到秒，同一秒内的 raw 分不出窗口边界
  const r1 = seedRaw(conv, 'user', 'a', '2026-01-01 00:00:01');
  const r2 = seedRaw(conv, 'assistant', 'b', '2026-01-01 00:00:02');
  const r3 = seedRaw(conv, 'user', 'c', '2026-01-01 00:00:03');

  // ① 空区间（from = maxId+1, to = maxId）：不覆盖任何 raw，但留审计行
  const empty = seedWindow({ fromRawId: r3 + 1, toRawId: r3 });
  assert.equal(isRawForgotten(1, r1), false);
  assert.equal(isRawForgotten(1, r3 + 1), false, 'from>to 的窗口不该命中任何 id');

  // ② from > to（人为脏数据）也不该命中或抛错
  seedWindow({ fromRawId: 900, toRawId: 100 });
  assert.equal(isRawForgotten(1, 900), false);
  assert.deepEqual(filterForgottenRawIds(1, [r1, r2, r3]), [r1, r2, r3]);

  // ③ 重叠窗口 = 并集
  seedWindow({ fromRawId: r1, toRawId: r2 });
  seedWindow({ fromRawId: r2, toRawId: r3 });
  assert.equal(isRawForgotten(1, r1), true);
  assert.equal(isRawForgotten(1, r2), true);
  assert.equal(isRawForgotten(1, r3), true);
  assert.deepEqual(filterForgottenRawIds(1, [r1, r2, r3]), []);

  // ④ 先遗忘再催眠再遗忘：两个窗口叠加且列表自洽（raw-id 口径：
  //    窗口左端 = session_start_raw_id + 1，与时间戳无关）
  hypnotize(1, { minutes: 30 }); // session_start_raw_id = r3（当时会话最大 raw）
  const first = forgetWindow(1); // 该区间没有 raw → 空窗口
  assert.equal(getHypnosisState(1).active, false, '遗忘即结束控制');
  const r4 = seedRaw(conv, 'assistant', 'd', '2026-01-01 00:00:10'); // 两次催眠之间的消息（她清醒自由时）
  hypnotize(1, { minutes: 30 }); // session_start_raw_id 刷新为 r4
  const r5 = seedRaw(conv, 'user', 'e', '2026-01-01 00:00:20'); // 新会话期间的消息
  const second = forgetWindow(1);
  assert.equal(second.fromRawId, r5, '第二个窗口只覆盖新会话期间的 raw');
  assert.equal(second.toRawId, r5);
  assert.ok(second.windowId > first.windowId);

  const active = listForgottenWindows(1);
  // 前面手工插了 4 条（空区间 / 脏 from>to / 两条重叠）+ 两次遗忘各 1 条
  assert.equal(active.length, 6);
  assert.ok(active.some(w => w.id === first.windowId));
  assert.ok(active.some(w => w.id === second.windowId));
  assert.ok(active.some(w => w.id === empty));
  assert.equal(isRawForgotten(1, r5), true, '第二个窗口应覆盖新会话期间的 raw');
  assert.equal(isRawForgotten(1, r4), false, '两次催眠之间的消息不属于第二个窗口（她当时清醒自由）');
});

// ──────────────── 恢复：越权与幂等 ────────────────

test('跨角色 restore 零副作用（强化）：对方已有的一次性指令也不能被改写', async t => {
  seed(t, { withSecond: true });
  const db = getDb();
  seedMemory({ memoryId: 'm_b', conversationId: 'char_2', startRawId: 1, endRawId: 2 });
  db.prepare(`UPDATE memory_fragments SET status = 'archived' WHERE memory_id = 'm_b'`).run();
  const wid = seedWindow({ characterId: 2, fromRawId: 1, toRawId: 2, memoryIds: ['m_b'] });
  // 对方本来就有一条待执行指令
  db.prepare(
    `INSERT INTO character_hypnosis (character_id, pending_directive, pending_at, last_command) VALUES (2, 'body_control', datetime('now','-1 hours'), 'body_control')`
  ).run();
  const before = snapshotTables();

  assert.throws(() => restoreForgottenWindow(wid, { characterId: 1 }), err => err.code === 'NOT_FOUND');
  assert.equal(db.prepare(`SELECT status FROM hypnosis_forgotten_windows WHERE id = ?`).get(wid).status, 'active', '窗口必须原样');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_b'`).get().status, 'archived', '记忆必须仍归档');
  assert.equal(db.prepare(`SELECT pending_directive FROM character_hypnosis WHERE character_id = 2`).get().pending_directive, 'body_control', '对方原有指令不得被覆盖');
  assert.deepEqual(snapshotTables(), before, '越权请求必须整表零变化');
});

test('restore 幂等与不存在窗口：第二次 restored=0；不存在的窗口 NOT_FOUND 零副作用', async t => {
  seed(t);
  seedMemory({ memoryId: 'm1', conversationId: 'char_1', startRawId: 1, endRawId: 2 });
  getDb().prepare(`UPDATE memory_fragments SET status = 'archived' WHERE memory_id = 'm1'`).run();
  const wid = seedWindow({ fromRawId: 1, toRawId: 2, memoryIds: ['m1'] });

  const first = restoreForgottenWindow(wid, { characterId: 1 });
  assert.equal(first.restored, 1);
  assert.equal(getDb().prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm1'`).get().status, 'active');

  consumePendingDirective(1);
  const second = restoreForgottenWindow(wid, { characterId: 1 });
  assert.equal(second.restored, 0, '已经 active 的记忆不会被重复"恢复"');
  assert.equal(second.window.status, 'restored');
  // 【观察】第二次仍会重新写一条 memory_restore 指令 → 模型会收到第二遍"记忆涌回"
  assert.equal(getPendingDirective(1), 'memory_restore', '重复 restore 会重复触发叙事指令');

  const before = snapshotTables();
  assert.throws(() => restoreForgottenWindow(999999, { characterId: 1 }), err => err.code === 'NOT_FOUND');
  assert.deepEqual(snapshotTables(), before);
});

// ──────────────── scene 回归 / 记账口径 ────────────────

test('scene 回归：SCENES 扩了 hypnosis，非法 scene 仍回落 chat，byScene 分组不受影响', async t => {
  seed(t);
  assert.ok(SCENES.includes('hypnosis'));

  recordIntimateActs(1, { scene: 'hypnosis', partnerKind: 'user', source: 'manual', acts: [{ actKey: 'climax', sourceUid: 'a1' }] });
  recordIntimateActs(1, { scene: 'chat', partnerKind: 'user', rawId: 1, source: 'auto', acts: [{ actKey: 'vaginal' }] });
  recordIntimateActs(1, { scene: 'nonsense', partnerKind: 'user', rawId: 2, source: 'auto', acts: [{ actKey: 'oral' }] });

  const logs = listIntimateLogs(1, { partnerKinds: 'all', limit: 50 });
  const byUid = new Map(logs.map(l => [l.actKey, l]));
  assert.equal(byUid.get('climax').scene, 'hypnosis');
  assert.equal(byUid.get('vaginal').scene, 'chat');
  assert.equal(byUid.get('oral').scene, 'chat', '非法 scene 依旧回落 chat（扩枚举没有破坏兜底）');
});

test('forced_climax 走 manual 通道：即使撤销了 stats 授权也照记（用户手动指令不受 AI 权限限制）', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  getDb().prepare(`UPDATE character_body_profile SET ai_edit_fields = '["body"]' WHERE character_id = 1`).run();
  if (!getDb().prepare('SELECT 1 FROM character_body_profile WHERE character_id = 1').get()) {
    getDb().prepare(`INSERT INTO character_body_profile (character_id, ai_edit_fields) VALUES (1, '["body"]')`).run();
  }
  const result = issueCommand(1, 'forced_climax');
  assert.equal(result.intimate.inserted, 1, '人工指令与"人工补录"同口径，绕过 aiEditFields 闸门');
  assert.equal(result.intimate.blocked, false);
});

// ──────────────── 幂等锚点与时长 ────────────────

test('【缺陷复现】同一秒内连续催眠：会话身份会退回旧值，新会话的 forced_climax 被静默吞掉', async t => {
  seed(t);
  // 会话 A
  hypnotize(1, { minutes: 30 });
  issueCommand(1, 'forced_climax');
  assert.equal(listIntimateLogs(1, { partnerKinds: 'all' }).length, 1);

  // 模拟"同一秒内的第 2 次催眠"留下的状态（+1s 修正生效后的样子）
  getDb().prepare(`UPDATE character_hypnosis SET started_at = datetime('now', '+1 second') WHERE character_id = 1`).run();
  const ahead = getDb().prepare(`SELECT started_at AS s FROM character_hypnosis WHERE character_id = 1`).get().s;
  // 第 3 次催眠：started_at(+1s) ≠ datetime('now') → 走 ELSE 分支，身份退回当前秒
  const third = hypnotize(1, { minutes: 30 });
  assert.ok(third.startedAt < ahead, `会话身份应单调前进，实际从 ${ahead} 退回 ${third.startedAt}`);

  // 后果：同一次催眠会话的身份与更早的会话相同 → 幂等键撞车
  recordIntimateActs(1, {
    scene: 'hypnosis', partnerKind: 'user', source: 'manual',
    acts: [{ actKey: 'climax', sourceUid: `hypnosis:${third.startedAt}:forced_climax` }],
  });
  const swallowed = issueCommand(1, 'forced_climax');
  assert.equal(swallowed.intimate.inserted, 0, '期望：新会话应各记一笔；实际被幂等吞掉');
  assert.equal(swallowed.intimate.skipped, 1);
});

test('【观察】+1s 修正让 started_at 与 active_until 的差不再是整分钟', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  getDb().prepare(`UPDATE character_hypnosis SET started_at = datetime('now') WHERE character_id = 1`).run();
  hypnotize(1, { minutes: 30 });

  const delta = getDb().prepare(
    `SELECT CAST((julianday(active_until) - julianday(started_at)) * 86400 AS INTEGER) AS sec,
            CAST(ROUND((julianday(active_until) - julianday(started_at)) * 1440) AS INTEGER) AS minutes
       FROM character_hypnosis WHERE character_id = 1`
  ).get();
  assert.equal(delta.minutes, 30, '按分钟四舍五入仍是 30（面板显示不受影响）');
  assert.ok(delta.sec <= 1799 && delta.sec >= 1797, `秒级差值应为 29:57~29:59，实际 ${delta.sec}s（面板若按秒显示会看到 29:58 这类数字）`);
});

// ──────────────── 总开关 ────────────────

test('总开关关闭：读 state 不受影响；hypnotize/wake/issueCommand/forget 全部拒绝且零写入', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });

  config.features.hypnosis = false;
  const state = getHypnosisState(1); // 读不拦
  assert.equal(state.active, true);
  assert.equal(state.bodyControlled, true);

  const before = snapshotTables();
  for (const attempt of [
    () => hypnotize(1, { minutes: 30 }),
    () => wake(1, { mode: 'full' }),
    () => wake(1, { mode: 'mind' }),
    () => issueCommand(1, 'forced_climax'),
    () => forgetWindow(1),
  ]) {
    assert.throws(attempt, err => err.code === 'DISABLED');
  }
  assert.deepEqual(snapshotTables(), before, '被总开关拒绝时必须零写入');
});

test('总开关关闭时 restoreForgottenWindow 也必须拒绝且零写入（与其它写操作同口径）', async t => {
  seed(t);
  seedMemory({ memoryId: 'm1', conversationId: 'char_1', startRawId: 1, endRawId: 2 });
  getDb().prepare(`UPDATE memory_fragments SET status = 'archived' WHERE memory_id = 'm1'`).run();
  const wid = seedWindow({ fromRawId: 1, toRawId: 2, memoryIds: ['m1'] });

  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });
  config.features.hypnosis = false;

  const before = snapshotTables();
  assert.throws(() => restoreForgottenWindow(wid, { characterId: 1 }), err => err.code === 'DISABLED');
  assert.equal(getDb().prepare(`SELECT status FROM hypnosis_forgotten_windows WHERE id = ?`).get(wid).status, 'active', '窗口必须原样');
  assert.equal(getDb().prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm1'`).get().status, 'archived', '记忆必须仍归档');
  assert.equal(
    getDb().prepare(`SELECT pending_directive FROM character_hypnosis WHERE character_id = 1`).get()?.pending_directive ?? '',
    '', '不得写入 memory_restore 指令'
  );
  assert.deepEqual(snapshotTables(), before, '被总开关拒绝时必须零写入');
});

test('总开关关闭时 grantHypnosisPhone 也必须拒绝且零写入（与其余写操作同口径）', async t => {
  seed(t, { phone: false });
  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });
  config.features.hypnosis = false;

  const before = snapshotTables();
  assert.throws(() => grantHypnosisPhone(), err => err.code === 'DISABLED');
  assert.deepEqual(snapshotTables(), before, '被总开关拒绝时必须零写入');
  assert.equal(getHypnosisGate(1).hasPhone, false, '拒绝后不得留下手机');
});

// ──────────────── 非法参数 / clamp 接缝 ────────────────
// 验收报告 §D 记的「非法参数分支在 base 测试里有、对抗文件里没有」就是这段补的：
// 这里不看 happy path，专挑「参数校验与门控/状态的先后顺序」「响应可能撒谎而库才是真相」两类接缝。

test('非法角色 id：一律 INVALID 且零写入（参数校验优先于门控，不会被 403 掩盖）', async t => {
  // 刻意不给手机：若参数校验排在门控之后，这里第一个就会抛 GATE 而不是 INVALID
  seed(t, { phone: false });
  const before = snapshotTables();
  for (const bad of [0, -1, -3.7, 'abc', '', null, undefined, NaN, {}, []]) {
    const label = `id=${JSON.stringify(bad) ?? String(bad)}`;
    assert.throws(() => getHypnosisState(bad), err => err.code === 'INVALID', `getHypnosisState ${label}`);
    assert.throws(() => hypnotize(bad, { minutes: 30 }), err => err.code === 'INVALID', `hypnotize ${label}`);
    assert.throws(() => wake(bad, { mode: 'full' }), err => err.code === 'INVALID', `wake ${label}`);
    assert.throws(() => issueCommand(bad, 'body_control'), err => err.code === 'INVALID', `issueCommand ${label}`);
    assert.throws(() => forgetWindow(bad), err => err.code === 'INVALID', `forgetWindow ${label}`);
  }
  assert.deepEqual(snapshotTables(), before, '非法 id 不得产生任何写入');
});

test('id 取整口径：服务层 toId 与路由 parseCharacterId 必须同步（1.5 → 1、\'2abc\' → 2）', async t => {
  seed(t, { withSecond: true });
  // routes/hypnosis.js:33-37 的 parseCharacterId 就是这个表达式；两层取整规则一旦分叉，
  // 会出现「路由放行但服务层操作了另一个角色」（或反之 400 了却已经写了库）。
  const routeParse = raw => {
    const id = Number.parseInt(raw, 10);
    return (!Number.isSafeInteger(id) || id <= 0) ? null : id;
  };
  for (const probe of [1, 2, '1', ' 2 ', '2abc', 1.5, 2.9, '1.9', 1e30, 'abc', 0, -1, null, undefined, NaN]) {
    const label = `probe=${JSON.stringify(probe) ?? String(probe)}`;
    let serviceAccepts = true;
    let characterId = null;
    try {
      characterId = getHypnosisState(probe).characterId;
    } catch (err) {
      serviceAccepts = false;
      assert.equal(err.code, 'INVALID', `${label} 服务层只允许以 INVALID 拒绝`);
    }
    assert.equal(serviceAccepts, routeParse(probe) !== null, `${label} 两层的接受性必须一致`);
    if (serviceAccepts) assert.equal(characterId, routeParse(probe), `${label} 两层必须解析出同一个 id`);
  }
  // 小数/带尾巴的 id 是「静默取整」不是拒绝（与路由同口径，属既定行为、不是缺陷）
  assert.equal(getHypnosisState(1.5).characterId, 1);
  assert.equal(getHypnosisState('2abc').characterId, 2);
});

test('时长 clamp 的真相在库里：垃圾输入落回默认值，数字一律落进 [1,720]', async t => {
  seed(t);
  const db = getDb();
  const storedMinutes = () => Number(db.prepare(
    `SELECT CAST(ROUND((julianday(active_until) - julianday('now')) * 24 * 60) AS INTEGER) AS m
       FROM character_hypnosis WHERE character_id = 1`
  ).get().m);

  const cases = [
    [-9999, HYPNOSIS_MIN_MINUTES], [-0, HYPNOSIS_MIN_MINUTES], [0, HYPNOSIS_MIN_MINUTES], [1, 1],
    [1.9, 1], [12.9, 12], ['12abc', 12], [[45], 45], [' 60 ', 60],
    [720, HYPNOSIS_MAX_MINUTES], [721, HYPNOSIS_MAX_MINUTES], [9999, HYPNOSIS_MAX_MINUTES],
    [1e9, HYPNOSIS_MAX_MINUTES], [1e30, HYPNOSIS_MIN_MINUTES],
    ['abc', HYPNOSIS_DEFAULT_MINUTES], ['', HYPNOSIS_DEFAULT_MINUTES], [null, HYPNOSIS_DEFAULT_MINUTES],
    [undefined, HYPNOSIS_DEFAULT_MINUTES], [NaN, HYPNOSIS_DEFAULT_MINUTES], [Infinity, HYPNOSIS_DEFAULT_MINUTES],
    [[], HYPNOSIS_DEFAULT_MINUTES], [{}, HYPNOSIS_DEFAULT_MINUTES], [true, HYPNOSIS_DEFAULT_MINUTES],
  ];
  for (const [input, expected] of cases) {
    const label = `minutes=${JSON.stringify(input) ?? String(input)}`;
    const state = hypnotize(1, { minutes: input });
    // 断言的是**库里存的值**：只看返回值会漏掉「返回钳过了、落库没钳」这类一半正确
    const stored = storedMinutes();
    assert.equal(stored, expected, `${label} 应落库为 ${expected}`);
    assert.ok(stored >= HYPNOSIS_MIN_MINUTES && stored <= HYPNOSIS_MAX_MINUTES, `${label} 落库后必须仍在合法区间`);
    assert.equal(state.active, true, label);
  }

  // 重新催眠必须清掉上一轮还没被消费的一次性指令（陈旧指令不得跨会话泄漏）
  issueCommand(1, 'body_control');
  assert.equal(getHypnosisState(1).pendingDirective, 'body_control');
  hypnotize(1, { minutes: 9999 });
  assert.equal(getHypnosisState(1).pendingDirective, '', '重新催眠后上一轮的待消费指令必须清空');
  assert.equal(storedMinutes(), HYPNOSIS_MAX_MINUTES);
});

test('非法指令 kind：INVALID 先于状态判定，且不写 pending_directive、不动 command_count、不落看板', async t => {
  seed(t);
  hypnotize(1, { minutes: 30 });
  const db = getDb();
  const stateRow = () => db.prepare(
    `SELECT pending_directive, pending_at, command_count, last_command FROM character_hypnosis WHERE character_id = 1`
  ).get();
  const before = snapshotTables();
  const beforeRow = { ...stateRow() };

  for (const kind of ['nope', '', null, undefined, 123, 'BODY_CONTROL', 'forced_climax ', {}, ['forced_climax']]) {
    assert.throws(() => issueCommand(1, kind), err => err.code === 'INVALID',
      `kind=${JSON.stringify(kind) ?? String(kind)}`);
  }
  assert.deepEqual({ ...stateRow() }, beforeRow, '非法 kind 不得改 pending_directive / pending_at / command_count / last_command');
  assert.deepEqual(snapshotTables(), before, '非法 kind 不得产生任何写入（含亲密看板）');

  // 参数校验优先：未催眠时非法 kind 报 INVALID；body_control 仍报 NOT_HYPNOTIZED，
  // forced_climax 自 task-42 起放行（「强制高潮不需要催眠 随时都能触发」）
  wake(1, { mode: 'full' });
  assert.throws(() => issueCommand(1, 'nope'), err => err.code === 'INVALID');
  assert.throws(() => issueCommand(1, 'body_control'), err => err.code === 'NOT_HYPNOTIZED');
  assert.equal(issueCommand(1, 'forced_climax').pendingDirective, 'forced_climax', '非催眠态下的强制高潮必须放行');
});

test('wake 的 mode 只认字面量 \'mind\'：大小写/空格/对象等垃圾值一律全醒，不会被当成「只唤醒意志」', async t => {
  seed(t);
  for (const mode of ['MIND', 'mind ', ' Mind', 'partial', '', null, undefined, 0, 1, true, {}, ['mind']]) {
    hypnotize(1, { minutes: 30 });
    const label = `mode=${JSON.stringify(mode) ?? String(mode)}`;
    const state = wake(1, { mode });
    assert.equal(state.active, false, `${label} 应全醒`);
    assert.equal(state.mindAwake, false, `${label} 不得留下「意志清醒」`);
    assert.equal(state.bodyControlled, false, `${label} 身体必须放开`);
    assert.equal(state.lastCommand, 'wake:full', label);
  }
  // 未催眠时：mind 是有前置条件的写 → NOT_HYPNOTIZED；full 幂等放行
  assert.throws(() => wake(1, { mode: 'mind' }), err => err.code === 'NOT_HYPNOTIZED');
  assert.equal(wake(1, { mode: 'full' }).active, false);
});

test('forgetWindow 的 toRawId 垃圾值：回落到会话最后一条 raw（仍落审计行，不报错）', async t => {
  seed(t);
  const first = seedRaw('char_1', 'user', '催眠中说的一句');
  const last = seedRaw('char_1', 'assistant', '她的回应');

  for (const toRawId of ['abc', null, undefined, -5, {}, [], NaN]) {
    hypnotize(1, { minutes: 30 });
    const result = forgetWindow(1, { toRawId });
    const label = `toRawId=${JSON.stringify(toRawId) ?? String(toRawId)}`;
    assert.equal(result.toRawId, last, `${label} 应回落到会话最后一条 raw(${last})`);
    assert.equal(result.fromRawId, last + 1, `${label} 左端仍等于「会话起点 raw + 1」，与 toRawId 无关`);
    assert.ok(result.windowId > 0, `${label} 仍要落一条可撤销的审计行`);
  }

  // 显式合法值照用；小数按 parseInt 截断（1.9 → 1）
  hypnotize(1, { minutes: 30 });
  assert.equal(forgetWindow(1, { toRawId: first }).toRawId, first, '合法 toRawId 照用');
  hypnotize(1, { minutes: 30 });
  assert.equal(forgetWindow(1, { toRawId: 1.9 }).toRawId, 1, '小数被 parseInt 截断');
});
