/**
 * 成人内容判定词表 · 中文口语补充回归（task-9，2026-09-29）
 *
 * 背景：真机反馈「催眠的时候如果发生性交记录到面板里」暴露的缺口是**纯口语**——
 * 她受催眠口径（"平淡、简短、直给" + <reply_length> 10~60 字）限制，露骨词落在用户那一句
 * （"你插进来""我下面已经湿了"），而 `db/imagePromptKnowledgePolicy.js` 的 `EXPLICIT_ADULT_PATTERN`
 * 旧词表全是名词化写法（性交 / 内射 / 小穴 …），这些日常口语一律判 false ⇒ 整轮漏账。
 *
 * 本文件是这张表**唯一**的回归位（生图侧与看板正文兜底共用它）：
 *   A. 正例：口语（本次补的）+ 英文 tag / 名词（回归，防止补词时把老词改坏）；
 *   B. 反例：日常语境**必须不命中**（含 lead 点名的「把电源插进去」「腿张开做拉伸」）；
 *   C. 边界：刻意不覆盖的说法——断言为 false 并写明理由，防止后人"顺手补上"造成误报；
 *   D. 联动：词表 × 催眠轮判定文本 = 看板真的记下一笔（task-8 的两半合起来才成立）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 直接抛错挡网络。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`intimate colloquial vocab fixture forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getDb, closeDb } = await import('../src/db/index.js');
const {
  containsExplicitAdultContent, EXPLICIT_ADULT_PATTERN,
} = await import('../src/db/imagePromptKnowledgePolicy.js');
const { recordUnspecifiedFromRawId } = await import('../src/services/intimateAutoRecord.js');
const { listIntimateLogs } = await import('../src/services/intimateService.js');
const { hypnotize } = await import('../src/services/hypnosisService.js');

config.dbPath = ':memory:';
after(() => closeDb());

// ── A. 正例 ────────────────────────────────────────────────────────────────

/** 本次补的中文口语（每条都对应一个真机漏账场景） */
const COLLOQUIAL_HITS = [
  // 插入类的第一人称/趋向说法（插进来 / 插进我）
  '你插进来', '我要插进来了', '插进我', '插入我里面', '插进我的身体，别停',
  // 湿润（要第一人称或衣物锚点）
  '我下面已经湿了', '我下面都湿透了', '人家下面早就湿了', '内裤湿了', '裤裆一片湿', '底裤已经湿了',
  // 最常用的那个词（旧表竟然没有）
  '做爱', '我想和你做爱',
  // 脱衣
  '把衣服脱光了', '脱光了全身', '我要脱光身子',
  // 性器官/体液的名词补充
  '肉棒', '肉茎', '蜜穴', '花穴', '菊穴', '淫穴', '淫水', '蜜液',
  // 动作
  '撸管', '抽插', '肏我', '口爆', '吞精', '舔阴', '舔穴', '顶到最深处', '顶进子宫',
  // 射
  '射在我身上', '射进我体内',
  // 道具
  '乳夹', '肛塞',
];

/** 旧词表（名词 + 英文 tag）回归：补词不许把老词改坏 */
const LEGACY_HITS = [
  '性交', '内射', '口交', '自慰', '小穴', '鸡巴', '高潮',
  '她忍不住叫了出来，高潮来得又急又猛。', '被强制带上高潮',
  '1girl, creampie, fellatio', 'nude, sex from behind, cum', 'after_sex',
];

test('A. 正例：本次补的中文口语全部命中（旧表对这些一律 false）', () => {
  const missed = COLLOQUIAL_HITS.filter(text => !containsExplicitAdultContent(text));
  assert.deepEqual(missed, [], `这些口语必须命中，实际漏了：${JSON.stringify(missed)}`);
});

test('A. 正例回归：英文 tag / 名词老词仍然命中（含 do 下划线归一化）', () => {
  const missed = LEGACY_HITS.filter(text => !containsExplicitAdultContent(text));
  assert.deepEqual(missed, [], `老词被改坏了：${JSON.stringify(missed)}`);
  // after_sex 靠 containsExplicitAdultContent 内部把 [_-] 换成空格才命中
  assert.equal(containsExplicitAdultContent('after_sex'), true);
  assert.equal(containsExplicitAdultContent('after sex'), true);
});

// ── B. 反例（日常语境不许误报） ───────────────────────────────────────────────

