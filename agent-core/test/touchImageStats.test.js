/**
 * 出图联动 + 立绘表情 + 统计聚合（task-19 · 阶段三 · 后端）
 *
 * 三块：
 *   ① 出图档位 always / smart / never（默认 smart）+ 既有出图总开关；
 *   ② 立绘表情联动（服务端独占通道，复用 standingDisplay.publishStandingKeys）；
 *   ③ GET /api/characters/:id/touch/stats 聚合（形状契约见 docs/touch-system.md §3.6）。
 *
 * 生图走**测试接缝** __setTouchImageGeneratorForTest（默认失败桩）：测试永不真连 ComfyUI、也不落盘。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';

// ── 假上游 LLM（照 test/contextUsage.test.js）──
// reply = 即时反应应答；initReply = 「偏好初始化」那一次批量调用的应答（识别：请求体里同时出现
// 全部动作 key 的 JSON 示例 —— 只有初始化 prompt 会列出全集）
const stub = { reply: '', initReply: null, fail: false, requests: [], calls: 0, initDelay: 0 };
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
    stub.requests.push(text);
    // 注意：原始 HTTP 体里的引号是**转义**过的（\"pat_head\"），所以只按 key 名匹配
    const isInitCall = text.includes('pat_head') && text.includes('whisper_ear');
    if (stub.fail) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub llm failure', type: 'invalid_request_error' } }));
      return;
    }
    const content = isInitCall && stub.initReply !== null ? stub.initReply : stub.reply;
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'stub', object: 'chat.completion', created: 0, model: 'stub',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    };
    // 偏好初始化故意慢：用来证明即时反应**不串行等它**（C2 的中间方案）
    if (isInitCall && stub.initDelay > 0) setTimeout(send, stub.initDelay);
    else send();
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const UPSTREAM = 'http://127.0.0.1:' + upstream.address().port + '/v1';
globalThis.fetch = async url => { throw new Error('touch image fixture forbids network: ' + url); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._apiKey = 'stub-key';
config.llm._baseURL = UPSTREAM;
config.llm._model = 'stub-model';
config.llm._thinkingMode = 'disabled';
config.llm._extraBody = {};

const { getDb, closeDb } = await import('../src/db/index.js');
const touchRouteModule = await import('../src/routes/touch.js');
const touchRoutes = touchRouteModule.default;
const configRoutes = (await import('../src/routes/config.js')).default;
const { getStandingDisplay } = await import('../src/services/standingDisplay.js');
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');

const app = express();
app.use(express.json());
app.use('/api/config', configRoutes);
app.use('/api/characters', touchRoutes);
const server = app.listen(0);
await new Promise(resolve => server.once('listening', resolve));
const PORT = server.address().port;

// SSE 抓取桩（group_message / group_message_update 断言）
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
/** 只看不取（waitUntil 轮询用，别把缓冲清了） */
function peekSse(eventType) {
  const out = [];
  for (const chunk of sse.chunks) {
    const matched = /^event: (.+)\ndata: (.*)\n\n$/s.exec(chunk);
    if (matched && matched[1] === eventType) out.push(JSON.parse(matched[2]));
  }
  return out;
}

