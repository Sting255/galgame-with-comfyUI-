/**
 * 角色资产「一键后台生成」HTTP 接口（2026-10-01）
 *
 * 挂载点：`/api/asset-generation`（见 app.js）。
 *
 * 契约：
 *   POST   /jobs                  body { character_ids?, kinds?, skipExisting? } → 202 { jobId, total, skipped }
 *   GET    /jobs/:jobId           → 进度（total/completed/failed/currentLabel/failures）
 *   GET    /jobs?active=1         → 活跃任务（页面重开、重启后发现 interrupted 用它恢复）
 *   POST   /jobs/:jobId/pause | resume | cancel | retry
 *
 * 错误映射：
 *   400 plan 为空 / 参数非法
 *   404 任务不存在
 *   409 已有任务在进行（全局单任务）
 */
import { Router } from 'express';
import {
  ASSET_KINDS,
  createAssetJob,
  getAssetJob,
  listAssetJobs,
  pauseAssetJob,
  resumeAssetJob,
  cancelAssetJob,
  retryFailedAssetJob,
} from '../services/assetGenerationQueue.js';

const router = Router();

function handle(res, err) {
  const code = err?.code;
  // 仓库约定：`error` = 机器码、`message` = 给人看的话（前端 request() 对 4xx 取 message || error）。
  // 两个都带上，免得以后有人调整 fallback 顺序时用户只能看到代码。
  if (code === 'JOB_ACTIVE') return res.status(409).json({ error: err.message, message: err.message, code });
  // ComfyUI 没开：409 而不是 500 —— 这是"环境还没就绪"，不是程序出错
  if (code === 'COMFY_DOWN') return res.status(409).json({ error: err.message, message: err.message, code });
  console.warn('[assetGen] route error:', err?.message || err);
  return res.status(400).json({ error: err?.message || 'unknown error', message: err?.message || 'unknown error' });
}

router.get('/jobs', (req, res) => {
  const active = req.query.active === '1' || req.query.active === 'true';
  res.json({ jobs: listAssetJobs({ active }) });
});

router.post('/jobs', async (req, res) => {
  try {
    const { character_ids, kinds, skipExisting } = req.body || {};
    const wanted = Array.isArray(kinds) && kinds.length ? kinds.filter(k => ASSET_KINDS.includes(k)) : ASSET_KINDS;
    if (wanted.length === 0) return res.status(400).json({ error: 'kinds 里没有任何可识别的资产类别' });
    const { job, units, skipped } = await createAssetJob({
      characterIds: Array.isArray(character_ids) ? character_ids : null,
      kinds: wanted,
      skipExisting: skipExisting !== false,
    });
    if (units === 0) {
      return res.status(400).json({ error: '没有需要生成的资产（都已存在；要全重画请传 skipExisting:false）', jobId: job.jobId, skipped });
    }
    // 立刻 202 返回，真正的工作在 worker 里串行跑（绝不占住这个请求）
    res.status(202).json({ started: true, jobId: job.jobId, total: units, skipped, job });
  } catch (err) {
    handle(res, err);
  }
});

router.get('/jobs/:jobId', (req, res) => {
  const job = getAssetJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

for (const [action, fn] of [
  ['pause', pauseAssetJob],
  ['resume', resumeAssetJob],
  ['cancel', cancelAssetJob],
  ['retry', retryFailedAssetJob],
]) {
  router.post(`/jobs/:jobId/${action}`, (req, res) => {
    const result = fn(req.params.jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    res.json(result);
  });
}

export default router;
