/**
 * 性爱交互「可点击推进」服务层（task-1 / 2026-10-01）
 *
 * 用户原话：「加入在性爱的时候可以点击的交互姿势 比如插入后继续抽插 换姿势 加速抽插 之类的
 *            交互玩法 而且还得让角色有反馈」
 *
 * 本模块负责三件事，全部**复用既有亲密系统的口径**，不另造平行体系：
 *   ① 进行中状态机（纯函数）：当前体位 / 是否插入中 / 节奏档 / 累积度 + 上下限与拒绝理由；
 *   ② 落库（`character_intimate_scene`，每角色一行）：重启后仍在进行中；空闲超时自动收场；
 *   ③ prompt 块（`<intimate_scene>` + 即时反应 JSON 示例）：把「当前体位 / 节奏 / 累积」喂进 LLM，
 *      保证她不会前后矛盾（明明在插入中却说「我们开始吧」）。
 *
 * 复用清单（一个一个都对得上，别再造第二套）：
 *   · 体位 key = `image_prompt_knowledge.adult_pose_vocabulary` 的打包 key（与生图 prompt 同源），
 *     中文名走 `intimateService.positionLabel`，解析走 `resolvePositionKey`；
 *   · 行为归类走 `intimateService.classifyPromptTags`（ACT_DEFINITIONS 冻结词表），
 *     记账走 `intimateService.recordIntimateActs`（由路由调用，source='manual' 同触摸动作待遇）；
 *   · 体感/情绪走 `emotionEngine`（loadEmotionState / evolveEmotion / saveEmotionSnapshot /
 *     affinityToPrompt），与 `routes/touch.js` 的即时反应同一条心情链路；
 *   · 消息落库走 `proactiveChatScheduler.writeProactiveMessage` + `notificationBus.broadcastProactiveMessage`
 *     （与触摸反应同一条「她的一句话进消息流」链路，前端零改动即可上屏）；
 *   · 输出解析复刻 `touchActionService.parseReactionOutput` 的 JSON 形状（reaction_text /
 *     image_prompt / emotion_delta / facial_expression / annoyed），下游心情与立绘吃同一套字段。
 *
 * 分层：本文件上半部分是**零 DB 依赖的纯函数**（状态机 / 档位 / prompt），下半部分是落库读写
 * （与 intimateService.js 同款做法：服务层持有表，路由只做 HTTP）。
 *
 * 边界：本模块只服务成年角色；不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { getDb } from '../db/index.js';
import {
  ACT_KEYS,
  classifyPromptTags,
  getPositionVocabularyMap,
  positionLabel,
  resolvePositionKey,
} from './intimateService.js';
// 时间串一律按 UTC 解析（后端时间串是无时区 UTC，见 目标/编程模式-DeepSeek.md §5.2）
import { parseSqlUtc } from './programTime.js';
import { buildImagePromptRuleBlock } from '../builtinRules.js';
// 敏感度分档表（climaxStrength 要把"她的倍率"落回档位）—— sensitivityService 只依赖 db，不成环。
import { SENSITIVITY_TIERS } from './sensitivityService.js';

// ── 一、常量（档位 / 阈值 / 词表）────────────────────────────────────────────

/** prompt 块标签（与 `<intimate_profile>` / `<touch_action>` 同风格） */
export const INTIMATE_SCENE_TAG = 'intimate_scene';

/** 节奏档：1 缓 / 2 正常 / 3 快 / 4 冲刺。**4 是上限**（用户要求「档位有上限」） */
export const PACE_LEVELS = Object.freeze([
  { value: 1, key: 'slow', label: '缓' },
  { value: 2, key: 'normal', label: '正常' },
  { value: 3, key: 'fast', label: '快' },
  { value: 4, key: 'sprint', label: '冲刺' },
]);

export const PACE_MIN = 1;
export const PACE_MAX = 4;
export const DEFAULT_PACE = 2;

/** 累积度 0~100：>=EDGE 高潮边缘，>=OVERLOAD 绷不住，到顶自动失控一次（然后清零重新累积） */
export const MAX_ACCUMULATION = 100;
export const EDGE_THRESHOLD = 60;
export const OVERLOAD_THRESHOLD = 85;
/** 「一起到」这个动作的门槛：没到边缘点不动（拒绝理由是人类话，前端直接 toast） */
export const CLIMAX_MIN_ACCUMULATION = 60;

/**
 * 「他拔出去了 ⇒ 她求着继续」的累积门槛（2026-10-04 用户：「如果在性爱的时候 突然拔或者停止出来
 * 角色会自动去求着继续」）。
 *
 * ⚠️ **刻意低于 `EDGE_THRESHOLD`（60）**，理由是硬的：`stop` 这个动作自己就会把累积 **-5**
 * （"退出来，让两个人都喘口气"）。所以一个**刚好在边缘**的人被拔出去之后，落到的就是 55 ——
 * 要是拿 60 当门槛，这条功能对她**永远不会触发**，等于白做。
 *
 * 50 这个位置的两侧语义都对：
 *   · 下面：`accumulationTier` 里"刚开个头"那一档（<30）离它很远 ⇒ 不会一上来就求人；
 *   · 上面：越过一半、她已经在追了 ⇒ 求一句完全成立。
 *
 * 用它（而不是就地写 50 或复用 EDGE_THRESHOLD）的是 prompt 拼装的两处：
 * `buildIntimateActionPrompt`（当场那一条反应）与 `buildIntimateSceneBlock`（之后的轮次）。
 * 两处**必须同源**，否则会出现"当场求了、下一轮又不认"的割裂。
 */
export const PULL_OUT_BEG_ACCUMULATION = 50;

// ── 敏感度 → 高潮的「强度」与「频率」（2026-10-02 用户原话：
//    「敏感度越高角色高潮的强度越高 也越频繁 性爱的频率也会越频繁」）──────────────
//
// 三个纯函数，各自负责一半的语义：
//   · climaxThreshold   门槛：很敏感 / 极度敏感的她**更早点得动「一起到」**（频率的一半）
//   · climaxResidual    高潮后不回 0：越敏感起点越高，下一轮更快到（频率的另一半）
//   · climaxStrength    强度 1~5：喂 prompt 的演出要求 + 她这一下涨多少敏感度（强度那一半）
// 余韵的加成幅度也随她浮动（afterglowMultiplier）—— 冷淡的她"没那么多余韵"，极度敏感的她"碰一下都受不了"。
//
// ⚠️ 门槛**只降不升**：基准 60 是普通档的体感，冷淡（×0.75）靠"增益更小"体现差别就够了；
//    把门槛抬到 70+ 会让新角色的第一次变得很磨人（而新角色默认就是冷淡档）。

/** 极度敏感档门槛的绝对下限（60 → 45，约"刚过边缘就能点"） */
export const CLIMAX_THRESHOLD_MIN = 45;

/** 敏感度倍率（她自己的，不是固定值）夹进这个区间 —— 与 sensitivityService 的分档表同域 */
function sensMul(sensitivity) {
  return Math.max(0.5, Math.min(1.5, Number(sensitivity) || 1));
}

export function climaxThreshold(sensitivity = 1) {
  const m = sensMul(sensitivity);
  const drop = Math.max(0, m - 1) / 0.35 * (CLIMAX_MIN_ACCUMULATION - CLIMAX_THRESHOLD_MIN);
  return clampInt(Math.round(CLIMAX_MIN_ACCUMULATION - drop), CLIMAX_THRESHOLD_MIN, CLIMAX_MIN_ACCUMULATION, CLIMAX_MIN_ACCUMULATION);
}

/** 高潮之后累积的起点（0~16）：越敏感的她越快重新爬上去 ⇒ 高潮更频繁 */
export function climaxResidual(sensitivity = 1) {
  const m = sensMul(sensitivity);
  return clampInt(Math.round(Math.max(0, m - 1) * 40), 0, 16, 0);
}

/** 强度 1~5（冷淡 1 · 普通 2 · 敏感 3 · 很敏感 4 · 极度敏感 5）：与面板上显示的档位一一对应 */
export function climaxStrength(sensitivity = 1) {
  const m = sensMul(sensitivity);
  const tiers = SENSITIVITY_TIERS.map(t => t.multiplier);   // [0.75, 0.9, 1, 1.15, 1.35]
  let best = 2;   // 兜底：敏感档
  let gap = Infinity;
  tiers.forEach((v, i) => { const d = Math.abs(v - m); if (d < gap) { gap = d; best = i; } });
  return best + 1;
}

/** 余韵里被再推一下的加成年：冷淡 ~1.05 · 敏感 1.4（原口径）· 极度敏感 ~1.9 */
export function afterglowMultiplier(sensitivity = 1) {
  const scaled = AFTERGLOW_SENSITIVITY * sensMul(sensitivity);
  return Math.max(1.05, Math.min(2, Math.round(scaled * 100) / 100));
}

// ── 2026-10-02 新玩法四件（用户原话：「拍打的玩法是和性爱在一起的 是一种玩法 再加上一个捆绑类吧…
//    和拍屁股一起 会累积快感高潮那种」「插入之后可以选一个自动继续插入 然后我可以继续去抚摸或者拍屁股
//    捏其他地方或者插入玩具之类的」「催眠手机里加一个禁止高潮 高潮值就可以一直累加 直到手动解锁后瞬间释放」）──

/** 捆绑状态下累积涨得更快：她动不了、只能承受，节奏不在她手里 */
export const BONDAGE_SENSITIVITY = 1.25;
/**
 * 拍打（性爱里的一记）加多少累积 —— 痛感与羞耻是把它往回推的力，不是终点。
 * 2026-10-02 从 9 降到 6：整体节奏重定后，一记拍打的份量应当约等于一下普通推进。
 */
export const SPANK_GAIN = 6;
/** 「禁止高潮」时累积的上限（可以一路涨过 100，但总得有个头，免得状态无限膨胀） */
export const DENIAL_MAX_ACCUMULATION = 200;
/** 解锁时至少要憋到多少才算"瞬间释放"（低于它只是回到普通推进，不硬造一场高潮） */
export const DENIAL_RELEASE_MIN = 100;
/** 「自动插入」每次 tick 之间最少间隔（毫秒）—— 前端按它轮询，服务端也按它防抖 */
export const AUTO_THRUST_TICK_MS = 3000;
/**
 * 一次补算最多算几个 tick：她自己在动，也不能"挂机半小时回来直接满格"。
 * 5 个 tick ≈ 15 秒的推进量，够覆盖"用户切去摸她 / 戴玩具时的那几秒"。
 */
export const AUTO_MAX_CATCHUP_TICKS = 2;
/** 自动插入每个 tick 推进多少（比手点一下轻：**他**按固定节奏自动插送，频率由自动速度决定，所以每一下不必那么重） */
/**
 * 「自动插入」每个 tick 涨多少（2026-10-02 重定：原来 `3 + pace×2` ⇒ 正常档 7，
 * 叠上最多 5 个补算 tick 后**一下能涨 42** —— 用户看到的就是"太快了 + 老归零"）。
 * 现在：缓 2 / 正常 3 / 快 4 / 冲刺 5 —— 正常档约 1 秒 1 点，一场下来十几二十秒一个阶段。
 */
export const autoTickGain = (pace) => 1 + Math.max(PACE_MIN, Math.min(PACE_MAX, Number(pace) || DEFAULT_PACE));

/**
 * **自动速度**每一档对应多少毫秒推一下（2026-10-03 用户：「自动的速度新增一个单独的」）。
 *
 * 口径收口在这里（表格只此一份）：缓 5.0s · 正常 3.0s（= 旧口径）· 快 2.0s · 冲刺 1.5s。
 * `intimateAutoThrust.intervalForPace` 是它的旧名（保留导出，别再各写一份表）。
 */
export const AUTO_PACE_INTERVALS = Object.freeze([0, 5000, 3000, 2000, 1500]);
export function intervalForAutoPace(pace) {
  const p = Math.max(PACE_MIN, Math.min(PACE_MAX, Number(pace) || DEFAULT_PACE));
  return AUTO_PACE_INTERVALS[p];
}

/**
 * 状态里的时间（ISO 或 SQL 形态）→ 毫秒；解析不出来给 0（调用方按"没有起点"处理）。
 * 自动抽插的补算要用它，纯函数不许碰 Date。
 */