after(() => {
  removeClient(sse);
  touchRouteModule.__setTouchImageGeneratorForTest(null);
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
function seedCharacter() {
  const db = getDb();
  seq += 1;
  const info = db.prepare(
    "INSERT INTO characters (name, display_name, base_prompt, short_prompt) VALUES (?, ?, '完整人格：她是个安静的图书管理员\n## 你的外观\n银色长发，蓝色眼睛，白衬衫与深色长裙', '短人格')"
  ).run('touchimg_' + seq, '出图' + seq);
  return Number(info.lastInsertRowid);
}
function seedGroup(memberIds) {
  const db = getDb();
  seq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run('出图群' + seq, '话题').lastInsertRowid);
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  return gid;
}

function stubReaction(text = '她缩了缩脖子。') {
  stub.fail = false;
  stub.calls = 0;
  stub.reply = JSON.stringify({
    reaction_text: text,
    emotion_delta: { valence: 0.08, arousal: 0.1, dominance: -0.05 },
    facial_expression: '害羞',
    annoyed: false,
  });
}

// 生图接缝：默认失败桩（不落盘、不写真库），需要断言图片时给成功结果，用完复位
const imageStub = { calls: [], result: null, hold: false, held: [] };
function stubTouchImages(result) { imageStub.result = result; }
/** §8.2 用：把出图扣住，验证「文字先上屏」；释放后图才回来 */
function releaseHeldImages() { const held = imageStub.held.splice(0); for (const fn of held) fn(); }
touchRouteModule.__setTouchImageGeneratorForTest(async (character, prompt, opts) => {
  imageStub.calls.push({ characterId: Number(character.id), prompt, scene: opts && opts.scene });
  if (imageStub.hold) await new Promise(resolve => imageStub.held.push(resolve));
  const result = imageStub.result;
  if (result instanceof Error) throw result;
  if (!result) return { urls: [], promptRefined: prompt, error: 'stub image failure' };
  return { urls: result.urls, promptRefined: (result.promptRefined || prompt + ' REFINED') };
});

function setImageMode(mode) { config.features.touchImageMode = mode; }
function privateMessages(characterId) {
  return getDb().prepare('SELECT id, content, images FROM messages WHERE conversation_id = ? ORDER BY id').all('char_' + characterId);
}
function imageTaskRows(characterId) {
  return getDb().prepare('SELECT * FROM image_tasks WHERE conversation_id = ? AND style = ?').all('char_' + characterId, 'touch-action');
}

// ──────────────── ① 出图档位 ────────────────

test('档位=从不：生成器一次都不调（零行为变化），响应带生效档位', async () => {
  // 本轮第一个用例：先钉住"默认档位 = smart"（config.js 的出厂值，别被后面的用例改花）
  assert.equal(config.features.touchImageMode, 'smart', '默认必须是 smart（用户裁决）');
  const id = seedCharacter();
  setImageMode('never');
  stubReaction();
  imageStub.calls.length = 0;
  const res = await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
  assert.equal(res.status, 200);
  assert.equal(res.json.mode, 'instant');
  assert.equal(res.json.imageMode, 'never');
  assert.deepEqual(res.json.images, []);
  assert.equal(imageStub.calls.length, 0, '从不档 = 生成器一次都不该被调用');
  assert.equal(privateMessages(id).length, 1, '反应消息照样写入');
  assert.equal(privateMessages(id)[0].images, null);
  assert.equal(imageTaskRows(id).length, 0);
});

test('档位=总是：Lv1 也出图，图挂在那条反应消息上并记 image_tasks', async () => {
  const id = seedCharacter();
  setImageMode('always');
  stubReaction('她愣了一下。');
  stubTouchImages({ urls: ['/images/chat/touch-stub.png'] });
  imageStub.calls.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.json.mode, 'instant');
    assert.equal(res.json.imageMode, 'always');
    assert.deepEqual(res.json.images, [], '§8.2 起图在后台补，响应不等图');
    assert.equal(await waitUntil(() => peekSse('proactive_message_update').length >= 1, 3000), true, '图完成后补 proactive_message_update');
    assert.deepEqual(peekSse('proactive_message_update')[0].images, ['/images/chat/touch-stub.png']);
    assert.equal(imageStub.calls.length, 1, '总是档 = 每次动作都出图（含 Lv1）');
    assert.equal(imageStub.calls[0].scene, 'chat');
    assert.ok(imageStub.calls[0].prompt.includes('gently patting her head'), 'prompt 要含该动作的画面提示');
    assert.ok(imageStub.calls[0].prompt.includes('银色长发'), 'prompt 要含角色外观（characterPersona.buildCharacterAppearanceSection 产出）');

    const msgs = privateMessages(id);
    assert.deepEqual(JSON.parse(msgs[msgs.length - 1].images), ['/images/chat/touch-stub.png'], '图挂在那条反应消息上');
    const tasks = imageTaskRows(id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'done');
    assert.deepEqual(JSON.parse(tasks[0].output_paths), ['/images/chat/touch-stub.png']);
  } finally {
    stubTouchImages(null);
    setImageMode('smart');
  }
});

test('档位=智能：Lv1 永不出图；Lv2 掷中才出图（概率判定可注入）', async () => {
  const id = seedCharacter();
  setImageMode('smart');
  stubReaction();
  imageStub.calls.length = 0;
  sse.chunks.length = 0;   // 清掉上一个用例的广播，peekSse 才不会读到脏数据
  const realRandom = Math.random;
  try {
    Math.random = () => 0;
    const lv1 = await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
    assert.equal(imageStub.calls.length, 0, '智能档对 Lv1 永不出图');
    assert.deepEqual(lv1.json.images, []);

    stubTouchImages({ urls: ['/images/chat/lv2.png'] });
    Math.random = () => 0;
    const hit = await api('POST', '/api/characters/' + id + '/touch/stroke_hair', { mode: 'instant' });
    assert.equal(imageStub.calls.length, 1, 'Lv2 掷中 → 出图');
    assert.deepEqual(hit.json.images, [], '§8.2 图在后台补，响应不等图');
    assert.equal(await waitUntil(() => peekSse('proactive_message_update').length >= 1, 3000), true, '图完成后补 update');
    assert.deepEqual(peekSse('proactive_message_update')[0].images, ['/images/chat/lv2.png']);

    stubTouchImages(null);
    Math.random = () => 0.99;
    const miss = await api('POST', '/api/characters/' + id + '/touch/stroke_back', { mode: 'instant' });
    assert.equal(imageStub.calls.length, 1, 'Lv2 没掷中 → 不出图');
    assert.deepEqual(miss.json.images, []);
  } finally {
    Math.random = realRandom;
    stubTouchImages(null);
  }
});

