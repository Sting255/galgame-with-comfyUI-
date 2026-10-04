/**
 * 催眠手机：HTTP 契约回归（真实 express 挂载 + 真实 fetch）
 *
 * 覆盖：路径与挂载顺序、状态形状、门控 403（带机器码）、未催眠 409、参数 400、
 * 角色不存在 404、跨角色撤销遗忘的**零副作用**（P2 回归）、总开关 409、背包领取幂等。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`hypnosis api fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const hypnosisRoutes = (await import('../src/routes/hypnosis.js')).default;
const { phoneRouter } = await import('../src/routes/hypnosis.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));
app.use('/api/hypnosis', wrapRouterAsync(phoneRouter));
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

/** 干净库 + 两个角色（A=1 用来操作，B=2 用来验跨角色） */
function seed(t, { phone = true, affinity = 100, oath = true } = {}) {
  const db = getDb();
  t.after(() => closeDb());
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (1, 'a', '角色A', '旅客')`).run();
  db.prepare(`INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt) VALUES (2, 'b', '角色B', '旅客')`).run();
  if (phone) db.prepare(
    `INSERT INTO backpack_items (effect_key, name, description, status, owner_key, source_type, collected_at)
     VALUES ('hypnosis_phone', '催眠手机', '测试用', 'ready', 'me', 'grant', datetime('now'))`
  ).run();
  if (affinity != null) {
    db.prepare(
      `INSERT INTO user_relationships (character_id, relationship_text, affinity) VALUES (1, '', ?)
       ON CONFLICT(character_id) DO UPDATE SET affinity = excluded.affinity`
    ).run(affinity);
  }
  if (oath) {
    db.prepare(
      `INSERT INTO user_relationships (character_id, relationship_text, is_oath) VALUES (1, '', 1)
       ON CONFLICT(character_id) DO UPDATE SET is_oath = 1`
    ).run();
  }
  return 1;
}

test('GET /:id/hypnosis 状态形状（含 gate.code 机器码）', async t => {
  seed(t);
  const res = await api('GET', '/api/characters/1/hypnosis');
  assert.equal(res.status, 200);
  for (const key of ['characterId', 'bodyControlled', 'mindAwake', 'active', 'activeUntil', 'startedAt',
    'pendingDirective', 'commandCount', 'lastCommand', 'gate']) {
    assert.ok(Object.hasOwn(res.json, key), `状态缺少 ${key}`);
  }
  assert.deepEqual(res.json.gate, {
    allowed: true, code: 'ok', reason: '', affinity: 100, isOath: true, hasPhone: true,
  });
  assert.equal(res.json.active, false);
});

test('门控失败：403 带 code + reason；角色非法/不存在 400/404', async t => {
  seed(t, { phone: false });
  const noPhone = await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 30 });
  assert.equal(noPhone.status, 403);
  assert.equal(noPhone.json.error, 'hypnosis gate not met');
  assert.equal(noPhone.json.code, 'no_phone');
  assert.equal(noPhone.json.reason, '背包里没有催眠手机');

  // 状态零改动
  const state = await api('GET', '/api/characters/1/hypnosis');
  assert.equal(state.json.active, false);
  assert.equal(state.json.commandCount, 0);

  assert.equal((await api('GET', '/api/characters/abc/hypnosis')).status, 400);
  assert.equal((await api('GET', '/api/characters/0/hypnosis')).status, 400);
  assert.equal((await api('GET', '/api/characters/9999/hypnosis')).status, 404);
});

test('催眠 → 只唤醒意志 → 全醒 的正交状态机（真 HTTP）', async t => {
  seed(t);
  const hyp = await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 0 });
  assert.equal(hyp.status, 200);
  assert.equal(hyp.json.active, true);
  assert.equal(hyp.json.bodyControlled, true);
  assert.equal(hyp.json.mindAwake, false);
  assert.equal(hyp.json.lastCommand, 'hypnotize');
  assert.equal(hyp.json.commandCount, 1);

  const mind = await api('POST', '/api/characters/1/hypnosis/wake', { mode: 'mind' });
  assert.equal(mind.status, 200);
  assert.equal(mind.json.mindAwake, true);
  assert.equal(mind.json.bodyControlled, true, '「只唤醒意志」身体仍受控');

  const full = await api('POST', '/api/characters/1/hypnosis/wake', { mode: 'full' });
  assert.equal(full.status, 200);
  assert.equal(full.json.active, false);
  assert.equal(full.json.bodyControlled, false);
  assert.equal(full.json.mindAwake, false);
  assert.equal(full.json.activeUntil, null);
});

test('指令：400 非法 kind / 未催眠时 body_control 409、forced_climax 放行 / 落看板且幂等', async t => {
  seed(t);
  assert.equal((await api('POST', '/api/characters/1/hypnosis/command', { kind: 'nope' })).status, 400);
  // task-42：body_control 仍要求"催眠中"（它本身就是身体受控的语义）
  const notHypnotized = await api('POST', '/api/characters/1/hypnosis/command', { kind: 'body_control' });
  assert.equal(notHypnotized.status, 409);
  assert.equal(notHypnotized.json.error, 'not hypnotized');

  // 非催眠态下的强制高潮：200，且不得把状态写成"催眠中"
  const awake = await api('POST', '/api/characters/1/hypnosis/command', { kind: 'forced_climax' });
  assert.equal(awake.status, 200, '强制高潮不需要催眠（随时都能触发）');
  assert.equal(awake.json.pendingDirective, 'forced_climax');
  assert.equal(awake.json.active, false, '非催眠态不得假装被催眠');
  assert.equal(awake.json.bodyControlled, false);
  assert.equal(awake.json.intimate.inserted, 1, '非催眠态照样计入亲密看板');

  await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 30 });
  const first = await api('POST', '/api/characters/1/hypnosis/command', { kind: 'forced_climax' });
  assert.equal(first.status, 200);
  assert.equal(first.json.pendingDirective, 'forced_climax');
  assert.equal(first.json.intimate.inserted, 1);
  const second = await api('POST', '/api/characters/1/hypnosis/command', { kind: 'forced_climax' });
  assert.equal(second.json.intimate.inserted, 0, '同一次催眠内重复点击不重复计数');

  const panel = await api('GET', '/api/characters/1/intimate');
  // 只挂了 hypnosis 路由，intimate 面板不在这里 → 直接查库确认场景与行为
  // 非催眠态一次 + 催眠中一次 = 2 笔；同一场催眠的第二次点击被幂等吃掉
  const rows = getDb().prepare(
    `SELECT scene, act_key, partner_kind FROM character_intimate_log WHERE character_id = 1 ORDER BY id`
  ).all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.scene, 'hypnosis');
    assert.equal(row.act_key, 'climax');
    assert.equal(row.partner_kind, 'user');
  }
  assert.equal(panel.status, 404, '本测试只挂 hypnosis 路由，intimate 未挂载（预期 404）');
});

test('遗忘与撤销：GET forgotten 形状、恢复返回值字段名、没有会话 409', async t => {
  seed(t);
  assert.equal((await api('POST', '/api/characters/1/hypnosis/forget', {})).status, 409, '没有催眠会话时拒绝遗忘');

  await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 30 });
  const forget = await api('POST', '/api/characters/1/hypnosis/forget', {});
  assert.equal(forget.status, 200);
  assert.equal(typeof forget.json.windowId, 'number');
  assert.equal(forget.json.archived, 0);
  assert.equal((await api('GET', '/api/characters/1/hypnosis')).json.active, false, '遗忘即结束控制');

  const list = await api('GET', '/api/characters/1/hypnosis/forgotten');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.windows));
  assert.equal(list.json.windows.length, 1);
  const win = list.json.windows[0];
  for (const key of ['id', 'characterId', 'fromRawId', 'toRawId', 'memoriesArchived', 'memoryIds', 'status']) {
    assert.ok(Object.hasOwn(win, key), `窗口缺少 ${key}`);
  }
  assert.equal(win.status, 'active');

  const restore = await api('POST', `/api/characters/1/hypnosis/forgotten/${win.id}/restore`);
  assert.equal(restore.status, 200);
  // 前端按契约防御式读取这两个字段名：必须是 restored / pendingDirective
  assert.equal(typeof restore.json.restored, 'number');
  assert.equal(restore.json.pendingDirective, 'memory_restore');
  assert.equal(restore.json.window.status, 'restored');

  assert.equal((await api('GET', '/api/characters/1/hypnosis/forgotten')).json.windows.length, 0, '默认只看 active');

  // 参数与不存在
  assert.equal((await api('POST', '/api/characters/1/hypnosis/forgotten/abc/restore')).status, 400);
  assert.equal((await api('POST', '/api/characters/1/hypnosis/forgotten/9999/restore')).status, 404);
});

test('P2 回归：跨角色撤销遗忘必须 404 且零副作用', async t => {
  seed(t);
  const db = getDb();
  // 造 B 的窗口：一条已归档记忆 + 一条 active 窗口
  db.prepare(
    `INSERT INTO memory_fragments (memory_id, conversation_id, fragment_type, content, status, memory_type, subject, judgment, source_raw_start_id, source_raw_end_id)
     VALUES ('m_b', 'char_2', 'fact', 'B 的记忆', 'archived', 'knowledge', 'user', 'B 的记忆', 1, 2)`
  ).run();
  const wid = Number(db.prepare(
    `INSERT INTO hypnosis_forgotten_windows (character_id, from_raw_id, to_raw_id, memory_ids, memories_archived, status)
     VALUES (2, 1, 2, '["m_b"]', 1, 'active')`
  ).run().lastInsertRowid);

  const res = await api('POST', `/api/characters/1/hypnosis/forgotten/${wid}/restore`);
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'window not found');

  // 回到原状：窗口仍 active、记忆仍 archived、B 的一次性指令未被写入
  assert.equal(db.prepare('SELECT status FROM hypnosis_forgotten_windows WHERE id = ?').get(wid).status, 'active');
  assert.equal(db.prepare(`SELECT status FROM memory_fragments WHERE memory_id = 'm_b'`).get().status, 'archived');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_hypnosis WHERE character_id = 2').get().n, 0);

  // 归属正确时能撤销
  const ok = await api('POST', `/api/characters/2/hypnosis/forgotten/${wid}/restore`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.restored, 1);
});

test('总开关关闭：写操作 409，读状态不拦', async t => {
  seed(t);
  await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 30 });
  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });
  config.features.hypnosis = false;

  const blocked = await api('POST', '/api/characters/1/hypnosis/hypnotize', { minutes: 30 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error, 'hypnosis feature disabled');
  assert.equal((await api('POST', '/api/characters/1/hypnosis/wake', { mode: 'full' })).status, 409);
  assert.equal((await api('POST', '/api/characters/1/hypnosis/command', { kind: 'body_control' })).status, 409);
  assert.equal((await api('POST', '/api/characters/1/hypnosis/forget', {})).status, 409);

  const read = await api('GET', '/api/characters/1/hypnosis');
  assert.equal(read.status, 200, '读状态不受总开关限制');
  config.features.hypnosis = saved;
});

test('POST /api/hypnosis/phone/grant：幂等领取（含形状）', async t => {
  seed(t, { phone: false });
  const first = await api('POST', '/api/hypnosis/phone/grant');
  assert.equal(first.status, 200);
  assert.ok(first.json.item, '必须返回 item');
  assert.equal(first.json.item.effect_key, 'hypnosis_phone');
  assert.equal(first.json.item.kind, 'special');

  const second = await api('POST', '/api/hypnosis/phone/grant');
  assert.equal(second.json.item.id, first.json.item.id, '已有未使用的一台就不重复塞');
  assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM backpack_items WHERE effect_key = 'hypnosis_phone'`).get().n, 1);

  // 领到手机后门控的 no_phone 消失
  const state = await api('GET', '/api/characters/1/hypnosis');
  assert.equal(state.json.gate.hasPhone, true);
  assert.notEqual(state.json.gate.code, 'no_phone');
});

