/**
 * 亲密档案与统计看板 HTTP 接口
 *
 * 挂载点：/api/characters（刻意早于 characters 路由挂载，理由同 emoji：
 * 避免 /:id 通配先吃掉带子路径的请求）。
 *
 * 口径：
 *   - 看板数据全部来自流水聚合，接口不缓存计数
 *   - 记账有两条路：服务端确定性归类（POST …/record + tags / prompt）与人工补录（POST …/log）
 *   - 撤回一轮 / 清空会话走 POST …/rollback（按 raw_id），与记忆回滚同一锚点
 *   - config.features.intimate=false 只拦"自动"入口（/record、/backfill，409），
 *     人工路径照常，保证关闭开关后数据仍可取可删
 */

import { Router } from 'express';
import { config } from '../config.js';
import {
  getIntimatePanel,
  upsertBodyProfile,
  setInjectEnabled,
  setAiJudgeEnabled,
  listIntimateLogs,
  recordIntimateActs,
  deleteIntimateLog,
  rollbackIntimateByRawId,
  setFirstAt,
  listIntimateVocabulary,
  classifyPromptTags,
  tagsFromPromptString,
  clearIntimateData,
} from '../services/intimateService.js';
import { startBackfill, getBackfillStatus, resetBackfill } from '../services/intimateBackfill.js';
import { judgeRecentRounds } from '../services/intimateAiJudge.js';

const router = Router();

/** 开关回显：前端据此判断功能是否被关掉（而不是把它当成"没数据"） */
function currentFeatures() {
  return { intimate: config.features.intimate, intimateBackfill: config.features.intimateBackfill };
}

/**
 * 亲密看板总开关闸门：只拦"自动"入口（自动记账 / 启动回填）。
 * 人工路径（补录、改档案、改设置、删除、回滚）一律不拦——否则用户关掉开关后
 * 连历史数据都取不出来，只能去改配置文件。
 * @param {Array<'intimate'|'intimateBackfill'>} keys 任一为 false 即拦截
 */
function featureDisabled(res, keys = ['intimate']) {
  const off = keys.filter(key => config.features[key] === false);
  if (off.length === 0) return false;
  res.status(409).json({ error: 'intimate feature disabled', disabled: off, features: currentFeatures() });
  return true;
}

function parseCharacterId(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

/** ?partnerKinds=user,character → 数组；未传返回 undefined（服务层回落档案 viewScope） */
function parsePartnerKinds(req) {
  const raw = req.query?.partnerKinds;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = list.map(item => String(item).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/** 统一错误映射：参数错 → 400，角色不存在 → 404，其余 500 */
function handle(res, err) {
  const message = err?.message || 'unknown error';
  if (message === 'invalid character id' || message === 'invalid argument') {
    return res.status(400).json({ error: message });
  }
  if (message === 'character not found') {
    return res.status(404).json({ error: message });
  }
  console.error('[intimate] route error:', message);
  return res.status(500).json({ error: message });
}

// GET /api/characters/:id/intimate — 面板一次读取（档案 + 里程碑 + 统计 + 计数 + 回填进度）
router.get('/:id/intimate', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(getIntimatePanel(id, { partnerKinds: parsePartnerKinds(req) }));
  } catch (err) {
    handle(res, err);
  }
});

// PUT /api/characters/:id/intimate/profile — 身体档案 + 权限/口径/回填开关（白名单字段，未传保持原值）
router.put('/:id/intimate/profile', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const body = req.body || {};
    const profile = upsertBodyProfile(id, {
      height: body.height,
      bust: body.bust,
      waist: body.waist,
      hip: body.hip,
      cup: body.cup,
      note: body.note,
      sensitiveZones: body.sensitiveZones,
      injectEnabled: body.injectEnabled,
      aiEditFields: body.aiEditFields,
      viewScope: body.viewScope,
      backfillEnabled: body.backfillEnabled,
    });
    res.json({ profile });
  } catch (err) {
    handle(res, err);
  }
});

// PUT /api/characters/:id/intimate/settings — 只改 AI 权限 / 统计口径 / 回填开关
router.put('/:id/intimate/settings', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const body = req.body || {};
    const profile = upsertBodyProfile(id, {
      aiEditFields: body.aiEditFields,
      viewScope: body.viewScope,
      backfillEnabled: body.backfillEnabled,
    });
    res.json({ profile });
  } catch (err) {
    handle(res, err);
  }
});

// PUT /api/characters/:id/intimate/inject — 面板开关：是否让角色在对话中知晓档案
router.put('/:id/intimate/inject', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const profile = setInjectEnabled(id, req.body?.enabled === true);
    res.json({ profile });
  } catch (err) {
    handle(res, err);
  }
});

// PUT /api/characters/:id/intimate/ai-judge — 面板开关：是否默认开启「AI 判断行为」（task-32）
router.put('/:id/intimate/ai-judge', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const profile = setAiJudgeEnabled(id, req.body?.enabled === true);
    res.json({ profile });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/ai-judge/run — 「AI 判断行为」按钮：补判最近若干轮
// 与 /record、/backfill 同口径：总开关关闭时 409（人工路径仍可取可删）
router.post('/:id/intimate/ai-judge/run', async (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  if (config.features.intimate === false) {
    return res.status(409).json({ error: 'intimate feature disabled' });
  }
  try {
    const summary = await judgeRecentRounds(id, { limit: req.body?.limit });
    res.json(summary);
  } catch (err) {
    handle(res, err);
  }
});

// GET /api/characters/:id/intimate/vocabulary — 行为分类 + 体位词表（id 仅作路由占位）
router.get('/:id/intimate/vocabulary', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(listIntimateVocabulary());
  } catch (err) {
    handle(res, err);
  }
});

