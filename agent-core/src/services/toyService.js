/**
 * toyService.js —— 成人玩具系统（专题-玩具系统与真机反馈三期 §二）
 *
 * 定位：**「佩戴状态」= 一行 + 「每轮状态注入块」+「摘戴反应调用」**，全部复用既有机制：
 *   · 表 character_worn_toys（db/index.js 的 migrateWornToysSchema，幂等建表）；
 *   · 门控**复用触摸系统**的 getTouchGate（门槛/文案/催眠豁免/群聊口径一套，不另造）；
 *   · 注入块格式照 <hypnosis_state> 的写法（分档指引写在块内，让模型照着演）。
 *
 * 文件边界：只限成年角色档案（与 touchActionService 文件头同口径）。
 * 依赖：**只 import 不改** touchActionService（hypno-core 正在改它）。
 *
 * ── 2026-10-02 玩法扩充（用户原话「玩具玩法有点太少了」）────────────────────────
 * 三类机制 + 一条她自己的主动性，代码位置与边界写在这里（省得下一个人到处找）：
 *   ① 清单加厚：`./toy/catalog.js`（新增 6 件，不同部位/刺激类型；**首期 5 件留在本文件 TOYS 不动**，
 *      因为 TOY_KEYS 的顺序与内容被既有测试逐项钉住）；
 *   ② 组合佩戴 / ③ 振动模式 / ④ 强度曲线：`./toy/mechanics.js`（纯函数，可注入假时钟）；
 *   ⑤ 她自己主动玩：`./toy/selfPlay.js`（判断路径 + 独立 prompt 块），本文件只做 DB 与上下文的接线。
 * **兼容口径**：`TOY_KEYS` 仍是首期 5 件；`getToy()` 认识全部 11 件；新增列一律走本文件
 * 懒建的两张玩法状态表（`toy_play_state` / `toy_self_play_log`），**不改 characters_worn_toys 的列**。
 */

import { getDb } from '../db/index.js';
// 2026-10-01 修：`generateToyImageForReaction` 里读了 config.features.toyImageMode / touchImageMode，
// 但这个模块**从来没 import 过 config** ⇒ 每次都抛 `config is not defined`，被下面那个
// 「出图异常（不影响穿戴）」的 catch 吞掉 —— 用户真机日志里 31 次那条警告就是它，
// 表现是「玩具怎么都配不出图」，而且因为是 warn，界面上什么提示都没有。
import { config } from '../config.js';
import { getTouchAction, TOUCH_LEVELS, DEFAULT_TOUCH_THRESHOLDS } from './touchActionService.js';
import { generateImage } from './imageSkill.js';
import { saveBase64Image } from './imagePaths.js';
import { buildCharacterAppearanceSection, buildCharacterPersona } from './characterPersona.js';
import { charArtistOverride } from './characterImageOpts.js';
import { invalidateGalleryCache } from './galleryCache.js';
// 2026-10-02：玩具 → 亲密刺激统一下游（敏感条 / 心情 / 记忆）。用户原话：
// 「现在的玩具和催眠和心情和记忆好像是完全解耦的一样 根本就没关联」。
import { applyIntimateStimulus } from './intimateStimulus.js';
// 2026-10-02：把"她身上戴着什么"登记给**生图唯一入口**（characterPersona）——
// 用户原话：「如果戴上玩具之后 没有摘下的情况下 在其他的地方出图也得要看到玩具的所在…
// 就算角色戴着玩具 但是就是没有出来玩具的图 这个是很不真实的」。
// 走注册表叶子是为了**不成环**（本文件本来就 import characterPersona，反过来 import 就循环了）。
import { registerWornToysProvider } from './wornToysBrief.js';
import { broadcastProactiveMessage } from './notificationBus.js';
import { broadcast } from './unifiedStreamBus.js';
// 2026-10-03 群聊 bug 修复：反应写在**哪里聊天就在哪里**（两条链与 touch / 亲密共用同一份口径）——
// `writeGroupInsertMessage` 是群聊插入式发言的唯一写入器，`reactionImageUpdate` 是补图事件名的唯一来源。
// 两个都是叶子模块（只依赖 db），不会与本模块形成循环。
import { writeGroupInsertMessage } from './groupInsertMessage.js';
import { reactionImageUpdate } from './reactionImageUpdate.js';
// ── 2026-10-02 玩法扩充：清单 / 机制 / 主动性三条线各自一个文件（依赖方向单向：本文件 → 它们）──
import { EXTRA_TOYS, EXTRA_TOY_KEYS, STIMULUS_KINDS, stimulusOf, daringOf } from './toy/catalog.js';
import { buildImagePromptRuleBlock } from '../builtinRules.js';
import {
  VIBRATION_MODES, VIBRATION_MODE_KEYS, DEFAULT_VIBRATION_MODE, isVibrationMode, normalizeMode, modeLabel, modeMeta, modePhase,
  INTENSITY_CURVES, INTENSITY_CURVE_KEYS, isIntensityCurveType, normalizeCurve, curveLabel, curveTargetAt,
  curveProgress, curveRemainingSec, curveFinished, comboEffects, comboRuleMatches, COMBO_RULES, evaluateToyPlay, seedOf, hash01,
} from './toy/mechanics.js';
import {
  SELF_PLAY_THRESHOLDS, SELF_PLAY_CODES, lewdnessScore, decideSelfPlay, buildSelfPlayPrompt, parseSelfPlayOutput,
  buildSelfPlayBlock, MAX_SELF_PLAY_BLOCK_CHARS,
} from './toy/selfPlay.js';

/** 首期 5 种（§2.1）。level 是**门控档**：敏感三件套随 Lv4，乳夹随 Lv3，项圈随 Lv3 但不要求亲密授权。 */
export const TOY_KEYS = Object.freeze(['vibe_egg', 'vibe_stick', 'anal_plug', 'nipple_clamp', 'collar']);

const TOYS = Object.freeze({
  vibe_egg: {
    key: 'vibe_egg', label: '跳蛋', part: '阴蒂', partSection: '阴蒂（塞入内裤贴合）',
    maxIntensity: 5, level: TOUCH_LEVELS.EXPLICIT, gateActionKey: 'touch_clit',
    requiresIntimateAuth: true, intensityKind: 'vibration', stimulus: 'vibration', daring: 4,
    desc: '无线遥控的小跳蛋，贴着阴蒂',
    effect: '贴着阴蒂一直震：写她坐姿发僵、腿根夹紧，句子被震得一顿一顿',
  },
  vibe_stick: {
    key: 'vibe_stick', label: '振动棒', part: '阴道', partSection: '阴道（插入）',
    maxIntensity: 5, level: TOUCH_LEVELS.EXPLICIT, gateActionKey: 'finger_insert',
    requiresIntimateAuth: true, intensityKind: 'vibration', stimulus: 'vibration', daring: 4,
    desc: '插入体内的振动棒，会影响走路与坐姿',
    effect: '体内被撑开又被震：写她走路变慢、坐下时不敢坐实、腰一软就扶住旁边',
  },
  anal_plug: {
    key: 'anal_plug', label: '肛塞', part: '后庭', partSection: '后庭（插入，可带尾巴款）',
    maxIntensity: 3, level: TOUCH_LEVELS.EXPLICIT, gateActionKey: 'touch_pussy',
    requiresIntimateAuth: true, intensityKind: 'vibration', stimulus: 'vibration', daring: 4,
    desc: '塞住后庭的肛塞，静置款强度为 0',
    effect: '后庭被塞满的胀感：写她坐着时重心偏一边、被顶到时呼吸一抖，走路时下意识夹紧',
  },
  nipple_clamp: {
    key: 'nipple_clamp', label: '乳夹', part: '乳头', partSection: '乳头（夹住）',
    maxIntensity: 3, level: TOUCH_LEVELS.SENSITIVE, gateActionKey: 'touch_breast',
    requiresIntimateAuth: true, intensityKind: 'clamp', stimulus: 'clamp', daring: 3,
    desc: '夹在乳尖上的乳夹，强度=松紧',
    effect: '乳尖被夹住的钝痛与麻：写她含胸、手臂挡在胸前，动作一大就被扯得吸气',
  },
  collar: {
    key: 'collar', label: '项圈', part: '颈部', partSection: '颈部（象征物）',
    maxIntensity: 0, level: TOUCH_LEVELS.SENSITIVE, gateActionKey: 'touch_breast',
    requiresIntimateAuth: false, intensityKind: 'symbolic', stimulus: 'symbolic', daring: 1,
    desc: '扣在颈上的项圈，不涉器官，象征归属',
    effect: '脖子上那一圈的存在感：写她下意识去摸它、被提到时就安静下来，更顺从',
  },
});

/** 全部玩具（首期 5 + 第二批 6）。**清单顺序 = TOY_KEYS 在前**，便于 UI 与测试复算。 */
const ALL_TOYS = Object.freeze({ ...TOYS, ...EXTRA_TOYS });

/** 全部玩具 key（第二批在此，**首期 TOY_KEYS 不动** ⇒ 旧测试与旧编码全兼容） */
export const ALL_TOY_KEYS = Object.freeze([...TOY_KEYS, ...EXTRA_TOY_KEYS]);

export function getToy(toyKey) {
  return ALL_TOYS[toyKey] || null;
}

/** 首期 5 件（**旧契约**：`GET /toys` 的 available、force_toy 枚举、旧测试都吃这一份，别改） */
export function listToys() {
  return TOY_KEYS.map(key => TOYS[key]);
}

/** 全部 11 件（面板 / 她主动挑玩具时用） */
export function listAllToys() {
  return ALL_TOY_KEYS.map(key => ALL_TOYS[key]);
}

