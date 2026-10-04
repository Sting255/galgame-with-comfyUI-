import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendGroupImageSpeakerName,
  applyGroupImageNameFallback,
  collectCharacterLoras,
  matchCharactersInImagePrompt,
} from './groupImageLoraMatcher.js';

const characters = [
  { id: 1, name: 'raiden_mei', display_name: 'Mei' },
  { id: 2, name: 'elysia pink', display_name: 'Elysia' },
  { id: 3, name: 'mei', display_name: 'Other Mei' },
];

test('appends only the speaker English name and ignores the appearance section', () => {
  const prompt = appendGroupImageSpeakerName(
    'a candid selfie in a cafe',
    {
      name: 'raiden_mei',
      base_prompt: '## 你的外观\n旧外观\n##你的外观\npurple eyes, long dark hair\nwearing a white dress',
    },
  );

  assert.equal(
    prompt,
    'a candid selfie in a cafe, raiden_mei',
  );
});

test('appends the English name when the character has no base prompt', () => {
  const prompt = appendGroupImageSpeakerName(
    'a city night scene',
    { name: 'elysia pink' },
  );

  assert.equal(prompt, 'a city night scene, elysia pink');
});

test('matches underscored and spaced names across prompt separators', () => {
  const matches = matchCharactersInImagePrompt(
    'RAIDEN MEI standing beside elysia_pink in a city street',
    characters,
  );

  assert.deepEqual(matches.map(character => character.id), [1, 2]);
});

test('can still match a longer spaced name, but very short handles no longer match alone', () => {
  // 行为变更（成因 A3 修复，2026-10-01）：`name` 归一化后去空格 < 5 个字符的别名不再进别名表。
  // 理由：短别名在普通英文里乱命中的代价是把无关角色 LoRA 塞到链首。
  // 例如 if 放行 `mei`，就会命中 `a meido waitress portrait` / `a mei tai baby carrier` 这类词。
  // 真实库里最短的 handle 是 `firefly`（7）与 `yunli`（5），不受影响。
  const matches = matchCharactersInImagePrompt(
    'raiden_mei standing beside mei in a city street',
    characters,
  );

  assert.deepEqual(matches.map(character => character.id), [1], 'raiden mei 命中；裸 mei（3 字母）不再命中');
});

test('uses token boundaries for short single-token names', () => {
  const matches = matchCharactersInImagePrompt('a meido waitress portrait', characters);
  assert.deepEqual(matches, []);
});

test('merges LoRAs from multiple characters and deduplicates paths', () => {
  const loras = collectCharacterLoras([
    { loras: JSON.stringify([{ path: 'mei.safetensors', weight: 0.7, triggerWord: 'mei' }]) },
    { loras: [{ path: 'elysia.safetensors', weight: 0.8 }, { path: 'mei.safetensors', weight: 1 }] },
  ]);

  assert.deepEqual(loras, [
    { path: 'mei.safetensors', weight: 0.7, triggerWord: 'mei' },
    { path: 'elysia.safetensors', weight: 0.8, triggerWord: '' },
  ]);
});

test('no longer prepends the speaker name when a person prompt omitted all character names', () => {
  // 行为变更（成因 A3 修复，2026-10-01）：旧实现把 `speaker.name` 前置成 `chinatsu, a shy young girl…`，
  // 真机后果是"谁发图就画成谁"（backend-2026-10-01.log:123-126：画面描述的是银狼、前面却被塞上 march7th）。
  // 新口径：不加任何人物名锚点，只回报 fallbackApplied 供诊断。
  const prepared = applyGroupImageNameFallback(
    'a shy young girl taking a selfie on a summer street',
    [],
    { name: 'chinatsu' },
  );

  assert.deepEqual(prepared, {
    prompt: 'a shy young girl taking a selfie on a summer street',
    fallbackApplied: true,
  });
});

test('does not add a character LoRA tag to scenery or object-only prompts', () => {
  const prepared = applyGroupImageNameFallback(
    'a convenience store shelf filled with colorful drinks',
    [],
    { name: 'chinatsu' },
  );

  assert.equal(prepared.fallbackApplied, false);
});
