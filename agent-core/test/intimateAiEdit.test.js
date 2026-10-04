import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
// 只放行本测试自己起的 express 服务，其余网络请求一律拒绝：AI 整理不允许真实联网
globalThis.fetch = async (url, opts) => {
  const target = String(url);
  if (serverPort && target.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`intimate ai edit fixture forbids network: ${target}`);
};

const { config, getLlmConfig } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb, migrateIntimateSchema } = await import('../src/db/index.js');
const service = await import('../src/services/intimateAiEdit.js');
const { getBodyProfile, upsertBodyProfile, listFirsts, isAiEditAllowed } = await import('../src/services/intimateService.js');
const aiEditRoutes = (await import('../src/routes/intimateAiEdit.js')).default;

// 按 app.js 的落点挂载（与 intimate 路由同前缀、同样早于 charactersRoutes）
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/characters', aiEditRoutes);
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

let seq = 0;

/** 造一个角色；aiEditFields 不传 = 走默认（只放开 stats） */
function seedCharacter({ aiEditFields, displayName = '琪亚娜' } = {}) {
  const db = getDb();
  const unique = `ai-edit-${++seq}`;
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(unique, displayName);
  const id = Number(lastInsertRowid);
  if (aiEditFields) upsertBodyProfile(id, { aiEditFields });
  return id;
}

/** 造该角色私聊会话的消息（user / assistant 交替） */
function seedDialogue(characterId, lines) {
  const db = getDb();
  const stmt = db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`);
  lines.forEach((line, index) => {
    stmt.run(`char_${characterId}`, index % 2 === 0 ? 'user' : 'assistant', line);
  });
}

/** 假 LLM：固定返回一段固定 JSON / 文本，保证测试完全离线 */
const fakeLlm = payload => async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, payload: await res.json() };
}

// ──────────────── 迁移 ────────────────

test('migrateIntimateSchema 建出 character_intimate_suggestions 与索引，且可重复调用', () => {
  const db = getDb();
  const columns = db.prepare('PRAGMA table_info(character_intimate_suggestions)').all().map(c => c.name);
  assert.deepEqual(columns, [
    'id', 'character_id', 'field', 'current_value', 'suggestion', 'reason',
    'status', 'source', 'created_at', 'updated_at',
  ]);
  const indexes = db.prepare('PRAGMA index_list(character_intimate_suggestions)').all().map(row => row.name);
  assert.ok(indexes.includes('idx_intimate_suggestions_char'), '缺少 (character_id, status) 索引');

  migrateIntimateSchema(db); // 幂等：再跑一次不报错、表结构不变
  assert.deepEqual(db.prepare('PRAGMA table_info(character_intimate_suggestions)').all().map(c => c.name), columns);
});

// ──────────────── 素材与 prompt ────────────────

test('没有素材时不调 LLM，直接返回 empty', async () => {
  const id = seedCharacter();
  let called = 0;
  const result = await service.proposeProfileEdits(id, {
    llmCall: async () => { called += 1; return '{}'; },
  });
  assert.deepEqual(result, { applied: [], suggestions: [], empty: true });
  assert.equal(called, 0, '空素材必须零 LLM 调用');
});

test('prompt 合规：完整 JSON 示例 + actKey 候选 + 只输出 JSON，且只喂该角色私聊的非系统消息', async () => {
  const id = seedCharacter();
  seedDialogue(id, ['用户：今天有点冷', '琪亚娜：抱抱']);
  const other = seedCharacter();
  seedDialogue(other, ['用户：这是别人的秘密']);
  getDb().prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'system', ?)`)
    .run(`char_${id}`, '系统提示词内容');

  let captured = null;
  await service.proposeProfileEdits(id, {
    llmCall: async (messages, opts) => { captured = { messages, opts }; return '{}'; },
  });

  const all = captured.messages.map(m => m.content).join('\n');
  assert.equal(captured.messages[0].role, 'system');
  assert.ok(all.includes('"sensitiveZones"'), 'prompt 缺少字段名');
  assert.match(all, /"firstAt": "2024-06-01"/, 'prompt 缺少完整 JSON 示例值');
  assert.match(all, /vaginal\(阴道\)/, 'actKey 候选应由 ACT_DEFINITIONS 生成');
  assert.match(all, /first_kiss\(初吻\)/, 'actKey 候选应包含全部行为键');
  assert.match(all, /只输出/, 'prompt 必须要求只输出 JSON');
  assert.match(all, /琪亚娜：抱抱/, '角色名应取 display_name');
  assert.ok(!all.includes('这是别人的秘密'), '别的角色的会话不能混进素材');
  assert.ok(!all.includes('系统提示词内容'), 'system 消息不算相处素材');
  assert.equal(captured.opts.temperature, 0.2, '整理任务要用低温度');
  assert.deepEqual(captured.opts.response_format, { type: 'json_object' });
});