/** 她主动挑玩具的顺序：大胆度升序（淫乱度越高越敢往后挑） */
export function selfPlayPickOrder() {
  return [...ALL_TOY_KEYS].sort((a, b) => daringOf(ALL_TOYS[a]) - daringOf(ALL_TOYS[b]));
}

// 机制 / 清单的再导出：调用方（路由、测试、脚本）只认本模块这一个入口，别各自去 import 子文件。
export {
  STIMULUS_KINDS, stimulusOf, daringOf,
  VIBRATION_MODES, VIBRATION_MODE_KEYS, DEFAULT_VIBRATION_MODE, isVibrationMode, normalizeMode, modeLabel, modeMeta,
  INTENSITY_CURVES, INTENSITY_CURVE_KEYS, isIntensityCurveType, normalizeCurve, curveLabel, curveTargetAt,
  curveProgress, curveRemainingSec, curveFinished, comboEffects, comboRuleMatches, COMBO_RULES, evaluateToyPlay, seedOf, hash01,
  modePhase,
  SELF_PLAY_THRESHOLDS, SELF_PLAY_CODES, lewdnessScore, decideSelfPlay, buildSelfPlayPrompt, parseSelfPlayOutput,
  buildSelfPlayBlock, MAX_SELF_PLAY_BLOCK_CHARS,
};

/** 她自己玩过之后，注入块保留多久（分钟）：太久会变成"她一直在玩"，太短则模型接不上 */
export const SELF_PLAY_BLOCK_TTL_MIN = 15;
/** 判定窗口：同一个 10 分钟窗口内不重复掷骰（她的决定对同一段状态是**可复算**的，测试才钉得住） */
export const SELF_PLAY_WINDOW_MS = 10 * 60 * 1000;

// ── 门控（§2.4）────────────────────────────────────────────────────────────

/**
 * 装上门控：**要她愿意（好感/誓约/授权）或催眠中**。
 *
 * 实现上直接复用触摸系统的 getTouchGate（同一个门槛对象、同一套拒绝文案、同一套催眠豁免与群聊口径），
 * 只对**项圈**放开一处：它是象征物（不涉器官）⇒ 不要求亲密看板授权。
 *
 * @param {{toyKey:string, affinity?:number, isOath?:boolean, hypnotized?:boolean, sleeping?:boolean,
 *          intimateAuthorized?:boolean, scene?:'chat'|'group', allowGroupAdult?:boolean,
 *          thresholds?:object}} args
 * @returns {{allowed:boolean, code:string, message:string, level:number|null, exempt:string|null,
 *           wakesOnIntensity:boolean, toy:object|null}}
 */
export function gateToy({
  toyKey,
  // 以下入参**保留**是为了不改所有调用点与测试的签名；门控取消后它们不再参与判定。
  affinity = 0,
  isOath = false,
  hypnotized = false,
  sleeping = false,
  intimateAuthorized = false,
  scene = 'chat',
  allowGroupAdult = false,
  thresholds = DEFAULT_TOUCH_THRESHOLDS,
} = {}) {
  const toy = getToy(toyKey);
  if (!toy) {
    return {
      allowed: false, code: 'unknown_toy', reason: 'unknown_toy', message: '没有这种玩具。',
      level: null, exempt: null, wakesOnIntensity: false, toy: null,
    };
  }
  // 睡着**不拦装上**（§2.4：可装（轻柔））——「调高强度会弄醒她」仍记在 wakesOnIntensity 上，
  // 由 set-intensity 的调用方消费。那不是"限制"，是游戏反馈，**保留**。
  const wakesOnIntensity = Boolean(sleeping && toy.maxIntensity > 0);

  // ══ 2026-10-04 用户裁决：「**玩具的限制全删**」 ══
  // 原实现是把玩具当成一个动作去过 `getTouchGate`（好感/誓约/亲密授权/群聊成人/睡着 全套门槛）。
  // 现在**一律放行**：玩具不再有任何好感、授权、场景门槛。
  //
  // ⚠️ 两点别改回去：
  //   1. `unknown_toy` 仍要拦 —— 那是"这个 key 根本不存在"的**参数错误**，不是内容限制；
  //   2. `wakesOnIntensity` 仍要算 —— 它驱动"调强度会把她弄醒"的表现，不是门控。
  //
  // 催眠豁免的语义仍然成立且更强：催眠本来就 `getTouchGate` 第一条直接放行，
  // 现在玩具连那一步都不需要了（用户：「催眠的权限是最高的」）。
  const level = getTouchAction(toy.gateActionKey)?.level ?? null;
  return { allowed: true, code: 'ok', reason: 'ok', message: '', level, exempt: null, wakesOnIntensity, toy };
}

/** 强度 clamp：0~max（项圈恒 0），非数字/非有限值回落 0，小数向下取整。 */
export function clampIntensity(toyKey, value) {
  const toy = getToy(toyKey);
  if (!toy) return 0;
  if (toy.maxIntensity <= 0) return 0;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(toy.maxIntensity, Math.max(0, n));
}

// ── 玩法状态表（模式 / 曲线 / tick 记忆 / 主动记录）────────────────────────────

/**
 * 懒建表（幂等）：**刻意不写进 db/index.js 的迁移**——本任务的文件边界只有 toys 这一块，
 * 动 `db/index.js` 会与其它线的迁移撞车。仓里已有先例：`services/assetGenerationQueue.js`、
 * `services/town/townSimulation.js` 都是在服务里 `CREATE TABLE IF NOT EXISTS`。
 *
 * 用 WeakSet 记住"哪个 db 实例建过表"：`closeDb()` 之后再 `getDb()` 是**新实例**，
 * 用布尔量记账会在重开库后漏建表（`:memory:` 测试里正好会踩到）。
 */
const playSchemaReady = new WeakSet();

