/**
 * AI 整理档案（intimate / ai-edit）真实 HTTP 联调测试
 *
 * 目的：`routes/intimateAiEdit.js` 与前端 `web-ui/src/api/intimate.js` /
 * `IntimatePanel.vue` 之间"字段名字对但层级错"是这类接口最容易翻车的点，
 * 所以这里**挂真实 express 路由、发真实 HTTP 请求**（不是直接调 service），
 * 再把响应原文喂给前端真实的纯逻辑层（intimateLogic.normalizeSuggestions /
 * aiEditResultText 与 api 层的 translateIntimateError）做契约交叉验证。
 *
 * 完全离线：globalThis.fetch 抛错挡网络；LLM 走 setLlmCallForTest 注入，绝不真调模型。
 * 覆盖：无素材 empty（且不调 LLM）/ 无 key 503 / 总开关 409 / 权限分流（applied vs pending）
 *      / accept 真写库 / reject 不写库 / 未知 sid 404 / 非法 id 400 / 角色不存在 404 / LLM 失败 502。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`ai-edit http fixture forbids network: ${url}`); };

const { config, getLlmConfig } = await import('../src/config.js');
config.dbPath = ':memory:';

const { getDb, closeDb } = await import('../src/db/index.js');
const intimate = await import('../src/services/intimateService.js');
const aiEdit = await import('../src/services/intimateAiEdit.js');
const aiEditRoutes = (await import('../src/routes/intimateAiEdit.js')).default;
const intimateRoutes = (await import('../src/routes/intimate.js')).default;
// 前端纯逻辑层（无依赖，文件头声明可被 node:test 直接引入）——用它校验后端响应形状
const logic = await import('../../web-ui/src/components/character/intimateLogic.js');
// 前端错误翻译在 api 层（intimate.js），面板的 409/503/404 中文提示全部来自它
const { translateIntimateError } = await import('../../web-ui/src/api/intimate.js');

// ── 真实 express 挂载（不用起完整 app.js）──

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

/** 真实 HTTP 请求（不能用 fetch：上面被挡死） */
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
        try { json = JSON.parse(text); } catch { /* 非 JSON 时保留原文供断言 */ }
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
function seedCharacter() {
  const db = getDb();
  const name = `aiedit_${++seedSeq}`;
  db.prepare(`INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '人格')`).run(name, name);
  return db.prepare('SELECT max(id) AS id FROM characters').get().id;
}

/** 造私聊素材：素材来源是 conversation_id = char_<id> 的 raw_messages */
function seedMaterial(characterId, contents = ['我今天量了身高，168cm', '好的，我记住了']) {
  const db = getDb();
  const conversationId = `char_${characterId}`;
  for (const content of contents) {
    db.prepare(`INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)`)
      .run(conversationId, 'user', content);
  }
}

/** 注入假 LLM，返回调用记录数组（用于断言"没有调 LLM"） */
function injectLlm(result) {
  const calls = [];
  aiEdit.setLlmCallForTest(async (messages, options) => {
    calls.push({ messages, options });
    return typeof result === 'function' ? result(messages, options) : result;
  });
  return calls;
}

/** 临时改 config.llm 并在测试结束后恢复（内存值，不落盘） */
function withLlmConfig(t, patch) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = config.llm[key];
    config.llm[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(saved)) config.llm[key] = value; });
}

/** 让"无 key"成为确定事实：先清内存 key，再确认 .env 兜底也没给 key */
function assertNoLlmKey() {
  assert.equal(getLlmConfig().hasApiKey, false,
    '前提不成立：当前环境配置了 LLM Key（内存或 .env），503 用例无法验证');
}

/**
 * 本机 `.env` 是否配了 LLM Key。
 *
 * `getLlmConfig()` 会**实时**读 `agent-core/.env`，所以一旦本机 `.env` 里配了 key，
 * "未配置 LLM"这条分支在进程内就**不可达**（`withLlmConfig` 只能改内存值）。
 * 这种环境差异不该报成回归，处理口径与 `intimateAiEdit.test.js` 里那条 503 用例一致：
 * 环境构造不出"未配置"状态时，改为源码级断言（闸门存在且早于调用 LLM，见本文件末尾的源码级用例），
 * 这里跳过而非失败。
 */
function llmKeyConfigured() {
  try { return getLlmConfig().hasApiKey !== false; } catch { return false; }
}

const suggestionRowKeys = ['id', 'field', 'fieldLabel', 'suggestion', 'currentValue', 'reason', 'status', 'createdAt'];

// ── 1. 列表接口：形状 + 空列表 ──

test('GET /intimate/ai-edit/suggestions → 200 { suggestions: [] }（顶层即数组，无多余包裹）', async () => {
  const id = seedCharacter();
  const res = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json), ['suggestions']);
  assert.ok(Array.isArray(res.json.suggestions));
  assert.equal(res.json.suggestions.length, 0);
});

