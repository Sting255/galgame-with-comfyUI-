# 反重复与话题推进（车轱辘话 / 钻牛角尖治理）

> 设计口径冻结于 2026-09-30（专题：`目标/规划/专题-车轱辘话与钻牛角尖.md`）。
> 本文件是**实现与验收口径**：别人要改这套逻辑，先改这里，再改代码。

## 一、要解决的问题

角色连续几轮在同一个话题上换着说法重复（车轱辘话），或者情绪落到某个角落之后翻来覆去纠结同一件事（钻牛角尖）。
成因链与代码证据见专题 §一；本项目特有的放大因素：聊天历史按轮累积、`<reply_length>` 长度条鼓励短回复原地打转、
采样参数此前完全没有反重复约束、RAG 每轮召回同一批记忆、人格卡口癖每轮在场。

## 二、四层防线与阶段划分

| 层 | 内容 | 阶段一是否落地 |
| --- | --- | --- |
| L1 上下文层 | 近端自身输出标注（`<recent_self_output_note>`，静态块，零额外调用） | ✅ 已落地 |
| L2 指令层 | 动态反重复 / 反钻牛角尖指令（`<anti_repetition>` / `<topic_progress>`） | ✅ 已落地 |
| L3 采样层 | `presence_penalty` / `frequency_penalty` 透传（默认不发送，用户显式填才生效） | ✅ 已落地 + **真网关探针已通过**（2026-09-30，见 §六） |
| L4 输出层 | 输出侧重叠检测（每轮都算）+ 自动升级；超阈值**重写兜底**（默认关） | ✅ 检测/升级已落地（阶段二）；⛔ 重写未接线，见 §十 |

RAG 召回多样性（专题 L1-2）仍未做（阶段二的可选项，本轮未纳入）。

## 三、检测口径（唯一实现在 `agent-core/src/services/antiRepetition.js`）

检测器是**纯函数**：输入「她最近几轮说过什么 + 最近情绪快照」，输出要注入的块或 null。
不读全局配置、不查库、不调 LLM —— 因此单测可以直接喂合成样本。

### 3.1 文本清洗

1. 去掉消息末尾的生图 JSON（`{"prompt":"..."}`）——那是系统附加的，不是她说过的话。
2. 标点/空白**不删除，而是替换成句界分隔符 `\u0001`**：否则相邻句子会粘成一条长串，
   跨轮公共子串会把两句不相干的话连成一个"话题词"。话题词提取时按分隔符切片，永不跨句。
3. 超长轮次只取**尾部 240 字**参与比较（车轱辘话通常表现为"结尾又绕回同一个说法"）。

### 3.2 车轱辘话（`detectRepetition`）

- 相似度用字符 bigram 的 Dice 系数：`2×|A∩B| / (|A|+|B|)`。
- 阈值 `REPETITION_HIGH_OVERLAP = 0.6` 视为"同一话题在打转"。
- 判档：
  | 条件 | 档位 | 注入 |
  | --- | --- | --- |
  | 末尾连续 ≥2 段高重叠（= 最近 3 轮都在同一话题） | `strong` | `<anti_repetition mode="strong">`，点名话题词 + 禁止再谈 |
  | 只有 1 段高重叠（2 轮），或"上段高、本段低" | `mild` | `<anti_repetition mode="mild">`，温和提醒，**不点名** |
  | 无高重叠 / 轮次不足 2 | `none` | 不注入（零 token） |

  温和档刻意不点名：两轮证据下的公共子串太容易是"同一句话"，点名会误伤。

### 3.3 话题词提取（`extractTopicKeywords`）

- 候选 = **相邻轮的公共连续子串**（不是 2 字滑窗词频）。中文没有分词器时，滑窗会造出大量跨词边界噪声
  （「现在已经很晚了」→「在已」「经很」），词频再高也不是话题。
- 片段只在**子句边界**（句界符、换行、中文语气词/助词、标点）处切分，并掐掉首尾功能词；
  单段最长 12 字——避免把二十几字的整句话塞进 prompt。
- 程序时间/日程词（`TIME_SCHEDULE_WORDS`，含「明天/早上/睡觉/日程/安排…」）**不当话题词点名**：
  连续几轮都在复述日程时，强档退回「刚才那个话题」的兜底措辞（档位照记，只在措辞上降级）。
- 提取不出话题词 → 不注入。

### 3.4 钻牛角尖（`detectTopicLock`）· **2026-09-30 口径变更（P0-1）**

> ⚠️ **旧口径是错的，且缺陷在真实存储里必然成立**：原文要求"**最近 4 轮快照**的 V/A 都贴着极值"。
> 但 `emotion_snapshots` 表**每个会话只保留最新一行**：
> `db/index.js:154`（`conversation_id TEXT NOT NULL UNIQUE`）+
> `migrateEmotionSnapshotsUnique`（删历史 + 重建带 UNIQUE 约束）+ `emotionEngine.saveEmotionSnapshot`
> 用 `INSERT OR REPLACE` 写入。于是 `fetchRecentEmotionSnapshots(..., { limit: 8 })` **永远只回 1 行**，
> `rows.length < 4` 恒真 ⇒ `<topic_progress>` **从未注入过、也不可能注入**。
> 36 条单测全绿是因为它们直接喂合成数组、**绕过了查库层**（教训见 §十）。

**现在的口径（方案 A）：当前情绪极值 × 文本侧话题锁死**，两个条件都必须成立：

1. **当前情绪极值**（`isCurrentEmotionExtreme`）：**最新那一行**快照的 V 或 A ≥0.8 或 ≤0.2。
   存储里只有一行 = 当前值，所以单行判定即可；不再要求"多行都极值"。
   理由文案不再是 `emotion_not_extreme`（那句在真实数据下永远是假的），改为
   `current_emotion_not_extreme`。
