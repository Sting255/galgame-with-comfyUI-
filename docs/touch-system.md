# SLG 动作系统（触摸互动）· 口径与实施

> **设计来源**：`目标/规划/专题-SLG动作系统.md`（冻结清单与三阶段排期）。
> **本文分工**：§1~§3、§5、§6.1 是**服务层**（task-11，写手 intimate-hypno）；§4 与 §6.2 是**前端**（task-12，写手 hires-ui）——
> 两份任务书曾把前端派给两个人，已于 2026-09-30 由 Lead 裁决：服务层 / 前端各写各的，**本文按小节分头追加，别整文件覆盖**。
> **代码行号基于 2026-09-30 工作树快照**；改动后以函数名重新定位。

## 1. 动作清单与分级（冻结，服务层唯一来源）

代码：`agent-core/src/services/touchActionService.js` 的 `TOUCH_ACTIONS`（16 个动作）。**只增不改**：`key` 是前后端与落库共用的机器键，改了等于旧数据失去含义。

| 等级 | key | 中文名 | 唤醒（睡着时做） | 看板 actKey |
| --- | --- | --- | --- | --- |
| Lv1 日常 | `pat_head` | 摸头 | — | — |
| Lv1 日常 | `pat_shoulder` | 拍拍肩 | — | — |
| Lv1 日常 | `hold_hand` | 拉手 | — | — |
| Lv1 日常 | `hug` | 抱抱 | — | — |
| Lv1 日常 | `tickle` | 挠痒痒 | ✅ | — |
| Lv1 日常 | `pinch_cheek` | 捏脸 | ✅ | — |
| Lv2 亲密 | `stroke_hair` | 摸头发 | — | — |
| Lv2 亲密 | `stroke_back` | 摸背 | — | — |
| Lv2 亲密 | `hold_waist` | 搂腰 | — | — |
| Lv2 亲密 | `kiss_cheek` | 亲脸颊 | — | — |
| Lv2 亲密 | `cuddle` | 贴贴 | — | — |
| Lv3 敏感 | `touch_breast` | 摸胸 | — | `hand` |
| Lv3 敏感 | `touch_butt` | 摸臀 | — | `hand` |
| Lv3 敏感 | `touch_thigh` | 摸大腿 | — | `hand` |
| Lv3 敏感 | `stroke_waist` | 腰部游走 | — | `hand` |
| Lv3 敏感 | `whisper_ear` | 耳后吹气 | — | —（留 null，不记账） |

两条实施说明：

1. **`stroke_waist` 的 key 是实施时补的**：专题 §1.1 只写了中文名「腰部游走」没给 key，按既有 snake_case 口径补。
2. **Lv3 的 `intimateActKey` 已裁决（2026-09-30，task-16）**：用户放权给 Lead 决断 ⇒ 「复用冻结记账管线、**不新增** `act_key`」。
   选键原则沿用仓里既有的「**宁可少归因，也不能误归因**」：摸/揉这类**手部抚摸统一落 `hand`**（手部动作大类），
   **不借部位键** —— 白名单里的 `breast`(乳交) / `thigh`(素股) / `anal`(后庭) 都是**另一种行为**，
   拿来记「摸胸 / 摸大腿 / 摸臀」会让看板数字说谎（专题 §四 原文也是这个判断：「看板 `breast` 是乳交、不是抚摸」）。
   `whisper_ear`（耳后吹气）**留 `null`**：不是手部动作、白名单里也没有吹气/耳部语义的键，宁可不记也不硬凑。
   映射表与理由见 §6.4；`TOUCH_ACTIONS` 里 `intimateActKey !== null` 的恰好 4 条（全为 Lv3 手部动作），有单测钉住。

每个动作另有：`promptDesc`（**玩家视角**一句话描述，如"你伸手轻轻摸了摸她的头"）、
`emotionDelta`（valence/arousal/dominance 瞬时心情增量，各夹 -1~1）、`wakes`（重动作标记）。

## 2. 服务层 API 清单

模块：`agent-core/src/services/touchActionService.js`。**零依赖**：不 import 任何其它模块、不碰 DB / LLM / config / chat.js；
所有需要既有系统的值（好感 / 誓约 / 催眠态 / 睡眠态 / 亲密授权 / 阈值）**由调用方读好传进来**（见 §3.1）。有源码级单测禁止它偷偷 import。

### 2.1 常量与清单

| 导出 | 形状 | 用途 |
| --- | --- | --- |
| `TOUCH_ACTIONS` | `Array<Action>`（16） | 冻结动作表；`Action = { key, label, level, promptDesc, emotionDelta:{valence,arousal,dominance}, wakes, intimateActKey }` |
| `TOUCH_ACTION_MAP` | `Record<key, Action>` | key → 定义（**不要再另建索引**） |
| `TOUCH_ACTION_KEYS` | `string[]`（16） | 白名单 |
| `TOUCH_LEVELS` | `{DAILY:1, INTIMATE:2, SENSITIVE:3}` | 分级常量（键是大写常量名，**别用值去索引它**，见 `normalizeTouchMode` 的注释） |
| `TOUCH_LEVEL_LABELS` | `{1:'Lv1 日常',2:'Lv2 亲密',3:'Lv3 敏感'}` | 前端直接显示 |
| `DEFAULT_TOUCH_THRESHOLDS` | `{lv2Affinity:40, lv3Affinity:60}` | 门控阈值默认值（专题说"可配"；本轮不碰 `config.js`，由调用方传 `thresholds` 覆盖） |
| `TOUCH_GATE_CODES` | `string[]` | 门控机器码白名单（前端按码选文案/置灰） |
| `TOUCH_REQUEST_CODES` | `string[]` | 校验机器码白名单 |
| `TOUCH_MODES` | `{AUTO:'auto', INSTANT:'instant', IMPLICIT:'implicit'}` | 反应模式取值 |
| `ANNOYANCE` | `{MIN,MAX,REPEAT_WINDOW_MS,REPEAT_GAIN,WARM_THRESHOLD,REFUSE_THRESHOLD,DECAY_PERIOD_MS,DECAY_PER_PERIOD}` | 腻烦度口径常量（要调只调这里） |
| `ANNOYANCE_TIERS` | `{FINE:'fine', WARM:'warm', REFUSING:'refusing'}` | 耐受档位 |
| `ANNOYANCE_TIER_TEXT` | `Record<tier,string>` | 档位的 prompt 措辞 |
| `INSTANT_QUOTA_NOTICE` | `string` | 即时反应额度用尽时给用户的一句话（可直接 toast） |
| `MAX_TOUCH_BLOCK_CHARS` / `MAX_REACTION_CHARS` | `900` / `300` | 注入块 / 反应正文上限 |

### 2.2 查询与校验

| 函数 | 入参 | 出参 | 用途 |
| --- | --- | --- | --- |
| `getTouchAction(actionKey)` | key | `Action \| null` | 按 key 取定义；**脏 key 返回 null 不抛**（UI 不该因为一次脏 key 整条动作条崩掉） |
| `listTouchActions({ maxLevel = 3 })` | 最高等级（越界自动夹到 1~3） | `Action[]` | "只显示到已解锁那档"；与门控同一份等级口径 |
| `normalizeTouchRequest({ actionKey, characterId, groupId, scene='chat', mode='auto' })` | 原始请求 | `{ok, code, error, actionKey, action, characterId, groupId, scene, mode}` | 路由第一道校验：`invalid_action` / `invalid_character` / `invalid_scene`（群聊缺 groupId）。取整口径与既有 `toId` 一致（`'1.5' → 1`）；`scene` 非 'group' 一律按私聊 |
| `normalizeTouchMode(mode)` | 任意 | `'auto' \| 'instant' \| 'implicit'` | mode 规范化（非法回落 auto） |

### 2.3 门控

`getTouchGate({ actionKey, affinity, isOath, hypnotized, sleeping, intimateAuthorized, scene, allowGroupAdult, thresholds })`
→ `{ allowed, code, reason, message, level, action, exempt, wakesSleeping, thresholds }`

判定顺序（**第一个没满足的条件说话**，与催眠手机 `getHypnosisGate` 同款）：

| # | 条件 | code / reason | message（人话，UI 直接显示） |
| --- | --- | --- | --- |
| 1 | 未知动作 | `unknown_action` | 没有这个动作。 |
| 2 | **催眠中 → 直接放行** | `ok` / `exempt: 'hypnosis'` | — |
| 3 | Lv1 | `ok` | — |
| 4 | 睡着 + Lv3 | `sleeping_blocked` | 她睡得很沉，翻了个身。这种时候还是别吵她比较好。 |
| 5 | 群聊 + Lv3 + 未开 `allowGroupAdult` | `group_adult_blocked` | 当着这么多人的面……这种事还是留到只有你们俩的时候吧。 |
| 6 | `affinity < 阈值` 且未誓约 | `affinity_low`（reason 分 `affinity_low_lv2` / `affinity_low_lv3`） | 她现在还不太习惯你离得这么近——先好好说会儿话吧。/ 她按住你的手，轻轻摇了摇头。你们之间还没到那一步。 |
| 7 | Lv3 且未授权 | `intimate_not_authorized` | （这一步要先在角色档案里打开「亲密」授权。） |

- `wakesSleeping`：睡着时做**重动作**（`tickle` / `pinch_cheek`）为 `true`，调用方据此挂 `temporaryWake`（服务层只给标记，不碰日程）。
- `thresholds`：与默认值浅合并，只传 `{ lv2Affinity: 10 }` 也合法。
- 催眠放行排在睡眠/群聊/授权**之前**：专题 §1.3「完全控制态下豁免门控」+ §八「催眠中点任意动作无门控」。


### 2.4 腻烦度与偏好（纯函数，时钟可注入）

| 函数 | 入参 | 出参 | 口径 |
| --- | --- | --- | --- |
| `nextAnnoyance({ current, lastAt, now, likeRatio })` | 当前值 / 上次同一动作的毫秒时间戳 / 现在 / 偏好倍率 | `{annoyance, tier, decayed, gain, repeated, elapsedMs}` | 先按流逝时间衰减，再判"是否连点"。**只算不落库**（落库要两张表，服务层不碰 DB）。 |
| `decayAnnoyance(annoyance, elapsedMs)` | 值 / 流逝毫秒 | `number` | 每 30 分钟 -10，不足一周期不减，地板 0 |
| `annoyanceTier(annoyance)` | 0~100 | `'fine' \| 'warm' \| 'refusing'` | >80 拒绝、>50 变冷、其余正常 |
| `likeGainScale(likeRatio)` | 偏好倍率 | `number` | `1/likeRatio` 夹在 [0.5, 2]：喜欢涨得慢、讨厌涨得快 |
| `likeRatioText(likeRatio)` | 偏好倍率 | `string` | prompt 措辞（受用 / 谈不上偏好 / 并不喜欢） |
| `clampAnnoyance(value)` | 任意 | `0~100` | 夹取 |

**叠加曲线（likeRatio = 1、10 分钟内连点）**：0 → 20 → 40 → 60(warm) → 80(warm) → 100(refusing)；第 4~5 次明显，与专题 §八 的真机口径一致。
**窗口外**（> 10 分钟）不叠加，只吃衰减；**偏好修正**：1.3 → 每次 ~15.4，0.5 → 每次 40。
**偏差说明**：专题 §2.3 举例是"喜欢被摸头 → 增速 ×0.5"，实现用连续的 `1/likeRatio`（1.3 → 0.77 而不是 0.5）——
因为 `like_ratio` 是"默认 1.0 + 可微调"的连续值，离散档位对不上；要严格对齐就改 `likeGainScale` 一处。

### 2.5 反应模式回落

`resolveTouchMode({ mode = 'auto', instantEnabled = true, quotaExhausted = false })` → `{ mode, fallback, notice, reason }`

- `auto` → 看 `instantEnabled`（"省额度模式"开关）与 `quotaExhausted`；
- 显式 `instant` 但额度用完 → **仍回落** `implicit` + `notice = INSTANT_QUOTA_NOTICE`（专题：耗尽自动回落并提示）；
- 显式 `implicit` → 不消耗额度。

**配额计数本身不在这里**（那是运行期状态，归路由/设置层），本函数只回答"这一次走哪条路"。

### 2.6 注入块与 prompt 构造

| 函数 | 入参 | 出参 | 用途 |
| --- | --- | --- | --- |
| `buildTouchActionBlock({ actionKey, userName, mode, annoyance, likeRatio, hypnotized, sleeping, hypnosisBlock })` | 见左 | `string`（`''` = 不注入） | 挂进聊天 `dynamicBlocks` 的 `<touch_action>` 块（**隐式注入模式**） |
| `buildReactionPrompt({ actionKey, persona, characterName, userName, emotionText, likeRatio, annoyance, recentLines, scene, groupPeek, sleeping, hypnosisBlock })` | 见左 | `{ system, user, messages, label }` | **即时反应**轻量调用（专题 §2.1）的请求体；只构造不发请求 |
| `describeAction(actionOrKey)` | key 或定义 | `string` | 玩家视角描述（日志 / tooltip） |
| `describeActionForTarget(actionOrKey, { userName })` | 同上 | `string` | 转成第二人称（"Tester 伸手轻轻摸了摸**你**的头"） |

两种模式的措辞**必须分开**（专题 §七"抢戏"风险）：

- `mode='implicit'`：块里写"把这一下的即时反应**写进你这一轮的回复里**"；
- `mode='instant'`：块里写"**已经单独发过了**，不要再重演一遍：优先回应他说的话"。

催眠中：块里换成"无条件顺从，不做抗拒/腻烦反应"，且**不写**耐受/偏好行；调用方给的 `hypnosisBlock` 会**追加在块之后**（位置口径与 chat.js 的催眠块后置一致——本模块不 import `hypnosisPrompt`，由调用方传字符串）。

`buildReactionPrompt` 的 JSON 示例按 AGENTS.md「LLM 输出」节给全：`reaction_text` / `emotion_delta` / `facial_expression` / `annoyed` 四字段 + 逐字段约束 + "只输出 JSON"。

### 2.7 输出解析

| 函数 | 用途 |
| --- | --- |
| `parseReactionOutput(text)` | → `{ ok, error, reactionText, emotionDelta, facialExpression, annoyed }`；容忍 json 代码块包裹与前后夹话；越界夹到 -1~1；`emotion_delta` 缺失给 `null`（**调用方据此跳过 evolveEmotion**）；`reaction_text` 非字符串或空 → `ok:false`（不写脏数据） |
| `extractReactionText(text)` | 只要正文（实时消息流用；解析失败返回 `''`，绝不把 JSON 漏给用户） |

## 3. 接线说明（给 Lead：照这段做即可）

### 3.1 既有值的读法（服务层不 import，全在调用方读）

| 门控入参 | 从哪读 |
| --- | --- |
| `affinity` | `emotionEngine.loadAffinity(characterId)` |
| `isOath` | `emotionEngine.loadOath(characterId)` |
| `hypnotized` | `hypnosisService.isBodyControlled(characterId)`（身体受控且未过期） |
| `sleeping` | `scheduleManager.isSleeping(characterId)` |
| `intimateAuthorized` | `intimateService.isAiEditAllowed(characterId, 'stats')`（Lv3 授权口径同亲密看板自动记账） |
| `sleeping 的唤醒` | 门控返回 `wakesSleeping: true` 时调 `scheduleManager.tempWake(id, { mode: 'phone', minutes })`（参照催眠手机 `wakeForForcedTrigger`） |

### 3.2 路由 `routes/touch.js`（Lead 新建；服务层不碰它）

```text
POST /api/characters/:id/touch/:action    body { mode?: 'auto'|'instant'|'implicit' }
GET  /api/characters/:id/touch/state      → 每个动作的 { annoyance, tier, likeRatio } + 配额 + pendingCount（阶段二面板用）
```

POST 的建议流程（每一步都能在本模块找到对应函数）：

1. `normalizeTouchRequest({ actionKey, characterId })` → 失败直接 400（`error` 就是机器码）。
2. 读 §3.1 的五个值 → `getTouchGate({...})` → 不 `allowed` 就返回 `{ allowed:false, code, message }`（前端直接 toast `message`，别自己造文案）。
3. 读上次状态 `character_touch_state(character_id, action_key)` 的 `(annoyance, like_ratio, updated_at)` →
   `nextAnnoyance({ current, lastAt, now: Date.now(), likeRatio })` → 落库新值（**表由你建**：本模块不碰 `db/index.js`）。
4. `resolveTouchMode({ mode, instantEnabled(设置开关), quotaExhausted(你的独立计数器) })`：
   - `instant` → 小调用（`buildReactionPrompt` → `chatSync/getLlm...` → `parseReactionOutput`）；
   - `implicit` → 不调模型，写一条 `touch_events(status='pending')` 等下一轮聊天消费。
