import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
globalThis.fetch = async url => { throw new Error(`characterPersona test forbids network: ${url}`); };

const { config } = await import('../src/config.js');
const { getUserName, matchUser } = await import('../src/services/userSearch.js');
const {
  buildCharacterPersona,
  buildImageCrossRefInfo,
  buildUserImageCrossRefInfo,
  extractAppearanceIdentityCorpus,
  replaceAppearanceSection,
  splitAppearanceSection,
  isAppearanceOnlyPromptChange,
} = await import('../src/services/characterPersona.js');

// 覆盖范围：
// 1) userSearch：用户名提及匹配（占位名 / 单字名 / 非字符串输入都不得误判）
// 2) buildUserImageCrossRefInfo：用户自述资料块（图片实验室、私聊提到用户名时注入）
// 3) AGENTS.md 强制的回归：无生效外观时 characterPersona 与收口前的旧口径逐字节一致
//
// 外观注入一律显式传 outfits: null —— 既绕开 DB，也保证断言只反映「没有外观可注入」这条路径。

/** 临时改写 config.user，返回还原函数（用例之间不串味） */
function patchUser(patch) {
  const saved = { ...config.user };
  Object.assign(config.user, patch);
  return () => Object.assign(config.user, saved);
}

// 标准测试角色：身份行 + 外观段俱全，用来对齐旧口径
const CHAR = {
  id: 1,
  display_name: '小满',
  short_prompt: '小满是面包店店员。',
  base_prompt: '你是小满，来自邻舍镇的面包店店员，性格温柔。\n\n## 你的外观\n小满有着栗色长发与琥珀色眼睛。\n',
};

test('文本里出现用户名时 matchUser 命中', () => {
  const restore = patchUser({ nickname: '阿离' });
  try {
    assert.equal(matchUser('阿离站在面包店门口，回头看向镜头'), true);
    assert.equal(matchUser('阿离'), true);
  } finally {
    restore();
  }
});

test('文本里没出现用户名时 matchUser 不命中', () => {
  const restore = patchUser({ nickname: '阿离' });
  try {
    assert.equal(matchUser('小满站在面包店门口'), false);
    assert.equal(matchUser(''), false);
  } finally {
    restore();
  }
});

test('占位昵称「用户」/「user」不算提到用户本人', () => {
  // 没设置昵称时 config.user.nickname 就是 '用户'；若把它当名字，
  // 正文里任何一句「用户」都会误触发注入
  for (const nickname of ['用户', 'user', 'User']) {
    const restore = patchUser({ nickname });
    try {
      assert.equal(getUserName(), nickname);
      assert.equal(matchUser('用户把面包放回了货架'), false);
    } finally {
      restore();
    }
  }
});

test('单字昵称不算提到用户本人', () => {
  const restore = patchUser({ nickname: '离' });
  try {
    assert.equal(matchUser('离站在面包店门口'), false);
  } finally {
    restore();
  }
});

test('matchUser 对空值与非字符串输入返回 false 且不抛', () => {
  const restore = patchUser({ nickname: '阿离' });
  try {
    for (const input of [null, undefined, '', 0, 123, {}, []]) {
      assert.equal(matchUser(input), false);
    }
  } finally {
    restore();
  }
});

test('getUserName 缺省回退占位名，并去掉首尾空白', () => {
  const restore = patchUser({ nickname: '' });
  try {
    assert.equal(getUserName(), '用户');
  } finally {
    restore();
  }

  const restoreTrimmed = patchUser({ nickname: '  阿离  ' });
  try {
    assert.equal(getUserName(), '阿离');
  } finally {
    restoreTrimmed();
  }
});

test('用户资料三项全空时给出占位说明（不返回空串）', () => {
  const restore = patchUser({ gender: '', appearance: '', persona: '' });
  try {
    assert.equal(buildUserImageCrossRefInfo(), '（用户未填写个人资料，按普通人处理）');
  } finally {
    restore();
  }
});

test('用户资料按性别 / 外观 / 其他说明顺序拼接', () => {
  const restore = patchUser({ gender: '女', appearance: '黑色长发，常穿米色外套', persona: '说话慢，喜欢甜食' });
  try {
    assert.equal(
      buildUserImageCrossRefInfo(),
      '性别：女；外观：黑色长发，常穿米色外套；其他说明：说话慢，喜欢甜食',
    );
  } finally {
    restore();
  }

  // 只填一项时不留多余分隔符
  const restorePartial = patchUser({ gender: '', appearance: '黑色长发', persona: '' });
  try {
    assert.equal(buildUserImageCrossRefInfo(), '外观：黑色长发');
  } finally {
    restorePartial();
  }
});

test('提到用户时的注入块与角色块同形：`[名字]` + 换行 + 资料', () => {
  const restore = patchUser({ nickname: '阿离', gender: '女', appearance: '黑色长发', persona: '' });
  try {
    assert.equal(
      `[${getUserName()}]\n${buildUserImageCrossRefInfo()}`,
      '[阿离]\n性别：女；外观：黑色长发',
    );
  } finally {
    restore();
  }
});

