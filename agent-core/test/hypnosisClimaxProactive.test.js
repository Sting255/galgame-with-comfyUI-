/**
 * 强制高潮「催眠高潮轮」回归（task-41）
 *
 * 背景（真机日志 完整/backend-2026-09-29.log）：睡着时点「强制高潮」，自动触发的那一轮走
 * proactiveChatScheduler，而它对催眠一无所知 —— prompt 里既没有 <hypnosis_command kind="forced_climax">，
 * 也没有「从睡梦里被硬拉起来」的专属文案，还不配图（配图取决于随机动机的 imageGen）。
 * 用户看到的就是一句普通主动闲聊 ⇒ 反复反馈「睡着时强制高潮没特殊反应」。
 *
 * 修法：把状态块 + 一次性指令块注入**这一轮**的 user 消息末尾（与私聊 chat.js 同口径），
 * 并把动机换成强制高潮（imageGen=true ⇒ 必须配图）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import（与其余 hypnosis 测试同口径）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`climax proactive fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const { grantHypnosisPhone, hypnotize, issueCommand } = await import('../src/services/hypnosisService.js');
const { buildForcedClimaxProactiveBlocks } = await import('../src/services/proactiveChatScheduler.js');

const COMMAND_TAG = '<hypnosis_command kind="forced_climax">';
const AWAKENED_MARK = '从深度睡眠里被硬生生拉上高潮';
const STATE_TAG = '<hypnosis_state>';

function seedCharacter(db, displayName) {
  return Number(db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run(`cp_${displayName}`, displayName, `你是${displayName}。`).lastInsertRowid);
}

/** 直接改睡眠列来构造四种场景（wakeForForcedTrigger 的效果就是 is_sleeping=0 + 临时唤醒窗口） */
function setSleepRow(db, id, { isSleeping = 0, tempWakeMin = null } = {}) {
  if (tempWakeMin === null) {
    db.prepare('UPDATE characters SET is_sleeping = ?, temporary_wake_until = NULL WHERE id = ?').run(isSleeping, id);
  } else {
    db.prepare("UPDATE characters SET is_sleeping = ?, temporary_wake_until = datetime('now', ?) WHERE id = ?")
      .run(isSleeping, `+${tempWakeMin} minutes`, id);
  }
}

/** 每个用例自带角色 + 手机 + 催眠态 + 一次待消费指令 */
function prepare(db, name, sleepOpts) {
  const id = seedCharacter(db, name);
  grantHypnosisPhone();
  hypnotize(id, { minutes: 30 });
  issueCommand(id, 'forced_climax');
  setSleepRow(db, id, sleepOpts);
  return id;
}

test('A1 睡着(is_sleeping=1)：注入状态块 + 睡梦唤醒版指令，且指令消费即清空', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = prepare(db, '睡着甲', { isSleeping: 1 });

  const first = buildForcedClimaxProactiveBlocks(id);
  assert.equal(first.awakenedFromSleep, true, 'is_sleeping=1 必须判为睡梦唤醒');
  assert.equal(first.directive, 'forced_climax');
  const joined = first.blocks.join('\n');
  assert.ok(joined.includes(STATE_TAG), '被催眠中要带状态块');
  assert.ok(joined.includes(COMMAND_TAG), '必须带一次性指令块');
  assert.ok(joined.includes(AWAKENED_MARK), '必须走睡梦唤醒专用文案');

  const second = buildForcedClimaxProactiveBlocks(id);
  assert.equal(second.directive, '', '一次性指令消费即清空');
  assert.ok(!second.blocks.join('\n').includes(COMMAND_TAG), '第二轮的块里不应再有指令');
});

test('A2 临时唤醒窗口内(is_sleeping=0 + 窗口在未来)：同样判为睡梦唤醒（真机关键分支）', async t => {
  // 强制高潮在触发这一轮之前已经 wakeForForcedTrigger() 临时唤醒她 ⇒ is_sleeping 已经是 0。
  // 只看 is_sleeping 的实现会在这里整条失效 —— 这条断言就是钉住它。
  const db = getDb();
  t.after(() => closeDb());
  const id = prepare(db, '临时唤醒乙', { isSleeping: 0, tempWakeMin: 5 });

  const got = buildForcedClimaxProactiveBlocks(id);
  assert.equal(got.awakenedFromSleep, true, '临时唤醒窗口内必须判为睡梦唤醒');
  assert.ok(got.blocks.join('\n').includes(AWAKENED_MARK), '窗口内要走睡梦唤醒文案');
});

test('A3 清醒且无临时唤醒：有指令块，但没有睡梦唤醒文案', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = prepare(db, '清醒丙', { isSleeping: 0 });

  const got = buildForcedClimaxProactiveBlocks(id);
  assert.equal(got.awakenedFromSleep, false);
  const joined = got.blocks.join('\n');
  assert.ok(joined.includes(COMMAND_TAG), '清醒轮同样要有指令块');
  assert.ok(!joined.includes(AWAKENED_MARK), '清醒轮不得出现睡梦唤醒文案');
});

test('A4 没有被下达指令：不产生指令块，只可能有状态块', async t => {
  const db = getDb();
  t.after(() => closeDb());
  const id = (() => {
    const cid = seedCharacter(db, '无指令丁');
    grantHypnosisPhone();
    hypnotize(cid, { minutes: 30 });
    setSleepRow(db, cid, { isSleeping: 1 });
    return cid;
  })();

  const got = buildForcedClimaxProactiveBlocks(id);
  assert.equal(got.directive, '');
  assert.ok(!got.blocks.join('\n').includes(COMMAND_TAG), '没有指令就不该有指令块');
});

test('B1 挂点：主动聊天把催眠块接在本轮 user 消息末尾，并强制配图', async () => {
  const source = await readFile(new URL('../src/services/proactiveChatScheduler.js', import.meta.url), 'utf8');
  assert.ok(source.includes('extra.hypnosisBlocks'), 'generateGreeting 要读注入块');
  assert.ok(/msgs\.push\(\{ role: 'user', content: worldRulePrefix \+ msgTask \+ hypnoSuffix \}\)/.test(source),
    '催眠块必须接在本轮 user 消息末尾（位置越靠后越硬，与私聊同口径）');
  assert.ok(source.includes("name: '强制高潮'"), '动机要换成强制高潮');
  assert.ok(source.includes('imageGen: true }'), '强制高潮轮必须配图');
  assert.ok(source.includes("consumePendingDirective(characterId)"), '指令由这一轮消费');
  assert.ok(source.includes('FORCED_CLIMAX_FRAME_OVERRIDE'), '要覆盖「开场白 / 15~50 字」的写作框架');
  assert.ok(source.includes("+ FORCED_CLIMAX_FRAME_OVERRIDE"), '覆盖段必须接在注入块之后（最硬的位置）');
  assert.ok(source.includes('本轮**不是**主动聊天的开场白'), '覆盖段要取消开场白结构');
});

test('B2 挂点：路由把 forcedClimax 传下去，且 2 分钟闸门挡不住用户手点', async () => {
  const route = await readFile(new URL('../src/routes/hypnosis.js', import.meta.url), 'utf8');
  assert.ok(route.includes('forcedClimax: true'), '路由必须声明这是强制高潮轮');
  const sched = await readFile(new URL('../src/services/proactiveChatScheduler.js', import.meta.url), 'utf8');
  assert.ok(sched.includes('if (!forcedClimax && hoursSince !== null && hoursSince * 60 < 2)'),
    '用户手点的强制高潮不能被「2 分钟内刚聊过」闸门吞掉');
});
