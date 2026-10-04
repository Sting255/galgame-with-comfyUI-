# 上下文余量面板（task-35）

**用户口径**：全局左上角一个「当前上下文还剩多少」的面板（参考 DSH 那种：百分比 + `~used / total` + 进度条 + 分项），
再加「用了多少 token」和卡片里的**压缩上下文**按钮；**添加模型时可以声明模型的上下文窗口**。

## 数据来源（都是真实值，不猜）

- **窗口**：三级回退 `declared`（模型配置里用户填的 `contextWindow`）→ `provider`（`GET /v1/models` 的
  `context_length` / `context_window` / `max_allowed_size`；`max_output_tokens` 是输出上限**不**当窗口）→ `default`（128000）。
  本项目真机实测网关报 `cn:deepseek-v4-flash` 的 `context_length = 1000000`，来源记 `provider`。
- **已用**：最近一次**真实请求**的 `usage.prompt_tokens`（`llm-client` 已有 usage 解析，`AsyncLocalStorage` 把它贴回对应会话快照；
  `planner` / 生图判断 / 记忆整理等旁路调用**不污染**主回复用量）。拿不到时退化成按字符估算，并在 `source` 里如实标 `estimate`。
- **分项**：在 prompt **组装点**就按块标签分桶（`rag_memories` / `user_portrait` / `hypnosis_*` / `round_directive` / 历史 / 系统块…），
  私聊两处 `buildChatContext` 与群聊 `buildGroupContext` 各记一份；分项 `tokens` 是**按字符估算**（中文 ≈ 字数/1.6），
  所以分项之和与顶层 `usedTokens` 会有偏差（实测约 -14%），**真实值以顶层 + `source: last-request` 为准**。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/context/usage?conversationId=char_2` | `contextWindow` / `contextWindowSource` / `usedTokens` / `usedPercent`(0~100) / `remainingTokens` / `source`(`last-request`\|`estimate`\|`none`) / `breakdown[]` |
| `POST /api/context/compress { conversationId }` | 复用既有滚动摘要 + 记忆整理；409 = 正在压缩；无内容时 `summaryCreated: false`；超 HTTP 预算（默认 8s）转后台并返回 `summaryCreated: null`（不假装已压缩） |
| `PUT /api/config/llm` | 新增 `contextWindow` / `contextWindowSource`；留空则先探测上游（`declared`/`provider`/`default` 三级回退） |

## 前端

`web-ui/src/components/ContextUsagePanel.vue`（挂 `App.vue` 的 `.page-host` 内、绝对定位 → **结构性不会压住侧栏**）；
收起态 = 环形进度 + 百分比胶囊，展开态 = 「上下文已用 33%」「4.4K / 1.0M」+ 进度条 + 分项 + **压缩上下文**按钮；
占用分档 `<70%` 主色 / `≥70%` 警示 / `≥90%` 危险；展开收起与进度都是 0.3s 过渡；纯逻辑在 `web-ui/src/utils/contextUsage.js`。
模型表单（`SettingsView.vue`）新增「上下文窗口」输入，留空 = 由服务端探测。

## 验证与已知边界

- 新增测试：后端 `test/contextUsage.test.js` 28 项、前端 `test/contextUsage.test.js` 26 项；
  全量 **后端 782 / 779 pass / 0 fail / 3 skipped**、**前端 222 / 222**。
- 真实样例（真机发过一轮聊天）：`usedTokens: 1511` 与上游日志 `[cache] 主聊天流: 命中 128/1511 prompt tokens` **一致**。
- **未做**：浏览器里真机点击验证（收起/展开观感、两套主题对比度、过渡手感需人工确认一次）。
- **快照只在内存**（上限 500 条）：重启后面板回到 `source: none` 空态，直到下一次请求。
- 「压缩」用的总闸是既有的**记忆总开关** `config.features.memory`（项目没有独立的压缩开关）。
- 群聊压缩不推进 `group_chats.rag_user_rounds_pending` 计数器（checkpoint 正常前进，代价是自然轮次到点可能空跑一次整理，无 LLM 调用）。
- `agent-core/public/` 根目录的 `letter-paper.avif` 与 `Whimsy of the Village.mp3` 不在 Vite 构建图里（手放的静态资源），
  本次构建后仍在；若哪天清目录行为变化它们会丢，建议挪进 `web-ui/public/`。
## 追加（2026-09-30）：稳定前缀指纹进面板 payload（代码审查改进 §2.3）

**背景**：架构上稳定前缀（世界观/人格/格式规则）与动态尾部（`<dynamic_context>` 贴最新 user 消息）已经分离，
`buildChatContext` 也早就算好了 `metadata.stablePrefixHash` / `fullPrefixHash` / `requestHash`；
`llm-client` 还会打 `prompt_cache_hit_tokens`。缺的是把两者连起来 ——
**面板无法回答「这轮缓存命中掉了，是稳定前缀变了还是只有动态尾部变了」**。

**改动（纯加法，不改 prompt、不改 token 统计）**：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 组装点 | `routes/chat.js`（`recordContextUsage` 调用处） | 把 `metadata` 的三个指纹作为 `prefixHashes` 传给 `recordContextUsage` |
| 快照 | `services/contextUsage.js` | 快照与 payload 各多三个可选字段；缺省 `null`（老调用点/群聊不传） |
| 接口 | `GET /api/context/usage` | 顶层新增 `stablePrefixHash` / `fullPrefixHash` / `requestHash` |

**契约（给前端）**：键的顺序锁定为
`conversationId, model, contextWindow, contextWindowSource, usedTokens, usedPercent, remainingTokens, source, updatedAt, stablePrefixHash, fullPrefixHash, requestHash, breakdown, breakdownCalibrated`。
三个新字段是**纯加法**：老前端忽略未知键即可；取值可能是 `null`（该轮没记录指纹 / 群聊链路）。
建议面板做法：与**上一轮**同会话的三个值比较，`stablePrefixHash` 变化 → 标「稳定前缀变化」，
只有 `requestHash` 变而 `stablePrefixHash` 不变 → 标「仅动态尾部变化」（后者不破坏前缀缓存）。
**前端一行显示仍待前端写手接**（本轮只做后端 payload）。

验证：`agent-core/test/contextUsage.test.js` 新增 2 条（指纹进 payload / 前一轮对比变化；未传时三字段为 null），
并同步扩了那条「形状严格」的键序断言（原本只锁到 `breakdownCalibrated`）。

## 收尾（task-37）：快照落库 + 分项标定 + 窗口惰性探测

- **快照落库**：只保留最近 200 个会话（按 updatedAt 淘汰）；重启后仍可读到上次用量，但 `source` 用**新取值 `snapshot`**（从持久化快照读到的上一次用量），不冒充 `last-request`；`updatedAt` 供面板显示「更新于 xx:xx」。
- **分项标定**：`breakdown[].tokensCalibrated`（按真实总量等比分摊）+ 顶层 `breakdownCalibrated`；估算值**不覆盖**，面板在标定时标「分项已按真实总量标定」，否则标「估算」。
- **窗口惰性探测**：当 `contextWindow` 仍是 `default` 且没有 `declared` 值时，`GET /api/context/usage` 会以短超时探一次上游 `/v1/models` 并缓存（成功 → `provider`，失败不影响接口仍回落默认）；因此面板不再出厂显示 128000。