test('素材按"最近优先"累计，超出预算的旧消息不进 prompt', async () => {
  const id = seedCharacter();
  // 用不会出现在 prompt 模板里的记号，避免和示例文案（如"旧伤"）撞词
  const OLD = 'OLD-MESSAGE-TOKEN';
  const NEW = 'NEW-MESSAGE-TOKEN';
  seedDialogue(id, [`用户：${OLD.repeat(30)}`, `琪亚娜：${NEW.repeat(30)}`]);
  let all = '';
  await service.proposeProfileEdits(id, {
    sourceCharLimit: 300,
    llmCall: async messages => { all = messages.map(m => m.content).join('\n'); return '{}'; },
  });
  assert.ok(all.includes(NEW), '最近的消息必须在素材里');
  assert.ok(!all.includes(OLD), '超出字数预算的旧消息应被丢掉');
});

// ──────────────── 权限分流 ────────────────

test('已授权 body 直接落库并返回 applied；未授权 note 只落 pending 提议', async () => {
  const id = seedCharacter({ aiEditFields: ['stats', 'body'] });
  seedDialogue(id, ['用户：我身高168，胸围88，腰围60，臀围89，罩杯D', '琪亚娜：记住了']);
  const result = await service.proposeProfileEdits(id, {
    llmCall: fakeLlm({ height: '168cm', bust: '88', waist: '60', hip: '89', cup: 'D', note: '肩颈怕痒' }),
  });

  assert.equal(result.empty, false);
  assert.deepEqual(result.applied.map(item => item.field), ['body']);
  assert.deepEqual(result.applied[0].value, { height: '168cm', bust: '88', waist: '60', hip: '89', cup: 'D' });
  const profile = getBodyProfile(id);
  assert.equal(profile.height, '168cm');
  assert.equal(profile.cup, 'D');

  assert.deepEqual(result.suggestions.map(item => item.field), ['note']);
  assert.equal(result.suggestions[0].status, 'pending');
  assert.equal(profile.note, '', '未授权字段绝不能顺手写进档案');
  assert.deepEqual(profile.sensitiveZones, []);
});

test('默认只放开 stats：四个字段全部只落 pending 提议，档案一动没动', async () => {
  const id = seedCharacter(); // 默认 aiEditFields = ['stats']
  seedDialogue(id, ['用户：我身高168，罩杯D', '琪亚娜：记住了']);
  const result = await service.proposeProfileEdits(id, {
    llmCall: fakeLlm({
      height: '168cm',
      cup: 'D',
      note: '肩颈怕痒',
      sensitiveZones: [{ key: 'neck', label: '脖颈', level: 4 }],
      firsts: [{ actKey: 'vaginal', firstAt: '2024-06-01' }],
    }),
  });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.suggestions.map(item => item.field).sort(), ['body', 'firsts', 'note', 'sensitiveZones']);

  const profile = getBodyProfile(id);
  assert.equal(profile.height, '');
  assert.equal(profile.cup, '');
  assert.equal(profile.note, '');
  assert.deepEqual(profile.sensitiveZones, []);
  assert.deepEqual(listFirsts(id), [], '未授权时里程碑也不许写');

  const rows = service.listSuggestions(id);
  assert.equal(rows.length, 4);
  const byField = new Map(rows.map(row => [row.field, row]));
  assert.equal(byField.get('note').suggestion, '肩颈怕痒');
  assert.equal(byField.get('note').fieldLabel, '备注');
  assert.equal(byField.get('body').suggestion, '身高 168cm、罩杯 D');
  assert.equal(byField.get('sensitiveZones').suggestion, '脖颈(很强)');
  assert.equal(byField.get('sensitiveZones').currentValue, '');
  assert.equal(byField.get('firsts').suggestion, '阴道 2024-06-01');
  assert.deepEqual(byField.get('sensitiveZones').payload, [{ key: 'neck', label: '脖颈', level: 4 }]);
  assert.match(byField.get('note').reason, /AI 修改权限/);
});

