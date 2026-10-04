/**
 * intimatePrompt 单测：<intimate_profile> 注入块的组装口径
 *
 * 口径来源：task-2 冻结契约（内容顺序 1身体→2敏感带→3初次→4相处、超长按 4→3→2 整段丢弃、
 * 默认 ≤600 字符、结尾反向约束原文照用）。
 * 全程用内存库 + fetch 抛错挡网络，验证本模块零 IO、零 LLM。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate prompt fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  upsertBodyProfile, recordIntimateActs, setFirstAt, getPositionVocabularyMap,
} = await import('../src/services/intimateService.js');
const {
  buildIntimateProfileBlock, shouldInjectIntimate,
  INTIMATE_BLOCK_TAG, INTIMATE_TAIL_NOTICE, ZONE_LEVEL_LABELS, DEFAULT_MAX_CHARS,
} = await import('../src/services/intimatePrompt.js');

config.dbPath = ':memory:';
after(() => closeDb());

let seq = 0;

/** 造一个干净的角色，测试之间互不串数据 */
function seedCharacter() {
  const db = getDb();
  seq += 1;
  db.prepare('INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, ?, ?)')
    .run(`ai_side_${seq}`, `角色${seq}`, '测试用成年角色', '测试');
  return db.prepare('SELECT last_insert_rowid() AS id').get().id;
}

/** 块里允许出现的整行前缀（用于断言没有"半截字段"） */
const LINE_PREFIXES = ['身体：', '备注：', '敏感带：', '初次：', '相处：'];

function assertWellFormed(block) {
  assert.ok(block.startsWith(`<${INTIMATE_BLOCK_TAG}>\n`), '首行必须是开标签');
  assert.ok(block.endsWith(`\n</${INTIMATE_BLOCK_TAG}>`), '末行必须是闭标签');
  assert.equal((block.match(new RegExp(`<${INTIMATE_BLOCK_TAG}>`, 'g')) || []).length, 1);
  assert.equal((block.match(new RegExp(`</${INTIMATE_BLOCK_TAG}>`, 'g')) || []).length, 1);
  assert.ok(block.includes(INTIMATE_TAIL_NOTICE), '结尾反向约束必须原文存在');
  const lines = block.split('\n');
  assert.equal(lines[0], `<${INTIMATE_BLOCK_TAG}>`);
  assert.equal(lines[lines.length - 1], `</${INTIMATE_BLOCK_TAG}>`);
  assert.equal(lines[lines.length - 2], INTIMATE_TAIL_NOTICE, '反向约束紧贴闭标签');
  for (const line of lines.slice(1, -2)) {
    assert.ok(
      LINE_PREFIXES.some(prefix => line.startsWith(prefix) && line.length > prefix.length),
      `出现了空字段或半截字段：${line}`
    );
  }
}

test('开关关闭：零注入', () => {
  const id = seedCharacter();
  // 档案内容齐全，但默认 inject_enabled = 0
  upsertBodyProfile(id, { height: '168cm', bust: '88', waist: '58', hip: '89', cup: 'D', note: '腰上有一道浅疤' });
  assert.equal(buildIntimateProfileBlock(id), '');
  assert.equal(shouldInjectIntimate(id), false);
});

test('档案为空（只有开关打开）：零注入', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { injectEnabled: true });
  assert.equal(buildIntimateProfileBlock(id), '');
  assert.equal(shouldInjectIntimate(id), false);
});

test('角色不存在 / id 非法：零注入', () => {
  seedCharacter(); // 保证库已初始化
  assert.equal(buildIntimateProfileBlock(0), '');
  assert.equal(buildIntimateProfileBlock(999999), '');
  assert.equal(shouldInjectIntimate(999999), false);
});

test('只填身体信息：三围齐全合成一项，空字段不产生空行', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { height: '168cm', bust: '88', waist: '58', hip: '89', cup: 'D', injectEnabled: true });
  const block = buildIntimateProfileBlock(id);
  assertWellFormed(block);
  assert.ok(block.includes('身体：身高 168cm，三围 88-58-89，罩杯 D'));
  assert.ok(!block.includes('胸围'), '三围齐全时不该拆成单项');
  assert.ok(!block.includes('备注：'), '空备注不留空字段行');
  assert.ok(!block.includes('敏感带'), '没有敏感带就不出这一段');
  assert.ok(!block.includes('初次：'));
  assert.ok(!block.includes('相处：'), '没有流水就不出统计段');
  assert.equal(shouldInjectIntimate(id), true);
});

