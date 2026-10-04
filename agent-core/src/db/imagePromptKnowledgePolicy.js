/**
 * 成人内容判定（二值）：**一个正则，两个用途**——
 *   1. 生图侧合规判定（imagePromptTagKnowledgeData.js / imagePromptKnowledge.js 过滤 adult_* 类目）；
 *   2. 亲密看板「正文兜底」记账（intimateAutoRecord.recordUnspecifiedFromText）：没有可归类生图 tag 的
 *      轮次，正文命中这里就记一笔 unspecified（「未归类」）。
 *
 * 词表分两半：开头 \b(?:…)\b 那一段是生图 prompt 的**英文 tag**（按词边界匹配）；后半段是**中文**词。
 *
 * 中文口语补充（2026-09-29，task-9）：
 *   真机反馈「催眠的时候如果发生性交记录到面板里」暴露的缺口是**纯口语**：她受"平淡、简短、直给"的
 *   催眠口径限制，露骨词落在用户那一句（"你插进来""我下面已经湿了"），而旧词表全是名词化写法
 *   （性交 / 内射 / 小穴 …），这些日常口语一律判 false ⇒ 整轮漏账。
 *   补词原则：**宁可少加，也不要误报**（本词表全场景共用，误报会往看板塞假的「未归类」）。
 *   所以只加"几乎不可能出现在日常语境"的说法：
 *     · 做爱(?!心) —— 挡「做爱心 / 做爱心义卖」；
 *     · 插(?:进|入)来 / 插(?:进|入|到)(?:我|人家) —— **刻意不加裸的「插入」「插进去」**：
 *       「插入表格」「U盘插进去」「把电源插进去」全是日常用法，区分不了；
 *     · (?:我|人家)下面…湿 / (?:内裤|底裤|裤裆)…湿 —— 要求第一人称或衣物锚点，
 *       裸的「湿了」会命中「地湿了 / 衣服湿了」，刻意不加。
 *   刻意不加（同口径：区分不了就别加，交给 AI 判断 / 人工补录兜）：
 *     · 「腿张开」——「腿张开做拉伸」是正常日常句；
 *     · 「她去了」「我要来了」——与「她去了学校」「火车要来了」完全同形；
 *     · 「乳房」——健康咨询语境会误报；「中出」——「集中出现」；「叫床」——「叫床上的孩子起床」；
 *       「肉穴」——「肌肉穴位」；「后穴」——「最后穴位」。
 *   改这张表要连带回归两处：生图侧（imagePromptTagKnowledgeData）与看板正文兜底
 *   （agent-core/test/intimateColloquialVocab.test.js 钉了正例 / 反例）。
 */
export const EXPLICIT_ADULT_PATTERN = /(?:\b(?:nsfw|nude|naked|sex|sexual|after sex|fucked silly|orgasm|ahegao|in heat|penis|testicle|erection|flaccid|foreskin|precum|futanari|cock|dick|pussy|vagina|vaginal|clitoris|labia|anus|anal|fellatio|blowjob|deepthroat|irrumatio|masturbat\w*|fingering|vibrator|dildo|handjob|footjob|paizuri|titjob|cum|bukkake|ejaculat\w*|semen|bondage|bdsm|rape|crotchless|no panties|bottomless|topless|nipple|areola|pubic hair|cameltoe|groping|grope|moan(?:ing)?|ass grab|butt grab|grabbing breasts?|doggystyle|cowgirl|missionary|mating press|spitroast|gangbang|orgy|threesome|creampie|facesitting|pegging|cunnilingus|anilingus|fisting)\b|色情|性爱|性交|裸体|全裸|事后|发情|高潮|阿黑颜|阴部|阴唇|阴蒂|阴茎|睾丸|龟头|阴道|肛门|肛交|口交|深喉|自慰|手淫|跳蛋|射精|精液|颜射|内射|束缚|调教|强奸|扶她|无内裤|露乳|乳头|乳晕|软牛子|抓着屁股|抓着乳房|后入|骑乘|狗爬式|乳交|足交|手交|屁眼|鸡巴|潮吹|爱液|M字|妹汁|精液|小穴|奶子|做爱(?!心)|肉棒|肉茎|肉刃|蜜穴|花穴|菊穴|淫穴|淫水|蜜液|撸管|抽插|肏|口爆|吞精|乳夹|肛塞|舔(?:阴|穴|小穴|阴部)|插(?:进|入)来|插(?:进|入|到)(?:我|人家)|顶(?:到|进)(?:最深处|子宫|宫口|花心)|射(?:在|进)(?:我|人家|体内|身体|身上)|(?:我|人家)下面(?:都|已经|早|就|好|很|快|全|也|有点|一直|还|的)*?(?:湿|流水)|(?:内裤|底裤|裤裆)(?:都|已经|早|就|好|很|快|全|也|有点|一直|还|一片|一片都|全都)*?湿|脱光(?:了)?(?:自己|衣服|全身|身子)|(?:自己|衣服|全身|身子)脱光(?:了)?)/i;

export function containsExplicitAdultContent(value) {
  return EXPLICIT_ADULT_PATTERN.test(String(value || '').replace(/[_-]+/g, ' '));
}
