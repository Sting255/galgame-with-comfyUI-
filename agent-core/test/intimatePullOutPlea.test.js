/**
 * 推进系统 · **「突然拔出去 ⇒ 她主动求着继续」**（2026-10-04 用户：
 * 「如果在性爱的时候 突然拔或者停止出来角色会自动去求着继续」）。
 *
 * 这个功能**不新增状态字段**（所以没有迁移、重启后照样自洽）：判据是从既有状态派生的
 *   `active === true && penetrating === false`
 *   —— 这一场还开着，但他不在她体内。这正是面板点「拔出 / stop」之后的形状。
 *
 * 覆盖两条链（**两条缺一不可**）：
 *   ① `buildIntimateActionPrompt` —— **当场那一条反应**（它自己拼 prompt，不走场景块）；
 *   ② `buildIntimateSceneBlock`   —— **之后的轮次**（用户下一句话时她还记得自己在求）。
 *
 * ⚠️ 门槛是 `PULL_OUT_BEG_ACCUMULATION`（50）而**不是** `EDGE_THRESHOLD`（60）：
 *   `stop` 自己会把累积 -5，所以"刚好在边缘(60)"的人拔出去后落到 55 ——
 *   拿 60 当门槛等于这条功能永不触发。下面的「③ 边界」就是钉这个坑的。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { closeDb } = await import('../src/db/index.js');
const svc = await import('../src/services/intimateActionService.js');

after(() => { closeDb() });

/** 造一个「已经插进去了、有累积」的状态，再按需覆盖字段 */
function sceneState(over = {}) {
  const base = svc.emptySceneState(1);
  return svc.normalizeSceneState({
    ...base,
    active: true,
    penetrating: true,
    positionKey: 'missionary',
    actKey: 'missionary',
    pace: 2,
    rounds: 12,
    actionSeq: 12,
    accumulation: 40,
    ...over,
  }, 1);
}

const PLEA_CORE = '主动开口留他';      // 高累积档的关键词（"求"）
const MILD_CORE = '别写成';            // 低累积档的关键词（"别写成做完了"）

/** 走一次「拔出」，返回 { before, after, text }（text = 当场那条反应的 prompt 全文） */
function pullOut(accumulation) {
  const before = sceneState({ accumulation });
  const planned = svc.planIntimateAction(before, { actionKey: 'stop' });
  assert.equal(planned.ok, true, '拔出本身要能执行：' + JSON.stringify(planned.code));
  const after = planned.next;
  const prompt = svc.buildIntimateActionPrompt({
    actionKey: 'stop', state: before, next: after, characterName: '她', userName: '他',
  });
  return { before, after, text: prompt.user + '\n' + prompt.system };
}

// ── ① 当场那一条反应（buildIntimateActionPrompt）──────────────────────────

test('① 拔出（高累积）：当场那一条反应 prompt 必须要求她**主动开口留他**', () => {
  const { after, text } = pullOut(svc.EDGE_THRESHOLD);
  assert.equal(after.penetrating, false, '拔出后不该还插着');
  assert.equal(after.active, true, '拔出**不收场**（active 保持 true）—— 这是整个功能的前提');
  assert.ok(text.includes(PLEA_CORE), '高累积拔出后必须要求她主动开口留人；实际 prompt 里没有');
  assert.ok(text.includes('未插入'), '状态行要如实写"未插入"');
});

test('② 拔出（低累积）：只写"不满 / 还没结束"，**不许**出现"主动求他继续"', () => {
  const { after, text } = pullOut(10);
  assert.ok(after.accumulation < svc.PULL_OUT_BEG_ACCUMULATION, '夹具：累积必须低于门槛');
  assert.ok(text.includes(MILD_CORE), '低累积拔出也要给约束（别写成做完了）');
  assert.ok(text.includes('还没结束'), '要点明"这一场还没结束"');
  assert.equal(text.includes(PLEA_CORE), false, '低累积**不许**要求她开口求 —— 刚开个头就求人是不对的');
});

