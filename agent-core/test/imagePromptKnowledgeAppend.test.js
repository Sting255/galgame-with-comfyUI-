/**
 * 成因 A2 回归：RAG 检索标签被**无条件追加**、且「单人锚点」在多人画面上强行加 `solo`。
 *
 * 真机证据（`完整/backend-2026-10-01.log:123-126`，只读）：
 *   [group] image prompt added speaker name fallback: march7th
 *   [imagePromptKnowledge] query="就现在这个角度，绝了" mode=hybrid tags=["solo","from back","low angle"]
 *   [imageSkill] Final prompt: march7th, a dimly lit dorm room at night, the main focus is a girl with
 *   long wavy silver-grey hair in a high ponytail lying back on a bed …, a small pink-haired girl in a
 *   blue and white blouse kneels on the bed with a camera aimed at her, …, solo, from back, low angle
 * —— 同一串里写着**两个女孩**，结尾却追加了 `solo`。
 *
 * 本文件钉四件事：
 *   ① 多人判定：英文 `two girls` 写法、中文「两个」写法、以及"两个角色锚点"写法都算多人，
 *      同时单人画面（含 `her bare thighs` 这种身体部位、"multiple views" 这种构图词）不得误判；
 *   ② 真机那条串喂进去，**不会**被追加 `solo`（正文一个字不改），也不再把 `ipk.count.solo` 记为生效规则；
 *   ③ 单人画面**仍然**拿到 `solo`（别把功能修没了），且 `prepareImagePrompt` 的 `disableRAG` 注桩可用；
 *   ④ 冲突标签被丢、非冲突标签保留、追加数量不超上限（最多 6 个）。
 *
 * 环境约定：先设 DB_PATH=':memory:' 再动态 import；globalThis.fetch 抛错挡网络。
 * 检索本身用**假 items**（真形状的 items，不是真库），所以本文件不依赖真库、不依赖向量服务。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
process.env.LOG_TO_FILE = 'false'
globalThis.fetch = async url => { throw new Error('image prompt fixture forbids network: ' + url) }

const { config } = await import('../src/config.js')
config.dbPath = ':memory:'
const { getDb, closeDb } = await import('../src/db/index.js')
const {
  composeImagePrompt,
  prepareImagePrompt,
  detectMultiPersonScene,
  tagConflictsWithText,
  selectAppendableTags,
} = await import('../src/services/imagePromptPreparer.js')

after(() => closeDb())

// ── 真形状的检索条目（executableTags 形如 image_prompt_knowledge.executable_tags 解析结果） ──
const ENTRY = (tag, label) => ({ tag, label: label || '', group: '' })
function item(id, category, priority, executableTags) {
  return { id, category, priority, executableTags, score: 1, version: 'fixture' }
}

/** `ipk.count.solo` 在真库里 executable_tags 是 `[]` —— 它的 `solo` 是程序按规则注入的，不是检索出来的。 */
const COUNT_SOLO_ITEM = item('ipk.count.solo', 'count_identity', 90, [])
const COUNT_DUO_ITEM = item('ipk.count.duo', 'count_identity', 96, [])
const GAZE_AWAY_ITEM = item('ipk.gaze.away', 'gaze', 96, [])
const CAMERA_ITEM = item('ipk.lib.camera.angle.001', 'camera_vocabulary', 50, [
  ENTRY('low angle', '低角度仰拍'),
])
const BACK_ITEM = item('ipk.lib.camera.angle.002', 'camera_vocabulary', 50, [
  ENTRY('from back', '后背视角'),
])
const NIGHT_ITEM = item('ipk.environment.night', 'environment_vocabulary', 50, [
  ENTRY('night', '夜景'),
])
const DEFAULT_ITEMS = [COUNT_SOLO_ITEM, COUNT_DUO_ITEM, GAZE_AWAY_ITEM, CAMERA_ITEM, BACK_ITEM, NIGHT_ITEM]

