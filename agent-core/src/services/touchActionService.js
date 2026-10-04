/**
 * SLG 动作系统 · 服务层（阶段一：私聊 MVP 的确定性内核 + prompt 构造）
 *
 * 用户原话：「我还想设计一个动作系统 比如抚摸 抱抱 更多之类的东西 反正就是SLG触摸游戏那一套
 * 我也想设计进去 可以在群聊和私聊对角色操作那种」——设计细节见 `目标/规划/专题-SLG动作系统.md`。
 *
 * 本模块的形态（**刻意如此**）：
 *   1. **零依赖**：不 import 任何其它模块（不碰 DB、不碰 LLM、不碰 config、不碰 chat.js）。
 *      判定需要的既有值（好感 / 誓约 / 催眠态 / 睡眠态 / 亲密授权 / 阈值）一律**由调用方传进来**——
 *      本轮 `config.js` / `db/index.js` / `routes/*` 由别的写手占用（见任务边界）。
 *   2. **纯函数 + 可注入时钟**：时间相关口径都收 `now` 参数（默认 Date.now()），
 *      所以腻烦叠加/衰减可以用假时间精确测，不必等真实的 30 分钟。
 *   3. **只构造、不执行**：本模块产出「注入块文本」「LLM 请求体」「解析结果」「判定结果」；
 *      真正发请求、落库、写 emotionEngine、记亲密看板全部由调用方（Lead 接线）做。
 *
 * 与既有系统的关系（专题 §四）：
 *   - Lv3 的看板记账键 **已裁决（2026-09-30，task-16）**：用户放权给 Lead 决断 ⇒ Lead 拍板
 *     "复用冻结的记账管线、不新增 act_key"。映射见 `TOUCH_ACTIONS` 的 `intimateActKey` 与下面
 *     「Lv3 映射口径」注释；拿不准的（`whisper_ear`）仍留 `null`，宁可不记也不误归因。
 *   - 心情影响只产出 `emotionDelta`（专题写的 `emotionEngine.applyInstant` 在本仓库**不存在**；
 *     既有原语是 `evolveEmotion(state, delta, baseline)` + `saveEmotionSnapshot(...)`，见接线说明）。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

// ── 一、动作清单与分级（专题 §1.1 的冻结清单） ────────────────────────────────

/** 动作分级：Lv1 日常（无门控）/ Lv2 亲密（好感或誓约）/ Lv3 敏感（成人向，另需亲密授权） */
// §10.1（2026-09-30）：新增 Lv4「私密」—— 摸私处在心理重量上明显高过 Lv3（摸胸摸臀），
// 塞进 Lv3 会让同一档内部分量失衡，所以单开一档（门槛更高、群聊无条件拦）。
export const TOUCH_LEVELS = Object.freeze({ DAILY: 1, INTIMATE: 2, SENSITIVE: 3, EXPLICIT: 4 });

/** 等级标签（前端可直接显示） */
export const TOUCH_LEVEL_LABELS = Object.freeze({ 1: 'Lv1 日常', 2: 'Lv2 亲密', 3: 'Lv3 敏感', 4: 'Lv4 私密' });

/**
 * 动作定义。字段口径：
 *   - `key`：机器键，前后端与落库共用，**只增不改**（改了等于旧数据失去含义）。
 *   - `label`：中文名，直接给前端按钮用。
 *   - `level`：TOUCH_LEVELS 之一，决定门控。
 *   - `promptDesc`：**玩家视角**的一句话动作描述（"你伸手轻轻摸了摸她的头"）；
 *     注入块与即时反应 prompt 写的都是它，对她说的时候用 describeActionForTarget 转视角。
 *   - `emotionDelta`：喂 emotionEngine 的瞬时心情增量（valence 愉快 / arousal 激动 / dominance 掌控感），
 *     各自夹在 [-1, 1]；只是建议值，即时反应模式可由 LLM 输出覆盖。
 *   - `wakes`：重动作（专题 §四「睡眠交互」点名的捏脸 / 挠痒）——睡着时做它会把她弄醒，
 *     调用方据此挂 temporaryWake（本模块只给标记，不碰日程）。
 *   - `intimateActKey`：Lv3 命中时记到亲密看板的哪个 actKey（Lv1/Lv2 恒为 null，不记账）。
 *     **口径（2026-09-30 裁决）**：只用 `intimateService.ACT_DEFINITIONS` 里**既有**的白名单键，
 *     不新增、不改看板语义；选键原则是仓里既有的「宁可少归因，也不能误归因」——
 *     摸/揉这类**手部抚摸**统一落 `hand`（手部动作大类），**不借部位键**：白名单的 `breast`=乳交、
 *     `thigh`=素股、`anal`=后庭，都是**另一种行为**，拿来记"摸胸/摸大腿/摸臀"会让看板数字说谎
 *     （专题 §四 原文也是这个判断：「看板 breast 是乳交、不是抚摸」）。
 *     非手部动作且无对应键的（`whisper_ear` 耳后吹气）**留 null**：不记账，也不硬凑一个键。
 */