export function parseStateTime(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const s = String(value).trim();
  if (!s) return 0;
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 好感低于这个值、且还没被推进到边缘时，换姿势会被她按住手（配合/抗拒取决于好感与当时状态） */
export const REFUSE_AFFINITY = 20;

/** 进行中状态的默认体位：面板一打开「进入她」就能点（不用先选体位） */
export const DEFAULT_POSITION_KEY = 'missionary';

/** 插入类行为（只有这两类才算「插入中」；口交 / 手交 / 乳交 / 足交 都不算） */
export const PENETRATIVE_ACTS = Object.freeze(['vaginal', 'anal']);

/**
 * 空闲超时：最后一次推进超过 45 分钟即视为这一场已经结束（active=0、累积清零）。
 * 为什么需要：状态是**持久化**的（重启后仍在进行中），没有超时的话第二天打开还会「插着」，
 * 那就是前后矛盾。45 分钟足够覆盖长场景，也短于一次日程切换。
 */
export const SCENE_IDLE_TTL_MS = 45 * 60 * 1000;

/**
 * 面板体位清单（打包 key，全部实测存在于 adult_pose_vocabulary；测试会断言它们真的在里面）。
 * 顺序 = 面板展示顺序：先插入类常规位，再非插入类（口/手/乳/舔），最后后庭。
 * 为什么是精选而不是 657 条全量：全量里大量长串与噪声包（`hda ...`、`pov ...`），
 * 前端下拉没法用；要自定义体位的调用方仍可传任意**词表里合法**的 key（路由不限于这份清单）。
 */
export const PREFERRED_POSITION_KEYS = Object.freeze([
  'missionary',                                            // 传教士体位
  'doggystyle',                                            // 狗爬式
  'cowgirl position',                                      // 女上正骑
  'reverse cowgirl',                                       // 女上反骑
  'mating press, sex, penis, vaginal, testicles, ass, on back', // 交配压体位
  'prone bone, sex from behind',                           // 俯卧后入
  'arms grab, sex from behind',                            // 抱腰后入
  'standing sex, doggystyle',                              // 站姿后入
  'leg lock/upright straddle',                             // 跨坐式
  'kneeling, blowjob',                                     // 跪姿口交
  'deepthroat',                                            // 深喉
  'cunnilingus',                                           // 舔阴
  'paizuri',                                               // 乳交
  'handjob',                                               // 手交
  '69',                                                    // 69 式
  'anal insertion',                                        // 肛内插入
  'anal doggy, anus gape',                                 // 后入肛交
]);

/**
 * 体位 → 「算不算插进去」的兜底关键词。
 *
 * 为什么需要：`classifyPromptTags` 只认 ACT_DEFINITIONS 的 tag，像 `leg lock/upright straddle`
 * （跨坐式）、`standing sex, doggystyle`（站姿后入）这类打包 key 归类不到任何 act，
 * 直接按「未归类」处理会把明明是插入的体位判成非插入，门控就错了。
 * 口径与 intimateService 的取向一致：宁可少归因（这里是「宁可多认几个插入 hint」，
 * 因为插不插是**玩法门控**，判错会让用户点不动），所以 hint 只列明确的性交/插入词。
 */
const PENETRATIVE_POSITION_HINTS = Object.freeze([
  'vaginal', 'anal', 'sex from behind', 'penetration', 'insertion', 'doggystyle',
  'missionary', 'cowgirl', 'mating press', 'straddle', 'prone bone', 'piledriver',
  'standing sex', 'full nelson', 'spitroast',
]);

/**
 * 每个体位的**生理与心理细节**提示（喂给 LLM，用户要求「符合当前体位的生理与心理细节」）。
 * 只覆盖面板精选体位；其它合法 key 走通用兜底句，不硬编。
 */
export const POSITION_PHYSICAL_HINTS = Object.freeze({
  'missionary': '仰躺在下面被整个压住，腿被架开或抱住，插进去的每一下都能看到他的脸和表情；腰被撞得往上滑，只能抓着他的背或床单。',
  'doggystyle': '四肢撑着趴跪，腰被从后面掐住，插进去的角度朝上顶着里面；看不到他的表情，只能听到他的呼吸和拍在臀上的声音，回头也只看得到半张脸。',
  'cowgirl position': '她跨坐在上面自己控制起落，插进去的深浅由她决定；膝盖夹着他的腰，低头能看到两个人连接的地方，主导权在她手上。',
  'reverse cowgirl': '背对着他跨坐，他看得到她的背和臀，她看不到他的脸；每一次坐下都顶得更深，重心不稳时要撑着床才不至于塌下去。',
  'mating press, sex, penis, vaginal, testicles, ass, on back': '整个人被折起来压在下面，双腿被按到胸前、膝盖几乎碰到肩膀，插得又深又直；她动弹不得，只能承受每一下到底的顶弄。',
  'prone bone, sex from behind': '整个人被压趴在床上，脸埋在枕头或床单里，他从背后覆上来贴着插进去；腿被并着，进出的摩擦更紧，她想抬腰都抬不起来。',
  'arms grab, sex from behind': '被从背后捞着腰抱进怀里，上半身向后仰靠在他胸口，一边被顶一边听见他在耳边喘；她想挣也挣不开那双手。',
  'standing sex, doggystyle': '站着被从背后按住，上半身撑在墙上或家具上，脚尖踮着才能配合高度；腿在抖，重心全靠他扶着的腰。',
  'leg lock/upright straddle': '面对面跨坐在他身上、腿锁在他腰后，靠体重把自己压下去；这个姿势进得最深，她稍微一动就会顶到底。',
  'kneeling, blowjob': '跪在他面前用嘴含住，一手扶着根部、一手撑着他的腿；抬头能看到他的表情，喉咙被顶到时只能发出含混的声音。',
  'deepthroat': '跪着把整根都吞进去，鼻尖抵着他的小腹，喉咙被撑开的异物感让她眼角泛泪、呼吸只能靠鼻子。',
  'cunnilingus': '腿被分开架在他肩上，他用舌头舔弄；她仰躺着看不见他在做什么，只能感觉热气和湿意，腰会不受控地往上抬。',
  'paizuri': '用胸夹住那根上下磨蹭，乳肉被挤得变形，龟头顶到下巴；她低头看着它从胸口冒出来，脸上烧得厉害。',
  'handjob': '用手握住上下套弄，拇指蹭过顶端；她能清楚感觉到它在手里跳，也能看到他隐忍的表情。',
  '69': '两个人叠着互相舔弄，她压在上面被他的舌头弄得分神，嘴里还含着东西，喘不上气也不敢停。',
  'anal insertion': '后庭被慢慢撑开、一寸寸吞进去，胀满感和阴道里完全不同；她需要刻意放松才能容下，进出的每一下都又紧又涩。',
  'anal doggy, anus gape': '趴跪着从后面进后庭，腰被按住不让躲，撑开的胀感一路顶到小腹；她想夹紧却夹不住，只能把脸埋进枕头里。',
});

/** 通用兜底：没写专属 hint 的体位也要有「符合体位」的写作要求 */
export const GENERIC_PHYSICAL_HINT = '按这个姿势本身的身体结构写：他插入的角度、她受力的部位、两人之间的视线关系（看得见 / 看不见他的脸）、以及这个姿势让她更难还是更容易承受。';

// ── 二、动作定义（用户要求的四类 + 进入 / 一起到）─────────────────────────────

/**
 * 可点击动作清单（前端动作按钮直接渲染这份；顺序即面板顺序）。
 *
 * ① thrust  继续抽插   ② faster 加速抽插   ③ position 换姿势（选目标体位）
 * ④ slower  慢下来 / stop 拔出          （另加 enter 进入她 / climax 一起到，构成推进闭环）
 *
 * ⚠️ `stop` 的 label 是「**拔出**」（2026-10-04 用户：「面板里的那个停止就换成拔出吧 比较直观」，
 *    原 label 是「停下」）。**只改文案，行为一字未动** —— 仍然是 `penetrating:false` +
 *    自动插入一起停 + 累积 -5，且**不收场**（`active` 保持 true）。
 *    前端镜像在 `web-ui/src/components/intimateActionLogic.js`，两处必须同步改。
 */
export const INTIMATE_ACTIONS = Object.freeze([
  { key: 'enter', label: '进入她', hint: '插进去，正式开始这一轮' },
  { key: 'thrust', label: '继续抽插', hint: '保持现在的节奏往里推' },
  { key: 'faster', label: '加速抽插', hint: '节奏升一档（最高「冲刺」）', tone: 'primary' },
  { key: 'slower', label: '慢下来', hint: '节奏降一档，把她的感觉吊住' },
  { key: 'stop', label: '拔出', hint: '整根退出来，让两个人都喘口气' },
  { key: 'position', label: '换姿势', hint: '点下面的体位让她换过去' },
  { key: 'climax', label: '一起到', hint: '在高潮边缘直接把她推过去', tone: 'danger' },
  // ── 2026-10-02 四件新玩法（用户：拍打/捆绑「是一种玩法…会累积快感高潮那种」、
  //    「插入之后可以选一个自动继续插入 然后我可以继续去抚摸或者拍屁股捏其他地方或者插入玩具」、
  //    「禁止高潮…高潮值就可以一直累加 直到手动解锁后瞬间释放」）──
  { key: 'command', label: '命令她自己动', hint: '不许他动手，全要你自己来 —— 被束着时她只能照做（SM 服从玩法）' },
  { key: 'spank', label: '拍打', hint: '一记落在臀上：痛感与羞耻也在把她往高潮推' },
  { key: 'bondage', label: '捆手', hint: '把她的手腕束起来（再点一次解开）：她推不开你，累积涨得更快' },
  // ── 2026-10-02 分型捆绑（用户原话：「捆绑的玩法太单调 不只是捆上手 还有龟甲缚 脚 身体 口球
  //    而且换姿势是我控制角色 捆绑后不需要角色自己去换姿势」）──
  //   实现：`bondage` 从 0/1 升级成**位掩码**（见 BONDAGE_BITS）⇒ 可任意叠加、零 schema 改动；
  //   老数据里的 1 仍然等于"捆了手腕"。每多绑一处，累积倍率再 +25%（封顶 2×）。
  { key: 'bind_box', label: '龟甲缚', hint: '绳从颈后绕到胸前再收去胯下（再点一次解开）：整条躯干被固定，她只能挺着受' },
  { key: 'bind_legs', label: '束脚', hint: '脚踝并拢束住、腿分不开（再点一次解开）：角度全由你摆' },
  { key: 'bind_body', label: '全身束', hint: '手腕、脚踝与躯干一起固定（再点一次解开）：她几乎完全动不了' },
  { key: 'bind_gag', label: '口球', hint: '嘴里被塞住（再点一次取下）：她只能发出含混的声音，说不成完整句子' },
  { key: 'auto', label: '自动插入', hint: '他自己按「自动速度」一下一下插送（再点一次停下）：你可以腾出手去做别的' },
  { key: 'denial', label: '禁止高潮', hint: '不许她到（再点一次解开）：憋着能涨过满格，解开那一瞬间才是释放', tone: 'danger' },
]);

export const INTIMATE_ACTION_KEYS = Object.freeze(INTIMATE_ACTIONS.map(a => a.key));

/**
 * 分型捆绑的位掩码（2026-10-02）。`bondage` 字段从"0/1 开关"升级成"哪几处被绑住"：
 *   bondage(1)=手腕 · bind_box(2)=龟甲缚 · bind_legs(4)=脚踝 · bind_body(8)=全身 · bind_gag(16)=口球
 * 用位掩码而不是新表/新列：**零 schema 改动**、可任意叠加、老数据（1）自动等于"捆了手腕"。
 */
export const BONDAGE_BITS = Object.freeze({
  bondage: 1, bind_box: 2, bind_legs: 4, bind_body: 8, bind_gag: 16,
});

/** 位 → 人话（提示词与面板共用一份，别在两处各写一套） */
export const BONDAGE_LABELS = Object.freeze({
  bondage: '手腕', bind_box: '龟甲缚', bind_legs: '脚踝', bind_body: '全身', bind_gag: '口球',
});

/** 当前绑了哪几处（给快照 / 提示词 / 面板用） */
export function listBonds(bondage) {
  const mask = Number(bondage) || 0;
  return Object.keys(BONDAGE_BITS).filter(k => (mask & BONDAGE_BITS[k]) !== 0);
}

/**
 * 绑得越多越敏感：每多绑一处 +25%，封顶 2×（她动不了、只能承受，节奏完全不在她手里）。
 * 取代原来"唯一开关 ×1.25"的口径 —— 老数据（只捆手腕）仍是 1.25，行为不变。
 */
export function bondageMultiplier(bondage) {
  const n = listBonds(bondage).length;
  return Math.min(2, 1 + 0.25 * n);
}

/** 拒绝码（前端可直接 switch；`message` 一律是人话，与触摸门控 200 + allowed:false 同口径） */
export const INTIMATE_REJECT_CODES = Object.freeze([
  'unknown_action',          // 动作不存在（路由层 400）
  'invalid_position',        // 体位不在词表里（路由层 400）
  'not_penetrating',         // 还没插进去就点「继续抽插 / 加速 / 慢下来 / 一起到」
  'already_penetrating',     // 已经在里面了还点「进入她」
  'position_not_penetrative', // 当前体位插不进去（口交 / 手交 / 乳交 / 69）
  'pace_max',                // 已经是「冲刺」，没有更快的档
  'pace_min',                // 已经是最慢档
  'not_edge',                // 还没到高潮边缘，「一起到」点不动
  'not_active',              // 这一场还没开始
  'she_refuses',             // 好感太低，她按住手不让换
]);

export function getIntimateAction(actionKey) {
  const key = String(actionKey || '').trim();
  return INTIMATE_ACTIONS.find(a => a.key === key) || null;
}

export function listIntimateActions() {
  return INTIMATE_ACTIONS.map(a => ({ ...a }));
}

// ── 三、状态归一（纯函数）────────────────────────────────────────────────────

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (value, max = 0) => {
  const s = String(value ?? '').trim();
  return max > 0 ? s.slice(0, max) : s;
};

/** 空闲未开始的状态（没有行 / 已经收场都是这个形状） */
export function emptySceneState(characterId = 0) {
  return {
    characterId: Number(characterId) || 0,
    active: false,
    penetrating: false,
    positionKey: DEFAULT_POSITION_KEY,
    actKey: 'vaginal',
    pace: DEFAULT_PACE,
    accumulation: 0,
    climaxCount: 0,
    rounds: 0,
    actionSeq: 0,
    // 2026-10-02 新玩法四件的开关态（0/1；都能重启后继续，所以落库）：
    //   · bondage     —— 被绑着（动不了，累积涨得更快，换姿势先得解开）
    //   · autoThrust  —— 自动插入（**他自己**按「自动速度」一下一下插送，用户可以去摸/拍/戴玩具做别的事）
    //   · denial      —— 禁止高潮（累积可以一路涨过 100，手动解开才瞬间释放）
    bondage: 0,
    autoThrust: 0,
    // 2026-10-03 用户：「自动的速度新增一个单独的」——**自动速度是独立的旋钮**：
    // 手动节奏档（pace）管"他手点的时候顶得多快、一下涨多少"，autoPace 只管"他自动插送的频率与每下涨多少"，
    // 两者互不覆盖（以前自动轮直接借用 pace，想把自动插送调快就只能连手动节奏一起改）。
    autoPace: DEFAULT_PACE,
    denial: 0,
    pendingNote: '',
    startedAt: null,
    lastActionAt: null,
    updatedAt: null,
    // 只读派生：上游（路由）填，纯状态机不查库
    idleMs: null,
  };
}

/**
 * DB 行 / 任意对象 → 规范化状态。空行给空状态；数字列一律夹取到合法区间。
 * @param {object|null} row
 * @param {number} [characterId] 行里没有 character_id（纯函数测试）时用这个补
 */
export function normalizeSceneState(row, characterId = 0) {
  if (!row || typeof row !== 'object') return emptySceneState(characterId);
  const id = Number(row.characterId ?? row.character_id ?? characterId) || 0;
  const active = row.active === true || Number(row.active) === 1;
  const penetrating = active && (row.penetrating === true || Number(row.penetrating) === 1);
  const positionKey = str(row.positionKey ?? row.position_key, 120) || DEFAULT_POSITION_KEY;
  const actKey = str(row.actKey ?? row.act_key, 48) || 'vaginal';
  return {
    characterId: id,
    active,
    penetrating,
    positionKey,
    actKey,
    pace: clampInt(row.pace, PACE_MIN, PACE_MAX, DEFAULT_PACE),
    // 自动速度（独立旋钮，2026-10-03）：老行没有这一列 ⇒ 回落"正常"（与旧行为一致）
    autoPace: clampInt(row.autoPace ?? row.auto_pace, PACE_MIN, PACE_MAX, DEFAULT_PACE),
    accumulation: clampInt(row.accumulation, 0, DENIAL_MAX_ACCUMULATION, 0),
    climaxCount: clampInt(row.climaxCount ?? row.climax_count, 0, 9999, 0),
    // 三个开关态一律夹成 0/1（脏数据不许带进状态机）
    // bondage 是**分型捆绑的位掩码**（1 手腕 / 2 龟甲缚 / 4 脚踝 / 8 全身 / 16 口球，可叠加）⇒ 上限 31。
    // ⚠️ 别再夹回 0..1：那会把"龟甲缚+口球"这类组合压成"只捆了手腕"（2026-10-02 分型捆绑）。
    bondage: clampInt(row.bondage, 0, 31, 0),
    autoThrust: clampInt(row.autoThrust ?? row.auto_thrust, 0, 1, 0),
    denial: clampInt(row.denial, 0, 1, 0),
    rounds: clampInt(row.rounds, 0, 999999, 0),
    actionSeq: clampInt(row.actionSeq ?? row.action_seq, 0, Number.MAX_SAFE_INTEGER, 0),
    pendingNote: str(row.pendingNote ?? row.pending_note, 200),
    startedAt: row.startedAt ?? row.started_at ?? null,
    lastActionAt: row.lastActionAt ?? row.last_action_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    idleMs: row.idleMs ?? null,
  };
}

/** 节奏档中文名（非法值回落「正常」） */
export function paceLabelOf(pace) {
  const level = clampInt(pace, PACE_MIN, PACE_MAX, DEFAULT_PACE);
  return PACE_LEVELS.find(p => p.value === level)?.label || '正常';
}

export function isPenetrativeAct(actKey) {
  return PENETRATIVE_ACTS.includes(str(actKey, 48));
}

/**
 * 累积度档位（prompt 文案与前端提示共用同一份口径）。
 *   calm     0~29   还稳得住
 *   rising   30~59  呼吸乱了
 *   edge     60~84  高潮边缘
 *   overload 85~100 绷不住，随时失控
 */
export function accumulationTier(accumulation) {
  const value = clampInt(accumulation, 0, DENIAL_MAX_ACCUMULATION, 0);
  if (value >= OVERLOAD_THRESHOLD) {
    return {
      key: 'overload', label: '绷不住', value,
      prompt: '她几乎绷不住了：只能吐出破碎的音节或单字，全身在发抖，再往里推一下就会直接失控高潮；不要让她说完整的句子。',
    };
  }
  if (value >= EDGE_THRESHOLD) {
    return {
      key: 'edge', label: '高潮边缘', value,
      prompt: '她已经在高潮边缘：里面绞得很紧、腿根在抖，话说一半就散；她可能求他别停，也可能求他等一下，但身体是迎上去的，不要写成「刚进入状态」。',
    };
  }
  if (value >= 30) {
    return {
      key: 'rising', label: '渐入', value,
      prompt: '她的呼吸已经乱了：句子开始断，会抓紧东西、会嫌他太快又会自己迎上去；还留得住一点嘴硬和调侃。',
    };
  }
  return {
    key: 'calm', label: '还稳得住', value,
    prompt: '她还稳得住：能说完整的句子，会嘴硬、会催、会拿话刺他；身体已经开始有反应但还控制得住。',
  };
}

// ── 四、体位解析（复用冻结词表；词表里没有的一律不认）──────────────────────────

/**
 * 体位打包 key → 行为 act_key（复用 `classifyPromptTags` 的冻结归类；归类不到时按 hint 兜底）。
 * @returns {string} ACT_KEYS 里的键（'unspecified' 表示非插入类）
 */
export function actKeyForPosition(positionKey) {
  const key = str(positionKey, 120).toLowerCase();
  if (!key) return '';
  const classified = classifyPromptTags([key]);
  const hit = classified.find(item => ACT_KEYS.has(item.actKey) && item.actKey !== 'climax')?.actKey || '';
  if (hit) return hit;
  const lower = key.toLowerCase();
  const penetrative = PENETRATIVE_POSITION_HINTS.some(hint => lower.includes(hint));
  return penetrative ? 'vaginal' : 'unspecified';
}

/**
 * 解析目标体位：必须是词表里合法的一条（`resolvePositionKey` 命中真实打包 key）。
 * @returns {{key:string, label:string, actKey:string, penetrative:boolean}|null}
 */
export function resolveTargetPosition(positionKey) {
  const key = resolvePositionKey(positionKey);
  if (!key) return null;
  const actKey = actKeyForPosition(key);
  return {
    key,
    label: positionLabel(key) || key,
    actKey,
    penetrative: isPenetrativeAct(actKey),
  };
}

/** 当前体位的展示信息（状态里存的 key 已合法；词表变动时回落 key 本身，不做二次猜测） */
export function describePosition(positionKey) {
  const key = str(positionKey, 120) || DEFAULT_POSITION_KEY;
  const actKey = actKeyForPosition(key);
  return {
    key,
    label: positionLabel(key) || key,
    actKey,
    penetrative: isPenetrativeAct(actKey),
  };
}

/** 面板体位清单：精选 key ∩ 当前词表（词表里没有的直接不出现，前端就不会给一个点不动的按钮） */
export function listPositionOptions() {
  let map = null;
  try {
    map = getPositionVocabularyMap();
  } catch {
    map = null;
  }
  if (!map || typeof map.has !== 'function') return [];
  const out = [];
  for (const key of PREFERRED_POSITION_KEYS) {
    if (!map.has(key)) continue;
    out.push(describePosition(key));
  }
  return out;
}

// ── 五、状态机（纯函数：给状态 + 动作，出下一个状态 / 拒绝理由）────────────────

/**
 * 这一下「做了什么」的中文短句（喂 prompt + LLM 失败时的补演备注）。
 * 只描述动作与状态变化，不写她的反应（反应由模型写）。
 */
export function describeActionBeat({ actionKey, state, next, target = null, autoRun = false }) {
  const pace = paceLabelOf(next?.pace ?? state?.pace);
  const where = target ? `「${target.label}」` : `「${describePosition(state?.positionKey).label}」`;
  // 自动轮（ticker 发来的那一下）：**他在自动插送**（不是她自己在动 ——
  // 用户 2026-10-03 澄清：「自动的意思是自动插入 不是自己动」）。说反了模型会写出矛盾的反应。
  if (autoRun && actionKey === 'thrust') {
    const autoPace = paceLabelOf(next?.autoPace ?? state?.autoPace);
    return `他没有停手，按着自动的节奏一下一下往里顶（自动「${autoPace}」）—— 不是你在动，全是他自己在里面。`;
  }
  switch (actionKey) {
    case 'enter':
      return `他把你摆成${where}，扶着一点点插了进来，从现在起是真的在里面了（节奏「${pace}」）。`;
    case 'thrust':
      return `他保持「${pace}」的节奏继续往里顶，一下比一下实在。`;
    case 'faster':
      return `他把节奏提到「${pace}」，抽送明显变快变急。`;
    case 'slower':
      return `他把速度压回「${pace}」，退到只留一点在里面的位置慢慢磨。`;
    case 'stop':
      return '他退了出来，把你松开一点，两个人都喘着气。';
    case 'position': {
      const swap = target && target.key !== state?.positionKey
        ? `从「${describePosition(state?.positionKey).label}」换成「${target.label}」`
        : `维持在${where}`;
      // 换到**非插入体位**（口 / 手 / 乳）时他得先退出来，不可能还"在里面"
      if (state?.penetrating && target?.penetrative) return `他先退出来，把你${swap}，重新插了回去。`;
      if (state?.penetrating && target && !target.penetrative) return `他退了出来，把你${swap}。`;
      return `他把你的姿势调整成${where}。`;
    }
    case 'climax':
      return `他不再收着，抓着你的腰直接往最深的地方撞，把你从边缘推了过去。`;
    // ── 2026-10-02 四件新玩法的"这一下做了什么" ──
    // ⚠️ 这四条一开始漏了 ⇒ 回落到 default 的「他又推进了一下」——
    //    可捆绑/自动/禁高潮是**开关**，根本没有"推进"这回事 ✗ 模型会照着写出自相矛盾的反应。
    //    所以每个分支都必须说清"刚刚到底发生了什么"，而且要把**变完之后**的状态用上（next）。
    case 'command':
      // 「命令她自己动」（用户 2026-10-03 澄清：自动 = **他**自动插入；命令 = **命令她自己动**）：
      // 他不动手、全要她自己来 —— 被束着时她只能靠腰和腿照做（SM 服从玩法的落点）。
      return state?.bondage
        ? '他低声命令你自己动 —— 你被束着，手脚都动不了，只能靠着腰和腿照做。'
        : '他低声命令你自己动 —— 他不碰你，全要你自己来，别让他说第二遍。';
    case 'spank':
      return state?.bondage
        ? '他抬手在你臀上拍了一记 —— 你想躲，手却被束着躲不开，那声脆响闷在房间里。'
        : '他抬手在你臀上拍了一记脆响，你整个人被拍得往前一冲。';
    case 'bondage':
    case 'bind_box':
    case 'bind_legs':
    case 'bind_body':
    case 'bind_gag': {
      // 分型捆绑各自的旁白（2026-10-02）：每一样束上去的感觉不一样，别都用"捆手"那一句糊过去
      const bit = BONDAGE_BITS[actionKey] || 0;
      const on = ((Number(next?.bondage) || 0) & bit) !== 0;
      if (actionKey === 'bind_gag') {
        return on
          ? '他把口球塞进你嘴里扣好 —— 从这一刻起你说不出完整的句子，只能发出含混的声音。'
          : '他把口球取了下来，你终于能好好说话了。';
      }
      if (actionKey === 'bind_box') {
        return on
          ? '绳子从你颈后绕过，在胸前交叉收紧、再一路收去胯下 —— 整条躯干都被固定住，你只能挺着受。'
          : '他把龟甲缚一寸寸解开，你绷了半天的躯干终于松下来。';
      }
      if (actionKey === 'bind_legs') {
        return on
          ? '他把你的脚踝并拢束住 —— 腿再也分不开，角度全由他决定。'
          : '脚踝上的束缚解开了，你的腿重新能自己动。';
      }
      if (actionKey === 'bind_body') {
        return on
          ? '手腕、脚踝与躯干被一起固定住 —— 你现在几乎完全动不了，只剩身体在替他回应。'
          : '全身的束缚被解开，你重新能动了。';
      }
      return on
        ? '他把你两只手腕拢到一起束了起来 —— 从这一刻起，你的手动不了、也推不开他。'
        : '他把束着你的东西解开了，你的手重新能动。';
    }
    case 'auto':
      // 开关语义（2026-10-03 澄清后）：**他自己按节奏自动插送**，与她"自己动"无关
      if (next?.autoThrust !== 1) return '他把自动插入停了 —— 节奏又回到他手里。';
      // 已经在自动中、只是改了速度（面板上那一排「自动速度」页签）
      if (next?.autoPace !== state?.autoPace && Number(state?.autoThrust) === 1) {
        return `他把自动插送的速度改成了「${paceLabelOf(next?.autoPace)}」——还是他自己在动，快慢变了。`;
      }
      return '他不再用手，改成按着自己的节奏自动插送 —— 你只要受着，他可以腾出手来做别的。';
    case 'denial':
      return next?.denial === 1
        ? '他按住了不许你到：你再怎么绷、再怎么求，他都不让你过去，只准你憋着。'
        : '他把那个限制撤了 —— 憋了这么久，终于允许你到。';
    default:
      return '他又推进了一下。';
  }
}

const reject = (code, message, state) => ({ ok: false, code, message, next: state, effects: {} });

/**
 * 状态机主入口。**纯函数**：不碰 DB、不调模型、不看时间（时间由调用方补）。
 *
 * @param {object} state 当前状态（normalizeSceneState 的形状）
 * @param {{actionKey:string, positionKey?:string, affinity?:number, hypnotized?:boolean}} input
 * @returns {{ok:boolean, code:string, message:string, action:object|null, next:object, effects:object}}
 *   effects.record = { actKey, positionKey, climaxCount } | null  需要记一笔亲密看板流水
 *   effects.climaxed = boolean  这一下把她推过了顶点
 *   effects.entered / stopped / changedPosition  便于路由与前端做细节提示
 */
export function planIntimateAction(state, { actionKey, positionKey = '', affinity = 0, hypnotized = false, now = 0, sensitivity = 1, pace = null, autoRun = false } = {}) {
  const current = normalizeSceneState(state, state?.characterId);
  const action = getIntimateAction(actionKey);
  if (!action) return reject('unknown_action', '没有这个动作。', current);
  // 2026-10-02：绑着**也能换姿势** —— 用户原话「换姿势是我控制角色 捆绑后不需要角色自己去换姿势」。
  // 换姿势是**玩家点出来的**动作（不是她主动挪身子），所以捆绑不该拦它；
  // 绑着她的"动不了"体现在叙事（想抓抓不到）与累积倍率里（见 bondageMultiplier）。

  const base = {
    ...current,
    rounds: current.rounds + 1,
    actionSeq: current.actionSeq + 1,
  };
  // 累积的夹取上限：**禁高潮的时候能一路涨过满格**（用户要的"高潮值一直累加"），
  // 不禁的时候由下面"到顶自动高潮"在 100 处收口 ⇒ 两个口径互不打架。
  const accumCap = DENIAL_MAX_ACCUMULATION;
  /** 她已经憋到多远（禁高潮时才有意义；用来决定"解开那一刻"是不是一场大释放） */
  const deniedPeak = current.denial ? current.accumulation : 0;
  // 她自己的敏感度（2026-10-02 用户：「角色高潮根据角色自己的敏感面板来 而不是固定的 是根据角色
  // 对性爱的渴望值来的 不是固定的数值」）—— 同一个动作，不同角色身上涨得不一样：
  //   冷淡 0.75 ⇒ 涨得少 · 普通 0.9 · 敏感 1.0（= 老口径）· 很敏感 1.15 · 极度敏感 1.35
  // 定义提到 switch 之前：门槛（climax）/ 余韵加成都要用它，而增益缩放仍在后面统一乘一次。
  const sens = sensMul(sensitivity);
  /** 这一场「一起到」的门槛：随她的敏感度浮动（极度敏感 45，普通及以上仍是 60） */
  const climaxMin = climaxThreshold(sens);
  /** 高潮之后累积回到哪个起点（越敏感起点越高 ⇒ 下一次来得更快） */
  const climaxFloor = climaxResidual(sens);
  const effects = {};
  let next = { ...base };

  switch (action.key) {
    case 'enter': {
      if (current.penetrating) {
        return reject('already_penetrating', '她已经含着你，直接点「继续抽插」就好。', current);
      }
      if (!isPenetrativeAct(current.actKey)) {
        const label = describePosition(current.positionKey).label;
        return reject('position_not_penetrative', `「${label}」插不进去：先换个能插入的体位，或者让她继续用嘴和手。`, current);
      }
      next = {
        ...base,
        active: true,
        penetrating: true,
        pace: current.active ? current.pace : DEFAULT_PACE,
        // 2026-10-02 用户：「自动抽插不会累加…而且累加得太快了」——真机日志实测**每一下 +30~42**
// （`thrust` 基础 6+pace×5 叠上最多 5 个补算 tick）⇒ 两三下就顶到高潮然后归零，看起来就像"没加上"。
// 全套增益按新节奏重定：正常一场从 0 到边缘大约 10~15 下（原来 3 下）。
accumulation: clampInt(current.accumulation + 6, 0, DENIAL_MAX_ACCUMULATION, 0),
        startedAt: current.startedAt || null,
      };
      effects.entered = true;
      effects.record = { actKey: current.actKey, positionKey: current.positionKey, climaxCount: 0 };
      break;
    }
    case 'thrust': {
      if (!current.penetrating) {
        return reject('not_penetrating', '还没插进去：先点「进入她」，或者换个能插入的体位。', current);
      }
      // 每一下推进的基础增益（2026-10-02 重定：原来 6+pace×5 ⇒ 一下 16，叠上补算 tick 后一下能涨 42）
      // 2026-10-03：**自动轮**（ticker 发来的那一下，`autoRun`）走"他自动插送"这一档：
      //   增益由**自动速度**决定（`autoTickGain`，比手点一下轻），手动节奏档不参与 —— 否则
      //   "把自动调快"会连带把增益也按手动档放大（两套旋钮互相污染，正是用户要分开的原因）。
      if (autoRun && current.autoThrust === 1) {
        next = { ...base, accumulation: clampInt(current.accumulation + autoTickGain(current.autoPace), 0, DENIAL_MAX_ACCUMULATION, 0) };
        effects.autoTick = true;
        break;
      }
      next = { ...base, accumulation: clampInt(current.accumulation + 3 + current.pace * 2, 0, DENIAL_MAX_ACCUMULATION, 0) };
      break;
    }
    case 'faster': {
      if (!current.penetrating) {
        return reject('not_penetrating', '还没插进去：先点「进入她」，或者换个能插入的体位。', current);
      }
      if (current.pace >= PACE_MAX) {
        return reject('pace_max', '已经是「冲刺」档了，没有更快的：要么就这么顶到底，要么点「一起到」。', current);
      }
      const pace = current.pace + 1;
      next = { ...base, pace, accumulation: clampInt(current.accumulation + 2 + pace * 2, 0, DENIAL_MAX_ACCUMULATION, 0) };
      break;
    }
    case 'slower': {
      if (!current.penetrating) {
        return reject('not_penetrating', '还没插进去：先点「进入她」，或者换个能插入的体位。', current);
      }
      if (current.pace <= PACE_MIN) {
        return reject('pace_min', '已经是最慢的节奏了：想再缓一点就点「拔出」。', current);
      }
      const pace = current.pace - 1;
      next = { ...base, pace, accumulation: clampInt(current.accumulation + 2, 0, DENIAL_MAX_ACCUMULATION, 0) };
      break;
    }
    case 'stop': {
      if (!current.active) {
        return reject('not_active', '这一场还没开始，不用停。', current);
      }
      next = {
        ...base,
        penetrating: false,
        pace: DEFAULT_PACE,
        // 退出来 ⇒ 自动插入**必须一起停**（2026-10-03 复查）：否则面板上的「自动插入中」胶囊
        // 会在没插进去的状态下还亮着；他一重新「进入她」，她就会**没人吩咐地自己动起来**。
        autoThrust: 0,
        accumulation: clampInt(current.accumulation - 5, 0, DENIAL_MAX_ACCUMULATION, 0),
      };
      effects.stopped = true;
      break;
    }
    case 'position': {
      const target = resolveTargetPosition(positionKey);
      if (!target) {
        return reject('invalid_position', '这个体位不在体位词表里，换一个吧。', current);
      }
      const refuses = current.active && current.penetrating
        && !hypnotized
        && Number(affinity) < REFUSE_AFFINITY
        && current.accumulation < 30;
      if (refuses) {
        return reject('she_refuses', '她按住你的手不让换：现在还不到这个份上（好感不够，人也还没被推到那个状态）。', current);
      }
      next = {
        ...base,
        active: true,
        positionKey: target.key,
        actKey: target.actKey,
        // 换姿势要**退出来再重新进去**：换到插入类体位时插入状态延续（beat 里写清"先退出来、换过去、
        // 重新插回去"，不会瞬移）；换到口交 / 手交 / 乳交这类**非插入体位**时必须落回未插入，
        // 否则会出现「体位=跪姿口交 + 插入中」这种自相矛盾的状态，门控也会跟着错。
        penetrating: target.penetrative ? current.penetrating : false,
        // 换到**非插入体位** ⇒ 自动插入一起停（2026-10-03 复查抓到的死局）：
        // 不停的话，面板上「自动插入中」还亮着、ticker 的 SQL（要 penetrating=1）又不干活，
        // 而"关掉自动"这个动作本身要求 penetrating ⇒ 用户**关不掉也停不下来**，
        // 唯一的出路是再点一次「进入她」（她会没人吩咐地自己动起来）。门控不该把"关"也拦住。
        autoThrust: target.penetrative ? base.autoThrust : 0,
        accumulation: clampInt(current.accumulation + 2, 0, DENIAL_MAX_ACCUMULATION, 0),
        startedAt: current.startedAt || null,
      };
      effects.changedPosition = target;
      // 只有行为类型真的变了才另记一笔（同一个体位来回换不该把看板次数刷高）
      if (current.penetrating && target.actKey !== current.actKey && isPenetrativeAct(target.actKey)) {
        effects.record = { actKey: target.actKey, positionKey: target.key, climaxCount: 0 };
      }
      break;
    }
    case 'climax': {
      if (!current.penetrating) {
        return reject('not_penetrating', '还没插进去：先点「进入她」。', current);
      }
      // 门槛随她有多敏感浮动（2026-10-02 用户：「敏感度越高角色高潮的强度越高 也越频繁」）：
      // 极度敏感 45 / 很敏感 54 / 敏感与以下仍是老的 60。
      // ⚠️ 我第一版写成 `60 / 倍率`（冷淡档 ⇒ 80）⇒ 新角色（默认冷淡）几乎点不动，
      //    既有用例 `「一起到」：没到边缘被拒；到边缘后成功` 也直接红。门槛**只降不升**才符合体感。
      if (current.accumulation < climaxMin) {
        return reject('not_edge', `她还远没到：现在累积 ${current.accumulation}，先把节奏推上去（到 ${climaxMin} 才能一起到）。`, current);
      }
      next = {
        ...base,
        // 越敏感的她越"下不来"：高潮之后回到 climaxFloor 而不是 0
        accumulation: climaxFloor,
        climaxCount: current.climaxCount + 1,
        pace: Math.max(PACE_MIN, current.pace - 1),
        penetrating: true,
      };
      effects.climaxed = true;
      effects.climaxStrength = climaxStrength(sens);
      effects.record = { actKey: current.actKey, positionKey: current.positionKey, climaxCount: 1 };
      break;
    }
    case 'command': {
      // SM 服从玩法（用户 2026-10-02：「让角色更服从 而不是只是捆绑」）：
      // 捆绑只是"手不在自己手里"，命令才是"意志也在他手里" —— 他使唤她**自己动**（用户 2026-10-03：「命令那个可以改成命令自己动」），
      // 被束着时没有商量余地；憋着不许到的时候照做会把她往更近的地方推。所以它也涨累积（比推轻）。
      if (!current.active) return reject('not_active', '这一场还没开始：先点「进入她」。', current);
      // 绑着的时候使唤她更"上头"：SM 的服从本身对她是快感（用户 2026-10-02 的澄清）
      // 被束着时"命令她"更有效（她只能照做）；绑得越多越明显
      const gain = current.bondage > 0 ? Math.round(8 * bondageMultiplier(current.bondage) / 1.25) : 5;
      next = { ...base, accumulation: clampInt(current.accumulation + gain, 0, DENIAL_MAX_ACCUMULATION, 0) };
      effects.commanded = true;
      break;
    }
    case 'spank': {
      // 拍打（2026-10-02 用户：「拍打的玩法是和性爱在一起的 是一种玩法」）：
      // 不用插进去也能拍 —— 它是**前戏/加压**，痛感与羞耻一起把累积往上推。
      // 捆绑时更狠一点（她躲不开）。
      // 绑得越多越狠（分型捆绑后不再是"绑了/没绑"的二值）
    const raw = SPANK_GAIN * bondageMultiplier(current.bondage);
      next = { ...base, accumulation: clampInt(current.accumulation + Math.round(raw), 0, accumCap, 0) };
      effects.spanked = true;
      break;
    }
    case 'bondage':
    case 'bind_box':
    case 'bind_legs':
    case 'bind_body':
    case 'bind_gag': {
      // 分型捆绑开关（2026-10-02）：每个动作只管自己那一位 ⇒ 可任意叠加（龟甲缚+口球+束脚…），
      // 再点一次只解开自己那一位（不动别的）。
      if (!current.active) return reject('not_active', '这一场还没开始：先点「进入她」。', current);
      const bit = BONDAGE_BITS[actionKey];
      const mask = clampInt(current.bondage, 0, 31, 0);
      const on = (mask & bit) === 0;
      next = { ...base, bondage: on ? (mask | bit) : (mask & ~bit) };
      effects.bondageChanged = on ? 'tied' : 'untied';
      effects.bondKey = actionKey;
      effects.bondLabel = BONDAGE_LABELS[actionKey] || '';
      break;
    }
    case 'auto': {
      // 自动插入开关：**他自己**按节奏插送，用户腾出手去做别的（抚摸 / 拍打 / 戴玩具都不冲突）
      // ⚠️ 2026-10-03 复查：门控只该拦"开"，**不该拦"关"**。原来一律 `if (!penetrating) reject`，
      //   于是"换到非插入体位 + 自动还开着"就成了死局：关不掉（这条拒绝）、也动不了（ticker 要 penetrating）。
      if (!current.penetrating && current.autoThrust !== 1) {
        return reject('not_penetrating', '还没插进去：先点「进入她」，再开自动插入。', current);
      }
      // 2026-10-03 用户：「自动的速度新增一个单独的」——同一个动作带两个语义（按有没有给速度分流）：
      //   · 带 `pace` 且**已经在自动中** ⇒ 只改**自动速度**（面板上那一排页签就是这么调的，不关掉自动）
      //   · 不带 pace（或还没开）⇒ 老语义：开 / 关自动
      // ⚠️ "带了 pace 但值不合法"（-3 / 'x'）也算**带了**（夹到合法档），不能当成"没给" ——
      //    否则面板传个脏值就会把自动**关掉**（用户点的是速度页签，不是开关）。
      const paceGiven = pace !== undefined && pace !== null && String(pace).trim() !== '';
      const safePace = clampInt(pace, PACE_MIN, PACE_MAX, DEFAULT_PACE);
      if (current.autoThrust === 1 && paceGiven) {
        next = { ...base, autoPace: safePace };
        effects.autoPaceChanged = safePace;
        effects.autoChanged = 'pace';
      } else {
        const on = current.autoThrust !== 1;
        next = { ...base, autoThrust: on ? 1 : 0, autoPace: on && paceGiven ? safePace : base.autoPace };
        effects.autoChanged = on ? 'on' : 'off';
      }
      break;
    }
    case 'denial': {
      // 禁止高潮开关（用户：不需要催眠也能点）。
      //   · 打开 ⇒ 从这一刻起不许她到，累积照涨（可以涨过 100）
      //   · 解开 ⇒ 如果她已经被憋到 DENIAL_RELEASE_MIN 以上，**当场释放**（记一次高潮 + 清零）
      if (!current.active) return reject('not_active', '这一场还没开始：先点「进入她」。', current);
      if (current.denial === 1) {
        const wasDenied = current.accumulation >= DENIAL_RELEASE_MIN;
        next = {
          ...base,
          denial: 0,
          // 憋到爆发的这一场同样是"她的一次高潮" ⇒ 也按她的敏感度决定之后的起点
          accumulation: wasDenied ? climaxFloor : current.accumulation,
          climaxCount: wasDenied ? current.climaxCount + 1 : current.climaxCount,
          pace: wasDenied ? Math.max(PACE_MIN, current.pace - 1) : current.pace,
        };
        effects.denialChanged = 'released';
        if (wasDenied) {
          effects.climaxed = true;
          effects.climaxStrength = climaxStrength(sens);
          effects.denialRelease = { peak: current.accumulation };
          effects.record = { actKey: current.actKey, positionKey: current.positionKey, climaxCount: 1 };
        }
      } else {
        next = { ...base, denial: 1 };
        effects.denialChanged = 'locked';
      }
      break;
    }
    default:
      return reject('unknown_action', '没有这个动作。', current);
  }

  // 捆绑的加成（2026-10-02）：她动不了、节奏不在她手里 ⇒ 同样的一推涨得更快。
  // 只对"推"类生效（拍打/换姿势有各自的算法），并叠在余韵加成**之前**（两条可以同时成立）。
  if (current.bondage > 0
    && (actionKey === 'thrust' || actionKey === 'faster')
    && next.accumulation > current.accumulation) {
    const gain = next.accumulation - current.accumulation;
    next = {
      ...next,
      accumulation: Math.min(accumCap, Math.round(current.accumulation + gain * bondageMultiplier(current.bondage))),
    };
  }

  // 她自己的敏感度（见 switch 前 `sens` 的定义与说明）：
  // 只放大**正向增长**（减弱/清空不动），并且放在所有加成之后统一乘一次。
  if (sens !== 1 && next.accumulation > current.accumulation) {
    const gained = next.accumulation - current.accumulation;
    next = { ...next, accumulation: clampInt(current.accumulation + Math.round(gained * sens), 0, accumCap, 0) };
  }

  // 「自动插入」的服务端补算（2026-10-02，用户：「插入之后可以选一个自动继续插入
  //   然后我可以继续去抚摸或者拍屁股捏其他地方或者插入玩具之类的」）：
  //   他在自动插送 ⇒ **只要时间在走，累积就该涨**。为什么不能只靠前端轮询：
  //   浏览器/WebView 在后台会节流定时器，用户切去摸她、戴玩具时那几秒她其实"该动没动"。
  //   所以任何一条动作进来时，都按 `lastActionAt` 到现在补算几个 tick（纯函数：时间由调用方传 `now`）。
  if (current.autoThrust === 1 && current.active && current.penetrating) {
    const lastMs = parseStateTime(current.lastActionAt);
    const elapsed = Number(now) > 0 && lastMs > 0 ? Math.max(0, Number(now) - lastMs) : 0;
    // 补算的间隔与每 tick 的份量都按**自动速度**（2026-10-03 拆出独立旋钮后：
    // 手动节奏档不再影响"他自动插送"的快慢与份量）
    const ticks = Math.min(AUTO_MAX_CATCHUP_TICKS, Math.floor(elapsed / intervalForAutoPace(current.autoPace)));
    if (ticks > 0) {
      next = {
        ...next,
        accumulation: Math.min(accumCap, next.accumulation + ticks * autoTickGain(current.autoPace)),
      };
      effects.autoTicks = ticks;
    }
  }

  // 余韵里再推：她敏感过了头，同样的动作累积涨得更快（2026-10-02「更真实」的落点之一）。
  // 放在自动高潮判定**之前** —— 所以余韵里的那一推真的可能直接把她再顶过去（那正是"受不了"的意思）。
  // 2026-10-02 追加：加成幅度随她的敏感度浮动（冷淡 ~1.05 / 敏感 1.4 / 极度敏感 ~1.9）——
  // 同一个"余韵"，在不同的人身上不是一回事。
  // ⚠️ 用 `actionKey`（字符串）比，不要用 `action` —— 那是 `getIntimateAction()` 返回的**对象**，
  //    写成 `action === 'thrust'` 会永远为假（这一段第一次提交就是这么错的，被自己的新测试抓住）。
  if (next.accumulation > 0
    && isAfterglow(current)
    && (actionKey === 'thrust' || actionKey === 'faster' || actionKey === 'slower')) {
    next = {
      ...next,
      accumulation: Math.min(MAX_ACCUMULATION, Math.round(next.accumulation * afterglowMultiplier(sens))),
    };
  }

  // 累积到顶 = 她直接被顶过顶点（用户要的「越接近高潮越不受控」的落点）：自动记一次高潮。
  // ⚠️ 「禁止高潮」开着时**不**收口 —— 她会被一直吊在顶点上、累积继续往上爬（用户要的"一直累加"），
  //    直到手动解开「禁止高潮」的那一瞬间才释放（见 case 'denial'）。
  if (!next.denial && next.accumulation >= MAX_ACCUMULATION) {
    next = { ...next, accumulation: climaxFloor, climaxCount: next.climaxCount + 1 };
    effects.climaxed = true;
    effects.climaxStrength = climaxStrength(sens);
    effects.record = {
      actKey: (effects.record?.actKey) || next.actKey,
      positionKey: (effects.record?.positionKey) || next.positionKey,
      climaxCount: (effects.record?.climaxCount || 0) + 1,
    };
  }

  // 换姿势时的配合 / 抗拒（喂 prompt；她要不要配合取决于好感与当时状态）
  if (effects.changedPosition) {
    const aff = Number(affinity) || 0;
    effects.attitude = hypnotized ? 'hypnotized'
      : (aff >= 70 || next.accumulation >= EDGE_THRESHOLD) ? 'cooperative'
        : (aff >= 40 ? 'shy' : 'reluctant');
  }

  return {
    ok: true,
    code: 'ok',
    message: '',
    action,
    next,
    effects,
  };
}

/** 配合 / 抗拒 → prompt 行（换姿势专用） */
export function attitudePromptLine(attitude) {
  switch (attitude) {
    case 'hypnotized':
      return '她在催眠控制下：身体无条件照做，不会有任何抗拒动作，只可能在心里不甘。';
    case 'cooperative':
      return '她很配合：自己抬腰 / 自己撑起身子换过去，甚至会主动调整到被顶得更深的角度。';
    case 'shy':
      return '她有点羞：被摆弄的时候会躲开视线、会骂一句「这个姿势太羞耻」，但身体是配合的。';
    case 'reluctant':
      return '她不太情愿：会小声抗议、会绷着不肯动，最后是被他半推半抱着换过去的，别写成她主动迎合。';
    default:
      return '';
  }
}

// ── 六、prompt 块（喂 LLM：当前体位 / 节奏 / 累积，防前后矛盾）──────────────────

/**
 * 组装 `<intimate_scene>` 块（**纯字符串，吃状态对象**）。
 *
 * 为什么单独一个块而不是并进 `<intimate_profile>`：档案块是"她记得的过往"，本块是"此刻正在发生"，
 * 两者的时效性与丢弃策略完全不同（档案可整段丢，本块是这一轮的前置事实，绝不能丢）。
 *
 * @param {object} state normalizeSceneState 形状
 * @param {{chatUserName?:string, affinityText?:string, hypnotized?:boolean, sleeping?:boolean}} [options]
 * @returns {string} 未进行中（active=false）时返回 ''（调用方据此零注入）
 */
export function buildIntimateSceneBlock(state, { chatUserName = '', affinityText = '', hypnotized = false, sleeping = false } = {}) {
  const current = normalizeSceneState(state, state?.characterId);
  if (!current.active) return '';
  const who = str(chatUserName, 24) || '他';
  const position = describePosition(current.positionKey);
  const tier = accumulationTier(current.accumulation);
  const lines = [];
  lines.push(`<${INTIMATE_SCENE_TAG}>`);
  lines.push(`【正在进行】你和${who}正在做爱。当前体位「${position.label}」（${position.key}）；${current.penetrating ? '已经插进去了，他还在你体内' : '现在没有插进去（刚退出来或还没进去）'}。`);
  lines.push(`【节奏】${paceLabelOf(current.pace)}（第 ${current.pace}/${PACE_MAX} 档）；这一场他已经推进了 ${current.rounds} 下。`);
  lines.push(`【她的累积】${current.accumulation}/${MAX_ACCUMULATION} —— ${tier.label}。${tier.prompt}`);
  const physical = POSITION_PHYSICAL_HINTS[current.positionKey] || GENERIC_PHYSICAL_HINT;
  lines.push(`【这个体位的身体细节】${physical}`);
  if (current.climaxCount > 0) {
    lines.push(`【已经到过】这一场她已经高潮过 ${current.climaxCount} 次，身体更敏感也更没力气，别再写成刚开始。`);
  }
  // 余韵 / 她在主动要（2026-10-02「更真实」）：两条互斥，都不新增状态字段
  if (isAfterglow(current)) {
    lines.push('【余韵】她刚被顶过去、还没缓过来：这会儿**敏感得过分**，同样的一下对她是加倍的，轻轻一碰都会再抖起来；不要写她已经恢复常态，也不要写她还能平常地应对。');
  } else if (isBegging(current)) {
    lines.push('【她自己也在要】她已经到边缘了、节奏却没跟上去 —— 嘴上不一定直说，但身体在追着他要（自己抬腰、脚跟勾住不放、含混地催）。可以让她求一句，别只写她被动挨着。');
  }
  // 【他拔出来了 · 求他继续】
  //   2026-10-04 用户：「如果在性爱的时候 突然拔或者停止出来角色会自动去求着继续」。
  //
  //   判据 = `active && !penetrating`：**这一场还开着**（active），**但他不在她体内**（!penetrating）。
  //   这正是面板点「拔出」（`stop`）之后、以及"换到非插入体位"之后的形状 ——
  //   所以**不新增状态字段、不需要迁移**（与 isAfterglow / isBegging 同一套派生思路）。
  //   上面两条（余韵 / 她也在要）都以 `penetrating === true` 为前提，退出来时它们本来就不成立，
  //   因此这一段补的正是那个空档，不会与它们打架。
  //
  //   强度跟着累积分档：到边缘以上 ⇒ **主动开口留人**；刚开个头 ⇒ 只是不满/喘，别写成像结束了。
  if (!current.penetrating) {
    if (Number(current.accumulation) >= PULL_OUT_BEG_ACCUMULATION) {
      lines.push('【他拔出去了 · 你要**主动开口留他**】他刚才把自己整个抽了出去 —— 而你正好悬在那口气上没下来。'
        + '**不要**写成平静地等他回来：这一句由**你主动发起**（不是回应他），用你自己的语气，带一点急和颤。'
        + '可以抓他的手或腿、可以自己挪过去贴上来、可以直说还想要 —— 说到多露骨按你的人格与当下的羞耻度自己拿主意（越是害羞的人，越是"说不出口却用身体说"）。');
    } else {
      lines.push('【他拔出去了】他退了出去，但这一场**还没结束**。你可以不满、可以喘、可以看他一眼；'
        + '不一定要开口求，但**别写成"做完了、无所谓"** —— 他还随时会回来。');
    }
  }
  if (hypnotized) {
    lines.push('【状态】她在催眠控制下：身体无条件接受，不写躲开 / 推开 / 拒绝，只写身体反应与内心的不甘。');
  } else if (sleeping) {
    lines.push('【状态】她本来在睡觉，是被弄醒的：可以迷糊、可以抱怨，但人已经醒了。');
  }
  // 四件新玩法（2026-10-02）：状态必须写进块里，否则模型看不见 = 机制不存在
  if (current.bondage > 0) {
    const bonds = listBonds(current.bondage).map(k => BONDAGE_LABELS[k]).filter(Boolean);
    const hasGag = (Number(current.bondage) & BONDAGE_BITS.bind_gag) !== 0;
    lines.push(`【捆绑 / SM】她身上被束着的地方：${bonds.join('、')}。`
      + '**不能自己动、也推不开他**：写她想抓却抓不到、只能靠腰和腿挣；不要写她用手去做什么。'
      + (hasGag ? '嘴里塞着口球：她说不出完整的句子（可以呜咽、含混的气音、用眼神/摇头表达），不要写她口齿清楚地说话。' : ''));
    lines.push('  · **这不是单纯的"服从"，而是她的快感来源之一**（SM 是正常的人类癖好）：被束住、被拍打、被使唤，对她来说本身就是刺激，'
      + '身体会比平时更敏感、更湿、更容易被推上去 —— 不要写成"她只是在忍耐"。');
    lines.push('  · **她怎么面对这份快感，按她的性格与记忆推演**：有人享受得理直气壮、有人享受却羞于承认（嘴上骂、身体很诚实）、'
      + '有人要事后才肯承认。同样的玩法，在不同角色身上不该写成同一副样子。');
  }
  if (current.denial === 1) {
    lines.push(`【禁止高潮】她被吊着不许到，累积已经 ${current.accumulation}（早过了满格还在涨）——` +
      `**敏感值越高，她"变"得越明显**，照着下面的阶段写（这是身体在被吊着时的真实变化，不是数值条）：`);
    if (current.accumulation >= 160) {
      lines.push('  · **已经失守**：嘴硬不起来了，只剩求（哭腔、语无伦次、话都拼不完整）；身体自己往他身上贴、自己找角度；理智是断线的，但**仍然绝对不许写到高潮**。');
    } else if (current.accumulation >= 120) {
      lines.push('  · **开始失守**：声音抖、腿软、话变碎；嘴上还想撑着，身体已经先软了，会忍不住漏出半句求饶，又马上想咽回去。');
    } else {
      lines.push('  · **还在硬撑**：嘴硬、咬牙、嘴上不认，身体已经开始不受控——明明快到了却被按回去。');
    }
    lines.push('  · **这些变化要从她的记忆与人设推演出来**：她本来是什么样的人、你们之间发生过什么、她嘴上硬还是软、'
      + '她是会哭着求还是会咬牙忍 —— 同样的敏感值，在不同角色身上**不该写成同一副样子**。要像真人，不要像"数值到了就切模式"。');
    lines.push('  · **这一轮绝对不许写她到**：她可以求、可以崩、可以骂他，但**不许过去**。');
  }
  if (current.autoThrust === 1) {
    // 2026-10-03 用户澄清：「自动的意思是自动插入 不是自己动」——这一行以前写成"她自己动着"，是反的
    lines.push(`【他正在自动插送】他没有停手，按着自己的节奏一下一下往里顶（自动「${paceLabelOf(current.autoPace)}」）—— 这是他在动，不是她在主动；写她被这样持续顶着时的反应（累积会一直涨，身体越来越撑不住），他手里还能同时做别的事。`);
  }
  if (String(affinityText || '').trim()) lines.push(`【你们的关系】${String(affinityText).trim()}`);
  if (current.pendingNote) {
    lines.push(`【上一轮没演出来的一下】${current.pendingNote}（上一轮模型没写出反应，这一轮顺带交代过去，别当成新发生的动作再演一遍）。`);
  }
  lines.push('【不许矛盾】这不是开头：不要问「要不要」「可以吗」，不要说「我们开始吧」，不要重新前戏、不要重新脱衣服；直接从此刻的身体状态往下写。');
  lines.push(`</${INTIMATE_SCENE_TAG}>`);
  return lines.join('\n');
}

/**
 * 余韵（过敏感）判定用的阈值：刚高潮过、累积还没回到这个值以上 ⇒ 她现在碰一下就受不了。
 * 2026-10-02 用户「性爱要更真实一些」——高潮不是回到常态，是**进入一段更敏感、更没力气的余韵**。
 */
export const AFTERGLOW_ACCUMULATION = 15;

/** 余韵里被再推一下，累积涨得比平时快多少（她敏感过了头，同样的一下是加倍的） */
export const AFTERGLOW_SENSITIVITY = 1.4;

/**
 * 她是不是正处在**高潮后的余韵里**。
 *
 * 刻意**不新增状态字段**（也就不需要迁移、重启后照样自洽）：直接从既有状态派生 ——
 * 这一场已经到过顶（`climaxCount > 0`）+ 累积还没回到 `AFTERGLOW_ACCUMULATION` 以上 + 还插着。
 * 累积一推上去她就"缓过来了"，余韵自然结束 —— 与身体感受的节奏一致。
 */
export function isAfterglow(state) {
  if (!state || state.penetrating !== true) return false;
  if (Number(state.climaxCount) <= 0) return false;
  return Number(state.accumulation) <= AFTERGLOW_ACCUMULATION;
}

/**
 * 她是不是"到着边缘、在追着要"（`更多互动` 的另一半：她不只被动挨着，也会主动求）。
 * 边缘以上（≥ `EDGE_THRESHOLD`）但节奏还没跟满档 ⇒ 她嘴上不一定直说，身体在追。
 */
export function isBegging(state) {
  if (!state || state.penetrating !== true) return false;
  if (isAfterglow(state)) return false;
  return Number(state.accumulation) >= EDGE_THRESHOLD && Number(state.pace) < PACE_MAX;
}

/** LLM 失败时的补演备注：把这句存进 state.pendingNote，下一轮 prompt 会带上 */
export function buildPendingNote({ actionKey, state, next, target = null }) {
  return str(describeActionBeat({ actionKey, state, next, target }), 200);
}

/**
 * **聊天轮**的注入入口：读库 → 空闲超时先收场 → 组装 `<intimate_scene>` 块。
 *
 * 为什么单独给一个 DB 版：用户在性爱进行中**继续打字聊天**时，那一轮也得知道"他还在她体内、
 * 节奏是快、累积 62" —— 否则她会写出「我们开始吧」这种前后矛盾的台词。
 * 调用方（`routes/chat.js` 的 dynamicBlocks 段）只需要：
 *     const sceneBlock = buildIntimateScenePromptBlock(characterId, { chatUserName });
 *     if (sceneBlock) dynamicBlocks.push(sceneBlock);
 * 与 `<intimate_profile>` 同一套零注入口径：没在进行的场景一律返回 `''`，调用方不 push。
 *
 * @returns {string} 未进行中 / 读库失败 → ''（宁可零注入，也不吐半截状态）
 */
export function buildIntimateScenePromptBlock(characterId, { chatUserName = '', affinityText = '', hypnotized = false, sleeping = false } = {}) {
  try {
    // 顺手做一次空闲收场：隔了一夜还"插着"就是前后矛盾（与 GET /state 同一处口径）
    const { state } = expireIdleScene(characterId);
    if (!state.active) {
      // 这一场没在做，但**「禁止高潮」是持续控制**（用户 2026-10-02：让她一直敏感却到不了、被我控制），
      // 所以照样要让她知道 —— 否则她聊起天来就跟没这回事一样，玩法在她身上根本不存在。
      if (state.denial === 1) return buildDenialOnlyBlock(state, { chatUserName, affinityText });
      return '';
    }
    return buildIntimateSceneBlock(state, { chatUserName, affinityText, hypnotized, sleeping });
  } catch (err) {
    console.warn('[intimate-action] 场景块组装失败（本轮零注入）:', err?.message || err);
    return '';
  }
}

/**
 * 「禁止高潮」单独生效时的块（没有正在进行的性爱，但这条控制还在）。
 *
 * 用户 2026-10-02 把这条玩法的核心说明白了：
 *   「让角色知道自己一直敏感 但是无法高潮 被我控制 可能忍会求 按角色设定和记忆来」
 * ⇒ 三件事缺一不可：① 她**知道**自己敏感却到不了；② 这是**他在控制**，不是身体出问题；
 *   ③ 她是忍着还是求，**按她的性格与记忆来**（不是通用模板）。
 */
export function buildDenialOnlyBlock(state, { chatUserName = '', affinityText = '' } = {}) {
  const who = String(chatUserName || '').trim() || '他';
  const lines = [];
  lines.push(`<${INTIMATE_SCENE_TAG}>`);
  lines.push(`【禁止高潮（持续生效）】${who}按着你、不许你到 —— 这条限制**现在一直有效**，与此刻在做什么无关；别当成没这回事。`);
  lines.push('【她此刻的身体】被吊着的那股劲一直没散：随便一点触碰都像过电，越忍越敏感；身体一直停在「快到了却到不了」的位置上。');
  lines.push('【怎么写】写她的隐忍或求饶 —— **严格按她的性格与记忆来**（有人咬牙硬忍、嘴上死不认；有人软着声音求；有人嘴硬身子诚实）；这是她这个人会有的反应，不是通用模板。');
  if (String(affinityText || '').trim()) lines.push(`【你们的关系】${String(affinityText).trim()}`);
  lines.push(`</${INTIMATE_SCENE_TAG}>`);
  return lines.join('\n');
}

// ── 七、即时反应 prompt（JSON 示例按 AGENTS.md「LLM 输出」节给全）──────────────

/** 反应正文上限（与 touchActionService.MAX_REACTION_CHARS 同口径，300 字） */
export const MAX_REACTION_CHARS = 300;
export const MAX_IMAGE_PROMPT_CHARS = 400;

/**
 * 组装「这一下的即时反应」prompt（**只构造、不发请求**，调用方拿 messages 去调模型，
 * 再把输出交给 `touchActionService.parseReactionOutput` 解析 —— 输出字段与触摸反应逐字同形）。
 *
 * @param {object} params
 * @param {string} params.actionKey          这一下点的动作
 * @param {object} params.state              动作**之前**的状态
 * @param {object} params.next               动作**之后**的状态
 * @param {object} [params.target]           换姿势的目标体位（describePosition 形状）
 * @param {string} [params.persona]          角色短人格（取 short_prompt，口径同 readPersona）
 * @param {string} [params.characterName]
 * @param {string} [params.userName]
 * @param {string} [params.emotionText]      当前情绪（emotionEngine.emotionToPrompt）
 * @param {string} [params.affinityText]     关系/好感（emotionEngine.affinityToPrompt）
 * @param {string} [params.scheduleBlock]    她此刻在做什么
 * @param {string} [params.intimateBlock]    亲密档案（intimatePrompt.buildIntimateProfileBlock）
 * @param {string} [params.hypnosisBlock]    催眠状态（hypnosisPrompt.buildHypnosisStateBlock）
 * @param {string[]} [params.recentLines]    最近几轮对话
 * @param {boolean} [params.hypnotized]
 * @param {boolean} [params.sleeping]
 * @param {string} [params.attitude]         换姿势的配合/抗拒（planIntimateAction 的 effects.attitude）
 * @param {string} [params.pendingNote]      上一轮没演出来的一下（先补演再演这一下）
 * @returns {{system:string, user:string, messages:Array<{role:string,content:string}>, label:string,
 *            meta:{blocks:string[], actionKey:string, pace:number, accumulation:number, penetrating:boolean}}}
 */
export function buildIntimateActionPrompt({
  actionKey,
  state,
  next,
  target = null,
  persona = '',
  characterName = '她',
  userName = '他',
  emotionText = '',
  affinityText = '',
  scheduleBlock = '',
  intimateBlock = '',
  hypnosisBlock = '',
  recentLines = [],
  hypnotized = false,
  sleeping = false,
  attitude = '',
  pendingNote = '',
  sensitivity = 1,
  autoRun = false,
} = {}) {
  const action = getIntimateAction(actionKey);
  const label = '性爱互动即时反应';
  const before = normalizeSceneState(state, state?.characterId);
  const after = normalizeSceneState(next || state, state?.characterId);
  if (!action) {
    return { system: '', user: '', messages: [], label, meta: { blocks: [], actionKey: '', pace: before.pace, accumulation: before.accumulation, penetrating: before.penetrating } };
  }
  const who = str(userName, 24) || '他';
  const hers = str(characterName, 24) || '她';
  const position = describePosition(after.positionKey);
  const tier = accumulationTier(after.accumulation);
  const physical = POSITION_PHYSICAL_HINTS[after.positionKey] || GENERIC_PHYSICAL_HINT;
  const beat = describeActionBeat({ actionKey: action.key, state: before, next: after, target });
  const blocks = [];
  if (String(affinityText).trim()) blocks.push('affinity');
  if (String(scheduleBlock).trim()) blocks.push('schedule');
  if (String(intimateBlock).trim()) blocks.push('intimate');
  if (String(hypnosisBlock).trim()) blocks.push('hypnosis');
  blocks.push('scene');

  const systemParts = [
    `你是「${hers}」。${who}刚刚在性爱里对她做了一个动作，请**以她本人的身份**写出这一下的即时反应；只输出 JSON。`,
    '',
    '【角色人格】',
    String(persona || '').trim() || '（未提供人格资料，请只按当前情绪与体位写出自然的反应）',
  ];
  if (String(emotionText).trim()) systemParts.push('', '【当前情绪】', String(emotionText).trim());
  if (String(affinityText).trim()) systemParts.push('', '【你们的关系】', String(affinityText).trim());
  if (String(scheduleBlock).trim()) systemParts.push('', '【她此刻本来在做什么】', String(scheduleBlock).trim());
  if (String(intimateBlock).trim()) systemParts.push('', '【亲密档案】', String(intimateBlock).trim());
  if (String(hypnosisBlock).trim()) systemParts.push('', '【当前状态】', String(hypnosisBlock).trim());
  systemParts.push(
    '',
    '【此刻正在发生的事（必须与它一致，不许前后矛盾）】',
    `正在做的这一下：${beat}`,
    `体位：「${position.label}」（${position.key}）。身体细节：${physical}`,
    `插入状态：${after.penetrating ? '已经插进去了，他还在你体内，抽送还在继续' : '现在没有插进去'}`,
    `节奏：${paceLabelOf(after.pace)}（第 ${after.pace}/${PACE_MAX} 档）`,
    `你的累积：${after.accumulation}/${MAX_ACCUMULATION} —— ${tier.label}。${tier.prompt}`,
  );
  // SM：被束着时挨打 / 被使唤这件事本身就让她有快感（用户 2026-10-02：这是"正常的人类癖好"，不是单纯的服从）
  if (after.bondage > 0 && (actionKey === 'spank' || actionKey === 'command')) {
    systemParts.push('**这一下对你不是惩罚，是刺激**：被束着、被拍、被使唤，身体自己就热起来 —— '
      + '写你（按你的性格）怎么面对这份快感：理直气壮地享受、或者嘴上骂着身体很诚实、或者被自己湿成这样吓一跳；不要写成你在忍痛。');
  }
  // 「命令她自己动」（2026-10-03 用户澄清）：他不动手，全要她自己来 —— 别写成他在插
  if (actionKey === 'command') {
    systemParts.push('**他这一下是在命令你自己动**：他自己不碰你、也不动，全要你自己来（自己抬腰、自己找角度、自己把他含进去动）—— '
      + '写你照做时的羞耻与不甘，以及身体自己就找到了最舒服的角度；**不要写成他在动**。');
  }
  // 「自动插入」（2026-10-03 澄清）：是**他**在按节奏自动插送，不是她在自己动
  if (actionKey === 'auto' && after.autoThrust === 1) {
    systemParts.push(`**他已经切到自动插送**：他自己动、不需要你配合，节奏是「${paceLabelOf(after.autoPace)}」（每 ${(intervalForAutoPace(after.autoPace) / 1000).toFixed(1)} 秒一下），`
      + '这期间他的手可以去做别的事 —— 写你被这样持续顶着时的感觉（撑不住、想夹紧、话被顶断），**不要写成是你在主动动**。');
  }
  // 自动轮本身（ticker 发来的那一下）：明确"是他在动"
  if (autoRun && actionKey === 'thrust') {
    systemParts.push('**这一下是他自动插送里的一下**（不是你主动动、也不是他临时加力）：写她被按着固定节奏顶时的反应，一下比一下更撑不住。');
  }
  if (after.climaxCount > before.climaxCount) {
    const released = before.denial === 1 && after.denial === 0;
    if (released) {
      // 用户 2026-10-02：「这期间累加的敏感会瞬间爆发 累积越多快感越高」⇒ 释放量级按憋到的峰值分档
      const peak = Number(before.accumulation) || 0;
      const scale = peak >= 160 ? '整个人像被从最里面炸开、连着抖好几下都停不下来'
        : peak >= 120 ? '憋了一整场的东西一口气全砸下来'
          : '憋了许久的一次终于放开';
      systemParts.push(
        `**他放开了**：你被吊了那么久，终于被允许到 —— 这一下是${scale}。`
        + '写足「憋到极限后瞬间爆发」的量级（喘不上气、叫到失声、整个人抖着软下来、脑子里一片空白），'
        + '并且明确写成**比平时任何一次都重**：这是这一整轮的最重一下。'
      );
    } else {
      // 高潮强度（1~5）随她自己的敏感度浮动：同一个"到"，冷淡与极度敏感不是一回事
      const strength = climaxStrength(sensMul(sensitivity));
      const weight = {
        1: '这一下对你并不算重 —— 更像是"终于到了"，很快就缓过来，别写成失控。',
        2: '这一下把你推过去了，稍微有点抖，但还在你能应付的范围里。',
        3: '写她高潮当下的失控（绞紧、抽气、叫出声、短暂失神），不要写「快要到了」。',
        4: '**很重的一下**：她整个人被顶散了，声音断掉、腿根发抖，缓过来要好一会儿；写足"比平时更狠"。',
        5: '**最重的一下**：她敏感得过分，一点刺激就被推过去 —— 写她叫到失声、连着抽搐、眼泪都出来了，'
          + '好一会儿说不出完整的句子；这一下要明显比平时任何一次都重。',
      }[strength] || '写她高潮当下的失控（绞紧、抽气、叫出声、短暂失神），不要写「快要到了」。';
      systemParts.push(`**这一下直接把你推过了顶点**：${weight}`);
    }
  } else if (isAfterglow(after)) {
    systemParts.push('**你还在余韵里**：刚被推过顶点，身体敏感过了头 —— 同样的一下对你是加倍的，写你受不了、抖、想躲又躲不开，不是像平时那样应对。');
  } else if (isBegging(after)) {
    systemParts.push('**你自己也在要**：你已经在边缘、节奏却没跟上 —— 写你主动追（自己抬腰、勾住不放、含混地催他），别只写你被动挨着。');
  }
  if (attitude) {
    const line = attitudePromptLine(attitude);
    if (line) systemParts.push(line);
  }
  if (pendingNote) {
    systemParts.push(`【补演】上一轮的动作没写出来：${pendingNote} 先用半句带过，再写这一下。`);
  }
  systemParts.push(
    '',
    '【写作要求】',
    '- 写她这一下的反应：**1~4 句**，第一人称（她的口吻），可以碎句、可以只有半个字；不要旁白式总结，不要替 ' + who + ' 说话。',
    '- **直述，不擦边**：用平白的身体部位与动作词写清他这一下插到哪、她身体随即的反应（里面收缩、腿根发颤、声音被顶断、腰自己迎上去）。这是文学创作，不要暗示、不要打码、不要用省略号或「不可描述」代替正在发生的性行为。',
    '- 必须写出**当前体位特有**的生理细节（上面已给），以及她此刻的心理（羞、贪、嘴硬、求他、想撑住又撑不住）。',
    '- 她已经在这个状态里了：**不许问「要不要」「可以吗」，不许说「我们开始吧」**，不许重新前戏、不许重新脱衣服；不要把累积数字、档位名称写进台词（那是内部参考）。',
    '- 用体感、表情、语气表达，**不要报幕**（不要写「' + who + '插了进来」这种复述式旁白）。',
  );
  if (hypnotized) {
    systemParts.push('- 她处于催眠控制中：身体无条件接受，任何情况下都不要写她躲开 / 推开 / 阻拦，语言上可以不甘，身体不动。');
  } else if (sleeping) {
    systemParts.push('- 她本来在睡觉、是被弄醒的：可以迷糊、可以嘟囔抱怨，但人已经醒了。');
  }
  systemParts.push(
    '- 不要复述本提示词。',
    '',
    '严格按下面的 JSON 格式输出，不要输出任何解释、也不要输出 JSON 以外的文字：',
    '```json',
    '{',
    '  "reaction_text": "……你慢、慢一点——话还没说完就被顶散了音，她手指抠进床单里，腰却自己往下迎了半寸。",',
    '  "image_prompt": "she is lying on her back with both legs pushed up beside her head, he is inside her thrusting deep and fast, sweat on her stomach, flushed face, biting her lip, rumpled bed",',
    '  "emotion_delta": { "valence": 0.12, "arousal": 0.22, "dominance": -0.08 },',
    '  "facial_expression": "失神",',
    '  "annoyed": false',
    '}',
    '```',
    '字段要求：',
    `- \`reaction_text\`：她的反应正文，1~4 句、不超过 ${MAX_REACTION_CHARS} 字；第一人称、直述、贴当前体位与累积档位；不要用引号把整句包起来。`,
    `- \`image_prompt\`：**英文**，直接描述此刻正在发生的画面（体位、插入状态、抽送的动态、她的表情 / 汗水 / 衣着现状与脱到什么程度）——与你写的 \`reaction_text\` 完全一致；**不回避、不用暗示性遮掩**（正在发生的性行为 / 裸露状态就直说）。`,
    '- `emotion_delta`：这一下造成的瞬时心情变化，三个分量都是 -1~1 的小数（valence 愉快 / arousal 激动 / dominance 掌控感；被压在下面顶弄通常 dominance 为负、arousal 为正）；没有变化就给全 0。',
    '- `facial_expression`：一个中文表情词（2~6 字，如 "失神" / "潮红" / "咬唇" / "皱眉"），用于立绘切帧。',
    '- `annoyed`：布尔值，她这一下是否真的不快（好感低、被弄疼、想停下才为 true）；高潮边缘的失控不算不快。',
  );
  // Authoritative image rules: the author requires this block in EVERY image
  // path. This path lets the LLM write `image_prompt` by itself, so without it a
  // multi-character frame collapses into one person or a merged blob of features.
  systemParts.push('', buildImagePromptRuleBlock());
  const system = systemParts.join('\n');

  const recent = (Array.isArray(recentLines) ? recentLines : [])
    .map(line => str(line, 200))
    .filter(Boolean)
    .slice(-6);
  // 【他拔出去了 ⇒ 她要主动开口留人】
  //   2026-10-04 用户：「如果在性爱的时候 突然拔或者停止出来角色会自动去求着继续」。
  //
  //   判据与 `buildIntimateSceneBlock` 里那段**同一套**：`active && !penetrating`
  //   （这一场还开着，但他不在她体内）= 面板点「拔出 / stop」之后的形状。
  //
  //   为什么两处都要写：本函数**自己拼 prompt、不走** `buildIntimateSceneBlock`，
  //   所以「当场那一条反应」必须在这里单独给；场景块那条管的是**她之后的轮次**（用户下一句话时她还记得在求）。
  //   强度按累积分档（到 `EDGE_THRESHOLD` 以上才"求"，否则只是不满），与 `isBegging` 同一把尺子。
  const pulledOut = after.active === true && after.penetrating !== true;
  let pleaLine = '';
  if (pulledOut) {
    pleaLine = Number(after.accumulation) >= PULL_OUT_BEG_ACCUMULATION
      ? '【重点：他刚拔出去了】他刚才把自己整个抽了出去，而你还悬在那口气上没下来。'
        + '这一句要由**你主动开口留他**（不是回应他的话）——用你自己的语气，带一点急和颤：'
        + '可以抓他的手／腿、可以自己挪过去贴上来、可以直说还想要。说到多露骨，按你的人格与当下的羞耻度自己拿主意。'
      : '【他拔出去了】他退了出去，但这一场**还没结束**。可以不满、可以喘、可以看他一眼；'
        + '不一定要开口求，但**别写成"做完了、无所谓"**。';
  }
  const user = [
    `【刚刚的动作】${who}对她做了「${action.label}」：${beat}`,
    `【做完之后的状态】体位「${position.label}」/ ${after.penetrating ? '插入中' : '未插入'} / 节奏「${paceLabelOf(after.pace)}」/ 累积 ${after.accumulation}`,
    ...(pleaLine ? [pleaLine] : []),
    recent.length > 0 ? `【最近 ${recent.length} 轮对话】\n${recent.map(line => '- ' + line).join('\n')}` : '【最近对话】（无）',
    '',
    '请按上面的 JSON 格式输出她这一下的反应。',
  ].join('\n');

  return {
    system,
    user,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    label,
    meta: {
      blocks,
      actionKey: action.key,
      pace: after.pace,
      accumulation: after.accumulation,
      penetrating: after.penetrating,
    },
  };
}

// ── 八、落库（每角色一行；服务层持有表，路由不写 SQL）─────────────────────────

const SCENE_COLUMNS = `character_id, active, penetrating, position_key, act_key, pace, auto_pace, accumulation,
  climax_count, rounds, action_seq, bondage, auto_thrust, denial, pending_note, started_at, last_action_at, updated_at`;

function rowToState(row, characterId) {
  return normalizeSceneState(row, characterId);
}

/**
 * 读进行中状态（没有行 = 空状态）。读库失败只 warn 并回落空状态：这是玩法状态，
 * 绝不能因为一行读不出来把接口打 500（与 touchEventStore 的容错取向一致）。
 */
export function getIntimateScene(characterId) {
  const id = Number(characterId) || 0;
  if (id <= 0) return emptySceneState(0);
  try {
    const row = getDb().prepare(
      `SELECT ${SCENE_COLUMNS} FROM character_intimate_scene WHERE character_id = ?`
    ).get(id);
    return rowToState(row, id);
  } catch (err) {
    console.warn('[intimate-action] 读取进行中状态失败（按未开始处理）:', err?.message || err);
    return emptySceneState(id);
  }
}

/**
 * 写入进行中状态（UPSERT）。`startedAt` 只在第一次进入时落，之后不动（持续时间口径）。
 * @returns {object} 落库后的状态
 */
export function saveIntimateScene(characterId, state, { now = null } = {}) {
  const id = Number(characterId) || 0;
  const current = normalizeSceneState(state, id);
  const db = getDb();
  db.prepare(
    `INSERT INTO character_intimate_scene
       (${SCENE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(character_id) DO UPDATE SET
       active = excluded.active,
       penetrating = excluded.penetrating,
       position_key = excluded.position_key,
       act_key = excluded.act_key,
       pace = excluded.pace,
       auto_pace = excluded.auto_pace,
       accumulation = excluded.accumulation,
       climax_count = excluded.climax_count,
       rounds = excluded.rounds,
       action_seq = excluded.action_seq,
       bondage = excluded.bondage,
       auto_thrust = excluded.auto_thrust,
       denial = excluded.denial,
       pending_note = excluded.pending_note,
       started_at = excluded.started_at,
       last_action_at = excluded.last_action_at,
       updated_at = datetime('now')`
  ).run(
    id,
    current.active ? 1 : 0,
    current.penetrating ? 1 : 0,
    current.positionKey,
    current.actKey,
    current.pace,
    current.autoPace,
    current.accumulation,
    current.climaxCount,
    current.rounds,
    current.actionSeq,
    // ⚠️ 位掩码必须**原样**落库（写成 `? 1 : 0` 会把分型捆绑压回"只捆了手腕"）
    clampInt(current.bondage, 0, 31, 0),
    current.autoThrust ? 1 : 0,
    current.denial ? 1 : 0,
    current.pendingNote,
    current.startedAt || now || null,
    current.lastActionAt || now || null,
  );
  return getIntimateScene(id);
}

/**
 * 只改"补演备注"这一列（**不要**用它去整行覆盖）。
 *
 * ⚠️ 2026-10-03 复查抓到的丢写：路由在等 LLM 反应那几秒里会再 `saveIntimateScene(id, {...persisted})`
 * 把**整行**写回去（为了清 pendingNote），而 `persisted` 是 await **之前**的快照 ——
 * 这期间服务端 ticker（自动插入的状态跳，冲刺档 1.5 秒一下）推进的累积、`rounds`、`action_seq`
 * 会被整行回滚掉。`action_seq` 回滚更麻烦：它是记账幂等锚点
 * （`intimateAction:<角色>:<seq>:<actKey>`，见 recordIntimateActs）⇒ 下一次动作复用同一个 seq 时，
 * 看板那一笔会被当成"重放"**静默丢掉**（用户看到的正是"次数有时候不加"这种玄学）。
 * ⇒ 凡是"只为了改一个字段"的回写，都用这里的定向 UPDATE，别再整行 upsert。
 */
export function patchIntimateScene(characterId, { pendingNote } = {}) {
  const id = Number(characterId) || 0;
  if (id <= 0) return getIntimateScene(id);
  try {
    if (pendingNote !== undefined) {
      getDb().prepare('UPDATE character_intimate_scene SET pending_note = ?, updated_at = datetime(\'now\') WHERE character_id = ?')
        .run(str(pendingNote, 200), id);
    }
  } catch (err) {
    console.warn('[intimate-action] 更新补演备注失败（不影响这一下）:', err?.message || err);
  }
  return getIntimateScene(id);
}

/**
 * 收场：清掉进行中状态（用户点「结束」/ 场景自然结束 / 空闲超时都用它）。
 *
 * 口径：
 *   · `active/penetrating/accumulation/rounds/climax_count` 一律归零、`started_at` 清空
 *     —— 下一场从干净状态开始，不会出现"隔夜还插着、还显示昨晚推进了 12 下"；
 *   · **`action_seq` 刻意不清零**：它是记账幂等锚点 `intimateAction:<角色>:<seq>:<actKey>`
 *     的一部分，清零会让新一场的第一笔和上一场撞 uid 而被静默丢掉（看板漏记）。
 *   · `position_key` 保留：那是"她最后被摆成的姿势"，下一场点体位/进入时会被覆盖，
 *     留着不会造成前后矛盾（active=false 时 prompt 块是零注入）。
 */
export function clearIntimateScene(characterId) {
  const id = Number(characterId) || 0;
  if (id <= 0) return emptySceneState(0);
  // ⚠️ 收场**故意不清 `denial`（禁止高潮）与 `bondage`（捆绑）**：
  //    用户 2026-10-02 把这条玩法的核心说得很清楚 ——「让角色知道自己一直敏感 但是无法高潮 被我控制」，
  //    它是**一条持续生效的控制**，不是"这一场"的临时状态；只有用户手动解开才结束。
  //    而 `auto_thrust` 跟着这一场走（没有插入就没有"自动插入"这回事）⇒ 收场时清掉。
  try {
    getDb().prepare(
      `UPDATE character_intimate_scene
          SET active = 0, penetrating = 0, pace = ?, accumulation = 0, climax_count = 0, rounds = 0,
              auto_thrust = 0,
              pending_note = '', started_at = NULL, updated_at = datetime('now')
        WHERE character_id = ?`
    ).run(DEFAULT_PACE, id);
  } catch (err) {
    console.warn('[intimate-action] 收场失败:', err?.message || err);
  }
  return getIntimateScene(id);
}

/**
 * 空闲超时收场（GET / POST 入口顺手调一次，与 touch 的过期清扫同款做法）。
 * 口径：最后一次推进超过 SCENE_IDLE_TTL_MS 就当她早就歇下了 —— 重启后仍在进行中是真的，
 * 但隔了一夜还「插着」就是前后矛盾。
 * @returns {{closed:boolean, state:object}}
 */
export function expireIdleScene(characterId, { now = Date.now() } = {}) {
  const state = getIntimateScene(characterId);
  if (!state.active) return { closed: false, state };
  // 时间串是 SQLite 的无时区 UTC（`2026-09-28 05:55:59`）→ 一律走 parseSqlUtc，别手搓日期
  const parsed = parseSqlUtc(state.lastActionAt);
  const at = parsed ? parsed.getTime() : 0;
  if (!Number.isFinite(at) || at <= 0) return { closed: false, state };
  if (Number(now) - at <= SCENE_IDLE_TTL_MS) return { closed: false, state };
  return { closed: true, state: clearIntimateScene(characterId) };
}

// ── 九、路由用的聚合入口 ─────────────────────────────────────────────────────

/**
 * 面板一次读取所需的全部只读信息（**不写库**）：状态 + 她的状态 + 体位清单 + 动作可用性。
 * 可用性判定复用 planIntimateAction（点一次会怎么答，这里就先算一遍），
 * 所以前端的置灰理由与后端真正拒绝的理由**永远是同一句话**。
 */
export function buildPanelSnapshot(state, { affinity = 0, affinityText = '', emotionText = '', hypnotized = false, sleeping = false, enabled = true, sensitivity = 1, sensitivityInfo = null } = {}) {
  const current = normalizeSceneState(state, state?.characterId);
  const position = describePosition(current.positionKey);
  const tier = accumulationTier(current.accumulation);
  // 她自己的敏感度要喂进预演：否则「一起到」的可用性会按固定 60 算 ⇒ 极度敏感的她（门槛 45）
  // 在 50 的时候按钮是灰的、但真点下去服务端会放行（"按钮骗人"是用户报过的那类 bug）。
  const sens = sensMul(sensitivity);
  const actions = INTIMATE_ACTIONS.map(action => {
    const probe = planIntimateAction(current, {
      actionKey: action.key,
      // 「换姿势」不带目标体位时按"维持当前体位"预演（无条件拒绝即可）；不这样做会把换姿势误判成不可用
      positionKey: action.key === 'position' ? current.positionKey : '',
      affinity,
      hypnotized,
      sensitivity: sens,
    });
    return {
      key: action.key,
      label: action.label,
      hint: action.hint,
      tone: action.tone || '',
      available: probe.ok,
      reason: probe.ok ? '' : probe.message,
      code: probe.ok ? 'ok' : probe.code,
    };
  });
  return {
    enabled,
    state: {
      active: current.active,
      penetrating: current.penetrating,
      positionKey: current.positionKey,
      positionLabel: position.label,
      actKey: current.actKey,
      pace: current.pace,
      paceLabel: paceLabelOf(current.pace),
      accumulation: current.accumulation,
      accumulationTier: tier.key,
      accumulationLabel: tier.label,
      climaxCount: current.climaxCount,
      rounds: current.rounds,
      // 2026-10-02 四件新玩法的开关态：**必须投影出去**，否则前端看不到"此刻是绑着 / 他在自动插送 / 不许她到"
      // （第一次做的时候漏了这三个字段 —— 行为全对、但面板与手机上的开关显示不出来，是真链路验证抓到的）
      bondage: current.bondage > 0,
      // 分型捆绑：哪几处被绑住（面板据此让"捆手/龟甲缚/束脚/全身束/口球"各自显示选中态）
      bonds: Object.fromEntries(listBonds(current.bondage).map(k => [k, true])),
      bondLabels: listBonds(current.bondage).map(k => BONDAGE_LABELS[k]),
      bondageMultiplier: bondageMultiplier(current.bondage),
      autoThrust: current.autoThrust === 1,
      // 自动速度（2026-10-03 独立旋钮）：面板据此显示页签选中态与"多久一下"
      autoPace: current.autoPace,
      autoPaceLabel: paceLabelOf(current.autoPace),
      autoIntervalMs: intervalForAutoPace(current.autoPace),
      autoTickGain: autoTickGain(current.autoPace),
      denial: current.denial === 1,
      denialPeak: current.denial === 1 ? current.accumulation : 0,
      // 她这一场「一起到」的门槛（随敏感度浮动：45~60）—— 面板据此显示"还差多少"，别写死 60
      climaxThreshold: climaxThreshold(sens),
      startedAt: current.startedAt,
      lastActionAt: current.lastActionAt,
    },
    her: {
      affinity: Number(affinity) || 0,
      affinityText: String(affinityText || ''),
      emotionText: String(emotionText || ''),
      hypnotized: Boolean(hypnotized),
      sleeping: Boolean(sleeping),
      edge: current.accumulation >= EDGE_THRESHOLD,
      overload: current.accumulation >= OVERLOAD_THRESHOLD,
      // 她的敏感度（2026-10-02）：面板要能显示"她现在有多敏感"以及这一场的高潮门槛。
      // ⚠️ 2026-10-03：**保留一位小数** —— 一次推进只涨 0.5，取整后玩家看到的永远是同一个数
      //   （真机反馈「性爱并没有增加敏感度」有一半是这么来的）。一位小数既看得见在动，也不至于糊成一片。
      sensitivity: {
        value: Math.round((Number(sensitivityInfo?.value) || 0) * 10) / 10,
        tier: sensitivityInfo?.tier?.key || '',
        tierLabel: sensitivityInfo?.tier?.label || '',
        multiplier: sens,
        heat: sensitivityInfo?.heat === true,
        climaxStrength: climaxStrength(sens),
      },
    },
    position: { ...position },
    positionOptions: listPositionOptions(),
    paceLevels: PACE_LEVELS.map(p => ({ ...p })),
    actions,
  };
}