/** 把一条 promptRefined 切成 tag 段，用于"有没有出现独立的 solo 段"这种断言。 */
const tagSegments = text => String(text || '')
  .split(',')
  .map(part => part.trim().toLowerCase())
  .filter(Boolean)
const soloSegs = text => tagSegments(text).filter(segment => segment === 'solo')

/** 真机那条串（backend-2026-10-01.log:126 的英文画面描述本体，不含程序追加的三个 tag）。 */
const REAL_PROMPT = 'a dimly lit dorm room at night, the main focus is a girl with long wavy silver-grey hair in a high ponytail lying back on a bed with one knee bent, her black cropped jacket and purple skirt set aside on the floor beside a pair of black thigh-high stockings, she wears only a dark purple crop top and black choker, one hand pressed over her lower belly and the other gripping the bedsheet, her expression tense and flushed with parted lips, soft cyan light from a handheld game console on the nightstand casts a cool glow over her bare thighs, a small pink-haired girl in a blue and white blouse kneels on the bed with a camera aimed at her, warm bedside lamp light mixes with the cyan glow, the scene conveys intimate chaos and playful pressure'
/** 同一份日志里落进 raw 的那一行（带发图人前缀，见成因 A3 测试文件）。 */
const REAL_LOG_LINE = `march7th, ${REAL_PROMPT}, solo, from back, low angle`

// ── ① 多人判定 ────────────────────────────────────────────────────────────────

test('① 多人判定：中文数量词、英文数量词、两个角色锚点、两个 IP 名都算多人', () => {
  // 中文写法（用户那一句是中文，英文 prompt 里可能一个人数词都没有）
  for (const zh of ['两个女孩在床边', '两人同框', '二人合照', '三个人在房间里', '她们俩在玩', '一群女生在笑']) {
    assert.equal(detectMultiPersonScene(zh), true, `中文数量词应判多人：${zh}`)
  }
  // 英文写法
  for (const en of [
    'two girls on a bed',
    '2girls, bedroom',
    'two people talking',
    'a couple sitting on a sofa',
    'they are a group of friends',
    'multiple girls in the frame',
    '1girl 1boy on the bed',
  ]) {
    assert.equal(detectMultiPersonScene(en), true, `英文数量词应判多人：${en}`)
  }
  // 角色锚点计数 ≥2（真机那条正是这一层命中）
  assert.equal(
    detectMultiPersonScene('the main focus is a girl with long silver-grey hair, a small pink-haired girl kneels on the bed with a camera'),
    true,
    '两个 girl 锚点应判多人',
  )
  assert.equal(detectMultiPersonScene('a girl sitting on the floor while another girl watches'), true)
  assert.equal(detectMultiPersonScene('a girl sitting on the floor while a second girl watches'), true)
  assert.equal(detectMultiPersonScene('a girl sitting on the floor while her sister watches'), true, 'her sister 是第二人')
  assert.equal(detectMultiPersonScene('March 7th (Honkai: Star Rail) and Silver Wolf (Honkai: Star Rail) in a dorm'), true)
  // 真机那条本体
  assert.equal(detectMultiPersonScene(REAL_PROMPT), true, '真机串必须判为多人')
})

test('① 单人画面不误判成多人（否则 solo 这一路功能等于被删掉）', () => {
  for (const solo of [
    '1girl, solo, long hair, looking at viewer',
    'a girl with long wavy silver-grey hair lying on a bed',
    'a young woman taking a selfie on a summer street',
    'she is a student in a sailor uniform',
    'no people in this empty room, a still life of bottles',
    // `multiple views` / `split screen` / `character sheet` 是**构图**词，不是人数
    'multiple views, split screen, character sheet',
    'a dimly lit dorm room at night with a game console on the nightstand',
    // 身体部位与量词短语不是"第二个人"（第一版在这里误判过）
    'her expression tense and flushed with parted lips',
    'a pair of black thigh-high stockings on the floor',
  ]) {
    assert.equal(detectMultiPersonScene(solo), false, `单人画面不得判多人：${solo}`)
  }
})