test('无生效外观时 short variant 走"运行时现裁"，不再采用库里那份 short_prompt', () => {
  // ⚠️ 2026-10-02（技术债②）：原来这里断言 short variant == `short_prompt + 外观段`（逐字节一致）。
  //    那个口径的后果是：库里 8 个角色存的都是**旧裁剪口径**（LLM 浓缩 ~200 字、甚至切在半句上）的产物，
  //    于是群聊成员资料卡 / 梦境 / 多角色参考全都吃不到 `cropPersonalityForEmotion` 的修复
  //    （真实数据：德丽莎整卡 2212 字 ⇒ 实际只用 200 字 = 9%），表现就是用户说的「角色不遵从设定」。
  //    现在改成运行时从 `base_prompt` 现裁 —— 所以这条断言钉的**行为**也换了：
  //    ① 人格部分来自整卡现裁（含身份/性格，不再是那一句 200 字浓缩）；
  //    ② 绝**不**等于库里那份旧 short_prompt（这就是防止有人又改回读库的反向守卫）；
  //    ③ 外观段照旧接在后面（外观归生图链管，与本债无关）。
  const out = buildCharacterPersona(CHAR, { outfits: null });
  assert.ok(out.includes('## 你的外观'), '外观段照旧要接在后面');
  assert.ok(out.includes('栗色长发与琥珀色眼睛'), '外观内容不能被裁掉');
  assert.notEqual(out, '小满是面包店店员。\n## 你的外观\n小满有着栗色长发与琥珀色眼睛。',
    '不许再逐字节等于"库里 short_prompt + 外观段"——那正是本债要废掉的口径');
  const personaPart = out.split('## 你的外观')[0];
  assert.ok(!personaPart.includes('小满是面包店店员。'),
    '人格部分不该是库里那份浓缩 short_prompt（它吃不到裁剪修复）');
  assert.match(personaPart, /小满/, '现裁结果仍要带角色名（"你"已替换）');
  assert.ok(!personaPart.includes('你是小满'), '开场白「你是X」应替换为「X」，不该留下第一人称');
});

test('无生效外观时 full variant 与旧口径逐字节一致（整卡原样）', () => {
  assert.equal(buildCharacterPersona(CHAR, { variant: 'full', outfits: null }), CHAR.base_prompt);
});

test('无生效外观时 buildImageCrossRefInfo 与旧口径逐字节一致（身份行 + 外观段）', () => {
  // 身份行切到含「来自」那一段的末标点；外观段「你」→ 角色名，并保留原有结尾换行
  assert.equal(
    buildImageCrossRefInfo(CHAR, { outfits: null }),
    '小满，来自邻舍镇的面包店店员\n## 小满的外观\n小满有着栗色长发与琥珀色眼睛。\n',
  );
});

test('没有 short_prompt 的行（小镇 NPC 等）：short 兜底整卡、full 原样返回（旧口径刻意保留）', () => {
  // ⚠️ 2026-10-02 技术债②收口时特意**保留**了这条：现裁只顶替"原来那份 short_prompt 的位置"。
  //    这行没有 short_prompt ⇒ 人格留空（有外观段时只用外观段，见 townAssetRequest.test.js 的断言：
  //    "人格卡正文不该混进外观需求"），没有外观段时才兜底整卡。
  const plain = { id: 2, display_name: '阿岚', short_prompt: '', base_prompt: '你是阿岚，来自邻舍镇的邮差。' };
  assert.equal(buildCharacterPersona(plain, { outfits: null }), '你是阿岚，来自邻舍镇的邮差。');
  assert.equal(buildCharacterPersona(plain, { variant: 'full', outfits: null }), '你是阿岚，来自邻舍镇的邮差。');

  // 有 short_prompt（真角色卡）时才是现裁路径；base_prompt 为空则退回库里那份
  const noBase = { id: 3, display_name: '阿岚', short_prompt: '阿岚是邮差。', base_prompt: '' };
  assert.equal(buildCharacterPersona(noBase, { outfits: null }), '阿岚是邮差。');
});

// 外观段编辑与身份提取：与人格组装共同维护，避免同名测试分散。
test('extractAppearanceIdentityCorpus 截取开头段到「来自」后的第一个句号并去掉「你是」', () => {
  const card = '你是星见雅(Hoshimi Miyabi)，来自《绝区零》。\n\n## 你的身份\n你是新艾利都对空洞特别行动科第六课的课长。';
  assert.equal(
    extractAppearanceIdentityCorpus(card, '星见雅'),
    '星见雅(Hoshimi Miyabi)，来自《绝区零》。',
  );
});