5. 落 `touch_events(id, char_id, group_id, action_key, at, reaction, status)`；即时模式把 `reaction_text` 作为她的消息发出（带动作标记）。
6. 心情：`parseReactionOutput` 的 `emotionDelta`（没有就用动作定义里的 `emotionDelta`）喂
   `evolveEmotion(current, delta, baseline)` + `saveEmotionSnapshot(conversationId, afterMsgId, ...)`。
   ⚠️ **专题写的 `emotionEngine.applyInstant` 在本仓库不存在**；快照锚点要用 `messages.id`（拿 `raw_messages.id` 会撞 FK，催眠手机 `nudgeEmotionForClimax` 踩过这个坑）。
7. Lv3 记账：**等用户裁决**（§1 第 2 条）后再接 `recordIntimateActs`，幂等锚点建议 `touch:` + `touch_events.id`。

### 3.3 `chat.js` 里该在哪一步注入什么（**最重要的一段**）

1. **读待反应的动作**：本轮开始时查 `touch_events WHERE char_id=? AND status='pending' ORDER BY id DESC LIMIT 1`（群聊按 `group_id` 与 target 过滤）。
2. **构造注入块**（在那里、紧挨着既有的 `<intimate_profile>` 注入之后加，**不要**塞进最后那段催眠块后置里——催眠块是"最硬约束"，动作块是叙事提示，位置该在它前面）：
   ```js
   if (config.features.touch !== false) {
     try {
       const pending = takePendingTouch(characterId);            // 你的读表函数
       if (pending) {
         const block = buildTouchActionBlock({
           actionKey: pending.actionKey,
           userName: chatUserName,
           mode: 'implicit',                                        // 隐式口径
           annoyance: pending.annoyance,
           likeRatio: pending.likeRatio,
           hypnotized: hypnoState?.active === true && hypnoState?.bodyControlled === true,
           sleeping: isSleeping(characterId),
           hypnosisBlock: stateBlock,                               // chat.js 已经有这一块；不传也行
         });
         if (block) dynamicBlocks.push(block);
       }
     } catch (err) { console.warn('[touch] action block inject failed:', err.message); }
   }
   ```
   要点：① `if (block)` 才 push（空串=未知动作，不许注入空气块）；② 整段 try/catch（记账/注入是旁路，绝不能影响聊天主流程）；
   ③ 放在 `features.touch` 守卫内（开关由你在 `config.js` + `db/settings.js` 加，服务层不碰）。
3. **即时反应模式下的轮次**：如果这一轮的动作已经由路由**单独发过反应消息**（`touch_events.status='done'`），
   注入时传 `mode: 'instant'` —— 块里会写"别再演一遍，优先回应用户的文字"（专题 §七 的抢戏风险就靠这个区分）。
4. **消费即完成**：注入成功后把那条 `touch_events.status` 置 `'injected'`（或 `'done'`）——**一次动作只注入一次**，
   否则她会把同一摸演一整晚。
5. **不需要改的地方**：生图判断、情绪评估、回复猜想、长度闸门都不用动；动作块只是一段 dynamicBlock。
   ⚠️ 但注意 `<reply_length>`：催眠轮已经用 `` 覆盖过长度（task-42）；动作轮的"演出来"如果被10~60字切短，
   参照同一手法加一段 `<reply_length_override>`（服务层不生产这个块，需要的话在 chat.js 拼）。

### 3.4 出图联动（task-19 · 阶段三）

**档位设置键**（三态，走**通用** `PUT /api/config/features`，键在 `config.features` 里所以白名单自动通过）：

| 项 | 值 |
| --- | --- |
| config 键 | `config.features.touchImageMode`（`config.js`） |
| 取值 | `always`（总是）/ `smart`（智能）/ `never`（从不） |
| 默认 | **`smart`**（用户裁决） |
| env | `FEATURE_TOUCH_IMAGE_MODE` |
| 落库键 | `feature_touchImageMode`（`db/settings.js`，type string） |
| 校验 | `touchActionService.normalizeTouchImageMode()`：非三态值一律回落 `smart`（`updateFeatureFlag` 用同一白名单） |
| GET | `GET /api/config` 的 `features.touchImageMode`；`GET /touch/actions` / `GET /touch/stats` 也各回一份 `features.imageMode` |
| PUT | `PUT /api/config/features` body `{ key: 'touchImageMode', value: 'always' }` → `{ ok: true, features }` |

**判定口径**（纯函数 `shouldGenerateTouchImage({ mode, level, random, enabled })`）：

| 档位 | 行为 |
| --- | --- |
| `never` | 一次都不出图（生成器都不调；与加功能前逐字节一致，有测试钉住） |
| `smart` | **只对 Lv2 / Lv3 按概率出图**：Lv2 **25%**、Lv3 **50%**（`SMART_IMAGE_CHANCE`），Lv1 永不 |
| `always` | 每次动作都出图（含 Lv1） |
| 任意档位 + `imageGenMode === 'off'` | 都不出图（**尊重既有出图总开关**；本仓没有图片配额概念，故只有这一个总闸） |

**接线**：`routes/touch.js` 的即时反应成功后
· prompt = `buildTouchImagePrompt({ actionKey, appearance, reactionText, annoyance, scene })`（英文画面句 + 反应原文最多 60 字 + `characterPersona.buildCharacterAppearanceSection` 外观块）；
· 生成走 `imageSkill.generateImage`（与 chat.js 同一条链：loras / customWorkflow / 画师串），落盘 `saveBase64Image`，挂到那条反应消息的 `messages.images`，并记一条 `image_tasks`（`style='touch-action'`）；
· **私聊**：先出图再广播（`proactive_message` 没有 update 事件，二次广播会重复气泡）；**群聊**：文字先广播（`group_message`），图好了再 `broadcast('group_message_update', { ...payload, images })`（与 `groupChatEngine` 既有挂图方式一致）；
· 失败一律只 warn：**动作本身（事件、反应消息、记账、看板）不受影响**（有测试钉住）；
· 响应新增 `images: string[]` 与 `imageMode`；测试接缝 `routes/touch.js` 的 `__setTouchImageGeneratorForTest(fn)`（假生成器不连 ComfyUI、不落盘）。

### 3.5 立绘表情联动（task-19）

立绘是**服务端独占**通道：只有 `services/standingDisplay.js` 的 `publishStandingKeys(turn, keys)` 能推表情，前端只有 `GET /standing-display/state` 与 `PUT /standing-display/active`。

`routes/touch.js` 的 `driveStandingExpression(characterId, facialExpression)`：

1. 用 `emojiService.getCharacterEmojiMap(characterId)` 拿她的表情包 key（key 就是中文名，如「害羞」）；
2. 与即时反应里的 `facial_expression` **匹配**：精确 → 被包含 → 包含；**匹配不到就跳过**（不报错、不猜）；
3. 命中则 `getStandingDisplay().select(characterId)` → `begin()` → `publishStandingKeys(turn, [key])` → `complete()`（`chat.js` 同一条通道，零新造）；
4. 响应字段 `standingExpression` = 命中的 key（`null` = 没命中/没有表情包）。

### 3.6 统计端点 `GET /api/characters/:id/touch/stats`（task-19）

只读；**不受总开关影响**（关掉功能也能看历史）。query：`days`（默认 14，1~90 夹取）、`recent`（默认 10，0~50）。
角色不存在 = 404；非法 id = 400。服务层 `services/touchStatsService.getTouchStats()`。

```jsonc
{
  "characterId": 7,
  "generatedAt": "2026-09-30T12:00:00.000Z",
  "range": { "days": 14, "from": "2026-09-16T12:00:00.000Z" },
  "totals": {
    "events": 12, "injected": 9, "pending": 1, "done": 3, "expired": 1, "dropped": 0,
    "byMode": { "instant": 5, "implicit": 7 },
    "peakAnnoyance": 80,
    "images": 4,          // image_tasks(style='touch-action') 里私聊会话 char_<id> 的条数
    "intimateActs": 3     // character_intimate_log 里 source_uid LIKE 'touch:%' 的笔数
  },
  "byAction": [{
    "actionKey": "pat_head", "label": "摸头", "level": 1, "levelLabel": "Lv1 日常",
    "intimateActKey": null,
    "count": 5, "lastAt": "2026-09-30T11:00:00.000Z",
    "byMode": { "instant": 2, "implicit": 3 },
    "byStatus": { "pending": 0, "done": 2, "injected": 3, "expired": 0, "dropped": 0 },
    "peakAnnoyance": 80, "avgAnnoyance": 53,
    "currentAnnoyance": 65, "annoyanceTier": "warm", "likeRatio": 0.9,
    "images": 0, "intimateActs": 0
  }],
  "byLevel": [{ "level": 1, "label": "Lv1 日常", "count": 8 }],
  "daily": [{ "date": "2026-09-30", "count": 5 }],   // 最近 days 天里**有数据**的天（按 UTC 日期）
  "recent": [{
    "id": 12, "actionKey": "hug", "label": "抱抱", "level": 1,
    "mode": "implicit", "status": "injected",
    "annoyance": 40, "annoyanceTier": "warm", "likeRatio": 1,
    "reaction": "她缩了缩脖子。", "facialExpression": "害羞",
    "createdAt": "2026-09-30T11:59:00.000Z"
  }],
  "features": { "touch": true, "instant": true, "groupAdult": false, "imageMode": "smart" },
  "imageModeLabels": { "always": "总是", "smart": "智能", "never": "从不" }
}
```

口径备注：`byAction` 按次数倒序（同数按 key 升序）；`avgAnnoyance` 是**按分组计数加权**的平均再四舍五入；
`peakAnnoyance` 取该动作全量最大（不限 days）；`daily` 用 SQLite 的无时区 UTC 串前 10 位（跨时区展示由前端决定）；
空数据一律返回 0 / 空数组（不是 null）。

### 3.8 事件消费顺序 / 新鲜度 / 待回应计数 / 动作偏好（task-24）

**① 消费顺序 = ASC（先点先演）**

私聊链与群聊链**同一口径**：用户连点三个动作时，先点的先演。实现落在 `services/touchEventStore.js` 的
`takePendingTouchEvent(characterId)`（`ORDER BY id ASC LIMIT 1`）；群聊侧是 `groupChatEngine` 的同款语义。

- 只认私聊：`group_id IS NULL`（群聊事件由群聊链消费）；
- `status IN ('pending','done')` 都会被消费 —— `done`（即时已单独发过）注入的是「已发过别再演」块，
  改 ASC 后**旧的 done 块可能延迟一轮注入**，属刻意接受的弱影响（不为它加复杂分支）；
- 读完置 `injected`（`markTouchEventInjected`）⇒ **一次动作只注入一次**。

**② 新鲜度窗口（不变）**：超过 `TOUCH_EVENT_TTL_MS`（30 分钟）的 pending/done 标 `expired` 且不再注入。
判定只有一处 `touchActionService.touchEventCutoff()`；清扫在 `routes/touch.js` 的每个入口 + 读事件时各扫一次。

**③ `pendingCount`（前端「还有 N 个动作等她回应」）**

`GET /api/characters/:id/touch/state` 返回体新增字段：

| 字段 | 口径 |
| --- | --- |
| `pendingCount` | **生效场景**下**还没反应**的条数：不传参数 = 私聊（该角色 `group_id IS NULL`）；`scene=group&groupId=n` = **该群全体**（`group_id = n`，不按 character 过滤）。口径 = **只数 `status = 'pending'`**；`done` / `injected` / `expired` / `dropped` 都不算（见下「2026-09-30 口径修正」） |
| `pendingCounts.chat` | 私聊口径计数（**永远返回**，与不传参数时同口径） |
| `pendingCounts.group` | 群聊口径计数（仅在 `scene=group&groupId` 时返回，否则 `null`） |
| `pendingByMode` | **生效场景**下按 mode 分开的 pending：`{ instant, implicit }`（2026-09-30 新增）。前端分文案用：`implicit` 才是「她还没回应你的动作，跟她说句话吧」；即时动作本来就不需要「等回应」提示 |
| `scene` / `groupId` | 生效场景与生效群；私聊时 `scene:'chat'`、`groupId:null` |

**2026-09-30 口径修正（真机问题 3：只涨不减）**

- 旧口径是 `status IN ('pending','done')`（"还没注入过"）—— 但**即时反应成功后事件就是 `done`**（反应已作为独立消息发出去了），
  它要等**下一轮聊天**被消费才变 `injected` ⇒ 用户不回话时计数**只涨不减**（30 分钟 TTL 内连过期都不会），与「反应已发」的事实矛盾。
- 现在 **`done` 不算「等她回应」**：`pendingCount` / `pendingCounts` / `pendingByMode` 一律**只数 `status='pending'`**（隐式动作还没演的那条才是真「等」）。
- ⚠️ **只改计数，不改消费**：`takePendingTouchEvent` 仍然吃 `pending + done`（`done` 要注入「已发过别再演」块，见上面 ①；
  `expireStaleTouchEvents` / `touchEventCutoff` 的窗口判断也照旧吃两者）。消费一条 `done` **不会**让计数变化（它本来就没算）。

**按场景查询（task-28 复审问题 2）**：

```
GET /api/characters/:id/touch/state                        → 私聊口径（旧行为，逐字节不变）
GET /api/characters/:id/touch/state?scene=group&groupId=12 → 群聊口径（该群全体）
```

- `scene` 只认 `'group'`（其它/缺省 = `chat`）；`scene=group` 时 `groupId` 必须是**严格正整数**，否则 **400 `{error:'invalid group id', code:'INVALID_GROUP_ID'}`**（显式契约，不静默回落）。
  **严格 = `String(raw).trim()` 后必须全是数字（`/^\d+$/`）且 > 0**：`1.5`（曾被 `parseInt` 截成 1 ⇒ 200）、`3abc`、`+3`、`-1`、`1e3`、`0`、`abc`、`1.0` 一律 400；`' 3 '`（首尾空白）trim 后合法 ⇒ 200。判定函数 `touchEventStore.parseStrictGroupId()`（路由与 store 共用同一处）。
- **过期清扫**：私聊口径扫 `{characterId}`；群聊口径**两个作用域都扫**（`{characterId}` + `{groupId}`），保证 `pendingCount`（群）与 `pendingCounts.chat` 都不含 30 分钟前的僵尸事件。
- 前端读不到 `pendingCount` 就当 0（既有实现，无需改）；群聊页要用群聊口径就带 `?scene=group&groupId=<当前群>`。

**④ 动作偏好 `like_ratio`（P1-1：从死字段变成真数据）**

改动前 `like_ratio` 永远是 1（没人写非 1 值）⇒ 全角色手感一致、【你的偏好】永远「谈不上偏好（1.00）」。现在：

| 环节 | 规则 |
| --- | --- |
| 初始化 | **首次对该角色做动作**时一次批量调用：人格卡 + 16 条动作清单 → JSON `{"<action_key>": 0.5~1.5}`（prompt 含**完整 JSON 示例**，AGENTS.md 要求）。只认合法动作 key，越界夹到 `[0.5, 1.5]`，缺的键补 1（保证 16 行齐全） |
| 幂等 | 成功后落 `system_settings.touch_like_ratio_init_<characterId> = '1'`；有标记就不再调。**失败不落标记** ⇒ 下次动作会重试 |
| 微调 | 每次即时反应：`annoyed=true` → 该动作 ×0.95（下限 **0.5**）；`emotion_delta.valence > 0.1` → ×1.05（上限 **2**）。两条独立判定，同轮都满足依次生效 |
| 失败语义 | 初始化 / 微调只 `warn`，**绝不影响动作本身**（事件、反应消息、记账照常） |
| 省额度模式 | `features.touchInstant === false` 时**跳过初始化**（该模式承诺"一次模型都不调"） |
| 不计配额 | 初始化不消耗 `touch_instant_quota`（那是"反应"的配额；初始化是每角色一次性的设定） |

相关实现：`routes/touch.js` 的 `ensureTouchLikeRatios()` / `parseLikeRatioInit()` / `tuneTouchLikeRatio()`；
标记前缀常量 `TOUCH_LIKE_RATIO_INIT_KEY_PREFIX`；区间常量 `TOUCH_LIKE_RATIO_INIT_MIN/MAX`、`TOUCH_LIKE_RATIO_FLOOR/CEIL`。

**⑤ 配额日期吃哪个钟（核实结论，审查 §四 #1）**

结论：**两条链都吃真实本地日期，两者本来就一致，本轮无需改口径**。

- `intimateAiJudge.localDateKey(date = new Date())`（`services/intimateAiJudge.js:86`）按 `getFullYear/getMonth/getDate` 取**本地**日期；
- `routes/touch.js` 的配额用 `programTime.localDateKey(now)`（`services/programTime.js:81`）—— 它同样是"把传入的 `Date` 按本地日期格式化"的纯函数，
  **不读程序时间偏移**（吃偏移的是 `programTime.getProgramNow()` / `toProgramTime()`，配额没调它们）；
- 所以"程序时间 +3 天 ⇒ 配额翻篇回满"**不成立**；回归测试 `test/touchImageStats.test.js` 的「P1-2 配额日期口径」把这条钉住了。

