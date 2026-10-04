/**
 * 群聊催眠手机 · 面板纯逻辑单测（task-31）
 *
 * 群聊面板的结构是"先选人再动手"：
 *   · 选 1 人 = 单独使用模式（渲染私聊那套完整面板）
 *   · 选多人 = 批量模式（一次对所有人下同一条指令，逐个反馈）
 * 本文件只测不依赖 Vue 的纯函数：选人过滤、状态短文案、批量汇总、动作集合（不含遗忘）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const {
  GROUP_BATCH_ACTIONS,
  memberStateText,
  selectedMembers,
  summarizeBatch,
  hypnosisViewModel,
} = await import('../src/components/hypnosisLogic.js');

const members = [
  { id: 3, display_name: '甲' },
  { id: 7, display_name: '乙' },
  { id: 9, name: '丙' },
];

// ──────────────── 选人 ────────────────

test('selectedMembers：按 id 过滤，且保持群里的原始顺序', () => {
  assert.deepEqual(selectedMembers(members, [9, 3]).map(m => m.id), [3, 9], '应保持群内顺序而不是选择顺序');
  assert.deepEqual(selectedMembers(members, ['7']).map(m => m.id), [7], '字符串 id 也要认');
  assert.deepEqual(selectedMembers(members, []), []);
  assert.deepEqual(selectedMembers(members, [999]), []);
  assert.deepEqual(selectedMembers(null, [1]), []);
  assert.deepEqual(selectedMembers(members, null).length, 0);
});

test('selectedMembers：去重（同一 id 重复选择只算一个）', () => {
  assert.deepEqual(selectedMembers(members, [3, 3, '3']).map(m => m.id), [3]);
});

// ──────────────── 状态文案 ────────────────

test('memberStateText：未催眠 / 催眠中 / 已过期三态，读失败给占位符', () => {
  const now = Date.now();
  assert.equal(memberStateText(null, now), '…', '没状态时给占位符');
  const notHypno = hypnosisViewModel({ active: false, gate: { allowed: true } }, now);
  assert.equal(notHypno.statusText, '未催眠');
  const active = hypnosisViewModel({
    active: true, activeUntil: new Date(now + 600_000).toISOString(), bodyControlled: true, mindAwake: false, gate: { allowed: true },
  }, now);
  assert.equal(memberStateText({
    active: true, activeUntil: new Date(now + 600_000).toISOString(), bodyControlled: true, mindAwake: false, gate: { allowed: true },
  }, now), '催眠中 · 剩余 10:00');
  assert.equal(memberStateText({ active: false, gate: { allowed: true } }, now), '未催眠');
});

// ──────────────── 批量汇总 ────────────────

test('summarizeBatch：全成功 / 全失败 / 部分失败三种文案与计数', () => {
  const allOk = summarizeBatch([{ name: '甲', ok: true }, { name: '乙', ok: true }]);
  assert.deepEqual(allOk, { okCount: 2, failedCount: 0, text: '已对 2 人完成操作', failed: [] });

  const allFail = summarizeBatch([{ name: '甲', ok: false, error: '不在催眠状态' }]);
  assert.equal(allFail.okCount, 0);
  assert.equal(allFail.failedCount, 1);
  assert.match(allFail.text, /操作失败：甲（不在催眠状态）/);

  const partial = summarizeBatch([
    { name: '甲', ok: true },
    { name: '乙', ok: false, error: '不满足使用条件' },
  ]);
  assert.equal(partial.okCount, 1);
  assert.equal(partial.failedCount, 1);
  assert.match(partial.text, /已对 1 人完成，1 人失败：乙（不满足使用条件）/);
  assert.deepEqual(partial.failed, [{ name: '乙', error: '不满足使用条件' }]);
});

test('summarizeBatch：空输入与缺字段都安全', () => {
  assert.deepEqual(summarizeBatch([]), { okCount: 0, failedCount: 0, text: '', failed: [] });
  assert.deepEqual(summarizeBatch(null), { okCount: 0, failedCount: 0, text: '', failed: [] });
  const loose = summarizeBatch([{ ok: false }]);
  assert.match(loose.text, /TA（操作失败）/, '缺名字/错误文案时用兜底词');
});

// ──────────────── 动作集合 ────────────────

test('GROUP_BATCH_ACTIONS：四个动作、不含遗忘（遗忘只有单独使用模式提供）', () => {
  assert.deepEqual(GROUP_BATCH_ACTIONS.map(a => a.key), ['hypnotize', 'wake', 'wakeMind', 'forcedClimax']);
  assert.deepEqual(GROUP_BATCH_ACTIONS.map(a => a.label), ['催眠', '唤醒', '只唤醒意志', '强制高潮']);
  assert.ok(!GROUP_BATCH_ACTIONS.some(a => a.key === 'forget'), '群聊批量不应提供遗忘');
  assert.equal(GROUP_BATCH_ACTIONS[0].variant, 'primary');
});

test('群聊批量：「强制高潮」不要求催眠，面板只按 batchBusy 置灰（task-42）', async () => {
  const source = await readFile(new URL('../src/components/HypnosisPhoneGroupPanel.vue', import.meta.url), 'utf8');
  assert.ok(GROUP_BATCH_ACTIONS.some(a => a.key === 'forcedClimax'), '批量集合必须有强制高潮');
  assert.ok(!source.includes('hypnotized'), '批量面板不得按催眠态判定按钮可用性（强制高潮不需要催眠）');
  assert.ok(source.includes(':disabled="batchBusy"'), '批量按钮的禁用条件只有 batchBusy');
});
