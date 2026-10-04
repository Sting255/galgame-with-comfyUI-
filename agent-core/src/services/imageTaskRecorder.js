import { getDb } from '../db/index.js';

export function recordCompletedImageTask({
  conversationId = null,
  promptOriginal,
  promptRefined,
  outputPaths,
  style = null,
  resolution = null,
  workflowTemplate = null,
  db = getDb(),
}) {
  const paths = Array.isArray(outputPaths) ? outputPaths.filter(Boolean) : [];
  if (!promptOriginal || paths.length === 0) return null;
  const result = db.prepare(`
    INSERT INTO image_tasks (
      conversation_id, prompt_original, prompt_refined, style, resolution,
      workflow_template, status, output_paths, finished_at
    ) VALUES (?, ?, ?, ?, COALESCE(?, '1024x1024'), ?, 'done', ?, datetime('now'))
  `).run(
    conversationId,
    promptOriginal,
    promptRefined || promptOriginal,
    style,
    resolution,
    workflowTemplate,
    JSON.stringify(paths),
  );
  return Number(result.lastInsertRowid);
}

/**
 * 记录一次**失败**的生图任务（2026-10-01 补）。
 *
 * ## 为什么必须有这个
 * 奇遇 / 朋友圈 / 镇民奇遇的出图失败原来只打一行 `console.warn`，**库里一条痕迹都不留**：
 * 真机实测 `image_tasks` 里 events 相关 **120 条全部 done、0 条 failed**，而同一时段的日志里
 * 明明有两次 `All ComfyUI submit attempts exhausted`。后果是事后完全分不出这三件事：
 *   ① 根本没触发配图   ② 触发了但生成失败   ③ 生成成功但图片文件后来被弄丢了
 * 用户报「有时候生不出来」时，这三种原因的修法完全不同，却长得一模一样。
 *
 * 代价只有一行 INSERT；`output_paths` 写 `'[]'`（没有产物），`error_message` 截断到 500 字
 * 免得把 ComfyUI 的整段报错塞进库里。
 *
 * @returns {number|null} 新行 id；没有 prompt 可记时返回 null（不制造无意义的空行）
 */
export function recordFailedImageTask({
  conversationId = null,
  promptOriginal,
  promptRefined = null,
  errorMessage = null,
  style = null,
  resolution = null,
  workflowTemplate = null,
  db = getDb(),
}) {
  if (!promptOriginal) return null;
  try {
    const result = db.prepare(`
      INSERT INTO image_tasks (
        conversation_id, prompt_original, prompt_refined, style, resolution,
        workflow_template, status, output_paths, error_message, finished_at
      ) VALUES (?, ?, ?, ?, COALESCE(?, '1024x1024'), ?, 'failed', '[]', ?, datetime('now'))
    `).run(
      conversationId,
      promptOriginal,
      promptRefined || promptOriginal,
      style,
      resolution,
      workflowTemplate,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
    );
    return Number(result.lastInsertRowid);
  } catch (err) {
    // 记账失败绝不能反过来把业务链路带崩
    console.warn('[imageTaskRecorder] 记录失败任务时出错（忽略）:', err?.message || err);
    return null;
  }
}