export function ensureToyPlaySchema(db = getDb()) {
  if (!db || playSchemaReady.has(db)) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS toy_play_state (
      character_id INTEGER NOT NULL,
      toy_key TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'steady',
      curve_json TEXT NOT NULL DEFAULT '',
      curve_started_at DATETIME,
      last_intensity INTEGER NOT NULL DEFAULT 0,
      last_tick_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (character_id, toy_key)
    );

    CREATE TABLE IF NOT EXISTS toy_self_play_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      toy_key TEXT NOT NULL,
      action TEXT NOT NULL DEFAULT 'equip',
      intensity INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'steady',
      curve_json TEXT NOT NULL DEFAULT '',
      secret INTEGER NOT NULL DEFAULT 0,
      bold INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      score REAL NOT NULL DEFAULT 0,
      at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_toy_self_play_char ON toy_self_play_log (character_id, at DESC);
  `);
  playSchemaReady.add(db);
  return db;
}

const sqlToMs = (value) => {
  if (!value) return 0;
  const t = new Date(String(value).replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(t) ? t : 0;
};

/** 曲线落库 / 读回都走这里（读回时按玩具上限再夹一次，防止上限被改小后越界） */
function curveFromJson(text, toy) {
  try {
    const obj = JSON.parse(String(text || '') || 'null');
    if (!obj || typeof obj !== 'object') return null;
    const normalized = normalizeCurve(obj, { maxIntensity: toy ? toy.maxIntensity : 0 });
    return normalized && normalized.invalid ? null : normalized;
  } catch (err) {
    return null;
  }
}

/** 原始玩法行（不建表也能读：表还没建过就当作"没有玩法状态"） */
function readPlayRow(db, characterId, toyKey) {
  try {
    return ensureToyPlaySchema(db).prepare(
      'SELECT * FROM toy_play_state WHERE character_id = ? AND toy_key = ?'
    ).get(characterId, toyKey) || null;
  } catch (err) {
    return null;
  }
}

function readPlayRows(db, characterId) {
  try {
    return ensureToyPlaySchema(db).prepare(
      'SELECT * FROM toy_play_state WHERE character_id = ?'
    ).all(characterId);
  } catch (err) {
    return [];
  }
}

/**
 * 一件已戴玩具的**玩法视图**（纯计算，不落库）：
 * `intensity` 是用户设的基准档，`liveIntensity` 才是"此刻实际作用在她身上的档位"
 * （曲线给目标档 × 模式给节奏包络；两者都没有时二者相等 ⇒ 旧行为逐字节一致）。
 */
function playView(toy, row, playRow, now) {
  const base = Number(row.intensity) || 0;
  const max = toy ? toy.maxIntensity : 0;
  const mode = normalizeMode(playRow ? playRow.mode : DEFAULT_VIBRATION_MODE);
  const curve = playRow ? curveFromJson(playRow.curve_json, toy) : null;
  const equippedAtMs = sqlToMs(row.equipped_at);
  const curveStartedAtMs = curve ? (sqlToMs(playRow.curve_started_at) || equippedAtMs) : equippedAtMs;
  const view = evaluateToyPlay({
    baseIntensity: base, maxIntensity: max, mode, curve,
    curveStartedAtMs, equippedAtMs, now,
    seed: seedOf(row.character_id, row.toy_key),
  });
  return {
    intensity: base,                 // 基准档（旧字段语义不变）
    liveIntensity: view.intensity,   // 此刻生效档
    mode,
    modeLabel: modeLabel(mode),
    modePhase: view.phase,
    modePhaseText: view.phaseText,
    modeFactor: view.modeFactor,
    curve,
    curveLabel: curveLabel(curve),
    curveIntensity: view.curveIntensity,
    curveProgress: view.curveProgress,
    remainingSec: view.remainingSec,
    curveFinished: view.finished,
  };
}

/**
 * 某个角色全部玩具的玩法行（面板/路由一次读全，避免 N+1）
 * `now` 可注入 ⇒ 单测拿假时钟就能验曲线推进，不用 sleep。
 */
export function listToyPlay(characterId, { now = Date.now() } = {}) {
  const db = getDb();
  const rows = readPlayRows(db, characterId);
  const byKey = new Map(rows.map(r => [r.toy_key, r]));
  const wornRows = db.prepare(
    "SELECT * FROM character_worn_toys WHERE character_id = ? AND status = 'worn'"
  ).all(characterId);
  return wornRows.map(row => {
    const toy = getToy(row.toy_key);
    return { toyKey: row.toy_key, label: toy ? toy.label : row.toy_key, ...playView(toy, row, byKey.get(row.toy_key), now) };
  });
}

// ── 佩戴生命周期（装上 / 跟随查询 / 调强度 / 摘下）──────────────────────────

const toSqlTime = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

function decorate(row) {
  if (!row) return null;
  const toy = getToy(row.toy_key);
  const stimulus = stimulusOf(toy);
  return {
    characterId: Number(row.character_id),
    toyKey: row.toy_key,
    label: toy ? toy.label : row.toy_key,
    part: toy ? toy.part : '',
    partSection: toy ? toy.partSection : '',
    desc: toy ? toy.desc : '',
    effect: toy ? (toy.effect || '') : '',      // 正文效果语义（面板也显示，避免 UI 与正文两套说法）
    stimulus: stimulus.key,
    stimulusLabel: stimulus.label,
    daring: daringOf(toy),
    intensity: Number(row.intensity) || 0,
    maxIntensity: toy ? toy.maxIntensity : 0,
    status: row.status,
    equippedAt: row.equipped_at || null,
    updatedAt: row.updated_at || null,
    equipCount: Number(row.equip_count) || 0,
  };
}

export function getWornToy(characterId, toyKey, { now = Date.now() } = {}) {
  const row = getDb().prepare(
    'SELECT * FROM character_worn_toys WHERE character_id = ? AND toy_key = ?'
  ).get(characterId, toyKey);
  if (!row) return null;
  const toy = getToy(toyKey);
  const playRow = readPlayRow(getDb(), characterId, toyKey);
  return { ...decorate(row), minutesWorn: minutesSince(row.equipped_at, now), ...playView(toy, row, playRow, now) };
}

function minutesSince(equippedAt, now = Date.now()) {
  if (!equippedAt) return 0;
  const t = sqlToMs(equippedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60000));
}

/**
 * 当前戴着的玩具（status='worn'），按佩戴顺序，带 `minutesWorn` 与**玩法视图**
 * （`liveIntensity` / `mode` / `curve` / `remainingSec` —— 由注入的 `now` 算出，不 sleep）。
 */
export function listWornToys(characterId, { now = Date.now() } = {}) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM character_worn_toys WHERE character_id = ? AND status = 'worn' ORDER BY id ASC"
  ).all(characterId);
  if (rows.length === 0) return [];
  const playRows = readPlayRows(db, characterId);
  const byKey = new Map(playRows.map(r => [r.toy_key, r]));
  return rows.map(row => {
    const t = decorate(row);
    const toy = getToy(row.toy_key);
    return {
      ...t,
      minutesWorn: minutesSince(t.equippedAt, now),
      ...playView(toy, row, byKey.get(row.toy_key), now),
    };
  });
}

/** 装上（幂等 upsert；重戴回 worn 并让 equip_count +1）。已设曲线时**重戴就从头再走一遍**。 */
export function equipToy(characterId, toyKey, { intensity = 1, now = Date.now() } = {}) {
  const toy = getToy(toyKey);
  if (!toy) return null;
  const db = getDb();
  const at = toSqlTime(now);
  const value = clampIntensity(toyKey, intensity);
  db.prepare(
    "INSERT INTO character_worn_toys (character_id, toy_key, intensity, status, equip_count, equipped_at, updated_at) " +
    "VALUES (?, ?, ?, 'worn', 1, ?, ?) " +
    'ON CONFLICT(character_id, toy_key) DO UPDATE SET ' +
    '  intensity = excluded.intensity, ' +
    "  status = 'worn', " +
    '  equip_count = character_worn_toys.equip_count + 1, ' +
    '  equipped_at = excluded.equipped_at, ' +
    '  updated_at = excluded.updated_at'
  ).run(characterId, toyKey, value, at, at);
  // 曲线重戴即重开（口径：曲线是"这一轮佩戴里怎么变化"，戴新的一轮当然从头走）
  ensureToyPlaySchema(db).prepare(
    'UPDATE toy_play_state SET curve_started_at = ?, last_intensity = ?, last_tick_at = ?, updated_at = ? ' +
    'WHERE character_id = ? AND toy_key = ?'
  ).run(at, value, at, at, characterId, toyKey);
  // 刚戴上也是一次刺激（玩家点"戴上"就是给她一个开始）；场景未进行时下游会自动跳过。
  // reason 会显示在心情气泡上 ⇒ 只写中文名（别写 toyKey）。
  Promise.resolve()
    .then(() => applyIntimateStimulus({
      characterId, source: 'toy', amount: Math.round(value * 1.5),
      reason: `戴上玩具：${toy?.label || '一件玩具'}`,
    }))
    .catch(() => { /* 旁路：玩具不受影响 */ });
  return getWornToy(characterId, toyKey, { now });
}

/**
 * 调强度（无门控，§2.4：已戴上就是默许）。未佩戴/未知玩具 → null。
 * 口径：只改**基准档**；已经开始走的曲线不动（想重排曲线就重设一次 → `setToyCurve`）。
 */
export function setToyIntensity(characterId, toyKey, intensity, { now = Date.now() } = {}) {
  const worn = getWornToy(characterId, toyKey, { now });
  if (!worn || worn.status !== 'worn') return null;
  const value = clampIntensity(toyKey, intensity);
  getDb().prepare(
    'UPDATE character_worn_toys SET intensity = ?, updated_at = ? WHERE character_id = ? AND toy_key = ?'
  ).run(value, toSqlTime(now), characterId, toyKey);
  // 调档也是一次刺激：跳得越多越明显（用户："加入档位随时可调" ⇒ 调档要真的作用在她身上）
  const jump = Math.abs(Number(value) - Number(worn.intensity || 0));
  if (jump > 0) {
    Promise.resolve()
      .then(() => applyIntimateStimulus({
        characterId, source: 'toy', amount: Math.round(jump * 1.5),
        reason: `玩具调档：${getToy(toyKey)?.label || '玩具'} → ${value} 档`,
      }))
      .catch(() => { /* 旁路：玩具不受影响 */ });
  }
  return getWornToy(characterId, toyKey, { now });
}

// ── 振动模式 / 强度曲线（§2.10 玩法扩充，2026-10-02）─────────────────────────

/** 写玩法行（模式 / 曲线 / tick 记忆共用一条 upsert，避免多处分头写） */
function upsertPlayRow(db, characterId, toyKey, patch, now) {
  const current = readPlayRow(db, characterId, toyKey);
  const next = {
    mode: patch.mode !== undefined ? patch.mode : (current ? current.mode : DEFAULT_VIBRATION_MODE),
    curveJson: patch.curveJson !== undefined ? patch.curveJson : (current ? current.curve_json : ''),
    curveStartedAt: patch.curveStartedAt !== undefined ? patch.curveStartedAt : (current ? current.curve_started_at : null),
    lastIntensity: patch.lastIntensity !== undefined ? patch.lastIntensity : (current ? current.last_intensity : 0),
    lastTickAt: patch.lastTickAt !== undefined ? patch.lastTickAt : (current ? current.last_tick_at : null),
  };
  const at = toSqlTime(now);
  db.prepare(
    'INSERT INTO toy_play_state (character_id, toy_key, mode, curve_json, curve_started_at, last_intensity, last_tick_at, updated_at) ' +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    'ON CONFLICT(character_id, toy_key) DO UPDATE SET ' +
    '  mode = excluded.mode, curve_json = excluded.curve_json, curve_started_at = excluded.curve_started_at, ' +
    '  last_intensity = excluded.last_intensity, last_tick_at = excluded.last_tick_at, updated_at = excluded.updated_at'
  ).run(characterId, toyKey, next.mode, next.curveJson, next.curveStartedAt, next.lastIntensity, next.lastTickAt, at);
  return readPlayRow(db, characterId, toyKey);
}

/**
 * 设置振动模式。未佩戴 → `{ok:false, code:'toy_not_worn'}`；模式不认识 → `{ok:false, code:'invalid_mode'}`。
 * @returns {{ok:boolean, code:string, toy:object|null}}
 */
export function setToyMode(characterId, toyKey, mode, { now = Date.now() } = {}) {
  if (!getToy(toyKey)) return { ok: false, code: 'unknown_toy', toy: null };
  const worn = getWornToy(characterId, toyKey, { now });
  if (!worn || worn.status !== 'worn') return { ok: false, code: 'toy_not_worn', toy: null };
  if (!isVibrationMode(mode)) return { ok: false, code: 'invalid_mode', toy: worn };
  const db = ensureToyPlaySchema(getDb());
  upsertPlayRow(db, characterId, toyKey, { mode, lastIntensity: worn.liveIntensity, lastTickAt: toSqlTime(now) }, now);
  return { ok: true, code: 'ok', toy: getWornToy(characterId, toyKey, { now }) };
}

/**
 * 设置 / 清除强度曲线。
 * `curve` 传 `null` / `'off'` / `{type:'off'}` ⇒ 关掉曲线（回到基准档）；
 * 传 `{type, from, to, durationSec, loop}` ⇒ 从**此刻**开始走（`curve_started_at = now`）；
 * 类型不认识 ⇒ `{ok:false, code:'invalid_curve'}`。
 */
export function setToyCurve(characterId, toyKey, curve, { now = Date.now() } = {}) {
  const toy = getToy(toyKey);
  if (!toy) return { ok: false, code: 'unknown_toy', toy: null };
  const worn = getWornToy(characterId, toyKey, { now });
  if (!worn || worn.status !== 'worn') return { ok: false, code: 'toy_not_worn', toy: null };
  const normalized = normalizeCurve(curve, { maxIntensity: toy.maxIntensity });
  if (normalized && normalized.invalid) return { ok: false, code: 'invalid_curve', toy: worn };
  const db = ensureToyPlaySchema(getDb());
  const at = toSqlTime(now);
  upsertPlayRow(db, characterId, toyKey, {
    curveJson: normalized ? JSON.stringify(normalized) : '',
    curveStartedAt: normalized ? at : null,
    lastIntensity: worn.liveIntensity,
    lastTickAt: at,
  }, now);
  return { ok: true, code: 'ok', toy: getWornToy(characterId, toyKey, { now }) };
}

/**
 * **tick 推进**（强度曲线随时间自动升降的唯一执行点）。
 *
 * 为什么需要它：曲线不是"装备那一刻算一次"，而是随时间变；tick 把每个时刻的实际档位
 * 结算进 `toy_play_state.last_intensity` 并报出**变化**（`transitions`），
 * 供路由/前端做提示与反应（"她自己把档位推高了"）。
 *
 * 纯计算部分在 `mechanics.evaluateToyPlay`（可注入假时钟）——本函数只负责落库与比较。
 * @returns {{now:number, worn:Array, transitions:Array<{toyKey:string, from:number, to:number, phase:string}>}}
 */
export function tickToys(characterId, { now = Date.now() } = {}) {
  const db = ensureToyPlaySchema(getDb());
  const worn = listWornToys(characterId, { now });
  const transitions = [];
  const at = toSqlTime(now);
  for (const item of worn) {
    const row = readPlayRow(db, characterId, item.toyKey);
    const from = row ? Number(row.last_intensity) || 0 : Number(item.intensity) || 0;
    const to = Number(item.liveIntensity) || 0;
    if (from !== to) transitions.push({ toyKey: item.toyKey, from, to, phase: item.modePhase });
    upsertPlayRow(db, characterId, item.toyKey, {
      lastIntensity: to, lastTickAt: at,
      // 模式/曲线保持原样（tick 不改配置）
      mode: item.mode,
      curveJson: item.curve ? JSON.stringify(item.curve) : '',
    }, now);
  }
  // ── 亲密刺激统一下游（2026-10-02）────────────────────────────────────────
  // 用户原话：「现在的玩具和催眠和心情和记忆好像是完全解耦的一样 根本就没关联」
  // 「可以同时多个或者单个穿戴 然后同时让角色感受」
  // ⇒ 只要她戴着玩具，每次 tick 都在真的刺激她；**多件同时戴会叠加**（各件 liveIntensity 求和）。
  // 不 await：玩具的 tick 要立刻回应面板，心情/记忆/累积由下游慢慢办（失败也不影响玩具本身）。
  const liveSum = worn.reduce((sum, item) => sum + (Number(item.liveIntensity) || 0), 0);
  if (liveSum > 0) {
    Promise.resolve()
      .then(() => applyIntimateStimulus({
        characterId,
        source: 'toy',
        amount: Math.round(liveSum * 1.5),
        // ⚠️ 这里会**显示在心情气泡上**（emotion_snapshots.reason）⇒ 只准写中文名、并且要截断：
        // 2026-10-02 用户截图报「心情一长串 💬"玩具刺激（vibe_egg / nipple_clamp / …）」——
        // 那是我把英文 toyKey 直接拼进去了（违反仓库「不许把键名给用户看」）。
        reason: '玩具刺激：' + bondToyListText(worn.map(item => item.label)),
      }))
      .catch(err => console.warn('[toys] 刺激下游失败（不影响玩具）:', err?.message || err));
  }
  return { now, worn: listWornToys(characterId, { now }), transitions };
}

/** 当前佩戴组合的叠加/互相影响（进 prompt，也进面板） */
export function wornCombo(characterId, { now = Date.now() } = {}) {
  return comboEffects(listWornToys(characterId, { now }), {});
}

/** 摘下（保留行：status='removed'，equip_count 不变）。未佩戴 → null。 */
export function removeToy(characterId, toyKey, { now = Date.now() } = {}) {
  const worn = getWornToy(characterId, toyKey);
  if (!worn || worn.status !== 'worn') return null;
  getDb().prepare(
    "UPDATE character_worn_toys SET status = 'removed', updated_at = ? WHERE character_id = ? AND toy_key = ?"
  ).run(toSqlTime(now), characterId, toyKey);
  return getWornToy(characterId, toyKey);
}

/** 「戴过几次」（同一行 upsert，故用 equip_count 而不是行数统计）。 */
export function countEquipHistory(characterId, toyKey) {
  const row = getDb().prepare(
    'SELECT equip_count FROM character_worn_toys WHERE character_id = ? AND toy_key = ?'
  ).get(characterId, toyKey);
  return Number(row?.equip_count) || 0;
}

// ── 状态注入块（§2.5）──────────────────────────────────────────────────────

const TIER_GUIDE = [
  '- 强度0：只是异物感，偶尔意识到它的存在',
  '- 强度1~2：隐约的酥麻，说话偶尔停顿、坐姿收紧',
  '- 强度3：持续的刺激，语句断续、咬唇、夹紧双腿、注意力涣散',
  '- 强度4~5：强烈刺激，几乎无法组织完整句子、面红耳赤、抓住桌沿/自己的衣服',
  '- 已戴超过1小时：从敏感转为麻木与疲惫的混合，带一点失神',
];

function formatWornDuration(minutes) {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? ('已戴' + h + '小时' + m + '分钟') : ('已戴' + h + '小时');
  }
  return '已戴' + minutes + '分钟';
}

function intensityText(toy, intensity) {
  if (toy && toy.maxIntensity <= 0) return '强度：无（象征物）';
  const max = toy ? toy.maxIntensity : 0;
  return '强度' + intensity + '/' + max;
}

/** 一件玩具那一行的正文（首期格式逐字节保留：`名称（部位，强度x/max，已戴N分钟）`） */
function wornLine(t) {
  const toy = getToy(t.toyKey);
  // 生效档位 = liveIntensity（曲线 × 模式）；没有曲线/非持续模式时它等于基准档 ⇒ 与旧文案一致
  const live = Number.isFinite(t.liveIntensity) ? t.liveIntensity : t.intensity;
  const modeText = t.mode && t.mode !== DEFAULT_VIBRATION_MODE
    ? ('，' + t.modeLabel + (t.modePhaseText ? '：' + t.modePhaseText : ''))
    : '';
  return t.label + '（' + t.partSection + '，' + intensityText(toy, live) + modeText + '，' + formatWornDuration(t.minutesWorn) + '）';
}

/** 节奏 / 曲线段：只有真的设过模式或曲线才出现（没设过就零注入） */
function rhythmLines(worn) {
  const lines = [];
  for (const t of worn) {
    const hasMode = t.mode && t.mode !== DEFAULT_VIBRATION_MODE;
    const hasCurve = Boolean(t.curve);
    if (!hasMode && !hasCurve) continue;
    const bits = [];
    if (hasMode) bits.push('模式「' + t.modeLabel + '」' + (t.modePhaseText ? '（' + t.modePhaseText + '）' : ''));
    if (hasCurve) {
      const remain = t.curveFinished
        ? '曲线已走完，停在 ' + (Number.isFinite(t.curveIntensity) ? t.curveIntensity : t.liveIntensity) + ' 档'
        : ('曲线还有 ' + (t.remainingSec === null ? '—' : t.remainingSec) + ' 秒走完');
      bits.push('曲线「' + t.curveLabel + '」，' + remain);
    }
    lines.push('- ' + t.label + '：' + bits.join('；'));
  }
  return lines;
}

/**
 * `<worn_toys>` 块。**零佩戴返回 null**（调用方据此零注入，与加功能前逐字节一致）。
 *
 * @param {number} characterId
 * @param {{scene?:'chat'|'group', now?:number, subjectName?:string, includeSelfPlay?:boolean|'auto',
 *          userName?:string, selfPlayTtlMin?:number}} [options]
 *   `includeSelfPlay`：`'auto'`（默认）= 15 分钟内她刚自己玩过就**追加**独立的
 *   `<self_toy_play>` 块（在她自己动手之后的那几轮里，叙事要记得这件事）；`false` = 永不追加。
 * @returns {string|null}
 */
export function buildWornToysBlock(characterId, {
  scene = 'chat', now = Date.now(), subjectName = '', includeSelfPlay = 'auto',
  userName = '', selfPlayTtlMin = SELF_PLAY_BLOCK_TTL_MIN,
} = {}) {
  const worn = listWornToys(characterId, { now });
  if (worn.length === 0) return null;
  const who = String(subjectName || '').trim() || '她';
  const lines = [];
  if (scene === 'group') lines.push('【本节只对「' + who + '」生效】');
  lines.push('她身上正戴着：' + worn.map(wornLine).join('、') + '。');
  lines.push('【身体状态指引——让它自然渗透在你这轮的每句话里，不要专门解说】');
  for (const line of TIER_GUIDE) lines.push(line);
  const rhythm = rhythmLines(worn);
  if (rhythm.length > 0) {
    lines.push('【节奏与曲线——她身上的东西不是在"恒定地开着"，是按下面的节奏在变】');
    for (const line of rhythm) lines.push(line);
  }
  const combo = comboEffects(worn, {});
  if (combo.count >= 2) {
    lines.push('【多件叠加】' + (combo.labels.length ? ('同时成立：' + combo.labels.join('、') + '。') : ''));
    for (const note of combo.notes) lines.push('- ' + note);
    if (combo.summary) lines.push('- ' + combo.summary);
  }
  if (scene === 'group') {
    lines.push('【她知道原因；其他人看得到她的异样但不知道原因】');
  }
  const block = '<worn_toys>\n' + lines.join('\n') + '\n</worn_toys>';
  if (includeSelfPlay === false) return block;
  const selfPlay = buildSelfPlayInjection(characterId, { scene, now, subjectName, userName, withinMin: selfPlayTtlMin });
  return selfPlay ? (block + '\n' + selfPlay) : block;
}

// ── 她自己主动玩（services/toy/selfPlay.js 的 DB 与上下文接线）──────────────────

/**
 * 用户"在不在场"：以**最后一次用户发言**为准（超过 `idleMs` 没说话 ⇒ 她算独处）。
 * 这是"独处"这个驱动量在本仓唯一能落到实处的数据源（不新造在线状态）。
 */
export function userPresence(characterId, { now = Date.now(), idleMs = 10 * 60 * 1000 } = {}) {
  let lastAtMs = 0;
  try {
    const row = getDb().prepare(
      "SELECT created_at FROM raw_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
    ).get('char_' + characterId);
    lastAtMs = sqlToMs(row?.created_at);
  } catch (err) {
    lastAtMs = 0;
  }
  const idleMinutes = lastAtMs ? Math.floor((now - lastAtMs) / 60000) : Infinity;
  const userPresent = lastAtMs > 0 && (now - lastAtMs) < idleMs;
  return { userPresent, alone: !userPresent, lastAtMs: lastAtMs || null, idleMinutes };
}

/** 淫乱度（派生量，不新增列）：亲密行为次数 + 玩具历史 + 主动次数，权重在 selfPlay.js 收口 */
export function lewdnessFor(characterId) {
  const num = (sql, ...args) => {
    try { return Number(getDb().prepare(sql).get(...args)?.n) || 0 } catch (err) { return 0 }
  };
  const intimateActs = num('SELECT COUNT(*) AS n FROM character_intimate_log WHERE character_id = ?', characterId);
  const toyEquips = num('SELECT COALESCE(SUM(equip_count), 0) AS n FROM character_worn_toys WHERE character_id = ?', characterId);
  const selfPlays = num('SELECT COUNT(*) AS n FROM toy_self_play_log WHERE character_id = ?', characterId);
  return { intimateActs, toyEquips, selfPlays, lewdness: lewdnessScore({ intimateActs, toyEquips, selfPlays }) };
}

/** 主动记录落库（她真的动手了才写；判定不通过什么都不写） */
export function recordSelfPlay(characterId, decision = {}, { now = Date.now(), toyKey, intensity, mode, curve } = {}) {
  const db = ensureToyPlaySchema(getDb());
  const at = toSqlTime(now);
  const info = db.prepare(
    'INSERT INTO toy_self_play_log (character_id, toy_key, action, intensity, mode, curve_json, secret, bold, code, reason, score, at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    characterId, String(toyKey || decision.toyKey || ''), String(decision.action || 'equip'),
    Number(intensity) || 0, String(mode || decision.mode || DEFAULT_VIBRATION_MODE),
    curve ? JSON.stringify(curve) : '', decision.secret ? 1 : 0, decision.bold ? 1 : 0,
    String(decision.code || ''), String(decision.reason || ''), Number(decision.score) || 0, at,
  );
  return getDb().prepare('SELECT * FROM toy_self_play_log WHERE id = ?').get(info.lastInsertRowid);
}

/** 最近一次主动记录（`minutesAgo` 用注入的 now 算，测试不用 sleep） */
export function lastSelfPlay(characterId, { now = Date.now(), withinMin = null } = {}) {
  const row = ensureToyPlaySchema(getDb()).prepare(
    'SELECT * FROM toy_self_play_log WHERE character_id = ? ORDER BY id DESC LIMIT 1'
  ).get(characterId) || null;
  if (!row) return null;
  const minutesAgo = Math.max(0, Math.floor((now - sqlToMs(row.at)) / 60000));
  if (withinMin !== null && minutesAgo > withinMin) return null;
  return { ...row, minutesAgo, secret: Number(row.secret) === 1, bold: Number(row.bold) === 1 };
}

/** 当日主动次数（按 UTC 日期切，与库里的时间串同口径） */
export function selfPlayCountToday(characterId, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    return Number(getDb().prepare(
      'SELECT COUNT(*) AS n FROM toy_self_play_log WHERE character_id = ? AND substr(at, 1, 10) = ?'
    ).get(characterId, day)?.n) || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * **她自己动手**的注入块（独立于 `<worn_toys>`，口径见 `toy/selfPlay.js` 文件头）。
 * 近期没有主动记录 ⇒ 返回 `''`（零注入）。
 */
export function buildSelfPlayInjection(characterId, {
  scene = 'chat', now = Date.now(), subjectName = '', userName = '', withinMin = SELF_PLAY_BLOCK_TTL_MIN,
} = {}) {
  const last = lastSelfPlay(characterId, { now, withinMin });
  if (!last) return '';
  const toy = getToy(last.toy_key);
  const curve = toy ? curveFromJson(last.curve_json, toy) : null;
  return buildSelfPlayBlock({
    toyLabel: toy ? toy.label : last.toy_key,
    part: toy ? toy.partSection : '',
    effect: toy ? (toy.effect || '') : '',
    intensity: Number(last.intensity) || 0,
    maxIntensity: toy ? toy.maxIntensity : 0,
    mode: last.mode,
    modeRhythm: modeMeta(last.mode).rhythm,
    curveText: curveLabel(curve),
    secret: Boolean(last.secret),
    bold: Boolean(last.bold),
    alone: !last.secret && !last.bold,
    action: last.action,
    lewdness: lewdnessFor(characterId).lewdness,
    minutesAgo: last.minutesAgo,
    scene,
    subjectName,
    userName: userName || '用户',
  });
}

/**
 * 收集判定的输入。**`signals` 与 `emotion` 一律由调用方注入**：
 *   · `signals`（催眠/睡着）必须注入 —— 本模块刻意不 import `hypnosisService` / `scheduleManager`，
 *     因为 `hypnosisService` 反过来 import 本模块，静态互引会成环（本仓 TDZ 血泪史）；
 *   · `emotion`（好感/誓约/唤醒）也走注入，理由同上（保持本模块只依赖 db + config）。
 *     路由层用 `emotionEngine.loadAffinity / loadOath / loadEmotionState` 三个读填进来。
 *
 * @param {object} options
 * @param {{hypnosisActive?:boolean, bodyControlled?:boolean, sleeping?:boolean}} [options.signals]
 * @param {{affinity?:number, isOath?:boolean, arousal?:number}} [options.emotion]
 * @param {{userPresent:boolean, alone:boolean}} [options.presence] 不传就按"最后一次用户发言"推
 */
export function selfPlayContext(characterId, {
  now = Date.now(), scene = 'chat', signals = {}, emotion = {}, idleMs = 10 * 60 * 1000, presence = null,
} = {}) {
  const presenceInfo = presence || userPresence(characterId, { now, idleMs });
  const lewd = lewdnessFor(characterId);
  const affinity = Number(emotion.affinity) || 0;
  const last = lastSelfPlay(characterId, { now });
  return {
    affinity,
    isOath: emotion.isOath === true,
    arousal: Math.max(0, Math.min(1, Number(emotion.arousal) || 0)),
    lewdness: lewd.lewdness,
    alone: presenceInfo.userPresent === true ? false : presenceInfo.alone !== false,
    userPresent: presenceInfo.userPresent === true,
    hypnosisActive: signals.hypnosisActive === true,
    bodyControlled: signals.bodyControlled === true,
    sleeping: signals.sleeping === true,
    scene,
    wornKeys: listWornToys(characterId, { now }).map(t => t.toyKey),
    availableKeys: selfPlayPickOrder(),
    minutesSinceLast: last ? last.minutesAgo : Infinity,
    playsToday: selfPlayCountToday(characterId, { now }),
    idleMinutes: presenceInfo.idleMinutes,
  };
}

/**
 * **她自己主动玩**的判断 + 执行（判断路径全部在 `toy/selfPlay.js`，这里只落库）。
 *
 * @param {object} options
 * @param {object} [options.signals] 见 `selfPlayContext`
 * @param {object} [options.emotion] 见 `selfPlayContext`
 * @param {boolean} [options.encouraged] 被用户逗了一下（只加分，**不越过任何硬门槛**）
 * @param {() => number} [options.random] 随机源；**默认不用 Math.random** —— 用
 *   `(角色, 10 分钟窗口)` 的确定性骰子，这样"她这次到底玩不玩"可复算、可测、不会让全量测试发抖
 * @returns {{play:boolean, code:string, reason:string, ...}} `decideSelfPlay` 的结果
 *          + `{ applied, changed, toyKey, intensity, mode, curve, label, runtime }`
 */
export function maybeSelfPlay(characterId, {
  now = Date.now(), scene = 'chat', signals = {}, emotion = {}, presence = null,
  encouraged = false, random = null, idleMs = 10 * 60 * 1000,
} = {}) {
  if (config.features.toys !== true) {
    return { play: false, code: 'toys_disabled', reason: '成人玩具总开关关着。', applied: false, changed: false };
  }
  const ctx = selfPlayContext(characterId, { now, scene, signals, emotion, presence, idleMs });
  const roll = typeof random === 'function'
    ? random
    : () => hash01(seedOf(characterId, 'self_play'), Math.floor(now / SELF_PLAY_WINDOW_MS) + 1);
  const decision = decideSelfPlay({ ...ctx, encouraged, random: roll, seed: seedOf(characterId, 'self_play') });
  if (!decision.play) return { ...decision, applied: false, changed: false };

  const toy = getToy(decision.toyKey);
  if (!toy) return { ...decision, play: false, code: SELF_PLAY_CODES.NO_TOY, applied: false, changed: false };

  let intensity = clampIntensity(decision.toyKey, decision.intensity);
  let mode = decision.mode;
  let curve = decision.curve ? normalizeCurve(decision.curve, { maxIntensity: toy.maxIntensity }) : null;
  if (curve && curve.invalid) curve = null;
  if (decision.action === 'bump') {
    const current = listWornToys(characterId, { now }).find(t => t.toyKey === decision.toyKey);
    intensity = clampIntensity(decision.toyKey, (current ? current.intensity : 0) + 1);
    setToyIntensity(characterId, decision.toyKey, intensity, { now });
  } else {
    equipToy(characterId, decision.toyKey, { intensity, now });
  }
  const modeRes = setToyMode(characterId, decision.toyKey, mode, { now });
  if (!modeRes.ok) mode = DEFAULT_VIBRATION_MODE;
  const curveRes = setToyCurve(characterId, decision.toyKey, curve, { now });
  if (!curveRes.ok) curve = null;

  const row = recordSelfPlay(characterId, decision, { now, toyKey: decision.toyKey, intensity, mode, curve });
  return {
    ...decision, applied: true, changed: true,
    toyKey: decision.toyKey, intensity, mode, curve,
    label: toy.label, part: toy.part, effect: toy.effect || '',
    maxIntensity: toy.maxIntensity, action: decision.action, at: row ? row.at : toSqlTime(now),
    runtime: curveRes.ok ? curveRes.toy : null,
  };
}

// ── 摘戴/调强度的即时反应（§2.3，复用 touch 反应管线的喂料口径）─────────────

const EVENT_TEXT = Object.freeze({
  equip: '你给她戴上了',
  remove: '你把她身上的玩具摘了下来',
  set_intensity: '你调了她的玩具强度',
});

/**
 * 批量（同一时刻好几件）的事实动词 —— 2026-10-04 用户原话：
 * 「一次性拿掉的话不要一个一个的去反馈 直接让角色一次性感受到然后再去反馈」。
 *
 * 单件口径原样不动；**≥2 件**时才走这一套：事实句直接列全清单 + 点明"同一时刻"，
 * 让她把这一批当成**一次**感受，而不是一件一件接踵而来。
 */
const BATCH_EVENT_TEXT = Object.freeze({
  equip: '你一次给她戴上了',
  remove: '你一次从她身上取了下来',
  set_intensity: '你一次把她的玩具强度调成了',
});

/**
 * 把批量入参规整成 `{key,label,part,effect,intensity}`（未知 key 保底成原字符串，不静默丢）。
 *
 * 入参可以是 `['collar','vibe_egg']`，也可以是 `[{toyKey:'collar',intensity:2}, ...]`
 * （后者能把「这一件几档」写进事实句，避免整批被糊成一个强度）。
 *
 * **少于 2 件 ⇒ 返回 []**：一件不算"一批"，调用方回落单件口径
 * （否则会出现"一次性给你戴上了「项圈」1 件"这种别扭措辞）。
 * @returns {Array<{key:string,label:string,part:string,effect:string,intensity:(number|undefined)}>}
 */
export function normalizeBatchToys(batchToys) {
  const raw = Array.isArray(batchToys) ? batchToys : [];
  const items = [];
  for (const it of raw) {
    if (typeof it === 'string') { if (it) items.push({ key: it, intensity: undefined }); continue }
    if (it && typeof it === 'object') {
      const key = String(it.toyKey || it.key || '');
      if (key) items.push({ key, intensity: Number.isFinite(Number(it.intensity)) ? Number(it.intensity) : undefined });
    }
  }
  if (items.length < 2) return [];
  return items.map(({ key, intensity }) => {
    const toy = getToy(key);
    return {
      key,
      intensity,
      label: toy ? toy.label : key,
      part: toy ? toy.part : '身上',
      effect: toy ? (toy.effect || '') : '',
    };
  });
}

/** 批量事实句：把**整批**一次说清（单件口径那套模板在这条路径上不适用）。 */
function buildBatchFactLine({ event, userName, batch, intensity }) {
  // 每件都带档位时才逐件写档位；档位不齐就别编（宁可不说，也不给模型一个假的"统一强度"）。
  const everyIntensity = batch.every(t => typeof t.intensity === 'number');
  const list = batch.map(t => '「' + t.label + '」（' + t.part + (everyIntensity ? '，强度 ' + t.intensity : '') + '）').join('、');
  const n = batch.length;
  const verb = BATCH_EVENT_TEXT[event] || BATCH_EVENT_TEXT.equip;
  if (event === 'remove') {
    return userName + verb + '——' + list + '，' + n + ' 件是**同一瞬间一起消失**的（不是一件一件拿走的）。';
  }
  if (event === 'set_intensity') {
    if (everyIntensity) return userName + '——' + list + '，' + n + ' 件是**同时**变档的。';
    return userName + verb + ' ' + intensity + ' 档——' + list + '，' + n + ' 件是**同时**变档的。';
  }
  return userName + verb + '——' + list + '，' + n + ' 件是**同一瞬间一起到位**的（不是一件一件戴上的）。';
}

/**
 * 玩具事件的反应 prompt。JSON 口径与 §一① 一致：**image_prompt 与 reaction_text 同一次调用产出**
 * （这样图与文字必然一致；image_prompt 字段名先按 §一① 落地，A 那条线落地后可直接对接）。
 *
 * 2026-10-02 加 `mode` / `curve` / `combo` 三个上下文：装备之后档位会自己变（模式+曲线），
 * 所以同一件玩具的"调强度"反应也要按**当时的节奏阶段**演，不能每次都是同一句。
 * @returns {{messages:Array, temperature:number, max_tokens:number}}
 */
export function buildToyReactionPrompt({
  event = 'equip', toyKey, intensity = 0, minutesWorn = 0, userName = '用户', extraContext = '',
  mode = DEFAULT_VIBRATION_MODE, modePhaseText = '', curve = null, combo = null, batchToys = null,
} = {}) {
  const toy = getToy(toyKey);
  const label = toy ? toy.label : String(toyKey || '玩具');
  const partText = toy ? toy.part : '身上';
  const eventText = EVENT_TEXT[event] || EVENT_TEXT.equip;
  const meta = modeMeta(mode);
  // 批量（≥2 件）：事实句、作用方式、写作要求、画面要求四处一起切到"一次性"口径（见 normalizeBatchToys）。
  const batch = normalizeBatchToys(batchToys);
  const effectText = batch.length
    ? batch.filter(t => t.effect).map(t => t.label + '：' + t.effect).join('；')
    : (toy ? (toy.effect || '') : '');
  const fact = batch.length
    ? buildBatchFactLine({ event, userName, batch, intensity })
    : (userName + eventText + '「' + label + '」（' + partText + '），当前强度 ' + intensity + '，已戴 ' + minutesWorn + ' 分钟。');
  const system = [
    '你在扮演一个成年角色。下面发生了一次与「成人玩具」有关的接触，请以第一人称给出她的即时反应。',
    '事实：' + fact,
    effectText ? ((batch.length ? '这几件的作用方式：' : '这件玩具的作用方式：') + effectText) : '',
    mode !== DEFAULT_VIBRATION_MODE ? ('振动模式：' + meta.label + '——' + meta.rhythm + (modePhaseText ? ('；此刻' + modePhaseText) : '')) : '',
    curve ? ('强度曲线：' + curveLabel(curve) + '（档位会随时间自己变，按此演"正在变化"而不是"恒定"）') : '',
    combo && combo.notes && combo.notes.length ? ('同时还有叠加：' + combo.notes.join('；')) : '',
    extraContext ? ('额外上下文：' + extraContext) : '',
    '',
    '【写作要求】',
    '- reaction_text：1~4 句第一人称，写身体与情绪的真实反应（装上：突然的刺激 / 异物感；摘下：骤然轻松或久戴后的虚脱；调强度：一次突袭般的刺激变化）。',
    batch.length ? '- **这一批是同一次动作**：reaction_text 要写成「同一时刻被几处一起袭击 / 一起抽离」的**一整段**反应（几种感觉同时涌上来、身体一时顾不过来；或几处同时一空、人差点软下去），**禁止**写成一件接一件的时间顺序（不要出现"先是…接着…然后…"这种逐件推进）。' : '',
    batch.length ? '- 这一批里每一件都要**被感受到**：别只写其中一件、把其余的漏掉；但也不必逐件分句，揉进同一段里写。' : '',
    batch.length
      ? '- image_prompt：英文，直接描述此刻正在发生的画面——姿势、表情、身体反应、衣着现状，以及**这几件同时**在各自位置上的可见形态（每件都要出现在描述里，一个都不能漏）。不要用暗示性遮掩，如实描述。'
      : '- image_prompt：英文，直接描述此刻正在发生的画面——姿势、表情、身体反应、衣着现状、玩具的位置与可见形态（如内裤轮廓里的跳蛋线、肛塞尾巴、乳夹）。不要用暗示性遮掩，如实描述。',
    '- emotion_delta：三个数值（valence / arousal / dominance），范围 -0.3~0.3，高强度时 arousal 明显冲高。',
    batch.length ? '- emotion_delta：这一批的刺激是**叠加**的，arousal 的绝对值要比单件时更大（仍不超 0.3）。' : '',
    '- facial_expression：一个简短的中文表情词（如「脸红咬唇」「失神」「皱眉」）。',
    '- annoyed：布尔，她被弄得不耐烦/太累时为 true，否则 false。',
    '',
    '严格按下面的 JSON 输出，不要输出任何解释或 JSON 以外的文字：',
    '{',
    '  "reaction_text": "（她的反应，1~4 句第一人称中文）",',
    '  "image_prompt": "english: what is happening right now, pose, expression, clothing state, the toy and how it shows",',
    '  "emotion_delta": { "valence": 0.05, "arousal": 0.18, "dominance": -0.05 },',
    '  "facial_expression": "脸红咬唇",',
    '  "annoyed": false',
    '}',
    '',
  // Authoritative image rules: the author requires this block in EVERY image path.
  // Without it a multi-character frame collapses into one person / a merged blob.
  buildImagePromptRuleBlock(),
].filter(Boolean).join('\n');
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: '（现在给出她这一刻的反应）' }], temperature: 0.8, max_tokens: 500 };
}

// ── 记忆挂点（§2.6-3）─────────────────────────────────────────────────────

/** 戴上/摘下各一条记忆；dedupeKey 让同一事件重复写不会堆叠（§2.5 末尾）。 */
export function toyMemoryDedupeKey(characterId, toyKey, at, event = 'equip') {
  const base = 'toy:' + characterId + ':' + toyKey + ':' + at;
  return event === 'equip' ? base : (base + ':' + event);
}

/**
 * 戴上/摘下/自己动手各一条记忆；dedupeKey 让同一事件重复写不会堆叠（§2.5 末尾）。
 *
 * `event='self_play'`（2026-10-02）：她自己动手那一条记忆 —— **主语是她**，
 * 内容与"用户给她戴上"分开写，且偷偷玩时要带上"没告诉他"（这是后续对话的伏笔）。
 */
export function buildToyMemoryEntry({ characterId, toyKey, event = 'equip', intensity = 0, at, userName = '用户', secret = false } = {}) {
  const toy = getToy(toyKey);
  const label = toy ? toy.label : String(toyKey || '玩具');
  const stamp = at || new Date().toISOString().slice(0, 19).replace('T', ' ');
  let content;
  if (event === 'equip') {
    content = userName + '给我戴上了' + label + '（强度 ' + intensity + '）。';
  } else if (event === 'self_play') {
    content = '我自己忍不住把' + label + '用上了（强度 ' + intensity + '）' + (secret ? '，没让' + userName + '发现。' : '。');
  } else {
    content = userName + '把我身上的' + label + '摘了下来（摘下前强度 ' + intensity + '）。';
  }
  return { dedupe_key: toyMemoryDedupeKey(characterId, toyKey, stamp, event), content, at: stamp };
}

/**
 * 批量装卸的**一条汇总记忆**（不是逐件 N 条）——与"整批只反应一次"同一口径（2026-10-04）。
 *
 * 之前批量那条链**一件记忆都不写**：单件有记忆、批量没有，于是她"身上一次多了三样东西"
 * 在后来的对话里毫无痕迹（她记得的只有单件那次）。这里补上，措辞按"一次一批"写。
 *
 * dedupeKey 用**排序后的 key 串** ⇒ 同一批重复提交不会堆叠（与单件那条 `toy:<id>:<key>:<at>` 同源不同粒度）。
 * @returns {{dedupe_key:string, content:string, at:string, toyKeys:string[]}|null}
 */
export function buildToyBatchMemoryEntry({ characterId, toyKeys = [], event = 'equip', at, userName = '用户' } = {}) {
  const keys = (Array.isArray(toyKeys) ? toyKeys : []).map(k => String(k || '')).filter(Boolean);
  if (keys.length === 0) return null;
  const labels = keys.map(k => (getToy(k)?.label || k)).join('、');
  const stamp = at || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const content = event === 'remove'
    ? userName + '一次把我身上的' + labels + '全取了下来（一次 ' + keys.length + ' 件）。'
    : userName + '一次给我戴上了' + labels + '（一次 ' + keys.length + ' 件）。';
  const dedupe_key = 'toy:batch:' + characterId + ':'
    + [...keys].sort().join('+') + ':' + stamp + (event === 'equip' ? '' : ':' + event);
  return { dedupe_key, content, at: stamp, toyKeys: keys };
}

// ── 睡着时的强度唤醒（§2.4 表末行：标了 wakesOnIntensity，这里把它消费掉）──────

/** 会被弄醒的强度阈值：≥3 视为「调高」（与分档指引里「强度3=持续刺激」同一档位）。 */
export const TOY_WAKE_INTENSITY = 3;

/**
 * 睡着时调强度的唤醒判定（纯函数，便于单测；调用方据此 tempWake + 把事实写进反应 prompt）。
 * @returns {{wake:boolean, extraContext:string}}
 */
export function toyWakePlan({ sleeping = false, intensity = 0 } = {}) {
  if (!sleeping) return { wake: false, extraContext: '' };
  if (Number(intensity) >= TOY_WAKE_INTENSITY) {
    return {
      wake: true,
      extraContext: '她本来已经睡着了，被这一下高强度的刺激**惊醒**了（刚被惊醒：迷糊、还没完全清醒，身体先有反应）。',
    };
  }
  return { wake: false, extraContext: '她还在睡着，这一下是轻柔的（没有把她弄醒）。' };
}

/**
 * 唤醒**执行器**（把 toyWakePlan 的判定落到 tempWake 上；tempWake 可注入 ⇒ 便于单测三条分支）。
 * @returns {{wake:boolean, extraContext:string, woke:boolean}}
 */
export function applyToyWake({ characterId, sleeping = false, intensity = 0, tempWake } = {}) {
  const plan = toyWakePlan({ sleeping, intensity });
  if (!plan.wake || typeof tempWake !== 'function') return { ...plan, woke: false };
  try {
    tempWake(characterId);
    return { ...plan, woke: true };
  } catch (err) {
    console.warn('[toys] tempWake failed:', err?.message || err);
    return { ...plan, woke: false };
  }
}

// ── 出图（§2.7，与 touch 同款两段式；§一① 的 image_prompt 现写画面）──────────

/** 把图片 URL 并进 messages.images（合并去重，不覆盖已有图；与 touch 的 attachImagesToMessage 同口径）。 */
export function attachToyImagesToMessage(msgId, urls) {
  if (!msgId || !Array.isArray(urls) || urls.length === 0) return [];
  try {
    const row = getDb().prepare('SELECT images FROM messages WHERE id = ?').get(msgId);
    let existing = [];
    try { existing = JSON.parse(row?.images || '[]') } catch (err) { existing = [] }
    const merged = [...new Set([...(Array.isArray(existing) ? existing : []), ...urls])];
    getDb().prepare('UPDATE messages SET images = ? WHERE id = ?').run(JSON.stringify(merged), msgId);
    try { invalidateGalleryCache() } catch (err) { /* 缓存失效失败不影响主流程 */ }
    return merged;
  } catch (err) {
    console.warn('[toys] 挂图失败:', err?.message || err);
    return [];
  }
}

/**
 * 玩具出图：**只用 LLM 现写的 image_prompt**（§一① 图文同源；没有画面描述就不出图，不回落写死模板），
 * 首期共用 features.touchImageMode（'never' 直接跳过，§2.7）。失败一律 null + warn。
 */
export async function generateToyImageForReaction({ character, imagePrompt = '', options = {} } = {}) {
  try {
    const mode = config.features.toyImageMode || config.features.touchImageMode || 'smart';
    if (mode === 'never') return null;
    const desc = String(imagePrompt || '').trim();
    if (!desc) return null;
    // ⚠️ 2026-10-02 兜底加固（用户："玩具触发的图和角色完全无关"）：
    //   主修在 routes/toys.js 的 characterRow（原来没 SELECT base_prompt ⇒ 外观段永远为空）。
    //   这里再兜一层：角色卡**没写 `## 你的外观` 段**时，外观段会是空串 —— 那时退回
    //   buildCharacterPersona 的 short 变体（short_prompt + 外观段，AGENTS.md 规定的生图人格统一入口），
    //   再空也至少把 display_name 塞进 prompt，绝不再出现"只有玩具、没有人"的图。
    const charObj = character || {};
    let appearance = buildCharacterAppearanceSection(charObj, { outfits: 'auto' });
    if (!appearance) {
      try {
        appearance = buildCharacterPersona(charObj, { variant: 'short', person: charObj.display_name || '角色' }) || '';
      } catch { appearance = ''; }
      if (!appearance) appearance = String(charObj.display_name || '').trim();
    }
    // 角色名/IP 标签也要进 prompt（2026-10-02 用户追问"玩具图要对当前角色外观"时实测发现）：
    //   只给外观段时，模型画出来的是"长相对了的人"，但 IP 角色的辨识度全靠外观文字硬撑；
    //   聊天链的图是带 `名字 (作品)` 标签的（出图人格入口做的），玩具链以前没有 ⇒ 这里补齐。
    const nameTag = String(charObj.display_name || '').trim();
    const prompt = [desc, nameTag, appearance].filter(Boolean).join(', ');
    const runner = typeof options.generateImage === 'function' ? options.generateImage : generateImage;
    const result = await runner(prompt, {
      scene: 'chat', workflowScene: 'chat', promptScene: 'chat',
      artist: charArtistOverride(character || {}),
      ...(options.imageOptions || {}),
    });
    if (!result?.success || !Array.isArray(result.images) || result.images.length === 0) {
      console.warn('[toys] 出图失败（不影响穿戴）:', result?.error || 'no images');
      return null;
    }
    const urls = result.images.map(img => saveBase64Image('chat', Date.now() + '_' + (img.filename || 'toy.png'), img.base64));
    return { urls, prompt, promptRefined: result.promptRefined || prompt };
  } catch (err) {
    console.warn('[toys] 出图异常（不影响穿戴）:', err?.message || err);
    return null;
  }
}

