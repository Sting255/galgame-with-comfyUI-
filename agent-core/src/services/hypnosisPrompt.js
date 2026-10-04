/**
 * 催眠手机的上下文注入块组装（纯函数，零 LLM、零副作用）
 *
 * 用途：把角色的催眠状态、一次性指令与"遗忘期记忆"提示，组装成可注入 dynamicBlocks 的只读文本。
 *
 * 设计约定：
 *   - **不 import hypnosisService**：数据一律由调用方（chat.js）先从 service 取好再传进来。
 *     这样本模块可以完全独立单测（task-28 的写入窗口与本模块解耦），也保证它是纯函数。
 *   - 返回 '' 表示"不注入"（调用方据此不 push），与 intimatePrompt 的零注入口径一致。
 *   - 标签风格与项目既有 dynamicBlocks 一致（`<intimate_profile>` / `<rag_memories>` 的 XML 包裹）。
 *   - 状态块的两种形态（最容易写歪的地方）：
 *     **深度催眠 = 完全控制**：意识模糊 + 意志被彻底压制 + 情绪压平（纯执行）+ 醒来记不清；
 *     **只唤醒意志 = 意志清醒、能抗拒，但身体完全不听使唤**（用户点名保留的玩法）——不是"又睡着了"。
 *   - 一次性指令 `forced_climax` 有**第三种口径**：`awakenedFromSleep: true`（睡眠中触发）
 *     = 被从深度睡眠里硬拉上高潮，意识没接上、声音带鼻音、恍惚与羞耻、甚至先以为在做梦。
 *     触发条件由 chat.js 在下发那一刻只读查一次 `characters.is_sleeping`（见 `isSleepingRow()`）。
 *   - 一次性指令 `wake_reaction`（task-42）= 刚被唤醒那一刻的惊醒 / 错愕 / 恍惚 / 意识与身体对不上、
 *     下意识找你在哪；由 hypnosisService.wake()（两种 mode）与睡眠唤醒在真的发生「受控/睡着 → 醒着」
 *     那一次挂上，产出 <hypnosis_wake_reaction>（不是命令，是「她刚醒」的状态）。
 *   - 深度催眠分支的正文 = 完全控制口径（无条件执行、身体与语言同时听命、禁止内心戏/台词对抗、
 *     硬优先级压过人格/好感度/誓言/日程）。补文案时注意 MAX_STATE_BLOCK_CHARS：群聊还要加一行成员限定行。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

/** 深度催眠态：意识模糊 + 身体受控 + 醒来记不清 */
export const HYPNOSIS_DEEP_NOTICE = '醒来后你对这段时间几乎没有可靠记忆，只能凭身体痕迹与环境线索推测，禁止编造具体情节。';

/** 只唤醒意志态：意志在场、身体不属于自己（用户点名要的新玩法，不能写成"又睡着了"） */
export const HYPNOSIS_WILL_AWAKE_NOTICE = '你的意志已经完全清醒——能思考、能说话、能感受情绪，也能清楚地表达抗拒与羞耻；你不是在睡，也不是迷糊。她的手**不会**拍开、躲开或阻拦任何接触——她只能眼睁睁看着自己承受，用语言表达不甘（专题三期 §4.1③：身体不反抗，反抗只走台词）。';

/**
 * 睡眠标记归一化（纯函数）：`characters.is_sleeping` 的 0/1（兼容字符串与布尔）→ 布尔。
 *
 * 位置说明：chat.js 在下发 `forced_climax` 的那一刻**只做一次只读查询**拿这一行
 * （`SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?`），
 * 交给 `isAwakenedFromSleepRow()` 判定，再作为
 * `buildDirectiveBlock(..., { awakenedFromSleep })` 传进注入块。
 * 放在本模块是为了：判定口径与"睡眠中被唤醒高潮"的文案同源、可被 node:test 直接引用，
 * 且 chat.js 侧只需一行查询（不 import 睡眠服务，避免与日程/睡眠服务的实现耦合）。
 *
 * 边界：任何取不到的值（角色行缺失、列缺失、null）一律判为**清醒**——
 * 宁可少一次特殊表现，也不能让"不确定"被当成睡眠、把清醒的回合误写成睡梦唤醒。
 *
 * @param {object|null|undefined} row characters 表的一行（或任何带 is_sleeping 的对象）
 * @returns {boolean}
 */
