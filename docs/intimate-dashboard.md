# 亲密看板（intimate dashboard）设计与维护

角色详情卡里的「亲密信息」看板：身体档案、初次里程碑、累计统计、部位敏感度、体位排行、流水明细，外加一个「让角色知晓这些信息」的注入开关。

本文按代码事实撰写，函数名 / 接口路径 / 字段名与实现逐字一致。**行号基于 2026-09-28 12:25 的工作树快照**；该功能当时仍在并行开发（多条场景链路是陆续接入的），改动后请以函数名 / 路径重新定位，不要相信过期行号。**例外：`agent-core/src/services/intimateService.js` 迭代最频繁，本文对它一律只给函数名、不给行号。** 维护时以这些文件为准：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 表结构 | `agent-core/src/db/index.js` 的 `migrateIntimateSchema()`（第 2538 行） | 6 张表的建表与存量库补列 |
| 数据层 | `agent-core/src/services/intimateService.js` | 档案读写、记账、回滚、里程碑、聚合统计、回填进度读写 |
| 记账入口 | `agent-core/src/services/intimateAutoRecord.js` | 聊天 / 群聊的零 LLM 自动记账（`recordFromPrompt` / `recordFromConversationTail`） |
| 场景挂点 | `agent-core/src/routes/chat.js`、`agent-core/src/services/groupChatEngine.js`、`agent-core/src/services/eventGenerator.js`、`agent-core/src/services/town/townNpcEventGenerator.js`（→ `town/townIntimateRecord.js`） | 私聊、群聊、角色奇遇、镇民奇遇四条链路的记账与回滚挂点 |
| 注入块 | `agent-core/src/services/intimatePrompt.js` | 组装 `<intimate_profile>` 文本 |
| 回填引擎 | `agent-core/src/services/intimateBackfill.js` | 扫历史 `raw_messages` 补流水 |
| AI 整理档案 | `agent-core/src/services/intimateAiEdit.js` + `agent-core/src/routes/intimateAiEdit.js` | 按最近对话提议档案修改，遵守 `aiEditFields` |
| HTTP | `agent-core/src/routes/intimate.js`（挂载 `app.js` 第 125 行）、`agent-core/src/routes/intimateAiEdit.js`（第 124 行） | REST 接口；两者都必须早于 `charactersRoutes`（第 126 行） |
| 总开关 | `agent-core/src/config.js` 的 `features.intimate` / `features.intimateBackfill`（第 121-122 行） | 见 `agent-core/src/db/settings.js` 的 `feature_intimate` / `feature_intimateBackfill` 持久化映射（第 99-100 行）；设置页入口在 `web-ui/src/views/SettingsView.vue` 第 687-704 行 |
| 前端面板 | `web-ui/src/components/character/IntimatePanel.vue` | 看板本体（容器由角色详情卡的 `LinsheModal` 提供） |
| 前端纯逻辑 | `web-ui/src/components/character/intimateLogic.js` | 口径换算、部位增删、排行、格式化（无 Vue 依赖，可被 `node:test` 直接引） |
| 前端接口 | `web-ui/src/api/intimate.js` | 自带请求基元的接口封装 |
| 前端入口 | `web-ui/src/components/CharacterDetailModal.vue`（第 142、199、488-497 行）+ `web-ui/src/views/ChatView.vue`（第 277、338-343、1263 行） | 详情卡桌面 / 移动两处入口 + 子窗；外加聊天页 ⚙ 设置面板里一行直达（`openIntimatePanel`） |

## 1. 功能概述

- **身体档案**：身高 / 三围 / 罩杯 / 备注 / 敏感带（`{key,label,level}`，level 0~5），1:1 存在 `character_body_profile`，由用户手动维护。
- **初次里程碑**：每个 `act_key` 的首次时间，可由流水自动派生（`source='derived'`），也可人工指定（`source='manual'`，不被流水覆盖）。
- **累计统计**：总次数 / 高潮次数 / 行为种类 / 各行为次数 / 体位排行 / 伙伴分组 / 场景分组，全部**当场从流水聚合**。
- **自动记账**：私聊（`chat` / `user`）、群聊（`group` / `character`）、奇遇结算（`event` / `user`）三条链路，都只拿现成的生图 prompt 过确定性词表，零额外 LLM 调用（见第 3 节末）。**没有生图 prompt 的轮次**另有一条正文兜底：正文命中项目现成的成人内容判定就记一笔 `unspecified`（「未归类」），仍然零 LLM、不猜具体行为（见第 13 节）。
- **两条补丁（2026-09-29，task-8 / task-9，用户报「催眠的时候如果发生性交记录到面板里」）**：① **催眠轮**（`hypnosisService.isBodyControlled` 为真）的判定文本会**并入紧邻其前的用户消息**；② 有生图 prompt 但**归类为空**时，催眠轮与 `forceTextFallback` 轮会再跑一次正文兜底；③ **自动触发**的强制高潮轮（`proactiveChatScheduler` 直接落 raw，不经 `chat.js`）新增了记账挂点。三条都在 `intimateAutoRecord.js` 收口（第 63-98、173-254、312-327 行），详见第 13 节。
- **历史回填**：扫描该角色私聊会话（线 1）与其所在群聊（线 2）里已有的 `raw_messages`，把过去的亲密行为补进流水（确定性规则，不调用 LLM）；两条线都带正文兜底，所以"只靠正文能看出来"的老回合也会补进流水（见第 7 节、第 13 节）。
- **让角色知晓**：开关打开后，`agent-core/src/services/intimatePrompt.js` 组装一段 `<intimate_profile>` 文本注入私聊 `dynamicBlocks`，让角色在对话里「记得」档案与相处经历。
- **让 AI 整理档案**：按最近对话抽档案字段，**已授权的字段直接写、未授权的只提议**，用户逐条采纳 / 忽略（见第 4 节末）。
- **总开关**：设置页「功能开关」卡片里的「亲密度看板」`features.intimate` 与「历史对话回填」`features.intimateBackfill`（`web-ui/src/views/SettingsView.vue` 第 687-704 行，写入走既有的 `updateFeatureFlag()` → `PUT /api/config/features`，见 `agent-core/src/routes/config.js` 第 224 行）。

三条设计红线：

1. **零额外 LLM 调用**：归类只做 tag 词表匹配（生图 prompt 本身就是英文 tag 逗号串），不额外发请求。模型对统计的"印象"如果靠自己算，会虚高且不可复现。（唯一例外是「让 AI 整理档案」，那是用户显式点按钮才发生的一次调用。）没有生图 prompt、或**有 prompt 但归类为空**的轮次只做**二值**成人内容判定（`containsExplicitAdultContent`，自带中文词表）并记一笔「未归类」——只回答"有没有"，不回答"是什么"，仍然不调 LLM（见第 13 节）。判定对象是**这一轮**（她这一轮的回复；催眠轮再并入用户那一句话），不是"她那一半"。
2. **档案与流水分权**：自动记账只写流水，**永远不 UPDATE `character_body_profile`**；改档案只有在用户显式打开对应权限键后才允许（见第 4 节）。
3. **不存计数器**：撤回一轮、清空会话、删除角色都必须让看板数字自然回落，所以统计一律从流水现算（见第 2 节末）。

## 2. 数据模型

建表与补列都在 `migrateIntimateSchema(db)`（`agent-core/src/db/index.js` 第 2538 行，启动时在 `agent-core/src/db/index.js` 第 979 行调用）。函数被**导出**，测试可反复调用验证幂等（`agent-core/test/intimateService.test.js` 有连调两次的断言）。

`CREATE TABLE IF NOT EXISTS` 对已存在的表不生效，所以存量库补列走 `PRAGMA table_info` + `ALTER TABLE`（内部 `addColumnIfMissing`，第 2633 行）：列已存在就跳过，重复调用不报错、不丢数据。

### `character_body_profile`（静态档案，1:1）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `character_id` | INTEGER PRIMARY KEY → `characters(id)` ON DELETE CASCADE | 角色 id |
| `height` / `bust` / `waist` / `hip` | TEXT NOT NULL DEFAULT '' | 身高 / 胸围 / 腰围 / 臀围（自由文本，如 `162cm`） |
| `cup` | TEXT NOT NULL DEFAULT '' | 罩杯（上限 12 字符） |
| `note` | TEXT NOT NULL DEFAULT '' | 备注（上限 `MAX_NOTE_LEN` = 300） |
| `sensitive_zones` | TEXT NOT NULL DEFAULT '[]' | JSON 数组 `[{key,label,level}]`；`level` 夹到 0~5，最多 `MAX_ZONES` = 30 项 |
| `inject_enabled` | INTEGER NOT NULL DEFAULT 0 | 「让角色知晓这些信息」开关 |
| `ai_edit_fields` | TEXT NOT NULL DEFAULT '[]' | AI 逐字段修改权限的 JSON 数组（见第 4 节） |
| `view_scope` | TEXT NOT NULL DEFAULT '["user","character"]' | 统计口径的 JSON 数组（见第 5 节）；默认含群聊（角色↔角色），存量库由一次性迁移同步 |
| `backfill_enabled` | INTEGER NOT NULL DEFAULT 1 | 角色级历史回填开关，默认开 |
| `updated_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 由 `upsertBodyProfile` 写 `nowIso()` |

体积/备注上限来自 `intimateService.js` 顶部的 `MAX_ACT_COUNT = 99`、`MAX_FIELD_LEN = 60`、`MAX_NOTE_LEN = 300`、`MAX_ZONES = 30`。

> 存量库补 `ai_edit_fields` 时有一次性的回填：补列成功后执行 `UPDATE character_body_profile SET ai_edit_fields = '["stats"]'`（第 2645 行）。因为"补列那一刻的存量行"等于从未设置过权限，留在列默认空数组上会让用户编辑过一次档案后自动记账被永久掐断。只在补列成功那一次执行，用户之后主动清空权限不会被改回来。

### `character_intimate_log`（行为流水，唯一计数来源）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 流水 id（面板删除单条用） |
| `character_id` | INTEGER NOT NULL → `characters(id)` ON DELETE CASCADE | 角色 id |
| `source_uid` | TEXT NOT NULL | 幂等键，构成规则见第 3 节 |
| `act_key` | TEXT NOT NULL | 行为 key，取自 `ACT_DEFINITIONS`（也可能是人工自定义 key） |
| `position_key` | TEXT NOT NULL DEFAULT '' | 体位 key（取自 `image_prompt_knowledge.adult_pose_vocabulary`），空串 = 未归因 |
| `custom_label` | TEXT NOT NULL DEFAULT '' | 人工补录时自定义展示名 |
| `partner_kind` | TEXT NOT NULL DEFAULT 'user' | `PARTNER_KINDS`：`user` / `character` / `npc` / `self` / `unknown` |
| `partner_id` | INTEGER NOT NULL DEFAULT 0 | 伙伴角色 id（0 = 无） |
| `scene` | TEXT NOT NULL DEFAULT 'chat' | `SCENES`：`chat` / `group` / `event` / `dream` / `moment` / `mailbox` / `manual` / `hypnosis`（`dream` / `moment` / `mailbox` 为枚举预留、暂无记账生产者；`hypnosis` 由催眠手机的强制高潮写入，见第 3 节表） |
| `act_count` | INTEGER NOT NULL DEFAULT 1 | 次数，夹到 1~99 |
| `climax_count` | INTEGER NOT NULL DEFAULT 0 | 高潮次数，夹到 0~99 |
| `raw_id` / `msg_id` | INTEGER NOT NULL DEFAULT 0 | 幂等锚点：`raw_messages.id` / 展示消息 id |
| `source` | TEXT NOT NULL DEFAULT 'auto' | `auto` / `llm` / `manual` |
| `confidence` | REAL NOT NULL DEFAULT 1 | 置信度 0~1（当前词表归类恒为 1） |
| `occurred_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 行为发生时间（回填时用 `raw_messages.created_at` 还原） |
| `created_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 落库时间 |

约束与索引：`UNIQUE(character_id, source_uid)`；`idx_intimate_log_char_time(character_id, occurred_at DESC)`；`idx_intimate_log_raw(raw_id)`。

### `character_intimate_firsts`（一次性里程碑）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `character_id` + `act_key` | 复合主键（CASCADE） | 每角色每行为一行 |
| `first_at` | DATETIME（可空） | 首次时间；空 = 人工只留了备注 / 无日期 |
| `source_raw_id` | INTEGER NOT NULL DEFAULT 0 | 派生来源的 `raw_id`（人工行恒为 0） |
| `source` | TEXT NOT NULL DEFAULT 'derived' | `derived`（流水派生）或 `manual`（人工结论） |
| `note` | TEXT NOT NULL DEFAULT '' | 人工备注 |
| `updated_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 更新时间 |

