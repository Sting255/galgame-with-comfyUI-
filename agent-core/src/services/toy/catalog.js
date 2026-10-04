/**
 * services/toy/catalog.js —— 玩具**第二批清单**（不同部位 / 不同刺激类型）
 *
 * 口径（2026-10-02，用户原话「玩具玩法有点太少了」）：
 *   · 首期 5 件（`vibe_egg` / `vibe_stick` / `anal_plug` / `nipple_clamp` / `collar`）**留在
 *     `toyService.js` 的 TOYS 里不动** —— `TOY_KEYS` 的顺序与内容已被既有测试逐项钉住
 *     （`test/toyService.test.js` ①、`test/toyRoutes.test.js` ②、`test/hypnosisForceToy.test.js` 全玩具巡检），
 *     改它等于把旧链路一起改红。所以**新增走这里**，合并入口是 `toyService.getToy / listToys / listAllToys`。
 *   · 每件必须写全四个字段（缺一件 UI 与正文就会各说各话）：
 *       `part`      —— 佩戴部位（中文，正文与面板都直接显示）
 *       `maxIntensity` —— 强度上限（0 = 无档位，如项圈）
 *       `stimulus`  —— 刺激类型 key（见 STIMULUS_KINDS，决定「强度」在正文里是什么东西）
 *       `effect`    —— **正文效果语义**：这一段就是"她要怎么演"的收口点，别在别处再写一遍
 *   · `intensityKind` 保留给首期 5 件做兼容（旧值 vibration / clamp / symbolic），
 *     新件一律用 `stimulus`，`stimulusOf()` 把两者归一。
 *   · 门控档（level / gateActionKey / requiresIntimateAuth）**照抄首期口径**：
 *     成人向（Lv3/Lv4）既要好感/誓约，又要亲密看板授权；门控实现仍在 `toyService.gateToy`
 *     委派 `touchActionService.getTouchGate`，本文件**不复制门槛数字**。
 */

/** 刺激类型：决定「强度」在正文里对应什么身体感受（不是装饰字段，prompt 直接引用） */
export const STIMULUS_KINDS = Object.freeze({
  vibration: Object.freeze({
    key: 'vibration', label: '震动',
    howToWrite: '强度就是震动档位：档位越高，震得越密越狠，写她语尾发抖、腰腿绷紧的程度',
  }),
  suction: Object.freeze({
    key: 'suction', label: '吸吮',
    howToWrite: '强度就是吸吮负压：档位越高，含得越紧、嘬得越急，写她被吸得小腹发紧、声音被截断',
  }),
  beads: Object.freeze({
    key: 'beads', label: '串珠',
    howToWrite: '强度就是推进的颗数：档位越高，进去的珠子越多、撑开感越明显，写她数着"又一颗"屏住呼吸',
  }),
  clamp: Object.freeze({
    key: 'clamp', label: '夹持',
    howToWrite: '强度就是夹紧的力度：档位越高夹得越疼越麻，写她不敢乱动、任何姿势变化都变成二次刺激',
  }),
  symbolic: Object.freeze({
    key: 'symbolic', label: '象征',
    howToWrite: '没有强度档：它靠"戴着"这件事本身起作用，写她的心理反应而不是生理刺激',
  }),
});

export const STIMULUS_KEYS = Object.freeze(Object.keys(STIMULUS_KINDS));

