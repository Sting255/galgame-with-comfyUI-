/**
 * SLG 动作系统（触摸互动）· 路由层回归（task-13 第一半）
 *
 * 覆盖 `routes/touch.js` 的三条端点 + 两张表 + 即时反应全链路：
 *   · GET /actions：动作清单 / 逐条门控 / 阈值 / 配额形状，maxLevel 夹取；
 *   · POST /:action：参数校验、门控矩阵（Lv1/Lv2/Lv3 × 好感 × 授权 × 催眠 × 睡眠）、
 *     腻烦叠加落库、醒来类动作的临时唤醒、即时反应真的落库（raw_messages + messages + 广播）、
 *     隐式回落（显式 implicit / 配额耗尽 / 模型失败）三种口径、总开关；
 *   · GET /state：默认值与落库值。
 *
 * LLM 用**本地假上游**（照 test/contextUsage.test.js 的手法起一个 /v1/chat/completions，打桩 openai 构造器
 * 会因 ESM/CJS 入口不同而静默失效）——本文件不产生任何真实 LLM 调用；globalThis.fetch 也被禁网。
 * 真实模型输出质量不在本文件断言范围（专题 §六 L5/L6）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { readFile } from 'node:fs/promises';

process.env.DB_PATH = ':memory:';

// ── 假上游 LLM（照 test/contextUsage.test.js 的做法）：起一个本地 /v1/chat/completions ──
// 为什么不用 globalThis.fetch 桩：openai v4 在 Node 下走 **node-fetch**，完全绕过 globalThis.fetch
// （本文件实测踩到过：桩没生效 → 真的发网络请求 → 每个即时反应用例卡 9 秒后失败）。
const stub = { syncBody: null, calls: 0, reply: '', fail: false, hold: false, held: [], upstreamAborted: 0 };
const upstream = http.createServer((req, res) => {
  let text = '';
  let answered = false;
  // 客户端（本机 server → 假上游）断开时计数：用于断言"上游调用真的被 abort 了"（§1.3）
  res.on('close', () => { if (!answered) stub.upstreamAborted += 1; });
  const respond = () => {
    answered = true;
    if (stub.fail) {
      // 400 = 不可重试（llm-client 只对 401/429/5xx 重试），保证失败用例秒失败
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
  };
  stub.release = () => { const list = stub.held.splice(0); for (const fn of list) fn(); };
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    if (!String(req.url || '').includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    stub.calls += 1;
    try { stub.syncBody = JSON.parse(text || '{}'); } catch { stub.syncBody = {}; }
    if (stub.hold) { stub.held.push(respond); return; }  // 扣住不回：留给用例中途断客户端
    respond();
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const UPSTREAM = `http://127.0.0.1:${upstream.address().port}/v1`;
globalThis.fetch = async url => { throw new Error(`touch fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.llm.freeEgg = false;
config.llm._apiKey = 'stub-key';
config.llm._baseURL = UPSTREAM;
config.llm._model = 'stub-model';
config.llm._thinkingMode = 'disabled';
config.llm._extraBody = {};

const { getDb, closeDb } = await import('../src/db/index.js');
const { localDateKey } = await import('../src/services/programTime.js');
const { saveAffinity, setOath } = await import('../src/services/emotionEngine.js');
const mgr = await import('../src/services/scheduleManager.js');
const { forceSleepNow } = await import('../src/services/scheduleEditor.js');
const hypnosis = await import('../src/services/hypnosisService.js');
const intimate = await import('../src/services/intimateService.js');
const touchService = await import('../src/services/touchActionService.js');
const touchRouteModule = await import('../src/routes/touch.js');
const touchRoutes = touchRouteModule.default;
const { expireStaleTouchEvents } = await import('../src/services/touchEventStore.js');
const { collectTouchActionBlocks } = await import('../src/services/groupChatEngine.js');
// 只挂统一总线：group_message 与 proactive_message 都会经它转发（notificationBus 是转发的上游），
// 两边都挂的话同一个事件会被同一个假客户端收到两遍。
const { addClient, removeClient } = await import('../src/services/unifiedStreamBus.js');
const configRoutes = (await import('../src/routes/config.js')).default;

const app = express();
app.use(express.json());
app.use('/api/characters', touchRoutes);
app.use('/api/config', configRoutes);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

// SSE 抓取桩：挂一个假客户端，用来断言"到底广播了哪种事件、几次"
const sse = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };
addClient(sse);
/**
 * 取走并解析指定事件类型的所有广播（**只移除这一类**，其余事件留在缓冲区里，
 * 否则同一个用例里连续两次 takeSse 会互相把对方的事件清掉）。
 */
function takeSse(eventType) {
  const out = [];
  sse.chunks = sse.chunks.filter(chunk => {
    const matched = /^event: (.+)\ndata: (.*)\n\n$/s.exec(chunk);
    if (matched && matched[1] === eventType) {
      out.push(JSON.parse(matched[2]));
      return false;
    }
    return true;
  });
  return out;
}

function resetSse() { sse.chunks.length = 0; }

after(() => {
  removeClient(sse);
  server.close();
  upstream.close();
  closeDb();
});

/** 真实 HTTP（globalThis.fetch 被禁网桩占住，用 node:http） */
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

