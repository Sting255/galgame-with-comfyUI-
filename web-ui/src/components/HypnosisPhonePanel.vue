<template>
  <!-- 催眠手机面板：只做内容与数据，弹窗外壳由调用方（背包）用 LinsheModal 提供。
       props.character 与 IntimatePanel 同约定。 -->
  <div class="hp">
    <div v-if="initialLoading" class="hp-skeleton">
      <div v-for="n in 4" :key="n" class="skeleton hp-sk-row"></div>
    </div>

    <template v-else>
      <p v-if="loadError" class="hp-banner">
        {{ loadError }}
        <linshe-button variant="link" size="sm" @click="refreshAll">重试</linshe-button>
      </p>

      <!-- ── ① 状态条 ── -->
      <section class="hp-status">
        <div class="hp-status-main">
          <span class="hp-status-name">{{ displayName }}</span>
          <span class="hp-badge" :class="statusClass">{{ view.statusText }}</span>
        </div>
        <!-- 意志 / 身体 是两枚正交标记：只唤醒意志后应显示「意志：清醒 / 身体：受控」 -->
        <div class="hp-marks">
          <span class="hp-mark" :class="{ 'is-on': !view.mindAwake }">
            <span class="hp-mark-label">意志</span>
            <span class="hp-mark-value">{{ view.mindText }}</span>
          </span>
          <span class="hp-mark" :class="{ 'is-on': view.bodyControlled }">
            <span class="hp-mark-label">身体</span>
            <span class="hp-mark-value">{{ view.bodyText }}</span>
          </span>
        </div>
      </section>

      <!-- ── ② 门控提示 + 领取 ── -->
      <p v-if="gateHint" class="hp-gate">{{ gateHint }}</p>
      <div v-if="phoneMissing" class="hp-grant">
        <linshe-button variant="primary" size="sm" :loading="busy === 'grant'" @click="onGrantPhone">
          领取催眠手机
        </linshe-button>
        <span class="hp-grant-tip">领取后回到这里就能用了</span>
      </div>

      <!-- ── ②.5 睡眠控制（**独立于催眠指令**：这是"她睡没睡"，不是"对她下指令"）──
           用户口径：「催眠手机是全覆盖的」（睡眠控制要有入口）、「单独一个选项控制睡眠」。
           状态来自睡眠服务（characters.is_sleeping / sleep_until），与上面的催眠状态是两套东西。
           刻意不与门控联动：睡眠不是催眠指令，手机没领到手也不该拦住她睡觉（后端若不认会返回错误，面板照样提示）。 -->
      <section class="hp-sec hp-sec-sleep">
        <header class="hp-sec-head">
          <h4 class="hp-sec-title">睡眠控制</h4>
          <span class="hp-sec-hint">单独控制她睡不睡，与催眠指令无关</span>
        </header>
        <div class="hp-sleep-status">
          <span class="hp-sleep-badge" :class="sleepView.isSleeping ? 'is-sleeping' : (sleepView.known ? 'is-awake' : '')">
            {{ sleepView.statusText }}
          </span>
          <span v-if="sleepView.untilText" class="hp-sleep-note">{{ sleepView.untilText }}</span>
          <span v-if="sleepView.tempWakeText" class="hp-sleep-note">{{ sleepView.tempWakeText }}</span>
        </div>
        <div class="hp-actions">
          <linshe-button
            v-for="action in SLEEP_ACTIONS"
            :key="action.key"
            :variant="action.variant"
            size="sm"
            :disabled="!sleepMatrix[action.key] || actionBusy"
            :loading="busy === action.key"
            @click="onSleepAction(action.key)"
          >
            {{ action.label }}
          </linshe-button>
        </div>
        <p class="hp-note">{{ SLEEP_SECTION_NOTE }}</p>
      </section>

      <!-- ── ③ 自定义时长 ── -->
      <section class="hp-sec">
        <header class="hp-sec-head">
          <h4 class="hp-sec-title">催眠时长</h4>
          <span class="hp-sec-hint">想催眠就催眠、想什么时候停就停</span>
        </header>
        <div class="hp-duration">
          <linshe-input
            v-model="minutes"
            type="number"
            size="sm"
            :min="MIN_MINUTES"
            :max="MAX_MINUTES"
            class="hp-duration-input"
            aria-label="催眠时长（分钟）"
          />
          <span class="hp-duration-unit">分钟</span>
          <span class="hp-duration-range">可填 {{ MIN_MINUTES }} ~ {{ MAX_MINUTES }}</span>
        </div>
      </section>

      <!-- ── ④ 操作区 ── -->
      <section class="hp-sec">
        <header class="hp-sec-head">
          <h4 class="hp-sec-title">操作</h4>
          <span class="hp-sec-hint">未满足条件时按钮不可点</span>
        </header>
        <div class="hp-actions">
          <linshe-button
            v-for="action in ACTION_DEFS"
            :key="action.key"
            :variant="action.variant"
            size="sm"
            :disabled="!matrix[action.key] || actionBusy"
            :loading="busy === action.key"
            @click="onAction(action.key)"
          >
            {{ action.label }}
          </linshe-button>
        </div>
        <!-- 只唤醒意志后的说明 / 指令回执 -->
        <Transition name="hp-fade">
          <p v-if="notice" class="hp-notice">{{ notice }}</p>
        </Transition>
        <p v-if="view.active && view.pendingDirective" class="hp-note">待执行指令：{{ directiveText(view.pendingDirective) }}</p>
        <p class="hp-note">累计指令 {{ view.commandCount }} 次{{ view.lastCommand ? ` · 最近：${directiveText(view.lastCommand)}` : '' }}</p>
      </section>

      <!-- ── ⑤ 命令她用玩具（force_toy，2026-10-01 新增）────────────────────────
           用户原话：「催眠状态也不能强制让角色用上玩具」。
           语义：归催眠域（**在催眠中即可下**，未满足时按钮随 `matrix.forceToy` 置灰）；
           ⚠️ 这里曾经写成 `matrix.body_control`——矩阵里没有这个键 ⇒ 永远置灰、点不了（真机 bug）。
           点下去服务端**当场真的把玩具戴上**并立刻替她触发一轮，所以点完马上就能看到反应与配图。 -->
      <Transition name="hp-fade">
        <!-- 高潮控制（2026-10-02 用户要求加在催眠手机里，且**不需要催眠也能点**）：
         与催眠无关 ⇒ 刻意不挂 actionMatrix 门控；只有"这一场还没开始"时才置灰并说明怎么开始。
         ⚠️ 别在这里再套一层 Transition：上面那层就是给它用的，多开一层会让 SFC 标签不配平
         （构建直接报 "Element is missing end tag"；源码守卫测试测不出这种错）。 -->
    <section class="hp-sec hp-sec-denial">
      <h3 class="hp-sec-title">高潮控制</h3>
      <p class="hp-note">
        她的累积：{{ denialView.accumulationText }}
        <span v-if="denialView.denial"> · 正在被禁止高潮</span>
      </p>
      <linshe-button
        :variant="denialView.denial ? 'danger' : 'secondary'"
        size="sm"
        :disabled="actionBusy || !denialView.active"
        :loading="busy === 'denial'"
        :title="denialView.hint"
        @click="onToggleDenial"
      >{{ denialView.label }}</linshe-button>
      <p v-if="!denialView.active" class="hp-note">这一场还没开始：先在私聊里点「❤ 推进」→「进入她」。</p>
    </section>
    </Transition>

    <!-- ── ⑥ 发情模式（2026-10-02 用户原话「然后再在催眠手机里加一个选项 叫发情模式
           角色的敏感度就会直接拉满」）────────────────────────────────────────────
         它管的是"她这个人现在有多敏感"，与催眠状态**无关** ⇒ 同样刻意不挂 actionMatrix 门控。
         拨开 ⇒ 服务端把敏感度直接写成 100（默认 2 小时后自然回落）；拨回去 ⇒ 回落到常态上沿。
         ⚠️ 与「高潮控制」是**兄弟** Transition（不是同一层里的第二个孩子）：Vue 的 <Transition>
           只接受一个孩子，塞两个进去会变成 dev 警告 + 干脆不过渡。 -->
    <Transition name="hp-fade">
    <section class="hp-sec hp-sec-heat">
      <header class="hp-sec-head">
        <h4 class="hp-sec-title">发情模式</h4>
        <linshe-switch
          v-model="heatOn"
          size="sm"
          on-text="发情中"
          off-text="已关闭"
          :disabled="actionBusy || !!heatBusy"
          aria-label="发情模式开关"
          @change="onToggleHeat"
        />
      </header>
      <p class="hp-note">
        她的敏感度：{{ heatView.valueText }}<span v-if="heatView.untilText"> · {{ heatView.untilText }}</span>
      </p>
      <p class="hp-note">{{ heatView.note }}</p>
    </section>
    </Transition>

    <Transition name="hp-fade">
    <section v-if="toysView.visible" class="hp-sec hp-sec-toys">
          <header class="hp-sec-head">
            <h4 class="hp-sec-title">命令她用玩具</h4>
            <span class="hp-sec-hint">戴上之后她自己取不下来</span>
          </header>
          <div class="hp-toy-row">
            <linshe-select
              v-model="toyKey"
              size="sm"
              :options="toysView.options"
              class="hp-toy-select"
              aria-label="选择要命令她戴上的玩具"
            />
            <linshe-select
              v-model="toyIntensity"
              size="sm"
              :options="toysView.intensityOptions"
              class="hp-toy-intensity"
              aria-label="选择强度"
            />
            <!-- 振动模式（2026-10-02）：不选＝保持她当前的模式 -->
            <linshe-select
              v-model="toyMode"
              size="sm"
              :options="toyModeOptions"
              class="hp-toy-mode"
              aria-label="选择振动模式"
            />
            <!-- 强度曲线（2026-10-02 第二步）：不选＝保持她当前的曲线 -->
            <linshe-select
              v-model="toyCurve"
              size="sm"
              :options="toyCurveOptions"
              class="hp-toy-curve"
              aria-label="选择强度曲线"
            />
            <linshe-button
              variant="secondary"
              size="sm"
              :disabled="!matrix.forceToy || actionBusy || !toyKey"
              :loading="busy === 'forceToy'"
              title="她没被完全控制时用不了"
              @click="onForceToy"
            >
              命令她戴上
            </linshe-button>
          </div>
          <p class="hp-note">{{ toysView.hint }}</p>
        </section>
      </Transition>

      <!-- ── ⑤ 遗忘记录 ── -->
      <section class="hp-sec">
        <header class="hp-sec-head">
          <h4 class="hp-sec-title">遗忘记录</h4>
          <span class="hp-sec-hint">可以把这段时间的记忆还给她</span>
        </header>
        <div v-if="forgotten.length" class="hp-forgotten stagger">
          <div v-for="row in forgotten" :key="row.id" class="hp-forgotten-row">
            <div class="hp-forgotten-main">
              <span class="hp-forgotten-time">{{ row.timeText }}</span>
              <span class="hp-forgotten-archived">{{ row.archivedText }}</span>
              <span class="hp-tag" :class="row.canRestore ? 'is-active' : ''">{{ row.statusText }}</span>
            </div>
            <!-- 非破坏性操作：不需要二次确认；已恢复的行按钮置灰 -->
            <div class="hp-forgotten-actions">
              <span class="hp-forgotten-tip">还原该段时间的长期记忆，并解除上下文屏蔽</span>
              <linshe-button
                variant="secondary"
                size="sm"
                title="她会在下一次对话里想起来"
                :disabled="!row.canRestore || actionBusy"
                :loading="busy === `restore-${row.id}`"
                @click="onRestore(row)"
              >
                让她恢复这段记忆
              </linshe-button>
            </div>
          </div>
        </div>
        <p v-else class="hp-empty">还没有遗忘记录</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'