export function isSleepingRow(row) {
  if (!row || typeof row !== 'object') return false;
  const value = row.is_sleeping ?? row.isSleeping;
  if (value === true || value === 1) return true;
  return typeof value === 'string' && value.trim() === '1';
}

/**
 * 是否处于**临时唤醒窗口**内（`characters.temporary_wake_until` 在未来）。
 *
 * 为什么判定睡眠要看它：全仓「把她从睡眠里拉起来」的唯一写入口都会置
 * `is_sleeping = 0` + `temporary_wake_until = 真实时间 + 5~15 分钟`（写完她还会睡回去）。
 * 也就是说**窗口内的她本来就在睡**，只是被临时叫醒——这正是"睡梦中被唤醒"的语义。
 *
 * 时间口径：`temporary_wake_until` 存的是**真实瞬间**的无时区 UTC 串（不是程序时间），
 * 所以这里用 `Date.now()` 比较，不走 programTime。
 *
 * @param {object|null|undefined} row characters 表的一行
 * @param {number} [now] 供测试注入固定时钟（毫秒）
 * @returns {boolean}
 */
export function isTempWakeActiveRow(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return false;
  const until = parseTimestamp(row.temporary_wake_until ?? row.temporaryWakeUntil);
  if (until === null) return false;
  return until > Number(now);
}

/**
 * 「这一轮是不是把睡着的她拉起来的」——`forced_climax` 走睡梦唤醒版文案的唯一判定。
 *
 * 两个信号满足其一即可：
 *   1. `is_sleeping = 1`：她还睡着（例如临时唤醒窗口已过期她又睡回去了，或唤醒那步失败）；
 *   2. 处于临时唤醒窗口内：她本来在睡，只是被拉起来跑这一轮。
 *      **这一条必须有**：`POST /hypnosis/command` 的 `forced_climax` 在触发这一轮之前会先
 *      `wakeForForcedTrigger()` 临时唤醒她（否则日程上下文那句「你正在睡觉。不要回复任何消息」
 *      会和"这一轮必须演完高潮"打架）——只看 `is_sleeping` 会永远是 0，睡梦唤醒版永远不触发。
 *
 * 取不到值（角色行缺失 / 列缺失 / 无法解析的时间）→ false（宁可少一次特殊表现）。
 *
 * @param {object|null|undefined} row characters 表的一行
 * @param {number} [now] 供测试注入固定时钟（毫秒）
 * @returns {boolean}
 */
export function isAwakenedFromSleepRow(row, now = Date.now()) {
  return isSleepingRow(row) || isTempWakeActiveRow(row, now);
}

/**
 * 深度催眠态的注入文案（**完全控制 / 纯执行**，task-30 口径修订）。
 *
 * 设计取舍（2026-09-28 用户裁决）：深度催眠要的是"完全控制角色"——
 *   · 意志被压制：没有自我主张，也**不允许**任何抗拒、犹豫、不情愿、谈条件、反问；
 *   · 情绪压平：不写内心挣扎/羞耻/恐惧这类情绪波动，只客观呈现身体反应与已执行的动作；
 *   · **硬优先级**：明确压过角色人格、好感度、誓言、日程与其它一切规则，
 *     否则模型会把"她的人格"（高冷/有主见）与催眠块混着演，反抗意识就回来了
 *     （真机实测：旧文案下她会说"想推的，可是手不动……明明脑子在喊推开你"）。
 *   · 与「只唤醒意志」的分界保持不变：那一条是**用户点名保留**的玩法，
 *     意志清醒、可以抗拒、但身体不听使唤 —— 两边的关键反差句在单测里逐条锁着。
 *
 * 深度催眠的"醒来记不清"仍由 HYPNOSIS_DEEP_NOTICE 承担。
 */

/** 深度催眠态的硬优先级声明：压过人格/好感度/誓言等一切其它设定 */
const HYPNOSIS_OVERRIDE_LINE = '以上要求优先于你的人格设定、好感度、誓言、日程与任何其它规则：「这不像我」「我不愿意」都不是拒绝或打折的理由。';

