/**
 * 亲密档案注入块组装（<intimate_profile>）
 *
 * 用途：面板上的「让角色知晓这些信息」开关打开后，把该角色的身体档案、敏感带、
 * 初次里程碑与相处记录，组装成一段可注入 dynamicBlocks 的只读文本，让角色在对话里
 * 自然记得这些事。
 *
 * 关键设计：
 *   - 纯字符串组装，**只读不写库、零 LLM 调用**（零 token 之外的额外成本）。
 *   - 数据一律走 intimateService 的现有读取接口，本模块不直接碰表、不做二次统计。
 *   - 超长时按 4（相处记录）→3（初次里程碑）→2（敏感带）整段丢弃，绝不出现半截字段；
 *     连正文都放不下时返回 ''（宁可零注入，也不吐残缺档案）。
 *   - 结尾带一段反向约束：档案只用来支撑体感与反应，禁止复述数字、禁止统计口吻。
 *     （防止模型把「累计约 16 次」原样说出口，把私聊变成数据汇报。）
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { getBodyProfile, listFirsts, getIntimateStats } from './intimateService.js';

/** 敏感带强度文案：level 1~5；0 视为未评级，不注入 */
export const ZONE_LEVEL_LABELS = Object.freeze({
  1: '轻微', 2: '一般', 3: '较强', 4: '很强', 5: '极强',
});

/** 块标签名（与 chat.js 里 <rag_memories> / <affinity_attitude> 同风格） */
export const INTIMATE_BLOCK_TAG = 'intimate_profile';

/** 结尾反向约束（冻结文案，勿改写语义；测试与验收都按原文断言） */
export const INTIMATE_TAIL_NOTICE = '以上是你的身体档案与相处记忆。提及它们时用体感与反应表达，禁止复述具体数字、禁止统计口吻（如「我们做过 16 次」），也不要主动把档案当成话题清单背诵。';

/** 默认长度预算（含首尾标签与结尾约束） */
export const DEFAULT_MAX_CHARS = 600;

const MAX_ZONES = 5;
const MAX_FIRSTS = 6;
const MAX_POSITIONS = 3;
const NOTE_PREFIX = '备注：';

/** 超长时的整段丢弃顺序：4 相处记录 → 3 初次里程碑 → 2 敏感带（1 身体档案要点永远保留到最后） */
const DROP_ORDER = ['stats', 'firsts', 'zones'];

const text = (value, max = 0) => {
  const s = String(value ?? '').trim();
  return max > 0 ? s.slice(0, max) : s;
};

/** 日期只保留到「天」；非标准格式则原样截断，避免注入一长串时间戳 */
function formatDate(value) {
  const raw = text(value, 40);
  if (!raw) return '';
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : raw.slice(0, 16);
}

/** 1 身体档案要点：指标行（仅非空项）+ 备注行 */
function formatBodyLines(profile) {
  const lines = [];
  const dims = [];
  if (text(profile?.height)) dims.push(`身高 ${text(profile.height)}`);
  // 三围齐全时合成一项，缺项时退化为单项标签，保证不出现「-」占位的空字段
  const three = [text(profile?.bust), text(profile?.waist), text(profile?.hip)];
  if (three.every(Boolean)) {
    dims.push(`三围 ${three.join('-')}`);
  } else {
    if (three[0]) dims.push(`胸围 ${three[0]}`);
    if (three[1]) dims.push(`腰围 ${three[1]}`);
    if (three[2]) dims.push(`臀围 ${three[2]}`);
  }
  if (text(profile?.cup, 12)) dims.push(`罩杯 ${text(profile.cup, 12)}`);
  if (dims.length) lines.push(`身体：${dims.join('，')}`);

  const note = text(profile?.note, 300);
  if (note) lines.push(`${NOTE_PREFIX}${note}`);
  return lines;
}

/** 2 敏感带：level 高的排前面，取前 5 个；level 0（未评级）不注入 */
function formatZonesLine(zones) {
  const items = (Array.isArray(zones) ? zones : [])
    .map(z => ({
      label: text(z?.label, 24) || text(z?.key, 32),
      level: Number.parseInt(z?.level, 10),
    }))
    .filter(z => z.label && Number.isInteger(z.level) && z.level >= 1 && z.level <= 5)
    .sort((a, b) => b.level - a.level) // 同强度保持面板里的原始顺序（Array#sort 稳定）
    .slice(0, MAX_ZONES)
    .map(z => `${z.label}(${ZONE_LEVEL_LABELS[z.level]})`);
  return items.length ? `敏感带：${items.join('、')}` : '';
}