/** 含 lead 点名的两条：「把电源插进去」「腿张开做拉伸」 */
const DAILY_MISSES = [
  // 插：日常电器/文件语境（所以裸的「插入」「插进去」刻意不加）
  '把电源插进去', 'U盘插进去没反应', '插入表格一行', '我在给文档插入图片', '把插头插上试试',
  // 腿：正常拉伸
  '腿张开做拉伸', '把腿张开做拉伸运动', '教练让我把腿张开压筋',
  // 去/来：日常动线（所以「她去了」「我要来了」刻意不加）
  '她去了学校', '火车要来了', '我先去了', '外卖要来了',
  // 做爱 × 做爱心
  '我们一起做爱心义卖', '做个爱心卡片送老师',
  // 脱光 × 树/叶子
  '叶子都脱光了', '树上的果子掉光了', '把文件脱光是什么意思',
  // 湿 × 天气/物品
  '地湿了', '衣服湿了还没干', '桌子下面湿了', '楼下地面湿了', '我把内裤放进洗衣机了', '内衣湿了要晾',
  // 叫床 × 叫床上的孩子
  '妈妈叫床上的孩子起床',
  // 中出 × 集中出现 / 穴位 × 肉穴后穴 / 乳房（健康）
  '集中出现了一点问题', '最后穴位按一按', '肌肉穴位有点酸', '乳房胀痛要看医生',
  // 射 × 阳光
  '阳光射在她脸上', '阳光射进来',
  // 普通闲聊
  '今天天气不错，我们去河边走走吧。', '今天加班到很晚，好累', '你吃饭了吗', '明天几点开会',
];

test('B. 反例：日常语境一律不命中（宁可少加，也不要误报）', () => {
  const falsePositives = DAILY_MISSES.filter(text => containsExplicitAdultContent(text));
  assert.deepEqual(falsePositives, [], `这些日常句被误判成成人内容了：${JSON.stringify(falsePositives)}`);
});

// ── C. 边界（刻意不覆盖，断言为 false + 写明理由） ─────────────────────────────

test('C. 边界：区分不了的说法刻意不覆盖，但要**显式钉住**，不许后人顺手补', () => {
  // 裸「下面湿」会把「桌子下面湿了」一起收进来 ⇒ 只收「我/人家下面…湿」
  assert.equal(containsExplicitAdultContent('下面好湿'), false, '裸「下面湿」误报面太大，刻意不收');
  // 裸「插进去/插入」会撞「把电源插进去」「插入表格」
  assert.equal(containsExplicitAdultContent('插进去'), false, '裸「插进去」刻意不收');
  assert.equal(containsExplicitAdultContent('插入'), false, '裸「插入」刻意不收');
  // 「她去了」「我要来了」与日常动线同形
  assert.equal(containsExplicitAdultContent('她去了'), false, '「她去了」刻意不收');
  assert.equal(containsExplicitAdultContent('我要来了'), false, '「我要来了」刻意不收');
  // 「腿张开」有正常拉伸语境
  assert.equal(containsExplicitAdultContent('腿张开'), false, '「腿张开」刻意不收');
});

// ── D. 联动：词表 × 催眠轮判定文本 → 看板真的记一笔 ───────────────────────────

test('D. 联动：催眠轮里用户说口语（新词）+ 她按口径平淡回 → 看板记一笔「未归类」', () => {
  const db = getDb();
  db.prepare('INSERT INTO characters (name, display_name, base_prompt) VALUES (?, ?, ?)')
    .run('vocab_hyp', '词表角色', '测试用成年角色');
  const id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  db.prepare(
    `INSERT INTO backpack_items (name, description, effect_key, status, owner_key, source_type, collected_at)
     VALUES ('hypnosis_phone', '催眠手机', 'hypnosis_phone', 'ready', 'me', 'grant', datetime('now'))`
  ).run();
  hypnotize(id, { minutes: 30 });

  // 补词前「你插进来」判 false ⇒ 这一轮在修复前整轮零流水
  assert.equal(containsExplicitAdultContent('你插进来'), true);
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(`char_${id}`, 'user', '你插进来');
  db.prepare('INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, ?, ?)')
    .run(`char_${id}`, 'assistant', '……嗯。\n（身体照做，动作僵硬）');
  const rawId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

  const res = recordUnspecifiedFromRawId({ characterId: id, rawId });
  assert.equal(res.inserted, 1, `词表命中 + 催眠轮并入用户消息后必须记一笔，实际 ${JSON.stringify(res)}`);
  const rows = listIntimateLogs(id, { limit: 10, partnerKinds: 'all' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actKey, 'unspecified');
  assert.equal(rows[0].rawId, rawId);
  assert.equal(rows[0].scene, 'chat');
});

// ── E. 收口（源码级） ──────────────────────────────────────────────────────

test('E. 收口：词表只有一处实现，且看板走的是它（不许在 intimate 里再写一份）', () => {
  const policy = fs.readFileSync(new URL('../src/db/imagePromptKnowledgePolicy.js', import.meta.url), 'utf8');
  assert.equal((policy.match(/EXPLICIT_ADULT_PATTERN = /g) || []).length, 1, '正则只能定义一次');
  assert.match(policy, /export function containsExplicitAdultContent\(value\)/);

  const auto = fs.readFileSync(new URL('../src/services/intimateAutoRecord.js', import.meta.url), 'utf8');
  assert.match(auto, /^import \{ containsExplicitAdultContent \} from '\.\.\/db\/imagePromptKnowledgePolicy\.js';$/m,
    '看板必须复用同一份词表，不许各写一份');
  assert.ok(!/插进来|做爱/.test(auto), '词条本身不得散落在 intimate* 里');
  assert.ok(EXPLICIT_ADULT_PATTERN instanceof RegExp);
});
