import './src/envCheck.js'; // 必须最先执行：Node ABI 预检，防 better-sqlite3 加载崩溃
import express from 'express';
import cors from 'cors';
import path from 'path';
import net from 'net';
import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { config, autoDetectWorkflowMode } from './src/config.js';
import { getDb, closeDb } from './src/db/index.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import { asyncHandler, wrapRouterAsync } from './src/middleware/asyncHandler.js';
import { imageAvifFallback } from './src/middleware/imageAvifFallback.js';
import { healthCheck as vectorHealth } from './src/services/vectorClient.js';
import chatRoutes from './src/routes/chat.js';
import memoryRoutes from './src/routes/memory.js';
import imagesRoutes from './src/routes/images.js';
import charactersRoutes from './src/routes/characters.js';
import emojiRoutes from './src/routes/emoji.js';
import intimateRoutes from './src/routes/intimate.js';
import hypnosisRoutes, { phoneRouter as hypnosisPhoneRoutes } from './src/routes/hypnosis.js';
import intimateAiEditRoutes from './src/routes/intimateAiEdit.js';
import touchRoutes from './src/routes/touch.js';
import toysRoutes from './src/routes/toys.js';
// 性爱交互姿势（2026-10-01，task-1）：可点击推进（继续抽插/加速/换姿势/停下）+ 角色实时反馈
import intimateActionRoutes from './src/routes/intimateActions.js';
import configRoutes from './src/routes/config.js';
import momentsRoutes from './src/routes/moments.js';
import relationshipsRoutes from './src/routes/relationships.js';
import userRelationshipsRoutes from './src/routes/userRelationships.js';
import portraitsRoutes from './src/routes/portraits.js';
import notificationsRoutes from './src/routes/notifications.js';
import eventsRoutes from './src/routes/events.js';
import streamRoutes from './src/routes/stream.js';
import expressionStandingRoutes from './src/routes/expressionStandings.js';
import assetGenerationRoutes from './src/routes/assetGeneration.js';
import { recoverInterruptedAssetJobs } from './src/services/assetGenerationQueue.js';
import scheduleRoutes from './src/routes/schedule.js';
import timeRoutes from './src/routes/time.js';   // 程序时间（世界钟）：/api/time*
import workflowsRoutes from './src/routes/workflows.js';
import mailboxRoutes from './src/routes/mailbox.js';
import groupsRoutes from './src/routes/groups.js';
import libraryRoutes from './src/routes/library.js';
import itemsRoutes from './src/routes/items.js';
import newspaperRoutes from './src/routes/newspaper.js';
import townRoutes from './src/routes/town.js';
import contextRoutes from './src/routes/context.js';
import dataRoutes from './src/routes/data.js';   // 一键导出/导入全部数据
import maibotBridgeRoutes from './src/maibot-bridge/router.js';
import { autoRestoreMissing } from './src/services/workflowTemplates.js';
import { startMomentScheduler } from './src/services/momentScheduler.js';
import { startSpecialMomentScheduler } from './src/services/scheduleSpecialMoment.js';
import { startProactiveChatScheduler } from './src/services/proactiveChatScheduler.js';
import { startEventScheduler } from './src/services/eventScheduler.js';
import { startDisturbScheduler } from './src/services/disturbModeScheduler.js';
import { startReplyQueueScheduler } from './src/services/replyQueueScheduler.js';
// 2026-10-01：世界翻篇（程序日切换）——启动补一次，覆盖"关机跨天"
import { runProgramDayRollover } from './src/services/programDayRollover.js';
import { initialize as initScheduleManager } from './src/services/scheduleManager.js';
import { startScheduler as startImageCompressor } from './src/services/imageCompressor.js';
import { startMailboxScheduler } from './src/services/mailboxScheduler.js';
import { startWeatherScheduler } from './src/services/weatherService.js';
import { startGroupIdleScheduler } from './src/services/groupIdleScheduler.js';
// 2026-10-02：「自动继续抽插」的服务端 ticker（用户原话：「自动抽插并没有自动 只是点一下
// 后面就没有角色的反应和图了」）—— 没有它时，她只在"下一条动作进来"时才补算推进。
import { startIntimateAutoThrust } from './src/services/intimateAutoThrust.js';
import { startKnowledgeSyncScheduler } from './src/services/imagePromptKnowledge.js';
import { startItemScheduler } from './src/services/itemScheduler.js';
import { applyFromConfig } from './src/services/llmConcurrency.js';
import { startTownScheduler, stopTownScheduler } from './src/services/town/townService.js';
import { startTownNpcStockScheduler, stopTownNpcStockScheduler } from './src/services/town/townNpcStockScheduler.js';
import { restoreInitJob } from './src/services/town/townInitService.js';
import { refresh as refreshCharSearch } from './src/services/characterSearch.js';
import { ensureDefaultMemoryIndexes, ensureVectorIndexConsistency, stopMemoryIndexWorker } from './src/services/memory/memoryRepository.js';
import { startConsolidationScheduler, stopConsolidationScheduler } from './src/services/memory/consolidationScheduler.js';
import { initFileLogging, getFileLogging } from './src/utils/fileLogger.js';

