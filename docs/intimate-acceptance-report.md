# 亲密看板 最终验收报告（task-6）

- 验收人：settings-ui（对抗式验收；未修改任何生产代码，仅新增本报告与 `test/intimateWithdrawRollback.test.js`）
- 工作树：`<ComfyUI 安装目录>
- 复跑时点：**2026-09-28 12:04 – 12:25**；**最终复跑 12:22:43**（见文末「移动靶声明」）
- 交付物：本文件 + `agent-core/test/intimateWithdrawRollback.test.js`（P1 回归，4/4）+ 给 lead 的汇报

---

## 0. 结论

**通过（附 1 条已闭环的 P1 + 3 条已知小瑕疵）**

- 功能主体（权限闸门、口径过滤、回填引擎、注入块、AI 整理、级联删除、群聊/奇遇/镇民场景）经独立复跑与真实 HTTP 冒烟**全部符合设计**。
- 验收中发现 **1 个 P1 缺陷**（撤回锚点错位）→ **已由 lead 修复**，本次验收**已独立复验闭环**（见 §D.P1「闭环证据」），并新增正式回归用例 `agent-core/test/intimateWithdrawRollback.test.js`（4/4 通过，直接驱动真实 chat 路由）。

| 级别 | 数量 | 状态 | 摘要 |
| --- | --- | --- | --- |
| P1 | 1 | **已修复 + 已闭环** | `DELETE …/messages/last-round` 不回滚自动记账流水（锚点 id 不一致 → 等值删除命中 0 行），`totalActs` 不回落、残留行 raw_id 指向已删 raw |
| P2 | 0 | — | — |
| P3 | 3 | 已知限制 | ① `POST …/ai-edit` 的 502 文案把上游英文原因拼在中文前缀后；② `test/momentUserPostFlow.test.js` 在全量并行下偶发文件级失败（与功能无关，单独跑 25/25 通过）；③ `npx eslint src` 有 5 个既有 error（非本功能文件） |

---

## A. 独立复跑（全部自己执行）

### A1 agent-core 全量

命令（`cd agent-core`，便携运行时已加入 PATH）：

```powershell
$env:DB_PATH=':memory:'; node --test "test/*.test.js" "src/services/*.test.js"
```

| 时点 | tests | pass | fail | 说明 |
| --- | --- | --- | --- | --- |
| 12:04:49 首跑 | 547 | 546 | 1 | 失败项是**文件级**：`not ok 46 - test\momentUserPostFlow.test.js`（该文件没有任何子用例输出，属进程级异常/超时） |
| — 该文件单独跑 | 25 | 25 | 0 | `node --test test/momentUserPostFlow.test.js` exit 0，全绿 |
| 12:07:02 复跑 | 546 | 546 | 0 | 全绿 |
| **12:22:43 最终复跑** | **588** | **587** | **1** | 仍是同一个文件，这次抓到了具体异常（见下），非产品缺陷 |

最终复跑的失败详情（**关键证据**）：

```
not ok 50 - test\momentUserPostFlow.test.js
  type: 'uncaughtException'
  error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
  code: 'ERR_TEST_FAILURE'
  stack: #processRawBuffer (node:internal/test_runner/runner:353:20)
         FileTest.parseMessage (node:internal/test_runner/runner:289:27)
         Socket.<anonymous> (node:internal/test_runner/runner:399:15)