// ── ② 真机那条串 ──────────────────────────────────────────────────────────────

test('② 真机那条多人串：不得被追加 solo，正文一个字不改', () => {
  const result = composeImagePrompt(REAL_PROMPT, DEFAULT_ITEMS, { ragQuery: '就现在这个角度，绝了' })

  assert.deepEqual(soloSegs(result.promptRefined), [], '多人画面不得被追加 solo')
  assert.ok(!result.selectedTags.some(tag => tag.tag === 'solo'), 'selectedTags 里也不得出现 solo')
  assert.ok(!result.appliedRules.includes('ipk.count.solo'), '不得把 count.solo 记为生效规则')
  assert.ok(result.appliedRules.includes('ipk.count.solo:skipped-multi-person'), '应显式留下"因多人跳过"的痕迹')
  // 画面描述原文必须逐字保留（只丢弃追加标签，不动正文）
  const withoutAppended = result.promptRefined.slice(0, result.promptRefined.length - result.selectedTags.reduce((sum, tag) => sum + tag.tag.length + 2, 0))
  assert.equal(withoutAppended, REAL_PROMPT, '正文必须逐字不变，追加标签只出现在尾部')
})

test('② 检索没被关掉：与正文不冲突的标签仍会被追加，重复/冲突的才被拦', () => {
  const prompt = 'a dimly lit dorm room at night, two girls on a bed facing the viewer'
  const result = composeImagePrompt(prompt, DEFAULT_ITEMS, { ragQuery: '就现在这个角度，绝了' })

  // ⚠️ 2026-10-04 **口径改了**（理由见下面新增的 ⑤）：`low angle` 是**构图/裁切标签**，
  // 真机日志 `Final prompt: …, low angle view, thighs focus, thighs close-up` 证明它会把正文
  // 写好的**场景**压回身体特写 —— 现在这一类**一律不自动追加**。
  // 所以这条用例的结论从"low angle 必须被追加"改成"这一批候选一个都不该被追加"：
  // night 正文已有、solo 与 two girls 冲突、low angle 是构图标签、from back 与 facing the viewer 冲突。
  assert.ok(!result.selectedTags.some(tag => tag.tag === 'low angle'), '构图标签不得自动追加')
  assert.ok(
    result.removedTags.some(tag => tag.tag === 'low angle' && tag.reason === 'framing/crop tags are not auto-appended'),
    'low angle 要记为"构图标签"被拦，而不是悄悄消失',
  )
  assert.equal(result.promptRefined, prompt, '候选全被拦下时正文逐字不变')
  // `night` 正文已有（`at night`）⇒ 不重复追加
  assert.ok(
    result.removedTags.some(tag => tag.tag === 'night' && tag.reason === 'already present in the picture description'),
    'night 应记为"正文已有"而跳过',
  )
  // `solo` 与 two girls 冲突 ⇒ 拦下（这一条是本次修复的主目标）
  assert.ok(!result.selectedTags.some(tag => tag.tag === 'solo'), 'two girls ⇒ 不得追加 solo')
  assert.ok(!result.appliedRules.includes('ipk.count.solo'))
})

test('② `from back` 与正文的正面朝向声明冲突时被拦下（追加阶段闸门）', () => {
  const { appendable, dropped } = selectAppendableTags(
    [
      { tag: 'from back', key: 'from_back', category: 'camera_vocabulary', knowledgeId: 'k.back', score: 20, priority: 50 },
      { tag: 'low angle', key: 'low_angle', category: 'camera_vocabulary', knowledgeId: 'k.low', score: 20, priority: 50 },
    ],
    'two girls on a bed facing the viewer, low angle framing',
  )
  assert.deepEqual(appendable, [], '两个候选都不该被追加（from back 冲突、low angle 已在正文里）')
  const backDrop = dropped.find(entry => entry.tag === 'from back')
  assert.ok(backDrop, 'from back 应被丢弃')
  assert.equal(backDrop.reason, 'conflicts with the picture description')
})

