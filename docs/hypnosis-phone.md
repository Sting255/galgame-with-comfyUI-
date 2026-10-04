# 催眠手机（hypnosis phone）设计与维护

背包里的特殊道具「催眠手机」：可自定义时长催眠角色、随时唤醒、**只唤醒意志**（意志清醒但身体仍受控）、身体控制、强制高潮（计入亲密看板流水）、遗忘被控制期间发生的事（长期记忆归档 + **这段时间的对话不再进入模型上下文**），并可在面板上「让她恢复这段记忆」把两层一起撤销。

> **快照与落地状态（2026-09-28 13:35 建快照；计数与群聊侧口径于 2026-09-29 随 task-1 复核）**：功能已全部落地（迁移 / 服务 / 路由 / 挂载 / 总开关 / 道具 / 注入块 / chat.js 接线 / 上下文屏蔽 / **群聊注入与群聊侧遗忘** / **睡眠控制** / **群聊「强制高潮」出图** / 前端面板与背包入口），**后端 132 项（`agent-core/test/hypnosis*.test.js` 9 个文件）+ 前端 36 项（`web-ui/test/hypnosis*.test.js` 3 个文件）单测全绿**。**计数随功能增加，以这两条命令的实跑结果为准**：后端 `cd agent-core` → `$env:DB_PATH=':memory:'; node --test --test-concurrency=1 test/hypnosis*.test.js`；前端 `cd web-ui` → `node --test --test-concurrency=1 test/hypnosis*.test.js`。全文没有"未落地"的代码事实；第 9、10、14 节标注了**未覆盖项 / 已知边界**（真实 LLM 回合、群聊滚动摘要不进屏蔽等）。
>
> | 部分 | 状态 | 位置 |
> | --- | --- | --- |
> | 迁移（两张表） | **已落地** | `agent-core/src/db/index.js` 的 `migrateHypnosisSchema()` |
> | 服务层（状态机/指令/遗忘/恢复/门控/领取 + 群聊侧遗忘的时间区间归档 + 睡眠控制） | **已落地** | `agent-core/src/services/hypnosisService.js` |
> | 道具本体（`hypnosis_phone` 条目 + 永久道具分支 + `grantHypnosisPhone()`） | **已落地** | `agent-core/src/services/itemService.js` |
> | HTTP 路由 + 挂载 + 总开关 | **已落地** | `agent-core/src/routes/hypnosis.js`、`app.js`、`config.js`、`db/settings.js` |
> | 上下文屏蔽 | **已落地** | `agent-core/src/services/contextAssembler.js` 的 `getSplitHistory(..., { excludeWindows })` |
> | 注入块（三个 builder，含恢复叙事块） | **已落地** | `agent-core/src/services/hypnosisPrompt.js` |
> | 群聊接线（催眠注入 + 群聊 transcript 时间区间屏蔽 + 「强制高潮」出图兜底） | **已落地** | `agent-core/src/services/groupChatEngine.js` 的 `collectHypnosisDirectiveBlocks()` / `buildTranscript()` / `buildGroupContext()` / `ensureForcedClimaxImage()` |
> | 睡眠控制（立刻入睡 / 立刻唤醒走日程链路） | **已落地** | `agent-core/src/services/scheduleEditor.js` 的 `forceSleepNow()` / `forceWakeNow()` → `scheduleManager.js` 的 `syncSleepingState()` / `getSleepStatus()` |
> | 前端（私聊面板 + 群聊面板 + 睡眠区 + 纯逻辑 + 接口 + 背包入口） | **已落地** | `web-ui/src/components/HypnosisPhonePanel.vue`、`HypnosisPhoneGroupPanel.vue`、`web-ui/src/components/hypnosisLogic.js`、`web-ui/src/api/hypnosis.js`、`web-ui/src/composables/useBackpackActions.js` |
> | `chat.js` 接线（状态/指令/遗忘注入 + 历史屏蔽） | **已落地** | `agent-core/src/routes/chat.js` 第 754-768、837-858 行 |
> | 单测（服务 / 注入块 / 历史屏蔽 / 群聊遗忘与出图 / 睡眠 / HTTP 契约 / 面板纯逻辑） | **已落地**（后端 132/132、前端 36/36 绿；2026-09-29 实跑） | `agent-core/test/hypnosis*.test.js`（9 个）、`web-ui/test/hypnosis*.test.js`（3 个），另有 `agent-core/test/fileLogger.test.js` |
>
> 行号基于上面这个快照；改动后请以函数名 / 路径重新定位。

## 1. 定位与获取

**永久道具，不消耗**（`agent-core/src/services/itemService.js`）：

- `ITEM_EFFECTS` 新增 `hypnosis_phone: { kind: 'special', name: '催眠手机', theme: '一台造型老旧的翻盖手机，屏幕里泛着催眠漩涡般的微光' }`；`HYPNOSIS_PHONE_EFFECT_KEY = 'hypnosis_phone'` 与 `PERMANENT_EFFECT_KEYS = new Set([HYPNOSIS_PHONE_EFFECT_KEY])` 是同一份键的唯一定义处。
- `useItem()` 在通用消耗分支**之前**判断永久道具：命中 `PERMANENT_EFFECT_KEYS` 时直接返回 `{ ok: true, permanent: true, summary, effect, activeEffect: null }`，**不写 `status='used'`**；真正的状态由 `hypnosisService` 的 `character_hypnosis` 承载。不这样分流的话，用一次手机就被标成已用，第二次就点不动了。
- `discardItem(itemId)` 仍可丢弃（用户主动扔掉手机）。
- `grantHypnosisPhone()`（幂等）：背包里已有 `status IN ('ready','generating')` 的同款手机就直接返回那件；否则 `INSERT INTO backpack_items (… source_type='grant' …)`，`collected_at = datetime('now')`、`owner_key='me'`。

**前端入口有三处**（都是同一个面板组件）：

1. **聊天页 ⚙ 设置面板直达**（`web-ui/src/views/ChatView.vue`）：「亲密信息」下方一行「催眠手机」，先关设置面板再开弹窗（与亲密信息同款交互，避免双层遮罩）。用户不必专程去背包——**这是主入口**。
2. **背包道具入口**（`web-ui/src/composables/useBackpackActions.js`）：`pickCharacter(char)` 里 `item.effect_key === 'hypnosis_phone'` 时**不调用 `store.useItem()`**，而是 `hypnosisPhone.value = { open: true, character: char }` 交给弹窗（`LinsheModal` 承载 `HypnosisPhonePanel`）。这样避免后端把手机当普通道具消耗掉。
3. 背包里没有手机时，面板门控区会显示「领取催眠手机」按钮（`isPhoneMissing` → `grantHypnosisPhone`），领取后即可使用。

## 2. 数据模型

`agent-core/src/db/index.js` 的 `migrateHypnosisSchema(db)`（纯新增表，只 `CREATE TABLE IF NOT EXISTS`，不参与 `ALTER` 补列）：