2. **文本侧证明话题锁死**（`TOPIC_LOCK_MIN_TOPIC_TURNS = 4`）：最近 **4** 轮原文全部落在同一话题
   （`window = texts.slice(-4)`，相邻轮重叠 ≥0.6 的段数 + 1 ≥ 4），且能提取出话题词
   （提取时排除程序时间/日程词；全被排除 → 不注入）。
   轮数不足 4 ⇒ `not_enough_turns`；话题换了 ⇒ `topic_changed`。

**持续性为什么改由文本侧证明**：真实存储里唯一"跨多轮"的证据就是原文历史（`raw_messages` 每轮都留），
所以把"她连续多轮都在纠结这件事"的证明放在那里才成立；情绪只回答"此刻是否处于极值"。

**与升级档的互斥（重要）**：`<topic_progress>` 是"情绪被钉住"的专用提示，而阶段二的
`mode="escalated"` 是"重复太多"的通用升级档。**同一轮只给一条最强约束**：
`escalated` 命中时 `topicProgressBlock` 恒为 `null`（`topicLock` 仍被记录）。
因此在**默认配置（`antiRepetitionEscalation` 开）**下，"4 轮高重叠 + 当前极值"这一轮注入的是
`escalated` 块；`<topic_progress>` 出现在"升级开关关掉 / 升级条件不满足但仍话题锁死"的场景
（例如 4 轮同话题但重叠率落在 0.6~0.75 之间）。
两者措辞不同：`escalated` 要求"换话题 / 推进新事"，`<topic_progress>` 要求"自我打断 / 分心 / 做个小决定"。

`<topic_progress>` 命中时**不再叠加** `<anti_repetition>`（前者是后者的更强形态）。

### 3.5 与催眠的优先级（专题 §五 风险条）

催眠「完全控制」轮（`hypnosisNeedsFullPerformance`：深度催眠 + 身体受控 + 意志未醒，或强制高潮指令）
**就是要重复执行指令**，反重复块会跟催眠块直接打架 → 检测器 `hypnosisActive=true` 时显式跳过，
日志记 `skipped=hypnosis`。

## 四、注入位置（`agent-core/src/routes/chat.js`）

`dynamicBlocks` 顺序（只列相关项）：

```
<reply_length>                    ← 原有：随好感度变化的长度条
<anti_repetition> / <topic_progress>  ← L2，紧跟长度条之后（先解除"短回复原地打转"，再谈推进话题）
<VAD 情绪>  <active_chat_history>     ← 原有
<recent_self_output_note>             ← L1-1，紧跟在历史之后
…（RAG / 时间 / 小镇 / 日刊）…
<attitude_reminder>                   ← 原有
催眠块（状态 / 指令 / 遗忘提示）        ← 原有，整块后置，优先级仍最高（task-42 口径不动）
```

- 实现顺序（长度条 → L2 → 情绪 → 历史 → L1-1）与专题里"历史之后"的字面顺序**不同**：本项目的既有惯例是
  **本轮最硬的指令靠近提示词末尾**（见 chat.js 内同一处的注释）。专题的硬约束「在 `<reply_length>` 之后、
  催眠块之前」两条都满足。
- 预算降级（`applyBudgetToBlocks`，默认关）作用于整段末尾：若将来开启，这几块属于优先丢弃项；
  这是有意的（它们是增强提示，不是硬约束）。

## 五、开关

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `config.features.antiRepetition` | 开 | L1-1 + L2 车轱辘话（关闭 → 一个块都不注入，与加功能前逐字节一致） |
| `config.features.antiRepetitionLock` | 开 | L2 钻牛角尖（只在 `antiRepetition` 也开时才有意义） |
| `config.features.antiRepetitionEscalation` | 开 | **阶段二自动升级**：连续高复述 → 下一轮注入 `mode="escalated"`；关掉 = 完全按阶段一判定 |
| `config.features.antiRepetitionReroll` | **关** | 阶段二**重写兜底**（超阈值再请求一次 LLM 替换输出）。**2026-09-30 已接线**，见 §十二 |
| `config.llm.antiRepetitionPenalty` | `null` | `presence_penalty`；null = 请求体里不发送 |
| `config.llm.antiRepetitionFrequency` | `null` | `frequency_penalty`；null = 请求体里不发送 |

- 逐条覆盖：`updateFeatureFlag('antiRepetition' | 'antiRepetitionLock' | 'antiRepetitionEscalation' | 'antiRepetitionReroll', bool)`
  → `system_settings.feature_*`（四个键都在 `db/settings.js` 的 `SETTING_TO_CONFIG` 里注册）。
  前端可通过既有 `PUT /api/config/features` 直接切换升级开关（不需要新增接口）。
- penalty：`PUT /api/config/anti-repetition`，body `{ presence, frequency }`，范围 `[-2, 2]`，空串 = 清空回 null。
  落库键 `anti_repetition_penalty` / `anti_repetition_frequency`，两者都在 `db/settings.js` 的
  `SETTING_TO_CONFIG` 里注册（`type: 'penalty'`：空串 → null，非法 → 保留代码默认）。
- 设置页入口：`web-ui/src/views/SettingsView.vue` 的「反重复与话题推进」卡片（两个 LinsheSwitch +
  两个 penalty 输入框 + 保存），用 Linshe 组件，不覆盖组件皮肤。

## 六、采样参数（L3 / 规划 C5）的核实结论与边界

