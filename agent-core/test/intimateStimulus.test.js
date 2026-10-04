/**
 * 「亲密刺激统一下游」守卫（2026-10-02 用户反馈）
 *
 * 用户原话：
 *   「角色在感受推进面板的时候 不应该只是独立的加敏感值 也会加到心情系统里面去 还有记忆」
 *   「现在的玩具和催眠和心情和记忆好像是完全解耦的一样 根本就没关联」
 *   「角色在进入想做爱的模式 各种亲密动作都会累积到高潮敏感条里 而不是只要在推进面板里抽插才推进」
 *   「角色在禁止高潮模式下 是知道自己一直达不到最高点 会一直渴望 这个也没做出来」
 *
 * 钉三层：
 *   ① 纯计算：刺激量与上限（捆绑倍率、禁止高潮 200 上限、显式 0 不被默认值覆盖）；
 *   ② 渴望曲线：禁止高潮时随累积单调上升，平时为 0；
 *   ③ 接线：触摸 / 玩具 / 推进 / 聊天四条链都真的调到了下游（少一条就又"解耦"了）；
 *   ④ 口径：**没有进行中的场次 ⇒ 一点敏感度都不写**（那是场外的动作，见下面 ④ 的说明）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', 'src')

process.env.DB_PATH = process.env.DB_PATH || ':memory:'
process.env.LOG_TO_FILE = 'false'

const { getDb } = await import('../src/db/index.js')
const { stimulusPlan, denialHunger, STIMULUS_AMOUNT, buildDenialHungerLine, trimReason, MAX_REASON_CHARS, applyIntimateStimulus } =
  await import('../src/services/intimateStimulus.js')
const { saveIntimateScene, emptySceneState } = await import('../src/services/intimateActionService.js')

const db = getDb()
db.pragma('foreign_keys = OFF')

test('① 刺激量：默认按来源、显式值优先、捆绑 ×1.25、上限随"是否禁止高潮"变', () => {
  const base = stimulusPlan({ accumulation: 40 }, { source: 'touch' })
  assert.equal(base.gain, STIMULUS_AMOUNT.touch, '触摸默认加 STIMULUS_AMOUNT.touch')
  assert.equal(base.cap, 100, '平时上限 100')

  const bound = stimulusPlan({ accumulation: 40, bondage: 1 }, { source: 'touch' })
  assert.ok(bound.gain > base.gain, '绑着时每一分刺激更直接（×1.25）')

  const denied = stimulusPlan({ accumulation: 40, denial: 1 }, { source: 'touch' })
  assert.equal(denied.cap, 200, '禁止高潮时上限抬到 200（憋得住，但涨得过满格）')

  // ⚠️ 回归：amount=null 不能被 Number(null)===0 骗成"显式 0"
  assert.ok(stimulusPlan({ accumulation: 0 }, { source: 'toy', amount: null }).gain > 0,
    'amount=null ⇒ 用来源默认量（第一版踩过 Number(null)===0 的坑）')
  assert.equal(stimulusPlan({ accumulation: 0 }, { source: 'toy', amount: 0 }).gain, 0,
    '显式 amount=0 ⇒ 就该是 0（比如推进面板自己那一下，累积已由状态机算过）')
})

test('① 封顶与分层：不越过上限、tier 随累积推进', () => {
  const full = stimulusPlan({ accumulation: 98 }, { source: 'touch', amount: 20 })
  assert.equal(full.after, 100, '平时不许超过 100')
  const denied = stimulusPlan({ accumulation: 195, denial: 1 }, { source: 'touch', amount: 20 })
  assert.equal(denied.after, 200, '禁止高潮时不许超过 200')
  assert.equal(denied.tier, 'broken')
  assert.equal(stimulusPlan({ accumulation: 60 }, { source: 'touch', amount: 0 }).tier, 'edge')
  assert.equal(stimulusPlan({ accumulation: 90 }, { source: 'touch', amount: 0 }).tier, 'overload')
})

test('① 记忆门槛：小刺激不记、够分量或跨过边缘线才记', () => {
  assert.equal(stimulusPlan({ accumulation: 10 }, { source: 'touch', amount: 3 }).memorable, false)
  assert.equal(stimulusPlan({ accumulation: 10 }, { source: 'touch', amount: 9 }).memorable, true)
  assert.equal(stimulusPlan({ accumulation: 58 }, { source: 'touch', amount: 3 }).memorable, true,
    '跨过 60 边缘线也要记（那是"差一点就到了"的关键记忆）')
})

test('② 渴望曲线：禁止高潮时单调上升，平时恒 0', () => {
  assert.equal(denialHunger({ denial: 0, accumulation: 180 }), 0, '没禁止高潮 ⇒ 没有这份渴望')
  const seq = [0, 50, 100, 150, 200].map(a => denialHunger({ denial: 1, accumulation: a }))
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], '累积越高渴望越强')
  assert.equal(seq[0], 0)
  assert.ok(seq.at(-1) >= 0.99 && seq.at(-1) <= 1, '涨到上限时接近满值')
})

test('② 渴望行：没有场次 ⇒ 空串（零注入）；禁止高潮 ⇒ 有台词且点名玩家', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS character_intimate_scene (
    character_id INTEGER PRIMARY KEY, active INTEGER, denial INTEGER, accumulation INTEGER,
    bondage INTEGER, auto_thrust INTEGER, penetrating INTEGER, position_key TEXT, pace INTEGER, started_at TEXT, last_action_at TEXT);`)
  db.prepare("DELETE FROM character_intimate_scene WHERE character_id = 771").run()
  assert.equal(buildDenialHungerLine(771), '', '没有场次 ⇒ 空串（零注入零 token）')

  db.prepare(`INSERT INTO character_intimate_scene
    (character_id, active, denial, accumulation, bondage, auto_thrust, penetrating, position_key, pace)
    VALUES (771, 1, 1, 150, 0, 0, 1, 'missionary', 3)`).run()
  const line = buildDenialHungerLine(771, { chatUserName: 'Tester' })
  assert.ok(line.length > 20, '禁止高潮时要有演法指令')
  assert.match(line, /禁止高潮/)
  assert.match(line, /Tester/, '要点名玩家：对她说话时别演成没事人')
  assert.match(line, /150/, '带上此刻的累积值（她"知道自己一直达不到"要有依据）')

  db.prepare('UPDATE character_intimate_scene SET denial = 0 WHERE character_id = 771').run()
  assert.equal(buildDenialHungerLine(771, { chatUserName: 'Tester' }), '', '没禁止 ⇒ 不注入')
})

test('③b 心情气泡上的文案：只准中文、且有长度上限（用户截图报过英文键名一长串）', () => {
  // 现场：用户看到 💬"玩具刺激（vibe_egg / nipple_clamp / clit_sucker / … 11 件全列）"
  // ⇒ ① reason 里不许出现英文 toyKey；② 长度要兜住（心情气泡就一行）。
  assert.equal(trimReason('玩具刺激：跳蛋、乳夹'), '玩具刺激：跳蛋、乳夹')
  const long = trimReason('玩具刺激：' + Array.from({ length: 11 }, (_, i) => 'toy_' + i).join(' / '))
  assert.ok(long.length <= MAX_REASON_CHARS, `超长要截断（实际 ${long.length}）`)
  assert.ok(long.endsWith('…'), '截断要看得出来')
  assert.equal(trimReason('  多   空格\n要归一 '), '多 空格 要归一', '换行/重复空格要归一成一行')
  assert.equal(trimReason(null), '', '空值不炸')

  const toys = fs.readFileSync(path.join(SRC, 'services', 'toyService.js'), 'utf8')
  // reason 会显示给用户 ⇒ 不许把 toyKey 变量拼进去（这次就是这么漏的）
  const reasonLines = toys.split(/\r?\n/).filter(l => /reason:\s*[`'"]/.test(l) || /reason:\s*'/.test(l))
  for (const line of reasonLines) {
    // 只拦「把键名**本身**写进文案」（`${toyKey}` / `${item.toyKey}`）；
    // 不拦 `getToy(toyKey)?.label` 这种**用键查中文名**的正当用法。
    assert.ok(!/\$\{\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.?toyKey\s*\}/.test(line),
      'reason 里不许直接插 toyKey（英文键名不给用户看）：' + line.trim())
    assert.ok(!/\.map\([^)]*\.toyKey/.test(line), 'reason 里不许列 toyKey 清单：' + line.trim())
  }
  assert.match(toys, /bondToyListText\(/, '玩具件数多时要折成"等 N 件"（别把 11 件全列出来）')
  assert.match(toys, /MAX_REASON_CHARS|bondToyListText/, '长度/文案收口要在玩具侧也体现')
})

test('③ 接线：触摸 / 玩具 / 推进 / 聊天 四条链都真的调了下游', () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

  const touch = read('routes/touch.js')
  assert.match(touch, /import \{ applyIntimateStimulus \} from '\.\.\/services\/intimateStimulus\.js'/, '触摸要导入下游')
  assert.match(touch, /applyIntimateStimulus\(\{[\s\S]{0,200}?source: 'touch'/, '触摸要真的调（各种亲密动作都累积）')

  const toys = read('services/toyService.js')
  assert.match(toys, /applyIntimateStimulus/, '玩具要导入下游（原来是完全解耦的）')
  assert.match(toys, /liveSum/, 'tick 时按"所有戴着玩具的实时强度求和"刺激她（多件同时戴会叠加）')
  assert.match(toys, /source: 'toy'/, '玩具要标明来源')

  const intimate = read('routes/intimateActions.js')
  assert.match(intimate, /source: 'intimate',[\s\S]{0,80}?amount: 0/, '推进面板每一只要写心情/记忆（累积由它自己的状态机算）')

  const chat = read('routes/chat.js')
  assert.match(chat, /buildDenialHungerLine/, '聊天链要注入"渴望"演法指令（否则她像没事人）')
})

/**
 * ④ 口径：**没有进行中的场次 ⇒ 零敏感度写入**（2026-10-03 把这条口径写明并钉住）。
 *
 * 复查时被问到的"口径不一致"：触摸 / 玩具在**场外**一点敏感度都不涨（这里早退），
 * 而「被撞见她正在自慰」（services/privateMomentService.js）不要求场次就给一点。
 * 结论：**保持现状，但把口径说明白**（数值一个都不改）——
 * 用户原话「正常情况性爱相关（含玩具、触摸私密部位）缓慢累加」说的是**在场次里**的动作；
 * 场外随手摸一下、戴个玩具不是"性爱相关事件"；而"她本来就在自慰"不是玩家发起的刺激，
 * 那条链直接 addSensitivity('self_play')，不经过这里。玩具链自己也是这个口径
 * （services/toyService.js：「刚戴上也是一次刺激…场景未进行时下游会自动跳过」）。
 */