**⑥ 群聊动作的心情锚点（审查 §四 #2）**：`applyTouchEmotion` 的快照永远挂 `char_<id>` 会话，
群聊路径**传 `afterMsgId: null`**（不再喂群 `messages.id`），由 `resolveLastMessageId('char_<id>')` 回落到私聊会话最后一条。

### 3.7 群聊围观概率设置键（task-22 的概率模型 · task-19 补键）

| 项 | 值 |
| --- | --- |
| config 键 | `config.features.touchBystanderChance`（`config.js`） |
| 默认 | **`0.3`**（30% 概率让 1 名其他成员插一句话） |
| env | `FEATURE_TOUCH_BYSTANDER_CHANCE` |
| 落库键 | `feature_touchBystanderChance`（`db/settings.js`，type **float**） |
| 关闭 | 置 `null` / `'off'`（`PUT /api/config/features` 传 `null` 或 `'off'`）⇒ 围观退回 task-17 的「最多 1 人」纯 prompt 口径，**逐字节一致** |
| 校验 | `PUT` 侧 0~1 夹取；读取侧 `groupChatEngine.resolveTouchBystanderChance()`：`null/false` = 关闭、非数字回落 0.3、0~1 夹取 |
| 消费方 | `groupChatEngine.collectTouchActionBlocks()` 的 `bystander`（`planTouchBystander` 掷一次骰子），只读本键 |

前端设置项（滑块）留给 task-20 收口后另派；本键的价值是**能被 system_settings 覆盖**（`loadSystemSettings` 是白名单式的）。

## 4. 前端（task-12 · hires-ui 写）

**文件**

| 文件 | 作用 |
| --- | --- |
| `web-ui/src/components/touchActionLogic.js` | 纯逻辑：镜像清单 / 门控 / 文案 + **服务端响应归一化**（`buildGroupsFromServer` / `normalizeServerGate`）；导出 `TOUCH_ACTIONS` / `TOUCH_LEVELS` / `DEFAULT_GATE_THRESHOLDS` / `TOUCH_GATE_CODES` / `GATE_MESSAGES` / `resolveActionGate` / `buildActionGroups` / `countAvailableActions` / `findTouchAction` / `gateMessage` |
| `web-ui/src/components/TouchActionBar.vue` | 胶囊条组件：收起为「动作」按钮（带解锁数角标），展开为按分级（日常 / 亲密 / 敏感）分组、可横滑的 LinsheButton `chip`；**`serverGroups` 优先、镜像兜底**；展开时 `emit('open')` 让父组件刷新门控 |
| `web-ui/src/api/index.js` | 三个封装：`fetchTouchActions` / `fetchTouchState` / `performTouchAction`（注释里写明「门控拒绝是 200 不是 4xx」） |
| `web-ui/src/views/ChatView.vue` | 局部加法（不改输入区）：模板在 `.guesses-row` 与 `.input-area` 之间插入 `<TouchActionBar>`；脚本 `loadTouchActions`（切角色 / 展开时拉服务端）与 `onTouchAction`（POST 上报 + toast + busy） |
| `web-ui/test/touchActionBar.test.js`、`web-ui/test/touchActionWiring.test.js`（新） | **43 例全绿**（纯净逻辑 + 服务层契约 + 服务端优先/兜底 + `onTouchAction` 真跑 + api 请求形状） |

**门控来源：服务端优先，镜像兜底（2026-09-30 task-15 接线后）**

- **正常路径**吃 `GET /api/characters/:id/touch/actions`：响应里逐 key 的 `gate` 就是服务层 `getTouchGate` 的真实结果
  （含催眠豁免与 Lv3 亲密看板授权）⇒ 前端**零翻译、零自算**，`code` / `message` 原样用。清单也用服务端的，
  服务层加了动作前端自动跟上，不必等镜像表同步。
- **兜底路径**（端点不可用 / 早期加载 / 某条 gate 字段缺失）才回落到本文件的镜像门控。镜像的**字段名、机器码、判定顺序刻意与服务层逐一对齐**：
  - 入参同名：`affinity` / `isOath` / `hypnotized` / `sleeping` / `intimateAuthorized` / `scene` / `allowGroupAdult` / `thresholds`
  - 出参同形：`{ allowed, code, message, wakesSleeping, level, exempt }`（另带 `source: 'server' | 'mirror'`，便于测试断言与线上排查）
  - `code` 取值就是 `TOUCH_GATE_CODES`：`ok` / `unknown_action` / `affinity_low` / `sleeping_blocked` / `group_adult_blocked` / `intimate_not_authorized`
  - 判定顺序同 `getTouchGate`：催眠豁免 → Lv1 放行 → 睡着 + Lv3 → 群聊 + Lv3 → 好感 / 誓约 → Lv3 亲密看板授权
- `normalizeServerGate` 口径：**只要服务端给了布尔 `allowed` 就以服务端为准**（哪怕与镜像算出来的相反）；字段缺失才回落镜像。

**契约测试钉住的漂移面**（`web-ui/test/touchActionBar.test.js` 直接解析 `touchActionService.js` 源码断言）：
动作 `key` / 中文名 / 等级 / `wakes` / 顺序逐条一致、`TOUCH_GATE_CODES` 完全一致、`DEFAULT_TOUCH_THRESHOLDS` 一致。
服务层加动作或改机器码而前端没跟上 ⇒ **测试直接红**，不会静默漏显示。（独立检出拿不到服务层文件时这几条会 skip，不误报。）

**接线（已完成 · task-15）**

1. `ChatView.loadTouchActions()`：切角色（`watch(chat.activeCharId, …, { immediate: true })`）与动作条展开（模板 `@open`）时拉 `GET .../touch/actions`，用 `buildGroupsFromServer` 规范化后喂给组件；拉取失败则清空 → 组件自动回落镜像门控。展开时要刷新，因为门控随好感 / 睡眠 / 誓约变化。
2. `ChatView.onTouchAction(actionId)`：POST `/api/characters/:id/touch/:action`（body `{ scene: 'chat' }`）。
   - **门控拒绝 = 200 + `{ allowed:false, code, message }`** ⇒ 直接 `toast(message, 'info')`，**绝不伪造她的反应**；
   - 成功 instant：反应已由后端 `writeProactiveMessage` 落库 + `broadcastProactiveMessage` 广播，本页既有链路（`App.vue` → `chat.handleProactiveMessage`）会把它当「她的新消息」插进消息流 ⇒ **前端不手动渲染、不重复插入**（避免与广播打架）；
   - 回落隐式（`mode === 'implicit'`）或响应带 `notice` ⇒ 提示「她的反应会在你下次发言时出现」；
   - 400 / 404 / 409 ⇒ `toast(err.message, 'error')`；请求期间 `touchBusyAction` 置为该 key（该胶囊转 loading）并忽略连点；`finally` 清 busy + 重拉门控。
3. `touchGateState`（镜像入参）保留但**只在兜底路径生效**：`intimateAuthorized` / `hypnotized` 前端仍无独立来源，兜底时按保守值处理 —— 正常路径不受影响，因为服务端 gate 已把这两个因素算进结果里。

**UI 口径**：按钮一律 Linshe 组件（模板内无裸 `<button>`）；颜色只用 `--text-secondary` / `--text-bright` 等 token，暖色 / 暗夜双主题自适应；展开收起 **0.3s** 过渡（opacity + translateX，不触发布局高度跳变）；767px 断点 + `overflow-x: auto` 横滑、隐藏滚动条；门控不满足只降 `opacity` + `aria-disabled`（**不覆盖 LinsheButton 皮肤**），并且**保持可点**以给出剧情化提示（专题 §3.1「置灰 + 点击给一句 toast」）。

**群聊（阶段二 · task-18）**

同一个 `TouchActionBar` 复用，只多两件事：

- **先选「对谁」**：群聊是多人，`requiresTarget = true` 时多一个「对 XXX」胶囊；点它 `emit('pick-target')`，由群聊页用它**既有的 @提及成员面板**选人 —— 同一份 `store.activeGroup.members`、同一套 `.mention-panel` / `.mention-item` / `.mention-avatar` 类名与 `useMentionPicker`（`{ includeAll: false }`，动作只能对具体成员做，不能对「全体成员」），**没有另造视觉**。展开时若还没选对象，自动把面板甩出来（少一次点击）。
- **口径差异**：门控取 `GET .../touch/actions?scene=group` ⇒ 服务端会对 Lv3 给 `group_adult_blocked`（专题 §2.2「群聊 Lv3 默认拦截」；前端 `allowGroupAdult` 保持 false，因为还没有对应设置项）。上报走 `POST /api/characters/:id/touch/:action`，body 带 `{ scene: 'group', groupId }`。
- **反应**：后端（task-17）把这条反应写进 `group_<gid>` 会话并 `broadcast('group_message')`，群聊页既有监听（`stores/groups.js:573` → `_enqueue`）会把它渲染成**该成员的气泡** ⇒ 前端**不自己插消息**（与私聊同一条纪律）。

**阶段三（task-20）**

- **统计面板**：`TouchStatsPanel.vue`（新）挂在 `CharacterDetailModal.vue` 的「触摸互动」小节；数据 `GET .../touch/stats`（形状见 §6.8）。拉不到 / 没记录一律走**中性空态**，不弹错、不伪造数字。
- **出图档位**：设置页「动作系统（触摸互动）」卡片里用 **LinsheTabs** 做三档（总是 / 智能 / 从不，默认智能），键 `features.touchImageMode`，走通用 `PUT /api/config/features`；失败回滚到上一档。
- **立绘表情**：前端**不写任何表情代码** —— 立绘表情是服务端独占通道（`publishStandingKeys`），后端已在 `routes/touch.js` 按 `facial_expression` 驱动（§6.8 有断言）。前端只保证「不自己动立绘、不自己插消息」。

## 5. 验证（服务层）

- L1：`cd agent-core` + ```DB_PATH=':memory:'``` + ```runtime\nodejs\node.exe --test --test-concurrency=1 test/touchActionService.test.js```
  → **27 tests / 27 pass / 0 fail / 0 skipped（~160ms）**。覆盖：清单契约、参数校验、门控矩阵（1~3 档 × 好感 0/39/40/59/60 × 誓约 × 催眠 × 睡眠 × 群聊 × 授权）、
  腻烦叠加曲线与衰减、偏好修正、档位阈值、模式回落、注入块两种口径、prompt 四字段 JSON 示例、解析容错（代码块包裹 / 夹话 / 坏 JSON / 越界 / 别名 / 截断）、
  以及"服务层零依赖、Lv3 映射留白"的源码级断言。
- L2/L5/L6 见专题 §六（全量与真机由 Lead 统一跑；服务层没有可点的 UI，L6 属前端）。

## 6. 实施记录

<!-- 2026-09-30 补回：以下实施记录在本轮被误删（整体重写文档造成）。
     来源：§6.5~§6.8 逐字节取自提交 f3b5685，§6.10 逐字节取自提交 560d308。
     §6.9（task-25 前端曲线 + 手册）**从未进入任何提交 / 分支 / stash**，无法从 git 恢复 ——
     已由 task-25 写手（hires-ui）按记忆于 2026-09-30 补回正文，见下。 -->

### 6.1 服务层（2026-09-30，task-11，写手 intimate-hypno）

- **新建** `agent-core/src/services/touchActionService.js`（33 个导出，零依赖纯函数 + prompt 构造）；
  `agent-core/test/touchActionService.test.js`（27 例全绿）；本文 §1~§3、§5。
- **与专题的偏差（5 条，都需要 Lead/用户知道）**：
  1. **Lv3 → 看板 actKey 未定**（专题 §四 要求单独裁决）⇒ 全部留 `null`，服务层不接线、不擅自记一笔。
  2. **`emotionEngine.applyInstant` 不存在**（专题 §四 写的）⇒ 接线改用 `evolveEmotion` + `saveEmotionSnapshot`（§3.2 第 6 步）。
  3. **人格块来源冲突**：AGENTS.md 说非生图用途不套 `characterPersona`，专题 §2.1 建议 `buildCharacterPersona(variant:'short')`
     ⇒ 服务层只吃 `persona` 字符串，不替调用方选（`buildReactionPrompt` 的注释里写明）。
  4. **睡眠时 Lv2 的"部分"没定义**（专题 §1.3 第 4 行"只能做 Lv1 + Lv2 部分"）⇒ 实现按"睡着时 Lv1/Lv2 全放行、只有 Lv3 拦"
     + `wakesSleeping` 标记重动作；若用户要的是"睡着时 Lv2 也要挑动作"，改 `getTouchGate` 一处。
  5. **两张表的名字在专题里前后不一致**：§1.2 写 `character_touch_preferences(character_id, action_key, like_ratio)`、
     §四 写 `character_touch_state(char_id, action_key, annoyance, like_ratio, updated_at)` ⇒ 建表时按后者（含 annoyance）一张表即可，
     服务层不碰 DB，只吃 `likeRatio` / `annoyance`。
  6. 补了 `stroke_waist` 的 key（专题只给中文名）；`likeGainScale` 用连续 `1/likeRatio` 而非专题举例的离散 ×0.5。
- **未做（明确不在本轮范围）**：`routes/touch.js`、两张表、即时反应的 LLM 实调与每日配额计数、
  `chat.js` / `config.js` / `db/settings.js` 的任何改动、`web-ui/**` 任何文件（前端归 task-12）。
- 验证数字：见 §5。真实库未动（服务层测试根本不需要 DB）。

### 6.2 前端（task-12 · hires-ui）

> （2026-09-30 交互改版后入口已变，见 **§6.13**；本节描述的是**改版前**的常驻动作条形态，保留作历史。）
> 改版落地后：`TouchActionBar.vue` 与其测试**已删除**，功能迁到 `TouchActionPanel.vue`（✋ 图标 + 底部弹层大卡片）；本节下方出现的 `TouchActionBar` / `.touch-bar` 字样均指改版前的形态。

**改版带出的一处接口偏离（Lead 2026-09-30 批准）**：面板的 props 与旧动作条同形（`serverGroups` / `state` / `busyAction` / `actions` / `targetName` / `requiresTarget` / `pendingCount`），
但专题 §3.3-1「与旧条同形」与 §3.2「卡片底部显示耐受档、右上角显示偏好角标」**自相矛盾** —— 耐受 / 偏好数据在 `GET .../touch/state` 的 `states[key]`（`annoyance` / `tier` / `likeRatio`）里，
而旧动作条**从未取过**这份数据。故按卡片需求**新增 `states` prop**（默认 `{}`），由 `ChatView` / `GroupChatView` 的 `loadTouchState` 顺带写入；
字段缺失时状态行退化为默认「还乐意」、不显示偏好角标，**不影响可用性**（端点不可用 / 早期加载都退化成默认态）。

- **新建** `web-ui/src/components/touchActionLogic.js`、`web-ui/src/components/TouchActionBar.vue`、`web-ui/test/touchActionBar.test.js`（26 例）；
  **局部修改** `web-ui/src/views/ChatView.vue`（模板 L162-169 插入动作条、L629 import、L724-748 门控状态与回调占位）。设计口径见本文 §4。
- **与专题 / 服务层的对齐与偏差**：
  1. **Lv3「腰部游走」的 key**：专题只给中文名；前端镜像先用 `stroke_waist`，事后与服务层核对——**两边独立选到了同一个 key**，已由契约测试钉住。
  2. **睡眠粒度**：专题 §1.3「睡着只能做 Lv1 + Lv2 部分」没定义「部分」⇒ 与服务层同口径：睡着时 Lv1 / Lv2 全放行、只拦 Lv3，重动作（`tickle` / `pinch_cheek`）带 `wakesSleeping` 标记，UI 提示会吵醒她。
  3. **门控在前端镜像一份**（跨包 + 端点未建）⇒ 已把漂移面用契约测试钉死；端点落地后建议**删掉镜像、直接用服务端的 `code` / `message`**。
  4. **`intimateAuthorized` / `hypnotized` 暂无来源**，`ChatView` 里硬编码 `false` ⇒ 接上之前 Lv3 一定置灰、催眠豁免不生效（逻辑已实现，只差数据）。
  5. **回调是占位**：`onTouchAction(actionId)` 只把 key 记进 `touchLastAction`，**故意零副作用**（不伪造反应、不伪造 loading）——接线前真机点动作「没反应」是预期。
- **未做（按分工）**：服务层、`routes/touch.js`、`chat.js` 接线、产物重建（`vite build`）——全量回归与产物重建由 Lead 在所有人停手后统一做。
- **验证数字（前端定向，node v22.18.0）**：`cd web-ui` + `node --test --test-concurrency=1 "test/touchActionBar.test.js"` → **26 tests / 26 pass / 0 fail / 0 skipped**；
  eslint 三个文件 **0 error**（`touchActionLogic.js` / `TouchActionBar.vue` 各 0 warning；`ChatView.vue` 46 warning 全落在改动前既有行，已按行号核对）；
  变异验证 5 例（门控顺序 / 催眠豁免 / 镜像 key 漂移 / 机器码越界 / 置灰点击守卫）**全部被测试抓到**（分别 2 / 2 / 2 / 2 / 1 条红），逐例还原后均回到 26 pass / 0 fail。