// 日志落盘：把 console 输出**同时**镜像到 <仓库根>/logs/backend-YYYY-MM-DD.log
// （启动器只用 QProcess 把 stdout 灌进界面日志控件，不落盘；落盘后排查/发给别人都不用截图了）。
// 放在所有 import 之后、任何 getDb()/迁移之前 —— 启动期的迁移日志也要进文件。
// 失败只 warn，不影响主流程；可用 LOG_TO_FILE=false 关闭。
const fileLog = initFileLogging();
if (fileLog) {
  console.log(`[log] 日志文件：${fileLog.file}（保留 ${fileLog.keepDays} 天；LOG_TO_FILE=false 可关闭）`);
}

/**
 * ── 起跑线检查：端口**能不能监听**（在任何 getDb() / 迁移 / 调度器之前）────────────────
 *
 * 为什么要有这一道（2026-10-04 真机日志 backend-2026-10-04.log 里的事故）：
 *   `app.listen()` 在文件末尾，而第二次启动时**库已经开过、迁移已经跑完、调度器已经起好** ——
 *   实测第二个实例把 `[town]` / `[consolidation]` / `[itemScheduler]` 的启动日志全刷了出来，
 *   然后才报 `listen EADDRINUSE: address already in use :::3099`（日志见文件末尾 uncaughtException）。
 *
 *   而 `process.on('uncaughtException')` 只打印、不退出 ⇒ 进程**带病活着**：
 *   后台调度器日志一直刷，看起来"还在跑"，但用户打开页面永远连不上、接口全部无响应。
 *
 *   比"僵尸进程"更严重的是**两个进程同时打开同一个 SQLite 文件** —— 那是数据损坏的头号风险。
 *   所以这里提前把端口抢一次：**抢不到就立刻退，一个字节都不碰数据库。**
 *
 * 与文件末尾 `server.on('error')` 的分工：这一道是"尽可能早"，那一道是"万一还是漏了"的兜底。
 */
await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (err) => {
    const code = err?.code || '';
    console.error(`[agent-core] 端口 ${config.port} 不可用（${code}）：${err.message}`);
    if (code === 'EADDRINUSE') {
      console.error(`[agent-core] 端口 ${config.port} 已被占用 —— 多半是**已经有一个实例在跑**。`);
      console.error('[agent-core] 请先关掉它（POST /api/shutdown，或直接结束那个进程）再启动。'
        + '本次启动退出，**没有触碰数据库**。');
    }
    process.exit(1);
  });
  probe.once('listening', () => probe.close(() => resolve()));
  probe.listen(config.port);
});

const app = express();

// 静态资源锚定 agent-core/，不随启动 cwd 漂移（从别处启动时曾静默落到空目录）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
// 仓库根目录：发布包里 agent-core 与 VERSION 同级（VERSION 由 `npm run tag` 写入）
const ROOT_DIR = path.join(__dirname, '..');

