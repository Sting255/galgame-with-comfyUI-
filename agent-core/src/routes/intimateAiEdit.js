/**
 * 亲密档案 AI 整理接口（让 AI 根据最近的对话整理档案）
 *
 * 挂载点：/api/characters（与 routes/intimate.js 同一落点，理由相同：
 * /:id/intimate/ai-edit* 必须早于 characters 路由挂载，否则会被 /:id 通配先吃掉）。
 *
 * 口径：
 *   - 只有 POST …/ai-edit 会调 LLM（一次）；列表 / 采纳 / 忽略都是纯数据库操作，不烧 token
 *   - 总开关 config.features.intimate=false → POST …/ai-edit 直接 409（AI 整理属"自动"路径，
 *     与 /record、/backfill 同待遇）；列表 / 采纳 / 忽略不拦，理由同 intimate 路由：
 *     关掉开关也要能看和清理已经产生的提议，否则用户被锁死
 *   - LLM 未配置（无 Key 且没开免费鸡蛋）→ 503 { error: 'llm not configured' }，
 *     前端据此提示"尚未配置 LLM"，不让用户看到 SDK 的英文原始报错
 *   - 写档案完全交给服务层的 isAiEditAllowed 分流：未授权字段只会变成 pending 提议，
 *     采纳（用户显式确认）才落库
 */

import { Router } from 'express';
import { config, getLlmConfig } from '../config.js';
import {
  proposeProfileEdits,
  listSuggestions,
  acceptSuggestion,
  rejectSuggestion,
} from '../services/intimateAiEdit.js';

const router = Router();

function parseCharacterId(req) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function parseSuggestionId(req) {
  const id = Number.parseInt(req.params.sid, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

function currentFeatures() {
  return { intimate: config.features.intimate, intimateBackfill: config.features.intimateBackfill };
}

/** 总开关闸门（只拦要调 LLM 的自动入口） */
function featureDisabled(res) {
  if (config.features.intimate !== false) return false;
  res.status(409).json({ error: 'intimate feature disabled', disabled: ['intimate'], features: currentFeatures() });
  return true;
}

/** LLM 未配置闸门：提前挡掉，避免把 openai SDK 的英文报错直接甩给用户 */
function llmMissing(res) {
  if (getLlmConfig().hasApiKey) return false;
  res.status(503).json({ error: 'llm not configured' });
  return true;
}

/** 统一错误映射：参数错 → 400，角色 / 提议不存在 → 404，其余（含 LLM 失败）→ 502 中文提示 */
function handle(res, err) {
  const message = err?.message || 'unknown error';
  if (message === 'invalid character id' || message === 'invalid argument' || message === 'invalid suggestion payload') {
    return res.status(400).json({ error: message });
  }
  if (message === 'character not found') {
    return res.status(404).json({ error: message });
  }
  console.error('[intimate-ai-edit] route error:', message);
  return res.status(502).json({ error: `AI 整理失败：${message}` });
}

// GET /api/characters/:id/intimate/ai-edit/suggestions — 待确认提议列表（默认只看 pending）
router.get('/:id/intimate/ai-edit/suggestions', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  try {
    const status = req.query.status === undefined ? 'pending' : (String(req.query.status) || null);
    res.json({ suggestions: listSuggestions(id, { status }) });
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/ai-edit — 让 AI 整理一次：
// 已授权字段立即写入（applied），未授权字段只落 pending 提议（suggestions）
router.post('/:id/intimate/ai-edit', async (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  if (featureDisabled(res)) return;
  if (llmMissing(res)) return;
  try {
    const result = await proposeProfileEdits(id, { sourceCharLimit: req.body?.sourceCharLimit });
    res.json(result);
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/ai-edit/suggestions/:sid/accept — 采纳：写入档案，status → accepted
router.post('/:id/intimate/ai-edit/suggestions/:sid/accept', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  const sid = parseSuggestionId(req);
  if (!sid) return res.status(400).json({ error: 'invalid suggestion id' });
  try {
    const result = acceptSuggestion(id, sid);
    if (!result) return res.status(404).json({ error: 'suggestion not found' });
    res.json(result);
  } catch (err) {
    handle(res, err);
  }
});

// POST /api/characters/:id/intimate/ai-edit/suggestions/:sid/reject — 忽略：只改状态，不动档案
router.post('/:id/intimate/ai-edit/suggestions/:sid/reject', (req, res) => {
  const id = parseCharacterId(req);
  if (!id) return res.status(400).json({ error: 'invalid character id' });
  const sid = parseSuggestionId(req);
  if (!sid) return res.status(400).json({ error: 'invalid suggestion id' });
  try {
    const result = rejectSuggestion(id, sid);
    if (!result) return res.status(404).json({ error: 'suggestion not found' });
    res.json(result);
  } catch (err) {
    handle(res, err);
  }
});

export default router;
