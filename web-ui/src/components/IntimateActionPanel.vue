<template>
  <Teleport to="body">
    <!--
      性爱交互「可点击推进」浮动面板（task-1）
      形态：**跟着 TouchActionPanel 的浮动小窗范式**（Teleport 到 body、无遮罩、不挡消息区），
      因为玩法的核心就是"点一下 → 她立刻回一句"，面板挡住聊天就看不见反应了。
      视觉全部走 Linshe 组件（LinsheButton / LinsheTabs）+ 设计系统 token，不引入新体系。
    -->
    <Transition name="ia-panel">
      <div v-if="open" class="ia-panel" role="dialog" aria-modal="false" aria-label="性爱推进">
        <div class="ia-header">
          <span class="ia-title">推进</span>
          <span class="ia-summary" :title="summary">{{ summary }}</span>
          <linshe-button variant="icon" size="sm" aria-label="关闭推进面板" @click="emit('close')">✕</linshe-button>
        </div>

        <!-- 状态 HUD：体位 / 插入状态 / 节奏 + 累积度条 -->
        <div class="ia-hud">
          <span class="ia-chip" :class="{ 'is-hot': view.penetrating }">{{ statusText }}</span>
          <span class="ia-chip">{{ view.positionLabel }}</span>
          <span class="ia-chip">{{ view.paceLabel }}</span>
          <span v-if="view.climaxCount > 0" class="ia-chip is-done">已到 {{ view.climaxCount }} 次</span>
          <!-- 开关型动作（捆绑 / 禁止高潮 / 自动抽插）的当前状态：以前只在按钮上"点没点"，看不出生效没有 -->
          <span v-if="toggleChips.length" class="ia-chip is-toggle is-hot" :title="toggleChipsTitle">{{ toggleChips.join(' · ') }}</span>
          <span class="ia-chip" :title="'好感度（决定她的配合 / 抗拒）'">好感 {{ her.affinity ?? 0 }}</span>
          <!-- 敏感度（2026-10-02 新数值系统）：她"有多敏感"决定门槛 / 增益 / 高潮强度，面板必须看得见；
               她是冷淡/普通档时也显示（用户要看得到这个数在动），发情模式则直接标出来。 -->
          <span
            v-if="sensitivity.available"
            class="ia-chip"
            :class="{ 'is-hot': sensitivity.heat || sensitivity.value >= 60 }"
            :title="sensitivity.title"
          >{{ sensitivity.text }}</span>
        </div>

        <div class="ia-bar" :title="accumulationHint(view)">
          <div class="ia-bar-fill" :class="'is-' + view.accumulationTier" :style="{ width: progressPercent(view) + '%' }"></div>
          <span class="ia-bar-edge" aria-hidden="true"></span>
        </div>
        <p class="ia-bar-text">
          累积 {{ view.accumulation }}/100 · {{ view.accumulationLabel }} · 已推进 {{ view.rounds }} 下
          <span class="ia-threshold">（她到 {{ view.climaxThreshold }} 就能「一起到」）</span>
        </p>
        <p class="ia-edge-hint">{{ accumulationHint(view) }}</p>

        <!-- 节奏档（LinsheTabs 只作状态显示：切换由「加速抽插 / 慢下来」两个动作推进，点一下=一轮反应） -->
        <div class="ia-row">
          <span class="ia-label">节奏</span>
          <linshe-tabs :model-value="view.pace" :options="paces" size="sm" disabled title="节奏由「加速抽插 / 慢下来」推进" />
        </div>

        <!-- 自动速度（2026-10-03 用户：「自动的速度新增一个单独的」）：
             与上面的手动节奏档**完全独立** —— 它只管"他自动插送得多快、每下涨多少"
             （用户同日澄清：「自动的意思是自动插入 不是自己动」）。 -->
        <div class="ia-row">
          <span class="ia-label">自动速度</span>
          <linshe-tabs
            :model-value="view.autoPace"
            :options="paces"
            size="sm"
            :disabled="!view.autoThrust || busy || loading || !enabled"
            :title="autoPaceTitle(view)"
            @update:model-value="setAutoPace"
          />
          <span class="ia-auto-hint">{{ view.autoThrust ? `他每 ${(view.autoIntervalMs / 1000).toFixed(1)} 秒一下` : '先开「自动插入」' }}</span>
        </div>

        <!-- 体位：点一下＝立刻换过去（含开场：还没开始时点体位＝把她摆成那个姿势） -->
        <div class="ia-row ia-row--block">
          <span class="ia-label">体位（点一下立刻换过去）</span>
          <div class="ia-positions">
            <linshe-button
              v-for="item in positions"
              :key="item.key"
              variant="chip"
              size="sm"
              :active="item.key === view.positionKey"
              :disabled="busy || loading || !enabled"
              :title="positionTitle(item, view)"
              @click="changePosition(item)"
            >{{ item.label }}</linshe-button>
          </div>
        </div>

        <!-- 动作按钮：可用性一律以服务端 actions 为准，端点不可用才回落镜像 -->
        <div class="ia-actions">
          <linshe-button
            v-for="action in actions"
            :key="action.key"
            :variant="action.available ? (action.tone || (action.key === 'thrust' ? 'primary' : 'secondary')) : 'secondary'"
            :size="action.key === 'thrust' || action.key === 'faster' ? 'lg' : 'md'"
            :disabled="!action.available || busy || loading || !enabled"
            :loading="busy && busyKey === action.key"
            :active="isToggleOn(action.key)"
            :title="hintFor(action)"
            @click="run(action)"
          >{{ labelFor(action) }}</linshe-button>
        </div>

        <Transition name="ia-fade">
          <p v-if="feedback" class="ia-feedback" :class="{ 'is-reject': feedbackRejected }">{{ feedback }}</p>
        </Transition>
        <p v-if="!enabled" class="ia-feedback is-reject">「性爱推进」功能当前已关闭。</p>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * 面板契约（Lead 挂到 ChatView 用）：
 *   props : open（受控显隐，父组件持有）、characterId（当前角色 id，必填）
 *   emits : close（✕ / 父组件自己收）、reaction（每次成功推进的回执，含 reaction / state / beat）、
 *           state（每次刷新后的 state 切片，父组件可选用）
 *   exposе: refresh()（父组件可手动刷新）
 *
 * 自包含：打开时自己 GET `/intimate-actions/:id/state`，点动作自己 POST，**不插消息、不伪造反应**——
 * 她的那句反应由后端写库 + `proactive_message` 广播进聊天流（与触摸反应同一条上屏链路）。
 * 门控口径：**服务端说了算**（actions[].available / reason），前端镜像只在端点不可用时兜底。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onEvent, offEvent } from '../stores/unifiedStream.js'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import {
  accumulationHint,
  actionButtonsOf,
  actionFeedbackText,
  autoPaceTitle,
  clampPaceForUi,
  normalizeIntimateState,
  paceOptions,
  parseActionResponse,
  positionOptionsOf,
  positionTitle,
  progressPercent,
  sensitivityView,
  statusChipText,
  summaryText,
} from './intimateActionLogic.js'
import { fetchIntimateActionState, postIntimateAction } from '../api/index.js'

