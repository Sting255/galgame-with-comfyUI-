/**
 * D2 · 重写兜底（reroll）的**端到端**回归（真 express 路由 + 真 SSE + 打桩 LLM 网络）
 *
 * 判定层在 test/antiRepetitionReroll.test.js；本文件验的是**调用点行为**：
 *   · 开关关 ⇒ 只发一次模型调用、不发替换事件（逐字节零变化）
 *   · 开关开 + 强档复读 ⇒ 追加一次调用，并发出 replace_last_assistant
 *   · 重写失败 ⇒ 保留原输出（既不空，也不发替换事件）
 *
 * 打桩方式与 antiRepetitionPenalty 一致：换掉 require.cache 里的 node-fetch，
 * 于是走"真 SDK 组装请求 → 假网络"，按请求顺序返回第 1/2 版稿子。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';

process.env.DB_PATH = ':memory:';
// node:test 的 worker 对 stdout 洪泛敏感（会报 "Unable to deserialize cloned data"，runner 层崩溃）：
// 本文件要跑真路由，连带的模块日志很多（情绪评估/配图判断/主动聊天排期都要打），这里静音。
// 与 test/townNpcOfferingSeedFlow.test.js 同一处理。SSE 断言只吃网络返回，不受影响。
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const require = createRequire(import.meta.url);
const nodeFetchPath = require.resolve('node-fetch');

/** 假网络：按顺序把 streamBodies.length 当作第几次调用，返回对应稿件 */
const net = { scripts: [], bodies: [], failOn: 0, mainIndex: 0, mainMarker: '' };
function sseBody(text) {
  const chunk = { choices: [{ delta: { content: text } }] };
  return 'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n';
}
const realFetchModule = require.cache[nodeFetchPath];
require.cache[nodeFetchPath] = {
  id: nodeFetchPath, filename: nodeFetchPath, loaded: true,
  exports: async (url, init) => {
    const body = JSON.parse(init.body);
    const index = net.bodies.length;
    net.bodies.push(body);
    // 失败用**非 2xx**（不是 throw）：SDK 的重试逻辑看到 5xx 会继续重试，随机 throw 反而可能被内部吞掉
    // 只认"末尾是动态尾部块"或"末尾是重写指令块"这两种请求 = 主聊天流（侧链的末尾是它们自己的指令句）
    const lastMsg = String((body.messages || []).slice(-1)[0]?.content || '');
    const bodyText = JSON.stringify(body.messages || []);
    // 本轮主流程调用：末尾是动态尾部块**且**带本轮用户原文（needImage 追问虽然也带动态尾部块，
    // 但它的原文是提示词，不含本轮原文）
    const isOriginalMainCall = lastMsg.includes('</dynamic_context>') && (!net.mainMarker || bodyText.includes(net.mainMarker));
    const isRewriteCall = lastMsg.includes('<anti_repetition_rewrite>');
    const isMainFlow = isOriginalMainCall || isRewriteCall;
    // 主流程调用计数器：无论成功失败都要前进（脚本顺序与"第几次失败"都按它算）
    const mainCallNo = isMainFlow ? ++net.mainIndex : 0;
    if (net.failOn && mainCallNo === net.failOn) {
      return new Response(JSON.stringify({ error: { message: 'stub llm failure (reroll attempt)' } }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
    const scriptIndex = isMainFlow ? mainCallNo - 1 : 0;
    const raw = net.scripts[Math.min(scriptIndex, net.scripts.length - 1)];
    // 支持 { empty: true }：返回一个"合法但没有正文"的流 → 触发"重写产出为空"的失败分支
    const script = (raw && typeof raw === 'object') ? (raw.empty ? '' : String(raw.text || '')) : (raw || '');
    return new Response(sseBody(script), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  },
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
config.features.memory = false;
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const chatRoutes = (await import('../src/routes/chat.js')).default;

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api', chatRoutes);
const server = app.listen(0);
const port = server.address().port;
test.after(() => {
  server.close();
  if (realFetchModule) require.cache[nodeFetchPath] = realFetchModule;
  closeDb();
});

const REPEATED = '我真的很担心你呢这件事让我一直放不下心里总觉得不安';
const REWRITTEN = '对了，楼下那家新开的咖啡店今天买一送一，我刚给你带了一杯。';

/** 造角色 + 最近 4 轮都在复述同一件事（这样检测档位 = strong/escalated） */
function seedRepetition(conversationId) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt, short_prompt) VALUES (1, 'a', '角色A', '旅客', '旅客')").run();
  // 清干净：messages 有几张子表引用（memory_fragments / emotion_snapshots / image_tasks / user_portraits）
  const safe = sql => { try { db.prepare(sql).run(conversationId); } catch { /* 表可能还没被写过 */ } };
  safe('DELETE FROM memory_fragments WHERE conversation_id = ?');
  safe('DELETE FROM emotion_snapshots WHERE conversation_id = ?');
  safe('DELETE FROM messages WHERE conversation_id = ?');
  safe('DELETE FROM raw_messages WHERE conversation_id = ?');
  const insert = db.prepare("INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)");
  for (const marker of ['一', '二', '三', '四']) insert.run(conversationId, REPEATED + marker);
}

/** 发一轮聊天并收集 SSE 事件（eventName → 次数 / 数据） */
function postChat(characterId, message) {
  const body = JSON.stringify({ message });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/characters/' + characterId + '/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let buffer = '';
      const events = [];
      res.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const nameLine = frame.split('\n').find(l => l.startsWith('event: '));
          const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
          if (!nameLine) continue;
          let data = null;
          try { data = dataLine ? JSON.parse(dataLine.slice(6)) : null; } catch { data = null; }
          events.push({ event: nameLine.slice(7).trim(), data });
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * 只数**主聊天流**的请求。
 *
 * 不能只看"body 里有没有本轮原文"：侧链（候选词预测 / 配图判断 / needImage 追问）也会把最近对话
 * 塞进自己的 prompt，于是都命中。主聊天流的独有形状是**末尾一条 user 消息 = 带 </dynamic_context>
 * 的动态尾部块 + 本轮用户原文** —— 侧链的末尾是它们自己的指令句。
 */
const mainFlowBodies = marker => net.bodies.filter(b => {
  const last = (b.messages || []).slice(-1)[0];
  if (!last || last.role !== 'user') return false;
  const text = String(last.content);
  // 原始那一版：动态尾部块（</dynamic_context>）+ 本轮原文
  if (text.includes('</dynamic_context>') && text.includes(marker)) return true;
  // 重写那一版：最后一条 user = <anti_repetition_rewrite> 指令块，历史里带本轮原文
  if (text.includes('<anti_repetition_rewrite>')) return true;
  return false;
});

/** 给角色挂一个可用表情包：只写 DB（前端 url 就是 image_path），不碰磁盘 */
function seedEmoji(characterId, key, url) {
  const db = getDb();
  let set = db.prepare('SELECT id FROM emoji_sets WHERE character_id = ? AND is_active = 1 ORDER BY id LIMIT 1').get(characterId);
  if (!set) {
    const setId = Number(db.prepare("INSERT INTO emoji_sets (character_id, name, is_active) VALUES (?, '默认表情包', 1)").run(characterId).lastInsertRowid);
    set = { id: setId };
  }
  db.prepare('DELETE FROM character_emojis WHERE character_id = ? AND emoji_key = ?').run(characterId, key);
  db.prepare("INSERT INTO character_emojis (character_id, set_id, emoji_key, prompt, image_path, status) VALUES (?, ?, ?, '', ?, 'done')")
    .run(characterId, set.id, key, url);
  return url;
}

/** 每个用例开始前清一下打桩状态 */
function resetNet(marker) {
  net.bodies.length = 0;
  net.mainIndex = 0;
  net.mainMarker = marker || '';
  net.failOn = 0;
}

const names = events => events.map(e => e.event);
const countOf = (events, name) => names(events).filter(n => n === name).length;

test('开关关（默认）：只调用一次模型、不发 replace_last_assistant（逐字节零变化）', async () => {
  const conversationId = 'char_1';
  seedRepetition(conversationId);
  config.features.antiRepetitionReroll = false;
  net.scripts = [REPEATED, REWRITTEN];
  resetNet('关着时只发一次');

  const events = await postChat(1, '关着时只发一次');
  const main = mainFlowBodies('关着时只发一次');
  assert.equal(main.length, 1, '关着时主聊天流只能有一次模型调用');
  assert.equal(countOf(events, 'replace_last_assistant'), 0, '关着时不发替换事件');
  assert.ok(countOf(events, 'token') > 0, '原输出照常流式发出');
  assert.ok(!main[0].messages.some(m => String(m.content).includes('<anti_repetition_rewrite>')),
    '关着时不追加重写指令');
});

test('开关开 + 强档复读：追加一次重写调用，并发 replace_last_assistant（带 segments）', async () => {
  const conversationId = 'char_1';
  seedRepetition(conversationId);
  config.features.antiRepetitionReroll = true;
  // 重写那一版里带一个表情标记：验证事件里的 stickerUrls 就是**原始下发**的那个 url（前端只会渲染 url）
  const stickerUrl = seedEmoji(1, '开心', '/stickers/happy.png');
  const rewrittenWithSticker = REWRITTEN + '[开心]';
  net.scripts = [REPEATED, rewrittenWithSticker];
  resetNet('开着时重写一次');

  const events = await postChat(1, '开着时重写一次');
  const main = mainFlowBodies('开着时重写一次');
  assert.equal(main.length, 2, '开 + 强档 ⇒ 主聊天流恰好两次调用（原始 + 重写一次）');
  assert.ok(main[1].messages.some(m => String(m.content).includes('<anti_repetition_rewrite>')),
    '第二次请求必须带重写指令块');
  assert.equal(countOf(events, 'replace_last_assistant'), 1, '必须发一次替换事件');
  const replace = events.find(e => e.event === 'replace_last_assistant');
  assert.ok(replace.data.content.includes('咖啡店'), '替换内容是重写后的那一版');
  assert.ok(Array.isArray(replace.data.segments) && replace.data.segments.length > 0, 'segments 逐气泡给');
  assert.equal(replace.data.reason, 'reroll');
  assert.ok(typeof replace.data.turn === 'number' && replace.data.turn > 0);

  // 【本轮重点】渲染字段齐：stickerUrls 必须是**原始那条消息实际下发的 url**
  const tokenStickerUrls = events
    .filter(e => e.event === 'token' && Array.isArray(e.data.images))
    .flatMap(e => e.data.images)
    .filter(Boolean);
  assert.ok(tokenStickerUrls.includes(stickerUrl),
    '前提：原始下发（token.images）里确实有这张表情的 url = ' + stickerUrl + '，实际=' + JSON.stringify(tokenStickerUrls));
  const segWithSticker = replace.data.segments.find(s => s.stickerUrls && s.stickerUrls.length > 0);
  assert.ok(segWithSticker, '重写事件里必须有一个 segment 带 stickerUrls（不能只给 emojiKeys）');
  assert.deepEqual(segWithSticker.stickerUrls, [stickerUrl],
    'stickerUrls 必须与原始下发逐条一致（前端没有 key→url 映射，拿不到 url 就渲染不出表情）');
  assert.deepEqual(segWithSticker.emojiKeys, ['开心'], 'emojiKeys 与 stickerUrls 一一对应（顺序一致）');
  // images 与 stickerUrls 分开：没有普通图片时 images 为空数组（不污染语义）
  assert.ok(Array.isArray(segWithSticker.images), 'images 字段始终存在（可为空数组）');
  for (const seg of replace.data.segments) {
    assert.ok('content' in seg && 'emojiKeys' in seg && 'stickerUrls' in seg && 'images' in seg,
      '每个 segment 四个字段齐全：' + JSON.stringify(seg));
  }

  // 不连环：一轮只重写一次（主流程两次调用就是上限，不许出现第三次）
  assert.equal(main.length, 2, '绝不允许连环重写（主流程调用数必须是 2）');
});

test('重写失败：保留原输出、不发替换事件、整轮不失败', async () => {
  const conversationId = 'char_1';
  seedRepetition(conversationId);
  config.features.antiRepetitionReroll = true;
  // 重写那次返回"合法但空"的流 ⇒ 走"reroll produced no content"失败分支（确定、无重试噪声）
  net.scripts = [REPEATED, { empty: true }];
  resetNet('重写会失败');

  const events = await postChat(1, '重写会失败');
  assert.equal(countOf(events, 'replace_last_assistant'), 0, '重写失败绝不能替换（否则用户看到空）');
  const tokens = events.filter(e => e.event === 'token').map(e => e.data.content).join('');
  assert.ok(tokens.includes('担心'), '用户看到的仍是原输出');
  assert.equal(countOf(events, 'error'), 0, '整轮不许失败');
});

test('开关缺省（未设置）也不能触发（默认关）', async () => {
  const conversationId = 'char_1';
  seedRepetition(conversationId);
  delete config.features.antiRepetitionReroll;
  net.scripts = [REPEATED, REWRITTEN];
  resetNet('缺省即关');

  const events = await postChat(1, '缺省即关');
  assert.equal(mainFlowBodies('缺省即关').length, 1, '缺省即关');
  assert.equal(countOf(events, 'replace_last_assistant'), 0);
  config.features.antiRepetitionReroll = false;
});