test('出图失败（生成器抛异常）不影响动作：反应照常落库、事件仍 done', async () => {
  const id = seedCharacter();
  setImageMode('always');
  stubReaction('她拍开了你的手。');
  stubTouchImages(new Error('comfyui down'));
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(res.json.allowed, true);
    assert.equal(res.json.status, 'done', '出图失败不能改坏动作状态');
    assert.equal(res.json.reaction.text, '她拍开了你的手。');
    assert.deepEqual(res.json.images, []);
    const row = getDb().prepare('SELECT status, reaction FROM touch_events WHERE id = ?').get(res.json.eventId);
    assert.equal(row.status, 'done');
    assert.equal(row.reaction, '她拍开了你的手。');
    assert.equal(privateMessages(id).length, 1, '反应消息照样写入');
    assert.equal(imageTaskRows(id).length, 0, '失败不记 image_tasks');
  } finally {
    stubTouchImages(null);
    setImageMode('smart');
  }
});

test('既有出图总开关 imageGenMode=off：档位=总是也不出图（尊重既有开关）', async () => {
  const id = seedCharacter();
  setImageMode('always');
  const before = config.features.imageGenMode;
  config.features.imageGenMode = 'off';
  stubReaction();
  imageStub.calls.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
    assert.deepEqual(res.json.images, []);
    assert.equal(imageStub.calls.length, 0, '总开关关着不调生成器');
  } finally {
    config.features.imageGenMode = before;
    setImageMode('smart');
  }
});

test('群聊出图：图挂到群气泡并广播 group_message_update（前端按既有 update 事件换图）', async () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  setImageMode('always');
  stubReaction('她往旁边躲了一下。');
  stubTouchImages({ urls: ['/images/chat/group-touch.png'] });
  takeSse('group_message');
  takeSse('group_message_update');
  imageStub.calls.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/hug', { scene: 'group', groupId: gid, mode: 'instant' });
    assert.equal(res.json.mode, 'instant');
    assert.deepEqual(res.json.images, ['/images/chat/group-touch.png']);
    assert.equal(imageStub.calls.length, 1);
    assert.equal(imageStub.calls[0].scene, 'group');
    assert.ok(imageStub.calls[0].prompt.includes('faintly visible in the background'), '群聊画面提示与私聊区分');

    const msgId = res.json.groupMessage.msgId;
    const row = getDb().prepare('SELECT images FROM messages WHERE id = ?').get(msgId);
    assert.deepEqual(JSON.parse(row.images), ['/images/chat/group-touch.png']);

    const updates = takeSse('group_message_update');
    assert.equal(updates.length, 1, '图生成完要广播一次 update');
    assert.equal(updates[0].id, msgId);
    assert.equal(updates[0].group_id, gid);
    assert.deepEqual(updates[0].images, ['/images/chat/group-touch.png']);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM image_tasks WHERE conversation_id = ? AND style = ?').get('group_' + gid, 'touch-action').n, 1);
  } finally {
    stubTouchImages(null);
    setImageMode('smart');
  }
});

// ──────────────── ② 立绘表情联动 ────────────────

function seedEmoji(characterId, key = '害羞') {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO emoji_categories (emoji_key, sort_order) VALUES (?, 99)').run(key);
  const categoryId = Number(db.prepare('SELECT id FROM emoji_categories WHERE emoji_key = ?').pluck().get(key));
  const setId = Number(db.prepare('INSERT INTO emoji_sets (character_id, name, is_active) VALUES (?, ?, 1)').run(characterId, '测试套').lastInsertRowid);
  db.prepare("INSERT INTO character_emojis (character_id, set_id, emoji_key, status, image_path) VALUES (?, ?, ?, 'done', ?)")
    .run(characterId, setId, key, 'C:/fake/' + key + '.png');
  return categoryId;
}

test('立绘表情联动：facial_expression 命中她的表情包 key → 立绘 slot 切到该表情', async () => {
  const id = seedCharacter();
  const categoryId = seedEmoji(id, '害羞');
  setImageMode('never');
  stubReaction('她缩了缩脖子。');
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.json.standingExpression, '害羞');
    const snapshot = getStandingDisplay().snapshot();
    assert.equal(snapshot.characterId, id, '立绘窗口要切到她');
    assert.equal(snapshot.slotId, 'emoji:' + categoryId, '立绘的表情槽 = 命中的表情');
  } finally {
    setImageMode('smart');
  }
});