test('③ 边界：门槛是 50（不是 60）—— 因为 stop 自己会 -5，含端点算"求"', () => {
  // 这一条是本次抓到的真缺陷的回归守卫：before=55 拔出去后 = 50 ⇒ 必须求。
  // （若门槛误用 EDGE_THRESHOLD=60，这里 after=50 < 60 ⇒ 不求 ⇒ 功能对"边缘上的人"永不触发。）
  const atThreshold = pullOut(svc.PULL_OUT_BEG_ACCUMULATION + 5);
  assert.equal(atThreshold.after.accumulation, svc.PULL_OUT_BEG_ACCUMULATION, '夹具：-5 之后刚好落在门槛上');
  assert.ok(atThreshold.text.includes(PLEA_CORE), '含端点：>= 门槛就该求');

  const justUnder = pullOut(svc.PULL_OUT_BEG_ACCUMULATION + 4);
  assert.equal(justUnder.after.accumulation, svc.PULL_OUT_BEG_ACCUMULATION - 1);
  assert.equal(justUnder.text.includes(PLEA_CORE), false, '差 1 点就不求');

  // 顺带钉住"门槛必须低于边缘"，防止以后有人"顺手统一"成 EDGE_THRESHOLD
  assert.ok(svc.PULL_OUT_BEG_ACCUMULATION < svc.EDGE_THRESHOLD, '求继续的门槛必须低于高潮边缘');
  assert.ok(svc.PULL_OUT_BEG_ACCUMULATION > 30, '也别低到"刚开个头"那一档（<30）去');
});

test('④ 还在插着 / 没开始 ⇒ 一律不出现"求继续"那一段（不能误伤正常动作）', () => {
  // 还在插着
  const in_ = sceneState({ accumulation: svc.EDGE_THRESHOLD + 20 });
  const thrust = svc.buildIntimateActionPrompt({
    actionKey: 'thrust', state: in_, next: svc.planIntimateAction(in_, { actionKey: 'thrust' }).next,
    characterName: '她', userName: '他',
  });
  assert.equal((thrust.user + thrust.system).includes(PLEA_CORE), false, '插着的时候不许出现"求继续"');

  // 没开始
  const idle = svc.normalizeSceneState({ ...svc.emptySceneState(1) }, 1);
  const enter = svc.buildIntimateActionPrompt({
    actionKey: 'enter', state: idle, next: svc.planIntimateAction(idle, { actionKey: 'enter' }).next,
    characterName: '她', userName: '他',
  });
  assert.equal((enter.user + enter.system).includes(PLEA_CORE), false, '还没开始不许出现"求继续"');
});

// ── ② 之后的轮次（buildIntimateSceneBlock）─────────────────────────────────

test('⑤ 场景块：拔出去后（active && !penetrating）也要带上求继续 —— 她下一轮还记得', () => {
  const pulledOut = sceneState({ penetrating: false, accumulation: svc.PULL_OUT_BEG_ACCUMULATION + 10 });
  const block = svc.buildIntimateSceneBlock(pulledOut, { chatUserName: '他' });
  assert.ok(block.length > 0, '这一场还开着 ⇒ 场景块不该为空');
  assert.ok(block.includes(PLEA_CORE), '高累积拔出去后，场景块要提示她主动留人');
  assert.ok(block.includes('没有插进去'), '状态行要如实描述');

  const mild = svc.buildIntimateSceneBlock(sceneState({ penetrating: false, accumulation: 5 }), { chatUserName: '他' });
  assert.ok(mild.includes('还没结束'), '低累积也要点明这一场没结束');
  assert.equal(mild.includes(PLEA_CORE), false, '低累积不许求');

  // 反向：插着的时候场景块不许出现"求继续"（那是另一条 isBegging 的地盘）
  const inside = svc.buildIntimateSceneBlock(sceneState({ penetrating: true, accumulation: svc.EDGE_THRESHOLD + 10 }), { chatUserName: '他' });
  assert.equal(inside.includes(PLEA_CORE), false, '插着的时候不走"拔出去"那段');

  // 反向：没开始 ⇒ 场景块整块为空（既定契约，别被这段破坏）
  assert.equal(svc.buildIntimateSceneBlock(svc.emptySceneState(1), { chatUserName: '他' }), '', '没开始就整块为空');
});

test('⑥ 拔出会把"自动插入"一起停掉（否则她会没人吩咐地自己动起来）', () => {
  const before = sceneState({ autoThrust: 1, accumulation: svc.EDGE_THRESHOLD + 5 });
  const after = svc.planIntimateAction(before, { actionKey: 'stop' }).next;
  assert.equal(after.autoThrust, 0, '拔出必须把自动插入一起停');
  assert.equal(after.penetrating, false);
  assert.equal(after.active, true, '但不收场');
  assert.ok(after.accumulation < before.accumulation, '拔出让累积回落一点');
  // 而这一步正是上面那个门槛必须低于 EDGE_THRESHOLD 的原因 —— 落差就来自这里
  assert.equal(before.accumulation - after.accumulation, 5, '落差固定 5（改这里就要重新审 PULL_OUT_BEG_ACCUMULATION）');
});
