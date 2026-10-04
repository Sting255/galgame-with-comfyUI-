import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate service fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const { getDb, closeDb, migrateIntimateSchema } = await import('../src/db/index.js');
const {
  AI_EDIT_DEFAULTS, DEFAULT_VIEW_SCOPE,
  getBodyProfile, upsertBodyProfile, setInjectEnabled, isAiEditAllowed,
  recordIntimateActs, rollbackIntimateByRawId, deleteIntimateLog, listIntimateLogs,
  clearIntimateData, refreshFirsts, listFirsts, setFirstAt,
  getIntimateStats, getIntimatePanel, getBackfillState, saveBackfillState,
  classifyPromptTags, tagsFromPromptString, resetPositionVocabularyCache,
  resolvePositionKey, positionLabel, listIntimateVocabulary, getPositionVocabularyMap,
} = await import('../src/services/intimateService.js');

/** 起一个干净角色（:memory: 库在 closeDb 后重建；体位词表缓存是模块级的，必须一起清） */
function seed(t, name = 'lin') {
  const db = getDb();
  t.after(() => closeDb());
  resetPositionVocabularyCache();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(name, name);
  return Number(lastInsertRowid);
}

// ──────────────── 迁移 ────────────────

test('迁移幂等：连调两次不报错、不丢数据，缺列老库自动补列并回填默认权限', async t => {
  const db = getDb();
  t.after(() => closeDb());

  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES ('lin', '林小姐', '旅客')`).run();
  upsertBodyProfile(1, { height: '168cm', cup: 'D' });
  recordIntimateActs(1, { scene: 'chat', rawId: 31, acts: [{ actKey: 'vaginal' }] });

  migrateIntimateSchema(db);
  migrateIntimateSchema(db);
  assert.equal(getBodyProfile(1).height, '168cm', '重复迁移不该丢档案');
  assert.equal(listIntimateLogs(1).length, 1, '重复迁移不该丢流水');

  // 还原成"没有新三列"的老库形态，再跑迁移（幂等迁移的真实回归场景）
  db.exec('DROP TABLE character_body_profile');
  db.exec(`CREATE TABLE character_body_profile (
     character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
     height TEXT NOT NULL DEFAULT '', bust TEXT NOT NULL DEFAULT '', waist TEXT NOT NULL DEFAULT '',
     hip TEXT NOT NULL DEFAULT '', cup TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
     sensitive_zones TEXT NOT NULL DEFAULT '[]', inject_enabled INTEGER NOT NULL DEFAULT 0,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.prepare(`INSERT INTO character_body_profile (character_id, height) VALUES (1, '170cm')`).run();

  migrateIntimateSchema(db);
  migrateIntimateSchema(db);

  const cols = db.prepare('PRAGMA table_info(character_body_profile)').all().map(c => c.name);
  for (const col of ['ai_edit_fields', 'view_scope', 'backfill_enabled']) {
    assert.ok(cols.includes(col), `老库缺列未补齐: ${col}`);
  }
  const row = db.prepare('SELECT * FROM character_body_profile WHERE character_id = 1').get();
  assert.equal(row.height, '170cm', '补列不该动存量数据');
  assert.equal(row.ai_edit_fields, '["stats"]', '补列那一刻的存量行应按语义默认回填，而不是留在空数组上');
  assert.equal(row.view_scope, '["user","character"]', '新默认口径（含群聊）应随补列一起落到存量行');
  assert.equal(row.backfill_enabled, 1);
  assert.equal(listIntimateLogs(1).length, 1);

  // 权限读出来就是"只放开 stats"，否则老库用户一编辑档案就再也记不上账
  assert.deepEqual(getBodyProfile(1).aiEditFields, AI_EDIT_DEFAULTS);
  assert.equal(isAiEditAllowed(1, 'stats'), true);
  // 回填进度表就位
  assert.equal(getBackfillState(1).status, 'idle');
});

test('口径默认值一次性迁移：存量 ["user"] 扩到含群聊的新默认，只跑一次、不覆盖用户之后的收窄', async t => {
  const db = getDb();
  t.after(() => closeDb());

  const mk = name => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
    ).run(name, name);
    return Number(lastInsertRowid);
  };
  const legacy = mk('legacy');     // 存量行里还是旧默认口径
  const other = mk('other');       // 别的口径：迁移不该碰

  upsertBodyProfile(legacy, { viewScope: ['user'] });
  upsertBodyProfile(other, { viewScope: ['character'] });

  // 模拟"还没跑过这次迁移的老库"：把 once 标记删掉再迁移一次
  db.prepare(`DELETE FROM system_settings WHERE setting_key = 'intimate_view_scope_group_default'`).run();
  migrateIntimateSchema(db);

  assert.deepEqual(getBodyProfile(legacy).viewScope, ['user', 'character'], '旧默认口径要随默认值一起扩到群聊');
  assert.deepEqual(getBodyProfile(other).viewScope, ['character'], '别的口径不该被动到');
  assert.ok(
    db.prepare(`SELECT 1 FROM system_settings WHERE setting_key = 'intimate_view_scope_group_default'`).get(),
    'once 标记必须落库'
  );

  // 只跑一次：用户之后主动收窄回「只看用户↔角色」，再迁移也不会被改回来
  upsertBodyProfile(legacy, { viewScope: ['user'] });
  migrateIntimateSchema(db);
  assert.deepEqual(getBodyProfile(legacy).viewScope, ['user'], '用户主动收窄后不该被迁移改回');
});

