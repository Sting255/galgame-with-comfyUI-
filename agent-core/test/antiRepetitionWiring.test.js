/**
 * 反重复接线的 TDZ 回归（2026-09-30，真机 E2E 抓到）
 *
 * 现象：后端日志每轮一条
 *   [anti-repetition] detection failed: Cannot access 'hypnosisNeedsFullPerformance' before initialization
 * 且**没有任何 mode= 行** ⇒ 反重复块一个都没注入（异常被 catch 吞掉），功能等于没上。
 * 纯函数单测测不到这种**接线期**错误 —— 这正是真机 E2E 的价值。
 *
 * 根因：反重复块在 hypnosisActive: 里引用了 hypnosisNeedsFullPerformance，
 * 而它是在**后面的催眠块**才 let 声明的 ⇒ TDZ。
 * 修法：反重复块自己读一次催眠状态（口径 active && bodyControlled && !mindAwake）。
 *
 * 本文件是**源码级**守卫（真跑 chat 管线成本过高）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/routes/chat.js', import.meta.url), 'utf8');

test('反重复块不得把催眠块的变量当值用（TDZ）', () => {
  const antiRepAt = source.indexOf('buildAntiRepetitionInjection({');
  assert.ok(antiRepAt > 0, '找不到反重复检测调用');
  const declAt = source.indexOf('let hypnosisNeedsFullPerformance = false;');
  assert.ok(declAt > 0, '找不到 hypnosisNeedsFullPerformance 的声明');
  assert.ok(antiRepAt < declAt, '前提：反重复块确实排在催眠块之前（否则本守卫无意义）');
  assert.ok(
    !source.includes('hypnosisActive: hypnosisNeedsFullPerformance'),
    '又把这句写回去了 —— 会抛 TDZ（真机踩过，别再犯）',
  );
});

test('反重复块改为自己读催眠状态，口径与催眠块一致', () => {
  assert.ok(source.includes('let antiRepHypnosisActive = false;'), '需要独立变量');
  assert.ok(source.includes('hypnosisActive: antiRepHypnosisActive,'), '调用处应使用它');
  assert.ok(
    source.includes('antiRepHypnosisActive = !!(stForAntiRep?.active && stForAntiRep.bodyControlled && !stForAntiRep.mindAwake)'),
    '判定口径应为 active && bodyControlled && !mindAwake（与催眠块一致）',
  );
});