- **核实结论（离线，可复跑）**：改造前 `llm-client.js` 的请求体里**根本没有** `presence_penalty` /
  `frequency_penalty`（全仓 grep 0 命中）；改造后两个字段在 `_chatSyncInner` 与 `_chatStreamInner`
  中可选透传，**默认 null → 请求体与改造前逐字节一致**。
- 证据：`agent-core/test/antiRepetitionPenalty.test.js`（打桩 `node-fetch`，抓真实请求体，不产生任何真实调用）。
- **未做的部分（已知边界）**：专题与补记 7 要求「先拿真网关打一发探针确认参数被接受，再上 UI」。
  当时属真实 LLM 调用（花用户额度），按 `目标/编程模式-DeepSeek.md` §0/§8 必须先请示 ⇒ 那一轮未做。
  **2026-09-30 已由 Lead 授权并执行（见下）**。当前 UI 提示仍是"部分第三方中转站不接受该参数，出错请清空重试"，
  且默认留空 ⇒ 不开这个开关就完全没有行为变化。
- **真网关探针结果（2026-09-30，Lead 授权「只允许 1 次」，写手 hypno-core 执行）**：
  · 手段：**真实库副本**（`%TEMP%` 下的一次性拷贝，含 `-wal`/`-shm`，跑完即删；真实 `agent-core/data/agent.db` 全程只读）
    + 用户自己的 LLM 配置（`http://127.0.0.1:7863/v1`，模型 `cn:deepseek-v4-flash`）；
    **恰好 1 次**请求：`presence_penalty=0.5` + `frequency_penalty=0.5`，`max_tokens=8`、`temperature=0`、`retries=0`。
  · **结果 = 接受**：HTTP 200，回复 `"好"`，1425ms。⇒ 该网关**接受**这两个字段，设置页可以放心让用户显式开启。
  · 默认值仍保持 `null`（不发送）：不填 = 与改造前逐字节一致，这是产品选择，不是兼容性限制。
  · ⚠️ 只覆盖**这一个网关**；换中转站 / 换模型仍需重新探（失败表现通常是 400，或回复明显异常）。

## 六之二、阶段二：输出侧检测与自动升级（2026-09-30 落地）

用户裁决：**阶段一保持温和，阶段二才做升级**。因此升级的每一环都必须有阈值、退路、开关。

### 6.2.1 输出侧检测（零额外调用，每轮都算）

- **检测 = 数字，不是重拍**：`detectRepetitionWithEscalation(turns, { escalationEnabled })` 在阶段一
  `detectRepetition` 的结果上追加四个数字：
  | 字段 | 含义 |
  | --- | --- |
  | `overlaps[]` / `maxOverlap` | 相邻轮两两 bigram 重叠率（阶段一就有） |
  | `escalatedRunLength` | **末尾连续**多少段 ≥ `REPETITION_ESCALATED_OVERLAP`(0.75) |
  | `runLength` | 末尾连续多少段 ≥ base 阈值 (0.6) |
  | `trend` | `normal` / `trending`（窗口里出现过 ≥1 段超升级阈值，却没连够）/ `escalating`（已升档） |
- 生成结束后 `chat.js` 再打一行可直接 grep 的量化日志（无论开关开没开）：

  ```
  [anti-repetition] output-check mode=strong trend=trending overlap=0.86 esc_run=2 run=2 turns=8 escalated=0 chars=57
  ```

  「她这一轮的原文」会在**下一轮**成为检测输入的"最近一轮"，跨轮累积因此天然成立（不需要额外状态）。

### 6.2.2 自动升级（把约束升一档，不再请求）

| 条件 | 档位 | 注入 |
| --- | --- | --- |
| 末尾连续 ≥ `REPETITION_ESCALATED_PAIRS`(3) 段 ≥ 0.75（= 最近 4 轮都在复述） | `escalated` | `<anti_repetition mode="escalated">`：明确要求**换话题或推进一件新事**，并说明这是升级约束 |
| 末尾连续 ≥2 段 ≥ 0.6（3 轮） | `strong` | 阶段一的强档（点名话题词 + 禁止再谈） |
| 只有 1 段 ≥ 0.6 | `mild` | 阶段一的温和档（不点名） |
| 都不满足 | `none` | 不注入 |

- **升级要慢**：单段"像"不够，必须连续 3 段都在复述同一话题。
- **退路要快**：升级态**没有记忆**，完全由"末尾连续段"推导 ⇒ 末尾只要断 1 段，`escalatedRunLength` 立刻归零、
  本轮就退回 `strong`/`mild`/`none`。刻意**不做**"再观察 N 轮才撤"的粘滞逻辑，
  避免"她已经不重复了、却还在被要求换话题"的赶话题手感（`REPETITION_ESCALATION_RELEASE_PAIRS = 1` 只用于日志文案）。
- **同一轮只给一条最强约束**：升级档命中时不再注入 `<topic_progress>`（`topicLock` 仍被记录，只是不注入）；
  催眠「完全控制」轮仍然整体跳过（升级态也不例外）。
- **可关**：`antiRepetitionEscalation = false` → `detectRepetitionWithEscalation` 返回与阶段一
  `detectRepetition` **同档同 reason 同话题词**的结果，`trend` 恒为 `normal`（有测试逐字段钉住）。

### 6.2.3 注入位置（与阶段一同一处，顺序不变）

升级块与阶段一的车轱辘话块**共用同一个注入点**（`chat.js` 里 `<reply_length>` 之后那一处）：
同一时刻只有一个 `block` 字段有值，所以"同一轮注入两块"在结构上不可能发生。
升级**不是**新开一次 LLM 调用，只是把下一轮的那一条指令写硬一档。