`refreshFirsts(characterId)`（`intimateService.js`）由流水 `MIN(occurred_at)` 重算派生行；`source='manual'` 的行**跳过不覆盖**；流水里已消失的自动行会被 DELETE（撤回后里程碑回落）。`setFirstAt()` 写人工行，`listFirsts()` 读并附 `label`。

### `character_intimate_stats`（聚合缓存，当前未启用）

列：`character_id`（PK，CASCADE）、`stats_json TEXT NOT NULL DEFAULT '{}'`、`updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`。

**当前实现里这张表只被读空 / 被 `invalidateStatsCache()` DELETE，没有任何地方写入 `stats_json`。** `getIntimateStats()` 一律现算。保留它是因为单角色千行级别的聚合代价可忽略、而缓存一旦写入就必须处理"何时失效"的一致性问题；留表不留逻辑是刻意的，改动这里要同时更新本节。

### `character_intimate_backfill`（回填进度，每人一行）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `character_id` | INTEGER PRIMARY KEY → CASCADE | 角色 id |
| `status` | TEXT NOT NULL DEFAULT 'idle' | 见第 7 节的状态机 |
| `last_raw_id` | INTEGER NOT NULL DEFAULT 0 | **私聊线**游标：`id <= last_raw_id` 的 `raw_messages` 已扫过 |
| `scanned` / `inserted` | INTEGER NOT NULL DEFAULT 0 | 私聊线累计扫描条数 / 累计新增流水条数 |
| `error` | TEXT NOT NULL DEFAULT '' | 失败原因（上限 300，`saveBackfillState` 用 `MAX_NOTE_LEN` 截断） |
| `updated_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 每次落盘更新 |
| `group_last_raw_id` / `group_scanned` / `group_inserted` | INTEGER NOT NULL DEFAULT 0 | **群聊线**的独立断点与计数（`GROUP_PROGRESS_COLUMNS`）。这三列由回填引擎自己的 `ensureGroupProgressColumns()` 幂等补上（`sqlite_master` 判表 → `PRAGMA table_info` 判列 → `ALTER TABLE`，老库自动升级），**不在 `migrateIntimateSchema()` 里**；读不到列时群聊线按"未扫过"处理，不影响私聊线 |

### `character_intimate_suggestions`（AI 待确认提议）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 提议 id（采纳 / 忽略的 `:sid`） |
| `character_id` | INTEGER NOT NULL → CASCADE | 角色 id |
| `field` | TEXT NOT NULL | 权限键：`body` / `sensitiveZones` / `note` / `firsts` |
| `current_value` | TEXT NOT NULL DEFAULT '' | 提议生成时的当前值（JSON 序列化） |
| `suggestion` | TEXT NOT NULL | 建议值载荷（JSON 序列化；展示时由 `previewOf()` 转成人话） |
| `reason` | TEXT NOT NULL DEFAULT '' | 为什么进提议：`未开启该字段的 AI 修改权限，AI 只做了提议，采纳后才写入` |
| `status` | TEXT NOT NULL DEFAULT 'pending' | `pending` / `accepted` / `rejected`（历史行保留供审计） |
| `source` | TEXT NOT NULL DEFAULT 'ai' | 来源标记 |
| `created_at` / `updated_at` | DATETIME | 创建 / 状态变更时间 |

索引：`idx_intimate_suggestions_char(character_id, status)`。建表与上面几张表同在一个 `migrateIntimateSchema()` 里，但它是**纯新增表、没有存量列要补**，所以只用 `CREATE TABLE IF NOT EXISTS`，不参与 `ALTER` 回填逻辑。

### 为什么统计只从流水聚合、不存计数器

撤回上一轮（`agent-core/src/routes/chat.js` 的 `DELETE /api/characters/:id/messages/last-round`）、群聊打回一轮（`groups.js` → `groupRoundUndo.js`）、清空会话（`DELETE /api/characters/:id/messages`）、删除角色（外键 CASCADE）四条路径都必须让看板数字回落。对应的回滚入口：

| 路径 | 回滚入口 | 说明 |
| --- | --- | --- |
| 私聊撤回上一轮（有 user 消息的分支） | `rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId })` | 与 `rollbackMemoriesFromRawId()` 在同一处调用。**必须按区间、且带 `conversationId`**：自动记账的锚点是**本轮 assistant raw**，它大于 `lastUserRawId`，而删除动作是按 `id >= lastUserRawId` 整段删的——只按 `lastUserRawId` 等值回滚会"命中 0 行 + raw 照删"，留下 `raw_id` 指向已删 raw 的孤儿流水、`totalActs` 不回落（task-6 复现的真实 bug）。`maxRawId` 取该会话 `SELECT MAX(id)`（查不到时回落 `lastUserRawId`），`conversationId` 把区间收敛成"本会话真实拥有的 raw id"（raw id 全库自增，不同会话区间互相穿插，裸 `BETWEEN` 会误删别会话流水）；`raw_id = 0` 的无锚点行（人工补录 / 事件流水）不受影响 |
| 私聊撤回上一轮（仅 agent 消息的分支） | `rollbackIntimateByRawId(lastRawId)` | 该分支本来就要删最后一条 assistant raw，等值回滚已经覆盖它的记账锚点 |
| 群聊打回一轮 | `rollbackIntimateByRawIdRange(minRawId, maxRawId, { conversationId })` | 群聊 raw 不是连续段，必须传 `conversationId` 把区间收敛成"本群真实拥有的 raw id"，否则会连带删掉落在同一 id 区间里的私聊 / 其他群流水；**必须在删 `raw_messages` 之前调用**，删完就再也分不清流水归属（见 `groupRoundUndo.js` 注释） |
| 清空会话 | `clearIntimateData(characterId)` | 清流水 + 里程碑，**保留身体档案**；与清空记忆在同一处调用 |
| 删除角色 | 表上的 `ON DELETE CASCADE` | 6 张表一起清 |

流水带 `raw_id`（或显式 `sourceUid`），跟着记忆回滚在同一处调用即可精确回滚；存计数器则必然出现"数字降不回去"的脏数据。

## 3. 幂等设计

唯一约束是 `UNIQUE(character_id, source_uid)`，写入用 `INSERT OR IGNORE`。`buildSourceUid()`（`intimateService.js`）的规则：

| 场景 | `source_uid` 形态 |
| --- | --- |
| 自动记账（有 raw/msg 锚点） | `${source}:${scene}:${anchor}:${actKey}:${positionKey}:${partnerKind}:${partnerId}`，`anchor` = `raw<rawId>`（`rawId>0`）否则 `msg<msgId>` |
| 人工补录（`source === 'manual'`） | `manual:${crypto.randomUUID()}` —— 每次补录都是新行（用户重复点就该计两次） |
| 调用方显式传 `sourceUid` | 原样透传（截断 160 字符），见奇遇场景 |
| 既非 manual 又没有任何锚点 | `${source}:${crypto.randomUUID()}`，并 `console.warn('[intimate] record without raw/msg anchor, dedupe disabled')` —— 去重失效，宁可漏记也不虚高 |

**为什么所有"可能为空的维度列"一律 `NOT NULL DEFAULT ''`**：SQLite 视 `NULL` 互不相等，唯一约束里只要有一列是 `NULL`，同一行为就会被反复插入、统计翻倍。`position_key`、`custom_label`、`raw_id` 等可空语义的列因此都以 `''` / `0` 落库（建表注释在 `db/index.js` 第 2532 行）。

幂等的两个已验证后果（测试见第 11 节）：

- 同一 `(character, raw_id, tag 组合)` 连记两次 → 只落 1 行（`inserted:1` 后 `skipped:1`）。
- 回填断点续跑、游标回退、`resetBackfill()` 重扫都不会把数字翻倍，因为去重靠 `source_uid` 而不是游标。

### 各场景的记账入口

流水里 `scene` / `partner_kind` 由调用点决定，面板的统计口径（第 5 节）就是按 `partner_kind` 过滤，所以「场景 → 口径」的对应关系必须保持一致。**一个口径没人写就是死开关，所以这张表要跟代码一起维护**（「小镇NPC」曾经就是这样，直到镇民奇遇记账接入）：

| `scene` | `partner_kind` | 生产者 | 幂等锚点 |
| --- | --- | --- | --- |
| `chat` | `user` | 三处入口，都落 `intimateAutoRecord`：① `routes/chat.js` 的 `recordIntimateFromTail()`（定义 1 处 + 主流程 / needImage 两处调用，第 1494、2412 行），内部走 `recordFromConversationTail()` 读会话尾部那条带 `prompt` 的 assistant raw；**同一处的 `else` 分支**走 `recordIntimateTextFallback()` → `recordUnspecifiedFromRawId()`（没有 prompt 的纯文字轮次记一笔「未归类」，见第 13 节）；② 尾部记账**内部**在"归类为空"时对催眠轮 / `forceTextFallback` 轮再补一次正文兜底（`intimateAutoRecord.js` 第 245 行）；③ `proactiveChatScheduler.js` 第 1266-1278 行：自动触发的强制高潮轮直接落 raw、不经 `chat.js`，用 `forceTextFallback: forcedClimax` 调同一个入口 | `raw<raw_messages.id>` |
| `group` | `character` | `groupChatEngine.js` 的 `recordGroupIntimateFromRound(rawId, prompts)` → `intimateAutoRecord.recordFromPrompt()`；`partnerId` 固定 0，只记发言角色这一笔。**同一轮收尾还有正文兜底**：`recordGroupIntimateFromText(rawId, 文本行, { excludeCharacterIds })` → `recordUnspecifiedFromText()`（发了图/已归类的角色排除，不叠第二笔，见第 13 节）。回滚见 `groupRoundUndo.js` / `routes/groups.js`；历史回填的群聊线也扫这两条口径（见第 7 节） | `raw<raw_messages.id>` |
| `event` | `user` | `eventGenerator.js` 的 `recordIntimateForEvent()`，在 `concludeEvent()` 删掉事件行之后、SSE 广播之前调用（角色奇遇，`character_events`） | 显式 `sourceUid = event:<eventId>:<actKey>:<positionKey>` |
| `event` | `npc`（环境奇遇，两位镇民同框）/ `user`（常规奇遇，镇民 + 玩家） | `services/town/townNpcEventGenerator.js` → `services/town/townIntimateRecord.js` 的 `recordIntimateForTownEvent()`（镇民奇遇落在 `town_npc_events`——建表见 `agent-core/src/db/townNpcEventSchema.js`——**不走** `concludeEvent`，所以必须单独挂一条） | 显式 `sourceUid = town:<eventId>:<actKey>:<positionKey>` |
| `manual` | 请求里的 `partnerKind`（默认 `user`） | 面板人工补录 `POST …/intimate/log`（`source='manual'`，绕过权限闸门） | `manual:<uuid>` |
| `hypnosis` | `user` | `hypnosisService.js` 的 `recordForcedClimax()`——面板「强制高潮」按钮的服务端确定性记账（`source='manual'`，绕过权限闸门），另触发情绪快照与一次性指令；详见 `docs/hypnosis-phone.md` §4 | `hypnosis:<started_at>:forced_climax`（幂等锚点 = 本次催眠会话） |

- 四条自动路径都是**零额外 LLM 调用**：直接拿已有的生图 prompt 串过 `tagsFromPromptString()` + `classifyPromptTags()`，拿不到 prompt 或没有成人 tag 就走**正文兜底**（命中成人内容判定记一笔「未归类」，见第 13 节），两者都没有才什么都不记（不猜）；都先看 `config.features.intimate === false` 直接返回，并把异常吞成 `console.warn`（记账是旁路，绝不能影响聊天 / 群聊 / 奇遇主流程）。
- 为什么两条"事件"路径都不用 `raw_id`：`raw_id` 在本项目语义固定指向 `raw_messages.id`，塞事件 id 会污染撤回链路（撤回一轮按 `raw_id` 删流水，事件流水会被误删）。所以都走 `recordIntimateActs` 的显式 `sourceUid`，`raw_id` 保持 0，同一事件重放多少次都只落一行。两条路径的 `sourceUid` 前缀不同（`event:` / `town:`），不会互相覆盖。
- 镇民奇遇的 `scene` 复用 `'event'`，**不新增 `SCENES` 枚举值**：镇民奇遇与角色奇遇同属剧情场景，`byScene` 里合并展示更符合直觉，也避免动冻结的枚举口径（`townIntimateRecord.js` 文件头有说明）。纯 NPC（`town_npcs.character_id` 为空）没有 `characters` 行可归属，调用方直接跳过。
- 群聊 / 镇民奇遇的 `partner_id` 都是 0 而不是"具体哪个角色"：为每个在场角色各记一笔会把 `totalActs` 放大数倍且无法归因，而画面里具体是谁无法从 prompt 可靠判定，宁缺毋滥；逐对象归因需要 LLM，暂不做。

## 4. AI 修改权限

键与语义（`intimateService.js` 的 `AI_EDIT_KEYS`，前端同名字符串定义在 `intimateLogic.js` 的 `AI_EDIT_FIELD_DEFS`，**改键名即破坏前后端契约**）：

| 键 | 语义 |
| --- | --- |
| `body` | 身高 / 三围 / 罩杯 |
| `sensitiveZones` | 敏感带 |
| `note` | 备注 |
| `firsts` | 初次里程碑 |
| `stats` | 允许自动记账写入流水 |

- 默认值 `AI_EDIT_DEFAULTS = ['stats']`：除统计外，AI 一律不得改。
- `isAiEditAllowed(characterId, fieldKey)`：未知键直接 `false`；没有档案行的角色按默认值算；有档案行就看行里的名单。
- **闸门位置**：`recordIntimateActs()` 内部——`source !== 'manual' && !isAiEditAllowed(id, 'stats')` 时直接 `return { inserted: 0, skipped: 0, blocked: true }`，整批不落库，也不 `refreshFirsts`。
- **谁绕过闸门**：`source: 'manual'`（面板人工补录、`POST …/intimate/log`）一律放行。
- **fail-closed**：`normalizeAiEditFields()` 只保留白名单键；解析失败 / 非数组脏值返回 `[]`（不给任何权限）。注意"显式空数组"是合法状态（用户主动把权限全关），不会回落到默认值；只有 `undefined` / `null`（用户没表过态）才用 `AI_EDIT_DEFAULTS`。前端 `normalizeAiEditFields()`（`intimateLogic.js` 第 40 行）保持同一语义。
- 档案字段（`body` / `sensitiveZones` / `note` / `firsts`）的 AI 写入通路是「让 AI 整理档案」（下一节）：只有 `isAiEditAllowed()` 放行的字段会被直接写入，其余落待确认提议等用户逐条确认。**自动记账与历史回填永远只写流水与派生里程碑，不碰这四类字段。**

### AI 整理档案（propose / apply / 待确认提议）

服务层 `agent-core/src/services/intimateAiEdit.js`：从该角色最近私聊 `raw_messages`（`conversation_id = 'char_<id>'`，`role IN ('user','assistant')`、`content` 非空，倒序累计到 `sourceCharLimit` 默认 6000 字符）抽素材，调一次 LLM（`chatSync`，temperature 0.2、`response_format: json_object`）输出固定形状的 JSON，然后**逐字段分流**：

| 情况 | 行为 |
| --- | --- |
| 素材为空 | 直接返回 `{ applied: [], suggestions: [], empty: true }`，**不调 LLM**（零成本） |
| 字段已授权（`isAiEditAllowed(id, field)`） | 立即写入（`applyField()` → `upsertBodyProfile()` / `setFirstAt()`），计入 `applied` |
| 字段未授权 | 只落一条 `status='pending'` 提议，等用户在面板「采纳」；同一 `(角色, 字段)` 只保留一条 pending，新的替换旧的，`accepted` / `rejected` 历史行保留供审计 |

- 写入路径只有 `applyField()` 一个入口（`propose` 的已授权分支与 `accept` 共用），载荷进来还要再校验一次；脏值（非法日期、越界 `level`、不在 `ACT_DEFINITIONS` 里的 `actKey`、超长文本）一律丢弃该字段，其他字段不受影响。
- `acceptSuggestion(characterId, suggestionId)` 是**人工授权路径**：用户点「采纳」即用户自己的决定，不再看 `aiEditFields` 权限位（否则未授权字段的提议永远无法落地）；`rejectSuggestion()` 只把 `status` 改成 `rejected`，不动档案。
- `firsts` 由 AI 写入时调 `setFirstAt()`，而它固定写 `source='manual'`——**代价**是该 `actKey` 的流水派生会被挡住（AI 断言优先于流水推导），要恢复派生需用户在面板清空这一项；`note` 会被写成「AI 整理」以便识别（取舍写在 `applyField()` 的注释里）。
- **接线状态**：服务层 `intimateAiEdit.js`、路由 `routes/intimateAiEdit.js`、`app.js` 挂载与 `character_intimate_suggestions` 建表迁移都已落地（2026-09-28 12:00 前后，见第 9 节）。路由闸门与 `routes/intimate.js` 同口径：只有会调 LLM 的 `POST …/ai-edit` 被总开关 409 拦下，列表 / 采纳 / 忽略不拦（关掉开关也要能看和清理已有提议）；`getLlmConfig().hasApiKey` 为假时 `POST …/ai-edit` 直接 503 `{ error: 'llm not configured' }`，其余异常统一 502 `AI 整理失败：…`（不把 SDK 英文原文甩给用户）。
- **错误优先级是刻意的口径，不是 bug**：路由把 `llmMissing()` 检查放在 `proposeProfileEdits()`（内部才判素材空）**之前**，所以「无 LLM key → 一律 503」，即使该角色零素材也不会返回 `empty: true`。理由：无 key 时用户唯一可行动作是去配置 LLM，回一句"对话内容太少"会把用户引向错误方向。`empty: true`（有 key + 无素材 → 200 且 **0 次模型调用**）只在**已配置 key**时可达，有单测覆盖。后来者不要把这个顺序当 bug"修掉"。

## 5. 统计口径

每个口径由哪条链路喂数据，见第 3 节末的「面板的统计口径由哪些生产者喂数据」——那个口径没人写就是死开关（「小镇NPC」曾经就是这样，直到镇民奇遇记账接入）。

- 口径存在 `character_body_profile.view_scope`，默认 `DEFAULT_VIEW_SCOPE = ['user', 'character']`（`intimateService.js`）——**用户↔角色 + 角色↔角色，群聊默认就计入统计**；NPC / 自慰维度仍要用户在面板里显式勾选。存量库里存着旧默认 `["user"]` 的行由 `db/index.js` 的一次性迁移同步（`system_settings` 标记 `intimate_view_scope_group_default`，只跑一次；用户之后主动收窄不会被改回来）——见第 13 节。
- `normalizeViewScope()`：只留合法 `PARTNER_KINDS`，去重保序；**空数组 / 非法值 / 解析失败一律规范化回默认口径**。刻意不允许"空 = 全部"：口径是减法操作，清空勾选反而看到更多数据会让用户以为看板坏了；想看全部请在面板上勾满三类（前端提供「全部」chip）。
- `resolvePartnerFilter(characterId, partnerKinds)` 的优先级：
  1. 请求参数里出现 `all`（`partnerKinds=all`）→ 返回 `[]`，**不过滤**。这是调试 / 内部逃生门（`ALL_PARTNER_KINDS`），面板不会提交它，也不要用它表达"全部"。
  2. 请求参数里有合法 `partner_kind` → 用它（`user,character` 逗号串或数组都支持）。
  3. 都没有 → 用 `getBodyProfile(characterId).viewScope`。
- 请求参数里的"空 / 非法"视作未传（`normalizePartnerKinds`），仍然回落到档案口径。
- `getIntimateStats(characterId, { partnerKinds })` 与 `listIntimateLogs(characterId, { limit, offset, partnerKinds })` 都过同一个 `partnerFilterClause()`（`kinds` 为空则不加子句），因此汇总与各分组只算过滤后的行。返回的 `stats.partnerKinds` 是**本次生效的口径**，前端据此校准 chip 选中态（`syncScopeFromStats()`）。
- **`firsts` 不参与过滤**：初次里程碑是"事实"，与看谁的口径无关，`getIntimatePanel()` 直接回 `listFirsts(id)`。
- `byPartner`（按 `partner_kind` + `partner_id` 分组）与 `byScene`（按 `scene` 分组）是排查"数字为什么这么大"的诊断数据，面板当前只展示 `byAct` 与 `byPosition`。
- `getIntimatePanel()` 还回 `counts: { logs, allLogs }`：`logs` 跟随当前口径，`allLogs` 是未过滤总数，用于提示"还有 N 条不在口径内"。

## 6. 词表与归类

**行为分类** `ACT_DEFINITIONS`（`intimateService.js`）：`vaginal` / `anal` / `oral` / `hand` / `foot` / `breast` / `thigh` / `self` / `climax` / `first_kiss`，每项带中文 `label` 与 `tags` 子串表。`classifyPromptTags(tags)` 按定义顺序做**首个命中即归类**的子串匹配，同一 `actKey|positionKey` 只出一次；没有定义匹配到的行为落 `custom_label`，不丢数据。`first_kiss` 的 `tags` 为空数组——`kiss` 太常见，只允许人工记录，不做自动归类。

**体位词表**来自知识库 `image_prompt_knowledge` 中 `category = 'adult_pose_vocabulary'` 且 `is_active = 1` 的行（`buildPositionIndex()`，结果缓存在 `positionIndexCache`，知识库同步后调 `resetPositionVocabularyCache()` 清缓存）。与生图 prompt 同源，判定不需要模糊匹配。索引分四份：

- `bundles: Map<打包 key, {key,label,group}>`：面板下拉 / 注入用的那一份，只含"打包 key"。知识库里绝大多数条目是**逗号连接的整段 tag**（如 `arms grab, sex from behind`），而真实 prompt 是一个个单独的 tag，精确查包名永远查不到。
- `tagToBundle: Map<单个 tag, 所属打包 key>`：**只保留全局唯一归属、且够具体的元素**，三条守卫缺一不可：
  1. **唯一归属**：`owner.count === 1`。出现在两个及以上打包项里的公共词（实测 `on bed` 命中 5 个包、`looking at viewer` 命中 34 个包）一律丢弃——宁可漏归因，也不能把"卧室里做了什么"算成某个体位。这就是"唯一归属"约束（option B 反向索引）。
  2. **特异性守卫**：单 token 元素（不含空格）还要求它所属的打包项足够紧凑——元素数 `≤ MAX_TIGHT_BUNDLE_TAGS`（= 2）才收录。不加这条就会出实测事故：`1girl` 全局只归属 `panty job, panties on penis, 1girl` 这一个包，于是任何含 `1girl` 的 prompt 都会被归因成「内裤手交」。多 token 元素（含空格，本身已够具体）不受这条限制。
  3. **非体位噪声黑名单**：单 token 包按英文 `key` 词边界匹配 `NON_POSE_TAG_KEYWORDS`、或按中文 `label` 包含匹配 `NON_POSE_LABEL_KEYWORDS`（`isNonPoseBundle()` / `isNonPoseTag()`）就**不进索引**。知识库混着"流体 / 事后 / 生理反应"类的单 token 包（`cum`→射精、`creampie`→内射、`aftersex`→事后、`lactating`→泌乳、`peeing`→排尿…），它们会被 `resolvePositionKey` 精确命中，于是 `masterpiece, 1girl, nude, vaginal, cum, bedroom` 这种真实 prompt 会把「射精」顶进面板的「体位排行」。两侧各拦一次：单 token 包不进 `bundles`（词表与下拉里就没有它），单元素 tag 不进 `tagToBundle`（`cum on breast` 不会借包名变成体位）。英文用词边界（`\bcum\b`）匹配，所以 `cum` 命中 `cum on breast`，而不会误伤 `peeking out upper body`；刻意**不写裸 `orgasm`**——实测它会误伤中文名为「传教士位肛交」的真体位长包。多 token 的真体位组合两侧都不动，行为统计（`ACT_DEFINITIONS`）与体位索引无关，`cum` 不作为体位但 `vaginal` 照记。
- `labelByKey: Map<key, 中文名>`：打包 key 与单元素 key（以及下面的别名）都在，单元素 key 借用所属打包项的中文名，否则 `byPosition` 只能显示英文 tag。
- `aliasToBundle: Map<剥权重形态, 真实包 key>`：`weightAliasOf()` 去掉 A1111 权重包装后的形态单独登记（实测有 11 个包名自带权重，如 `(vibrator under panties secure leg belt:1.2)`），命中别名返回**真实包 key**——这样 `positionLabel` 出中文、注入块也不会吐出带权重的长串。别名登记写在 `isNonPoseTag()` 去噪**之后**：被去噪的元素连别名都不补，否则「射精 / 泌乳」会从别名这条路回来。

`resolvePositionKey(tag)` 的优先级（顺序即优先级，真实包名永远优先于别名）：先过 `normPositionKey()`（`str(tag, 120).trim().toLowerCase()`——**必须先 slice 再 trim** 才幂等，否则截断切在空白处会得到一个"自己都查不到自己"的 key），然后 ① 精确命中打包 key（单 token 打包项如 `bdsm` / `69` 走这条）→ 返回包名；② 命中剥权重别名 → 返回真实包 key；③ 命中唯一归属的单元素 tag → 返回**该 tag 自身**；④ 公共元素 / 不认识 → `''`。`positionLabel(positionKey)` 负责展示名兜底（实测 `doggystyle` → 狗爬式、`missionary` → 传教士体位）。`classifyPromptTags` 只在 `vaginal` / `anal` 这两个插入类行为上归因体位，避免把 oral 也算成某个体位。

`listIntimateVocabulary()` 回 `{ acts: [{key,label}], positions: [{key,label,group,tags}] }`；`positions` 只回打包 key（680 条单元素不该进下拉），另附拆好的 `tags` 供前端搜索。`getPositionVocabularyMap()` 是给内部 / 测试直接拿 `bundles` 的入口。

**为什么不用 LLM 归类**：成本（每轮都要额外一次调用）＋ 幻觉（模型会把"氛围"读成具体行为，统计虚高且不稳定）。确定性词表的另一好处是**可复现**——同一段 prompt 永远归出同一批 `acts`，回填与实时记账口径一致。

## 7. 历史回填

引擎在 `agent-core/src/services/intimateBackfill.js`，纯规则、零 LLM。

**开关**：`features.intimateBackfill` 默认开（`config.js` 第 122 行），角色级 `profile.backfillEnabled` 默认开（建表默认 1）。`backfillAllowed(profile)`（第 456 行）三闸全开才回填：`features.intimate !== false` && `features.intimateBackfill !== false` && `profile.backfillEnabled !== false`；任一关闭时 `startBackfill()` 直接返回当前状态，"一个字都不写"。

**两条扫描线**（各自独立断点，互不影响；`advance()` 第 435 行先扫完私聊线、再用**共享的 `maxMessages` 剩余预算**推进群聊线，两条线都到表尾才算 `done`）：

| 线 | 范围 | prompt 从哪来 | 记录的 `scene` / `partnerKind` |
| --- | --- | --- | --- |
| 私聊 | `conversation_id = 'char_' + characterId`（`CONVERSATION_PREFIX`，第 56 行） | `raw_messages.prompt` 列（取不到再回退 `content` 里的 JSON，见下） | `chat` / `user` |
| 群聊 | 该角色所属的群：`group_members` 里的 `group_id` → `conversation_id = 'group_' + groupId`（`GROUP_CONVERSATION_PREFIX`，第 57 行），只扫 `role='assistant'` | 一轮群聊只落**一条** assistant raw（多角色剧本合并），`prompt` 列**从不写**；画面描述以 `[显示名]: {英文描述}` 的行留在 `content` 里，`parseGroupContentLines()` / `extractLineImagePrompt()` 按行协议解析 | `group` / `character` |

- 群聊线的归属：`[显示名]` 在本群成员里反查 `characters.display_name`（重名取最小 id 并 warn），查不到 / 不是本群成员就跳过——与实时路径 `membersByName` 同口径，绝不跨群瞎挂；一条 raw 里多个发言角色各带画面描述时**各自记各的那笔**（与 `recordGroupIntimateFromRound` 一致，不按群人数放大）。顺带后果：为 A 回填时同群里 B 的那笔也会写进 B 的流水，B 自己的回填线再跑到同一 `raw_id` 时 `inserted=0`（幂等），这保证 B 的面板也不会缺历史。
- 权限阻断的粒度也不同：私聊线被拦 = 停线且不推进游标（授权后可重扫这一条）；群聊线**只有回填发起人自己被拦才停线**，其他角色被拦只跳过该行（每个角色都有自己的群聊回填线，不会漏）。
- 第一版不追已解散 / 已退出群的历史；`group_members` 无行时群聊线直接空返回。

**prompt 来源（按真实落库代码核实）**：

- `raw_messages.prompt` 存的是**生图 prompt 字符串**（英文 tag 逗号串），不是数组也不是 JSON。写入口见 `chat.js` 第 1305/1317 行（`insertRawStmt.run(conversationId, 'assistant', rawContent, tags.prompt || null, thinkingPayload)`）与第 2118/2127/2159 行（needImage 路径）。
- 有些路径会把 prompt 折进 `content`：`(图片) {"prompt":"…"}`，或往已有正文尾部追加 `{"prompt":"…"}`。`extractPromptFromContent(content)`（第 108 行）先 `JSON.parse` 再正则兜底。
- 取值顺序 `readPromptText(row)`（第 129 行）：`prompt` 列 → `content` 里的 JSON；两处都取不到就跳过，**绝不猜**。
- 拿到文本后走 `tagsFromPromptString()` → `classifyPromptTags()`；没有可归类的 tag 也跳过。

**游标与续跑**：私聊 `scanPrivateBatch()`（第 278 行）按 `id ASC` 取 `id > last_raw_id` 的下一批，断点写 `last_raw_id`；群聊 `scanGroupBatch()`（第 223 行）按同样的 `id ASC` 语义扫所属群，断点写 `group_last_raw_id`。默认 `batchSize = 200`（上限 2000），`maxMessages` 默认 5000（上限 200000），两条线共享这笔运行预算。每批调一次 `saveBackfillState()` 落盘，进程中途挂掉只丢最后一批。去重**不靠游标而靠 `recordIntimateActs` 的 `source_uid`**（含 `raw_id`），所以游标回退、重复启动、`resetBackfill()` 都不会翻倍。

**幂等启动**：`inFlight`（进程内 `Set`，第 75 行）是真在跑的凭据——同一角色已在跑时 `startBackfill()`（第 490 行）不重复起，直接返回当前状态。DB 里挂着 `running` 但内存里没有活任务（上次进程崩溃）会被当作普通断点续跑。默认调度是 `setImmediate`（`scheduleImmediate`），不阻塞 HTTP；`startBackfill(characterId, { maxMessages, batchSize, schedule })` 的 `schedule` 可注入，测试用同步调度避免 flaky。

**状态机**（`status` 不做白名单，`saveBackfillState` 原样存，前端照实展示）：

| status | 含义 |
| --- | --- |
| `idle` | 未开始 / 已重置（无行时 `getBackfillState()` 也回 `idle` 空状态，不写库） |
| `running` | 正在跑（每批落盘时写入） |
| `partial` | 还有没扫到的行（受 `maxMessages` 限制），再调一次接着扫；两条线任一没到表尾都是 `partial` |
| `done` | **两条线都**扫到表尾 |
| `blocked` | 权限闸门拦下（未授权 `stats`）：私聊线是该角色自己，群聊线只有发起人自己被拦才停线；**被拦的那条不推进游标也不计 `scanned`**，重新授权后还能被扫到；`error` 写 `'AI 自动记账权限未开启（stats）'` |
| `error` | 引擎抛错（`advance()` 的异常不会抛给调用方，HTTP 早已返回，错误落进状态行给面板展示） |

**接口**：`getBackfillStatus(characterId)`（第 470 行）、`startBackfill(characterId, options)`（第 490 行）、`resetBackfill(characterId)`（第 526 行）。

- `getBackfillStatus()` 返回 **顶层字段 = 私聊线**（与"只有私聊"的第一版完全兼容，前端只读顶层即可），另给 `private` / `group` 两条线各自的 `{ lastRawId, scanned, inserted }`，便于表达两条线的进度。
- `resetBackfill()` 回退**两条线**的游标与计数（`status: 'idle'`、私聊归零、群聊 `saveGroupProgress` 也归零；群聊线写失败只警告、不连累私聊线），**不删已有流水**——要清数据请用 `DELETE /api/characters/:id/intimate`。

**路由**（`agent-core/src/routes/intimate.js`，2026-09-28 11:54 起已由真引擎接管，不再返回 `placeholder`）：

- `GET /api/characters/:id/intimate/backfill`：只读，**不加总开关闸门**（开关关掉也要能看进度）。返回 `{ ...getBackfillStatus(id), backfill, features }`——顶层平铺 + `backfill` 同一份，前端轮询直接吃顶层字段，兼容路径用 `res.backfill`。
- `POST /api/characters/:id/intimate/backfill`：闸门 `featureDisabled(res, ['intimate', 'intimateBackfill'])`；body 可选 `{ maxMessages, batchSize, reset }`，也支持 `?reset=1` / `?reset=true`。`reset` 为真时先 `resetBackfill(id)` 再 `startBackfill(id, { maxMessages, batchSize })`。引擎后台异步推进，接口立刻返回，`status='running'` 时前端轮询上面的 GET。
- `POST /api/characters/:id/intimate/backfill/reset`：同闸门，只 `resetBackfill(id)`（回退两条线游标与计数、不删流水）。前端目前只用 `POST /backfill`，这个入口供手动 / 联调用。

### 已知边界与已裁决取舍

- **已退出 / 已解散群的历史不追**：群聊线只扫 `group_members` 里当前还有该角色行的群。
- **私聊历史很长的老用户，首次回填通常只推进私聊线**：`maxMessages` 是两条线共享的运行预算，且顺序固定"先扫完私聊线、再用剩余预算扫群聊线"。因此第一次回填常见结果是 `status=partial` 且 `group` 子对象仍是 0——再点一次「开始 / 继续回填」（或继续等调度跑完）才会补上群聊数字。这是预算共享的刻意设计，不是丢数据。
- **为 A 回填会顺带写 B 的群聊流水**：同一条群聊 raw 里 B 也有画面描述时，B 的那笔会一起落库（与实时群聊路径 `recordGroupIntimateFromRound` 行为一致，保证 B 的面板也不缺历史）；B 自己的回填线再跑到同一 `raw_id` 时 `inserted=0`（幂等）。
- 实测记录（本轮临时库 + 真实 HTTP 集成验证）：某角色群聊回填前 `character.totalActs=0`、`byScene=[]`；回填后 `totalActs=4`、`byScene=[{scene:'group',count:4}]`；再跑一次数字不变。`maxMessages=1` 连跑两组时 `scanned` 与游标逐次递进，断点续跑成立。
- **体位排行仍可能混入非体位条目（结构性问题，已裁决接受）**：全量测量（task-25）显示可解析形态 1288 条里有 **764 条非体位**（其它 361 / 身体部位 209 / 场景 51 / 服饰 43 / 道具 41 / 跨类 59），它们会借所属打包项的中文名进排行，例如 `tile floor`→「瓷砖跪口交」、`red hair`→「办公桌下口交」、`school sweater vest`→「学生乱交」、`full lips`→「事后颜射」、`condom wrapper`→「事后套套展示」、`mirror`→「照镜子」。
  - **为什么没在词表层收干净**：场景词本身就是体位名的一部分（`lying on bed` / `kabedon against wall` / `fellatio under table`），加黑名单必然误伤真体位——实测 **C1 扩展黑名单损失 14.2% 真体位、且仍剩 507 条坏样本**；**C2 白名单化损失 42.3%**（手交/口交/乳交/足交/舔阴等面板核心统计全部出局）。两者都不满足"真体位损失 ≤10% 且剩余坏样本 ≤2 条"的落地门槛，因此**未改索引**。
  - **已落地的缓解**：面板 `topPositions` 优先只显示出现 ≥2 次的条目（噪声词几乎都是一次性出现，真体位会反复累计）。它的边界：**反复出现的非体位词仍会显示**。
  - **待办选项**：若将来出现用户可见的顽固噪声（同一非体位词反复出现、`≥2` 过滤挡不住），再启动 **C2'「宽白名单」**测量（取向从"宁可误归因"翻成"宁可漏归因"；现成种子=612 条加宽真体位口径；仍用同一把尺与"切词比连续词序列、禁用 `includes`"的实现纪律）。

## 8. 注入块

组装入口 `buildIntimateProfileBlock(characterId, { chatUserName = '', maxChars = DEFAULT_MAX_CHARS })`（`intimatePrompt.js` 第 169 行），返回字符串；开关关闭 / 档案为空 / 没有任何可用内容 / 预算放不下时返回 `''`（调用方据此不 push，零注入零 token）。`shouldInjectIntimate(characterId)`（第 195 行）是同一口径的布尔判断。

段落顺序（`collectSections()`，第 131 行；有内容的段才出现）：

1. `身体：身高 162cm，三围 88-58-90，罩杯 D` —— 仅非空项；三围齐全合成一项，缺项退化为单项标签（不出现 `-` 占位）。
2. `备注：…` —— 自成一行。
3. `敏感带：脖颈(较强)、腰侧(一般)…` —— 按 `level` 从高到低取前 `MAX_ZONES = 5` 个；`level 0`（未评级）不注入；1~5 映射 `ZONE_LEVEL_LABELS` = 轻微 / 一般 / 较强 / 很强 / 极强。同强度保持面板原始顺序（`Array#sort` 稳定）。
4. `初次：初吻 2025-03-01；…` —— 只取 `firstAt` 非空的，最多 `MAX_FIRSTS = 6` 条，日期只保留到「天」。
5. `相处：与{chatUserName}累计约 N 次，高潮约 N 次，常见体位：…` —— **粗粒度**：只给总量与高潮量，Top3 体位（`MAX_POSITIONS = 3`）**只列名字不给次数**（数字越细，模型越容易在对话里复述）。
6. `INTIMATE_TAIL_NOTICE`（第 30 行，冻结文案，勿改写语义）：

   > 以上是你的身体档案与相处记忆。提及它们时用体感与反应表达，禁止复述具体数字、禁止统计口吻（如「我们做过 16 次」），也不要主动把档案当成话题清单背诵。