**接线后必须复跑的**：本文 §5 的服务层 L1 + 本节的 `touchActionBar.test.js`（契约测试会随服务层源码变化自动校验前端镜像）。

### 6.3 路由接线 + 建表 + chat.js 注入 + 设置开关（2026-09-30，task-13，写手 hypno-core）

**实际改动**

| 文件 | 内容 |
| --- | --- |
| `agent-core/src/routes/touch.js`（新） | 三条端点 + 每日配额 + 即时反应落库（见下）；门控/腻烦/prompt/解析全部调用 §2 的纯函数 |
| `agent-core/src/db/index.js` | `migrateTouchSchema(db)`：新表 `character_touch_state` / `touch_events`（纯新增、幂等、首次建表打一行启动日志）；调用点紧跟 `migrateHypnosisSchema` |
| `agent-core/app.js` | `import touchRoutes` + `app.use('/api/characters', wrapRouterAsync(touchRoutes))`，**整块排在 hypnosis 家族之前**（早于 charactersRoutes 的 `/:id` 通配；且不夹进 intimate → characters 的紧邻区间） |
| `agent-core/src/routes/chat.js` | 5.55 段动作块注入（L936-961）；L92/L109 两个本地 helper（读待反应事件 / 置 injected）；import 增加 `buildTouchActionBlock`、`isBodyControlled`、`isSleeping` |
| `agent-core/src/config.js` | `features.touch` / `features.touchInstant`（均默认 true；env `FEATURE_TOUCH` / `FEATURE_TOUCH_INSTANT` 可关） |
| `agent-core/src/db/settings.js` | 映射 `feature_touch` / `feature_touchInstant`（`PUT /api/config/features` 是通用 handler，改这两处即可持久化，routes/config.js 无需改） |
| `web-ui/src/views/SettingsView.vue` | 新卡片「动作系统（触摸互动）」（两个 `linshe-switch`）；把 B1 的 `saveAntiRepFeature` 与新增 `saveTouchFeature` 收口到共用的 `saveFeatureWithToast` |
| `agent-core/test/touchRoutes.test.js`（新，17 例） | 三条端点 + 门控矩阵 + 腻烦曲线 + 即时/隐式/配额/失败回落 + 总开关 + `chat.js` 挂点源码断言 |

**端点契约**

| 方法 | 路径 | 返回 |
| --- | --- | --- |
| GET | `/api/characters/:id/touch/actions`（`?maxLevel=&scene=&allowGroupAdult=1`） | `{ characterId, actions:[{key,label,level,levelLabel,wakes}], gate:{<key>:{allowed,code,message,wakesSleeping,exempt}}, thresholds, levels, features:{touch,instant}, quota }` |
| GET | `/api/characters/:id/touch/state` | `{ characterId, states:{<key>:{annoyance,tier,likeRatio,updatedAt}}, quota }` |
| POST | `/api/characters/:id/touch/:action` body `{ mode?, scene?, groupId? }` | 见下 |

POST 成功（200）：`{ allowed:true, code:'ok', action, requestedMode, mode:'instant'|'implicit', fallback, notice, reason, eventId, status:'done'|'pending', reaction:{text,facialExpression,annoyed,emotionDelta}|null, emotion, annoyance:{value,tier,repeated,gain}, likeRatio, wakesSleeping, preWake, quota, message }`。
**门控拒绝 = 200 + `{ allowed:false, code, message }`**（Lead 裁决：这是"她不愿意"的叙事结果，不是服务端错误；`message` 已是人话，前端直接 toast）。非法 action / 角色 = 400，角色不存在 = 404，`features.touch=false` = 409 且零写入。

**三条口径（都是 Lead 裁决，写死在这里）**

1. **即时反应真的落库**：复用 `proactiveChatScheduler.writeProactiveMessage`（本次把它 `export`）→ `raw_messages` 一条 assistant + `messages` 按句分段（`is_proactive=1`），再 `broadcastProactiveMessage({ source:'touch', touch:{action,label,eventId} })`。刷新后仍在、下一轮上下文能看到。`touch_events.status`：即时=`'done'`、隐式=`'pending'`、注入过=`'injected'`。
2. **每日配额（独立计数）**：设置键 **`touch_instant_daily_limit`（默认 100，0 = 不限）** 与 **`touch_instant_quota`**（`{date,used}`，按本地日期翻篇；库写失败回落到进程内存）。只在**真的会调模型**时扣一次；耗尽 → `resolveTouchMode` 自动回落隐式 + 返回 `INSTANT_QUOTA_NOTICE`。
3. **人格串不套 characterPersona**：AGENTS.md「非生图用途不套本入口」优先于专题 §2.1 的建议 ⇒ `persona = short_prompt || base_prompt`（`routes/touch.js` 的 `readPersona`），不调用 `buildCharacterPersona`。

**chat.js 注入口径**：位置 **5.55 段（L936-961）**——紧挨 `<intimate_profile>` 之后、`const hypnosisBlocks = []` **之前**（动作块是叙事提示，不进 task-42 的后置硬约束）。读事件 SQL：`status IN ('pending','done') AND group_id IS NULL`（`done` = 即时反应已单独发过 ⇒ 注入 `mode='instant'`，块里写"别再演一遍"）；注入后立刻 `status='injected'` ⇒ **一次动作只注入一次**。不传 `hypnosisBlock`（催眠状态块由 5.6 段独立注入并整块后置，重复拼会违背 task-42 的位置口径）。

**验证数字（2026-09-30 实跑，:memory:）**：`test/touchRoutes.test.js` **17 / 17 pass**；与它同批跑的 `touchActionService` / `antiRepetition*` / `hypnosis*`（ChatIntegration、PromptOrder、Api、Service）合计 **122 / 122 pass、0 fail、0 skip**。

### 6.4 Lv3 → 亲密看板映射接线（2026-09-30，task-16，写手 hypno-core）

**裁决来源**：用户原话「要我下决断的事情你就自己按自己推荐来」⇒ Lead 拍板「**认可、复用冻结管线**」（不改看板口径、不新增 `act_key`）。

**最终映射表**（唯一实现在 `touchActionService.js` 的 `TOUCH_ACTIONS[].intimateActKey`）

| 动作 | `intimateActKey` | 为什么是这个键 |
| --- | --- | --- |
| `touch_breast` 摸胸 | `hand` | 动作本质是**用手抚摸**；`breast` 在看板里是乳交，不是抚摸 |
| `touch_butt` 摸臀 | `hand` | 无臀部键；`anal` 是后庭/肛交（更远的语义），不借 |
| `touch_thigh` 摸大腿 | `hand` | `thigh` 在看板里是素股，不是抚摸 |
| `stroke_waist` 腰部游走 | `hand` | 无腰部键；本质是手部抚摸 |
| `whisper_ear` 耳后吹气 | **`null`（不记账）** | 不是手部动作，白名单里没有吹气/耳部语义的键 ⇒ 宁可不记也不硬凑 |

- **为什么不是「一个动作一个键」**：白名单是**性行为大类**（`ACT_DEFINITIONS`），抚摸与行为不是一回事；
  按仓里「宁可少归因也不误归因」的口径，**手部抚摸全部落 `hand` 一档**，而不是借 `breast`/`thigh` 把数字做漂亮。
  如果将来用户想要「按部位分档」，正确做法是**新增 `act_key`**（例如 `touch_breast`），而不是改这里的映射 —— 那属于看板口径变更，需要重新裁决。
- **记账点**：`routes/touch.js` 的 `recordTouchIntimate()`（POST 通过门控后、与即时/隐式无关——这一下真的发生了）。
  口径：`scene='chat'`（**不新增 SCENES 枚举值**，与镇民奇遇复用 `'event'` 同口径）、`partnerKind='user'`、`source='manual'`（用户手点，绕过 `aiEditFields` 闸门；Lv3 的「亲密授权」已在门控那步判过）、`rawId=0`、
  幂等锚点 **`touch:<touch_events.id>:<actKey>`**（一次动作只记一笔；重放幂等）、**不写 `climaxCount`**（触摸不是高潮，别动面板的「高潮次数」）。
  失败只 `console.warn`（记账是旁路，不能影响动作本身）；`config.features.intimate === false` 时直接不记。
  响应体新增 `intimate: { actKey, sourceUid, inserted, skipped, blocked } | null`，前端据此可选地给一句提示。
- **验证数字**：`test/touchActionService.test.js` **27 / 27**（含映射表断言：`intimateActKey !== null` 恰好这 4 条 + `whisper_ear` 留 null + 源码级「除 `hand` 外不许出现别的映射键」）；
  `test/touchRoutes.test.js` **23 / 23**（含「Lv3 命中 → 记一笔 `hand`/`scene=chat`/`source=manual`/锚点」「同一次动作重放不双记、两次点击两笔」「Lv1/Lv2 与 `whisper_ear` 不记账」「门控拒绝 / 未授权 / `features.intimate=false` 不记账」）；
  亲密侧回归 `test/intimate*.test.js` **216 pass / 0 fail / 3 skip**（3 条 skip 是 `intimateAiEditWithLlm` 里「本机 .env 已配 LLM Key ⇒ 503 分支不可达」的环境性跳过，改动前已如此）。

**已知边界（如实写）**

1. **群聊动作未接**：`POST` 支持 `scene:'group'`+ `groupId`，但 chat.js 的注入只认 `group_id IS NULL`（私聊）；群聊插入式发言是阶段二（专题 §五）。
2. **唤醒反应只做"临时唤醒"**：睡着时的重动作走 `tempWake(id,{mode:'phone',minutes:5})`，**没有**挂 task-42 的 `wake_reaction` 文案；专题把"专属唤醒反应"排在阶段二。
3. **Lv3 看板记账仍未接**（专题 §四要求单独裁决 `intimateActKey`）⇒ 摸胸/摸臀等动作**不写**亲密看板。
4. **没有新鲜度窗口**：一条 `pending`/`done` 事件会一直等到下一轮聊天才被消费（哪怕隔了几天）；如需"过期作废"，下一轮给 `takePendingTouchEvent` 加 `created_at` 判定。
5. **前端仍是镜像门控 + 占位回调**：`ChatView.onTouchAction` 与 `touchGateState` 的 `intimateAuthorized/hypnotized` 仍是硬编码；端点已就绪，接线后可删镜像、直接用服务端 `code`/`message`（§4 第 3 条）。
6. 真实 LLM 的即时反应质量未验（本文件测试用假上游，零真实调用）。

### 6.4 前端接线：动作条接真实端点（2026-09-30，task-15，写手 hires-ui）

> 承接 §6.3 的「已知边界 5」（它写下时前端还是占位）——本轮把它接上了，**该条已过时，以本节为准**。

**实际改动**

| 文件 | 内容 |
| --- | --- |
| `web-ui/src/api/index.js` | 新增 `fetchTouchActions` / `fetchTouchState` / `performTouchAction`（注释写明「门控拒绝是 200 不是 4xx」） |
| `web-ui/src/components/touchActionLogic.js` | 新增 `buildGroupsFromServer`（服务端响应 → 渲染分组）与 `normalizeServerGate`（**服务端优先、字段缺失才回落镜像**）；`resolveActionGate` 返回值加 `source: 'mirror'` 便于区分 |
| `web-ui/src/components/TouchActionBar.vue` | 新增 `serverGroups` prop（有就用服务端）+ 展开时 `emit('open')`；`groups` / `availableCount` 改为从生效分组推导 |
| `web-ui/src/views/ChatView.vue` | `loadTouchActions()`（`watch(activeCharId, immediate)` + 模板 `@open` 刷新；失败清空以回落镜像）+ `onTouchAction` 真发 POST（门控拒绝 toast 服务端 message、成功不伪造反应、隐式 / notice 提示、400·404·409 error toast、busy 防连点、finally 重拉门控） |
| `web-ui/test/touchActionWiring.test.js`（新，17 例） | 服务端优先 / 兜底、服务端清单优先、api 请求形状、`onTouchAction` 真跑（被拒 / 成功 / 隐式 / notice / 抛错 / 连点 / 无角色） |

**契约对齐核对（读 task-13 的路由源码与它自己的测试，不是只看文档）**

- `actionBrief`（`agent-core/src/routes/touch.js:296-304`）= `{ key, label, level, levelLabel, wakes }` ⇒ 与 `buildGroupsFromServer` 消费的字段一致。
- `gate[<key>]` = `{ allowed, code, message, wakesSleeping, exempt }`（`routes/touch.js:326-332`）⇒ 与 `normalizeServerGate` 一致。
- `levels` = `TOUCH_LEVEL_LABELS`（值是 `Lv1 日常` 这种带前缀的；后端测试 `assert.match(action.levelLabel, /^Lv[123] /)` 也证实）⇒ 前端 `stripLevelPrefix` 负责剥成「日常」。
- `thresholds` = `{ lv2Affinity: 40, lv3Affinity: 60 }` ⇒ 与前端 `DEFAULT_GATE_THRESHOLDS` 一致（本就有契约测试钉住）。

**与 task-15 描述的一处不一致（已报 Lead，已裁决）**：描述第 3 点写「`GET .../touch/state` 能拿到 `intimateAuthorized` / `hypnotized`」，但 **§6.3 的表与真实代码都不是**（`routes/touch.js:369` 只回 `{ characterId, states, quota }`）；那两个值只在 `readGateInputs()`（L182-190）里被读、喂给 `/touch/actions` 的服务端门控。**Lead 裁决：前端不去补 state，直接吃 `/touch/actions` 的 `gate`** —— 它就是 `getTouchGate` 的真实结果（含催眠豁免与 Lv3 授权），零翻译零自算，比读原始布尔值更权威。故本轮**没有任何地方去取 `/touch/state`**（`fetchTouchState` 已备好，留给阶段二做「耐受度档位」UI）。

**验证数字（前端定向，node v22.18.0）**

| 命令 | 结果 |
| --- | --- |
| `cd web-ui` + `node --test --test-concurrency=1 "test/touchActionBar.test.js" "test/touchActionWiring.test.js"` | **43 tests / 43 pass / 0 fail / 0 skipped** |
| eslint（`touchActionLogic.js` / `TouchActionBar.vue` / `api/index.js` / `ChatView.vue`） | **0 error**；前三个 0 warning；`ChatView.vue` **46 warning 与改动前同数**，逐行核对无一落在本轮新增行 |
| 变异验证 4 例（改坏 → 应红 → 还原 → 应绿） | M1 服务端 gate 优先级反转 40/3；M2 无视服务端清单 40/3；M3 把「被拒」当成功 41/2；M4 删连点守卫 42/1；**四例全被抓到**，还原后均 43/0 |

**已知边界**

1. **反应消息依赖 SSE 广播**：即时反应靠 `broadcastProactiveMessage` → `App.vue` → `chat.handleProactiveMessage` 追加进消息流。**若前端 SSE 断连，那一条不会实时出现**（刷新后仍在，因为已落库）。前端**故意不**手动插消息（避免与广播重复），这是与「别另造一套」一致的取舍。
2. **本机没能真机联调**：后端端口 3099 当时未监听，无法跑真实 GET/POST；契约改为**读 task-13 路由源码 + 它自己的 `touchRoutes.test.js` 断言**核对（见上）。
3. **仍保留镜像门控**：端点不可用 / 早期加载 / 单条 gate 缺失时兜底；**端点正常时镜像不参与**（有测试钉住「即使两者相反也以服务端为准」）。
4. ~~**群聊动作未接**~~ —— **已在 §6.5 接上**（这条是 §6.4 写下时的状态，留作历史）：`fetchTouchActions` 的 `scene` / `allowGroupAdult` 现由群聊页使用（`scene: 'group'`）。
5. **产物重建（`vite build`）仍由 Lead 统一做**（本轮已改 `web-ui/src`，按编程模式 L4 需要重建）。

### 6.5 前端 · 群聊动作条（2026-09-30，task-18，写手 hires-ui）

> 承接 §6.3「已知边界 1：群聊动作未接」—— 前端这一半本轮做完；后端**群内写入路径**由 task-17 补齐（`writeGroupTouchMessage` + `broadcast('group_message')`），所以「插入式发言」不再是待办。§6.4 的边界 4 已由本节取代。

**实际改动**