## 七、验收口径

1. **单测**（`agent-core/test/antiRepetition.test.js`，27 条）：3 轮高重叠 → strong；2 轮高重叠 → mild；
   无重叠 → null；催眠轮 → null；**当前情绪极值 + 文本侧话题锁死 4 轮 → `<topic_progress>`**；
   当前情绪不极端 / 文本侧不足 4 轮 / 话题换了 → 不注入；只剩日程词的轮次
   → 不注入 topic_progress 但仍提示车轱辘话；跨轮/跨表对齐、查库失败降级、日志格式。
1.5 **wiring 级**（`agent-core/test/antiRepetitionTopicLockWiring.test.js`，8 条，P0-1 新增）：
   真实建表 + 只写一行快照 + 走 `fetchRecentEmotionSnapshots`/`fetchRecentAssistantTurns` 真实查库路径 →
   极值 + 锁死 4 轮必须注入 `<topic_progress>`（**修复前此断言为红**）；升级档命中时 topic_progress 让位；
   三类不该注入的反例；以及"表里确实只剩一行"的前提校验。**纯函数单测不能替代它。**
2. **采样透传**（`agent-core/test/antiRepetitionPenalty.test.js`，5 条）：默认不发送；显式/全局值透传；
   0 也要发送；sync 与 stream 同口径；extraBody 仍可覆盖。
3. **HTTP 契约**（`agent-core/test/antiRepetitionApi.test.js`，5 条）：字段形状、保存/清空/400、
   `system_settings` 映射可读回（重启不丢），以及 **D2 reroll 开关经 `PUT /api/config/features` 落库并装回 config**。
3.5 **阶段二升级**（`agent-core/test/antiRepetitionEscalation.test.js`，16 条）：阈值边界（1/2/3 段）、
   0.6~0.75 之间不升级、5 轮不越级、换话题立刻回落、只重复一次回落一档、关掉后与阶段一逐字段一致、
   催眠优先、升级档不与 `<topic_progress>` 叠加、指标形状、常量导出、以及 `chat.js`/`config`/`settings` 接线守卫。
   `agent-core/test/antiRepetitionWiring.test.js`（2 条，Lead 加）：TDZ 回归守卫，改动 `chat.js` 后必须仍然绿。

## 十二、重写兜底 reroll（D2，2026-09-30 落地）

用户口径：「D2 你做个开关，放到设置里说明」。开关在设置页（`SettingsView.vue` 的「重写这一轮」，LinsheSwitch），
键 `feature_antiRepetitionReroll`；后端 `config.features.antiRepetitionReroll`，**默认关**。

### 12.1 触发条件（复用既有判定，不新造检测器）

一轮生成（含 @memory 二次续写）结束后，**同时**满足下面全部条件才重写：

| # | 条件 | 说明 |
| --- | --- | --- |
| 1 | 开关打开 | 关着时 `shouldReroll` 第一个判断就返回 `disabled`，**零额外调用、零事件、逐字节不变** |
| 2 | 检测档位达到既有阈值 | `mode === 'strong'` 或 `'escalated'`（`mild` 属阶段一「温和」，不重写） |
| 3 | 本轮还没重写 | `firedCount < REPETITION_REROLL_MAX_ATTEMPTS`（常量 = **1**） |
| 4 | 非催眠「完全控制」轮 | 那轮本就该照指令重复 |
| 5 | 客户端还在、本轮有内容 | 断开了不再白花一次调用；空输出无处可替 |

判定全是纯函数：`shouldReroll({enabled,result,firedCount,hypnosisActive,clientGone})` → `{fire,reason,instruction,maxAttempts}`；
`reason` 取值：`disabled` / `client_gone` / `hypnosis` / `already_rerolled` / `no_result` / `below_threshold` /
`repetition_strong` / `repetition_escalated`（可直接 grep 日志定位）。

### 12.2 只重写一次（成本上限）

- 每次重写 = **多一次真实 LLM 调用**（同样的 prompt 体量）。
- `chat.js` 在 fire 前把计数器 `antiRepRerollFired += 1`，**同一轮**再进判定必然 `already_rerolled`；
  重写后仍复读也**不再重写**（防连环重试打爆额度）。
- 日志：成功 `[anti-repetition] reroll fired reason=… mode=… turns=… chars=…` → `reroll done chars=…`；
  失败 `[anti-repetition] reroll failed, keeping original output: <err>`（warn）。

### 12.3 指令块（贴在原 user 消息之后）

```
<anti_repetition_rewrite>
（系统提示：你上一条回复因为重复复述已被作废。请**重新**写一条完全不同的回复。）
不要再围绕「<刚复述过的话题词，最多 4 个>」说同一件事，也不要衔接、延续上面那半句；
换一个角度、换一件具体的事，或者干脆把话题转向新的方向。字数与语气照旧。
</anti_repetition_rewrite>
```

没有话题词时兜底为「刚才那个话题」。**不**清空对话历史、**不**重发整套 system（前缀缓存仍可命中）。

### 12.4 前端替换事件 `replace_last_assistant`（后端 → 前端 SSE）

```jsonc
{
  "content": "重写后的完整文本（所有文本气泡用 \\n\\n 拼起来）",
  "segments": [
    {
      "content": "句子",
      "emojiKeys": ["开心"],
      "stickerUrls": ["/emoji/char_2/happy.png"],
      "images": []
    }
  ],
  "reason": "reroll",
  "turn": 1759219200000
}
```

