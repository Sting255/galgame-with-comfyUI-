# 群聊 ↔ 私聊记忆关联（task-34）

**用户口径**：群里聊的内容要联系到单独聊天，群里和私聊不要分离；**双向**；两种手段都要（扩宽检索范围 ＋ 关键轮次落记忆）；**所有角色都这样**；底线是「像人类一样：群里聊过的，私聊也记得」。

**实现落点**：新增 `agent-core/src/services/groupMemoryLink.js`（唯一新逻辑模块），挂点三处。

## 1. 私聊检索纳入她所在的群（H1）

- 私聊被动召回路径：`routes/chat.js` → `services/memory/chatMemoryRecall.js` → `hybridSearch`，结果进 `dynamicBlocks` 的 `<rag_memories>`；@memory 二阶段走 `services/memory/activeSearch.js` 的 `formatMemoryRecallBlock`。两处都做了处理。
- **重要更正（本轮查证）**：群会话**原本就在**私聊召回范围里 —— 那段 SQL（`SELECT 'group_' || group_id … FROM group_members WHERE character_id = ?`）在 HEAD~1 的 `chat.js` 里就有，可追到初版群聊 `a877880` / 群聊上线 `dd5016d`（v2.4.0），不是本轮引入。本轮做的不是"从无到有"，而是：把范围查询抽成可单测的 `listCharacterGroupConversationIds`（SQL 逐字保留）、**新增 `【群聊·<群名>】` 出处标注**、**新增 ≤8 条群来源收敛**（task-36 起：带 `群聊` tag 的记忆也算群来源并标出处）。
- 无群来源时**不查** `group_chats` 表，格式化输出与旧实现**逐字节一致**（有回归断言）。

## 2. 群聊一轮结束 → 写进她自己的长期记忆（H2）

- 挂点：`groupChatEngine.js` 群聊轮收尾（亲密记账之后），**fire-and-forget**（`.catch` 只 warn），不阻塞群聊。
- 每个"本轮有发言"的成员各写一条 `conversation_id = 'char_<id>'` 的记忆，确定性拼接（**不额外调 LLM**）：`在群「X」里，用户说：…；我（甲）说：…；其他人：乙说：…。`（≤200 字）。
- 幂等：`dedupeKey = group_link:<groupId>:<rawId>:<charId>`（落在 `content_hash`）；走既有 `applyMemoryActions`，字段取值按 `normalizeMemory/validateMemoryAction` 的合法集合（`memoryType='knowledge'`、`subject='relationship'`、`importance=4`）。
- **取舍**：**不落 raw 锚点**（`sourceRawStartId/EndRawId = null`）。理由：群聊与私聊共用 `raw_messages` 全局自增 id，把群 raw id 写进 `char_<id>` 会被私聊撤回回滚（`rollbackMemoriesFromRawId`）与催眠遗忘窗口（`collectMemoriesInRange`）误伤。代价：群聊那一轮被回滚时这些私聊记忆不会被一起撤销（"她记得自己说过"更符合人类直觉）。
- `config.features.memory === false` 时整体不写。

## 3. 群聊轮里注入「只属于她」的私聊记忆（H3）

- 位置：`runGroupRound` 的 `directiveBlocks`，**通用 directive 之后、催眠块之前**。
- 形如：
  ```
  <member_private_memory name="甲">
  【只有甲自己知道，其他人不知情，也不要替她说出来】
  - 你和用户私下聊过：……
  </member_private_memory>
  ```
  沿用催眠"成员限定行"那套已在真机验证有效的口径（一轮群聊一次调用演多个角色，必须把"你"锁在一个人身上）。
- 数据源 `readMemberPrivateMemories()` → `listActiveMemories({ conversationId: 'char_<id>' })`：**纯只读、不触发 embedding/网络**；候选池 = 她最近更新的 `GROUP_PRIVATE_MEMORY_SCAN_LIMIT`（30）条，再按 重要性 × 时间 排序取前 `GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER`（3）条（避免每轮每人一次全表扫描）。
- **只喂真正的私聊记忆（task-37 修正）**：H2 写进 `char_<id>`、带 `群聊` tag 的记忆在 H3 读侧被整个滤掉（`isMemberPrivateOnlyMemory`，读侧还先超采 `SCAN_OVERFETCH` 倍再截断，免得这些记忆把"最近 30 条"窗口占满）。理由：它们的内容群 prompt 里本来就有（`<group_transcript>`），再喂一遍既重复又把每人 top-3 挤满。**H1 私聊召回照旧带上它们**——H2 的记忆出现在私聊里正是本功能的目的。
- 没有记忆的成员**不产空块**；`config.features.memory === false` 时完全不注入。
- **口径（产品已确认，有意为之，不是泄漏）**：本节只是把**她自己知道的事**告诉她；**她是否当众说出来由她自己决定** —— 成员会在群里主动讲出自己的私聊细节，这更像人，所以不做"禁止她提起"的硬约束（说明行里的"不要替她说出来"只约束**别的**角色）。真机观测到"只有她自己知道"实际只成立一轮，属于预期行为。