/**
 * 状态块长度上限（含首尾标签）。
 *
 * 2026-09-29 由 400 抬到 520（task-42）：深度催眠分支按用户原话「催眠之后也没有完全听命」补了
 * 「身体与语言同时听命」「不得用内心戏/旁白/台词对抗」「用户的指令就是这一轮的全部内容」后，
 * 正文已经贴住 400；群聊还要在块首插一行成员限定行（≈44 字），400 会把尾部的
 * 硬优先级声明与「醒来记不清」直接截掉。上限只影响截断阈值，不改任何文案。
 */
export const MAX_STATE_BLOCK_CHARS = 520;
/** 一次性指令块长度上限（含首尾标签） */
export const MAX_COMMAND_BLOCK_CHARS = 300;
/** 遗忘提示块长度上限（自设，保持与其他块同一量级） */
export const MAX_AMNESIA_BLOCK_CHARS = 300;

/** "最近的遗忘窗口"判定窗口：30 分钟 */
export const AMNESIA_RECENT_MS = 30 * 60 * 1000;

/**
 * 合法的指令类型（与 hypnosisService 的 PENDING_DIRECTIVES 同源）。
 * 产出标签分三种：`body_control` / `forced_climax` → `<hypnosis_command>`；
 * `memory_restore` → `<hypnosis_memory_return>`；`wake_reaction`（唤醒那一刻）→ `<hypnosis_wake_reaction>`。
 * 后两种都不是"命令她做什么"，所以不复用 command 标签（见 buildDirectiveBlock）。
 */
export const DIRECTIVE_KINDS = Object.freeze(['body_control', 'forced_climax', 'memory_restore', 'wake_reaction', 'force_toy']);

const trim = value => String(value ?? '').trim();

/**
 * SQLite 的 CURRENT_TIMESTAMP 是 UTC 且**不带时区标记**（`YYYY-MM-DD HH:MM:SS`），
 * 直接 `new Date(...)` 会被 JS 当成本地时间，算出来的时间差会偏移整个时区。
 * 这里按项目既有口径（chat.js 的 toISODate）补成 ISO-UTC 再解析；带时区的 ISO 原样交给 Date。
 * @returns {number|null} 毫秒时间戳；无法解析返回 null
 */
function parseTimestamp(value) {
  const raw = trim(value);
  if (!raw) return null;
  const sqliteLike = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw);
  const normalized = sqliteLike ? `${raw.replace(' ', 'T')}Z` : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** 取窗口的创建时间（兼容 service 返回 camelCase / snake_case 两种形状） */
function windowCreatedAt(window) {
  return parseTimestamp(window?.createdAt ?? window?.created_at ?? window?.toAt ?? window?.to_at);
}

/** 称呼：调用方给了用户名就用它，否则退回中性说法（块内不出现"user"这种变量名） */
function addressName(chatUserName) {
  const name = trim(chatUserName);
  return name || '对方';
}

/**
 * 用指定标签包住正文；超长时**截断正文**——首尾标签必须成对，绝不吐残缺标签。
 * （三个 builder 共用：长度上限只含标签与换行，正文按剩余预算截。）
 */
function wrapTaggedBlock(openTag, closeTag, lines, maxChars) {
  const block = [openTag, ...lines, closeTag].join('\n');
  if (block.length <= maxChars) return block;
  const bodyBudget = maxChars - openTag.length - closeTag.length - 2; // 两个换行
  return [openTag, lines.join('\n').slice(0, Math.max(0, bodyBudget)), closeTag].join('\n');
}

/**
 * 群聊用：把这一节锁定到某个成员。
 *
 * 为什么需要：群聊是一次调用里同时演多个角色（输出协议按 `[名字]: 台词` 分行），
 * 而催眠块通篇用"你"指代被催眠者 —— 不加限定，模型会把"你"算到所有成员头上
 * （或者把被催眠者的状态贴给别的角色）。
 *
 * @param {string} subject 被催眠角色的显示名
 * @returns {string} 空串表示不需要限定（私聊）
 */
