/**
 * 催眠注入块 builder 单测（task-29 第 1 阶段，无外部依赖）
 *
 * 锁三件事：
 *   1. 三种状态形态：深度催眠 / **只唤醒意志** / 其它组合零注入；
 *      「只唤醒意志」必须写成"意志清醒 + 身体不听话"，**不能写成又睡着了**——用户点名要的新玩法，
 *      也是这两个形态唯一的分界，所以两种文案的关键反差句在本文件里逐条断言；
 *   2. 一次性指令：kind 白名单、forced_climax 按 mindAwake 分流、未知 kind 零注入；
 *   3. 遗忘提示：只在"最近 30 分钟内创建的 active 窗口"存在时注入，且时间戳按 **UTC** 解析
 *      （SQLite 的 CURRENT_TIMESTAMP 不带时区，当本地时间解析会整体偏移一个时区）。
 *
 * 本文件不需要 DB / 不需要 config / 不需要 globalThis.fetch 兜底：模块是纯函数（不 import service）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  AMNESIA_RECENT_MS,
  DIRECTIVE_KINDS,
  MAX_AMNESIA_BLOCK_CHARS,
  MAX_COMMAND_BLOCK_CHARS,
  MAX_STATE_BLOCK_CHARS,
  buildAmnesiaBlock,
  buildDirectiveBlock,
  buildHypnosisStateBlock,
} = await import('../src/services/hypnosisPrompt.js');

/** 状态工厂：默认深度催眠（bodyControlled=1 / mindAwake=0 / active） */
const stateOf = (patch = {}) => ({
  characterId: 1, bodyControlled: true, mindAwake: false, active: true,
  activeUntil: null, startedAt: null, pendingDirective: '', commandCount: 0, lastCommand: '', ...patch,
});

const assertPaired = (block, open, close) => {
  assert.ok(block.startsWith(open), `应以 ${open} 开头：${block.slice(0, 40)}`);
  assert.ok(block.endsWith(close), `应以 ${close} 结尾：${block.slice(-40)}`);
  assert.equal(block.split(open).length - 1, 1, `${open} 只应出现一次`);
  assert.equal(block.split(close).length - 1, 1, `${close} 只应出现一次`);
};

// ──────────────── 1. 状态块 ────────────────

test('深度催眠态：完全控制 —— 意识模糊 + 意志被压制 + 纯执行 + 醒来记不清', async () => {
  const block = buildHypnosisStateBlock(stateOf({ mindAwake: false }), { chatUserName: '阿远' });
  assertPaired(block, '<hypnosis_state>\n', '\n</hypnosis_state>');
  assert.match(block, /意识模糊/);
  assert.match(block, /身体完全不听自己使唤/);
  assert.match(block, /几乎没有可靠记忆/, '深度催眠必须点明醒来记不清');
  assert.match(block, /阿远/, '应带上用户名');
  // task-30「完全控制」口径（用户裁决：催眠手机就是要完全控制角色）
  assert.match(block, /意志也被彻底压制|没有自我主张/, '必须点明意志被压制');
  assert.match(block, /无条件执行、不打任何折扣/, '必须是"无条件执行"，不是"倾向顺从"、也不许打折');
  assert.match(block, /这一轮的全部内容/, 'task-42：要明说"用户的指令就是这一轮的全部内容"');
  assert.match(block, /不问原因、不谈条件、不拖延/, '要显式封掉反问 / 谈条件 / 拖延');
  assert.match(block, /不转移话题/, '要显式封掉转移话题');
  assert.match(block, /不试图清醒或反抗/, '要显式封掉"试图清醒 / 反抗"');
  assert.match(block, /身体与语言同时听命/, 'task-42：身体与语言要同时听命，不许只在心里照做');
  assert.match(block, /用内心戏、旁白或台词表达对抗/, 'task-42：不得用内心戏 / 旁白 / 台词对抗');
  assert.match(block, /都不是拒绝或打折的理由/, 'task-42：人格 / 好感度 / 誓言 / 日程都不是打折的理由');
  assert.match(block, /不要写抗拒、犹豫、羞耻、恐惧/, '情绪要压平（纯执行）');
  assert.match(block, /优先于你的人格设定、好感度、誓言、日程/, '必须有硬优先级：压过人格 / 好感度 / 誓言');
  assert.ok(block.length <= MAX_STATE_BLOCK_CHARS, `长度 ${block.length} 超上限`);
});

