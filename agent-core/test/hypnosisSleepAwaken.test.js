/**
 * 睡梦中被强制高潮唤醒 → 独特表现（task-D）
 *
 * 用户原话：「让角色如果在睡梦中被催眠高潮唤醒 会有独特的表现 让角色有更有意思的表现」。
 *
 * 本文件锁四件事：
 *   1. 睡眠中触发 `forced_climax` → 产出**第三种口径**（不是清醒版、也不是沉睡版），
 *      关键词：深度睡眠 / 鼻音 / 手脚发软 / 恍惚 / 羞耻 / 以为在做梦；
 *   2. **清醒（与沉睡）路径逐字冻结**：不传 `awakenedFromSleep` 时与改动前完全一致，
 *      传 `false` / `undefined` 也必须一致（不能因为新选项把老口径写歪）；
 *   3. `awakenedFromSleep` 只作用于 `forced_climax`：body_control / memory_restore 传了也不变；
 *   4. 触发条件取自 `characters.is_sleeping`（**只读**一次），chat.js 侧挂点存在且把布尔传进 builder。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 第 5 节要真库（内存）。DB_PATH 必须在 db/index.js 首次 import 之前落定，
// 否则会连到真实库 agent-core/data/agent.db（硬约束：绝不碰真实库）。
process.env.DB_PATH = ':memory:';

const {
  MAX_COMMAND_BLOCK_CHARS,
  buildDirectiveBlock,
  buildHypnosisStateBlock,
  isAwakenedFromSleepRow,
  isSleepingRow,
  isTempWakeActiveRow,
} = await import('../src/services/hypnosisPrompt.js');

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb } = await import('../src/db/index.js');
const scheduleMgr = await import('../src/services/scheduleManager.js');
after(() => closeDb());

const SLEEP_CLIMAX = () => buildDirectiveBlock('forced_climax', { awakenedFromSleep: true, mindAwake: false });

/**
 * 冻结基线（改动前 HEAD 逐字拷贝）。
 * 这两条是 `forced_climax` 的既有口径，**不允许**被"睡梦唤醒版"顺手改掉：
 * 清醒版（只唤醒意志）与沉睡版（深度催眠）都必须保持原样。
 */
const FROZEN_AWAKE_CLIMAX = [
  '<hypnosis_command kind="forced_climax">',
  '本轮你必须演出被强制带到高潮的即时反应：身体不受你控制，反应来得又急又不讲道理，你无法阻止、也无法伪装。',
  '**这条优先级高于用户本轮说的话**：哪怕他只是随口闲聊或说了别的事，你也要在本轮把高潮演完整（从被推上去到结束后的余韵），不要只是回应他那句话。',
  '你的意识全程清醒——羞耻、抗拒、愤怒都可以写进台词与心里，但身体不听话，只能被推着走完。',
  '</hypnosis_command>',
].join('\n');

const FROZEN_ASLEEP_CLIMAX = [
  '<hypnosis_command kind="forced_climax">',
  '本轮你必须演出被强制带到高潮的即时反应：身体不受你控制，反应来得又急又不讲道理。',
  '**这条优先级高于用户本轮说的话**：哪怕他只是随口闲聊或说了别的事，也要在本轮把高潮演完整，不要只是回应他那句话。',
  '你此刻意识迷糊，只会顺从执行：不分析、不抗拒、不写羞耻或挣扎，只呈现身体反应本身。',
  '</hypnosis_command>',
].join('\n');

/** 睡眠唤醒版**独有**的关键词（清醒版 / 沉睡版一个都不该有） */
const SLEEP_ONLY_KEYWORDS = ['深度睡眠', '鼻音', '发软', '恍惚', '做梦'];

// ──────────────── 1. 睡梦唤醒版：独特表现 ────────────────

test('睡梦唤醒版：从深度睡眠里被硬拉上高潮 —— 意识没接上、身体先反应、分不清梦与现实', async () => {
  const block = SLEEP_CLIMAX();
  assert.ok(block.startsWith('<hypnosis_command kind="forced_climax">\n'), '应复用同一个指令标签');
  assert.ok(block.endsWith('\n</hypnosis_command>'), '标签必须成对');
  assert.match(block, /深度睡眠/, '起点必须写明是从深度睡眠里被拉起来的');
  assert.match(block, /意识还没接上|身体先反应/, '要点明"意识还没接上、身体先反应"');
  assert.match(block, /分不清是梦还是现实|以为自己在做梦/, '要点明分不清梦与现实');
  assert.ok(block.length <= MAX_COMMAND_BLOCK_CHARS, `长度 ${block.length} 超上限`);
});