// ──────────────── 幂等记账 ────────────────

test('幂等记账：同一 (character, raw_id, tag 组合) 连记两次只落一行', async t => {
  const id = seed(t);
  const payload = {
    scene: 'chat', partnerKind: 'user', rawId: 77, source: 'auto',
    acts: [{ actKey: 'vaginal', positionKey: 'missionary' }, { actKey: 'climax' }],
  };

  assert.deepEqual(recordIntimateActs(id, payload), { inserted: 2, skipped: 0, blocked: false });
  assert.deepEqual(recordIntimateActs(id, payload), { inserted: 0, skipped: 2, blocked: false });
  assert.equal(listIntimateLogs(id).length, 2);

  // 换锚点（另一轮对话）就是新的一笔
  assert.equal(recordIntimateActs(id, { ...payload, rawId: 78 }).inserted, 2);
  assert.equal(listIntimateLogs(id).length, 4);

  // 没锚点时不虚高：退化为一次性 uid，重复调用也各算一笔（宁可漏记不可虚增）
  const anchorless = { scene: 'chat', source: 'auto', acts: [{ actKey: 'climax' }] };
  assert.equal(recordIntimateActs(id, anchorless).inserted, 1);
  assert.equal(recordIntimateActs(id, anchorless).inserted, 1);

  // 空 acts / 无效 actKey 不落库
  assert.deepEqual(recordIntimateActs(id, { rawId: 99, acts: [] }), { inserted: 0, skipped: 0, blocked: false });
  assert.equal(recordIntimateActs(id, { rawId: 99, acts: [{ actKey: '  ' }] }).inserted, 0);
});

// ──────────────── 权限 ────────────────