import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
// 发情模式（2026-10-02）：一个「开/关」的开关 ⇒ 必须走统一开关组件（裸 checkbox 是明确禁止的）
import LinsheSwitch from './ui/LinsheSwitch.vue'
// 玩具清单：force_toy 指令要选"命令她戴上哪一件、多大强度"（服务端 gate 仍然说了算）
import { fetchToys } from '../api/index.js'
// 高潮控制（2026-10-02）：禁止高潮的开关住在性爱场景状态里，与催眠无关 —— 所以走性爱那套 API
import { fetchIntimateActionState, postIntimateAction } from '../api/index.js'
import { TOYS, TOY_KEYS, maxIntensityOf } from './toyLogic.js'
// 请求走 api 层，判定口径走纯逻辑层（components/hypnosisLogic.js）
import {
  commandCharacter,
  forgetControlledWindow,
  getHeatMode,
  getHypnosisState,
  grantHypnosisPhone,
  hypnotizeCharacter,
  listForgottenWindows,
  restoreForgottenWindow,
  setHeatMode,
  sleepCharacter,
  wakeCharacter,
  wakeFromSleepCharacter,
} from '../api/hypnosis.js'
import {
  ACTION_DEFS,
  DEFAULT_MINUTES,
  MAX_MINUTES,
  MIN_MINUTES,
  RESTORE_TOAST_TEXT,
  SLEEP_ACTIONS,
  SLEEP_SECTION_NOTE,
  SLEEP_TOAST,
  WAKE_MIND_NOTICE,
  actionMatrix,
  clampMinutes,
  directiveText,
  forgetConfirmMessage,
  forgottenRows,
  gateText,
  heatViewModel,
  hypnosisViewModel,
  isPhoneMissing,
  normalizeHeat,
  resolveSleep,
  restoreResultText,
  sleepViewModel,
} from './hypnosisLogic.js'

