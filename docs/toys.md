# 成人玩具系统（后端）

> 上游：`目标/规划/专题-玩具系统与真机反馈三期.md` §二。本文件只写**后端口径**（前端面板见 §2.8，属 web-ui 线）。

## 1. 数据模型

表 `character_worn_toys`（迁移 `agent-core/src/db/index.js: migrateWornToysSchema`，幂等建表）：

| 列 | 说明 |
| --- | --- |
| `character_id` / `toy_key` | `UNIQUE(character_id, toy_key)`：同种玩具一件，不同部位可叠加（多行） |
| `intensity` | 0~`maxIntensity`（项圈恒 0） |
| `status` | `worn` / `removed`（摘下**保留行**） |
| `equip_count` | 「戴过几次」——**对专题 §2.2 表结构的必要补强**：UNIQUE 约束下同一玩具永远只有一行，靠行数统计不出来 |
| `equipped_at` / `updated_at` | 佩戴时刻（「已戴多久」的唯一依据；不随程序时间自动变化，§2.10-3） |

## 2. 门控矩阵（§2.4）

实现：`toyService.gateToy()` **委派 `touchActionService.getTouchGate()`**（同一门槛对象、同一套拒绝文案、同一套催眠豁免与群聊口径），只在两处加玩具自己的口径：

| 玩具 | 门控档 | 要求 | 群聊 |
| --- | --- | --- | --- |
| 跳蛋 / 振动棒 / 肛塞 | Lv4（`touch_clit` / `finger_insert` / `touch_pussy`） | 好感 ≥80 或誓约 **+ 亲密看板授权** | 吃 `touchGroupAdult`（**与 Lv4 同命运**：§一③ 解禁 Lv4 群聊后玩具自动跟随，本模块不复制口径） |
| 乳夹 | Lv3（`touch_breast`） | 好感 ≥60 或誓约 + 授权 | 同上 |
| 项圈 | Lv3 门槛，但**不要求亲密授权**（象征物、不涉器官） | 好感 ≥60 或誓约 | 同上 |

- **催眠中（`isBodyControlled`）豁免一切**（走 getTouchGate 的 `exempt: 'hypnosis'`）；
- **睡着**不拦装上（§2.4：可轻柔装上），但返回 `wakesOnIntensity: true` —— 调高强度的时机由调用方决定是否弄醒她；
- **调强度 / 摘下无门控**（已戴上就是默许）；催眠装上后醒来**不会自动脱落**（残留玩法）。

## 3. 状态注入块（§2.5）

`toyService.buildWornToysBlock(characterId, { scene, now, subjectName })`：

- **零佩戴返回 `null`**（调用方据此零注入 ⇒ 与加功能前逐字节一致）；
- 私聊版：`<worn_toys>` + 佩戴清单（部位/强度/已戴时长）+ **分档描写指引**（强度 0 / 1~2 / 3 / 4~5 / 已戴超 1 小时，五行全给）；
- 群聊版：多一行 `【本节只对「X」生效】` + `【她知道原因；其他人看得到她的异样但不知道原因】`；
- 注入位置：私聊 `routes/chat.js` **5.54**（紧挨 5.55 动作块之前）；群聊 `groupChatEngine` 逐成员注入（带成员限定行）；主动轮 `proactiveChatScheduler.generateGreeting`。

## 4. API 契约（§2.9-2）

路径与字段以 `web-ui/src/api/index.js` 的四个函数为准（前端已按 §2.9-2 写好）：