```

即 **Node 自带 test runner 的 IPC 通道反序列化失败**（子进程往 runner 的 socket 写了一条无法反序列化的消息），发生在 `node:internal/test_runner` 内部；该文件自身会 `console.log` 出多 KB 的完整 LLM 提示词，属于"子进程输出过大 + 并行负载"触发的 runner 抖动。三次全量里出现 2 次、单独跑与中途复跑各 1 次通过 → 判定 **环境/框架 flake，与亲密看板无任何因果关系**（该文件是朋友圈用户发帖链路，完全不加载 chat.js / intimate 模块）。

规避建议（如需稳定绿灯）：`node --test --test-concurrency=1 "test/*.test.js" "src/services/*.test.js"`，或把该文件的调试输出改为按需打印。

### A2 web-ui 全量

```powershell
cd web-ui; node --test "test/*.test.js"
```

```
# tests 170   # pass 170   # fail 0   # duration_ms 4893
```

判定：**通过**（最终复跑时点 12:22:43）。

### A3 `npx eslint src`

```
✖ 637 problems (5 errors, 632 warnings)
```

5 个 error 精确清单（**全部在非本功能文件**，属仓库历史遗留）：

| 文件 | 行 | 规则 |
| --- | --- | --- |
| `src/components/BackpackModal.vue` | 54 | `vue/require-toggle-inside-transition` |
| `src/components/town/TownNpcChat.vue` | 126 | `no-unsafe-finally` |
| `src/town/renderers/CanvasTownRenderer.js` | 234 | `no-useless-assignment`（`drew`） |
| `src/town/renderers/CanvasTownRenderer.js` | 260 | `no-useless-assignment`（`drew`） |
| `src/utils/momentShareRenderer.js` | 926 | `no-useless-assignment`（`cursor`） |

本功能新增/修改的前端文件 `web-ui/src/components/character/IntimatePanel.vue`、`intimateLogic.js`、`web-ui/src/api/intimate.js`、`SettingsView.vue`、`CharacterDetailModal.vue` **零 error**。

判定：**通过（历史遗留，与本功能无关）**。

### A4 `npx vite build` + bundle 关键词

```
✓ built in 10.71s      BUILD_EXIT=0
../agent-core/public/assets/index-Cr9Kd_yr.js   1,507.10 kB
../agent-core/public/assets/index-Cjix1hT.css     611.49 kB
```

产物落点 `agent-core/public`（vite.config.js 的 outDir，符合预期）。bundle 内 grep：

| 关键词 | 结果 |
| --- | --- |
| 亲密度看板 | OK（`index-Cr9Kd_yr.js`） |
| 历史对话回填 | OK |
| 亲密信息 | OK |
| 让 AI 根据最近的对话整理档案 | OK |
| `intimate_profile` | MISS（**预期**：该标签由后端注入 dynamicBlocks，不进前端 bundle） |

判定：**通过**。

---

## B. 端到端真跑（临时库 + 真服务）

环境（**没有写 `agent-core/data/agent.db`**）：

```powershell
$env:PORT='3097'
$env:DB_PATH="$env:TEMP\intimate-accept.db"   # 全新临时库
$env:LLM_BASE_URL='http://127.0.0.1:1/v1'     # 兜住"零真实外网流量"：任何真实 LLM 调用立即连接失败
$env:LLM_API_KEY='sk-noop-no-real-traffic'
$env:FEATURE_TOWN/JGROUP_CHAT/WEATHER/SCHEDULE='false'
cd agent-core; node app.js
```

启动日志确认无真实外网往返：`[scheduleGen] … ❌ 最终失败: … Connection error.`（若真打到 DeepSeek，会返回鉴权错误而不是 Connection error）。

| # | 验证项 | 证据（命令 → 关键输出） | 判定 |
| --- | --- | --- | --- |
| B1 | 面板顶层形状 | `GET /api/characters/1/intimate` → 顶层键 `backfill,characterId,counts,firsts,profile,stats`；profile 含 `injectEnabled/aiEditFields/viewScope/backfillEnabled/sensitiveZones`；stats 含 `totalActs/totalClimax/byAct/byPosition/byScene`；默认 `aiEditFields=['stats']`、`viewScope=['user']` | 通过 |
| B2 | 全字段可编辑 + 回读 | `PUT …/profile`（身高/三围/罩杯/备注/敏感带 2 条/injectEnabled/aiEditFields/viewScope/backfillEnabled）→ `GET` 回读全部一致（含中文备注 `肩颈怕痒`、`[{"key":"neck","label":"颈侧","level":4},{"key":"ear","label":"耳后","level":2}]`） | 通过 |
| B3 | 自动记账**永不改写身体档案** | 写入前/后对 `character_body_profile` 整行做字节级对比：`{"height":"168cm","bust":"88","waist":"58","hip":"90","cup":"D","note":"肩颈怕痒","sensitive_zones":"[…颈侧…耳后…]","inject_enabled":1,"ai_edit_fields":"[\"stats\"]","view_scope":["user"]…,"updated_at":"2026-09-28T04:10:57.493Z"}` **before == after（含 updated_at）**；期间写入 1 条人工 `/log` + 1 条自动 `/record` | 通过 |
| B4 | 逐字段 AI 权限 | `PUT …/settings {aiEditFields:['body']}`（去掉 stats）→ `POST …/record {tags:['creampie'],rawId:9102}` → `blocked=true, inserted=0`，该 rawId 零落库；同一状态下 `POST …/log` 仍 `inserted=1`；恢复 `['stats']` 后自动记账 `inserted=1, blocked=false` | 通过 |
| B5 | 统计口径 | 3 条流水（partnerKind=user/character/npc）逐个切换 `viewScope`：`['user']`→totalActs=1/partnerKinds=[user]；`['character']`→1/[character]；`['npc']`→1/[npc]；三类全勾→3/[user,character,npc]；**空数组→自动规范化为 [user]**（totalActs=1）；`?partnerKinds=all` 逃生门→3；脏值 `['nope','user','nope']`→规范化 `['user']`；byPartner/byScene 与口径一致 | 通过 |
| B6 | 历史回填真引擎 | 造 3 条 `char_1` assistant raw（2 条带成人 tag、1 条无 tag）+ 1 条 `char_2` raw → `POST …/backfill` → `scanned=3, inserted=2, status=done`，流水 2 行且 `char_2` 未串味；重复 POST→仍 2 行；`…/backfill/reset` + 再 POST→仍 2 行；`{maxMessages:1}`→`status=partial, scanned=1, lastRawId=13`，再 POST→`done, scanned=3`，仍 2 行 | 通过 |
| B7 | 回滚一致性 | **修复前不通过、修复后通过**：`POST …/rollback {rawId}` 同 id 时正常回落；`DELETE …/messages/last-round` 修复前残留脏计数（见 P1），修复后 `totalActs 1→0`、残留流水 0 行（见 §D.P1 闭环证据） | **通过（已闭环）** |
| B8 | AI 整理档案 | `GET …/ai-edit/suggestions` → 顶层 `{suggestions:[…]}`；无素材 → `POST …/ai-edit` 返回 `{"applied":[],"suggestions":[],"empty":true}`（HTTP 200，未调 LLM）；`PUT /api/config/features {key:'intimate',value:false}` → `POST …/ai-edit` → **409** `{"error":"intimate feature disabled","disabled":["intimate"],…}`（与前端 `translateIntimateError` 的识别串一致），且关闭时面板仍可读；恢复后手工 INSERT 一条 pending 提议 → `GET` 可见（含 `fieldLabel/suggestion/currentValue/payload`）；`accept` → 档案写入 + `status=accepted`；`reject` → 档案不变 + `status=rejected`；未知 sid → 404；pending 列表清空 | 通过 |
| B9 | 注入块 | `buildIntimateProfileBlock(1)`（node 直调）→ 输出含 `<intimate_profile>` 开闭标签、`身体：身高 168cm，三围 88-58-90，罩杯 D`、`敏感带：颈侧(很强)、耳后(一般)`、`初次：…`、`相处：累计约 2 次，常见体位：…`、以及结尾反统计约束原文；长度 214（另一轮 199）**≤600**；`PUT …/inject {enabled:false}` → 返回 `''`（零注入）；恢复 true → 199 字符 | 通过 |
| B10 | 前端静态核查 | 两处入口都在：`CharacterDetailModal.vue:142-143`（移动 toolbar）与 `:199-200`（桌面 float-row）都 `@click="openIntimateModal"`；子窗由 `<linshe-modal v-model="showIntimateModal" :title="…" full>`（:489）承载；`IntimatePanel.vue`/`intimateLogic.js`/`api/intimate.js` 裸 `<button>/<input>/<select>` = 0；`#rrggbb` = 0、`rgba(` = 0；0.3s 过渡 13 处 | 通过 |

