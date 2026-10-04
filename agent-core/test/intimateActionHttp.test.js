/**
 * 性爱交互「可点击推进」· HTTP 全链路回归（task-1）
 *
 * 覆盖 `routes/intimateActions.js` 的两条端点 + 落库 + 即时反应全链路：
 *   · GET  /:id/state          形状 / 未开始默认值 / 动作可用性 / 400 / 404 / 409
 *   · POST /:id/:action        进入 → 继续抽插 → 加速 → 换姿势 → 慢下来 → 停下 → 一起到
 *   · 门控拒绝 = 200 + allowed:false（未插入点「继续抽插」）且**不产生模型调用**
 *   · 即时反应真的落库：raw_messages + messages（is_proactive=1）+ `proactive_message` 广播
 *   · 每轮 prompt 都喂了当前体位 / 节奏 / 累积（用户要求：不许前后矛盾）
 *   · 亲密看板记账（character_intimate_log：插入一笔 + 高潮一笔，幂等）
 *   · 模型失败 → 状态照常推进 + 写 pending_note，下一轮 prompt 里补演
 *   · 「省额度模式」（features.touchInstant=false）→ 不调模型，反应留到下一轮
 *   · 空闲超时自动收场（GET 顺手清扫）
 *   · 进行中状态**持久化**（落表；重启后仍读得到 —— 本文件断言的是读路径与行内容）
 *
 * LLM 用**本地假上游**（照 test/touchRoutes.test.js 的手法：openai v4 走 node-fetch，
 * 打桩 globalThis.fetch 会静默失效）——本文件不产生任何真实 LLM 调用。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';

const stub = { syncBody: null, calls: 0, reply: '', fail: false };
const upstream = http.createServer((req, res) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    if (!String(req.url || '').includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    stub.calls += 1;
    try { stub.syncBody = JSON.parse(text || '{}'); } catch { stub.syncBody = {}; }
    if (stub.fail) {
      // 400 = 不可重试（llm-client 只对 401/429/5xx 重试），失败用例秒失败
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub llm failure', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'stub-completion', object: 'chat.completion', created: 0, model: 'stub-model',
      choices: [{ index: 0, message: { role: 'assistant', content: stub.reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}/v1`;
globalThis.fetch = async url => { throw new Error(`intimate action fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._apiKey = 'stub-key';
config.llm._baseURL = UPSTREAM;
config.llm._model = 'stub-model';
config.llm._thinkingMode = 'disabled';
config.llm._extraBody = {};

const { getDb, closeDb } = await import('../src/db/index.js');
const { saveAffinity } = await import('../src/services/emotionEngine.js');
const routes = (await import('../src/routes/intimateActions.js')).default;
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');
const { SCENE_IDLE_TTL_MS, MAX_ACCUMULATION } = await import('../src/services/intimateActionService.js');
const { toSqlUtc } = await import('../src/services/programTime.js');

const app = express();
app.use(express.json());
// 按挂载建议挂（独立前缀，不受 /api/characters 的 /:id 通配影响）
app.use('/api/intimate-actions', routes);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

// SSE 抓取桩（统一流总线）
const sse = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
addClient(sse);
function takeSse(eventType) {
  const out = [];
  sse.chunks = sse.chunks.filter(chunk => {
    const matched = /^event: (.+)\ndata: (.*)\n\n$/s.exec(chunk);
    if (matched && matched[1] === eventType) { out.push(JSON.parse(matched[2])); return false; }
    return true;
  });
  return out;
}

after(() => {
  removeClient(sse);
  server.close();
  upstream.close();
  closeDb();
});

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
        try { json = JSON.parse(text); } catch { /* 非 JSON 保留原文 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let seq = 0;
function seedCharacter({ affinity = 80 } = {}) {
  seq += 1;
  const info = getDb().prepare(
    `INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, '完整人格', '短人格')`
  ).run(`ia_http_${seq}`, `推进HTTP${seq}`);
  const id = Number(info.lastInsertRowid);
  saveAffinity(id, affinity, false);
  return id;
}

function sceneRow(id) {
  return getDb().prepare('SELECT * FROM character_intimate_scene WHERE character_id = ?').get(id) || null;
}

function logRows(id) {
  return getDb().prepare('SELECT * FROM character_intimate_log WHERE character_id = ? ORDER BY id').all(id);
}

function rawCount(conversationId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(conversationId).n;
}

const OK_REPLY = JSON.stringify({
  reaction_text: '她抓紧了床单，声音被顶得断续：慢、慢一点——腰却自己迎了上去。',
  image_prompt: 'she is on her back, he is inside her thrusting, flushed face, biting her lip',
  emotion_delta: { valence: 0.1, arousal: 0.25, dominance: -0.1 },
  facial_expression: '潮红',
  annoyed: false,
});

// ── 1. GET state ────────────────────────────────────────────────────────────

test('GET /state：未开始时的形状（状态 + 她的状态 + 体位清单 + 逐动作可用性）', async () => {
  const id = seedCharacter();
  const { status, json } = await api('GET', `/api/intimate-actions/${id}/state`);
  assert.equal(status, 200);
  assert.equal(json.characterId, id);
  assert.equal(json.enabled, true);
  assert.equal(json.state.active, false);
  assert.equal(json.state.penetrating, false);
  assert.equal(json.state.positionLabel, '传教士体位', '默认体位要拿得到中文名');
  assert.equal(json.state.paceLabel, '正常');
  assert.equal(json.state.accumulation, 0);
  assert.equal(json.state.accumulationTier, 'calm');
  assert.equal(json.her.affinity, 80);
  assert.equal(json.paceLevels.length, 4);
  assert.ok(json.positionOptions.length >= 10);
  for (const option of json.positionOptions) {
    assert.ok(option.key && option.label && option.label !== option.key);
  }
  const byKey = Object.fromEntries(json.actions.map(a => [a.key, a]));
  assert.equal(byKey.enter.available, true, '默认体位可插入 ⇒「进入她」可点');
  assert.equal(byKey.thrust.available, false, '没插进去时「继续抽插」不可点');
  assert.equal(byKey.thrust.code, 'not_penetrating');
  assert.ok(byKey.thrust.reason.length > 0, '不可点必须给出人话理由');
  assert.equal(byKey.position.available, true, '换姿势随时可点（也用来开场）');
  assert.equal(byKey.stop.available, false, '还没开始不用停');
});

test('GET /state：非法 id 400 / 不存在 404；总开关关闭时读不拦（enabled=false）、写 409', async () => {
  assert.equal((await api('GET', '/api/intimate-actions/abc/state')).status, 400);
  assert.equal((await api('GET', '/api/intimate-actions/0/state')).status, 400);
  assert.equal((await api('GET', '/api/intimate-actions/999999/state')).status, 404);

  config.features.intimateActions = false;
  try {
    const id = seedCharacter();
    // 读不拦（与触摸同口径：前端要能显示"功能已关闭"），写一律 409
    const read = await api('GET', `/api/intimate-actions/${id}/state`);
    assert.equal(read.status, 200);
    assert.equal(read.json.enabled, false);
    assert.equal((await api('POST', `/api/intimate-actions/${id}/enter`, {})).status, 409);
  } finally {
    delete config.features.intimateActions;
  }
});

// ── 2. 点一下 = 立刻一轮反应 + 落库 + 广播 ───────────────────────────────────

test('POST enter：状态推进 + 她的反应立刻落库并广播（proactive_message / source=intimate_action）', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  stub.fail = false;
  t.after(() => { stub.reply = ''; });

  const before = stub.calls;
  const { status, json } = await api('POST', `/api/intimate-actions/${id}/enter`, {});
  assert.equal(status, 200);
  assert.equal(json.allowed, true);
  assert.equal(json.code, 'ok');
  assert.equal(json.mode, 'instant');
  assert.equal(json.fallback, false);
  assert.equal(stub.calls, before + 1, '每次点击恰好一次模型调用');
  assert.equal(json.state.penetrating, true);
  assert.equal(json.state.active, true);
  // 2026-10-02：进入的推进从固定 10 变成「基础 6 × 她自己的敏感度」（≈4~12；敏感度见
  // services/sensitivityService.js）。这里断言区间，别把数值钉死 —— 数值会随玩法调。
  assert.ok(json.state.accumulation >= 4 && json.state.accumulation <= 12,
    `进入的初始推进应当在她自己的敏感度区间内，实际 ${json.state.accumulation}`);
  assert.equal(json.state.rounds, 1);
  assert.match(json.beat, /插了进来/);
  assert.ok(json.reaction.text.includes('床单'), '反应正文来自模型输出');
  assert.equal(json.reaction.facialExpression, '潮红');
  assert.equal(json.reaction.annoyed, false);
  assert.ok(json.reaction.emotionDelta.arousal > 0);

  // 落库：raw_messages + messages 都真的写了（她的一句话进消息流）
  const conversationId = `char_${id}`;
  assert.equal(rawCount(conversationId), 1, 'raw_messages 要有一轮');
  const msgs = getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId);
  assert.ok(msgs.length >= 1);
  assert.equal(msgs.every(m => m.is_proactive === 1), true, '即时反应按主动消息口径落库');
  assert.equal(msgs[0].role, 'assistant');
  assert.ok(json.message.rawId > 0 && json.message.msgId > 0);

  // 广播：前端消息流靠这条立刻上屏
  const broadcasts = takeSse('proactive_message');
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].character_id, id);
  assert.equal(broadcasts[0].source, 'intimate_action');
  assert.equal(broadcasts[0].intimate_action.action, 'enter');
  assert.equal(broadcasts[0].intimate_action.positionKey, 'missionary');
  assert.equal(broadcasts[0].intimate_action.pace, 2);
  assert.ok(broadcasts[0].segments.length >= 1);

  // 状态真的落表（持久化：重启后仍读得到这一行）
  const row = sceneRow(id);
  assert.ok(row, '进行中状态必须落库');
  assert.equal(row.active, 1);
  assert.equal(row.penetrating, 1);
  assert.equal(row.position_key, 'missionary');
  assert.equal(row.act_key, 'vaginal');
  assert.equal(row.pace, 2);
  // 落库的也是「6 × 她的敏感度」⇒ 断言区间（2026-10-02：数值随敏感度走，别把 10 钉死）
  assert.ok(row.accumulation >= 4 && row.accumulation <= 12, `落库的初始推进 ${row.accumulation}`);
  assert.equal(row.rounds, 1);
  assert.equal(row.action_seq, 1);
  assert.ok(row.started_at && row.last_action_at);

  // 亲密看板：插入记一笔（source_uid 幂等锚点）
  const logs = logRows(id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].act_key, 'vaginal');
  assert.equal(logs[0].position_key, 'missionary');
  assert.equal(logs[0].scene, 'chat');
  assert.equal(logs[0].source, 'manual');
  assert.match(logs[0].source_uid, new RegExp(`^intimateAction:${id}:1:vaginal$`));

  // 心情快照锚点必须是 messages.id（不是 raw id）
  const snap = getDb().prepare('SELECT * FROM emotion_snapshots WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(conversationId);
  assert.ok(snap, '心情要落一条快照');
  assert.equal(msgs.some(m => m.id === snap.after_msg_id), true, '锚点必须指向 messages.id');
});

test('每轮 prompt 都喂进「当前体位 / 节奏 / 累积」，并禁止前后矛盾', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  stub.fail = false;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  await api('POST', `/api/intimate-actions/${id}/faster`, {});
  const before = stub.calls;
  const { json } = await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(stub.calls, before + 1);
  assert.ok(json.prompt.blocks.includes('scene'), '喂料清单里必须有场景块');

  const sent = JSON.stringify(stub.syncBody?.messages || []);
  assert.ok(sent.includes('传教士体位'), '喂当前体位（中文名）');
  assert.ok(sent.includes('missionary'), '喂当前体位（与生图同源的 key）');
  assert.ok(sent.includes('快'), '喂当前节奏档');
  assert.match(sent, /累积/, '喂累积度');
  assert.match(sent, /我们开始吧/, '必须明确禁止「我们开始吧」这类前后矛盾');
  assert.match(sent, /已经插进去了/, '插入状态要写清');
  assert.match(sent, /直述/, '直述不擦边');
  assert.ok(sent.includes('reaction_text') && sent.includes('image_prompt'), 'JSON 示例字段齐全');
});

test('POST position：换姿势要带合法体位（非法 400），换完状态与 beat 都对', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});

  const bad = await api('POST', `/api/intimate-actions/${id}/position`, { positionKey: '不存在的体位' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_position');
  const missing = await api('POST', `/api/intimate-actions/${id}/position`, {});
  assert.equal(missing.status, 400);

  const { status, json } = await api('POST', `/api/intimate-actions/${id}/position`, { positionKey: 'doggystyle' });
  assert.equal(status, 200);
  assert.equal(json.allowed, true);
  assert.equal(json.state.positionKey, 'doggystyle');
  assert.equal(json.state.positionLabel, '狗爬式');
  assert.equal(json.state.penetrating, true, '换姿势后仍在里面（beat 写了他退出来又进去）');
  assert.match(json.beat, /退出来/);
  assert.equal(sceneRow(id).position_key, 'doggystyle');

  // 切到非插入体位（口交）→ 之后「继续抽插」应被拒（体位换了，玩法门控跟着变）
  await api('POST', `/api/intimate-actions/${id}/position`, { positionKey: 'kneeling, blowjob' });
  assert.equal(sceneRow(id).act_key, 'oral');
  const thrust = await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(thrust.json.allowed, false);
  assert.equal(thrust.json.code, 'not_penetrating');
});

// ── 3. 门控拒绝：200 + allowed:false 且不烧模型调用 ─────────────────────────

test('未插入点「继续抽插」= 200 + allowed:false，且一次模型都不调', async () => {
  const id = seedCharacter();
  const before = stub.calls;
  const { status, json } = await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(status, 200, '门控拒绝不是 HTTP 错误（与触摸门控同口径）');
  assert.equal(json.allowed, false);
  assert.equal(json.code, 'not_penetrating');
  assert.match(json.message, /进入她/);
  assert.equal(json.reaction, null);
  assert.equal(stub.calls, before, '被拒时绝不许调模型');
  assert.equal(sceneRow(id), null, '被拒时不许落状态');
});

test('未知动作 400 / 非法 id 400 / 角色不存在 404', async () => {
  const id = seedCharacter();
  assert.equal((await api('POST', `/api/intimate-actions/${id}/nope`, {})).status, 400);
  assert.equal((await api('POST', '/api/intimate-actions/abc/enter', {})).status, 400);
  assert.equal((await api('POST', '/api/intimate-actions/999999/enter', {})).status, 404);
});

test('节奏档上限：连点加速到「冲刺」之后再点被拒（pace_max）', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  await api('POST', `/api/intimate-actions/${id}/faster`, {});   // 3 快
  const maxed = await api('POST', `/api/intimate-actions/${id}/faster`, {}); // 4 冲刺
  assert.equal(maxed.json.state.pace, 4);
  assert.equal(maxed.json.state.paceLabel, '冲刺');
  const denied = await api('POST', `/api/intimate-actions/${id}/faster`, {});
  assert.equal(denied.json.allowed, false);
  assert.equal(denied.json.code, 'pace_max');
  assert.match(denied.json.message, /冲刺/);
  // 下限：一路慢下来到「缓」之后再点被拒
  await api('POST', `/api/intimate-actions/${id}/slower`, {});
  await api('POST', `/api/intimate-actions/${id}/slower`, {});
  await api('POST', `/api/intimate-actions/${id}/slower`, {});
  const floored = await api('POST', `/api/intimate-actions/${id}/slower`, {});
  assert.equal(floored.json.allowed, false);
  assert.equal(floored.json.code, 'pace_min');
});

test('停下：退出来但这一场还在（active 不变、节奏回正常）', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  const { json } = await api('POST', `/api/intimate-actions/${id}/stop`, {});
  assert.equal(json.allowed, true);
  assert.equal(json.state.penetrating, false);
  assert.equal(json.state.active, true);
  assert.equal(json.state.paceLabel, '正常');
  assert.match(json.beat, /退了出来/);
});

// ── 4. 一起到 / 自动高潮 / 看板高潮计数 ──────────────────────────────────────

test('「一起到」：没到边缘被拒；到边缘后成功且看板记一笔高潮', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});

  const early = await api('POST', `/api/intimate-actions/${id}/climax`, {});
  assert.equal(early.json.allowed, false);
  assert.equal(early.json.code, 'not_edge');

  // 夹具：把累积推到边缘（等价于连点抽插，省 4 次调用）
  getDb().prepare('UPDATE character_intimate_scene SET accumulation = 70 WHERE character_id = ?').run(id);
  const { json } = await api('POST', `/api/intimate-actions/${id}/climax`, {});
  assert.equal(json.allowed, true);
  assert.equal(json.climaxed, true);
  assert.equal(json.state.accumulation, 0);
  assert.equal(json.state.climaxCount, 1);

  const logs = logRows(id);
  assert.equal(logs.length, 2, '插入一笔 + 高潮一笔');
  const climaxLog = logs[logs.length - 1];
  assert.equal(climaxLog.climax_count, 1);
  assert.equal(climaxLog.act_key, 'vaginal');
  assert.ok(json.reaction.text.length > 0, '高潮这一下也要有反应正文');
});

test('插到顶：累积到 100 自动高潮一次并清零（推进感的落点）', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  getDb().prepare('UPDATE character_intimate_scene SET accumulation = ?, pace = 4 WHERE character_id = ?')
    .run(MAX_ACCUMULATION - 1, id);
  const { json } = await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(json.climaxed, true);
  assert.equal(json.state.accumulation, 0);
  assert.equal(json.state.climaxCount, 1);
  const logs = logRows(id);
  assert.equal(logs[logs.length - 1].climax_count, 1);
});

// ── 5. 失败兜底 / 省额度 / 超时 ─────────────────────────────────────────────

test('模型失败：状态照常推进 + 写 pending_note，下一轮 prompt 里补演', async (t) => {
  const id = seedCharacter();
  t.after(() => { stub.fail = false; });
  stub.fail = true;
  const failed = await api('POST', `/api/intimate-actions/${id}/enter`, {});
  assert.equal(failed.status, 200);
  assert.equal(failed.json.allowed, true, '动作本身是真的发生了，不许回滚');
  assert.equal(failed.json.fallback, true);
  assert.equal(failed.json.reason, 'instant_failed');
  assert.equal(failed.json.reaction, null);
  assert.match(failed.json.notice, /下一轮补演/);
  assert.equal(failed.json.state.penetrating, true, '状态仍然推进');
  const row = sceneRow(id);
  assert.ok(row.pending_note.length > 0, '这一下要写进 pending_note');
  assert.equal(rawCount(`char_${id}`), 0, '失败时不写消息');

  // 下一轮成功调用：prompt 里要带上「上一轮没演出来的动作」
  stub.fail = false;
  stub.reply = OK_REPLY;
  const next = await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(next.json.fallback, false);
  const sent = JSON.stringify(stub.syncBody?.messages || []);
  assert.match(sent, /上一轮的动作没写出来/, '补演行必须进 prompt');
  assert.equal(sceneRow(id).pending_note, '', '演完就清掉');
  stub.reply = '';
});

test('省额度模式（features.touchInstant=false）：不调模型，这一下留给下一轮', async (t) => {
  const id = seedCharacter();
  const before = stub.calls;
  config.features.touchInstant = false;
  t.after(() => { delete config.features.touchInstant; });
  const { status, json } = await api('POST', `/api/intimate-actions/${id}/enter`, {});
  assert.equal(status, 200);
  assert.equal(json.allowed, true);
  assert.equal(json.mode, 'implicit');
  assert.equal(json.reaction, null);
  assert.equal(stub.calls, before, '省额度模式下一次都不调');
  assert.equal(json.state.penetrating, true, '状态照常推进');
  assert.ok(sceneRow(id).pending_note.length > 0);
  assert.equal(rawCount(`char_${id}`), 0);
});

test('空闲超时：最后一次推进超过 TTL，GET 顺手收场（不会隔夜还「插着」）', async () => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  await api('POST', `/api/intimate-actions/${id}/thrust`, {});
  assert.equal(sceneRow(id).active, 1);
  const seqBefore = sceneRow(id).action_seq;
  assert.ok(seqBefore >= 2);

  // 夹具：把 last_action_at 拨到 TTL 之前
  const old = toSqlUtc(new Date(Date.now() - SCENE_IDLE_TTL_MS - 60_000));
  getDb().prepare('UPDATE character_intimate_scene SET last_action_at = ? WHERE character_id = ?').run(old, id);

  const { json } = await api('GET', `/api/intimate-actions/${id}/state`);
  assert.equal(json.state.active, false, '超时应自动收场');
  assert.equal(json.state.penetrating, false);
  assert.equal(json.state.accumulation, 0);
  assert.equal(json.state.rounds, 0, '推进次数按场清零（下一场不会显示昨晚推进了多少下）');
  assert.equal(json.state.climaxCount, 0);
  assert.equal(json.state.startedAt, null);
  const row = sceneRow(id);
  assert.equal(row.active, 0);
  assert.equal(row.action_seq, seqBefore, 'action_seq 必须保留：清零会让新一场第一笔撞 uid 被静默丢掉');
  stub.reply = '';
});

test('进行中状态可跨请求读回：GET 拿到 POST 落下的同一条状态（重启后的读路径）', async (t) => {
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  t.after(() => { stub.reply = ''; });
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  await api('POST', `/api/intimate-actions/${id}/faster`, {});
  const { json } = await api('GET', `/api/intimate-actions/${id}/state`);
  assert.equal(json.state.active, true);
  assert.equal(json.state.penetrating, true);
  assert.equal(json.state.pace, 3);
  assert.equal(json.state.paceLabel, '快');
  assert.ok(json.state.rounds >= 2);
  assert.ok(json.state.accumulation > 10);
  assert.ok(json.state.startedAt, '开始时间要落库（持续时间口径）');
});

// ── 6. 自动插入的节拍：面板那一拍与服务端反应跳共用一个闸门 ──────────────────

test('自动插入：面板那一拍（HTTP 全链路）关掉服务端反应闸门；静默跳不许关', async (t) => {
  // 2026-10-03 复查（额度洞）：面板开着时它自己有一拍 20 秒的"补一下"
  // （IntimateActionPanel 的 AUTO_TICK_MS），服务端 ticker 的反应跳也是 20 秒一次 ——
  // 两条节拍各走各的 ⇒ 她每 ~10 秒就出一轮完整反应（每次一次 LLM 调用）。
  // 修法：路由在她的完整反应真的出来之后调 noteReaction()，两边共用同一个闸门。
  const ticker = await import('../src/services/intimateAutoThrust.js');
  const id = seedCharacter();
  stub.reply = OK_REPLY;
  stub.fail = false;
  t.after(() => { stub.reply = ''; ticker.resetAutoThrustState(); });

  // 铺场：进入 + 开自动插入（各自是一轮完整反应），之后把闸门清干净
  await api('POST', `/api/intimate-actions/${id}/enter`, {});
  const autoOn = await api('POST', `/api/intimate-actions/${id}/auto`, {});
  assert.equal(autoOn.json.state.autoThrust, true, '自动插入已开（后面 auto 轮才走 autoTick 那一档）');
  ticker.resetAutoThrustState();

  const first = stub.calls;
  const panelBeat = await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true });
  assert.equal(panelBeat.json.fallback, false, '面板那一拍走完整链路（她真的说了一句）');
  assert.equal(stub.calls, first + 1, '恰好一次模型调用');
  assert.equal(ticker.reactionDue(id), false,
    '刚出过一轮完整反应 ⇒ 服务端反应跳必须退让（否则 20s+20s 叠成每 ~10 秒一次调用）');

  // 静默档（ticker 的状态跳）只推进状态、不调模型 ⇒ 它不是"完整反应"，不许关闸门
  ticker.resetAutoThrustState();
  const beforeSilent = stub.calls;
  const silent = await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true, silent: true });
  assert.equal(silent.json.mode, 'silent', '静默档：只推状态');
  assert.equal(stub.calls, beforeSilent, '静默档一次模型都不调');
  assert.equal(ticker.reactionDue(id), true, '静默跳不许关闸门（她这一跳根本没说话）');

  // 模型失败那一下也不算"完整反应"（她没说出话来，别把服务端封 20 秒）
  ticker.resetAutoThrustState();
  stub.fail = true;
  const failed = await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true });
  stub.fail = false;
  assert.equal(failed.json.fallback, true);
  assert.equal(ticker.reactionDue(id), true, '模型失败 ⇒ 闸门照旧开着（这一下她没出声）');

  // 场景登记的回声不许续期：ticker 自己发的推进带 internal ⇒ 路由不登记
  ticker.resetAutoThrustState();
  await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true, silent: true, internal: true });
  assert.equal(ticker.sceneFor(id), null, 'ticker 的回声（internal）不许登记场景 —— 否则 TTL 永远不生效');
  await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true, silent: true });
  assert.equal(ticker.sceneFor(id)?.scene, 'chat', '玩家侧的动作照旧登记（这里是私聊口径）');
  const groupId = Number(getDb().prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('闸门群', '测试').lastInsertRowid);
  getDb().prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(groupId, id);
  await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true, silent: true, scene: 'group', groupId });
  assert.equal(ticker.sceneFor(id)?.scene, 'group', '群里的动作立刻覆盖私聊登记（她下一秒的反应写回群里）');
  await api('POST', `/api/intimate-actions/${id}/thrust`, { auto: true, silent: true });
  assert.equal(ticker.sceneFor(id)?.scene, 'chat', '回到私聊再点一下 ⇒ 立刻压回私聊（不许留在旧场景）');
});