// ── 2. 无素材：empty=true 且不调 LLM（规格路径：有 key 时）──

test('POST /intimate/ai-edit（有 key、无素材）→ 200 { applied:[], suggestions:[], empty:true } 且不调 LLM', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  const calls = injectLlm({ height: '170cm' });
  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200, `实际 ${res.status} ${res.text}`);
  assert.deepEqual(Object.keys(res.json).sort(), ['applied', 'empty', 'suggestions']);
  assert.deepEqual(res.json, { applied: [], suggestions: [], empty: true });
  assert.equal(calls.length, 0, '无素材时必须零 LLM 调用');
  // 前端文案（intimateLogic.aiEditResultText 读的就是 empty 这个顶层字段）
  assert.equal(logic.aiEditResultText(res.json), '最近的对话内容太少，暂时整理不出档案');
});

// ── 2b. 实测差异：无 key 时"无素材"分支不可达 ──

test('实测差异（报告用）：无 LLM Key + 无素材 → 仍返回 503，而非规格里的 empty:true', async t => {
  withLlmConfig(t, { apiKey: '', freeEgg: false });
  if (llmKeyConfigured()) { t.skip('本机 .env 已配置 LLM Key：503 分支在进程内不可达（闸门顺序见源码级用例）'); return; }
  const id = seedCharacter();
  const calls = injectLlm({ height: '170cm' });
  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  // 路由把 llmMissing 放在"取素材"之前，于是这条"本该 empty、不需要 LLM"的请求也吃 503。
  // 判定：与 task-12 规格（素材为空 → empty:true 且不调 LLM）不一致，但这是当前实际行为，已上报 lead。
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'llm not configured');
  assert.equal(calls.length, 0);
});

// ── 3. 无 LLM key：真 503 ──

test('POST /intimate/ai-edit（有素材 + 无 LLM Key）→ 503 { error: "llm not configured" }，与前端提示串一致', async t => {
  withLlmConfig(t, { apiKey: '', freeEgg: false });
  if (llmKeyConfigured()) { t.skip('本机 .env 已配置 LLM Key：503 分支在进程内不可达（闸门顺序见源码级用例）'); return; }
  const id = seedCharacter();
  seedMaterial(id); // 有素材也要被 key 闸门先拦住，说明闸门在"调模型"之前
  const calls = injectLlm({ height: '170cm' });
  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 503);
  assert.deepEqual(Object.keys(res.json), ['error']);
  assert.equal(res.json.error, 'llm not configured');
  assert.equal(calls.length, 0);
  assert.equal(translateIntimateError(503, res.json.error), '尚未配置 LLM，无法整理');
});

test('POST /intimate/ai-edit（角色不存在 + 无 key）→ 503 优先于 404（闸门顺序）', async t => {
  withLlmConfig(t, { apiKey: '', freeEgg: false });
  if (llmKeyConfigured()) { t.skip('本机 .env 已配置 LLM Key：503 分支在进程内不可达（闸门顺序见源码级用例）'); return; }
  const res = await api('POST', '/api/characters/999999/intimate/ai-edit', {});
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'llm not configured');
});

// ── 4. 总开关关闭：409（只拦 POST，列表仍可用）──

test('features.intimate=false → POST ai-edit 409 { error: "intimate feature disabled" }，列表不拦', async t => {
  const previous = config.features.intimate;
  config.features.intimate = false;
  t.after(() => { config.features.intimate = previous; });

  const id = seedCharacter();
  const post = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(post.status, 409);
  assert.equal(post.json.error, 'intimate feature disabled');
  assert.deepEqual(post.json.disabled, ['intimate']);
  assert.equal(post.json.features.intimate, false);
  assert.equal(translateIntimateError(409, post.json.error), '看板功能当前已关闭');

  // 关掉开关也要能看/清理已有提议，否则用户被锁死
  const list = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, { suggestions: [] });
});

// ── 5. 默认权限（只放开 stats）：全部字段只落 pending 提议 ──