const props = defineProps({
  character: { type: Object, default: null },
})

const toastFn = inject('toast', null)
const confirmFn = inject('confirm', null)

/** 处于催眠中时的后端状态同步间隔 */
const POLL_MS = 10000
/** 本地走秒间隔：剩余时间要肉眼可见地走 */
const TICK_MS = 1000

const displayName = computed(() => props.character?.display_name || props.character?.name || 'TA')

const initialLoading = ref(true)
const loadError = ref('')
const state = ref(null)
const forgotten = ref([])
/** 睡眠状态：后端 POST /sleep|/wake 的返回、GET /hypnosis 里的睡眠字段、角色行上的 is_sleeping 都往这里归一 */
const sleepRaw = ref(null)
const minutes = ref(DEFAULT_MINUTES)
const busy = ref('')
const notice = ref('')

// ── 高潮控制：禁止高潮（2026-10-02 用户原话「催眠手机里加上一个 禁止高潮 高潮值就可以一直累加
//    直到手动解锁后瞬间释放高潮爽感 这个禁止高潮的按钮不需要催眠也可以点击操作」）──
// 它管的是"这一场性爱里要不要让她到"，跟催眠状态**完全无关** ⇒ 这里刻意**不挂** actionMatrix 门控
// （手机没催眠时这颗按钮照样能点）。状态住在性爱场景里，所以走性爱那套 API。
const intimateState = ref(null)
const denialView = computed(() => {
  const s = intimateState.value || {}
  const n = Number(s.accumulation) || 0
  const denial = s.denial === 1
  return {
    active: s.active === true,
    denial,
    accumulationText: denial ? `${n}（早过满格，还在涨）` : `${n}/100`,
    label: denial ? '解开（当场释放）' : '禁止高潮',
    hint: denial ? '解开：憋了这么久，她会当场释放' : '打开：她一直被吊着，高潮值一路累加',
  }
})
async function refreshIntimateState() {
  const cid = Number(props.character?.id)
  if (!cid) return
  try {
    intimateState.value = (await fetchIntimateActionState(cid))?.state || null
  } catch { /* 读不到就按"这一场还没开始"显示，不打扰用户 */ }
}
async function onToggleDenial() {
  const cid = Number(props.character?.id)
  if (!cid || actionBusy.value) return
  busy.value = 'denial'
  try {
    const payload = await postIntimateAction(cid, 'denial')
    if (payload?.state) intimateState.value = payload.state
    if (payload?.allowed === false) {
      notice.value = payload?.message || '现在点不动。'
    } else {
      notice.value = intimateState.value?.denial === 1
        ? '已禁止她高潮：高潮值会一路累加，解开那一瞬间才算释放。'
        : '已解开：她憋了这么久，当场释放。'
      const said = String(payload?.reaction?.text || '').trim()
      if (said) notice.value += ' ' + said.slice(0, 40)
    }
  } catch (err) {
    notice.value = err?.message || '操作失败'
  } finally {
    busy.value = ''
  }
}
onMounted(refreshIntimateState)
watch(() => props.character?.id, refreshIntimateState)