/** 第二批（2026-10-02）：6 件，按部位/刺激类型铺开 */
export const EXTRA_TOYS = Object.freeze({
  clit_sucker: Object.freeze({
    key: 'clit_sucker', label: '吸吮器', part: '阴蒂',
    partSection: '阴蒂（吸口整个含住）',
    maxIntensity: 5, level: 4, gateActionKey: 'touch_clit',
    requiresIntimateAuth: true, stimulus: 'suction', daring: 4,
    desc: '带吸口的小机器，靠负压把阴蒂整个含住反复嘬吸',
    effect: '负压吸住阴蒂不停嘬，快感是"被含住"而不是"被震"：写她小腹一下一下发紧、脚尖绷直、气音被吸断',
  }),
  g_spot_vibe: Object.freeze({
    key: 'g_spot_vibe', label: 'G点棒', part: '阴道前壁（G点）',
    partSection: '阴道（插入，顶端顶住前壁）',
    maxIntensity: 5, level: 4, gateActionKey: 'finger_insert',
    requiresIntimateAuth: true, stimulus: 'vibration', daring: 4,
    desc: '顶端带弧度的振动棒，专门顶在阴道前壁那处',
    effect: '酸胀感从体内往外顶：写她腰塌下去、忍不住往前迎、腿根发抖，说话变成短促的"嗯"',
  }),
  anal_beads: Object.freeze({
    key: 'anal_beads', label: '串珠', part: '后庭',
    partSection: '后庭（逐颗推入）',
    maxIntensity: 3, level: 4, gateActionKey: 'touch_pussy',
    requiresIntimateAuth: true, stimulus: 'beads', daring: 4,
    desc: '一串渐大的珠子，一颗颗推进后庭',
    effect: '每推进一颗都是一次新的撑开：写她屏住呼吸、后腰绷紧，抽出来时又一颗一颗地被撑开',
  }),
  nipple_sucker: Object.freeze({
    key: 'nipple_sucker', label: '乳尖吸吮器', part: '乳头',
    partSection: '乳头（吸口吸住）',
    maxIntensity: 3, level: 3, gateActionKey: 'touch_breast',
    requiresIntimateAuth: true, stimulus: 'suction', daring: 3,
    desc: '吸在乳尖上的小吸盘，一直含着嘬',
    effect: '乳尖被吸得发胀：写她含胸、衣料蹭到都难受，说话时下意识把手臂挡在胸前',
  }),
  chain_clamp: Object.freeze({
    key: 'chain_clamp', label: '乳链', part: '双乳',
    partSection: '双乳乳尖（左右相连的链子）',
    maxIntensity: 2, level: 3, gateActionKey: 'touch_breast',
    requiresIntimateAuth: true, stimulus: 'clamp', daring: 3,
    desc: '两只乳夹被一条短链连着，动一下就互相牵扯',
    effect: '链条把两边连在一起：写她不敢乱动、每次转头或弯腰都会扯到另一边，被迫放慢所有动作',
  }),
  thigh_vibe: Object.freeze({
    key: 'thigh_vibe', label: '大腿绑带振动器', part: '大腿内侧',
    partSection: '大腿内侧（绑带固定）',
    maxIntensity: 3, level: 3, gateActionKey: 'touch_thigh',
    requiresIntimateAuth: true, stimulus: 'vibration', daring: 2,
    desc: '绑在大腿内侧的振动器，离腿根只差一点',
    effect: '震动顺着腿根往上爬、却始终差一点到不了最里面：写她夹不紧腿、坐着不停挪动、走路时被迫放慢',
  }),
});

export const EXTRA_TOY_KEYS = Object.freeze(Object.keys(EXTRA_TOYS));

/** 刺激类型归一：新件读 `stimulus`，首期 5 件读旧字段 `intensityKind` */
export function stimulusOf(toy) {
  if (!toy) return STIMULUS_KINDS.vibration;
  const key = toy.stimulus || toy.intensityKind || 'vibration';
  return STIMULUS_KINDS[key] || STIMULUS_KINDS.vibration;
}

/**
 * 大胆度（0~5）：**只用于"她自己主动玩"时挑哪一件**（淫乱度越高越敢挑里面那几件），
 * 不参与门控 —— 门控永远只由 `touchActionService.getTouchGate` 说了算。
 */
export function daringOf(toy) {
  if (!toy) return 0;
  if (Number.isFinite(toy.daring)) return Number(toy.daring);
  const part = String(toy.part || '');
  if (/阴蒂|阴道|后庭/.test(part)) return 4;
  if (/乳头|双乳/.test(part)) return 3;
  if (/大腿/.test(part)) return 2;
  return 1;
}
