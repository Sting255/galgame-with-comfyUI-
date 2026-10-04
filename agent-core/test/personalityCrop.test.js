/**
 * 短人格裁剪的回归测试（2026-10-02）
 *
 * 用户反馈：「角色对话还是有一些不**遵**从设定，和玩家的性别与自我描述」。
 * 取证发现的**结构性根因**之一：`cropPersonalityForEmotion` 把人格压成 9% ——
 *   · 只留 `## 你的身份` 之前的开场白；
 *   · `## 你的性格` 只留到第二个换行（= 一行）；
 *   · 最后**硬截断 200 字**（还会切在半句上）。
 * 真实数据：德丽莎整卡 2212 字 ⇒ 实际生效 200 字。吃这个亏的链路有：
 * 群聊成员资料卡、梦境 system3、多角色参考 otherPersona、触摸/亲密即时反应、朋友圈互动、事件、信箱。
 *
 * 这些断言钉的是**行为**（保留了什么、在哪切断的），不是"源码里有没有某一行"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cropPersonalityForEmotion, getPersonalityCropMaxChars } from '../src/services/emotionEngine.js'

/** 形状照真实角色卡（含 ## 你的身份 / 性格 / 好恶 / 外观 四节），长度接近真实整卡 */
const CARD = [
  '你是德丽莎·阿波卡利斯，天命教会的主教，也是圣芙蕾雅学园的学园长。',
  '你看起来是个小女孩，实际上比在场所有人都年长，说话时常带着一点居高临下的从容。',
  '',
  '## 你的身份',
  '德丽莎·阿波卡利斯，天命教会主教、圣芙蕾雅学园学园长。你同时是「毗湿奴」的宿主，',
  '这让你必须时刻控制自己的情绪，也让你的疲惫比任何人都深。你习惯把责任一个人扛下来。',
  '',
  '## 你的性格',
  '- 你对外人严厉、嘴硬，常用命令句和反问句，例如「这种小事也要我教吗」；',
  '- 你对自己人极度护短，一旦对方受伤你会立刻失去冷静，语气从命令变成急促的追问；',
  '- 你不擅长表达关心，关心会伪装成责备，例如「下次再这样我就不管你了」；',
  '- 你讨厌被当成小孩子，被说「小个子」时会真的生气，但不会承认自己在生气。',
  '',
  '## 你的好恶',
  '- 喜欢：苦咖啡（喝不惯别人加的糖）、甜食但嘴上说不要、整理文件、学园里的孩子；',
  '- 讨厌：被人俯视着说话、被问年龄与身高、无谓的牺牲、把责任推给下属的人。',
  '',
  '## 你的外观',
  '银白色长发，头顶戴着黑色的头饰；穿着白底蓝色镶边的教会制服，外披黑色斗篷；',
  '身高明显比同龄人矮，站在人群里需要仰头看人。',
].join('\n')

test('① 保留身份与性格（不是只剩开头那一小段）', () => {
  const out = cropPersonalityForEmotion(CARD, '德丽莎')
  assert.ok(out.includes('天命教会主教'), '身份段要留下')
  assert.ok(out.includes('嘴硬'), '性格段要留下（旧版只留一行 ⇒ 这种细节全丢）')
  assert.ok(out.includes('苦咖啡'), '好恶段要留下')
  // 核心回归：旧版只有 200 字 = 9%，现在必须明显更完整
  assert.ok(out.length > 400, `应当明显长于旧的 200 字上限，实际 ${out.length}`)
  assert.ok(out.length / CARD.length > 0.3, `保留比例应当远高于旧的 9%，实际 ${(out.length / CARD.length * 100).toFixed(1)}%`)
})

test('② 绝不以半句结尾（要么完整句号，要么带「其余设定略」）', () => {
  for (const max of [150, 200, 260, 400, 700, 5000]) {
    process.env.PERSONALITY_CROP_MAX_CHARS = String(max)
    const out = cropPersonalityForEmotion(CARD, '德丽莎')
    const tail = out.trimEnd().slice(-20)
    const okEnding = /[。！？…）]$/.test(out.trimEnd()) || /（其余设定略）$/.test(out.trimEnd())
    assert.ok(okEnding, `上限 ${max} 时结尾必须完整，实际结尾：…${tail}`)
    // 不许出现"切在半个词上"就结束：结尾不应当是逗号/顿号/顿断的连接词
    assert.ok(!/[，、；：]$/.test(out.trimEnd()), `上限 ${max} 时不许以逗号/顿号/分号结尾：…${tail}`)
  }
  delete process.env.PERSONALITY_CROP_MAX_CHARS
})

test('③ 上限可配置，且结果不超上限', () => {
  assert.equal(getPersonalityCropMaxChars(), 700, '默认上限 700')
  for (const max of [200, 350, 900]) {
    process.env.PERSONALITY_CROP_MAX_CHARS = String(max)
    assert.equal(getPersonalityCropMaxChars(), max, '环境变量生效')
    const out = cropPersonalityForEmotion(CARD, '德丽莎')
    assert.ok(out.length <= max + 20, `上限 ${max} 时结果 ${out.length} 不该超出（省略说明允许略超几个字）`)
  }
  process.env.PERSONALITY_CROP_MAX_CHARS = 'abc'
  assert.equal(getPersonalityCropMaxChars(), 700, '非法值回落默认')
  delete process.env.PERSONALITY_CROP_MAX_CHARS
})

test('④ 外观段不进人格文本（生图链由 characterPersona.js 负责，别重复塞）', () => {
  const out = cropPersonalityForEmotion(CARD, '德丽莎')
  assert.ok(!out.includes('银白色长发'), '外观不该出现')
  assert.ok(!out.includes('斗篷'), '外观不该出现')
  assert.ok(!out.includes('## 你的外观'), '外观小节标题不该出现')
})

test('⑤ 既有语义不倒退：「你」→ 角色名、签名不变、空输入安全', () => {
  const out = cropPersonalityForEmotion(CARD, '德丽莎')
  assert.ok(!out.includes('你'), '「你」应被全部替换为角色名')
  assert.ok(out.includes('德丽莎'), '替换成的是角色名')
  assert.equal(cropPersonalityForEmotion('', '德丽莎'), '', '空输入返回空串')
  assert.equal(cropPersonalityForEmotion(null), '', 'null 返回空串')
  assert.equal(typeof cropPersonalityForEmotion(CARD), 'string', '不传名字也要能用（默认 assistant）')
  assert.ok(cropPersonalityForEmotion(CARD).includes('assistant'), '默认名仍是 assistant（向后兼容）')
})

test('⑥ 没有规范小节的旧卡：整卡回退 + 仍然不切半句（别把老角色清空）', () => {
  const legacy = '你是瓦雷莎，说话慢悠悠的，喜欢在句尾拖长音。你不太会拒绝别人，也不擅长说谎。'.repeat(20)
  const out = cropPersonalityForEmotion(legacy, '瓦雷莎')
  assert.ok(out.length > 200, '旧卡不能被压成一小段')
  assert.ok(/[。！？…]$/.test(out.trimEnd()) || /（其余设定略）$/.test(out.trimEnd()), '旧卡也不许切半句')
})