首行 `<intimate_profile>`、末行 `</intimate_profile>`（`INTIMATE_BLOCK_TAG`，第 27 行），中间每段一行。

**长度预算**：`DEFAULT_MAX_CHARS = 600`（含首尾标签与结尾约束）。超长时的丢弃顺序由 `DROP_ORDER = ['stats', 'firsts', 'zones']`（第 41 行）决定——相处记录 → 初次里程碑 → 敏感带，然后才是**整个备注行**（`dropNoteLine()`，只丢 `备注：` 那一行，因为它是自成一行、可整行丢弃的补充信息）；身体档案要点永远保留到最后。每丢一段重新量长，避免多丢；连正文都放不下时返回 `''`（宁可零注入，也不注入残缺档案）。**不允许半截字段。**

**挂载点**：`agent-core/src/routes/chat.js` 第 807-814 行，紧跟 `<affinity_attitude>`（第 804 行）之后、`<rag_memories>`（第 922 行）之前——两者都是"她对这个人的认知"，同属关系层，放在一起便于模型串联。它就是一个普通 `dynamicBlock`，因此同样受 `applyBudgetToBlocks` 的预算降级保护（不做特殊处理）。`config.features.intimate !== false` 时才组装。

**为什么结尾要反向约束**：档案里的数字是给模型"体感"用的，不是台词。模型看到「累计约 16 次」的概率性复述会把私聊变成数据汇报，因此文案直接禁止复述数字、禁止统计口吻，并禁止把档案当话题清单背诵。