const DAY_ONLY = [
  { startTime: '00:00', endTime: '23:59', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
];

let seedSeq = 0;
function seedCharacter({ affinity = 0, oath = 0, scheduled = false } = {}) {
  const db = getDb();
  const n = ++seedSeq;
  const info = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt, short_prompt, schedule_enabled)
     VALUES (?, ?, '完整人格', '短人格', ?)`
  ).run(`touch_${n}`, `触摸${n}`, scheduled ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  // 显式落好感：不写的话 loadAffinity 会拿到种子里的默认 100（Lv2/Lv3 全放行，门控矩阵测不出来）
  saveAffinity(id, affinity, false);
  // P1-1 的偏好初始化（task-24）会让"首次动作"多一次模型调用。本文件的用例都在测**反应**路径，
  // 夹具里直接标成"已初始化"，让 `stub.calls` 仍然只数反应那一次；
  // 初始化自身的用例（含"省额度模式不初始化"）在 test/touchImageStats.test.js。
  setSetting('touch_like_ratio_init_' + id, '1');
  if (oath) setOath(id, 1);
  if (scheduled) {
    db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
      .run(id, JSON.stringify(DAY_ONLY));
    mgr.ensureTodaySchedule(id);
  }
  return id;
}

function seedGroup(memberIds) {
  const db = getDb();
  seedSeq += 1;
  const gid = Number(db.prepare('INSERT INTO group_chats (name, topic) VALUES (?, ?)').run(`测试群${seedSeq}`, '话题').lastInsertRowid);
  for (const id of memberIds) db.prepare('INSERT INTO group_members (group_id, character_id) VALUES (?, ?)').run(gid, id);
  return gid;
}

function makeSleeping(id) {
  const result = forceSleepNow(id);
  assert.equal(result.ok, true, '夹具：立刻入睡必须成功');
  mgr.syncSleepingState(id);
  assert.equal(mgr.isSleeping(id).sleeping, true, '夹具：必须真的处于睡着');
}

function eventRows(characterId) {
  return getDb().prepare('SELECT * FROM touch_events WHERE character_id = ? ORDER BY id').all(characterId);
}

function messageRows(characterId) {
  return getDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(`char_${characterId}`);
}

function rawRows(characterId) {
  return getDb().prepare('SELECT * FROM raw_messages WHERE conversation_id = ? ORDER BY id').all(`char_${characterId}`);
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
    .run(key, String(value));
}

/** 每次要用"即时反应成功"的场景：把桩设成一份合法 JSON */
function stubReaction(text = '她缩了缩脖子，耳朵有点红。') {
  stub.fail = false;
  stub.calls = 0;
  stub.syncBody = null;
  stub.hold = false;
  stub.held = [];
  stub.upstreamAborted = 0;
  stub.reply = JSON.stringify({
    reaction_text: text,
    emotion_delta: { valence: 0.08, arousal: 0.1, dominance: -0.05 },
    facial_expression: '害羞',
    annoyed: false,
  });
}

// ──────────────── GET /actions ────────────────

test('GET /touch/actions：28 条动作（含 §十 Lv4 十条 + 击打类 3 条）+ 逐条门控 + 阈值/配额形状', async () => {
  const id = seedCharacter();
  const res = await api('GET', `/api/characters/${id}/touch/actions`);
  assert.equal(res.status, 200);
  assert.equal(res.json.characterId, id);
  assert.equal(res.json.actions.length, 28, '专题 §1.1 的 16 条 + §十 的 Lv4 + 2026-10-02 的击打类 3 条');
  for (const action of res.json.actions) {
    assert.ok(action.key && action.label, '每条都要 key/label');
    assert.ok([1, 2, 3, 4].includes(action.level));
    assert.match(action.levelLabel, /^Lv[1-4] /);
    assert.equal(typeof action.wakes, 'boolean');
  }
  // 2026-10-04 用户裁决「Lv4 私密整档直接开放」⇒ 阈值 80 → 0。
  // ⚠️ 下面**同时**钉住 Lv2/Lv3 没被动，以及 Lv4 在零好感下真的放行 —— 不是只把 80 改成 0 就完事。
  assert.deepEqual(res.json.thresholds, { lv2Affinity: 40, lv3Affinity: 60, lv4Affinity: 0 });
  // 逐条门控：好感 0 时 Lv1 放行、Lv2/Lv3 被人话拦住
  assert.equal(res.json.gate.pat_head.allowed, true);
  assert.equal(res.json.gate.pat_head.code, 'ok');
  assert.equal(res.json.gate.stroke_hair.allowed, false);
  assert.equal(res.json.gate.stroke_hair.code, 'affinity_low');
  assert.ok(res.json.gate.stroke_hair.message.length > 0, '拒绝必须带人话文案');
  assert.equal(res.json.gate.touch_breast.code, 'affinity_low');
  // Lv4：零好感 + 列表里也未授权 ⇒ **仍然放行**（新口径）
  assert.equal(res.json.gate.touch_pussy.allowed, true, 'Lv4 不再吃好感门槛（零好感也放行）');
  assert.equal(res.json.gate.touch_pussy.code, 'ok');
  assert.equal(res.json.gate.inner_thigh.allowed, true, 'Lv4 抚摸大腿内侧同理');
  // 反向守卫：Lv3 在同样输入下**必须仍被拦**，证明放开的是 Lv4 而不是整条链
  assert.equal(res.json.gate.touch_breast.allowed, false, 'Lv3 不许被顺带放开');
  // 2026-10-04：群聊成人开关默认开 ⇒ features.groupAdult / allowGroupAdult 都是 true
  assert.deepEqual(res.json.features, { touch: true, instant: true, groupAdult: true, imageMode: 'smart' }, '出图档位默认 smart（task-19）');
  assert.equal(res.json.allowGroupAdult, true, '群聊成人开关默认开（2026-10-04 用户裁决），前端读它')
  assert.equal(res.json.quota.dailyLimit, 100);
  assert.equal(res.json.quota.usedToday, 0);
  assert.equal(res.json.quota.unlimited, false);
});

test('GET /touch/actions?maxLevel=2：只回 Lv1+Lv2（11 条）', async () => {
  const id = seedCharacter();
  const res = await api('GET', `/api/characters/${id}/touch/actions?maxLevel=2`);
  assert.equal(res.status, 200);
  assert.equal(res.json.actions.length, 11);
  assert.ok(res.json.actions.every(action => action.level <= 2));
});

test('GET /touch/actions|state：非法 id 400、角色不存在 404；state 给默认值', async () => {
  assert.equal((await api('GET', '/api/characters/abc/touch/actions')).status, 400);
  assert.equal((await api('GET', '/api/characters/999999/touch/actions')).status, 404);

  const id = seedCharacter();
  const res = await api('GET', `/api/characters/${id}/touch/state`);
  assert.equal(res.status, 200);
  assert.equal(res.json.states.pat_head.annoyance, 0);
  assert.equal(res.json.states.pat_head.tier, 'fine');
  assert.equal(res.json.states.pat_head.likeRatio, 1);
  assert.equal(res.json.states.pat_head.updatedAt, null);
});

// ──────────────── POST：即时反应全链路 ────────────────

test('POST pat_head（即时模式）：反应落 raw_messages + messages、事件 done、心情锚点是 messages.id', async () => {
  const id = seedCharacter();
  stubReaction('她缩了缩脖子，耳朵有点红：……又、又摸头……');
  const res = await api('POST', `/api/characters/${id}/touch/pat_head`, {});
  assert.equal(res.status, 200);
  assert.equal(res.json.allowed, true);
  assert.equal(res.json.code, 'ok');
  assert.equal(res.json.mode, 'instant');
  assert.equal(res.json.status, 'done');
  assert.equal(res.json.action.key, 'pat_head');
  assert.equal(res.json.action.level, 1);
  assert.equal(res.json.reaction.text, '她缩了缩脖子，耳朵有点红：……又、又摸头……');
  assert.equal(res.json.reaction.facialExpression, '害羞');
  assert.equal(res.json.reaction.annoyed, false);
  assert.equal(stub.calls, 1, '即时反应只调一次模型');

  // 反应真的落库（Lead 裁决：刷新页面仍在、下一轮上下文能看到）
  const raws = rawRows(id);
  assert.equal(raws.length, 1);
  assert.equal(raws[0].role, 'assistant');
  assert.match(raws[0].content, /又摸头/);
  const msgs = messageRows(id);
  assert.ok(msgs.length >= 1, '反应必须落 messages（分句）');
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].is_proactive, 1);
  assert.equal(res.json.message.rawId, raws[0].id);
  assert.equal(res.json.message.msgId, msgs[0].id);

  // 事件：done + 反应文本 + 表情 + delta
  const events = eventRows(id);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'done');
  assert.equal(events[0].action_key, 'pat_head');
  assert.equal(events[0].mode, 'instant');
  assert.match(events[0].reaction, /又摸头/);
  assert.equal(events[0].facial_expression, '害羞');
  assert.ok(events[0].emotion_delta);

  // 心情快照锚点 = 刚落库的 messages.id（不是 raw id）
  const snapshot = getDb().prepare(
    'SELECT after_msg_id, reason FROM emotion_snapshots WHERE conversation_id = ? ORDER BY id DESC LIMIT 1'
  ).get(`char_${id}`);
  assert.ok(snapshot, '必须落一条心情快照');
  assert.equal(snapshot.after_msg_id, msgs[msgs.length - 1].id);
  assert.match(snapshot.reason, /触摸互动：摸头/);
  assert.equal(res.json.emotion.applied, true);

  // 腻烦落库
  const stateRow = getDb().prepare(
    'SELECT annoyance, like_ratio FROM character_touch_state WHERE character_id = ? AND action_key = ?'
  ).get(id, 'pat_head');
  assert.ok(stateRow, '动作后必须有腻烦行');
  // 腻烦曲线（专题 §2.4）：第 1 次 = 0（还没有"连点"），第 2 次起才叠加
  assert.equal(stateRow.annoyance, 0);
  assert.equal(stateRow.like_ratio, 1);
  assert.equal(res.json.annoyance.value, 0);
  assert.equal(res.json.annoyance.repeated, false);
});

test('POST pat_head 连点：腻烦叠加、档位随之上抬（10 分钟内连点）', async () => {
  const id = seedCharacter();
  stubReaction();
  // 专题 §2.4 的曲线：0 → 20 → 40 → 60(warm)；第 1 次没有"连点"所以还是 0
  const first = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  const second = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  const third = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  const fourth = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  assert.equal(first.json.annoyance.value, 0);
  assert.equal(second.json.annoyance.value, 20);
  assert.equal(third.json.annoyance.value, 40);
  assert.equal(fourth.json.annoyance.value, 60);
  assert.equal(fourth.json.annoyance.tier, 'warm', '>50 必须变冷');
  assert.equal(fourth.json.annoyance.repeated, true);
  assert.ok(fourth.json.annoyance.gain > 0);
});

// ──────────────── POST：门控矩阵 ────────────────

test('POST Lv3：好感不足 → 200 {allowed:false, affinity_low}，且零落库', async () => {
  const id = seedCharacter({ affinity: 0 });
  const res = await api('POST', `/api/characters/${id}/touch/touch_breast`, {});
  assert.equal(res.status, 200, '门控拒绝是叙事结果，走 200（Lead 裁决）');
  assert.equal(res.json.allowed, false);
  assert.equal(res.json.code, 'affinity_low');
  assert.match(res.json.message, /还没到那一步|摇了摇头/);
  assert.equal(res.json.reaction, null);
  assert.equal(res.json.eventId, null);
  assert.equal(eventRows(id).length, 0, '被拒的动作不得落事件');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM character_touch_state WHERE character_id = ?').get(id).n, 0);
});

test('POST Lv3：好感够 + 默认授权 → 放行；撤掉 AI 授权 → intimate_not_authorized', async () => {
  const id = seedCharacter({ affinity: 60 });
  const allowed = await api('POST', `/api/characters/${id}/touch/touch_breast`, { mode: 'implicit' });
  assert.equal(allowed.json.allowed, true);
  assert.equal(allowed.json.code, 'ok');

  intimate.upsertBodyProfile(id, { aiEditFields: [] });
  const blocked = await api('POST', `/api/characters/${id}/touch/touch_breast`, {});
  assert.equal(blocked.json.allowed, false);
  assert.equal(blocked.json.code, 'intimate_not_authorized');
  assert.match(blocked.json.message, /亲密/);
});

test('POST Lv2：好感 39 拦、40 放；誓约可替代好感', async () => {
  const low = seedCharacter({ affinity: 39 });
  assert.equal((await api('POST', `/api/characters/${low}/touch/stroke_hair`, {})).json.code, 'affinity_low');
  const enough = seedCharacter({ affinity: 40 });
  assert.equal((await api('POST', `/api/characters/${enough}/touch/stroke_hair`, { mode: 'implicit' })).json.allowed, true);
  const oathed = seedCharacter({ affinity: 0, oath: 1 });
  assert.equal((await api('POST', `/api/characters/${oathed}/touch/stroke_hair`, { mode: 'implicit' })).json.allowed, true);
});

test('POST：催眠中豁免门控（Lv3 + 好感 0 也放行，exempt=hypnosis）', async () => {
  const id = seedCharacter({ affinity: 0 });
  hypnosis.grantHypnosisPhone();
  hypnosis.hypnotize(id, { minutes: 30 });
  const res = await api('POST', `/api/characters/${id}/touch/touch_breast`, { mode: 'implicit' });
  assert.equal(res.json.allowed, true);
  assert.equal(res.json.code, 'ok');
  const actions = await api('GET', `/api/characters/${id}/touch/actions`);
  assert.equal(actions.json.gate.touch_breast.exempt, 'hypnosis');
});

test('POST：睡着时重动作（挠痒痒）放行并临时唤醒；睡着时 Lv3 拦截', async () => {
  const id = seedCharacter({ scheduled: true });
  makeSleeping(id);
  stubReaction();

  const tickle = await api('POST', `/api/characters/${id}/touch/tickle`, {});
  assert.equal(tickle.json.allowed, true, 'Lv1 睡着也能做');
  assert.equal(tickle.json.wakesSleeping, true);
  assert.equal(tickle.json.preWake.woken, true, '重动作必须临时唤醒她');
  assert.equal(tickle.json.preWake.minutes, 5);
  const charRow = getDb().prepare('SELECT temporary_wake_until, wake_mode FROM characters WHERE id = ?').get(id);
  assert.ok(charRow.temporary_wake_until, '必须写入临时唤醒窗口');
  assert.equal(charRow.wake_mode, 'phone');

  makeSleeping(id);
  const lv3 = await api('POST', `/api/characters/${id}/touch/touch_breast`, {});
  assert.equal(lv3.json.allowed, false);
  assert.equal(lv3.json.code, 'sleeping_blocked');
  assert.match(lv3.json.message, /睡得很沉/);
});

test('POST：非法动作 400、群聊缺 groupId 400、角色不存在 404', async () => {
  const id = seedCharacter();
  const badAction = await api('POST', `/api/characters/${id}/touch/not_an_action`, {});
  assert.equal(badAction.status, 400);
  assert.equal(badAction.json.code, 'invalid_action');

  const badScene = await api('POST', `/api/characters/${id}/touch/pat_head`, { scene: 'group' });
  assert.equal(badScene.status, 400);
  assert.equal(badScene.json.code, 'invalid_scene');

  const missing = await api('POST', '/api/characters/999999/touch/pat_head', {});
  assert.equal(missing.status, 404);
  assert.equal((await api('POST', '/api/characters/abc/touch/pat_head', {})).status, 400);
});

// ──────────────── POST：隐式回落三种口径 ────────────────

test('显式 implicit：不调模型，事件留 pending 等下一轮注入', async () => {
  const id = seedCharacter();
  stubReaction();
  const res = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  assert.equal(res.json.allowed, true);
  assert.equal(res.json.mode, 'implicit');
  assert.equal(res.json.status, 'pending');
  assert.equal(res.json.reaction, null);
  assert.equal(stub.calls, 0, '隐式模式一次模型都不调');
  assert.equal(rawRows(id).length, 0, '隐式模式不写消息，反应由下一轮聊天写出');
  const events = eventRows(id);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'pending');
  assert.equal(events[0].mode, 'implicit');
  // 心情：动作定义里的静态 delta 立刻生效（专题 §1.2）
  assert.equal(res.json.emotion.applied, true);

  await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  assert.equal(eventRows(id).length, 2, '每次动作各留一条 pending');
});

test('配额耗尽：auto/instant 都回落隐式 + notice，事件仍留 pending', async () => {
  const id = seedCharacter();
  stubReaction();
  setSetting('touch_instant_daily_limit', 1);
  setSetting('touch_instant_quota', JSON.stringify({ date: localDateKey(), used: 1 }));

  const res = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'instant' });
  assert.equal(res.json.mode, 'implicit');
  assert.equal(res.json.fallback, true);
  assert.equal(res.json.reason, 'quota_exhausted');
  assert.equal(res.json.notice, touchService.INSTANT_QUOTA_NOTICE);
  assert.equal(res.json.quota.exhausted, true);
  assert.equal(res.json.quota.remaining, 0);
  assert.equal(stub.calls, 0, '额度耗尽不得再调模型');
  assert.equal(eventRows(id)[0].status, 'pending');

  setSetting('touch_instant_daily_limit', 0);
  const unlimited = await api('GET', `/api/characters/${id}/touch/actions`);
  assert.equal(unlimited.json.quota.unlimited, true);
  assert.equal(unlimited.json.quota.remaining, null);
});

test('模型失败 / 坏 JSON：不回滚动作，事件留 pending 走隐式，且只 warn', async () => {
  const id = seedCharacter();
  stub.fail = true;
  stub.calls = 0;
  const failed = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'instant' });
  assert.equal(failed.json.mode, 'implicit');
  assert.equal(failed.json.fallback, true);
  assert.equal(failed.json.reason, 'instant_failed');
  assert.equal(failed.json.reaction, null);
  assert.equal(rawRows(id).length, 0);
  assert.equal(eventRows(id)[0].status, 'pending');
  assert.equal(eventRows(id)[0].error, 'llm_failed');
  assert.equal(failed.json.emotion.applied, true, '模型挂了也要落动作的静态心情 delta');

  stub.fail = false;
  stub.reply = '这不是 JSON';
  const bad = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'instant' });
  assert.equal(bad.json.mode, 'implicit');
  assert.equal(bad.json.reason, 'instant_failed');
  assert.match(eventRows(id)[1].error, /JSON/);
});

// ──────────────── chat.js 挂点（第二半）───────────────

test('chat.js 挂点：动作块紧挨亲密档案之后、在催眠块容器之前，注入后置 injected', async () => {
  const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  const at = (needle, label) => {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, `chat.js 缺挂点：${label}`);
    return index;
  };
  // task-24 P2-2 搬家后，同一行只剩 buildTouchActionBlock；消费函数改从服务层 import
  assert.match(source, /^import \{ buildTouchActionBlock \} from '\.\.\/services\/touchActionService\.js';$/m, '未 import buildTouchActionBlock');

  const intimateAt = at('if (intimateBlock) dynamicBlocks.push(intimateBlock);', '亲密档案注入');
  const readAt = at('const pendingTouch = takePendingTouchEvent(characterId);', '读待反应动作');
  const pushAt = at('dynamicBlocks.push(touchBlock);', '动作块注入');
  const containerAt = at('const hypnosisBlocks = [];', '催眠块容器');
  assert.ok(intimateAt < readAt && readAt < pushAt, '动作块必须紧挨亲密档案之后');
  assert.ok(pushAt < containerAt, '动作块不得塞进 task-42 后置的催眠块（位置必须在它之前）');
  assert.ok(source.includes('if (config.features.touch !== false) {'), '动作块必须在 features.touch 守卫内');
  assert.ok(source.includes('[touch] action block inject failed'), '动作块必须被 try/catch 包住（失败不影响聊天主流程）');
  assert.ok(source.includes('markTouchEventInjected(pendingTouch.id);'), '注入后必须置 injected（一次动作只注入一次）');
  assert.equal((source.match(/dynamicBlocks\.push\(touchBlock\);/g) || []).length, 1, '动作块只允许一个注入点');
  // 待反应事件的查询口径（pending/done + instant/implicit + 只认私聊）已搬到服务层 touchEventStore：
  // 这里断言"chat.js 不再自带一份"，口径本身在 touchEventStore.test.js 里做行为断言。
  const storeSource = await readFile(new URL('../src/services/touchEventStore.js', import.meta.url), 'utf8');
  assert.match(storeSource, /status IN \('pending', 'done'\)/, 'touchEventStore 的待反应查询口径不对');
  assert.match(storeSource, /mode: row\.mode === 'instant' \? 'instant' : 'implicit'/, '读事件时必须带上 instant/implicit 口径');
  assert.match(storeSource, /group_id IS NULL/, '私聊链只认私聊事件');
  assert.ok(!source.includes('status IN (\'pending\', \'done\')'), 'chat.js 不应再自带一份查询（会与 store 漂移）');
  // 不重复消费催眠指令（我的挂点不得加第二个 consumePendingDirective）
  assert.equal((source.match(/^\s*const directive = consumePendingDirective\(characterId\);/gm) || []).length, 1, '催眠指令仍只消费一次');
});

test('一次动作只注入一次：pending/done 被置 injected 之后不再被取走（chat.js 依赖的契约）', async () => {
  const id = seedCharacter();
  const pick = () => getDb().prepare(
    `SELECT id, mode FROM touch_events
      WHERE character_id = ? AND status IN ('pending', 'done') AND group_id IS NULL
      ORDER BY id DESC LIMIT 1`
  ).get(id);

  // 隐式：留 pending，等下一轮取
  await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' });
  const first = pick();
  assert.ok(first, '隐式事件必须能被下一轮取到');
  assert.equal(first.mode, 'implicit');
  getDb().prepare(`UPDATE touch_events SET status = 'injected' WHERE id = ?`).run(first.id);
  assert.equal(pick(), undefined, '置 injected 之后不得再被取走');

  // 即时：反应已单独发过（status='done'），下一轮仍要能取到 —— 但口径是 instant（"别再演一遍"）
  stubReaction();
  const instant = await api('POST', `/api/characters/${id}/touch/pat_head`, {});
  assert.equal(instant.json.mode, 'instant');
  assert.equal(instant.json.status, 'done');
  const second = pick();
  assert.ok(second, '即时事件（done）也必须能被下一轮取到');
  assert.equal(second.mode, 'instant');
  getDb().prepare(`UPDATE touch_events SET status = 'injected' WHERE id = ?`).run(second.id);
  assert.equal(pick(), undefined);
});

// ──────────────── Lv3 → 亲密看板记账（task-16）────────────────

function intimateRows(characterId) {
  return getDb().prepare(
    'SELECT act_key, scene, partner_kind, source, source_uid, act_count, climax_count FROM character_intimate_log WHERE character_id = ? ORDER BY id'
  ).all(characterId);
}

test('Lv3 记账：命中映射 → 记一笔 hand（scene=chat / source=manual / 锚点 touch:<eventId>:hand）', async () => {
  const id = seedCharacter({ affinity: 60 });
  const res = await api('POST', `/api/characters/${id}/touch/touch_breast`, { mode: 'implicit' });
  assert.equal(res.json.allowed, true);
  assert.deepEqual(res.json.intimate, {
    actKey: 'hand',
    sourceUid: `touch:${res.json.eventId}:hand`,
    inserted: 1,
    skipped: 0,
    blocked: false,
  });
  const rows = intimateRows(id);
  assert.equal(rows.length, 1, '一次动作只落一笔');
  assert.equal(rows[0].act_key, 'hand');
  assert.equal(rows[0].scene, 'chat', '复用既有 SCENES，不新增枚举值');
  assert.equal(rows[0].partner_kind, 'user');
  assert.equal(rows[0].source, 'manual', '用户手点的动作走 manual，绕过 aiEditFields 闸门（授权已在门控判过）');
  assert.equal(rows[0].act_count, 1);
  assert.equal(rows[0].climax_count, 0, '触摸不是高潮，不许动面板的「高潮次数」');
  assert.equal(rows[0].source_uid, `touch:${res.json.eventId}:hand`);
});

test('Lv3 记账幂等：同一次动作重放不双记；两次点击 = 两笔', async () => {
  const id = seedCharacter({ affinity: 60 });
  const first = await api('POST', `/api/characters/${id}/touch/touch_thigh`, { mode: 'implicit' });
  assert.equal(first.json.intimate.inserted, 1);

  // 重放同一次动作（锚点相同）→ 幂等跳过，不落第二行
  const replay = intimate.recordIntimateActs(id, {
    scene: 'chat', partnerKind: 'user', partnerId: 0, source: 'manual', rawId: 0,
    acts: [{ actKey: 'hand', count: 1, sourceUid: first.json.intimate.sourceUid }],
  });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.skipped, 1);
  assert.equal(intimateRows(id).length, 1);

  // 再点一次 = 新事件 → 新锚点 → 各记一笔
  const second = await api('POST', `/api/characters/${id}/touch/touch_thigh`, { mode: 'implicit' });
  assert.equal(second.json.intimate.inserted, 1);
  assert.notEqual(second.json.intimate.sourceUid, first.json.intimate.sourceUid);
  assert.equal(intimateRows(id).length, 2);
});

test('不记账的动作：Lv1 / Lv2 恒 null；whisper_ear 留 null（无对应键，不硬凑）', async () => {
  const id = seedCharacter({ affinity: 60 });
  assert.equal((await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'implicit' })).json.intimate, null);
  assert.equal((await api('POST', `/api/characters/${id}/touch/stroke_hair`, { mode: 'implicit' })).json.intimate, null);
  const ear = await api('POST', `/api/characters/${id}/touch/whisper_ear`, { mode: 'implicit' });
  assert.equal(ear.json.allowed, true, '耳后吹气照样能点（只是不记账）');
  assert.equal(ear.json.intimate, null);
  assert.equal(intimateRows(id).length, 0);
});

test('Lv3 记账：门控拒绝 / 未授权时不记账', async () => {
  const low = seedCharacter({ affinity: 0 });
  const denied = await api('POST', `/api/characters/${low}/touch/touch_breast`, {});
  assert.equal(denied.json.allowed, false);
  assert.equal(intimateRows(low).length, 0);

  const unauthorized = seedCharacter({ affinity: 60 });
  intimate.upsertBodyProfile(unauthorized, { aiEditFields: [] });
  const blocked = await api('POST', `/api/characters/${unauthorized}/touch/touch_breast`, {});
  assert.equal(blocked.json.allowed, false);
  assert.equal(blocked.json.code, 'intimate_not_authorized');
  assert.equal(intimateRows(unauthorized).length, 0);
});

test('Lv3 记账：看板总开关 features.intimate=false 时不记账（动作本身照常）', async () => {
  const id = seedCharacter({ affinity: 60 });
  config.features.intimate = false;
  try {
    const res = await api('POST', `/api/characters/${id}/touch/touch_butt`, { mode: 'implicit' });
    assert.equal(res.json.allowed, true);
    assert.equal(res.json.intimate, null);
    assert.equal(intimateRows(id).length, 0);
  } finally {
    config.features.intimate = true;
  }
});

// ──────────────── 群聊动作（task-17 · 阶段二）────────────────

test('群聊即时反应：写进群会话 + 只广播一次 group_message（私聊会话零写入）', async () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  const displayName = getDb().prepare('SELECT display_name FROM characters WHERE id = ?').pluck().get(id);
  stubReaction('她愣了一下，脸有点红。');
  sse.chunks.length = 0;

  const res = await api('POST', `/api/characters/${id}/touch/pat_head`, { scene: 'group', groupId: gid });
  assert.equal(res.status, 200);
  assert.equal(res.json.mode, 'instant');
  assert.deepEqual(res.json.groupMessage, { groupId: gid, msgId: res.json.groupMessage.msgId, rawId: res.json.groupMessage.rawId, seq: 0 });

  // 群会话里能看到（raw 带说话人前缀，messages 一气泡一条、speaker 是被摸的角色）
  const raws = getDb().prepare('SELECT role, content FROM raw_messages WHERE conversation_id = ?').all(`group_${gid}`);
  assert.equal(raws.length, 1);
  assert.equal(raws[0].role, 'assistant');
  assert.equal(raws[0].content, `[${displayName}]: 她愣了一下，脸有点红。`);
  const msgs = getDb().prepare('SELECT * FROM messages WHERE conversation_id = ?').all(`group_${gid}`);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].speaker_character_id, id);
  assert.equal(msgs[0].content, '她愣了一下，脸有点红。');
  assert.equal(msgs[0].seq, 0);

  // 广播形状逐字对齐 groupChatEngine.serializeMsg()（群聊页 _enqueue 唯一认的形态）
  const events = takeSse('group_message');
  assert.equal(events.length, 1, '只广播一次 group_message');
  assert.equal(events[0].id, res.json.groupMessage.msgId);
  assert.equal(events[0].group_id, gid);
  assert.equal(events[0].role, 'assistant');
  assert.equal(events[0].content, '她愣了一下，脸有点红。');
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].speaker_character_id, id);
  assert.equal(events[0].speaker_name, displayName);
  assert.equal(events[0].source, 'touch');
  assert.ok(events[0].created_at, 'created_at 必须是 ISO 串');

  // 私聊一个字节都没写、也没发 proactive_message
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 0);
  assert.equal(takeSse('proactive_message').length, 0);
});

test('私聊即时反应维持现状：写私聊 + proactive_message，不广播 group_message', async () => {
  const id = seedCharacter();
  stubReaction('……嗯。');
  sse.chunks.length = 0;

  const res = await api('POST', `/api/characters/${id}/touch/pat_head`, {});
  assert.equal(res.json.mode, 'instant');
  assert.equal(res.json.groupMessage, null);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?').get(`char_${id}`).n, 1);
  assert.equal(takeSse('group_message').length, 0);
  assert.equal(takeSse('proactive_message').length, 1);
});

test('群聊参数校验：群不存在 404 / 她不是群成员 400', async () => {
  const id = seedCharacter();
  const missing = await api('POST', `/api/characters/${id}/touch/pat_head`, { scene: 'group', groupId: 999999 });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'group not found');

  const other = seedCharacter();
  const gid = seedGroup([other]);
  const notMember = await api('POST', `/api/characters/${id}/touch/pat_head`, { scene: 'group', groupId: gid });
  assert.equal(notMember.status, 400);
  assert.equal(notMember.json.error, 'character is not a member of this group');
  assert.equal(eventRows(id).length, 0, '校验失败不得落事件');
});

test('群聊动作端到端：路由落 group_id 事件 → groupChatEngine 能注入（成员限定行）', async () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  const displayName = getDb().prepare('SELECT display_name FROM characters WHERE id = ?').pluck().get(id);

  const res = await api('POST', `/api/characters/${id}/touch/hug`, { scene: 'group', groupId: gid, mode: 'implicit' });
  assert.equal(res.json.mode, 'implicit');
  const row = getDb().prepare('SELECT group_id, action_key, status FROM touch_events WHERE id = ?').get(res.json.eventId);
  assert.equal(row.group_id, gid);
  assert.equal(row.action_key, 'hug');
  assert.equal(row.status, 'pending');

  const injected = collectTouchActionBlocks({ id: gid, members: [{ id, display_name: displayName }] });
  assert.equal(injected.blocks.length, 2, '动作块 + 围观规则');
  assert.ok(injected.blocks[0].includes(`【本节只对「${displayName}」生效`));
  assert.equal(getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(res.json.eventId), 'injected');
});

// ──────────────── 睡着被摸挂 wake_reaction（task-17）────────────────

test('睡着被重动作摸醒：tempWake + 复用 task-42 的 wake_reaction', async () => {
  const id = seedCharacter({ scheduled: true });
  makeSleeping(id);
  const res = await api('POST', `/api/characters/${id}/touch/tickle`, { mode: 'implicit' });
  assert.equal(res.json.allowed, true);
  assert.equal(res.json.wakesSleeping, true);
  assert.equal(res.json.preWake.woken, true);
  assert.equal(res.json.wakeReaction, true, '被摸醒也要演"惊醒/恍惚"');
  assert.equal(getDb().prepare('SELECT pending_directive FROM character_hypnosis WHERE character_id = ?').pluck().get(id), 'wake_reaction');
  // 只写指令列，不碰催眠状态列
  const row = getDb().prepare('SELECT body_controlled, mind_awake, active_until FROM character_hypnosis WHERE character_id = ?').get(id);
  assert.deepEqual({ ...row }, { body_controlled: 0, mind_awake: 0, active_until: null });

  // 没睡着的同一动作：不挂（wakesSleeping=false）
  const awake = seedCharacter({ scheduled: true });
  const second = await api('POST', `/api/characters/${awake}/touch/tickle`, { mode: 'implicit' });
  assert.equal(second.json.wakesSleeping, false);
  assert.equal(second.json.wakeReaction, false);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM character_hypnosis WHERE character_id = ?').get(awake).n, 0);
});

// ──────────────── 事件新鲜度窗口（task-17）────────────────

function seedStaleEvent(characterId, minutesAgo = 45, status = 'pending') {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, created_at, updated_at)
     VALUES (?, NULL, 'pat_head', 'implicit', 0, 1, ?, datetime('now', ?), datetime('now'))`
  ).run(characterId, status, `-${minutesAgo} minutes`);
  return Number(info.lastInsertRowid);
}