test('权限：未授权 stats 时自动记账被阻断，人工补录不受限', async t => {
  const id = seed(t);

  // 没有档案行 = 用户没表过态，只放开 stats
  assert.deepEqual(getBodyProfile(id).aiEditFields, AI_EDIT_DEFAULTS);
  assert.equal(isAiEditAllowed(id, 'stats'), true);
  assert.equal(isAiEditAllowed(id, 'body'), false);
  assert.equal(isAiEditAllowed(id, '不是权限键'), false);
  assert.equal(isAiEditAllowed(0, 'stats'), false);

  // 用户改成不含 stats 的清单
  const profile = upsertBodyProfile(id, { aiEditFields: ['body', 'note'], viewScope: ['user', 'character'] });
  assert.deepEqual(profile.aiEditFields, ['body', 'note']);
  assert.equal(isAiEditAllowed(id, 'stats'), false);

  const blocked = recordIntimateActs(id, { scene: 'chat', rawId: 5, source: 'auto', acts: [{ actKey: 'climax' }] });
  assert.deepEqual(blocked, { inserted: 0, skipped: 0, blocked: true });
  assert.equal(listIntimateLogs(id).length, 0, '被阻断时一笔都不该落库');
  assert.equal(getIntimateStats(id).totalActs, 0);

  // LLM 来源同样受闸门约束
  assert.equal(recordIntimateActs(id, { scene: 'chat', rawId: 6, source: 'llm', acts: [{ actKey: 'climax' }] }).blocked, true);

  // 人工补录绕过权限（用户自己点的算事实）
  const manual = recordIntimateActs(id, { scene: 'manual', source: 'manual', acts: [{ actKey: 'climax' }] });
  assert.deepEqual(manual, { inserted: 1, skipped: 0, blocked: false });
  assert.equal(listIntimateLogs(id).length, 1);

  // 未知权限键被规范化丢掉、重复键去重
  assert.deepEqual(upsertBodyProfile(id, { aiEditFields: ['stats', 'hack', 'stats'] }).aiEditFields, ['stats']);
  assert.equal(isAiEditAllowed(id, 'stats'), true);

  // 脏数据 fail-closed
  getDb().prepare(`UPDATE character_body_profile SET ai_edit_fields = 'not json' WHERE character_id = ?`).run(id);
  assert.deepEqual(getBodyProfile(id).aiEditFields, []);
  assert.equal(isAiEditAllowed(id, 'stats'), false);
});

test('档案写入：白名单合并、未传保持原值、敏感带与开关规范化', async t => {
  const id = seed(t);

  upsertBodyProfile(id, { height: '168cm', bust: '88', waist: '58', hip: '90', cup: 'D' });
  setInjectEnabled(id, true);
  let profile = upsertBodyProfile(id, { note: '肩颈怕痒' });
  assert.equal(profile.height, '168cm', '未传字段保持原值');
  assert.equal(profile.injectEnabled, true);
  assert.equal(profile.note, '肩颈怕痒');
  assert.equal(profile.backfillEnabled, true, '回填默认开');

  profile = upsertBodyProfile(id, {
    sensitiveZones: [{ key: 'neck', label: '颈侧', level: 9 }, { key: '', label: '' }, 'garbage'],
    backfillEnabled: false,
  });
  assert.deepEqual(profile.sensitiveZones, [{ key: 'neck', label: '颈侧', level: 5 }]);
  assert.equal(profile.backfillEnabled, false);
  assert.equal(setInjectEnabled(id, false).injectEnabled, false);

  // 角色不存在 → 报错（路由据此回 404）
  assert.throws(() => upsertBodyProfile(999999, { height: '1' }), /character not found/);
  assert.throws(() => upsertBodyProfile(0, { height: '1' }), /invalid character id/);
});

// ──────────────── 统计口径 ────────────────