test('默认 aiEditFields=[stats]：body/zones/note/firsts 全部只落 pending 提议，档案零改写', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  seedMaterial(id);
  const calls = injectLlm({
    height: '168cm', bust: '88cm', note: '左肩有旧伤',
    sensitiveZones: [{ key: 'neck', label: '脖颈', level: 4 }],
    firsts: [{ actKey: 'vaginal', firstAt: '2024-06-01' }],
  });

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, '有素材时应恰好调一次 LLM');
  assert.deepEqual(Object.keys(res.json).sort(), ['applied', 'empty', 'suggestions']);
  assert.deepEqual(res.json.applied, []);
  assert.equal(res.json.empty, false);
  assert.deepEqual(res.json.suggestions.map(row => row.field).sort(), ['body', 'firsts', 'note', 'sensitiveZones']);

  for (const row of res.json.suggestions) {
    for (const key of suggestionRowKeys) {
      assert.ok(key in row, `提议行缺字段 ${key}：${JSON.stringify(row)}`);
    }
    assert.equal(row.status, 'pending');
    assert.ok(row.fieldLabel, `fieldLabel 不能为空（前端直接显示中文名）：${JSON.stringify(row)}`);
    assert.equal(typeof row.suggestion, 'string', 'suggestion 应是可读预览串，不是 JSON 对象');
    assert.equal(typeof row.currentValue, 'string');
  }

  // 档案必须一个字都没改
  const profile = intimate.getBodyProfile(id);
  assert.equal(profile.height, '');
  assert.equal(profile.note, '');
  assert.deepEqual(profile.sensitiveZones, []);
  assert.deepEqual(intimate.listFirsts(id).filter(item => item.firstAt), []);

  // 前端拿真实响应做归一化：4 条 pending 都应被保留且有展示文本
  const normalized = logic.normalizeSuggestions(res.json.suggestions, { actLabels: { vaginal: '阴道' } });
  assert.equal(normalized.length, 4);
  assert.ok(normalized.every(row => row.fieldLabel && row.suggestionText.length > 0));
  assert.equal(logic.aiEditResultText(res.json), '有字段需要你确认，已放进待确认提议');

  // GET 列表能看到这 4 条，且形状与 POST 内嵌的 suggestions 一致
  const list = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.equal(list.status, 200);
  assert.equal(list.json.suggestions.length, 4);
  assert.deepEqual(Object.keys(list.json), ['suggestions']);
});

// ── 6. 权限分流：body 已授权 → 立即写入；note 未授权 → pending ──

test('aiEditFields=[body]：body 立即落库（applied），note 仍是 pending', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  seedMaterial(id);
  intimate.upsertBodyProfile(id, { aiEditFields: ['body'] });
  injectLlm({ height: '168cm', note: '左肩有旧伤' });

  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.applied, [{ field: 'body', value: { height: '168cm' } }]);
  assert.deepEqual(res.json.suggestions.map(row => row.field), ['note']);
  assert.equal(res.json.suggestions[0].status, 'pending');
  assert.equal(logic.aiEditResultText(res.json), '已更新 1 项档案');

  // 前端"采纳/整理后重新拉面板"读的是 GET /intimate 的顶层 profile（不能多包一层）
  const panel = await api('GET', `/api/characters/${id}/intimate`);
  assert.equal(panel.status, 200);
  assert.deepEqual(Object.keys(panel.json).sort(), ['backfill', 'characterId', 'counts', 'firsts', 'profile', 'stats']);
  assert.equal(panel.json.profile.height, '168cm');
  assert.equal(panel.json.profile.note, '');
  assert.deepEqual(panel.json.profile.aiEditFields, ['body']);
});

// ── 7. 采纳：真写库 + 幂等 ──

test('POST .../suggestions/:sid/accept → 200 { suggestion, applied }，档案真写入且重复采纳不重复写', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  seedMaterial(id);
  injectLlm({ note: '左肩有旧伤，冬天怕冷' });
  const proposed = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  const sid = proposed.json.suggestions[0].id;
  assert.ok(sid > 0);
  assert.equal(intimate.getBodyProfile(id).note, '');

  const accepted = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${sid}/accept`, {});
  assert.equal(accepted.status, 200);
  assert.deepEqual(Object.keys(accepted.json).sort(), ['applied', 'suggestion']);
  assert.equal(accepted.json.suggestion.status, 'accepted');
  assert.equal(accepted.json.suggestion.id, sid);
  assert.deepEqual(accepted.json.applied, { field: 'note', value: '左肩有旧伤，冬天怕冷' });

  const panel = await api('GET', `/api/characters/${id}/intimate`);
  assert.equal(panel.json.profile.note, '左肩有旧伤，冬天怕冷');

  // 幂等：再点一次不重复写（applied 为 null，状态保持 accepted）
  const again = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${sid}/accept`, {});
  assert.equal(again.status, 200);
  assert.equal(again.json.applied, null);
  assert.equal(again.json.suggestion.status, 'accepted');

  // 默认 pending 列表里已看不到它；status=accepted 时能看到（审计）
  const pending = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.deepEqual(pending.json.suggestions, []);
  const acceptedList = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions?status=accepted`);
  assert.equal(acceptedList.json.suggestions.length, 1);
});

// ── 8. 忽略：不写库 ──

test('POST .../suggestions/:sid/reject → 200 status=rejected，档案不动', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  seedMaterial(id);
  injectLlm({ note: '不应该被写入的备注' });
  const proposed = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  const sid = proposed.json.suggestions[0].id;

  const rejected = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/${sid}/reject`, {});
  assert.equal(rejected.status, 200);
  assert.deepEqual(Object.keys(rejected.json), ['suggestion']);
  assert.equal(rejected.json.suggestion.status, 'rejected');

  const panel = await api('GET', `/api/characters/${id}/intimate`);
  assert.equal(panel.json.profile.note, '', 'reject 绝不能写档案');
  const pending = await api('GET', `/api/characters/${id}/intimate/ai-edit/suggestions`);
  assert.deepEqual(pending.json.suggestions, []);
});