test('新鲜度窗口：超过 30 分钟的 pending/done 被扫成 expired，且私聊读取按同一 cutoff 挡住', async () => {
  const id = seedCharacter();
  const staleId = seedStaleEvent(id, 45);
  const staleDoneId = seedStaleEvent(id, 90, 'done');

  // 私聊链（chat.js）的查询口径：带 cutoff 过滤 → 过期事件取不到
  const picked = getDb().prepare(
    `SELECT id FROM touch_events
      WHERE character_id = ? AND status IN ('pending','done') AND group_id IS NULL AND created_at >= ?
      ORDER BY id DESC LIMIT 1`
  ).get(id, touchService.touchEventCutoff());
  assert.equal(picked, undefined, '过期事件不得被私聊链注入');

  const marked = expireStaleTouchEvents({ characterId: id });
  assert.equal(marked, 2);
  assert.equal(getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(staleId), 'expired');
  assert.equal(getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(staleDoneId), 'expired');

  // 新鲜事件不受影响：同一套 cutoff 查询能取到；GET /actions 也会顺手清扫
  const freshId = seedStaleEvent(id, 0);
  const fresh = getDb().prepare(
    `SELECT id FROM touch_events
      WHERE character_id = ? AND status IN ('pending','done') AND group_id IS NULL AND created_at >= ?
      ORDER BY id DESC LIMIT 1`
  ).get(id, touchService.touchEventCutoff());
  assert.equal(fresh.id, freshId);
  assert.equal((await api('GET', `/api/characters/${id}/touch/actions`)).status, 200);
  assert.equal(getDb().prepare('SELECT status FROM touch_events WHERE id = ?').pluck().get(freshId), 'pending', '新鲜事件不该被误扫');
});

