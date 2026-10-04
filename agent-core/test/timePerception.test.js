/**
 * 「角色此刻看到的时间」感知接口（`GET /api/time/perception`）—— 契约 + 同源 + 只读边界
 *
 * ## 用户原话
 * 「调时的选项设置页面还是太简陋了 而且不在其他的覆盖范围 需要把时间优先级调高
 *   让角色也感受时间 这样才像真实世界」
 *
 * ## 这个接口要证明的两件事
 *   1. **同源**：返回的 `timeTag` 就是注入 prompt 的那一行（`timeLight.getTimeTag()` 现算），
 *      前端不许自己拼、后端也不许拼第二份；偏移只加**一遍**（历史上 timeLight 犯过
 *      "日期用加一遍的值、时段标签用加两遍的值" 的双重偏移 bug，这里钉死不许复发）。
 *   2. **只读**：读一次感知不能改世界钟、不能写 `program_day_last_processed`、不能触发翻篇任务。
 *
 * 夹具与 `test/timeControl.test.js` 同口径：内存库 + 断网（对外 fetch 一律抛错）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// ── 夹具：临时库 + 断网 ────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let serverPort = 0;
process.env.DB_PATH = ':memory:';
process.env.LOG_TO_FILE = 'false';
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (serverPort && u.includes(`127.0.0.1:${serverPort}`)) return realFetch(url, opts);
  throw new Error(`time perception fixture forbids network: ${u}`);
};

const { config } = await import('../src/config.js');
config.dbPath = ':memory:';
const express = (await import('express')).default;
const { getDb, closeDb } = await import('../src/db/index.js');
const { wrapRouterAsync } = await import('../src/middleware/asyncHandler.js');
const timeRoutes = (await import('../src/routes/time.js')).default;
const { buildTimePerception } = await import('../src/routes/time.js');
const programTime = await import('../src/services/programTime.js');
const timeLight = await import('../src/services/timeLight.js');
const rollover = await import('../src/services/programDayRollover.js');
const mgr = await import('../src/services/scheduleManager.js');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/api/time', wrapRouterAsync(timeRoutes));
app.use('/api/schedule/time', wrapRouterAsync(timeRoutes));
const server = app.listen(0);
serverPort = server.address().port;
after(() => { server.close(); closeDb(); });

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

const { localDateKey, addDaysToKey, getProgramNow } = programTime;

/** 每个用例开始前把钟拨回真实时间（状态落 system_settings，会跨用例残留） */
function resetClock(t) {
  t.after(() => programTime.resetProgramTime());
  programTime.resetProgramTime();
}

/**
 * timeLight.LIGHT_MAP 的时段边界，在这里**独立复刻一份**用于交叉验算：
 * 断言"接口给的时段名"与"接口给的时刻"自洽 ⛔ 不能直接调 timeLight 的实现，
 * 否则两边同错也测不出来。
 */
function segmentOfClock(hhmm) {
  const hour = Number(String(hhmm).slice(0, 2));
  if (hour >= 0 && hour < 5) return '凌晨';
  if (hour >= 5 && hour < 7) return '清晨';
  if (hour >= 7 && hour < 12) return '上午';
  if (hour >= 12 && hour < 13) return '中午';
  if (hour >= 13 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19) return '傍晚';
  if (hour >= 19 && hour < 22) return '晚上';
  if (hour >= 22 && hour < 24) return '深夜';
  return '未知';
}

// ── 1. 契约形状 + prompt 同源 ─────────────────────────────────────────────