test('身体信息只填一半：缺项退化为单项标签，不出现空字段', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { height: '168cm', bust: '88', injectEnabled: true });
  const block = buildIntimateProfileBlock(id);
  assertWellFormed(block);
  assert.ok(block.includes('身体：身高 168cm，胸围 88'));
  assert.ok(!block.includes('腰围') && !block.includes('臀围') && !block.includes('三围'));
  assert.ok(!block.includes('罩杯'));
});

test('敏感带：level 从高到低取前 5，level 文案映射正确，未评级不注入', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, {
    injectEnabled: true,
    sensitiveZones: [
      { key: 'neck', label: '脖颈', level: 3 },
      { key: 'ear', label: '耳后', level: 5 },
      { key: 'waist', label: '腰侧', level: 1 },
      { key: 'thigh', label: '大腿内侧', level: 4 },
      { key: 'spine', label: '脊背', level: 2 },
      { key: 'knee', label: '膝窝', level: 1 }, // 与腰侧同强度且更靠后 → 第 6 个被截掉
      { key: 'unrated', label: '未评级处', level: 0 },
    ],
  });
  const block = buildIntimateProfileBlock(id);
  assertWellFormed(block);
  assert.ok(block.includes('敏感带：耳后(极强)、大腿内侧(很强)、脖颈(较强)、脊背(一般)、腰侧(轻微)'));
  assert.ok(!block.includes('膝窝'), '只取前 5 个');
  assert.ok(!block.includes('未评级处'), 'level 0 未评级不注入');
  // level 文案表与契约一致
  assert.deepEqual({ ...ZONE_LEVEL_LABELS }, { 1: '轻微', 2: '一般', 3: '较强', 4: '很强', 5: '极强' });
});

test('初次里程碑：只取 firstAt 非空的，最多 6 条', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { injectEnabled: true });
  const keys = ['vaginal', 'anal', 'oral', 'hand', 'foot', 'breast', 'thigh'];
  keys.forEach((key, i) => {
    setFirstAt(id, key, { firstAt: `2024-01-0${i + 1}T09:00:00.000Z` });
  });
  setFirstAt(id, 'first_kiss', {}); // 人工里程碑但没日期 → 不注入

  const block = buildIntimateProfileBlock(id);
  assertWellFormed(block);
  assert.ok(block.includes('初次：'));
  assert.ok(block.includes('阴道 2024-01-01'), 'ISO 时间戳只保留到日');
  assert.ok(block.includes('后庭 2024-01-02'));
  assert.ok(!block.includes('素股 2024-01-07'), '第 7 条超出上限被截掉');
  assert.ok(!block.includes('初吻'), 'firstAt 为空的里程碑不注入');
  assert.ok(block.split('\n').find(l => l.startsWith('初次：')).split('；').length === 6);
});

test('相处记录：粗粒度总数 + Top3 体位，不逐个给次数', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { injectEnabled: true });
  recordIntimateActs(id, {
    scene: 'chat', partnerKind: 'user', rawId: 11,
    acts: [{ actKey: 'vaginal', positionKey: 'missionary', count: 4, climaxCount: 2 }],
  });
  recordIntimateActs(id, {
    scene: 'chat', partnerKind: 'user', rawId: 12,
    acts: [
      { actKey: 'vaginal', positionKey: 'doggystyle', count: 3, climaxCount: 1 },
      { actKey: 'oral', count: 2, climaxCount: 1 },
    ],
  });
  recordIntimateActs(id, {
    scene: 'chat', partnerKind: 'user', rawId: 13,
    acts: [{ actKey: 'vaginal', positionKey: 'missionary', count: 1 }],
  });

  const positions = getPositionVocabularyMap();
  const label = key => positions.get(key)?.label || key;
  const block = buildIntimateProfileBlock(id);
  assertWellFormed(block);
  const statsLine = block.split('\n').find(l => l.startsWith('相处：'));
  assert.ok(statsLine.includes('累计约 10 次'));
  assert.ok(statsLine.includes('高潮约 4 次'));
  assert.ok(statsLine.includes(`常见体位：${label('missionary')}、${label('doggystyle')}`));
  assert.ok(!/\d+ 次[，、]?$/.test(statsLine.replace(/^相处：/, '')), '体位不逐个带次数');

  // chatUserName 只影响称呼，不改变粗粒度口径
  const named = buildIntimateProfileBlock(id, { chatUserName: '小北' });
  assert.ok(named.split('\n').find(l => l.startsWith('相处：')).includes('相处：与小北累计约 10 次'));
});

