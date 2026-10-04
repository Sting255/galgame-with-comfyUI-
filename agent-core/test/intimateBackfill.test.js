/**
 * intimateBackfill 单测：历史回填引擎（确定性、零 LLM）
 *
 * 覆盖 task-4 冻结口径：
 *   - 只对可解析出成人 tag 的助手消息记账；无 prompt / 无成人 tag / 非私聊会话 / 用户消息一律跳过
 *   - 幂等：连跑两次不翻倍（靠 recordIntimateActs 的 source_uid）
 *   - 断点续跑：maxMessages 限制下 status=partial，lastRawId 前进，再调接着扫
 *   - backfill_enabled=0 时一个字都不写库
 *   - 已在跑不重复起（可注入调度器，不依赖真实定时器）
 *   - 出错落进 status='error'，不抛给调用方
 *
 * 全程内存库 + fetch 抛错挡网络（引擎本来就零 LLM、零网络）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate backfill fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getDb, closeDb, migrateIntimateSchema } = await import('../src/db/index.js');
const {
  upsertBodyProfile, listIntimateLogs, listFirsts, getIntimateStats,
} = await import('../src/services/intimateService.js');
const {
  startBackfill, getBackfillStatus, resetBackfill, extractPromptFromContent,
} = await import('../src/services/intimateBackfill.js');
const { recordFromPrompt } = await import('../src/services/intimateAutoRecord.js');

config.dbPath = ':memory:';
after(() => closeDb());

let seq = 0;

/** 造一个干净角色，测试之间互不串数据 */
function seedCharacter() {
  const db = getDb();
  seq += 1;
  db.prepare('INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, ?, ?)')
    .run(`backfill_${seq}`, `角色${seq}`, '测试用成年角色', '测试');
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 往 raw_messages 塞一条原始消息，返回 raw_id */
function addRaw(characterId, {
  role = 'assistant', content = '', prompt = null, createdAt = null, conversationId = null,
} = {}) {
  const db = getDb();
  const conv = conversationId || `char_${characterId}`;
  if (createdAt) {
    db.prepare('INSERT INTO raw_messages (conversation_id, role, content, prompt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(conv, role, content, prompt, createdAt);
  } else {
    db.prepare('INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, ?, ?, ?)')
      .run(conv, role, content, prompt);
  }
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 角色显示名（群聊归因按它反查） */
function nameOf(characterId) {
  return getDb().prepare('SELECT display_name FROM characters WHERE id = ?').get(characterId).display_name;
}

/** 造一个群并把给定角色加为成员，返回 group_id */
function seedGroup(characterIds) {
  const db = getDb();
  db.prepare(`INSERT INTO group_chats (name) VALUES ('回填测试群')`).run();
  const groupId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const insert = db.prepare('INSERT OR IGNORE INTO group_members (group_id, character_id) VALUES (?, ?)');
  for (const characterId of characterIds) insert.run(groupId, characterId);
  return groupId;
}

/** 群聊一轮的 raw content（与 groupChatEngine.formatGroupImageLine 同格式） */
const groupRoundContent = lines => lines.map(([name, prompt]) => `[${name}]: {${prompt}}`).join('\n');

/** 同步调度器：startBackfill 返回前就把活干完，测试不依赖真实定时器 */
const syncSchedule = fn => fn();
/** 队列调度器：把活攒起来，用来验证"已在跑不重复起" */
function queueSchedule() {
  const queued = [];
  return {
    schedule: fn => { queued.push(fn); },
    flush: () => { while (queued.length > 0) queued.shift()(); },
    size: () => queued.length,
  };
}

test('extractPromptFromContent：兼容 (图片) JSON、尾部追加 JSON 与截断兜底', () => {
  assert.equal(extractPromptFromContent('(图片) {"prompt":"missionary, vaginal"}'), 'missionary, vaginal');
  assert.equal(extractPromptFromContent('正文{"prompt":"doggystyle, vaginal"}'), 'doggystyle, vaginal');
  assert.equal(extractPromptFromContent('带转义的{"prompt":"a \\"quoted\\" tag, vaginal"}'), 'a "quoted" tag, vaginal');
  assert.equal(extractPromptFromContent('(图片) {"prompt":"vaginal, anal"'), 'vaginal, anal');
  assert.equal(extractPromptFromContent('(图片) {"prompt":""}'), '');
  assert.equal(extractPromptFromContent('(图片) {"prompt":'), '');
  assert.equal(extractPromptFromContent('普通回复，没有生图'), '');
  assert.equal(extractPromptFromContent(''), '');
});

test('只回填该角色私聊里能解析出成人 tag 的助手消息', () => {
  const id = seedCharacter();
  const first = addRaw(id, {
    prompt: 'missionary, vaginal, orgasm',
    content: '(图片) {"prompt":"missionary, vaginal, orgasm"}',
    createdAt: '2023-05-01 08:00:00',
  });
  addRaw(id, { content: '今天天气不错' });                       // 没有 prompt：跳过
  addRaw(id, { prompt: 'a cat sitting on a wooden table' });    // 有 prompt 但没有成人 tag：跳过
  const second = addRaw(id, { content: '(图片) {"prompt":"doggystyle, vaginal"}' }); // prompt 折在 content 里
  addRaw(id, { role: 'user', content: '在吗', prompt: 'vaginal' });  // 用户消息：不扫
  const third = addRaw(id, { prompt: 'vaginal' });               // 纯 prompt 列
  addRaw(id, { prompt: 'vaginal', conversationId: 'group_999999' }); // 群聊会话：本用例角色不是该群成员，不参与私聊线
  addRaw(id + 999, { prompt: 'vaginal' });                      // 别的角色的私聊：不串数据

  const state = startBackfill(id, { schedule: syncSchedule });
  assert.equal(state.status, 'done');
  assert.equal(state.scanned, 5, '只数该角色私聊会话里的助手消息');
  assert.equal(state.inserted, 4, 'first 两条行为 + second 一条行为 + third 一条行为');

  const logs = listIntimateLogs(id, { limit: 50 });
  // 一条消息可以带多个行为（first 同时命中 vaginal 与 climax），所以 rawId 会重复出现
  assert.deepEqual(
    logs.map(l => l.rawId).sort((a, b) => a - b),
    [first, first, second, third].sort((a, b) => a - b)
  );
  assert.ok(logs.every(l => l.scene === 'chat' && l.partnerKind === 'user' && l.source === 'auto'));
  assert.deepEqual(logs.map(l => l.actKey).sort(), ['climax', 'vaginal', 'vaginal', 'vaginal']);
  // 时间取消息的 created_at（历史日期），初次里程碑才能回到过去
  assert.equal(logs.find(l => l.rawId === first).occurredAt, '2023-05-01T08:00:00.000Z');
  assert.equal(listFirsts(id).find(f => f.actKey === 'vaginal').firstAt, '2023-05-01T08:00:00.000Z');
  // 别的角色没被回填
  assert.equal(listIntimateLogs(id + 999, { limit: 10 }).length, 0);
});

test('幂等：连跑两次不翻倍，新增消息只增量补齐', () => {
  const id = seedCharacter();
  const first = addRaw(id, { prompt: 'missionary, vaginal' });

  const run1 = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run1.status, 'done');
  assert.equal(run1.inserted, 1);

  const run2 = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run2.status, 'done');
  assert.equal(run2.inserted, 1, 'inserted 是累计值，不该翻倍');
  assert.equal(run2.scanned, 1, '没有新消息就不该再扫');
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 1);
  assert.equal(getIntimateStats(id).totalActs, 1);

  const added = addRaw(id, { prompt: 'fellatio, blowjob' });
  const run3 = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run3.inserted, 2);
  assert.equal(getIntimateStats(id).totalActs, 2, '两轮各一条行为');
  assert.deepEqual(listIntimateLogs(id, { limit: 50 }).map(l => l.rawId).sort((a, b) => a - b), [first, added]);
});