// GET /api/characters/:id/intimate/log?limit=&offset=&partnerKinds=user,character — 流水明细
router.get('/:id/intimate/log', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const offset = Number.parseInt(req.query.offset, 10) || 0;
    res.json({ logs: listIntimateLogs(id, { limit, offset, partnerKinds: parsePartnerKinds(req) }) });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/log — 人工补录一笔
router.post('/:id/intimate/log', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const body = req.body || {};
    const result = recordIntimateActs(id, {
      scene: 'manual',
      partnerKind: body.partnerKind || 'user',
      partnerId: body.partnerId || 0,
      rawId: body.rawId || 0,
      msgId: body.msgId || 0,
      source: 'manual',
      confidence: 1,
      occurredAt: body.occurredAt,
      acts: Array.isArray(body.acts) ? body.acts : [body],
    });
    res.json({ ...result, logs: listIntimateLogs(id, { limit: 20 }) });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/record — 服务端记账（自动/LLM），可直传 tags 或生图 prompt 串
// 返回 blocked=true 表示角色未授权 stats，本次一笔都没落库；总开关关闭时直接 409
router.post('/:id/intimate/record', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  if (featureDisabled(res, ['intimate'])) return;
  try {
    const body = req.body || {};
    const tags = Array.isArray(body.tags) ? body.tags : tagsFromPromptString(body.prompt);
    const acts = Array.isArray(body.acts) && body.acts.length > 0
      ? body.acts
      : classifyPromptTags(tags);
    const result = recordIntimateActs(id, {
      scene: body.scene,
      partnerKind: body.partnerKind,
      partnerId: body.partnerId,
      rawId: body.rawId,
      msgId: body.msgId,
      source: body.source || 'auto',
      confidence: body.confidence,
      occurredAt: body.occurredAt,
      acts,
    });
    res.json({ ...result, acts, features: currentFeatures() });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/classify — 只归类不落库（联调/回归用），吃 tags 数组或 prompt 串
router.post('/:id/intimate/classify', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : tagsFromPromptString(req.body?.prompt);
    res.json({ acts: classifyPromptTags(tags), tags });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/rollback — 按 raw_id 回滚（撤回一轮 / 清空会话联动）
router.post('/:id/intimate/rollback', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const rawId = Number.parseInt(req.body?.rawId, 10);
    if (!Number.isSafeInteger(rawId) || rawId <= 0) {
      return res.status(400).json({ error: 'invalid rawId' });
    }
    res.json(rollbackIntimateByRawId(rawId));
  } catch (err) {
    handle(res, err);
  }
});

// PUT /api/characters/:id/intimate/firsts/:actKey — 人工设定初次（来源标记 manual，不被流水覆盖）
router.put('/:id/intimate/firsts/:actKey', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const first = setFirstAt(id, req.params.actKey, {
      firstAt: req.body?.firstAt ?? null,
      note: req.body?.note ?? '',
    });
    res.json({ first });
  } catch (err) {
    handle(res, err);
  }
});

// GET /api/characters/:id/intimate/backfill — 历史回填进度（只读，不加总开关闸门：开关关掉也要能看进度）
// 返回形状：顶层平铺 + backfill 同一份 —— 前端轮询直接吃顶层字段，兼容路径用 res.backfill。
router.get('/:id/intimate/backfill', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const backfill = getBackfillStatus(id);
    res.json({ ...backfill, backfill, features: currentFeatures() });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/backfill — 启动 / 继续历史回填。
// 说明：占位实现已由 task-4 的真引擎接管（不再写 body 里的 status/lastRawId 等进度字段，
// 也不再返回 placeholder 标记 —— 前端据此判断"引擎尚未接入"，引擎接了就必须消失）。
// body 可选 { maxMessages, batchSize, reset }，也支持 ?reset=1：reset 为真时先重置游标再重扫。
// 引擎后台异步推进，本接口立刻返回状态；status='running' 时前端轮询上面的 GET。
router.post('/:id/intimate/backfill', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  if (featureDisabled(res, ['intimate', 'intimateBackfill'])) return;
  try {
    const body = req.body || {};
    const reset = body.reset === true || req.query?.reset === '1' || req.query?.reset === 'true';
    if (reset) resetBackfill(id); // 只回退游标与计数，不删流水；重复扫描靠 source_uid 去重，不会翻倍
    const backfill = startBackfill(id, { maxMessages: body.maxMessages, batchSize: body.batchSize });
    res.json({ ...backfill, backfill, features: currentFeatures() });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/backfill/reset — 只重置游标（不动已有流水），下次启动从头重扫。
// 与 POST /backfill 走同一闸门；前端目前只调 POST /backfill body{}，这个显式入口供手动/联调用。
router.post('/:id/intimate/backfill/reset', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  if (featureDisabled(res, ['intimate', 'intimateBackfill'])) return;
  try {
    const backfill = resetBackfill(id);
    res.json({ ...backfill, backfill, features: currentFeatures() });
  } catch (err) {
    handle(res, err);
  }
});

// DELETE /api/characters/:id/intimate/log/:logId — 删除单条流水（人工纠错）
router.delete('/:id/intimate/log/:logId', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const logId = Number.parseInt(req.params.logId, 10);
    if (!Number.isSafeInteger(logId) || logId <= 0) {
      return res.status(400).json({ error: 'invalid log id' });
    }
    const ok = deleteIntimateLog(id, logId);
    if (!ok) return res.status(404).json({ error: 'log not found' });
    res.json({ ok: true, ...getIntimatePanel(id) });
  } catch (err) {
    handle(res, err);
  }
});

// DELETE /api/characters/:id/intimate — 清空看板数据（保留身体档案）
router.delete('/:id/intimate', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    res.json(clearIntimateData(id));
  } catch (err) {
    handle(res, err);
  }
});

export default router;