// 中间件
app.use(cors());
// 刻意不使用 compression 中间件（v3.4.0 加过，已整体移除）。两条理由，改回来之前先读：
//   1) 正确性：它的默认 filter 认为 text/event-stream 可压缩（compressible 返回 true），
//      会把 SSE 接进 zlib/brotli 变换流，事件被缓冲在压缩缓冲里下不去。
//      gzip/deflate 是「响应头能发、body 0 字节」，br 更狠「连响应头都发不出去」；
//      浏览器必带 Accept-Encoding，服务端必选中一种编码 ⇒ 实时推送 100% 静默失效
//      （瞄一眼图片、流式回复、主动消息、群聊/朋友圈事件全挂，且不报错）。
//      用户侧可复现的现场（真实 agent-core，curl 带浏览器同款 Accept-Encoding）：
//        br+gzip → http=000，5 秒内 0 字节，连响应头都收不到
//        gzip    → 200 且响应头到达，body 只有 gzip 头部字节，事件全被扣在压缩缓冲里
//        不发    → event: connected 立即到达
//      移除本中间件后：三种 Accept-Encoding 全部无 Content-Encoding，
//        event: connected 在 +25ms 到达、:keepalive 在 +30037ms 独立到达（增量推送恢复）。
//      对用户的实际表现：私聊撞前端 30s 安全超时并提示"请求超时，请重试"，
//        群聊无超时则一直等到整轮结束才一次性刷出；消息其实都已落库，刷新就能看到全部
//        —— 于是被误判成"连接不畅"，而生成早已照常计费。
//   2) 收益：本项目以本机/局域网为主，瓶颈已从带宽转到 CPU。实测 gzip level 6 压
//      11.67MB JSON 需 263ms、只压到 4.02MB，平衡点 ≈29 MB/s(233Mbps)；
//      而 WiFi5/6 有效吞吐 50~150 MB/s 远高于它 ⇒ 压了反而更慢（12MB 接口 117ms → 303ms）。
// 若将来确需压缩（如公网/蜂窝访问），必须显式排除 text/event-stream，并建议降档
// （另需 import zlib from 'node:zlib'）：
//   compression({ level: 1, brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } } })
//   （gzip 263→134ms、brotli 194→58ms，平衡点抬到 ≈134 MB/s）
app.use(express.json({ limit: '10mb' }));