test('已授权 firsts：写入里程碑并标记来源，用户可在面板改回', async () => {
  const id = seedCharacter({ aiEditFields: ['stats', 'firsts'] });
  seedDialogue(id, ['用户：那天是我们的第一次', '琪亚娜：嗯…记得']);
  const result = await service.proposeProfileEdits(id, {
    llmCall: fakeLlm({ firsts: [{ actKey: 'vaginal', firstAt: '2024-06-01' }] }),
  });

  assert.deepEqual(result.applied.map(item => item.field), ['firsts']);
  const firsts = listFirsts(id);
  assert.equal(firsts.length, 1);
  assert.equal(firsts[0].actKey, 'vaginal');
  assert.equal(firsts[0].firstAt, '2024-06-01');
  assert.equal(firsts[0].source, 'manual');
  assert.equal(firsts[0].note, 'AI 整理');
});

test('脏数据一律丢弃：非 JSON 输出、超长文本、非法 level、非法 / 假日期 actKey', async () => {
  const id = seedCharacter({ aiEditFields: ['stats', 'body', 'sensitiveZones', 'note', 'firsts'] });
  seedDialogue(id, ['用户：随便聊聊', '琪亚娜：好']);

  // 输出不是 JSON：解析失败 = 什么都不要，也不抛错
  let result = await service.proposeProfileEdits(id, { llmCall: fakeLlm('这不是 JSON，只是普通回复') });
  assert.deepEqual(result, { applied: [], suggestions: [], empty: false });

  result = await service.proposeProfileEdits(id, {
    llmCall: fakeLlm({
      height: 'x'.repeat(80),      // 超长 → 丢
      bust: '88cm',                // 合法 → 留
      cup: 1234567890123456,       // 超长 → 丢
      waist: 58,                   // 数字写法 → 留（模型常这么给）
      note: 'a'.repeat(200),       // 超长 → 丢
      sensitiveZones: [
        { key: 'neck', label: '脖颈', level: 9 },   // level 越界 → 丢
        { key: 'ear', label: '耳后', level: '3' },  // 字符串数字 → 留
        { key: 'thigh', label: '大腿', level: 6 },  // level 越界 → 丢
        { key: '', label: '', level: 3 },           // 空条目 → 丢
        { key: 'ear', label: '耳朵', level: 2 },    // 重复 key → 丢
      ],
      firsts: [
        { actKey: 'not_an_act', firstAt: '2024-06-01' }, // 非法 actKey → 丢
        { actKey: 'vaginal', firstAt: '2024-13-45' },    // 假月份 → 丢
        { actKey: 'oral', firstAt: '2024-02-30' },       // 假日期 → 丢
        { actKey: 'hand', firstAt: '2024/05/06' },       // 格式不对 → 丢
        { actKey: 'hand', firstAt: '2024-05-06' },       // 合法 → 留
      ],
    }),
  });

  const fields = result.applied.map(item => item.field).sort();
  assert.deepEqual(fields, ['body', 'firsts', 'sensitiveZones']);
  const body = result.applied.find(item => item.field === 'body');
  assert.deepEqual(body.value, { bust: '88cm', waist: '58' });
  const zones = result.applied.find(item => item.field === 'sensitiveZones');
  assert.deepEqual(zones.value, [{ key: 'ear', label: '耳后', level: 3 }]);
  const firsts = result.applied.find(item => item.field === 'firsts');
  assert.deepEqual(firsts.value, [{ actKey: 'hand', firstAt: '2024-05-06' }]);
  assert.equal(getBodyProfile(id).note, '', '超长备注不许写库');
  assert.equal(listFirsts(id).length, 1);
});

