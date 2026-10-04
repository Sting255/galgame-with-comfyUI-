/**
 * groupImagePipeline.js —— 群聊「出图管线」簇（§5.1 第 3 刀，纯搬家，2026-09-30）
 *
 * **纯搬家产物**：下列函数从 groupChatEngine.js **逐字节**搬来，逻辑一行未动、导出名未改；
 * groupChatEngine.js 仍 re-export 原本公开的那几个（ensureForcedClimaxImage /
 * defaultForcedClimaxPrompt / buildForcedClimaxImageMessages / groupConvId），
 * `emitGroupImageFor` 与 `generateGroupImage` 搬家前就是**模块私有**，所以本文件导出前者供引擎调用、
 * 后者保持文件私有（只被 emitGroupImageFor 用）。
 *
 * 随行的两个小工具（**为避免循环依赖**，与簇一起搬）：
 *   · `groupConvId`：原本在 groupChatEngine 里导出（routes/groups.js 等在用）→ 引擎 re-export，对外面不变；
 *   · `serializeMsg`：原本是引擎私有（group_msg 广播用）→ 引擎改为 import，不对外暴露。
 * 如果把它们留在引擎，本文件就得 import groupChatEngine，形成 engine ⇄ pipeline 环（本仓 TDZ 血泪史）。
 *
 * 依赖：db / config / llm-client / imageSkill / imagePaths / imagePromptResponse /
 * groupImageLoraMatcher / characterImageOpts / characterPersona / galleryCache / groupScriptProtocol。
 */

import { getDb, getGlobalRule } from '../db/index.js';
import { config } from '../config.js';
import { chatSync } from '../llm/llm-client.js';
import { generateImage, getLastWorkflowMode } from './imageSkill.js';
import { buildCharacterPersona } from './characterPersona.js';
import { charArtistOverrideWithFallback } from './characterImageOpts.js';
import { requestNonEmptyImagePrompt, extractImagePromptResponse } from './imagePromptResponse.js';
import { saveBase64Image } from './imagePaths.js';
import { resolveGroupImageLoras, parseCharacterLoras } from './groupImageLoraMatcher.js';
import { invalidateGalleryCache } from './galleryCache.js';
import { formatGroupImageLine } from './groupScriptProtocol.js';
// 「0.5 刀」起：groupConvId / serializeMsg 搬到 groupConversationId.js（最小共享块，两个业务模块共用）
import { groupConvId, serializeMsg } from './groupConversationId.js';

/**
 * 把一条发图请求落到群聊里（找到承载气泡 + 落 image_tasks + 触发后台生图）。
 *
 * 两个调用点共用：
 *   ① 主链路——模型自己输出了发图行（下面的 handleParsed）；
 *   ② 兜底链路——「强制高潮」那一轮模型没发图，由 ensureForcedClimaxImage 补一次。
 * 之所以必须共用：两条路都要"挂到该角色本轮最后一条气泡、没有就新建空文本气泡"，各写一份必然走歪。
 *
 * 返回值里的 `seq` 是**承载气泡的 seq**：调用方必须用它把外层的 seq 计数器推到它之后，
 * 否则"本轮第一行就是发图行"时下一个文字气泡会拿到重复 seq（旧代码在新建气泡分支里自带 `seq++`，
 * 抽成公共函数后这一步漏在了调用点 —— task-5 修的就是这个隐式回归）。
 *
 * @returns {{targetMsgId:number, seq:number, taskPromise:Promise}}
 */
