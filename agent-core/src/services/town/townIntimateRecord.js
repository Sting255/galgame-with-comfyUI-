/**
 * 镇民奇遇 → 亲密看板记账
 *
 * 为什么单独有这个模块（而不是复用 eventGenerator 的记账）：
 *   镇民奇遇落在 **town_npc_events** 表，走的是 townNpcEventGenerator 自己的
 *   开场 → 分支 → 结局链路，**不会**经过 character_events 的 concludeEvent，
 *   所以角色奇遇那套收尾记账覆盖不到镇民奇遇 —— 结果是面板里「小镇NPC」这个
 *   统计口径永远为空（死开关）。
 *
 * 归因规则（只认确定性信息，不猜）：
 *   · 只有"已关联酒馆角色"的镇民（town_npcs.character_id 非空）才有角色可归属；
 *     纯 NPC 没有 characters 行 → 直接跳过（调用方负责判空）。
 *   · 环境奇遇（两位镇民同框、玩家不在场）→ partnerKind='npc'
 *   · 常规奇遇（镇民 + 玩家同框）→ partnerKind='user'
 *   · partnerId 一律 0：画面里具体是"哪个 NPC"无法从 prompt 可靠判定，宁缺毋滥。
 *
 * 幂等：事件没有 raw_messages.id，所以用**显式 sourceUid**
 *   `town:<eventId>:<actKey>:<positionKey>`。
 *   刻意不用 raw_id 冒充（那会与 chat.js「撤回一轮」按 raw_id 删除的语义串味，
 *   导致撤回私聊时误删镇民事迹的流水）。
 *
 * 场景值复用既有的 'event'（不新增 SCENES 枚举值）：镇民奇遇与角色奇遇同属剧情场景，
 * 面板的 byScene 里合并展示更符合直觉，也避免改动冻结的枚举口径。
 *
 * 边界：本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。
 */

import { config } from '../../config.js';
import { classifyPromptTags, recordIntimateActs, tagsFromPromptString } from '../intimateService.js';

const EMPTY = Object.freeze({ inserted: 0, skipped: 0, blocked: false });

/**
 * 按镇民奇遇的画面 prompt 记一笔看板流水。
 * @param {object} params
 * @param {number|string} params.characterId 该镇民关联的酒馆角色 id（没有就不要调用）
 * @param {number|string} params.eventId     town_npc_events.id（幂等锚点）
 * @param {string} [params.prompt]           事件的生图 prompt 串（英文 tag 逗号分隔）
 * @param {'npc'|'user'} [params.partnerKind] 见文件头归因规则
 * @returns {{inserted:number, skipped:number, blocked:boolean}}
 */
export function recordIntimateForTownEvent({ characterId, eventId, prompt = '', partnerKind = 'npc' } = {}) {
  if (config.features.intimate === false) return { ...EMPTY };

  const charId = Number.parseInt(characterId, 10);
  const evId = Number.parseInt(eventId, 10);
  if (!Number.isSafeInteger(charId) || charId <= 0) return { ...EMPTY };
  if (!Number.isSafeInteger(evId) || evId <= 0) return { ...EMPTY };

  const tags = tagsFromPromptString(prompt);
  if (tags.length === 0) return { ...EMPTY };

  const classified = classifyPromptTags(tags);
  if (classified.length === 0) return { ...EMPTY };

  return recordIntimateActs(charId, {
    scene: 'event',
    partnerKind: partnerKind === 'user' ? 'user' : 'npc',
    partnerId: 0,
    rawId: 0,
    source: 'auto',
    acts: classified.map(act => ({
      ...act,
      sourceUid: `town:${evId}:${act.actKey}:${act.positionKey}`,
    })),
  });
}