test('统计口径：viewScope / partnerKinds 过滤生效，汇总只算过滤后的行', async t => {
  const id = seed(t);
  recordIntimateActs(id, { scene: 'chat', partnerKind: 'user', rawId: 1, acts: [{ actKey: 'vaginal', count: 2 }] });
  recordIntimateActs(id, { scene: 'chat', partnerKind: 'user', rawId: 2, acts: [{ actKey: 'climax', climaxCount: 3 }] });
  recordIntimateActs(id, { scene: 'event', partnerKind: 'character', partnerId: 9, rawId: 3, acts: [{ actKey: 'oral' }] });
  recordIntimateActs(id, { scene: 'chat', partnerKind: 'self', rawId: 4, acts: [{ actKey: 'self' }] });

  // 默认口径：用户↔角色 + 角色↔角色（群聊那笔默认就看得见；NPC / 自慰仍要显式勾选）
  let stats = getIntimateStats(id);
  assert.deepEqual(stats.partnerKinds, ['user', 'character']);
  assert.equal(stats.totalActs, 4);
  assert.equal(stats.totalClimax, 3);
  assert.equal(stats.actKinds, 3);
  assert.deepEqual(stats.byAct.map(a => a.actKey).sort(), ['climax', 'oral', 'vaginal']);
  assert.deepEqual(stats.byPartner, [
    { partnerKind: 'user', partnerId: 0, count: 3 },
    { partnerKind: 'character', partnerId: 9, count: 1 },
  ]);
  assert.equal(listIntimateLogs(id).length, 3);

  // 显式 partnerKinds（数组 / 逗号串 / 非法值被忽略）
  assert.equal(getIntimateStats(id, { partnerKinds: ['character'] }).totalActs, 1);
  assert.equal(getIntimateStats(id, { partnerKinds: 'character,self' }).totalActs, 2);
  assert.deepEqual(getIntimateStats(id, { partnerKinds: 'nope' }).partnerKinds, ['user', 'character'], '非法值等于没传');
  assert.equal(getIntimateStats(id, { partnerKinds: 'character,self' }).byScene.find(s => s.scene === 'event').count, 1);

  // 档案 viewScope 生效
  upsertBodyProfile(id, { viewScope: ['user', 'character'] });
  assert.deepEqual(getIntimateStats(id).partnerKinds, ['user', 'character']);
  assert.equal(getIntimateStats(id).totalActs, 4);
  assert.equal(listIntimateLogs(id).length, 3);

  // 口径是减法：清空勾选不允许"看到更多"，空/脏值一律回落默认口径
  assert.deepEqual(upsertBodyProfile(id, { viewScope: [] }).viewScope, DEFAULT_VIEW_SCOPE);
  assert.deepEqual(getIntimateStats(id).partnerKinds, ['user', 'character']);
  assert.equal(getIntimateStats(id).totalActs, 4);
  getDb().prepare(`UPDATE character_body_profile SET view_scope = 'oops' WHERE character_id = ?`).run(id);
  assert.deepEqual(getBodyProfile(id).viewScope, DEFAULT_VIEW_SCOPE);

  // 逃生门：只有请求参数层的 all 才表示不过滤
  assert.deepEqual(getIntimateStats(id, { partnerKinds: 'all' }).partnerKinds, []);
  assert.equal(getIntimateStats(id, { partnerKinds: 'all' }).totalActs, 5);
  assert.equal(listIntimateLogs(id, { partnerKinds: 'all' }).length, 4);

  // 面板：counts 跟随口径，另有未过滤总数；backfill 无行时是 idle 空状态
  const panel = getIntimatePanel(id, { partnerKinds: 'character' });
  assert.equal(panel.characterId, id);
  assert.equal(panel.counts.logs, 1);
  assert.equal(panel.counts.allLogs, 4);
  assert.equal(panel.stats.totalActs, 1);
  assert.equal(panel.profile.viewScope[0], 'user');
  assert.deepEqual(panel.backfill, {
    characterId: id, status: 'idle', lastRawId: 0, scanned: 0, inserted: 0, error: '', updatedAt: null,
  });
  assert.equal(panel.firsts.length, 4, '里程碑是事实、不随口径过滤');

  // limit / offset 仍是硬上限与位移
  assert.equal(listIntimateLogs(id, { limit: 2, partnerKinds: 'all' }).length, 2);
  assert.equal(listIntimateLogs(id, { limit: 2, offset: 3, partnerKinds: 'all' }).length, 1);
  assert.equal(listIntimateLogs(id, { limit: 9999, partnerKinds: 'all' }).length, 4);
});

// ──────────────── 回滚 / 纠错 ────────────────

test('occurredAt 规范化：SQLite 无时区串必须落成 ISO+Z（与 nowIso 不混存）', async t => {
  const id = seed(t);
  // ai-judge 手动补判传的是 raw_messages.created_at（SQLite datetime('now') 的裸 UTC 串）
  recordIntimateActs(id, {
    scene: 'chat', rawId: 21, occurredAt: '2026-03-01 05:30:00',
    acts: [{ actKey: 'vaginal' }],
  });
  const row = getDb().prepare(
    `SELECT occurred_at FROM character_intimate_log WHERE character_id = ? AND raw_id = 21`
  ).get(id);
  assert.equal(row.occurred_at, '2026-03-01T05:30:00.000Z',
    '裸 SQLite 串要转成 ISO+Z；否则前端按本地解析偏 8 小时、ORDER BY 字符串比较空格恒排在 T 前');
  // ISO 输入原样透传，不重复转换
  recordIntimateActs(id, {
    scene: 'chat', rawId: 22, occurredAt: '2026-03-02T06:00:00.000Z',
    acts: [{ actKey: 'oral' }],
  });
  const row2 = getDb().prepare(
    `SELECT occurred_at FROM character_intimate_log WHERE character_id = ? AND raw_id = 22`
  ).get(id);
  assert.equal(row2.occurred_at, '2026-03-02T06:00:00.000Z');
});