test('② 已经落在输入里的 solo（真机 raw 行那种）不被原地删除，但程序也不再追加第二个', () => {
  // 真机 raw 行 = 模型输出 + 上一轮被程序追加过的三个 tag。闸门只拦"追加"，不删作者原文
  // （与 imagePromptPreparer 里"只丢弃追加标签、不动正文"的口径一致）。
  const result = composeImagePrompt(REAL_LOG_LINE, DEFAULT_ITEMS, { ragQuery: '就现在这个角度，绝了' })
  assert.equal(soloSegs(result.promptRefined).length, 1, '原串里的那个 solo 保留，且不得再多一个')
  assert.ok(!result.selectedTags.some(tag => tag.tag === 'solo'), '不得再追加 solo')
  assert.equal(
    result.promptRefined.replace(/,\s*solo/, '').includes('solo'),
    false,
    '除了原作者写的那个之外不得再出现 solo',
  )
})

test('② 中文 query 也参与多人判定（英文 prompt 无人数量词时的兜底）', () => {
  const prompt = 'a dorm room at night, a girl lies on a bed while a pink-haired girl holds a camera'
  const result = composeImagePrompt(prompt, DEFAULT_ITEMS, { ragQuery: '两个女孩在宿舍，一个躺着，一个拿相机' })
  assert.deepEqual(soloSegs(result.promptRefined), [], '中文 query 说明是两个女孩 ⇒ 不得追加 solo')
  assert.ok(!result.selectedTags.some(tag => tag.tag === 'solo'), '不得追加 solo')
  assert.ok(result.promptRefined.startsWith(prompt), '正文必须逐字不被改写（追加只发生在尾部）')
  // 中文 query 不得变成"白拿分"通道：老实现拿 prompt + query 的合并串去比 label，
  // 而 label 是中文注解、query 也是中文 ⇒ 任何被检索命中的条目的 tag 都会无条件进追加列表。
  assert.ok(
    !result.selectedTags.some(tag => tag.tag === 'from back'),
    '多人画面（且没人写从背后看）不得因为中文 query 被追加 from back',
  )
})

// ── ③ 单人仍然拿到单人锚点 ────────────────────────────────────────────────────

test('③ 单人画面仍然按规则注入 solo（功能没被修没）', () => {
  const result = composeImagePrompt('1girl, long silver hair, standing in a hallway', DEFAULT_ITEMS, { ragQuery: '走廊里的独照' })
  assert.ok(result.selectedTags.some(tag => tag.tag === 'solo'), '单人画面应拿到 solo')
  assert.ok(result.appliedRules.includes('ipk.count.solo'), 'appliedRules 应记录生效的 solo 规则')
  assert.ok(tagSegments(result.promptRefined).includes('solo'), 'solo 应真的落到 promptRefined 里')
})

test('③ prepareImagePrompt 的 disableRAG 注桩可用（不碰真库、不碰网络）', async () => {
  const off = await prepareImagePrompt('1girl, standing', { scene: 'group', disableRAG: true, db: null })
  assert.equal(off.status, 'rag_disabled')
  assert.equal(off.promptRefined, '1girl, standing')
  assert.deepEqual(off.selection.selectedTags, [])

  const skipped = await prepareImagePrompt('1girl, standing', { scene: 'group', alreadyPrepared: true, db: null })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.promptRefined, '1girl, standing')

  const empty = await prepareImagePrompt('   ', { db: null })
  assert.equal(empty.status, 'empty')
})