test('立绘表情联动：没有表情包 / 匹配不到 → 静默跳过（不报错、不动立绘）', async () => {
  const id = seedCharacter();
  setImageMode('never');
  stubReaction('她哼了一声。');
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(res.json.standingExpression, null);
    // 立绘仍停在别的角色上（这个角色没有表情包可推）
    assert.notEqual(getStandingDisplay().snapshot().characterId, id);
  } finally {
    setImageMode('smart');
  }
});

// ──────────────── ③ 统计聚合 ────────────────

function seedEvent(characterId, { actionKey = 'pat_head', mode = 'implicit', status = 'done', annoyance = 40, likeRatio = 1, reaction = '嗯。', minutesAgo = 0 } = {}) {
  const db = getDb();
  const createdAt = minutesAgo > 0 ? "datetime('now', '-" + Math.round(minutesAgo) + " minutes')" : "datetime('now')";
  const info = db.prepare(
    'INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, reaction, facial_expression, created_at, updated_at)' +
    ' VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ' + createdAt + ", datetime('now'))"
  ).run(characterId, actionKey, mode, annoyance, likeRatio, status, reaction, '害羞');
  return Number(info.lastInsertRowid);
}

test('GET /touch/stats：按动作/等级/时间聚合 + 当前腻烦 + 出图/看板计数', async () => {
  const id = seedCharacter();
  const db = getDb();
  seedEvent(id, { actionKey: 'pat_head', mode: 'implicit', annoyance: 20 });
  seedEvent(id, { actionKey: 'pat_head', mode: 'instant', annoyance: 60 });
  seedEvent(id, { actionKey: 'pat_head', mode: 'instant', annoyance: 80, status: 'injected' });
  seedEvent(id, { actionKey: 'kiss_cheek', mode: 'implicit', annoyance: 30 });
  seedEvent(id, { actionKey: 'touch_breast', mode: 'implicit', annoyance: 50, minutesAgo: 60 * 24 * 30 });
  db.prepare('INSERT INTO character_touch_state (character_id, action_key, annoyance, like_ratio, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'))')
    .run(id, 'pat_head', 65, 0.9);
  db.prepare("INSERT INTO character_intimate_log (character_id, source_uid, act_key, scene, source) VALUES (?, 'touch:1:hand', 'hand', 'chat', 'manual')").run(id);
  db.prepare("INSERT INTO image_tasks (conversation_id, prompt_original, style, status, output_paths) VALUES (?, 'p', 'touch-action', 'done', '[]')").run('char_' + id);

  const res = await api('GET', '/api/characters/' + id + '/touch/stats');
  assert.equal(res.status, 200);
  const stats = res.json;
  assert.equal(stats.characterId, id);
  assert.equal(stats.totals.events, 5);
  assert.equal(stats.totals.injected, 1);
  assert.equal(stats.totals.done, 4);
  assert.deepEqual(stats.totals.byMode, { instant: 2, implicit: 3 });
  assert.equal(stats.totals.peakAnnoyance, 80, '腻烦峰值取全量最大');
  assert.equal(stats.totals.images, 1, 'image_tasks(style=touch-action) 计数');
  assert.equal(stats.totals.intimateActs, 1, 'source_uid 前缀 touch: 的看板流水');
  setImageMode('smart');
  const refreshed = await api('GET', '/api/characters/' + id + '/touch/stats');
  assert.equal(refreshed.json.features.imageMode, 'smart', '响应带生效档位');
  assert.ok(stats.imageModeLabels.always, '档位中文名一并给出');

  const pat = stats.byAction.find(a => a.actionKey === 'pat_head');
  assert.equal(pat.count, 3);
  assert.equal(pat.label, '摸头');
  assert.equal(pat.level, 1);
  assert.equal(pat.peakAnnoyance, 80);
  assert.equal(pat.avgAnnoyance, 53, '(20+60+80)/3 四舍五入');
  assert.equal(pat.currentAnnoyance, 65, '当前腻烦来自 character_touch_state');
  assert.equal(pat.likeRatio, 0.9);
  assert.ok(pat.annoyanceTier, '当前腻烦要带档位文案键');
  assert.ok(pat.lastAt.includes('T'), 'lastAt 是 ISO 串');
  assert.deepEqual(pat.byMode, { instant: 2, implicit: 1 });

  const breast = stats.byAction.find(a => a.actionKey === 'touch_breast');
  assert.equal(breast.level, 3);
  assert.equal(breast.intimateActs, 1, 'Lv3 动作带上它记的看板笔数');
  // 等级桶：pat_head×3 = Lv1、kiss_cheek = Lv2、touch_breast = Lv3
  assert.deepEqual(stats.byLevel.map(l => [l.level, l.count]), [[1, 3], [2, 1], [3, 1]]);
  assert.ok(stats.daily.length >= 1, '按天聚合要有一天（今天）');
  assert.ok(stats.daily.every(d => typeof d.date === 'string' && d.count > 0));
  assert.equal(stats.recent.length, 5);
  assert.equal(stats.recent[0].actionKey, 'touch_breast', 'recent 按 id 倒序（最新在前）');
  assert.equal(stats.recent[0].createdAt.includes('T'), true);
  assert.equal(stats.recent[0].facialExpression, '害羞');
  assert.equal(stats.range.days, 14);
});