## 9. REST 接口清单

挂载（`agent-core/app.js`，顺序是冻结契约的一部分）：

```js
app.use('/api/characters', wrapRouterAsync(intimateAiEditRoutes));  // 第 124 行
app.use('/api/characters', wrapRouterAsync(intimateRoutes));        // 第 125 行
app.use('/api/characters', wrapRouterAsync(charactersRoutes));      // 第 126 行
```

`/:id/intimate*` 一族的子路径**必须早于 `charactersRoutes`**，否则 characters 的 `/:id` 通配会把它们先吃掉（同 emoji 的理由）；AI 整理路由又刻意排在 `intimateRoutes` 之前，让 `intimate → characters` 保持紧邻。`agent-core/test/intimateApi.test.js` 有源码级断言锁住"intimate 紧邻 charactersRoutes 之前、两者之间不夹别的挂载"。

统一错误映射（`routes/intimate.js` 的 `handle()`，第 69 行）：`invalid character id` / `invalid argument` → 400；`character not found` → 404；其余 500。`routes/intimateAiEdit.js` 的 `handle()` 多两档：`invalid suggestion payload` → 400、`suggestion not found` → 404、其余 → 502 `AI 整理失败：…`。

| 方法 | 路径 | 关键参数 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/characters/:id/intimate` | `?partnerKinds=user,character`（可选） | `{ characterId, profile, firsts, stats, counts, backfill }` |
| PUT | `/api/characters/:id/intimate/profile` | `height` / `bust` / `waist` / `hip` / `cup` / `note` / `sensitiveZones` / `injectEnabled` / `aiEditFields` / `viewScope` / `backfillEnabled`（白名单，未传保持原值） | `{ profile }` |
| PUT | `/api/characters/:id/intimate/settings` | `aiEditFields?` / `viewScope?` / `backfillEnabled?` | `{ profile }` |
| PUT | `/api/characters/:id/intimate/inject` | `{ enabled }`（严格 `=== true` 才算开） | `{ profile }` |
| GET | `/api/characters/:id/intimate/vocabulary` | 无（`id` 只做路由占位） | `{ acts: [{key,label}], positions: [{key,label,group,tags}] }` |
| GET | `/api/characters/:id/intimate/log` | `?limit`（默认 50，夹到 1~200）`&offset`（默认 0）`&partnerKinds` | `{ logs: [...] }` |
| POST | `/api/characters/:id/intimate/log` | 人工补录：`{ actKey, positionKey?, customLabel?, count?, climaxCount?, occurredAt?, partnerKind?, partnerId?, rawId?, msgId? }`，也可传 `acts[]` | `{ inserted, skipped, blocked, logs }`（`logs` 为最近 20 条） |
| POST | `/api/characters/:id/intimate/record` | `{ tags }` 或 `{ prompt }` 或 `{ acts }`（优先级：`body.acts` 非空 → 直接用；否则 `body.tags` 数组 / `tagsFromPromptString(body.prompt)` → `classifyPromptTags`）；另可带 `scene` / `partnerKind` / `partnerId` / `rawId` / `msgId` / `source` / `confidence` / `occurredAt` | `{ inserted, skipped, blocked, acts, features }` |
| POST | `/api/characters/:id/intimate/classify` | `{ tags }` 或 `{ prompt }` | `{ acts, tags }`（**只归类不落库**，联调 / 回归用） |
| POST | `/api/characters/:id/intimate/rollback` | `{ rawId }`（必须为正整数，否则 400） | `{ deleted, characters }` |
| PUT | `/api/characters/:id/intimate/firsts/:actKey` | `{ firstAt, note }`（`firstAt: null` 即清空日期） | `{ first }` |
| GET | `/api/characters/:id/intimate/backfill` | 无 | `{ ...getBackfillStatus(id), backfill, features }`：顶层 = 私聊线，另有 `private` / `group` 两条线的 `{lastRawId,scanned,inserted}`；只读，无闸门 |
| POST | `/api/characters/:id/intimate/backfill` | `{ maxMessages?, batchSize?, reset? }`，或 `?reset=1` | `{ ...getBackfillStatus(id), backfill, features }`；`reset` 为真时先 `resetBackfill` 再 `startBackfill` |
| POST | `/api/characters/:id/intimate/backfill/reset` | 无 | `{ ...resetBackfill(id), backfill, features }`（回退两条线游标，不删流水） |
| DELETE | `/api/characters/:id/intimate/log/:logId` | 正整数 `logId` | `{ ok: true, ...getIntimatePanel(id) }`；非法 id → 400，非本角色 / 不存在 → 404 |
| DELETE | `/api/characters/:id/intimate` | 无 | `{ logs, firsts }`（`clearIntimateData`，**保留身体档案**） |

**409 条件**（`featureDisabled()`，第 46 行；响应体 `{ error: 'intimate feature disabled', disabled: [...], features: { intimate, intimateBackfill } }`）：

- `POST …/record`：`config.features.intimate === false` 时 409，`disabled: ['intimate']`。
- `POST …/backfill` 与 `POST …/backfill/reset`：`intimate` 或 `intimateBackfill` 任一为 `false` 时 409。
- **只拦"自动"入口**：人工补录、改档案、改设置、删除、回滚、读看板一律不拦——否则用户关掉开关后连历史数据都取不出来，只能去改配置文件（也正因为如此 `GET …/intimate`、`GET …/log`、`GET …/backfill` 没有闸门，只有 `POST` 拦）。
- `features.intimate` 为 `undefined` 时不拦（`=== false` 才算关），与 `config.js` 的默认开一致。

### AI 整理档案：独立路由

这 4 个接口在**独立 router** `agent-core/src/routes/intimateAiEdit.js` 里（与 `routes/intimate.js` 同落点 `/api/characters`，理由相同：`/:id/intimate/ai-edit*` 必须早于 characters 路由，否则会被 `/:id` 通配先吃掉），挂载见 `app.js` 的 `app.use('/api/characters', wrapRouterAsync(intimateAiEditRoutes));`。

| 方法 | 路径 | 关键参数 | 返回 |
| --- | --- | --- | --- |
| POST | `/api/characters/:id/intimate/ai-edit` | `{ sourceCharLimit? }`（默认 6000，夹到 200~40000） | `{ applied: [{field, value}], suggestions: [...], empty?: true }` |
| GET | `/api/characters/:id/intimate/ai-edit/suggestions` | `?status`（不传默认 `pending`；`?status=` 空串表示不过滤状态） | `{ suggestions: [...] }` |
| POST | `/api/characters/:id/intimate/ai-edit/suggestions/:sid/accept` | 正整数 `sid` | `{ suggestion, applied }`；`sid` 非法 → 400，不属于该角色 / 不存在 → 404 |
| POST | `/api/characters/:id/intimate/ai-edit/suggestions/:sid/reject` | 正整数 `sid` | `{ suggestion }`；同上 400 / 404 |

错误条件：

- `POST …/ai-edit`：`config.features.intimate === false` → 409 `{ error: 'intimate feature disabled', disabled: ['intimate'], features }`；无 LLM Key → 503 `{ error: 'llm not configured' }`；其余异常 → 502 `{ error: 'AI 整理失败：…' }`。
- 列表 / 采纳 / 忽略**不加总开关闸门**（关掉开关也要能看和清理已产生的提议，否则用户被锁死）；采纳时若提议载荷非法，返回 400 `invalid suggestion payload`。

## 10. 前端

### 面板结构（`web-ui/src/components/character/IntimatePanel.vue`）

| 区块 | 关键实现 |
| --- | --- |
| ① 知晓开关 | `linshe-switch` 绑 `injectEnabled`，标题 `让 {{ displayName }} 知晓这些信息`，副标题「开启后她会在对话中记得自己的身体档案（消耗少量 token）」；切换即 `PUT …/inject`，失败回滚开关值 |
| ② 统计口径 | `linshe-button variant="chip"` 三档 + 「全部」；见下方兜底 |
| ③ 身体信息 | `BODY_FIELDS` = 身高 / 胸围 / 腰围 / 臀围 / 罩杯 + 备注 `linshe-input type="textarea"`；两列 grid，`@media (max-width: 767px)` 降单列 |
| ④ 初次 / 破处信息 | 行 = 是否有记录开关 + `linshe-input type="date"`（未填时 `disabled`）+ `人工` / `自动` / `无记录` 标记；取消勾选 = `firstAt: null` |
| ⑤ 基础统计 | 概要 5 格（总次数 / 高潮次数 / 行为种类 / 最早记录 / 最近记录）+ `byAct` 两列 key/value（数值用 `--accent`） |
| ⑥ 部位敏感度 | 可增删的 `linshe-slider`（0~5）+ 横向色带；`zoneLevelPercent()` 决定宽度、`zoneLevelToken()` 决定色阶（只用 `var(--fun-*)` 现有 token） |
| ⑦ 体位排行 | `topPositions(byPosition, 5)`：名次 + label + 次数。**优先只显示出现 ≥2 次的条目**，若一条 ≥2 次的都没有（新角色 / 只发生过一次）则退回显示全部——这是**展示层**对"排行混入非体位词"的缓解，不改归因口径、不改后端 `byPosition`（仍返回全量），详见 §7 已知边界 |
| ⑧ AI 修改权限 | `AI_EDIT_FIELD_DEFS` 五项开关，写回 `PUT …/settings { aiEditFields }` |
| ⑨ 让 AI 整理档案 | 主按钮「让 AI 根据最近的对话整理档案」→ `proposeIntimateProfileEdits`；已授权字段由后端直接落库（返回 `applied`），其余渲染成「待确认提议」列表（`normalizeSuggestions`，每行 = 字段中文名 + 当前值 → 建议值 + 理由 + 「采纳 / 忽略」，`acceptIntimateSuggestion` / `rejectIntimateSuggestion`）。`loadSuggestions({ silent: true })` 读失败静默、不打断看板；错误文案 409 → 看板已关闭、503 → 尚未配置 LLM。整理 / 采纳前先 `flushPendingEdits()`，避免刚敲的改动被服务端值覆盖 |
| ⑩ 历史回填 | 「开启历史回填」开关（写 `backfillEnabled`）+ 「开始 / 继续回填」按钮 + `已扫描 N · 新增 N` 进度；`status === 'running'` 时每 `BACKFILL_POLL = 1500ms` 轮询 `GET …/backfill`，结束即停；状态文案的 `BACKFILL_STATUS` 六态与引擎一致（`partial` → 「未扫完，可继续回填」、`blocked` → 「已暂停：该角色未授权 AI 写入统计」）；面板还留着 `placeholder === true` 的「回填引擎尚未接入」提示分支（引擎接管后后端不再返回该字段，属于可删的兼容代码） |
| ⑪ 流水明细 | 最近 `LOG_PAGE = 20` 条 + 「加载更多」+ 人工补录表单 + 单条删除（`variant="danger"`，走 `confirm` 确认） |

面板改动档案前会先 `flushPendingEdits()`：把 400ms 防抖里还没发出去的本地改动落库，再让服务端结果覆盖，避免「刚敲完一行就被 AI 整理结果冲掉」。

### 入口：详情卡两处 + 聊天页设置面板一处

**详情卡里的两处都要在**——历史上有过只加一处导致移动端点不到的 bug：

- 桌面端：右侧悬浮卡 `.float-panel-body` 里的 `.float-row.float-row-action`「亲密信息」（第 199 行，`v-if="!isMobile"` 区块内）。
- 移动端：正文末尾 `.mobile-detail-toolbar`（第 112 行，`v-if="isMobile"`）里的 `.toolbar-item.toolbar-item-btn`（第 142 行）。

两处都调 `openIntimateModal()`（第 582 行）→ `showIntimateModal = true`，子窗是 `linshe-modal v-model="showIntimateModal" :title="\`亲密信息 — ${character?.display_name || ''}\`" full`（第 489 行），内容 `IntimatePanel`，`#footer` 只有一句「身体档案与流水字段修改后自动保存」+ 关闭按钮。详情卡收起时 `watch` 里一并 `showIntimateModal = false`（第 654 行，避免孤儿弹窗）。