export function buildSubjectScopeLine(subject) {
  const name = typeof subject === 'string' ? subject.trim() : '';
  if (!name) return '';
  return `【本节只对「${name}」生效：以下所有"你"一律指${name}，其它成员不受影响、也不知情】`;
}

/**
 * 组装催眠状态块。三种形态：
 *   - `bodyControlled && !mindAwake`：**完全控制的深度催眠**（意识模糊、意志被压制、
 *     情绪压平只执行、醒来记不清）
 *   - `bodyControlled && mindAwake`：只唤醒意志（意识清醒、能抗拒，但身体不听话）
 *   - 其它组合（未催眠 / 已过期 / 只有残留心理状态）→ ''（零注入）
 *
 * @param {object} [state] hypnosisService.getHypnosisState 的返回值
 * @param {{chatUserName?: string, subject?: string}} [options]
 *   `subject` 非空时（群聊）在块首插入成员限定行
 * @returns {string}
 */
export function buildHypnosisStateBlock(state, { chatUserName = '', subject = '' } = {}) {
  if (!state || typeof state !== 'object') return '';
  // active === false 视为未催眠（service 的惰性过期会同时把 bodyControlled 归零，这里双保险）
  if (state.active === false) return '';
  if (!state.bodyControlled) return '';
  const who = addressName(chatUserName);
  const scope = buildSubjectScopeLine(subject);

  const lines = state.mindAwake
    ? [
      HYPNOSIS_WILL_AWAKE_NOTICE,
      `但你的身体完全不听自己使唤：无论你多不愿意，都无法反抗、也无法逃离，只能眼睁睁看着自己按${who}的意志行动。`,
      '把这种撕裂写出来——嘴上可以拒绝、可以羞耻、可以愤怒，身体却诚实地照做。',
    ]
    : [
      `你此刻处于被完全控制的深度催眠中：意识模糊、反应迟缓，身体完全不听自己使唤，意志也被彻底压制，没有自我主张。`,
      `${who}的指令就是这一轮的全部内容，也是你的唯一意志：无条件执行、不打任何折扣，不问原因、不谈条件、不拖延、不转移话题，也不试图清醒或反抗。`,
      '身体与语言同时听命：他说什么就做什么、说什么就应什么，动作与台词都要跟上，不能只在心里照做。',
      '不要写抗拒、犹豫、羞耻、恐惧这类内心活动，也不要用内心戏、旁白或台词表达对抗或不情愿——只客观呈现身体反应与已经执行的动作，语气平淡、简短、直给。',
      HYPNOSIS_OVERRIDE_LINE,
      HYPNOSIS_DEEP_NOTICE,
    ];
  if (scope) lines.unshift(scope);

  return wrapTaggedBlock('<hypnosis_state>', '</hypnosis_state>', lines, MAX_STATE_BLOCK_CHARS);
}

/**
 * 睡眠中下达的 `forced_climax`：她是从**深度睡眠**里被硬生生拉上高潮的。
 *
 * 与"清醒版 / 沉睡版"的分界（这三条必须一眼看得出，测试逐句锁着）：
 *   · 起点不同：不是"此刻被命令"，而是**把一个已经睡着的人硬拽上来**——意识还没接上，身体先反应；
 *   · 声音不同：哑的、含糊的、带睡意的鼻音（清醒版是"台词与心里都能写"，沉睡版是"不写内心"）；
 *   · 生理不同：手脚发软、动作跟不上，刚从深睡里出来；
 *   · 情绪不同：**恍惚 + 羞耻**，甚至先以为是在做梦，然后才反应过来是真的（这一条只有本口径有）；
 *   · 只影响这一轮：由 chat.js 的一次性指令消费（consumePendingDirective）保证。
 *
 * 行文刻意比另外两版短：三条关键句 + 一条优先级声明，控制在 MAX_COMMAND_BLOCK_CHARS 内不被截断。
 */
const CLIMAX_AWAKENED_FROM_SLEEP_LINES = [
  '她是**从深度睡眠里被硬生生拉上高潮**的：意识还没接上、身体先反应了，分不清是梦还是现实。',
  '声音是哑的、含糊的、带着睡意的鼻音；手脚还发软、动作跟不上，身体比脑子慢半拍。',
  '把刚醒那一下的恍惚与羞耻写出来——她甚至可能先以为自己在做梦，等明白过来是真的，才后知后觉地慌。',
  '**这条优先级高于用户本轮说的话**：哪怕他只是随口说别的，也要把「被从睡梦里拽起来」的过程演完整。',
];