test('GET /touch/stats：空数据返回零值/空数组（不是 null），days 可调且夹取', async () => {
  const id = seedCharacter();
  const res = await api('GET', '/api/characters/' + id + '/touch/stats?days=7&recent=3');
  assert.equal(res.status, 200);
  assert.equal(res.json.totals.events, 0);
  assert.deepEqual(res.json.totals.byMode, { instant: 0, implicit: 0 });
  assert.deepEqual(res.json.byAction, []);
  assert.deepEqual(res.json.byLevel, []);
  assert.deepEqual(res.json.daily, []);
  assert.deepEqual(res.json.recent, []);
  assert.equal(res.json.range.days, 7);
  const crazy = await api('GET', '/api/characters/' + id + '/touch/stats?days=9999');
  assert.equal(crazy.json.range.days, 90, 'days 上限 90');
  const missing = await api('GET', '/api/characters/999999/touch/stats');
  assert.equal(missing.status, 404);
});

// ──────────────── ④ 档位设置键（走通用 PUT /api/config/features）────────────────

test('围观概率键：默认 0.3，PUT 可改（0~1 夹取），null/off = 关闭概率模型', async () => {
  const before = await api('GET', '/api/config');
  assert.equal(before.json.features.touchBystanderChance, 0.3, '默认 0.3（30% 概率 1 名成员插话）');

  const put = await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: 0.7 });
  assert.equal(put.json.features.touchBystanderChance, 0.7);
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchBystanderChance'), '0.7');

  const clamped = await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: 5 });
  assert.equal(clamped.json.features.touchBystanderChance, 1, '超过 1 夹到 1');
  const negative = await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: -1 });
  assert.equal(negative.json.features.touchBystanderChance, 0, '负数夹到 0');

  const off = await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: 'off' });
  assert.equal(off.json.features.touchBystanderChance, null, 'null = 关闭概率模型（与 task-17 逐字节一致）');
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchBystanderChance'), '', '关闭状态落空串');

  const bad = await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: 'abc' });
  assert.equal(bad.json.features.touchBystanderChance, 0.3, '非数字回落 0.3（与读取侧同口径）');
  await api('PUT', '/api/config/features', { key: 'touchBystanderChance', value: 0.3 });
});