> 说明：B 阶段前两次「失败」是我自己的验收脚本问题（PowerShell 5.1 的 `Invoke-RestMethod` 把中文请求体编码成 `?`；`/settings` 误用 POST；`ConvertFrom-Json` 读到 mojibake），均已在后续复验中修正，不计入问题清单。

---

## C. 找茬（10 条反例，含 1 个真缺陷）

| # | 反例 | 复现与结论 | 判定 |
| --- | --- | --- | --- |
| C1 | 同 rawId 不同 tag 组合 / 同 act 不同 position 是否重复计数 | 同 rawId 同 tags 连记 2 次 → **1 行**（source_uid 幂等）；同 rawId 换 tag 组合（creampie → creampie+doggystyle）→ **2 行**，两行 act 都是 vaginal 但 position 不同，**互不覆盖** | 符合设计 |
| C2 | manual 里程碑是否被 derived 覆盖 / 被回滚误删 | 流水 MIN 更新 derived（2026-01-01 → 补录更早的 2025-12-01 后跟随）；`source='manual'` 的 `first_kiss` 在 `POST …/rollback` 后**仍保留**；清空看板时才一并清掉（保留身体档案） | 符合设计 |
| C3 | viewScope 空/脏值是否仍规范化 `['user']` | `[]` → `['user']`；`['nope','user','nope']` → `['user']`；`partnerKinds=all` 是唯一"不过滤"逃生门 | 通过 |
| C4 | 权限关闭时回填游标是否被错误推进（blocked 的消息能否补回） | `aiEditFields=['body']` 时回填 → `status=blocked, scanned=0, lastRawId=0, 0 行`；重新授权后同一批 → `status=done, scanned=3, inserted=2, 2 行` → **游标未被错误推进，消息被补回** | 通过 |
| C5 | 群聊解散后 group 流水是否残留 / 会不会误伤私聊 | 造群 + 成员 + 3 条交错 raw（group raw 38、**私聊 char_1 raw 39（落在 38..40 中间）**、group raw 40）+ 3 笔流水 → `DELETE /api/groups/:gid` → 响应 `{"ok":true,"intimate":{"deleted":2,"characters":[1]}}`；结果 `groupRows=0`、**区间内的私聊流水 1 行未被误删**、群与群 raw 清空、私聊 raw 保留 | 通过 |
| C6 | 镇民奇遇生产者在 `characterId=0`（纯 NPC）时 | `recordIntimateForTownEvent({characterId:0,eventId:5,prompt:'creampie, missionary'})` → `{inserted:0,skipped:0,blocked:false}`，**不抛错**；`eventId=0`、无成人 tag 同样零写入；正常记账 `inserted=1`；**同事件重复 → `skipped=1`，totalActs 不变** | 通过 |
| C7 | 前端 api 封装 vs 后端返回：顶层 vs 嵌套（lead 重点关注） | `GET /intimate`：顶层 `characterId/profile/firsts/stats/counts/backfill` ✓；`GET/POST …/backfill`：**顶层均有 `status/scanned/inserted/lastRawId`**（另附 `backfill` 嵌套副本与 `private`/`group` 双线进度，属加法）✓；`vocabulary` 顶层 `acts/positions` ✓；`log` 顶层 `logs` ✓；`ai-edit/suggestions` 顶层 `suggestions` ✓ | 通过 |
| C8 | manual 里程碑 vs 流水回滚（独立复验） | `first_kiss/manual/2026-02-02` + `vaginal/derived` → `record(rawId=56)` + `rollback(56)` → `deleted=1`，`totalActs 2→1`，两个里程碑都在 | 通过 |
| C9 | **撤回上一轮**（P1 最小复现） | 修复前复现出脏计数（见 §D.P1）；lead 修复后同一形状复验 `totalActs 1→0`、残留 0 行；已固化为 `test/intimateWithdrawRollback.test.js`（4/4） | **通过（已闭环）** |
| C10 | 删除角色是否级联清空 5 张表 | 建角色 → 写 profile/log/firsts/backfill/suggestions（各 1 行，firsts 2 行）→ `DELETE /characters/:id` → 5 张表全部为 0 | 通过 |