// ──────────────── 提议的采纳 / 忽略 ────────────────

test('采纳提议：写入档案且 status=accepted；重复采纳与跨角色采纳都不重复写', async () => {
  const id = seedCharacter(); // 默认未授权
  seedDialogue(id, ['用户：我身高168，肩颈怕痒', '琪亚娜：记住了']);
  await service.proposeProfileEdits(id, { llmCall: fakeLlm({ height: '168cm', note: '肩颈怕痒' }) });

  const rows = service.listSuggestions(id);
  const noteRow = rows.find(row => row.field === 'note');
  const bodyRow = rows.find(row => row.field === 'body');
  const other = seedCharacter();

  assert.equal(service.acceptSuggestion(other, noteRow.id), null, '别人的提议不能被采纳');

  const accepted = service.acceptSuggestion(id, noteRow.id);
  assert.equal(accepted.suggestion.status, 'accepted');
  assert.deepEqual(accepted.applied, { field: 'note', value: '肩颈怕痒' });
  assert.equal(getBodyProfile(id).note, '肩颈怕痒');

  // 采纳 body（用户确认即写入，不再看权限位）
  const acceptedBody = service.acceptSuggestion(id, bodyRow.id);
  assert.equal(acceptedBody.suggestion.status, 'accepted');
  assert.equal(getBodyProfile(id).height, '168cm');

  // 重复采纳：幂等，不再写库
  const again = service.acceptSuggestion(id, noteRow.id);
  assert.equal(again.applied, null);
  assert.equal(again.suggestion.status, 'accepted');

  assert.deepEqual(service.listSuggestions(id), [], 'pending 列表清空');
  assert.equal(service.listSuggestions(id, { status: null }).length, 2, '已处理的行保留供审计');
  assert.equal(isAiEditAllowed(id, 'body'), false, '采纳不会顺手打开权限位');
});

test('忽略提议：只改状态，档案不动', async () => {
  const id = seedCharacter();
  seedDialogue(id, ['用户：我身高168', '琪亚娜：记住了']);
  await service.proposeProfileEdits(id, { llmCall: fakeLlm({ height: '168cm' }) });
  const [row] = service.listSuggestions(id);

  const rejected = service.rejectSuggestion(id, row.id);
  assert.equal(rejected.suggestion.status, 'rejected');
  assert.equal(getBodyProfile(id).height, '', '忽略后档案仍然是空的');
  assert.deepEqual(service.listSuggestions(id), []);
  assert.equal(service.listSuggestions(id, { status: 'rejected' }).length, 1);
  // 已拒绝的提议不会被"再次采纳"复活
  assert.equal(service.acceptSuggestion(id, row.id).applied, null);
  assert.equal(getBodyProfile(id).height, '');
});

test('同一字段的旧 pending 提议被新提议替换，不堆积', async () => {
  const id = seedCharacter();
  seedDialogue(id, ['用户：我身高168', '琪亚娜：记住了']);
  await service.proposeProfileEdits(id, { llmCall: fakeLlm({ note: '第一次整理' }) });
  await service.proposeProfileEdits(id, { llmCall: fakeLlm({ note: '第二次整理' }) });

  const rows = service.listSuggestions(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].suggestion, '第二次整理');
  // 被替换的是未处理的 pending 行，直接删掉；只有已采纳 / 已忽略的行才留作审计
  assert.equal(service.listSuggestions(id, { status: null }).length, 1);
});

test('参数与归属校验：非法 id 抛错，不存在的角色 / 提议返回 null', async () => {
  const id = seedCharacter();
  await assert.rejects(() => service.proposeProfileEdits(0), /invalid character id/);
  await assert.rejects(() => service.proposeProfileEdits(999999), /character not found/);
  assert.throws(() => service.listSuggestions(0), /invalid character id/);
  assert.throws(() => service.acceptSuggestion(id, 0), /invalid argument/);
  assert.throws(() => service.rejectSuggestion(0, 1), /invalid argument/);
  assert.equal(service.acceptSuggestion(id, 999999), null);
  assert.equal(service.rejectSuggestion(id, 999999), null);
});

