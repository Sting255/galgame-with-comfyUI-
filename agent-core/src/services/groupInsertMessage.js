/**
 * 群聊「插入式发言」共享写入器 + 群成员查询（2026-10-02 抽取）
 *
 * 为什么抽出来：原本只有 `routes/touch.js` 会往群里插一条消息（群聊里摸她 → 她的反应要当众发在群里）。
 * 但亲密推进那条链**只走私聊写入器**（`writeProactiveMessage` → `char_<id>`），于是用户在群里点
 * 「进入她 / 抽插 / 捆绑」时，消息和她的反应全跑到私聊去了 —— 用户原话：
 *   「在群聊里进行点玩具和插入动作 消息会去到私聊里 这是不应该的 在哪里聊天就在哪里继续进行」
 *
 * 形状必须**逐字对齐** `services/groupChatEngine.serializeMsg()`（那是群聊页唯一认的形态，
 * `routes/groups.js` 的 emit → `web-ui/src/stores/groups.js` 的 `_enqueue`）。
 * 与其在两处各写一份（必然漂移），不如一份实现、两处调用：
 *   · 触摸链 `routes/touch.js`（source: 'touch'）
 *   · 亲密链 `routes/intimateActions.js`（source: 'intimate_action'）
 */

import { getDb } from '../db/index.js';

/**
 * 把一条发言写进群会话（raw_messages + messages 各一行）并返回广播用的 payload。
 *
 * 口径（与 touch 阶段二完全一致，勿改）：
 *   · 会话 id = `group_<gid>`；
 *   · raw 正文自带 `[名字]: ` 说话人前缀（群聊引擎同口径）；
 *   · messages 一行 = 一个气泡，`seq` 取该会话当前最大值 +1；
 *   · `speaker_character_id` 必须是**说话的那个角色**，群聊页据此渲染成她的气泡；
 *   · 附加字段（`source` / `extra`）前端会忽略未知字段，放心加。
 *
 * @param {number|string} groupId
 * @param {{id:number|string, display_name?:string, name?:string}} character 说话的角色
 * @param {string} content 正文（不要自己带 `[名字]:`，这里会加）
 * @param {{source?:string, extra?:object}} [opts]
 * @returns {{rawId:number, msgId:number, seq:number, payload:object}|null} 失败返回 null（调用方只 warn）
 */
export function writeGroupInsertMessage(groupId, character, content, { source = 'group', extra = {} } = {}) {
  try {
    const db = getDb();
    const gid = Number(groupId);
    const conversationId = `group_${gid}`;
    const speakerName = character?.display_name || character?.name || '角色';
    const text = String(content || '').trim();
    if (!text) return null;

    const rawResult = db.prepare(
      "INSERT INTO raw_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
    ).run(conversationId, `[${speakerName}]: ${text}`);
    const rawId = Number(rawResult.lastInsertRowid);

    const seqRow = db.prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM messages WHERE conversation_id = ?').get(conversationId);
    const seq = Number(seqRow?.s ?? -1) + 1;

    const msgResult = db.prepare(
      `INSERT INTO messages (conversation_id, raw_id, role, content, seq, speaker_character_id)
       VALUES (?, ?, 'assistant', ?, ?, ?)`
    ).run(conversationId, rawId, text, seq, Number(character?.id));
    const msgId = Number(msgResult.lastInsertRowid);

    return {
      rawId,
      msgId,
      seq,
      conversationId,
      payload: {
        id: msgId,
        group_id: gid,
        role: 'assistant',
        content: text,
        seq,
        speaker_character_id: Number(character?.id),
        speaker_name: speakerName,
        created_at: new Date().toISOString(),
        source,
        ...extra,
      },
    };
  } catch (err) {
    console.warn('[group-insert] 写入群消息失败（只影响这条发言，不影响动作）:', err?.message || err);
    return null;
  }
}

/** 她是不是这个群的成员（群里做动作前必须校验：否则这条发言永远没人消费） */
export function isGroupMember(groupId, characterId) {
  try {
    return Boolean(getDb().prepare(
      'SELECT 1 FROM group_members WHERE group_id = ? AND character_id = ? LIMIT 1'
    ).get(Number(groupId), Number(characterId)));
  } catch {
    return false;
  }
}

/** 群存在？ */
export function groupExists(groupId) {
  try {
    // ⚠️ 表名是 **group_chats**（不是 groups）—— 2026-10-02 真机报「这个群不存在（可能已经被删了）」：
    // 我第一版查了不存在的 `groups` 表 ⇒ 每次都判群不存在；而我的单测自己 CREATE 了一个假的
    // `groups` 表 ⇒ **假绿**。改查真表，并把测试改成用真表名（错的表名以后也会红）。
    return Boolean(getDb().prepare('SELECT 1 FROM group_chats WHERE id = ? LIMIT 1').get(Number(groupId)));
  } catch {
    return false;
  }
}

/** 群里除她以外的成员行（围观候选；调用方一般已校验过她是群成员） */
export function readGroupMemberRows(groupId) {
  try {
    return getDb().prepare(
      'SELECT c.id, c.name, c.display_name FROM group_members m JOIN characters c ON c.id = m.character_id WHERE m.group_id = ?'
    ).all(Number(groupId)) || [];
  } catch (err) {
    console.warn('[group-insert] 读取群成员失败:', err?.message || err);
    return [];
  }
}

/**
 * 解析请求里的场景参数（私聊 / 群聊）。
 *
 * 口径：**不传 = 私聊**（与改造前逐字一致，老前端不受影响）；`scene=group` 时必须带合法 `groupId`，
 * 且她必须是该群成员 —— 否则 400（"群不存在 / 她不在这个群"这类问题要在入口就说清，
 * 不能让这条发言写进一个没人看的会话）。
 *
 * @returns {{ok:true, scene:'chat'|'group', groupId:number|null, conversationId:string}
 *          | {ok:false, code:string, message:string}}
 */
export function resolveSceneTarget(req, characterId) {
  const rawScene = String(req.body?.scene ?? req.query?.scene ?? 'chat').trim();
  if (rawScene !== 'group') {
    return { ok: true, scene: 'chat', groupId: null, conversationId: `char_${characterId}` };
  }
  const groupId = Number.parseInt(String(req.body?.groupId ?? req.query?.groupId ?? ''), 10);
  if (!Number.isFinite(groupId) || groupId <= 0) {
    return { ok: false, code: 'invalid_group', message: '群聊场景必须带上合法的 groupId。' };
  }
  if (!groupExists(groupId)) {
    return { ok: false, code: 'group_not_found', message: '这个群不存在（可能已经被删了）。' };
  }
  if (!isGroupMember(groupId, characterId)) {
    return { ok: false, code: 'not_group_member', message: '她不在这个群里，换个人或者换个群吧。' };
  }
  return { ok: true, scene: 'group', groupId, conversationId: `group_${groupId}` };
}