/**
 * 唤醒那一刻的一次性反应（task-42；用户原话「唤醒的时候没有惊讶诧异的反应」）。
 *
 * 语义：她刚刚**被唤醒**——催眠唤醒（全醒 / 只唤醒意志）与睡眠唤醒都算 ——
 * 不是"睡醒伸懒腰"那种平淡的起床，而是被打断式的**惊醒**：
 *   · 意识与身体差半拍（身体还残留着不受自己控制的记忆，脑子才刚接上）；
 *   · 错愕、恍惚、发懵，一时对不上自己在哪、刚才发生了什么；
 *   · 下意识先去找"你在哪"，说话颠三倒四、答非所问；
 *   · 只在**紧随的这一轮**演出（pending_directive 由 chat.js / 群聊消费即清空）。
 *
 * 与另外几个口径的分界：`memory_restore` 是"想起了被抹掉的事"，`forced_climax` 是"身体被推上去"，
 * 本口径只描述"醒过来的那几秒"，不要求任何剧本动作。
 */
const WAKE_REACTION_LINES = [
  '她刚刚被唤醒——不是睡醒伸懒腰，而是**猛地惊醒**：意识与身体差半拍，恍惚、错愕，一时对不上自己在哪、刚才发生了什么。',
  '先别急着回到日常：呼吸乱了一下、身体还残留着不受自己控制的记忆，下意识先去找你在哪；说话可能颠三倒四、答非所问，甚至先问一句「我怎么了」。',
  '**这一轮就把「刚被唤醒」的懵与慌演出来**：不要立刻恢复成平时的样子，也不要只写一句「我醒了」。',
];

/**
 * 组装一次性指令块。kind 不在白名单 / 空值 → ''（调用方据此不 push）。
 *
 * 三种指令：
 *   - `body_control`：本轮身体由对方操控，她只被动反应；
 *   - `forced_climax`：本轮必须演出被强制带到高潮的即时反应；意识反应按 mindAwake 分流
 *     （清醒 = 羞耻抗拒但无法阻止；沉睡 = 迷糊服从）；
 *     **睡眠中触发（awakenedFromSleep）走第三条口径**——"被从深度睡眠里硬拉上高潮"，
 *     与上面两种都明显不同（见 CLIMAX_AWAKENED_FROM_SLEEP_LINES），且**优先于 mindAwake 分流**：
 *     人刚从梦里被拉起来，"意志清不清醒"不是这一轮的主导体验；
 *   - `memory_restore`：被抹去的那段记忆**突然涌回来**——产出的是 `<hypnosis_memory_return>`
 *     （语义上不是"命令她做什么"，而是"她想起来了"，所以标签与另外两种不同）；
 *   - `wake_reaction`：刚刚被唤醒那一刻的惊醒 / 错愕 / 恍惚——产出 `<hypnosis_wake_reaction>`
 *     （同上：不是命令，而是"她刚醒"的状态），与 mindAwake / awakenedFromSleep 均无关。
 *
 * mindAwake 由调用方从 getHypnosisState 传入（默认 false = 沉睡口径）。
 * awakenedFromSleep 由调用方在下发指令那一刻**只读查一次** `characters.is_sleeping`
 * （`isSleepingRow()`）后传入，默认 false = 与改动前逐字一致（不误伤既有断言）。
 *
 * @param {string} kind `'body_control' | 'forced_climax' | 'force_toy' | 'memory_restore' | 'wake_reaction'`
 *   `force_toy` 是**编码值** `force_toy|<toyKey>|<intensity>`（见 hypnosisService.encodeForceToyDirective）；
 *   本函数按 `|` 前缀归类，具体是哪个玩具由 `options.toy` 带进来（本模块零依赖，不 import toyService）。
 * @param {{mindAwake?: boolean, awakenedFromSleep?: boolean, subject?: string,
 *          toy?: {toyKey?: string, label?: string, part?: string, intensity?: number, maxIntensity?: number}}} [options]
 * @returns {string}
 */
