import { getDb } from '../db/index.js';
import {
  TOUCH_ACTION_MAP,
  TOUCH_LEVEL_LABELS,
  annoyanceTier,
} from './touchActionService.js';

/**
 * 触摸动作统计聚合（task-19 · 阶段三）——**只读**，供前端统计面板用。
 *
 * 口径（docs/touch-system.md §3.6 为唯一契约说明）：
 *   · 数据源：`touch_events`（明细）+ `character_touch_state`（每动作当前腻烦/偏好）
 *     + `character_intimate_log`（Lv3 的看板记账，`source_uid LIKE 'touch:%'`）
 *     + `image_tasks`（配图，`style = 'touch-action'`，只统计私聊会话 `char_<id>`）；
 *   · 时间一律转 **ISO 串**（库里是无时区 UTC → 补 Z 再 toISOString，与其它接口同口径）；
 *   · `daily` 只覆盖最近 `days` 天（默认 14，上限 90），空数据返回空数组而不是 null。
 *
 * 纯读 + 多次聚合查询；不写任何表。
 */

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;
const DEFAULT_RECENT = 10;

/** 统计面板用的配图标记（写 image_tasks 时的 style），与路由里的常量必须一致 */
export const TOUCH_IMAGE_TASK_STYLE = 'touch-action';

/** SQLite 无时区 UTC 串 → ISO；解析不了就原样返回（不抛） */
function toIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const sqliteLike = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
  const at = Date.parse(sqliteLike ? raw.replace(' ', 'T') + 'Z' : raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : raw;
}

function levelLabel(level) {
  return TOUCH_LEVEL_LABELS[level] || ('Lv' + level);
}

/**
 * @param {number|string} characterId
 * @param {{days?:number, recent?:number, db?:object}} [options]
 * @returns {object} 形状见 docs/touch-system.md §3.6
 */