test('回滚：统计回落、derived 里程碑被清、manual 里程碑保留', async t => {
  const id = seed(t);
  recordIntimateActs(id, {
    scene: 'chat', rawId: 11, occurredAt: '2026-01-01T00:00:00.000Z',
    acts: [{ actKey: 'vaginal' }, { actKey: 'climax' }],
  });
  recordIntimateActs(id, { scene: 'chat', rawId: 12, occurredAt: '2026-02-01T00:00:00.000Z', acts: [{ actKey: 'climax' }] });
  assert.equal(getIntimateStats(id).totalActs, 3);
  assert.equal(getIntimateStats(id).firstAt, '2026-01-01T00:00:00.000Z');

  // 人工里程碑：climax 覆盖派生值，first_kiss 纯人工（没有对应流水）
  setFirstAt(id, 'climax', { firstAt: '2025-11-11T00:00:00.000Z', note: '用户手改' });
  setFirstAt(id, 'first_kiss', { firstAt: '2025-12-24T00:00:00.000Z' });
  refreshFirsts(id);
  assert.equal(listFirsts(id).find(f => f.actKey === 'climax').source, 'manual', '人工结论不被流水覆盖');

  const rolled = rollbackIntimateByRawId(11);
  assert.equal(rolled.deleted, 2);
  assert.deepEqual(rolled.characters, [id]);

  const stats = getIntimateStats(id);
  assert.equal(stats.totalActs, 1, '撤回后统计必须回落');
  assert.equal(stats.totalClimax, 0);
  assert.equal(stats.firstAt, '2026-02-01T00:00:00.000Z');

  const firsts = listFirsts(id);
  assert.deepEqual(firsts.map(f => f.actKey).sort(), ['climax', 'first_kiss'], 'derived 的 vaginal 应被清掉');
  assert.equal(firsts.find(f => f.actKey === 'climax').firstAt, '2025-11-11T00:00:00.000Z');
  assert.equal(firsts.find(f => f.actKey === 'climax').source, 'manual');

  // 不存在的锚点是空操作
  assert.deepEqual(rollbackIntimateByRawId(999), { deleted: 0, characters: [] });
  assert.deepEqual(rollbackIntimateByRawId(0), { deleted: 0, characters: [] });
});

test('人工纠错：删除单条流水要校验归属，清空数据保留档案与回填进度', async t => {
  const id = seed(t, 'lin');
  const other = seed(t, 'other');
  recordIntimateActs(id, { scene: 'chat', rawId: 21, acts: [{ actKey: 'vaginal' }, { actKey: 'climax' }] });
  recordIntimateActs(other, { scene: 'chat', rawId: 22, acts: [{ actKey: 'oral' }] });
  upsertBodyProfile(id, { height: '168cm' });
  saveBackfillState(id, { status: 'done', lastRawId: 21, scanned: 3, inserted: 2 });

  const logId = listIntimateLogs(id).find(l => l.actKey === 'vaginal').id;
  assert.equal(deleteIntimateLog(other, logId), false, '不能删别的角色的流水');
  assert.equal(deleteIntimateLog(id, 999999), false);
  assert.equal(deleteIntimateLog(id, logId), true);
  assert.equal(listIntimateLogs(id).length, 1);
  assert.deepEqual(listFirsts(id).map(f => f.actKey), ['climax'], '删掉唯一一条流水后 derived 里程碑同步清掉');
  assert.equal(getIntimateStats(id).totalActs, 1);

  const cleared = clearIntimateData(id);
  assert.deepEqual(cleared, { logs: 1, firsts: 1 });
  assert.equal(getIntimateStats(id).totalActs, 0);
  assert.equal(getBodyProfile(id).height, '168cm', '清空数据保留身体档案');
  assert.equal(getBackfillState(id).status, 'done', '清空不回退回填进度：清了就不该自己填回来');
});