test('出图档位设置：GET 反映生效值；PUT 往返持久化；非法值回落 smart', async () => {
  setImageMode('smart'); // 「出厂默认 = smart」由本文件第一个用例钉住，这里回到基准值再验读写
  const before = await api('GET', '/api/config');
  assert.equal(before.json.features.touchImageMode, 'smart');

  const put = await api('PUT', '/api/config/features', { key: 'touchImageMode', value: 'always' });
  assert.equal(put.status, 200);
  assert.equal(put.json.features.touchImageMode, 'always');
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchImageMode'), 'always', '落 system_settings（重启不丢）');
  assert.equal((await api('GET', '/api/config')).json.features.touchImageMode, 'always');

  const off = await api('PUT', '/api/config/features', { key: 'touchImageMode', value: 'never' });
  assert.equal(off.json.features.touchImageMode, 'never');

  const bad = await api('PUT', '/api/config/features', { key: 'touchImageMode', value: 'sometimes' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.features.touchImageMode, 'smart', '非法值回落 smart，不写脏值');
  assert.equal(getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchImageMode'), 'smart');
  assert.equal((await api('GET', '/api/characters/1/touch/actions')).json.features.imageMode, 'smart', '动作清单也回生效档位');
});

// ──────────────── P1-2：两个口径核实（task-24）────────────────

test('P1-2 配额日期口径：吃**真实**本地日期（与 intimateAiJudge 同口径），程序时间 +3 天不翻篇', async () => {
  const programTime = await import('../src/services/programTime.js');
  const id = seedCharacter();
  setImageMode('never');
  stubReaction();
  try {
    // 本文件用例共享同一个进程内配额计数，所以用**相对**断言（前面用例已经花掉一些）
    const before = (await api('GET', '/api/characters/' + id + '/touch/state')).json.quota.usedToday;
    const first = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(first.json.mode, 'instant');
    assert.equal(first.json.quota.usedToday, before + 1, '真的调了模型 → 配额 +1');
    const stored = getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('touch_instant_quota');
    const storedDate = JSON.parse(stored).date;
    assert.equal(storedDate, programTime.localDateKey(new Date()), '落库的 date = **真实**本地日期（不是程序时间）');

    // 把程序时间推 +3 天：若配额吃程序钟，这里会立刻翻篇归零（审查担心的就是这个）
    programTime.setProgramOffsetMs(3 * 24 * 60 * 60 * 1000);
    try {
      assert.notEqual(programTime.getProgramDateKey(), storedDate, '夹具：程序日期确实翻篇了');
      const after = await api('GET', '/api/characters/' + id + '/touch/state');
      assert.equal(after.json.quota.usedToday, before + 1, '程序时间 +3 天不许把配额洗回 0');
      assert.equal(
        getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('touch_instant_quota'),
        stored,
        '落库计数键原样不动（没有被程序时间改写）'
      );
    } finally {
      programTime.resetProgramTime();
    }
  } finally {
    setImageMode('smart');
  }
});

test('P1-2 群聊动作的心情锚点回落到 char_ 会话（不锚到群 messages.id 上）', async () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  const db = getDb();
  // 私聊会话里先放一条消息：锚点应当回落到它（传 null 后 resolveLastMessageId('char_<id>') 取的就是它）
  db.prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', '早')").run('char_' + id);
  const privateMsgId = Number(db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').pluck().get('char_' + id));
  setImageMode('never');
  stubReaction('她往旁边躲了一下。');
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/hug', { scene: 'group', groupId: gid, mode: 'instant' });
    assert.equal(res.json.mode, 'instant');
    const groupMsgId = Number(res.json.groupMessage.msgId);
    const snap = db.prepare('SELECT after_msg_id FROM emotion_snapshots WHERE conversation_id = ?').get('char_' + id);
    assert.ok(snap, '群聊动作也要落一条 char_<id> 的心情快照');
    assert.equal(Number(snap.after_msg_id), privateMsgId, '锚点 = 私聊会话最后一条 messages.id');
    assert.notEqual(Number(snap.after_msg_id), groupMsgId, '**不能**锚在那条群气泡上（会话语义错位）');
  } finally {
    setImageMode('smart');
  }
});

// ──────────────── P1-1：like_ratio 初始化 + 微调（task-24）────────────────

const INIT_MARKER = id => 'touch_like_ratio_init_' + id;
function likeRatioOf(characterId, actionKey) {
  const row = getDb().prepare('SELECT like_ratio FROM character_touch_state WHERE character_id = ? AND action_key = ?').get(characterId, actionKey);
  return row ? Number(row.like_ratio) : null;
}
const delayMs = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn, timeout = 3000, step = 20) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await delayMs(step);
  }
  return Boolean(fn());
}
function initCalls() {
  // 只有初始化 prompt 会同时列出这两个 key（反应 prompt 只提当前那一个动作）
  return stub.requests.filter(text => text.includes('pat_head') && text.includes('whisper_ear'));
}
function markInitialized(characterId, ratios = {}) {
  const db = getDb();
  for (const [key, value] of Object.entries(ratios)) {
    db.prepare("INSERT INTO character_touch_state (character_id, action_key, annoyance, like_ratio, updated_at) VALUES (?, ?, 0, ?, datetime('now')) ON CONFLICT(character_id, action_key) DO UPDATE SET like_ratio = excluded.like_ratio").run(characterId, key, value);
  }
  db.prepare('INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)').run(INIT_MARKER(characterId), '1');
}