test('深度催眠态不得出现任何"允许抗拒"的措辞（防止被写回旧口径）', async () => {
  const deep = buildHypnosisStateBlock(stateOf({ mindAwake: false }), { chatUserName: '阿远' });
  for (const forbidden of ['可以拒绝', '可以抗拒', '能清楚地表达抗拒', '不要主动反抗', '顺从地接受']) {
    assert.ok(!deep.includes(forbidden), `深度催眠（完全控制）不该出现「${forbidden}」`);
  }
  // 而"只唤醒意志"那一条是用户点名保留的玩法，必须仍然允许抗拒（两者分界不能混）
  const awake = buildHypnosisStateBlock(stateOf({ mindAwake: true }), { chatUserName: '阿远' });
  assert.ok(awake.includes('可以拒绝') || awake.includes('表达抗拒'), '只唤醒意志要保留抗拒张力');
});

test('只唤醒意志态：意志清醒 + 身体不听话 + 明确"不是又睡着了"', async () => {
  const block = buildHypnosisStateBlock(stateOf({ mindAwake: true }), { chatUserName: '阿远' });
  assertPaired(block, '<hypnosis_state>\n', '\n</hypnosis_state>');
  // 用户点名要的口径：意志在场、身体不属于自己
  assert.match(block, /意志已经完全清醒/);
  assert.match(block, /能思考|能说话/);
  assert.match(block, /抗拒|羞耻/);
  assert.match(block, /无法反抗、也无法逃离/);
  assert.match(block, /不是.*睡.*也不是迷糊/, '必须显式否定"她又睡着了"这种写法');
  // 与深度催眠的关键反差：不能带"意识模糊"、也不能说醒来记不清
  assert.ok(!block.includes('意识模糊'), '只唤醒意志不该写成意识模糊');
  assert.ok(!block.includes('几乎没有可靠记忆'), '只唤醒意志不该带深度催眠的遗忘口径');
  assert.ok(block.length <= MAX_STATE_BLOCK_CHARS);
});

test('深度催眠与只唤醒意志的文案必须真的不同', async () => {
  const deep = buildHypnosisStateBlock(stateOf({ mindAwake: false }));
  const awake = buildHypnosisStateBlock(stateOf({ mindAwake: true }));
  assert.notEqual(deep, awake);
  assert.ok(!deep.includes('意志已经完全清醒'));
  assert.ok(!awake.includes('几乎没有可靠记忆'));
});

test('状态块零注入：无状态 / 未受控 / 已过期 / 非法入参', async () => {
  assert.equal(buildHypnosisStateBlock(null), '');
  assert.equal(buildHypnosisStateBlock(undefined), '');
  assert.equal(buildHypnosisStateBlock('nope'), '');
  assert.equal(buildHypnosisStateBlock({}), '');
  assert.equal(buildHypnosisStateBlock(stateOf({ bodyControlled: false })), '', '未受控 → 零注入');
  assert.equal(buildHypnosisStateBlock(stateOf({ bodyControlled: false, mindAwake: true })), '');
  assert.equal(buildHypnosisStateBlock(stateOf({ active: false })), '', '已过期 → 零注入');
  assert.equal(buildHypnosisStateBlock(stateOf({ active: false, mindAwake: true })), '');
});

test('状态块：没给用户名时退回中性称呼，不出现 "undefined"', async () => {
  const block = buildHypnosisStateBlock(stateOf({ mindAwake: true }));
  assert.match(block, /对方/);
  assert.ok(!block.includes('undefined'), '用户名缺失不能拼出 undefined');
  assert.ok(!block.includes('user'), '块内不该出现变量名 user');
});

// ──────────────── 2. 一次性指令块 ────────────────