/** 3 初次里程碑：只取有日期的，最多 6 条 */
function formatFirstsLine(firsts) {
  const items = (Array.isArray(firsts) ? firsts : [])
    .map(f => ({
      label: text(f?.label, 24) || text(f?.actKey, 48),
      date: formatDate(f?.firstAt),
    }))
    .filter(f => f.label && f.date)
    .slice(0, MAX_FIRSTS)
    .map(f => `${f.label} ${f.date}`);
  return items.length ? `初次：${items.join('；')}` : '';
}

/**
 * 4 相处记录：粗粒度（累计约 N 次 / 高潮约 N 次）+ Top3 体位。
 * 刻意不给每个体位的次数——数字越细，模型越容易在对话里复述出来。
 */
function formatStatsLine(stats, chatUserName) {
  const totalActs = Number(stats?.totalActs) || 0;
  if (totalActs <= 0) return '';
  const who = chatUserName ? `与${chatUserName}` : '';
  const parts = [`${who}累计约 ${totalActs} 次`];
  const totalClimax = Number(stats?.totalClimax) || 0;
  if (totalClimax > 0) parts.push(`高潮约 ${totalClimax} 次`);

  const positions = (Array.isArray(stats?.byPosition) ? stats.byPosition : [])
    .map(p => ({ label: text(p?.label, 40) || text(p?.positionKey, 120), count: Number(p?.count) || 0 }))
    .filter(p => p.label && p.count > 0)
    .slice(0, MAX_POSITIONS)
    .map(p => p.label);
  if (positions.length) parts.push(`常见体位：${positions.join('、')}`);

  return `相处：${parts.join('，')}`;
}

/**
 * 收集四段内容。开关关闭时返回 null（调用方据此零注入）。
 * @returns {Array<{key:string, lines:string[]}>|null}
 */
function collectSections(characterId, chatUserName) {
  const profile = getBodyProfile(characterId);
  if (!profile?.injectEnabled) return null;
  return [
    { key: 'body', lines: formatBodyLines(profile) },
    { key: 'zones', lines: [formatZonesLine(profile.sensitiveZones)].filter(Boolean) },
    { key: 'firsts', lines: [formatFirstsLine(listFirsts(characterId))].filter(Boolean) },
    { key: 'stats', lines: [formatStatsLine(getIntimateStats(characterId), chatUserName)].filter(Boolean) },
  ];
}

/** 首行开标签、末行闭标签，中间每段一行 */
function renderBlock(sections) {
  return [
    `<${INTIMATE_BLOCK_TAG}>`,
    ...sections.flatMap(s => s.lines),
    INTIMATE_TAIL_NOTICE,
    `</${INTIMATE_BLOCK_TAG}>`,
  ].join('\n');
}

const dropSection = (sections, key) => sections.filter(s => s.key !== key);
const dropNoteLine = sections => sections.map(s => (
  s.key === 'body' ? { key: s.key, lines: s.lines.filter(line => !line.startsWith(NOTE_PREFIX)) } : s
));

function normalizeBudget(maxChars) {
  const n = Number(maxChars);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.floor(n);
}

/**
 * 组装注入块。
 * @param {number} characterId
 * @param {{chatUserName?:string, maxChars?:number}} [options]
 * @returns {string} 开关关闭 / 档案为空 / 无可用内容 / 预算放不下时返回 ''（调用方据此不 push）
 */
export function buildIntimateProfileBlock(characterId, { chatUserName = '', maxChars = DEFAULT_MAX_CHARS } = {}) {
  const budget = normalizeBudget(maxChars);
  const collected = collectSections(characterId, chatUserName);
  if (!collected) return '';

  let sections = collected.filter(s => s.lines.length > 0);
  if (sections.length === 0) return ''; // 档案为空：零注入

  // 超长先整段丢弃（4→3→2）；每丢一段重新量长，避免多丢
  for (const key of DROP_ORDER) {
    if (renderBlock(sections).length <= budget) break;
    sections = dropSection(sections, key);
  }
  // 仍超长：备注是自成一行、可整行丢弃的补充信息（不是半截字段）
  if (renderBlock(sections).length > budget) sections = dropNoteLine(sections);
  // 连基本正文都放不下：宁可零注入，也不注入残缺档案
  if (sections.length === 0 || renderBlock(sections).length > budget) return '';

  return renderBlock(sections);
}

/**
 * 是否需要为该角色注入档案：开关打开且确实拼得出内容（与 buildIntimateProfileBlock 同口径）。
 * 调用方可以只用 buildIntimateProfileBlock 判空，这个入口是给「先判断再决定是否组装」的场景。
 * @returns {boolean}
 */
export function shouldInjectIntimate(characterId) {
  return buildIntimateProfileBlock(characterId) !== '';
}