test('P1-1 首次动作：偏好初始化改**后台**跑（本次用默认 1.0、下次生效），连点只发一次；幂等标记照旧', async () => {
  const id = seedCharacter();
  setImageMode('never');
  stubReaction();
  stub.initReply = JSON.stringify({ pat_head: 0.8, hug: 1.4, whisper_ear: 0.6 });
  stub.initDelay = 400;   // 初始化故意慢：证明即时反应不再串行等它（C2）
  stub.requests.length = 0;
  const markerOf = () => getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get(INIT_MARKER(id));
  try {
    const started = Date.now();
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    const elapsed = Date.now() - started;
    assert.equal(res.json.status, 'done');
    assert.ok(elapsed < 350, '首次动作不得等初始化（实测 ' + elapsed + 'ms；旧实现串行 await = 400ms+）');
    assert.equal(likeRatioOf(id, 'pat_head'), 1, '本次仍用默认 1.0（后台初始化还没生效）');
    assert.equal(markerOf(), undefined, '初始化还没完成，标记不能提前落');

    // 连点：后台初始化还在飞，不许再发一次（同角色在飞合并）
    await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
    assert.equal(initCalls().length <= 1, true, '一次初始化在飞时连点不重复发（实测 ' + initCalls().length + ' 次）');

    // 后台初始化落地（动作之后、异步）
    assert.equal(await waitUntil(() => markerOf() === '1', 4000), true, '后台初始化必须完成并落标记');
    assert.equal(initCalls().length, 1, '整轮只发一次批量初始化调用');
    assert.equal(likeRatioOf(id, 'pat_head'), 0.8, '模型给的值要落库（下次动作生效）');
    assert.equal(likeRatioOf(id, 'hug'), 1.4);
    assert.equal(likeRatioOf(id, 'whisper_ear'), 0.6);
    assert.equal(likeRatioOf(id, 'hold_hand'), 1, '没给的键补 1（不留空行）');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM character_touch_state WHERE character_id = ?').get(id).n, 28, '28 个动作（§十 的 Lv4 + 2026-10-02 击打类 3 条）都要有行');

    // 幂等：初始化完成后，再动作不再调模型
    const callsBefore = initCalls().length;
    await api('POST', '/api/characters/' + id + '/touch/whisper_ear', { mode: 'instant' });
    await delayMs(150);
    assert.equal(initCalls().length, callsBefore, '已初始化不再调（幂等标记仍是唯一依据）');
    assert.equal(likeRatioOf(id, 'hug'), 1.4, '已初始化的值不被覆盖回 1');
  } finally {
    stub.initReply = null;
    stub.initDelay = 0;
    setImageMode('smart');
  }
});

test('P1-1 初始化失败只 warn：动作照常成功、不写脏值、下次动作还会重试', async () => {
  const id = seedCharacter();
  setImageMode('never');
  stubReaction();
  stub.initReply = '这不是 JSON';
  stub.requests.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'done', '初始化失败绝不能影响动作');
    assert.equal(res.json.reaction.text.length > 0, true, '反应照常返回');
    assert.equal(await waitUntil(() => initCalls().length >= 1, 2000), true, '后台初始化确实发起了');
    await delayMs(120);   // 假上游即答：给它跑完（失败也是"跑完"）
    assert.equal(likeRatioOf(id, 'pat_head'), 1, '没解析出来就不改偏好（保持 1，不写脏值）');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM system_settings WHERE setting_key = ?').get(INIT_MARKER(id)).n, 0, '失败不落标记 ⇒ 下次动作会重试');

    // 失败重试语义不变：下一次动作会再发一次初始化（C2 只改"谁在等"，不改幂等/重试）
    const before = initCalls().length;
    await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
    assert.equal(await waitUntil(() => initCalls().length > before, 2000), true, '下次动作仍然重试初始化');
  } finally {
    stub.initReply = null;
    setImageMode('smart');
  }
});

test('P1-1 微调：annoyed ×0.95（下限 0.5）；valence>0.1 ×1.05（上限 2）', async () => {
  const id = seedCharacter();
  setImageMode('never');
  markInitialized(id, { pat_head: 0.8, hug: 0.5, kiss_cheek: 2 });
  stub.requests.length = 0;
  try {
    // ① annoyed → ×0.95（0.8 → 0.76）
    stub.reply = JSON.stringify({ reaction_text: '她拍开了你的手。', emotion_delta: { valence: 0, arousal: 0, dominance: 0 }, facial_expression: '', annoyed: true });
    await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(likeRatioOf(id, 'pat_head'), 0.76, 'annoyed=true → ×0.95');

    // ② valence > 0.1 → ×1.05（0.76 → 0.798）
    stub.reply = JSON.stringify({ reaction_text: '她笑了。', emotion_delta: { valence: 0.5, arousal: 0, dominance: 0 }, facial_expression: '', annoyed: false });
    await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(likeRatioOf(id, 'pat_head'), 0.798, 'valence>0.1 → ×1.05');

    // ③ 下限 0.5：从 0.5 再 annoyed 不许跌破 0.5
    stub.reply = JSON.stringify({ reaction_text: '她躲开了。', emotion_delta: { valence: 0, arousal: 0, dominance: 0 }, facial_expression: '', annoyed: true });
    await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'instant' });
    assert.equal(likeRatioOf(id, 'hug'), 0.5, '下限 0.5（0.5×0.95=0.475 被夹回 0.5）');

    // ④ 上限 2：从 2 再 valence 不许超过 2
    stub.reply = JSON.stringify({ reaction_text: '她很开心。', emotion_delta: { valence: 0.6, arousal: 0, dominance: 0 }, facial_expression: '', annoyed: false });
    await api('POST', '/api/characters/' + id + '/touch/kiss_cheek', { mode: 'instant' });
    assert.equal(likeRatioOf(id, 'kiss_cheek'), 2, '上限 2（2×1.05=2.1 被夹回 2）');
  } finally {
    setImageMode('smart');
  }
});

