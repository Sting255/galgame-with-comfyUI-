/**
 * 立绘 ↔ 世界观 的一致性（2026-10-01，用户：「同步形象展示那边的立绘，需要根据现在的世界观去生成」）
 *
 * ## 问题
 * 立绘生成时**确实吃了世界观**（`characters.js` 的 `system0 = 破甲词 + 世界观`、
 * `<world_setting>` 指令、`getWorldIntegrationRule('interaction')`），所以**新生成的图是对的**。
 * 但 `characters` 表只存了 `standing_url` —— **没记录这张图是哪个世界观下生成的**：
 *   · 用户改了世界观内容（或者切到另一套世界观）⇒ 立绘静默过期，形象展示里还是旧世界的图；
 *   · 系统一无所知，既不会提示、也没法一键重生成。
 * 小镇素材那侧是靠 `town_assets.world_setting_id` 分库解决的；角色立绘是全局表，
 * 所以这里用"**签名**"记在角色行上，而不是给立绘分库（角色跨世界观共用，分库会让"换世界=立绘全空"）。
 *
 * ## 签名口径
 * `null` = 当前没有启用世界观；否则 `${worldId}:${sha1(content) 前 12 位}`。
 * 用**内容哈希**而不是 `updated_at`：内容被改但时间戳没动（脚本/迁移写库）也能认出来。
 *
 * ## 什么时候判"待同步"（isStandingStale）
 * | 情况 | 判定 | 理由 |
 * | --- | --- | --- |
 * | 没有立绘 | 不提示（`no_standing`）| 没有图可同步，提示也是噪音 |
 * | 没有世界观 | 不提示（`no_world`）| 没有"现在的世界观"这个基准，无从比对 |
 * | 立绘签名缺失（老数据）| **待同步**（`unknown`）| 生成于本机制之前，无法确认是否吻合当前世界观 |
 * | 签名一致 | 不提示（`fresh`）| |
 * | 签名不同 | **待同步**（`world_changed`）| 世界观换了/改了 |
 */

import crypto from 'node:crypto';
import { getActiveWorldSetting, getGlobalRule } from '../db/index.js';

/** 内容哈希（只取前 12 位十六进制，够区分且不占空间） */
function contentHash(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
}

/**
 * 当前世界观的签名。
 *
 * ⚠️ 两个坑（本文件第一版就踩了第一个，测试当场抓到）：
 * 1. **不能用 `getWorldSetting()`** —— 它返回的是**拼好的 prompt 串**
 *    （`<world_setting>…</world_setting>` 或 null），不是行，取不到 id/content。
 * 2. **更不能因为"防打扰模式"而变** —— `getWorldSetting()` 在防打扰时段会返回 null
 *    （那是"这段时间先不喂给模型"，不是"世界观没了"）。若拿它当基准，
 *    签名会随傍晚跳变 ⇒ 一到晚上所有立绘都被误判成"待同步"。
 *    所以这里一律走**库级行访问器**（`getActiveWorldSetting` / 旧表 `global_rules`）。
 *
 * @returns {string|null} `${worldId}:${hash}`；没有任何启用世界观时 null
 */
export function currentWorldSignature() {
  try {
    const active = getActiveWorldSetting();
    if (active && active.id !== undefined && active.id !== null) {
      const content = String(active.content || '').trim();
      // 用户主动把内容清空 = 明确选择"无世界观"，这本身也是一个可比较的基准
      return content ? `${active.id}:${contentHash(content)}` : `empty:${active.id}`;
    }
    // 兼容旧表（world_settings 无激活项时 getWorldSetting 才回退到这里）
    const legacy = getGlobalRule('world_setting');
    if (legacy?.rule_content && legacy.is_active) return `legacy:${contentHash(legacy.rule_content)}`;
    return null;
  } catch {
    // 库还没初始化 / 表不存在：按"没有世界观"处理（模块被提前 import 也不该炸）
    return null;
  }
}

/**
 * 这张立绘与当前世界观是否一致。
 * @param {{standing_url?:string|null, standing_world_sig?:string|null}} character 角色行（含两列即可）
 * @returns {{stale:boolean, reason:'fresh'|'world_changed'|'unknown'|'no_standing'|'no_world', current:string|null, recorded:string|null}}
 */
export function isStandingStale(character) {
  const current = currentWorldSignature();
  const recorded = character?.standing_world_sig ? String(character.standing_world_sig) : null;
  const hasStanding = Boolean(character?.standing_url);

  if (!hasStanding) return { stale: false, reason: 'no_standing', current, recorded };
  if (!current) return { stale: false, reason: 'no_world', current, recorded };
  if (!recorded) return { stale: true, reason: 'unknown', current, recorded };
  if (recorded === current) return { stale: false, reason: 'fresh', current, recorded };
  return { stale: true, reason: 'world_changed', current, recorded };
}

/** 给角色行补上 `standing_stale` / `standing_stale_reason` 两个下发字段（接口层用） */
export function withStandingStaleness(character) {
  if (!character || typeof character !== 'object') return character;
  const info = isStandingStale(character);
  return { ...character, standing_stale: info.stale, standing_stale_reason: info.reason };
}
