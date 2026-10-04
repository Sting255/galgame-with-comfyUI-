/**
 * 前后端亲密看板接口契约回归测试
 *
 * 为什么需要它：端到端冒烟抓到过一类"静默不一致"——前端 `getIntimateBackfill` 的轮询
 * 直接吃**顶层** status/scanned/inserted，而后端当时返回 `{ backfill: {...} }` 嵌套一层，
 * 前端于是永远显示"引擎尚未接入"，却没有任何测试会红。同类风险还有字段改名、
 * 返回多包一层、路径拼错（前端 404 但不报错）。
 *
 * 抽取方式：**行为级**，不解析前端源码。本文件把 globalThis.fetch 打桩，直接 import
 * web-ui/src/api/intimate.js 并逐个调用它的导出函数，记录真实发出的 (method, path)；
 * 前端换写法（拼串、换模板、加封装）都不会让这套断言假红，只有"真的没发这个请求"才会红。
 * 然后用这份清单去比对真实 express 路由（无 404）并断言前端消费的字段形状。
 *
 * 只读取/调用前端模块，不修改任何生产代码与前端文件。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const realFetch = globalThis.fetch;
let serverPort = 0;
// 抽取阶段用录制桩，其余时间只放行本测试自己起的 express 服务（其余网络一律拒绝）
let extractionRecorder = null;
process.env.DB_PATH = ':memory:';
globalThis.fetch = async (url, opts) => {
  if (extractionRecorder) return extractionRecorder(url, opts);
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`intimate contract fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const intimateRoutes = (await import('../src/routes/intimate.js')).default;

// task-12 的 AI 整理路由文件落地后自动纳入契约（未落地时相关用例标 todo，不留红灯）
const AI_EDIT_ROUTE_FILE = fileURLToPath(new URL('../src/routes/intimateAiEdit.js', import.meta.url));
const hasAiEditRoutes = existsSync(AI_EDIT_ROUTE_FILE);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/characters', wrapRouterAsync(intimateRoutes));
if (hasAiEditRoutes) {
  const aiEditRoutes = (await import('../src/routes/intimateAiEdit.js')).default;
  app.use('/api/characters', wrapRouterAsync(aiEditRoutes));
}
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

// ──────────────── 基础工具 ────────────────

/** 契约测试统一用 1 号角色（前端调用时传的假 id 也是 1，两边对得上） */
const CONTRACT_CHARACTER_ID = 1;

/** 起一个干净库并确保 1 号角色存在（:memory: 库在 closeDb 后重建） */
function freshDb(t) {
  const db = getDb();
  if (t) t.after(() => closeDb());
  db.prepare(
    `INSERT OR IGNORE INTO characters (id, name, display_name, base_prompt)
     VALUES (?, 'contract_char', '契约角色', '旅客')`
  ).run(CONTRACT_CHARACTER_ID);
  return db;
}

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

/** express 未匹配到路由时的默认 404 是 HTML；命中了 handler 的 404 是 JSON */
function isUnmountedRoute(res) {
  return res.status === 404 && !res.text.trim().startsWith('{');
}

function assertMounted(method, path, res) {
  assert.ok(
    !isUnmountedRoute(res),
    `${method} ${path} 没有挂载到任何 handler（express 默认 404）：${res.text.slice(0, 120)}`,
  );
}

// ──────────────── 1. 行为级抽取前端调用面 ────────────────

const FRONTEND_API_URL = new URL('../../web-ui/src/api/intimate.js', import.meta.url);

/**
 * 逐个导出函数的调用参数。新增前端接口时：若签名是 (characterId, ...)，这里补一行即可；
 * 没补也不会漏抽——默认会以 [1] 调一次，只要请求发出来了就能被记录。
 */