// ──────────────── HTTP 层 ────────────────

test('HTTP：POST ai-edit 走通（已授权写入 / 未授权提议），列表 / 采纳 / 忽略与错误码齐全', async t => {
  const savedFreeEgg = config.llm.freeEgg;
  config.llm.freeEgg = true; // 让"LLM 已配置"闸门确定性放行（LLM 本身由注入的假实现接管，不联网）
  service.setLlmCallForTest(fakeLlm({ height: '168cm', cup: 'D', note: '肩颈怕痒' }));
  t.after(() => { service.setLlmCallForTest(null); config.llm.freeEgg = savedFreeEgg; });

  const id = seedCharacter({ aiEditFields: ['stats', 'body'] });
  seedDialogue(id, ['用户：我身高168，罩杯D', '琪亚娜：记住了']);

  let res = await api('POST', `/api/characters/${id}/intimate/ai-edit`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.applied.map(item => item.field), ['body']);
  assert.deepEqual(res.payload.suggestions.map(item => item.field), ['note']);
  assert.equal(res.payload.empty, false);

  res = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.equal(res.status, 200);
  assert.equal(res.payload.suggestions.length, 1);
  assert.equal(res.payload.suggestions[0].fieldLabel, '备注');
  assert.equal(res.payload.suggestions[0].suggestion, '肩颈怕痒');
  const sid = res.payload.suggestions[0].id;

  res = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${sid}/accept`);
  assert.equal(res.status, 200);
  assert.equal(res.payload.suggestion.status, 'accepted');
  assert.equal(getBodyProfile(id).note, '肩颈怕痒');
  assert.deepEqual((await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`)).payload.suggestions, []);

  // 再整理一次 → 忽略
  await api('POST', `/api/characters/${id}/intimate/ai-edit`);
  const sid2 = (await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`)).payload.suggestions[0].id;
  res = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${sid2}/reject`);
  assert.equal(res.status, 200);
  assert.equal(res.payload.suggestion.status, 'rejected');

  // 错误码
  assert.equal((await api('POST', '/api/characters/abc/intimate/ai-edit')).status, 400);
  assert.equal((await api('POST', '/api/characters/999999/intimate/ai-edit')).status, 404);
  assert.equal((await api('GET', '/api/characters/999999/intimate/ai-edit/suggestions')).status, 404);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/0/accept`)).status, 400);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/abc/reject`)).status, 400);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/999999/accept`)).status, 404);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/999999/reject`)).status, 404);
});

test('HTTP：总开关关闭时 POST ai-edit 返回 409，且一次 LLM 都不调', async t => {
  const saved = { ...config.features };
  let called = 0;
  service.setLlmCallForTest(async () => { called += 1; return '{}'; });
  t.after(() => { service.setLlmCallForTest(null); Object.assign(config.features, saved); });

  const id = seedCharacter();
  seedDialogue(id, ['用户：我身高168', '琪亚娜：记住了']);
  config.features.intimate = false;

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`);
  assert.equal(res.status, 409);
  assert.equal(res.payload.error, 'intimate feature disabled');
  assert.deepEqual(res.payload.disabled, ['intimate']);
  assert.equal(called, 0, '总开关关闭时必须直接拦掉，不能先烧一次 token');

  // 列表 / 采纳 / 忽略不受总开关影响（关闭后也要能看和清理已有提议）
  assert.equal((await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`)).status, 200);
});