// ──────────────── 群聊敏感档开关（task-17 追加）────────────────

test('群聊 Lv3 开关：2026-10-04 起**默认开** → 群聊直接放行；显式关掉 → group_adult_blocked；GET 带出生效值', async () => {
  const id = seedCharacter({ affinity: 60 });
  const gid = seedGroup([id]);

  // 默认开（2026-10-04 用户裁决「群聊成人开关也默认开」）⇒ 群里 Lv3 直接放行。
  // 原断言是「默认关 → 恒拦」，默认值翻转后必须改成从**开**这一侧进，否则测的就不是产品行为。
  const on = await api('POST', `/api/characters/${id}/touch/touch_breast`, { scene: 'group', groupId: gid, mode: 'implicit' });
  assert.equal(on.json.allowed, true, '默认开：群聊 Lv3 直接放行');
  const listOn = await api('GET', `/api/characters/${id}/touch/actions?scene=group`);
  assert.equal(listOn.json.allowGroupAdult, true, '前端读这个生效值，别自己写死 false');
  assert.equal(listOn.json.features.groupAdult, true);
  assert.equal(listOn.json.gate.touch_breast.allowed, true);
  assert.equal(listOn.json.gate.hug.allowed, true, 'Lv1 不受这个开关影响');

  // 反向证明：开关**本身没被废掉** —— 显式关掉时必须回到拦截（否则"默认开"就等于"删了开关"）
  config.features.touchGroupAdult = false;
  try {
    const rowsBefore = eventRows(id).length;
    const off = await api('POST', `/api/characters/${id}/touch/touch_breast`, { scene: 'group', groupId: gid, mode: 'implicit' });
    assert.equal(off.json.allowed, false);
    assert.equal(off.json.code, 'group_adult_blocked');
    assert.equal(eventRows(id).length, rowsBefore, '被拦时零落库');
    const listOff = await api('GET', `/api/characters/${id}/touch/actions?scene=group`);
    assert.equal(listOff.json.allowGroupAdult, false);
    assert.equal(listOff.json.features.groupAdult, false);
    assert.equal(listOff.json.gate.touch_breast.code, 'group_adult_blocked');
    // 私聊场景永远不受它影响（关着开关也照常）
    const chatList = await api('GET', `/api/characters/${id}/touch/actions`);
    assert.equal(chatList.json.gate.touch_breast.allowed, true);
  } finally {
    config.features.touchGroupAdult = true;   // 还原成新默认值，别污染后面的用例
  }
});