**聊天页直达入口（`web-ui/src/views/ChatView.vue`）**：聊天页右上角 ⚙ 打开的设置面板里，「查看详细信息」下面有一行 `.sp-btn`「亲密信息」（第 277 行），点击走 `openIntimatePanel()`（第 1263 行）——先 `showSettings = false`（两个遮罩不能叠着，否则双遮罩 + 焦点错乱）再 `showIntimate = true`，由 ChatView 自己渲染同一个 `linshe-modal` + `IntimatePanel`（第 338-343 行，标题与底部操作与详情卡内那份完全同口径）。
这条入口的由来：原先必须「⚙ → 查看详细信息 → 详情卡里再点一次」，用户反馈找不到；桌面与移动端共用这同一行，所以只加一处即可。

### 口径 chip 与"至少保留一个口径"的兜底

`viewScopeToggleResult(list, key)`（`intimateLogic.js` 第 97 行）：取消**最后一个**勾选时不归零，而是回退默认口径（`DEFAULT_VIEW_SCOPE = ['user','character']`）并返回 `clamped: true`；面板在 `onToggleScope()` 里弹一次「至少保留一个统计口径，已切回"用户↔角色 + 角色↔角色"」——提示里的口径名由 `VIEW_SCOPE_DEFS × DEFAULT_VIEW_SCOPE` 现算，不要写死（默认值改过一次）。「全部」= 勾满三类（`ALL_VIEW_SCOPE`），后端不接受空数组，面板也不会提交 `?partnerKinds=all`。提交 query 走 `viewScopeToPartnerKinds()`（永不为空），回读用 `partnerKindsToViewScope()`（`all` 只在回读时当作全选）。