// 静态文件（Vue 前端，构建后）
// 带内容哈希的资源（/assets/*，含字体）可长缓存；index.html 保持可即时更新
app.use(express.static(PUBLIC_DIR, {
  // `cacheControl: false`：把 Cache-Control 的**唯一权威**交给下面的 setHeaders。
  // 不关的话 express/send 会按自己的 maxAge 再写一次头，把这里设的值**覆盖掉** ——
  // 2026-10-01 验收实测踩到：index.html 拿到的是 `public, max-age=0`（express 默认），
  // 我设的 `no-cache` 根本没生效（"显式承诺"成了空话）。
  cacheControl: false,
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30d（带内容哈希，可长缓存）
      return;
    }
    // 2026-10-01（代码优化规划 §三-3）：给 index.html 一条**显式**承诺。
    // 它是唯一能把浏览器引向新产物 hash 的入口（每次前端重建都会变）。原来只依赖 express.static
    // 的默认 ETag —— 那也是 304，但属"默认行为"而非"承诺"：中间层只要自作主张缓存住旧 index，
    // 页面就会白屏或去引用已被删掉的旧 bundle（第七轮真踩过）。
    // `no-cache` 的语义是"每次回源验证"（有 ETag 就是 304，不是不缓存），正是我们要的。
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// 图片编辑任务暂存预览（重新生成 / HiresFix 细化确认前）
app.use('/images/.pending', express.static(path.join(DATA_DIR, 'images', '.pending'), { dotfiles: 'allow', index: false, maxAge: '5m' }));

// 图片存储目录（AVIF 自适应：请求 .png 时若同名 .avif 存在则返回 AVIF）
app.use('/images', imageAvifFallback(path.join(DATA_DIR, 'images')));
app.use('/images', express.static(path.join(DATA_DIR, 'images'), { maxAge: '7d' }));
app.use('/avatars', express.static(path.join(DATA_DIR, 'avatars'), { maxAge: '30d' }));

// 小镇像素素材（独立于 data/images，不进图库/压缩扫描；不带强缓存，素材重生成后刷新即生效）
//
// 2026-10-01 核实（代码优化规划 §三-2 提出"若是哈希命名就该加长缓存"）：
// 实测文件名是**混合**的 —— `asset_11_xxx_<uuid>.png`（uuid 名，可长缓存）
// 与 `asset_10_milky_pond_01_source.png`（**固定名**，重新生成会原地覆盖）。
// 固定名那一类一旦加了长缓存，重生成后浏览器会一直拿旧图 ⇒ 结论：**维持不带强缓存**，
// 这条注释就是防止后来者只看 uuid 名就顺手加 maxAge。
app.use('/town-assets', express.static('data/town/assets'));

// API 路由（wrapRouterAsync：给所有 async 处理器加 rejection 兜底，防请求挂起）
app.use('/api', wrapRouterAsync(expressionStandingRoutes));
app.use('/api', wrapRouterAsync(chatRoutes));           // /api/characters/:id/chat, /api/characters/:id/messages
app.use('/api/memory', wrapRouterAsync(memoryRoutes));
app.use('/api/images', wrapRouterAsync(imagesRoutes));
// 角色资产「一键后台生成」（2026-10-01）：独立前缀，与 /api/characters 的 /:id 通配无冲突
app.use('/api/asset-generation', wrapRouterAsync(assetGenerationRoutes));
// 性爱交互姿势（task-1）：**独立前缀**，不塞进 /api/characters 那串（那边有"相邻挂载"的冻结契约）
app.use('/api/intimate-actions', wrapRouterAsync(intimateActionRoutes));
app.use('/api/characters/emoji', wrapRouterAsync(emojiRoutes));  // 表情包管理（必须早于 /api/characters 挂载）
// SLG 动作系统：/:id/touch* 同样必须早于 /api/characters 挂载（characters 的 /:id 通配会先吃掉这一族子路径）。
// 整块排在 hypnosis 家族之前，**刻意不夹进** intimate → characters 的紧邻区间
// （test/intimateApi.test.js / test/intimateAiEdit.test.js 断言两者之间不夹别的挂载）。
app.use('/api/characters', wrapRouterAsync(touchRoutes));
// 成人玩具系统：/:id/toys* —— 同样必须早于 /api/characters 挂载（理由同 touch），
// 插在 touch 与 hypnosis 之间，不破坏 test/intimateApi.test.js 的「intimate → characters 紧邻」断言。
app.use('/api/characters', wrapRouterAsync(toysRoutes));
// 催眠手机：/:id/hypnosis* 也必须早于 /api/characters 挂载（理由同上）。
// 刻意挂在 intimate 家族**之前**，让 intimate → characters 仍然紧邻
// （test/intimateApi.test.js 断言这两行之间不夹别的挂载）
app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));
app.use('/api/hypnosis', wrapRouterAsync(hypnosisPhoneRoutes));  // 背包直接领取催眠手机
// 亲密档案与统计看板：/:id/intimate* 必须早于 /api/characters 挂载，
// 否则 characters 路由的 /:id 通配会把这一族子路径先吃掉（同 emoji 的理由）
// AI 整理档案（/:id/intimate/ai-edit*）是同一族的子路径，同样要在 charactersRoutes 之前；
// 刻意挂在 intimateRoutes **之前**，让 intimate → characters 仍然紧邻
// （test/intimateApi.test.js 断言这两行之间不夹别的挂载）
app.use('/api/characters', wrapRouterAsync(intimateAiEditRoutes));
app.use('/api/characters', wrapRouterAsync(intimateRoutes));
app.use('/api/characters', wrapRouterAsync(charactersRoutes));  // /api/characters CRUD
app.use('/api/config', wrapRouterAsync(configRoutes));
app.use('/api/moments', wrapRouterAsync(momentsRoutes));
app.use('/api/relationships', wrapRouterAsync(relationshipsRoutes));
app.use('/api/user-relationships', wrapRouterAsync(userRelationshipsRoutes));
app.use('/api/portraits', wrapRouterAsync(portraitsRoutes));
app.use('/api/notifications', wrapRouterAsync(notificationsRoutes));
app.use('/api/events', wrapRouterAsync(eventsRoutes));
app.use('/api/stream', wrapRouterAsync(streamRoutes));
app.use('/api/schedule', wrapRouterAsync(scheduleRoutes));
app.use('/api/time', wrapRouterAsync(timeRoutes));   // 程序时间：GET /api/time、POST /api/time/{advance,period,set,reset}
app.use('/api/workflows', wrapRouterAsync(workflowsRoutes));
app.use('/api/mailbox', wrapRouterAsync(mailboxRoutes));
app.use('/api/groups', wrapRouterAsync(groupsRoutes));
app.use('/api/library', wrapRouterAsync(libraryRoutes));   // /api/library/event-types, /api/library/topics
app.use('/api/items', wrapRouterAsync(itemsRoutes));
app.use('/api/newspaper', wrapRouterAsync(newspaperRoutes));   // /api/newspaper/today 《小镇早知道》
app.use('/api/town', wrapRouterAsync(townRoutes));
app.use('/api/context', wrapRouterAsync(contextRoutes));   // /api/context/usage, /api/context/compress
app.use('/api/data', wrapRouterAsync(dataRoutes));         // /api/data/export, /api/data/export/info, /api/data/import