test('指令块：body_control 与 forced_climax 各自成形（body_control 按意志状态分流）', async () => {
  const body = buildDirectiveBlock('body_control');
  assertPaired(body, '<hypnosis_command kind="body_control">\n', '\n</hypnosis_command>');
  assert.match(body, /身体完全由对方操控/);
  assert.match(body, /被动地承受/);
  assert.match(body, /纯执行/, '深度催眠（默认沉睡口径）下身体控制要压平情绪');

  const bodyAwake = buildDirectiveBlock('body_control', { mindAwake: true });
  assert.notEqual(bodyAwake, body, '只唤醒意志要保留"身体带动情绪"的撕裂口径');
  assert.match(bodyAwake, /让身体带动情绪/);

  const climax = buildDirectiveBlock('forced_climax', { mindAwake: false });
  assertPaired(climax, '<hypnosis_command kind="forced_climax">\n', '\n</hypnosis_command>');
  assert.match(climax, /强制带到高潮|被强制/);
  assert.match(climax, /不受你控制/);
  assert.ok(body.length <= MAX_COMMAND_BLOCK_CHARS);
  assert.ok(climax.length <= MAX_COMMAND_BLOCK_CHARS);
});

test('指令块 forced_climax：意识清醒 vs 沉睡必须分流', async () => {
  const awake = buildDirectiveBlock('forced_climax', { mindAwake: true });
  const asleep = buildDirectiveBlock('forced_climax', { mindAwake: false });
  assert.notEqual(awake, asleep);
  assert.match(awake, /意识全程清醒/, '清醒态要点明意识在场');
  assert.match(awake, /羞耻|抗拒/, '清醒态允许并鼓励表达抗拒/羞耻');
  assert.match(awake, /无法阻止|只能被推着走/, '清醒态要点明阻止不了');
  assert.match(asleep, /意识迷糊/, '沉睡态是迷糊服从');
  assert.match(asleep, /顺从/);
  assert.match(asleep, /不写羞耻或挣扎/, '完全控制下情绪要压平（纯执行）');
  // 默认（不传 mindAwake）= 沉睡口径，保持与冻结签名一致
  assert.equal(buildDirectiveBlock('forced_climax'), asleep);
});

test('指令块零注入：未知 kind / 空值 / 非白名单', async () => {
  for (const bad of ['', '  ', null, undefined, 'nope', 'BODY_CONTROL', 'forced_climax ']) {
    const out = buildDirectiveBlock(bad);
    if (bad === 'forced_climax ') assert.notEqual(out, '', '前后空格应被 trim 后接受');
    else assert.equal(out, '', `「${bad}」应零注入`);
  }
  // 2026-10-01：新增 force_toy（命令她用玩具），取值域随之扩一项
  assert.deepEqual([...DIRECTIVE_KINDS], ['body_control', 'forced_climax', 'memory_restore', 'wake_reaction', 'force_toy']);
});

test('指令块 wake_reaction：刚被唤醒那一刻的惊醒 / 错愕 / 恍惚（task-42）', async () => {
  const block = buildDirectiveBlock('wake_reaction');
  assertPaired(block, '<hypnosis_wake_reaction>\n', '\n</hypnosis_wake_reaction>');
  assert.match(block, /猛地惊醒/, '要点明是"惊醒"，不是平淡的睡醒伸懒腰');
  assert.match(block, /恍惚、错愕/, '要有错愕 / 恍惚');
  assert.match(block, /意识与身体差半拍/, '要点明意识与身体对不上');
  assert.match(block, /先去找你在哪/, '要下意识去"找你在哪"');
  assert.match(block, /不要只写一句/, '不许一笔带过成"我醒了"');
  assert.ok(block.length <= MAX_COMMAND_BLOCK_CHARS, `长度 ${block.length} 超上限`);
  // 它不是"命令她做什么" ⇒ 不复用 <hypnosis_command>（与 memory_restore 同处理）
  assert.ok(!block.includes('hypnosis_command'), '唤醒反应不该复用指令标签');
  assert.notEqual(block, buildDirectiveBlock('memory_restore'));

  // 催眠唤醒 / 睡眠唤醒共用一套文案：mindAwake 与 awakenedFromSleep 都不改变它
  assert.equal(buildDirectiveBlock('wake_reaction', { mindAwake: true }), block);
  assert.equal(buildDirectiveBlock('wake_reaction', { mindAwake: false }), block);
  assert.equal(buildDirectiveBlock('wake_reaction', { awakenedFromSleep: true }), block);

  // 群聊：成员限定行 + 仍在 300 字上限内（不许被截断）
  const scoped = buildDirectiveBlock('wake_reaction', { subject: '甲' });
  assertPaired(scoped, '<hypnosis_wake_reaction>\n', '\n</hypnosis_wake_reaction>');
  assert.ok(scoped.includes('【本节只对「甲」生效'), '群聊必须带成员限定行');
  assert.ok(scoped.length <= MAX_COMMAND_BLOCK_CHARS, `带限定行长度 ${scoped.length} 超上限`);
});

