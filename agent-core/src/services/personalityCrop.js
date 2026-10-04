/**
 * 人格文本裁剪（叶子模块，**零 import**）
 *
 * 2026-10-02 从 `emotionEngine.js` 抽出来的，原因只有一个：**避免循环依赖**。
 *   · `services/characterPersona.js` 的 `variant:'short'` 需要"运行时从 base_prompt 现裁"的能力
 *     （原来它读库里那份旧的 200 字 `short_prompt`，吃不到裁剪修复）；
 *   · 但 `emotionEngine.js` **反过来 import 了** `characterPersona.js`（第 21 行，它要用 buildCharacterPersona）
 *     ⇒ 如果让 characterPersona 直接 import emotionEngine，就成了环，而且会把 db / llm-client
 *     整条依赖链拖进这个被 58 处引用的模块里（characterPersona 本该是轻的）。
 *   ⇒ 所以把裁剪逻辑放这个**不依赖任何模块**的叶子里：
 *     `emotionEngine.js` 继续"本地 import + 再导出"（它的 3 个调用方与 personalityCrop.test.js 不用改），
 *     `characterPersona.js` 直接 import 这里 ⇒ 无环、且 characterPersona 不会变重。
 *
 * ⚠️ 搬动时踩过的坑（写在这儿免得下次再踩）：在 `emotionEngine.js` 里**只写 `export { x } from './x.js'`
 *    不产生本地绑定** —— 而该文件内部还要调用 `cropPersonalityForEmotion`（`characters.js` 的迁移链会走到），
 *    只再导出会让它变成 `ReferenceError: cropPersonalityForEmotion is not defined`（本仓真机出过同类 bug）。
 *    所以那边是 **import（本地用）+ export … from（对外）** 两条语句并存。
 *
 * 本文件的所有判据与文案都保持与抽出前**逐字一致**，只是换了住址。
 */

/** 短人格长度上限（可配置，默认 700）。 */
export function getPersonalityCropMaxChars() {
  const raw = parseInt(process.env.PERSONALITY_CROP_MAX_CHARS, 10);
  return Number.isFinite(raw) && raw >= 100 ? raw : 700;
}

/** "决定她怎么说话"的小节关键词（外观类**不在**此处，由 characterPersona.js 在生图链负责） */
const SPEECH_SECTION_KEYS = ['身份', '性格', '好恶', '喜好', '说话', '语气', '口吻', '习惯', '价值观', '态度', '癖', '背景', '经历', '关系', '设定'];
const APPEARANCE_SECTION_KEYS = ['外观', '外貌', '长相', '衣着', '着装', '服饰', '身材', '形象', '立绘', '服装'];

/**
 * 把人格卡按 `## xxx` 小节切开，挑出"决定她怎么说话"的那些小节。
 * 为什么要按小节而不是"取到第二个换行"：后者只留一行性格，等于把角色压成一个标签，
 * 模型自然就不像她了（用户反馈：「角色对话还是有一些不遵从设定」）。
 *
 * @returns {{ preamble: string, kept: string[] }}
 */