test('perception 形状：契约字段齐全，且 timeTag 就是注入 prompt 的那一行', async t => {
  resetClock(t);
  const res = await api('GET', '/api/time/perception');
  assert.equal(res.status, 200);
  const j = res.json;

  assert.equal(j.ok, true);
  for (const key of ['date', 'time', 'datetime', 'weekday', 'dayIndex', 'totalDays', 'period', 'phase',
    'epochDate', 'offsetMs', 'offsetDays', 'offsetHours', 'offsetMinutes', 'real',
    'timeTag', 'timeLightTag', 'lightText', 'season', 'periodText', 'lightOutdoor', 'lightIndoor',
    'weather', 'sharedClock', 'characters', 'source']) {
    assert.ok(Object.hasOwn(j, key), `感知快照缺少字段 ${key}`);
  }

  // ① 与 timeLight 现算的字符串同源（允许跨分钟：取请求前后两次）
  const tagBefore = timeLight.getTimeTag();
  const tagAfter = timeLight.getTimeTag();
  assert.ok([tagBefore, tagAfter].includes(j.timeTag),
    `timeTag 必须来自 timeLight.getTimeTag()：得到 ${j.timeTag}，现算 ${tagBefore} / ${tagAfter}`);
  assert.equal(j.timeLightTag, timeLight.getTimeLightTag());
  assert.equal(j.lightText, timeLight.getLightHint());
  assert.equal(j.source, 'timeLight.getTimeTag() / getTimeLightTag() / getLightHint()');

  // ② 无天气数据时，标签里的每个字段都能对回同一份世界钟（不是前端/后端自己拼的）
  assert.equal(j.weather, null, '内存库没有 weather_hourly 行 → 天气必须是 null，不许编造');
  assert.equal(j.timeTag, `[${j.date} ${j.weekday} ${j.time} | ${j.season}·${j.periodText}]`);

  // ③ 与世界钟其它接口同口径
  const clock = (await api('GET', '/api/time')).json;
  assert.equal(j.date, clock.date);
  assert.equal(j.time, clock.time);
  assert.equal(j.dayIndex, clock.dayIndex);
  assert.equal(j.period, clock.phase);

  // ④ 时段名与时刻自洽（8 段）
  assert.equal(j.periodText, segmentOfClock(j.time));
  assert.ok(j.timeTag.includes(`·${j.periodText}`), '标签里的时段要与 periodText 同一份');

  // ⑤ 角色摘要是数组（没有角色就是空数组，不是 null），条目形状固定
  assert.ok(Array.isArray(j.characters));
  assert.equal(j.sharedClock, true);
  for (const c of j.characters) {
    for (const key of ['id', 'name', 'awake', 'isSleeping', 'isTempWoken', 'sleepKind', 'activity', 'light', 'summary']) {
      assert.ok(Object.hasOwn(c, key), `角色条目缺少字段 ${key}`);
    }
    assert.equal(typeof c.summary, 'string');
    assert.ok(c.summary.length > 0);
  }
});

// ── 2. 偏移为 0：与真实时间一致，行为不变 ─────────────────────────────────

test('偏移 0 时行为不变：程序日期 = 真实日期，标签与真实时间同源', async t => {
  resetClock(t);
  const j = buildTimePerception();
  assert.equal(j.date, localDateKey(new Date()));
  assert.equal(j.offsetMs, 0);
  assert.equal(j.dayIndex, 1);
  assert.equal(j.totalDays, 0);
  assert.equal(j.real.date, localDateKey(new Date()));
  // 偏移 0 ⇒ 程序时间就是真实时间：现算标签（同一分钟内）必须一致
  const tag = timeLight.getTimeTag();
  const tagAlt = timeLight.getTimeTag(new Date());
  assert.ok([tag, tagAlt].includes(j.timeTag), `${j.timeTag} 应当等于 ${tag} / ${tagAlt}`);
});

// ── 3. 调时之后同源跟随 + 双重偏移回归 ────────────────────────────────────

test('调时后同源跟随：advance 1 天后标签里的日期就是新程序日期', async t => {
  resetClock(t);
  const start = localDateKey(new Date());
  const moved = await api('POST', '/api/time/advance', { days: 1 });
  assert.equal(moved.status, 200);

  const j = (await api('GET', '/api/time/perception')).json;
  assert.equal(j.date, addDaysToKey(start, 1));
  assert.equal(j.dayIndex, 2);
  assert.ok(j.timeTag.includes(j.date), 'prompt 同源串要跟着世界钟走');
  assert.ok(j.timeTag.includes(j.weekday));
  assert.ok(j.timeTag.includes(j.time), '标签里的时刻必须是程序时刻');
  // 与现算同源（同一分钟，允许跨分钟取两次）
  const a = timeLight.getTimeTag();
  const b = timeLight.getTimeTag();
  assert.ok([a, b].includes(j.timeTag), `timeTag 应当等于现算的 ${a} / ${b}`);
});