// ── 发情模式（2026-10-02）：与催眠无关的"她有多敏感"总开关（住在 sensitiveService 里）──
// 读一次 → 归一化成视图（口径在 hypnosisLogic.heatViewModel）；拨动 → POST 落库后再以返回值
// 覆盖本地状态（**不乐观更新**：曾经有面板先本地翻、服务端拒绝后按钮状态和真相反着来）。
const now = ref(Date.now())
const heatRaw = ref(null)
const heatBusy = ref('')
const heatOn = ref(false)
const heatView = computed(() => heatViewModel(heatRaw.value, now.value))
async function refreshHeat() {
  const cid = Number(props.character?.id)
  if (!cid) return
  try {
    const payload = await getHeatMode(cid)
    heatRaw.value = payload
    heatOn.value = normalizeHeat(payload).heat
  } catch { /* 读不到就按"已关闭"显示，不打扰用户 */ }
}
async function onToggleHeat(next) {
  const cid = Number(props.character?.id)
  if (!cid || heatBusy.value) return
  heatBusy.value = 'heat'
  try {
    const payload = await setHeatMode(cid, next === true)
    heatRaw.value = payload
    // 服务端说了算：失败/被拒时把开关拨回去
    heatOn.value = normalizeHeat(payload).heat
    notice.value = heatOn.value
      ? '已进入发情模式：她的敏感度被拉满，高潮会来得更急更密。'
      : '已退出发情模式：敏感度回到常态，之后会慢慢回落。'
  } catch (err) {
    heatOn.value = normalizeHeat(heatRaw.value).heat
    notice.value = err?.message || '操作失败'
  } finally {
    heatBusy.value = ''
  }
}
onMounted(refreshHeat)
watch(() => props.character?.id, refreshHeat)