test('③ prepareImagePrompt 走真检索（内存库自带 222 条知识库种子）：多人 prompt 不会被追加 solo', async () => {
  const result = await prepareImagePrompt(REAL_PROMPT, {
    scene: 'group',
    ragQuery: '就现在这个角度，绝了',
    db: getDb(),
    ragTimeoutMs: 200,
  })
  // 内存库确实灌了 222 条知识库种子（`[db] image prompt knowledge seeded: 222 items`），
  // 但这条 query 在无嵌入服务的前提下命中为空 ⇒ 只断言"检索真的跑过 + 结果没被 solo 污染"。
  assert.equal(result.ragQuery, '就现在这个角度，绝了', '中文 query 应优先作为检索词')
  assert.ok(['hybrid', 'keyword'].includes(result.retrieval.mode), `检索模式应为 hybrid/keyword，实际 ${result.retrieval.mode}`)
  assert.ok(!result.selection.selectedTags.some(tag => tag.tag === 'solo'), '真检索路径也不得追加 solo')
  assert.deepEqual(soloSegs(result.promptRefined), [], '真检索路径也不得追加 solo')
  assert.ok(result.promptRefined.startsWith('a dimly lit dorm room at night'), '正文不得被改写')
  assert.ok(!result.selection.appliedRules.includes('ipk.count.solo'), '不得把 count.solo 记为生效规则')
})

// ── ④ 冲突闸门与上限 ──────────────────────────────────────────────────────────

test('④ 冲突标签被丢、非冲突标签保留', () => {
  // from back 与"看镜头"互斥
  assert.equal(tagConflictsWithText('from back', '1girl, looking at viewer, standing'), true)
  assert.equal(tagConflictsWithText('from back', 'a girl with silver hair, back view'), false)
  // 反方向：正文是背影时不追加 looking at viewer
  assert.equal(tagConflictsWithText('looking at viewer', '1girl, from behind, walking away'), true)
  // solo 与反人互动锚点互斥
  assert.equal(tagConflictsWithText('solo', '1girl, hetero, on a bed'), true)
  // 裸 face 不当判据（`framing her face` 在背影里也成立，拿它当判据会误伤合法 from back）
  assert.equal(
    tagConflictsWithText('from back', 'a girl sees a camera framing her face in the mirror'),
    false,
    '光有 face 不能判成正面朝向',
  )
  // 无关标签一律不拦
  for (const tag of ['low angle', 'night', 'closed_eyes', 'from above', 'full_body']) {
    assert.equal(tagConflictsWithText(tag, '1girl, standing in a hallway at night'), false, `${tag} 不应被拦`)
  }

  const selected = [
    { tag: 'solo', key: 'solo', category: 'count_identity', knowledgeId: 'ipk.count.solo', score: 100, priority: 100 },
    { tag: 'from back', key: 'from_back', category: 'camera_vocabulary', knowledgeId: 'k.back', score: 20, priority: 50 },
    { tag: 'low angle', key: 'low_angle', category: 'camera_vocabulary', knowledgeId: 'k.low', score: 20, priority: 50 },
  ]
  // 这条正文是**单人**且写着 looking at viewer ⇒ 丢 from back（与正文朝向矛盾），
  // solo 合法（单人）必须留下；`low angle` 2026-10-04 起被**构图闸门**拦下（不是冲突判据，见 ⑤）。
  const { appendable, dropped } = selectAppendableTags(
    selected,
    'a girl with long wavy silver-grey hair, looking at viewer',
  )
  assert.deepEqual(appendable.map(entry => entry.tag).sort(), ['solo'])
  assert.deepEqual(dropped.map(entry => entry.tag).sort(), ['from back', 'low angle'])
  const reasonOf = tag => dropped.find(entry => entry.tag === tag)?.reason
  assert.equal(reasonOf('from back'), 'conflicts with the picture description')
  assert.equal(reasonOf('low angle'), 'framing/crop tags are not auto-appended')
})