/**
 * 玩具反应**两段式**（照抄 touch §8.2 的口径）：
 *   ① 文字先落库 + 先广播（images: []）——用户 ~3s 就能看到她的反应；
 *   ② 出图**不 await**；图好了补一条 update（前端按那条气泡挂图）；失败只 warn、不发 update。
 *
 * ── 2026-10-03 群聊维度（两位独立审查者复现的 bug）─────────────────────────────
 * 用户原话：「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的 在哪里聊天就在哪里继续进行」。
 * 玩具链原来**不管什么场景都写私聊**（`deps.writeMessage` = writeProactiveMessage ⇒ `char_<id>` +
 * `proactive_message`），而群聊页只认统一流的 `group_message` / `group_message_update`
 * （`routes/groups.js` 的 emit → `web-ui/src/stores/groups.js` 的 `_enqueue`）⇒ 玩家在群聊玩具面板里
 * 戴上/调强度/摘下，她的反应与补图**全落到私聊**，群里什么也看不到（顺带绕过群聊成人闸门）。
 *
 * 现在按场景分叉，形状与 `routes/touch.js` / `routes/intimateActions.js` **逐字对齐**：
 *   · 群聊：`groupInsertMessage.writeGroupInsertMessage` 写 `group_<gid>`（raw 带「[名字]: 」前缀、
 *     messages 一行 = 一个气泡）+ 广播 `group_message`；补图广播 `group_message_update`（带整份群 payload）；
 *   · 私聊：一字未改（`proactive_message` + `proactive_message_update`，字段名不变）。
 * **不传 `scene` = 私聊**（老调用方不受影响）。补图的事件名与载荷形状**只由**
 * `services/reactionImageUpdate.js` 决定 —— 那是"两套 store 各认一条事件"的唯一收口处。
 *
 * ── 2026-10-03 复查：补图**锚点**（另一路复查发现的"图会跑"）────────────────────
 * 她的反应会被 `writeProactiveMessage` **分句成多条气泡**，而图写进的是**最后一条**
 * （`attachImages(pending.lastMsgId)`）。以前实时广播只给 `firstMsgId` ⇒ 直播时图挂在第一段后面、
 * 刷新一次又跳到**最后一段**后面（用户看到"图会跑"）。现在 `target` 把 `lastMsgId` 一起给出去
 * （`reactionImageUpdate` 优先认它）⇒ **实时广播的锚 == 落库挂图的锚**，两条气泡不会再分家。
 *
 * `deps.writeMessage` 必须由调用方注入（routes/toys.js 传 proactiveChatScheduler.writeProactiveMessage）——
 * 刻意不让本模块静态 import 那个调度器：它与本模块互相依赖，会形成循环（本仓 TDZ 血泪史）。
 * @param {object} input
 * @param {'chat'|'group'} [input.scene] 场景（群聊必须带 groupId，否则按私聊处理）
 * @param {number|string} [input.groupId]
 * @returns {{ok:boolean, written:object|null, imagePromise:Promise}}
 */