test('角色删除：五张表按外键级联清空', async t => {
  const id = seed(t);
  const db = getDb();
  recordIntimateActs(id, { scene: 'chat', rawId: 41, acts: [{ actKey: 'vaginal' }] });
  upsertBodyProfile(id, { height: '168cm' });
  saveBackfillState(id, { status: 'done', lastRawId: 41, scanned: 5, inserted: 1 });
  db.prepare(`INSERT INTO character_intimate_stats (character_id, stats_json) VALUES (?, '{}')`).run(id);

  const tables = [
    'character_body_profile',
    'character_intimate_log',
    'character_intimate_firsts',
    'character_intimate_stats',
    'character_intimate_backfill',
  ];
  for (const table of tables) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`).get(id).n, 1, `${table} 应有一行`);
  }

  db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  for (const table of tables) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id = ?`).get(id).n, 0, `${table} 应被级联清空`);
  }
});

// ──────────────── 回填进度 ────────────────

test('回填进度：无行返回 idle 空状态，写入后可读回、未传字段保持原值', async t => {
  const id = seed(t);

  assert.deepEqual(getBackfillState(id), {
    characterId: id, status: 'idle', lastRawId: 0, scanned: 0, inserted: 0, error: '', updatedAt: null,
  });

  const saved = saveBackfillState(id, { status: 'running', lastRawId: 120, scanned: 40, inserted: 7 });
  assert.equal(saved.status, 'running');
  assert.equal(saved.lastRawId, 120);
  assert.equal(saved.scanned, 40);
  assert.equal(saved.inserted, 7);
  assert.ok(saved.updatedAt, '写入应带 updated_at');

  const patched = saveBackfillState(id, { status: 'done' });
  assert.equal(patched.lastRawId, 120, '未传字段保持原值');
  assert.equal(patched.inserted, 7);
  assert.equal(patched.error, '');

  const clamped = saveBackfillState(id, { lastRawId: -5, error: 'boom' });
  assert.equal(clamped.lastRawId, 0, '负数被夹到 0');
  assert.equal(clamped.error, 'boom');
  assert.equal(clamped.status, 'done');

  assert.throws(() => saveBackfillState(999999, { status: 'idle' }), /character not found/);
  assert.throws(() => saveBackfillState(0, { status: 'idle' }), /invalid character id/);
});

// ──────────────── prompt 串 → tag 数组 ────────────────

test('tagsFromPromptString：权重剥离 / 去重 / 空输入 / 数组入参 / 截断', async () => {
  assert.deepEqual(
    tagsFromPromptString('1girl, (cowgirl:1.2), ((missionary)), [anal], {fellatio}, 1girl, , '),
    ['1girl', 'cowgirl', 'missionary', 'anal', 'fellatio'],
  );
  assert.deepEqual(tagsFromPromptString('  CUM IN PUSSY , Vaginal '), ['cum in pussy', 'vaginal']);
  // 已经是数组：逐项走同一套规范化（数组元素里带逗号也拆）
  assert.deepEqual(tagsFromPromptString(['Blowjob', 'deepthroat, (orgasm:1.1)']), ['blowjob', 'deepthroat', 'orgasm']);
  // 非法入参一律空数组
  assert.deepEqual(tagsFromPromptString(''), []);
  assert.deepEqual(tagsFromPromptString('   ,  , '), []);
  assert.deepEqual(tagsFromPromptString(null), []);
  assert.deepEqual(tagsFromPromptString(undefined), []);
  assert.deepEqual(tagsFromPromptString(123), []);
  assert.deepEqual(tagsFromPromptString({ prompt: 'x' }), []);
  // 截断（maxTags 夹到 1~1000）
  assert.deepEqual(tagsFromPromptString('a, b, c, d, e', { maxTags: 3 }), ['a', 'b', 'c']);
  assert.deepEqual(tagsFromPromptString('a, b', { maxTags: 0 }), ['a']);
  assert.equal(tagsFromPromptString('a, b, c', { maxTags: 999 })[2], 'c');
});