app.use('/api/maibot', wrapRouterAsync(maibotBridgeRoutes));

// 应用自身版本号（仓库根目录 VERSION，不带 v 前缀）
// 前端「有更新噢」拿它当本地版本去比 GitHub 上的 tag —— 这一步只读本地文件、不碰网络，
// 所以放后端；查 GitHub 那一步是浏览器直连，见 web-ui/src/utils/githubUpdate.js
app.get('/api/version', (req, res) => {
  let version = '';
  try {
    // 每次现读：文件只有几个字节，省得更新之后内存里的旧值跟实际装的对不上
    version = readFileSync(path.join(ROOT_DIR, 'VERSION'), 'utf-8').trim();
  } catch {
    // VERSION 缺失（非标准部署）时返回空串，前端据此跳过更新提示
  }
  res.json({ version });
});

// 健康检查
app.get('/api/health', asyncHandler(async (req, res) => {
  const vectorOk = await vectorHealth();
  res.json({
    status: 'ok',
    vector_service: vectorOk ? 'ok' : 'down',
    timestamp: new Date().toISOString(),
  });
}));

// 错误处理
app.use(errorHandler);

// ── 启动 ──
console.log('============================================');
console.log('  邻舍.EXE - 旮旯给木就是这样的！');
console.log('============================================');

// 初始化数据库
getDb();
console.log('[db] SQLite initialized');

// 启动自动压缩：清理任务删除大量行后，SQLite 只把页还回内部空闲列表，文件对操作系统的
// 占用不变。空闲页占比超阈值时在监听端口前做一次 VACUUM（阻塞启动数秒到数分钟，一次性
// 成本），把磁盘空间真正归还；刚清理过的库空闲占比为 0 会直接跳过。失败（如磁盘不足）
// 仅告警，不阻断启动。DB_AUTO_VACUUM=0 可关闭。
compactDatabaseIfFragmented();
trimImageTaskHistory();

/**
 * 生图任务历史瘦身：老任务的提示词文本（prompt_original/prompt_refined/workflow_template，
 * 每行合计约 1.5KB）对最近查询没有意义，但行本身被相册与聊天图片归因引用，不能删——
 * 因此只清空重文本字段，保留 id/status/output_paths/created_at（图片文件与引用都不动）。
 */
