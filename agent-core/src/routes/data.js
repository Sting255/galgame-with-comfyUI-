/**
 * 一键导出 / 一键导入 接口
 *
 *   GET  /api/data/export?includeConfig=0|1   → 200 流式返回 linshe-backup-<YYYYMMDD-HHmm>.tar.gz
 *   GET  /api/data/export/info                → 200 { ok, dbBytes, counts, lastExportAt }
 *   POST /api/data/import                     → 200 { ok, restored, backupPath, restartRecommended, message }
 *
 * 实现口径：
 *   - 导出**先落临时文件再发**：生成过程中出错返回 500 JSON，绝不会吐半个归档给前端；
 *     发送用 res.sendFile 从磁盘流式读（不把归档读进内存），发完删临时文件。
 *   - 导入体是 .tar.gz 原始字节，用**路由级** express.raw（不动 app.js 的全局 body parser）；
 *     上限按请求现读 LINSHE_BACKUP_MAX_BYTES，超限由 body-parser 抛 entity.too.large，
 *     本路由内的错误中间件把它翻译成 413 { error, detail }。
 *   - 校验/落地全部在 services/dataBackup.js 里，本文件只负责 HTTP 形状。
 */
import express, { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  createBackup, importBackup, getExportInfo, getMaxArchiveBytes, BackupError,
} from '../services/dataBackup.js';

const router = Router();

// 路由级 raw parser：limit 按当前 LINSHE_BACKUP_MAX_BYTES 现取，同一个 limit 复用同一个 parser
const rawParsers = new Map();
function importBodyParser(req, res, next) {
  const limit = getMaxArchiveBytes();
  let parser = rawParsers.get(limit);
  if (!parser) {
    // type: () => true —— 不论客户端写的是 application/gzip 还是 octet-stream 都按原始字节收，
    // 真正的"是不是 gzip"由 service 校验文件头决定（curl 忘写 Content-Type 也能用）
    parser = express.raw({ type: () => true, limit });
    rawParsers.set(limit, parser);
  }
  return parser(req, res, next);
}

router.get('/export/info', asyncHandler(async (req, res) => {
  res.json(getExportInfo());
}));

router.get('/export', asyncHandler(async (req, res) => {
  const includeConfig = String(req.query.includeConfig ?? '0') === '1';
  let backup = null;
  try {
    backup = await createBackup({ includeConfig });
  } catch (err) {
    console.error('[data] 导出失败:', err.message);
    return res.status(500).json({
      error: '导出失败，没有生成任何归档',
      detail: err.message,
    });
  }

  // 归档已经完整落盘，这里才开始写响应头
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName}"`);
  res.setHeader('Content-Length', String(backup.bytes));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Linshe-Backup-Bytes', String(backup.bytes));

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    backup.cleanup().catch(() => {});
  };
  res.on('close', cleanup);

  res.sendFile(backup.file, err => {
    cleanup();
    if (!err) return;
    // 头已经发出去就没法改成 JSON 了，只能断开；至少把原因记下来
    console.error('[data] 归档发送中断:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '导出失败', detail: err.message });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
}));

router.post('/import', importBodyParser, asyncHandler(async (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return res.status(400).json({
      error: '请求体为空',
      detail: 'POST /api/data/import 的 body 必须是 .tar.gz 的原始字节（Content-Type: application/gzip）',
    });
  }

  try {
    const result = await importBackup(body);
    res.json({
      ok: true,
      restored: result.restored,
      backupPath: result.backupPath,
      restartRecommended: result.restartRecommended,
      message: result.message,
    });
  } catch (err) {
    if (err instanceof BackupError) {
      const status = err.status || 400;
      console.error(`[data] 导入失败(${status}):`, err.message, err.detail || '');
      if (status >= 500) {
        return res.status(500).json({ error: err.message, detail: err.detail || '', backupPath: err.backupPath });
      }
      return res.status(status).json({ error: err.message, detail: err.detail || '' });
    }
    console.error('[data] 导入失败(500):', err.message);
    res.status(500).json({ error: '导入失败', detail: err.message, backupPath: null });
  }
}));

/**
 * 本路由内的错误兜底：只处理 raw parser 抛出的解析类错误，其余交给全局 errorHandler。
 * 放在所有路由之后注册，因此只会兜到 /api/data 自己的请求。
 */
router.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: '归档超过大小上限',
      detail: `上限 ${getMaxArchiveBytes()} 字节（可用环境变量 LINSHE_BACKUP_MAX_BYTES 覆盖）`,
    });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(400).json({ error: '请求体无法解析', detail: err.message });
  }
  next(err);
});

export default router;
