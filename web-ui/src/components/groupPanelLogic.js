/**
 * 群聊里的「🧸 玩具 / ❤ 推进」入口逻辑（2026-10-02 用户：「群聊里也没有动作系统和玩具 性爱系统的按钮」）
 *
 * 群聊与私聊的关键差别：**群里有很多人**，而这两个面板一次只能作用于一个人
 * （私聊里 `:character-id` 就是当前会话角色，群里必须由用户先指定"对谁"）。
 *
 * 所以把"该不该打开、打开谁"抽成纯函数放在这里 —— 视图只负责调它、把 id 喂给面板：
 *   · 没选目标 ⇒ 返回一句人话，**不打开面板、也不默认拿第一个群成员**（用户明确要求：不要默默无反应）；
 *   · 选的人已经不在当前群里（换群 / 退群）⇒ 同样拒绝，并提示重选；
 *   · 选好了 ⇒ 返回那个人 id，调用方拿去传 `:character-id`。
 *
 * ⚠️ 为什么不在视图里内联判断：这几条口径（尤其是"绝不默认第一个成员"）要靠测试钉住，
 *    而 SFC 里的内联逻辑测不到 —— 纯函数才能"钉行为"而不是"钉源码里有没有某一行"。
 */

export const GROUP_PANEL_HINTS = Object.freeze({
  noMembers: '这个群里还没有成员',
  noTarget: '先在「✋ 动作」里选一个人，再开玩具 / 推进面板',
  gone: '你选的那个人已经不在这个群里了，重新选一个吧',
})

/**
 * 判断能不能为当前选中的群成员打开面板。
 *
 * @param {{ targetId?: number|string|null, members?: Array<{id:number|string, display_name?:string}> }} input
 * @returns {{ ok:true, characterId:number|string, name:string }
 *          | { ok:false, code:'no_members'|'no_target'|'target_gone', message:string }}
 */
export function resolveGroupPanelTarget({ targetId = null, members = [] } = {}) {
  const list = Array.isArray(members) ? members : []
  if (list.length === 0) {
    return { ok: false, code: 'no_members', message: GROUP_PANEL_HINTS.noMembers }
  }
  // 只在"确实没选"时提示 —— 注意这里**故意**不回落到 list[0]：
  // 默认第一个人会让用户以为"点一下就能玩"，实际作用在别人身上，是更难查的错。
  if (targetId === null || targetId === undefined || targetId === '') {
    return { ok: false, code: 'no_target', message: GROUP_PANEL_HINTS.noTarget }
  }
  const hit = list.find((m) => String(m?.id) === String(targetId))
  if (!hit) {
    return { ok: false, code: 'target_gone', message: GROUP_PANEL_HINTS.gone }
  }
  return {
    ok: true,
    characterId: hit.id,
    name: String(hit.display_name || '').trim(),
  }
}

/** 两个入口的文案（供视图与测试共用，避免两处各写一份） */
export const GROUP_PANEL_META = Object.freeze({
  toy: {
    key: 'toy',
    ariaLabel: '玩具',
    titleClosed: '玩具（先选一个人）',
    titleOpen: '收起玩具面板',
  },
  intimate: {
    key: 'intimate',
    ariaLabel: '推进',
    titleClosed: '推进（继续抽插 / 加速 / 换姿势）（先选一个人）',
    titleOpen: '收起推进面板',
  },
})