// ──────────────── §8.2：私聊两段式（文字先上屏，图后台补）────────────────

test('§8.2 私聊两段式：出图还扣着时文字已上屏（proactive_message），图好了补 proactive_message_update', async () => {
  const id = seedCharacter();
  setImageMode('always');
  stubReaction('她愣了一下。');
  stubTouchImages({ urls: ['/images/chat/two-phase.png'] });
  imageStub.calls.length = 0;
  sse.chunks.length = 0;
  imageStub.hold = true;
  try {
    const pending = api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(
      await waitUntil(() => peekSse('proactive_message').length >= 1, 2500),
      true,
      '文字必须先上屏（旧实现是「先出图再广播」，出图被扣住时这条会红）'
    );
    const first = peekSse('proactive_message')[0];
    assert.equal(first.content, '她愣了一下。', '第一段就是文字');
    assert.ok(first.msg_id, '第一段就带 msg_id（update 靠它挂图）');
    assert.deepEqual(first.images || [], [], '第一段广播不带图');
    assert.equal(peekSse('proactive_message_update').length, 0, '图没好之前不许有 update');

    const res = await pending;
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.images, [], '响应也不等图');

    releaseHeldImages();
    assert.equal(await waitUntil(() => peekSse('proactive_message_update').length >= 1, 3000), true, '图完成后必须补一条 update');
    const upd = peekSse('proactive_message_update')[0];
    assert.equal(upd.msg_id, first.msg_id, 'update 的 msg_id 对应第一段那条气泡');
    assert.ok(upd.raw_id, 'update 带 raw_id');
    assert.deepEqual(upd.images, ['/images/chat/two-phase.png']);
    assert.equal(peekSse('group_message_update').length, 0, '私聊不许复用群聊的 update 事件');

    const msgs = privateMessages(id);
    assert.deepEqual(JSON.parse(msgs[msgs.length - 1].images), ['/images/chat/two-phase.png'], 'DB 上也挂上了');
    assert.equal(imageTaskRows(id).length, 1, '出图照旧记账');
  } finally {
    releaseHeldImages();
    imageStub.hold = false;
    stubTouchImages(null);
    setImageMode('smart');
    sse.chunks.length = 0;
  }
});

test('§8.2 出图失败：文字照常上屏、不发 update（无损）', async () => {
  const id = seedCharacter();
  setImageMode('always');
  stubReaction('她缩了缩脖子。');
  stubTouchImages(new Error('comfyui down'));
  sse.chunks.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.images, []);
    assert.equal(peekSse('proactive_message').length, 1, '文字照常上屏');
    await delayMs(400);
    assert.equal(peekSse('proactive_message_update').length, 0, '失败不发 update');
  } finally {
    stubTouchImages(null);
    setImageMode('smart');
    sse.chunks.length = 0;
  }
});

// ──────────────── §一①：图文同源（image_prompt 现写）────────────────

test('§一① 图文同源：出图 prompt 用这一轮 LLM 现写的 image_prompt，不再用预写模板', async () => {
  const { TOUCH_IMAGE_HINTS } = await import('../src/services/touchActionService.js');
  const id = seedCharacter();
  setImageMode('always');
  stub.fail = false;
  stub.calls = 0;
  stub.reply = JSON.stringify({
    reaction_text: '她仰起头喘了口气。',
    image_prompt: 'she is bent over the mirror stand, skirt hiked up, his fingers inside her, flushed',
    emotion_delta: { valence: 0.1, arousal: 0.35, dominance: -0.12 },
    facial_expression: '羞耻',
    annoyed: false,
  });
  stubTouchImages({ urls: ['/images/chat/same-source.png'] });
  imageStub.calls.length = 0;
  sse.chunks.length = 0;
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(imageStub.calls.length, 1, '出图接缝被调一次');
    assert.ok(imageStub.calls[0].prompt.startsWith('she is bent over the mirror stand'),
      '图 prompt 第一句 = 这一轮反应里 LLM 现写的画面（实测：' + imageStub.calls[0].prompt.slice(0, 80) + '）');
    assert.ok(!imageStub.calls[0].prompt.includes(TOUCH_IMAGE_HINTS.pat_head), '写了就不再拼预写模板');
    assert.equal(await waitUntil(() => peekSse('proactive_message_update').length >= 1, 3000), true, '两段式照旧补 update');
  } finally {
    stubTouchImages(null);
    setImageMode('smart');
    sse.chunks.length = 0;
  }
});