---

## D. 问题清单（按严重度）

### P1｜「撤回上一轮」不回滚自动记账流水（脏计数 + 孤儿行）

**影响**：用户点「撤回上一轮」后，看板数字降不回去；残留流水的 `raw_id` 指向已被删除的 `raw_messages`，之后既不会被同一条撤回清掉，也无法再通过 raw 维度回滚（只能靠「清空看板」或逐条删除）。与之配套的 derived 里程碑也会残留。

**最小复现**（真 HTTP + 真锚点，临时库）：

```
1. 造一轮：char_1 下 user raw=55、assistant raw=56（assistant 带 prompt "creampie, missionary"），并写 messages 两行
2. POST /api/characters/1/intimate/record {"tags":["creampie","missionary"],"rawId":56,"scene":"chat","partnerKind":"user"}
   → {"inserted":1,…}
3. DELETE /api/characters/1/messages/last-round
   → {"ok":true,"deleted":4}
4. GET /api/characters/1/intimate?partnerKinds=all
   → totalActs = 1        ← 期望 0
   raw_messages 剩 []  ；character_intimate_log 残留 [{"id":50,"raw_id":56,"scene":"chat"}]
```

**期望 vs 实际**：期望撤回后该轮流水随 raw 一起消失、`totalActs` 回落 0；实际残留 1 行且 `totalActs` 不变。

**根因**（`agent-core/src/routes/chat.js`）：
- 自动记账锚点 = **assistant raw id**：`chat.js:1307-1311` 先 `INSERT raw_messages (assistant…)`，紧接着 `if (tags.prompt) recordIntimateFromTail(...)`；`recordFromConversationTail`（`services/intimateAutoRecord.js:100-129`）取的是**最近一条带 prompt 的 assistant raw** → 锚点即 assistant raw 的 id。
- 撤回路径用的是 **user raw id**，且是**等值**删除：`chat.js:226-234` 取 `lastUserRawId`，调 `rollbackIntimateByRawId(lastUserRawId)`；该函数（`services/intimateService.js:610-623`）执行 `DELETE FROM character_intimate_log WHERE raw_id = ?`。
- 55 ≠ 56 → 命中 0 行；随后 `DELETE FROM raw_messages … AND id >= lastUserRawId` 把 56 删掉 → 孤儿。
- **对照实验**：把同一笔记账的 `rawId` 改成 55（= 撤回所用的 id）后，撤回后 `totalActs` 正常回落 0 → 证明差异纯粹在锚点不一致。
- **不受影响的分支**：无 user 消息的 proactive-only 分支（`chat.js:193-205`）用 `lastAssistantRaw.id`，与实际锚点一致。

**建议修法**（供 lead 决策，改动面很小）：有 user 消息的分支改成**区间回滚**——先取该会话 `MAX(id)`，再 `rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId })`；该函数已由 task-15 提供，且已在 `groupRoundUndo.js` / `routes/groups.js` 落地并经本次 C5 独立验证（传 `conversationId` 才不会因全库自增 id 误删别的会话）。**不要**用 `clearIntimateData`（会连私聊统计一起清）。

**为什么既有测试没拦住**：task-7 的集成测试是 service 级同 id 语义（`record(rawId=11)` → `rollback(11)`），恰好掩盖了生产路径上 user/assistant 两个 id 的错位。

#### P1 修复（lead，chat.js，2026-09-28）

有 user 消息的分支由"等值回滚"改为"区间回滚 + conversationId 收敛"：

```js
const maxRawId = db.prepare('SELECT MAX(id) AS id FROM raw_messages WHERE conversation_id = ?')
  .get(conversationId)?.id || lastUserRawId;
rollbackIntimateByRawIdRange(lastUserRawId, maxRawId, { conversationId });
```

- 选区间而不是"改用 assistant raw 等值删"：删除本身就是 `id >= lastUserRawId` 整段删（可能含多条 assistant raw），按区间才与删除范围严格对齐；
- `conversationId` 是必需的：raw id 全库自增、跨会话区间会互相穿插（task-15 已实测裸 BETWEEN 会误删私聊流水）；
- 仅 agent 消息的分支保持等值回滚（那里撤回的就是最后一条 assistant raw，锚点天然一致）；
- 根因与复现数字（user raw=55 / assistant raw=56）已写进代码注释。

#### P1 闭环证据（本次独立复验，修复后重启服务 + 全新临时库）

复现脚本（真实 HTTP + 真实锚点形状，`%TEMP%` 临时库 `intimate-accept2.db`）：

```
=== P1 闭环复验（修复后）===
  锚点=assistant raw 2（user raw=1）/ record inserted=1
  DELETE last-round → {"ok":true,"deleted":4}
  raw_messages 剩=[] ; 残留流水=[] ; totalActs 1 → 0
PASS  撤回上一轮后 totalActs 回落为 0（实际 0）
PASS  撤回上一轮后流水清零（实际 0 行）
PASS  该会话 raw 已删除

=== 护栏 1：区间内别的会话的流水/raw 不被误删（带 conversationId）===
  布局: char_1 user=8 / 角色2 assistant=9（落在 char_1 的 8..10 区间内）/ char_1 assistant=10
  撤回前: char_1 流水=1 行, 角色2 流水=1 行
  DELETE last-round(char_1) → {"ok":true,"deleted":4}
  撤回后: char_1 流水=0 行, 角色2 流水=[{"id":6,"raw_id":9,"scene":"chat"}], 角色2 raw 剩=[9]
PASS  区间内别的会话的流水/raw 未被误删（带 conversationId 的收敛生效）

=== 护栏 2：raw_id=0 的无锚点行（人工补录）不受撤回影响 ===
  人工行(raw_id=0) 1 条 → 撤回 → {"ok":true,"deleted":4} → 剩余 [{"id":3,"raw_id":0,"scene":"manual","act_key":"climax"}]
PASS  raw_id=0 的人工流水在撤回路经下保留
```