## 4. 防上下文爆炸的硬上限（本任务的第二目标）

群聊 prompt 已经没有 token 预算降级机制（`applyContextBudget` 只在私聊用），所以这些**字符硬上限是唯一护栏**，全部导出为常量并被单测直接断言：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `GROUP_PRIVATE_MEMORY_MAX_PER_MEMBER` | 3 | 群聊里每个成员最多注入 3 条私聊记忆 |
| `GROUP_PRIVATE_MEMORY_MEMBER_CHARS` | 300 | 每人那一节（含标签）上限 |
| `GROUP_PRIVATE_MEMORY_TOTAL_CHARS` | 3000 | 全体合计的**硬顶**（只负责"人再多也不失控"）；**每轮预算**由下面的动态公式现算 |
| `GROUP_PRIVATE_MEMORY_SCAN_LIMIT` | 30 | 每人在私聊记忆里先扫多少条候选（`listActiveMemories` 按更新时间倒序，防止"最旧但最重要"被挡在池外） |
| `GROUP_PRIVATE_MEMORY_SCAN_OVERFETCH` | 4 | H3 读侧超采倍数：先读 30 × 4 = 120 行，滤掉 `群聊` tag 后再截到 30 |
| `GROUP_LINK_SUMMARY_MAX_CHARS` | 200 | 群→私聊那条记忆正文上限 |
| `PRIVATE_GROUP_MEMORY_MAX_ITEMS` | 8 | 私聊 prompt 里群来源条目上限 |

**每轮实际预算（task-37）**＝ `resolveMemberMemoryBudget(人数)`（导出纯函数）：

```
effective = min(GROUP_PRIVATE_MEMORY_TOTAL_CHARS, 人数 × (GROUP_PRIVATE_MEMORY_MEMBER_CHARS + 1))
```

`+ 1` 是**节与节之间换行分隔符**的余量（口径写在函数注释里）。取值效果：

- **8 人** → 8 × 301 = **2408 ≤ 3000** → 8 节全进。旧口径把 `TOTAL_CHARS = 2400` 当成每轮预算（= 8 × 300），漏算了分隔符：8 节顶满实际要 8 × 300 + 7 = **2407 > 2400**，于是第 8 个成员**每轮都被跳过**（真机日志：`额度已用完（2106/2400 字），本轮跳过「辛」`）。
- **20 人** → 20 × 301 = 6020 → 被 3000 硬顶住，超出的成员照旧**整节跳过 + log**（行为不变）。
- 日志里的 `N/M 字` 用的是**现算出来的 M**，不再写死常量。

关键断言（`agent-core/test/groupMemoryLink.test.js`）：

- **8 人 × 每人 3 条 300 字** → 8 节全在、`skipped` 为空，实际 `chars = 8 × 300 + 7 = 2407`（这个字数在旧硬顶 2400 下确实装不下，正是该用例复现的故障）；
- **20 人 × 每人 3 条 300 字** → 合计 ≤ 3000 且有成员被跳过（不报错、只 log）；

其余已有界的事实（无需本功能额外处理）：群聊 transcript 走滚动摘要 + 有上限的最近 raw（`MAX_TRANSCRIPT_RAWS=40`、每轮剧本 `MAX_ROUND_MESSAGES=18`）；群→私聊的**短期**注入一直是 `PRIVATE_GROUP_LOG_MAX_ROUNDS=2`（最近 2 轮 + 该群最新摘要）。

### 4.1 群聊轮 RAG 的查询分词上限（task-37）

`memorySearch.queryTokens` 的截断上限默认是 `QUERY_TOKEN_LIMIT_DEFAULT = 24`（**私聊召回的口径，未改**），
群聊轮由 `groupChatEngine.GROUP_ROUND_QUERY_TOKEN_LIMIT = 64` 显式放宽（`hybridSearch` 的新可选参数 `queryTokenLimit`）。