export const TOUCH_ACTIONS = Object.freeze([
  // ── Lv1 日常：任何关系下都可做，不越界 ──
  { key: 'pat_head',     label: '摸头',   level: 1, wakes: false, intimateActKey: null,
    promptDesc: '你伸手轻轻摸了摸她的头',
    emotionDelta: { valence: 0.05, arousal: 0.02, dominance: -0.01 } },
  { key: 'pat_shoulder', label: '拍拍肩', level: 1, wakes: false, intimateActKey: null,
    promptDesc: '你抬手拍了拍她的肩膀',
    emotionDelta: { valence: 0.03, arousal: 0.01, dominance: -0.01 } },
  { key: 'hold_hand',    label: '拉手',   level: 1, wakes: false, intimateActKey: null,
    promptDesc: '你握住了她的手',
    emotionDelta: { valence: 0.05, arousal: 0.03, dominance: 0.00 } },
  { key: 'hug',          label: '抱抱',   level: 1, wakes: false, intimateActKey: null,
    promptDesc: '你把她抱进怀里',
    emotionDelta: { valence: 0.08, arousal: 0.05, dominance: -0.02 } },
  { key: 'tickle',       label: '挠痒痒', level: 1, wakes: true,  intimateActKey: null,
    promptDesc: '你伸手挠了挠她的痒痒',
    emotionDelta: { valence: 0.04, arousal: 0.10, dominance: -0.05 } },
  { key: 'pinch_cheek',  label: '捏脸',   level: 1, wakes: true,  intimateActKey: null,
    promptDesc: '你捏了捏她的脸颊',
    emotionDelta: { valence: 0.02, arousal: 0.05, dominance: -0.04 } },

  // ── Lv2 亲密：需要好感 / 关系门槛（阈值见 DEFAULT_TOUCH_THRESHOLDS） ──
  { key: 'stroke_hair',  label: '摸头发', level: 2, wakes: false, intimateActKey: null,
    promptDesc: '你顺着她的发丝慢慢摸下去',
    emotionDelta: { valence: 0.07, arousal: 0.05, dominance: -0.02 } },
  { key: 'stroke_back',  label: '摸背',   level: 2, wakes: false, intimateActKey: null,
    promptDesc: '你把手贴在她背上，慢慢顺着往下抚',
    emotionDelta: { valence: 0.07, arousal: 0.06, dominance: -0.02 } },
  { key: 'hold_waist',   label: '搂腰',   level: 2, wakes: false, intimateActKey: null,
    promptDesc: '你伸手搂住了她的腰',
    emotionDelta: { valence: 0.08, arousal: 0.10, dominance: -0.03 } },
  { key: 'kiss_cheek',   label: '亲脸颊', level: 2, wakes: false, intimateActKey: null,
    promptDesc: '你凑过去，在她脸颊上亲了一下',
    emotionDelta: { valence: 0.10, arousal: 0.12, dominance: -0.03 } },
  { key: 'cuddle',       label: '贴贴',   level: 2, wakes: false, intimateActKey: null,
    promptDesc: '你贴了过去，把脸埋在她肩窝里蹭了蹭',
    emotionDelta: { valence: 0.10, arousal: 0.08, dominance: -0.04 } },

  // ── Lv3 敏感：成人向；既要做亲密授权，又要好感/誓约 ──
  //    intimateActKey 口径见上方字段说明（2026-09-30 task-16 裁决）：手部抚摸统一 `hand`，
  //    不借 `breast`(乳交)/`thigh`(素股)/`anal`(后庭) 这类"另一种行为"的部位键；
  //    `whisper_ear` 不是手部动作、白名单也没有吹气/耳部键 ⇒ 留 null（不记账）。
  { key: 'touch_breast', label: '摸胸',     level: 3, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手覆上了她的胸口',
    emotionDelta: { valence: 0.06, arousal: 0.20, dominance: -0.08 } },
  { key: 'touch_butt',   label: '摸臀',     level: 3, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手落在了她的臀上',
    emotionDelta: { valence: 0.05, arousal: 0.18, dominance: -0.08 } },
  { key: 'touch_thigh',  label: '摸大腿',   level: 3, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手贴上了她的大腿',
    emotionDelta: { valence: 0.06, arousal: 0.16, dominance: -0.06 } },
  // 专题 §1.1 的「腰部游走」没给 key，这里补一个（沿用既有 snake_case 口径），已在实施记录里写明。
  { key: 'stroke_waist', label: '腰部游走', level: 3, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手在她腰侧慢慢游走',
    emotionDelta: { valence: 0.06, arousal: 0.14, dominance: -0.05 } },
  // 耳后吹气：不是手部动作，白名单里没有"吹气/耳部"语义的键 ⇒ **留 null**（宁可不记也不硬凑）
  { key: 'whisper_ear',  label: '耳后吹气', level: 3, wakes: false, intimateActKey: null,
    promptDesc: '你凑到她耳后，轻轻吹了口气',
    emotionDelta: { valence: 0.07, arousal: 0.18, dominance: -0.06 } },

  // ── Lv4 私密（2026-09-30 专题 §十）：门槛最高（好感 ≥80 或誓约 + 亲密授权），**群聊无条件拦** ──
  //    intimateActKey 沿用「宁可少归因」：手部落 `hand`、口部落 `oral`、无对应语义落 null。
  //    §10.2 明确：`touch_neck` 初稿写 `oral`，最终**改 null** —— 吻颈不属于性行为白名单任一类。
  { key: 'touch_pussy',   label: '摸私处',      level: 4, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手探入她的内裤，指腹贴上那处最私密的地方',
    emotionDelta: { valence: 0.08, arousal: 0.38, dominance: -0.14 } },
  { key: 'touch_clit',    label: '摸阴蒂',      level: 4, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的指尖找到她最敏感的那一点，轻轻打着圈',
    emotionDelta: { valence: 0.08, arousal: 0.40, dominance: -0.15 } },
  { key: 'finger_insert', label: '手指进入',    level: 4, wakes: false, intimateActKey: 'hand',
    promptDesc: '你缓缓将一根手指探入她体内',
    emotionDelta: { valence: 0.07, arousal: 0.40, dominance: -0.15 } },
  { key: 'touch_neck',    label: '抚摸脖颈',    level: 4, wakes: false, intimateActKey: null,
    promptDesc: '你低头吻上她的脖颈，唇齿轻轻厮磨',
    emotionDelta: { valence: 0.09, arousal: 0.28, dominance: -0.11 } },
  { key: 'lick_neck',     label: '舔颈',        level: 4, wakes: false, intimateActKey: null,
    promptDesc: '你的舌尖沿着她的颈侧一路向上舔舐',
    emotionDelta: { valence: 0.08, arousal: 0.30, dominance: -0.12 } },
  { key: 'suck_nipple',   label: '吮吸乳头',    level: 4, wakes: false, intimateActKey: 'oral',
    promptDesc: '你的唇含住她的乳尖，舌尖轻轻打转',
    emotionDelta: { valence: 0.08, arousal: 0.36, dominance: -0.14 } },
  { key: 'touch_nipple',  label: '捏乳头',      level: 4, wakes: false, intimateActKey: 'hand',
    promptDesc: '你捻住她的乳尖，指尖轻轻揉捻',
    emotionDelta: { valence: 0.07, arousal: 0.34, dominance: -0.13 } },
  { key: 'ear_nibble',    label: '咬耳朵',      level: 4, wakes: false, intimateActKey: null,
    promptDesc: '你含住她的耳垂轻轻厮咬，气息喷在她耳廓',
    emotionDelta: { valence: 0.09, arousal: 0.25, dominance: -0.10 } },
  { key: 'inner_thigh',   label: '抚摸大腿内侧', level: 4, wakes: false, intimateActKey: 'hand',
    promptDesc: '你的手掌顺着她的裙摆滑进大腿内侧，缓缓上移',
    emotionDelta: { valence: 0.08, arousal: 0.32, dominance: -0.12 } },
  // ── 击打类（2026-10-02 用户：「动作系统没有拍屁股这类打的交互」）──
  // 加了这一档，「打」才第一次进入动作系统：轻拍带惩罚/调情性质，痛感 + 羞耻感是抚摸类给不了的
  // （`spank` 这个词以前只存在于生图标签库里，动作系统里一个击打动作都没有）。
  // 三件套口径：
  //   · `wakes: true`（与挠痒痒/捏脸同档）—— 睡着时挨一下本来就该醒；
  //   · `annoyanceGainMultiplier: 1.5` —— 腻烦涨得比抚摸类快：连打会**真恼**，
  //     而不是像摸头那样可以一直点（这是"打"和"摸"在玩法上的核心区别）；
  //   · 好感门槛照常由 level 决定（Lv3 需好感达标），催眠/完全控制下顺从口径由门控豁免自动生效。
  { key: 'spank_butt',    label: '拍屁股',       level: 3, wakes: true, intimateActKey: 'hand', annoyanceGainMultiplier: 1.5,
    promptDesc: '你抬手在她臀上清脆地拍了一记',
    emotionDelta: { valence: 0.04, arousal: 0.22, dominance: -0.10 } },
  { key: 'spank_thigh',   label: '拍大腿',       level: 3, wakes: true, intimateActKey: 'hand', annoyanceGainMultiplier: 1.5,
    promptDesc: '你在她大腿外侧拍了一巴掌，留下一道淡淡的红印',
    emotionDelta: { valence: 0.03, arousal: 0.18, dominance: -0.08 } },
  { key: 'slap_face_light', label: '轻拍脸颊',   level: 4, wakes: true, intimateActKey: 'hand', annoyanceGainMultiplier: 1.8,
    promptDesc: '你的手掌贴上她的脸颊，不轻不重地拍了一下',
    emotionDelta: { valence: -0.02, arousal: 0.28, dominance: -0.18 } },
]);

/** key → 定义（冻结表；别再另建一份索引） */
export const TOUCH_ACTION_MAP = Object.freeze(
  TOUCH_ACTIONS.reduce((acc, action) => { acc[action.key] = action; return acc; }, {})
);

/** 全部合法 key（校验用） */
export const TOUCH_ACTION_KEYS = Object.freeze(TOUCH_ACTIONS.map(action => action.key));

/**
 * 该动作的腻烦增益倍数（2026-10-02 击打类）：写在动作定义里，缺省 1.0。
 * 只认动作表里的 key —— 传 null / 未知 key / 不认识的类型一律 1.0，
 * 保证"没写这个字段的动作"行为与加字段之前逐字节一致。
 */