function splitPersonalitySections(basePrompt) {
  const text = String(basePrompt || '');
  const parts = text.split(/\n(?=##\s)/);
  const preamble = String(parts[0] || '').trim();
  const kept = [];
  for (const part of parts.slice(1)) {
    const title = (part.match(/^##\s*(.+)/) || [])[1] || '';
    if (APPEARANCE_SECTION_KEYS.some((k) => title.includes(k))) continue;
    if (!SPEECH_SECTION_KEYS.some((k) => title.includes(k))) continue;
    kept.push(part.trim());
  }
  // 一张小节都没匹配上（老卡没有规范标题）⇒ 整卡回退交给 cap，别把人设丢空
  if (kept.length === 0) return { preamble: preamble || text.trim(), kept: [] };
  return { preamble, kept };
}

/**
 * 超上限时的收口：优先在句末（。！？…）切；找不到像样的句末就退到分句边界（，；、）并补一个句号。
 * **任何情况下都不以半句结尾**，并在末尾注明「（其余设定略）」。
 */
function capPersonalityText(text, max = getPersonalityCropMaxChars()) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const marker = '\n\n（其余设定略）';
  const budget = Math.max(100, max - marker.length);
  const head = s.slice(0, budget);
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('…'), head.lastIndexOf('\n'),
  );
  if (cut >= budget * 0.5) return head.slice(0, cut + 1).trimEnd() + marker;
  const soft = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('、'));
  if (soft > 0) return head.slice(0, soft) + '。' + marker;
  return head.trimEnd() + '。' + marker;
}

/**
 * 裁剪角色人格文本，用于"短人格"场景（群聊成员资料卡 / 梦境 / 多角色参考 / 即时反应 / 朋友圈互动…）。
 *
 * 规则（2026-10-02 重写，旧规则见下方注释）：
 *   1. 保留开头总述（"你是XX…"）作为身份锚点；
 *   2. **按小节取**决定说话方式的部分（身份 / 性格 / 好恶 / 说话 / 语气 / 习惯 / 价值观 / 背景…），
 *      **外观类小节不取**（生图链由 characterPersona.js 统一补，见 AGENTS.md）；
 *   3. 拼接后 "你" → characterName（默认 "assistant" 向后兼容）；
 *   4. 超上限（`PERSONALITY_CROP_MAX_CHARS`，默认 700）时**按句子边界**收，绝不切半句。
 *
 * ⚠️ 旧规则（已废弃，留作对照）：从开头取到 "## 你的身份" 之前 + "## 你的性格" 只留到第二个换行
 *    + **硬截断 200 字**。真实后果：德丽莎整卡 2212 字 ⇒ 实际只有 200 字（9%）且切在半句上，
 *    群聊成员资料卡 / 梦境 / 多角色参考 / 触摸反应 / 朋友圈 / 事件 / 信箱全吃这个亏，
 *    表现就是用户说的「角色对话还是有一些不遵从设定」。
 *
 * @param {string} basePrompt - 角色完整人格 prompt
 * @param {string} [characterName='assistant'] - 角色真实名称，用于替换 "你"
 *
 * 输入示例 → 输出示例:
 *   ("你是瓦雷莎...", "瓦雷莎")
 *   → "瓦雷莎是瓦雷莎...## 瓦雷莎的性格\n- 瓦雷莎说话总是慢悠悠的..."
 */
export function cropPersonalityForEmotion(basePrompt, characterName = 'assistant') {
  if (!basePrompt) return '';

  let result = '';

  // ── 2026-10-02 重写：旧的"只留到 ## 你的身份 之前 + ## 你的性格 只留一行 + 硬截 200 字"
  //    会把人格压成 9%（真实案例：德丽莎整卡 2212 字 ⇒ 实际只有 200 字，还切在半句上），
  //    用户反馈就是「角色对话还是有一些不遵从设定」。现在改成**按小节取**：
  //    · 开头总述（"你是XX…"）保留 —— 它是身份锚点；
  //    · 只挑"决定她怎么说话"的小节（身份 / 性格 / 好恶 / 说话方式 / 语气 / 习惯 / 价值观 / 背景…）；
  //    · **外观类小节不进人格文本**（`## 你的外观` 等由 characterPersona.js 在生图那条链统一补，
  //      人格里再塞一遍既费 token 又容易和着装归属打架）。
  const sections = splitPersonalitySections(basePrompt);
  result += sections.preamble;
  for (const sec of sections.kept) result += '\n\n' + sec;

  // 规则 3: "你" 全部替换为角色名
  // ⚠️ 先处理开场白「你是X，来自…」：直接替换「你」会得到「**X是X**，来自…」这种重复又费 token 的写法
  //    （真实卡片几乎都以「你是XX，来自《作品》…」开头，所以这条天天会走到）。
  //    改成把「你是X」整体换成「X」⇒「X，来自…」，语义不变、还省字。
  const escaped = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  result = result.replace(new RegExp('^你是' + escaped), characterName);
  result = result.replace(/你/g, characterName);

  // 兜底：超上限时按**句子边界**收，绝不留半句（旧版是硬切 200 字，会把话切成半句）
  return capPersonalityText(result);
}