let tickTimer = null
let pollTimer = null

const view = computed(() => hypnosisViewModel(state.value, now.value))
const matrix = computed(() => actionMatrix(view.value, now.value))
const gateHint = computed(() => gateText(state.value?.gate))
const phoneMissing = computed(() => isPhoneMissing(state.value?.gate))
const statusClass = computed(() => (view.value.hypnotized ? 'is-active' : (view.value.expired ? 'is-expired' : '')))
const actionBusy = computed(() => !!busy.value)
const sleepView = computed(() => sleepViewModel(sleepRaw.value, now.value))
const sleepMatrix = computed(() => ({
  sleep: sleepView.value.canSleep,
  wakeUp: sleepView.value.canWake,
}))

/** 睡眠状态的可读来源（优先级：本次操作的返回 → GET /hypnosis 里带的睡眠字段 → 角色行上的 is_sleeping/sleep_until） */
function refreshSleepFrom(sources) {
  const merged = resolveSleep(...sources.filter(Boolean))
  // 三个来源都没有睡眠信息时**保留旧值**（不要把已知状态抹成"未知"）
  if (merged.known) sleepRaw.value = merged
}

function notify(message, type = 'info') {
  if (typeof toastFn === 'function') toastFn(message, type)
  else console.warn('[催眠手机]', message)
}

// ── 读取 ──
async function refreshState({ silent = false } = {}) {
  const id = props.character?.id
  if (!id) return
  try {
    state.value = await getHypnosisState(id)
    // 后端可能把睡眠字段一并挂在状态里（同一位同事在改 /hypnosis）；有就顺手更新，没有就保留旧值
    refreshSleepFrom([state.value])
    if (!silent) loadError.value = ''
  } catch (err) {
    if (!silent) loadError.value = err?.message || '读取催眠状态失败'
  }
}

async function refreshForgotten() {
  const id = props.character?.id
  if (!id) return
  try {
    const res = await listForgottenWindows(id)
    forgotten.value = forgottenRows(Array.isArray(res) ? res : res?.windows || res?.forgotten || [])
  } catch {
    // 遗忘记录读失败不阻塞面板主流程（后端 task-28 未就绪时这里是 404）
    forgotten.value = []
  }
}

async function refreshAll() {
  const id = props.character?.id
  if (!id) {
    initialLoading.value = false
    return
  }
  initialLoading.value = !state.value
  loadError.value = ''
  await Promise.all([refreshState(), refreshForgotten(), loadToys(), refreshHeat()])
  initialLoading.value = false
}

// ── 轮询：1s 本地走秒 + 10s 向后端同步（只在催眠中同步） ──
function startTicking() {
  if (!tickTimer) tickTimer = setInterval(() => { now.value = Date.now() }, TICK_MS)
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (view.value.active) refreshState({ silent: true })
    // 发情模式开着时要回头问一次：到点了后端会把 heat 关掉，面板得跟着回落（不靠前端自己算过期）
    if (heatView.value.heat) refreshHeat()
  }, POLL_MS)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function stopTimers() {
  stopPolling()
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
}

// ── 操作 ──
/** 统一收口：加锁 → 执行 → 刷新状态 → 提示；返回是否成功（失败时 notice 已放错误文案） */
async function run(key, fn, { success = '', refreshForgottenAfter = false } = {}) {
  const id = props.character?.id
  if (!id || busy.value) return false
  busy.value = key
  try {
    await fn(id)
    notice.value = ''
    await refreshState()
    if (refreshForgottenAfter) await refreshForgotten()
    if (success) notify(success, 'success')
    return true
  } catch (err) {
    const message = err?.message || '操作失败'
    notice.value = message
    notify(message, 'error')
    return false
  } finally {
    busy.value = ''
  }
}

async function onHypnotize() {
  const value = clampMinutes(minutes.value)
  // 输入框可能被清空成 '' 之类的脏值：落库前统一夹到 1~720，并把输入框回写成实际生效值
  minutes.value = value
  await run('hypnotize', id => hypnotizeCharacter(id, value), { success: `已催眠 ${value} 分钟` })
}