test('唤醒反应不污染既有块 / 未知 kind 仍零注入（不传时逐字节不变）', async () => {
  assert.equal(buildDirectiveBlock('wake_reaction '), buildDirectiveBlock('wake_reaction'), '前后空格 trim 后接受');
  for (const kind of ['body_control', 'forced_climax', 'memory_restore']) {
    const out = buildDirectiveBlock(kind);
    assert.ok(!out.includes('hypnosis_wake_reaction'), `${kind} 不得混进唤醒反应块`);
    assert.ok(!out.includes('刚被唤醒'), `${kind} 不得混进唤醒反应文案`);
  }
  const deep = buildHypnosisStateBlock(stateOf({ mindAwake: false }));
  assert.ok(!deep.includes('hypnosis_wake_reaction') && !deep.includes('刚被唤醒'), '状态块不得混进唤醒反应');
  assert.equal(buildDirectiveBlock('wake'), '');
  assert.equal(buildDirectiveBlock('WAKE_REACTION'), '');
  assert.equal(buildDirectiveBlock('wake_reaction', { subject: '' }), buildDirectiveBlock('wake_reaction'), '空 subject = 私聊口径');
});

test('指令块 memory_restore：记忆突然涌回来（标签是 hypnosis_memory_return，不是 command）', async () => {
  const block = buildDirectiveBlock('memory_restore');
  assertPaired(block, '<hypnosis_memory_return>\n', '\n</hypnosis_memory_return>');
  assert.match(block, /突然涌回来/, '要点明记忆是突然回来的');
  assert.match(block, /想起来了/, '要演出"想起来了"的冲击');
  assert.match(block, /困惑|羞耻|愤怒|依恋/, '情绪反应给了合理区间');
  assert.match(block, /接进当前对话/);
  assert.ok(block.length <= MAX_COMMAND_BLOCK_CHARS);
  // 它不是"命令她做什么"，不该复用指令标签
  assert.ok(!block.includes('hypnosis_command'), 'memory_restore 不应产出 <hypnosis_command>');
  // mindAwake 不影响它（记忆恢复与意识是否清醒无关）
  assert.equal(buildDirectiveBlock('memory_restore', { mindAwake: true }), block);
});

// ──────────────── 3. 遗忘提示块 ────────────────

test('遗忘提示：最近 30 分钟内的 active 窗口 → 注入，且带"禁止编造记忆"约束', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const windows = [{ id: 7, status: 'active', createdAt: new Date(now - 5 * 60 * 1000).toISOString() }];
  const block = buildAmnesiaBlock(windows, { now });
  assertPaired(block, '<hypnosis_amnesia>\n', '\n</hypnosis_amnesia>');
  assert.match(block, /断片、模糊/);
  assert.match(block, /禁止编造不存在的记忆/);
  assert.match(block, /困惑/);
  assert.ok(block.length <= MAX_AMNESIA_BLOCK_CHARS);
});

test('遗忘提示：SQLite 的无时区时间戳必须按 UTC 解析（不是本地时间）', async () => {
  // 30 分钟窗口的边界正好能暴露"当本地时间解析"的时区偏移
  const now = Date.parse('2026-09-28T12:00:00Z');
  const utc = new Date(now - 10 * 60 * 1000);
  const sqliteStamp = utc.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const block = buildAmnesiaBlock([{ id: 1, status: 'active', created_at: sqliteStamp }], { now });
  assert.notEqual(block, '', `UTC 的 ${sqliteStamp} 应被判定为"最近 10 分钟"`);
});

test('遗忘提示：snake_case / camelCase / ISO 三种形状都能识别', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const recentIso = new Date(now - 60 * 1000).toISOString();
  const shapes = [
    { created_at: recentIso },
    { createdAt: recentIso },
    { created_at: recentIso.replace('T', ' ').replace(/\.\d+Z$/, '') },
  ];
  for (const shape of shapes) {
    assert.notEqual(buildAmnesiaBlock([{ status: 'active', ...shape }], { now }), '', JSON.stringify(shape));
  }
});