对照（修复前，同一形状）：`totalActs 1 → 1`，残留流水 `[{"id":50,"raw_id":56,"scene":"chat"}]`，`raw_messages` 剩 `[]` → 即本报告 §C9 的复现输出。

#### 正式回归用例（新增，属本任务交付）

`agent-core/test/intimateWithdrawRollback.test.js`（**直接驱动真实 chat 路由** `DELETE /characters/:id/messages/last-round`，`DB_PATH=':memory:'`，禁网）：

```
ok 1 - 撤回上一轮：按 assistant 锚点记账的流水必须被回滚（P1 回归）
ok 2 - 撤回一轮不误删区间内别的会话的流水与 raw（conversationId 收敛）
ok 3 - 撤回一轮不影响 raw_id=0 的无锚点行（人工补录 / 事件流水）
ok 4 - chat.js 的 user 分支必须用区间回滚 + conversationId（防改回等值删）
# tests 4   # pass 4   # fail 0
```

用例 1 的形状与修复前的失败复现完全一致（assistant 锚点 ≠ user raw，按 `id >= lastUserRawId` 整段删），因此它对本次 P1 具备真实的守护能力；用例 4 另加源码级护栏（禁止再出现 `rollbackIntimateByRawId(lastUserRawId)`，并要求先查会话内 `MAX(id)`）。


### P3-a｜ai-edit 的 502 文案拼接上游英文

`POST …/ai-edit`（LLM 不可达）→ `{"error":"AI 整理失败：Connection error."}`。中文前缀符合"不让用户看到 SDK 原文"的意图，但把上游英文原因原样拼在后面。可接受，建议后续统一为固定中文。

### P3-b｜`test/momentUserPostFlow.test.js` 全量并行下偶发文件级失败

见 A1：三次全量中 2 次失败（均为**无子用例输出的文件级失败**），最终复跑抓到的具体异常是 Node test runner 的 `uncaughtException: Unable to deserialize cloned data`（`node:internal/test_runner` 内部）；该文件单独跑 25/25 通过。判定 **环境/框架 flake**，与亲密看板无关。规避：`--test-concurrency=1`。

### P3-c｜`npx eslint src` 的 5 个既有 error

见 A3，全部在非本功能文件（BackpackModal / TownNpcChat / CanvasTownRenderer / momentShareRenderer）。

---

## E. 未覆盖项

1. **真实 LLM 回合**：本机 `.env` 配了 API Key，为"零真实外网流量"我把 `LLM_BASE_URL` 指向 `127.0.0.1:1` → 真实聊天轮次的自动记账、真实奇遇/群聊生成、`ai-edit` 的真实 JSON 抽取都**未覆盖**（`ai-edit` 只覆盖到"无素材不调 LLM"与"LLM 不可达 → 502"）。
2. **真实浏览器视觉**：暖色/暗夜双主题、<768px 窄屏、组件在真实后端数据下的渲染，由 task-16/20/22 负责，本报告只做了静态核查（B10）。
3. **`撤回上一轮` 修复后复验**：P1 修复需要重跑 C9 用例。
4. **vector-service 未启动**：`[vector] WARNING: not reachable`，记忆/向量相关路径降级运行；与看板无交集。
5. **客户端点击链路**：统计口径 chip / 采纳·忽略按钮的浏览器点击（无 CDP 驱动）未覆盖，只覆盖了其后端接口。

---

## F. 本功能引入 vs 仓库既有

| 类别 | 项 |
| --- | --- |
| **本功能引入** | P1（撤回锚点错位）；P3-a（502 文案拼接） |
| **仓库既有（与本功能无关）** | A3 的 5 个 eslint error；P3-b 的 flaky 测试 |
| **本次验收自身的噪声（已排除）** | PowerShell 5.1 的中文 body 编码 / `ConvertFrom-Json` mojibake / `curl` 别名 / URL 重复 `/api` 等脚本问题，均已复验修正 |

---

## G. 复跑命令速查

```powershell
$env:Path='<worktree>\runtime\nodejs;<worktree>\runtime\python;'+$env:Path
# A1
cd agent-core; $env:DB_PATH=':memory:'; node --test "test/*.test.js" "src/services/*.test.js"
# P1 回归（本次新增）
cd agent-core; $env:DB_PATH=':memory:'; node --test test/intimateWithdrawRollback.test.js
# A2 / A3 / A4
cd web-ui; node --test "test/*.test.js"; npx eslint src; npx vite build
# B（临时库真跑）
$env:PORT='3097'; $env:DB_PATH="$env:TEMP\intimate-accept.db"
$env:LLM_BASE_URL='http://127.0.0.1:1/v1'; $env:LLM_API_KEY='sk-noop'
cd agent-core; node app.js     # 收尾：POST /api/shutdown，并删除 %TEMP% 下临时库与脚本
```