test('断点续跑：maxMessages 限制下 status=partial，lastRawId 前进，再调接着扫', () => {
  const id = seedCharacter();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(addRaw(id, { prompt: 'missionary, vaginal' }));

  const run1 = startBackfill(id, { maxMessages: 2, batchSize: 2, schedule: syncSchedule });
  assert.equal(run1.status, 'partial', '没扫完不能报 done');
  assert.equal(run1.scanned, 2);
  assert.equal(run1.lastRawId, ids[1]);
  assert.equal(run1.inserted, 2);
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 2);

  const run2 = startBackfill(id, { maxMessages: 2, batchSize: 2, schedule: syncSchedule });
  assert.equal(run2.status, 'partial');
  assert.equal(run2.scanned, 4);
  assert.equal(run2.lastRawId, ids[3]);
  assert.equal(run2.inserted, 4);
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 4, '续跑没重算前两条');

  const run3 = startBackfill(id, { maxMessages: 2, batchSize: 2, schedule: syncSchedule });
  assert.equal(run3.status, 'done');
  assert.equal(run3.scanned, 5);
  assert.equal(run3.lastRawId, ids[4]);
  assert.equal(run3.inserted, 5);

  // 扫完之后再调一次：不重复计数
  const run4 = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run4.status, 'done');
  assert.equal(run4.inserted, 5);
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 5);
});