test('prompt 串直喂分类：大小写与权重包装不影响命中', async t => {
  seed(t);
  // 知识库种子自带体位词表（与生图 tag 同源）；这里再插一条合成 tag，避免依赖种子里的具体文案
  getDb().prepare(
    `INSERT INTO image_prompt_knowledge (knowledge_id, category, title, content, executable_tags, version)
     VALUES ('pos_test_only', 'adult_pose_vocabulary', '测试体位', '', ?, '1')`
  ).run(JSON.stringify([{ tag: 'test_only_pose', label: '测试体位', group: '测试' }]));
  resetPositionVocabularyCache();

  // 大小写 / 权重混写也要命中同一行为与同一位体
  const acts = classifyPromptTags(tagsFromPromptString('(Test_Only_Pose:1.4), (Creampie:1.1), 1girl'));
  assert.deepEqual(acts, [{ actKey: 'vaginal', positionKey: 'test_only_pose' }]);

  // 非插入类行为不归因体位
  assert.deepEqual(classifyPromptTags(tagsFromPromptString('(Deepthroat:1.3)')), [{ actKey: 'oral', positionKey: '' }]);

  // 面板词表：行为分类来自 ACT_DEFINITIONS，体位来自知识库（种子 + 本次插入）
  const { listIntimateVocabulary, ACT_DEFINITIONS } = await import('../src/services/intimateService.js');
  const vocabulary = listIntimateVocabulary();
  assert.deepEqual(vocabulary.acts, ACT_DEFINITIONS.map(({ key, label }) => ({ key, label })));
  assert.ok(vocabulary.positions.some(p => p.key === 'test_only_pose' && p.label === '测试体位'));
  assert.ok(vocabulary.positions.length > 0, '体位词表应来自知识库（与生图 tag 同源）');
});

// ──────────────── 体位反向索引（打包 key → 单元素 tag） ────────────────

test('体位反查：真实样式 prompt 命中打包项，公共词不误归因', async t => {
  seed(t);

  // 知识库里的打包 key（复合串）拆开后才有可命中的单个 tag：arms grab / sex from behind 属于"抱腰后入"
  assert.equal(resolvePositionKey('arms grab, sex from behind'), 'arms grab, sex from behind', '整包精确命中');
  assert.equal(resolvePositionKey('arms grab'), 'arms grab', '唯一归属的单元素返回 tag 自身');
  assert.equal(positionLabel('arms grab'), positionLabel('arms grab, sex from behind'), '单元素借用所属打包项的中文名');
  assert.equal(positionLabel('arms grab'), '抱腰后入');

  // 真实样式 prompt：1girl/solo/on bed 都是公共词或泛化词，不能被算成体位；最终归因到 arms grab
  const acts = classifyPromptTags(tagsFromPromptString('1girl, solo, sex from behind, arms grab, on bed, cum'));
  assert.deepEqual(acts, [{ actKey: 'vaginal', positionKey: 'arms grab' }]);
  assert.equal(positionLabel(acts[0].positionKey), '抱腰后入');

  // 歧义元素（实测 on bed 归属 5 个打包项、looking at viewer 归属 34 个）一律不归因
  for (const ambiguous of ['on bed', 'looking at viewer', 'spread legs', 'solo', 'hetero']) {
    assert.equal(resolvePositionKey(ambiguous), '', `${ambiguous} 是公共词，不该被归因`);
  }
  // 泛化单 token（实测 1girl 唯一归属 'panty job, panties on penis, 1girl'）被特异性守卫挡掉，
  // 否则任何带 1girl 的 prompt 都会变成"内裤手交"
  assert.equal(resolvePositionKey('1girl'), '');

  // 单 token 打包项（bdsm / 69）走精确命中分支
  assert.equal(resolvePositionKey('bdsm'), 'bdsm');
  assert.equal(positionLabel('bdsm'), '绑缚与调教/支配与臣服/施虐与受虐');
  assert.equal(resolvePositionKey('69'), '69');
  assert.equal(positionLabel('69'), '69式');
  assert.equal(resolvePositionKey(''), '');
  assert.equal(positionLabel(''), '');
});

