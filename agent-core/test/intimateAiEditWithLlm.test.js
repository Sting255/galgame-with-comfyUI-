/**
 * AI 整理档案「有 LLM」链路回归测试（propose → apply → 提议闭环 → 脏输出 → 502）
 *
 * 与 test/intimateAiEditHttp.test.js 的分工：
 *   - 那份验的是「无 key / 409 / 列表与采纳的字段形状」（没有模型输出的一侧）；
 *   - 本份验的是**模型真的返回了一份档案 JSON 之后**的处理链路：按 aiEditFields 逐字段
 *     分流、未授权字段只落 pending 提议、采纳/忽略是否真写库、脏输出是否逐字段丢弃、
 *     模型不可用时是否 502 中文提示。
 *
 * 手段：真实 express 挂载 + 真发 HTTP + 真实 GET /:id/intimate 回读（面板刷新读的就是它），
 * LLM 用 setLlmCallForTest 注入固定 JSON（含 ```json 围栏形态，走 parseJsonObject 的字符串路径），
 * globalThis.fetch 抛错禁网——**没有任何真实模型参与**。
 *
 * 边界声明：本文件用假 LLM，只验证"模型返回之后的处理链路"，不代表真实模型的返回质量；
 * 真实 LLM 服务的输出质量仍是未覆盖项。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`ai-edit llm fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';

const { getDb, closeDb } = await import('../src/db/index.js');
const intimate = await import('../src/services/intimateService.js');
const aiEdit = await import('../src/services/intimateAiEdit.js');
const aiEditRoutes = (await import('../src/routes/intimateAiEdit.js')).default;
const intimateRoutes = (await import('../src/routes/intimate.js')).default;

const app = express();
app.use(express.json());
app.use('/api/characters', aiEditRoutes);
app.use('/api/characters', intimateRoutes);

const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

after(() => {
  aiEdit.setLlmCallForTest(null);
  server.close();
  closeDb();
});

/** 真实 HTTP 请求（node:http；fetch 被本文件的禁网桩占住） */
function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 时保留原文 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 造数据 ──

let seedSeq = 0;
function seedCharacter({ aiEditFields = null } = {}) {
  const db = getDb();
  const name = `withllm_${++seedSeq}`;
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`).run(name, name);
  const id = db.prepare('SELECT max(id) AS id FROM characters').get().id;
  if (aiEditFields) intimate.upsertBodyProfile(id, { aiEditFields });
  return id;
}

/** 造私聊素材（conversation_id = char_<id>），否则服务会走 empty 分支不调 LLM */
function seedDialogue(characterId, contents = ['我今天量了身高，168cm', '嗯，我记住了']) {
  const db = getDb();
  for (const content of contents) {
    db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', ?)`)
      .run(`char_${characterId}`, content);
  }
}

/**
 * 注入假 LLM。默认按"真实模型可能给出的形态"回 ```json 围栏字符串（走字符串解析路径）；
 * 传 object 时走 parseJsonObject 的对象分支；传函数时可自定义抛错等行为。
 */
function injectLlm(result) {
  const calls = [];
  aiEdit.setLlmCallForTest(async (messages, options) => {
    calls.push({ messages, options });
    if (typeof result === 'function') return result(messages, options);
    return typeof result === 'string' ? result : (result === null || result === undefined ? '' : JSON.stringify(result));
  });
  return calls;
}

const fenced = value => '```json\n' + JSON.stringify(value) + '\n```';

/** 一份"模型返回了完整档案"的典型输出（五个维度全覆盖） */
const FULL_PROFILE = {
  height: '168cm', bust: '88cm', waist: '60cm', hip: '89cm', cup: 'D',
  note: '左肩有旧伤，冬天怕冷',
  sensitiveZones: [{ key: 'neck', label: '脖颈', level: 4 }, { key: 'ear', label: '耳后', level: 3 }],
  firsts: [{ actKey: 'vaginal', firstAt: '2024-06-01' }],
};

/** 让 key 闸门确定性放行（内存 key，不落盘、不联网：LLM 已被注入接管） */
function withKey(t) {
  const saved = config.llm.apiKey;
  config.llm.apiKey = 'fixture-key';
  t.after(() => { config.llm.apiKey = saved; });
}

const fieldsOf = rows => rows.map(row => row.field).sort();
const profileOf = async id => (await api('GET', `/api/characters/${id}/intimate`)).json.profile;
const firstsOf = async id => (await api('GET', `/api/characters/${id}/intimate`)).json.firsts;

// ── 1. 默认权限：模型给了全字段，全部只落 pending 提议 ──