原因（真机实测）：群话题通常**一句话带多个主题**。话题「大家说说自己养过的猫、怕黑的事、收藏的东西吧，顺便聊聊上次群里说的露营。」
分词后共 32 个 token，「露营」排在第 32 位 → 被 24 截掉 → 群里含"露营"的记忆一条都没召回，第 2/3 轮直接 `hits=0`。
放宽到 64 后关键词进列表，检索恢复正常；第 65 个之后的 token 依旧被截断（有界，不是"不截断"）。

## 5. 验证与已知边界

- `agent-core/test/groupMemoryLink.test.js`（38 个用例）+ 新增 `agent-core/test/memorySearchQueryTokenLimit.test.js`（3 个用例）；
  后端全量 **845 / 842 pass / 0 fail / 3 skipped**（基线 836/833/0/3，正好 +9 个用例，其余零回归）。
  跑法：`cd agent-core`、`DB_PATH=':memory:'`、`LOG_TO_FILE='false'`、`node --test --test-concurrency=1 "test/*.test.js" "src/services/*.test.js"`。
- 挂点位置用源码级断言锁住（与 `hypnosisGroupInject.test.js` 同口径）。
- **未做**真实 `runGroupRound` 端到端（需要真模型）。
- ~~`mailboxScheduler` 生成信件时仍只检索自己那个会话（信件不是私聊 prompt，未动）~~ —— **2026-09-29 已修**（旧账清理一轮）。
> **task-36 追加**：群聊轮的 RAG scope 已从 `[group_<id>, ...所有成员 char_<id>]` **收窄为只含 `group_<id>`** —— 真机实测原先 6 条命中全来自私聊会话，会让"别人也知道她的私事"，不符合"像人类"；成员的私聊记忆现在**只**通过本人小节进入。同时合计上限 1800→2400、候选池 20→30。
> **2026-09-29 追加（旧账清理一轮，非 task 编号）**：**信箱写信现在也吃群记忆** —— 上一行那条边界已不成立。检索范围 = `char_<id>` ＋ 她所在的全部群会话（复用 `groupMemoryLink.listCharacterGroupConversationIds`，与私聊召回同一收口，不新造并行检索）；群来源命中在素材行前带 `【群聊·群名】`/`【群聊】` 出处前缀（复用 `groupOriginPrefix`），**非群来源的行与改动前逐字节一致**，`isGroupMemoryLinkEnabled()` 关闭时一次 `group_members`/`group_chats` 查询都不发。实现：`mailboxScheduler.js` 的 `resolveMailboxMemoryScope()` / `formatMailboxMemoryLines()` / `buildMailboxMemorySection()`（`search` 可注入，故单测不联网）；回归 `agent-core/test/mailboxGroupMemory.test.js`（10 项）。边界：群来源条目**不再另设上限**（沿用信箱 `topK=3` 的既有口径，群多也不膨胀）；**未做**真模型端到端（信件文本层面只有素材段级证据）。
> **task-37 追加**：① 合计上限 2400 **降级为硬顶 3000**，每轮预算改为按人数现算（见 §4），修掉"8 人群第 8 人每轮被跳过"；② H3 读侧按 `群聊` tag 过滤 H2 记忆（见 §3，原文"H2 写的记忆会同时出现在 H3 小节里"已不成立）；③ 群聊轮 RAG 分词上限 24 → 64（见 §4.1），私聊口径不变；④ 明确"她是否当众说出自己的私事由她自己决定"是有意为之（见 §3）。

## 6. 群聊围观插话的概率模型（task-22）

**背景**：task-17 的 `<touch_bystander>` 只是 prompt 约束 —— 每轮都写「其他成员最多 1 人可以插一句」，
等于**每轮都允许**有人插话，没有概率成分。task-22 把它做成真概率，同时**不动**「单轮最多 1 人」这条用户裁决。

**契约**（`src/services/groupChatEngine.js`，全部导出、纯函数可单测）：

| 导出 | 行 | 形状 | 说明 |
| --- | --- | --- | --- |
| `DEFAULT_TOUCH_BYSTANDER_CHANCE` | 101 | `0.3` | 默认 30% |
| `resolveTouchBystanderChance(raw?)` | 113 | `number \| null` | 读 `config.features.touchBystanderChance`：非数字 → 0.3；0~1 越界夹取；**null / false → null（关闭）** |
| `planTouchBystander({members, excludeId, chance, random})` | 124 | `{chance, roll, allowed, member\|null}` | 掷**一次**骰子；命中才点名一位**非被摸者**成员（无其他人可点时一律拒绝） |
| `buildTouchBystanderRule(name, {chance, allowed, otherName})` | 143 | `string` | 三态文案，见下 |
| `collectTouchActionBlocks(group, {now, bystanderChance, bystanderRandom})` | 180 | 返回值新增 `bystander` | 只在**真有触摸事件**那一轮参与（没有事件 → 不出现该块，也不消耗概率） |