### 保存与接口层

- 身体档案 / 敏感带 / 备注：`blur`、`change` 即保存，`SAVE_DEBOUNCE = 400ms` 防抖（`onBodyInput` / `queueZonesSave` / `flushProfile` / `flushZones`）；`onBeforeUnmount` 会把还没到时间的改动补发出去。滑块拖动过程中只改本地值，松手（`change`）才落库。
- 错误提示走注入的 `toast` / `confirm`（`inject('toast')` / `inject('confirm')`），无注时 `console.warn`。
- `web-ui/src/api/intimate.js` 自带请求基元（刻意不改 1722 行的 `src/api/index.js`），非 2xx 抛错，409 转中文「看板功能当前已关闭」（`translateIntimateError()`）。导出：`getIntimatePanel` / `saveIntimateProfile` / `setIntimateInject` / `saveIntimateSettings` / `getIntimateVocabulary` / `listIntimateLogs` / `createIntimateLog` / `setIntimateFirst` / `deleteIntimateLog` / `startIntimateBackfill` / `getIntimateBackfill` / `proposeIntimateProfileEdits` / `listIntimateSuggestions` / `acceptIntimateSuggestion` / `rejectIntimateSuggestion`。
- 纯逻辑集中在 `intimateLogic.js`（无 Vue 依赖），组件只负责画：`AI_EDIT_FIELD_DEFS`、`VIEW_SCOPE_DEFS`、`normalizeAiEditFields`、`toggleAiEditField`、`normalizeViewScope`、`viewScopeToggleResult`、`viewScopeToPartnerKinds`、`partnerKindsToViewScope`、`normalizeZones` / `zonesForSave` / `addZone` / `removeZone` / `zoneLevelLabel` / `zoneLevelPercent` / `zoneLevelToken`、`topPositions` / `actStatRows` / `statSummary`、`firstsRows` / `logRowText`、`formatDateTime` / `toDateInput` / `fromDateInput`、`normalizeBackfill` / `backfillButtonText` / `backfillStatusText`、`SUGGESTION_FIELD_LABELS` / `suggestionFieldLabel` / `normalizeSuggestions` / `aiEditResultText` 等。
- 主题与动效遵循 `docs/design-system.md`：色值一律走 `styles/tokens.css` token（无硬编码色值），切换口径 / 展开表单用 `0.3s` 过渡（`.ip-fade` / `.ip-drop`），并带 `prefers-reduced-motion` 降级。
- 已裁决接受的小冗余：`runAiEdit()` 在 `proposeIntimateProfileEdits()` 之后还会再发一次 `loadSuggestions()`（`listIntimateSuggestions`）GET。propose 的返回里其实已经带了 `suggestions`，这次多发的请求是幂等的纯读取，仅多一个请求，不改（要收掉的话注意 propose 返回的提议行与列表接口的字段形状要一致）。

## 11. 验证入口