// ──────────────── POST：总开关 ────────────────

test('群聊敏感档开关：PUT /api/config/features 往返持久化（2026-10-04 起默认 true）', async () => {
  assert.equal((await api('GET', '/api/config')).json.features.touchGroupAdult, true, '默认必须开（用户 2026-10-04 裁决）');
  const put = await api('PUT', '/api/config/features', { key: 'touchGroupAdult', value: false });
  assert.equal(put.status, 200);
  assert.equal(put.json.features.touchGroupAdult, false);
  assert.equal(
    getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchGroupAdult'),
    'false',
    '必须落 system_settings（重启不丢）'
  );
  assert.equal((await api('GET', '/api/config')).json.features.touchGroupAdult, false);
  await api('PUT', '/api/config/features', { key: 'touchGroupAdult', value: true });
  assert.equal((await api('GET', '/api/config')).json.features.touchGroupAdult, true);
});

test('设置开关：PUT /api/config/features 持久化 touch / touchInstant，GET 能读回', async () => {
  const before = await api('GET', '/api/config');
  assert.equal(before.json.features.touch, true, '动作系统默认开');
  assert.equal(before.json.features.touchInstant, true, '即时反应默认开');

  const put = await api('PUT', '/api/config/features', { key: 'touch', value: false });
  assert.equal(put.status, 200);
  assert.equal(put.json.features.touch, false);
  assert.equal(
    getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touch'),
    'false',
    '必须落 system_settings（重启不丢）'
  );
  const after = await api('GET', '/api/config');
  assert.equal(after.json.features.touch, false, 'GET /api/config 要带 features（设置页读它）');

  const putInstant = await api('PUT', '/api/config/features', { key: 'touchInstant', value: false });
  assert.equal(putInstant.json.features.touchInstant, false);

  // 非法 key → 400（通用 handler 的白名单就是 config.features 本身）
  assert.equal((await api('PUT', '/api/config/features', { key: 'not_a_feature', value: true })).status, 400);

  // 复位：本文件用例共享一个进程/配置，别把后面的用例连坐
  await api('PUT', '/api/config/features', { key: 'touch', value: true });
  await api('PUT', '/api/config/features', { key: 'touchInstant', value: true });
  assert.equal((await api('GET', '/api/config')).json.features.touch, true);
});