function trimImageTaskHistory() {
  try {
    if (process.env.IMAGE_TASK_TEXT_RETENTION_DAYS === '0') return;
    // 2026-10-01（本仓裁决，上游 v3.6.2 带来的功能）：**缺省不删**。
    // 上游缺省 30 天，启动时无条件把 30 天前的 image_tasks 提示词文本清空
    // （prompt_original=''、prompt_refined/workflow_template=NULL）。这段文本是**不可再生**的：
    // HiresFix「细化」要在 routes/images.js 反查原提示词才能复用（朋友圈/私聊图有 moment/raw 两级兜底，
    // 立绘 / 头像 / 小镇素材 / 表情包 / 群相册那批**没有任何兜底**，清了就只能拿到空提示词）。
    // 现在只有**显式**配了正整数天才瘦身：写 IMAGE_TASK_TEXT_RETENTION_DAYS=30 即恢复上游行为。
    const raw = process.env.IMAGE_TASK_TEXT_RETENTION_DAYS;
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    const days = Math.max(1, parseInt(raw, 10) || 0);
    if (!days) return;
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
    const trimmed = db.prepare(`UPDATE image_tasks SET prompt_original = '', prompt_refined = NULL, workflow_template = NULL
      WHERE created_at < ? AND status IN ('done','failed')
        AND (prompt_original != '' OR prompt_refined IS NOT NULL OR workflow_template IS NOT NULL)`).run(cutoff).changes;
    if (trimmed > 0) console.log(`[db] 生图任务历史瘦身：清空 ${trimmed} 行（>${days} 天）的提示词文本，行与图片保留`);
  } catch (err) {
    console.warn('[db] 生图任务历史瘦身跳过（不影响启动）:', err?.message || err);
  }
}

function compactDatabaseIfFragmented() {
  try {
    if (process.env.DB_AUTO_VACUUM === '0') return;
    const db = getDb();
    const pages = db.pragma('page_count', { simple: true });
    const free = db.pragma('freelist_count', { simple: true });
    const ratio = pages > 0 ? free / pages : 0;
    const sizeBefore = statSync(config.dbPath).size;
    if (ratio < 0.25 || sizeBefore < 100 * 1024 * 1024) return;
    console.log(`[db] 空闲页占比 ${(ratio * 100).toFixed(0)}%（文件 ${(sizeBefore / 1073741824).toFixed(2)} GB）→ VACUUM 压缩中，大库可能需要几分钟…`);
    const t0 = Date.now();
    db.exec('VACUUM');
    const sizeAfter = statSync(config.dbPath).size;
    console.log(`[db] VACUUM 完成（${Math.round((Date.now() - t0) / 1000)}s）：${(sizeBefore / 1073741824).toFixed(2)} GB → ${(sizeAfter / 1073741824).toFixed(2)} GB`);
  } catch (err) {
    console.warn('[db] 自动压缩跳过（不影响启动）:', err?.message || err);
  }
}

// 初始化时根据 ComfyUI/models/diffusion_models 下的模型自动检测工作流模式（仅首次执行一次）
autoDetectWorkflowMode();

// 初始化角色名称注册表（交叉引用检索）
refreshCharSearch();
console.log('[search] Character name registry loaded');

// 初始化后台 LLM 并发限制（云端 API 用户自动跳过，零开销）
applyFromConfig(config);

// 启动时自动补全缺失的工作流文件（已有文件不会被覆盖）
autoRestoreMissing();

// 启动朋友圈定时调度器
startMomentScheduler();

// 启动特殊日程朋友圈队列（启动时先检查所有角色的日程：过时的直接跳过，到点的立即发送）
startSpecialMomentScheduler();

// 启动主动对话调度器（由 config.features.proactiveChat 控制开关，scheduler 内部自行判断）
startProactiveChatScheduler();

// 启动奇遇事件调度器（由 config.features.events 控制开关，scheduler 内部自行判断）
startEventScheduler();

// 启动防打扰模式调度器（由 config.features.disturbMode 控制开关，scheduler 内部自行判断）
startDisturbScheduler();

// 启动回复队列调度器（日程刷新 + 延迟回复处理）
startReplyQueueScheduler();

// 启动「自动继续抽插」ticker（2026-10-02）：每 3 秒扫一遍正在自动抽插的场次，
// 到点的就内部走一遍同一条推进链（状态推进 + 她的反应 + 配图），面板关掉也继续。
// 用户原话：「自动抽插并没有自动 只是点一下 后面就没有角色的反应和图了」。
startIntimateAutoThrust();