test('模型返回全字段 + 默认 aiEditFields=[stats] → applied=[]、四条 pending，profile 与 firsts 一字未变', async t => {
  withKey(t);
  const id = seedCharacter();
  seedDialogue(id);
  const calls = injectLlm(fenced(FULL_PROFILE));

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.equal(calls.length, 1, '有素材时应恰好调用一次模型');
  assert.equal(res.json.empty, false, '模型返回了内容，empty 必须为 false');
  assert.deepEqual(res.json.applied, [], '默认只放开 stats：一个字段都不许直接写');
  assert.deepEqual(fieldsOf(res.json.suggestions), ['body', 'firsts', 'note', 'sensitiveZones']);

  // 面板刷新路径（GET /:id/intimate 顶层 profile）回读：真的一字未改
  const profile = await profileOf(id);
  for (const key of ['height', 'bust', 'waist', 'hip', 'cup', 'note']) {
    assert.equal(profile[key], '', `默认权限下 ${key} 不该被写`);
  }
  assert.deepEqual(profile.sensitiveZones, []);
  assert.deepEqual(await firstsOf(id), []);
  assert.deepEqual(intimate.getIntimateStats(id, { partnerKinds: 'all' }).totalActs, 0, 'AI 整理不该碰行为流水');

  // 起草阶段传给模型的 prompt 必须是"完整 JSON 示例 + 只输出 JSON"的口径（AGENTS.md）
  const promptText = calls[0].messages.map(m => m.content).join('\n');
  assert.match(promptText, /"sensitiveZones": \[\{ "key": "neck", "label": "脖颈", "level": 4 \}\]/);
  assert.match(promptText, /只输出那一个 JSON 对象/);
  assert.equal(calls[0].options.response_format.type, 'json_object');
});

// ── 2. 部分授权：body / note 立即写入，未授权维度仍只落提议 ──

test("aiEditFields=['stats','body','note'] → body/note 立即落库并回读，zones/firsts 仍 pending", async t => {
  withKey(t);
  const id = seedCharacter({ aiEditFields: ['stats', 'body', 'note'] });
  seedDialogue(id);
  const calls = injectLlm(fenced(FULL_PROFILE));

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.equal(calls.length, 1);
  assert.deepEqual(res.json.applied.map(item => item.field).sort(), ['body', 'note']);
  assert.deepEqual(fieldsOf(res.json.suggestions), ['firsts', 'sensitiveZones']);

  // 已授权字段：GET 回读必须立刻可见（面板 refreshData({withProfile:true}) 读的就是这些）
  const profile = await profileOf(id);
  assert.equal(profile.height, '168cm');
  assert.equal(profile.bust, '88cm');
  assert.equal(profile.waist, '60cm');
  assert.equal(profile.hip, '89cm');
  assert.equal(profile.cup, 'D');
  assert.equal(profile.note, '左肩有旧伤，冬天怕冷');
  // 未授权字段：一个都没写
  assert.deepEqual(profile.sensitiveZones, []);
  assert.deepEqual(await firstsOf(id), []);

  // 提议里的"当前值"应是写入前的旧值快照，便于用户对比
  const zonesSug = res.json.suggestions.find(row => row.field === 'sensitiveZones');
  assert.equal(zonesSug.currentValue, '');
  assert.match(zonesSug.suggestion, /脖颈/);
});

// ── 3. 采纳 / 忽略：未授权字段的最终去向 ──