// ── 9. 404 / 400 ──

test('未知 sid → 404 { error: "suggestion not found" }（accept 与 reject 一致）', async () => {
  const id = seedCharacter();
  for (const action of ['accept', 'reject']) {
    const res = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/999999/${action}`, {});
    assert.equal(res.status, 404, `${action} 未命中应 404，实际 ${res.status} ${res.text}`);
    assert.equal(res.json.error, 'suggestion not found');
    assert.equal(translateIntimateError(404, res.json.error), '这条提议已不存在，可能已被处理过');
  }
});

test('非法 characterId / suggestionId → 400（不是 500）', async () => {
  const bad1 = await api('GET', '/api/characters/abc/intimate/ai-edit/suggestions');
  assert.equal(bad1.status, 400);
  assert.equal(bad1.json.error, 'invalid character id');

  const bad2 = await api('POST', '/api/characters/0/intimate/ai-edit', {});
  assert.equal(bad2.status, 400);
  assert.equal(bad2.json.error, 'invalid character id');

  const id = seedCharacter();
  const bad3 = await api('POST', `/api/characters/${id}/intimate/ai-edit/suggestions/0/accept`, {});
  assert.equal(bad3.status, 400);
  assert.equal(bad3.json.error, 'invalid suggestion id');
});

test('角色不存在（有 key 时）→ 404 { error: "character not found" }', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const res = await api('POST', '/api/characters/999999/intimate/ai-edit', {});
  assert.equal(res.status, 404, `实际 ${res.status} ${res.text}`);
  assert.equal(res.json.error, 'character not found');
  assert.equal(translateIntimateError(404, res.json.error), '角色不存在或已被删除');
});

// ── 10. LLM 失败：502 中文提示，不泄漏英文堆栈 ──

test('LLM 抛错 → 502 { error: "AI 整理失败：..." }（不是 500）', async t => {
  withLlmConfig(t, { apiKey: 'fixture-key', freeEgg: false });
  const id = seedCharacter();
  seedMaterial(id);
  injectLlm(() => { throw new Error('connect ETIMEDOUT'); });
  const res = await api('POST', `/api/characters/${id}/intimate/ai-edit`, {});
  assert.equal(res.status, 502);
  assert.match(res.json.error, /^AI 整理失败：/);
  assert.match(res.json.error, /ETIMEDOUT/);
});

// ── 11. 源码级闸门断言（task-17 第 3 条的离线兜底）──

test('源码级：自动路径必须过 isAiEditAllowed，applyField 只有"已授权"与"用户采纳"两个入口', () => {
  const src = fs.readFileSync(new URL('../src/services/intimateAiEdit.js', import.meta.url), 'utf8');
  // applyField：1 处定义 + 2 处调用（route 的已授权分支 / acceptSuggestion）
  assert.equal([...src.matchAll(/applyField\(/g)].length, 3);
  assert.match(src, /if \(isAiEditAllowed\(id, field\)\) \{/);
  // 提议落库与直接写入互斥：同一 route 内 else 分支才是 savePendingSuggestion
  const routeBody = src.slice(
    src.indexOf('const route = (field, payload, currentPayload) => {'),
    src.indexOf('if (Object.keys(edits.body).length > 0)'),
  );
  assert.ok(routeBody.includes('isAiEditAllowed(id, field)'), 'route 必须先判权限');
  assert.ok(routeBody.indexOf('isAiEditAllowed') < routeBody.indexOf('applyField'), '权限判定必须在写库之前');

  // 路由层闸门顺序：409（总开关）→ 503（无 key）→ service
  const routeSrc = fs.readFileSync(new URL('../src/routes/intimateAiEdit.js', import.meta.url), 'utf8');
  const post = routeSrc.slice(
    routeSrc.indexOf("router.post('/:id/intimate/ai-edit'"),
    routeSrc.indexOf('// POST /api/characters/:id/intimate/ai-edit/suggestions/:sid/accept'),
  );
  assert.ok(post.indexOf('featureDisabled(res)') < post.indexOf('llmMissing(res)'), '409 必须先于 503');
  assert.ok(post.indexOf('llmMissing(res)') < post.indexOf('proposeProfileEdits'), '503 必须挡在调模型之前');
});