export function emitGroupImageFor(group, speaker, prompt, { written, rawLines, emit, options = {}, rawId = null } = {}) {
  const db = getDb();
  const conversationId = groupConvId(group.id);
  // 优先挂到该角色本轮最后一条还没图的文字气泡；没有就新建一条空文本气泡承载图片
  let target = [...written].reverse().find(w => w.speaker_character_id === speaker.id && !w.hasImage);
  if (!target) {
    const seq = written.reduce((max, w) => Math.max(max, Number(w.seq) || 0), -1) + 1;
    const r = db.prepare(
      `INSERT INTO messages (conversation_id, raw_id, role, content, images, seq, speaker_character_id) VALUES (?, ?, 'assistant', '', NULL, ?, ?)`
    ).run(conversationId, rawId, seq, speaker.id);
    target = {
      id: r.lastInsertRowid, content: '', seq, rawLineIdx: rawLines.length,
      speaker_character_id: speaker.id, speaker_name: speaker.display_name,
    };
    rawLines.push('');
    written.push(target);
    emit('group_msg', serializeMsg(target, group.id));
  }
  target.hasImage = true;
  rawLines.push(formatGroupImageLine(speaker.display_name, prompt));
  // 与主链路同一个生图函数：落 image_tasks(running) → 调 generateImage → 成功置 done
  const taskPromise = generateGroupImage(group, speaker, prompt, target.id, emit, options);
  return { targetMsgId: target.id, seq: Number(target.seq) || 0, taskPromise };
}

/**
 * 群聊版的"强制高潮出图"（task-1）。
 *
 * 为什么需要兜底：私聊那条链有 chat.js 的路径 D'（`handleNeedImageFlow` 让模型额外产一次画面描述，
 * 与用户勾选"强制生图"同一条管线）；群聊没有这条管线，出图只能来自剧本里的发图行，
 * 而发图本来只是概率抽卡。`buildForcedClimaxImageBlock` 把要求写进 prompt 后绝大多数轮次模型会照做，
 * 但"必须真的出图"不能建立在"模型这次听话"上——所以流结束后若该角色本轮确实没有任何发图行，
 * 这里**再请求一次模型**只要画面描述（与私聊同一手法），拿到就直接进生图管线。
 *
 * 归因与主链路一致：图挂在被下令角色自己的气泡上（群聊里她就是发言人），
 * 亲密看板沿用主链路的记账（本函数不再重复记账，避免与 recordGroupIntimateFromRound 双重计数）。
 *
 * @returns {Promise<boolean>} 是否成功发起了一次生图（不保证 ComfyUI 成功）
 */