const props = defineProps({
  /** 受控显隐（父组件持有 showIntimatePanel） */
  open: { type: Boolean, default: false },
  /** 当前私聊角色 id（必填；换人会自动重新读状态） */
  characterId: { type: [Number, String], default: 0 },
  /**
   * 场景（2026-10-02）：`'chat'`（默认，私聊）或 `'group'`。
   * 群里打开时必须传 `'group'` + `groupId`，否则她的反应会写到私聊去
   * （用户原话：「在哪里聊天就在哪里继续进行」）。
   */
  scene: { type: String, default: 'chat' },
  /** 群聊场景的群 id（scene='group' 时必填） */
  groupId: { type: [Number, String], default: null },
})

const emit = defineEmits(['close', 'reaction', 'state'])

const toast = inject('toast', null)

const snapshot = ref(null)
const enabled = ref(true)
const loading = ref(false)
const busy = ref(false)
const busyKey = ref('')
const feedback = ref('')
const feedbackRejected = ref(false)

const view = computed(() => normalizeIntimateState(snapshot.value?.state || {}))
const her = computed(() => snapshot.value?.her || {})// 她的敏感度（2026-10-02）：HUD 上一个 chip —— 数值系统必须可见，否则玩家不知道"为什么这次这么快"
const sensitivity = computed(() => sensitivityView(her.value))
const positions = computed(() => positionOptionsOf(snapshot.value || {}))
const actions = computed(() => actionButtonsOf(snapshot.value || {}))
const paces = computed(() => paceOptions())