| 方法 | 路径 | body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/characters/:id/toys` | — | `{ unlocked, worn:[{toyKey,label,part,intensity,maxIntensity,equippedAt,minutesWorn,gate}], available:[{toyKey,label,part,maxIntensity,allowed,gate}] }` |
| POST | `/api/characters/:id/toys/:toyKey/equip` | `{ intensity? }` | `{ ok, unlocked, toy, reaction, memory, gate }`；门控不过 → **403** `{ error:'toy_gate_blocked', code, message }` |
| POST | `/api/characters/:id/toys/:toyKey/set-intensity` | `{ intensity }` | `{ ok, unlocked, toy, reaction }`；未佩戴 → 404 `toy_not_worn` |
| POST | `/api/characters/:id/toys/:toyKey/remove` | `{}` | `{ ok, unlocked, toy, reaction, memory }`；未佩戴 → 404 |

- 开关 `features.toys`（`config.js`，env `FEATURE_TOYS`，持久键 `feature_toys`，**默认关**）：关着时 GET 返回 `unlocked:false`（空数组）、三个写接口 **403 `toys_disabled`**；
- **场景（2026-10-03 群聊 bug 修复）**：四个写入口（`equip` / `set-intensity` / `remove` / `self-play`）与 `tick` 都接受 query/body 的 `scene=group` + `groupId=<n>`；
  - **不传 = 私聊**（与改造前逐字一致，老前端零改动）：反应写 `char_<id>` + 广播 `proactive_message`，补图 `proactive_message_update`；
  - `scene=group`：反应写 `group_<gid>`（`groupInsertMessage.writeGroupInsertMessage`，raw 带「[名字]: 」前缀）+ 广播 `group_message`，补图 `group_message_update`（**整份群 payload + `group_id` + `images`**，事件名由 `services/reactionImageUpdate.js` 唯一决定）—— 群聊页只认这两条统一流事件（用户原话：「在哪里聊天就在哪里继续进行」）；
  - `scene=group` 必须带合法 `groupId` 且她是该群成员，否则 **400** + 人话（`invalid_group` / `group_not_found` / `not_group_member`）；
  - **群聊成人闸门** `features.touchGroupAdult`（默认关）对四条链一视同仁：关着时 `equip` 走 `gateToy`、`set-intensity` / `remove` / `self-play` 走 `groupAdultGate`（同一个 `getTouchGate` 的 `group_adult_blocked` 结论），全部 **403 `toy_gate_blocked` + `code:'group_adult_blocked'`** + 触摸链那句话；私聊不受这个开关影响；
- `reaction` 与 touch 即时反应同管线（`chatSync` + `parseReactionOutput`），字段含 `reactionText` / **`imagePrompt`** / `emotionDelta` / `facialExpression` / `annoyed`；
- 反应 / 心情 / 记忆都是**增强项**：任一步失败都只 warn，不影响穿戴状态本身。

## 5. 与 §一① `image_prompt` 的衔接

`toyService.buildToyReactionPrompt` 的 JSON 示例里**已经包含 `image_prompt`**（与 §一① 的字段名一致，且要求写「此刻正在发生的画面」——姿势/表情/衣着现状/玩具的可见形态），与 `reaction_text` **同一次调用产出** ⇒ 图文一致。
§一① 那条线（touch 反应改为 LLM 现写 `image_prompt`）落地后，本模块**不需要改**：字段名与语义已经对齐；届时玩具出图只要复用同一字段即可。

## 5.1 睡着时的强度唤醒（§2.4 表末行 · 2026-09-30 收口）

`gateToy` 返回的 `wakesOnIntensity` 由 **`set-intensity` 消费**：

- 判定：`toyWakePlan({ sleeping, intensity })` —— **睡着 且 强度 ≥ `TOY_WAKE_INTENSITY`(=3)** 才唤醒；
  - 唤醒时 `extraContext` = 「她本来已经睡着了，被这一下高强度的刺激**惊醒**了（刚被惊醒：迷糊、还没完全清醒，身体先有反应）」→ 写进反应 prompt（模型据此演"惊醒"而不是"接续撒娇"）；
  - 低强度（1~2）= 轻柔，不唤醒，`extraContext` 写明「没有把她弄醒」；
  - 没睡着 ⇒ 不涉及。
- 执行：`applyToyWake({ characterId, sleeping, intensity, tempWake })` → 真的调用 **`scheduleManager.tempWake()`**（触摸链的现成机制，**不新造唤醒管线**）：`is_sleeping=0` + `temporary_wake_until` + `wake_mode='phone'` + 广播 `schedule_state_change`；到期由既有的 `revertTempWake` 按日程决定回睡。
- 响应里带回 `wake: { wake, extraContext, woke }`（`woke=false` 表示 tempWake 抛错，只 warn）。

> 测试说明：`:memory:` 里造不出「真实睡着」态（`isSleeping` 读的是**日程快照**，裸改 `is_sleeping` 列会被它纠正），所以路由级的"睡着"用例是 `test.skip` 并注明原因；行为由 `toyWakePlan`/`applyToyWake`（注入 spy 验三支）+ `tempWake` 真实冒烟（写 `temporary_wake_until`）覆盖。

## 5.2 出图（§2.7 · 与 touch 同款两段式）

`toyService.publishToyReaction({ character, reactionText, imagePrompt, source, deps })`：

1. **文字先落库 + 先广播** `proactive_message`（`images: []`）——用 `proactiveChatScheduler.writeProactiveMessage` 写入 `char_<id>` 的 raw + 分段 messages（`is_proactive=1`），再 `broadcastProactiveMessage`；
2. **出图不 await**：`imagePromise` 后台跑，图好 → `attachToyImagesToMessage`（合并去重挂 `messages.images`）→ 广播 `proactive_message_update` `{ msg_id, raw_id, images }`（**同一事件、不发明新事件名**，前端按 msg_id 挂图）；
3. 失败只 `warn`、**不发 update**（文字已在屏上，无损）。

- 出图本身：`generateToyImageForReaction` —— **只用 LLM 现写的 `image_prompt`**（§一①；没有画面描述就不出图，**不回落写死模板**）+ 角色外观段（`buildCharacterAppearanceSection`）+ 画师覆盖（`charArtistOverride`）；档位首期共用 `touchImageMode`（`never` 直接跳过）；
- **依赖注入**：`publishToyReaction` 的 `deps`（`writeMessage`/`broadcastText`/`broadcastUpdate`/`attachImages`/`generateImage`）都可注入 ⇒ 单测能扣住出图 Promise，验证「文字先到 → 图好补 update → 失败只有文字」；
- ⚠️ `writeMessage` **必须由调用方注入**（`routes/toys.js` 传 `writeProactiveMessage`）：toyService 刻意**静态不 import** `proactiveChatScheduler` —— 那个调度器反过来 import 本模块（注入 `<worn_toys>`），静态互引会成环（本仓 TDZ 血泪史）。

## 6. 记忆挂点（§2.6-3）

- `toyMemoryDedupeKey(charId, toyKey, at, event)`：戴上是 `toy:<charId>:<toyKey>:<at>`，摘下/调强度追加 `:<event>` ⇒ 同一事件重复提交不堆叠；
- `buildToyMemoryEntry()` 产出 `{ dedupe_key, content, at }`，由 `routes/toys.js` 写进既有记忆管线（`memoryRepository.applyMemoryActions`，`memoryType:'event'`）。

## 7. 边界

1. 只限**成年角色档案**（与 `touchActionService` 文件头同口径）；
2. 门控不过 = 403（与触摸同款叙事拒绝文案），**不存在「催眠除外的未同意佩戴」**；
3. 玩具状态**不随程序时间自动变化**（不模拟电量）；
4. 她**不能自己摘**（用户独占控制权），但可以在对话里请求摘（prompt 允许）；
5. 出图档位首期**共用 `touchImageMode`**，不另加开关（§2.7）；
6. `config.features.toys` 默认关；DB `feature_toys` 未 seed（默认值由 config 兜住），设置页开关由设置页写 `PUT /api/config/features {key:'toys'}` 持久化。

## 8. 测试

- `agent-core/test/toyService.test.js`（服务层，7 例：清单/门控矩阵/clamp/生命周期/注入块分档/反应 prompt/记忆键）；
- `agent-core/test/toyRoutes.test.js`（路由：开关关→403 与空清单、门控不过→403、允许路径（项圈）=装/查/调/摘全链路、未知玩具 404）；
- `agent-core/test/toyWakeAndImage.test.js`（遗留两条：`toyWakePlan` 三支 + `applyToyWake` spy + 真实 `tempWake` 冒烟；`publishToyReaction` 两段式顺序/失败路径）。

## 9. 她自己主动玩 + 「私密时刻」（2026-10-02）

这一节把两条**她本人发起**的链路并列写清（都与"用户命令"分开）：

### 9.1 她自己玩玩具（`services/toy/selfPlay.js`，纯判定 + 独立块）

- 判定 `decideSelfPlay(...)`：好感 / 誓约 / 淫乱度（派生量 `lewdnessScore`）/ 情绪唤醒 / 独处 / 催眠 / 当日次数 /
  冷却 / 被逗 —— 硬门槛不过直接 `not_yet`，其余按加权分与 `random()` 比一次（**她有权拒绝**：`held_back`）。
- 注入块 `<self_toy_play>`（`buildSelfPlayBlock`，上限 700 字）：与 `<worn_toys>` **分开**，
  因为后者说"身上有什么"、前者说"**这是她自己做的**"；混一条会让模型把她的主动性演成用户命令。
- 接线：聊天轮在 `routes/chat.js` 5.54a 先判、再建块（骰子是"角色 + 10 分钟窗口"的确定性哈希 ⇒ 同一窗口只判一次）。

### 9.2 「私密时刻」＝自慰（`services/privateMomentService.js`）

用户原话：「再增加一个事件 叫自慰 和角色敏感度也相关 越高发生概率也就越高 这个可以算到日程里」
「这个时候再去找角色私聊就会触发事件 玩家闯入角色正在自慰的情况」。

- **挂在她今天的日程上**：`privateSlots()` 从 `getTodaySchedule()` 里挑"一个人在屋里"的非睡眠时段
  （`ALONE_PATTERNS`：一个人/独自/在家/卧室/休息/睡前…；睡眠类直接排除；短于 `minSlotMin` 的块不算），
  再在槽位里挖一个 20~40 分钟、两端留边距的窗口（`privateWindow`）。
- **概率**：`privateMomentProbability({ sensitivity, heat, affinity })` —— 敏感度是主驱动（0~0.32），
  发情模式再 +0.25，好感最多 +0.10，封顶 0.72。**判定是确定性的**（`hash01(种子, 槽位)`）⇒
  同一天多次询问结论一致，不会"刷一下她又开始了"。
- **落库**：`character_private_moments`（一天一槽一行，`UNIQUE(character_id, slot_date, slot_key)`）。
  ⚠️ 时间口径是**程序时间的分钟数**（`start_minute`/`end_minute`），不是绝对时间戳 ——
  日程本身就是程序时间，存绝对时间在"调时/跳天"之后会对不上。
- **闯入**：`routes/chat.js` 5.54c 读 `privateMomentState()`，正在窗口里就注入 `<private_moment>` 块
  （第一次撞见 = "她被你撞见"的口径；之后同一窗口换成"她还没缓过来"，避免连发三条消息重演三次），
  同时 `catchPrivateMoment()` 落 `caught_at` / `caught_times` 并给她 `+GROWTH.self_play` 的敏感度。
- **可见**：`GET /api/schedule/:id/private-moment`（单独轮询用）与 `GET /api/schedule/:id` 的
  `private_moment` 字段（日程页抽屉里显示一条"今天有一段一个人待着的时间"，不剧透内容）。