| 文件 | 内容 |
| --- | --- |
| `web-ui/src/components/TouchActionBar.vue` | 新增 `targetName` / `requiresTarget` 两个 prop + `pick-target` 事件：显示「对 XXX」目标胶囊；`requiresTarget` 且未选对象时点动作只 toast 提示并请求选人（**不上报**）；展开且未选对象时自动请求选人。私聊路径（`requiresTarget=false`）行为不变，有测试钉住 |
| `web-ui/src/views/GroupChatView.vue` | 输入区上方挂 `TouchActionBar`（`:requires-target="true"`）；「对谁」复用**既有 @提及面板**；`loadTouchActions`（`scene: 'group'`，换群 / 换对象重拉，失败清空回落镜像）；`onTouchAction`（POST 带 `{ scene:'group', groupId }`，被拒 toast 服务端 message，`finally` 重拉门控）；CSS 加 `.touch-group-wrap { position: relative; }`（让复用的 `.mention-panel` 定位照旧生效）；`syncMention` 里顺手收起选人面板（两个面板互斥） |
| `web-ui/test/touchActionGroup.test.js`（新，14 例） | 群聊 gate 口径、复用 @提及选人、`pickTarget`、`loadTouchActions`、`onTouchAction` 真跑、私聊不受影响、两个模板可编译、**与 task-17 的 `group_message` 契约断言一次** |

**「对谁」怎么选的（task-18 点名要回报）**：复用群聊页**原有的 `@` 提及成员选择器** —— `useMentionPicker(() => store.activeGroup?.members || [], { includeAll: false })`，面板直接复用 `.mention-panel` / `.mention-item` / `.mention-avatar` 这三组既有类名。`includeAll: false` 是刻意的：动作对象必须是**具体成员**，「全体成员」不是合法目标（有测试钉住）。

**与 task-17 的契约（测试里断言一次，不改渲染逻辑）**：`routes/touch.js` 的 `writeGroupTouchMessage` 在 `scene === 'group'` 时写 `group_<gid>` 并 `broadcast('group_message')`，payload key = `{ id, group_id, role, content, seq, speaker_character_id, speaker_name, created_at, source, touch }`。断言用 **AST 取字面量 key** —— 注意 `content` / `seq` 是**简写属性**，用 `includes('content:')` 会假红（第一版就是这么错的）。前端消费侧 `stores/groups.js` 的 `_enqueue` 只依赖 `msg.group_id` 与 `msg.id`，两者都在。

**验证数字（前端定向，node v22.18.0）**

| 命令 | 结果 |
| --- | --- |
| `cd web-ui` + `node --test --test-concurrency=1 "test/touchActionBar.test.js" "test/touchActionWiring.test.js" "test/touchActionGroup.test.js"` | **57 tests / 57 pass / 0 fail / 0 skipped** |
| eslint（`TouchActionBar.vue` / `GroupChatView.vue`） | **0 error / 0 warning** |
| 变异验证 4 例（改坏 → 应红 → 还原 → 应绿） | M1 群聊 POST 的 scene 写错 55/2；M2 动作清单取错 scene 56/1；M3 选人面板放回「全体成员」56/1；M4 没选对象也放行 56/1；**四例全被抓到**，还原后均 57/0 |

**已知边界**

1. ~~**群聊成人档没有开关**~~ —— **已在 §6.6 补上**（`features.touchGroupAdult`，默认 false；设置页第三个开关；前端改读 `GET /touch/actions?scene=group` 的 `allowGroupAdult` 生效值）。这条是 §6.5 写下时的状态，留作历史。
2. ~~**围观机制未做**~~ —— **已在 §6.7 补上**（task-22 做成真概率模型：默认 0.3、可关、`collectTouchActionBlocks` 返回 `bystander`；设置键见 §3.7，task-19 补上 `feature_touchBystanderChance` 让它可被覆盖）。这条是 §6.5 写下时的状态，留作历史。
3. **反应仍依赖 SSE**：群内反应走统一流 `group_message`；前端 SSE 断连时不会实时出现（刷新后仍在，已落库）。前端**故意不**手动插消息。
4. **本机没能真机联调**（后端端口当时未监听）：契约按后端源码 + 后端测试断言核对。
5. **产物重建（`vite build`）由 Lead 统一做**。

> 群聊交互口径另见 §4「群聊（阶段二 · task-18）」。

### 6.6 后端 · 阶段二：群聊动作 + 被摸醒文案 + 事件新鲜度 + 群聊敏感档开关（2026-09-30，task-17，写手 hypno-core）

> 承接 §6.3 的「已知边界 1 / 2 / 4」与 §6.5 的边界 1：群聊注入链、被摸醒的专属反应、事件过期、群聊成人档开关，本轮一起补掉。

**实际改动**

| 文件 | 内容（行号为 2026-09-30 工作树快照） |
| --- | --- |
| `services/groupChatEngine.js` | 新增 `collectTouchActionBlocks(group)`（**L127**）：读本群待消费事件 → 带**成员限定行**的 `<touch_action>` 块 + `<touch_bystander>` 围观规则（**L180**）；**单轮最多消费 1 条**；消费即置 `injected`。群聊轮挂点 **L1598**（在成员私聊记忆之后、催眠块之前 —— 动作块是叙事提示，催眠块仍保持最后） |
| `services/touchActionService.js` | `buildTouchActionBlock` 新增 `scopeLine` 参数（限定行插在**块内第一行**；格式的唯一来源仍是 `hypnosisPrompt.buildSubjectScopeLine`，本模块零依赖只吃字符串）；新增 `TOUCH_EVENT_TTL_MS`（30 分钟）/ `touchEventCutoff(now)` / `isTouchEventFresh(...)` —— **新鲜度判定只有这一处**，私聊与群聊两条链都调它 |
| `routes/touch.js` | ① 群聊即时反应**改写群会话**：`writeGroupTouchMessage()` L371（`group_<gid>` 的 raw + messages，`speaker_character_id` = 被摸的角色）+ `broadcast('group_message', payload)` **L745**（形状逐字对齐 `groupChatEngine.serializeMsg()`）；② `expireStaleTouchEvents()` L229（GET / POST 入口顺手清扫）；③ 睡着被重动作摸醒 → `tempWake` + `attachWakeReaction` **L623**（复用 task-42，只写 pending_directive）；④ 群聊 Lv3 读 `features.touchGroupAdult`（helper L98、GET 生效值 L495/L497、POST 判定 L579）；⑤ 群聊参数校验：群不存在 404、非成员 400 |
| `routes/chat.js` | `takePendingTouchEvent` 加新鲜度窗口（清扫 L100 + `created_at >= cutoff` 过滤 L108）；私聊注入点仍是 5.55 段 **L958**（`group_id IS NULL` 不变） |
| `services/hypnosisService.js` | `attachWakeReaction` 加 `export`（一个词 + 一行注释，逻辑未动） |
| `config.js` / `db/settings.js` | `features.touchGroupAdult`（**默认 false**，env `FEATURE_TOUCH_GROUP_ADULT`；config L171）+ `feature_touchGroupAdult` 映射（settings L106） |
| `web-ui/src/views/SettingsView.vue` | 「动作系统（触摸互动）」卡片第三个 `linshe-switch`「群聊里的敏感动作」（**L827**，默认关） |
| 测试 | 新建 `test/touchGroupInject.test.js`（7 例）；`test/touchRoutes.test.js` 扩到 31 例；`test/touchActionService.test.js` 扩到 29 例 |

**群聊动作的消费语义（与私聊逐条对齐）**

1. 取事件：`status IN ('pending','done') AND group_id = <gid> AND created_at >= touchEventCutoff()`；
   一次拿最多 5 条候选，**坏行（成员退群 / 动作下架）就地标 `dropped` 并继续往下找** —— 坏行不占本轮名额；
2. 注入：`<touch_action>`（块内第一行是成员限定行「本节只对「X」生效…」）+ `<touch_bystander>`（**其他成员最多 1 人**围观，用户裁决「单轮只 1 人插话」）；
3. **单轮最多注入 1 条**（`LIMIT 1` 语义），其余留到下一轮；
4. 消费即完成：`status='injected'`（**一次动作只注入一次**；写失败只 warn）；
5. `mode='instant'`（反应已作为独立消息发过）照传，块里写「别再演一遍」防同一摸演两遍。

**`touch_events.status` 完整取值**：`pending`（隐式，等下一轮）/ `done`（即时反应已单独发出）/ `injected`（已注入过）/ `expired`（超过 30 分钟，作废）/ `dropped`（成员已不在群 / 动作下架，作废）。

**群聊里的即时反应走哪条链（与私聊的分工）**

| 场景 | 落库 | 广播 | 前端 |
| --- | --- | --- | --- |
| 私聊 `scene='chat'` | `char_<id>` 的 raw_messages + 分段 messages（`is_proactive=1`） | `proactive_message` | 私聊页既有链路 |
| 群聊 `scene='group'` | `group_<gid>` 的 raw（`[名字]: ` 前缀）+ 一条 messages（`speaker_character_id`） | **`group_message`**（统一流） | 群聊页 `stores/groups.js` 的 `_enqueue`（**前端一行都不用改**） |

群聊 payload 的 key（`routes/touch.js` L745 广播的那个对象）：`{ id, group_id, role, content, seq, speaker_character_id, speaker_name, created_at, source:'touch', touch:{action,eventId} }` —— 前 8 个与 `serializeMsg()` 逐字一致，后 2 个是附加诊断字段（前端忽略未知字段）。

**事件新鲜度窗口（阶段一边界）**

- 常量 **`TOUCH_EVENT_TTL_MS = 30 * 60 * 1000`**（服务层导出，要调只调这里）；判定纯函数 `touchEventCutoff(now, ttlMs)` 返回 **SQLite 无时区 UTC 串**，可直接 `WHERE created_at >= ?` 比较；内存侧用 `isTouchEventFresh(createdAt, now)`（群聊兜底）。
- 清扫点：`routes/touch.js` 的每个入口（GET /actions、GET /state、POST）调 `expireStaleTouchEvents({characterId})`；`chat.js` 在读之前也调一次（同一实现，路由→路由 import，见该处注释）。
- 超窗口的事件：不再被任何一条链注入，并标 `'expired'`。

**群聊敏感档开关（task-17 追加，默认关）**

| 项 | 值 |
| --- | --- |
| config 键 | `config.features.touchGroupAdult`（`config.js` L171，env `FEATURE_TOUCH_GROUP_ADULT === 'true'`） |
| 落库键 | `feature_touchGroupAdult`（`db/settings.js` L106，`PUT /api/config/features` 通用 handler 直接持久化） |
| 默认 | **false**（关闭时群聊 Lv3 一律 `group_adult_blocked`，与加开关前行为一致） |
| 设置页 | `SettingsView.vue`「动作系统（触摸互动）」卡片第三个开关（L827） |
| 前端读法 | `GET /api/characters/:id/touch/actions?scene=group` 返回体的 **`allowGroupAdult`**（生效值；`features.groupAdult` 同值）——**不要自己写死 false** |

**验证数字（2026-09-30 实跑，:memory:）**

| 命令 | 结果 |
| --- | --- |
| `test/touchGroupInject.test.js` | **7 / 7 pass** |
| `test/touchRoutes.test.js` | **31 / 31 pass** |
| `test/touchActionService.test.js` | **29 / 29 pass** |
| 同批 `test/touch*.test.js test/hypnosis*.test.js test/group*.test.js` | **295 / 295 pass、0 fail、0 skip** |
| `eslint src/views/SettingsView.vue` | **0 error**（2 warning 为改动前既有行） |

**已知边界**

1. ~~**围观只有"最多 1 人"的 prompt 约束**~~ —— **已由 task-22 做成真概率模型**（`DEFAULT_TOUCH_BYSTANDER_CHANCE = 0.3`、`resolveTouchBystanderChance` / `planTouchBystander`、`collectTouchActionBlocks` 返回值新增 `bystander`；关闭时块文案与 task-17 逐字节一致）。**task-19 补上了设置键 `features.touchBystanderChance`（默认 0.3，float 映射）让它可被 system_settings 覆盖**，见 §3.7。
2. **群聊即时反应仍依赖统一流**：SSE 断连时不会实时出现（已落库，刷新或下一轮 GET /messages 能看到）。
3. **没有"点错对象"的成员归属校验之外的权限**：群聊动作只校验"她是不是该群成员"。
4. **`expireStaleTouchEvents` 走路由→路由 import**（`chat.js` ← `routes/touch.js`）：服务层 `touchActionService` 契约是零依赖/不碰 DB，扫地逻辑不宜放那里；要搬家的话建议新建一个 DB 层的 `touchEventStore`。
5. 真实 LLM 的群聊反应质量未验（测试用本地假上游）。

### 6.7 后端 · 阶段三：出图联动 + 立绘表情 + 统计聚合（2026-09-30，task-19，写手 hypno-core）

**实际改动**

| 文件 | 内容 |
| --- | --- |
| `services/touchActionService.js` | 新增出图档位三态常量与判定：`TOUCH_IMAGE_MODES` / `TOUCH_IMAGE_MODE_LABELS` / `DEFAULT_TOUCH_IMAGE_MODE='smart'` / `SMART_IMAGE_CHANCE` / `normalizeTouchImageMode()` / `shouldGenerateTouchImage()`（纯函数，随机源可注入）；新增 16 条动作的英文 `TOUCH_IMAGE_HINTS` + `buildTouchImagePrompt()`（英文画面句 + 反应原文 + 调用方给的外观块，本模块仍零依赖） |
| `services/touchStatsService.js`（新） | `getTouchStats(characterId, { days, recent })`：按动作/等级/日期聚合（次数、最近一次、腻烦峰值/均值/当前值、模式与状态分布、出图数、看板笔数）+ 最近明细；形状见 §3.6 |
| `routes/touch.js` | 出图：`generateTouchImageForReaction()`（档位 → 判定 → prompt → `imageSkill.generateImage` → `saveBase64Image` → 挂 `messages.images` + 记 `image_tasks(style='touch-action')`；私聊先出图再广播、群聊文字先广播再 `group_message_update`；失败只 warn）；测试接缝 `__setTouchImageGeneratorForTest()`；立绘：`driveStandingExpression()`（复用 `publishStandingKeys`）；新端点 `GET /:id/touch/stats`；响应新增 `images` / `imageMode` / `standingExpression` |
| `config.js` / `db/settings.js` | `features.touchImageMode`（默认 `smart`；`updateFeatureFlag` 加三态分支，通用 `PUT /api/config/features` 直接可用）+ `feature_touchImageMode`（string）；顺手补 `features.touchBystanderChance`（默认 0.3）+ `feature_touchBystanderChance`（float，task-22 围观概率的覆盖键） |
| 测试 | 新 `test/touchImageStats.test.js`（12 例）；`test/touchActionService.test.js` 扩到 31 例；`test/touchRoutes.test.js` 同步新形状 |

**关键口径**

1. **档位=从不 = 零行为变化**：生成器一次都不被调用（单测钉住）；档位非法一律回落 `smart`。
2. **智能档只对 Lv2/Lv3 按概率出图**（Lv2 25% / Lv3 50%），Lv1 永不出；`always` 连 Lv1 也出；两者都受**既有出图总开关** `features.imageGenMode === 'off'` 约束。
3. **出图失败不影响动作**：事件仍 `done`、反应消息照写、看板记账不受牵连（异常只 warn）。
4. **立绘表情不新造通道**：复用 `standingDisplay.publishStandingKeys`（服务端独占），`facial_expression` 与她的表情包 key 匹配不到就静默跳过。
5. **统计只读且不受总开关影响**；空数据返回 0/空数组。

**验证数字**：`test/touchImageStats.test.js` **12 / 12**；`test/touchActionService.test.js` **31 / 31**；`test/touchRoutes.test.js` **31 / 31**；`test/touchGroupInject.test.js` **7 / 7**（合计 **81 / 81**，另一批群聊/催眠回归另计）。

**已知边界**

1. **出图会拉长即时反应的 POST 返回时间**（等 ComfyUI）：私聊是「先出图再广播」，群聊是「文字先上屏、图好了再 update」；不想要延迟就选 `never`。
2. **本仓没有图片配额概念**：只尊重既有出图总开关（`imageGenMode`），没有每日张数上限。
3. **`totals.images` 只数私聊会话**（`char_<id>` + `style='touch-action'`）；群聊出图记在 `group_<gid>` 下，不计入角色统计。
4. **立绘联动会切换展示角色**（`select`），群聊里对某人做动作时立绘窗口会切到她 —— 这是有意的（与 `chat.js` 同口径），但**同时只显示一个角色**。
5. **统计的 `daily` 用 UTC 日期**（SQLite 无时区串前 10 位），跨时区展示由前端决定。
6. 真实 ComfyUI 出图质量未验（测试用假生成器接缝）；`image_tasks` 未写 `source_msg_id`（`recordCompletedImageTask` 无该参数）。

### 6.8 前端 · 阶段三：统计面板 + 出图档位 + 立绘表情联动（2026-09-30，task-20，写手 hires-ui）

> 后端那半由 §6.7（task-19）落地；本节只记前端。开工时 `touch/stats`、`features.touchImageMode`、立绘钩子在 agent-core 里都是 0 命中，我据此报过 Lead；**同一轮内三者陆续落地**，所以我没把猜的形状写死，落地后按真实形状收敛。

**实际改动**