test('LLM 未配置 → 503（不暴露 SDK 英文报错）', async () => {
  // 说明：resolveLlmApiKey() 会实时读取 agent-core/.env，本仓库的 .env 配了 Key，
  // 测试进程内无法构造"未配置"状态（不会为了测试去改 .env）。因此：
  //   1) 干净环境（.env 无 Key）时直接跑真实 503 分支；
  //   2) 配了 Key 时退化为源码级断言：503 分支存在，且早于任何 LLM 调用。
  const source = await readFile(new URL('../src/routes/intimateAiEdit.js', import.meta.url), 'utf8');
  assert.match(source, /res\.status\(503\)\.json\(\{ error: 'llm not configured' \}\)/, '缺少 503 分支');
  assert.match(source, /getLlmConfig\(\)\.hasApiKey/, '503 判定应读实时配置');
  const gateAt = source.indexOf('if (llmMissing(res)) return;');
  const callAt = source.indexOf('await proposeProfileEdits');
  assert.ok(gateAt >= 0 && callAt > gateAt, 'LLM 配置闸门必须早于调用 LLM');

  if (getLlmConfig().hasApiKey === false) {
    const res = await api('POST', `/api/characters/${seedCharacter()}/intimate/ai-edit`);
    assert.equal(res.status, 503);
    assert.deepEqual(res.payload, { error: 'llm not configured' });
  }
});

// ──────────────── 挂载顺序 ────────────────

test('app.js 把 ai-edit 挂在 charactersRoutes 之前，且不破坏 intimate → characters 紧邻', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /^import intimateAiEditRoutes from '\.\/src\/routes\/intimateAiEdit\.js';$/m, '未 import ai-edit 路由');

  const AI_EDIT = "app.use('/api/characters', wrapRouterAsync(intimateAiEditRoutes));";
  const INTIMATE = "app.use('/api/characters', wrapRouterAsync(intimateRoutes));";
  const CHARACTERS = "app.use('/api/characters', wrapRouterAsync(charactersRoutes));";
  const aiAt = source.indexOf(AI_EDIT);
  const intimateAt = source.indexOf(INTIMATE);
  const charactersAt = source.indexOf(CHARACTERS);
  assert.ok(aiAt >= 0, 'ai-edit 路由未挂载');
  assert.ok(aiAt < intimateAt, 'ai-edit 必须早于 charactersRoutes，且刻意挂在 intimate 之前保持其紧邻');
  assert.ok(intimateAt < charactersAt, 'intimate 必须早于 charactersRoutes');
  const between = source.slice(intimateAt + INTIMATE.length, charactersAt).replace(/\/\/[^\n]*/g, '').trim();
  assert.equal(between, '', 'intimate 与 characters 之间不能夹别的挂载（test/intimateApi.test.js 同样断言）');
});

// ──────────────── 陈旧待确认提议（task-26 P2 回归） ────────────────

test('字段从"未授权"变为"已授权"并成功写入后，该字段的旧 pending 提议必须被清掉', async () => {
  // 回归背景（task-26 的 P2）：savePendingSuggestion 只在"新建 pending"时替换旧行，
  // 已授权分支原先直接 applyField 写入、没有任何清理 → 面板会同时显示"档案里已有该值"与
  // "同字段的陈旧提议"（其 currentValue 还是写入前的旧快照，会误导用户）。
  const id = seedCharacter({ displayName: '陈旧提议' });   // 默认权限只放开 stats
  // 必须有对话素材，否则 proposeProfileEdits 走 empty 分支、根本不调 LLM
  seedDialogue(id, ['今天有点冷', '我左肩以前受过伤，一到冬天就疼']);
  const first = await service.proposeProfileEdits(id, { llmCall: fakeLlm({ note: '左肩有旧伤' }) });
  assert.equal(first.applied.length, 0, '未授权字段不应直接写入');
  assert.equal(first.suggestions.length, 1);
  assert.equal(service.listSuggestions(id).length, 1);

  upsertBodyProfile(id, { aiEditFields: ['stats', 'note'] });   // 用户放开 note 权限

  const second = await service.proposeProfileEdits(id, { llmCall: fakeLlm({ note: '左肩有旧伤' }) });
  assert.equal(second.applied.length, 1, '已授权字段应直接写入');
  assert.equal(second.suggestions.length, 0, '本轮不该再产生同字段提议');
  assert.equal(getBodyProfile(id).note, '左肩有旧伤');
  assert.deepEqual(service.listSuggestions(id), [], '旧 pending 必须被清掉（修复前这里仍会返回 1 条）');
});