// ── force_toy：命令她用玩具（2026-10-01，用户原话「催眠状态也不能强制让角色用上玩具」）──
// 口径：清单与强度上限都从服务端 /toys 拿（**服务端 gate 说了算**，前端只做展示与选择）；
// 未催眠时按钮随 matrix.body_control 置灰（后端也会回 409，两层都在）。
const toyKey = ref('')
const toyIntensity = ref(1)
// 振动模式（2026-10-02「继续优化」：手机里命令她用玩具时能**一次说清**哪件/多大/什么节奏）。
// 选项直接复用玩具面板那份模式表（同一个 toyLogic 镜像），不自己写键名 —— 键名写错会静默失效。
// 空值 = 不改模式（后端不写第三段，与旧编码逐字一致）。
const toyMode = ref('')
const toyCurve = ref('')
// 选项复用玩具面板那份表（同一个 toyLogic 镜像）：**字段名是 `value` / `label`**（不是 key）——
// 之前写成 `m.key ?? m.value` 属于"碰巧对"，镜像哪天加个 key 字段就会静默显示英文键名 ⇒ 这里按 value 优先写死。
// 空值 = 不改这一项（后端不写第三/四段，编码与旧值逐字一致）。
const toyModeOptions = computed(() => [
  { label: '模式不变', value: '' },
  ...VIBRATION_MODES.map(m => ({ label: m.label || m.value, value: m.value })),
])
const toyCurveOptions = computed(() => [
  { label: '曲线不变', value: '' },
  ...INTENSITY_CURVES.map(c => ({ label: c.label || c.value, value: c.value })),
])
import { VIBRATION_MODES, INTENSITY_CURVES } from './toyLogic.js'
const toysState = ref({ unlocked: false, available: [] })

const toysView = computed(() => {
  const available = Array.isArray(toysState.value.available) ? toysState.value.available : []
  const options = available.map(t => ({
    label: t.label || TOYS[t.toyKey]?.label || t.toyKey,
    value: t.toyKey,
  }))
  const max = Math.max(0, maxIntensityOf(toyKey.value))
  const intensityOptions = max > 0
    ? Array.from({ length: max + 1 }, (_, i) => ({ label: i === max ? `强度 ${i}（上限）` : `强度 ${i}`, value: i }))
    : [{ label: '无强度（象征物）', value: 0 }]
  return {
    visible: toysState.value.unlocked === true && options.length > 0,
    options,
    intensityOptions,
    hint: '点下去她会**当场**被戴上（不是"将要"），并且这一轮就会演出来；她自己取不下来。',
  }
})

async function loadToys() {
  const id = props.character?.id
  if (!id) return
  try {
    const res = await fetchToys(id)
    const available = Array.isArray(res?.available) ? res.available : []
    toysState.value = { unlocked: res?.unlocked === true, available }
    if (!toyKey.value && available.length) toyKey.value = available[0].toyKey
    // 换玩具后强度可能要回落（上限不同）
    toyIntensity.value = Math.min(Number(toyIntensity.value) || 0, maxIntensityOf(toyKey.value))
  } catch {
    toysState.value = { unlocked: false, available: [] }
  }
}

// 换玩具时把强度夹进新玩具的上限，避免"选了 5 再换成上限 2 的玩具"这种越界值被发出去
watch(toyKey, () => {
  toyIntensity.value = Math.min(Number(toyIntensity.value) || 0, maxIntensityOf(toyKey.value))
})

async function onForceToy() {
  const id = props.character?.id
  if (!id || !toyKey.value) return
  const ok = await run(
    'forceToy',
    () => commandCharacter(id, 'force_toy', { toyKey: toyKey.value, intensity: Number(toyIntensity.value) || 0, mode: toyMode.value || undefined, curve: toyCurve.value || undefined }),
    { success: '已命令她戴上，她取不下来' }
  )
  // 戴上是真落库了：把清单/已戴状态一起刷回来（角标、背包面板都跟着变）
  if (ok) await loadToys()
}

async function onWakeFull() {
  await run('wake', id => wakeCharacter(id, 'full'), { success: '已完全唤醒' })
}

async function onWakeMind() {
  const ok = await run('wakeMind', id => wakeCharacter(id, 'mind'), { success: '已只唤醒意志' })
  // 只有成功后才写说明文案；失败时 notice 应保留错误信息
  if (ok) notice.value = WAKE_MIND_NOTICE
}

async function onForcedClimax() {
  await run('forcedClimax', id => commandCharacter(id, 'forced_climax'), { success: '已计入亲密看板，这一轮会配图' })
}

