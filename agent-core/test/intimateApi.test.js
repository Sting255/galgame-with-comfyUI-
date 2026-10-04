import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
// 只放行本测试自己起的 express 服务，其余网络请求一律拒绝：看板不该有真实外部流量
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`intimate api fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const intimateRoutes = (await import('../src/routes/intimate.js')).default;

// 按落点挂载（与 app.js 一致）：/:id/intimate* 走 express 的 params 解析
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/characters', intimateRoutes);
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

function seedCharacter(t, name = 'lin') {
  const db = getDb();
  t.after(() => closeDb());
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, '旅客')`
  ).run(name, name);
  return Number(lastInsertRowid);
}

async function api(method, path, body) {
  const res = await realFetch(`http://127.0.0.1:${serverPort}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, payload: await res.json() };
}

// ──────────────── 面板 ────────────────

test('GET /api/characters/:id/intimate 返回冻结形状（档案 + 里程碑 + 统计 + 计数 + 回填）', async t => {
  const id = seedCharacter(t);
  const { status, payload } = await api('GET', `/api/characters/${id}/intimate`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(payload).sort(), ['backfill', 'characterId', 'counts', 'firsts', 'profile', 'stats']);
  assert.equal(payload.characterId, id);
  assert.deepEqual(payload.profile.aiEditFields, ['stats']);
  assert.deepEqual(payload.profile.viewScope, ['user', 'character']);
  assert.equal(payload.profile.backfillEnabled, true);
  assert.deepEqual(payload.stats.partnerKinds, ['user', 'character']);
  assert.deepEqual(payload.counts, { logs: 0, allLogs: 0 });
  assert.deepEqual(payload.backfill, {
    characterId: id, status: 'idle', lastRawId: 0, scanned: 0, inserted: 0, error: '', updatedAt: null,
  });

  assert.equal((await api('GET', '/api/characters/abc/intimate')).status, 400);
  assert.equal((await api('GET', '/api/characters/0/intimate')).status, 400);
  assert.equal((await api('GET', '/api/characters/-3/intimate')).status, 400);
});

// ──────────────── 档案 / 设置 ────────────────

test('PUT profile / settings / inject 写档案与开关，且白名单字段互不干扰', async t => {
  const id = seedCharacter(t);

  let res = await api('PUT', `/api/characters/${id}/intimate/profile`, {
    height: '168cm', bust: '88', waist: '58', hip: '90', cup: 'D', note: '肩颈怕痒',
    sensitiveZones: [{ key: 'neck', label: '颈侧', level: 3 }], injectEnabled: true,
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.profile.height, '168cm');
  assert.deepEqual(res.payload.profile.sensitiveZones, [{ key: 'neck', label: '颈侧', level: 3 }]);
  assert.equal(res.payload.profile.injectEnabled, true);
  assert.deepEqual(res.payload.profile.aiEditFields, ['stats'], '默认只放开统计');

  // settings 只动权限 / 口径 / 回填开关，不碰身体字段
  res = await api('PUT', `/api/characters/${id}/intimate/settings`, {
    aiEditFields: ['stats', 'body'], viewScope: ['user', 'character'], backfillEnabled: false,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.profile.aiEditFields, ['stats', 'body']);
  assert.deepEqual(res.payload.profile.viewScope, ['user', 'character']);
  assert.equal(res.payload.profile.backfillEnabled, false);
  assert.equal(res.payload.profile.height, '168cm');
  assert.deepEqual(res.payload.profile.sensitiveZones, [{ key: 'neck', label: '颈侧', level: 3 }]);

  // 口径是减法：清空勾选回落到默认口径（用户↔角色 + 角色↔角色），不允许"看到更多"
  res = await api('PUT', `/api/characters/${id}/intimate/settings`, { viewScope: [] });
  assert.deepEqual(res.payload.profile.viewScope, ['user', 'character']);

  res = await api('PUT', `/api/characters/${id}/intimate/inject`, { enabled: false });
  assert.equal(res.payload.profile.injectEnabled, false);
  assert.equal(res.payload.profile.height, '168cm');

  assert.equal((await api('PUT', '/api/characters/999999/intimate/profile', { height: 'x' })).status, 404);
  assert.equal((await api('PUT', '/api/characters/999999/intimate/settings', { aiEditFields: [] })).status, 404);
  assert.equal((await api('PUT', '/api/characters/999999/intimate/inject', { enabled: true })).status, 404);
});

// ──────────────── 记账 ────────────────

test('POST record：tags 与 prompt 两种入参、幂等、权限阻断，人工补录不受限', async t => {
  const id = seedCharacter(t);

  let res = await api('POST', `/api/characters/${id}/intimate/record`, {
    tags: ['creampie', 'missionary'], rawId: 501, scene: 'chat', partnerKind: 'user',
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.inserted, 1);
  assert.equal(res.payload.blocked, false);
  assert.deepEqual(res.payload.features, { intimate: true, intimateBackfill: true });

  // prompt 串走同一套拆解：权重包装不影响归类
  res = await api('POST', `/api/characters/${id}/intimate/record`, { prompt: '(Creampie:1.2), 1girl', rawId: 502 });
  assert.equal(res.status, 200);
  assert.equal(res.payload.inserted, 1);
  assert.deepEqual(res.payload.acts.map(a => a.actKey), ['vaginal']);

  // 同锚点重复调用不重复计数
  res = await api('POST', `/api/characters/${id}/intimate/record`, { prompt: '(Creampie:1.2), 1girl', rawId: 502 });
  assert.deepEqual({ inserted: res.payload.inserted, skipped: res.payload.skipped }, { inserted: 0, skipped: 1 });

  // classify 只归类不落库
  res = await api('POST', `/api/characters/${id}/intimate/classify`, { prompt: '(Deepthroat:1.3)' });
  assert.deepEqual(res.payload.acts, [{ actKey: 'oral', positionKey: '' }]);
  assert.deepEqual(res.payload.tags, ['deepthroat']);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log`)).payload.logs.length, 2);

  // 收回 stats 授权 → 自动路径整批阻断，人工补录仍能写
  await api('PUT', `/api/characters/${id}/intimate/settings`, { aiEditFields: ['body'] });
  res = await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['creampie'], rawId: 503 });
  assert.equal(res.status, 200);
  assert.deepEqual({ inserted: res.payload.inserted, blocked: res.payload.blocked }, { inserted: 0, blocked: true });
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log`)).payload.logs.length, 2);

  res = await api('POST', `/api/characters/${id}/intimate/log`, { actKey: 'climax', occurredAt: '2026-03-01T00:00:00.000Z' });
  assert.equal(res.status, 200);
  assert.equal(res.payload.inserted, 1);
  assert.equal(res.payload.logs.length, 3);
  assert.equal((await api('POST', '/api/characters/999999/intimate/record', { tags: ['creampie'] })).status, 404);
});

// ──────────────── 统计口径 ────────────────

test('口径过滤：viewScope 生效，partnerKinds 查询参数与 all 逃生门可用', async t => {
  const id = seedCharacter(t);
  await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['creampie'], rawId: 601, partnerKind: 'user' });
  await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['deepthroat'], rawId: 602, partnerKind: 'character', partnerId: 7 });
  await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['masturbation'], rawId: 603, partnerKind: 'self' });

  // 默认口径＝用户↔角色 + 角色↔角色（群聊默认可见；self 这类仍要显式勾）
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log`)).payload.logs.length, 2);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log?partnerKinds=character`)).payload.logs.length, 1);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log?partnerKinds=user,character`)).payload.logs.length, 2);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log?partnerKinds=all`)).payload.logs.length, 3);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log?partnerKinds=nope`)).payload.logs.length, 2);

  const panel = (await api('GET', `/api/characters/${id}/intimate?partnerKinds=all`)).payload;
  assert.equal(panel.stats.totalActs, 3);
  assert.deepEqual(panel.stats.partnerKinds, []);
  assert.deepEqual(panel.counts, { logs: 3, allLogs: 3 });

  // 档案口径生效：勾上角色维度后 user + character
  await api('PUT', `/api/characters/${id}/intimate/settings`, { viewScope: ['user', 'character'] });
  const scoped = (await api('GET', `/api/characters/${id}/intimate`)).payload;
  assert.deepEqual(scoped.stats.partnerKinds, ['user', 'character']);
  assert.equal(scoped.stats.totalActs, 2);
  assert.deepEqual(scoped.counts, { logs: 2, allLogs: 3 });

  // limit / offset
  const paged = (await api('GET', `/api/characters/${id}/intimate/log?partnerKinds=all&limit=2&offset=2`)).payload;
  assert.equal(paged.logs.length, 1);
});