test('④ 多人正文时 solo 被闸门丢掉（与 ② 同一条判据的最小复现）', () => {
  const selected = [
    { tag: 'solo', key: 'solo', category: 'count_identity', knowledgeId: 'ipk.count.solo', score: 100, priority: 100 },
    { tag: 'low angle', key: 'low_angle', category: 'camera_vocabulary', knowledgeId: 'k.low', score: 20, priority: 50 },
  ]
  const { appendable, dropped } = selectAppendableTags(
    selected,
    'a girl with long silver-grey hair, a small pink-haired girl kneels on the bed with a camera',
  )
  // 多人 ⇒ solo 被冲突判据丢掉；`low angle` 被构图闸门丢掉（见 ⑤）⇒ 一个都不追加。
  assert.deepEqual(appendable.map(entry => entry.tag), [])
  assert.deepEqual(dropped.map(entry => entry.tag).sort(), ['low angle', 'solo'])
  assert.equal(dropped.find(entry => entry.tag === 'solo').reason, 'conflicts with the picture description')
  assert.equal(dropped.find(entry => entry.tag === 'low angle').reason, 'framing/crop tags are not auto-appended')
})

// ── ⑤ 构图/裁切标签不得自动追加（2026-10-04 真机） ─────────────────────────────

test('⑤ 构图/裁切标签一律不自动追加；非构图标签照常追加（证明检索没被一刀切关掉）', () => {
  const camera = (tag) => ({ tag, key: tag, category: 'camera_vocabulary', knowledgeId: 'k.' + tag, score: 20, priority: 50 })
  // 真机日志里那一串（backend-2026-10-04.log）：正文写好了场景，尾部却被塞进这些
  const framing = ['low angle view', 'low angle', 'thighs focus', 'thighs close-up', 'close-up', 'ass up view', 'from below', 'headshot']
  for (const tag of framing) {
    const { appendable, dropped } = selectAppendableTags([camera(tag)], 'a girl stands in a dim gymnasium near an east window')
    assert.deepEqual(appendable, [], `${tag} 不该被追加（它会把场景压成特写）`)
    assert.equal(dropped[0].reason, 'framing/crop tags are not auto-appended', `${tag} 要给出拦截理由`)
  }
  // 反向对照：**非构图**标签不许被这道闸门误伤（否则等于把检索/追加整个关掉）
  for (const tag of ['night', 'closed_eyes', 'from above', 'full_body', 'smile']) {
    const { appendable } = selectAppendableTags([camera(tag)], 'a girl stands in a hallway')
    assert.deepEqual(appendable.map(entry => entry.tag), [tag], `${tag} 不该被构图闸门拦下`)
  }
  // `from above` / `full_body` 是**放宽构图**的方向，跟 close-up 相反，必须留着
  assert.deepEqual(
    selectAppendableTags([camera('from above'), camera('full_body')], 'a girl sits at a desk').appendable.map(e => e.tag),
    ['from above', 'full_body'],
  )
})

test('④ 追加数量不超上限（最多 6 个），按分数保留前 6 个', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    tag: `tag${index}`,
    key: `tag${index}`,
    category: 'camera_vocabulary',
    knowledgeId: `k.${index}`,
    score: 100 - index,
    priority: 50,
  }))
  const { appendable, dropped } = selectAppendableTags(many, '1girl standing in a hallway')
  assert.equal(appendable.length, 6)
  assert.deepEqual(appendable.map(entry => entry.tag), ['tag0', 'tag1', 'tag2', 'tag3', 'tag4', 'tag5'])
  assert.deepEqual(dropped.map(entry => entry.tag), ['tag6', 'tag7'])
  assert.ok(dropped.every(entry => entry.reason.includes('append limit')))
})