async function onForget() {
  const id = props.character?.id
  if (!id || busy.value) return
  const ok = typeof confirmFn === 'function'
    ? await confirmFn({
        title: '遗忘被控制这段时间',
        message: forgetConfirmMessage(displayName.value),
        okText: '归档并遗忘',
        danger: true,
      })
    : true
  if (!ok) return
  busy.value = 'forget'
  try {
    const res = await forgetControlledWindow(id)
    const archived = Number(res?.archived) || 0
    notice.value = archived > 0 ? `已归档 ${archived} 条记忆，可在下面撤销。` : '这段时间没有可归档的记忆。'
    notify('已遗忘被控制这段时间', 'success')
    await Promise.all([refreshState(), refreshForgotten()])
  } catch (err) {
    const message = err?.message || '遗忘失败'
    notice.value = message
    notify(message, 'error')
  } finally {
    busy.value = ''
  }
}

async function onRestore(row) {
  const id = props.character?.id
  if (!id || busy.value || !row.canRestore) return
  busy.value = `restore-${row.id}`
  try {
    const res = await restoreForgottenWindow(id, row.id)
    // 文案区分「还原了 N 条」与「没有抽取到长期记忆但屏蔽已解除」，否则用户会以为按钮没生效
    notice.value = restoreResultText(res)
    notify(RESTORE_TOAST_TEXT, 'success')
    await refreshForgotten()
  } catch (err) {
    const message = err?.message || '恢复失败'
    notice.value = message
    notify(message, 'error')
  } finally {
    busy.value = ''
  }
}

async function onGrantPhone() {
  if (busy.value) return
  busy.value = 'grant'
  try {
    await grantHypnosisPhone()
    notify('已领取催眠手机', 'success')
    await Promise.all([refreshState(), refreshForgotten()])
  } catch (err) {
    const message = err?.message || '领取失败'
    notice.value = message
    notify(message, 'error')
  } finally {
    busy.value = ''
  }
}

// ── 睡眠控制（独立于催眠指令） ──
/** 睡觉 / 唤醒：返回形状与催眠状态无关，直接用它刷新睡眠区（并顺手刷新催眠状态，两边互不影响） */
async function onSleepAction(key) {
  const id = props.character?.id
  if (!id || busy.value || !sleepMatrix.value[key]) return
  busy.value = key
  try {
    const result = key === 'sleep' ? await sleepCharacter(id) : await wakeFromSleepCharacter(id)
    refreshSleepFrom([result])
    notice.value = ''
    notify(SLEEP_TOAST[key] || '已更新睡眠状态', 'success')
    await refreshState({ silent: true })
  } catch (err) {
    const message = err?.message || '操作失败'
    notice.value = message
    notify(message, 'error')
  } finally {
    busy.value = ''
  }
}

/** 五个按钮统一分发（模板里只写一个 @click） */
function onAction(key) {
  if (!matrix.value[key] || busy.value) return
  if (key === 'hypnotize') return onHypnotize()
  if (key === 'wake') return onWakeFull()
  if (key === 'wakeMind') return onWakeMind()
  if (key === 'forcedClimax') return onForcedClimax()
  if (key === 'forget') return onForget()
  return undefined
}

watch(() => props.character?.id, (id, old) => {
  if (!id || id === old) return
  state.value = null
  forgotten.value = []
  notice.value = ''
  minutes.value = DEFAULT_MINUTES
  // 睡眠状态先用角色行上已有的字段垫上（characters 列表本来就带 is_sleeping / sleep_until），
  // 之后的 POST 返回或 GET /hypnosis 会把它刷新成权威值。
  sleepRaw.value = resolveSleep(props.character)
  refreshAll()
}, { immediate: true })

onMounted(() => {
  startTicking()
  startPolling()
})

watch(() => view.value.active, (active) => {
  // 状态清空后不再向后端轮询；本地走秒保留（代价极小，状态回切时也更平顺）
  if (active) startPolling()
  else stopPolling()
})

onUnmounted(() => {
  stopTimers()
})
</script>

<style scoped>
/* 色值一律走 tokens.css，暖色 / 暗夜两套主题自动联动；不出现硬编码色值。 */
.hp {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  color: var(--text-primary);
}

/* ── 骨架 ── */
.hp-skeleton { display: flex; flex-direction: column; gap: 12px; }
.hp-sk-row { height: 54px; border-radius: var(--radius-md); }
.skeleton {
  background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-hover) 37%, var(--bg-tertiary) 63%);
  background-size: 400% 100%;
  animation: hp-shimmer 1.4s ease infinite;
}
@keyframes hp-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

.hp-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
  background: var(--bg-tertiary);
  color: var(--danger);
  font-size: var(--fs-sm);
}

