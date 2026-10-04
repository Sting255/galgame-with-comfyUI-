/**
 * 私聊 prompt 里催眠块的**位置**与长度条冲突回归（task-42）
 *
 * 真机反馈：「催眠之后也没有完全听命」。
 * 根因（日志实证 完整/backend-2026-09-29.log）：状态块原先排在亲密档案之后，后面还压着
 * user_portrait / reply_length / 情绪 / 聊天历史 / 风格 / 奇遇 / RAG —— 尤其
 * <reply_length>10~60字 会把「演完整」直接切短。
 * 口径：催眠是本轮最硬的约束 ⇒ 整块后置；完全控制 / 强制高潮轮追加长度豁免。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chatSource = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');

test('C1 催眠块攒进独立容器，不再就地 push 进 dynamicBlocks', () => {
  assert.ok(chatSource.includes('const hypnosisBlocks = [];'), '需要独立的 hypnosisBlocks 容器');
  for (const line of [
    'if (stateBlock) hypnosisBlocks.push(stateBlock);',
    'if (directiveBlock) hypnosisBlocks.push(directiveBlock);',
    'if (amnesiaBlock) hypnosisBlocks.push(amnesiaBlock);',
  ]) {
    assert.ok(chatSource.includes(line), `应改为推进 hypnosisBlocks：${line}`);
  }
});

test('C2 催眠块整块后置：排在所有其它动态块之后（含 user_portrait / reply_length / attitude_reminder）', () => {
  const deferAt = chatSource.indexOf('dynamicBlocks.push(...hypnosisBlocks);');
  assert.ok(deferAt > 0, '缺少后置 push');
  for (const marker of ['<user_portrait>', '<reply_length>', '<attitude_reminder>']) {
    const at = chatSource.indexOf(marker);
    assert.ok(at > 0, `找不到 ${marker}`);
    assert.ok(deferAt > at, `催眠块必须排在 ${marker} 之后（现在是前）`);
  }
  assert.ok(chatSource.includes('if (hypnosisBlocks.length > 0) {'), '没有催眠内容时不得多注入任何东西');
});

test('C3 完全控制 / 强制高潮轮追加长度豁免，其它轮次不受影响', () => {
  assert.ok(chatSource.includes('let hypnosisNeedsFullPerformance = false;'), '需要这个开关且默认关');
  assert.ok(chatSource.includes("if (directive === 'forced_climax') hypnosisNeedsFullPerformance = true;"), '强制高潮轮要开');
  assert.ok(chatSource.includes('!hypnoState.mindAwake) hypnosisNeedsFullPerformance = true;'), '完全控制（mindAwake=false）也要开');
  assert.ok(chatSource.includes('<reply_length_override>'), '要有长度豁免块');
  assert.ok(chatSource.includes('if (hypnosisNeedsFullPerformance) {'), '豁免必须有开关守卫');
});