**`segments[]` 逐字段契约（2026-09-30 定名，别猜）**：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `content` | string | 该气泡的文本（表情标记已剥掉） |
| `emojiKeys` | string[] | 命中的表情 key；**仅诊断/日志用，前端不能拿它渲染**。可空数组 |
| `stickerUrls` | string[] | **表情图真正渲染用的 url**，顺序与 `emojiKeys` 一一对应。**必须由后端下发**（前端没有 key→url 映射）；就是前端 `sticker_images` 里存的那些 url（与原始 `token`/`msg_saved` 下发的 url **逐条一致**）。**空数组/缺省 = 这轮没换表情**，前端保持原样、**不清空** |
| `images` | string[] | 普通图片 url 数组（既有语义，与 `stickerUrls` 分开） |

- **语义**：把**刚显示的那条 assistant 气泡**整段换成本事件的内容；`segments` 保留逐气泡的文本/表情包/图片，
  前端替换后**不能丢表情包与图片**（`content` 只是简单路径）。
- 表情 url 的来源：`chat.js` 用**同一份 `emojiMap`** 对原始段再解析一次 `parseEmojiText(...).images`
  （`parseEmojiText` 命中表情时把 url 放进 `images`，key 放进 `keys`），因此 `stickerUrls` 与当场
  `token.images` 下发的 url 完全同源。
- `turn` = 服务端时间戳，「替换的是哪一轮」的校验用；`reason` 目前恒为 `reroll`（后续可扩展）。
- **只在重写成功后发**：失败/超时/空输出 ⇒ `chat.js` 恢复原输出且**不发**该事件（否则用户看到空白）。
- 落库以重写后的内容为准：`raw_messages` / `messages` 都写重写版，刷新后与直播画面一致。
- 前端接收方由 **hires-ui** 负责（`web-ui/src/stores/chat.js`）；后端只负责发出，字段与语义冻结在本节。

### 12.5 失败与边界

- 重写失败（网络/超时/空流）只 `warn`，**保留原输出**，整轮不失败、不发替换事件、不影响落库。
- 与 `@memory` 续写的顺序：先跑完 @memory 二次续写，再考虑重写（重写基于**最终那一版**）。
- 重写请求不带 @memory 重定向：重写只是「同一轮换一种说法」，不做二次检索（避免成本叠加）。
- 群聊不走 reroll（`groupChatEngine` 的文本侧口径独立，本轮未接）。

### 12.6 测试与验收

- 判定层 `agent-core/test/antiRepetitionReroll.test.js`（**17 条**）：关=零变化、开+strong/escalated 触发、
  mild/none/无结果不触发、不会连环、催眠与断开优先、指令块形状、替换事件形状与空输入、
  设置键 `feature_antiRepetitionReroll` 往返、以及 `chat.js` 接线守卫（开关/计数器/日志/事件名）。
- 端到端 `agent-core/test/chatRerollStream.test.js`（**4 条**，真 express 路由 + 真 SSE + 打桩网络）：
  关 ⇒ 只 1 次模型调用且无替换事件；开+强档 ⇒ 恰好 2 次（原始+重写）且发出 `replace_last_assistant`（含 segments，
  **`stickerUrls` 与当场 `token.images` 下发的表情 url 逐条一致**）；
  重写产出为空 ⇒ 保留原输出、无替换事件、无 error 事件；开关缺省 ⇒ 按关处理。

4. **真机（用户）**：连续聊 20~30 轮不开新话题，观察 a) 是否还在换着法重复同一观点；b) 是否出现
   "自我打断 / 转移话题"的自然行为；c) 有没有变得赶话、机械。后端日志搜 `[anti-repetition]`
   可看每轮档位（`mode=` / `overlap=` / `topic_lock=` / `skipped=` / `trend=` / `esc_run=` / `escalated=`），
   另有每轮一条 `[anti-repetition] output-check` 给出复读率与升级段数的量化数字。
   **若觉得约束过硬**：先关 `antiRepetitionEscalation`（回到阶段一的温和档），再不行就关 `antiRepetition`。
   命令行验收（不打真实模型，只看档位）：把 `[anti-repetition]` 行贴出来即可。

## 八、调参入口

阈值全部导出为常量，真机调参**不改逻辑**：

| 常量 | 默认 | 作用 |
| --- | --- | --- |
| `REPETITION_HIGH_OVERLAP` | 0.6 | 判"同一话题在打转"的 bigram 重叠率 |
| `REPETITION_ESCALATED_OVERLAP` | 0.75 | **升级**阈值："这句话我基本说过一遍了" |
| `REPETITION_ESCALATED_PAIRS` | 3 | 连续几段超升级阈值才升档（= 最近 4 轮都在复述） |
| `REPETITION_ESCALATION_RELEASE_PAIRS` | 1 | 撤档口径（断 1 段即撤）；只用于日志文案，判定完全由末尾连续段推导 |
| `REPETITION_STRONG_CONSECUTIVE` | 2 | 强档要求的连续高重叠段数（3 轮） |
| `REPETITION_MIN_TURNS` | 2 | 至少几轮才检测 |
| `EMOTION_EXTREME_HIGH` / `_LOW` | 0.8 / 0.2 | 情绪极值判定（`isCurrentEmotionExtreme`：当前那一行） |
| `TOPIC_LOCK_MIN_TOPIC_TURNS` | **4** | **钻牛角尖真正的门槛**：文本侧（最近几轮原文）至少这么多轮仍在同一话题 |
| `TOPIC_LOCK_MIN_EXTREME_TURNS` | 4 | **遗留**：只有"历史型"辅助 `isEmotionExtremeHeld` 在用；真实存储拿不到多行，别再拿它当检测门槛 |
| `EMOTION_EXTREME_MAX_STEP` | 0.2 | 历史型辅助用的逐轮跨度上限（防"极值区间横跳"误判；当前值单行判定不需要） |
| `MAX_TURN_CHARS` | 240 | 单轮参与比较的尾部字数 |
| `TIME_SCHEDULE_WORDS` | 见文件 | 不当作话题词的日程/时间词表 |