| 范围 | 命令 / 文件 |
| --- | --- |
| 数据层（迁移幂等、幂等记账、权限闸门、口径过滤、回滚、级联删除） | `agent-core/test/intimateService.test.js` |
| HTTP 契约（含挂载顺序源码断言） | `agent-core/test/intimateApi.test.js` |
| 注入块组装（开关 / 空档案 / 截断 / 反向约束 / 只读不写库） | `agent-core/test/intimatePrompt.test.js` |
| 自动记账入口 | `agent-core/test/intimateAutoRecord.test.js` |
| **正文兜底记账**（私聊 / 群聊实时口径、"已归类就不叠未归类"、幂等、总开关与权限闸门、两条回填线、词表标签、源码级挂点断言） | `agent-core/test/intimateTextFallback.test.js` |
| **催眠轮 / 强制高潮轮记账**（催眠轮并入用户消息、普通轮零行为变化、`forceTextFallback` 默认 false 与显式 true、没 prompt 的强制轮、幂等不双记、源码级挂点） | `agent-core/test/intimateHypnosisRecord.test.js` |
| **成人内容词表**（口语正例、日常反例、刻意不覆盖的边界、与看板/催眠轮的联动、词表收口） | `agent-core/test/intimateColloquialVocab.test.js` |
| 回填引擎（prompt 兜底解析、私聊线与群聊线各自的幂等 / 续跑 / 归因 / 重名、被权限拦下、开关关闭、出错状态、reset） | `agent-core/test/intimateBackfill.test.js` |
| 聊天与奇遇集成（尾部记账、撤回与清空联动、注入联动、权限闸门、奇遇 `sourceUid`；含 `chat.js` / `eventGenerator.js` 挂点源码断言） | `agent-core/test/intimateChatIntegration.test.js` |
| 群聊场景（按发言角色记账、`scene=group` / `partnerKind=character` / `partnerId=0`、锚点失效保护、口径联动；含挂点源码断言） | `agent-core/test/intimateGroupRecord.test.js` |
| 镇民奇遇场景（`npc` / `user` 归因、显式 `sourceUid` 幂等、纯 NPC 跳过、总开关、无 tag 不猜、权限闸门） | `agent-core/test/intimateTownEventRecord.test.js` |
| AI 整理档案（素材为空不调 LLM、已授权直接写、未授权只落提议、脏 JSON 丢弃、采纳 / 忽略；LLM 用注入的假调用，不联网） | `agent-core/test/intimateAiEdit.test.js` |
| 前端纯逻辑（权限清洗、口径换算与 clamp、部位增删、排行、格式化、回填状态文案、提议清洗与文案） | `web-ui/test/intimatePanel.test.js` |
| 浏览器回归样例（**挂载真实组件** + 组件漂移自检） | `web-ui/test/fixtures/intimatePanel.html` + `intimatePanel.js`：用 `createApp(IntimatePanel, { character })` 直接挂载真实 `IntimatePanel.vue`（Vite dev 即时编译 SFC，与 `whiteGaps.js` 同一套做法），`globalThis.fetch` 打桩面板 / 词表 / 流水 / 待确认提议 4 个接口（离线可跑，不连 3099）；24 项自检覆盖组件漂移（组件 scoped CSS 里出现硬编码色值、引用不存在的 token、区块结构被改、接口路径被换 → 直接变红）、暖色 / 暗夜 token 溯源、360px 真实视口（iframe）单列与无横向溢出；页面自显 PASS / FAIL。打开：`npm --prefix web-ui run dev` 后访问 `/test/fixtures/intimatePanel.html`，加 `?theme=dark` 用暗夜主题打开。口径与 `docs/testing.md` 的浏览器回归样例清单一致 |

```powershell
# 后端（内存库，禁用网络）
cd agent-core
$env:DB_PATH=':memory:'; node --test test/intimateService.test.js test/intimateApi.test.js test/intimatePrompt.test.js test/intimateAutoRecord.test.js test/intimateBackfill.test.js test/intimateChatIntegration.test.js test/intimateGroupRecord.test.js test/intimateTownEventRecord.test.js test/intimateAiEdit.test.js
node --test "test/*.test.js" "src/services/*.test.js"   # 全量

# 前端
cd web-ui
node --test test/intimatePanel.test.js
npx eslint src
npx vite build
```

测试统一 `process.env.DB_PATH=':memory:'` 后动态 import，并把 `globalThis.fetch` 换成抛错函数挡住网络（无真实 LLM / 真实库依赖）。

**没有自动化覆盖的路径**（改动相关代码时应手工验证）：

- 真实 LLM 服务：注入块已用本地假 LLM 端点（`LLM_BASE_URL` 指向本地 stub，env 注入、未改 `.env`）跑过真链路——一轮真实对话后 stub 收到的 payload 里确实含 `<intimate_profile>`（身高 / 三围 / 敏感带 / 初次 + 「禁止复述具体数字」约束，位置在 `<reply_length>` 之前），关掉「知晓」开关后新请求 0 命中；同一轮也跑通了自动记账（阴道 / 抱腰后入、`byScene=chat`）。**未覆盖：真实 LLM 服务**（stub 只验证链路与形状，不验证模型是否真的照着约束说）；**未覆盖：ComfyUI 真实出图**。
- 「让 AI 整理档案」的真实 LLM 路径：单测注入假 `llmCall`，prompt 质量、模型输出偏差、真实 503 / 502 分支都只有手工验证。
- 面板在真实浏览器里的**视觉观感**与两处入口的**可点性**：`node:test` 不渲染组件（项目没有 jsdom）；`intimatePanel.html` 已经挂载真实组件并做组件漂移 / 双主题 / 360px 自检（24 项），但它进不了角色详情卡，两处入口的实际点击仍需手工验证。写这类"读计算样式"的自检注意 `docs/testing.md` 记的坑：切主题后立刻读 `getComputedStyle` 会拿到过渡起点，必须先冻结 `transition` 并 `cancel()` 掉在跑的动画再断言。
- 历史回填在真实老库上的效果：测试用合成 `raw_messages`，真实数据里 `prompt` 列的覆盖率、群聊 `content` 行协议的覆盖率与 `content` 兜底比例需要人工抽样确认。
- 群聊 / 奇遇 / 镇民奇遇记账在真实业务链路上的端到端效果：单测直接调函数；**正文兜底这条路已经补过一次真实 HTTP + 真实回填引擎的端到端实测（见第 13.3 节）**，但"真模型生成一轮群聊 → 看板立刻多一笔"仍未跑过（那需要模型真的输出成人内容）。
- 正文兜底的真实召回/误报率：只有合成样本（含成人词的中文句 / 普通句），没有拿真实聊天记录统计过"该记的漏了多少、不该记的记了多少"。要做就照第 7 节 task-25 的测量法（同一把尺 + 人工样本）。task-9 补口语词时用的也是合成样本（39 正例 / 33 反例），同样没有真实语料统计。

## 12. 边界声明

本模块只服务成年角色档案，不提供未成年体型相关的字段语义、默认值或提示词。

## 13. 正文兜底记账（task-26 建口径；task-8 / task-9 补两条）

**用户报的缺口**：看板原先只吃"生图 prompt 的英文 tag 串"——

- 私聊：`chat.js` 只在 `tags.prompt` 存在时记账（`if (tags.prompt) recordIntimateFromTail(...)`，第 1494 行）⇒ 纯文字轮次整段不进看板；
- 群聊：只收集 `[说话人]: {画面描述}` 的**发图行**（`recordGroupIntimateFromRound`）⇒ 群里只打字不发图，看板一笔都没有（用户主动发起的群聊轮只"鼓励"配图，不强制）；
- 而且群聊那笔是 `partner_kind='character'`，旧默认口径 `['user']` 也不显示 ⇒ "群聊消息没引进看板"是**两层叠加**。

**2026-09-29 追加的缺口**（用户报「催眠的时候如果发生性交记录到面板里」，task-8 诊断 + task-9 收口）：链条本身没断——`chat.js` 的催眠分支只做注入（第 872-911 行），记账挂点（第 1494 / 2412 行）对它没有任何条件——断的是**三条更细的路**：

1. **兜底只扫"她那一半"**：催眠口径（完全控制 = "只客观呈现身体反应与已经执行的动作，语气平淡、简短、直给"，`<reply_length>` 10~60 字）把露骨词压到**用户那一句指令**上，而 `recordUnspecifiedFromRawId()` 只 `SELECT content ... WHERE id = ?`（她自己那条）⇒ user 命中、她回复不命中 ⇒ 整轮零流水。实测（真机日志原句）：user=「自慰吧」词表 true + 她回"嗯……好。（指尖顺着裙摆边沿慢慢滑下去，动作有些发软）……"词表 false → `inserted: 0`。
2. **有 prompt 时归类/兜底是互斥的**：`recordFromPrompt()` 默认 `allowUnspecified=false`（`intimateAutoRecord.js` 第 129 行），而 `chat.js` 是 `if (tags.prompt) 归类 else 兜底` ⇒ 有 prompt 就永远进不到 else。强制高潮轮走的正是"强制出图"分支（`chat.js` 第 1640 行路径 D'），prompt 由生图助手按上下文自拟（散文式英文场景描述，不含归类 tag）⇒ 归类空手而归、正文兜底又够不着 ⇒ 整轮零流水。
3. **自动触发的强制高潮轮不经 `chat.js`**：点「强制高潮」是在 `routes/hypnosis.js` 第 143-151 行立刻 `forceProactiveNow(..., { forcedClimax: true })` 触发一轮，那一轮由 `proactiveChatScheduler.writeProactiveMessage()` 直接落 raw ⇒ `chat.js` 的两处挂点一个都跑不到（旧状：整文件 grep `intimate` = 0 命中）。

### 13.1 规则

没有**可归类**生图 prompt 的轮次，先做一次**二值判定** `containsExplicitAdultContent(判定文本)`（`db/imagePromptKnowledgePolicy.js`，自带中英词表）：

- 命中 → 记一笔 `act_key='unspecified'`（`ACT_DEFINITIONS` 里的中文名「未归类」，`tags: []`；只能由正文兜底与人工产生，前端下拉/统计直接用它下发的 label）；
- 不命中 → 什么都不记（不猜）。

**判定文本 = 这一轮，不是"她那一半"**（`intimateAutoRecord.roundTextOf()`，第 90-98 行）：

| 轮次 | 判定文本 |
| --- | --- |
| 普通轮 | **她这一轮的回复**（`raw_messages.content`），与 task-26 原口径逐字节一致 |
| **催眠轮**（`hypnosisService.isBodyControlled()` 为真、未过期） | 她这一轮的回复 **+ 紧邻其前的用户消息**（`previousUserText()`，第 72-82 行）；因为催眠口径把露骨词挤到用户那一侧（见上 1） |
| **`forceTextFallback` 轮**（`proactiveChatScheduler` 的自动触发轮） | 归类为空时同上；本轮**没有 prompt** 时退到该会话最后一条 assistant raw，且**只用它自己的正文**（主动消息的"上一句 user"可能是很久以前的消息，并进来会让旧指令给无关的一轮背账） |

**什么时候会真的跑到兜底**（`recordFromConversationTail()`，第 173-254 行）：

1. `result.inserted === 0 && result.skipped === 0 && !result.blocked`（归类一条都没产出，且未被权限闸门挡下）；
2. 且 `round.hypnosis || forceTextFallback === true`（第 245 行）——即"催眠轮"或"调用方显式声明这一轮必须入账"；
3. 锚点仍是同一 `raw_id`；归类成功时**不**进兜底 ⇒ 不双重计数。

`forceTextFallback` 默认 `false` ⇒ 普通轮的现有行为逐字节不变（有测试钉住）。

刻意**不**做：不把中文正文喂给 tag 词表（`tagsFromPromptString` + `classifyPromptTags` 是按英文逗号 tag 串设计的，切中文叙事会大量误报，task-25 已实测）；不调 LLM 判定（成本 + 幻觉，见第 3 节末）；不猜具体行为、不猜体位、不猜对象（群聊仍是 `partnerKind='character'` / `partnerId=0`）。"未归类"是**承认发生了但不知道是什么**，比整段丢掉更接近事实，也不会污染已归类的统计。

### 13.2 挂点（四条实时 + 两条回填）