## H. 移动靶声明

- A/B/C 证据的采集时点为 **2026-09-28 12:04 – 12:25**；**A1/A2 的最终复跑时点为 12:22:43**。
- 采集期间的生产代码变动：`chat.js` 的 P1 修复（lead，12:2x）已包含在最终复跑中；**task-21（core-data，`intimateService.js` 体位带权重别名）已落地**；**task-23（backend-integration，`intimateService.js` 多词元素紧凑守卫）在最终复跑时仍在进行中**，若它落地并改动体位索引，需重跑 A1 并复验涉及体位归因的用例（C1/C7 与 `vocabulary` 形状）。
- 与 `intimateService.js` 解耦的结论（P1 及 B1-B6/B8/B9、C2-C6/C8/C10）不受上述改动影响。
- 证据中所有"失败 → 修正"的段落都保留了原始输出，便于核对是我的脚本问题还是产品问题。

---

## 附加复核（2026-09-28 12:38，core-data）

**复核人与独立性声明**：本段由 core-data 撰写，复核对象是**他人的产出与上文的结论**（chat.js 挂点与撤回修复、群聊/奇遇/镇民记账与回滚、AI 整理档案、回填两条线、前端面板与设置页、浏览器样例、文档）。**本人主写的 task-1（schema/服务/接口）不在独立验证范围内**，本段不对其作"独立"背书。本段**只添加，不改动上文任何文字**。

**时点**：上文写于 12:04–12:25（最终复跑 12:22:43）；本段采集时点 **2026-09-28 12:38**，复核的是**当前工作区代码**。

### ① 复跑（全部由本人执行）

| 项 | 命令（`cd agent-core` / `cd web-ui`） | 结果 |
| --- | --- | --- |
| 体位四件套 | `node --test test/intimateService.test.js test/intimatePositionWeightAlias.test.js test/intimatePositionNoise.test.js test/intimateMultiWordGuard.test.js` | **40 / 40 pass** |
| agent-core 全量（并行，默认并发） | `$env:DB_PATH=':memory:'; node --test "test/*.test.js" "src/services/*.test.js"` | **604 / 604 pass，EXIT=0** |
| agent-core 全量（串行） | 同上 + `--test-concurrency=1` | **603 / 604**，失败项 = `groupAvatarRoute.test.js`（见 ③），两次串行均为同一项 |
| web-ui 全量 | `node --test "test/*.test.js"` | **170 / 170 pass** |
| eslint | `npx eslint src` | `637 problems (5 errors, 632 warnings)`；5 个 error 与 A3 表**同文件同行同规则**（BackpackModal:54 / TownNpcChat:126 / CanvasTownRenderer:234,260 / momentShareRenderer:926） |
| vite build | `npx vite build` | `BUILD_EXIT=0`，产物落 `agent-core/public`；本次 bundle = `index-B3OVuZ2E.js` + `index-zLEMdNg2.css`（上文时点为 `index-Cr9Kd_yr.js` / `index-Cjix1hT.css`，文件名随内容变，属预期） |

bundle 关键词（本次产物 grep）：`亲密度看板` OK、`历史对话回填` OK、`亲密信息` OK、`让 AI 根据最近的对话整理档案` OK、`intimate_profile` MISS（**预期**：该标签由后端注入，不进前端 bundle）。

**关于 flake 的收紧（对 §P3-b 的补充）**：上文建议用 `--test-concurrency=1` 规避 `momentUserPostFlow` 抖动；本次实测**并行 604/604 全绿（未复现）**，而**串行反而出现另一个文件级失败**。即"串行＝稳定绿灯"在当前机器上**不成立**：本仓库至少有 **2 个与看板无关的偶发失败源**（`momentUserPostFlow` 的 runner IPC、③ 的 `groupAvatarRoute`）。

### ② 与上文的差异清单（标明时点，不为作者改口）