## 九、已知边界

1. 中文没有分词器，话题词是"公共子串 + 子句切分"的近似；它只用于**措辞**（点名话题），
   档位判定只依赖 bigram 重叠率与情绪，不受分词质量影响。
2. `recentAssistantTurns` 与 `recentEmotionSnapshots` 来自两张表：**原文是多轮历史，情绪永远只有 1 行**。
   检测器只把这一行当"当前值"用（`isCurrentEmotionExtreme`），历史多行时也只取最后一行；
   任何"需要多条情绪快照"的判定都不要再写（P0-1 就是这么错的）。
3. **群聊已接入 L2 合并块**（task-26，见 §十一：复用本节同一套纯函数、**不复制检测逻辑**；面向全群只给一块，
   仅当**全群**都处于催眠「完全控制」时才跳过）；朋友圈、奇遇叙事仍未接入（本专题范围之外）。
4. L4 的**重写兜底**（超阈值再请求一次 LLM 替换已流式输出的内容）**未接线**：本项目流式协议没有
   "替换已输出内容"的语义，且多一次调用属于要花用户额度的操作。开关 `antiRepetitionReroll` 已经预留
   （配置 + 落库 + 默认关），但**打开它目前不会有任何效果** —— 接线前必须在设置页说明这一点。
   专题 §十（风险表）里"开启时前端可显示『重新组织语言中…』过渡"那句同样属于未做项。
5. 升级态**没有跨轮记忆**（完全由库里最近几轮原文推导）：对同一条回复手动改库/删库会立刻改变档位。
   这是有意的——少一个状态就少一类"状态与内容不一致"的 bug；代价是无法做"再观察 N 轮"的粘滞退路。
6. **文本侧门槛从 3 提到 4**（`TOPIC_LOCK_MIN_TOPIC_TURNS`）：取 `slice(-4)` 并要求"4 轮都还在同一话题"。
   代价是"3 轮就很像"的场景不触发 `<topic_progress>`（那时仍有 `strong`/`mild` 的车轱辘话提醒兜着）。
   这样改是为了兑现专题 §三的"连续 ≥4 轮"字面口径 —— 以前那个 4 是错在"数快照条数"。
7. **`isEmotionExtremeHeld` 是"历史型"辅助函数**（自适应窗口，给几行看几行），
   真实链路不再使用它；保留是因为它对单行/少行也成立，可被测试与将来的"真的存历史"方案复用。
   它有一个已知特性：窗口比 `minTurns` 短时按实际行数判定（`minTurns` 只是上限），因此
   "3 行都极值"会返回 true —— 别把它当"必须 4 行"的门槛用（那正是 P0-1 的错）。

## 十、教训：别只测纯函数（P0-1，2026-09-30）

**缺陷**：`<topic_progress>` 自上线起**从未注入过一次**。判据"最近 4 条情绪快照都极值"在真实存储里
不可能成立（`emotion_snapshots` 每会话 UNIQUE 只留一行），而 `rows.length < 4 → false` 是个**恒真**的短路。
功能等于不存在，但界面/日志/单测全都没有报警。

**为什么 36 条单测全绿**：那些用例直接 `buildAntiRepetitionInjection({ emotionSnapshots: [四行合成数组] })`，
**绕过了查库层**——它验证的是"给定 4 行极值快照，逻辑对不对"，而真实世界**从来给不出 4 行**。
纯函数单测能证明"逻辑自洽"，不能证明"输入存在"。

**本仓因此固定的规矩**（与 Lead 的 `antiRepetitionWiring.test.js` 同一思路，但更靠前一步）：

1. 任何"检测器依赖某个输入形状"的假设，都必须有一条 **wiring 级测试**：
   `getDb()` 建真表 → 用线上同款写入路径造数据 → 走**真实查库函数** → 断言检测结果。
   本专题的样板：`agent-core/test/antiRepetitionTopicLockWiring.test.js`。
2. 先写**红测试**再改：这次的红测试第一版就是"只写一行快照 → 断言 `topicProgressBlock === null`"，
   它**通过**了——那就是缺陷存在的证据；翻成绿才是修好。
3. 涉及**表结构**的假设（UNIQUE / 每会话一行 / 保留策略）一律以 `src/db/index.js` 的建表与迁移为准，
   注释与文档都可能过时。
4. `reason` 文案也是契约：`emotion_not_extreme` 这种"在真实数据下永远为真"的理由会把排查引向错误方向，
   已改为 `current_emotion_not_extreme` / `not_enough_turns` / `topic_changed` / `no_topic_keyword`。
5. **"全仓没有写入方"要写成源码级断言，不能只写在注释里**（P1 第三次踩坑后的加强）：
   夹具级前提（"某个 `group_` 夹具 0 行"）只能证明**造出来的**那一刻；真正的风险是**以后有人新增一个写入点**。
   `antiRepetitionTopicLockWiring.test.js` 里现在有一条**扫全仓**的断言：找出所有 `saveEmotionSnapshot(` 调用点，
   解析第一个实参在**同文件内调用点之前最近一次**的赋值，断言不含 `group_`（并有"至少存在一个 `char_` 写入方"
   的反向证据，防止扫描口径写错时静默通过）。建议所有"某类存储永远为空/永远只有一行"的假设都照这个写。