export function annoyanceGainMultiplierOf(actionKey) {
  if (typeof actionKey !== 'string' || !actionKey) return 1;
  const action = TOUCH_ACTION_MAP[actionKey];
  const n = Number(action?.annoyanceGainMultiplier);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * 门控门槛默认值（**可配**：设置页以后可调；本轮不碰 config.js，由调用方传 thresholds 覆盖）
 *
 * ⚠️ `lv4Affinity = 0` —— 2026-10-04 用户裁决「**Lv4 私密整档直接开放**」：
 *    Lv4 不再吃好感门槛，也不再要求「亲密」授权（见 getTouchGate 里那条 `sensitive &&`）。
 *    **Lv2(40) / Lv3(60) 是另一回事，别顺手动** —— 用户只要求放开 Lv4。
 *    前端镜像另有一份同名常量，两边必须同时改，否则面板置灰与服务端 gate 会对不上。
 */
export const DEFAULT_TOUCH_THRESHOLDS = Object.freeze({ lv2Affinity: 40, lv3Affinity: 60, lv4Affinity: 0 });

/** 门控结果机器码（前端按它选文案 / 置灰，不依赖 reason 措辞） */
export const TOUCH_GATE_CODES = Object.freeze([
  'ok', 'unknown_action', 'affinity_low', 'sleeping_blocked', 'group_adult_blocked', 'intimate_not_authorized',
]);

/** 按 key 取动作定义；未知 key 返回 null（不抛——UI 不该因为一次脏 key 整条动作条崩掉） */
export function getTouchAction(actionKey) {
  const key = String(actionKey || '').trim();
  return key && TOUCH_ACTION_MAP[key] ? TOUCH_ACTION_MAP[key] : null;
}

/**
 * 列出动作；`maxLevel` 用于"只显示到已解锁那档"（与门控同一份口径）。
 *
 * §10.1（2026-09-30）：默认上限提到 `EXPLICIT`（Lv4）—— 偏好初始化 prompt / 面板分组 / 状态面板
 * 都是靠这份动态遍历"自动覆盖新动作"的；要老口径（只到 Lv3）显式传 `{ maxLevel: 3 }`。
 */
export function listTouchActions({ maxLevel = TOUCH_LEVELS.EXPLICIT } = {}) {
  const cap = Number(maxLevel);
  const limit = Number.isFinite(cap)
    ? Math.min(TOUCH_LEVELS.EXPLICIT, Math.max(TOUCH_LEVELS.DAILY, Math.trunc(cap)))
    : TOUCH_LEVELS.EXPLICIT;
  return TOUCH_ACTIONS.filter(action => action.level <= limit);
}


// ── 二、参数校验 ────────────────────────────────────────────────────────────

/** 请求校验的机器码 */
export const TOUCH_REQUEST_CODES = Object.freeze(['ok', 'invalid_action', 'invalid_character', 'invalid_scene']);

/** 反应模式取值（三选一；见 resolveTouchMode） */
export const TOUCH_MODES = Object.freeze({ AUTO: 'auto', INSTANT: 'instant', IMPLICIT: 'implicit' });

/**
 * 把任意输入规范化成合法的 mode **值**（'auto' | 'instant' | 'implicit'），非法值回落 'auto'。
 * 注意别写成 TOUCH_MODES[mode]——那张表的键是大写常量名，用值查会永远拿到 undefined。
 */
export function normalizeTouchMode(mode) {
  return Object.values(TOUCH_MODES).includes(mode) ? mode : TOUCH_MODES.AUTO;
}

/**
 * 校验一次动作请求（路由层第一道，脏数据不许进核心逻辑）。
 *
 * @param {object} input
 * @param {string} input.actionKey 动作 key（必填，白名单内）
 * @param {number|string} input.characterId 目标角色 id（必填，正整数）
 * @param {number|string} [input.groupId] 群聊场景的群 id（群聊必填正整数）
 * @param {string} [input.scene] 'chat'（私聊）| 'group'（群聊），默认 'chat'
 * @param {string} [input.mode] 'auto' | 'instant' | 'implicit'（非法值回落 'auto'）
 * @returns {{ok:boolean, code:string, error:string, actionKey:string, action:object|null,
 *            characterId:number, groupId:number, scene:string, mode:string}}
 */
export function normalizeTouchRequest({ actionKey, characterId, groupId, scene = 'chat', mode = 'auto' } = {}) {
  const fail = (code, error) => ({
    ok: false, code, error, actionKey: '', action: null,
    characterId: 0, groupId: 0, scene: 'chat', mode: TOUCH_MODES.AUTO,
  });
  const action = getTouchAction(actionKey);
  if (!action) return fail('invalid_action', 'unknown touch action');
  const charId = Number.parseInt(characterId, 10);
  if (!Number.isSafeInteger(charId) || charId <= 0) return fail('invalid_character', 'invalid character id');
  const wantedScene = scene === 'group' ? 'group' : 'chat';
  let group = 0;
  if (wantedScene === 'group') {
    group = Number.parseInt(groupId, 10);
    if (!Number.isSafeInteger(group) || group <= 0) return fail('invalid_scene', 'group id required for group scene');
  }
  return {
    ok: true, code: 'ok', error: '', actionKey: action.key, action,
    characterId: charId, groupId: group, scene: wantedScene,
    mode: normalizeTouchMode(mode),
  };
}

// ── 三、门控（专题 §1.3，刻意不复杂；第一个没满足的条件说话） ────────────────

/** 拒绝文案：按机器码给**人话**，UI 直接显示（专题 §3.1 要求"文案要有趣，不要机械报错"） */
const GATE_MESSAGES = Object.freeze({
  unknown_action: '没有这个动作。',
  affinity_low_lv2: '她现在还不太习惯你离得这么近——先好好说会儿话吧。',
  affinity_low_lv3: '她按住你的手，轻轻摇了摇头。你们之间还没到那一步。',
  // §10.4 第 2 条给的原文：比 Lv3 更重（Lv4 是关系深处才解锁的体验）
  affinity_low_lv4: '她握住你的手腕，摇头。要到那一步……你们还差得远。',
  sleeping_blocked: '她睡得很沉，翻了个身。这种时候还是别吵她比较好。',
  group_adult_blocked: '当着这么多人的面……这种事还是留到只有你们俩的时候吧。',
  intimate_not_authorized: '（这一步要先在角色档案里打开「亲密」授权。）',
});

/**
 * 判定一次动作能不能做。
 *
 * 判定顺序（第一个不满足的条件说话，与催眠手机 getHypnosisGate 同款）：
 *   1. 未知动作 → unknown_action
 *   2. **催眠中 → 直接放行**（专题 §1.3「完全控制态豁免门控」+ §八「催眠中点任意动作无门控」），
 *      排在睡眠前面：睡着的她在催眠里也能做
 *   3. Lv1 → 放行（无门控）
 *   4. 睡着 + Lv3 → sleeping_blocked
 *   5. 群聊 + Lv3 + 未开群聊成人内容 → group_adult_blocked（专题 §2.2 隐私边界，阶段二生效）
 *   6. 好感 < 门槛 且 未誓约 → affinity_low
 *   7. Lv3 还要过亲密看板授权 → intimate_not_authorized
 *
 * 外部值**由调用方读好传进来**（见文件头的零依赖说明）：
 *   affinity          ← emotionEngine.loadAffinity(id)
 *   isOath            ← emotionEngine.loadOath(id)
 *   hypnotized        ← hypnosisService.isBodyControlled(id)
 *   sleeping          ← scheduleManager.isSleeping(id)
 *   intimateAuthorized ← intimateService.isAiEditAllowed(id, 'stats')
 *
 * @returns {{allowed:boolean, code:string, reason:string, message:string, level:number|null,
 *            action:object|null, exempt:string|null, wakesSleeping:boolean, thresholds:object}}
 */
export function getTouchGate({
  actionKey,
  affinity = 0,
  isOath = false,
  hypnotized = false,
  sleeping = false,
  intimateAuthorized = false,
  scene = 'chat',
  allowGroupAdult = false,
  thresholds = DEFAULT_TOUCH_THRESHOLDS,
} = {}) {
  const limit = { ...DEFAULT_TOUCH_THRESHOLDS, ...(thresholds || {}) };
  const action = getTouchAction(actionKey);
  const base = {
    allowed: false, code: 'unknown_action', reason: 'unknown_action',
    message: GATE_MESSAGES.unknown_action, level: action ? action.level : null,
    action, exempt: null, wakesSleeping: false, thresholds: limit,
  };
  if (!action) return base;

  const allow = (code, extra = {}) => ({ ...base, allowed: true, code, reason: code, message: '', ...extra });

  if (hypnotized) return allow('ok', { exempt: 'hypnosis', wakesSleeping: Boolean(action.wakes && sleeping) });
  if (action.level === TOUCH_LEVELS.DAILY) return allow('ok', { wakesSleeping: Boolean(action.wakes && sleeping) });

  // §10.1：Lv4 私密与 Lv3 同属"成人向"，但 Lv4 的群聊口径更严（见下）
  const sensitive = action.level === TOUCH_LEVELS.SENSITIVE;
  const explicit = action.level === TOUCH_LEVELS.EXPLICIT;
  const adult = sensitive || explicit;

  if (sleeping && adult) {
    return { ...base, code: 'sleeping_blocked', reason: 'sleeping_blocked', message: GATE_MESSAGES.sleeping_blocked };
  }
  // 群聊成人内容：**Lv3 与 Lv4 同一口径** —— 吃 `touchGroupAdult` 开关（关着照样拦，文案不变）。
  // §一③（三期 2026-09-30）：用户期望变了（要群聊里也能用私密动作、还要有旁观者参与），
  // 原 §10.1 的「Lv4 群聊无条件拦」裁决由用户作废。
  if (scene === 'group' && adult && !allowGroupAdult) {
    return { ...base, code: 'group_adult_blocked', reason: 'group_adult_blocked', message: GATE_MESSAGES.group_adult_blocked };
  }
  const threshold = explicit ? limit.lv4Affinity : (sensitive ? limit.lv3Affinity : limit.lv2Affinity);
  if (!(Number(affinity) >= threshold || isOath === true)) {
    const reason = explicit ? 'affinity_low_lv4' : (sensitive ? 'affinity_low_lv3' : 'affinity_low_lv2');
    return { ...base, code: 'affinity_low', reason, message: GATE_MESSAGES[reason] };
  }
  // 「亲密」授权只对 **Lv3 敏感档**还生效。
  // 2026-10-04 用户裁决「Lv4 私密整档直接开放」⇒ Lv4 不再要求授权（也不再吃好感门槛，见
  // DEFAULT_TOUCH_THRESHOLDS.lv4Affinity=0）。原来这里是 `adult &&`（Lv3+Lv4 共用），已收窄。
  // ⚠️ 别改回 `adult &&`：那会把 Lv4 重新扣上授权，和这次裁决相反。
  if (sensitive && intimateAuthorized !== true) {
    return { ...base, code: 'intimate_not_authorized', reason: 'intimate_not_authorized', message: GATE_MESSAGES.intimate_not_authorized };
  }
  return allow('ok', { wakesSleeping: Boolean(action.wakes && sleeping) });
}


// ── 四、腻烦度与偏好（专题 §2.3；纯函数，时钟可注入） ───────────────────────

/** 腻烦度口径常量（要调就调这里，别散落在调用点） */
export const ANNOYANCE = Object.freeze({
  MIN: 0,
  MAX: 100,
  /** 同一动作在这个窗口内连点才算"重复" */
  REPEAT_WINDOW_MS: 10 * 60 * 1000,
  /** 每次重复的基础增量（专题给的是 15~25，取中值 20） */
  REPEAT_GAIN: 20,
  /** 超过这个值反应开始变冷 */
  WARM_THRESHOLD: 50,
  /** 超过这个值直接拒绝（躲开 / 拍掉你的手） */
  REFUSE_THRESHOLD: 80,
  /** 衰减周期与幅度：每 30 分钟 -10 */
  DECAY_PERIOD_MS: 30 * 60 * 1000,
  DECAY_PER_PERIOD: 10,
});

/** 耐受档位（前端显示 / prompt 注入共用，别各自定阈值） */
export const ANNOYANCE_TIERS = Object.freeze({ FINE: 'fine', WARM: 'warm', REFUSING: 'refusing' });

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 腻烦值规范到 0~100 */
export function clampAnnoyance(value) {
  return clampNumber(value, ANNOYANCE.MIN, ANNOYANCE.MAX, ANNOYANCE.MIN);
}

/** 偏好倍率 → 腻烦增速倍率：喜欢（likeRatio > 1）涨得慢，讨厌（< 1）涨得快，夹在 [0.5, 2] */
export function likeGainScale(likeRatio = 1) {
  const ratio = clampNumber(likeRatio, 0.1, 5, 1);
  return clampNumber(1 / ratio, 0.5, 2, 1);
}

/** 按流逝时间衰减腻烦（不足一个周期不衰减；不会跌破 0） */
export function decayAnnoyance(annoyance, elapsedMs = 0) {
  const periods = Math.floor(Math.max(0, Number(elapsedMs) || 0) / ANNOYANCE.DECAY_PERIOD_MS);
  return clampAnnoyance(clampAnnoyance(annoyance) - periods * ANNOYANCE.DECAY_PER_PERIOD);
}

/** 耐受档位：>80 拒绝 / >50 变冷 / 其余正常 */
export function annoyanceTier(annoyance) {
  const value = clampAnnoyance(annoyance);
  if (value > ANNOYANCE.REFUSE_THRESHOLD) return ANNOYANCE_TIERS.REFUSING;
  if (value > ANNOYANCE.WARM_THRESHOLD) return ANNOYANCE_TIERS.WARM;
  return ANNOYANCE_TIERS.FINE;
}

/**
 * 算出这一下之后的新腻烦值（**只算，不落库**——落库要两张表，本模块不碰 DB）。
 *
 * 口径（专题 §2.3）：
 *   - 先按距上次的时间衰减（每 30 分钟 -10）；
 *   - 距上次 ≤ 10 分钟 = "还在连点" → 叠加 REPEAT_GAIN × likeGainScale(likeRatio)；
 *   - 超出窗口 = 重新开始，不叠加（只吃衰减）；
 *   - 结果夹 0~100；没有 lastAt（第一次）按当前值原样。
 *
 * @param {object} params
 * @param {number} [params.current] 当前腻烦值（0~100）
 * @param {number|null} [params.lastAt] 上次同一动作的毫秒时间戳
 * @param {number} [params.now] 现在（毫秒）
 * @param {number} [params.likeRatio] 该角色对该动作的偏好倍率（默认 1.0）
 * @returns {{annoyance:number, tier:string, decayed:number, gain:number, repeated:boolean, elapsedMs:number|null}}
 */
/**
 * 计算下一次的腻烦值（衰减 → 连点增益）。
 *
 * §4.1①：`suppressGain: true`（催眠轮）时**只衰减不叠加** —— 完全控制/意志清醒态下「连点被拍开」
 * 在语义上不成立，用户也明确要「可以一直点」；存量值照常按时间衰减，不冻结也不清零。
 *
 * 2026-10-02（击打类）：传 `actionKey` 时按动作取 `annoyanceGainMultiplier` ——
 * 「打」和「摸」在玩法上的核心区别就是**连点会不会真恼**：摸头可以一直点，
 * 拍屁股连打三下她就该烦了。倍数写在动作定义里（`TOUCH_ACTION_MAP`），纯函数这边只查表，
 * 不认识的 key / 没写倍数的动作一律 1.0（与加这个字段之前逐字节一致）。
 */
export function nextAnnoyance({ current = 0, lastAt = null, now = Date.now(), likeRatio = 1, suppressGain = false, actionKey = null } = {}) {
  const at = Number(now);
  const previousAt = Number(lastAt);
  // lastAt 传 null/undefined = 第一次；传 0 是合法的"很早以前"（此时 elapsed 会把它推到窗口外）
  const hasLast = lastAt !== null && lastAt !== undefined && Number.isFinite(previousAt) && previousAt >= 0;
  const elapsedMs = hasLast ? Math.max(0, at - previousAt) : Number.POSITIVE_INFINITY;
  const decayed = hasLast ? decayAnnoyance(current, elapsedMs) : clampAnnoyance(current);
  const repeated = hasLast && elapsedMs <= ANNOYANCE.REPEAT_WINDOW_MS;
  const gainMultiplier = annoyanceGainMultiplierOf(actionKey);
  const gain = (repeated && !suppressGain)
    ? ANNOYANCE.REPEAT_GAIN * likeGainScale(likeRatio) * gainMultiplier
    : 0;
  return {
    annoyance: clampAnnoyance(decayed + gain),
    tier: annoyanceTier(decayed + gain),
    decayed,
    gain,
    repeated,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
  };
}

/** 耐受档位的 prompt 措辞（写进注入块 / 反应 prompt；SLG 玩家靠它读手感） */
export const ANNOYANCE_TIER_TEXT = Object.freeze({
  fine: '还乐意（她对这一下没有不耐烦）',
  warm: '有点不耐烦了（同一动作被连着摸了好几次，反应该冷了）',
  refusing: '已经很烦了（这一下必须躲开或拍掉你的手，带明显负心情）',
});

/** 偏好倍率的 prompt 措辞 */
export function likeRatioText(likeRatio = 1) {
  const ratio = clampNumber(likeRatio, 0.1, 5, 1);
  if (ratio >= 1.25) return '她其实很受用（偏好倍率 ' + ratio.toFixed(2) + '）';
  if (ratio <= 0.75) return '她并不喜欢（偏好倍率 ' + ratio.toFixed(2) + '）';
  return '谈不上偏好（偏好倍率 ' + ratio.toFixed(2) + '）';
}


// ── 五、反应模式（即时反应 / 隐式注入）与每日配额回落（专题 §2.1） ──────────

/** 即时反应额度用尽时给用户的一句人话（前端可直接 toast） */
export const INSTANT_QUOTA_NOTICE = '今日即时反应额度已用完，她的反应会在你下次发言时出现。';

/**
 * 这一次走哪条路（**不含配额计数本身**——计数是运行期状态，归路由/设置层管）。
 *
 * - auto：看 instantEnabled（用户的"省额度模式"开关）与 quotaExhausted
 * - instant：用户显式要求 → 但额度用完仍然回落隐式（专题：耗尽自动回落并提示）
 * - implicit：显式要求隐式 → 不消耗额度
 *
 * @returns {{mode:string, fallback:boolean, notice:string|null, reason:string}}
 */
export function resolveTouchMode({ mode = TOUCH_MODES.AUTO, instantEnabled = true, quotaExhausted = false } = {}) {
  const wanted = normalizeTouchMode(mode);
  if (wanted === TOUCH_MODES.IMPLICIT) {
    return { mode: TOUCH_MODES.IMPLICIT, fallback: false, notice: null, reason: 'explicit_implicit' };
  }
  const wantsInstant = wanted === TOUCH_MODES.INSTANT || instantEnabled === true;
  if (!wantsInstant) {
    return {
      mode: TOUCH_MODES.IMPLICIT, fallback: false, notice: null,
      reason: instantEnabled === false ? 'instant_disabled' : 'auto_implicit',
    };
  }
  if (quotaExhausted === true) {
    return { mode: TOUCH_MODES.IMPLICIT, fallback: true, notice: INSTANT_QUOTA_NOTICE, reason: 'quota_exhausted' };
  }
  return { mode: TOUCH_MODES.INSTANT, fallback: false, notice: null, reason: 'instant' };
}

// ── 六、注入块与「即时反应」prompt 构造 ─────────────────────────────────────

/** 注入块字符上限（防止一次摸头把 dynamicBlocks 预算吃穿） */
export const MAX_TOUCH_BLOCK_CHARS = 900;
/** 反应正文上限（解析时也按它截断） */
export const MAX_REACTION_CHARS = 300;

/** §一①：LLM 现写的画面描述上限（英文，太长会挤掉外观块与画质词） */
export const MAX_IMAGE_PROMPT_CHARS = 400;

/**
 * §4.1②：**催眠轮的耐受行降级文案**。
 *
 * 真机根因（证据链见专题 §4.1）：催眠块「无法反抗」+ 写作要求「无条件顺从」+ 耐受档 refusing
 * 「必须躲开或拍掉你的手」三条两两冲突，模型在冲突里选了耐受档 ⇒ 输出打手（用户报的
 * 「催眠控制下还能反抗」）。所以催眠轮把耐受整行换掉：身体无条件接受，情绪只走内心与台词。
 */
export const HYPNOSIS_TOLERANCE_TEXT = '（催眠中：耐受无效，身体无条件接受，情绪反应只走内心与台词）';

// ── 事件新鲜度窗口（task-17 · 阶段二）────────────────────────────────────────
//
// 为什么需要：`touch_events` 的 pending / done 原来是"一直等到下一轮聊天才消费"，
// 于是"点一下触摸、三天后才聊天"也会让角色突然演出一次触摸反应（还带着早就过期的耐受/偏好读数）。
// 超过这个窗口的事件一律作废（调用方标 `'expired'`）且**不再注入**。
// 30 分钟：够覆盖"点完动作马上接着聊完这一场"，又不会把陈旧事件带进下一场对话。
//
// ⚠️ **判定只有这一处**（Lead 口径：两条链都调它，别写两份）：
//   · SQL 侧：`WHERE created_at >= touchEventCutoff(now)`（返回的是 SQLite 无时区 UTC 串，可直接字符串比较）
//   · 内存侧：`isTouchEventFresh(createdAt, now)`

/** 事件新鲜度窗口（毫秒）。0 / 负数 / 非数字按默认值处理 */
export const TOUCH_EVENT_TTL_MS = 30 * 60 * 1000;

/**
 * 新鲜度截止时间 → **SQLite 无时区 UTC 串**（`YYYY-MM-DD HH:MM:SS`），
 * 与库里 `datetime('now')` 写的 `created_at` 同口径，可直接 `WHERE created_at >= ?` 比较
 * （别再包 datetime()，更不要用本地时间）。
 */
export function touchEventCutoff(now = Date.now(), ttlMs = TOUCH_EVENT_TTL_MS) {
  const ms = Number(now);
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : TOUCH_EVENT_TTL_MS;
  const at = new Date((Number.isFinite(ms) ? ms : Date.now()) - ttl);
  return at.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** 某条事件的 `created_at` 是否还在窗口内（取不到 / 解析不了时间 → **判为不新鲜**，宁可不注入） */
export function isTouchEventFresh(createdAt, now = Date.now(), ttlMs = TOUCH_EVENT_TTL_MS) {
  const raw = String(createdAt ?? '').trim();
  if (!raw) return false;
  const sqliteLike = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
  const at = Date.parse(sqliteLike ? `${raw.replace(' ', 'T')}Z` : raw);
  if (!Number.isFinite(at)) return false;
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : TOUCH_EVENT_TTL_MS;
  const anchor = Number(now);
  return (Number.isFinite(anchor) ? anchor : Date.now()) - at <= ttl;
}

/** 把"玩家视角"的动作描述换成"对她说"的视角（promptDesc 里的 '你' 与 '她' 都是玩家视角） */
export function describeActionForTarget(actionOrKey, { userName = '他' } = {}) {
  const action = typeof actionOrKey === 'string' ? getTouchAction(actionOrKey) : actionOrKey;
  if (!action) return '';
  const who = String(userName || '他').trim() || '他';
  return action.promptDesc.replace(/^你/, who).replace(/她/g, '你');
}

/** 动作的玩家视角描述（日志 / 事件记录 / 前端 tooltip 用） */
export function describeAction(actionOrKey) {
  const action = typeof actionOrKey === 'string' ? getTouchAction(actionOrKey) : actionOrKey;
  return action ? action.promptDesc : '';
}

// ── 七、出图联动（task-19 · 阶段三）────────────────────────────────────────────
//
// 档位三态：总是 / 智能 / 从不（用户裁决：默认**智能**）。
//   · 从不 → 一次图都不出（与加功能前逐字节一致，有单测钉住）；
//   · 总是 → 每次动作出图（仍然受"既有出图总开关"约束，见路由）；
//   · 智能 → **只对 Lv2 / Lv3 按概率出图**（Lv1 永远不出；Lv2 25%、Lv3 50%）。
// 本模块只做**判定与 prompt 组装**（纯函数）；真正调 ComfyUI / 落库 / 挂图由路由做。

/** 出图档位取值 */
export const TOUCH_IMAGE_MODES = Object.freeze({ ALWAYS: 'always', SMART: 'smart', NEVER: 'never' });
/** 档位中文名（设置页直接用） */
export const TOUCH_IMAGE_MODE_LABELS = Object.freeze({ always: '总是', smart: '智能', never: '从不' });
/** 默认档位（用户裁决） */
export const DEFAULT_TOUCH_IMAGE_MODE = TOUCH_IMAGE_MODES.SMART;
/** 智能档的出图概率：只对这几个等级生效（Lv1 不在表里 = 永不出图） */
// §10.3：Lv4 的画面价值更高 ⇒ 0.6（比 Lv3 的 0.5 再高一档）
//
// 2026-10-01 调高默认（用户：「需要把所有和生图相关的都看看 其他地方好像还是有限制」）：
// 原来 0.25/0.5/0.6 ⇒ 点四下摸头才可能出一张图，观感就是"生图被限制了"。
// 现在是 0.5/0.75/0.9（一半到九成），并且整表可由 `config.features.touchImageChanceScale`
// （默认 1，设置页 `feature_touchImageChanceScale`，float）整体缩放，上限夹到 1。
// 想要"每次都出"用 `touchImageMode: 'always'`（设置页已有三档开关）。
export const SMART_IMAGE_CHANCE = Object.freeze({ 2: 0.5, 3: 0.75, 4: 0.9 });

/** 档位归一：非三态值（含 undefined / 空串 / 脏值）一律回落默认 `smart` */
export function normalizeTouchImageMode(mode) {
  return Object.values(TOUCH_IMAGE_MODES).includes(mode) ? mode : DEFAULT_TOUCH_IMAGE_MODE;
}

/**
 * 按缩放系数取某等级的实际出图概率（纯函数，便于测试）。
 *
 * ⚠️ 本模块是**零依赖**的（文件头写明：不 import config / DB / LLM，判定值一律由调用方传入），
 * 所以缩放系数只能**当参数传**，不能在这里读 `config.features.touchImageChanceScale`。
 * 调用方（`routes/touch.js`）负责把配置值传进来；缺省 = 1（不缩放）。
 *
 * @param {number} level 动作等级
 * @param {number} [scale=1] 缩放系数（>0；非法值按 1）
 * @returns {number} 0~1
 */
export function touchImageChanceFor(level, scale = 1) {
  const base = SMART_IMAGE_CHANCE[Number(level) || 1] || 0;
  if (base <= 0) return 0;
  const n = Number(scale);
  const safe = Number.isFinite(n) && n > 0 ? n : 1;
  return Math.min(1, base * safe);
}

/**
 * 这次动作要不要出图（纯函数，随机源可注入，便于测试）。
 *
 * @param {{mode?:string, level?:number, random?:() => number, enabled?:boolean, chanceScale?:number}} params
 *   `enabled:false` = 既有出图总开关关着（`config.features.imageGenMode === 'off'`）→ 一律不出
 *   `chanceScale` 缺省时读 `config.features.touchImageChanceScale`
 * @returns {boolean}
 */
export function shouldGenerateTouchImage({ mode = DEFAULT_TOUCH_IMAGE_MODE, level = 1, random = Math.random, enabled = true, chanceScale } = {}) {
  if (enabled === false) return false;
  const wanted = normalizeTouchImageMode(mode);
  if (wanted === TOUCH_IMAGE_MODES.NEVER) return false;
  if (wanted === TOUCH_IMAGE_MODES.ALWAYS) return true;
  const chance = touchImageChanceFor(level, chanceScale);
  if (chance <= 0) return false;
  const roll = typeof random === 'function' ? Number(random()) : Math.random();
  return Number.isFinite(roll) && roll < chance;
}

/** 每个动作的英文画面提示（画面主体；与玩家视角的中文 promptDesc 是两回事，key 必须覆盖全集） */
export const TOUCH_IMAGE_HINTS = Object.freeze({
  pat_head: 'a hand gently patting her head, her expression softening',
  pat_shoulder: 'a hand resting on her shoulder, casual friendly moment',
  hold_hand: 'their hands held together, fingers intertwined, close-up',
  hug: 'a warm hug, her face buried against his chest',
  tickle: 'tickling her sides, she is laughing and squirming',
  pinch_cheek: 'gently pinching her cheek, playful moment',
  stroke_hair: 'fingers running slowly through her hair, tender moment',
  stroke_back: 'his hand slowly stroking her back, intimate atmosphere',
  hold_waist: 'his arm wrapped around her waist, standing close together',
  kiss_cheek: 'a soft kiss on her cheek, she looks surprised and happy',
  cuddle: 'cuddling close, her face nuzzled into his shoulder',
  touch_breast: 'his hand resting on her chest over her clothing, she is flustered',
  touch_butt: 'his hand on her hip, she glances back with a red face',
  touch_thigh: 'his hand resting on her thigh, seated close together',
  stroke_waist: 'his hand slowly moving along her waist, intimate tension',
  whisper_ear: 'he leans in and whispers by her ear, she shivers slightly',
  // ── Lv4 私密（§10.3）：含蓄擦边 —— 手的位置 / 她的表情 / 衣衫状态，与 Lv3 提示词同一尺度 ──
  touch_pussy: 'his hand slipping under her skirt, she gasps and presses her thighs together, deeply flushed',
  touch_clit: 'his fingertips between her thighs, her body trembling, biting her lip, heavy blush',
  finger_insert: 'she arches slightly with a startled breath, hands clutching the sheets, deep blush',
  touch_neck: 'he kisses along her neck, her head tilting back, eyes half closed, flustered',
  lick_neck: 'his tongue tracing up the side of her neck, she shivers with a hand over her mouth',
  suck_nipple: 'he lowers his head to her chest, her clothes loosened, she covers her face in shame',
  touch_nipple: 'his fingertips teasing her chest over loosened clothing, she squirms and blushes',
  ear_nibble: 'he nibbles her earlobe, her shoulders jumping, ears turning red',
  inner_thigh: 'his hand sliding up the inside of her thigh under her skirt, she grips his wrist, breathing uneven',
  // ── 击打类（2026-10-02）：画面重点在"红印 + 身体弹动 + 她的反应"，不是暴力；与 Lv3/Lv4 同一尺度 ──
  spank_butt: 'his open palm striking her upturned bare bottom with a sharp smack, a red handprint blooming on the soft flesh, her whole body jolting forward, gasping',
  spank_thigh: 'his palm landing on the outside of her thigh with a crisp slap, a faint red mark on the skin, she flinches and looks back at him',
  slap_face_light: 'his palm resting against her cheek for a light slap, her head turned slightly, eyes wide and face flushed',
});

/** 腻烦档位 → 画面情绪（英文；与 ANNOYANCE_TIER_TEXT 的中文措辞同源口径） */
const TOUCH_IMAGE_MOODS = Object.freeze({
  fine: 'blushing, shy expression',
  warm: 'slightly annoyed but not resisting, pursed lips',
  refusing: 'frowning, about to push his hand away',
});

/**
 * 组装动作配图的 prompt（纯函数）。
 *
 * 组成：**英文画面句**（§一① 起**优先用 `imagePrompt`** —— 那一轮反应里 LLM 现写的画面；缺失才回落
 * `TOUCH_IMAGE_HINTS`）+ 情绪 + 场景氛围 + 画质词 + 可选**反应原文**（最多 60 字）
 * + 调用方给的外观块（`characterPersona.buildCharacterAppearanceSection`，AGENTS.md 允许生图用途）。
 * 本模块零依赖，所以外观块由调用方拼好传进来（与 `hypnosisBlock` / `scopeLine` 同款做法）。
 *
 * @returns {string} 空串 = 这个动作没有画面提示（不该出图）
 */
export function buildTouchImagePrompt({ actionKey, appearance = '', reactionText = '', imagePrompt = '', annoyance = 0, scene = 'chat' } = {}) {
  const action = getTouchAction(actionKey);
  if (!action) return '';
  // §一①：**优先用这一轮反应里 LLM 现写的画面**（图文同源）；只有它缺失/为空时才回落预写死的提示词。
  const written = String(imagePrompt || '').trim();
  const hint = written || TOUCH_IMAGE_HINTS[action.key] || '';
  if (!hint) return '';
  const mood = TOUCH_IMAGE_MOODS[annoyanceTier(annoyance)] || '';
  const setting = scene === 'group' ? 'other people faintly visible in the background' : 'intimate private moment';
  const sceneLine = [hint, mood, setting, 'soft warm lighting, cinematic composition, detailed, best quality']
    .filter(Boolean)
    .join(', ');
  const reaction = String(reactionText || '').trim().slice(0, 60);
  const head = reaction ? sceneLine + '\n' + reaction : sceneLine;
  const look = String(appearance || '').trim();
  return look ? head + '\n' + look : head;
}

/**
 * 生成挂进本轮聊天 dynamicBlocks 的 <touch_action> 块（**隐式注入模式**的核心）。
 *
 * 两种口径必须分开（专题 §七 的"抢戏"风险）：
 *   - mode='implicit'：还没演过 → 让她**在这一轮回复里**把反应写出来；
 *   - mode='instant'：反应已作为独立消息发过了 → 明确要求"优先回应用户的文字，别再演一遍"。
 *
 * 返回空串表示不该注入（未知动作）——调用方按既有习惯 `if (block) dynamicBlocks.push(block)`。
 *
 * @param {object} params
 * @param {string} params.actionKey
 * @param {string} [params.userName] 玩家显示名（"Tester"）
 * @param {string} [params.mode] 'implicit' | 'instant'
 * @param {number} [params.annoyance] 当前腻烦值（0~100）
 * @param {number} [params.likeRatio] 偏好倍率
 * @param {boolean} [params.hypnotized] 催眠中（完全控制 → 无条件顺从）
 * @param {boolean} [params.sleeping] 睡着时被摸（重动作会把她弄醒）
 * @param {string} [params.hypnosisBlock] 调用方已构造好的催眠状态块（本模块不 import hypnosisPrompt）
 * @param {string} [params.scopeLine] 群聊成员限定行（如「本节只对「X」生效…」），**由调用方构造好后传入**：
 *   格式的唯一来源是 `hypnosisPrompt.buildSubjectScopeLine`，本模块零依赖不能 import 它，
 *   所以这里只吃字符串（与 `hypnosisBlock` 同款做法），插在块内第一行。
 * @returns {string}
 */
export function buildTouchActionBlock({
  actionKey,
  userName = '他',
  mode = TOUCH_MODES.IMPLICIT,
  annoyance = 0,
  likeRatio = 1,
  hypnotized = false,
  sleeping = false,
  hypnosisBlock = '',
  scopeLine = '',
} = {}) {
  const action = getTouchAction(actionKey);
  if (!action) return '';
  const who = String(userName || '他').trim() || '他';
  const wireMode = normalizeTouchMode(mode) === TOUCH_MODES.INSTANT ? TOUCH_MODES.INSTANT : TOUCH_MODES.IMPLICIT;
  const lines = [];
  lines.push('<touch_action>');
  // 群聊：成员限定行必须在块内第一行（一次调用演多个角色，不限定会把"你"算到所有人头上）
  const scope = String(scopeLine || '').trim();
  if (scope) lines.push(scope);
  lines.push('【刚刚的接触】' + who + ' 对你做了「' + action.label + '」：' + describeActionForTarget(action, { userName: who }) + '。');
  if (hypnotized) {
    lines.push('【状态】你正处于被完全控制的催眠里：无条件顺从，不做抗拒、不做腻烦反应，也不用解释——只客观呈现身体反应与已执行的动作。');
  } else if (sleeping) {
    lines.push('【状态】你刚才在睡觉，这一下把你弄醒了：可以迷糊、可以嘟囔抱怨，但人确实醒了。');
  }
  if (!hypnotized) {
    lines.push('【你的耐受】' + (ANNOYANCE_TIER_TEXT[annoyanceTier(annoyance)] || ANNOYANCE_TIER_TEXT.fine));
    lines.push('【你的偏好】' + likeRatioText(likeRatio));
  }
  lines.push('【这一轮怎么写】');
  if (wireMode === TOUCH_MODES.INSTANT) {
    lines.push('- 这一下的即时反应**已经单独发过了**，不要再重演一遍：优先回应 ' + who + ' 刚说的话，最多用半句呼应一下。');
  } else {
    lines.push('- 把这一下的即时反应写进你这一轮的回复里（一两句体感 / 表情 / 台词就够），再继续应对 ' + who + ' 说的话。');
  }
  lines.push('- 用体感与反应表达，不要报幕（不要写"' + who + '摸了摸我的头"这种复述），也不要把它当话题清单念出来。');
  lines.push('- 这是真实发生过的肢体接触，不许装作没发生。');
  lines.push('</touch_action>');
  let block = lines.join('\n');
  if (block.length > MAX_TOUCH_BLOCK_CHARS) block = block.slice(0, MAX_TOUCH_BLOCK_CHARS) + '\n</touch_action>';
  if (hypnosisBlock) block = block + '\n\n' + String(hypnosisBlock).trim();
  return block;
}

/**
 * 构造「即时反应」轻量调用的请求体（专题 §2.1）。
 *
 * **只构造、不发请求**：调用方拿 messages 去调 LLM（建议 temperature 0.8 / max_tokens 300 上下），
 * 再把输出交给 parseReactionOutput。
 *
 * 人格块由调用方给（persona 字符串）：AGENTS.md 的「角色生图人格组装」节说非生图用途不套
 * characterPersona，而专题 §2.1 建议用 buildCharacterPersona(character, { variant: 'short' })——
 * 两者冲突，本模块**不替调用方选**，只吃字符串（接线说明里已列给 Lead 裁决）。
 *
 * JSON 示例按 AGENTS.md「LLM 输出」节给全（字段名 + 示例值 + 每条约束 + 只输出 JSON）。
 *
 * @returns {{system:string, user:string, messages:Array<{role:string,content:string}>, label:string}}
 */
export function buildReactionPrompt({
  actionKey,
  persona = '',
  characterName = '她',
  userName = '他',
  emotionText = '',
  likeRatio = 1,
  annoyance = 0,
  recentLines = [],
  scene = 'chat',
  groupPeek = false,
  sleeping = false,
  hypnosisBlock = '',
  hypnotized = false,   // §4.1②：催眠轮把耐受行换成降级文案（别和催眠块打架）
  bystanderName = '',   // §一③：群聊即时反应顺带拉一位围观者（并入同一次调用，省额度）
  imagePromptRule = '', // §一①：生图规范（含原作者要求的那段 MUST：IP 角色写成 `Name \(Series\) \(hair color, eye color, distinctive features\)` + 每人一句完整动作）。
                        // **必须由调用方传入** —— 本模块是零依赖纯函数模块（守卫 test/touchActionService.test.js:503 盯着"服务层不 import 任何东西"），
                        // 所以这里不 import builtinRules，由 `routes/touch.js` 取好规则传进来。
                        // 不传时行为与改动前**逐字一致**（既有调用方与测试不受影响）。
} = {}) {
  const action = getTouchAction(actionKey);
  const label = '触摸即时反应';
  if (!action) return { system: '', user: '', messages: [], label };
  const who = String(userName || '他').trim() || '他';
  const hers = String(characterName || '她').trim() || '她';
  // §4.1②：催眠轮耐受整行降级（否则 refusing 的「必须拍开手」会和催眠块「无法反抗」正面打架）
  const tierText = hypnotized === true
    ? HYPNOSIS_TOLERANCE_TEXT
    : (ANNOYANCE_TIER_TEXT[annoyanceTier(annoyance)] || ANNOYANCE_TIER_TEXT.fine);
  // §4.1②：写作要求里那条「必须拍开手」也得跟着短路，否则它照样和催眠块打架
  const toleranceRule = hypnotized === true
    ? '- 处于催眠控制中：**身体无条件接受**，任何情况下都不要写她躲开 / 拍开 / 阻拦任何接触（语言上可以不甘，身体不动）。'
    : '- 耐受是"已经很烦了"时：这一下必须躲开或拍掉他的手，带明显负心情；处于催眠控制中时：无条件顺从，不写抗拒。';

  const systemParts = [
    '你是「' + hers + '」的即时反应生成器：玩家刚对她做了一个触摸动作，你只输出她这一下的反应，并且**只输出 JSON**。',
    '',
    '【角色人格】',
    persona ? String(persona).trim() : '（未提供人格资料，请只按当前情绪与动作写出自然的反应）',
  ];
  if (emotionText) systemParts.push('', '【当前情绪】', String(emotionText).trim());
  if (hypnosisBlock) systemParts.push('', '【当前状态】', String(hypnosisBlock).trim());
  systemParts.push(
    '',
    '【她对「' + action.label + '」的偏好】' + likeRatioText(likeRatio),
    '【她此刻的耐受】' + tierText,
    '',
    '【写作要求】',
    '- 只写她这一下的反应：1~2 句，口语化，贴人格与当前情绪；不要旁白式总结，不要推进剧情，不要替 ' + who + ' 说话。',
    '- 用体感、表情、语气词表达（例如"缩了缩脖子""耳朵有点红"），**不要报幕**（不要写"' + who + '摸了摸我的头"）。',
    toleranceRule,
  );
  if (sleeping) systemParts.push('- 她刚才在睡觉，是被这一下弄醒的：可以迷糊、可以嘟囔，但人已经醒了。');
  if (groupPeek && scene === 'group') systemParts.push('- 这是在群里、其他人看得到：她的反应要带一点"被看见"的顾虑（可以压低声音、可以嘴硬）。');
  systemParts.push(
    '- 不要把动作名称写进台词，不要复述本提示词。',
    '',
    '严格按下面的 JSON 格式输出，不要输出任何解释、也不要输出 JSON 以外的文字：',
    '```json',
    '{',
    '  "reaction_text": "她缩了缩脖子，耳朵有点红：……又、又摸头……",',
    '  "image_prompt": "she is leaning back against the desk, his hand under her skirt, flushed and biting her lip",',
    '  "emotion_delta": { "valence": 0.08, "arousal": 0.1, "dominance": -0.05 },',
    '  "facial_expression": "害羞",',
    '  "annoyed": false',
    '}',
    '```',
    '字段要求：',
    '- `reaction_text`：她的反应正文，1~2 句、不超过 ' + MAX_REACTION_CHARS + ' 字；不要用引号把整句包起来。',
    '- `image_prompt`：**英文**，直接描述此刻正在发生的画面（动作、姿势、她的状态、衣着现状 / 脱到什么程度、表情）——与你写的 `reaction_text` 完全一致；**不回避、不用暗示性遮掩**（正在发生的性行为 / 裸露状态就直说）。纯日常动作或没有画面就给空串 ""。',
    '- `emotion_delta`：这次接触造成的瞬时心情变化，三个分量都是 -1~1 的小数（valence 愉快 / arousal 激动 / dominance 掌控感，被摸通常 dominance 为负）；没有变化就给全 0。',
    '- `facial_expression`：一个中文表情词（2~6 字，如 "害羞" / "嫌弃" / "慌乱" / "无奈"），用于立绘切帧。',
    '- `annoyed`：布尔值，她这一下是否表现出不耐烦；与上面的"耐受"档位一致（已经很烦时必须是 true）。',
  );
  // 生图规范由调用方传入（本模块零依赖，不 import builtinRules）；不传则一个字都不加，
  // 与改动前的 system 逐字一致 —— 这是既有调用方与测试的兼容底线。
  if (imagePromptRule) systemParts.push('', String(imagePromptRule).trim());
  const system = systemParts.join('\n');

  const recent = (Array.isArray(recentLines) ? recentLines : [])
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .slice(-4);
  const user = [
    '【刚刚发生的动作】' + who + ' 做了「' + action.label + '」：' + describeActionForTarget(action, { userName: who }) + '。',
    recent.length > 0 ? '【最近两轮对话】\n' + recent.map(line => '- ' + line).join('\n') : '【最近两轮对话】（无）',
    '【场景】' + (scene === 'group' ? '群聊' + (groupPeek ? '（其他人看得到）' : '') : '私聊'),
    '',
    '请按上面的 JSON 格式输出她这一下的反应。',
  ].join('\n');

  return {
    system,
    user,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    label,
  };
}

// ── 六·B 对话式反应 prompt（task-30 反应喂料扩容）────────────────────────────
//
// 为什么单独一个 builder 而不改 buildReactionPrompt：快速版是"一键回退"路径，必须保持口径稳定；
// 本函数是**默认**路径（`features.touchReactionMode` 缺省 = conversation），把"现状"喂全：
//   人格 + 情绪 + **关系/好感** + **她正在做的事（日程）** + **催眠状态** + **亲密档案**
//   + 耐受/偏好 + **最近 8 条对话**（按场景 char_ / group_ 会话）+ 动作定义与等级 + 同一动作是否刚发生过。
// 输出口径同时放开：1~4 句、允许顺着话题接话与结尾抛话（"触摸触发对话"）；
// **JSON 四字段不变**（reaction_text / emotion_delta / facial_expression / annoyed）—— 下游解析、心情、
// 立绘、看板记账全靠它们，一行不用改。
//
// 本模块零依赖：四块新喂料由调用方（routes/touch.js）调用既有 builder 拼好后传入，
// 与 `hypnosisBlock` / `scopeLine` 同款做法；每块拿不到就不传（不硬塞空段）。

/** 对话式反应默认喂多少条最近对话（快速版仍是 4 条上限） */
export const CONVERSATION_RECENT_LINES = 8;

/**
 * 组装"对话式"即时反应 prompt（task-30）。
 *
 * @param {object} params 与 buildReactionPrompt 同名参数 + 四块新喂料 + recentSameAction
 * @param {string} [params.affinityBlock]  关系/好感档位（调用方用 emotionEngine.affinityToPrompt）
 * @param {string} [params.scheduleBlock]  她此刻在做什么（scheduleManager.formatScheduleContext）
 * @param {string} [params.intimateBlock]  亲密档案块（intimatePrompt.buildIntimateProfileBlock）
 * @param {{minutesAgo:number, count:number}|null} [params.recentSameAction] 同一动作刚发生过？
 * @returns {{system:string, user:string, messages:Array, label:string, meta:{rounds:number, blocks:string[], sameAction:boolean}}}
 */
export function buildConversationReactionPrompt({
  actionKey,
  persona = '',
  characterName = '她',
  userName = '他',
  emotionText = '',
  likeRatio = 1,
  annoyance = 0,
  recentLines = [],
  scene = 'chat',
  groupPeek = false,
  sleeping = false,
  hypnosisBlock = '',
  affinityBlock = '',
  scheduleBlock = '',
  intimateBlock = '',
  recentSameAction = null,
  maxRecentLines = CONVERSATION_RECENT_LINES,
  hypnotized = false,   // §4.1②：催眠轮把耐受行换成降级文案（别和催眠块打架）
  bystanderName = '',   // §一③：群聊即时反应顺带拉一位围观者（并入同一次调用，省额度）
  imagePromptRule = '', // §一①：生图规范（含原作者要求的那段 MUST：IP 角色写成 `Name \(Series\) \(hair color, eye color, distinctive features\)` + 每人一句完整动作）。
                        // **必须由调用方传入** —— 本模块是零依赖纯函数模块（守卫 test/touchActionService.test.js:503 盯着"服务层不 import 任何东西"），
                        // 所以这里不 import builtinRules，由 `routes/touch.js` 取好规则传进来。
                        // 不传时行为与改动前**逐字一致**（既有调用方与测试不受影响）。
} = {}) {
  const action = getTouchAction(actionKey);
  const label = '触摸对话式反应';
  if (!action) return { system: '', user: '', messages: [], label, meta: { rounds: 0, blocks: [], sameAction: false } };
  const who = String(userName || '他').trim() || '他';
  const hers = String(characterName || '她').trim() || '她';
  // §4.1②：催眠轮耐受整行降级（否则 refusing 的「必须拍开手」会和催眠块「无法反抗」正面打架）
  const tierText = hypnotized === true
    ? HYPNOSIS_TOLERANCE_TEXT
    : (ANNOYANCE_TIER_TEXT[annoyanceTier(annoyance)] || ANNOYANCE_TIER_TEXT.fine);
  // §4.1②：写作要求里那条「必须拍开手」也得跟着短路，否则它照样和催眠块打架
  const toleranceRule = hypnotized === true
    ? '- 处于催眠控制中：**身体无条件接受**，任何情况下都不要写她躲开 / 拍开 / 阻拦任何接触（语言上可以不甘，身体不动）。'
    : '- 耐受是"已经很烦了"时：这一下必须躲开或拍掉他的手，带明显负心情；处于催眠控制中时：无条件顺从，不写抗拒。';

  const affinity = String(affinityBlock || '').trim();
  const schedule = String(scheduleBlock || '').trim();
  const intimate = String(intimateBlock || '').trim();
  const hypnosis = String(hypnosisBlock || '').trim();
  const blocks = [];
  if (affinity) blocks.push('affinity');
  if (schedule) blocks.push('schedule');
  if (intimate) blocks.push('intimate');
  if (hypnosis) blocks.push('hypnosis');

  const systemParts = [
    '你是「' + hers + '」。' + who + '刚刚对她做了一个触摸动作，请**以她本人的身份**像回一条聊天消息那样回应；只输出 JSON。',
    '',
    '【角色人格】',
    persona ? String(persona).trim() : '（未提供人格资料，请只按当前情绪与动作写出自然的反应）',
  ];
  if (emotionText) systemParts.push('', '【当前情绪】', String(emotionText).trim());
  if (affinity) systemParts.push('', '【你们的关系】', affinity);
  if (schedule) systemParts.push('', '【她此刻正在做的事】', schedule);
  if (intimate) systemParts.push('', '【亲密档案】', intimate);
  if (hypnosis) systemParts.push('', '【当前状态】', hypnosis);
  systemParts.push(
    '',
    '【她对「' + action.label + '」的偏好】' + likeRatioText(likeRatio),
    '【她此刻的耐受】' + tierText,
    '',
    '【写作要求】',
    '- 像回一条聊天消息一样回应：**1~4 句**，第一人称（她的口吻），可以长可以短；不要旁白式总结，不要替 ' + who + ' 说话。',
    '- **顺着当前话题接话**：如果刚才聊到一半的事、她手头正在做的事、或你们之间的往事被这一下勾起来了，就顺着说下去（可以追问、打趣、撒娇、抗议）。',
    '- 如果她想，**可以在结尾向 ' + who + ' 抛一句话**（撒娇 / 抗议 / 提问都行），让他接得下去；但她已经很烦（annoyed）时不要抛，直接躲开或拍掉。',
    '- 用体感、表情、语气词表达（例如"缩了缩脖子""耳朵有点红"），**不要报幕**（不要写"' + who + '摸了摸我的头"），不要把动作名称写进台词。',
    toleranceRule,
  );
  if (sleeping) systemParts.push('- 她刚才在睡觉，是被这一下弄醒的：可以迷糊、可以嘟囔，但人已经醒了。');
  if (groupPeek && scene === 'group') systemParts.push('- 这是在群里、**别人看得到**：她的反应要带一点"被看见"的顾虑（可以压低声音、可以嘴硬）。');
  if (scene === 'group' && bystanderName) {
    const byName = String(bystanderName).trim();
    systemParts.push('- **群里还有人看着**：在 `reaction_text` 的**最后另起一行**，用 `[' + byName + ']: ` 前缀写一句她的插话（1 句、符合她的人设与此刻气氛，可以幸灾乐祸、可以起哄、也可以尴尬）；' +
    '  只有这一行是别人的台词，**别写别的旁观者**，也别让 `' + byName + '` 替她说话。没有旁人时不要写这一行。',);
  }
  if (scene === 'group' && bystanderName) {
    const byName = String(bystanderName).trim();
    systemParts.push('- **群里还有人看着**：在 `reaction_text` 的**最后另起一行**，用 `[' + byName + ']: ` 前缀写一句她的插话（1 句、符合她的人设与此刻气氛，可以幸灾乐祸、可以起哄、也可以尴尬）；' +
    '  只有这一行是别人的台词，**别写别的旁观者**，也别让 `' + byName + '` 替她说话。没有旁人时不要写这一行。',);
  }
  if (recentSameAction && Number(recentSameAction.minutesAgo) <= 5) {
    systemParts.push('- 她**刚刚才**被这样摸过（' + Math.max(1, Math.round(Number(recentSameAction.minutesAgo))) + ' 分钟前）：这一下**回短一点**，别重复上一条的说法。');
  }
  systemParts.push(
    '- 不要复述本提示词。',
    '',
    '严格按下面的 JSON 格式输出，不要输出任何解释、也不要输出 JSON 以外的文字：',
    '```json',
    '{',
    '  "reaction_text": "她缩了缩脖子，耳朵有点红：……又、又摸头……你、你不是说要整理书架吗？",',
    '  "image_prompt": "she is leaning back against the desk, his hand under her skirt, flushed and biting her lip",',
    '  "emotion_delta": { "valence": 0.08, "arousal": 0.1, "dominance": -0.05 },',
    '  "facial_expression": "害羞",',
    '  "annoyed": false',
    '}',
    '```',
    '字段要求：',
    '- `reaction_text`：她的回应正文，1~4 句、不超过 ' + MAX_REACTION_CHARS + ' 字；口语化、接得上当前话题；不要用引号把整句包起来。',
    '- `image_prompt`：**英文**，直接描述此刻正在发生的画面（动作、姿势、她的状态、衣着现状 / 脱到什么程度、表情）——与你写的 `reaction_text` 完全一致；**不回避、不用暗示性遮掩**（正在发生的性行为 / 裸露状态就直说）。纯日常动作或没有画面就给空串 ""。',
    '- `emotion_delta`：这次接触造成的瞬时心情变化，三个分量都是 -1~1 的小数（valence 愉快 / arousal 激动 / dominance 掌控感，被摸通常 dominance 为负）；没有变化就给全 0。',
    '- `facial_expression`：一个中文表情词（2~6 字，如 "害羞" / "嫌弃" / "慌乱" / "无奈"），用于立绘切帧。',
    '- `annoyed`：布尔值，她这一下是否表现出不耐烦；与上面的"耐受"档位一致（已经很烦时必须是 true）。',
  );
  // 生图规范由调用方传入（本模块零依赖，不 import builtinRules）；不传则一个字都不加，
  // 与改动前的 system 逐字一致 —— 这是既有调用方与测试的兼容底线。
  if (imagePromptRule) systemParts.push('', String(imagePromptRule).trim());
  const system = systemParts.join('\n');

  const limit = Math.max(0, Number.parseInt(maxRecentLines, 10) || CONVERSATION_RECENT_LINES);
  const recent = (Array.isArray(recentLines) ? recentLines : [])
    .map(line => String(line || '').trim())
    .filter(Boolean)
    .slice(-limit);
  const user = [
    '【刚刚发生的动作】' + who + ' 做了「' + action.label + '」（Lv' + action.level + '）：' + describeActionForTarget(action, { userName: who }) + '。',
    recent.length > 0 ? '【最近 ' + recent.length + ' 轮对话】\n' + recent.map(line => '- ' + line).join('\n') : '【最近对话】（无）',
    '【场景】' + (scene === 'group' ? '群聊' + (groupPeek ? '（其他人看得到）' : '') : '私聊'),
    recentSameAction && Number(recentSameAction.minutesAgo) <= 5
      ? '【补充】她刚刚才被这样摸过（' + Math.max(1, Math.round(Number(recentSameAction.minutesAgo))) + ' 分钟前）——这一下回短一点。'
      : null,
    '',
    '请按上面的 JSON 格式输出她的回应。',
  ].filter(part => part !== null).join('\n');

  return {
    system,
    user,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    label,
    meta: { rounds: recent.length, blocks, sameAction: Boolean(recentSameAction && Number(recentSameAction.minutesAgo) <= 5) },
  };
}
// ── 七、即时反应输出解析（容错手法照 intimateAiJudge.parseJudgeOutput） ──────

/** 裸解析：容忍 json 代码块包裹与前后夹话（截第一个 { 到最后一个 }） */
function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(body.slice(start, end + 1));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * 解析即时反应输出 → 规范化结果（越界夹取、缺字段给默认、坏 JSON 不写脏数据）。
 *
 * @param {string} text LLM 原始输出
 * @returns {{ok:boolean, error:string, reactionText:string, imagePrompt:string, emotionDelta:object|null,
 *            facialExpression:string, annoyed:boolean}}
 */
export function parseReactionOutput(text) {
  const empty = { ok: false, error: '', reactionText: '', imagePrompt: '', emotionDelta: null, facialExpression: '', annoyed: false };
  const parsed = parseJsonLoose(text);
  if (!parsed) return { ...empty, error: 'output is not valid JSON' };
  // 只认字符串（模型偶尔把数字塞进来，那不是台词；宁可不记也别把 "123" 当反应发出去）
  const rawText = typeof parsed.reaction_text === 'string' ? parsed.reaction_text
    : (typeof parsed.reactionText === 'string' ? parsed.reactionText : '');
  const reactionText = rawText.trim().slice(0, MAX_REACTION_CHARS);
  if (!reactionText) return { ...empty, error: 'missing reaction_text' };
  const source = parsed.emotion_delta != null ? parsed.emotion_delta : (parsed.emotionDelta != null ? parsed.emotionDelta : null);
  const emotionDelta = source && typeof source === 'object'
    ? {
      valence: clampNumber(source.valence, -1, 1, 0),
      arousal: clampNumber(source.arousal, -1, 1, 0),
      dominance: clampNumber(source.dominance, -1, 1, 0),
    }
    : null;
  const facialExpression = String(parsed.facial_expression != null ? parsed.facial_expression : (parsed.facialExpression != null ? parsed.facialExpression : ''))
    .trim().slice(0, 12);
  // §一①：LLM 现写的画面描述（英文）。非字符串不认（数字/对象一律当没给 ⇒ 走 TOUCH_IMAGE_HINTS 兜底）
  const rawImagePrompt = typeof parsed.image_prompt === 'string' ? parsed.image_prompt
    : (typeof parsed.imagePrompt === 'string' ? parsed.imagePrompt : '');
  const imagePrompt = rawImagePrompt.trim().slice(0, MAX_IMAGE_PROMPT_CHARS);
  return {
    ok: true,
    error: '',
    reactionText,
    imagePrompt,
    emotionDelta,
    facialExpression,
    annoyed: parsed.annoyed === true,
  };
}

/** 只要反应正文（实时消息流用：解析失败就直接不显示，别把 JSON 漏给用户） */
export function extractReactionText(text) {
  const parsed = parseReactionOutput(text);
  return parsed.ok ? parsed.reactionText : '';
}