| # | 上文（12:22–12:25） | 当前（12:38 复测） | 判定 |
| --- | --- | --- | --- |
| 1 | §H：task-23 在途、task-25 未开工 | 两者 board 上均 completed；task-23 的 `GENERIC_SCENE_TAG_KEYWORDS`(93 条) + `isGenericSceneTag` 已在位，`professional lighting` → `''` 实测生效 | 移动靶**已收口**（task-23 部分） |
| 2 | §E.3「撤回上一轮修复后复验」列为未覆盖 | **已覆盖**：`test/intimateWithdrawRollback.test.js` 在本次全量中通过 | 未覆盖项**已消解** |
| 3 | §E.1 真实 LLM 回合未覆盖 | **部分消解**：task-26 已交付 `test/intimateAiEditWithLlm.test.js`（stub LLM 真 HTTP + 脏输出 + 502），本次全量通过；**stub ≠ 真实服务**，真实模型返回质量仍未覆盖 | 部分消解 |
| 4 | §H/§C 未给词表条数 | 当前 `positions` **657**（单 token 119 / 多 token 538），`acts` 10 | 新增信息（上文未 pin，不构成冲突） |
| 5 | §C1/§C7 体位归因与反例保护 | 逐条复测**完全一致**：`on all fours`→床上肛交后入、`full nelson`→背后锁臂、`arms grab`→抱腰后入、`missionary`→传教士体位、`doggystyle`→狗爬式、`69`→69式、`reverse cowgirl`→女上反骑；`sex from behind`→`''`、`cum`→`''`、`aftersex`→`''`、`professional lighting`→`''`；`classifyPromptTags(['nude','vaginal','cum'])` 仍产出 `actKey='vaginal'`（行为统计不受体位去噪影响） | **一致** |
| 6 | ——（上文未涉及「体位排行」残差） | **task-25（方案 C）虽 completed，但当前代码里看不到任何新增常量/白名单**（`intimateService.js` 模块级常量仍只有 NON_POSE_*/GENERIC_SCENE_* 两套）；task-25 自列的坏样本 **11 条里 10 条仍会进排行**：`tile floor`→瓷砖跪口交、`lying on bed`→跨坐吸乳、`on grey carpet`→曲膝捆绑、`red hair`→办公桌下口交、`school sweater vest`→学生乱交、`thighband pantyhose`→脱衣舞女2、`full lips`→事后颜射、`condom wrapper`→事后套套展示、`mirror`→照镜子、`caught`→被发现（仅 `professional lighting` 被 task-23 的 B 拦下） | **仍未收口**：`mirror`/`caught` 正是 task-25 点名的单 token 包靶子，当前仍进「体位排行」。若 task-25 是按"残差 ≤2 条才落地"的规则**只交报告未落地**，则与其 complete 不矛盾——**结论以其报告为准**；本段只能证明"代码未变、坏样本仍在"，是否接受现状由 lead 裁决 |
| 7 | §P3-b 仅列 `momentUserPostFlow` | 串行失败项换成了 `test/groupAvatarRoute.test.js`（上文未提及的**第三个**失败源），详见 ③ | 上述 P3-b 需**扩项**（新增发现，非改口） |

### ③ 新发现：`groupAvatarRoute` 毫秒同名导致偶发断言失败（与看板无关，属仓库既有缺陷）

- **最小复现**：`cd agent-core; $env:DB_PATH=':memory:'; node --test test/groupAvatarRoute.test.js`（连跑 5 次：run1/run2 失败、run3-5 通过 ⇒ **2/5**）
- **失败原文**：`not ok 2 - POST /api/groups/:id/avatar 换头像时清理旧文件`；`operator: 'notStrictEqual'`；`expected: '/avatars/group_1_1790570156899.png'`，`actual: '/avatars/group_1_1790570156899.png'`（**两个值完全相同**）
- **根因**：`agent-core/src/routes/groups.js:198` 的 `const filename = \`group_${groupId}_${Date.now()}.png\`` 只有毫秒分辨率；测试连续两次 POST 若落在同一毫秒 → 文件名相同 → `assert.notEqual` 失败。路由行为本身正确（换头像时确实删了旧文件）。
- **归属判定**：`git ls-files --error-unmatch` 显示该测试为**已提交的既有文件**；`git diff` 显示 `routes/groups.js` 的 avatar 段**未被本次功能改动**（工作区改动只在解散群回滚处）⇒ **仓库既有缺陷**，与亲密看板无因果关系。
- **处置**：按 task-27 纪律**只报告、未修改**。建议 owner 择机修（文件名加随机数/自增，或断言放宽为"URL 变化或被替换"）；修前"串行全绿"不可作为验收姿势。

### ④ 卫生体检（时点 12:38）

- `git status --short`（排除 `agent-core/public`）= **M 13 + ?? 34**，逐条归类：
  - **本功能产出**：`agent-core/app.js`、`src/config.js`、`src/db/index.js`、`src/db/settings.js`、`src/routes/intimate.js`、`src/routes/intimateAiEdit.js`、`src/services/intimateAiEdit.js`/`intimateAutoRecord.js`/`intimateBackfill.js`/`intimatePrompt.js`/`intimateService.js`、`src/services/town/townIntimateRecord.js`、`test/intimate*.test.js`（22 个）、`docs/intimate-dashboard.md`、本报告、`web-ui/src/api/intimate.js`、`web-ui/src/components/character/`、`web-ui/test/fixtures/intimatePanel*.{html,js}`、`web-ui/test/intimatePanel.test.js`、`docs/testing.md`（新增 browser fixture 条目）
  - **集成/回滚类（为看板闭环改动的既有文件）**：`src/routes/chat.js`、`src/routes/groups.js`、`src/services/groupChatEngine.js`、`src/services/groupRoundUndo.js`、`src/services/eventGenerator.js`、`src/services/town/townNpcEventGenerator.js`
  - **前端既有文件**：`web-ui/src/components/CharacterDetailModal.vue`、`web-ui/src/views/SettingsView.vue`
  - **无关残留**：`使用说明.txt`（会话开始即存在的未跟踪文件，非本功能产出）
- **异常残留排查**：`_*.mjs` / `*.log` / `test-out.txt` / `full-regression.txt` / 文件名含 `,`·`);`·`JSON.stringify` / `agent-core` 根下 0 字节文件 / `agent-core/test` 下非 `*.test.js` 文件 ⇒ **全部 0 条**；lead 清理的那个 0 字节怪文件**没有第二个同类**。本段使用的临时探针（`_aliascheck/_whycheck/_avprobe/_revcheck/_badprobe.mjs`）均在写入的同一命令内删除，复查无残留。

### ⑤ 未覆盖项现状（对 §E）