test('extractAppearanceIdentityCorpus 兼容「来自」单独成行的卡片', () => {
  const card = '你是芙宁娜(Furina)。\n来自《原神》。\n\n## 你的身份\n你是枫丹的前任水神。';
  assert.equal(
    extractAppearanceIdentityCorpus(card, '芙宁娜'),
    '芙宁娜(Furina)。\n来自《原神》。',
  );
});

test('extractAppearanceIdentityCorpus 只在首个空行前的段落里找「来自」，不受正文影响', () => {
  const card = '你是流萤(Firefly)，来自《崩坏：星穹铁道》。\n\n## 你的身份\n你来自天外的一艘星舰，常年沉睡。';
  assert.equal(
    extractAppearanceIdentityCorpus(card, '流萤'),
    '流萤(Firefly)，来自《崩坏：星穹铁道》。',
  );
});

test('extractAppearanceIdentityCorpus 无「来自」或句号时回退为显示名', () => {
  assert.equal(extractAppearanceIdentityCorpus('你是萨沙(Sasha)。你是一名高中生。', '萨沙'), '萨沙');
  assert.equal(extractAppearanceIdentityCorpus('你是无名，来自只有传说的地方', '无名'), '无名');
  assert.equal(extractAppearanceIdentityCorpus('', '默认助手'), '默认助手');
  assert.equal(extractAppearanceIdentityCorpus('', ''), '');
});

test('replaceAppearanceSection 原位替换已有外观段（默认是最后一段）', () => {
  const card = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\n- 旧外观一行\n- 旧外观两行';
  assert.equal(
    replaceAppearanceSection(card, 'Sasha has long golden hair, wearing a white JK uniform.'),
    '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\nSasha has long golden hair, wearing a white JK uniform.',
  );
});

test('replaceAppearanceSection 外观段之后还有别的段落时只替换到下一个标题', () => {
  const card = '## 你的外观\n- 旧外观\n\n## 你的口癖\n- 呐呐';
  const result = replaceAppearanceSection(card, 'new look');
  assert.ok(result.includes('## 你的外观\nnew look'));
  assert.ok(result.includes('## 你的口癖\n- 呐呐'));
  assert.ok(result.indexOf('new look') < result.indexOf('## 你的口癖'));
});

test('replaceAppearanceSection 无外观段时在卡末补一段', () => {
  const card = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气';
  assert.equal(
    replaceAppearanceSection(card, 'Sasha has blue eyes.'),
    '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\nSasha has blue eyes.',
  );
  assert.equal(replaceAppearanceSection('', 'only look'), '\n\n## 你的外观\nonly look');
});

test('splitAppearanceSection 切出的前后文按公式重组后与 replaceAppearanceSection 完全一致', () => {
  const assemble = (base, body) => {
    const { before, after } = splitAppearanceSection(base);
    return `${before}## 你的外观\n${body}${after}`;
  };
  const cases = [
    '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\n- 旧外观',
    '你是萨沙(Sasha)。\n\n## 你的外观\n- 旧外观\n\n## 你的口癖\n- 呐呐',
    '## 你的外观\n- 旧外观',
    '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气',
    '',
  ];
  for (const base of cases) {
    assert.equal(assemble(base, 'new look'), replaceAppearanceSection(base, 'new look'));
  }
});

test('isAppearanceOnlyPromptChange 仅外观段正文变化（含外观段增删）时返回 true', () => {
  const card = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\n- 金发\n- 白色JK';
  assert.equal(isAppearanceOnlyPromptChange(card, card.replace('- 金发', '- 银发')), true);
  assert.equal(isAppearanceOnlyPromptChange(card, card.replace('- 白色JK', '- 白色JK，黑丝')), true);
  // 原卡无外观段 → 卡末新增外观段
  const noAppearance = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气';
  assert.equal(isAppearanceOnlyPromptChange(noAppearance, replaceAppearanceSection(noAppearance, '- 金发')), true);
  // 删除整段外观
  assert.equal(isAppearanceOnlyPromptChange(card, noAppearance), true);
});

test('isAppearanceOnlyPromptChange 外观段之前的正文变化时返回 false', () => {
  const card = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\n- 金发';
  assert.equal(isAppearanceOnlyPromptChange(card, card.replace('- 元气', '- 高冷')), false);
  assert.equal(isAppearanceOnlyPromptChange(card, card.replace('萨沙', '星野')), false);
});

test('isAppearanceOnlyPromptChange 容忍标题前收尾空白差异与完全一致的两次保存', () => {
  const card = '你是萨沙(Sasha)。\n\n## 你的性格\n- 元气\n\n## 你的外观\n- 金发';
  assert.equal(isAppearanceOnlyPromptChange(card, card.replace('\n\n## 你的外观', '\n## 你的外观')), true);
  assert.equal(isAppearanceOnlyPromptChange(card, card), true);
  assert.equal(isAppearanceOnlyPromptChange(card.replace('\n\n## 你的外观', '\n## 你的外观'), card), true);
});
