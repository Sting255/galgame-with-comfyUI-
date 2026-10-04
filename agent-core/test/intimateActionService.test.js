/**
 * 性爱交互「可点击推进」· 服务层纯逻辑回归（task-1）
 *
 * 覆盖（全部脱离 HTTP 与模型，只吃状态对象）：
 *   · 状态机：进入 → 继续抽插 → 加速 → 换姿势 → 慢下来 → 停下 → 一起到；
 *   · 档位上下限（已经「冲刺」不能再快 / 已经最慢不能再慢）；
 *   · 未插入时的拒绝（点「继续抽插」必须被拒且 reason 是人话）；
 *   · 非插入体位（口交 / 乳交）点「进入她」被拒；
 *   · 累积度：到顶自动高潮并清零、边缘门槛、「一起到」的门槛；
 *   · 换姿势：非法体位不认、好感太低 she_refuses、好感够就换过去；
 *   · prompt 块：含当前体位 / 节奏 / 累积，且明确写死「不许说我们开始吧」这类矛盾；
 *   · 即时反应 prompt：JSON 示例字段齐全（AGENTS.md「LLM 输出」节）+ 每字段约束 + 只输出 JSON；
 *   · **体位清单必须真实存在于 adult_pose_vocabulary**（本仓踩过"把不存在的 key 钉成正确"的坑）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const svc = await import('../src/services/intimateActionService.js');
const intimate = await import('../src/services/intimateService.js');

after(() => { closeDb(); });

let seq = 0;
function seedCharacter() {
  seq += 1;
  const info = getDb().prepare(
    `INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, '完整人格', '短人格')`
  ).run(`ia_${seq}`, `推进${seq}`);
  return Number(info.lastInsertRowid);
}

// ── 1. 状态机主链 ──

test('状态机：进入 → 继续 → 加速 → 换姿势 → 慢下来 → 停下（每一步都产出新状态）', () => {
  const empty = svc.emptySceneState(1);
  assert.equal(empty.active, false);
  assert.equal(empty.penetrating, false);
  assert.equal(empty.pace, svc.DEFAULT_PACE, '默认节奏「正常」');
  assert.equal(empty.accumulation, 0);

  // 没插入就点「继续抽插」→ 拒绝（验收标准 1 明写的那条）
  const denied = svc.planIntimateAction(empty, { actionKey: 'thrust' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'not_penetrating');
  assert.match(denied.message, /进入她/, '拒绝文案要告诉他下一步怎么点');
  assert.deepEqual(denied.next, svc.normalizeSceneState(empty), '被拒时状态一个字段都不许动');

  const enter = svc.planIntimateAction(empty, { actionKey: 'enter' });
  assert.equal(enter.ok, true);
  assert.equal(enter.next.active, true);
  assert.equal(enter.next.penetrating, true);
  // 2026-10-02 节奏重定：进入的初始推进从 10 降到 6（原来叠上补算 tick 一下能涨 42，
  // 用户实测「累加得太快了」⇒ 全场增益按"十几下到边缘"重排）
  assert.equal(enter.next.accumulation, 6, '进入本身也有推进');
  assert.equal(enter.effects.record.actKey, 'vaginal', '插入类体位记阴道口径');
  assert.equal(enter.next.actionSeq, 1);

  // 已经在里面还点「进入她」→ 拒绝
  const again = svc.planIntimateAction(enter.next, { actionKey: 'enter' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'already_penetrating');

  const thrust = svc.planIntimateAction(enter.next, { actionKey: 'thrust' });
  assert.equal(thrust.ok, true);
  assert.equal(thrust.next.penetrating, true);
  assert.ok(thrust.next.accumulation > enter.next.accumulation, '抽插必须推进累积');

  const faster = svc.planIntimateAction(thrust.next, { actionKey: 'faster' });
  assert.equal(faster.ok, true);
  assert.equal(faster.next.pace, svc.DEFAULT_PACE + 1, '加速升一档');

  const change = svc.planIntimateAction(faster.next, {
    actionKey: 'position', positionKey: 'doggystyle', affinity: 80,
  });
  assert.equal(change.ok, true);
  assert.equal(change.next.positionKey, 'doggystyle');
  assert.equal(change.next.actKey, 'vaginal');
  assert.equal(change.next.penetrating, true, '换姿势之后仍然是插入中（beat 里写了他退出来又进去）');
  assert.equal(change.effects.attitude, 'cooperative', '好感 80 = 主动配合');

  const slower = svc.planIntimateAction(change.next, { actionKey: 'slower' });
  assert.equal(slower.ok, true);
  assert.equal(slower.next.pace, svc.DEFAULT_PACE, '慢下来降一档');

  const stop = svc.planIntimateAction(slower.next, { actionKey: 'stop' });
  assert.equal(stop.ok, true);
  assert.equal(stop.next.penetrating, false);
  assert.equal(stop.next.active, true, '停下是"退出来喘口气"，不是收场');
  assert.equal(stop.next.pace, svc.DEFAULT_PACE);
  assert.ok(stop.next.accumulation <= slower.next.accumulation, '停下会让累积回落一点');
  assert.equal(stop.effects.stopped, true);
});

test('换姿势的过渡句写清「先退出来 → 换过去 → 重新插回去」', () => {
  const entered = { ...svc.emptySceneState(2), active: true, penetrating: true, positionKey: 'missionary', actKey: 'vaginal' };
  const planned = svc.planIntimateAction(entered, { actionKey: 'position', positionKey: 'doggystyle', affinity: 80 });
  const target = svc.resolveTargetPosition('doggystyle');
  const beat = svc.describeActionBeat({ actionKey: 'position', state: entered, next: planned.next, target });
  assert.match(beat, /退出来/);
  assert.match(beat, /重新插/);
  assert.match(beat, /狗爬式/, '过渡句要写清换到哪个体位（中文名）');
});

// ── 2. 档位上下限 ──

test('节奏档位上下限：冲刺再加速被拒（pace_max）、最慢再慢下来被拒（pace_min）', () => {
  const maxed = { ...svc.emptySceneState(3), active: true, penetrating: true, pace: svc.PACE_MAX };
  const faster = svc.planIntimateAction(maxed, { actionKey: 'faster' });
  assert.equal(faster.ok, false);
  assert.equal(faster.code, 'pace_max');
  assert.equal(faster.next.pace, svc.PACE_MAX, '被拒时档位不动');
  assert.match(faster.message, /冲刺/);

  const floored = { ...svc.emptySceneState(3), active: true, penetrating: true, pace: svc.PACE_MIN };
  const slower = svc.planIntimateAction(floored, { actionKey: 'slower' });
  assert.equal(slower.ok, false);
  assert.equal(slower.code, 'pace_min');
  assert.equal(slower.next.pace, svc.PACE_MIN);

  assert.equal(svc.paceLabelOf(1), '缓');
  assert.equal(svc.paceLabelOf(2), '正常');
  assert.equal(svc.paceLabelOf(3), '快');
  assert.equal(svc.paceLabelOf(4), '冲刺');
  assert.equal(svc.paceLabelOf(99), '冲刺', '非法值夹取');
  assert.equal(svc.paceLabelOf(0), '缓');
});

test('未插入时：继续 / 加速 / 慢下来 / 一起到 四类全部拒绝，且都是 not_penetrating', () => {
  const stopped = { ...svc.emptySceneState(4), active: true, penetrating: false, positionKey: 'missionary', actKey: 'vaginal' };
  for (const actionKey of ['thrust', 'faster', 'slower', 'climax']) {
    const result = svc.planIntimateAction(stopped, { actionKey });
    assert.equal(result.ok, false, actionKey + ' 不该在未插入时可用');
    assert.equal(result.code, 'not_penetrating', actionKey + ' 的拒绝码');
    assert.ok(result.message.length > 0, actionKey + ' 必须给人话理由');
  }
});

test('非插入体位（跪姿口交）：点「进入她」被拒（position_not_penetrative）', () => {
  const oral = svc.resolveTargetPosition('kneeling, blowjob');
  assert.ok(oral, '夹具：词表里必须有这个体位');
  assert.equal(oral.actKey, 'oral');
  assert.equal(oral.penetrative, false);
  const state = { ...svc.emptySceneState(5), active: true, positionKey: oral.key, actKey: oral.actKey };
  const enter = svc.planIntimateAction(state, { actionKey: 'enter' });
  assert.equal(enter.ok, false);
  assert.equal(enter.code, 'position_not_penetrative');
  assert.match(enter.message, /口/);
});

// ── 3. 累积度与高潮 ──

test('累积到顶：自动高潮一次并清零（推进感的落点）', () => {
  const near = {
    ...svc.emptySceneState(6), active: true, penetrating: true,
    pace: svc.PACE_MAX, accumulation: 95, climaxCount: 0,
  };
  const result = svc.planIntimateAction(near, { actionKey: 'thrust' });
  assert.equal(result.ok, true);
  assert.equal(result.effects.climaxed, true, '这一下直接把她推过去了');
  assert.equal(result.next.accumulation, 0, '高潮后重新累积');
  assert.equal(result.next.climaxCount, 1);
  assert.equal(result.effects.record.climaxCount, 1, '看板要记一笔高潮');
});

test('「一起到」有门槛：没到边缘被拒（not_edge），到边缘后成功且清零', () => {
  const early = {
    ...svc.emptySceneState(7), active: true, penetrating: true,
    accumulation: svc.CLIMAX_MIN_ACCUMULATION - 1,
  };
  const denied = svc.planIntimateAction(early, { actionKey: 'climax' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'not_edge');
  assert.match(denied.message, new RegExp(String(svc.CLIMAX_MIN_ACCUMULATION)), '拒绝文案要带上门槛数字');

  const edge = { ...early, accumulation: svc.CLIMAX_MIN_ACCUMULATION };
  const ok = svc.planIntimateAction(edge, { actionKey: 'climax' });
  assert.equal(ok.ok, true);
  assert.equal(ok.effects.climaxed, true);
  assert.equal(ok.next.accumulation, 0);
  assert.equal(ok.next.climaxCount, 1);
  assert.ok(ok.next.pace <= edge.pace, '高潮之后节奏不会更快');
});

test('累积档位：calm / rising / edge / overload 四档，边界值明确', () => {
  assert.equal(svc.accumulationTier(0).key, 'calm');
  assert.equal(svc.accumulationTier(29).key, 'calm');
  assert.equal(svc.accumulationTier(30).key, 'rising');
  assert.equal(svc.accumulationTier(59).key, 'rising');
  assert.equal(svc.accumulationTier(svc.EDGE_THRESHOLD).key, 'edge');
  assert.equal(svc.accumulationTier(84).key, 'edge');
  assert.equal(svc.accumulationTier(svc.OVERLOAD_THRESHOLD).key, 'overload');
  assert.equal(svc.accumulationTier(100).key, 'overload');
  assert.match(svc.accumulationTier(100).prompt, /不受控|失控|绷不住/, '越接近高潮她越不受控，要写进 prompt');
});

// ── 4. 换姿势：合法性 / 配合抗拒 ──

test('换姿势：词表里没有的体位一律不认（invalid_position）', () => {
  const state = { ...svc.emptySceneState(8), active: true, penetrating: true };
  for (const bogus of ['', '不存在的体位', 'no_such_position_xyz', null]) {
    const result = svc.planIntimateAction(state, { actionKey: 'position', positionKey: bogus });
    assert.equal(result.ok, false, JSON.stringify(bogus) + ' 不该被认');
    assert.equal(result.code, 'invalid_position');
  }
  assert.equal(svc.resolveTargetPosition('no_such_position_xyz'), null);
});

test('换姿势的配合 / 抗拒取决于好感与当时状态', () => {
  const state = { ...svc.emptySceneState(9), active: true, penetrating: true, accumulation: 10 };
  // 好感 10 + 刚进来 → 她按住手
  const refused = svc.planIntimateAction(state, { actionKey: 'position', positionKey: 'doggystyle', affinity: 10 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'she_refuses');
  assert.deepEqual(refused.next, svc.normalizeSceneState(state), '被拒时状态不动');
  // 同好感但已经被推到边缘 → 不拒（身体已经在状态里）
  const hot = svc.planIntimateAction({ ...state, accumulation: 70 }, { actionKey: 'position', positionKey: 'doggystyle', affinity: 10 });
  assert.equal(hot.ok, true);
  // 催眠中不拒
  const hypnotized = svc.planIntimateAction(state, { actionKey: 'position', positionKey: 'doggystyle', affinity: 5, hypnotized: true });
  assert.equal(hypnotized.ok, true);
  assert.equal(hypnotized.effects.attitude, 'hypnotized');
  // 好感 50 → 害羞但配合
  assert.equal(svc.planIntimateAction({ ...state, accumulation: 40 }, { actionKey: 'position', positionKey: 'doggystyle', affinity: 50 }).effects.attitude, 'shy');
  // 好感 20 但人已经被推到边缘 → 配合
  assert.equal(svc.planIntimateAction(state, { actionKey: 'position', positionKey: 'doggystyle', affinity: 20, hypnotized: false }).ok, true);
});

test('态度文案四档都有话（配合 / 害羞 / 不情愿 / 催眠）', () => {
  assert.match(svc.attitudePromptLine('cooperative'), /配合/);
  assert.match(svc.attitudePromptLine('shy'), /羞/);
  assert.match(svc.attitudePromptLine('reluctant'), /不太情愿/);
  assert.match(svc.attitudePromptLine('hypnotized'), /催眠/);
  assert.equal(svc.attitudePromptLine(''), '');
});

test('换到非插入体位（口交）：插入状态必须落回未插入，否则会自相矛盾', () => {
  const inside = {
    ...svc.emptySceneState(16), active: true, penetrating: true,
    positionKey: 'missionary', actKey: 'vaginal',
  };
  const oral = svc.resolveTargetPosition('kneeling, blowjob');
  const planned = svc.planIntimateAction(inside, { actionKey: 'position', positionKey: oral.key, affinity: 80 });
  assert.equal(planned.ok, true);
  assert.equal(planned.next.positionKey, oral.key);
  assert.equal(planned.next.actKey, 'oral');
  assert.equal(planned.next.penetrating, false, '换到口交不可能还"在里面"');
  const beat = svc.describeActionBeat({ actionKey: 'position', state: inside, next: planned.next, target: oral });
  assert.match(beat, /退了出来/);
  assert.ok(!beat.includes('重新插了回去'), '换到口交不该写"重新插回去"');
  assert.equal(svc.planIntimateAction(planned.next, { actionKey: 'thrust' }).code, 'not_penetrating');

  // 换回插入体位也不会自动插回去（要再点「进入她」），但那时「进入她」必须可用
  const back = svc.planIntimateAction(planned.next, { actionKey: 'position', positionKey: 'doggystyle', affinity: 80 });
  assert.equal(back.next.penetrating, false);
  assert.equal(svc.planIntimateAction(back.next, { actionKey: 'enter' }).ok, true);
});

// ── 5. 体位词表真实存在（防"钉错 key"） ──

test('面板体位清单：每一条都真实存在于 adult_pose_vocabulary，且拿得到中文名', () => {
  const options = svc.listPositionOptions();
  assert.ok(options.length >= 10, '精选体位至少 10 条（实际 ' + options.length + '）');
  const map = intimate.getPositionVocabularyMap();
  for (const option of options) {
    assert.ok(map.has(option.key), `体位 key 必须真的在词表里：${option.key}`);
    assert.ok(option.label && option.label !== option.key, `必须有中文名：${option.key}`);
    assert.ok(typeof option.penetrative === 'boolean');
  }
  const keys = options.map(o => o.key);
  assert.ok(keys.includes('missionary'));
  assert.ok(keys.includes('doggystyle'));
  assert.ok(options.some(o => o.penetrative), '至少要有能插入的体位');
  assert.ok(options.some(o => !o.penetrative), '也要有非插入体位（口 / 手 / 乳）');
  // 后庭必须归到 anal 而不是 vaginal（归类走 ACT_DEFINITIONS 冻结词表）
  assert.equal(options.find(o => o.key === 'anal insertion')?.actKey, 'anal');
});

test('actKeyForPosition：口/手/乳/舔归到各自 act，插不进去的归 unspecified', () => {
  assert.equal(svc.actKeyForPosition('missionary'), 'vaginal');
  assert.equal(svc.actKeyForPosition('anal insertion'), 'anal');
  assert.equal(svc.actKeyForPosition('kneeling, blowjob'), 'oral');
  assert.equal(svc.actKeyForPosition('paizuri'), 'breast');
  assert.equal(svc.actKeyForPosition('handjob'), 'hand');
  assert.equal(svc.actKeyForPosition('69'), 'unspecified');
  assert.equal(svc.isPenetrativeAct(svc.actKeyForPosition('missionary')), true);
  assert.equal(svc.isPenetrativeAct(svc.actKeyForPosition('handjob')), false);
});

// ── 6. prompt 块：喂进当前体位 / 节奏 / 累积，并禁止前后矛盾 ──

test('场景块：含当前体位 / 节奏 / 累积，并写死「不许说我们开始吧」', () => {
  const state = {
    ...svc.emptySceneState(10), active: true, penetrating: true,
    positionKey: 'doggystyle', actKey: 'vaginal', pace: 3, accumulation: 66, rounds: 7, climaxCount: 0,
  };
  const block = svc.buildIntimateSceneBlock(state, { chatUserName: '你', affinityText: '好感：亲密', hypnotized: false });
  assert.ok(block.startsWith('<intimate_scene>'));
  assert.ok(block.endsWith('</intimate_scene>'));
  assert.ok(block.includes('狗爬式'), '当前体位（中文名）');
  assert.ok(block.includes('doggystyle'), '当前体位（与生图同源的 key）');
  assert.ok(block.includes('快'), '当前节奏档');
  assert.match(block, /66\/100/, '累积度');
  assert.ok(block.includes('高潮边缘'), '累积 66 属于边缘档');
  assert.match(block, /已经插进去了/, '插入状态要写清，不许她装作没发生');
  assert.match(block, /我们开始吧/, '必须显式禁止前后矛盾的说法');
  assert.match(block, /不要问「要不要」/);
  assert.ok(block.includes('好感：亲密'));
  // 未进行中 = 零注入
  assert.equal(svc.buildIntimateSceneBlock(svc.emptySceneState(10)), '');
  assert.equal(svc.buildIntimateSceneBlock({ ...state, active: false }), '');
});

test('场景块：她之前高潮过要写明，别写成刚开始', () => {
  const state = {
    ...svc.emptySceneState(11), active: true, penetrating: true,
    positionKey: 'missionary', actKey: 'vaginal', accumulation: 20, climaxCount: 2,
  };
  const block = svc.buildIntimateSceneBlock(state);
  assert.match(block, /高潮过 2 次/);
  assert.match(block, /别再写成刚开始/);
});

test('聊天轮注入入口（读库版）：进行中才给块，未进行中 / 超时收场后一律零注入', async () => {
  const id = seedCharacter();
  const { toSqlUtc } = await import('../src/services/programTime.js');
  const nowSql = toSqlUtc(new Date());
  // 未开始：零注入（调用方据此不 push）
  assert.equal(svc.buildIntimateScenePromptBlock(id, { chatUserName: '你' }), '');

  // 落一条进行中状态 → 块里带体位 / 节奏 / 累积
  svc.saveIntimateScene(id, {
    ...svc.emptySceneState(id),
    active: true, penetrating: true, positionKey: 'doggystyle', actKey: 'vaginal',
    pace: 3, accumulation: 72, rounds: 5, actionSeq: 5,
    startedAt: nowSql, lastActionAt: nowSql,
  });
  const block = svc.buildIntimateScenePromptBlock(id, { chatUserName: '你', affinityText: '好感：亲密' });
  assert.ok(block.startsWith('<intimate_scene>'));
  assert.ok(block.includes('狗爬式'));
  assert.ok(block.includes('doggystyle'));
  assert.ok(block.includes('快'));
  assert.match(block, /72\/100/);
  assert.match(block, /我们开始吧/);
  assert.ok(block.includes('好感：亲密'));

  // 空闲超时 → 收场 → 零注入（隔夜不会还"插着"）
  getDb().prepare('UPDATE character_intimate_scene SET last_action_at = ? WHERE character_id = ?')
    .run('2020-01-01 00:00:00', id);
  assert.equal(svc.buildIntimateScenePromptBlock(id, { chatUserName: '你' }), '');
  assert.equal(svc.getIntimateScene(id).active, false, '读入口顺手收场，状态也要落回未进行中');
});

test('即时反应 prompt：字段齐全的 JSON 示例 + 逐字段约束 + 只输出 JSON + 直述不擦边', () => {
  const before = {
    ...svc.emptySceneState(12), active: true, penetrating: true,
    positionKey: 'missionary', actKey: 'vaginal', pace: 2, accumulation: 40,
  };
  const planned = svc.planIntimateAction(before, { actionKey: 'faster' });
  const prompt = svc.buildIntimateActionPrompt({
    actionKey: 'faster', state: before, next: planned.next,
    persona: '短人格', characterName: '小满', userName: '你',
    emotionText: '情绪：开心', affinityText: '好感：亲密', recentLines: ['你：过来'],
    hypnotized: false,
  });
  assert.equal(prompt.label, '性爱互动即时反应');
  assert.equal(prompt.messages.length, 2);
  const system = prompt.system;
  // JSON 示例（AGENTS.md：字段名 + 示例值 + 每字段要求）
  for (const field of ['reaction_text', 'image_prompt', 'emotion_delta', 'facial_expression', 'annoyed']) {
    assert.ok(system.includes('"' + field + '"'), 'JSON 示例必须给全字段：' + field);
    assert.ok(system.includes('`' + field + '`'), '每个字段都要有要求说明：' + field);
  }
  assert.match(system, /只输出 JSON|不要输出 JSON 以外的文字/);
  assert.match(system, /直述/, '本仓口径：直述、不擦边');
  assert.match(system, /不要暗示|不要打码/);
  assert.match(system, /不许问「要不要」/, '不许前后矛盾');
  assert.match(system, /体位/, '要写清体位');
  assert.ok(system.includes('传教士体位'), '喂进当前体位的中文名');
  assert.ok(system.includes('快'), '喂进这一下之后的节奏');
  assert.ok(prompt.user.includes('加速抽插'), '喂进这一下做了什么');
  assert.ok(prompt.meta.penetrating === true && prompt.meta.pace === 3);
  assert.ok(prompt.meta.blocks.includes('scene'), '场景块必须在喂料清单里');
});

test('即时反应 prompt：未知动作给空 prompt（路由层已先拦，这里是最后一道）', () => {
  const prompt = svc.buildIntimateActionPrompt({ actionKey: 'nope', state: svc.emptySceneState(13) });
  assert.equal(prompt.system, '');
  assert.deepEqual(prompt.messages, []);
});

test('即时反应 prompt：换姿势带上「配合 / 抗拒」这一行', () => {
  const before = { ...svc.emptySceneState(14), active: true, penetrating: true, positionKey: 'missionary', actKey: 'vaginal' };
  const planned = svc.planIntimateAction(before, { actionKey: 'position', positionKey: 'doggystyle', affinity: 80 });
  const prompt = svc.buildIntimateActionPrompt({
    actionKey: 'position', state: before, next: planned.next,
    target: svc.resolveTargetPosition('doggystyle'), attitude: planned.effects.attitude,
  });
  assert.ok(prompt.system.includes('狗爬式'));
  assert.match(prompt.system, /配合/);
  assert.match(prompt.system, /这个体位的身体细节|身体细节/);
});

// ── 7. 归一化与面板快照 ──

test('normalizeSceneState：脏数据夹取，不能把非法值带进状态机', () => {
  const state = svc.normalizeSceneState({
    character_id: 3, active: 1, penetrating: 1, position_key: '', act_key: '',
    pace: 99, accumulation: 999, climax_count: -5, rounds: 'x', action_seq: -1,
  });
  assert.equal(state.characterId, 3);
  assert.equal(state.active, true);
  assert.equal(state.pace, svc.PACE_MAX);
  // 2026-10-02：「禁止高潮」要求她的高潮值能涨过满格 ⇒ 累积的夹取上限放宽到 DENIAL_MAX_ACCUMULATION(200)。
  // 不懈禁时的 100 收口由「到顶自动高潮」负责，不靠这里夹（所以脏数据也只夹到 200）。
  assert.equal(state.accumulation, svc.DENIAL_MAX_ACCUMULATION);
  assert.equal(state.climaxCount, 0);
  assert.equal(state.rounds, 0);
  assert.equal(state.actionSeq, 0);
  assert.equal(state.positionKey, svc.DEFAULT_POSITION_KEY, '空体位回落默认');
  // 没 active 就不算插入中（防止脏行留下一根插着的幽灵）
  assert.equal(svc.normalizeSceneState({ active: 0, penetrating: 1 }).penetrating, false);
  assert.equal(svc.normalizeSceneState(null).active, false);
});

test('面板快照：动作可用性与状态机判定完全一致（前端置灰理由 = 后端拒绝理由）', () => {
  const base = {
    ...svc.emptySceneState(15), active: true, penetrating: false,
    positionKey: 'missionary', actKey: 'vaginal',
  };
  const notEntered = svc.buildPanelSnapshot(base, { affinity: 50 });
  const thrust = notEntered.actions.find(a => a.key === 'thrust');
  assert.equal(thrust.available, false);
  assert.equal(thrust.code, 'not_penetrating');
  const enter = notEntered.actions.find(a => a.key === 'enter');
  assert.equal(enter.available, true);
  assert.equal(notEntered.state.positionLabel, '传教士体位');
  assert.equal(notEntered.state.paceLabel, '正常');
  assert.equal(notEntered.paceLevels.length, svc.PACE_MAX, '前端要用同一份档位表');
  assert.ok(notEntered.positionOptions.length >= 10);

  // 就在状态机里复核一遍：快照说可用 ⇒ 真点下去必须放行（口径只有一处）
  for (const action of notEntered.actions.filter(a => a.available && a.key !== 'position')) {
    const probe = svc.planIntimateAction(base, { actionKey: action.key, affinity: 50 });
    assert.equal(probe.ok, true, '面板说 ' + action.key + ' 可用，状态机就必须放行');
  }
});