1. **真实 LLM 回合**：仍**未覆盖**（task-26 只补了 stub；本段亦未打真实外网）⇒ 状态：部分消解，边界声明沿用 task-26 的「stub ≠ 真实服务」。
2. **真实浏览器视觉**：task-16/20/22 已交付 fixture（`web-ui/test/fixtures/intimatePanel.html`、`intimatePanelLive.html`），本段**未复跑**（需 vite dev + headless Chrome，超出本任务范围）；上文"只做静态核查"在本段仍是事实。
3. **撤回修复复验**：**已覆盖**（见 ②-2）。
4. **vector-service**：本段未启动，记忆/向量路径仍降级运行；与看板无交集。
5. **客户端点击链路**：仍**未覆盖**（无 CDP 驱动），只覆盖了其后端接口。

### ⑥ 本段结论

- 上文的核心结论（权限闸门 / 口径过滤 / 回填双线 / 注入块 / AI 整理 / 级联删除 / 群聊·奇遇·镇民记账与回滚）**在当前代码上仍然成立**；体位归因的既有反例保护逐条复测一致。
- 上文的**时点差已收口两项**（task-23 落地、§E.3 消解），**仍有一项未收口**：`mirror`/`caught` 等非体位词仍进「体位排行」（task-25 的靶子）——以 task-25 报告为准，由 lead 裁决是否接受现状。
- **新增一个既有偶发失败源**（`groupAvatarRoute` 毫秒同名）：不影响看板结论，但会让"串行全绿"这一验收姿势失效，建议单独修。
- 上述所有复核均为**独立执行**；**core-data 自写的 task-1 不在本段背书范围内**。

### ⑦ 补充说明（2026-09-28，core-data，经 lead 说明后补记）

本段 ②-6 的"仍未收口"是**词表层的实测事实**；现经 lead 说明、并由本人独立复核其处置，补记如下（**不改动 ②-6 的原始实测记录**，供读者对照时点）：

- task-25 的交付物**本身就是测量报告**：C1（扩展黑名单：真体位损失 14.2%、仍残留 507 条）与 C2（白名单化：损失 42.3%）**均不满足 lead 设定的落地门槛**，因此**不上代码**——故"②-6 代码未变、坏样本仍在"与其 complete 并不矛盾。
- lead 采纳的是**展示层低风险缓解**而非词表变更；本人已逐条核验：
  - `web-ui/src/components/character/intimateLogic.js:262-272`：`topPositions` 已实现"**优先只显示出现 ≥2 次的条目**"（若一条 ≥2 次的都没有则退回全量），注释标注了 task-25 的测量依据；后端 `byPosition` 仍返回全量、归因口径未变。
  - `docs/intimate-dashboard.md` §「已知边界与已裁决取舍」（305-314 行）已写明该口径、其边界「**反复出现的非体位词仍会显示**」，以及 **C2'（宽白名单）** 的触发条件与现成种子。
- 结论修正：②-6 的 `mirror` / `caught` 等残差属**已裁决接受的已知边界**（用户可见面已由展示层缓解），**不是遗漏**；②-6 的"仍未收口"仅指"词表层未做变更"这一事实。
- 另：③ 的 `groupAvatarRoute` 既有 flake 经 lead 裁决**本次不修**（超出目标范围），本段保留根因与修法供后续按需处理。

### ⑧ 补记：`groupAvatarRoute` 撞名缺陷已修（2026-09-28，催眠轮，用户裁决「现在顺手修掉」）

③ 记的毫秒同名缺陷此前经 lead 裁决「本次不修」；本轮做真实 LLM 复跑后的全量复核时**再次命中**（`not ok 169`，683 pass / 1 fail），用户裁决「现在顺手修掉」，故落地：

- **修法（2 个文件）**：`agent-core/src/routes/groups.js` 的文件名由 `group_${groupId}_${Date.now()}.png` 改为 `group_${groupId}_${Date.now()}_${randomBytes(3).toString('hex')}.png`（`randomBytes` 取自 `node:crypto`，与 `townSchema.js` 等既有写法一致）；`agent-core/test/groupAvatarRoute.test.js` 两处 `assert.match` 正则同步为 `/^\/avatars\/group_\d+_\d+_[0-9a-f]{6}\.png$/`。
- **③ 的结论需要加重**：原文写「路由行为本身正确（换头像时确实删了旧文件）」，而实测代码顺序是**先把新文件写盘、再调 `deleteGroupAvatarFile(旧路径)`**，且该函数只取 basename、**不判断"旧路径是否就是刚写的那个文件"** ⇒ 同一毫秒两次上传时，被删掉的正是**刚写进去的新文件**，库里却仍指向该路径——**群头像会真裂图**（`/avatars` 静态缓存 30 天，坏 URL 还会被缓存住）。所以它不只是"测试偶发红"，而是低概率真实缺陷；随机后缀同时消除了「删旧逻辑删到同名新文件」这条自伤路径。
- **证据**：修复前单独连跑 6 次 = **4 绿 2 红**（失败时 `expected == actual == /avatars/group_1_1790592639230.png`）；修复后单独连跑 **10 次 = 10 绿**。测试正则现在强制 `_6 位 hex` 后缀且通过 ⇒ 唯一性由随机后缀保证，与两次上传落在哪一毫秒无关（原用例即变成确定性回归用例）。
- **未覆盖**：不在真实浏览器里人工复现"同一毫秒点两次换头像"（UI 层面做不到）；判定依据是代码顺序 + 上述确定性用例。