test('未授权字段：accept 后真写入档案，reject 后档案不变（同一次整理的两条提议）', async t => {
  withKey(t);
  const id = seedCharacter({ aiEditFields: ['stats', 'body', 'note'] });
  seedDialogue(id);
  injectLlm(fenced(FULL_PROFILE));

  const proposed = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  const zonesSid = proposed.json.suggestions.find(row => row.field === 'sensitiveZones').id;
  const firstsSid = proposed.json.suggestions.find(row => row.field === 'firsts').id;

  // 采纳敏感带
  const accepted = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${zonesSid}/accept`, {});
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.suggestion.status, 'accepted');
  assert.deepEqual(accepted.json.applied, {
    field: 'sensitiveZones',
    value: [{ key: 'neck', label: '脖颈', level: 4 }, { key: 'ear', label: '耳后', level: 3 }],
  });
  const profileAfterAccept = await profileOf(id);
  assert.deepEqual(profileAfterAccept.sensitiveZones, [
    { key: 'neck', label: '脖颈', level: 4 }, { key: 'ear', label: '耳后', level: 3 },
  ]);
  // 采纳敏感带不该顺带写初次
  assert.deepEqual(await firstsOf(id), []);

  // 忽略初次
  const rejected = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${firstsSid}/reject`, {});
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.suggestion.status, 'rejected');
  const profileAfterReject = await profileOf(id);
  assert.deepEqual(await firstsOf(id), [], 'reject 后初次仍不能有值');
  assert.deepEqual(profileAfterReject.sensitiveZones, profileAfterAccept.sensitiveZones, 'reject 不该动别的字段');

  // 已处理的提议不再出现在默认（pending）列表
  const pending = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.deepEqual(pending.json.suggestions, []);
  const all = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions?status=accepted`);
  assert.equal(all.json.suggestions.length, 1);
});

// ── 4. 脏输出矩阵（真 HTTP，逐字段丢弃，绝不 500 / 绝不写脏值）──

test('脏输出①：非 JSON 纯文本 → 200、applied/suggestions 全空、档案不动（不是 500）', async t => {
  withKey(t);
  const id = seedCharacter({ aiEditFields: ['stats', 'body', 'note'] });
  seedDialogue(id);
  injectLlm('好的，我已经帮你整理好了这个角色的身体档案。');

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.deepEqual(res.json, { applied: [], suggestions: [], empty: false });
  assert.equal((await profileOf(id)).height, '');
  assert.equal((await profileOf(id)).note, '');
});

test('脏输出②：敏感带 level 越界 → 只丢那一条，同批合法项照常保留', async t => {
  withKey(t);
  const id = seedCharacter();
  seedDialogue(id);
  injectLlm(JSON.stringify({
    sensitiveZones: [
      { key: 'neck', label: '脖颈', level: 9 },   // 越界 → 丢
      { key: 'ear', label: '耳后', level: '3' },  // 字符串数字 → 留（与 task-12 单测同口径）
      { key: 'thigh', label: '大腿', level: 0 },  // 越界 → 丢
    ],
  }));

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.deepEqual(fieldsOf(res.json.suggestions), ['sensitiveZones']);
  assert.deepEqual(res.json.suggestions[0].payload, [{ key: 'ear', label: '耳后', level: 3 }]);
});

test('脏输出③：actKey 不在词表 / 假日期 2026-02-30 → 整条丢，只留合法里程碑', async t => {
  withKey(t);
  const id = seedCharacter();
  seedDialogue(id);
  injectLlm(JSON.stringify({
    firsts: [
      { actKey: 'not_an_act', firstAt: '2024-06-01' }, // 词表外 → 丢
      { actKey: 'oral', firstAt: '2026-02-30' },       // 2026 非闰年，假日期 → 丢
      { actKey: 'vaginal', firstAt: '2024-13-45' },    // 假月份 → 丢
      { actKey: 'hand', firstAt: '2024-05-06' },       // 合法 → 留
    ],
  }));

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.deepEqual(fieldsOf(res.json.suggestions), ['firsts']);
  assert.deepEqual(res.json.suggestions[0].payload, [{ actKey: 'hand', firstAt: '2024-05-06' }]);
});

test('脏输出④：超长字段丢弃 / 数字型 waist 保留为字符串（已授权时真落库）', async t => {
  withKey(t);
  const id = seedCharacter({ aiEditFields: ['stats', 'body'] });
  seedDialogue(id);
  injectLlm(JSON.stringify({
    height: 'x'.repeat(80),      // 超过 60 → 丢
    cup: 1234567890123456,       // 超长 → 丢
    waist: 58,                   // 数字写法 → 按口径保留为 '58'（模型常这么给）
    note: 'a'.repeat(200),       // 超过 120 → 丢
  }));

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.deepEqual(res.json.applied, [{ field: 'body', value: { waist: '58' } }]);
  const profile = await profileOf(id);
  assert.equal(profile.waist, '58');
  assert.equal(profile.height, '', '超长字段绝不能写库');
  assert.equal(profile.cup, '');
  assert.equal(profile.note, '', '超长备注不能写库');
});

// ── 5. 模型不可用：502 中文前缀，不是 500 / 不是裸 SDK 英文 ──

test('模型连接失败 → 502 { error: "AI 整理失败：..." }，不是 500 也不裸抛 SDK 英文', async t => {
  withKey(t);
  const id = seedCharacter();
  seedDialogue(id);
  injectLlm(() => { throw new Error('Connection error.'); });

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 502, `实际 ${res.status} ${res.text}`);
  assert.match(res.json.error, /^AI 整理失败：/);
  assert.match(res.json.error, /Connection error\./);
  assert.equal(Object.keys(res.json).length, 1, '错误响应只应有 error 字段');
});

// ── 6. 闸门复核：总开关关闭时一次模型调用都不发 ──

test('features.intimate=false → 409，且注入的模型实现一次都没被调用', async t => {
  withKey(t);
  const id = seedCharacter();
  seedDialogue(id);
  const calls = injectLlm(fenced(FULL_PROFILE));

  const previous = config.features.intimate;
  config.features.intimate = false;
  t.after(() => { config.features.intimate = previous; });

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'intimate feature disabled');
  assert.equal(calls.length, 0, '总开关关闭时不能先烧一次 token 再拒绝');
  assert.deepEqual(await firstsOf(id), []);
});