// ── 三个「开关型」动作的状态回显（2026-10-02 用户反馈：点了捆绑 / 自动抽插 / 禁止高潮，看不出有没有生效）──
//
// 服务端 `state` 里一直就有这三个字段（bondage / autoThrust / denial，见
// agent-core/src/services/intimateActionService.js 的 buildPanelSnapshot），以前只被"自动抽插 tick 判定"用到，
// **从没显示给用户** ⇒ 用户点完只看到按钮样式没变，自然以为"没生效 / 不知道绑上没绑上"。
// 现在三处一起改：① 按钮加 `:active`（LinsheButton 的 chip/active 语义）；② 按钮文案翻转成"解开…"；
// ③ HUD 加一枚胶囊把当前生效的开关明写出来。**判定仍以服务端 state 为准**，前端不自己记账（刷新即同步）。
const TOGGLE_FIELD = { bondage: 'bondage', auto: 'autoThrust', denial: 'denial' }
const TOGGLE_ON_LABEL = {
  bondage: '解开手腕', bind_box: '解开龟甲缚', bind_legs: '解开束脚', bind_body: '解开全身束', bind_gag: '取出口球',
  auto: '停止自动插入', denial: '允许她到',
}
const TOGGLE_ON_HINT = {
  bondage: '她已经被绑住了（再点一次解开）：绑着时累积涨得更快，换姿势依然由你说了算',
  bind_box: '龟甲缚已经上身（再点一次解开）：整条躯干被固定住，她只能挺着受',
  bind_legs: '脚踝已经束住（再点一次解开）：腿分不开，角度全由你摆',
  bind_body: '全身都被固定了（再点一次解开）：她几乎完全动不了',
  bind_gag: '口球已经戴上（再点一次取下）：她说不出完整的句子，只能发出含混的声音',
  // 2026-10-03 用户澄清：「自动的意思是自动插入 不是自己动」——这一档是**他**在按节奏动
  auto: '他正在自动插送（再点一次停止）：他按「自动速度」自己一下一下地动，这期间你可以去摸她、拍她或戴玩具',
  denial: '现在不许她到（再点一次放开）：憋着能一路涨过满格，放开的那一瞬间才是释放',
}

/** 分型捆绑的五个键（服务端位掩码，前端只读快照的 bonds） */
const BOND_KEYS = ['bondage', 'bind_box', 'bind_legs', 'bind_body', 'bind_gag']

const isToggleOn = (key) => {
  // 2026-10-02 分型捆绑：`bondage` 在服务端是**位掩码**（可同时绑多处），快照里投影成 bonds 逐位布尔
  if (BOND_KEYS.includes(key)) return snapshot.value?.state?.bonds?.[key] === true
  const field = TOGGLE_FIELD[key]
  if (!field) return false
  // ⚠️ 真实故障（用户 2026-10-02 报「点了不变成停止自动抽插 / 关不掉禁止高潮」）：
  // 服务端 `buildPanelSnapshot` 投影的是**布尔值**（`autoThrust: current.autoThrust === 1`），
  // 我第一版只判 `=== 1` ⇒ 对 true 永远不成立 ⇒ **按钮文字永不翻转**（行为其实是对的、就是看不出来）。
  // ⇒ 布尔与数字两种形态都要认（服务端改口径也不会再翻车）。
  const value = snapshot.value?.state?.[field]
  return value === true || value === 1
}
const labelFor = (action) => (isToggleOn(action.key) ? (TOGGLE_ON_LABEL[action.key] || action.label) : action.label)
const hintFor = (action) => (isToggleOn(action.key)
  ? (TOGGLE_ON_HINT[action.key] || action.hint)
  : (action.available ? action.hint : action.reason))