| 文件 | 内容 |
| --- | --- |
| `web-ui/src/components/touchStatsLogic.js`（新） | 纯逻辑：`normalizeTouchStats`（吃真实形状 `totals` / `byAction` / `byLevel` / `recent`，并兼容旧命名与 `stats{}` 映射表）、`likeTierOf`、`annoyanceTierOf`（50 / 80 阈值）、`formatLastSeen`（走 `parseBackendTime` 收口） |
| `web-ui/src/components/TouchStatsPanel.vue`（新） | 「触摸互动」小节：总数 / 配图数 / 最近一次 / 等级分布条 / 按次数降序的动作行（偏好与耐受度一律**档位文案**，不暴露原始数值）；有加载态与中性空态；0.3s 过渡、双主题 token、767px 断点 |
| `web-ui/src/components/CharacterDetailModal.vue` | 正文插入 `<TouchStatsPanel :character="character" />`（角色详情语义最贴，Lead 批准） |
| `web-ui/src/views/SettingsView.vue` | 「动作系统（触摸互动）」卡片加 **LinsheTabs** 三档（`features.touchImageMode`）；`features` 初值同源常量；保存失败回滚上一档。另按 Lead 追加，在「反重复与话题推进」卡片加 `features.antiRepetitionEscalation` 开关（默认开） |
| `web-ui/src/components/touchActionLogic.js` | 加 `TOUCH_IMAGE_MODE_KEY` / `DEFAULT_TOUCH_IMAGE_MODE` / `TOUCH_IMAGE_MODES` / `normalizeTouchImageMode` / `touchImageModeLabel` |
| `web-ui/src/api/index.js` | 加 `fetchTouchStats` |
| `web-ui/test/touchStage3.test.js`（新，14 例）· `web-ui/test/antiRepetitionEscalationSwitch.test.js`（新，3 例） | 档位常量与归一化、保存与回滚、统计真实形状与空态、档位阈值、UTC 时间解析、面板视觉约束、立绘契约断言、升级开关与「重写兜底不给入口」 |

**Lead 裁决的三条，逐条对上**

1. **出图档位**：键 `features.touchImageMode`，取值 `always | smart | never`，默认 `smart`，走通用 `PUT /api/config/features`（后端 `config.js:181` + `settings.js:109` + `updateFeatureFlag` 三态分支都已落地）。非法值前后端**都回落 `smart`**。UI 用 LinsheTabs（不自造分段控件）。
2. **立绘表情：前端零代码**。后端 `routes/touch.js` 的 `driveStandingExpression` 复用既有 `publishStandingKeys`，按 `facial_expression` 在她的表情包里做「精确 → 包含 → 被包含」匹配，**匹配不到就跳过（不报错、不猜）**。前端只保证「不自己动立绘、不自己插消息」，并有断言钉住这一点（前端确实没有改立绘表情的接口：只有 `GET /standing-display/state` 与 `PUT /standing-display/active`）。
3. **统计面板**挂在 `CharacterDetailModal.vue`，端点落地后按真实形状收敛。

**真实形状的关键点（与最初假设不同，值得记）**

- 动作数组叫 **`byAction`（数组）**，不是 `actions`；总数在 **`totals.events`**；等级分布在 **`byLevel`**；
- 每动作的「当前耐受度」是 **`currentAnnoyance`**（**不是** `peakAnnoyance`，后者是历史峰值）；出图数是 **`totals.images`**（只数私聊会话，见 §6.7 边界 3）；
- 最近一次取 **`recent[0].createdAt`**（服务端已把 SQLite 无时区串转成 ISO）；
- 我的第一版 `toRows` 只把 `byAction` 当对象遍历（会拿下标当 key）——已修，并加钉住用例 + 变异验证。

**验证数字（前端定向，node v22.18.0）**

| 命令 | 结果 |
| --- | --- |
| `cd web-ui` + `node --test --test-concurrency=1` 五个 touch 测试文件 | **71 tests / 71 pass / 0 fail / 0 skipped** |
| 同上 + `test/antiRepetitionEscalationSwitch.test.js` | **74 tests / 74 pass / 0 fail / 0 skipped** |
| eslint（6 个改动文件） | **0 error**；4 个文件 0 warning；`SettingsView.vue` 2 条 / `CharacterDetailModal.vue` 5 条 warning **全是改动前既有行**（逐行核对无新增） |
| 变异验证 5 例 | M1 `byAction` 又按对象遍历 69/2；M2 总数不读 `totals.events` 69/2；M3 腻烦阈值 80→90 69/2；M4 档位归一化不回落 69/2；M5 档位保存不回滚 70/1；**五例全被抓到**，还原后均 71/0 |

**追加小项 2 · 群聊围观插话概率（task-22）**：设置页「动作系统（触摸互动）」卡片加了 `features.touchBystanderChance` 的**开关 + 概率滑块**（用现成的 `LinsheSlider`，未自造皮肤）。契约按后端 `config.js:549-556` 对齐：写入是**数字 0~1 = 开启**、`'off'` / null = 关闭、数字由后端 0~1 夹取；读取 `''` / null / false 一律按**关闭**处理，非法值前后端都回落 0.3（30%）。关闭时滑块收起、**不发送概率**；开关与滑块失败都回滚。专测 `web-ui/test/touchBystanderChance.test.js`（6 例）。

> 踩坑记录：滑块的值本身就是**百分比**（0~100），而 `chanceToPercent` 吃的是 **0~1 分数** —— 第一版把两者混用（会存成 1 而不是 0.7），被测试当场抓住；已拆成 `clampPercent`（吃百分比）与 `chanceToPercent`（吃分数）两个函数。

**全量（收工前顺手跑的，供 Lead 参考）**：`cd web-ui` + `node --test --test-concurrency=1 "test/*.test.js"` → **389 tests / 389 pass / 0 fail / 0 skipped**。

**口径记录（不实现，Lead 已记）**：专题 L4 的「重写兜底」`antiRepetitionReroll` 键已预留、默认关、**本轮不接线**（要改流式替换语义且每次多烧一次 LLM）⇒ **故意不给 UI 入口**，并有测试钉住「不许出现绑定」。

**已知边界**

1. **统计面板保留旧命名兼容**：后端若再改字段名不会白屏，但会显示空态；契约测试会随 `touchStatsService.js` 变化报警。
2. **没跑真机**：本机后端端口当时未监听；契约按源码 + 后端测试断言核对。
3. **没做**：产物重建（Lead 统一做）、统计按天曲线（`daily` 已在响应里，本轮只做次数与档位，不画图）、围观机制。

### 6.9 前端 · 按天曲线 + 待回应提示；用户手册补缺（2026-09-30，task-25，写手 hires-ui）

> 对应审查《审查与改进规划-20260930》缺口 5（P0-3）与 §五 P2-1。
>
> 【补记 2026-09-30】本节在本轮文档整体重写中丢失，且未进入任何 git 提交 / 分支 / stash；
> 以下由 task-25 写手（hires-ui）按记忆补回，内容与当时回报 Lead 的清单一致。

**① 用户手册（P0-3）**

| 文件 | 改动 |
| --- | --- |
| `目标/操作流程.md` | **+60 行 / −0**：新增 §12 动作系统（入口 · 群聊先选人 · 三档 16 动作 · 门控为什么灰 · 腻烦度与 30 分钟冷却 · 即时反应 vs 省额度 · 每日配额 100）、§13 动作出图档位（智能＝Lv2 25% / Lv3 50%）+ 围观概率 + 群聊敏感档（默认关）+ 统计面板入口、§14 反重复（三开关各管什么 · penalty 两框怎么填 · **留空＝不发送** · `[anti-repetition]` 日志看档位）、§15 待回应提示；§10 常见问题表**新增 4 行** |
| `scripts/build-release.mjs` 的 `buildUsageGuideText` | **+28 行 / −0**：同一批内容按 `【】` 小节写进 `使用说明.txt`（纯文本，**不带 markdown 记号**）+ 常见问题补 3 条 |
| `使用说明.txt`（生成物，gitignored） | 重新生成：**79 → 107 行，0 删除 / 26 新增**（`git diff --no-index` 实测） |

> ⚠️ `buildUsageGuideText` 是 `使用说明.txt` 的**唯一**来源；它在 `scripts/build-release.mjs`（**不在 agent-core**），那次只动了这一个函数。

**② 统计按天曲线（P2-1）**

- `touchStatsLogic.js` 新增 `normalizeDaily`（丢无日期、次数取非负整数、按日期升序）、`buildDailyPoints`（SVG `polyline` 的 points 串；**少于 2 个点返回空串** —— 一个点画不出线，不硬画一条假平线；纵向按窗口最大值归一化，全 0 时最大值兜底 1 避免除零）、`dailyLabel`（`YYYY-MM-DD` → `MM-DD`）；`normalizeTouchStats` 透出 `daily` 与 `dailyTotal`。
- `TouchStatsPanel.vue` **自绘 SVG 折线**（不引图表库、不新造视觉）：`viewBox="0 0 260 44"` + `preserveAspectRatio="none"` 随容器拉伸，`vector-effect="non-scaling-stroke"` 保证拉伸后描边仍是 2px；描边色走 `var(--accent)` token（双主题自动跟随）；不足两天给中性说明「还不满两天，攒够两天就能看到曲线」；曲线在既有 `touch-stats-fade` 0.3s 过渡内。

**③ 待回应提示（pendingCount）**

- `touchActionLogic.js` 新增 `pendingHintOf(count)`：**N>0 才给文案**，0 / 负数 / 非数字一律空串。
- `TouchActionBar.vue` 新增 prop `pendingCount`；提示行 `.touch-bar__pending` 用 `flex-basis:100%` **独占一行排在动作胶囊上方**（容器加 `flex-wrap: wrap`；既有 `touch-bar-slide` 展开动画与胶囊结构未动）。
- `ChatView.vue`：独立 `watch(activeCharId)` 拉 `GET /api/characters/:id/touch/state` 取 `pendingCount`，**读不到当 0**；每次动作结束后连同门控一起刷新。
- 🔌 **后端 `pendingCount` 当时尚未落地**（agent-core grep = 0 命中）：前端按约定形状写好，读不到就静默不显示、不弹错，**落地后无需改前端**。（后续由 task-28 落地后端口径，群聊那一半见 §6.11；消费后刷新见 §6.12。）

**验证数字（node v22.18.0）**

| 命令 | 结果 |
| --- | --- |
| `node --test` 当时名下 8 个测试文件 | **92 / 92 pass，0 fail，0 skipped** |
| 新增 `test/touchDailyPending.test.js`（8 例）+ `test/touchManualCoverage.test.js`（4 例） | 全绿 |
| **前端全量** `node --test "test/*.test.js"` | **401 / 401 pass，0 fail，0 skipped** |
| eslint（5 个改动前端文件） | **0 error**（`ChatView.vue` 45 条 warning 全是改动前既有行） |
| 变异验证 6 例 | M1 单点也画线 / M2 daily 不排序 / M3 `pendingHintOf` 把 0 当有 / M4 不透出 daily / M5 提示不看阈值 / M6 不再传条数 —— **六例全被抓到**，还原后均 8/0 |
| 手册 diff | `目标/操作流程.md` **+60/−0**；`build-release.mjs` **+28/−0**；重新生成的 `使用说明.txt` **79→107 行、0 删除** |

**TDD 红→绿证据**

1. 手册**先写红**：`touchManualCoverage.test.js` 首跑 **1 pass / 3 fail**（报出 18 项缺失内容），补完两份手册后 **4/4 绿**。
2. 曲线与提示**先写红**：`touchDailyPending.test.js` 首跑整体失败 —— `SyntaxError`：模块不提供 `buildDailyPoints` 这个导出（导出还不存在）；实现后 **8/8 绿**。

**顺手修掉的一个既有 lint 错误**：`TouchStatsPanel.vue` 的 `<Transition>` 直接子元素缺 `v-if`（`vue/require-toggle-inside-transition`，task-20 就存在，被我用错的 grep 模式漏掉了）—— 已补 `v-if="stats.hasData"`，该文件现在 0 problem。

**已知边界**

1. **`pendingCount` 当时未经真机验证**：按约定形状写并标注（后端口径后续由 task-28 落地）。
2. **曲线不做横轴刻度**：只在两端标日期（`MM-DD`），中间不给网格线 —— 抽屉里的迷你趋势图，不做完整图表。
3. **`daily` 用 UTC 日期**（SQLite 无时区串前 10 位，见 §6.7 边界 5）；跨时区时横轴日期以 UTC 计。
4. **`使用说明.txt` 是 gitignored 生成物**：不进 git，正式打包时由 `buildUsageGuideText` 重新生成。

### 6.10 后端 · task-24：消费顺序 + 待回应计数 + 配额口径核实 + 动作偏好初始化 + `touchEventStore` 搬家（2026-09-30，写手 hypno-core）

**实际改动**

| 文件 | 内容（行号为当时工作树快照） |
| --- | --- |
| `services/touchEventStore.js`（**新**） | 事件存取统一入口：`takePendingTouchEvent`（**ASC 先点先演** + 过期清扫 + 只认私聊）、`markTouchEventInjected`、`expireStaleTouchEvents`（角色/群两个作用域）、`countPendingTouchEvents`。三条函数**逐字节照搬** routes/chat.js / routes/touch.js 的旧实现 |
| `routes/chat.js` | 删掉本地 `takePendingTouchEvent` / `markTouchEventInjected` 与 `import … from './touch.js'`（**反向 import 消除**），改从服务层 import；补 §5.55 段说明 |
| `routes/touch.js` | 删掉本地 `expireStaleTouchEvents`（改 import 服务层）；`GET /touch/state` 新增 `pendingCount`（并顺手清扫）；新增 P1-1 偏好区块：`ensureTouchLikeRatios` / `buildLikeRatioInitPrompt` / `parseLikeRatioInit` / `writeLikeRatios` / `tuneTouchLikeRatio` + 常量；群聊心情锚点改传 `null` |
| 测试 | 新增 `test/touchEventStore.test.js`（7 例）；`test/touchRoutes.test.js` 新增 P0-2 顺序 + `pendingCount` 用例（并把 chat.js 的查询口径断言迁到 store）；`test/touchImageStats.test.js` 新增 P1-2（配额钟、群聊锚点）+ P1-1（初始化/幂等/失败/微调上下限）共 11 例 |

**TDD 红→绿证据（审查者要求，逐件先红后绿）**

| 件 | 红（首跑） | 绿（实现后） |
| --- | --- | --- |
| P0-2 | `touchRoutes.test.js` **31 pass / 2 fail** —— ASC 源码断言 + `pendingCount` 各一条 | **33 / 33** |
| P1-2 | `touchImageStats.test.js` 群聊锚点 **expected 12 / actual 13**（锚在群气泡上）；配额钟那条首版写绝对断言（拿到 11）后改成相对断言 | **14 / 14** |
| P1-1 | `touchImageStats.test.js` **14 pass / 3 fail**（初始化没调、微调没生效） | **17 / 17** |
| P2-2 | `test/touchEventStore.test.js` 首跑 `ERR_MODULE_NOT_FOUND`（模块还不存在） | 建服务后 **7 / 7**（含一次夹具修正：`characters.base_prompt` NOT NULL） |

**验证数字**

| 命令 | 结果 |
| --- | --- |
| `test/touchEventStore + touchRoutes + touchImageStats` | **57 / 57 pass、0 fail、0 skip** |
| `test/touch* + hypnosis* + group* + chat*` | **348 / 348 pass、0 fail、0 skip** |

**已知边界**

1. **首次动作会多一次模型调用**（偏好初始化，每角色一次）：本文件 `touchRoutes.test.js` 的夹具把角色直接标成已初始化，
   让 `stub.calls` 仍只数反应那一次；初始化自身的用例在 `touchImageStats.test.js`。
2. `expireStaleTouchEvents({ characterId })` 按 `character_id` 扫，**包含该角色的群聊行**（搬家前口径，逐字节保留）；群聊链另按 `group_id` 扫，两者互补。
3. 初始化/微调失败只 warn，`like_ratio` 会保持旧值（首次失败即保持 1），不阻塞任何动作。
4. 偏好初值区间 `[0.5, 1.5]`，微调后整体区间 `[0.5, 2]`（用户裁决）。
5. 本轮的 P0-2 只改顺序，**没有**为「done 事件延迟一轮注入」加特殊分支（审查确认属弱影响）。

### 6.11 后端 · task-28：`pendingCount` 的群聊口径（2026-09-30，写手 hypno-core）

**问题**（复审 §10.2 问题 2）：`countPendingTouchEvents` 只算私聊（`group_id IS NULL`）⇒ 群聊页要显示「还有 N 个动作」时口径对不上。

**改动**

| 文件 | 内容 |
| --- | --- |
| `services/touchEventStore.js` | `countPendingTouchEvents(characterId, { groupId })`：传正整数 = 群聊口径（`group_id = ? AND status IN ('pending','done')`，数该群**全体**）；**默认路径 SQL 与返回值逐字节不变** |
| `routes/touch.js` | `GET /:id/touch/state` 支持 `?scene=group&groupId=<n>`：非法 groupId → 400；群聊口径下**两个作用域都清扫**；响应新增 `pendingCounts{chat,group}` / `scene` / `groupId`，`pendingCount` = 生效场景计数（不传参数 ⇒ 与旧行为完全一致） |
| 测试 | `test/touchEventStore.test.js` +2（9 例）；`test/touchRoutes.test.js` +1（HTTP 契约，35 例） |