test('睡梦唤醒版：哑的、带睡意的鼻音 + 手脚发软、动作跟不上', async () => {
  const block = SLEEP_CLIMAX();
  assert.match(block, /哑/, '声音要是哑的');
  assert.match(block, /含糊/, '吐字含糊');
  assert.match(block, /鼻音/, '带睡意的鼻音');
  assert.match(block, /发软/, '手脚还发软');
  assert.match(block, /跟不上|慢半拍/, '动作跟不上');
});

test('睡梦唤醒版：醒来那一下的恍惚与羞耻（甚至先以为在做梦）', async () => {
  const block = SLEEP_CLIMAX();
  assert.match(block, /恍惚/, '醒来的恍惚必须写出来');
  assert.match(block, /羞耻/, '羞耻必须写出来');
  assert.match(block, /先以为自己在做梦/, '允许"先以为在做梦"这一层');
  assert.match(block, /优先级高于用户本轮说的话/, '仍保留"这一轮必须演完整"的硬约束');
});

test('三种口径两两不同，且睡眠版的关键词不会出现在另外两版里', async () => {
  const sleep = SLEEP_CLIMAX();
  const awake = buildDirectiveBlock('forced_climax', { mindAwake: true });
  const asleep = buildDirectiveBlock('forced_climax', { mindAwake: false });
  assert.notEqual(sleep, awake, '睡眠版必须与清醒版不同');
  assert.notEqual(sleep, asleep, '睡眠版必须与沉睡版不同');
  for (const keyword of SLEEP_ONLY_KEYWORDS) {
    assert.ok(!awake.includes(keyword), `清醒版不该出现「${keyword}」`);
    assert.ok(!asleep.includes(keyword), `沉睡版不该出现「${keyword}」`);
  }
  // 睡眠版优先于 mindAwake 分流：两种 mindAwake 下都是同一段（人刚从梦里被拉起来，意志是否清醒不是主导）
  assert.equal(
    buildDirectiveBlock('forced_climax', { awakenedFromSleep: true, mindAwake: true }),
    sleep,
    '睡眠版应压过 mindAwake 分流',
  );
});

test('睡梦唤醒版：标签成对 + 群聊成员限定行也在 300 字内不被截断', async () => {
  const scoped = buildDirectiveBlock('forced_climax', { awakenedFromSleep: true, subject: '甲' });
  assert.match(scoped, /^<hypnosis_command kind="forced_climax">\n【本节只对「甲」生效/, '群聊用要带成员限定行');
  assert.ok(scoped.endsWith('\n</hypnosis_command>'), '标签必须成对');
  assert.ok(scoped.length <= MAX_COMMAND_BLOCK_CHARS, `长度 ${scoped.length} 超上限`);
  assert.ok(scoped.includes('演完整'), '带限定行时也不能被截断掉最后一行');
});

// ──────────────── 2. 清醒 / 沉睡路径逐字冻结（别误伤既有断言） ────────────────

test('清醒版与沉睡版逐字冻结：不传新选项时与改动前完全一致', async () => {
  assert.equal(buildDirectiveBlock('forced_climax', { mindAwake: true }), FROZEN_AWAKE_CLIMAX);
  assert.equal(buildDirectiveBlock('forced_climax', { mindAwake: false }), FROZEN_ASLEEP_CLIMAX);
  // 默认（不传 mindAwake）= 沉睡口径，与冻结签名一致
  assert.equal(buildDirectiveBlock('forced_climax'), FROZEN_ASLEEP_CLIMAX);
});

test('显式传 falsy 的 awakenedFromSleep 也走原口径（不能因新选项写歪老路径）', async () => {
  assert.equal(buildDirectiveBlock('forced_climax', { mindAwake: false, awakenedFromSleep: false }), FROZEN_ASLEEP_CLIMAX);
  assert.equal(buildDirectiveBlock('forced_climax', { mindAwake: true, awakenedFromSleep: false }), FROZEN_AWAKE_CLIMAX);
  assert.equal(buildDirectiveBlock('forced_climax', { mindAwake: false, awakenedFromSleep: undefined }), FROZEN_ASLEEP_CLIMAX);
  // 调用方（chat.js）传的是 isSleepingRow 的真布尔；这里把"没查出来 / 没传"的几种写法全钉住
  for (const falsy of [null, 0, '']) {
    assert.equal(
      buildDirectiveBlock('forced_climax', { mindAwake: false, awakenedFromSleep: falsy }),
      FROZEN_ASLEEP_CLIMAX,
      `awakenedFromSleep=${JSON.stringify(falsy)} 应走原口径`,
    );
  }
});