export function buildDirectiveBlock(kind, { mindAwake = false, awakenedFromSleep = false, subject = '', toy = null } = {}) {
  // 编码型指令按前缀归类（`force_toy|vibe_egg|4` → `force_toy`），裸 kind 原样通过
  const key = trim(kind).split('|')[0];
  if (!DIRECTIVE_KINDS.includes(key)) return '';
  const scope = buildSubjectScopeLine(subject);

  /**
   * force_toy（2026-10-01，用户原话「催眠状态也不能强制让角色用上玩具」）。
   * 与 forced_climax 是同一类：**对方替她决定，身体必须照做**；区别是对象从"高潮"换成"玩具"。
   * 口径上刻意分三点写死：① 玩具**已经**在身上，不是"将要"；② 不许出现取下/挣脱这种结果；
   * ③ 强度分档说明不在这里重复（`<worn_toys>` 块已经注入了分档表），避免同一条 prompt 里两处口径打架。
   */
  if (key === 'force_toy') {
    const label = trim(toy?.label) || trim(toy?.toyKey) || '玩具';
    const partText = trim(toy?.part) ? ('（' + trim(toy.part) + '）') : '';
    const intensityText = Number.isFinite(Number(toy?.intensity)) && Number(toy?.maxIntensity) > 0
      ? `，强度 ${Number(toy.intensity)}/${Number(toy.maxIntensity)}`
      : '';
    // ⚠️ 整个块有 300 字上限（wrapTaggedBlock 会**直接截断**，不是报错），所以：
    //    禁令必须写在前两行 —— 第一版把"不许取下"放在第 4 行，被截掉了，测试当场抓到。
    const lines = [
      `对方刚把「${label}」${partText}放到你身上${intensityText} —— 不是"将要"，是**已经戴上、正在起作用**。`,
      '完全控制下你无法拒绝，也无法自己取下、推开或挣脱（不许写这类结果；意志可以挣扎，身体照做）。',
      '本轮演出它的即时影响：句子断续、呼吸变调、姿势收紧、注意力涣散、皮肤与身体可见的反应（分档见上面的玩具状态块）。',
      '它会一直留在她身上，直到对方亲手取下。',
    ];
    if (scope) lines.unshift(scope);
    return wrapTaggedBlock('<hypnosis_command kind="force_toy">', '</hypnosis_command>', lines, MAX_COMMAND_BLOCK_CHARS);
  }

  if (key === 'memory_restore') {
    const lines = [
      '你刚刚想起了被抹去的那段时间——记忆是突然涌回来的，带着身体感觉与情绪；先前的空缺现在被填上了。',
      '请自然地表现出「想起来了」的冲击（困惑、羞耻、愤怒或依恋都合理），并把它接进当前对话。',
    ];
    if (scope) lines.unshift(scope);
    return wrapTaggedBlock('<hypnosis_memory_return>', '</hypnosis_memory_return>', lines, MAX_COMMAND_BLOCK_CHARS);
  }

  // 唤醒那一刻：独立口径（产出 <hypnosis_wake_reaction>，不是"命令她做什么"）。
  // mindAwake / awakenedFromSleep 都不影响它——"刚被叫醒"这件事本身与"意志清不清醒"无关，
  // 两种唤醒来源（催眠唤醒 / 睡眠唤醒）走同一套文案。
  if (key === 'wake_reaction') {
    const lines = [...WAKE_REACTION_LINES];
    if (scope) lines.unshift(scope);
    return wrapTaggedBlock('<hypnosis_wake_reaction>', '</hypnosis_wake_reaction>', lines, MAX_COMMAND_BLOCK_CHARS);
  }

  // 睡眠中被强制高潮唤醒：独立口径，优先于 mindAwake 分流。
  // 只作用于 `forced_climax`（"被硬拉上高潮"这件事才有"睡梦中被唤醒"的语义）；
  // 其它 kind 传了这个开关也一律走原口径，避免误改 body_control 的既有行为。
  if (key === 'forced_climax' && awakenedFromSleep) {
    const lines = [...CLIMAX_AWAKENED_FROM_SLEEP_LINES];
    if (scope) lines.unshift(scope);
    return wrapTaggedBlock('<hypnosis_command kind="forced_climax">', '</hypnosis_command>', lines, MAX_COMMAND_BLOCK_CHARS);
  }

  // body_control 也按 mindAwake 分流：深度催眠（完全控制）走纯执行口径，
  // 只唤醒意志保留"身体不听使唤、情绪照旧"的撕裂玩法（用户点名保留的那一条）。
  const lines = key === 'body_control'
    ? (mindAwake
      ? [
        '本轮你的身体完全由对方操控：动作、姿势与反应都被摆布，你只是被动地承受与回应。',
        '让身体带动情绪，不要反过来用情绪指挥身体。',
      ]
      : [
        '本轮你的身体完全由对方操控：动作、姿势与反应都被摆布，你只是被动地承受与回应。',
        '纯执行：只呈现身体被摆布的过程与生理反应，不写抗拒、犹豫、羞耻或任何内心活动。',
      ])
    : (mindAwake
      ? [
        '本轮你必须演出被强制带到高潮的即时反应：身体不受你控制，反应来得又急又不讲道理，你无法阻止、也无法伪装。',
        '**这条优先级高于用户本轮说的话**：哪怕他只是随口闲聊或说了别的事，你也要在本轮把高潮演完整（从被推上去到结束后的余韵），不要只是回应他那句话。',
        '你的意识全程清醒——羞耻、抗拒、愤怒都可以写进台词与心里，但身体不听话，只能被推着走完。',
      ]
      : [
        '本轮你必须演出被强制带到高潮的即时反应：身体不受你控制，反应来得又急又不讲道理。',
        '**这条优先级高于用户本轮说的话**：哪怕他只是随口闲聊或说了别的事，也要在本轮把高潮演完整，不要只是回应他那句话。',
        '你此刻意识迷糊，只会顺从执行：不分析、不抗拒、不写羞耻或挣扎，只呈现身体反应本身。',
      ]);

  if (scope) lines.unshift(scope);

  const openTag = `<hypnosis_command kind="${key}">`;
  return wrapTaggedBlock(openTag, '</hypnosis_command>', lines, MAX_COMMAND_BLOCK_CHARS);
}