test('总开关关闭：/phone/grant 也 409 且不改背包（与其余写操作对齐）', async t => {
  seed(t, { phone: false });
  const saved = config.features.hypnosis;
  t.after(() => { config.features.hypnosis = saved; });
  config.features.hypnosis = false;

  const res = await api('POST', '/api/hypnosis/phone/grant');
  assert.equal(res.status, 409, '总开关关闭时不允许下发道具');
  assert.equal(res.json.error, 'hypnosis feature disabled');
  assert.equal(
    getDb().prepare(`SELECT COUNT(*) AS n FROM backpack_items WHERE effect_key = 'hypnosis_phone'`).get().n,
    0,
    '被拦截时不许有任何写入'
  );

  config.features.hypnosis = saved;
  const ok = await api('POST', '/api/hypnosis/phone/grant');
  assert.equal(ok.status, 200, '开关恢复后仍能正常领取');
  assert.equal(ok.json.item.effect_key, 'hypnosis_phone');
});

test('挂载顺序：hypnosis 在 intimate 家族之前，且 intimate→characters 仍紧邻', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /^import hypnosisRoutes, \{ phoneRouter as hypnosisPhoneRoutes \} from '\.\/src\/routes\/hypnosis\.js';$/m);
  const hypnosisMount = source.indexOf("app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));");
  const phoneMount = source.indexOf("app.use('/api/hypnosis', wrapRouterAsync(hypnosisPhoneRoutes));");
  const intimateMount = source.indexOf("app.use('/api/characters', wrapRouterAsync(intimateRoutes));");
  const charactersMount = source.indexOf("app.use('/api/characters', wrapRouterAsync(charactersRoutes));");
  assert.ok(hypnosisMount > 0 && phoneMount > 0 && intimateMount > 0 && charactersMount > 0);
  assert.ok(hypnosisMount < intimateMount, 'hypnosis 必须早于 intimate 挂载（否则 /:id 通配先吃掉）');
  // intimate → characters 之间不许夹别的挂载（intimateApi.test.js 的既有约束）
  const between = source.slice(intimateMount + "app.use('/api/characters', wrapRouterAsync(intimateRoutes));".length, charactersMount)
    .replace(/\/\/[^\n]*/g, '').trim();
  assert.equal(between, '', 'intimate 与 characters 之间不该夹别的挂载');
});