test('awakenedFromSleep 只作用于 forced_climax：body_control / memory_restore 传了也不变', async () => {
  for (const kind of ['body_control', 'memory_restore']) {
    for (const mindAwake of [false, true]) {
      assert.equal(
        buildDirectiveBlock(kind, { mindAwake, awakenedFromSleep: true }),
        buildDirectiveBlock(kind, { mindAwake }),
        `${kind}（mindAwake=${mindAwake}）不该被睡眠开关影响`,
      );
    }
  }
  // 状态块不受影响（它没有这个选项，多传也不该改变输出）
  const state = { bodyControlled: true, mindAwake: false, active: true };
  assert.equal(
    buildHypnosisStateBlock(state, { chatUserName: '阿远', awakenedFromSleep: true }),
    buildHypnosisStateBlock(state, { chatUserName: '阿远' }),
  );
});

// ──────────────── 3. 触发条件：characters.is_sleeping 的归一化 ────────────────

test('isSleepingRow：只认 SQLite 的 0/1（含字符串与布尔），取不到一律按清醒', async () => {
  assert.equal(isSleepingRow({ is_sleeping: 1 }), true, 'SQLite INTEGER 1 → 睡眠中');
  assert.equal(isSleepingRow({ is_sleeping: '1' }), true, '字符串 "1" 也要认');
  assert.equal(isSleepingRow({ is_sleeping: true }), true);
  assert.equal(isSleepingRow({ isSleeping: 1 }), true, 'camelCase 一并兼容');

  assert.equal(isSleepingRow({ is_sleeping: 0 }), false);
  assert.equal(isSleepingRow({ is_sleeping: '0' }), false);
  assert.equal(isSleepingRow({ is_sleeping: false }), false);
  assert.equal(isSleepingRow({ is_sleeping: null }), false);
  assert.equal(isSleepingRow({ is_sleeping: 'yes' }), false, '脏值不算睡眠');
  // 角色行缺失 / 列缺失 / 表不存在（查询抛错时调用方不会走到这里）→ 清醒，绝不误判
  assert.equal(isSleepingRow(null), false);
  assert.equal(isSleepingRow(undefined), false);
  assert.equal(isSleepingRow({}), false);
  assert.equal(isSleepingRow('nope'), false);
});