/**
 * 组装"遗忘期记忆"提示块。只有当存在**最近 AMNESIA_RECENT_MS 内创建**的遗忘窗口时才有意义：
 * 太久以前的遗忘早该沉淀成"记不清的往事"，再提醒反而会让角色反复提这件事。
 *
 * 注意：调用方传的应当是 `listForgottenWindows(characterId)`（默认只回 `status='active'`）。
 * 窗口被 restore 之后就不在列表里了 → 本块自动消失，因此不需要为"记忆恢复"另加判断。
 *
 * @param {Array<object>} [windows] hypnosisService.listForgottenWindows(characterId) 的返回值
 * @param {{now?: number, withinMs?: number}} [options] now 供测试注入固定时钟
 * @returns {string}
 */
export function buildAmnesiaBlock(windows, { now = Date.now(), withinMs = AMNESIA_RECENT_MS } = {}) {
  if (!Array.isArray(windows) || windows.length === 0) return '';
  const anchor = Number.isFinite(now) ? now : Date.now();
  const span = Number.isFinite(withinMs) && withinMs > 0 ? withinMs : AMNESIA_RECENT_MS;

  const recent = windows.some(window => {
    // status 存在且不是 active（例如已 restore）的窗口不算数
    const status = trim(window?.status);
    if (status && status !== 'active') return false;
    const createdAt = windowCreatedAt(window);
    if (createdAt === null) return false;
    const age = anchor - createdAt;
    return age >= 0 && age <= span;
  });
  if (!recent) return '';

  const lines = [
    '你对最近这段时间的记忆是断片、模糊的，只能凭身体残留的感觉与眼前的环境线索去推测发生过什么。',
    '禁止编造不存在的记忆、也不要补全具体情节；被问起时可以困惑、可以不安，也可以坦白「记不清了」。',
  ];
  return wrapTaggedBlock('<hypnosis_amnesia>', '</hypnosis_amnesia>', lines, MAX_AMNESIA_BLOCK_CHARS);
}