6. **日志拼接用精确断言，不要只 `includes`**：`reason` 重复过一次标签
   （`a + current_extreme current_extreme(...)`），而当时所有断言都是 `includes`，一个都没红。
   任何"给人看的字符串"（日志、块首行、reason）都值得一条 `assert.equal` 精确断言。

## 十一、群聊反重复（P2-3 / task-26）

**背景**：用户主诉「说话容易说着说着就车轱辘话了」**从来没有限定私聊**，而群聊每轮一次调用演所有人，
是同一问题的放大器；在此之前 `groupChatEngine.js` 里 grep 反重复 = **0 命中**（本专题只接了私聊）。

**目标与口径**：群聊轮接**同一套** `services/antiRepetition.js` 纯函数，给一个**面向全群的合并块**，
复用两个既有开关，**不新增设置键**。

### 11.1 取数与合并口径（为什么只有一块）

| 导出（`services/groupChatEngine.js`） | 说明 |
| --- | --- |
| `GROUP_ANTI_REPETITION_TURNS = 6` | 看最近 6 轮，与私聊 `chat.js` 的默认窗口一致 |
| `buildGroupAntiRepetitionBlock({turns, emotionSnapshots, hypnosisActive, escalationEnabled, enabled})` | **纯函数**：直接调 `buildAntiRepetitionInjection`，返回 `{enabled, block, result}` |
| `collectGroupAntiRepetitionBlock(group, {sinceRawId})` | 接线入口：取数（`fetchRecentAssistantTurns` / `fetchRecentEmotionSnapshots`）→ 判定 → 日志 |
| `isWholeGroupHypnotized(members)` | 全群是否都处于完全控制（见 11.4） |

- **不按成员各成一块**：群聊每轮只发**一次** LLM 调用、输出是**一份剧本**，约束本来就该是全局的；
  而 `fetchRecentAssistantTurns` 取回来的每一条 raw 就是那一轮**所有人发言的合体**（群聊一轮一条 assistant raw），
  所以「该群最近几轮的剧本」天然给出全群口径的重复判定 ⇒ **一个块**。
- 同一轮只给一条最强约束（`escalated` > `<topic_progress>` > `<anti_repetition>`）——这个优先级来自
  `buildAntiRepetitionInjection` 自身，群聊侧**不做二次判定**（保证"同一轮两块"结构上不可能）。
- 起点用该群的摘要 checkpoint（`rolling_summaries.end_msg_id`，与 `buildTranscript` 同一口径）：
  只看**还在上下文里**的轮次，与私聊`chat.js`同口径。
- **遗忘窗口**：群侧遗忘区间只有**时间**（`{fromAt,toAt}`），而 `fetchRecentAssistantTurns` 的
  `excludeWindows` 只认 raw id ⇒ 这里把时间区间换算成 raw id 区间再传（`resolveForgottenRawWindows`，读失败就不过滤）。
  只影响**检测输入**（因此也影响话题词），注入内容与群聊 transcript 的屏蔽口径保持一致。

### 11.2 块序与理由

`directiveBlocks`（同一轮拼成一条 `<round_directive>`）里与本次相关的顺序：

```
<round_message_limit> …            ← 本轮格式/长度（对位私聊的 <reply_length>）
发图规则（idle/lull 或抽卡）         ← 同属"本轮格式"
<anti_repetition> / <topic_progress>  ← 本次新增：输出侧约束，紧跟格式约束之后
<member_private_memory> …          ← 内容素材（私聊记忆）
<touch_action> + <touch_bystander> ← 叙事提示（task-17）
催眠块（状态 / 指令）              ← 仍然最后：本轮最硬约束
```

理由（与私聊 §四 对齐）：

1. 私聊是「`<reply_length>` → `<anti_repetition>`/`<topic_progress>` → 情绪 → 历史 → …」，
   反重复是**输出侧约束**，紧跟长度条之后、**排在上下文类块之前**（先给约束，再给素材）；
   群聊里与 `<reply_length>` 对位的就是 `<round_message_limit>`（＋同属本轮格式的发图规则）⇒ 接在它们后面。
2. **不跟 task-17 的群聊动作块打架**：动作块是"这一下接触发生了，让她演出反应"的**叙事提示**，
   与"别再重复"这种风格约束语义正交；反重复排在它**之前**，两者都被后面的格式约束覆盖。
3. **不跟催眠块打架**：催眠块保持最后一个（全仓惯例：越靠后越硬）。被完全控制的成员由它压过，
   反重复块不与之争位；`directiveBlocks` 顺序有**源码级断言**钉住（见 11.5 第 ⑦ 条）。

### 11.3 开关（复用既有键，未新增）

| 键 | 行为 |
| --- | --- |
| `features.antiRepetition === false` | **早退**：零查询、零块 ⇒ 与加功能前**逐字节一致**（有测试） |
| `features.antiRepetitionLock === false` | **不注入 `<topic_progress>`**（该键的语义就是"钻牛角尖"）；车轱辘话块不受影响 |
| `features.antiRepetitionEscalation` | 透传升级开关；false = 完全按基础阈值判定（不出现 `mode="escalated"`） |

日志（与私聊同一行格式，可一起 grep；前缀 `[group]` 区分群聊轮）：

```
[group] [anti-repetition] mode=strong overlap=0.86 turns=6 emotionTurns=1 reason=consecutive_high=2
[group] anti-repetition injected: mode=strong turns=6
```

### 11.3b 群聊的 `<topic_progress>` 走**纯文本 ≥6 轮**（P1 / task-27，方案 B）