// ──────────────── 里程碑 / 回滚 / 纠错 ────────────────

test('PUT firsts / POST rollback / DELETE log 与清空看板', async t => {
  const id = seedCharacter(t);
  await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['creampie'], rawId: 701 });

  let res = await api('PUT', `/api/characters/${id}/intimate/firsts/first_kiss`, {
    firstAt: '2025-12-24T00:00:00.000Z', note: '用户手改',
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.first.source, 'manual');

  res = await api('POST', `/api/characters/${id}/intimate/rollback`, { rawId: 701 });
  assert.equal(res.status, 200);
  assert.equal(res.payload.deleted, 1);
  assert.deepEqual(res.payload.characters, [id]);

  let panel = (await api('GET', `/api/characters/${id}/intimate`)).payload;
  assert.equal(panel.stats.totalActs, 0);
  assert.deepEqual(panel.firsts.map(f => f.actKey), ['first_kiss'], '人工里程碑不随回滚被清');

  assert.equal((await api('POST', `/api/characters/${id}/intimate/rollback`, { rawId: 0 })).status, 400);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/rollback`, {})).status, 400);

  // 人工补录 → 单条删除
  await api('POST', `/api/characters/${id}/intimate/log`, { actKey: 'climax' });
  const logId = (await api('GET', `/api/characters/${id}/intimate/log`)).payload.logs[0].id;
  assert.equal((await api('DELETE', `/api/characters/${id}/intimate/log/abc`)).status, 400);
  assert.equal((await api('DELETE', `/api/characters/${id}/intimate/log/999999`)).status, 404);
  res = await api('DELETE', `/api/characters/${id}/intimate/log/${logId}`);
  assert.equal(res.status, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.counts.allLogs, 0);

  // 清空看板：流水与里程碑清零，档案保留
  await api('POST', `/api/characters/${id}/intimate/log`, { actKey: 'climax' });
  res = await api('DELETE', `/api/characters/${id}/intimate`);
  assert.deepEqual(res.payload, { logs: 1, firsts: 2 });
  panel = (await api('GET', `/api/characters/${id}/intimate`)).payload;
  assert.equal(panel.counts.allLogs, 0);
  assert.deepEqual(panel.firsts, [], '清空看板连同里程碑一起清（身体档案保留）');
});

// ──────────────── 回填占位 + 总开关 ────────────────

test('回填接口（真引擎）与 features 总开关闸门（自动路径 409，人工路径照常）', async t => {
  const id = seedCharacter(t);

  // GET：真引擎状态。顶层平铺 + backfill 同一份；占位标记 placeholder 已随引擎接管删除
  let res = await api('GET', `/api/characters/${id}/intimate/backfill`);
  assert.equal(res.status, 200);
  assert.equal(res.payload.status, 'idle');
  assert.equal(res.payload.backfill.status, 'idle');
  assert.equal(res.payload.lastRawId, 0);
  assert.equal(res.payload.placeholder, undefined, '占位标记必须已被真实现取代');
  assert.deepEqual(res.payload.features, { intimate: true, intimateBackfill: true });

  // POST：真正启动回填。这个角色没有 raw_messages → 扫到表尾即 done
  res = await api('POST', `/api/characters/${id}/intimate/backfill`, {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.placeholder, undefined);
  assert.ok(['running', 'done'].includes(res.payload.status), '引擎后台推进，接口先返回 running');
  await new Promise(resolve => setImmediate(resolve)); // 让后台那一批跑完，下面才能确定断言
  const settled = await api('GET', `/api/characters/${id}/intimate/backfill`);
  assert.equal(settled.payload.status, 'done');
  assert.equal(settled.payload.scanned, 0);
  assert.equal(settled.payload.inserted, 0);
  // 进度进面板
  assert.equal((await api('GET', `/api/characters/${id}/intimate`)).payload.backfill.status, 'done');

  // reset 入口：只回退游标（不删流水），返回 idle
  res = await api('POST', `/api/characters/${id}/intimate/backfill/reset`, {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.status, 'idle');
  assert.equal(res.payload.lastRawId, 0);
  assert.equal(res.payload.scanned, 0);

  const savedFeatures = { ...config.features };
  t.after(() => Object.assign(config.features, savedFeatures));

  config.features.intimate = false;
  const blockedRecord = await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['creampie'], rawId: 901 });
  assert.equal(blockedRecord.status, 409);
  assert.equal(blockedRecord.payload.error, 'intimate feature disabled');
  assert.deepEqual(blockedRecord.payload.disabled, ['intimate']);
  const blockedBackfill = await api('POST', `/api/characters/${id}/intimate/backfill`, { status: 'idle' });
  assert.equal(blockedBackfill.status, 409);
  assert.deepEqual(blockedBackfill.payload.features, { intimate: false, intimateBackfill: true });

  // 人工路径一律不被总开关锁死
  assert.equal((await api('POST', `/api/characters/${id}/intimate/log`, { actKey: 'climax' })).status, 200);
  assert.equal((await api('PUT', `/api/characters/${id}/intimate/profile`, { height: '170cm' })).status, 200);
  assert.equal((await api('PUT', `/api/characters/${id}/intimate/settings`, { aiEditFields: ['stats'] })).status, 200);
  assert.equal((await api('GET', `/api/characters/${id}/intimate`)).status, 200);
  assert.equal((await api('GET', `/api/characters/${id}/intimate/log`)).status, 200);
  assert.equal((await api('DELETE', `/api/characters/${id}/intimate`)).status, 200);

  // 回填开关单独关闭：只拦回填启动
  config.features.intimate = true;
  config.features.intimateBackfill = false;
  const blockedBackfill2 = await api('POST', `/api/characters/${id}/intimate/backfill`, {});
  assert.equal(blockedBackfill2.status, 409);
  assert.deepEqual(blockedBackfill2.payload.disabled, ['intimateBackfill']);
  // reset 入口走同一闸门，别漏
  assert.equal((await api('POST', `/api/characters/${id}/intimate/backfill/reset`, {})).status, 409);
  assert.equal((await api('POST', `/api/characters/${id}/intimate/record`, { tags: ['creampie'], rawId: 902 })).status, 200);
});

// ──────────────── 回填真链路（HTTP 端到端，task-4） ────────────────

test('回填接口走真链路：历史 prompt 被补进流水，重复启动与重扫都不翻倍', async t => {
  const id = seedCharacter(t);
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO raw_messages (conversation_id, role, content, prompt) VALUES (?, 'assistant', ?, ?)`
  );
  ins.run(`char_${id}`, '(图片) {"prompt":"missionary, vaginal"}', 'missionary, vaginal'); // 命中：阴道 + 传教士体位
  ins.run(`char_${id}`, '今天天气不错', null);                                            // 没有 prompt：跳过
  ins.run(`char_${id}`, '(图片) {"prompt":"a cat on a table"}', 'a cat on a table');       // 有 prompt 无成人 tag：跳过
  ins.run(`char_${id}`, '(图片) {"prompt":"doggystyle, vaginal"}', null);                  // prompt 折在 content 里

  let res = await api('POST', `/api/characters/${id}/intimate/backfill`, {});
  assert.equal(res.status, 200);
  await new Promise(resolve => setImmediate(resolve)); // 等后台那一批跑完
  const state = (await api('GET', `/api/characters/${id}/intimate/backfill`)).payload;
  assert.equal(state.status, 'done');
  assert.equal(state.scanned, 4, '只数该角色私聊会话里的助手消息（含被跳过的）');
  assert.equal(state.inserted, 2, '第 1 条 1 个行为 + 第 4 条 1 个行为');

  const panel = (await api('GET', `/api/characters/${id}/intimate`)).payload;
  assert.equal(panel.stats.totalActs, 2);
  assert.equal(panel.counts.logs, 2);
  assert.equal(panel.firsts.find(f => f.actKey === 'vaginal').source, 'derived');

  // 再次启动：游标已在表尾，不重复计数
  await api('POST', `/api/characters/${id}/intimate/backfill`, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await api('GET', `/api/characters/${id}/intimate/backfill`)).payload.inserted, 2);
  assert.equal((await api('GET', `/api/characters/${id}/intimate`)).payload.stats.totalActs, 2);

  // ?reset=1：重置游标后重扫，靠 source_uid 去重，数字同样不翻倍
  const resetRes = await api('POST', `/api/characters/${id}/intimate/backfill?reset=1`, {});
  assert.equal(resetRes.status, 200);
  await new Promise(resolve => setImmediate(resolve));
  const afterReset = (await api('GET', `/api/characters/${id}/intimate/backfill`)).payload;
  assert.equal(afterReset.status, 'done');
  assert.equal(afterReset.scanned, 4, 'reset 之后确实从头重扫了');
  assert.equal(afterReset.inserted, 0, '重扫命中的都是同一批 raw_id');
  assert.equal((await api('GET', `/api/characters/${id}/intimate`)).payload.stats.totalActs, 2);
});