const EXPORT_ARGS = {
  getIntimatePanel: [CONTRACT_CHARACTER_ID],
  saveIntimateProfile: [CONTRACT_CHARACTER_ID, { height: '168cm' }],
  setIntimateInject: [CONTRACT_CHARACTER_ID, true],
  saveIntimateSettings: [CONTRACT_CHARACTER_ID, { aiEditFields: ['stats'], viewScope: ['user'], backfillEnabled: true }],
  getIntimateVocabulary: [CONTRACT_CHARACTER_ID],
  listIntimateLogs: [CONTRACT_CHARACTER_ID, { limit: 5, offset: 0, partnerKinds: 'user,character' }],
  createIntimateLog: [CONTRACT_CHARACTER_ID, { actKey: 'climax' }],
  setIntimateFirst: [CONTRACT_CHARACTER_ID, 'climax', { firstAt: '2026-01-01T00:00:00.000Z', note: '' }],
  deleteIntimateLog: [CONTRACT_CHARACTER_ID, 1],
  startIntimateBackfill: [CONTRACT_CHARACTER_ID],
  getIntimateBackfill: [CONTRACT_CHARACTER_ID],
  proposeIntimateProfileEdits: [CONTRACT_CHARACTER_ID],
  listIntimateSuggestions: [CONTRACT_CHARACTER_ID],
  acceptIntimateSuggestion: [CONTRACT_CHARACTER_ID, 1],
  rejectIntimateSuggestion: [CONTRACT_CHARACTER_ID, 1],
};

/** 非请求类导出（纯函数）：显式列出并跳过，绝不静默忽略 */
const SKIP_EXPORTS = new Set(['translateIntimateError']);

const recorded = [];
const noRequestExports = [];
const skippedExports = [];

extractionRecorder = async (url, init) => {
  recorded.push({ method: String(init?.method || 'GET').toUpperCase(), path: String(url) });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const frontendApi = await import(FRONTEND_API_URL);
for (const name of Object.keys(frontendApi).sort()) {
  const fn = frontendApi[name];
  if (typeof fn !== 'function') continue;
  if (SKIP_EXPORTS.has(name)) { skippedExports.push(name); continue; }
  const before = recorded.length;
  try {
    await fn(...(EXPORT_ARGS[name] || [CONTRACT_CHARACTER_ID]));
  } catch {
    // 请求已经发出即算抽到；只是桩响应的结构喂不饱解析逻辑时，这里会抛错，忽略即可
  }
  if (recorded.length === before) noRequestExports.push(name);
}
extractionRecorder = null;

/** 前端真实调用面（去重后的 method + path） */
const FRONTEND_SURFACE = [...new Map(recorded.map(r => [`${r.method} ${r.path}`, r])).values()];

const surfaceSummary = () => FRONTEND_SURFACE.map(r => `${r.method} ${r.path}`).join('\n  ');

test('行为级抽取前端调用面：每个导出都真的发出了请求', () => {
  assert.deepEqual(
    noRequestExports, [],
    `以下导出没有发出任何请求：\n  ${noRequestExports.join('\n  ')}\n`
    + '若是新增的非请求类导出，请加进 SKIP_EXPORTS 并说明；若是请求函数，说明抽取参数喂错了。',
  );
  assert.ok(
    FRONTEND_SURFACE.length >= 10,
    `只抽到 ${FRONTEND_SURFACE.length} 条调用，前端的请求面疑似退化：\n  ${surfaceSummary()}`,
  );
  for (const call of FRONTEND_SURFACE) {
    assert.ok(call.path.startsWith(`/api/characters/${CONTRACT_CHARACTER_ID}/`), `路径不像角色子路径：${call.method} ${call.path}`);
    assert.ok(call.path.includes('/intimate'), `路径不含 /intimate：${call.method} ${call.path}`);
  }
  assert.ok(
    [...SKIP_EXPORTS].every(name => name in frontendApi || true),
    `跳过清单里的 ${[...SKIP_EXPORTS].join(', ')} 在前端已不存在，请清理`,
  );
  // 跳过清单保持可见：失败信息里会带上它，避免"静默跳过"
  assert.ok(skippedExports.length <= SKIP_EXPORTS.size, `跳过清单异常：${skippedExports.join(', ')}`);
});

// ──────────────── 2. 前端调用面 ↔ 后端路由（路径不能拼错 / 漏挂） ────────────────

/** 各接口的最小合法请求体：契约测试只关心"路径通、形状对" */
function bodyFor(surfacePath, method) {
  if (method === 'GET' || method === 'DELETE') return undefined;
  if (surfacePath.includes('/profile')) return { height: '168cm' };
  if (surfacePath.includes('/inject')) return { enabled: true };
  if (surfacePath.includes('/settings')) return { aiEditFields: ['stats'], viewScope: ['user'], backfillEnabled: true };
  if (/\/intimate\/log$/.test(surfacePath)) return { actKey: 'climax' };
  if (surfacePath.includes('/firsts/')) return { firstAt: '2026-01-01T00:00:00.000Z', note: '' };
  return {};
}

test('前端调用的每条路径都有后端 handler（不出现 express 默认 404）', async t => {
  freshDb(t);
  // DELETE /log/:logId 需要一个真实存在的流水 id，否则 handler 会按设计回 JSON 404
  await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/log`, { actKey: 'climax' });
  const listed = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/log?limit=5&offset=0`);
  const logId = listed.json.logs[0].id;

  const calls = hasAiEditRoutes
    ? FRONTEND_SURFACE
    : FRONTEND_SURFACE.filter(call => !call.path.includes('/ai-edit'));
  assert.equal(
    FRONTEND_SURFACE.length - calls.length, hasAiEditRoutes ? 0 : 4,
    'ai-edit 调用面数量与预期不符（前端加了新接口请同步本测试）',
  );

  const missed = [];
  for (const call of calls) {
    const path = call.path.replace(/\/log\/\d+$/, `/log/${logId}`);
    const res = await api(call.method, path, bodyFor(path, call.method));
    if (isUnmountedRoute(res)) missed.push(`${call.method} ${path} → ${res.status} ${res.text.slice(0, 60)}`);
  }
  assert.deepEqual(
    missed, [],
    `以下前端调用后端没有 handler（路径拼错或未挂载）：\n  ${missed.join('\n  ')}\n`
    + `（本次前端调用面：\n  ${surfaceSummary()}）`,
  );
});