test('体位反查：byPosition 的中文名对单元素 key 也要解析出来', async t => {
  const id = seed(t);
  // 手工补录一条 positionKey 是"单元素 tag"的流水（真实自动记账就是这个形态）
  recordIntimateActs(id, {
    scene: 'manual', source: 'manual', partnerKind: 'user',
    acts: [{ actKey: 'vaginal', positionKey: 'arms grab' }, { actKey: 'anal', positionKey: 'bdsm' }],
  });

  const byPosition = getIntimateStats(id).byPosition;
  const labels = Object.fromEntries(byPosition.map(row => [row.positionKey, row.label]));
  assert.equal(labels['arms grab'], '抱腰后入', '单元素 key 要借所属打包项的中文名');
  assert.equal(labels.bdsm, '绑缚与调教/支配与臣服/施虐与受虐', '打包 key 用自己的中文名');
  assert.deepEqual(byPosition.map(row => row.count), [1, 1]);
});

test('体位索引：构建确定性（两次构建结果逐字段一致）', async t => {
  seed(t);
  const first = listIntimateVocabulary().positions;
  const firstLabels = first.slice(0, 20).map(p => [p.key, positionLabel(p.key)]);
  assert.ok(first.length > 0);
  assert.ok(first.every(p => Array.isArray(p.tags) && p.tags.length > 0), '每个打包项都带拆好的 tags 供前端搜索');

  resetPositionVocabularyCache();
  const second = listIntimateVocabulary().positions;
  assert.deepEqual(second, first, '同一库两次构建必须完全一致');
  assert.deepEqual(second.slice(0, 20).map(p => [p.key, positionLabel(p.key)]), firstLabels);
  assert.equal(resolvePositionKey('arms grab'), 'arms grab');
});

test('体位索引：每个打包 key 都能查回自己的中文名（key 归一化必须幂等）', async t => {
  seed(t);
  const bundles = getPositionVocabularyMap();
  const badLabel = [];
  const badResolve = [];
  for (const entry of bundles.values()) {
    const label = positionLabel(entry.key);
    if (label !== entry.label) badLabel.push(entry.key);
    if (resolvePositionKey(entry.key) !== entry.key) badResolve.push(entry.key);
    // 中文名不该回落成英文 tag 长串：不带逗号（那是复合 key 的形态）、不超过 label 上限
    assert.ok(!label.includes(','), `label 回落成了复合 key: ${label.slice(0, 40)}`);
    assert.ok(label.length <= 40, `label 超长（${label.length}）: ${label.slice(0, 40)}`);
    assert.ok(!(label === entry.key && entry.key.includes(',')), `复合 key 没解析出中文名: ${entry.key.slice(0, 40)}`);
  }
  // 回归背景：str() = trim 后 slice，截断切在空白处会留下尾空格；归一化不幂等时
  // positionLabel(bundle.key) 会查不到自己（实测 25 个 120 字符 key），前端体位排行显示英文长串
  assert.deepEqual(badLabel, [], '打包 key 必须能查回自己的中文名');
  assert.deepEqual(badResolve, [], '打包 key 必须能精确命中自己');
  assert.ok(bundles.size > 0);
  assert.ok([...bundles.values()].every(e => e.key === e.key.trim()), '索引里的 key 不该带首尾空格');
});

test('体位索引：截断处正好是空格的超长 key 仍能解析出中文名', async t => {
  seed(t);
  // 第 120 个字符是空格 → str() 先 trim 再 slice 会留下尾空格，复现键不相等的根因
  const longTag = `${'x'.repeat(119)} tail, second tag`;
  const stored = 'x'.repeat(119);
  getDb().prepare(
    `INSERT INTO image_prompt_knowledge (knowledge_id, category, title, content, executable_tags, version)
     VALUES ('pos_long_key', 'adult_pose_vocabulary', '超长 key', '', ?, '1')`
  ).run(JSON.stringify([{ tag: longTag, label: '超长key体位', group: '测试' }]));
  resetPositionVocabularyCache();

  assert.equal(resolvePositionKey(longTag), stored, '截断后要去掉尾空格再入索引');
  assert.equal(getPositionVocabularyMap().get(stored).key, stored, '索引里的 key 是规范化结果');
  assert.equal(positionLabel(stored), '超长key体位');
  assert.equal(positionLabel(longTag), '超长key体位', '拿原始超长 tag 查也要命中');
});