const toggleChips = computed(() => {
  const out = []
  const bonds = snapshot.value?.state?.bonds || {}
  const bondNames = BOND_KEYS.filter(k => bonds[k]).map(k => (TOGGLE_ON_LABEL[k] || '').replace(/^(解开|取出)/, ''))
  if (bondNames.length) out.push('已捆 ' + bondNames.join('+'))
  if (isToggleOn('denial')) out.push('禁止高潮中')
  if (isToggleOn('auto')) out.push('自动插入中')
  return out
})
const toggleChipsTitle = computed(() => `${toggleChips.value.join('、')}（按钮文字会变成「解开 / 停止 / 允许她到」，再点一次即可解除）`)
const summary = computed(() => summaryText(view.value))
const statusText = computed(() => statusChipText(view.value))

function setFeedback(text, rejected = false) {
  feedback.value = String(text || '')
  feedbackRejected.value = rejected
}

/** 读一次服务端快照（列表/可用性/体位清单都来自它） */
async function refresh() {
  const id = Number(props.characterId)
  if (!id) return
  loading.value = true
  try {
    // 场景透传：群聊里读的是 group_<gid> 的场景快照（不传 = 私聊，老行为不变）
    const data = await fetchIntimateActionState(id, { scene: props.scene, groupId: props.groupId })
    snapshot.value = data || null
    enabled.value = data?.enabled !== false
    emit('state', data?.state || null)
  } catch (err) {
    setFeedback(err?.message || '读取状态失败', true)
  } finally {
    loading.value = false
  }
}

// ── 「自动插入」的节拍（2026-10-02 用户：「插入之后可以选一个自动继续插入 然后我可以继续去抚摸
//     或者拍屁股捏其他地方或者插入玩具之类的」）──
// ⚠️ 语义（用户 2026-10-03 澄清）：「自动的意思是自动插入 不是自己动」—— 是**他**在按节奏动。
// 面板只负责"补一下"：开着的时候走一次现有的 thrust 全链路（服务端另有 ticker，按自动速度判）。
// ⚠️ 为什么不是每 1.5~8 秒（用户 2026-10-02 提醒：「生图是本地免费」—— 对，但**反应要走模型**）：
//   这条链每次都过一次 LLM，8 秒一次 = 一分钟 7 次调用，纯浪费；
//   而"他一直顶着"**不靠这里**：累积由服务端补算推进（`planIntimateAction` 的 autoTicks，
//   时间过去就算他又插了一下），所以把这里放慢只是"少让她说几句"，不影响手感与状态。
//
// ⚠️ 2026-10-03 复查（额度洞，本面板 + 服务端 ticker 叠加）：面板这一拍原来是 20 秒的 `setInterval`，
//   而服务端 ticker 的**反应跳**也恰好是 20 秒一次（`intimateAutoThrust.AUTO_REACTION_INTERVAL_MS`）——
//   两条节拍各走各的 ⇒ 实际每 ~10 秒就出一轮完整反应（每轮都是一次 LLM 调用），面板开着时额度翻倍。
//   现在两边**共用服务端那一个反应闸门**（面板这一拍走 HTTP ⇒ 路由里 noteReaction 记账），
//   于是这里的周期必须**严格短于闸门**（15s < 20s）：每一拍都在闸门重开之前把它续上
//   ⇒ 面板开着时服务端每一跳都退化成状态跳（silent，不调模型），她说话的节拍只剩这一条。
//   ⚠️ 别想反过来把这里放慢到 25~30 秒"错开"：闸门会在两拍之间重开一次，服务端照样补一跳 ——
//     叠加只是变稀、没有消失（要么短于闸门独占，要么就还是两份）。
//   并且改成"上一拍走完再排下一拍"（setTimeout 链，不用 setInterval）：模型慢的时候 setInterval
//   会因为 `busy` 跳过这一拍，两拍之间就被拖过 20 秒、闸门重新打开 —— 链式排期让间隔恒等于 AUTO_TICK_MS。
const AUTO_TICK_MS = 15000
let autoTimer = null
/**
 * 「自动插入」到底开着没有。
 * ⚠️ 2026-10-03 复查抓到的洞：这里原来写 `state.autoThrust === 1`，而服务端投影的是**布尔值**
 * （`buildPanelSnapshot`：`autoThrust: current.autoThrust === 1`）⇒ `on` 恒为 false，
 * **面板自己那一拍从来没启动过**（只剩服务端 ticker；面板一关客户端就完全没有兜底）。
 * 同一个文件上面的 `isToggleOn` 早就踩过这个坑并写下了警告，而这一处读的是原始字段、绕过了它。
 * 现在统一走 `autoOn`（布尔 / 数字两种形态都认）。
 */