/* ── ① 状态条 ── */
.hp-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  transition: background-color 0.3s var(--ease-standard), border-color 0.3s var(--ease-standard);
}
.hp-status-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.hp-status-name { font-size: var(--fs-md); font-weight: 700; }
.hp-badge {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  transition: background-color 0.3s var(--ease-standard), color 0.3s var(--ease-standard);
}
.hp-badge.is-active { background: color-mix(in srgb, var(--fun-violet) 20%, transparent); color: var(--fun-violet); }
.hp-badge.is-expired { background: color-mix(in srgb, var(--warning) 22%, transparent); color: var(--warning); }

.hp-marks { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hp-mark {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  background: var(--bg-sunken);
  transition: border-color 0.3s var(--ease-standard), color 0.3s var(--ease-standard);
}
.hp-mark.is-on { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--accent); }
.hp-mark-label { opacity: 0.8; }
.hp-mark-value { font-weight: 700; }

/* ── ② 门控 ── */
.hp-gate {
  margin: 0;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  font-size: var(--fs-sm);
}
.hp-grant { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hp-grant-tip { font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── 区块 ── */
.hp-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.hp-sec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.hp-sec-title { margin: 0; font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.3px; }
.hp-sec-hint { font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── ②.5 睡眠控制（与催眠区同皮肤，但用状态色把它和"指令"区分开） ── */
.hp-sec-sleep { border-style: dashed; }

/* ── 发情模式（2026-10-02）：唯一一处"她会变烫"的区块，用主题内的桃粉描边 + 极淡底色区分，
      与「高潮控制」「命令她用玩具」同皮肤同间距，不引入新视觉体系。开着时右侧开关自带状态色。 ── */
.hp-sec-heat {
  border-color: color-mix(in srgb, var(--accent-4) 45%, var(--border));
  background: color-mix(in srgb, var(--accent-4) 7%, var(--bg-secondary));
}
.hp-sec-heat .hp-sec-title { color: var(--accent-4); }
.hp-sleep-status { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hp-sleep-badge {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  transition: background-color 0.3s var(--ease-standard), color 0.3s var(--ease-standard);
}
.hp-sleep-badge.is-sleeping { background: color-mix(in srgb, var(--fun-blue) 20%, transparent); color: var(--fun-blue); }
.hp-sleep-badge.is-awake { background: color-mix(in srgb, var(--warning) 20%, transparent); color: var(--warning); }
.hp-sleep-note { font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── ③ 时长 ── */
.hp-duration { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hp-duration-input { width: 110px; }
.hp-duration-unit { font-size: var(--fs-sm); color: var(--text-secondary); }
.hp-duration-range { font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── ④ 操作 ── */
.hp-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.hp-notice {
  margin: 0;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: var(--fs-sm);
}
.hp-note { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── ⑤ 命令她用玩具 ── */
.hp-toy-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hp-toy-select { min-width: 120px; }
.hp-toy-intensity { min-width: 130px; }

/* ── ⑤ 遗忘记录 ── */
.hp-forgotten { display: flex; flex-direction: column; gap: 6px; }
.hp-forgotten-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  flex-wrap: wrap;
}
.hp-forgotten-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.hp-forgotten-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.hp-forgotten-tip { font-size: var(--fs-xs); color: var(--text-secondary); }
.hp-forgotten-time { font-size: var(--fs-base); font-weight: 600; }
.hp-forgotten-archived { font-size: var(--fs-xs); color: var(--text-secondary); }
.hp-tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.hp-tag.is-active { background: color-mix(in srgb, var(--fun-violet) 18%, transparent); color: var(--fun-violet); }
.hp-empty { margin: 0; padding: 10px 0; font-size: var(--fs-sm); color: var(--text-secondary); text-align: center; }

/* 状态切换 0.3s 过渡 */
.hp-fade-enter-active, .hp-fade-leave-active { transition: opacity 0.3s var(--ease-standard); }
.hp-fade-enter-from, .hp-fade-leave-to { opacity: 0; }

/* ── 移动端：单列不溢出 ── */
@media (max-width: 767px) {
  .hp-status { align-items: flex-start; flex-direction: column; }
  .hp-duration-input { width: 100%; }
  .hp-actions { flex-direction: column; align-items: stretch; }
  .hp-forgotten-row { flex-direction: column; align-items: stretch; }
  .hp-forgotten-actions { flex-direction: column; align-items: stretch; }
}

@media (prefers-reduced-motion: reduce) {
  .hp-fade-enter-active, .hp-fade-leave-active { transition: none; }
  .skeleton { animation: none; }
}
</style>