test('④ 端到端：正文里已经写过的标签一个都不重复追加（真机那条串的行为）', () => {
  // 10 个 tag 全都能在正文里命中（score=20），分布在 5 个类目上（每类配额 2~4）⇒ 都会有候选；
  // 但它们的词本身就在正文里 ⇒ "逐词去重"闸门把它们全部丢掉，只剩正文没写的 `solo` 被追加。
  // （"最多 6 个"这个上限由上面那条纯函数用例直接钉住；这里钉的是接线确实生效。）
  const tokens = [
    ['camera_vocabulary', 'alpha0'], ['camera_vocabulary', 'alpha1'],
    ['object_vocabulary', 'beta0'], ['object_vocabulary', 'beta1'],
    ['scene_vocabulary', 'gamma0'], ['scene_vocabulary', 'gamma1'], ['scene_vocabulary', 'gamma2'],
    ['environment_vocabulary', 'delta0'], ['environment_vocabulary', 'delta1'],
    ['clothing_vocabulary', 'epsilon0'],
  ]
  const manyItems = [COUNT_SOLO_ITEM]
  tokens.forEach(([category, tag], index) => {
    manyItems.push(item(`kb.extra.${tag}`, category, 60 - index, [ENTRY(tag, `额外标签${index}`)]))
  })

  const prompt = `1girl, ${tokens.map(([, tag]) => tag).join(', ')}`
  const result = composeImagePrompt(prompt, manyItems)

  assert.ok(result.selectedTags.length <= 6, `selectedTags 不得超过 6，实际 ${result.selectedTags.length}`)
  assert.deepEqual(result.selectedTags.map(tag => tag.tag), ['solo'], '只应追加正文没写过的 solo')
  // 正文里那 10 个标签是**独立逗号段**（`exactPromptSegments` 命中）⇒ 在选词阶段就被排除了，
  // 不会被追加；这里只断言"没有任何一个被重复追加到尾部"。
  for (const [, token] of tokens) {
    assert.ok(
      !result.selectedTags.some(tag => tag.tag === token),
      `正文里已写过的 ${token} 不得再被追加`,
    )
  }
  assert.equal(result.promptRefined, `${prompt}, solo`)
})

test('④ 正文里写过的标签不再重复追加（即使打分仍会命中它）', () => {
  // 打分口径**故意没动**（"检索到哪条就追加哪条"是既有设计）；重复问题由追加阶段的
  // "逐词去重"闸门解决：`selectExecutableTags` 只按**独立逗号段**排除候选，
  // 标签词写在正文句子里（`low angle shot` / `at night`）时仍会打成候选，靠这一道拦住。
  const appended = selectAppendableTags(
    [{ tag: 'night', key: 'night', category: 'environment_vocabulary', knowledgeId: 'k.night', score: 20, priority: 50 }],
    'a girl stands on a rooftop at night, low angle shot',
  )
  assert.deepEqual(appended.appendable, [])
  assert.equal(appended.dropped[0].reason, 'already present in the picture description')

  // 反向：正文里没有这个词时照常追加（`midnight` 不算 `night`）
  const kept = selectAppendableTags(
    [{ tag: 'night', key: 'night', category: 'environment_vocabulary', knowledgeId: 'k.night', score: 20, priority: 50 }],
    'a girl stands on a rooftop at midnight',
  )
  assert.deepEqual(kept.appendable.map(entry => entry.tag), ['night'])
})

// ── ⑤ 退化输入与幂等 ──────────────────────────────────────────────────────────

test('⑤ 空 prompt 不抛异常（沿用既有行为：空串下仍会得到单人锚点，不是本修复的改动点）', () => {
  assert.doesNotThrow(() => composeImagePrompt('', DEFAULT_ITEMS))
  assert.doesNotThrow(() => composeImagePrompt('   ', DEFAULT_ITEMS))
  assert.equal(composeImagePrompt('a scenery only prompt', []).promptRefined, 'a scenery only prompt')
})

test('⑤ 幂等：同一条多人串反复 compose，结果完全一致且都不追加 solo', () => {
  const first = composeImagePrompt(REAL_PROMPT, DEFAULT_ITEMS, { ragQuery: '就现在这个角度，绝了' })
  const second = composeImagePrompt(REAL_PROMPT, DEFAULT_ITEMS, { ragQuery: '就现在这个角度，绝了' })
  assert.equal(first.promptRefined, second.promptRefined)
  assert.deepEqual(second.selectedTags.map(tag => tag.tag), first.selectedTags.map(tag => tag.tag))
  assert.deepEqual(soloSegs(second.promptRefined), [])
})