export function publishToyReaction({
  character, reactionText = '', imagePrompt = '', source = 'toy', scene = 'chat', groupId = null, deps = {},
} = {}) {
  const text = String(reactionText || '').trim();
  const isGroup = scene === 'group' && Number(groupId) > 0;
  /**
   * 群聊写入器：默认走共享的 `writeGroupInsertMessage`（与触摸 / 亲密同一条），
   * 归一成调用方认的字段名（firstMsgId / lastMsgId / rawId / segments / msgIds），
   * 并原样带上群 payload —— 补图那一步必须用**同一份** payload（少字段群聊 store 就认不出气泡）。
   */
  const writeGroupMessage = deps.writeGroupMessage || ((char, content) => {
    const inserted = writeGroupInsertMessage(groupId, char, content, { source, extra: deps.groupExtra || {} });
    if (!inserted) return null;
    return {
      rawId: inserted.rawId,
      firstMsgId: inserted.msgId,
      lastMsgId: inserted.msgId,
      msgIds: [inserted.msgId],
      segments: [content],
      seq: inserted.seq,
      groupPayload: inserted.payload,
    };
  });
  const writeMessage = isGroup ? writeGroupMessage : deps.writeMessage;
  const broadcastText = isGroup
    ? (deps.broadcastGroupText || (payload => broadcast('group_message', payload)))
    : (deps.broadcastText || broadcastProactiveMessage);
  // 补图广播接缝：私聊是旧契约（`broadcastUpdate(data)`，一个参数）；群聊单独一个口子。
  // 两个都没注入时统一走 `broadcast(update.event, update.payload)`（事件名由 reactionImageUpdate 决定）。
  const broadcastUpdate = isGroup ? deps.broadcastGroupUpdate : deps.broadcastUpdate;
  const attachImages = deps.attachImages || attachToyImagesToMessage;
  const generate = deps.generateImage || (async (char, prompt) => generateToyImageForReaction({ character: char, imagePrompt: prompt }));
  if (!text || typeof writeMessage !== 'function') return { ok: false, written: null, imagePromise: Promise.resolve(null) };

  let written = null;
  try {
    written = writeMessage(character, text);
  } catch (err) {
    console.warn('[toys] 反应写入失败（只影响上屏）:', err?.message || err);
  }
  if (!written) return { ok: false, written: null, imagePromise: Promise.resolve(null) };

  try {
    if (isGroup) {
      // 群聊 payload 由写入器给（与 `groupChatEngine.serializeMsg()` 逐字对齐）；自定义写入器没带就补最小形状
      broadcastText(written.groupPayload || {
        id: written.firstMsgId,
        group_id: Number(groupId),
        role: 'assistant',
        content: text,
        seq: written.seq ?? null,
        speaker_character_id: Number(character.id),
        speaker_name: character.display_name || character.name || '角色',
        created_at: new Date().toISOString(),
        source,
      });
    } else {
      broadcastText({
        character_id: character.id,
        display_name: character.display_name,
        avatar_path: character.avatar_path || null,
        content: text,
        segments: written.segments || [text],
        msg_ids: written.msgIds,
        msg_id: written.firstMsgId,
        raw_id: written.rawId,
        images: [],
        source,
        created_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.warn('[toys] 反应广播失败:', err?.message || err);
  }

  const pending = written;
  const imagePromise = Promise.resolve()
    .then(() => generate(character, imagePrompt))
    .then(shot => {
      if (!shot || !Array.isArray(shot.urls) || shot.urls.length === 0) return null;
      const attached = attachImages(pending.lastMsgId, shot.urls);
      if (!attached.length) return null;
      // 事件名/载荷口径的唯一来源（群 ⇒ group_message_update + 整份群 payload；私 ⇒ proactive_message_update）。
      // ⚠️ 锚点必须与**落库时挂图的那一行**同一个 id：她的反应会被分句成多条气泡，图写进的是
      // `lastMsgId`（上一行），而 `reactionImageUpdate` 现在优先认 `lastMsgId` ⇒ 实时广播与刷新后
      // 看到的是同一条气泡（以前只给 firstMsgId ⇒ 直播时图挂在第一段后面、刷新后跳到最后一段）。
      const update = reactionImageUpdate({
        scene: isGroup ? 'group' : 'chat',
        groupPayload: isGroup ? (pending.groupPayload || null) : null,
        target: { lastMsgId: pending.lastMsgId, firstMsgId: pending.firstMsgId, rawId: pending.rawId },
        images: attached,
        groupId: isGroup ? Number(groupId) : null,
        reactionText: text,
        source,
      });
      if (!update) return null;
      (broadcastUpdate || (data => broadcast(update.event, data)))(update.payload);
      return shot;
    })
    .catch(err => {
      console.warn('[toys] 配图后台生成失败（文字已在屏上，不下发 update）:', err?.message || err);
      return null;
    });
  return { ok: true, written, imagePromise };
}

/**
 * 「玩具名清单」的人话文本 —— **只给用户看的字符串必须用它**（2026-10-02）。
 *
 * 用户截图报过：心情气泡上出现
 *   💬"玩具刺激（vibe_egg / nipple_clamp / clit_sucker / … 11 件全列出来）"
 * 根因是我把英文 `toyKey` 拼进了 `emotion_snapshots.reason`。仓库规矩是
 * 「除白名单外不许把键名给用户看」，长度也得收住 ⇒ 最多列 3 件，其余折成"等 N 件"。
 */
function bondToyListText(labels) {
  const list = (Array.isArray(labels) ? labels : []).map(s => String(s || '').trim()).filter(Boolean);
  if (list.length === 0) return '玩具';
  if (list.length <= 3) return list.join('、');
  return list.slice(0, 3).join('、') + ` 等 ${list.length} 件`;
}

// ── 2026-10-02：把「她身上戴着什么」登记给生图唯一入口（characterPersona）─────────────────
//
// 为什么是**一句短的**而不是复用 `buildWornToysBlock()`：那个块是给聊天叙事用的（含情绪指引、
// 节奏曲线、多件叠加说明），塞进 image_prompt 会太长且跑题；生图只需要"看得见的佩戴物 + 强度"，
// 好让画面上真的出现它（以及它造成的轮廓/形变/线材）。
//
// 多角色场景（群聊成员卡、多人同框）由调用方传 `person`：只对那个人生效，避免"把她的玩具画到别人身上"
// （与着装归属同一套思路）。
registerWornToysProvider((characterId, { scene = 'chat', person = '' } = {}) => {
  const worn = listWornToys(characterId);
  if (!worn.length) return '';
  const who = String(person || '').trim();
  const items = worn.map((t) => {
    const toy = getToy(t.toyKey);
    const live = Number.isFinite(t.liveIntensity) ? t.liveIntensity : t.intensity;
    const parts = [t.partSection || (toy ? toy.partSection : '')];
    parts.push(toy ? intensityText(toy, live) : ('Lv' + live));
    if (t.mode && t.mode !== DEFAULT_VIBRATION_MODE) parts.push(t.modeLabel || t.mode);
    return `${t.label}（${parts.filter(Boolean).join('，')}）`;
  });
  const head = who && scene === 'group' ? `【只对「${who}」生效】` : '';
  return `${head}她身上正戴着：${items.join('、')}`
    + '——画面里必须如实画出这些佩戴物，以及它们造成的轮廓、凸起、线材或形变；不要漏画，也不要画成没戴。';
});