test('④ 口径：没有进行中的场次 ⇒ 触摸 / 玩具一点敏感度都不写（有场次才涨）', async () => {
  const id = 952
  db.prepare(`INSERT OR REPLACE INTO characters
    (id, name, display_name, base_prompt, short_prompt, sensitivity, sensitivity_updated_at,
     sensitivity_sex_day, sensitivity_sex_day_gain, sensitivity_sex_last_at)
    VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 0, NULL)`)
    .run(id, '场外口径', '场外口径', '你是测试角色。', '测试角色')
  db.prepare('DELETE FROM character_intimate_scene WHERE character_id = ?').run(id)
  const readRow = () => db.prepare(`SELECT sensitivity, sensitivity_updated_at, sensitivity_sex_day,
    sensitivity_sex_day_gain, sensitivity_sex_last_at FROM characters WHERE id = ?`).get(id)

  const before = readRow()
  for (const source of ['touch', 'toy', 'toy_selfplay', 'hypnosis']) {
    assert.equal(await applyIntimateStimulus({ characterId: id, source }), null,
      `${source}：没有 active 场次 ⇒ 下游直接跳过（返回 null，零写入）`)
  }
  assert.deepEqual(readRow(), before, '没有场次 ⇒ 敏感度相关的列一个都不许动')

  // 正对照：起一场之后照旧缓慢累加（否则这条守卫会把"整条链断了"也一起盖住）
  saveIntimateScene(id, { ...emptySceneState(id), active: true, penetrating: true, actKey: 'vaginal', positionKey: 'missionary', pace: 2 })
  const res = await applyIntimateStimulus({ characterId: id, source: 'touch' })
  assert.ok(res && res.sensitivity > Number(before.sensitivity || 0),
    `有场次 ⇒ 触摸照旧让她慢慢变敏感（增长走 GROWTH.touch_sensitive，数值未改；实际 ${res?.sensitivity}`)
  db.prepare('DELETE FROM character_intimate_scene WHERE character_id = ?').run(id)
})
