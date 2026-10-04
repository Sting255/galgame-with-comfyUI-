<template>
  <Teleport to="body">
    <Transition name="touch-overlay">
      <!-- §4.2 浮动小窗：**没有遮罩**（点外面不关闭，只有 ✕ 关）—— overlay 只做定位层，不接收事件 -->
      <div v-if="open" class="touch-overlay">
        <!-- 2026-10-01 真机反馈两条，都在这里修：
             ①「滑下去之后要回到最顶部才能拖」→ 面板本身不再是滚动容器（见 .touch-panel 的
                overflow:hidden），滚动下沉到 .touch-body，**头部永远在**，因此在任何滚动位置都能拖；
             ②「拖动很卡」→ 位移不再走响应式 ref（每帧触发整块重渲染），改成直接写 style.transform，
                并用 requestAnimationFrame 把高频 pointermove 合并成每帧一次（与 TownImageEditor 同套路）。
             注意：:style 绑定已去掉，transform 由 applyTransform() 统一写，避免两处互相覆盖。 -->
        <div
          ref="panelRef"
          class="touch-panel"
          :class="{ 'is-dragging': dragging }"
          role="dialog"
          aria-modal="false"
          aria-label="动作"
        >
          <div class="touch-header" @pointerdown="onDragStart">
            <span class="touch-grip" aria-hidden="true" title="按住拖动面板">⠿</span>
            <!-- 催眠状态徽标（复审遗留 2）：服务端说了算；取不到就不渲染，绝不默认「完全控制」 -->
            <span v-if="hypnosisBadge" class="hypnosis-badge" :class="'is-' + hypnosisBadge.key" :title="'当前催眠状态：' + hypnosisBadge.label">{{ hypnosisBadge.label }}</span>
            <span class="touch-title">
              <svg class="touch-title-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
              摸摸她
            </span>
            <linshe-button
              v-if="requiresTarget"
              variant="chip"
              size="sm"
              :active="!!targetName"
              :title="targetName ? '更换动作对象' : '选择动作对象'"
              @click="emit('pick-target')"
            >对 {{ targetName || '谁？' }}</linshe-button>
            <linshe-button variant="icon" aria-label="关闭动作面板" @click="requestClose">✕</linshe-button>
          </div>

          <!-- 待回应提示：与入口角标同源同文案（pendingCount>0 才出现） -->
          <p v-if="pendingHint" class="touch-pending">{{ pendingHint }}</p>

          <div class="touch-body">
            <section v-for="group in groups" :key="group.level" class="touch-group">
              <h4 class="touch-group-title">{{ group.label }}</h4>
              <div class="touch-grid">
                <div
                  v-for="action in group.actions"
                  :key="action.key"
                  class="touch-card"
                  :class="{ 'is-disabled': !action.gate.allowed, 'is-busy': isBusy(action.key) }"
                  :aria-disabled="action.gate.allowed ? undefined : 'true'"
                  :title="action.gate.allowed ? action.label : action.gate.message"
                  role="button"
                  tabindex="0"
                  @click="onPick(action)"
                  @keydown.enter.prevent="onPick(action)"
                  @keydown.space.prevent="onPick(action)"
                >
                  <span v-if="likeBadge(action)" class="touch-card-like">{{ likeBadge(action) }}</span>
                  <span class="touch-card-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
                  </span>
                  <span class="touch-card-title">{{ action.label }}</span>
                  <span class="touch-card-status">
                    <template v-if="!action.gate.allowed">{{ action.gate.message || '现在还不行' }}</template>
                    <template v-else-if="action.gate.wakesSleeping">会把她弄醒</template>
                    <template v-else>{{ statusOf(action) }}</template>
                  </span>
                  <span v-if="isBusy(action.key)" class="touch-card-spinner" aria-hidden="true"></span>
                </div>
              </div>
            </section>
          </div>

        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