⚠️ **缺陷**：群聊原先给 `detectTopicLock` 喂的是 `group_<gid>` 会话的情绪快照，而
**全仓没有任何代码给 `group_` 会话写快照**（`saveEmotionSnapshot` 的每个调用点 `conversationId` 都是 `char_<id>`）
⇒ 群聊的 `<topic_progress>` **永不触发**。这是三天内**第三次**同款"检测器输入在真实存储里不存在"
（前两次：私聊 `emotion_snapshots` 只有一行、以及本次），而且是在修同一个坑的同一轮里新引入的。

**现在的口径**：群聊侧**不做情绪判定**，`<topic_progress>` 由**纯文本**触发：

| 侧 | 触发条件 | reason 标签 |
| --- | --- | --- |
| 私聊（`chat.js`，默认） | 当前情绪极值 **×** 文本 ≥ `TOPIC_LOCK_MIN_TOPIC_TURNS`(4) 轮同话题 | `current_extreme(duration_turns=N/need=4)` |
| 群聊（`groupChatEngine.js`） | **纯文本** ≥ `TOPIC_LOCK_MIN_TEXT_ONLY_TURNS`(6) 轮同话题（不做情绪判定） | `text_only(duration_turns=N/need=6)` |

- 实现方式：`detectTopicLock({ ..., textOnly })` 一个参数开关两套门槛，**文本判定那一段是同一份代码**，
  群聊侧没有复制任何检测逻辑；`buildAntiRepetitionInjection({ ..., textOnlyTopicLock })` 把它透传上去。
  结果里另有 `topicLockSource: 'text_only' | 'private' | null` 与 reason 里的标签一致。
- 为什么 6 比私聊的 4 更保守：私聊有"当前情绪处于极值"作证；群里**说话打转 ≠ 钻牛角尖**，
  没有情绪佐证就只能要求更长的持续时间。
- 群聊侧仍会查一次快照（仅用于日志对照，恒为 0 行），但**不参与判定**；即便调用方硬塞一条极值快照也不会改判
  （有测试 `⑨c`）。
- `features.antiRepetitionLock === false` 时群聊直接不注入（`enabled:false`），与私聊"该键管钻牛角尖"的语义对齐。

**reason 拼装契约（2026-09-30 修）**：`detectTopicLock` 返回的 `lock.reason` **自带**来源前缀
（`current_extreme(...)` / `text_only(...)`），所以 `buildAntiRepetitionInjection` 拼 reason 时
**只做"车轱辘话理由 + lock.reason"**，绝不再补一个 tag。曾经补过一次，日志出现
`consecutive_high=3 + current_extreme current_extreme(duration_turns=4/need=4)`（判定与注入块都不受影响，
只是日志脏）。契约用**精确断言**钉住：私聊那一条必须是
`consecutive_high=3 + current_extreme(duration_turns=4/need=4)`，且 `current_extreme` 标签只出现一次。

### 11.4 与私聊的唯一有意差异：催眠跳过取「全群」

私聊在 `hypnosisNeedsFullPerformance`（深度催眠 + 身体受控 + 意志未醒）时**整个跳过**反重复 ——
她被命令重复执行，两个块直接打架。群聊是"一次调用演所有人"，所以这里取 **`isWholeGroupHypnotized`：只有全群都在完全控制态才跳过**。
只要还有没被控制的成员，反重复块照常注入（被控制的那位由**排在其后的**催眠块压过）。
理由：若改成"任一人被控制就跳过"，一个成员处在控制态（最长 720 分钟）就会让**全群**失去反重复保护。
这是有意偏差，若将来要改回"任一即跳过"，改 `collectGroupAntiRepetitionBlock` 里 `hypnosisActive` 一处即可。

### 11.5 验收与边界

- 测试 `agent-core/test/groupAntiRepetition.test.js`（**13 条**）：
  ① 连续重复 → **只有一块**；② 不重复 → 零注入；③ 总开关关 → 零块；④ 升级开关关 → 不出现 `escalated`；
  ⑤ 全群完全控制 → `skipped=hypnosis`、块为 null；⑥ 集成（:memory: 库真取数）；⑦ **源码级块序**断言；
  **⑧ P1 前提**（group_ 会话永远没有快照行，对照私聊 `char_` 能写进去）；
  **⑨ P1 红→绿**（6 轮同话题 + 无快照 → 必须注入 `<topic_progress>`；修复前该断言是 `=== null` 且**永远通过**）；
  ⑨b 5 轮不足（不注入，reason 含 `need=6`）；⑨c 硬塞极值快照也不走情绪判定；⑨d 私聊口径 `need=4` 不变；
  ⑨e 升级档顶掉 topic_progress 时仍有块可注入。
- **已知边界**：
  1. L1-1 的 `<recent_self_output_note>` **未接**群聊：它的位置约定是"紧跟在自己的历史之后"，
     而群聊历史在 `<group_transcript>`（不同的消息）里，本轮只做 L2 的合并块，避免为此改动上下文布局。
  2. 朋友圈、奇遇叙事仍未接入（与本专题 §九 第 3 条一致）。
  3. ⚠️ **§九 第 3 条「只在私聊链路接入；群聊…未接入」自本节起不再成立**（该条由他人小节维护，未就地改写）。
  4. ⚠️ **群聊的 `<topic_progress>` 仍可能被升级档顶掉**：`escalated`（末尾连续 3 段 ≥0.75）优先级更高，
     而"6 轮几乎逐字重复"必然先满足升级条件 ⇒ 那种剧本注入的是 `escalated` 块（措辞更硬、方向一致）。
     纯文本 `<topic_progress>` 出现在"6 轮同话题但相似度在 0.6~0.75"（不够升级）时 ——
     这是**默认配置**下的实际可达范围，若要让"话题锁死"优先需要调优先级（产品口径，未擅自改）。