| 位置 | 入口 | 说明 |
| --- | --- | --- |
| chat（私聊） | `intimateAutoRecord.recordUnspecifiedFromRawId()`（第 312-327 行） | `chat.js` 两处 `if (tags.prompt) recordIntimateFromTail(...)` 的 **`else` 分支**各接一处（主流程用 `rawMsgId`、needImage 用 `assistantRawId`，第 1495 / 2413 行）；与归类路径**互斥**，不会双重计数 |
| chat（私聊·尾部兜底） | `intimateAutoRecord.recordFromConversationTail()` 内部（第 245-253 行） | 有 prompt 但归类为空时，**催眠轮 / `forceTextFallback` 轮**再补一次；补的是调用方永远够不着的那半（见 13.1 上 2） |
| chat（私聊·自动触发轮） | `proactiveChatScheduler.forceProactiveNow()`（第 1266-1278 行） | 自动触发的强制高潮轮直接落 raw、不经 `chat.js`；用 `forceTextFallback: forcedClimax` 调同一入口。**位置必须在 `generateImageForGreeting()`（第 1257 行）之后**——它才是把 prompt 写回 raw 的那一步，而尾部记账按"最后一条带 prompt 的 assistant raw"找锚点 |
| group（群聊） | `groupChatEngine.recordGroupIntimateFromText(rawId, lines, { excludeCharacterIds })` | 解析剧本时收集"说话人 + 正文"（`intimateTextLines`），轮次收尾与 `recordGroupIntimateFromRound` 并列调用；**本轮已归类的角色排除**；同角色多句命中只算一笔 |
| 回填 · 私聊线 | `intimateBackfill.scanPrivateBatch()` | 原先"没有 tag 就跳过"的分支改为先试正文兜底，命中才记（回填是**离线扫历史**，拿不到当时的催眠态，所以不参与 13.1 的"并入用户消息"） |
| 回填 · 群聊线 | `intimateBackfill.scanGroupBatch()` + `parseGroupTextLines()` | 没有 `{…}` 的正文行按说话人兜底；同一 raw 里已发图的成员排除 |

幂等与回滚：锚点仍是 `raw_messages.id`（`source_uid = auto:<scene>:raw<id>:unspecified::<partnerKind>:0`），所以重复记账 / 重放 / 重扫都不翻倍；撤回一轮、清空会话、解散群的看板回滚照旧生效（回滚按 `raw_id`，与记忆同一锚点）。总开关 `features.intimate=false` 在调用方包装与 `recordUnspecifiedFromText()` 内部各把一道；未授权 `stats` 时返回 `blocked: true`，回填据此停线重扫。

**词表里的中文口语补充（task-9）**：`EXPLICIT_ADULT_PATTERN`（`db/imagePromptKnowledgePolicy.js` 第 28 行）原先全是名词化写法（性交 / 内射 / 小穴 …），对"你插进来""我下面已经湿了"这类口语一律 false ⇒ 补了一批（`做爱(?!心)`、`插(?:进|入)来`、`插(?:进|入|到)(?:我|人家)`、`(?:我|人家)下面…湿`、`(?:内裤|底裤|裤裆)…湿`、`脱光…/…脱光`、`抽插`、`撸管`、`口爆`、`乳夹`、`肛塞` 等 26 条写法 / 覆盖 39 条口语正例）。口径是**宁可少加，也不要误报**：裸的「插入」「插进去」「湿了」「腿张开」「她去了」「我要来了」**刻意不加**（与"插入表格/U盘插进去""地湿了""腿张开做拉伸""她去了学校"同形，区分不了），理由逐条写在文件头注释里、并由 `test/intimateColloquialVocab.test.js` 的 C 组**显式断言为 false**，防止后人顺手补上。

### 13.3 口径默认值（同批改动）

默认口径由 `['user']` 改为 `['user', 'character']`（`DEFAULT_VIEW_SCOPE`，前后端同名常量）：群聊流水默认就计入统计，不用手动切 chip。存量库里存着旧默认的行由 `db/index.js` 的一次性迁移同步（`system_settings.intimate_view_scope_group_default` 标记，只跑一次）；用户之后主动收窄回"只看用户↔角色"不会被改回来（有单测）。NPC 维度默认仍关着。

### 13.4 验证

- 单测：`agent-core/test/intimateTextFallback.test.js`（11 项：私聊/群聊实时、排除规则、幂等、锚点失效、总开关、权限 blocked、两条回填线、词表标签、源码级挂点）、`intimateService.test.js` 的迁移用例。
- task-8 / task-9 新增两份：
  - `agent-core/test/intimateHypnosisRecord.test.js`（15 项：催眠轮并入用户消息、普通轮零行为变化、解除催眠回退、`forceTextFallback` 三种情形、没 prompt 的强制轮、幂等不双记、总开关、强制高潮按钮那一笔、源码级挂点）；
  - `agent-core/test/intimateColloquialVocab.test.js`（6 项：口语正例 39 条、日常反例 33 条、**刻意不覆盖的边界显式断言 false**（C 组）、词表 × 催眠轮联动、词表收口）。
- 实跑数字（2026-09-29，本机 `runtime\nodejs\node.exe`，`DB_PATH=':memory:'`）：`cd agent-core` + `node --test --test-concurrency=1 "test/intimate*.test.js"` → **219 tests / 216 pass / 0 fail / 3 skipped**（含上面的新文件）；其中排除这两份新文件的既有 intimate 文件为 198 / 195 / 0 fail / 3 skipped。前端 `web-ui/test/intimatePanel.test.js` 见第 16 节的口径。
- **真实 HTTP 端到端**（临时库 + 真后端 + 真回填引擎，2026-09-28 实测）：私聊历史 3 条（正文命中 1 / 普通 1 / 带 prompt 1）→ 回填后流水 `unspecified@raw1/chat/user` + `vaginal@raw3/chat/user`，`counts.logs=2`、`totalActs=2`、`byAct` 为「未归类 ×1 + 阴道 ×1」；群聊一条 raw（甲只有正文命中、乙带发图行）→ 甲记 `unspecified@raw/group/character`、乙记 `vaginal@raw/group/character`，乙不叠未归类；词表回显 `{"key":"unspecified","label":"未归类"}`。

### 13.5 已知边界

- 只回答"有没有"，不回答"是什么"：正文命中的轮次统一显示「未归类」。**旧数据回填后 `totalActs` 会跳一次**（补的是历史事实，不是 bug），不想要就把口径收窄或删掉那几条流水。
- 判定是词表二值判断，两个方向都会错：含蓄写法（不含词表任何词）仍然漏；含这些词但非性场景（例如剧情里的"高潮"）会记成「未归类」。宁可漏/粗，也不猜具体行为。
- 扩词要走 `imagePromptKnowledgePolicy.EXPLICIT_ADULT_PATTERN`（与生图合规判定同源），改它要连带回归生图侧（`imagePromptTagKnowledgeData.js:351` 用它决定每个 tag 归到 `adult_*` 还是普通类目、`imagePromptKnowledge.js:87 / :271` 用它决定要不要召回成人 tag）。task-9 的口语补充实跑：正例 **39 / 漏 0**、日常反例 **33 / 误报 0**；生图侧连带回归（拿 `git show HEAD` 的旧正则与新正则逐个比对 `src/db/data/imagePromptTags.yaml` 的全部标签）：**2985 个标签里只有 1 个翻转** —— `penetration gesture = 暗示做爱`（原 `expression_pose_vocabulary` → 新 `adult_expression_pose_vocabulary`）。这一条语义上本来就该算成人，方向正确；除此之外没有生图类目变化。
- **"并入用户消息"只在催眠轮**（`isBodyControlled`，且异常一律当"不是催眠轮"）：普通轮逐字节不变是有意为之（本轮验收口径）。通用口径（所有轮都把用户消息并进来）理由同样成立——AI 判断送的本来就是 `[用户消息, 她的回复]`——但会改变普通轮的记录结果，要放开得先经用户裁决。
- **自动触发轮的兜底仍是"最后一条 assistant raw"**：`forceTextFallback` 轮没有 prompt 时锚点退到会话最后一条 assistant raw，成立的前提是调用方紧接着落库就调用它（`proactiveChatScheduler` 就是这么用的）。若有别处复用这个开关而中间又插了别的 raw，锚点会错到上一条——新增调用方时要么保证时序，要么改成显式传 `rawId`（当前没有这个参数）。

## 14. 「AI 判断行为」（task-32）

**用户口径**：加一个按钮就叫「AI 判断行为」，再加一个「是否默认开启 AI 判断」开关；**异步**（回复完再判定）。

**服务端**（`agent-core/src/services/intimateAiJudge.js`）：

| 函数 | 作用 |
| --- | --- |
| `buildJudgePrompt({characterName,userName,lines,scene})` | 组装判定 prompt：给出**完整 JSON 示例**（`acts[].act_key/partner/confidence/count/climax_count` + `reason`）与逐字段约束（AGENTS.md 口径） |
| `parseJudgeOutput(text)` | 容错解析（裸 JSON / 代码块包裹 / 前后带话）；**白名单过滤**（不在 `ACT_DEFINITIONS` 里、以及 `unspecified` 一律丢弃）；confidence 夹 0~1、count 夹 1~99、climax_count 夹 0~99 |
| `judgeRound(...)` | 判定并记账：只补「一条流水都没有 / 只有未归类」的轮次（已有具体行为 → `already-recorded`，**不重复计数**）；判定出 ≥1 条具体行为时**撤掉该轮的 `unspecified`**；写库 `source='llm'`，幂等锚点 `ai:<rawId>:<actKey>:<partnerKind>`；坏 JSON / 调用失败只报错不写脏数据；`config.features.intimate=false` → blocked |
| `listJudgeCandidates` / `judgeRecentRounds` | 手动按钮：候选 = 她的私聊 + **她参与的群聊** raw；群聊 raw 是多角色剧本，**只挑她自己说过的台词**；私聊会带上她回复前那句 user；上限 20 |
| `judgeRoundInBackground` | 自动挂点用：fire-and-forget，失败只 warn |

**开关**：`character_body_profile.ai_judge_enabled`（DDL 默认 0 + `addColumnIfMissing` 迁移；**默认关**，因为开了每轮会多一次 LLM 调用）。

**接口**：`PUT /api/characters/:id/intimate/ai-judge`（body `enabled`）→ `profile`；`POST /api/characters/:id/intimate/ai-judge/run`（body `limit`，≤20，默认 8）→ `scanned/judged/recorded/skipped/superseded/errors`（总开关关闭时 409，与 `/record`、`/backfill` 同口径）。

**自动挂点**：`chat.js` 回复落库后（画像提取之后）与 `groupChatEngine.js` 群聊轮收尾处 —— 开关开启时各自异步补判，**不阻塞聊天**。

**前端**：`IntimatePanel.vue` 新「AI 判断行为」区块 —— `LinsheSwitch`「默认开启 AI 判断」+ `LinsheButton`「AI 判断行为」（汇总 toast：已判断 N 轮，补记 M 笔；有 errors 降级 warning；成功后刷新看板与流水）。

**验证**：`agent-core/test/intimateAiJudge.test.js` 12 项；后端全量 **732 / 729 pass / 0 fail / 3 skipped**；前端 **196 / 196**；`vite build` 重建产物 `index-CuYQANt_.js` / `index-CO9vIxQM.css`（并删掉两个 hash 已变的旧产物）。**未覆盖**：真机浏览器点击（本机没有 jsdom / @vue/test-utils，无法挂载测试；构建通过 + 产物含新文案与接口路径 + eslint 干净）；真实 LLM 下的判定准确率（判定质量取决于模型，词表与「不重复计数」逻辑已在单测里锁住）。
## 15. AI 判断行为的每日配额可填（task-37）

- 设置：全局 `aiJudgeDailyLimit`（**0 = 不限制**，默认 200），**计数按本地日期落库、跨重启保留**。
- 接口：`GET /api/config` 的 `aiJudge: { dailyLimit, usedToday, remaining, unlimited }`；`PUT /api/config/ai-judge { dailyLimit }`（非法 → 400）。
- 耗尽时：**自动补判不调用模型**（打 `[intimateAiJudge] 今日配额已用完（N/N）`），手动 `POST …/ai-judge/run` 返回里新增 `quota` 字段并在 `errors` 里给人话说明（既有字段不变）。
- 前端：亲密看板「AI 判断行为」区块里的「每日判定上限」输入（`LinsheInput`，旁注显示今日已用/剩余），`0 = 不限制`。