/**
 * SLG 动作系统 · 交互改版（专题-动作交互改版 §二/§三 方案 A）
 *
 * 形态：输入区最右的 ✋ 图标点开「底部弹层 + 大卡片网格」——**照抄 GiftPanel 的结构范式**
 * （Teleport 到 body、底部对齐遮罩、卡片带图标/标题/状态行、点遮罩关闭、0.3s 渐入渐出），
 * 但类名在本组件内自建（GiftPanel 不是共享组件，跨组件引 scoped 样式会失效），色值一律走 token 以便双主题。
 *
 * **接口与旧的 TouchActionBar 同形**（serverGroups / state / busyAction / actions / targetName /
 * requiresTarget / pendingCount，emit action / open / pick-target），额外多三个：
 *   · states —— GET /touch/state 的 states（每动作的 annoyance / tier / likeRatio），卡片状态行用；
 *   · open   —— 受控显隐（父组件持有 showTouchPanel）；
 *   · close  —— 关闭（✕ / 点遮罩 / 父组件自己收）。
 *
 * **已验收的行为一个都没丢**（专题 §六 要求）：
 *   · 门控**服务端优先**（serverGroups 里的 gate.code / gate.message 原样用），端点不可用回落镜像；
 *   · 门控不满足的卡片半透明但**仍可点**，点了 toast 服务端那句剧情化提示（不是机械报错）；
 *   · busyAction 期间忽略连点；睡着时点唤醒类动作先给一句提示；
 *   · 群聊没选「对谁」时点卡片只 toast + 请求选人（面板顶部有「对 XXX」可随时换人）；
 *   · 催眠豁免等门控逻辑全在服务端，这里零翻译、零自算。
 *
 * **做完动作面板不自动关**：SLG 触摸的玩法就是连着摸；她的反应由后端广播进消息流，
 * 面板是 Teleport 弹层不挡消息区。组件只 emit('action', key)，**不插消息、不伪造反应**。
 */
import { computed, inject, ref, watch } from 'vue'
import LinsheButton from './ui/LinsheButton.vue'
import {
  TOUCH_ACTIONS,
  WAKE_WARNING_TEXT,
  buildActionGroups,
  likeBadgeOf,
  pendingHintByMode,
  toleranceLabel,
} from './touchActionLogic.js'

const props = defineProps({
  /** 受控显隐 */
  open: { type: Boolean, default: false },
  /** 服务端分组（GET .../touch/actions 规范化而来）：**有它就用它**，gate.code / gate.message 原样吃 */
  serverGroups: { type: Array, default: () => [] },
  /** 镜像门控状态（与服务层 getTouchGate 同名入参）—— 仅作端点不可用时的兜底 */
  state: { type: Object, default: () => ({}) },
  /** 正在上报的动作 key（父组件传入），用于该卡片的 loading 态（旧单值，保留兼容） */
  busyAction: { type: String, default: '' },
  /**
   * 正在上报的动作 key 集合（§4.2 连点）：**同动作重复点击忽略、不同动作可并发**，每卡独立 loading。
   * 父组件传 Set 或数组都吃。
   */
  busyActions: { type: [Object, Array], default: () => new Set() },
  /** 镜像动作清单（仅在无 serverGroups 时使用） */
  actions: { type: Array, default: () => TOUCH_ACTIONS },
  /** 群聊多人场景：当前动作对象的成员名；非空时显示「对 XXX」胶囊 */
  targetName: { type: String, default: '' },
  /** 需要先选动作对象（群聊为 true）：没选对象不让做动作 */
  requiresTarget: { type: Boolean, default: false },
  /** 待回应动作条数（GET .../touch/state 的 pendingCount）：>0 才显示提示行 */
  pendingCount: { type: Number, default: 0 },
  /** 每动作的耐受 / 偏好（GET .../touch/state 的 states），卡片状态行与偏好角标用 */
  states: { type: Object, default: () => ({}) },
  /**
   * 分模式待回应数 { instant, implicit }（专题 §七 问题 3）：有 implicit ⇒ 文案换成「跟她说句话吧」。
   * 🔌 后端字段尚未落地：缺了自动回落「还有 N 个动作等她回应」。
   */
  pendingByMode: { type: Object, default: () => ({}) },
  /**
   * 催眠状态徽标（复审遗留 2）：父组件从 GET /hypnosis 取「服务端结论」后用 hypnosisBadgeOf 算好传进来。
   * **null ⇒ 不渲染**（组件不读原始字段、不做任何推断）。
   */
  hypnosisBadge: { type: Object, default: null },
})

const emit = defineEmits(['action', 'open', 'pick-target', 'close', ])

const toastFn = inject('toast', null)

// 正常路径吃服务端（含 code / message）；端点不可用 / 早期加载时回落镜像
const groups = computed(() =>
  props.serverGroups && props.serverGroups.length
    ? props.serverGroups
    : buildActionGroups(props.state, props.actions),
)