// ──────────────── 词表 ────────────────

test('GET vocabulary 返回行为分类与体位词表', async t => {
  const id = seedCharacter(t);
  const res = await api('GET', `/api/characters/${id}/intimate/vocabulary`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.payload.acts));
  assert.ok(res.payload.acts.some(a => a.key === 'vaginal' && a.label === '阴道'));
  assert.ok(Array.isArray(res.payload.positions) && res.payload.positions.length > 0);
  assert.equal((await api('GET', '/api/characters/abc/intimate/vocabulary')).status, 400);
});

// 挂载顺序是冻结契约的一部分（/:id 通配不能先吃掉 :id/intimate*）。
// 这里读 app.js 源码断言而不是 boot 整个 app：app.js 会拉起调度器让事件循环不退出，
// 不适合放进单测；路由本身的契约由上面的真实 HTTP 用例覆盖。
test('app.js 把 intimate 路由紧邻挂在 charactersRoutes 之前', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(source, /^import intimateRoutes from '\.\/src\/routes\/intimate\.js';$/m, '未 import intimate 路由');

  const INTIMATE = "app.use('/api/characters', wrapRouterAsync(intimateRoutes));";
  const CHARACTERS = "app.use('/api/characters', wrapRouterAsync(charactersRoutes));";
  const intimateAt = source.indexOf(INTIMATE);
  const charactersAt = source.indexOf(CHARACTERS);
  assert.ok(intimateAt >= 0, 'intimate 路由未挂载');
  assert.ok(charactersAt >= 0, 'characters 路由未挂载');
  assert.ok(intimateAt < charactersAt, 'intimate 必须早于 charactersRoutes 挂载');
  const between = source.slice(intimateAt + INTIMATE.length, charactersAt).replace(/\/\/[^\n]*/g, '').trim();
  assert.equal(between, '', '两者之间不应夹别的挂载');
});