test('backfill_enabled=0：引擎完全不写库；打开后可以正常补', () => {
  const id = seedCharacter();
  addRaw(id, { prompt: 'missionary, vaginal' });
  upsertBodyProfile(id, { backfillEnabled: false });

  const blocked = startBackfill(id, { schedule: syncSchedule });
  assert.equal(blocked.status, 'idle', '开关关闭时连进度行都不写');
  assert.equal(blocked.lastRawId, 0);
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 0);

  upsertBodyProfile(id, { backfillEnabled: true });
  const run = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run.status, 'done');
  assert.equal(run.inserted, 1);
});

test('AI 未授权 stats：回填被 recordIntimateActs 拦下，落 status=blocked 且不写流水', () => {
  const id = seedCharacter();
  addRaw(id, { prompt: 'missionary, vaginal' });
  upsertBodyProfile(id, { aiEditFields: ['body'] }); // 关掉 stats 授权

  const blocked = startBackfill(id, { schedule: syncSchedule });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error, /stats/);
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 0);

  // 重新授权后可以补上
  upsertBodyProfile(id, { aiEditFields: ['stats'] });
  const run = startBackfill(id, { schedule: syncSchedule });
  assert.equal(run.status, 'done');
  assert.equal(run.inserted, 1);
});

test('已在跑不重复起：第二次调用只读到 running，不再排活', () => {
  const id = seedCharacter();
  addRaw(id, { prompt: 'missionary, vaginal' });
  const queue = queueSchedule();

  const first = startBackfill(id, { schedule: queue.schedule });
  assert.equal(first.status, 'running');
  assert.equal(queue.size(), 1);

  const second = startBackfill(id, { schedule: queue.schedule });
  assert.equal(second.status, 'running');
  assert.equal(queue.size(), 1, '第二个请求不应再排一次活');

  queue.flush();
  const settled = getBackfillStatus(id);
  assert.equal(settled.status, 'done');
  assert.equal(settled.inserted, 1);
});

test('resetBackfill 回到起点：重扫靠 source_uid 去重，数字不翻倍', () => {
  const id = seedCharacter();
  addRaw(id, { prompt: 'missionary, vaginal' });
  startBackfill(id, { schedule: syncSchedule });

  const reset = resetBackfill(id);
  assert.equal(reset.status, 'idle');
  assert.equal(reset.lastRawId, 0);
  assert.equal(reset.scanned, 0);
  assert.equal(reset.inserted, 0);

  const again = startBackfill(id, { schedule: syncSchedule });
  assert.equal(again.status, 'done');
  assert.equal(again.scanned, 1, '确实重扫了');
  assert.equal(again.inserted, 0, '命中的是同一 raw_id，重复扫描不再落库');
  assert.equal(listIntimateLogs(id, { limit: 50 }).length, 1);
});

test('参数兜底：非法 id / 不存在的角色按错误契约抛出', () => {
  seedCharacter();
  assert.throws(() => startBackfill(0), /invalid character id/);
  assert.throws(() => getBackfillStatus(0), /invalid character id/);
  assert.throws(() => resetBackfill(0), /invalid character id/);
  assert.throws(() => startBackfill(999999), /character not found/);
  assert.throws(() => resetBackfill(999999), /character not found/);
});

// ──────────────── 群聊回填线（task-19） ────────────────