export function getTouchStats(characterId, { days = DEFAULT_DAYS, recent = DEFAULT_RECENT, db = getDb() } = {}) {
  const id = Number(characterId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid character id');

  const windowDays = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(days, 10) || DEFAULT_DAYS));
  const recentLimit = Math.min(50, Math.max(0, Number.parseInt(recent, 10) || DEFAULT_RECENT));
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  // ① 明细：按 (动作, 模式, 状态) 分组，再在内存里并成「每动作一行」
  const grouped = db.prepare(`
    SELECT action_key, mode, status,
           COUNT(*) AS count,
           MAX(created_at) AS last_at,
           MAX(annoyance) AS peak_annoyance,
           AVG(annoyance) AS avg_annoyance
      FROM touch_events
     WHERE character_id = ?
     GROUP BY action_key, mode, status
  `).all(id);

  const byActionMap = new Map();
  const totals = {
    events: 0, injected: 0, pending: 0, done: 0, expired: 0, dropped: 0,
    byMode: { instant: 0, implicit: 0 },
    peakAnnoyance: 0,
  };
  const levelCounts = new Map();
  for (const row of grouped) {
    const actionKey = String(row.action_key || '');
    const action = TOUCH_ACTION_MAP[actionKey] || null;
    const count = Number(row.count) || 0;
    const mode = row.mode === 'instant' ? 'instant' : 'implicit';
    const status = ['pending', 'done', 'injected', 'expired', 'dropped'].includes(row.status) ? row.status : 'pending';
    const level = action?.level || 0;

    if (!byActionMap.has(actionKey)) {
      byActionMap.set(actionKey, {
        actionKey,
        label: action?.label || actionKey,
        level,
        levelLabel: levelLabel(level),
        intimateActKey: action?.intimateActKey || null,
        count: 0,
        lastAt: null,
        byMode: { instant: 0, implicit: 0 },
        byStatus: { pending: 0, done: 0, injected: 0, expired: 0, dropped: 0 },
        peakAnnoyance: 0,
        _annoyanceWeighted: 0,
      });
    }
    const entry = byActionMap.get(actionKey);
    entry.count += count;
    entry.byMode[mode] += count;
    entry.byStatus[status] += count;
    entry.peakAnnoyance = Math.max(entry.peakAnnoyance, Math.round(Number(row.peak_annoyance) || 0));
    entry._annoyanceWeighted += (Number(row.avg_annoyance) || 0) * count;
    const lastAt = toIso(row.last_at);
    if (lastAt && (!entry.lastAt || lastAt > entry.lastAt)) entry.lastAt = lastAt;

    totals.events += count;
    totals[status] = (totals[status] || 0) + count;
    totals.byMode[mode] += count;
    totals.peakAnnoyance = Math.max(totals.peakAnnoyance, Math.round(Number(row.peak_annoyance) || 0));
    if (level > 0) levelCounts.set(level, (levelCounts.get(level) || 0) + count);
  }

  // ② 每动作的当前腻烦 / 偏好（character_touch_state）
  const stateRows = db.prepare(
    'SELECT action_key, annoyance, like_ratio FROM character_touch_state WHERE character_id = ?'
  ).all(id);
  for (const row of stateRows) {
    const entry = byActionMap.get(String(row.action_key || ''));
    if (!entry) continue;
    entry.currentAnnoyance = Math.round(Number(row.annoyance) || 0);
    entry.annoyanceTier = annoyanceTier(entry.currentAnnoyance);
    entry.likeRatio = Number(row.like_ratio) || 1;
  }

  // ③ 看板记账（Lv3 动作的 source_uid 前缀固定是 touch:）
  let intimateActs = 0;
  try {
    const intimateRows = db.prepare(`
      SELECT act_key, COUNT(*) AS count FROM character_intimate_log
       WHERE character_id = ? AND source_uid LIKE 'touch:%'
       GROUP BY act_key
    `).all(id);
    for (const row of intimateRows) {
      const count = Number(row.count) || 0;
      intimateActs += count;
      const entry = [...byActionMap.values()].find(e => e.intimateActKey === row.act_key);
      if (entry) entry.intimateActs = (entry.intimateActs || 0) + count;
    }
  } catch { /* 老库缺表时不影响其它统计 */ }
  totals.intimateActs = intimateActs;

  // ④ 配图（出图联动写的 image_tasks；私聊会话口径）
  let images = 0;
  try {
    images = Number(db.prepare(
      'SELECT COUNT(*) AS count FROM image_tasks WHERE conversation_id = ? AND style = ?'
    ).get('char_' + id, TOUCH_IMAGE_TASK_STYLE)?.count) || 0;
  } catch { /* 同上 */ }
  totals.images = images;

  // ⑤ 按天（最近 windowDays 天；只回有数据的天）
  const dailyRows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
      FROM touch_events
     WHERE character_id = ? AND created_at >= ?
     GROUP BY date ORDER BY date ASC
  `).all(id, cutoff);

  // ⑥ 最近 N 条明细
  const recentRows = recentLimit > 0 ? db.prepare(`
    SELECT id, action_key, mode, status, annoyance, like_ratio, reaction, facial_expression, created_at
      FROM touch_events WHERE character_id = ? ORDER BY id DESC LIMIT ?
  `).all(id, recentLimit) : [];

  const byAction = [...byActionMap.values()]
    .map(entry => {
      const { _annoyanceWeighted, ...rest } = entry;
      return {
        ...rest,
        avgAnnoyance: entry.count > 0 ? Math.round(_annoyanceWeighted / entry.count) : 0,
        currentAnnoyance: rest.currentAnnoyance ?? 0,
        annoyanceTier: rest.annoyanceTier || annoyanceTier(0),
        likeRatio: rest.likeRatio ?? 1,
        images: 0,
        intimateActs: rest.intimateActs || 0,
      };
    })
    .sort((a, b) => b.count - a.count || a.actionKey.localeCompare(b.actionKey));

  return {
    characterId: id,
    generatedAt: new Date().toISOString(),
    range: { days: windowDays, from: toIso(cutoff) },
    totals,
    byAction,
    byLevel: [...levelCounts.entries()]
      .map(([level, count]) => ({ level, label: levelLabel(level), count }))
      .sort((a, b) => a.level - b.level),
    daily: dailyRows.map(row => ({ date: String(row.date || ''), count: Number(row.count) || 0 })),
    recent: recentRows.map(row => {
      const action = TOUCH_ACTION_MAP[row.action_key] || null;
      const annoyance = Math.round(Number(row.annoyance) || 0);
      return {
        id: Number(row.id),
        actionKey: row.action_key,
        label: action?.label || row.action_key,
        level: action?.level || 0,
        mode: row.mode === 'instant' ? 'instant' : 'implicit',
        status: row.status,
        annoyance,
        annoyanceTier: annoyanceTier(annoyance),
        likeRatio: Number(row.like_ratio) || 1,
        reaction: row.reaction || null,
        facialExpression: row.facial_expression || null,
        createdAt: toIso(row.created_at),
      };
    }),
  };
}