// 待回应提示行（mode 感知）：有隐式待回应就提醒用户去说句话（专题 §七 问题 3）
const pendingHint = computed(() => pendingHintByMode({ count: props.pendingCount, byMode: props.pendingByMode }))

/** 卡片状态行（可用态）：她的耐受档 */
function statusOf(action) {
  const st = props.states && action ? props.states[action.key] : null
  return toleranceLabel(st)
}

/** 偏好角标：♥ / ～ / 空 */
function likeBadge(action) {
  const st = props.states && action ? props.states[action.key] : null
  return likeBadgeOf(st && st.likeRatio)
}

/** 该卡是否在飞：新 Set 优先，旧单值兜底（两个容器都认，父组件换实现不影响这里） */
function isBusy(key) {
  if (!key) return false
  const set = props.busyActions
  if (set && typeof set.has === 'function') return set.has(key)
  if (Array.isArray(set)) return set.includes(key)
  return props.busyAction === key
}

function requestClose() {
  emit('close')
}

// ── §4.2 浮动小窗：自实现 pointer 拖动（项目里没有现成拖动组件）──
// 默认仍从底部弹出；拖动后变成自由浮窗（不吸附）；关掉再开回默认位置；
// 位置持久化到 localStorage，刷新页面能记住上次拖到哪；视口边界 clamp（移动端同逻辑）。
const PANEL_POS_KEY = 'touch-panel-pos'
const panelRef = ref(null)
/** 自由浮窗的位移 {x,y}；null = 没拖过，走默认（底部居中）。它是**已提交**的位置，
 *  拖动过程中不写它 —— 每帧改一次 ref 会让整块面板重渲染，那正是「拖起来卡」的来源。 */
const dragOffset = ref(null)
/** 本页是否已经「恢复过」持久化位置（只恢复一次，之后每次打开都回默认位置） */
let restoredOnce = false
const dragging = ref(false)
let dragStart = null
let rafId = 0          // 本帧是否已排过 applyDragFrame
let lastPointer = null // 最近一次指针坐标（高频事件只记这个）
let lastApplied = null // 最近一次真正写进 DOM 的位移（松手时提交它）

/** 把位移写进 DOM。**唯一的 transform 写入口**：直接改 style，绕开响应式。 */
function applyTransform(offset) {
  const el = panelRef.value
  if (!el) return
  el.style.transform = offset ? `translate(${offset.x}px, ${offset.y}px)` : ''
}
/** dragOffset 变化时（打开恢复位置 / 松手提交）同步一次 DOM */
watch(dragOffset, (v) => applyTransform(v), { flush: 'post' })

function readSavedPos() {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!(p && Number.isFinite(p.x) && Number.isFinite(p.y))) return null
    // 2026-09-30 真机 bug：恢复坐标必须夹进**当前**视口 —— 在别的窗口尺寸/屏幕拖过之后，
    // 旧坐标会把面板顶到屏幕外，用户看到的现象就是「点了没反应（面板其实在画布外）」
    return clampOffset(p.x, p.y)
  } catch { return null }
}
function savePos(p) {
  try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(p)) } catch { /* 隐私模式等写不进去就算了 */ }
}

/** 把位移夹到视口里，保证整块面板不跑出屏幕外 */
function clampOffset(x, y) {
  const el = panelRef.value
  const w = el?.offsetWidth || 340
  const h = el?.offsetHeight || 360
  const vw = window.innerWidth || 0
  const vh = window.innerHeight || 0
  const maxX = Math.max(0, (vw - w) / 2)
  const maxY = Math.max(0, (vh - h) / 2)
  return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
}

/**
 * 头部里「不是拖动把手」的交互元件：✕（LinsheButton 渲染成 <button class="ls-btn">）与
 * 群聊的「对 XXX」胶囊。判定用 closest，所以点图标/文字也算命中。
 */
const DRAG_IGNORE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="link"]';