**三态文案**（都仍然满足「最多 1 人」）：

| 态 | 触发 | 块正文要点 |
| --- | --- | --- |
| **关闭** | `chance === null`（配置 null/false） | 与 task-17 版本**逐字节一致**（`touchBystanderChance.test.js` 第 ① 条钉死） |
| **命中** | `roll < chance` 且群里有其他人 | 「其他成员**只让「X」**可以插一句围观 / 起哄的话（其余人这一轮不要发言）」 |
| **未命中** | `roll >= chance` / 群里只有她 / 关闭 | 「**其他成员这一轮都不要发言**，不要整群跟着刷屏」 |

**可配**：设置键 `features.touchBystanderChance`（`config.js` 归 Lead，本模块**只读**；缺省即 0.3）。
`0` = 永不插话、`1` = 每轮点名一位、`null`/`false` = 退回旧文案；写进 `system_settings` 即可生效（走 settings.js 既有的 DB → config 覆盖）。

**观测**：每轮命中/未命中打一行
`[group] touch bystander conv <groupId>: allow 「X」/deny (p=0.3, roll=0.12)` —— 真机核对概率时直接 grep。

**测试**：`agent-core/test/touchBystanderChance.test.js`（6 项：默认值/越界夹取/null 关闭、决策排除被摸者、
三态文案、以及 :memory: 库上的集成 —— 概率 1 点名另一位成员、概率 0 全员闭嘴、概率 null 逐字节等于旧文案）。

## 7. C 线两笔旧账的结论（task-22，两笔都**不改代码**）

### 7.1 C1「群聊滚动摘要不进遗忘屏蔽」—— 判断为**不值得做全量修复**

**现状（行号为当前 HEAD）**：

- 群聊 transcript **已经**吃遗忘屏蔽：`buildTranscript(db, convId, excludeTimeRanges)`（`groupChatEngine.js:629`），
  区间由 `resolveTranscriptExcludeRanges`（`:702`）从 `hypnosisService.collectForgottenWindowsForMembers` 取，
  再按 raw 的 `created_at` 落在 `[fromAt, toAt]` **闭区间**里就剔除（`isRawInTimeRanges`，`:620` 判定、`:679-680` 过滤）。
- **漏的是摘要这一层**：`buildGroupContext` 在 `groupChatEngine.js:735` 把 `getRecentSummaries(convId, 1).summary`
  原样塞进 system 块，**没有任何区间过滤**。
- 摘要**生成**侧同样不过滤：`summarizer.js:128-132` 取 `id > checkpointEndId` 的全部 raw（无区间条件），
  而且 `summarizer.js:125` 把 `previousSummary` 一起喂回模型 —— **摘要串行继承**。

**为什么"便宜的两半"都不干净**：

1. **生成期排除**（SQL 加区间条件，0 次额外 LLM 调用）：只能拦住**将来**生成的摘要；已落库摘要里那段内容照旧，
   且因为 `previousSummary` 串行继承，一旦某条摘要含遗忘内容，**之后每一条都可能带着它** —— 只按区间过滤读不到这一点。
2. **读取期过滤**：摘要是一段自然语言，没法"局部挖掉"，能做只有**整条不注入**；而 transcript 的起点正是摘要
   checkpoint（`end_msg_id`）⇒ 摘要不注入 = **checkpoint 之前的全部历史一次性消失**。用"整段旧上下文"换一条摘要的隐私，
   代价明显大于收益，且只要该群存在遗忘窗口就每轮都付这个代价。
3. **想干净地做**需要给 `rolling_summaries` 加"被污染"标记并沿摘要链传递（新列 + 迁移 + 生成/读取两侧改造），
   超出"低优先、顺手做"的量级。
4. 设计文档本来就把这条写成**刻意不修**的边界：`docs/hypnosis-acceptance-report.md:106`
   「滚动摘要不受遗忘屏蔽：设计文档 §10 既定边界（重写摘要要再调一次 LLM），刻意不修。」

**结论**：本轮**不做**，把边界写清楚留档：

- 残余风险：遗忘窗口内的内容**可能**经由"更早的滚动摘要"文本再次进入模型上下文；
- **同一路径在私聊也存在**（`routes/chat.js:825 getRecentSummaries(conversationId, 1)` 同样不过滤）——
  这不是群聊独有，真要做应两处一起做；