test('总开关关闭：POST 409 且零写入；touchInstant=false 时全部走隐式', async () => {
  const id = seedCharacter();
  stubReaction();
  config.features.touch = false;
  try {
    const res = await api('POST', `/api/characters/${id}/touch/pat_head`, {});
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'touch feature disabled');
    assert.equal(eventRows(id).length, 0);
    // 读动作清单不拦（前端才能显示"功能已关闭"）
    const list = await api('GET', `/api/characters/${id}/touch/actions`);
    assert.equal(list.status, 200);
    assert.equal(list.json.features.touch, false);
  } finally {
    config.features.touch = true;
  }

  config.features.touchInstant = false;
  try {
    const res = await api('POST', `/api/characters/${id}/touch/pat_head`, { mode: 'auto' });
    assert.equal(res.json.mode, 'implicit');
    assert.equal(res.json.reason, 'instant_disabled');
    assert.equal(stub.calls, 0);
  } finally {
    config.features.touchInstant = true;
  }
});
// ──────────────── P0-2：消费顺序 + 待消费计数（task-24）────────────────

test('P0-2 私聊消费顺序 = ASC（先点先演，与群聊 collectTouchActionBlocks 对齐）', async () => {
  // task-24 P2-2 搬家后，消费逻辑在服务层 touchEventStore；行为测试见 test/touchEventStore.test.js
  const store = await readFile(new URL('../src/services/touchEventStore.js', import.meta.url), 'utf8');
  const from = store.indexOf('export function takePendingTouchEvent');
  const to = store.indexOf('export function markTouchEventInjected');
  assert.ok(from > 0 && to > from, 'touchEventStore 里应有 takePendingTouchEvent（消费私聊动作事件的唯一入口）');
  const block = store.slice(from, to);
  assert.ok(block.includes('ORDER BY id ASC'), '私聊链必须取**最旧**的一条（改前 DESC = 先点后演，与群聊不一致）');
  assert.ok(!block.includes('ORDER BY id DESC'), '不能残留 DESC');

  // 反向 import 已消除：chat.js 从服务层 import，且不再 import 任何 routes 模块
  const chatSource = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');
  assert.ok(chatSource.includes("import { markTouchEventInjected, takePendingTouchEvent } from '../services/touchEventStore.js';"), 'chat.js 必须从服务层取消费函数');
  assert.ok(!/from '\.\/touch\.js'/.test(chatSource), 'chat.js 不许再反向 import ./touch.js');
  assert.ok(!chatSource.includes('function takePendingTouchEvent'), '本地副本必须删掉（否则两处实现会漂）');
});

test('GET /touch/state 带 pendingCount（前端显示「还有 N 个动作等她回应」）', async () => {
  const id = seedCharacter();
  const db = getDb();
  const seed = (status) => db.prepare(
    "INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, created_at, updated_at) " +
    "VALUES (?, NULL, 'pat_head', 'implicit', 0, 1, ?, datetime('now'), datetime('now'))"
  ).run(id, status);
  seed('pending');
  seed('pending');
  seed('done');
  seed('injected');
  seed('expired');

  const res = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(res.status, 200);
  assert.equal(res.json.pendingCount, 2, '只数 pending×2；done（反应已发过）/injected/expired 都不算');
  assert.deepEqual(res.json.pendingByMode, { instant: 0, implicit: 2 }, '按 mode 分开给（供前端分文案）');

  // 清空后再查：0（不是 undefined）
  db.prepare("UPDATE touch_events SET status = 'injected' WHERE character_id = ?").run(id);
  const cleared = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(cleared.json.pendingCount, 0);
  assert.deepEqual(cleared.json.pendingByMode, { instant: 0, implicit: 0 });

  // 群聊事件不算进私聊的「待回应」
  const gid = seedGroup([id]);
  db.prepare("INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status) VALUES (?, ?, 'hug', 'implicit', 0, 1, 'pending')").run(id, gid);
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state')).json.pendingCount, 0);
});

// ──────────────── task-28：/touch/state 的群聊口径 ────────────────

test('task-28 /touch/state 支持 scene=group：群聊口径 + 保留私聊口径字段 + 群聊下的过期清扫', async () => {
  const id = seedCharacter();
  const other = seedCharacter();
  const gid = seedGroup([id, other]);
  const db = getDb();
  const seed = (characterId, status, groupId = null, minutesAgo = 0) => db.prepare(
    "INSERT INTO touch_events (character_id, group_id, action_key, mode, annoyance, like_ratio, status, created_at, updated_at) " +
    "VALUES (?, ?, 'pat_head', 'implicit', 0, 1, ?, datetime('now', ?), datetime('now'))"
  ).run(characterId, groupId, status, '-' + minutesAgo + ' minutes');
  seed(id, 'pending');
  seed(id, 'done');
  seed(id, 'pending', gid);
  seed(other, 'pending', gid);

  // ① 不传参数 ⇒ 私聊口径（现有前端行为逐字节不变），并顺手给出新字段
  const plain = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(plain.status, 200);
  assert.equal(plain.json.pendingCount, 1, '不传参数 = 私聊口径，且只数 pending（done 不算「等回应」）');
  assert.equal(plain.json.scene, 'chat');
  assert.equal(plain.json.groupId, null);
  assert.deepEqual(plain.json.pendingCounts, { chat: 1, group: null }, '私聊口径下 group 计数为 null');
  assert.deepEqual(plain.json.pendingByMode, { instant: 0, implicit: 1 }, 'pendingByMode = 生效场景（私聊）的 pending 分 mode');

  // ② scene=group&groupId ⇒ 该群口径（全体成员），同时保留私聊口径
  const group = await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=' + gid);
  assert.equal(group.status, 200);
  assert.equal(group.json.scene, 'group');
  assert.equal(group.json.groupId, gid);
  assert.equal(group.json.pendingCount, 2, '群聊口径 = 该群全体待消费（id 1 条 + other 1 条）');
  assert.deepEqual(group.json.pendingCounts, { chat: 1, group: 2 }, '两个口径都给，互不污染（都只数 pending）');
  assert.deepEqual(group.json.pendingByMode, { instant: 0, implicit: 2 }, '群聊场景下 pendingByMode 走群口径');
  assert.ok(group.json.states && group.json.states.pat_head, 'states/quota 结构不变');

  // ③ 非法 groupId ⇒ 400（显式契约，不静默回落）
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state?scene=group')).status, 400);
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=0')).status, 400);
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=abc')).status, 400);

  // ④ 群聊口径下的过期清扫：120 分钟前的僵尸事件不进计数
  seed(id, 'pending', gid, 120);
  const afterStale = await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=' + gid);
  assert.equal(afterStale.json.pendingCount, 2, '过期事件被清掉，不撑大群聊计数');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM touch_events WHERE group_id = ? AND status = 'expired'").get(gid).n,
    1,
    '群聊口径的 GET 也会把僵尸事件标成 expired'
  );

  // ⑤ 私聊口径也仍然清扫自己的僵尸事件（回归）
  seed(id, 'pending', null, 120);
  const chatAfter = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(chatAfter.json.pendingCount, 1, '私聊口径：僵尸事件被清掉后只剩那条真 pending');
  assert.equal(chatAfter.json.pendingCounts.chat, 1);
});