const autoOn = computed(() => {
  const v = snapshot.value?.state?.autoThrust
  return v === true || v === 1
})
/** 走一拍：她的一轮完整反应（含一次模型调用）；跑完再排下一拍（间隔从"上一拍结束"算起，恒短于服务端闸门） */
async function autoTickOnce() {
  autoTimer = null
  if (!autoOn.value || !props.open) return
  try {
    // `auto: true`：这一下是"他自动插送"里的一下（服务端据此按**自动速度**算增益、演出也写成他在动）
    if (!busy.value) await run({ key: 'thrust' }, { auto: true })
  } finally {
    // 这一拍失败 / 被跳过也要把节拍链接上（否则她从此不再自动开口）
    scheduleAutoTick()
  }
}
/** 排下一拍（幂等：已经在排队就不重复排） */
function scheduleAutoTick() {
  if (autoTimer || !autoOn.value || !props.open) return
  autoTimer = setTimeout(autoTickOnce, AUTO_TICK_MS)
}
/**
 * 节拍只在**面板开着 + 自动插入开着**时跑（面板关了就把节拍交给服务端 ticker —— 它按自动速度推进状态、
 * 并按自己的反应闸门让她开口）。开着的时候由面板独占这个闸门，见 AUTO_TICK_MS 的算术。
 */
function syncAutoTick() {
  if (autoOn.value && props.open) scheduleAutoTick()
  else if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
}
watch([() => props.open, autoOn], syncAutoTick)

/**
 * 亲密刺激下游的广播（累积 / 心情 / 敏感度）—— 服务端一直在发，但 2026-10-03 复查发现
 * **前端白名单里根本没有这个事件名** ⇒ "面板进度条实时更新"这条链路从来没生效：
 * 自动插入开着、面板看着别处时，库里在涨而界面一动不动。
 * 现在订阅它：收到本角色的事件就刷一次 HUD（便宜的状态读，不调模型）。
 */
function onIntimateStimulus(payload) {
  if (!props.open) return
  const cid = Number(payload?.character_id ?? payload?.characterId)
  if (!cid || cid !== Number(props.characterId)) return
  // 面板动作自己那条回执已经在刷新，这里只补"别处推来的那一下"（ticker / 触摸 / 玩具）
  if (busy.value) return
  refresh()
}
onMounted(() => onEvent('intimate_stimulus', onIntimateStimulus))
onBeforeUnmount(() => offEvent('intimate_stimulus', onIntimateStimulus))
onBeforeUnmount(() => { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null } })