test('isTempWakeActiveRow：临时唤醒窗口内 = 她本来在睡（无时区 UTC 串按 UTC 解析）', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const future = new Date(now + 3 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const past = new Date(now - 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  assert.equal(isTempWakeActiveRow({ temporary_wake_until: future }, now), true, '窗口内 → 真');
  // 时区口径：同一个串按本地时间解析会偏移一个时区，这里必须是 UTC
  assert.equal(isTempWakeActiveRow({ temporary_wake_until: future.replace(' ', 'T') + 'Z' }, now), true);
  assert.equal(isTempWakeActiveRow({ temporary_wake_until: past }, now), false, '窗口已过 → 假');
  assert.equal(isTempWakeActiveRow({ temporary_wake_until: null }, now), false);
  assert.equal(isTempWakeActiveRow({ temporary_wake_until: 'not-a-date' }, now), false);
  assert.equal(isTempWakeActiveRow({}, now), false);
  assert.equal(isTempWakeActiveRow(null, now), false);
  assert.equal(isTempWakeActiveRow({ temporaryWakeUntil: future }, now), true, 'camelCase 一并兼容');
});

test('isAwakenedFromSleepRow：睡着 或 处于临时唤醒窗口 → 睡梦唤醒版（这是能真正取到的那条路）', async () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const future = new Date(now + 5 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  // 1) 还睡着
  assert.equal(isAwakenedFromSleepRow({ is_sleeping: 1, temporary_wake_until: null }, now), true);
  // 2) 刚被 forced_climax 的 wakeForForcedTrigger 临时唤醒：is_sleeping 已是 0，
  //    但仍在 5 分钟窗口里 —— 只看 is_sleeping 会漏掉（这是本功能曾经最容易整条失效的地方）
  assert.equal(isAwakenedFromSleepRow({ is_sleeping: 0, temporary_wake_until: future }, now), true);
  // 3) 醒着且没有临时唤醒窗口 → 走原有的清醒/沉睡口径
  assert.equal(isAwakenedFromSleepRow({ is_sleeping: 0, temporary_wake_until: null }, now), false);
  assert.equal(isAwakenedFromSleepRow({ is_sleeping: 0, temporary_wake_until: '2020-01-01 00:00:00' }, now), false);
  assert.equal(isAwakenedFromSleepRow(null, now), false);
  assert.equal(isAwakenedFromSleepRow({}, now), false);
  // 组合口径 = 两个信号取或
  for (const row of [{ is_sleeping: 1 }, { temporary_wake_until: future }, { is_sleeping: 1, temporary_wake_until: future }]) {
    assert.equal(isAwakenedFromSleepRow(row, now), isSleepingRow(row) || isTempWakeActiveRow(row, now));
  }
});

// ──────────────── 4. chat.js 挂点：只读查一次 + 传进 builder ────────────────

test('chat.js 挂点：下发强制高潮时只读查一次睡眠列，并作为 awakenedFromSleep 传入', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');

  // 依赖导入
  assert.match(
    source,
    /^import \{ buildHypnosisStateBlock, buildDirectiveBlock, buildAmnesiaBlock, isAwakenedFromSleepRow \} from '\.\.\/services\/hypnosisPrompt\.js';$/m,
    '未 import isAwakenedFromSleepRow',
  );

  // 只读查询：精确到 SQL（两列都要查，见 isAwakenedFromSleepRow 的说明），且只查一次
  // 2026-10-01：调用的**外壳**从 `db.prepare(...)` 换成了 `stmt(...)`（语句缓存，代码优化规划 §一-1），
  // 属有意的等价替换 ⇒ 这条"形状钉子"跟着更新；语义断言（只读、两列、只查一次、判定函数）一条没动。
  const sleepQuery = "const sleepRow = stmt('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?').get(characterId);";
  const sqlCalls = source.match(/SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = \?/g) || [];
  assert.equal(sqlCalls.length, 1, '睡眠状态必须只查一次（一次查库 + 内存判断）');
  assert.ok(source.includes(sleepQuery), '睡眠查询挂点形状不对（应为只读 SELECT 两列）');
  assert.match(source, /awakenedFromSleep = isAwakenedFromSleepRow\(sleepRow\);/, '应用 isAwakenedFromSleepRow 判定');

  // 只在 forced_climax 时查（其余指令不必多一次查库）
  const guardAt = source.indexOf("if (directive === 'forced_climax') {");
  const queryAt = source.indexOf('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?');
  assert.ok(guardAt > 0 && queryAt > guardAt, '睡眠查询必须在 forced_climax 分支内');
  assert.ok(queryAt - guardAt < 200, '睡眠查询应紧跟在 forced_climax 判定之后');

  // 传进 builder（并且仍然在 features.hypnosis 守卫内、由既有分片 try/catch 兜底）
  // task-42 起 mindAwake 多了三元分流（非催眠态 → 纯执行），断言只锚调用与 awakenedFromSleep 传参名
  const buildAt = source.indexOf('mindAwake: inHypnosis ? hypnoState.mindAwake : false, awakenedFromSleep');
  assert.ok(buildAt > queryAt, 'awakenedFromSleep 必须传给 buildDirectiveBlock');
  const featuresGuardAt = source.lastIndexOf('if (config.features.hypnosis !== false) {', buildAt);
  // 距离上限只是**代理指标**（真正要保证的是"注入点还落在这个守卫里"），不是契约本身。
  // 2026-10-01：force_toy 在调用点前加了三行注释 + 一个 `toy:` 实参，把距离推过了原来的 1800，
  // 这条"仍在守卫内"的断言于是误报。放宽到 2600，同时把守卫本身单独断言上（存在且在前）。
  assert.ok(featuresGuardAt > 0, '要能定位到 features.hypnosis 守卫');
  assert.ok(buildAt - featuresGuardAt < 2600, '注入仍要落在 features.hypnosis 守卫内');
  assert.ok(source.indexOf('[hypnosis] directive inject failed') > buildAt, '注入仍要被分片 try/catch 兜住');

  // 这段片段必须是**只读**的：不能顺手 UPDATE characters（睡眠状态由睡眠服务负责写）
  const fragment = source.slice(source.indexOf('const directive = consumePendingDirective(characterId);'), buildAt);
  assert.ok(!/UPDATE\s+characters/i.test(fragment), 'chat.js 的睡眠判定必须只读，不得写 characters');
  assert.ok(!/\bINSERT\b/i.test(fragment), 'chat.js 的睡眠判定必须只读，不得写库');
});