test('真机问题 3：即时反应成功（done）后计数归零；隐式 pending 才计「等她回应」+ pendingByMode 形状', async () => {
  const id = seedCharacter();
  stubReaction();
  // ① 即时动作成功：反应已作为独立消息发出（status=done）⇒ 不该再显示「还有 N 个动作等她回应」
  const instant = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
  assert.equal(instant.json.status, 'done', '即时反应落库为 done');
  const afterInstant = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(afterInstant.json.pendingCount, 0, '反应发出去了就不算「等回应」（旧口径会一直是 1，只涨不减）');
  assert.deepEqual(afterInstant.json.pendingByMode, { instant: 0, implicit: 0 });

  // ② 隐式动作：还没演 ⇒ 算「等回应」，且按 mode 能区分出 implicit
  const implicitRes = await api('POST', '/api/characters/' + id + '/touch/hug', { mode: 'implicit' });
  assert.equal(implicitRes.json.status, 'pending');
  const afterImplicit = await api('GET', '/api/characters/' + id + '/touch/state');
  assert.equal(afterImplicit.json.pendingCount, 1, '隐式 pending 才是真的等她下一轮聊天演出');
  assert.deepEqual(afterImplicit.json.pendingByMode, { instant: 0, implicit: 1 });

  // ③ 消费链没被改：取值仍是 ASC（最旧），所以先被取走的正是 ① 那条 done —— 它照样要被注入
  //    「已发过别再演」块；而因为它本来就不在计数里，消费它**不会**让计数变化。
  const { takePendingTouchEvent, markTouchEventInjected } = await import('../src/services/touchEventStore.js');
  const takenDone = takePendingTouchEvent(id);
  assert.ok(takenDone, '必须有可消费事件');
  assert.equal(takenDone.mode, 'instant', '最旧的是 ① 的 done（消费链仍吃 done，只是计数不算它）');
  markTouchEventInjected(takenDone.id);
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state')).json.pendingCount, 1, '消费 done 不影响计数');

  // 再消费那条真正「等回应」的隐式 pending → 归零
  const takenPending = takePendingTouchEvent(id);
  assert.equal(takenPending.mode, 'implicit');
  markTouchEventInjected(takenPending.id);
  assert.equal((await api('GET', '/api/characters/' + id + '/touch/state')).json.pendingCount, 0, '消费掉 pending 后归零');
});

test('task-28 groupId 边界：严格正整数（1.5 / 3abc / +3 ⇒ 400；" 3 " trim 后合法）', async () => {
  const id = seedCharacter();
  const gid = seedGroup([id]);
  // 非严格正整数一律 400（旧实现 parseInt('1.5')=1 会 200，这条就是红）
  for (const raw of ['1.5', '3abc', '+3', '-1', '1e3', '0', 'abc', '1.0']) {
    const res = await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=' + encodeURIComponent(raw));
    assert.equal(res.status, 400, `groupId=${raw} 必须 400，实际 ${res.status}`);
    assert.equal(res.json.code, 'INVALID_GROUP_ID', `groupId=${raw} 的 code`);
  }
  // 纯数字串（含首尾空白，口径 = trim 后 /^\d+$/）⇒ 200，并按该群口径
  const ok = await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=' + gid);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.groupId, gid);
  assert.equal(ok.json.scene, 'group');
  const padded = await api('GET', '/api/characters/' + id + '/touch/state?scene=group&groupId=' + encodeURIComponent(' ' + gid + ' '));
  assert.equal(padded.status, 200, '首尾空白 trim 后是纯数字 ⇒ 允许');
  assert.equal(padded.json.groupId, gid);
  // 不带 scene 时 groupId 不参与（旧行为不变）
  const ignored = await api('GET', '/api/characters/' + id + '/touch/state?groupId=1.5');
  assert.equal(ignored.status, 200, 'scene 缺省 = chat，groupId 忽略');
  assert.equal(ignored.json.scene, 'chat');
  assert.equal(ignored.json.groupId, null);
});

// ──────────────── task-30：对话式反应喂料扩容 ────────────────

function seedRecentMessages(characterId, count, prefix = 'R') {
  const db = getDb();
  for (let i = 1; i <= count; i++) {
    db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'user', ?)")
      .run('char_' + characterId, prefix + String(i).padStart(2, '0'));
  }
}

test('task-30 对话式反应（默认）：喂全四块 + 8 轮窗口 + max_tokens 500 + reactionFeed 回执 + 可观测日志', async () => {
  const id = seedCharacter({ affinity: 62, scheduled: true });
  hypnosis.grantHypnosisPhone();
  hypnosis.hypnotize(id, { minutes: 30 });
  seedRecentMessages(id, 9);
  config.features.touchReactionMode = 'conversation';
  stubReaction();
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  let res;
  try {
    res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
  } finally {
    console.log = origLog;
  }
  assert.equal(res.json.mode, 'instant');
  assert.equal(stub.syncBody.max_tokens, 500, '对话式 → max_tokens 500');
  const text = JSON.stringify(stub.syncBody.messages);
  assert.ok(text.includes('与 user 的关系深度'), '喂了关系/好感块');
  assert.ok(text.includes('白天活动'), '喂了当前日程');
  assert.ok(text.includes('催眠'), '喂了催眠状态块（完全控制口径）');
  assert.ok(text.includes('R02') && !text.includes('R01'), '窗口 = 最近 8 轮（第 1 条被裁掉）');
  assert.ok(text.includes('Lv1'), '动作定义与等级要喂');
  assert.ok(text.includes('私聊'), '场景要喂');
  assert.ok(text.includes('1~4 句'), '输出口径放开为对话式');
  assert.equal(res.json.reactionFeed.mode, 'conversation');
  assert.equal(res.json.reactionFeed.rounds, 8);
  assert.ok(res.json.reactionFeed.blocks.includes('affinity'), '回执能看出喂了哪几块');
  assert.ok(res.json.reactionFeed.blocks.includes('schedule'));
  assert.ok(res.json.reactionFeed.blocks.includes('hypnosis'));
  assert.deepEqual(res.json.reactionFeed.failed, []);
  assert.ok(logs.some(line => line.includes('[touch] reaction feed') && line.includes('rounds=8')), '要有可观测日志（轮数/块/字符数）');
});

test('task-30 快速模式：touchReactionMode=quick ⇒ 不喂新块、窗口 2 条、max_tokens 300（一键回退）', async () => {
  const id = seedCharacter({ affinity: 62, scheduled: true });
  seedRecentMessages(id, 9, 'Q');
  config.features.touchReactionMode = 'quick';
  stubReaction();
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.json.mode, 'instant');
    assert.equal(stub.syncBody.max_tokens, 300, '快速模式仍是 300');
    const text = JSON.stringify(stub.syncBody.messages);
    assert.ok(!text.includes('与 user 的关系深度'), '快速模式不喂关系块');
    assert.ok(!text.includes('白天活动'), '快速模式不喂日程块');
    assert.ok(!text.includes('1~4 句'), '快速模式仍是 1~2 句');
    assert.ok(text.includes('Q09') && text.includes('Q08') && !text.includes('Q07'), '快速窗口 = 2 条');
    assert.equal(res.json.reactionFeed.mode, 'quick');
    assert.equal(res.json.reactionFeed.rounds, 2);
  } finally {
    config.features.touchReactionMode = 'conversation';
  }
});