function onDragStart(e) {
  if (e.button !== undefined && e.button !== 0) return
  // 2026-10-01 真机 bug「浮窗打开就关不了」的真因：
  // 头部整块是拖动把手，而这里**无条件**把指针捕获到头部（setPointerCapture）。
  // 指针一旦被头部捕获，后续 pointerup 会被重定向到头部，浏览器随后派发的 click
  // 也就落在「pointerdown 目标与 pointerup 目标的最近公共祖先」＝头部上 ——
  // 于是头部里的 ✕ 与「对 XXX」**永远收不到 click**，面板关不掉、也换不了对象。
  // 契约：从交互元件上按下的那一下**不启动拖动、不抢指针**，把事件留给它自己。
  const target = e.target
  if (target && typeof target.closest === 'function' && target.closest(DRAG_IGNORE_SELECTOR)) return
  dragStart = { px: e.clientX, py: e.clientY, x: dragOffset.value?.x || 0, y: dragOffset.value?.y || 0 }
  lastPointer = null
  lastApplied = null
  dragging.value = true
  // 拖动期间提示合成层：这块面板有圆角+阴影+半透明，不提升会每帧重绘整块（真机上的「卡」）
  if (panelRef.value) panelRef.value.style.willChange = 'transform'
  e.currentTarget?.setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
}
/** 每帧最多应用一次：高频 pointermove 只更新 lastPointer，真正写 DOM 交给 rAF */
function applyDragFrame() {
  rafId = 0
  if (!dragStart || !lastPointer) return
  const next = clampOffset(
    dragStart.x + (lastPointer.x - dragStart.px),
    dragStart.y + (lastPointer.y - dragStart.py)
  )
  lastApplied = next
  applyTransform(next)
}
function onDragMove(e) {
  if (!dragStart) return
  lastPointer = { x: e.clientX, y: e.clientY }
  if (rafId) return
  rafId = requestAnimationFrame(applyDragFrame)
}
function onDragEnd() {
  if (!dragStart) return
  // 松手前把最后一帧补上（否则快速甩动会停在上一帧的位置）
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; applyDragFrame() }
  dragStart = null
  lastPointer = null
  dragging.value = false
  if (panelRef.value) panelRef.value.style.willChange = ''
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  if (lastApplied) { dragOffset.value = lastApplied; savePos(lastApplied) }
  lastApplied = null
}

// 打开时让父组件刷一次服务端门控（好感 / 睡眠 / 催眠会变，门控要跟着变）；
// 群聊还没选「对谁」就把成员面板直接甩出来（少一次点击）
watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  // 位置：**关掉再开回默认位置**（§4.2 形态行）；只有本页第一次打开才吃 localStorage 里的
  // 「上次拖到哪」（刷新后仍记得，符合 §4.2 记忆点行）—— 靠这个一次性开关区分两者。
  if (!restoredOnce) { restoredOnce = true; dragOffset.value = readSavedPos() } else { dragOffset.value = null }
  emit('open')
  if (props.requiresTarget && !props.targetName) emit('pick-target')
})

function onPick(action) {
  if (!action || !action.gate) return
  // 群聊多人场景：先选「对谁」——没选之前门控都无从谈起（gate 是按目标成员算的）
  if (props.requiresTarget && !props.targetName) {
    toastFn?.('先选一个人，再动手', 'info')
    emit('pick-target')
    return
  }
  // 门控不满足：卡片半透明但仍可点，点了给一句有剧情的提示（专题 §3.1：不要机械报错）
  // message 正常路径就是服务端 getTouchGate 的原句（serverGroups）；镜像兜底时才用本地文案
  if (!action.gate.allowed) {
    toastFn?.(action.gate.message || '现在还不行', 'info')
    return
  }
  // 已有动作在上报：忽略连点，避免重复触发
  if (props.busyAction) return
  if (action.gate.wakesSleeping) toastFn?.(WAKE_WARNING_TEXT, 'info')
  emit('action', action.key)
}
</script>

<style scoped>
/* 底部弹层：结构照 GiftPanel（.gift-overlay / .gift-panel），类名与色值在本组件自建走 token */
.touch-overlay {
  /* §七：不再全屏（消息区不挡）；§4.2：**浮动小窗化后彻底没有遮罩** ——
     这一层只承担「把面板摆在底部居中」的定位，**不吃任何指针事件**（点外面不关闭，只有 ✕ 关）。 */
  position: fixed; inset: auto 0 0 0; z-index: 2000;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 0 16px 100px;
  pointer-events: none;
}
.touch-panel {
  /* §4.2：底部弹层 → 浮动小窗，宽度收窄到 ~340px（520 全宽对浮窗太大） */
  pointer-events: auto;
  width: min(340px, 100%);
  max-height: min(62dvh, 560px);
  /* 2026-10-01 真机反馈「滑下去之后得回到最顶部才能拖」：
     原来面板本体是滚动容器（overflow-y:auto），而唯一的拖动把手 .touch-header 是它第一个子元素
     ⇒ 往下滑，把手就滚出视野，抓不到了。现在面板本身不滚，改成 flex 列 + **内容区自己滚**，
     头部永远在视野里，因此在任何滚动位置都能拖。
     touch-action:none 依旧只加在把手上（见 .touch-header），面板内容照常能滑。 */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--modal-bg);
  border: var(--modal-border);
  border-radius: var(--modal-radius);
  box-shadow: var(--modal-shadow);
  color: var(--text-bright);
  /* 左右/底部内边距下沉到 header / pending / body，让滚动条贴面板边 */
  padding: 18px 0 0;
}