test('双重偏移回归：时段名必须与标签里的时刻同源（不许"08:56 配深夜"）', async t => {
  resetClock(t);
  // 拨到一个**非整数天**的墙上时间：offsetMs 会带上"小时+分钟"的零头，
  // 这正是当年 timeLight 双重偏移 bug 的暴露条件（日期读加一遍的值、时段读加两遍的值）。
  const set = await api('POST', '/api/time/set', { datetime: '2030-05-01 08:56' });
  assert.equal(set.status, 200);

  const j = (await api('GET', '/api/time/perception')).json;
  assert.equal(j.date, '2030-05-01', '日期是拨过去的墙上日期');
  assert.equal(Number(j.time.slice(0, 2)), 8, `程序时刻应当仍在 8 点档：${j.time}`);
  assert.equal(j.periodText, '上午', '8 点档的时段是「上午」；被加两遍偏移会落到别的时段');
  assert.equal(j.periodText, segmentOfClock(j.time), '时段名与同一份时刻自洽');
  assert.ok(j.timeTag.includes('| 春天·上午'), `标签应当是春天·上午：${j.timeTag}`);
  assert.equal(timeLight.getTimeLight().timeDesc, j.periodText, '与 timeLight 现算的时段一致');
});

test('双重偏移回归（反向）：把世界钟拨到深夜，白天/黑夜与时段都跟着走', async t => {
  resetClock(t);
  await api('POST', '/api/time/set', { datetime: '2030-05-01 23:30' });
  const j = (await api('GET', '/api/time/perception')).json;
  assert.equal(j.period, 'night');
  assert.equal(j.periodText, '深夜');
  assert.equal(Number(j.time.slice(0, 2)), 23);
  assert.ok(j.lightText.includes('深夜'), `光线描述应当提到深夜：${j.lightText}`);
});

// ── 4. 各角色摘要（她们此刻看到什么）──────────────────────────────────────

/** 夜间睡眠：22:00~07:45 睡，白天醒（与 timeControl.test.js 同一份夹具日程） */
const NIGHT = [
  { startTime: '07:45', endTime: '22:00', activity: '白天活动', location: '事务所', replyDelay: 0, tags: [], description: 'x' },
  { startTime: '22:00', endTime: '07:45', activity: '就寝安眠', location: '卧室', replyDelay: -1, tags: ['睡眠'], description: 'x' },
];

function seedSleepingCharacter() {
  const db = getDb();
  const info = db.prepare(
    'INSERT INTO characters (name, display_name, base_prompt, schedule_enabled) VALUES (?, ?, ?, 1)'
  ).run('tp_1', '夜猫子', '旅客');
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO schedule_templates (character_id, schedule_json) VALUES (?, ?)')
    .run(id, JSON.stringify(NIGHT));
  mgr.ensureTodaySchedule(id);
  return id;
}

test('角色摘要：同一口钟下，差异只在"睡/醒 + 在做什么"，睡觉时室内没有灯光', async t => {
  resetClock(t);

  // 先拨到深夜（22:00 之后 ⇒ 夹具角色在睡），再落角色与当日快照
  await api('POST', '/api/time/set', { datetime: '2030-05-01 23:10' });
  const id = seedSleepingCharacter();

  const night = (await api('GET', '/api/time/perception')).json;
  const slept = night.characters.find(c => c.id === id);
  assert.ok(slept, '角色必须出现在感知列表里');
  assert.equal(slept.name, '夜猫子');
  assert.equal(slept.isSleeping, true);
  assert.equal(slept.awake, false);
  assert.match(slept.light, /没有灯光/);
  assert.match(slept.summary, /睡觉/);
  // 所有人共用一口钟：角色条目里不带第二份时间串
  assert.ok(!Object.hasOwn(slept, 'timeTag'), '角色条目不许再放一份时间标签（同源只有一份）');

  // 拨到白天同一日期（12:00）⇒ 同一个角色应当醒着，并且带上她此刻在做的事
  await api('POST', '/api/time/set', { datetime: '2030-05-01 12:00' });
  const day = (await api('GET', '/api/time/perception')).json;
  const awake = day.characters.find(c => c.id === id);
  assert.equal(awake.isSleeping, false);
  assert.equal(awake.awake, true);
  assert.match(awake.summary, /醒着/);
  assert.match(awake.activity, /白天活动/);
  // 醒着时的室内光线口径**来自 timeLight**（同一份文案，不是路由自己写的第二份）
  assert.equal(awake.light, day.lightIndoor, `醒着的室内光线应等于接口的 lightIndoor：${awake.light}`);
  assert.notEqual(awake.light, slept.light, '睡 / 醒 的光线口径必须不同');
});