**TDD 红→绿证据**

| 件 | 红（首跑） | 绿 |
| --- | --- | --- |
| store 群聊口径 | `touchEventStore.test.js` 首跑 **7 pass / 2 fail**（`groupId` 参数被忽略：expected 2 / actual 1、expected 2 / actual 0） | **9 / 9** |
| 路由契约 | `touchRoutes.test.js` 首跑 **33 pass / 1 fail**（`scene` 字段缺失：expected 'chat'） | **35 / 35** |

**验证数字**：`touchEventStore + touchRoutes + touchImageStats` **60 / 60 pass、0 fail、0 skip**；`touch*` 全量与关联批次的数字见回报。

**边界**：群聊口径**不按 character 过滤**（群聊页要的是"这个群还有几件事"）；群不存在时计数自然是 0（不额外 404）；`pendingCounts.group` 只在群聊口径下给值（私聊口径为 `null`，避免前端误用）。

**补记（2026-09-30，独立验证者报的边界）**：`groupId` 一律走 `parseStrictGroupId()` 严格判定 —— 旧实现 `Number.parseInt` 会把 `1.5` 截成 1、`3abc` 截成 3（实测 HTTP 200 走错口径）；现在非严格正整数一律 400 `INVALID_GROUP_ID`，store 层非严格输入按"没给群"回落私聊口径（绝不再截断）。测试：`test/touchEventStore.test.js` 的「groupId 必须是严格正整数」与 `test/touchRoutes.test.js` 的「task-28 groupId 边界」。

### 6.12 前端 · task-29：群聊 pendingCount 接线 + 消费后刷新（2026-09-30，写手 hires-ui）

> 复审 §10.2 问题 2/3 的前端一半；后端口径见上一节 §6.11。

**① 群聊 pendingCount（问题 2）**

- `api/index.js` `fetchTouchState(characterId, { scene, groupId })`：按需拼 `?scene=…&groupId=…`；**不传参数 = 旧行为逐字节一致**；`groupId` 用 `undefined` / `null` / `''` 判空（**0 是合法群 id，不能被假值判断吃掉**）。
- `GroupChatView.vue` 新增 `touchPendingCount` + `loadTouchState()`（带 `scene:group` + `groupId`），传给既有 `TouchActionBar` 的 `pendingCount`（N>0 才显示，交互与私聊一致）。
- ⚠️ **口径对齐（重要，写之前差点做错）**：后端群聊口径统计的是**整个群**还没被注入的动作、**不按 character 过滤**（§6.11 边界），所以路径里的角色 id **只用来定位会话** —— `touchPathId()` = 当前选中对象，没选就回落**群内第一个成员**；否则用户没选人时提示永远不出现。响应里 `pendingCount` = 生效场景计数（`pendingCounts.{chat,group}` 是分场景明细），前端统一读 `pendingCount`。

**② 消费后刷新（问题 3）**

- 根因：隐式动作被下一轮聊天消费掉（后端 `markTouchEventInjected`）后前端没有任何钩子 ⇒「她明明回应了，提示还在」。
- 只补在**既有的消息变化钩子**里，不新造监听：`ChatView` 的 `watch(() => chat.messages.length)`（L1761）与 `GroupChatView` 的 `watch(() => store.scrollSignal)`（L775）各补一次 `scheduleTouchStateRefresh()`。
- **防打爆**：`touchActionLogic.js` 新增纯函数 `createCoalescer({ delay = 350, run, setTimer, clearTimer })` —— **前缘合并**：窗口内第一次 `schedule()` 才真的排上，后续的**直接丢掉**（不延期、不排队），触发后窗口重开。定时器与清理函数可注入，单测用假时钟确定性验证。
- **竞态守卫保留并加强**：`loadTouchState` 仍比对发起时的角色 / 群（`chat.activeCharId !== charId`、`store.activeGroupId !== groupId`、`touchPathId() !== pathId`），不一致就丢弃响应；切角色 / 换群时额外 `touchStateCoalescer.cancel()`，别让上一个角色的响应落到新角色头上。

**改动文件**

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `web-ui/src/api/index.js` | L507-515 | `fetchTouchState` 支持 `scene` / `groupId` |
| `web-ui/src/components/touchActionLogic.js` | L120-140 | `createCoalescer` 合并器 |
| `web-ui/src/views/ChatView.vue` | L770-771 / L775-780 / L1761 | 合并器 + 切角色取消并重拉 + 消息变化触发 |
| `web-ui/src/views/GroupChatView.vue` | L167 / L522-546 / L550 / L574 / L775 | pendingCount 全套接线 + 消息变化触发 |
| `web-ui/test/touchPendingRefresh.test.js`（新，9 例） | — | 查询串契约 / 合并器 / 两个页面的接线与守卫 |

**TDD 红→绿证据**

1. 首跑整体失败：`SyntaxError: … does not provide an export named 'createCoalescer'`（导出还不存在）。
2. 补完 `createCoalescer` + `fetchTouchState` 后：**9 例里 4 绿 / 5 红**（红的都是两个页面的接线断言）。
3. 两个页面接完线：**9 / 9 绿**。

**验证数字（node v22.18.0）**

| 项 | 结果 |
| --- | --- |
| 我名下 9 个测试文件 | **101 / 101 pass，0 fail，0 skipped** |
| **前端全量** `node --test "test/*.test.js"` | **410 / 410 pass，0 fail，0 skipped** |
| eslint（4 个改动文件） | **0 error**（`ChatView.vue` 45 条 warning 全是改动前既有行） |
| 变异验证 9 例 | M1 groupId 假值判空吃掉 0 / M2 不带 scene / M3 合并器不再合并 / M4 消息变化不触发刷新 / M5 群聊调错端点 / M6 丢掉竞态守卫 / M7 路径角色无回落（**第一版没抓到，已加强断言后抓到**）+ 前两轮 2 例 —— **全部被抓到**，还原后均 9/0 |

**动到的既有测试**：`touchActionWiring.test.js` 对「切角色重拉动作清单」的整行断言改成宽松正则（该 watch 现在多了取消 + 重拉条数）；`touchActionGroup.test.js` 的 fake state 补 `loadTouchState` 并断言动作结束后会刷新条数。两处都是**加强**，不是放宽。

**已知边界**

1. **合并窗口 350ms**：一轮消息若拖得比这更久会再刷一次（可接受；要严格「一轮一次」得靠后端给轮次 id）。
2. **群聊提示是「整群」口径**，所以换动作对象时数字不变 —— 与后端语义一致，不是 bug。
3. **没跑真机**：按 §6.11 契约对齐；真机请点一次确认群聊提示出现、并在她回应后消失。

### 6.13 交互改版：入口「常驻动作条」→「✋ 图标 + 底部弹层大卡片」（2026-09-30 · 文档口径归档 · intimate-hypno）

> 本节的职责：把**改版的设计口径**钉在这里（前端实现见写手的实施记录；本轮只动文档 —— `目标/操作流程.md`、`build-release.mjs` 的 `buildUsageGuideText`、本节）。
> 上游依据：`目标/规划/专题-动作交互改版.md`（用户原话①「触摸系统在对话框上面而且还是复选框 不太好点」②「放在最右边吧」——**本文只补文档面**）。

**1. 入口形态与位置裁决**

| 项 | 定案 | 理由 |
| --- | --- | --- |
| 形态 | **方案 A**：删掉常驻条，改为输入区最右的 **✋ 图标** → **底部弹层 + 大卡片网格** | 零常驻占地（痛点「压在输入框上」）；卡片目标大（痛点「小胶囊难点」）；**完全复用送礼面板 `GiftPanel` 的形态**（底部对齐 + 卡片网格 + 遮罩关闭），用户零学习成本，符合 AGENTS.md「优先复用现有组件与设计模式」 |
| 位置 | `[配图模式] [输入框] [🎁礼物] [✋动作] [发送]` —— 动作紧贴**发送按钮左侧** | 用户说的「放最右边」= 图标排的右端；发送是输入区的终点语义，插到发送右侧会破坏「最后一步是发送」的动线 |
| 例外 | 若某端形态下 `.send-btn` 是独立浮动/孤岛，**动作直接放最右、发送保持原位** | 总原则：**别让「放最右」变成「难找到」**（`专题` §3.1 布局裁决原文） |
| 不做 | 不点消息头像/立绘直接摸（头像=角色设置是既有心智，立绘窗口是服务端独占通道）；不做自定义动作收藏夹 | 防范围膨胀（`专题` §3.4） |

**2. 卡片分组**

- 三段分组沿用服务层冻结清单：**日常 6（摸头/拍拍肩/拉手/抱抱/挠痒痒/捏脸）+ 亲密 5（摸头发/摸背/搂腰/亲脸颊/贴贴）+ 敏感 5（摸胸/摸臀/摸大腿/腰部游走/耳后吹气）= 16**；面板内容**垂直滚动**（3 列 × 约 6 行 + 3 个分组标题），比横向滚 16 颗胶囊好找。
- 卡片**状态外显**（替代原来「🔒 前缀 + title 悬停」）：可用＝底部小字写**耐受档**（`ANNOYANCE_TIERS` 文案）；门控拒绝＝半透明 + 底部写**服务端 `gate.message` 原句**；偏好＝右上角 **♥/～** 小角标（`like_ratio` ≥1.25 / ≤0.75，源 `likeRatioText`）；上报中＝该卡片 loading，连点忽略。
- **面板不自动关**（SLG 玩法就是连着摸）：反应由后端广播进消息流，弹层不挡消息区；做完刷新卡片状态行。

**3. 必须保留的旧行为（一条都不能丢）**

1. **门控**照旧吃服务端（`GET /touch/actions` 逐条 `gate`）：拒绝项**仍然可点** → 弹服务端那句剧情化 message（`allowed:false` 是叙事结果，不是请求失败）。
2. **防连点**：`busyAction` 守卫照旧（请求期间该卡片 loading、忽略重复点击）。
3. **群聊「对谁」**：入口先弹成员面板（复用 @ 提及那块），面板顶部常驻「对 XXX」胶囊可随时换人；端点仍带 `scene=group&groupId`。
4. **催眠豁免**：服务端 `gate.exempt='hypnosis'` 口径不变（前端不自行判定）。
5. **双主题**：暖色 / 暗夜都走既有 token。
6. **0.3s 过渡**：弹层渐入渐出，**关闭动画跑完再卸载**（AGENTS.md 硬要求）。
7. **移动端**：与 🎁 礼物同规则（`isMobile && inputFocused` 时隐藏入口，键盘弹起不挡输入）；面板仍 3 列。
8. **数据源零变化**：`GET /touch/actions`（逐条 gate）、`POST /touch/:action`、`GET /touch/state`（pendingCount）三个端点与 `loadTouchActions` / `onTouchAction` / `loadTouchState` 接线**原样复用**，只换渲染层。

**4. 待回应提示的两个位置**

「还有 N 个动作等她回应」现在**两处同时给**：① **入口 ✋ 图标上的角标数字**（不打开面板就能看到）；② **弹层顶部那一行小字**。两处都只在 **N>0** 时出现，她回应完一起消失。（本节之前的 §3.8 / §6.9 / §6.12 只写了「动作条上方」那一处 —— 那是改版前的位置描述。）

**5. E2E 断言跟着改到哪两处**

| # | 位置 | 改什么 |
| --- | --- | --- |
| ① | `e2e/run-e2e.mjs` 的**入口存在性与分组/门控断言**（现 A2 / A3a / A3b / A5 / A7） | 选择器从 `.touch-bar*` 换成新链路：**输入区右端的 ✋ 图标 → 底部弹层 → 卡片**；三档仍是 6/5/5 且亮灰必须与服务端 `gate` 表逐条一致；**置灰卡片带 `is-disabled`（等价于旧的 `aria-disabled`）时点击要 `force:true`** —— 行为断言照搬，只是选择器换了 |
| ② | `e2e/run-e2e.mjs` 的**「点动作出反应」链路断言**（现 A4 / A8 / A9） | 动作元素从胶囊换成**面板里的卡片**；断言内容不变：发出 `POST /touch/:action`、反应落库并出现在消息流、**刷新后仍在** |

（前端单测侧 `touchActionBar.test.js` → 面板测试属于写手那条线，不在本节范围。）

**6. 文档面口径与实测（本轮，Lead 裁决：直接替换）**

口径：**把旧入口描述直接替换**成改版后的形态 —— 「只增不删」那条纪律的目的是**防误删内容**，不是让用户手册同时写两套矛盾的入口说明。**以下 3 行是「有意替换」，不是误删**；除它们之外一行未删。

| 被替换掉的旧句（生成物里已消失） | 换成 |
| --- | --- |
| `- 入口：聊天页输入框正上方有一条动作条，默认收起成一颗「动作」胶囊，点开是一排可以左右滑的动作` | `- 入口：聊天页输入区最右端、发送按钮左边有一颗 ✋（手掌）图标（和 🎁 礼物并排）；点它打开底部弹层大卡片面板` |
| `- 群聊里也能用，但要先选人：点「动作」先弹成员面板，选好「对 XXX」再选动作` | `- 群聊里也能用，入口同样是这颗 ✋：点它先弹成员面板选「对谁」，选完直接进面板；面板顶部有「对 XXX」可随时换人（没选人时点卡片会提示先选目标）` |
| `- 动作条上方的「还有 N 个动作等她回应」是正常提示：…` | `- 「还有 N 个动作等她回应」在两个地方显示：① ✋ 图标上的角标数字；② 点开面板后顶部那一行 —— 两处数字一致…` |

- 生成物实测（`node scripts/build-release.mjs --usage-guide-only <tmp>`，改前那份与仓库 `使用说明.txt` 逐字节一致）：**非空行 90 → 94；删除 3 行 / 新增 7 行**，被删的 3 行全部与入口形态有关。
- 残留旧提法实测全 `false`：`输入框正上方` / `输入框上方` / `收起成一颗` / `左右滑的动作` / `动作条上方`；新口径关键词全 `true`（`输入区最右端、发送按钮左边` / `✋` / `底部弹层大卡片` / `三段分组` / `对 XXX` / `还有 N 个动作等她回应`）。
- `目标/操作流程.md` 同步直接替换：§12 旧入口段 → 新入口段（**16 个动作清单没丢**，移进「面板」那条），§15 合成「两个位置」一条。
- 文案与实现对齐依据（只读核对）：`TouchActionPanel.vue`（`.touch-pending` 顶部待回应行、`对 {targetName}` 胶囊、`group.label` 三段分组、`is-disabled` + 状态行 = `gate.message` / 「会把她弄醒」/ 耐受档、偏好角标、busy spinner、Teleport + Transition 0.3s）；两个页面的入口 `.touch-icon-btn` + `.touch-icon-badge`（`pendingCount>0` 才显示）。

## 7. 反应喂料扩容：对话式反应（task-30，2026-09-30，写手 hypno-core）

**为什么**：用户原话③「触摸可以触发对话那种 根据现状提交到AI去反应 不是写死的」。核实结论：即时反应**一直是真 LLM 调用**（`chatSync` + JSON），「像写死的」真因是**喂料薄 + 输出口径锁死**（只喂短人格 + 情绪 + 最近 2 条 + 耐受/偏好；system 明写 1~2 句、不要推进剧情）。本轮把「现状」喂全，仍**只调一次**。

**两个模式**

| 模式 | builder | 喂料 | 长度 | max_tokens |
| --- | --- | --- | --- | --- |
| `conversation`（默认） | 新增 `buildConversationReactionPrompt` | 全量（见下表） | 1~4 句、可接话/抛话 | **500** |
| `quick`（一键回退） | `buildReactionPrompt`（**原样保留**） | 短人格 + 情绪 + 最近 2 条 + 耐受/偏好 | 1~2 句 | 300 |

开关（**已落地**）：`config.features.touchReactionMode` —— 取值 `conversation`（默认）/ `quick`；env `FEATURE_TOUCH_REACTION_MODE`；落库键 `feature_touchReactionMode`（`db/settings.js`，type string）。
非这两个值一律回落 `conversation`（`updateFeatureFlag` 的二态分支）。通用 `PUT /api/config/features` 直接可用：`{ key: 'touchReactionMode', value: 'quick' }` → `{ ok: true, features: {...} }`；`GET /api/config` 的 `features.touchReactionMode` 即生效值。

**喂料清单（对话式）**