/** 点一下动作（同一次点击只发一个请求；busy 期间忽略连点） */
async function run(action, extra = {}) {  if (busy.value || !action?.key) return
  if (!enabled.value) {
    setFeedback('「性爱推进」功能当前已关闭。', true)
    return
  }
  // 换姿势必须带目标体位：「换姿势」按钮本身不带，点是提示去点下面的体位胶囊
  if (action.key === 'position' && !action.positionKey) {
    setFeedback('先点下面的体位，再换过去。', true)
    return
  }
  const id = Number(props.characterId)
  if (!id) return
  // 场景要一起发：群里点动作 ⇒ 后端把她的反应写进群会话并广播 group_message（不是私聊）
  const sceneFields = props.scene === 'group' && props.groupId ? { scene: 'group', groupId: props.groupId } : {}
  const body = action.key === 'position' ? { positionKey: action.positionKey, ...sceneFields } : { ...sceneFields, ...extra }
  busy.value = true
  busyKey.value = action.key
  try {
    const payload = await postIntimateAction(id, action.key, body)
    const result = parseActionResponse(payload)
    if (result.state) {
      // 立刻用回执里的状态刷新 HUD；`actions` 置空 ⇒ 这一帧先走镜像门控（别显示上一轮的旧可用性）
      snapshot.value = {
        ...(snapshot.value || {}),
        state: { ...(snapshot.value?.state || {}), ...result.state },
        her: { ...(snapshot.value?.her || {}), ...(payload?.her || {}) },
        actions: [],
      }
      emit('state', snapshot.value.state)
    }
    setFeedback(actionFeedbackText(payload), !result.allowed)
    if (!result.allowed && result.message) toast?.(result.message, 'info')
    if (result.allowed) emit('reaction', { ...payload, action: action.key })
    // 后台刷新真正的可用性（不调模型，很便宜）
    refresh()
  } catch (err) {
    setFeedback(err?.message || '推进失败', true)
    toast?.(err?.message || '推进失败', 'info')
  } finally {
    busy.value = false
    busyKey.value = ''
  }
}

/** 点体位胶囊 = 换姿势（也是开场入口：还没开始时点它＝把她摆成那个姿势） */
function changePosition(item) {
  if (!item?.key) return
  return run({ key: 'position', label: '换姿势', hint: '', tone: '', available: true, reason: '', positionKey: item.key })
}

/**
 * 点「自动速度」页签 = 只改**他自动插送的快慢**（2026-10-03 用户：「自动的速度新增一个单独的」）。
 *
 * 走的是同一个 `auto` 动作但**带 pace** ⇒ 服务端只改 `autoPace`（不会把自动关掉、也不碰手动节奏档）。
 * 这里刻意**不走 run()**：改速度不该触发一轮反应（那会白烧一次模型调用），所以自己发请求 + 只更新 HUD。
 */
async function setAutoPace(pace) {
  const id = Number(props.characterId)
  const next = clampPaceForUi(pace)
  if (!id || busy.value || !next) return
  if (!view.value.autoThrust) {
    setFeedback('先开「自动插入」，再调他自动插送的快慢。', true)
    return
  }
  if (next === view.value.autoPace) return
  const sceneFields = props.scene === 'group' && props.groupId ? { scene: 'group', groupId: props.groupId } : {}
  busy.value = true
  busyKey.value = 'auto'
  try {
    const payload = await postIntimateAction(id, 'auto', { pace: next, ...sceneFields })
    const state = payload?.state || null
    if (state) {
      snapshot.value = {
        ...(snapshot.value || {}),
        state: { ...(snapshot.value?.state || {}), ...state },
        her: { ...(snapshot.value?.her || {}), ...(payload?.her || {}) },
      }
      emit('state', snapshot.value.state)
    }
    const label = paceOptions().find(p => p.value === next)?.label || next
    setFeedback(payload?.allowed === false ? (payload?.message || '现在调不了速度。') : `自动速度已调成「${label}」。`)
  } catch (err) {
    setFeedback(err?.message || '调速度失败', true)
  } finally {
    busy.value = false
    busyKey.value = ''
  }
}

