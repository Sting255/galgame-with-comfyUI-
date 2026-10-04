/**
 * 角色资产「一键后台生成」队列（2026-10-01，用户原话：「弄个按钮一键后台生成得了」）
 *
 * ## 要解决的问题
 * 立绘 / 表情包 / 表情立绘一共要**一个个点开角色、在前端干等**：
 * 立绘首次生成是同步阻塞的（`characters.js` 出完图才响应），表情包的「全部生成」是前端自己写的
 * while 循环（关窗即停，`EmojiManagerModal.vue`），只有表情立绘是正经的后台 job。
 * 一次全量是 8 角色 × 32 张 ≈ 256 张 / 35~50 分钟 —— 这种事必须丢到后台、可关窗、可续跑。
 *
 * ## 设计（为什么这么写）
 * · **编排而非重写**：三类资产各自都已有成熟入口（立绘 `POST /:id/generate-standing` 同步、
 *   表情包 `POST /api/characters/emoji/{prompts,images}`、表情立绘 `POST /:id/expression-standings/generate` 202）。
 *   本模块只做**串行编排 + 记账 + 进度广播**，通过本机 HTTP 调自己的接口，
 *   不复制任何生图/提示词逻辑（复制才是以后口径走散的根源）。
 * · **全局单任务 + 严格串行**：同时只允许一个 job，单元之间串行 ⇒ ComfyUI 永远只有 1 路请求，
 *   不会把机器打爆，也不会和前台聊天抢图（前台是 high 优先级，见 imageSkill 的队列）。
 * · **只补缺靠"文件真相"**：跳过判定一律走 `imageUrlExists()`（DB 里 `status='done'` 但文件不在的
 *   情况在真机上真实存在：本次三类资产图片**磁盘上一张都没有**）⇒ 那时不能跳过，且表情包要带
 *   `includeDone: true` 才会重画这些"假 done"的行。
 * · **断点续跑**：job 行里存 `plan_json` + `cursor`；进程重启把 `running` 置 `interrupted`，
 *   resume 从 cursor 继续（已完成的单元直接跳过）。
 * · **失败不拖死整批**：单元级超时 + 失败记账，继续下一个；跑完按失败数给 `partial_failed`。
 */
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { imageUrlExists } from './imagePaths.js';
import { broadcast } from './unifiedStreamBus.js';
// 同进程直读"期望槽位 + 每槽现状"（只读、无 LLM/无生图）：表情立绘的**槽位级只补缺**要用它。
// 单元执行仍然走 HTTP 调既有入口 —— 这里只做计划，不复制任何生成逻辑。
import { listExpressionStandings } from './expressionStandingService.js';

export const ASSET_KINDS = ['standing', 'emoji', 'expressionStanding'];
export const ASSET_KIND_LABEL = Object.freeze({ standing: '立绘', emoji: '表情包', expressionStanding: '表情立绘' });

/** 单元上限：立绘与表情包提示词要过 LLM，表情立绘一批 16 张图最慢 ⇒ 给足时间但仍要有上限 */
const UNIT_TIMEOUT_MS = Object.freeze({
  standing: 300_000,
  emojiPrompts: 300_000,
  emojiImages: 900_000,
  expressionStanding: 900_000,
});
const POLL_MS = 2000;
/** 单元之间的礼貌间隔：让前台请求（聊天/触摸配图）有机会插进来 */
const UNIT_GAP_MS = 300;

let runningJobId = null;
const paused = new Set();

/** 建表（幂等；与 db/index.js 的迁移风格一致：直接 CREATE IF NOT EXISTS，不动老库结构） */
export function ensureAssetJobTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS asset_generation_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      plan_json TEXT NOT NULL DEFAULT '[]',
      cursor INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      current_label TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * 开始批量之前先问一句：ComfyUI 在不在。
 *
 * 为什么必须有（2026-10-01 用户「ComfyUI关了」）：ComfyUI 没开时每个单元都会走完
 * 「重试 3 次 → 失败」，8 角色 × 3 类要白等十几分钟才拿到一份全失败的清单。
 * 与其跑完再报错，不如**一开始就拦住并说清原因**。
 * 用 `/system_stats` 做探针（比 `/object_info` 的 2.8MB 轻得多），超时 2.5s。
 */