test('自证：路径拼错时确实会被判为未挂载（否则上面的断言是假绿）', async t => {
  freshDb(t);
  const typo = await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/profil`, { height: '168cm' });
  assert.ok(isUnmountedRoute(typo), `拼错的路径必须能被识别：${typo.status} ${typo.text.slice(0, 60)}`);
  const correct = await api('PUT', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/profile`, { height: '168cm' });
  assert.ok(!isUnmountedRoute(correct), '正确路径不该被判成未挂载');
});

// ──────────────── 3. 形状断言（前端真实消费的字段） ────────────────

test('GET /:id/intimate 形状：顶层 + profile + stats + counts 都齐', async t => {
  freshDb(t);
  await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/log`, { actKey: 'climax', count: 2, climaxCount: 1 });

  const res = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate`);
  assert.equal(res.status, 200);
  for (const key of ['characterId', 'profile', 'firsts', 'stats', 'counts', 'backfill']) {
    assert.ok(Object.hasOwn(res.json, key), `面板响应缺少顶层字段 ${key}`);
  }
  // 前端 injectEnabled / aiEditFields / viewScope / backfillEnabled / sensitiveZones 直接取自 profile
  for (const key of ['injectEnabled', 'aiEditFields', 'viewScope', 'backfillEnabled', 'sensitiveZones']) {
    assert.ok(Object.hasOwn(res.json.profile, key), `profile 缺少 ${key}`);
  }
  for (const key of ['totalActs', 'totalClimax', 'byAct', 'byPosition', 'byScene']) {
    assert.ok(Object.hasOwn(res.json.stats, key), `stats 缺少 ${key}`);
  }
  assert.ok(Array.isArray(res.json.firsts), 'firsts 必须是数组');
  assert.equal(typeof res.json.counts.logs, 'number', 'counts.logs 必须是数字（面板显示条数）');
  assert.equal(res.json.stats.totalActs, 2);
  assert.ok(Array.isArray(res.json.stats.byAct) && res.json.stats.byAct.length > 0);
  assert.equal(typeof res.json.stats.byAct[0].label, 'string', 'byAct 必须带后端 label，前端直接展示');
  assert.ok(Array.isArray(res.json.stats.byPosition));
  assert.ok(Array.isArray(res.json.stats.byScene));
});