test('群聊回填：按 [显示名] 归因，多个发言角色各自记各的那一笔', () => {
  const owner = seedCharacter();
  const other = seedCharacter();
  const groupId = seedGroup([owner, other]);
  const rawId = addRaw(owner, {
    conversationId: `group_${groupId}`,
    content: groupRoundContent([
      [nameOf(owner), 'missionary, vaginal'],
      [nameOf(other), 'fellatio, blowjob'],
      ['查无此人', 'doggystyle, anal'], // 不是本群成员：跳过，绝不瞎挂
    ]),
  });

  const state = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(state.status, 'done');
  assert.equal(state.private.scanned, 0, '这个角色没有私聊消息');
  assert.equal(state.group.scanned, 1);
  assert.equal(state.group.inserted, 2, '两个发言角色各一笔（不是按群人数放大）');

  const ownerLogs = listIntimateLogs(owner, { limit: 50, partnerKinds: ['character'] });
  const otherLogs = listIntimateLogs(other, { limit: 50, partnerKinds: ['character'] });
  assert.equal(ownerLogs.length, 1);
  assert.equal(otherLogs.length, 1);
  for (const log of [...ownerLogs, ...otherLogs]) {
    assert.equal(log.scene, 'group');
    assert.equal(log.partnerKind, 'character');
    assert.equal(log.rawId, rawId);
  }
  assert.equal(ownerLogs[0].actKey, 'vaginal');
  assert.equal(otherLogs[0].actKey, 'oral');
  assert.equal(getIntimateStats(owner, { partnerKinds: ['character'] }).totalActs, 1);
  assert.equal(getIntimateStats(other, { partnerKinds: ['character'] }).totalActs, 1);
  // 默认口径已含「角色↔角色」：群聊这笔默认就计入统计（用户可在面板一键收窄回"只看用户↔角色"）
  assert.equal(listIntimateLogs(owner, { limit: 50 }).length, 1);
  assert.equal(getIntimateStats(owner).totalActs, 1);
  assert.equal(listIntimateLogs(owner, { limit: 50, partnerKinds: ['user'] }).length, 0);
  // source_uid 与实时路径同形：auto:group:raw<id>:<actKey>:<positionKey>:character:0
  const uid = getDb().prepare('SELECT source_uid AS uid FROM character_intimate_log WHERE character_id = ?').get(owner).uid;
  assert.equal(uid, `auto:group:raw${rawId}:vaginal:missionary:character:0`);
});

test('群聊线断点续跑：maxMessages 逐批推进，重复扫描不翻倍', () => {
  const owner = seedCharacter();
  const groupId = seedGroup([owner]);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(addRaw(owner, {
      conversationId: `group_${groupId}`,
      content: groupRoundContent([[nameOf(owner), 'missionary, vaginal']]),
    }));
  }

  const run1 = startBackfill(owner, { maxMessages: 1, batchSize: 1, schedule: syncSchedule });
  assert.equal(run1.status, 'partial');
  assert.equal(run1.group.scanned, 1);
  assert.equal(run1.group.lastRawId, ids[0]);
  assert.equal(run1.group.inserted, 1);

  const run2 = startBackfill(owner, { maxMessages: 1, batchSize: 1, schedule: syncSchedule });
  assert.equal(run2.status, 'partial');
  assert.equal(run2.group.scanned, 2);
  assert.equal(run2.group.lastRawId, ids[1]);
  assert.equal(run2.group.inserted, 2);

  // 第 3 条扫完时恰好用尽预算：保守标 partial，再调一次即 done
  const run3 = startBackfill(owner, { maxMessages: 1, batchSize: 1, schedule: syncSchedule });
  assert.equal(run3.status, 'partial');
  assert.equal(run3.group.scanned, 3);
  assert.equal(run3.group.lastRawId, ids[2]);

  const run4 = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(run4.status, 'done');
  assert.equal(run4.group.scanned, 3);
  assert.equal(run4.group.inserted, 3);
  assert.equal(listIntimateLogs(owner, { limit: 50, partnerKinds: ['character'] }).length, 3);

  // 幂等：再跑一次不翻倍
  const run5 = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(run5.status, 'done');
  assert.equal(run5.group.inserted, 3);
  assert.equal(listIntimateLogs(owner, { limit: 50, partnerKinds: ['character'] }).length, 3);
});

test('群聊归因：查不到的显示名跳过；同群重名取最小 id 并 warn', () => {
  const first = seedCharacter();
  const second = seedCharacter();
  const groupId = seedGroup([first, second]);
  // display_name 没有唯一约束：把 second 改成与 first 同名，制造重名
  getDb().prepare('UPDATE characters SET display_name = ? WHERE id = ?').run(nameOf(first), second);

  addRaw(first, {
    conversationId: `group_${groupId}`,
    content: groupRoundContent([
      [nameOf(first), 'missionary, vaginal'],
      ['幽灵角色', 'doggystyle, anal'],
    ]),
  });

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warns.push(args.join(' ')); };
  let state;
  try {
    state = startBackfill(first, { schedule: syncSchedule });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(state.status, 'done');
  assert.equal(state.group.scanned, 1);
  assert.equal(state.group.inserted, 1, '重名只算 id 最小的那个角色那一笔');
  assert.equal(listIntimateLogs(first, { limit: 50, partnerKinds: ['character'] }).length, 1);
  assert.equal(listIntimateLogs(second, { limit: 50, partnerKinds: ['character'] }).length, 0);
  assert.ok(warns.some(w => w.includes('duplicate display_name')), '重名必须 warn，不能静默挂错人');
});