- 若日后要做，**最小有效方案**：读取期用 `rolling_summaries.start_msg_id/end_msg_id` 反查 `created_at`，
  与遗忘窗口重叠则整条不注入 + 打日志；**同时必须**处理继承链 —— 生成期若发现 `previousSummary` 属于被污染摘要，
  就用「（新对话开始）」代替它，否则污染会一轮轮复制下去。

### 7.2 C2「群聊遗忘按时间近似」—— 偏保守，**确认不改**

- 群聊侧的遗忘区间只有**时间**：`collectForgottenWindowsForMembers` 返回 `{characterId, windowId, fromAt, toAt}`
  （`hypnosisService.js:580`、`:595-596`），判断是 `at >= from && at <= to` 的**闭区间**（`groupChatEngine.js:620`）。
- 相对私聊的 raw id 闭区间（见 `docs/hypnosis-phone.md` §7），群聊的时间近似会**多剔除**边界同一秒的消息 ——
  方向是「宁可少说，不泄漏」，与遗忘的语义一致；
- 反向误差（该删没删）需要 raw 的 `created_at` 与窗口 `from_at/to_at` **不同源**才可能出现，而两者都出自
  同一个 SQLite 的 `datetime('now')`（UTC 无时区串、同一时钟）。
- 边界用例已由 `agent-core/test/hypnosisGroupForget.test.js` 覆盖。**因此不需要改**，只在此留档口径。

---

## 8. 群聊围观「谁围观」落库（D4 · 2026-09-30）

**背景**：§6 的概率模型（task-22）只决定「这一轮允不允许有人插话」，**具体谁开口由模型临场决定**，
没有任何结构记录 ⇒ 「谁围观」不可查询、不可统计（规划-下一步-20260930 §D4 / §五 验收）。

**改法（程序选定 + 落库）**

| 环节 | 落点 |
| --- | --- |
| 选择 | `planTouchBystander`（`groupChatEngine.js`，task-22 纯函数）：排除被摸者、只在本群成员里掷，**掷中才返回具体成员** |
| 提示词 | `buildTouchBystanderRule` 继续**点名**「只让「X」可以插一句」——不是笼统的「让某人插一句」；掷不中/关闭时文案与 task-17 逐字节一致 |
| 落库 | 新增 `messages.onlooker_char_id`（迁移 `db/index.js: migrateGroupChatSchema`，守卫式 ALTER）；群聊轮收尾调 `stampGroupRoundOnlooker(db, { rawId, onlookerCharId })`，把**该轮所有群消息气泡**都打上同一个围观者 id |

**语义边界（重要）**

1. `onlooker_char_id` 记录的是**程序的选择**（这一轮谁"被允许"围观），不是"谁真的说了话"——
   模型没照办时**不伪造数据**，只打日志：`[group] onlooker recorded: 36 (⚠️ 本轮该成员没开口)`。
   真机验收口径（规划 §五）就是「插话人名与发言一致」：拿这个 id 与 `speaker_character_id` 对照即可。
2. **掷不中 ⇒ 零落库**；**关闭概率模型（chance=null）⇒ 零落库 + 文案与 task-17 逐字节一致**（两项都有测试钉住）。
3. 列不存在（老库没跑迁移）时 `stampGroupRoundOnlooker` **安全 no-op** 并返回 false —— 少一列绝不让整轮群聊失败。
4. 与被摸者的动作块、催眠块**互不干扰**：围观者永远不是被摸者，块顺序不变（动作块在前、催眠块仍在最后）。

**查询/统计口径**（管理员或后续面板可直接用）

```sql
-- 谁围观得最多
SELECT onlooker_char_id, COUNT(*) AS n
FROM messages
WHERE conversation_id = 'group_<id>' AND onlooker_char_id IS NOT NULL
GROUP BY onlooker_char_id ORDER BY n DESC;

-- 某轮围观者到底开没开口（验收「插话人名与发言一致」）
SELECT speaker_character_id, onlooker_char_id, COUNT(*)
FROM messages WHERE raw_id = ? GROUP BY 1, 2;
```

**测试**：`agent-core/test/groupBystanderPersistence.test.js`（5 例，真实表 + 真实查库）
—— ①程序点名且不是被摸者；②落库且可按 `onlooker_char_id` 查回；③掷不中零落库；④关闭 = task-17 逐字节 + 零落库；⑤选定者是群成员、模块不自造第二个围观者。
红→绿证据：实现前 **2 pass / 3 fail**（②③⑤ 红），实现后 **5 pass / 0 fail**；群聊线 16 个测试文件 **234 / 234**。