export async function isComfyReachable(timeoutMs = 2500) {
  const base = String(config.comfyui?.url || 'http://localhost:8188').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function newJobId() {
  return 'assetgen_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function ownBase() {
  const port = process.env.PORT || config.port || 3099;
  return `http://127.0.0.1:${port}`;
}

/** 调自己的 HTTP 接口（编排用）。超时一律带 AbortSignal，绝不无限挂。 */
async function callOwnApi(method, path, body, timeoutMs) {
  const res = await fetch(ownBase() + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就让调用方看 text */ }
  if (!res.ok) {
    const msg = json?.error || json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 表情立绘：这一角色**缺文件的槽位**（2026-10-01 规划 §一-3）。
 *
 * 原先表情立绘单元是"整批全量重出 16 张"（`startStandingBatch` 不传 slotIds = 全选），
 * 于是"只补缺"这个承诺在这一类上不成立、也白烧算力。
 * 现在按槽位逐个判**文件**（`imageUrlExists`，与立绘/表情包同一口径）：
 * · 期望槽位来自 `standingSlots()`（normal + 每个表情类别）⇒ **新增类别也算缺**，不会漏；
 * · 已 done 但文件不在的槽位同样算缺（真机上正是这种，DB 全 done、磁盘空）。
 */
export function missingExpressionStandingSlots(characterId) {
  try {
    const { slots } = listExpressionStandings(characterId) || {};
    if (!Array.isArray(slots)) return [];
    return slots
      .filter(s => !s.image_url || !imageUrlExists(s.image_url))
      .map(s => s.slot_id || s.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 该角色这一类资产是否**文件齐全**（判的是文件，不是 DB 状态） */
function kindHasAllFiles(characterId, kind) {
  const db = getDb();
  if (kind === 'standing') {
    const row = db.prepare('SELECT standing_url FROM characters WHERE id = ?').get(characterId);
    return Boolean(row?.standing_url) && imageUrlExists(row.standing_url);
  }
  if (kind === 'emoji') {
    const rows = db.prepare("SELECT image_path FROM character_emojis WHERE character_id = ? AND image_path != ''").all(characterId);
    if (rows.length === 0) return false;
    return rows.every(r => imageUrlExists(r.image_path));
  }
  if (kind === 'expressionStanding') {
    // 槽位级：期望槽位里只要有一个缺文件就算"不齐全"（且计划里会精确到那几个）
    const slots = (() => {
      try { return listExpressionStandings(characterId)?.slots || []; } catch { return []; }
    })();
    if (slots.length === 0) return false;
    return missingExpressionStandingSlots(characterId).length === 0;
  }
  return false;
}

/**
 * 展开计划：角色 × 资产类别 → 扁平单元列表。
 * `skipExisting` 为真时，文件齐全的单元直接标 skipped（不占总数、不烧算力）。
 */
export function buildAssetPlan({ characterIds = null, kinds = ASSET_KINDS, skipExisting = true } = {}) {
  const db = getDb();
  const ids = Array.isArray(characterIds) && characterIds.length
    ? characterIds.map(Number).filter(Number.isSafeInteger)
    : db.prepare('SELECT id FROM characters ORDER BY id').all().map(r => Number(r.id));
  const wanted = kinds.filter(k => ASSET_KINDS.includes(k));
  const units = [];
  let skipped = 0;
  for (const characterId of ids) {
    const character = db.prepare('SELECT id, display_name FROM characters WHERE id = ?').get(characterId);
    if (!character) continue;
    for (const kind of wanted) {
      const unit = {
        characterId,
        characterName: character.display_name || String(characterId),
        kind,
        done: false,
        attempts: 0,
        error: '',
      };
      if (skipExisting && kindHasAllFiles(characterId, kind)) { skipped++; continue; }
      units.push(unit);
    }
  }
  return { units, skipped };
}

function readJob(jobId) {
  ensureAssetJobTable();
  const row = getDb().prepare('SELECT * FROM asset_generation_jobs WHERE id = ?').get(jobId);
  if (!row) return null;
  return {
    jobId: row.id,
    status: row.status,
    plan: JSON.parse(row.plan_json || '[]'),
    cursor: Number(row.cursor) || 0,
    total: Number(row.total) || 0,
    completed: Number(row.completed) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    currentLabel: row.current_label || '',
    error: row.error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function updateJob(jobId, patch) {
  const fields = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = {
      status: 'status', plan: 'plan_json', cursor: 'cursor', total: 'total', completed: 'completed',
      failed: 'failed', skipped: 'skipped', currentLabel: 'current_label', error: 'error',
    }[key];
    if (!column) continue;
    fields.push(`${column} = ?`);
    params.push(key === 'plan' ? JSON.stringify(value) : value);
  }
  fields.push("updated_at = datetime('now')");
  params.push(jobId);
  getDb().prepare(`UPDATE asset_generation_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

/** 对外进度形状（前端只认这个） */
function jobView(job) {
  if (!job) return null;
  const failures = job.plan.filter(u => u.error).map(u => ({
    characterId: u.characterId, characterName: u.characterName, kind: u.kind,
    kindLabel: ASSET_KIND_LABEL[u.kind] || u.kind, error: u.error, attempts: u.attempts,
  }));
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    cursor: job.cursor,
    currentLabel: job.currentLabel,
    done: job.completed + job.failed >= job.total,
    failures,
    error: job.error,
  };
}

function broadcastProgress(job) {
  try { broadcast('asset_generation_progress', jobView(job)); } catch { /* 广播失败不影响生成 */ }
}

export function getAssetJob(jobId) {
  return jobView(readJob(jobId));
}

export function listAssetJobs({ active = false } = {}) {
  ensureAssetJobTable();
  const rows = active
    ? getDb().prepare("SELECT id FROM asset_generation_jobs WHERE status IN ('queued','running','paused','interrupted') ORDER BY created_at DESC").all()
    : getDb().prepare('SELECT id FROM asset_generation_jobs ORDER BY created_at DESC LIMIT 20').all();
  return rows.map(r => jobView(readJob(r.id))).filter(Boolean);
}

/**
 * 建任务。**全局只允许一个活跃任务**（同时只跑一个 job 是不把 ComfyUI 打爆的根本保证）。
 * 建完立刻返回；worker 由 `startAssetJob` 在 setImmediate 后串行跑。
 */
export async function createAssetJob({ characterIds = null, kinds = ASSET_KINDS, skipExisting = true } = {}) {
  ensureAssetJobTable();
  const active = listAssetJobs({ active: true }).filter(j => j.status === 'running' || j.status === 'queued');
  if (active.length > 0) {
    const err = new Error('已有批量任务在进行，请先暂停或等它跑完');
    err.code = 'JOB_ACTIVE';
    throw err;
  }
  // 开跑前先确认 ComfyUI 在（否则会白跑完所有单元才拿到一份全失败的清单）
  if (!(await isComfyReachable())) {
    const err = new Error('ComfyUI 连不上（没启动或还在加载），先把 ComfyUI 启动起来再点这里');
    err.code = 'COMFY_DOWN';
    throw err;
  }
  const { units, skipped } = buildAssetPlan({ characterIds, kinds, skipExisting });
  const jobId = newJobId();
  getDb().prepare(`INSERT INTO asset_generation_jobs
    (id, status, plan_json, cursor, total, completed, failed, skipped, current_label)
    VALUES (?, 'queued', ?, 0, ?, 0, 0, ?, '')`)
    .run(jobId, JSON.stringify(units), units.length, skipped);
  // ⚠️ 必须在这里就把 worker 踢起来。2026-10-01 真机验收抓到：早先版本只建了任务行、
  // 没人调 startAssetJob，任务永远停在 queued（前端看着"排队中"一直到天荒地老）。
  // 放在服务里而不是路由里，是为了让**任何**调用方都不会漏掉这一步（startAssetJob 自带幂等守卫）。
  startAssetJob(jobId);
  return { job: getAssetJob(jobId), units: units.length, skipped };
}

export function pauseAssetJob(jobId) {
  const job = readJob(jobId);
  if (!job) return null;
  paused.add(jobId);
  updateJob(jobId, { status: 'paused' });
  return getAssetJob(jobId);
}

export function resumeAssetJob(jobId) {
  const job = readJob(jobId);
  if (!job) return null;
  paused.delete(jobId);
  updateJob(jobId, { status: 'running' });
  startAssetJob(jobId);
  return getAssetJob(jobId);
}

export function cancelAssetJob(jobId) {
  const job = readJob(jobId);
  if (!job) return null;
  paused.delete(jobId);
  updateJob(jobId, { status: 'cancelled' });
  return getAssetJob(jobId);
}

/** 只重跑失败的单元（把它们的 done/error 清掉，cursor 退回第一个失败处） */
export function retryFailedAssetJob(jobId) {
  const job = readJob(jobId);
  if (!job) return null;
  const plan = job.plan.map(u => (u.error ? { ...u, done: false, error: '', attempts: 0 } : u));
  const firstFailed = plan.findIndex(u => !u.done && !u.error);
  const cursor = firstFailed === -1 ? plan.length : Math.min(job.cursor, firstFailed);
  const failedCount = plan.filter(u => !u.done).length;
  updateJob(jobId, {
    plan, cursor, status: 'running',
    failed: 0, completed: plan.filter(u => u.done).length, total: plan.length, error: '',
  });
  paused.delete(jobId);
  startAssetJob(jobId);
  return { job: getAssetJob(jobId), pending: failedCount };
}

/** 进程重启：把在跑的置为 interrupted（可 resume），不假装失败 */
export function recoverInterruptedAssetJobs() {
  ensureAssetJobTable();
  const rows = getDb().prepare("SELECT id FROM asset_generation_jobs WHERE status IN ('queued','running')").all();
  for (const row of rows) {
    updateJob(row.id, { status: 'interrupted', error: '服务重启导致中断，可继续' });
    console.log(`[assetGen] job ${row.id} 标记为 interrupted（可续跑）`);
  }
  return rows.length;
}

/** 等待表情包这一角色的行全部落定（done / failed），返回失败数 */
async function waitEmojiSettled(characterId, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const overview = await callOwnApi('GET', '/api/characters/emoji/overview', null, 30_000);
    const rows = (overview?.emojis || []).filter(e => Number(e.character_id) === characterId);
    const pending = rows.filter(e => e.status === 'generating' || e.status === 'prompt_ready');
    if (rows.length > 0 && pending.length === 0) {
      const failed = rows.filter(e => e.status === 'failed').length;
      if (failed > 0) throw new Error(`表情包有 ${failed} 张生成失败`);
      return rows.length;
    }
    if (Date.now() - started > timeoutMs) throw new Error('表情包生成超时');
    await sleep(POLL_MS);
  }
}

/**
 * 等待表情立绘批次落定 —— **认 jobId，不认槽位状态**。
 *
 * 2026-10-01 真机验收抓到的坑：早先版本轮询 `GET /:id/expression-standings` 的槽位状态，
 * 而批次是**异步**的（`/generate` 只返回 202 + jobId，真正开跑还要排队）。
 * 于是"还没开始写"的那一刻，槽位状态仍是上一次的 `done` ⇒ 轮询立刻判定"全部落定"，
 * 任务被标成 `done` —— 而磁盘上的图还在生成：
 * ```
 * 我的 job：status=done completed=3  updated_at=07:43:08
 * 立绘 job：status=generating completed=5   ← 还在跑
 * ```
 * 这就是典型的"虚假成功"。现在直接读 `expression_standing_jobs` 这一行（同进程、同一个库），
 * 直到它进入终态为止；找不到行就直接报错，绝不假装完成。
 */
async function waitExpressionStandingSettled(jobId, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const row = getDb().prepare('SELECT status, completed, error FROM expression_standing_jobs WHERE id = ?').get(jobId);
    if (!row) throw new Error('表情立绘任务不存在（jobId 未被记录）');
    const status = String(row.status || '');
    if (status === 'done') return Number(row.completed) || 0;
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(row.error || `表情立绘任务${status === 'failed' ? '失败' : '被取消'}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error('表情立绘生成超时');
    await sleep(POLL_MS);
  }
}

/** 单个单元的编排（三类资产各自调既有入口） */
async function runAssetUnit(unit) {
  const id = unit.characterId;
  if (unit.kind === 'standing') {
    // 立绘首次生成是同步接口（出完图才响应）—— 对后台 worker 正好是"await 到完成"
    await callOwnApi('POST', `/api/characters/${id}/generate-standing`, {}, UNIT_TIMEOUT_MS.standing);
    return;
  }
  if (unit.kind === 'emoji') {
    await callOwnApi('POST', '/api/characters/emoji/prompts', { character_ids: [id] }, UNIT_TIMEOUT_MS.emojiPrompts);
    // includeDone: true —— 真机上"DB 说 done、文件不在"的行必须重画（跳过判定用的是文件真相）
    await callOwnApi('POST', '/api/characters/emoji/images',
      { character_ids: [id], includeDone: true }, UNIT_TIMEOUT_MS.emojiImages);
    await waitEmojiSettled(id, UNIT_TIMEOUT_MS.emojiImages);
    return;
  }
  if (unit.kind === 'expressionStanding') {
    // 槽位级只补缺（规划 §一-3）：只把**缺文件的那几个槽位**交给批次，不再整批重出 16 张。
    const missing = missingExpressionStandingSlots(id);
    if (missing.length === 0) return;   // 防御：计划时齐了、跑到时又被补上（另一个入口刚生成过）
    const started = await callOwnApi('POST', `/api/characters/${id}/expression-standings/generate`, { slotIds: missing }, UNIT_TIMEOUT_MS.expressionStanding);
    const jobId = started?.jobId || started?.id;
    if (!jobId) throw new Error('表情立绘任务未返回 jobId（无法判定是否真的跑完）');
    await waitExpressionStandingSettled(jobId, UNIT_TIMEOUT_MS.expressionStanding);
    return;
  }
  throw new Error(`unknown asset kind: ${unit.kind}`);
}

/** worker：串行跑完 plan（中途可暂停/取消；重启后可从 cursor 续跑） */
export async function startAssetJob(jobId) {
  if (runningJobId === jobId) return getAssetJob(jobId);
  if (runningJobId) return getAssetJob(runningJobId);
  const job = readJob(jobId);
  if (!job) return null;
  if (job.status === 'cancelled') return getAssetJob(jobId);
  runningJobId = jobId;
  updateJob(jobId, { status: 'running' });

  (async () => {
    let cursor = job.cursor;
    const plan = job.plan;
    try {
      while (cursor < plan.length) {
        const current = readJob(jobId);
        if (current.status === 'cancelled') break;
        if (paused.has(jobId) || current.status === 'paused') {
          updateJob(jobId, { cursor });
          break;
        }
        const unit = plan[cursor];
        if (unit.done) { cursor++; updateJob(jobId, { cursor }); continue; }

        updateJob(jobId, { currentLabel: `${unit.characterName} · ${ASSET_KIND_LABEL[unit.kind] || unit.kind}`, cursor });
        broadcastProgress(readJob(jobId));
        try {
          await runAssetUnit(unit);
          unit.done = true;
          unit.error = '';
        } catch (err) {
          unit.attempts = (unit.attempts || 0) + 1;
          unit.error = err?.message || String(err);
          console.warn(`[assetGen] ${unit.characterName} · ${ASSET_KIND_LABEL[unit.kind]}: ${unit.error}`);
        }
        cursor++;
        const done = plan.filter(u => u.done).length;
        const failed = plan.filter(u => u.error).length;
        updateJob(jobId, { plan, cursor, completed: done, failed });
        broadcastProgress(readJob(jobId));
        await sleep(UNIT_GAP_MS);
      }
      const finalJob = readJob(jobId);
      if (finalJob.status !== 'cancelled' && finalJob.status !== 'paused' && !paused.has(jobId)) {
        const failed = finalJob.plan.filter(u => u.error).length;
        updateJob(jobId, {
          status: failed > 0 ? 'partial_failed' : 'done',
          currentLabel: '',
          plan: finalJob.plan,
          cursor: finalJob.plan.length,
        });
        broadcastProgress(readJob(jobId));
      }
    } catch (err) {
      updateJob(jobId, { status: 'failed', error: err?.message || String(err), cursor });
      broadcastProgress(readJob(jobId));
    } finally {
      runningJobId = null;
    }
  })();

  return getAssetJob(jobId);
}