test('遗忘提示零注入：空输入 / 太旧 / 已还原 / 无可用时间', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  assert.equal(buildAmnesiaBlock([]), '');
  assert.equal(buildAmnesiaBlock(null), '');
  assert.equal(buildAmnesiaBlock(undefined), '');
  assert.equal(buildAmnesiaBlock({}), '');

  // 31 分钟前 → 已过窗口
  const old = new Date(now - 31 * 60 * 1000).toISOString();
  assert.equal(buildAmnesiaBlock([{ status: 'active', createdAt: old }], { now }), '');
  // 已还原的窗口不算
  assert.equal(buildAmnesiaBlock([{ status: 'restored', createdAt: new Date(now - 1000).toISOString() }], { now }), '');
  // 没有可解析的时间 → 忽略该行
  assert.equal(buildAmnesiaBlock([{ status: 'active', createdAt: '' }], { now }), '');
  assert.equal(buildAmnesiaBlock([{ status: 'active', createdAt: 'not-a-date' }], { now }), '');
  // 未来时间（时钟漂移）也不注入，避免"刚创建"判定被负数年龄绕过
  assert.equal(buildAmnesiaBlock([{ status: 'active', createdAt: new Date(now + 60 * 1000).toISOString() }], { now }), '');
});

test('遗忘提示：30 分钟边界（29:59 注入 / 30:01 不注入）', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const inside = new Date(now - (AMNESIA_RECENT_MS - 1000)).toISOString();
  const outside = new Date(now - (AMNESIA_RECENT_MS + 1000)).toISOString();
  assert.notEqual(buildAmnesiaBlock([{ status: 'active', createdAt: inside }], { now }), '');
  assert.equal(buildAmnesiaBlock([{ status: 'active', createdAt: outside }], { now }), '');
});

test('三个 builder 的返回形状：要么空串、要么标签成对（含极端入参）', async () => {
  const cases = [
    buildHypnosisStateBlock(stateOf()),
    buildHypnosisStateBlock(stateOf({ mindAwake: true })),
    buildDirectiveBlock('body_control'),
    buildDirectiveBlock('forced_climax', { mindAwake: true }),
    buildDirectiveBlock('memory_restore'),
    buildDirectiveBlock('wake_reaction'),
    buildDirectiveBlock('wake_reaction', { subject: '甲' }),
    buildAmnesiaBlock([{ status: 'active', createdAt: new Date().toISOString() }]),
  ];
  for (const block of cases) {
    assert.notEqual(block, '');
    const open = block.slice(0, block.indexOf('>') + 1).split('\n')[0];
    const tag = open.slice(1, open.indexOf(' ') === -1 ? open.length - 1 : open.indexOf(' '));
    assert.ok(block.startsWith(`<${tag}`), `开标签异常：${block.slice(0, 30)}`);
    assert.ok(block.trimEnd().endsWith(`</${tag}>`), `闭标签异常：${block.slice(-30)}`);
  }
});

test('§4.1③ 意志清醒态：显式禁止身体反抗（不会拍开 / 躲开 / 阻拦任何接触）', async () => {
  const { buildHypnosisStateBlock, HYPNOSIS_WILL_AWAKE_NOTICE } = await import('../src/services/hypnosisPrompt.js');
  assert.ok(HYPNOSIS_WILL_AWAKE_NOTICE.includes('拍开') && HYPNOSIS_WILL_AWAKE_NOTICE.includes('躲开') && HYPNOSIS_WILL_AWAKE_NOTICE.includes('阻拦'),
    '常量本身要带这句（两个态都吃它）');
  const block = buildHypnosisStateBlock({ active: true, bodyControlled: true, mindAwake: true }, { chatUserName: '用户' });
  assert.ok(/不会\*\*拍开、躲开或阻拦任何接触/.test(block), '意志清醒态的块里必须能读到这句：' + block.slice(0, 120));
  const deep = buildHypnosisStateBlock({ active: true, bodyControlled: true, mindAwake: false }, { chatUserName: '用户' });
  assert.ok(deep.includes('无条件执行'), '完全控制态口径不变');
});