test('task-30 喂料容错：某一块 builder 抛错 ⇒ 其余块照常注入、动作照常成功', async () => {
  const id = seedCharacter({ affinity: 62, scheduled: true });
  config.features.touchReactionMode = 'conversation';
  stubReaction();
  touchRouteModule.__setTouchFeedBuildersForTest({ schedule: () => { throw new Error('boom'); } });
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'done', '喂料失败绝不影响动作');
    const text = JSON.stringify(stub.syncBody.messages);
    assert.ok(!text.includes('白天活动'), '抛错的那块被跳过');
    assert.ok(text.includes('与 user 的关系深度'), '其它块照常注入');
    assert.ok(res.json.reactionFeed.failed.includes('schedule'), 'failed 里要能看出哪块挂了');
  } finally {
    touchRouteModule.__setTouchFeedBuildersForTest(null);
    config.features.touchReactionMode = 'conversation';
  }
});

test('task-30 同一动作刚发生过 ⇒ 提示「回短一点」（防同一摸演两遍）', async () => {
  const id = seedCharacter();
  config.features.touchReactionMode = 'conversation';
  stubReaction();
  const first = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'implicit' });
  assert.equal(first.json.status, 'pending');
  const second = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
  assert.equal(second.json.mode, 'instant');
  const text = JSON.stringify(stub.syncBody.messages);
  assert.ok(text.includes('刚刚才'), '第二次要提示她刚被这样摸过');
  assert.equal(second.json.reactionFeed.sameAction, true);
});

test('task-30 反应风格设置键：GET 默认 conversation；PUT 往返持久化；非法值回落；PUT 后真的切换链路', async () => {
  // 源码级守卫：本文件的 task-30 用例会在**内存里**直接改这个键，所以"默认值"必须从 config.js 源码确认，
  // 否则键忘了声明也会因为内存污染而假绿（我第一版就是这么假绿的）。
  const configSource = await readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(
    configSource.includes("touchReactionMode: process.env.FEATURE_TOUCH_REACTION_MODE || 'conversation'"),
    'config.js 必须声明 touchReactionMode（默认 conversation）'
  );
  const settingsSource = await readFile(new URL('../src/db/settings.js', import.meta.url), 'utf8');
  assert.ok(settingsSource.includes('feature_touchReactionMode'), 'db/settings.js 必须有落库映射');

  const before = await api('GET', '/api/config');
  assert.equal(before.json.features.touchReactionMode, 'conversation', '默认对话式');

  const put = await api('PUT', '/api/config/features', { key: 'touchReactionMode', value: 'quick' });
  assert.equal(put.status, 200);
  assert.equal(put.json.features.touchReactionMode, 'quick');
  assert.equal(
    getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchReactionMode'),
    'quick',
    '落 system_settings（重启不丢）'
  );
  assert.equal((await api('GET', '/api/config')).json.features.touchReactionMode, 'quick');

  // PUT 之后链路真的用快速版（一次调用、300 token、不喂新块）
  const id = seedCharacter({ affinity: 62, scheduled: true });
  stubReaction();
  const quick = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
  assert.equal(quick.json.reactionFeed.mode, 'quick');
  assert.equal(stub.syncBody.max_tokens, 300);
  assert.ok(!JSON.stringify(stub.syncBody.messages).includes('与 user 的关系深度'));

  const bad = await api('PUT', '/api/config/features', { key: 'touchReactionMode', value: 'sometimes' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.features.touchReactionMode, 'conversation', '非法值回落 conversation，不写脏值');
  assert.equal(
    getDb().prepare('SELECT setting_value FROM system_settings WHERE setting_key = ?').pluck().get('feature_touchReactionMode'),
    'conversation'
  );
  await api('PUT', '/api/config/features', { key: 'touchReactionMode', value: 'conversation' });
});

// ──────────────── §1.3：客户端断开 → 中止上游 LLM（不让它空烧）────────────────
const delayMs = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn, timeout = 2000, step = 20) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await delayMs(step);
  }
  return Boolean(fn());
}
function countChatMessages(id) {
  return getDb().prepare("SELECT COUNT(*) AS n FROM raw_messages WHERE conversation_id = ?").get('char_' + id).n;
}

test('§1.3 客户端断开 ⇒ 中止上游 LLM；事件留 pending、不落库、不写消息', async () => {
  const id = seedCharacter({ affinity: 62 });
  stubReaction();
  stub.hold = true;
  const before = countChatMessages(id);
  const port = server.address().port;
  const req = http.request({
    host: '127.0.0.1', port, path: '/api/characters/' + id + '/touch/pat_head', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, () => {});
  req.on('error', () => {});   // 主动 destroy 引起的 ECONNRESET 是预期
  req.end(JSON.stringify({ mode: 'instant' }));

  assert.ok(await waitUntil(() => stub.calls >= 1, 2000), '上游应当已经收到这次调用');
  req.destroy();               // 用户关页面 / 切走
  const aborted = await waitUntil(() => stub.upstreamAborted >= 1, 2000);
  stub.release();              // 假上游"愿意回了"也不该被采纳
  await delayMs(250);

  assert.equal(aborted, true, '服务端必须 abort 上游调用（否则照常计费）');
  assert.equal(stub.calls, 1, 'abort 不许重试（llm-client 的 throwIfSyncAborted 先于可重试判定）');
  const row = getDb().prepare('SELECT status, mode FROM touch_events ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'pending', '断开后事件留 pending（下一轮聊天照样演出这一下）');
  assert.equal(countChatMessages(id), before, '不落库、不广播她这条反应');
});

// ──────────────── §4.1①：催眠轮不叠腻烦 ────────────────

function annoyanceOf(id, key) {
  const row = getDb().prepare('SELECT annoyance FROM character_touch_state WHERE character_id = ? AND action_key = ?').get(id, key);
  return row ? Number(row.annoyance) : null;
}

test('§4.1① 催眠轮连点同一动作：腻烦度**不叠加**（非催眠照常叠加）', async () => {
  const id = seedCharacter();
  hypnosis.grantHypnosisPhone();
  hypnosis.hypnotize(id, { minutes: 30 });
  stubReaction();
  try {
    for (let i = 0; i < 5; i += 1) {
      const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { mode: 'instant' });
      assert.equal(res.json.status, 'done', '催眠豁免下每次都应成功');
    }
    assert.equal(annoyanceOf(id, 'pat_head'), 0, '催眠中连点 5 次，腻烦度仍是 0（不叠加）');

    const normalId = seedCharacter();
    stubReaction();
    for (let i = 0; i < 5; i += 1) {
      await api('POST', '/api/characters/' + normalId + '/touch/pat_head', { mode: 'instant' });
    }
    assert.ok(annoyanceOf(normalId, 'pat_head') > 0, '非催眠角色照常叠加（对照）');
  } finally {
    stubReaction();
  }
});

// ──────────────── §一③：群聊即时反应顺带围观插话 ────────────────

test('§一③ 群聊即时反应顺带围观插话：命中时第二条 group_message（同一次 LLM 调用，省额度）', async () => {
  const id = seedCharacter();
  const other = seedCharacter();
  const gid = seedGroup([id, other]);
  const db = getDb();
  const otherName = db.prepare('SELECT display_name FROM characters WHERE id = ?').pluck().get(other);
  const prevAdult = config.features.touchGroupAdult;
  const prevChance = config.features.touchBystanderChance;
  const realRandom = Math.random;
  config.features.touchGroupAdult = true;
  config.features.touchBystanderChance = 1;
  Math.random = () => 0;
  stubReaction('她红了脸。\n[' + otherName + ']: 哟，当着我们面就动手动脚？');
  takeSse('group_message');
  try {
    const res = await api('POST', '/api/characters/' + id + '/touch/pat_head', { scene: 'group', groupId: gid, mode: 'instant' });
    assert.equal(res.status, 200);
    assert.equal(stub.calls, 1, '反应 + 围观插话必须是**同一次**调用（省额度）');
    const messages = takeSse('group_message');
    assert.equal(messages.length, 2, '她的反应 + 围观者插话各一条广播');
    assert.equal(messages[0].content, '她红了脸。', '她的气泡里不含围观者那一行');
    assert.equal(messages[1].content, '哟，当着我们面就动手动脚？', '第二条 = 围观者插话');
    const rows = db.prepare('SELECT speaker_character_id, content FROM messages WHERE conversation_id = ? ORDER BY id').all('group_' + gid);
    assert.equal(rows.length, 2, '群会话里两条消息');
    assert.equal(Number(rows[0].speaker_character_id), id, '第一条是她');
    assert.equal(Number(rows[1].speaker_character_id), other, '第二条是围观者（别的角色真的被拉进来了）');
    assert.equal(Number(messages[1].speaker_character_id), other, '广播里也标了说话人');
  } finally {
    Math.random = realRandom;
    config.features.touchGroupAdult = prevAdult;
    config.features.touchBystanderChance = prevChance;
    stubReaction();
  }
});