// 初始化日程管理器（恢复睡眠状态）
initScheduleManager();

// 启动图片压缩调度器（定时 + 立即压缩功能）
startImageCompressor();

// 启动信箱调度器（每 60 秒扫描待回信的信件）
startMailboxScheduler();

// 启动天气调度器（每日 08:00 后更新小时级天气缓存）
startWeatherScheduler();

// 启动群聊后台调度器（预算制闲聊 + 角色自发建群，由 config.features.groupChat 控制）
startGroupIdleScheduler();

// 启动图片知识库同步调度器（用户安静时才执行同步，不阻塞生图）
startKnowledgeSyncScheduler();

// 启动记忆整理 daemon（记忆的"睡眠期"：空闲触发，内部自带开关与预算判断）
startConsolidationScheduler();

// 2026-10-01：角色资产「一键后台生成」——进程重启把在跑的批量任务标成 interrupted（可续跑），
// 不假成 failed（failed 是"跑过了、错了"，interrupted 是"被打断了、还能接着跑"）。
try {
  const recovered = recoverInterruptedAssetJobs();
  if (recovered > 0) console.log(`[assetGen] 发现 ${recovered} 个被中断的批量任务（可在前端一键继续）`);
} catch (error) {
  console.warn('[assetGen] 中断任务恢复失败（不影响启动）:', error.message);
}

// 2026-10-01：世界翻篇检查（程序日切换）——关机跨天 / 上次调时后没跑完的日常任务，启动时补一次。
// 首次运行只记录基准不补跑（见 programDayRollover 的说明）；fire-and-forget，绝不挡启动。
runProgramDayRollover({ reason: 'startup' }).catch(error => {
  console.warn('[rollover] 启动检查失败（不影响启动）:', error?.message || error);
});

// 启动道具系统调度器（每 10 分钟清理到期效果、恢复变身、标记卡死的生成中道具）
startItemScheduler();
// 启动小镇调度器（世界页：瓦片地图 + 轻量居民生态，由 config.features.town 控制）
restoreInitJob();  // 恢复未完成的初始化向导（断点续跑）
startTownScheduler();
startTownNpcStockScheduler(); // 货架：后台 3 天换货 + 预生成图标

// 先启动 HTTP 服务，向量检查异步进行
const server = app.listen(config.port, () => {
  console.log(`[agent-core] http://localhost:${config.port}`);
  console.log('============================================');
});
// 缩短 keep-alive 空闲超时，避免 Vite 代理在进程重启后复用到已死连接
server.keepAliveTimeout = 5000;

/**
 * HTTP 服务**起不来** ⇒ 整个应用不可用（后台调度器照跑、但没有任何接口应答），
 * 所以这里是**唯一**该让进程直接退出的地方。
 *
 * 2026-10-04 真机日志（`logs/backend-2026-10-04.log`）就是这么一条：
 *   `[agent-core] uncaught exception: listen EADDRINUSE: address already in use :::3099`
 * 而文件末尾那个 `process.on('uncaughtException')` 只打印、不退出 ⇒ 进程**带病活着**：
 * `[town]` / `[imageSkill]` / `[consolidation]` 的日志一直在刷，看起来"还在跑"，
 * 但用户打开页面永远连不上、接口全部无响应。**僵尸进程比直接崩掉难查十倍** —— 直接崩掉至少留下一条退出码。
 *
 * 只对"监听失败"这一类**致命**错误退出；运行期的连接级错误（ECONNRESET / EPIPE 等）由各自链路兜，
 * 不该拿整个进程陪葬。
 */
server.on('error', (err) => {
  const code = err?.code || '';
  if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL') {
    console.error(`[agent-core] 无法监听端口 ${config.port}（${code}）：${err.message}`);
    if (code === 'EADDRINUSE') {
      console.error(`[agent-core] 端口 ${config.port} 已被占用 —— 多半是**已经有一个实例在跑**。`);
      console.error('[agent-core] 请先关掉它（POST /api/shutdown，或直接结束那个进程）再启动。本次启动退出。');
    }
    process.exit(1);
  }
  console.error('[agent-core] http server error:', err?.message || err);
});