| 位置 | 内容 | 来源（全部复用既有 builder，一行不重写） |
| --- | --- | --- |
| system | 角色人格 | `readPersona`（现状） |
| system | 当前情绪 | `emotionToPrompt(loadEmotionState)`（现状） |
| system | **关系 / 好感档位** | `emotionEngine.affinityToPrompt(loadAffinity)` |
| system | **她此刻正在做的事** | `scheduleManager.formatScheduleContext` |
| system | **亲密档案** | `intimatePrompt.buildIntimateProfileBlock`（开关关 / 档案空 = 跳过） |
| system | **催眠状态**（完全控制口径） | `hypnosisService.getHypnosisState` + `hypnosisPrompt.buildHypnosisStateBlock`（没催眠 = 跳过） |
| system | 她对动作的偏好 + 当前耐受 | 现状 |
| user | **最近 8 条对话**（按场景取 `char_<id>` / `group_<gid>`） | `readRecentLines(limit=8)`（现状为 2） |
| user | 动作定义 + 等级 + 场景（私聊 / 群聊 + 是否有人看得到） | 现状 |
| user | **同一动作刚发生过（≤5 分钟）⇒ 这一下回短一点** | `readRecentSameAction`（防同一摸演两遍） |

**输出口径**：1~4 句、第一人称、可长可短；**允许顺着当前话题接话、追问、打趣、抗议**，并**允许在结尾向他抛一句话**（「触摸触发对话」的闭环：摸 → 她对话式回应并可能抛话 → 用户回 → 正常聊天轮继续，**不加任何新管线**）；`annoyed` 时不许抛。JSON **四字段不变**（`reaction_text` / `emotion_delta` / `facial_expression` / `annoyed`）—— 下游解析、心情、立绘、看板记账一行未改。

**可观测**：① 响应新增 `reactionFeed = { mode, rounds, blocks[], failed[], sameAction, maxTokens }`；② 每次反应打一行日志：
`[touch] reaction feed mode=conversation rounds=8 blocks=affinity,schedule,hypnosis failed=none chars=3120 sameAction=no`。

**容错**：四个新喂料块**各自 try/catch**（拿不到 / 抛错就跳过并记进 `failed`），**绝不让动作失败**；单测接缝 `routes/touch.js` 的 `__setTouchFeedBuildersForTest(patch)`。

**成本**：仍是**一次**调用；上下文约 8 倍 + `max_tokens` 500；每日配额（100）与「首次动作的偏好初始化」那一次调用都不变（初始化只在首次）。快速模式可随时一键回退。

**测试（先红后绿）**：`test/touchActionService.test.js` 的 L 组 3 例（四块喂料 / 8 条窗口 / 对话式口径 / 完整 JSON 示例 / 快速版逐字节回归）；`test/touchRoutes.test.js` 4 例（默认模式喂料+回执+日志、快速模式回退、单块抛错容错、同动作回执）。
红→绿：服务 **32 pass / 2 fail → 34 / 34**；路由 **35 pass / 4 fail → 39 / 39**；`test/touch*.test.js` **113 / 113**；`touch* + hypnosis* + chat*` **271 / 271**。

**边界**：① `touchReactionMode` 的配置键与设置页 UI 不在本轮（属主补键后即可切换）；② 群聊的**会话上下文只读群会话**（现状口径，窗口扩容不改来源），好感/日程/催眠/档案属「她自己的状态」可以喂；③ 快速模式保留 2 条窗口以保持逐字节回退；④ 真实 LLM 的对话式反应质量未验（测试用本地假上游）。

## 8. 真机问题 3：待回应计数口径修正（2026-09-30，写手 hypno-core）

**现象**：即时反应成功（气泡已出现）后，角标/面板仍显示「还有 N 个动作等她回应」，**只涨不减**——用户不回话就永远占着。

**根因**：`countPendingTouchEvents` 数的是 `status IN ('pending','done')`，而即时成功的事件状态就是 `done`（反应已作为独立消息发出），
要等下一轮聊天被 `takePendingTouchEvent` 消费才变 `injected` ⇒ `done` 一直占着计数（30 分钟 TTL 内连过期都不会）。

**改动（治本，只改计数）**

| 文件 | 改动 |
| --- | --- |
| `services/touchEventStore.js` | `countPendingTouchEvents` 两个作用域的 SQL 都改成 `status = 'pending'`；新增 `countPendingTouchEventsByMode(characterId, { groupId })` → `{ instant, implicit }`（同口径同作用域） |
| `routes/touch.js` | `GET /:id/touch/state` 响应新增 **`pendingByMode`**（生效场景：私聊 = 私聊口径，`scene=group&groupId` = 该群口径） |
| `docs/touch-system.md` | 本节 + §3.8③ 的口径与字段表同步 |

**边界（刻意不动）**

- `takePendingTouchEvent` **仍然吃 `pending + done`** —— `done` 的「已发过别再演」块注入是刻意设计（§3.8①）；`markTouchEventInjected` / `expireStaleTouchEvents` / `touchEventCutoff` 一并照旧。
- 群聊口径同样只数 `pending`（`group_id = ?` 分支）；`pendingCounts.chat/group` 语义不变，只是数值口径跟着收紧。
- 前端文案分工：`pendingByMode.implicit > 0` 才提示「她还没回应你的动作，跟她说句话吧」；`instant` 一般恒为 0（即时成功即 `done` 不计），只有即时调用失败回落隐式时才会计入（此时它已经走 `!parsed.ok` 的 `pending` 路径）。

**测试（先红后绿）**

- 红：`touchEventStore` 首跑 **9 pass / 4 fail**（`expected 1 / actual 2`、`countPendingTouchEventsByMode is not a function`）；`touchRoutes` 首跑 **39 pass / 3 fail**（缺 `pendingByMode`）。
- 绿：`touchEventStore` **13 / 13**、`touchRoutes` **42 / 42**（合计 55 / 55）。
- 用例钉住：只数 pending（done 不算）、隐式 pending 消费后归零、**消费链仍吃 done**（含路由级：先被取走的是那条 `done`，消费它计数不变）、`pendingByMode` 形状与群聊口径、即时成功（`done`）后 `pendingCount = 0`。

**用户手册同步（2026-09-30 · 有意替换，特此写清）**

专题 §七 改动面第 5 条要求用户手册同步新口径。按「只增不删」纪律，下面是**有意替换**的 5 处原文 → 新文（均只动这几句，其余未动）：

| 位置 | 原句（旧口径） | 新句（只数「还没反应」） |
| --- | --- | --- |
| `目标/操作流程.md:167`（§10 FAQ 行） | 「这是正常提示：做下的动作还等着她回应（隐式模式下会并进下一轮），她回应完就自己消失」 | 「这是正常提示，但**只统计「还没反应」的动作**：即时反应发出后不再计数；只有隐式模式下做下、还没演的才算……（2026-09-30 口径修正）」 |
| `目标/操作流程.md:191`（§12 入口角标） | 「（做下但还没被她回应的条数）」 | 「（**只数还没反应的动作**：即时反应已单独发出 ⇒ 不计；只有隐式模式下做下、还没演的动作才算）」 |
| `目标/操作流程.md:242`（§15 两个位置） | 「那是已经做下、还等着她回应的动作（隐式模式下它们会并进下一轮）」 | 「两处数字一致，**只数「还没反应」的动作**……」+ 新增一行「隐式动作写『她还没回应你的动作，跟她说句话吧』；即时动作不显示这行」 |
| `scripts/build-release.mjs:318`（`buildUsageGuideText`） | 「（做下但还没被她回应的条数）」 | 同上口径化 |
| `scripts/build-release.mjs:327`（`buildUsageGuideText`） | 「它只是提示（做下的动作还等着她回应）」 | 「**只数「还没反应」的动作**（即时反应已单独发出 ⇒ 不计……）」+ 新增一行隐式文案说明 |

（`buildUsageGuideText` 只改了这两行字符串；`node --check scripts/build-release.mjs` 通过。`使用说明.txt` 的重新生成归发布线，我没跑生成。）

## 9. 真机第二轮（慢）：私聊即时反应改两段式（2026-09-30，写手 hypno-core）

**根因（日志实测）**：LLM 反应只要 2.4~3.3s，慢的全是 ComfyUI 出图（单张 ~5s，单卡串行排队时 10~40s）。而私聊分支是**先出图再广播**
（`touch.js` 注释写着「`proactive_message` 没有 message_update 事件」）⇒ 2 秒就写好的文字被图劫持，图没好整条都不上屏。

**改动（与群聊同款两段式）**

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `routes/touch.js` 私聊分支（`else` 段） | 顺序反转：先 `writeProactiveMessage` + `broadcastProactiveMessage`（**`images: []`**）⇒ 文字 ~3s 上屏；`generateTouchImageForReaction` **不 await**（`Promise.resolve().then(...)`）放后台 |
| 2 | 同上（后台回调） | 图好了：`attachImagesToMessage` 挂到那条消息 + `recordTouchImageTask` 记账 + **广播新事件 `proactive_message_update`** |
| 3 | 事件形状 | `proactive_message_update` = `{ msg_id, raw_id, images }`（`msg_id` = 第一段那条气泡的 `firstMsgId`，前端靠它找气泡挂图）。**刻意不复用 `group_message_update`**（那是群聊 store 的契约） |
| 4 | 失败 | 出图抛错 ⇒ **不发 update**（文字已在屏上，无损），只 `console.warn('[touch] 私聊配图后台生成失败（文字已上屏，不下发 update）')` |
| 5 | 响应 | `res.json.images` 固定为 `[]`（图不再同步返回；群聊分支**保持不变**，仍是同步 images + `group_message_update`） |

**事件白名单核实**：`services/unifiedStreamBus.js` 的 `broadcast(eventType, data)` 是**通用 SSE 广播、没有事件白名单**；`routes/stream.js` 只做 `addClient`。
⇒ agent-core 侧**无需登记**（`app.js` 不用改）。前端订阅侧由 web-ui 那条线接（`unifiedStream.js` 分发 + `chat.js` 按 `msg_id` 挂图）。

**测试（先红后绿）**：`test/touchImageStats.test.js` 用出图接缝 `__setTouchImageGeneratorForTest` + 新增「扣住出图」（`imageStub.hold` / `releaseHeldImages()`）与 `peekSse()`（只看不取）：

- 红：`touchImageStats.test.js` **16 pass / 3 fail** —— 「文字先上屏（出图被扣住时 `proactive_message` 应已到）」超时失败；另两条旧用例还在等 `res.json.images`。
- 绿：**19 / 19**；`touch*.test.js` 合计 **121 / 121**。
- 用例钉住：① 出图扣住时 `proactive_message` 已到且 `images` 为空、此时**没有** update；② 图完成后 update 到达且 `msg_id` = 第一段、`raw_id` 在、`images` 正确、**私聊场景 `group_message_update` 为 0**、DB 那条 messages 也挂上图、`image_tasks` 记账；③ 出图失败 ⇒ 只有文字、**不发 update**；④ 群聊既有两段式回归不受影响（`group_message` + `group_message_update` + 同步 images 全绿）。

**边界**：出图仍在**主流程之外**排队（单卡串行不改）；后台任务的异常全被 catch，绝不影响响应与落库；`proactiveChatScheduler` 主动聊天的配图路径**未改**（仍是「图文一起广播」的一次性口径）。

## 10. 三期真机反馈：出图直白 / 催眠反抗 / Lv4 群聊解禁 + 围观插话（2026-09-30，写手 hypno-core）

### 10.1 §一① 出图直白：反应 JSON 加 `image_prompt`（图文同源）

- 两个反应 builder（`buildConversationReactionPrompt` / `buildReactionPrompt`）的 **JSON 示例与字段要求都加了 `image_prompt`**：要求**英文**、**直接描述此刻正在发生什么**（动作/姿势/她的状态/衣着现状/表情），与 `reaction_text` 完全一致，**不回避、不用暗示性遮掩**；没有画面就给空串。
- `parseReactionOutput` 提取 `imagePrompt`（非字符串不认、裁到 `MAX_IMAGE_PROMPT_CHARS=400`）⇒ 反应结果多了 `imagePrompt` 字段。
- `buildTouchImagePrompt({ imagePrompt })`：**优先用 LLM 现写的画面**，`TOUCH_IMAGE_HINTS` **降级为兜底**（缺失/空串才用）；情绪词、场景句、外观块、画质词照旧。
- `routes/touch.js` 的两条出图调用都把 `parsed.imagePrompt` 传进 `generateTouchImageForReaction`（私聊后台补图 + 群聊两段式都传）。
- 边界：中文 `reaction_text` 仍作为「反应原文」拼在画面之后（最多 60 字，既有口径不变）；负面提示词/工作流仍是用户侧配置（§一① 已核实无代码级拦截，未动）。
- 测试：`touchActionService.test.js` 三条（解析提取 / 优先用现写、缺失回落模板 / 两个 builder 示例与要求）；`touchImageStats.test.js` 一条**图文同源**（出图接缝收到的 prompt 第一句 = 这一轮 LLM 写的 `image_prompt`，且不含预写模板）。

### 10.2 §4.1 催眠反抗的真根因：三条 prompt 指令打架（三处小改）

| # | 位置 | 改动 |
| --- | --- | --- |
| ① | `routes/touch.js` ① 段 | `nextAnnoyance({ suppressGain: inputs.hypnotized === true })` —— **催眠轮只衰减不叠加**腻烦（存量照常衰减、不清零），门控的 `hypnotized` 豁免同口径 |
| ② | 两个 builder | 新增 `hypnotized` 入参：为真时**耐受行整行换成降级文案** `HYPNOSIS_TOLERANCE_TEXT`（「催眠中：耐受无效，身体无条件接受，情绪反应只走内心与台词」），并把写作要求里那条「必须躲开或拍掉他的手」也换成「身体无条件接受、不要写躲开/拍开/阻拦」——`refusing` 档因此**整个短路** |
| ③ | `hypnosisPrompt.js` 的 `HYPNOSIS_WILL_AWAKE_NOTICE` | 补一句「她的手**不会**拍开、躲开或阻拦任何接触——只能眼睁睁看着自己承受，用语言表达不甘」（意志清醒态；完全控制态口径未动） |

- 测试：`touchRoutes.test.js`「催眠连点 5 次腻烦仍为 0 / 非催眠照常叠加」；`touchActionService.test.js`「催眠时耐受行是降级文案（两个 builder 一致、且不再出现『必须躲开或拍掉』）」；`hypnosisPrompt.test.js`「意志清醒态块里能读到这句、完全控制态不变」。

### 10.3 §一③ Lv4 群聊解禁 + 即时反应顺带围观插话

- **门控**：`getTouchGate` 的群聊分支合并为一条 —— **Lv3 与 Lv4 同口径**：`scene === 'group' && adult && !allowGroupAdult` → `group_adult_blocked`（文案不变）。§10.1 的「Lv4 群聊无条件拦」裁决**由用户作废**（用户要群聊里也能用私密动作且有旁观者）。
- **围观插话并入同一次调用**（省额度）：群聊即时反应前用既有纯函数 `planTouchBystander()`（默认 30%、单轮最多 1 人、注入随机源）掷一次；命中就把 `bystanderName` 传给反应 builder —— prompt 要求她在 `reaction_text` **末尾另起一行**写 `[名字]: 一句插话`。
- 落库/广播：`splitBystanderLine()` 把那行拆出来（**她的气泡只留她自己的话**），随后用**那位成员的字符行**再 `writeGroupTouchMessage` + `broadcast('group_message')` 一条（payload 带 `speaker_character_id` / `speaker_name`）⇒ 一步之内「她的反应 + 围观者插话」各一条。
- 边界：仍是**一次 LLM 调用**（不加调用、不加配额）；掷不中/没别人/群聊关闭概率时行为与改动前一致（只广播她那条）；围观插话写入失败只 warn；`groupTouchConsumption.js` 只**只读复用**，未改。
- 测试：`touchActionService.test.js` 门控矩阵（开关关着仍拦、开着放行）；`touchRoutes.test.js`「命中时两条 `group_message`、第二条是另一个角色（DB `speaker_character_id` 钉住）、`stub.calls === 1`（同一次调用）」。

### 10.4 数字（先红后绿）

| 件 | 红（首跑） | 绿 |
| --- | --- | --- |
| `touchActionService.test.js` | §一①/§4.1 三条新用例 + Lv4 群聊门控用例红（`image_prompt` 缺失、耐受行仍写「必须躲开或拍掉」、Lv4 群聊仍需放行） | **41 / 41** |
| `touchImageStats.test.js`（图文同源） | 接线后首跑即绿（判别力由「第一句 = 现写画面」「不出现预写模板」两条互斥断言保证） | **20 / 20** |
| `touchRoutes.test.js` | §4.1① 腻烦用例、§一③ 围观用例红（只广播 1 条 group_message） | **44 / 44** |
| `hypnosisPrompt.test.js` | 常量补句前红 | **19 / 19** |
| 后端全量 | — | **1301 tests / 1298 pass / 0 fail / 3 skipped** |

真实库指纹：收工时 **17244160 bytes / 2026-09-30 15:15:27**（较上一轮 2.5MB 明显增长 —— 是**运行中的应用本体**在写，本批测试全在 `:memory:`，未写真实库）。