export async function ensureForcedClimaxImage(forcedMembers, { group, written, rawLines, emit, deps = {}, options = {}, rawId = null, imagePromises = [] } = {}) {
  const list = Array.isArray(forcedMembers) ? forcedMembers : [];
  if (list.length === 0) return false;
  const db = getDb();
  const conversationId = groupConvId(group.id);
  const coveredIds = new Set(written.filter(w => w.hasImage).map(w => Number(w.speaker_character_id)));
  let launchedAny = false;

  for (const member of list) {
    const id = Number(member?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (coveredIds.has(id)) continue;
    const speaker = group.members.find(m => m.id === id);
    if (!speaker) continue;

    let prompt = '';
    try {
      const script = await requestNonEmptyImagePrompt(
        () => (deps.imagePromptChat || chatSync)(
          buildForcedClimaxImageMessages({
            group, character: speaker, rawId, userName: config.user.nickname || '用户',
          }),
          { temperature: 0.7, max_tokens: 1024, label: `群聊#${group.id}·强制高潮生图` },
        ),
        { emptyRetries: 1 }
      );
      prompt = extractImagePromptResponse(script) || '';
    } catch (err) {
      console.warn(`[group] forced_climax image prompt failed for ${speaker.display_name}:`, err.message);
    }

    // 模型没给出画面描述时用可解释的兜底描述，保证"这一轮一定有图"（与私聊路径 D' 的 intent 一致）
    const finalPrompt = prompt || defaultForcedClimaxPrompt(speaker);
    console.log(`[group] hypnosis forced_climax: forcing image for ${speaker.display_name} (prompt ${prompt ? 'from model' : 'fallback'})`);
    const { taskPromise } = emitGroupImageFor(group, speaker, finalPrompt, {
      written, rawLines, emit, options, rawId,
    });
    if (taskPromise) imagePromises.push(taskPromise);
    coveredIds.add(id);
    launchedAny = true;
  }
  return launchedAny;
}

/**
 * 兜底画面描述：模型没返回可用英文描述时用它，保证生图管线拿到的不是空串。
 * 只写"人 + 场景 + 状态"三要素，不猜测具体情节（避免替角色编造没发生的事）。
 *
 * **纯 ASCII 英文，刻意不拼角色名**（task-5 修正）：这条最终会经 `formatGroupImageLine` 写成
 * 「名字: {英文描述}」落进 raw，下一轮 transcript 里模型会看到花括号全文 —— 拼中文 `display_name`
 * 就与输出协议「花括号里必须是全英文画面描述」直接冲突，模型会照抄中文。
 *
 * 角色身份**已由生图管线负责**（有证据，不是推测）：
 *   ① `generateGroupImage` 无条件强制注入发图角色自身的 LoRA（`parseCharacterLoras(speaker)`）；
 *   ② `resolveGroupImageLoras` 现在按**多路别名**（handle / `Name (Series)` 形态 / LoRA 触发词）
 *      在画面描述里认人，认出来就把对应角色的 LoRA 排进链首。
 *      2026-10-01 改：这条原先是"没匹配到任何已知角色时用 `speaker.name` 前置角色名"，
 *      后果是把**发图人**的名字塞到一段描述**别人**的画面最前面（真机日志
 *      `[group] image prompt added speaker name fallback: march7th` → 串首 `march7th,` + 描述银狼），
 *      等于替模型断言画中人是谁 —— 已删掉前置行为，只留 `fallbackApplied` 当"有人但没认出来"的诊断信号。
 * 所以这里再拼一次名字是重复注入，而且拼的是中文显示名——两处都错。
 *
 * @param {object} [_speaker] 保留入参以兼容既有调用点（本函数不再使用它）
 */
export function defaultForcedClimaxPrompt(_speaker) {
  return '1girl, intimate scene, flushed face, trembling body, sweat, disheveled hair, closed eyes, heavy breathing, indoor bedroom, warm dim lamp light, soft focus, close-up';
}

/** 本轮"强制高潮出图"用的第二轮请求：只要英文画面描述，不要台词、不要解释。 */
export function buildForcedClimaxImageMessages({ group, character, messages = [], rawId = 0, userName = '用户' } = {}) {
  const db = getDb();
  const conversationId = groupConvId(group.id);
  const history = db.prepare(
    `SELECT role, content FROM raw_messages
      WHERE conversation_id = ? AND role IN ('user','assistant') AND content != ''
      ORDER BY id DESC LIMIT 6`
  ).all(conversationId).reverse();
  const transcript = history.map(row => String(row.content || '').trim()).filter(Boolean).join('\n');
  const persona = buildCharacterPersona(character || {}, { variant: 'full' }) || '';
  const formatGuide = (getGlobalRule('image_prompt')?.rule_content || '').trim();
  const who = character?.display_name || '她';

  return [
    {
      role: 'system',
      content: `${persona}\n\n你正在为群聊里刚刚发生的一幕生成一张配图的画面描述。${transcript ? `群聊最近的剧本：\n${transcript}\n` : ''}`,
    },
    {
      role: 'system',
      content: `【当前画面生成规则·最高优先级】\n${who} 刚刚在群聊里被${userName}用催眠指令强制带上了高潮，身体不听使唤、反应来得又急又不讲道理。\n请只输出**这一瞬间**的画面：必须出现${who}本人，画出她的姿态、表情与身体反应，体现高潮当下的状态；场景与光影延续上面的群聊上下文。\n${formatGuide ? `画面描述规范：\n${formatGuide}\n` : ''}只输出一段全英文的画面描述，直接输出英文正文，不要台词、不要中文说明、不要引号、不要 JSON、不要任何解释。`,
    },
    { role: 'user', content: '现在生成这张图的英文画面描述。' },
  ];
}

// ── 群内生图 ──

async function generateGroupImage(group, speaker, prompt, targetMsgId, emit, options = {}) {
  // options.generateImage：仅供单测注入确定性生图桩（默认走真实 ComfyUI 链路）。
  // 放在 options 里而不是新开一个参数，是为了不改动既有调用点的参数顺序。
  const db = getDb();
  const conversationId = groupConvId(group.id);
  const taskResult = db.prepare(
    `INSERT INTO image_tasks (conversation_id, source_msg_id, prompt_original, prompt_refined, status)
     VALUES (?, ?, ?, ?, 'running')`
  ).run(conversationId, targetMsgId, prompt, prompt);
  const taskId = taskResult.lastInsertRowid;
  emit('generate_start', { group_id: group.id, taskId, prompt, speaker_character_id: speaker.id, msg_id: targetMsgId });

  try {
    const loraOpts = {};

    // 按 prompt 中的英文名匹配其他角色 LoRA，再强制注入发图角色自身的 LoRA。
    const {
      prompt: preparedPrompt,
      fallbackApplied,
      matchedCharacters,
      loras: matchedLoras,
    } = resolveGroupImageLoras(prompt, speaker);

    // 强制注入发送者 LoRA（去重合并）
    const speakerLoras = parseCharacterLoras(speaker);
    const seenPaths = new Set(speakerLoras.map(l => l.path));
    const allLoras = [...speakerLoras, ...matchedLoras.filter(l => !seenPaths.has(l.path))];
    if (allLoras.length > 0) loraOpts.loras = allLoras;
    const speakerArtist = charArtistOverrideWithFallback(speaker, matchedCharacters || []);
    if (speakerArtist !== null) loraOpts.artist = speakerArtist;

    if (matchedCharacters.length > 0) {
      const matchedNames = matchedCharacters.map(char => `${char.display_name}(${char.name})`).join(', ');
      console.log(`[group] image character matches: ${matchedNames}; LoRAs: ${allLoras.map(lora => lora.path).join(', ') || 'none'}`);
    }
    console.log(`[group] forced speaker LoRA for ${speaker.display_name}(${speaker.name}): ${speakerLoras.map(l => l.path).join(', ') || 'none'}`);

    if (fallbackApplied) {
      console.log(`[group] image prompt added speaker name fallback: ${speaker.name}`);
    }

    // 后台主动群聊（idle 后台闲聊 / opening 自动建群）的图更像角色生活记录，
    // 统一借用朋友圈分辨率；用户触发的群聊图仍走默认聊天分辨率。
    const resolutionOverrides = options.useMomentsResolution
      ? { width: config.comfyui.momentsWidth, height: config.comfyui.momentsHeight }
      : {};
    const runner = typeof options.generateImage === 'function' ? options.generateImage : generateImage;
    const result = await runner(preparedPrompt, {
      ragQuery: options.ragQuery,
      scene: 'group',
      workflowScene: 'group',
      promptScene: 'chat',
      ragTimeoutMs: options.ragTimeoutMs,
      priority: options.priority,
      onProgress: (p) => {
        if (p.stage === 'retrying') emit('generate_retrying', { taskId, msg_id: targetMsgId, attempt: p.attempt, maxRetries: p.maxRetries });
        else emit('generate_progress', { taskId, msg_id: targetMsgId, ...p });
      },
      ...resolutionOverrides,
      ...loraOpts,
    });
    if (result.promptRefined) {
      db.prepare(`UPDATE image_tasks SET prompt_refined = ? WHERE id = ?`).run(result.promptRefined, taskId);
    }
    if (!result.success || result.images.length === 0) {
      throw new Error(result.error || 'No images generated');
    }
    const urls = [];
    for (const img of result.images) {
      const filename = `${Date.now()}_${img.filename || 'comfy.png'}`;
      urls.push(saveBase64Image('chat', filename, img.base64));
    }
    db.prepare(`UPDATE messages SET images = ? WHERE id = ?`).run(JSON.stringify(urls), targetMsgId);
    db.prepare(`UPDATE image_tasks SET status='done', output_paths=?, workflow_template=?, finished_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(urls), result.wfMode, taskId);
    // 相册缓存失效（cache 已下沉到 services，直接静态导入）
    try {
      invalidateGalleryCache();
    } catch { /* gallery 缓存失效失败不影响主流程 */ }
    emit('generate_done', { group_id: group.id, taskId, msg_id: targetMsgId, images: urls, speaker_character_id: speaker.id });
    console.log(`[group] image done for ${speaker.display_name} in group ${group.id}: ${urls[0]}`);
  } catch (err) {
    console.error(`[group] image failed for group ${group.id}:`, err.message);
    db.prepare(`UPDATE image_tasks SET status='failed', error_message=?, workflow_template=?, finished_at=datetime('now') WHERE id=?`)
      .run(err.message, getLastWorkflowMode(), taskId);
    emit('generate_error', { group_id: group.id, taskId, msg_id: targetMsgId, error: err.message });
  }
}