// 异步检查向量服务（不阻塞启动）
(async () => {
  console.log('[vector] checking connection to', config.vectorService.url);
  let retries = 0;
  while (true) {
    const ok = await vectorHealth();
    if (ok) {
      console.log('[vector] connected');
      setImmediate(() => ensureDefaultMemoryIndexes().catch(error => console.warn('[memory] default index initialization failed:', error.message)));
      // 2026-10-01：向量库 ↔ 库的一致性自检（换过库 / 导入过数据之后，chroma 里的记忆会与库里对不上，
      // 而库里「已索引」的标记让系统以为一切正常 ⇒ 403 条记忆的向量检索静默失效）。串在默认索引之后跑。
      setImmediate(() => ensureVectorIndexConsistency().catch(error => console.warn('[memory] 向量索引自检失败（不影响启动）:', error.message)));
      break;
    }
    retries++;
    if (retries === 6) {
      console.warn('[vector] WARNING: not reachable — vector search, memory extraction degraded; retrying every 30 seconds');
    }
    await new Promise(r => setTimeout(r, retries < 6 ? 3000 : 30000));
  }
})();

// 周期性 WAL checkpoint：每 5 分钟将 WAL 日志写入主 DB 文件，
// 缩短异常退出时的"脏窗口"，降低 WAL 损坏概率
const WAL_CHECKPOINT_INTERVAL = 5 * 60 * 1000;
const walCheckpointTimer = setInterval(() => {
  try {
    const db = getDb();
    const r = db.pragma('wal_checkpoint(PASSIVE)');
    if (r[0]?.log > 0 || r[0]?.checkpointed > 0) {
      console.log(`[db] periodic WAL checkpoint: ${r[0].checkpointed} pages checkpointed, ${r[0].log} remaining`);
    }
  } catch (_) { /* silent — 定期维护不应阻塞主流程 */ }
}, WAL_CHECKPOINT_INTERVAL);
// 不阻塞 process.exit()：WAL checkpoint 不是必须完成的关键操作
walCheckpointTimer.unref();

// 全局未捕获异常，防止进程崩溃
process.on('unhandledRejection', (reason) => {
  console.error('[agent-core] unhandled rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[agent-core] uncaught exception:', err.message);
});

// 优雅退出（幂等 — 防止 shutdown 端点 + 信号双重触发）
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[agent-core] shutting down...');
  stopMemoryIndexWorker();
  stopConsolidationScheduler();
  stopTownScheduler();
  stopTownNpcStockScheduler();

  // 1. WAL checkpoint：确保所有未落盘事务写入主 DB
  try {
    const db = getDb();
    const r = db.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`[db] WAL checkpointed before shutdown: ${r[0]?.checkpointed || 0} pages`);
  } catch (e) {
    console.warn('[db] WAL checkpoint failed:', e.message);
  }

  // 2. 先关 HTTP 服务（拒绝新连接），再清理资源
  server.close(async () => {
    // 日志文件先收尾（把缓冲区刷盘、还原 console），再关库退出
    try { await getFileLogging()?.close(); } catch { /* 旁路，不影响退出 */ }
    closeDb();
    process.exit(0);
  });
  // 5 秒硬超时兜底
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows: 关闭控制台窗口 → CTRL_CLOSE_EVENT（若 Node 未映射为 SIGBREAK 则直接被杀，
// 周期性 WAL checkpoint 已把脏窗口缩到 ≤5 分钟，最坏情况损失 < 5 分钟的写入）
process.on('SIGBREAK', shutdown);

// 供 dev.mjs 在 taskkill 前触发优雅退出（仅限本机调用，防局域网内其他设备远程关停）
const isLoopbackRequest = (req) => {
  const addr = req.socket?.remoteAddress || '';
  return addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
};
app.post('/api/shutdown', (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ error: 'shutdown 仅允许本机调用' });
  }
  res.json({ ok: true });
  shutdown();
});