test('开关关闭：群聊线与私聊线都不写库（backfill_enabled / features.intimate）', () => {
  const owner = seedCharacter();
  const groupId = seedGroup([owner]);
  addRaw(owner, { prompt: 'missionary, vaginal' });
  addRaw(owner, {
    conversationId: `group_${groupId}`,
    content: groupRoundContent([[nameOf(owner), 'fellatio, blowjob']]),
  });
  const allKinds = { limit: 50, partnerKinds: ['user', 'character'] };

  upsertBodyProfile(owner, { backfillEnabled: false });
  const off = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(off.status, 'idle', '开关关闭时连进度行都不写');
  assert.equal(off.private.lastRawId, 0);
  assert.equal(off.group.lastRawId, 0);
  assert.equal(listIntimateLogs(owner, allKinds).length, 0);

  upsertBodyProfile(owner, { backfillEnabled: true });
  const saved = config.features.intimate;
  config.features.intimate = false;
  try {
    const disabled = startBackfill(owner, { schedule: syncSchedule });
    assert.equal(disabled.status, 'idle');
    assert.equal(listIntimateLogs(owner, allKinds).length, 0);
  } finally {
    config.features.intimate = saved;
  }

  // 恢复后两条线都补上
  const on = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(on.status, 'done');
  assert.equal(on.inserted, 1, '私聊线 1 笔');
  assert.equal(on.group.inserted, 1, '群聊线 1 笔');
  assert.equal(listIntimateLogs(owner, allKinds).length, 2);
});

test('与群聊实时记账不冲突：同一条 raw 先实时再回填，inserted=0', () => {
  const owner = seedCharacter();
  const groupId = seedGroup([owner]);
  const rawId = addRaw(owner, {
    conversationId: `group_${groupId}`,
    content: groupRoundContent([[nameOf(owner), 'missionary, vaginal']]),
  });

  // 实时路径与 groupChatEngine.recordGroupIntimateFromRound 同口径
  const live = recordFromPrompt({
    characterId: owner, prompt: 'missionary, vaginal', rawId,
    scene: 'group', partnerKind: 'character', partnerId: 0,
  });
  assert.equal(live.inserted, 1);

  const state = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(state.status, 'done');
  assert.equal(state.group.scanned, 1);
  assert.equal(state.group.inserted, 0, 'source_uid 相同 → 回填不重复落库');
  assert.equal(listIntimateLogs(owner, { limit: 50, partnerKinds: ['character'] }).length, 1);
});

test('群聊线：发起人未授权 stats 时落 blocked 且不推进游标，授权后可重扫回来', () => {
  const owner = seedCharacter();
  const groupId = seedGroup([owner]);
  addRaw(owner, {
    conversationId: `group_${groupId}`,
    content: groupRoundContent([[nameOf(owner), 'missionary, vaginal']]),
  });

  upsertBodyProfile(owner, { aiEditFields: ['body'] });
  const blocked = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.group.scanned, 0, '被拦的行不计 scanned');
  assert.equal(blocked.group.lastRawId, 0, '被拦的行不推进游标');
  assert.equal(listIntimateLogs(owner, { limit: 50, partnerKinds: ['character'] }).length, 0);

  upsertBodyProfile(owner, { aiEditFields: ['stats'] });
  const recovered = startBackfill(owner, { schedule: syncSchedule });
  assert.equal(recovered.status, 'done');
  assert.equal(recovered.group.inserted, 1);
});

// 放在最后：这个用例会临时删掉流水表来制造异常
test('扫描出错：落进 status=error，不把异常抛给调用方', () => {
  const id = seedCharacter();
  addRaw(id, { prompt: 'missionary, vaginal' });
  const db = getDb();
  const state = startBackfill(id, {
    schedule: fn => {
      db.exec('DROP TABLE character_intimate_log'); // 制造 recordIntimateActs 无法写入的故障
      fn();
    },
  });
  assert.equal(state.status, 'error');
  assert.match(state.error, /no such table/i);
  assert.equal(getBackfillStatus(id).status, 'error');

  // 复原表结构，保证文件内后续/复跑不受影响（迁移本身幂等）
  migrateIntimateSchema(db);
  const recovered = startBackfill(id, { schedule: syncSchedule });
  assert.equal(recovered.status, 'done');
  assert.equal(recovered.inserted, 1);
});