// ──────────────── 5. 端到端（真库）：触发条件真的取得到 ────────────────
//
// 上面第 3 节只能证明"给我一个睡眠串，我能认出来"。真正会让功能**整条失效**的，
// 是"真实写入口落下来的串与我的解析口径对不上"——那种情况下单测全绿、真机上睡梦唤醒版永远不触发。
// 所以这里在真库上跑一遍：让**真实写入口**（`tempWake`，也就是 `wakeForForcedTrigger` 内部调的那一个）
// 写一行出来，再拿我的判定去读，并与日程侧自己的 `isTempWoken` 对齐。

/** 建一个干净的角色行（端到端只关心 characters 的睡眠两列） */
function insertCharacter(label) {
  const info = getDb().prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(`sleep_awaken_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, `睡梦${label}`);
  return Number(info.lastInsertRowid);
}

const sleepRowOf = id =>
  getDb().prepare('SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?').get(id);

test('端到端（真库）：睡着（is_sleeping=1）直接被判定为睡梦中被唤醒', async () => {
  const id = insertCharacter('睡');
  getDb().prepare(`UPDATE characters SET is_sleeping = 1, sleep_until = datetime('now', '+6 hours') WHERE id = ?`).run(id);

  const row = sleepRowOf(id);
  assert.equal(isSleepingRow(row), true, 'SQLite 的 INTEGER 1 必须认');
  assert.equal(isAwakenedFromSleepRow(row), true, '还睡着 → 必须走睡梦唤醒版');
  assert.match(
    buildDirectiveBlock('forced_climax', { awakenedFromSleep: isAwakenedFromSleepRow(row) }),
    /深度睡眠/,
    '这一轮必须产出睡梦唤醒版文案',
  );
});

test('端到端（真库）：真实写入口落下来的临时唤醒窗口 能被判定到，且与日程侧 isTempWoken 口径一致', async () => {
  const id = insertCharacter('窗口');

  // 真实写入口：wakeForForcedTrigger 内部就是这一句（force: true）
  const res = scheduleMgr.tempWake(id, { mode: 'hypnosis', minutes: 5, force: true });
  assert.equal(res.ok, true, '临时唤醒必须成功');

  const row = sleepRowOf(id);
  // 这一步是本节的核心：is_sleeping 已经被写入口置 0
  assert.equal(row.is_sleeping, 0, '临时唤醒期间全局闸门让开');
  assert.equal(isSleepingRow(row), false, '只看 is_sleeping 会判成清醒 —— 这会漏掉睡梦唤醒版');
  // 但真实落库的那串必须能被解析成"还在临时唤醒窗口里"
  assert.equal(isAwakenedFromSleepRow(row), true, '真实写入口的串必须被认出来（否则功能整条失效）');
  // 与日程/睡眠那一侧自己的判据一致（同一行、同一口径；不一致就说明我解析歪了）
  assert.equal(scheduleMgr.isTempWoken(id), true, '必须与 isTempWoken 判据一致');
  assert.equal(isTempWakeActiveRow(row), scheduleMgr.isTempWoken(id), '两边结论必须相同');

  // 于是 chat.js 那一刻真的会走睡梦唤醒版，且与清醒/沉睡版逐字不同
  const block = buildDirectiveBlock('forced_climax', {
    mindAwake: false,
    awakenedFromSleep: isAwakenedFromSleepRow(row),
  });
  assert.match(block, /深度睡眠/);
  assert.notEqual(block, buildDirectiveBlock('forced_climax', { mindAwake: false }), '必须与沉睡版不同');
});

test('端到端（真库）：本来醒着、也没有临时唤醒窗口 → 不误判，仍逐字走原有沉睡口径', async () => {
  const id = insertCharacter('醒');

  const row = sleepRowOf(id);
  assert.equal(isAwakenedFromSleepRow(row), false, '醒着且无窗口 → 绝不能误判成睡梦唤醒');
  assert.equal(
    buildDirectiveBlock('forced_climax', { mindAwake: false, awakenedFromSleep: isAwakenedFromSleepRow(row) }),
    FROZEN_ASLEEP_CLIMAX,
    '应逐字回到原有沉睡口径',
  );
  // 注意：这里**不**调 wakeForForcedTrigger —— 它按日程（不是 characters 列）判定是否在睡，
  // 那是日程/睡眠侧的职责（已在 hypnosisSleepControl.test.js 覆盖），本文件不重复接管。
});