.touch-header {
  flex: 0 0 auto;        /* 常驻：不参与滚动 */
  padding: 0 20px;
  display: flex; align-items: center; gap: 10px;
  cursor: grab;          /* §4.2：标题栏是拖动把手 */
  user-select: none;
  touch-action: none;    /* 只有把手不吃滚动，面板本体照常可滚 */
}
.touch-panel.is-dragging { cursor: grabbing; }
.touch-panel.is-dragging .touch-header { cursor: grabbing; }
/* 催眠状态徽标：小胶囊，走 token（双主题），不引入新体系 */
.hypnosis-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  background: var(--tint-subtle);
}
.hypnosis-badge.is-full { color: var(--accent); border-color: var(--accent); }
.touch-grip {
  flex-shrink: 0;
  font-size: 13px; line-height: 1;
  color: var(--text-secondary);
  opacity: 0.7;
  letter-spacing: -1px;
}
.touch-title {
  display: flex; align-items: center; gap: 7px;
  margin-right: auto;
  font-size: 16px; font-weight: 600;
  color: var(--text-bright);
}
.touch-title-icon { flex-shrink: 0; }
.touch-pending { flex: 0 0 auto; margin: 6px 20px 0; font-size: 12px; color: var(--text-secondary); }

.touch-body {
  /* 滚动下沉到这里：min-height:0 是必须的 —— flex 子项默认 min-height:auto 会顶开容器、让内部滚不动 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 20px 20px;
}
.touch-group + .touch-group { margin-top: 14px; }
.touch-group-title {
  margin: 0 0 8px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
  color: var(--text-secondary);
}
.touch-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }

/* 大卡片（对照 .gift-card）：整卡热区 → AGENTS.md 组件约定第 4 条，div + role=button + 自包含样式 */
.touch-card {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 12px 8px 10px;
  border-radius: 14px;
  border: 1.5px solid var(--border);
  background: var(--bg-secondary);
  text-align: center;
  cursor: pointer;
  user-select: none;
  transition: transform 0.25s cubic-bezier(0.22, 0.61, 0.36, 1), box-shadow 0.25s ease, border-color 0.25s ease;
}
.touch-card:hover { transform: translateY(-2px); border-color: var(--accent); }
.touch-card:active { transform: scale(0.97); }
.touch-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 门控不满足：只降透明度 + 禁止光标，**保持可点**（点了给剧情化提示） */
.touch-card.is-disabled { opacity: 0.5; cursor: not-allowed; }
.touch-card.is-busy { pointer-events: none; }

.touch-card-like {
  position: absolute; top: 6px; right: 8px;
  font-size: 12px; line-height: 1; color: var(--accent);
}
.touch-card-icon { color: var(--accent); line-height: 0; }
.touch-card-title { font-size: 13px; font-weight: 500; color: var(--text-bright); }
.touch-card-status {
  font-size: 11px; line-height: 1.35;
  color: var(--text-secondary);
  min-height: 15px;
}
.touch-card-spinner {
  position: absolute; top: 50%; left: 50%;
  width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border-radius: 50%;
  border: 2px solid var(--tint-subtle);
  border-top-color: var(--accent);
  animation: touch-spin 0.8s linear infinite;
}
@keyframes touch-spin { to { transform: rotate(360deg); } }

/* 弹层渐入渐出 0.3s（AGENTS.md 硬要求：关窗动画跑完再卸载，Transition 天然满足） */
.touch-overlay-enter-active,
.touch-overlay-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.touch-overlay-enter-from,
.touch-overlay-leave-to {
  opacity: 0;
  transform: translateY(16px);
}

@media (max-width: 767px) {
  .touch-overlay { padding: 0 10px 84px; }
  .touch-panel { padding: 14px 14px 16px; max-height: 70dvh; }
  .touch-grid { gap: 8px; }
  .touch-card { padding: 10px 6px 8px; border-radius: 12px; }
}
</style>