test('超长：按 4→3→2 整段丢弃，长度 ≤ 预算且标签成对', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, {
    injectEnabled: true,
    height: '168cm', bust: '88', waist: '58', hip: '89', cup: 'D',
    note: '腰上有一道浅疤，'.repeat(12),
    sensitiveZones: [{ key: 'ear', label: '耳后', level: 5 }, { key: 'neck', label: '脖颈', level: 3 }],
  });
  setFirstAt(id, 'vaginal', { firstAt: '2024-05-02' });
  recordIntimateActs(id, {
    scene: 'chat', partnerKind: 'user', rawId: 21,
    acts: [{ actKey: 'vaginal', positionKey: 'missionary', count: 6, climaxCount: 3 }],
  });

  // 1) 默认预算：全部内容塞不下时也不许超预算
  const full = buildIntimateProfileBlock(id);
  assertWellFormed(full);
  assert.ok(full.length <= DEFAULT_MAX_CHARS, `默认预算超长：${full.length}`);

  // 2) 收紧到 200：先丢 4 相处记录，再丢 3 初次、2 敏感带，只留身体
  const tight = buildIntimateProfileBlock(id, { maxChars: 200 });
  assertWellFormed(tight);
  assert.ok(tight.length <= 200, `截断后仍超长：${tight.length}`);
  assert.ok(tight.includes('身体：'));
  assert.ok(!tight.includes('相处：'));
  assert.ok(!tight.includes('初次：'));
  assert.ok(!tight.includes('敏感带：'));

  // 3) 预算小到连正文都放不下：宁可零注入，也不吐残缺档案
  assert.equal(buildIntimateProfileBlock(id, { maxChars: 40 }), '');
});

test('备注过长时先丢掉备注整行（不是截半句）', () => {
  const id = seedCharacter();
  upsertBodyProfile(id, {
    injectEnabled: true, height: '168cm', note: '疤痕'.repeat(80),
  });
  const block = buildIntimateProfileBlock(id, { maxChars: 260 });
  assertWellFormed(block);
  assert.ok(block.length <= 260);
  assert.ok(block.includes('身体：身高 168cm'));
  assert.ok(!block.includes('备注：疤痕疤痕疤痕疤痕疤痕'), '备注被整行丢弃而不是截断半句');
});

test('模块只读：组装过程不写库、不触网', async () => {
  const id = seedCharacter();
  upsertBodyProfile(id, { injectEnabled: true, height: '168cm' });
  const db = getDb();
  const before = {
    profile: db.prepare('SELECT COUNT(*) AS n FROM character_body_profile').get().n,
    logs: db.prepare('SELECT COUNT(*) AS n FROM character_intimate_log').get().n,
    firsts: db.prepare('SELECT COUNT(*) AS n FROM character_intimate_firsts').get().n,
  };
  for (let i = 0; i < 3; i++) buildIntimateProfileBlock(id);
  const after2 = {
    profile: db.prepare('SELECT COUNT(*) AS n FROM character_body_profile').get().n,
    logs: db.prepare('SELECT COUNT(*) AS n FROM character_intimate_log').get().n,
    firsts: db.prepare('SELECT COUNT(*) AS n FROM character_intimate_firsts').get().n,
  };
  assert.deepEqual(after2, before);
  // fetch 仍是被替换掉的抛错实现，说明模块没有偷偷绕过它
  await assert.rejects(() => fetch('https://example.com/intimate'));
});
