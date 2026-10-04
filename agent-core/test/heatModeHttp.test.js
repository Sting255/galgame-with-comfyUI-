/**
 * 发情模式 · HTTP 全链路（2026-10-02）
 *
 * 用户原话：「然后再在催眠手机里加一个选项 叫发情模式 角色的敏感度就会直接拉满」。
 * 前端面板（`web-ui/src/components/HypnosisPhonePanel.vue`）拨的开关就是这里的两条端点：
 *   GET  /api/characters/:id/heat   → 面板显示她现在有多敏感
 *   POST /api/characters/:id/heat   → { on: true|false } 开关
 *
 * ## 本文件钉住什么（都是为了不出现"测试全绿、真机坏掉"）
 * 1. **GET 与 POST 返回同一形状**（曾经 GET 给 `tier` 字符串、POST 给 `tier` 对象 ⇒
 *    前端读 `.label` 读到 undefined ⇒ 面板上显示 "undefined"）；
 * 2. 开 ⇒ 敏感度**真的**拉满 100 并落库（不是只在响应里写 100）；
 * 3. 关 ⇒ 回落到常态上沿（≤55），不能"关了还是满格"；
 * 4. 发情模式**不吃催眠门控**（与催眠无关：手机没催眠也要能拨）；
 * 5. 不存在的角色：写 404、读不炸。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';

const { getDb, closeDb } = await import('../src/db/index.js');
const routes = (await import('../src/routes/hypnosis.js')).default;

const app = express();
app.use(express.json());
// 与 src/app.js 同口径：本路由挂在 /api/characters 下（/:id/hypnosis*）
app.use('/api/characters', routes);
const server = http.createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

after(() => { server.close(); closeDb(); });

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
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const db = getDb();
db.pragma('foreign_keys = OFF');
const CID = 902;
db.prepare(`INSERT OR REPLACE INTO characters
  (id, name, display_name, base_prompt, short_prompt, sensitivity, sensitivity_updated_at, heat_mode, heat_until)
  VALUES (?, ?, ?, ?, ?, 30, NULL, 0, NULL)`)
  .run(CID, '发情测试', '发情测试', '你是发情测试用角色。', '发情测试');

/** 面板真正会读的字段（少一个就是 undefined 上屏） */
const HEAT_FIELDS = ['characterId', 'heat', 'value', 'tier', 'tierLabel', 'multiplier'];

test('① GET：形状完整、默认不是发情状态（前端拿同一段代码渲染 GET 与 POST）', async () => {
  const res = await api('GET', `/api/characters/${CID}/heat`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).filter(k => HEAT_FIELDS.includes(k)).sort(), [...HEAT_FIELDS].sort(),
    `GET 缺少字段 ⇒ 面板显示 undefined：${JSON.stringify(res.json)}`);
  assert.equal(res.json.characterId, CID);
  assert.equal(res.json.heat, false, '默认不是发情模式');
  assert.equal(typeof res.json.value, 'number');
  assert.equal(res.json.tier, 'normal', '30 点属于普通档');
  assert.equal(res.json.tierLabel, '普通');
  assert.equal(res.json.until, null, '没开时没有到点时间');
  // 面板喜欢拿它做文案；数值必须与库里一致
  assert.equal(res.json.value, 30);
});

test('② POST 开：敏感度真的拉满 100（落库 + 到点时间），且与 GET 同形状', async () => {
  const res = await api('POST', `/api/characters/${CID}/heat`, { on: true });
  assert.equal(res.status, 200);
  for (const k of HEAT_FIELDS) assert.ok(k in res.json, `POST 缺少字段 ${k}（与 GET 形状不一致）`);
  assert.equal(res.json.heat, true);
  assert.equal(res.json.value, 100, '发情模式 = 敏感度直接拉满');
  assert.equal(res.json.tier, 'extreme');
  assert.equal(res.json.tierLabel, '极度敏感');
  assert.equal(res.json.multiplier, 1.35, '拉满 ⇔ 增益倍率最高档');
  assert.ok(res.json.until && Number.isFinite(Date.parse(res.json.until)), `要有到点时间，实际 ${res.json.until}`);

  // 真的落库（不是只在响应里写 100）
  const row = db.prepare('SELECT sensitivity, heat_mode, heat_until FROM characters WHERE id = ?').get(CID);
  assert.equal(row.sensitivity, 100);
  assert.equal(row.heat_mode, 1);
  assert.ok(row.heat_until, '到点时间也要落库（否则过期判断没依据）');

  // 再读一次：形状与数值都必须一致（前端刷新时读的就是这一条）
  const again = await api('GET', `/api/characters/${CID}/heat`);
  assert.equal(again.json.heat, true);
  assert.equal(again.json.value, 100);
  assert.equal(again.json.tierLabel, '极度敏感', 'GET 也要给中文档位名');
  assert.ok(again.json.until, 'GET 要回到点时间（面板要显示"还有多久自然回落"）');
});

test('③ POST 关：回落到常态上沿（≤55），标志与到点时间都清掉', async () => {
  const res = await api('POST', `/api/characters/${CID}/heat`, { on: false });
  assert.equal(res.status, 200);
  assert.equal(res.json.heat, false);
  assert.ok(res.json.value <= 55, `关掉后不许还是满格，实际 ${res.json.value}`);
  assert.equal(res.json.until, null);
  const row = db.prepare('SELECT sensitivity, heat_mode, heat_until FROM characters WHERE id = ?').get(CID);
  assert.equal(row.heat_mode, 0);
  assert.equal(row.heat_until, null);
  assert.ok(row.sensitivity <= 55);
});

test('④ 不吃催眠门控：没催眠、没手机照样能拨（它是"她有多敏感"，不是催眠指令）', async () => {
  // 上面三次调用都在"角色从未被催眠过"的前提下成功 ⇒ 这里再显式钉一次语义
  const gate = await api('GET', `/api/characters/${CID}/hypnosis`);
  assert.equal(gate.status, 200);
  assert.equal(gate.json.active, false, '前提：她不在催眠中');
  const on = await api('POST', `/api/characters/${CID}/heat`, { on: true });
  assert.equal(on.status, 200, '不在催眠中也要能开发情模式');
  assert.equal(on.json.heat, true);
  await api('POST', `/api/characters/${CID}/heat`, { on: false });
});

test('⑤ 边界：不存在的角色 —— 写 404、读不炸（数值系统不许把面板打崩）', async () => {
  const write = await api('POST', '/api/characters/999999/heat', { on: true });
  assert.equal(write.status, 404);
  const read = await api('GET', '/api/characters/999999/heat');
  assert.equal(read.status, 200, '读路径不 404：面板拿得到"冷淡"这个正常结论');
  assert.equal(read.json.heat, false);
  assert.equal(read.json.value, 0);
  assert.equal(read.json.tierLabel, '冷淡');
});