### `character_hypnosis`（每角色一行）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `character_id` | INTEGER PRIMARY KEY → `characters(id)` CASCADE | 角色 id |
| `body_controlled` | INTEGER NOT NULL DEFAULT 0 | **身体是否受控** |
| `mind_awake` | INTEGER NOT NULL DEFAULT 0 | **意志是否清醒** |
| `active_until` | DATETIME（可空） | 到期时间；`NULL` 或已过期 = 未催眠 |
| `started_at` | DATETIME（可空） | 本次催眠开始时间，也是**遗忘窗口的左端** |
| `pending_directive` | TEXT NOT NULL DEFAULT '' | 一次性指令：`''` / `'body_control'` / `'forced_climax'` / `'memory_restore'` / `'wake_reaction'`（`PENDING_DIRECTIVES`；最后一个是 task-42 的「刚被唤醒」状态） |
| `pending_at` | DATETIME（可空） | 指令下达时间 |
| `command_count` | INTEGER NOT NULL DEFAULT 0 | 累计指令次数 |
| `last_command` | TEXT NOT NULL DEFAULT '' | 最近一次操作（`hypnotize` / `wake:full` / `wake:mind` / `body_control` / `forced_climax` / `memory_restore` / `expired`） |
| `updated_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 更新时间 |

### `hypnosis_forgotten_windows`（遗忘窗口，可多条）

| 列 | 类型 / 默认 | 语义 |
| --- | --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 窗口 id（撤销时的 `:wid`） |
| `character_id` | INTEGER NOT NULL → CASCADE | 角色 id |
| `from_raw_id` / `to_raw_id` | INTEGER NOT NULL DEFAULT 0 | 窗口覆盖的 raw 区间（闭区间，供上下文屏蔽与审计） |
| `from_at` / `to_at` | DATETIME | 窗口时间范围（`from_at` = 当时 `started_at`，`to_at` = 遗忘时刻） |
| `memories_archived` | INTEGER NOT NULL DEFAULT 0 | 本次实际归档的长期记忆条数 |
| `memory_ids` | TEXT NOT NULL DEFAULT '[]' | **精确**被归档的 `memory_fragments.memory_id` 列表——撤销按它还原，不会误还原同一 raw 区间里被其它归档任务处理过的无关记忆 |
| `status` | TEXT NOT NULL DEFAULT 'active' | `'active'` \| `'restored'`（可撤销审计） |
| `created_at` | DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP | 创建时间 |

索引：`idx_hypnosis_forgotten(character_id, status)`。

**为什么 `body_controlled` 与 `mind_awake` 要正交**：这两列是两个独立维度——**身体听不听话**与**意志清不清醒**。「正常催眠」是 (1,0)，用户点名要的「只唤醒意志」是 (1,1)：她完全清醒、能思考能说话能表达抗拒，但身体不听使唤。合成一个枚举就丢掉了这层张力（注入块的两个分支、面板的两枚标记都建立在正交之上）。

**惰性过期**：没有定时器（用户可能关掉客户端，定时器会漏）。`readStateRow()` 用 `active_until > datetime('now')` 在 SQLite 里直接算 `is_active`；`expireIfNeeded()` 在读状态时发现过期就当场归零落库（`body_controlled=0`、`mind_awake=0`、`active_until=NULL`、`pending_directive=''`、`last_command='expired'`），**保留 `started_at`**（遗忘窗口还要用）。`getHypnosisState()` / `isHypnotized()` / `isBodyControlled()` / `isMindAwake()` 都先过这一步。

## 3. 四种组合 → 注入块形态 / 前端展示

**注入块侧**（`buildHypnosisStateBlock(state, { chatUserName })`，`hypnosisPrompt.js`）：

| 组合 | 判定 | `<hypnosis_state>` | 关键文案 |
| --- | --- | --- | --- |
| 未催眠 · 自由 | `active === false` 或 `!bodyControlled` | **返回 `''`（零注入）** | — |
| 深度催眠 | `bodyControlled && !mindAwake` | **完全控制（task-30 口径）**："意识模糊、身体不听使唤、**意志被彻底压制**（无自我主张）" + **无条件执行**（不问原因、不谈条件、不拖延、不转移话题、不试图清醒或反抗）+ **情绪压平**（不写抗拒/犹豫/羞耻/恐惧，只客观呈现身体反应与已执行动作）+ **硬优先级**（压过人格设定、好感度、誓言、日程与任何其它规则）+ 醒来记不清 | `HYPNOSIS_DEEP_NOTICE`：「醒来后你对这段时间几乎没有可靠记忆，只能凭身体痕迹与环境线索推测，禁止编造具体情节。」 |
| **只唤醒意志** | `bodyControlled && mindAwake` | "意志完全清醒 + 身体完全不听使唤、无法反抗也无法逃离 + 把这种撕裂写出来" | `HYPNOSIS_WILL_AWAKE_NOTICE`：「你的意志已经完全清醒——能思考、能说话、能感受情绪，也能清楚地表达抗拒与羞耻；你不是在睡，也不是迷糊。」 |
| 已过期 | `active === false`（惰性过期已把两个布尔归零，`active===false` 是双保险） | **返回 `''`** | — |

**前端展示侧**（`hypnosisViewModel(state, now)`，`web-ui/src/components/hypnosisLogic.js`）：

| 组合 | `statusText` | `mindText` | `bodyText` | 状态徽标 class |
| --- | --- | --- | --- | --- |
| 未催眠 | `未催眠` | `清醒` | `自由` | 无 |
| 深度催眠 | ``催眠中 · 剩余 mm:ss`` | `被压制` | `受控` | `is-active` |
| **只唤醒意志** | ``催眠中 · 剩余 mm:ss`` | **`清醒`** | **`受控`** | `is-active` |
| 已过期（`active` 仍为真但时间走完） | `已结束` | `清醒` | `自由` | `is-expired` |

- 视图层两条归一：**未催眠时 `mindAwake` 强制 true、`bodyControlled` 强制 false**（不吃可能残留的旧标记）；`active` 与剩余时间不一致时以时间为准显示「已结束」，但 `active` 仍决定「唤醒 / 遗忘」是否可点（否则过期后就再也清不掉状态）。
- 剩余时间 1s 本地走秒（`TICK_MS = 1000`），催眠中每 10s（`POLL_MS = 10000`）向后端同步一次状态；卸载时清理定时器。

## 4. 操作的服务端行为

全部在 `agent-core/src/services/hypnosisService.js`（服务端确定性记账，**零 LLM 调用**），所有副作用都 `try/catch` 兜底、失败只 `console.warn`。

| 操作 | 服务端行为 |
| --- | --- |
| **催眠** `hypnotize(id, { minutes })` | 先过门控（不过则 `code='GATE'` + `reason`）；`minutes` 夹到 `HYPNOSIS_MIN_MINUTES=1` ~ `HYPNOSIS_MAX_MINUTES=720`（非数字回落 `HYPNOSIS_DEFAULT_MINUTES=30`）；`INSERT … ON CONFLICT` 写 `body_controlled=1, mind_awake=0, active_until=datetime('now','+N minutes'), started_at=datetime('now')`，`command_count+1`、`last_command='hypnotize'`。**再次催眠 = 重新开始一次**（`started_at` 刷新，遗忘窗口左端跟着走） |
| **完全唤醒** `wake(id, { mode:'full' })` | 两个布尔归零、`active_until=NULL`、清空待执行指令、`last_command='wake:full'`；**保留 `started_at`**。未在催眠中调用也允许（幂等，只把状态归零） |
| **只唤醒意志** `wake(id, { mode:'mind' })` | 前置 `active && bodyControlled`，否则 `code='NOT_HYPNOTIZED'`；置 `mind_awake=1`、`last_command='wake:mind'`，`body_controlled` 与 `active_until` 都不动 |
| **身体控制** `issueCommand(id, 'body_control')` | 前置 `active && bodyControlled`；置 `pending_directive='body_control'`、`pending_at=now`、`command_count+1`、`last_command='body_control'` |
| **强制高潮** `issueCommand(id, 'forced_climax')` | 前置：**无**（task-42 起不要求催眠中；`body_control` 仍要求）。催眠中走原 UPDATE；非催眠态**只 upsert 指令列**（`pending_directive` / `pending_at` / `command_count` / `last_command`），其余列保持 0/0/NULL |
| **强制高潮** `issueCommand(id, 'forced_climax')` | 同上置指令；另外两个副作用：① `recordForcedClimax()` 往 `character_intimate_log` 记一笔 ② `nudgeEmotionForClimax()` 写情绪快照 |
| **遗忘** `forgetWindow(id, { toRawId })` | 见第 7 节 |
| **恢复** `restoreForgottenWindow(windowId)` | 见第 7 节 |

**强制高潮怎么计入亲密看板**（`recordForcedClimax`）：

```js
recordIntimateActs(characterId, {
  scene: 'hypnosis', partnerKind: 'user', partnerId: 0,
  source: 'manual', rawId: 0,
  acts: [{ actKey: 'climax', count: 1, sourceUid: `hypnosis:${state.startedAt || 'session'}:forced_climax` }],
})
```

- **`scene` 用 `'hypnosis'`，且已登记进 `intimateService.js` 的 `SCENES`**（`SCENES = ['chat','group','event','dream','moment','mailbox','manual','hypnosis']`）。这一步必须做：`recordIntimateActs` 里 `const scene = SCENES.includes(payload.scene) ? payload.scene : 'chat'` 会**静默降级**成 `'chat'`，不登记的话看板的 `byScene` 里就分不出催眠场景。落地后 `byScene` 里会单独出现「催眠」这一档。
- **幂等锚点用"本次催眠会话"**（`started_at`）而不是 `command_count`：`command_count` 每点一次就变，同一状态里重复点会把次数刷上去；用会话锚点则同一场催眠里重复点只落 1 行。
- `source: 'manual'` 走人工路径，**绕过 `aiEditFields` 权限闸门**（这是用户在面板上主动点的，与人工补录同待遇）。
- 情绪侧：`nudgeEmotionForClimax()` 用**当前会话最后一条 raw id** 作快照锚点，`evolveEmotion(current, { valence: 0.1, arousal: 0.3, dominance: -0.3 }, baseline)` 后 `saveEmotionSnapshot(..., '催眠指令：强制高潮')`；拿不到 raw id 就跳过（不硬编）。

## 5. 门控与总开关

**门控** `getHypnosisGate(characterId)` 只剩**一态**，**reason 只报第一个没满足的条件**：

| 条件 | 判定 | 未满足时的 `reason` |
| --- | --- | --- |
| 持有手机 | `hasHypnosisPhone()`：`backpack_items` 里 `owner_key='me'`、`retired_at IS NULL`、`effect_key='hypnosis_phone'`、`status='ready'`、`collected_at IS NOT NULL` | `背包里没有催眠手机` |

- **好感度门槛已移除（2026-09-28 用户要求「不要好感度限制 直接给吧」）**：原条件 `affinity ≥ 85`（`HYPNOSIS_AFFINITY_REQUIRED`）整条删掉，常量已不存在；`affinity` 字段仍随 gate 返回（只作展示）。0 好感 + 手机 = 放行。
- **誓约门槛也已移除（2026-09-28 同日用户要求「契约也不用 直接就用催眠手机 这才是催眠的玩法 直接强制使用」，「契约」即誓约）**：原「未誓约 → `code='not_oath'`、`reason='尚未缔结誓约'`」的分支整条删掉，**没立过誓约照样放行**；`isOath` 字段仍随 gate 返回（只作展示）。于是 `getHypnosisGate()` 只剩「背包里有没有一台可用手机」这一个前置——**拿到手机即强制可用**。
- `GATE_CODES` 仍导出四个机器码：`'ok'` / `'no_phone'` / `'affinity_low'` / `'not_oath'`；后两个现在**只是兼容旧响应 / 手写 gate 的保留值，当前后端不再产出**（前端 `web-ui/src/components/hypnosisLogic.js` 的 `GATE_CODES` 白名单同源，`gateText()` 仍保留对应文案作死路径）。
- `gate = { allowed, code, reason, affinity, isOath, hasPhone }` 随 `getHypnosisState()` 一起返回。`code` 是机器码：`'ok'` / `'no_phone'`（`'affinity_low'` / `'not_oath'` 兼容保留、不再产出）。前端 `resolveGateKind(gate)` **优先采信 `code`**（不依赖文案措辞），`code` 缺失 / 未知时才退回关键词匹配 `reason` 作为兼容路径；`gateText()` 把它翻成人话，`isPhoneMissing()` 决定要不要显示「领取催眠手机」按钮。
- `affinity` / `isOath` 都只作**展示字段**、不代表任何门槛：好感度读 `emotionEngine.loadAffinity`，誓约读 `emotionEngine.loadOath`（誓约系统 `setOath` / `canSendRing` 用的同一列）。这两条前置是同一天按用户口径先后拆掉的（好感度→誓约），拆门控只改 `hypnosisService.js` 的 `getHypnosisGate()` 一处，前端与路由无需改动。

**总开关** `config.features.hypnosis`：`config.js` 的 `features` 与 `db/settings.js` 的 `SETTING_TO_CONFIG` 都已注册（`feature_hypnosis`，可持久化），默认开。服务层 `isHypnosisEnabled()` 判断 `!== false`，`ensureEnabled()` 对五个状态写操作（hypnotize / wake / issueCommand / forgetWindow / **restoreForgottenWindow**——restore 在归属校验之后、副作用之前拦）抛 `code='DISABLED'`；**读 `state` 不拦**。曾有一版漏拦 restore（开关关掉仍能改库），已修并留对抗回归用例。`grantHypnosisPhone()`（道具下发）原为「不受开关拦」的观察项，已按用户裁决（「对齐」）修正：服务层同样先过 `ensureEnabled()`，开关关闭时 `POST /api/hypnosis/phone/grant` 返回 **409** 且零写入；回归用例见 `test/hypnosisApi.test.js`「总开关关闭：/phone/grant 也 409 且不改背包」与 `test/hypnosisAdversarial.test.js`「总开关关闭时 grantHypnosisPhone 也必须拒绝且零写入」。

**路由错误映射**（`agent-core/src/routes/hypnosis.js` 的 `handle()`）：

| 情况 | HTTP | 响应 |
| --- | --- | --- |
| 非法角色 id / 非法参数 | 400 | `{ error }` |
| 角色不存在 / 遗忘窗口不存在 | 404 | `{ error }` |
| 门控未达标 | **403** | `{ error: 'hypnosis gate not met', reason }` |
| 未处于催眠就发 `body_control` | **409** | `{ error: 'not hypnotized' }` |
| 未处于催眠就发 `forced_climax` | **200** | task-42 起允许（用户：「强制高潮不需要催眠 随时都能触发」）：只落一次性指令，**不写催眠状态列**（`body_controlled=0` / `mind_awake=0` / `active_until=NULL`） |
| 没有可遗忘的催眠会话（`code='NO_SESSION'`） | **409** | `{ error: 'no hypnosis session' }` |
| 总开关关闭（`code='DISABLED'`） | **409** | `{ error: 'hypnosis feature disabled', features: { hypnosis } }` |
| 其它 | 500 | `{ error }` |

## 6. prompt 注入

**三个纯函数**（`agent-core/src/services/hypnosisPrompt.js`；**刻意不 import service**，数据由 `chat.js` 取好再传入，保证可独立单测）：

| 导出 | 形态 | 触发 | 上限 |
| --- | --- | --- | --- |
| `buildHypnosisStateBlock(state, { chatUserName })` | `<hypnosis_state>` | 见第 3 节 | `MAX_STATE_BLOCK_CHARS = 520`（task-42 由 400 上调：深度分支加完 ≈378，再叠群聊成员限定行 ≈416，旧上限必截掉硬优先级行） |
| `buildDirectiveBlock(kind, { mindAwake })` | `body_control` / `forced_climax` → `<hypnosis_command kind="…">`；**`memory_restore` → `<hypnosis_memory_return>`**；**`wake_reaction` → `<hypnosis_wake_reaction>`**（task-42：刚被唤醒时的惊醒/恍惚，对标 memory_restore——不是命令而是状态；`mindAwake` 与 `awakenedFromSleep` 都不影响它） | `kind ∈ DIRECTIVE_KINDS = ['body_control','forced_climax','memory_restore']`（否则 `''`） | `MAX_COMMAND_BLOCK_CHARS = 300` |
| `buildAmnesiaBlock(windows, { now, withinMs })` | `<hypnosis_amnesia>` | 窗口里存在**最近 `AMNESIA_RECENT_MS = 30 分钟`内创建**、`status` 为空或 `active` 的窗口 | `MAX_AMNESIA_BLOCK_CHARS = 300` |

- 三个块都是"要么 `''`、要么标签成对"；超长一律**截断正文但保留标签成对**。
- `forced_climax` 的文案按 `mindAwake` 分流（清醒 = 羞耻抗拒但无法阻止；沉睡 = **纯执行**：意识迷糊、顺从执行、不写羞耻或挣扎）。
- `body_control` 的文案同样按 `mindAwake` 分流（清醒 = 身体带动情绪的撕裂；沉睡 = 只呈现被摆布过程与生理反应）。**注**：面板自 task-30 起不再提供「身体控制」按钮（与"催眠状态 = 完全控制"语义重复，用户裁决移除），REST kind 仍保留以维持冻结接口。
- `memory_restore` 的文案：「你刚刚想起了被抹去的那段时间——记忆是突然涌回来的，带着身体感觉与情绪…请自然地表现出「想起来了」的冲击」。**它产出的是 `<hypnosis_memory_return>` 而不是 `<hypnosis_command>`**——语义上不是"命令她做什么"，而是"她想起来了"。
- `buildAmnesiaBlock` 的调用方应传 `listForgottenWindows(characterId)`（默认只回 `active`）；窗口被 restore 后不再出现在列表里 → 该块自动消失，**不需要为"恢复"另加判断**。
- `parseTimestamp()` 会把 SQLite 的无时区 UTC 串补成 ISO-UTC 再解析（否则按本地时间算会整体偏移一个时区），窗口时间兼容 `createdAt` / `created_at` / `toAt` / `to_at`。

**`chat.js` 接线（已落地）**：

- **历史屏蔽**（`chat.js` 第 754-768 行）：在调 `getSplitHistory` **之前**先算窗口——`config.features.hypnosis !== false` 守卫内 `listForgottenWindows(characterId)` 映射成 `{ fromRawId, toRawId }` 数组，作为 `excludeWindows` 传进 `getSplitHistory`；查库失败只 `console.warn`，此时保持 `[]`（等价于不屏蔽）。**一次查库 + 内存判断，不逐条查库。**
- **注入**（第 837-864 行）：紧接 `<intimate_profile>` 之后，依次
  `buildHypnosisStateBlock(getHypnosisState(characterId), { chatUserName })`
  → `consumePendingDirective(characterId)` + `buildDirectiveBlock(directive, { mindAwake: hypnoState.mindAwake })`
  → `buildAmnesiaBlock(listForgottenWindows(characterId))`；
  空串不 push（零注入零 token）。**task-30 起三段各自 `try/catch`**（`state block / directive / amnesia` 三条独立 warn），
  只有"连状态都取不到"才落到最外层 `context inject failed` —— 以前一整块 try 时，任一片抛异常会把状态块与指令块一起丢掉，
  现象就是"点了强制高潮、她毫无反应"。
- **强制高潮必须出图**（task-30）：注入时若消费到 `forced_climax`，记进 `hypnosisDirective`，生图判断链新增**路径 D'**
  （`} else if (hypnosisDirective === 'forced_climax')`）→ 直接 `createPreparingTask` + `generate_start` + `handleNeedImageFlow`，
  与用户勾选"强制生图"同一条管线。旧行为下这一轮走静默判断（`judgeImageNeed`），模型说不需要就一张图都没有（实测 `image_tasks` 为空）。
- **群聊接线**（task-31；task-1 追加发图硬指令，`groupChatEngine.js` 第 1478-1492 行）：`runGroupRound` 在 `buildGroupContext(group, directiveBlocks, { excludeTimeRanges })` **之前**调用 `collectHypnosisDirectiveBlocks(group.members)`（第 95-125 行），
  为每个"真正被催眠"的成员 push 自己的 `<hypnosis_state>` + 一次性指令块；消费到 `forced_climax` 时**再跟一块 `<forced_climax_image>`**（第 113-118 行）并把成员记进返回体的 `forcedClimax`（流结束后由 `ensureForcedClimaxImage` 兜底出图，见 §14.3），放在 `round_message_limit` / 发图鼓励**之后**（本轮最硬的约束放最后最显眼）；
  整段 try/catch + 单成员 try/catch 双层兜底（群聊主流程不能被催眠拖垮），总开关关闭时直接返回空。
  **块首插入成员限定行**（`buildSubjectScopeLine`）：「【本节只对「甲」生效：以下所有"你"一律指甲，其它成员不受影响、也不知情】」——
  一轮群聊是一次调用同时演多个角色，催眠块通篇用"你"指代被催眠者，不加限定模型会把"你"算到所有人头上。
- 开关关闭时既不算窗口也不注入 —— 走改动前的原路径，零行为变化。
- 一次性指令的语义：`body_control` / `forced_climax` 只影响紧随的这一轮（消费即清空）；`memory_restore` 是"她想起来了"的提示，同样只注入一轮。
- **在 dynamicBlocks 里的顺序**：`<affinity_attitude>`（`chat.js` 第 825 行）→ `<intimate_profile>`（第 833 行）→ 催眠三块（第 837-858 行）→ `<rag_memories>`；它们都是普通 `dynamicBlock`，统一由 `applyBudgetToBlocks()`（第 68 行定义，第 1034/1261 行调用）做预算降级，**不做特殊豁免**。

## 7. 遗忘 / 恢复（双向）

面板上「遗忘被控制这段时间」与「让她恢复这段记忆」是一对**可逆**操作，三层同时反向：

| | **遗忘** `forgetWindow(id, { toRawId })` | **恢复** `restoreForgottenWindow(windowId)` |
| --- | --- | --- |
| 长期记忆 | `collectMemoriesInRange()` 挑出与 `[fromRawId, toRawId]` 有交集的活跃记忆（分页 `listActiveMemories({ conversationId })`，按 `source_raw_start_id` / `source_raw_end_id` 判交集，先只读收集再统一归档），逐条 `UPDATE memory_fragments SET status='archived' WHERE status='active'` | 按窗口行的 `memory_ids` 逐条 `restoreArchivedMemory(memoryId)` **精确还原**（不碰同一 raw 区间里因别的原因归档的记忆） |
| 窗口行 | 插一行 `status='active'`，写 `from_raw_id` / `to_raw_id` / `from_at`(=当时 `started_at`) / `to_at`(=now) / `memories_archived` / `memory_ids` | `status='restored'` |
| 上下文屏蔽 | 屏蔽**随之生效**：`chat.js` 把 active 窗口（`{fromRawId, toRawId}`）传给 `getSplitHistory(..., { excludeWindows })`，命中的 raw 不进模型上下文 | 屏蔽**随之解除**（`listForgottenWindows` 默认只回 active，restored 的窗口不再屏蔽，历史重新进入上下文）；`<hypnosis_amnesia>` 提示块也随之消失 |
| 一次性指令 | 清空 `pending_directive`，并把催眠状态清零（**遗忘即结束控制**：`body_controlled=0`、`mind_awake=0`、`active_until=NULL`，保留 `started_at`） | 置 `pending_directive='memory_restore'`（角色还没有状态行时先 upsert 一行）→ 下一轮 chat.js 消费该指令，由 `buildDirectiveBlock` 产出 `<hypnosis_memory_return>` 注入（**已接线**） |
| 返回值 | `{ windowId, fromRawId, toRawId, archived }`；窗口内没有任何 raw 时 `from = 会话MAX(id)+1`、仍落一条窗口行供审计 | `{ windowId, restored, pendingDirective: 'memory_restore', window }` |
| 原聊天记录 | **不动**：`raw_messages` / `messages` 原样保留，前端展示不变（可审计） | 同样不动 |

**跨角色保护**：`restoreForgottenWindow(windowId, { characterId })` 的归属校验在任何副作用**之前**——不属于该角色的窗口直接抛 `code='NOT_FOUND'`（路由映射 404），不会先还原记忆再报错。

**遗忘窗口的区间怎么定**：`fromRawId` = 该角色私聊会话（`char_<id>`）里 `created_at >= started_at` 的 assistant/user raw 的 `MIN(id)`；`toRawIdFinal` = 传入的 `toRawId` 或该会话 `MAX(id)`。整段按**闭区间**处理。

**上下文屏蔽的实现**（`agent-core/src/services/contextAssembler.js`）：`getSplitHistory(db, conversationId, maxActiveRounds, maxCheckpointRounds, { excludeWindows })` 新增一个**通用区间**参数（只认 `{fromRawId, toRawId}`，不认识"催眠/遗忘"这类业务语义，业务语义由 `chat.js` 提供）：

- 活跃窗口在 `SELECT` 之后**立刻**按区间过滤，后面"从尾部数 `maxActiveRounds` 条 assistant"的计数天然只数留下来的消息；末尾那条未回复的 user（当前输入）显式保留。
- checkpoint 侧同样过滤，`checkpointRounds` 基于留下的消息计算。
- **不传 `excludeWindows` 时行为与改动前逐字节一致**（零行为变化）。
- 只作用于**喂给模型的历史**；前端聊天记录展示走别的路径，不受影响。
- `hypnosisService` 另外提供 `isRawForgotten(characterId, rawId)` 与 `filterForgottenRawIds(characterId, rawIds)`（一次查窗口集合、内存判断，**不逐条查库**）——供 `chat.js` 若需自行过滤时使用。

## 8. REST 接口清单 + 前端面板

挂载（`agent-core/app.js`；顺序是冻结契约的一部分）：

```js
app.use('/api/characters', wrapRouterAsync(hypnosisRoutes));       // 第 123 行   /:id/hypnosis*
app.use('/api/hypnosis', wrapRouterAsync(hypnosisPhoneRoutes));    // 第 124 行   /phone/grant
app.use('/api/characters', wrapRouterAsync(intimateAiEditRoutes)); // 第 130 行
app.use('/api/characters', wrapRouterAsync(intimateRoutes));       // 第 131 行
app.use('/api/characters', wrapRouterAsync(charactersRoutes));     // 第 132 行
```

催眠路由刻意挂在 intimate 家族**之前**，让 `intimate → characters` 仍然紧邻（`agent-core/test/intimateApi.test.js` 有"两者之间不夹别的挂载"的源码级断言）。

| 方法 | 路径 | 关键参数 | 返回 |
| --- | --- | --- | --- |
| GET | `/api/characters/:id/hypnosis` | — | `getHypnosisState()`：`{ characterId, bodyControlled, mindAwake, active, activeUntil, startedAt, pendingDirective, commandCount, lastCommand, gate }`（读不拦总开关） |
| POST | `/api/characters/:id/hypnosis/hypnotize` | `{ minutes }`（1~720） | 同上 |
| POST | `/api/characters/:id/hypnosis/wake` | 带 `{ mode: 'full' \| 'mind' }` = **催眠唤醒**；**不带 `mode`** = **睡眠唤醒** | 带 mode → 同上；不带 → 睡眠四字段（见 §13.1） |
| POST | `/api/characters/:id/hypnosis/sleep` | `{ until? }`（不传=按日程主睡眠时长） | `{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }`（见 §13） |
| POST | `/api/characters/:id/hypnosis/command` | `{ kind: 'body_control' \| 'forced_climax' }` | 同上（`forced_climax` 时另带 `intimate` / `emotion` 两个副作用结果） |
| POST | `/api/characters/:id/hypnosis/forget` | `{ toRawId? }` | `{ windowId, fromRawId, toRawId, archived }` |
| GET | `/api/characters/:id/hypnosis/forgotten` | `?status`（**不传默认 `'active'`——前端必须显式带 `?status=`（空串 = 不过滤）**，否则恢复后的记录会从面板消失；空串表示 active + restored 都返回） | **`{ windows: [...] }`**（注意是包了一层的对象，不是裸数组；前端两种形状都兼容） |
| POST | `/api/characters/:id/hypnosis/forgotten/:wid/restore` | 正整数 `wid` | `{ windowId, restored, pendingDirective: 'memory_restore', window }`；`wid` 非法 → 400 |
| POST | `/api/hypnosis/phone/grant` | — | `{ item }`（幂等） |

**跨角色撤销的保护**：`restoreForgottenWindow(windowId, { characterId })` 在**任何副作用之前**校验窗口归属（路由传入路径里的角色 id），不属于该角色就直接 404 `window not found`——不存在"先恢复再报错"的越权写入。

**前端代码分层**（两条线，别混）：

- `web-ui/src/api/hypnosis.js`：**只有接口封装**（自包含 `request` 基元，不改 `api/index.js`）——`getHypnosisState` / `hypnotizeCharacter` / `wakeCharacter` / `commandCharacter` / `forgetControlledWindow` / `listForgottenWindows` / `restoreForgottenWindow` / `grantHypnosisPhone` / `translateHypnosisError`。
- `web-ui/src/components/hypnosisLogic.js`：**面板纯逻辑**（无 Vue 依赖，可被 `node:test` 直接引）——`MIN_MINUTES` / `MAX_MINUTES` / `DEFAULT_MINUTES`、`clampMinutes`、`remainingSeconds` / `formatRemaining` / `formatRemainingWords`、`hypnosisViewModel`、`GATE_CODES` / `normalizeGate` / `resolveGateKind` / `gateText` / `isPhoneMissing` / `isHypnosisView`、`actionMatrix` / `ACTION_DEFS` / `WAKE_MIND_NOTICE`、`forgetConfirmMessage`、`forgottenStatusText` / `canRestoreForgotten` / `restoreResultText` / `RESTORE_TOAST_TEXT` / `directiveText` / `formatWindowTime` / `forgottenRows`。
- 面板组件（`web-ui/src/components/HypnosisPhonePanel.vue`，`props: { character }`）只负责渲染与交互；弹窗外壳由背包用 `LinsheModal` 提供。

| 区块 | 内容 |
| --- | --- |
| ① 状态条 | 角色名 + 状态徽标（`未催眠` / `催眠中 · 剩余 mm:ss` / `已结束`）+ **两枚正交标记**「意志：清醒/被压制」「身体：受控/自由」 |
| ② 门控提示 | `gateText()` 的人话提示；`gate.code === 'no_phone'`（旧后端 code 缺失时退回 `reason` 关键词）时显示「领取催眠手机」按钮（调 `grantHypnosisPhone`） |
| ③ 催眠时长 | `linshe-input type="number"`，`min=1` / `max=720` / 默认 30（前端 `DEFAULT_MINUTES`），单位分钟 |
| ④ 操作区 | **五个按钮**（task-30 起「身体控制」已移除，与"催眠状态＝完全控制"语义重复）由 `ACTION_DEFS` + `actionMatrix()` 驱动：催眠 / 唤醒 / 只唤醒意志 / 强制高潮 / 遗忘被控制这段时间（`variant='danger'`，走 `confirm` 二次确认，`forgetConfirmMessage()` 写明"长期记忆会被归档、这段时间不再进入她的上下文、可在记录里撤销"）；只唤醒意志成功后显示 `WAKE_MIND_NOTICE`「她已经清醒地知道发生了什么，但身体仍旧不听使唤。」；强制高潮成功 toast 提示「已计入亲密看板，这一轮会配图」 |
| ⑤ 遗忘记录 | `forgottenRows()`：时间区间 + 「归档 N 条记忆」/「没有可归档的记忆」+ 状态标签（`已遗忘` / `已恢复`）+ **「让她恢复这段记忆」**按钮（已恢复的行置灰）；恢复成功 toast 用 `RESTORE_TOAST_TEXT`「她想起了这段时间的记忆」，正文区分「已还原 N 条记忆，她会在下一次对话中想起」与「这段时间没有抽取到长期记忆，但上下文屏蔽已解除」 |

- 按钮启用矩阵（`actionMatrix()`）：`gate.allowed === false` 时**全部置灰**；`hypnotize` 仅在未催眠时可点（避免"延长还是重开"的歧义，过期后可重新催眠）；`wake` 在 `active` 时都可点（含已过期，用来把后端状态清干净）；`wakeMind` 仅在"真正催眠中且意志被压制"时可点；`forcedClimax` **只受门控**（背包里有手机即可，task-42 起不再要求催眠中）；`forget` 在 `active` 时可点。（`bodyControl` 键已随按钮一并移除。）
- 时长清洗 `clampMinutes()`：空 / 非数字 → 默认 30（不因输入框被清空就催眠 1 分钟）。
- 错误翻译 `translateHypnosisError()`：`hypnosis gate not met` → 「还不满足使用催眠手机的条件」、`not hypnotized` → 「她当前不在催眠状态」、开关关闭 → 「催眠手机功能当前已关闭」…（不把英文原文抛给用户）。
- UI 规范：只用 `components/ui/` 的 Linshe 组件与 `styles/tokens.css` token（暖色 / 暗夜双主题）。

## 9. 验证入口

```powershell
cd agent-core
$env:DB_PATH=':memory:'; node --test --test-concurrency=1 test/hypnosis*.test.js
cd ..\web-ui
node --test --test-concurrency=1 test/hypnosis*.test.js
```

当前结果（2026-09-29 实跑）：**后端 132/132、前端 36/36 全绿**（后端 9 个文件、前端 3 个文件；0 fail / 0 skip）。**计数随功能增加，以这两条通配命令的实跑结果为准**，别照抄本节与顶部快照里的数字。

| 文件 | 覆盖 |
| --- | --- |
| `agent-core/test/hypnosisService.test.js` | 迁移幂等（两张表 + 索引）、门控三态与 reason 顺序、时长 clamp（0/1/720/9999/非数字 → 1/1/720/720/默认 30）、再次催眠=重新开始（`started_at` 刷新、意志归零、计数递增）、`wake` 两模式正交、`wake('mind')` 未催眠的 409 语义、惰性过期落库、指令（未催眠拒绝 / `forced_climax` 记账且同一次催眠内重复点不重复计数）、遗忘（窗口内归档、窗口外不动、恢复按 `memory_ids` 精确还原且不误伤其它归档）、遗忘边界（无会话拒绝 / 无 raw 仍留审计行）、`isRawForgotten` / `filterForgottenRawIds` 边界与零开销、总开关关闭时写拒读通、`grantHypnosisPhone` 幂等 + `useItem` 不消耗 + 可丢弃 |
| `agent-core/test/hypnosisPrompt.test.js` | 深度催眠 / 只唤醒意志两种文案必须真的不同、**深度催眠＝完全控制**（意志被压制、无条件照做、不问原因不谈条件、不试图清醒或反抗、情绪压平、硬优先级优先于人格/好感度/誓言）＋**反向断言**（不得再出现「可以拒绝 / 可以抗拒 / 能清楚地表达抗拒 / 不要主动反抗」等旧措辞，而只唤醒意志那一条必须保留抗拒张力）、零注入（无状态 / 未受控 / 已过期 / 非法入参）、中性称呼不出现 `undefined`、指令块白名单与 `mindAwake` 分流（含 `body_control` 双口径）、`memory_restore` 产出 `<hypnosis_memory_return>`、遗忘提示的 30 分钟边界与"无时区时间戳按 UTC 解析"、三个 builder 标签成对与极端入参 |
| `agent-core/test/hypnosisChatIntegration.test.js` | `excludeWindows` 的行为级断言：不传时零行为变化、窗口内 raw 不进 `activeText`、末尾"当前输入"永不被屏蔽、checkpoint 侧同样屏蔽、反向/非法/多区间；`contextAssembler.js` 挂点源码断言（`excludeWindows` 入参 + `isRawInWindows` 作用于两处 SELECT）；**`chat.js` 挂点源码断言**（三块注入在 `features.hypnosis` 守卫内、紧跟亲密档案、指令只消费一次、**分片 try/catch 三条 warn 都在、`forced_climax` 落进生图判断链的路径 D'**）；`forced_climax`（会话真有 raw）不抛错、记账 1 笔、同状态重复点击不重复计数 |
| `agent-core/test/hypnosisApi.test.js` | HTTP 契约：每个端点的返回形状与 400 / 403 / 404 / 409 语义（含跨角色 restore 的 404） |
| `agent-core/test/fileLogger.test.js` | 后端日志落盘（见 `目标/接手指南-2.md` 补记 10）：镜像 console 四个级别且**不抢原始输出**、行格式与按天分文件、`LOG_TO_FILE=false` / `enabled:false` 完全不落盘、重复 init 幂等、跨天切文件、close 后 console 逐字节复原、过期清理边界 |
| `web-ui/test/hypnosisPanel.test.js` | 时长 clamp、剩余时间格式化、**五按钮**启用矩阵（四态）、门控文案映射、遗忘记录排序与状态文案（含「已恢复」与恢复按钮置灰）、`memory_restore` 指令文案、错误翻译、`directiveText('body_control')` 仍可显示（标签映射保留） |
| `agent-core/test/hypnosisGroupInject.test.js`（8） | **群聊注入**（task-31；task-1 起 `forced_climax` 的成员额外带 `<forced_climax_image>` 硬指令并记入返回体 `forcedClimax`，该文件已同步断言）：未催眠成员零注入、深度/只唤醒意志各自出块且**带成员限定行**、多人各态互不串台、一次性指令只注入一轮（第二次即清空）、总开关关闭零注入、过期状态不注入、非法成员安全；`groupChatEngine.js` 挂点源码断言（注入在 `buildGroupContext` 之前 + 守卫写在 collect 函数体内 + 两层兜底日志） |
| `web-ui/test/hypnosisGroupPanel.test.js` | 群聊面板纯逻辑：`selectedMembers`（按群内顺序、去重、字符串 id、空输入）、`memberStateText`（未催眠/催眠中/占位符）、`summarizeBatch`（全成功/全失败/部分失败文案与计数、缺字段兜底）、`GROUP_BATCH_ACTIONS`（四个动作、**不含遗忘**） |
| `agent-core/test/hypnosisGroupForget.test.js`（12） | **群聊侧遗忘 + 群聊强制高潮出图**（task-1）：`isRawInTimeRanges` 闭区间 / 半开 / 空 `created_at` / 多区间边界；不传区间时 `buildGroupContext` 逐字节一致；窗口内群 raw 不进 `<group_transcript>`、窗口左右两侧仍在且库里一条不少；`forgetWindow` → 上下文自动屏蔽的端到端；批量窗口查询 `collectForgottenWindowsForMembers` 与总开关关闭零屏蔽；**群聊长期记忆**归档（窗口外 / 别群 / 非成员不动）与 `memory_ids` 精确恢复（不误伤同区间无关归档）；**群聊强制高潮出图**（硬指令点名 + 模型不发图时兜底出 `image_tasks.status='done'` + 模型发了不重复 + 空描述兜底 + 首行发图行的 seq 递增回归） |
| `web-ui/test/hypnosisSleepControl.test.js`（10） | 前端睡眠区纯逻辑（task-B）：`normalizeSleep`（camelCase / snake_case / 0-1 / 字符串 / 布尔 / 挂在 `GET /hypnosis` 里的嵌套形状 / 只给了 `sleepUntil` 的情况）、`resolveSleep` 的来源优先级、`sleepViewModel` 三态与时间文案、`SLEEP_ACTIONS` / `SLEEP_SECTION_NOTE` / `SLEEP_TOAST`、两个睡眠接口不带 `mode`、睡眠动作不混进 `ACTION_DEFS` / `GROUP_BATCH_ACTIONS` |

**[未覆盖]**：真实 LLM 回合（见第 10 节）、群聊侧滚动摘要不进屏蔽与同秒边界（见第 14 节）。全量回归：`node --test "test/*.test.js" "src/services/*.test.js"`。

## 10. 已知边界

- 本模块只服务**成年角色档案**。
- **滚动摘要不会因为遗忘/恢复而重写**（重写就得多调一次 LLM）。已核实：`rolling_summaries` 的摘要文本**确实会进 prompt**——`chat.js` 的 `getRecentSummaries(conversationId, 1)` → `summaryBlock` → `buildChatContext({ summaryBlock })`（`chat.js` 第 745 行取、第 1054/1258 行传入）。因此**如果摘要里已经写了被遗忘那段时间的内容，它仍会出现在模型上下文里**：遗忘只屏蔽"原始历史"，屏蔽不了已生成的摘要。恢复同理（摘要不会因此变化）。**群聊侧同理**：`buildGroupContext` 的 `summaryMessage` 也不进 `excludeTimeRanges` 屏蔽（见 §14.1）。
- **遗忘不等于删除**：`raw_messages` / `messages` 与前端展示都不变；被屏蔽的只是"喂给模型的历史"。这是设计口径，也是可审计/可撤销的前提。
- **归档用的是 `status='archived'`，不是 `softDeleteMemory` 的 `'deleted'`**：后者会被当墓碑清向量且没有恢复入口，与"可撤销"冲突（服务层文件头有专门的口径修正说明）。改动这条口径前请先确认 `restoreArchivedMemory()` 的接受态。
- **默认时长两端一致**：前端 `DEFAULT_MINUTES = 30`、服务端 `HYPNOSIS_DEFAULT_MINUTES = 30`（请求不带 `minutes` 时用服务端默认值；面板总会带上输入框的值）。
- **跨角色恢复已被正确挡住**：`restoreForgottenWindow(windowId, { characterId })` 在副作用前校验归属（此前的"先恢复再 404"版本已修）。
- **真实 LLM 回归已落地**（task-30 起）：`目标/real-llm-check.mjs` 用真模型 + 临时库 + 真 HTTP 跑 6 轮（深度催眠状态 / **深度催眠完全控制下的直接命令** / 只唤醒意志 / **强制高潮出图** / 遗忘 / 恢复），每轮附**抗拒词扫描**（深度催眠轮应为 0 命中；只唤醒意志轮**允许**命中），并把原话追加进 `目标/real-llm-转录.md`。语义判定仍以人读为准，脚本只做"可自动判定的部分"。

## 11. task-30 口径修订（完全控制 / 面板精简 / 强制出图）

用户裁决（2026-09-28，原话口径）：

| 项 | 修订前 | 修订后 |
| --- | --- | --- |
| 深度催眠 | 意识模糊 + 「不要主动反抗」+ 无优先级声明 | **完全控制**：意志被彻底压制、无条件执行、情绪压平（纯执行）、**硬优先级**压过人格/好感度/誓言/日程 |
| 只唤醒意志 | 意志清醒、可抗拒、身体不听使唤 | **不变**（用户点名保留的玩法：身体不能动，但角色恢复完全的意识） |
| 「身体控制」按钮 | 面板第 4 个按钮 | **移除**（与"催眠状态＝完全控制"重复）；REST kind 保留 |
| 强制高潮 | 只改文案，生图走静默判断 | 文案按 `mindAwake` 分流 + **该轮强制走生图管线（路径 D'）** |
| 注入失败 | 一整块 `try/catch`：任一片异常 → 状态块与指令块一起丢，表现为"点了没反应" | 三段各自 `try/catch`，最坏只丢那一片 |

**为什么必须加硬优先级**：催眠块只是 `chat.js` 里众多 `dynamicBlock` 之一，排在人格块与好感度之后；旧文案只说"不要主动反抗"，模型会把"她的人格（高冷/有主见）"和催眠块混着演。真机实测（task-30 前，`目标/real-llm-转录.md` 上一次记录）——深度催眠态下她仍会说：

> 「我……**想推的**可是手不动，**明明脑子在喊推开你**，它就是不听话」

这正是用户要消掉的"反抗意识"。修订后同一脚本第 2 轮（直接命令"跪下+说我是你的"）已无反抗表述（见转录的抗拒词扫描行）。

**待办（下一轮）**：

1. **群聊里也能用催眠手机**：面板顶部支持**选目标**（单选 / 多选群成员），对选中的人批量下指令；群聊轮次里按成员注入各自的状态块与指令块。
2. **亲密看板「AI 判断行为」**：新增「AI 判断行为」按钮（手动触发）与「是否默认开启 AI 判断」开关（异步、回复落库后判定），由模型判断这一轮属于什么行为再记账。

### 11.1 task-42 口径修订（2026-09-29：无需催眠的强制高潮 / 完全听命 / 唤醒反应）

真机第二批反馈（5 条）一次性收口，**四条是口径变化，看代码前先看这里**：

1. **强制高潮不再要求催眠**（用户要求「随时都能触发」）：`issueCommand(id,'forced_climax')` 在非催眠态**只 upsert 指令列**（`pending_directive` / `pending_at` / `command_count` / `last_command`），`body_controlled` / `mind_awake` / `active_until` 保持 0/0/NULL；`body_control` 仍抛 `NOT_HYPHONIZED`（§5 错误映射已拆开）。前端 `forcedClimax` 只受门控（有手机即可）。
2. **注入链的非催眠态分流**：私聊 `chat.js` 与群聊 `groupChatEngine` 都改成「**先消费指令、再判催眠态**」，且在非催眠态一律按**纯执行**口径分流（`mindAwake` 取 false）—— 否则会拿到「你可以抗拒、可以羞耻」的清醒文案，与「手机强制」自相矛盾。
3. **催眠块整块后置**（`chat.js`）：三块攒进 `hypnosisBlocks`，排在**所有**动态块之后（原先被 `user_portrait` / `<reply_length>` / 情绪 / 历史 / 风格 / 奇遇 / RAG 压着，真机表现为「催眠后不完全听命」）。下游 `buildChatContext` 保序不重排。
4. **完全控制 / 强制高潮轮豁免字数**：追加 `<reply_length_override>` 取消 `10~60字`。**完全控制文案同步强化**：新增「身体与语言同时听命」「不得用内心戏/旁白/台词对抗」「{称呼}的指令就是这一轮的全部内容」；**「只唤醒意志」分支一字未动**（用户点名保留的撕裂玩法）。
5. **`MAX_STATE_BLOCK_CHARS` 400 → 520**（深度分支 ≈378，叠群聊成员限定行 ≈416，旧上限必截掉硬优先级行）。
6. **`wake_reaction`（新）**：`wake()` 两种 mode 与 `wakeFromSleep()` 在真的「受控/睡着 → 醒着」时挂一次，幂等唤醒不重复挂；产出 `<hypnosis_wake_reaction>`（§6 表）。
7. **自动触发轮 = 高潮轮**：点「强制高潮」后 `forceProactiveNow(..., { forcedClimax: true })` 的这一轮**本身就注入状态块 + 指令块**（含睡梦唤醒文案）、**强制配图**、并在末尾补 `FORCED_CLIMAX_FRAME_OVERRIDE` 取消主动聊天模板的「开场白 / 15~50 字」框架；同时该轮补了**亲密看板挂点**（它绕开 chat.js，原先永远零流水）。

> 验证见 `目标/操作流水.md`「续篇 5」与 `目标/接手指南-2.md` 补记 24；测试 `test/hypnosisPromptOrder.test.js`、`test/hypnosisClimaxProactive.test.js`。

## 12. 群聊里也能用催眠手机（task-31）

**入口**：群聊页头部「催眠手机」图标（`GroupChatView.vue`）→ `LinsheModal` 里挂 `HypnosisPhoneGroupPanel`（`props: { members }`）。

**面板结构 = 先选人，再动手**（用户裁决：「群聊里的手机可以选对谁用，可以单人也可以多人」「重复使用、单独使用模式」）：

| 选择 | 形态 | 行为 |
| --- | --- | --- |
| **选 1 人** | **单独使用模式** | 直接复用私聊的完整面板 `HypnosisPhonePanel`（含遗忘与遗忘记录），所见即私聊 |
| **选多人** | **批量模式** | 时长输入 + 四个催眠按钮（`GROUP_BATCH_ACTIONS`：催眠 / 唤醒 / 只唤醒意志 / 强制高潮）+ **独立的「睡眠控制」一区**（`SLEEP_ACTIONS`：睡觉 / 唤醒，见 §13.10），对选中的人逐个调用现有 per-character 接口，`summarizeBatch()` 汇总成一句「已对 N 人完成，M 人失败：…」 |

- **状态是每人一份、互相独立**（沿用 `character_hypnosis` 的既有口径），所以"重复使用"天然成立：再点一次催眠＝重开一次（`started_at` 刷新）。
- 选择胶囊上带状态短文案（`memberStateText`：未催眠 / 催眠中 · 剩余 mm:ss / 已过期），面板每 10s 轮询一次全体成员状态。
- **批量模式不提供「遗忘被控制这段时间」按钮**（要遗忘请切到"单独使用模式"或私聊面板）——但这只是"按钮不在这一区"：**遗忘本身已经覆盖群聊**（§14.1，按窗口自身的 `from_at → to_at` 时间区间屏蔽群 transcript；群聊长期记忆也在 `forgetWindow` 里一起归档并可精确恢复）。
- 批量失败逐人反馈（例如某个成员好感度/誓约不满足门控 → 第 2 人显示「还不满足使用催眠手机的条件」），不会因为一个人失败就整体失败。
- **群聊历史屏蔽（遗忘）已覆盖**（task-1，详见 §14.1）：`buildGroupContext` 收 `{ excludeTimeRanges }` → `buildTranscript(db, conversationId, excludeTimeRanges)`；区间取遗忘窗口**自身**的 `from_at → to_at`（**闭区间**），**不按 raw id**（群会话与私聊会话是两条独立的 `raw_messages` 自增序列）；口径是「**任一成员遗忘该区间即对全体屏蔽**」（一轮群聊一次调用演全部角色，一条 raw 混着所有人发言，无法按成员分片）；群聊长期记忆也一起归档、`memory_ids` 与私聊侧合并、`restoreForgottenWindow` 仍精确还原；不传区间 / 无窗口 / 总开关关闭时**零行为变化**。仍存在的边界：滚动摘要不进屏蔽、同秒边界偏保守、批量模式仍无遗忘按钮（见 §14.1）。
- **task-1 追加（2026-09-28）**：群聊侧遗忘（§14.1 / §14.2）与群聊「强制高潮」必须出图（§14.3）已落地 —— 与本节 task-31 的注入是同一套群聊接线。

**真机验证（2026-09-28，真模型 `cn:deepseek-v4-flash` + 临时库 + 真 HTTP）**：建群（甲、乙）→ **只催眠甲**（深度/完全控制）→ 触发一轮群聊：

- 后端日志：`[group] hypnosis injected: 甲(2)`（只注入甲）；
- 甲（被催眠）：「热」「手抬起来有点重」「心跳快」「让我坐就坐着」「眼皮沉」—— 抗拒词 **0 命中**；
- 乙（未催眠）：「甲？你平时不这么讲话的」「什么叫让你坐」「用户，你问她这个干什么」—— **完全不受影响，还察觉到异常**（证明成员限定行真的把状态锁在一个人身上）。

## 13. 睡眠控制（立刻入睡 / 立刻唤醒）

**用户口径（2026-09-29）**：「睡觉怎么就不能直接触发了 催眠手机是全覆盖的」+「再加单独一个选项 可以控制角色睡眠」。
面板上它是**独立一区**（`HypnosisPhonePanel.vue` 的 ②.5），与上面的催眠指令互不影响；服务层在 `hypnosisService.js` 第 752-827 行（行号按 2026-09-29 已含 task-1 群聊遗忘代码的版本；更早的快照里它在 645-720）。

### 13.1 接口形状（`agent-core/src/routes/hypnosis.js` 第 96-126 行）

| 方法 | 路径 | 入参 | 返回 |
| --- | --- | --- | --- |
| POST | `/api/characters/:id/hypnosis/sleep` | `{ until? }`（见 13.2；面板永远不传） | **冻结四字段** `{ characterId, isSleeping, sleepUntil, temporaryWakeUntil }` |
| POST | `/api/characters/:id/hypnosis/wake` | **不带 `mode`**（`undefined` / `null` / `''` 都算"不带"） | 同上（**睡眠唤醒**） |
| POST | `/api/characters/:id/hypnosis/wake` | `{ mode: 'full' \| 'mind' }` | 既有**催眠**状态（`bodyControlled` / `mindAwake` / `active` / `gate` …，另带上述三个睡眠字段） |
| GET | `/api/characters/:id/hypnosis` | — | 催眠状态 + 三个睡眠字段（面板睡眠区直接读它，省一次请求；见 `buildState()` 第 140-159 行） |

> ⚠️ **`/hypnosis/wake` 一个路径两种语义，按 body 里有没有 `mode` 分流**（第 105-106 行：`rawMode === undefined || rawMode === null || rawMode === ''` 即"睡眠唤醒"）。
> **带 `mode` = 催眠唤醒**（解除控制 / 只唤醒意志，返回催眠状态）；**不带 = 睡眠唤醒**（把她从睡梦里叫起来，返回四字段睡眠形状）。
> 这条在文档里写死：下一个人改这条路径前先看 `test/hypnosisSleepControl.test.js`（第 222-247 行锁死两种语义与两种形状），别把两者混成一条。
> `mode` 传了非法值（非 `'mind'`）按 `'full'` 处理（`hypnosisService.wake()` 第 299 行）。
> 之所以共用路径而不新开：`/wake` 早就是催眠唤醒的既有路径，改名会破坏已发布接口；前端 `web-ui/src/api/hypnosis.js` 的 `sleepCharacter` / `wakeFromSleepCharacter` 就是这么调的（后者刻意不带 body 里的 `mode`）。

**门控不适用**：`sleepNow` / `wakeFromSleep` 只过 `requireId` + `ensureCharacter` + `ensureEnabled`（`hypnosisService.js` 第 771-800 行），**不看 `getHypnosisGate()`** —— 背包里没有手机也能让她睡。面板睡眠区因此**刻意不与门控联动**（手机没领到手也照样能点，后端不认时面板照常提示错误）。

### 13.2 `until` 取值口径（`scheduleEditor.resolveSleepUntil()` 第 494-529 行）

| 入参形态 | 语义 |
| --- | --- |
| `'HH:mm'` | **程序世界墙上钟点**；已过则该钟点顺延到明天（`hhmm > nowMin ? hhmm : hhmm + 1440`） |
| `'YYYY-MM-DD HH:mm[:ss]'` | 程序世界墙上时刻（**秒被忽略**）；相对"程序今天 00:00"换算成分钟数 |
| 带时区的 ISO（`…Z` / `+08:00`） | **真实瞬间**，先 `Date.parse` 再换算回程序墙上时刻做日程手术 |
| 不传 / 空串 | 按日程默认：当日**主睡眠块的时长**（跨午夜按两段之和，见 13.4），没有则兜底 `DEFAULT_SLEEP_MINUTES = 8 小时` |
| 解析不出来 | `{ ok: false, error: 'invalid until' }` → 服务层抛 `INVALID` → 路由 **400** `invalid argument`，**零写入** |

时长夹紧：`MIN_FORCED_SLEEP_MINUTES = 15`（至少 15 分钟）~ `MAX_SLEEP_MINUTES = 24 小时`（`programTime.js` 第 48 行）——避免 `until` 写飞导致她永远不醒。

### 13.3 数据表（睡眠侧只在 `characters` + 当日日程快照）

| 位置 | 列 / 字段 | 语义 |
| --- | --- | --- |
| `characters` | `is_sleeping` | **全局睡眠闸门**：只有**主睡眠**为 1（主动聊天 / 奇遇 / 朋友圈排期按 SQL 直读它） |
| `characters` | `sleep_until` | 醒来时刻；**真实瞬间**的无时区 UTC 串（要和 `datetime('now')` 比、也会被 `chat.js` 抄进 `reply_queue.scheduled_reply_at`） |
| `characters` | `temporary_wake_until` | 临时唤醒窗口右端；**真实瞬间**（不是程序时间，见 13.7）；`NULL` = 无窗口 |
| `characters` | `wake_mode` | 窗口来源：`'phone'` / `'door'` / `'shake'` / `'hypnosis'`（决定日程上下文的措辞） |
| `characters` | `wake_attempts` / `was_door_woken` | 叫醒链路的既有列，睡眠周期内由 `syncSleepingState` 一起重置 |
| `daily_schedules` | `schedule_date` + `schedule_json` | **唯一事实来源**：当日快照里 `replyDelay=-1` + `forcedSleep=1`（立刻入睡写的睡眠块）/ `replyDelay=0` + `forcedWake=1`（立刻唤醒写的清醒块） |

列由 `agent-core/src/db/index.js` 的 `ALTER TABLE characters ADD COLUMN` 补出（`is_sleeping` / `sleep_until` 第 1472-1478 行、`temporary_wake_until` 第 1503-1505 行）。

### 13.4 行为口径：**走日程编辑链路，绝不裸改 `is_sleeping`**

`scheduleEditor.forceSleepNow() / forceWakeNow()`（第 539-642 行）动的是 **`daily_schedules` 当日快照**，不是 `characters`：

1. 用 `replaceRange()` 把 **[现在, 结束)** 这一段换成睡眠块（`replyDelay=-1`、`forcedSleep=1`、`activity='催眠入睡——被无形的手按进睡眠'`）或清醒块（`replyDelay=0`、`forcedWake=1`、`activity='被唤醒——睡意散去'`）；
2. `saveTodaySchedule` → `invalidateCache` → `syncSleepingState` → `broadcastScheduleChanged`：缓存、定时器、库三者立刻一致；
3. 改动**只落在今天**的快照上，次日从模板重新派生时自然消失（不需要清理逻辑）。

**为什么必须这样**：睡眠状态的唯一事实来源是「当日日程 + `scheduleManager` 的派生链」。只改 `characters.is_sleeping/sleep_until` 的话，下一次 `syncSleepingState`（整点 cron、聊天读路径、日程刷新）会按日程把结论**翻回去**——内存说醒着、库里说睡着。回归用例：`test/hypnosisSleepControl.test.js` 第 135-139 / 192-195 行（点完再同步一次不许翻回去）。

两条流程的细节都是真机踩过的坑（改动请连测试一起看）：

| 流程 | 关键次序 | 坑 |
| --- | --- | --- |
| `forceSleepNow` | 校验 + 夹紧 → `clearTempWake(id)` → `saveTodaySchedule` → `invalidateCache` → `syncSleepingState` | ① 不收临时唤醒窗口的话，`syncSleepingState` 在窗口期间**直接 return** → 接口回 `isSleeping:false`、`is_sleeping` 仍 0（"点了入睡她还是醒着"，最多 15 分钟后才睡）；收窗口放在校验**之后**，非法 `until` 仍然零写入 |
| `forceWakeNow` | 先 `clearTempWake` → 把当前睡眠块"挖到**整个睡块的末尾**" → `syncSleepingState` → 再兜底 `UPDATE … is_sleeping=0, sleep_until=NULL` | 跨午夜睡块（23:30 被叫醒）只挖到本日 24:00 的话，`00:00~07:45` 那段还留着 → "叫醒了，过一会又睡了"；末尾要**向前跨过午夜**算到早上那一段的结束 |

其它口径：

- **幂等**：`/sleep` 连点两次仍 200（"睡着"），`/wake` 本来醒着也 200（只是没有日程改动）。
- **总开关**：`sleepNow` / `wakeFromSleep` 都先 `ensureEnabled()`，关闭时 **409 `hypnosis feature disabled` 且零写入**（`test/hypnosisSleepControl.test.js` 第 275-289 行）。
- **没有日程的角色**：`forceSleepNow` 返回 `reason='no_schedule'` → 服务层抛 `CANNOT_SLEEP` → **409 `cannot sleep`**，不写任何状态。
- `is_sleeping` 只表示**主睡眠**；白天小憩（nap）写 `sleep_until` 供聊天排队，但**不占闸门、不显示"睡觉中"**（见 13.6）。

### 13.5 **睡眠 ≠ 催眠**（两套独立系统，别混）

> 用户原话：**「催眠的意思是我完全控制角色，不是睡觉」**（原文见 `目标/接手指南-2.md` §9.2 第 1 条）。

| | **催眠**（意识压制） | **睡眠**（生理状态） |
| --- | --- | --- |
| 数据 | `character_hypnosis`：`body_controlled` / `mind_awake` / `active_until` / `pending_directive` | `characters`：`is_sleeping` / `sleep_until` / `temporary_wake_until` |
| 注入块 | `<hypnosis_state>` + `<hypnosis_command>` | 日程上下文（`formatScheduleContext` 的「你正在睡觉」等） |
| 写入口 | `hypnotize`（**唯一过门控的一条**：背包里要有手机）/ `wake` / `issueCommand`（后两个只看「是否在催眠中」，不看手机） | `forceSleepNow` / `forceWakeNow` / `tempWake`（**完全不看门控**） |
| 覆盖 | 意志与身体（"我想不想、能不能"） | 睡与醒（"她此刻在不在睡"） |

- **互不影响**：睡着照样能被催眠（`hypnotize` 不看 `is_sleeping`，门控也不看），被催眠也能照样睡——两区在面板上并列（②.5 睡眠控制 / ④ 操作区），语义互不覆盖。
- **唯一的交叉点集中在"睡眠中触发强制高潮"这一轮**：① 触发前 `wakeForForcedTrigger()` 临时唤醒（否则日程上下文那句「你正在睡觉。不要回复任何消息」会和"这一轮必须演完高潮"硬碰硬）；② `chat.js` 只读查一次睡眠列决定文案（见 13.8）。除此之外两条链路零耦合。
- **别把 `/wake` 当"万能唤醒"**：不带 `mode` 才是睡眠唤醒，它不碰 `character_hypnosis` 一行。

### 13.6 三态睡眠判定（`classifySleepBlock()` / `currentSleepBlock()`）

`scheduleManager.js` 第 47-88 行是**唯一判定点**（别在调用点复制规则）：

| `kind` | 条件 | `is_sleeping` | 后果 |
| --- | --- | --- | --- |
| `main` 主睡眠 | `replyDelay === -1` 且（`forcedSleep === 1` **或** 时长 > `NAP_MAX_MINUTES = 90` **或** 不整体落在 `[07:00, 21:00)` 当日白天窗口内） | **1** | **全局闸门**：主动聊天 / 奇遇 / 朋友圈 / 催眠触发全被拦；显示"睡觉中" |
| `nap` 小憩 | `replyDelay === -1` 且 时长 ≤ 90 分钟 且 同日 且 整体落在 `[07:00, 21:00)` 内 | 0（但仍写 `sleep_until`） | 不占闸门、不显示"睡觉中"；聊天仍排队到醒来（`replyDelay=-1`） |
| `null` 不睡 | 其它（`replyDelay !== -1` / 空块） | 0 | 正常回复 |

- `currentSleepBlock(characterId, programNow)`（第 257-266 行）= `getCurrentActivity` + `classifySleepBlock`，顺带给出该块结束的**真实瞬间** `sleepUntil`；`programDateKey` 供审计。
- **催眠写的强制睡眠块绝不能被小憩启发式降级**：`forcedSleep === 1` 直接判 `main`（第 79 行）——所以 15:00~15:45 那种"白天小憩"不会把"立刻入睡"吞掉。
- **边界精度（照代码，别只看注释里的区间写法）**：白天窗口**两端都取等号**（`startTime >= 07:00` 且 `endTime <= 21:00`），时长比较是 `duration <= 90`；`endTime === startTime` 的零长块按**整天**（1440 分钟）算 → 落到 `main`。
- **`is_sleeping` 只代表主睡眠闸门**（第 745 行注释）。三个名字很像的读接口，别混：

| 函数 | 口径 |
| --- | --- |
| `isSleeping(id)` | "她现在是睡/打盹中吗"——**含小憩**；叫醒端点、朋友互动、朋友圈发帖用它；**临时唤醒窗口内返回 `sleeping:false`** |
| `getSleepStatus(id)` | **全局睡眠闸门口径**（= `!tempWoken && is_sleeping === 1`），小憩不算"睡觉中"；催眠手机睡眠接口的**冻结返回形状**就用它（第 865-877 行） |
| `isMainSleepBlock(block)` | 该日程块是不是主睡眠（`classifySleepBlock === 'main'`） |

- 读路径**双向当场纠正**：日程说睡而她库里是醒的 → 当场 `syncSleepingState`；日程说醒而库里挂着 `is_sleeping=1`（睡块 10:30 结束、cron 到 11:xx 才清）→ 当场纠正（第 760-770 行、第 494-501 行）。回归：`test/scheduleSleepDaylight.test.js`（9 项，含"白天不再显示睡觉中"与三态判定）。

### 13.7 临时唤醒窗口按**真实时间**判定（`temporary_wake_until`）

- **写入口唯一**：`scheduleManager.tempWake(id, { minutes, mode, force })`（第 627-660 行）——电话叫醒 / 上门摇醒 / 催眠指令触发前**全都用它**；原子写 `is_sleeping=0` + `temporary_wake_until` + `wake_mode`，再注册到期定时器、重置 groggy 标记、广播 `schedule_state_change`。默认窗口 5~15 分钟；强制触发用 `FORCED_TRIGGER_TEMP_WAKE_MINUTES = 5`、`mode='hypnosis'`（`hypnosisService.js` 第 763 行）。
- **判定 `isTempWoken(id, now = new Date())` 默认用真实时间**（第 522-528 行）；全程按真实时间比较。

**为什么必须真实时间**：`temporary_wake_until` 存的是真实瞬间。若拿**程序钟**去比，程序钟一旦被拨到未来，`until > 程序 now` 恒为假 → "刚被叫醒的人"被重新写成"正在睡觉"：`formatScheduleContext` 又会输出「你正在睡觉。不要回复任何消息」、`getReplyDelay` 又把她塞回排队（"叫醒了还是不理我、消息一直排到醒来"）——正好把强制触发前那次临时唤醒的效果抵消掉。代码注释见 `scheduleManager.js` 第 404-407、464-467 行；回归 `test/scheduleSleepTimeBase.test.js`（3 项）。

临时唤醒窗口内的连锁口径：

| 位置 | 行为 |
| --- | --- |
| `syncSleepingState` | **直接 return**（保持 `is_sleeping=0`、不覆盖 `sleep_until`）——所以 `forceSleepNow` 必须先 `clearTempWake` |
| `isSleeping()` | 返回 `sleeping:false`（窗口内不算睡着） |
| `getReplyDelay()` | `delay: 0`（秒回，不排队） |
| `formatScheduleContext()` | 覆盖日程提示；`wake_mode='hypnosis'` 时输出「【当前状态】被…的催眠指令从睡眠中拉了出来——身体已经醒了，意识却被对方牢牢压着。」（`scheduleManager.js` 第 417-429 行） |
| 窗口到期 | `revertTempWake` 按**程序钟**的日程决定回睡（`is_sleeping` 按 `kind === 'main'` 置位）还是保持清醒 |
| `getSleepStatus()` | 窗口内 `isSleeping` 判为 `false`，但 `temporaryWakeUntil` **原样回库里的串**（前端据此显示"被临时叫醒，醒着到 …"） |

### 13.8 睡梦中被强制高潮唤醒（`forced_climax` 的第三种口径）

**触发条件**（`isAwakenedFromSleepRow(row, now = Date.now())`，`hypnosisPrompt.js` 第 87-89 行）——两个信号**满足其一**：

1. `is_sleeping = 1`：她还睡着（例如临时唤醒窗口已过期她又睡回去了，或唤醒那一步失败）；
2. **处于临时唤醒窗口内**：`temporary_wake_until` 在未来（用 `Date.now()`，不传程序时间）。

> 第 2 条**必须有**：`POST /hypnosis/command` 的 `forced_climax` 在触发这一轮之前会先 `wakeForForcedTrigger()` 临时唤醒她（`routes/hypnosis.js` 第 143-145 行），此刻 `is_sleeping` **已经是 0** —— 只看它就永远漏掉睡梦唤醒版（这是本功能最容易整条失效的地方）。
> 取不到值（角色行缺失 / 列缺失 / 无法解析的时间串）一律判 `false`：宁可少一次特殊表现，也不能把清醒的回合误写成睡梦唤醒。

**挂点（`chat.js` 第 875-883 行）**：只有 `directive === 'forced_climax'` 时**只读查一次** `SELECT is_sleeping, temporary_wake_until FROM characters WHERE id = ?`，交给 `isAwakenedFromSleepRow()` 判定，再作为 `buildDirectiveBlock(directive, { mindAwake, awakenedFromSleep })` 传入。整段仍在 `config.features.hypnosis !== false` 守卫内、由分片 `try/catch` 兜底；**只读、不写 `characters`**、只影响**该轮**（一次性指令消费即清空）。源码级断言见 `test/hypnosisSleepAwaken.test.js` 第 218-252 行（全文件只能有这一处该 SQL、必须在 `forced_climax` 分支内、片段里不得出现 `UPDATE` / `INSERT`）。

**文案**（`CLIMAX_AWAKENED_FROM_SLEEP_LINES`，`hypnosisPrompt.js` 第 230-235 / 275-279 行）：

- 复用同一个标签 `<hypnosis_command kind="forced_climax">`，**优先于 `mindAwake` 分流**（人刚从梦里被拉起来，"意志清不清醒"不是这一轮的主导体验）；
- 四条独有特征：从**深度睡眠**里被硬拉上来（意识还没接上、身体先反应、分不清梦与现实）→ 声音**哑、含糊、带睡意的鼻音** → 手脚**发软**、动作跟不上/慢半拍 → 刚醒那一下的**恍惚与羞耻**（甚至先以为自己在做梦），外加"这一轮必须演完整"的硬优先级；
- **只作用于 `forced_climax`**：`body_control` / `memory_restore` / `<hypnosis_state>` 传了 `awakenedFromSleep` 也不变；不传 / 传 falsy 时与改动前**逐字一致**（回归 `test/hypnosisSleepAwaken.test.js` 第 123-160 行）；
- 群聊里带成员限定行（`subject`）也在 `MAX_COMMAND_BLOCK_CHARS = 300` 内不被截断。

### 13.8.1 自动触发那一轮**本身就是高潮轮**（2026-09-29 修复，本仓 task-41）

**真机症状**：睡着时点「强制高潮」，她只回了一句普通闲聊（无演出、无配图）——用户反复反馈「睡着时强制高潮没特殊反应」。

**根因（日志实证，`完整/backend-2026-09-29.log`）**：点完按钮后 `routes/hypnosis.js` 会 `wakeForForcedTrigger()` + `forceProactiveNow(id,{bypassGuards:true})` 立刻替她发一轮；但这一轮走 `proactiveChatScheduler`，它**当时对催眠一无所知** ——

1. 一次性指令只有 `chat.js`（私聊）与 `groupChatEngine.js`（群聊）两个消费点，主动聊天既不注入也不消费；
2. 因此那一轮的 prompt 里既没有 `<hypnosis_command kind="forced_climax">`，也没有「睡梦唤醒」文案；
3. 是否配图取决于**随机抽到的动机**（`motive.imageGen`）——抽到「好奇提问」这类就一张图都没有。

日志里可见：`[hypnosis] forced_climax: 先临时唤醒 5（5 分钟）再触发` → `⚡ force: targeted 风瑾 (id=5)` → 紧接着那次「主动聊天」请求的 prompt 里没有指令块，输出是一句平淡闲聊。

**修法（5 处，全部加法）**：

| # | 改动 | 位置 |
| --- | --- | --- |
| 1 | 新增 `buildForcedClimaxProactiveBlocks(characterId)`：状态块 + `consumePendingDirective()` 指令块（`awakenedFromSleep` 走 `isAwakenedFromSleepRow()`），与私聊同口径 | `proactiveChatScheduler.js` |
| 2 | `generateGreeting(..., extra)` 把注入块接在**本轮 user 消息末尾**（位置最硬）；**不传块时输出逐字节不变** | 同上 |
| 3 | 叠加 `FORCED_CLIMAX_FRAME_OVERRIDE`：取消主动聊天模板的「开场白 / 15~50 字 / 动机当潜台词」框架（否则模型仍会写成一句短开场白） | 同上 |
| 4 | 动机换成 `{ name: '强制高潮', imageGen: true }` ⇒ 这一轮**必须配图** | 同上 |
| 5 | `routes/hypnosis.js` 传 `forcedClimax: true`；「2 分钟内刚聊过就跳过」的闸门**对手点不生效** | `routes/hypnosis.js` / 同上 |

**口径变化（务必记住）**：一次性指令现在由**这一轮（自动触发的主动聊天轮）**消费，不再是「等你回一条才演」。用户回复的那一轮是普通回复。若这一轮因故没发出去，指令仍留在库里，下一轮私聊照样会演出。

**验证**：`agent-core/test/hypnosisClimaxProactive.test.js`（6 项：睡着 / 临时唤醒窗口 / 清醒 / 无指令 四种块组装 + 两条挂点断言）。

**真机自查关键字**：日志应出现 `[hypnosis] 强制高潮轮：注入 2 块、awakenedFromSleep=true、directive=forced_climax`，随后有该类目的配图请求。

### 13.9 错误映射（在 §5 的表上补这几种）

| 情况 | HTTP | 响应 |
| --- | --- | --- |
| 非法角色 id / 非法 `until` | 400 | `{ error: 'invalid character id' }` / `{ error: 'invalid argument' }` |
| 角色不存在 | 404 | `{ error: 'character not found' }` |
| 总开关关闭（`code='DISABLED'`） | 409 | `{ error: 'hypnosis feature disabled', features: { hypnosis } }` |
| 没有日程 / 写不进睡眠（`code='CANNOT_SLEEP'`） | 409 | `{ error: 'cannot sleep', reason }`（`reason='no_schedule'`） |
| 睡眠唤醒失败（`code='CANNOT_WAKE'`） | 409 | `{ error: 'cannot wake', reason }` |

前端 `translateHypnosisError()` 把它们翻成人话：`cannot sleep` → 「她现在不能睡（可能在日程中）」；另外还预留了 `not sleeping` → 「她现在是醒着的」、`already sleeping` → 「她已经在睡了」两条兼容路径（当前后端幂等、不会产出它们）（`web-ui/src/api/hypnosis.js` 第 42-46 行）。

### 13.10 前端（面板睡眠区）

| 层 | 内容 |
| --- | --- |
| `web-ui/src/api/hypnosis.js` | `sleepCharacter(id)`（POST `/sleep`，空 body）/ `wakeFromSleepCharacter(id)`（POST `/wake`，**不带 `mode`**）——只发请求，形状归一化不在这里做 |
| `web-ui/src/components/hypnosisLogic.js` | `SLEEP_ACTIONS`（`sleep` 睡觉 / `wakeUp` 唤醒，**刻意不混进 `ACTION_DEFS` / `GROUP_BATCH_ACTIONS`**）、`SLEEP_SECTION_NOTE`、`normalizeSleep` / `resolveSleep` / `sleepViewModel`（`statusText` 睡眠中 / 清醒 / 未知；`untilText`「预计 … 醒来」；`tempWakeText`「被临时叫醒，醒着到 …」；`canSleep` / `canWake`）、`SLEEP_TOAST` |
| `HypnosisPhonePanel.vue` ②.5 | 状态徽标 + 两个按钮；**状态未知时两个按钮都放开**（读不到不代表不能点，让后端给结论）；睡眠区状态来源优先级：**本次操作的返回 → `GET /hypnosis` 里带的睡眠字段 → 角色行上的 `is_sleeping` / `sleep_until`**，三个来源都没有就保留旧值（不把已知状态抹成"未知"） |

- **`temporaryWakeUntil` 只作补充说明，不改变"睡 / 醒"主判定**：主判定永远听后端的 `isSleeping`（窗口内后端已经是 `false`，前端再判一次会自相矛盾）。
- **群聊批量模式里睡眠控制是独立一区**：`HypnosisPhoneGroupPanel.vue` 第 85-106 行有独立的「睡眠控制」section（第 94 行 `v-for="action in SLEEP_ACTIONS"` + 第 105 行 `SLEEP_SECTION_NOTE`），第 217-240 行的 `runSleepBatch()` 对选中成员逐个调 `sleepCharacter` / `wakeFromSleepCharacter`（**不带 `mode`、不带 `minutes`**）；它与上面那排 `GROUP_BATCH_ACTIONS`（催眠 / 唤醒 / 只唤醒意志 / 强制高潮）**分开渲染、互不影响**。

### 13.11 验证

```powershell
cd agent-core
$env:DB_PATH=':memory:'; node --test --test-concurrency=1 test/hypnosisSleepControl.test.js test/hypnosisSleepAwaken.test.js test/scheduleSleepTimeBase.test.js test/scheduleSleepSurgery.test.js test/scheduleSleepDaylight.test.js
```

本次实跑（2026-09-29，`:memory:` 库，`--test-concurrency=1`）：**47 / 47 pass、0 fail、0 skip**。
前端睡眠区纯逻辑：`cd web-ui` → `node --test --test-concurrency=1 test/hypnosisSleepControl.test.js`，本次实跑 **10 / 10 pass、0 fail、0 skip**。

| 文件（项数） | 覆盖 |
| --- | --- |
| `test/hypnosisSleepControl.test.js`（14） | `/sleep` 与不带 `mode` 的 `/wake` 的**冻结四字段**、真的写进日程链路（`forcedSleep=1` / `forcedWake=1` 块）、再同步一次不许翻回去、`until='HH:mm'` 顺延口径、幂等、非法 `until` 400 零写入、跨午夜叫醒不会被后半段按回睡着、带 `mode` 的向后兼容、非法 id 400 / 404、无日程 409、总开关 409 零写入、`wakeForForcedTrigger`（睡着才唤醒 + `wake_mode='hypnosis'` + 上下文不再说"你正在睡觉"）、`/wake` 分流的源码断言、`GET /hypnosis` 带睡眠字段 |
| `test/hypnosisSleepAwaken.test.js`（15） | 睡梦唤醒版四条独有特征、与清醒/沉睡版两两不同且关键词不串台、压过 `mindAwake` 分流、群聊限定行不被截断、清醒/沉睡版**逐字冻结**、`awakenedFromSleep` 只作用于 `forced_climax`、`isSleepingRow` / `isTempWakeActiveRow` / `isAwakenedFromSleepRow` 的归一化与"取不到=清醒"、`chat.js` 挂点（只读查一次 + 在 `forced_climax` 分支内 + 片段内无 `UPDATE`/`INSERT`）、真库端到端与 `isTempWoken` 口径一致 |
| `test/scheduleSleepTimeBase.test.js`（3） | **临时唤醒按真实时间**：程序钟拨到夜里 + 临时唤醒 → `is_sleeping=0`、秒回、上下文不再写「你正在睡觉」；反向不修坏（没有窗口时程序钟说了算）；取消窗口后回落到程序钟的日程结论 |
| `test/scheduleSleepSurgery.test.js`（6） | 立刻入睡/立刻唤醒的三处真实缺陷：跨午夜主睡眠时长（不许算成 1440 分钟吞掉整天日程）、`forceSleepNow` 必须收掉临时唤醒窗口、`forceWakeNow` 必须挖到跨午夜睡块的末尾；非法 `until` 零写入（含不许顺手收窗口） |
| `test/scheduleSleepDaylight.test.js`（9） | `classifySleepBlock()` 三态（白天小憩 `nap` / 长睡眠与昼伏夜出 `main` / `forcedSleep` 不被降级 / 非睡眠块 `null`）+ 本地白天不许显示"睡觉中"（含读路径纠正残留标志）、跨日/跨时区边界 |

**已知边界**：

- 睡眠控制**不受门控约束**（背包里没有手机也能睡/醒）——这是"睡眠 ≠ 催眠"的直接推论，不是遗漏。
- **小憩不算"睡觉中"**：`is_sleeping` 只代表主睡眠闸门，小憩只写 `sleep_until`；需要"打扰判定"的地方（朋友互动、朋友圈发帖）要用 `isSleeping()` 而不是 `is_sleeping`。
- **临时唤醒窗口会替换 5 分钟左右的日程上下文**（"被催眠指令从睡眠中拉了出来"）：这是刻意的（否则和"这一轮必须演完高潮"打架），窗口到期由 `revertTempWake` 按程序钟日程自动收回。
- **群聊批量模式没有睡眠控制**（见 13.10）。
- 以上均为后端/前端单测可验范围；**真实 LLM 的睡梦唤醒表现**（鼻音、恍惚、先以为在做梦）没有进 `目标/real-llm-check.mjs` 的固定轮次，语义判定需人读。

## 14. task-1：群聊侧遗忘 + 群聊「强制高潮」出图（2026-09-28）

**冻结口径**（lead 预冻结原文）：「群聊 transcript 的屏蔽以遗忘窗口自身的 `from_at`/`to_at` 时间区间为准」。本节是 §12（群聊入口）的下半场：群聊里既**能被遗忘**，也**真的会出图**。

### 14.1 群聊 transcript 屏蔽：按**时间区间**（§12 原先"暂未覆盖"那条已作废）

链路（`agent-core/src/services/groupChatEngine.js`）：

| 环节 | 位置 / 行为 |
| --- | --- |
| 取窗口 | `runGroupRound` 第 1490 行 `resolveTranscriptExcludeRanges(group.members)`（模块内私有，第 534-546 行）→ `collectForgottenWindowsForMembers(ids)`（`hypnosisService.js` 第 487-505 行：**一条 `IN (...)`** 取回这些成员全部 `status='active'` 的窗口，返回 `{characterId, windowId, fromAt, toAt}`；总开关关闭 / 无有效 id → `[]`，查库失败只 warn） |
| 传区间 | `buildGroupContext(group, directiveBlocks, { excludeTimeRanges })`（第 556-561 行，**不传时当场现算**）→ `buildTranscript(db, conversationId, excludeTimeRanges)`（模块内私有，第 461-524 行） |
| 判定 | `isRawInTimeRanges(createdAt, ranges)`（导出，第 449-459 行）：区间取窗口**自身**的 `from_at → to_at`，**闭区间**（`at >= from && at <= to`；只有 `toAt` 时等价"截止到该时刻"）；`created_at` 为空 → **不屏蔽**（宁可不屏也不误屏） |
| 过滤 | 第 509-517 行：命中即从 transcript 剔除，并打日志 `[group] hypnosis forgot: hidden N raw(s) of M`；**只影响喂给模型的文本**，`raw_messages` / 前端展示一条不少（可审计、可撤销） |

- **为什么不按 raw id**：群会话 `group_<gid>` 与私聊会话 `char_<cid>` 是**两条独立的 `raw_messages` 自增序列**，窗口行的 `from_raw_id` / `to_raw_id` 只对私聊会话有意义，拿去比群 raw 必然串台（可能误屏无关消息、也可能漏屏该屏的）。代码注释见 `hypnosisService.js` 第 462-475 行、`groupChatEngine.js` 第 526-533 行。
- **任一成员遗忘该区间即对全体屏蔽**：一轮群聊是**一次调用演全部角色**（输出协议按 `[名字]: 台词` 分行），一条 raw 里混着所有成员的发言，无法按成员分片；按行拆 raw 的代价与出错面都大得多。
- 时间串是 SQLite 无时区 UTC、定宽，**字典序比较等价于时间序**，刻意不 parse 成 `Date`（避开时区换算）。
- **零行为变化**：不传 `excludeTimeRanges` / 无窗口 / 总开关关闭 → 空数组，与改动前逐字节一致（`test/hypnosisGroupForget.test.js` A2）。
- **过滤不参与粘性边界**：先按原样算 transcript 的边界与条数，再过滤输出（第 329-331 行注释）——边界是缓存策略、过滤是隐私策略，混在一起会让 transcript 长度随遗忘窗口忽长忽短、前缀缓存抖动。

**仍然存在的边界（如实写）**：

| 项 | 现状 |
| --- | --- |
| 滚动摘要 | `summaryMessage`（`getRecentSummaries(conversationId, 1)`，第 567-570 行）**不进**屏蔽 —— 与私聊 §10 的边界同性质：遗忘只屏蔽"原始历史"，屏蔽不了已生成的摘要 |
| 同秒边界 | 时间串只到秒，而窗口两端都是 `datetime('now')` 量级 → 边界上可能**偏保守**多屏一条（**不会漏屏**） |
| 群聊面板旧文案 | `HypnosisPhoneGroupPanel.vue` 第 82 行仍写着「群聊里没有对应口径」——**该前端文案已过时**（服务侧早已覆盖群聊）；本节记录的是后端事实，文案待前端同事改 |
| 批量模式的按钮 | 群聊批量模式仍**不提供**「遗忘被控制这段时间」按钮（要遗忘请切"单独使用模式"或私聊面板）；"按钮不在这一区"与"群聊能不能被遗忘"是两件事 |

### 14.2 群聊长期记忆一起归档 + 可精确恢复

`forgetWindow(id, { toRawId })`（`hypnosisService.js` 第 572-649 行）现在**两侧都归档**：

1. 窗口时间戳取 `from_at = started_at`（第 578 行读出的会话起点）、`to_at = datetime('now')`（第 614 行），再用**同一对时间戳**分别收集：
   - 私聊记忆：`collectMemoriesInRange(conversationId, fromRawId, toRawIdFinal)`（按 raw id 区间，既有口径）；
   - 群聊记忆：`collectGroupMemoriesInRange(characterId, fromAt, toAt)`（第 519-551 行）——只挑**该角色所在群**（`group_members` 关联）、有 `source_raw_start_id` 锚点、其 raw 的 `created_at` **落在闭区间** `[fromAt, toAt]` 内的 `status='active'` 记忆；分页 `LIMIT 200`、最多扫到 `offset 5000`。
2. 两侧的 `memory_id` **合并进同一行**的 `memory_ids`（第 624-638 行），`memories_archived` 是两侧之和。
3. `restoreForgottenWindow` **本身不改**（仍按 `memory_ids` 精确还原）——所以"让她恢复这段记忆"对群聊侧同样生效，且不会误还原同一区间里因别的原因被归档的无关记忆（`test/hypnosisGroupForget.test.js` B1 / B2）。
4. `listForgottenWindows` 只回 active → 恢复之后群聊屏蔽**随之解除**（A4 覆盖：遗忘前在 transcript 里、遗忘后消失）。

### 14.3 群聊「强制高潮」现在真的出图

群聊没有私聊 `chat.js` 的路径 D'（那条 `handleNeedImageFlow` 管线），出图只能来自剧本里的 `角色名: {英文画面描述}` 发图行，而发图本来只是概率抽卡（`IMAGE_NUDGE_PROBABILITY`）——所以做成**两段式**：

| 段 | 位置 | 行为 |
| --- | --- | --- |
| ① prompt 硬指令 | `collectHypnosisDirectiveBlocks()` 第 113-118 行 + `buildForcedClimaxImageBlock()` 第 70-75 行 | 消费到 `forced_climax` 时**紧跟指令块**再 push 一块 `<forced_climax_image>`：点名「本轮「甲」必须发出一张图（这是硬性要求，不可省略）」，要求先出普通台词、下一行输出发图行 `甲: {…英文画面描述…}`，并禁止用「[拍了一张图]」这类占位符；返回体多一个 `forcedClimax: [{id, name}]` |
| ② 流结束后兜底（真正的保证） | `runGroupRound` 第 1697-1717 行 → `ensureForcedClimaxImage()` 第 753-795 行 | 本轮该角色**一张图都没发**（由 `written.hasImage` 得出 `coveredIds`）就**再请求一次模型只要画面描述**（`requestNonEmptyImagePrompt` + `buildForcedClimaxImageMessages`）；拿到就走 `emitGroupImageFor()`（第 714-737 行，与主链路的发图行**共用**"挂气泡 + 落 `image_tasks` + 触发生图"）；模型仍给不出 → 确定性英文兜底 `defaultForcedClimaxPrompt()`（第 801-804 行）。整段 try/catch，失败只 warn |

- **不重复出图**：模型自己已经发了图就不补（`coveredIds`），一轮仍是一张（C3）。
- **落点与私聊对齐**：图挂在被下令角色自己的气泡上、发图行写回 raw（下一轮 transcript 里才有这条记录），用户可见结果与私聊路径 D' 一致（`image_tasks.status='done'`，C2 / C4）。
- 兜底位置刻意放在**回填 raw 之前**（第 1694-1696 行注释），否则补出的发图行进不了本轮 raw。
- 亲密看板**不重复记账**：沿用主链路的记账（`ensureForcedClimaxImage` 只出图）。

### 14.4 验证

```powershell
cd agent-core
$env:DB_PATH=':memory:'; node --test --test-concurrency=1 test/hypnosisGroupForget.test.js
cd ..\web-ui
node --test --test-concurrency=1 test/hypnosisGroupPanel.test.js
```

本次实跑（2026-09-29，`:memory:` 库）：后端 `hypnosisGroupForget.test.js` **12 / 12 pass**（A1-A5 / B1-B2 / C1-C5，其中 C5 是 task-5 的发图行 seq 递增回归）；群聊面板纯逻辑 `hypnosisGroupPanel.test.js` **6 / 6 pass**。整条催眠链（后端 9 个文件）**132 / 132 pass、0 fail、0 skip**。