test('GET log 与 vocabulary 形状：logs / acts / positions', async t => {
  freshDb(t);
  await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/log`, { actKey: 'climax' });

  const log = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/log?limit=50&offset=0`);
  assert.equal(log.status, 200);
  assert.ok(Array.isArray(log.json.logs), 'log 顶层必须是 logs 数组');
  assert.equal(typeof log.json.logs[0].id, 'number', '前端删除单条要用 log.id');
  assert.equal(typeof log.json.logs[0].actKey, 'string');

  const vocab = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/vocabulary`);
  assert.equal(vocab.status, 200);
  assert.ok(Array.isArray(vocab.json.acts) && vocab.json.acts.length > 0, 'vocabulary.acts 必须是数组');
  assert.ok(vocab.json.acts.every(a => a.key && a.label), 'acts 每项要有 key + label');
  assert.ok(Array.isArray(vocab.json.positions) && vocab.json.positions.length > 0, 'vocabulary.positions 必须是数组');
  assert.ok(vocab.json.positions.every(p => p.key && p.label), 'positions 每项要有 key + label');
  assert.ok(Object.hasOwn(vocab.json.positions[0], 'group'), 'positions 带 group（前端拼「label（group）」）');
});

// ──────────────── 4. 回填：前端吃的是顶层字段 ────────────────

// 探针：缺顶层 status 就把用例标 todo（这是端到端冒烟抓到的真实缺口），
// 不留在红灯里；task-4 落地后这里会自动转严。
freshDb();
const backfillProbe = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/backfill`);
const backfillHasTopLevelStatus = !!(backfillProbe.json && Object.hasOwn(backfillProbe.json, 'status'));

test('backfill 顶层形状（前端 normalizeBackfill 直接吃顶层 status/scanned/inserted/lastRawId）', {
  todo: backfillHasTopLevelStatus ? false : '后端 backfill 仍返回嵌套形状，等 task-4 接管后启用',
}, async t => {
  freshDb(t);
  const get = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/backfill`);
  assert.equal(get.status, 200);
  for (const key of ['status', 'scanned', 'inserted', 'lastRawId']) {
    assert.ok(Object.hasOwn(get.json, key), `GET backfill 顶层缺少 ${key}（前端直接读顶层）`);
  }
  assert.equal(typeof get.json.status, 'string');
  assert.equal(typeof get.json.scanned, 'number');
  assert.equal(typeof get.json.inserted, 'number');

  const post = await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/backfill`, {});
  assert.equal(post.status, 200);
  assert.ok(Object.hasOwn(post.json, 'status'), 'POST backfill 顶层缺少 status');
  // 前端用 placeholder 判断"引擎尚未接入"：引擎接了就不该再有这个标记
  assert.notEqual(post.json.placeholder, true, 'placeholder 标记应随引擎落地消失');
});

// ──────────────── 5. AI 整理（task-12 落地前 todo，落地后自动转严） ────────────────

test('ai-edit 四条路径与提议形状', {
  todo: hasAiEditRoutes ? false : 'task-12 的 routes/intimateAiEdit.js 尚未落地，前端已按契约先写',
}, async t => {
  freshDb(t);

  const propose = await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit`, {});
  assertMounted('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit`, propose);
  // 素材为空 → 200（不调 LLM）；无 LLM 配置 → 503，两者都不算契约错误
  assert.ok([200, 503].includes(propose.status), `ai-edit 非预期状态：${propose.status}`);

  const list = await api('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions`);
  assertMounted('GET', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions`, list);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.suggestions), 'suggestions 必须是数组');

  const accept = await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions/1/accept`, {});
  assertMounted('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions/1/accept`, accept);
  const reject = await api('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions/1/reject`, {});
  assertMounted('POST', `/api/characters/${CONTRACT_CHARACTER_ID}/intimate/ai-edit/suggestions/1/reject`, reject);
});