watch(() => props.open, (open) => {
  if (open) {
    setFeedback('')
    refresh()
  }
})

watch(() => props.characterId, () => {
  if (props.open) refresh()
})

defineExpose({ refresh })
</script>

<style scoped>
/* 浮动小窗：右下角，不挡消息区（与 TouchActionPanel 同取向：无遮罩、不接管点击） */
.ia-panel {
  position: fixed;
  right: 16px;
  bottom: 96px;
  z-index: 60;
  width: min(340px, calc(100vw - 24px));
  max-height: min(70vh, 620px);
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 12px);
  box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.18));
  transition: opacity 0.3s ease, transform 0.3s ease;
}

/* 面板开合：0.3s 渐入渐出（AGENTS.md：窗口/内容切换 0.3s，关闭动画跑完再卸载） */
.ia-panel-enter-active,
.ia-panel-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.ia-panel-enter-from,
.ia-panel-leave-to { opacity: 0; transform: translateY(12px); }

.ia-header { display: flex; align-items: center; gap: 8px; }
.ia-title { font-size: 14px; font-weight: 600; color: var(--text-bright, var(--text-primary)); }
.ia-summary {
  flex: 1; min-width: 0; font-size: 11px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.ia-hud { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 8px; }
.ia-chip {
  padding: 2px 8px; border-radius: 999px; font-size: 11px;
  color: var(--text-secondary); background: var(--bg-sunken, rgba(0, 0, 0, 0.05));
  border: 1px solid var(--border);
}
.ia-chip.is-hot { color: var(--accent); border-color: var(--accent); }
.ia-chip.is-done { color: var(--text-bright, var(--text-primary)); }

/* 累积度：宽度变化 0.3s（"推进感"的可视化） */
.ia-bar {
  position: relative; height: 8px; border-radius: 999px; overflow: hidden;
  background: var(--bg-sunken, rgba(0, 0, 0, 0.06));
  border: 1px solid var(--border);
}
.ia-bar-fill {
  height: 100%; border-radius: 999px;
  background: var(--accent);
  transition: width 0.3s ease, background-color 0.3s ease;
}
.ia-bar-fill.is-edge { background: #e0864a; }
.ia-bar-fill.is-overload { background: #c74949; }
.ia-bar-edge {
  position: absolute; top: 0; bottom: 0; left: 60%;
  width: 1px; background: color-mix(in srgb, var(--text-secondary) 60%, transparent);
}
.ia-bar-text { margin: 6px 0 2px; font-size: 11px; color: var(--text-secondary); }
/* 她自己的「一起到」门槛（随敏感度浮动 45~60）：跟数字同一行、弱化一档，别抢累积度 */
.ia-threshold { opacity: 0.8; }
.ia-edge-hint { margin: 0 0 8px; font-size: 11px; color: var(--text-secondary); opacity: 0.85; }

.ia-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.ia-row--block { display: block; }
.ia-label { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
.ia-row--block .ia-label { display: block; margin-bottom: 6px; }
/* 自动速度那一排右侧的说明（"每 3.0 秒一下" / "先开自动继续抽插"）：弱化，别抢页签 */
.ia-auto-hint { font-size: 11px; color: var(--text-secondary); opacity: 0.85; white-space: nowrap; }

.ia-positions { display: flex; flex-wrap: wrap; gap: 6px; }

.ia-actions {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px; margin-top: 10px;
}

.ia-feedback {
  margin: 10px 0 0; font-size: 11px; line-height: 1.5;
  color: var(--text-secondary);
}
.ia-feedback.is-reject { color: #c74949; }

/* 提示行切换也走 0.3s，避免文字硬跳 */
.ia-fade-enter-active,
.ia-fade-leave-active { transition: opacity 0.3s ease; }
.ia-fade-enter-from,
.ia-fade-leave-to { opacity: 0; }

@media (max-width: 520px) {
  .ia-panel { right: 8px; left: 8px; width: auto; bottom: 84px; }
}
</style>