test('没有角色时 characters 是空数组，其它字段照常可用（空态不炸）', async t => {
  resetClock(t);
  // 内存库里清空角色表（含 seedData 的 default 助手）—— 只在本测试进程内，不碰真库
  getDb().exec('DELETE FROM characters');
  const j = buildTimePerception();
  assert.deepEqual(j.characters, []);
  assert.equal(typeof j.timeTag, 'string');
  assert.ok(j.timeTag.length > 0);
  assert.equal(j.ok, true);
  const viaHttp = (await api('GET', '/api/time/perception')).json;
  assert.deepEqual(viaHttp.characters, []);
});

// ── 5. 天气分支（有数据时标签里带天气，无数据时不许编）──────────────────────

test('天气：有 weather_hourly 数据时标签带天气；没有时 weather 为 null', async t => {
  resetClock(t);
  const db = getDb();
  const hour = getProgramNow().getHours();
  const key = `${String(hour).padStart(2, '0')}:00`;
  db.prepare('DELETE FROM weather_hourly WHERE weather_time = ?').run(key);
  t.after(() => db.prepare('DELETE FROM weather_hourly WHERE weather_time = ?').run(key));

  const noWeather = buildTimePerception();
  assert.equal(noWeather.weather, null);
  assert.ok(!noWeather.timeTag.includes('天气:'), `没数据时不许写天气：${noWeather.timeTag}`);

  db.prepare('INSERT OR REPLACE INTO weather_hourly (weather_time, weather_text, temperature, wind_speed) VALUES (?, ?, ?, ?)')
    .run(key, '多云', '挺热', '微风');

  const withWeather = buildTimePerception();
  assert.equal(withWeather.weather.text, '多云');
  assert.ok(withWeather.timeTag.includes('天气:多云、挺热'), `标签要带上天气：${withWeather.timeTag}`);
  assert.ok(withWeather.lightText.includes('多云'), `光线描述也要带上天气：${withWeather.lightText}`);
  // 仍然同源
  assert.equal(withWeather.timeTag, timeLight.getTimeTag());
});

// ── 6. 只读：不改钟、不写翻篇标记 ─────────────────────────────────────────

test('只读：读感知不改时钟状态、不写翻篇标记（不会顺手触发日常任务）', async t => {
  resetClock(t);
  await api('POST', '/api/time/advance', { days: 2 });
  rollover.setLastProcessedProgramDate('1999-01-01'); // 故意留一个"未翻篇"的标记

  const db = getDb();
  const before = db.prepare('SELECT setting_key, setting_value FROM system_settings ORDER BY setting_key').all();

  await api('GET', '/api/time/perception');
  await api('GET', '/api/time/perception');
  buildTimePerception();

  const after = db.prepare('SELECT setting_key, setting_value FROM system_settings ORDER BY setting_key').all();
  assert.deepEqual(after, before, '感知接口不许写任何 system_settings 行');
  assert.equal(rollover.getLastProcessedProgramDate(), '1999-01-01', '不许代替 tick 去落翻篇标记');
  const clock = (await api('GET', '/api/time')).json;
  assert.equal(clock.totalDays, 2, '世界钟没有被读操作挪动');
});

// ── 7. 开关与挂载点 ───────────────────────────────────────────────────────

test('总开关关闭：perception 与 /api/time 一样回 409 time control disabled', async t => {
  resetClock(t);
  const before = config.features.schedule;
  try {
    config.features.schedule = false;
    const res = await api('GET', '/api/time/perception');
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'time control disabled' });
    const clock = await api('GET', '/api/time');
    assert.equal(clock.status, 409, '读取口与写入口共用一个开关口径');
  } finally {
    config.features.schedule = before;
  }
  assert.equal((await api('GET', '/api/time/perception')).status, 200, '开关恢复后立刻可用');
});

test('旧挂载点同样可用：/api/schedule/time/perception 与 /api/time/perception 同形状', async t => {
  resetClock(t);
  const a = await api('GET', '/api/time/perception');
  const b = await api('GET', '/api/schedule/time/perception');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(Object.keys(b.json).sort(), Object.keys(a.json).sort());
  assert.equal(b.json.date, a.json.date);
  assert.equal(b.json.periodText, a.json.periodText);
});
