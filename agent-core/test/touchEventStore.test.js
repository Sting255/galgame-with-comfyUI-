/**
 * `services/touchEventStore.js`（task-24 · P0-2 / P2-2）
 *
 * ① **消费顺序**：私聊链与群聊链同口径（先点先演）⇒ `takePendingTouchEvent` 取**最旧**一条（ASC）。
 * ② **过期作废**：超过 `TOUCH_EVENT_TTL_MS` 的 pending/done 标 `expired` 且不再被取到（判定只有一处）。
 * ③ **搬家**：这三个函数从 `routes/touch.js` / `routes/chat.js` 搬进本服务，行为逐字节不变，
 *    顺便消掉 `chat.js ← routes/touch.js` 的反向 import。
 * ④ **待消费计数**：`countPendingTouchEvents` 供 `GET /touch/state` 的 `pendingCount` 用。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const store = await import('../src/services/touchEventStore.js');
const { TOUCH_EVENT_TTL_MS } = await import('../src/services/touchActionService.js');

after(() => closeDb());

let seq = 0;
function seedCharacter() {
  const db = getDb();
  seq += 1;
  const info = db.prepare(
    "INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, '人格', '短人格')"
  ).run('store_' + seq, '存储' + seq);
  return Number(info.lastInsertRowid);
}
function seedGroup(memberIds) {
  const db = getDb();
  seq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('存储群' + seq, 't').lastInsertRowid);
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  return gid;
}
function seedEvent(characterId, { groupId = null, actionKey = 'pat_head', mode = 'implicit', status = 'pending', ageMinutes = 0 } = {}) {
  const db = getDb();
  const createdAt = ageMinutes > 0 ? "datetime('now', '-" + Math.round(ageMinutes) + " minutes')" : 'datetime(\'now\')';
  const info = db.prepare(
    'INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, created_at, updated_at)' +
    ' VALUES (?, ?, ?, ?, 0, 1, ?, ' + createdAt + ", datetime('now'))"
  ).run(characterId, groupId, actionKey, mode, status);
  return Number(info.lastInsertRowid);
}
const statusOf = id => getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(id);

test('takePendingTouchEvent：连插 3 条 pending → 先消费**最旧**那条（先点先演，与群聊 ASC 对齐）', () => {
  const id = seedCharacter();
  const oldest = seedEvent(id, { actionKey: 'pat_head', ageMinutes: 30 });
  const middle = seedEvent(id, { actionKey: 'hug', ageMinutes: 20 });
  const newest = seedEvent(id, { actionKey: 'kiss_cheek', ageMinutes: 10 });

  const first = store.takePendingTouchEvent(id);
  assert.ok(first, '必须取到一条');
  assert.equal(first.id, oldest, '第一轮消费最旧那条（改 ASC 前这里会拿到 newest）');
  assert.equal(first.actionKey, 'pat_head');
  assert.equal(first.mode, 'implicit');
  store.markTouchEventInjected(first.id);
  assert.equal(statusOf(oldest), 'injected');
  const second = store.takePendingTouchEvent(id);
  assert.equal(second.id, middle, '第二轮消费第二旧');
  store.markTouchEventInjected(second.id);
  const third = store.takePendingTouchEvent(id);
  assert.equal(third.id, newest, '第三轮才轮到最新那条');
  store.markTouchEventInjected(third.id);
  assert.equal(store.takePendingTouchEvent(id), null, '消费完就没有了');
});

test('takePendingTouchEvent：done（即时已发过）也会被消费，mode 回 instant（审查点名的弱影响照旧）', () => {
  const id = seedCharacter();
  const doneId = seedEvent(id, { actionKey: 'hold_hand', mode: 'instant', status: 'done' });
  const taken = store.takePendingTouchEvent(id);
  assert.equal(taken.id, doneId);
  assert.equal(taken.mode, 'instant', '即时口径要回 instant（注入「已发过别再演」块）');
  assert.equal(Number(taken.likeRatio), 1);
  assert.equal(Number(taken.annoyance), 0);
});

test('takePendingTouchEvent：只认私聊（group_id IS NULL），群聊事件由群聊链消费', () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  const groupEvent = seedEvent(id, { groupId: gid, actionKey: 'hug' });
  assert.equal(store.takePendingTouchEvent(id), null, '群聊事件不许被私聊链取走');
  assert.equal(statusOf(groupEvent), 'pending', '也不许被顺手改状态');
  const privateEvent = seedEvent(id, { actionKey: 'pat_head' });
  assert.equal(store.takePendingTouchEvent(id).id, privateEvent);
});

test('takePendingTouchEvent：超过 30 分钟的事件自动作废（标 expired）且不返回', () => {
  const id = seedCharacter();
  const stale = seedEvent(id, { ageMinutes: (TOUCH_EVENT_TTL_MS / 60000) + 5 });
  const fresh = seedEvent(id, { actionKey: 'hug' });
  const taken = store.takePendingTouchEvent(id);
  assert.equal(taken.id, fresh, '过期的先扫掉，不挡新鲜事件');
  assert.equal(statusOf(stale), 'expired', '过期清理在同一次调用里发生（调用方不用自己扫）');
});

test('expireStaleTouchEvents：两个作用域各按各的列扫（characterId = 她名下全部；groupId = 该群全部）', () => {
  const id = seedCharacter();
  const other = seedCharacter();
  const gid = seedGroup([id, other]);
  const stalePrivate = seedEvent(id, { ageMinutes: 120 });
  const staleGroup = seedEvent(id, { groupId: gid, ageMinutes: 120 });
  const freshPrivate = seedEvent(id, { actionKey: 'hug' });
  const otherStale = seedEvent(other, { ageMinutes: 120 });
  const otherStaleGroup = seedEvent(other, { groupId: gid, ageMinutes: 120 });

  // 角色作用域按 character_id 扫：**包含**她的群聊事件（搬家前的既有口径，逐字节照搬；
  // 群聊链自己那份清扫是按 group_id 的，两者互补）
  assert.equal(store.expireStaleTouchEvents({ characterId: id }), 2, '角色作用域 = 她名下全部过期行（私聊 + 她的群聊行）');
  assert.equal(statusOf(stalePrivate), 'expired');
  assert.equal(statusOf(staleGroup), 'expired');
  assert.equal(statusOf(freshPrivate), 'pending', '新鲜的不动');
  assert.equal(statusOf(otherStale), 'pending', '别人的不动');

  assert.equal(store.expireStaleTouchEvents({ groupId: gid }), 1, '群作用域 = 该群里还剩下的过期行');
  assert.equal(statusOf(otherStaleGroup), 'expired');
  assert.equal(statusOf(otherStale), 'pending', '按群清扫不碰私聊行');
  assert.equal(store.expireStaleTouchEvents({ characterId: other }), 1);
  assert.equal(statusOf(otherStale), 'expired');
  assert.equal(store.expireStaleTouchEvents({}), 0, '没有作用域 → 不误杀');
});

test('countPendingTouchEvents：**只数 pending**（done = 反应已发过，不算「等她回应」；task-30 真机问题 3）', () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  seedEvent(id, { status: 'pending' });
  seedEvent(id, { actionKey: 'hug', status: 'done', mode: 'instant' });   // 即时成功：反应已作为独立消息发出
  seedEvent(id, { actionKey: 'kiss_cheek', status: 'injected' });
  seedEvent(id, { actionKey: 'tickle', status: 'expired' });
  seedEvent(id, { groupId: gid, actionKey: 'hug' });
  assert.equal(store.countPendingTouchEvents(id), 1, '只有 pending 算；done（已发过）/injected/expired/群聊都不算');
  assert.equal(store.countPendingTouchEvents(id + 999), 0, '不存在的角色 = 0（不抛）');
});

test('countPendingTouchEvents：隐式 pending → 消费（注入）后归零（用户「不回话也一直涨」的直接回归）', () => {
  const id = seedCharacter();
  seedEvent(id, { status: 'pending' });
  seedEvent(id, { status: 'pending', actionKey: 'hug' });
  assert.equal(store.countPendingTouchEvents(id), 2, '两条隐式：等她下一轮聊天演出');
  const taken = store.takePendingTouchEvent(id);
  store.markTouchEventInjected(taken.id);
  assert.equal(store.countPendingTouchEvents(id), 1, '消费一条减一');
  store.markTouchEventInjected(store.takePendingTouchEvent(id).id);
  assert.equal(store.countPendingTouchEvents(id), 0, '全消费完 = 0');
});

test('takePendingTouchEvent 仍吃 done（**只改 count、不改消费**的回归锚点）', () => {
  const id = seedCharacter();
  const doneId = seedEvent(id, { actionKey: 'hug', status: 'done', mode: 'instant' });
  const taken = store.takePendingTouchEvent(id);
  assert.ok(taken, 'done 事件仍必须被消费（要注入「已发过别再演」块）');
  assert.equal(taken.id, doneId);
  assert.equal(taken.mode, 'instant', 'mode 仍回 instant');
  assert.equal(store.countPendingTouchEvents(id), 0, '但计数不把它算成「等回应」');
});

test('countPendingTouchEventsByMode：pending 按 mode 分开数（供前端分文案），群聊口径同样只数 pending', () => {
  const id = seedCharacter();
  seedEvent(id, { status: 'pending' });                                   // implicit
  seedEvent(id, { status: 'pending', actionKey: 'hug' });                  // implicit
  seedEvent(id, { status: 'pending', actionKey: 'tickle', mode: 'instant' });
  seedEvent(id, { status: 'done', actionKey: 'kiss_cheek', mode: 'instant' });
  assert.deepEqual(store.countPendingTouchEventsByMode(id), { instant: 1, implicit: 2 });
  assert.deepEqual(store.countPendingTouchEventsByMode(id + 999), { instant: 0, implicit: 0 }, '不存在的角色 = 0');

  const gid = seedGroup([id]);
  seedEvent(id, { groupId: gid, actionKey: 'hug', mode: 'instant' });
  seedEvent(id, { groupId: gid, actionKey: 'hug', status: 'done', mode: 'instant' });
  assert.deepEqual(store.countPendingTouchEventsByMode(id, { groupId: gid }), { instant: 1, implicit: 0 }, '群聊口径：只数 pending');
});

test('store 零 routes 依赖（搬家目标：两条链都从服务层 import）', async () => {
  const source = await readFile(new URL('../src/services/touchEventStore.js', import.meta.url), 'utf8');
  assert.ok(!/from '[^']*routes\//.test(source), '不许 import 任何 routes 模块（反向依赖已消除）');
  assert.ok(source.includes('export function takePendingTouchEvent'));
  assert.ok(source.includes('export function markTouchEventInjected'));
  assert.ok(source.includes('export function expireStaleTouchEvents'));
  assert.ok(source.includes('export function countPendingTouchEvents'));
});

// ──────────────── task-28：pendingCount 的群聊口径 ────────────────

test('countPendingTouchEvents({ groupId })：按场景计数（群聊口径数**该群全体**，私聊口径不变）', () => {
  const a = seedCharacter();
  const b = seedCharacter();
  const gid = seedGroup([a, b]);
  // 私聊：a 两条、b 一条
  seedEvent(a, { status: 'pending' });
  seedEvent(a, { actionKey: 'hug', status: 'done', mode: 'instant' });
  seedEvent(b, { status: 'pending' });
  // 群聊：同一个群里 a 一条、b 一条（都是隐式待演）
  seedEvent(a, { groupId: gid, actionKey: 'hug' });
  seedEvent(b, { groupId: gid, actionKey: 'tickle' });
  // 干扰项：另一群的 pending 不算进来
  const otherGroup = seedGroup([a]);
  seedEvent(a, { groupId: otherGroup, actionKey: 'pat_head' });

  assert.equal(store.countPendingTouchEvents(a), 1, '默认（私聊口径）只数 a 的**未回应**私聊（done 不算）');
  assert.equal(store.countPendingTouchEvents(b), 1, '默认口径按 character_id 过滤');
  assert.equal(store.countPendingTouchEvents(a, { groupId: gid }), 2, '群聊口径 = 该群全体待消费（a 1 条 + b 1 条）');
  assert.equal(store.countPendingTouchEvents(b, { groupId: gid }), 2, '群聊口径与传入的 characterId 无关（数的是群）');
  assert.equal(store.countPendingTouchEvents(a, { groupId: otherGroup }), 1, '按群隔离，不串群');
  assert.equal(store.countPendingTouchEvents(a, { groupId: 0 }), 1, '非法 / 0 → 回落私聊口径');
  assert.equal(store.countPendingTouchEvents(a, { groupId: 'x' }), 1, '非数字 → 回落私聊口径');
});

test('countPendingTouchEvents({ groupId })：不过期的才算，且 30 分钟前的僵尸事件不撑大计数', () => {
  const a = seedCharacter();
  const gid = seedGroup([a]);
  seedEvent(a, { groupId: gid, actionKey: 'hug' });
  const stale = seedEvent(a, { groupId: gid, actionKey: 'tickle', ageMinutes: 120 });
  assert.equal(store.countPendingTouchEvents(a, { groupId: gid }), 2, '未清扫前两条都在（计数只做过滤，不负责清扫）');
  assert.equal(store.expireStaleTouchEvents({ groupId: gid }), 1, '群作用域清扫照旧生效');
  assert.equal(statusOf(stale), 'expired');
  assert.equal(store.countPendingTouchEvents(a, { groupId: gid }), 1, '清扫后僵尸事件不再撑大计数');
});

test('countPendingTouchEvents({ groupId })：groupId 必须是**严格**正整数（1.5 / 3abc / +3 一律不算）', () => {
  const a = seedCharacter();
  const gid = seedGroup([a]);
  seedEvent(a, { status: 'pending' });                    // 私聊 2 条
  seedEvent(a, { actionKey: 'hug', status: 'pending' });
  for (let i = 0; i < 5; i++) seedEvent(a, { groupId: gid, actionKey: 'hug' });  // 该群 5 条
  assert.equal(store.countPendingTouchEvents(a), 2, '夹具：私聊口径 = 2');
  assert.equal(store.countPendingTouchEvents(a, { groupId: gid }), 5, '夹具：群聊口径 = 5');

  // 非严格正整数 ⇒ 当"没给 groupId"处理（回落私聊口径），**绝不 parseInt 截断**成群 1
  assert.equal(store.countPendingTouchEvents(a, { groupId: '1.5' }), 2, '1.5 不得被截断成 1');
  assert.equal(store.countPendingTouchEvents(a, { groupId: 1.5 }), 2, '数字 1.5 同样拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: String(gid) + 'abc' }), 2, '数字后缀（3abc）拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: '+' + gid }), 2, '带正号（+3）拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: '-' + gid }), 2, '负数拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: '1e3' }), 2, '科学计数法拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: '' }), 2, '空串拒绝');
  assert.equal(store.countPendingTouchEvents(a, { groupId: [] }), 2, '数组/对象拒绝');

  // 允许：纯数字串，以及**首尾空白**（口径 = String(raw).trim() 后必须 /^\d+$/）
  assert.equal(store.countPendingTouchEvents(a, { groupId: String(gid) }), 5, '纯数字串');
  assert.equal(store.countPendingTouchEvents(a, { groupId: ' ' + gid + ' ' }), 5, '首尾空白 trim 后是纯数字 ⇒ 允许');
  assert.equal(store.countPendingTouchEvents(a, { groupId: gid }), 5, 'JS 整数照旧');
});
