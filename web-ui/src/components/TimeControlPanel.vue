<template>
  <!-- 程序时间（"现实模拟"时钟）：世界钟一眼看清 + 「角色此刻看到的时间」预览 + 快速调时 + 翻篇反馈。
       只负责画与交互：格式化 / 判定 / 文案口径在 components/timeControlLogic.js，
       读写在 api/timeControl.js（旧路径）与 api/index.js 的 getTimePerception()（只读感知）。

       纪律：**前端不自己算时间偏移**（偏移只存在后端 program_time_state），
       所有时刻 / 时段 / 光线 / 时间标签都来自接口。 -->
  <div class="tc">
    <div v-if="initialLoading" class="tc-skeleton" aria-hidden="true">
      <div class="skeleton tc-sk-row"></div>
      <div class="skeleton tc-sk-row"></div>
    </div>

    <template v-else>
      <p v-if="loadError" class="tc-banner">
        {{ loadError }}
        <linshe-button variant="link" size="sm" @click="refresh">重试</linshe-button>
      </p>

      <!-- ── ① 世界钟：日期（周几 / 第几天）+ 时刻 + 时段 + 与真实时间的差 ── -->
      <div class="tc-now" role="status" aria-live="polite">
        <div class="tc-now-main">
          <span class="tc-now-label">程序时间</span>
          <span class="tc-now-date">{{ time.dateText }}</span>
          <span v-if="time.weekday" class="tc-now-weekday">{{ time.weekday }}</span>
          <span class="tc-now-clock">{{ time.clockText }}</span>
          <span v-if="time.segmentText" class="tc-seg">{{ time.segmentText }}</span>
          <span class="tc-period" :class="time.period === 'night' ? 'is-night' : 'is-day'">
            {{ time.periodText || '时段未知' }}
          </span>
          <span class="tc-now-days">{{ time.dayText }}</span>
          <linshe-button variant="link" size="sm" :disabled="!!busy" @click="refreshAll()">刷新</linshe-button>
        </div>
        <!-- 如实说明"程序钟与现实钟差多少"，避免用户以为改了真实时间 -->
        <div v-if="time.offsetText || time.realText" class="tc-now-sub">
          <span v-if="time.offsetText">{{ time.offsetText }}</span>
          <span v-if="time.realText">现实世界现在 {{ time.realText }}</span>
        </div>
      </div>

      <!-- ── ② 角色此刻看到的时间（与注入 prompt 的字符串同源）── -->
      <div class="tc-sec tc-perception">
        <div class="tc-sec-head">
          <span class="tc-sec-title">角色此刻看到的时间</span>
          <span class="tc-sec-hint">与注入她们提示词的字符串同源（后端逐字给出，前端不重拼）</span>
          <linshe-button variant="ghost" size="sm" :disabled="perceptionLoading" @click="refreshPerception">
            刷新
          </linshe-button>
        </div>

        <linshe-tabs v-model="perceptionTab" :options="PERCEPTION_TABS" size="sm" />

        <Transition name="tc-swap" mode="out-in">
          <div v-if="perceptionTab === 'tag'" key="tag" class="tc-perception-body">
            <p v-if="perceptionError" class="tc-perception-empty">{{ perceptionError }}</p>
            <template v-else>
              <p class="tc-tag">{{ perception.timeTag || '（还没读到时间标签）' }}</p>
              <p class="tc-perception-line">
                <span v-if="perception.castLine">{{ perception.castLine }}</span>
                <span v-else class="tc-muted">季节 / 时段 / 天气暂时读不到</span>
              </p>
              <p v-if="perception.lightText" class="tc-perception-line tc-muted">
                光线：{{ perception.lightText }}
              </p>
            </template>
          </div>

          <div v-else key="cast" class="tc-perception-body">
            <p v-if="perceptionError" class="tc-perception-empty">{{ perceptionError }}</p>
            <template v-else>
              <p class="tc-perception-line tc-muted">{{ perception.countText }}</p>
              <ul v-if="perception.characters.length" class="tc-cast">
                <li v-for="c in perception.characters" :key="c.id == null ? c.name : c.id" class="tc-cast-row">
                  <span class="tc-cast-name">{{ c.name }}</span>
                  <span class="tc-cast-state" :class="c.awake ? 'is-awake' : 'is-asleep'">
                    {{ c.awake ? '醒着' : '在睡' }}
                  </span>
                  <span class="tc-cast-summary">{{ c.summary }}</span>
                  <span v-if="c.light" class="tc-cast-light">{{ c.light }}</span>
                </li>
              </ul>
              <p v-else class="tc-perception-empty">还没有角色能被时间照到</p>
            </template>
          </div>
        </Transition>
      </div>

      <!-- ── ③ 翻篇反馈（调时后立刻给，SSE program_day_rollover 到达后更新）── -->
      <Transition name="tc-fade">
        <p v-if="rollover.text" class="tc-rollover" :class="`is-${rollover.phase}`" role="status">
          <span class="tc-rollover-dot" aria-hidden="true"></span>
          {{ rollover.text }}
        </p>
      </Transition>

      <!-- ── ④ 快速调时 ── -->
      <div class="tc-sec">
        <div class="tc-sec-head">
          <span class="tc-sec-title">让世界往前走</span>
          <span class="tc-sec-hint">所有角色会一起过完这些天，日程与睡眠当场重算</span>
        </div>
        <div class="tc-row">
          <linshe-button
            v-for="days in QUICK_ADVANCE_DAYS"
            :key="days"
            :variant="days === QUICK_ADVANCE_DAYS[0] ? 'primary' : 'secondary'"
            size="sm"
            :loading="busy === `advance-${days}`"
            :disabled="!!busy"
            @click="onAdvance(days)"
          >
            推进 {{ days }} 天
          </linshe-button>
          <linshe-input
            v-model="advanceDays"
            type="number"
            size="sm"
            class="tc-days-input"
            :min="DAY_ADVANCE_MIN"
            :max="DAY_ADVANCE_MAX"
            aria-label="快进天数"
            @blur="normalizeAdvanceDays"
            @keyup.enter="onAdvance(clampAdvanceDays(advanceDays), 'advance-n')"
          />
          <span class="tc-unit">天</span>
          <linshe-button
            variant="secondary"
            size="sm"
            :loading="busy === 'advance-n'"
            :disabled="!!busy"
            @click="onAdvance(clampAdvanceDays(advanceDays), 'advance-n')"
          >
            推进这么多天
          </linshe-button>
          <span class="tc-range">可填 {{ DAY_ADVANCE_MIN }} ~ {{ DAY_ADVANCE_MAX }} 天（超出会被夹住）</span>
        </div>

        <div class="tc-row">
          <linshe-button
            variant="secondary"
            size="sm"
            :disabled="!!busy || time.period === 'day'"
            :loading="busy === 'period-day'"
            @click="onPeriod('day')"
          >
            跳到白天
          </linshe-button>
          <linshe-button
            variant="secondary"
            size="sm"
            :disabled="!!busy || time.period === 'night'"
            :loading="busy === 'period-night'"
            @click="onPeriod('night')"
          >
            跳到黑夜
          </linshe-button>
          <linshe-button variant="ghost" size="sm" :disabled="!!busy" @click="openSetDialog">
            精确设置日期时间
          </linshe-button>
          <linshe-button
            variant="ghost"
            size="sm"
            :loading="busy === 'reset'"
            :disabled="!!busy"
            @click="onReset"
          >
            回到真实时间
          </linshe-button>
        </div>
        <p class="tc-range">白天 = 08:00，黑夜 = 22:00；只切时段时日期与「第几天」不动。</p>
      </div>

      <!-- ── ⑤ 结果（0.3s 淡入淡出）── -->
      <Transition name="tc-fade">
        <p v-if="notice" class="tc-notice" :class="`is-${notice.type}`" role="status">{{ notice.text }}</p>
      </Transition>

      <!-- ── ⑥ 口径说明：哪些会跟着变、哪些仍按真实时间走 ── -->
      <div class="tc-scope">
        <div class="tc-scope-col">
          <span class="tc-scope-title">会跟着程序时间变</span>
          <ul class="tc-scope-list">
            <li v-for="line in TIME_SCOPE_NOTES.changes" :key="line">{{ line }}</li>
          </ul>
        </div>
        <div class="tc-scope-col">
          <span class="tc-scope-title">仍按真实时间走</span>
          <ul class="tc-scope-list">
            <li v-for="line in TIME_SCOPE_NOTES.unchanged" :key="line">{{ line }}</li>
          </ul>
        </div>
      </div>
    </template>

    <!-- 精确设置：设定是不可逆的"跳跃"，用弹窗让用户看清再确认 -->
    <linshe-modal v-model="setDialog.show" title="设定程序时间" panel-class="tc-modal">
      <p class="tc-modal-line">直接跳到指定的日期与时刻；这会影响所有角色的日程与睡眠。</p>
      <div class="tc-modal-row">
        <linshe-input v-model="setDialog.date" type="date" size="sm" aria-label="程序日期" />
        <linshe-input v-model="setDialog.time" type="time" size="sm" aria-label="程序时刻" />
      </div>
      <p v-if="setDialog.date || setDialog.time" class="tc-modal-preview">
        将设为：{{ formatProgramDate(setDialog.date) }} {{ formatProgramClock(setDialog.time) }}
      </p>
      <template #footer>
        <linshe-button variant="secondary" :disabled="!!busy" @click="setDialog.show = false">取消</linshe-button>
        <linshe-button
          variant="primary"
          :loading="busy === 'set'"
          :disabled="!!busy || !composeDatetime(setDialog.date, setDialog.time)"
          @click="onSet"
        >
          确认设定
        </linshe-button>
      </template>
    </linshe-modal>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, reactive, ref } from 'vue'

import LinsheButton from './ui/LinsheButton.vue'
import LinsheInput from './ui/LinsheInput.vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import { advanceProgramTime, getProgramTime, resetProgramTime, setProgramPeriod, setProgramTime } from '../api/timeControl.js'
import { getTimePerception } from '../api/index.js'
import { onEvent } from '../stores/unifiedStream.js'
import {
  DAY_ADVANCE_MAX,
  DAY_ADVANCE_MIN,
  QUICK_ADVANCE_DAYS,
  TIME_SCOPE_NOTES,
  clampAdvanceDays,
  composeDatetime,
  formatProgramClock,
  formatProgramDate,
  perceptionViewModel,
  programTimeViewModel,
  resetConfirmMessage,
  rolloverEventText,
  rolloverNotice,
  rolloverTimeoutText,
  splitDatetime,
  timeActionResultText,
} from './timeControlLogic.js'

/** 感知预览的两个视图（就是提示词字符串 / 逐个角色） */
const PERCEPTION_TABS = [
  { label: '她们看到的那一行', value: 'tag' },
  { label: '逐个角色', value: 'cast' },
]

/** 调时后等翻篇广播最多等多久（后端翻篇任务含 LLM 生成，十几秒起；等不到就如实说） */
const ROLLOVER_WAIT_MS = 20000
/** 世界钟刷新间隔（只为了让面板上的钟跟着走；翻篇不靠轮询，靠 SSE 广播） */
const CLOCK_POLL_MS = 30000

const toastFn = inject('toast', null)
const confirmFn = inject('confirm', null)

const initialLoading = ref(true)
const loadError = ref('')
const rawTime = ref(null)
const rawPerception = ref(null)
const perceptionLoading = ref(false)
const perceptionError = ref('')
const perceptionTab = ref(PERCEPTION_TABS[0].value)
const advanceDays = ref(DAY_ADVANCE_MIN)
const busy = ref('')
const notice = ref(null)
const rollover = ref({ phase: 'idle', text: '' })
const setDialog = reactive({ show: false, date: '', time: '' })

let offRollover = null
let clockTimer = null
let rolloverTimer = null

const time = computed(() => programTimeViewModel(rawTime.value))
const perception = computed(() => perceptionViewModel(rawPerception.value))

function notify(message, type = 'info') {
  if (typeof toastFn === 'function') toastFn(message, type)
  else console.warn('[程序时间]', message)
}

function clearRolloverTimer() {
  if (rolloverTimer) { clearTimeout(rolloverTimer); rolloverTimer = null }
}

/** 成功后统一收口：拿返回刷新世界钟 + 感知预览，并落一条结果文案（返回形状与 GET 相同） */
function applyResult(result, text) {
  if (result && typeof result === 'object' && (result.date || result.time)) rawTime.value = result
  notice.value = { type: 'success', text }
  notify(text, 'success')
  refreshPerception()
}

/** 调时/自然跨天之后：算出"程序日期变没变"，给出翻篇反馈（变了才等广播） */
function syncRollover(prevDate) {
  const info = rolloverNotice(prevDate, time.value.date)
  if (!info.text) return
  rollover.value = { phase: info.phase, text: info.text }
  clearRolloverTimer()
  if (info.changed) {
    rolloverTimer = setTimeout(() => {
      if (rollover.value.phase === 'pending') {
        rollover.value = { phase: 'timeout', text: rolloverTimeoutText() }
      }
    }, ROLLOVER_WAIT_MS)
  }
}

/** SSE：后端世界翻篇了（`{ from, to, reason }`）—— 不靠轮询，收到就更新状态并刷新预览 */
function onProgramDayRollover(data) {
  clearRolloverTimer()
  rollover.value = { phase: 'confirmed', text: rolloverEventText(data) }
  refreshQuiet()
  refreshPerception()
}

async function refresh() {
  initialLoading.value = !rawTime.value
  loadError.value = ''
  try {
    rawTime.value = await getProgramTime()
  } catch (err) {
    // 读不到只影响这一区：把后端的话（或"还没有时间接口"）如实写出来，不阻塞设置页其它配置
    loadError.value = err?.message || '读取程序时间失败'
  } finally {
    initialLoading.value = false
  }
}

/** 静默刷新世界钟（轮询用）：日期自己走过了午夜也要给翻篇反馈，不弹 toast */
async function refreshQuiet() {
  const prevDate = time.value.date
  try {
    const result = await getProgramTime()
    rawTime.value = result
    const info = rolloverNotice(prevDate, programTimeViewModel(result).date)
    if (info.changed && rollover.value.phase === 'idle') syncRollover(prevDate)
  } catch { /* 静默刷新失败不改动界面：下一轮再来 */ }
}

/** 感知预览只读接口（取不到不阻塞其它区，单独给一行说明） */
async function refreshPerception() {
  perceptionLoading.value = true
  perceptionError.value = ''
  try {
    rawPerception.value = await getTimePerception()
  } catch (err) {
    perceptionError.value = err?.message || '读取角色感知失败'
  } finally {
    perceptionLoading.value = false
  }
}

function refreshAll() {
  return Promise.all([refresh(), refreshPerception()])
}

/** 四个写操作共用：加锁 → 请求 → 刷新 → 翻篇反馈 → 提示；失败时把后端的话原样给用户 */
async function run(key, fn, textOf) {
  if (busy.value) return
  const prevDate = time.value.date
  busy.value = key
  notice.value = null
  try {
    const result = await fn()
    applyResult(result, textOf(result))
    syncRollover(prevDate)
  } catch (err) {
    const message = err?.message || '操作失败'
    notice.value = { type: 'error', text: message }
    notify(message, 'error')
  } finally {
    busy.value = ''
  }
}

/** 输入框失焦时把天数归一（空/非法回落 1，超界夹到 1~3650） */
function normalizeAdvanceDays() {
  advanceDays.value = clampAdvanceDays(advanceDays.value)
}

async function onAdvance(days, key = `advance-${days}`) {
  const value = clampAdvanceDays(days)
  advanceDays.value = value
  await run(key, () => advanceProgramTime(value), result => timeActionResultText('advance', result, { days: value }))
}

function onPeriod(period) {
  return run(`period-${period}`, () => setProgramPeriod(period), result => timeActionResultText('period', result, { period }))
}

/** 回到真实时间：会重锚「第 1 天」，走二次确认（与遗忘那类不可逆操作同口径） */
async function onReset() {
  if (busy.value) return
  const ok = typeof confirmFn === 'function'
    ? await confirmFn({ title: '回到真实时间', message: resetConfirmMessage(), okText: '对齐真实时间' })
    : true
  if (!ok) return
  await run('reset', () => resetProgramTime(), result => timeActionResultText('reset', result))
}

function openSetDialog() {
  const initial = splitDatetime(rawTime.value)
  setDialog.date = initial.date
  setDialog.time = initial.time
  setDialog.show = true
}

async function onSet() {
  const datetime = composeDatetime(setDialog.date, setDialog.time)
  if (!datetime) return
  await run('set', () => setProgramTime(datetime), result => timeActionResultText('set', result))
  // 失败时保持弹窗打开，让用户改完再试
  if (!notice.value || notice.value.type === 'success') setDialog.show = false
}

onMounted(() => {
  refreshAll()
  offRollover = onEvent('program_day_rollover', onProgramDayRollover)
  clockTimer = setInterval(refreshQuiet, CLOCK_POLL_MS)
})

onUnmounted(() => {
  if (offRollover) { offRollover(); offRollover = null }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
  clearRolloverTimer()
})
</script>

<style scoped>
/* 色值一律走 tokens.css，暖色 / 暗夜两套主题自动联动；不出现硬编码色值。 */
.tc {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  color: var(--text-primary);
}

/* ── 骨架 ── */
.tc-skeleton { display: flex; flex-direction: column; gap: 12px; }
.tc-sk-row { height: 52px; border-radius: var(--radius-md); }
.skeleton {
  background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-hover) 37%, var(--bg-tertiary) 63%);
  background-size: 400% 100%;
  animation: tc-shimmer 1.4s ease infinite;
}
@keyframes tc-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

.tc-banner {
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

/* ── ① 世界钟 ── */
.tc-now {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  transition: background-color 0.3s var(--ease-standard), border-color 0.3s var(--ease-standard);
}
.tc-now-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 10px; }
.tc-now-sub { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-now-label { font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-now-date { font-size: var(--fs-md); font-weight: 700; }
.tc-now-weekday { font-size: var(--fs-sm); color: var(--text-secondary); }
.tc-now-clock { font-size: var(--fs-md); font-weight: 700; font-variant-numeric: tabular-nums; }
.tc-now-days { font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-period {
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  transition: background-color 0.3s var(--ease-standard), color 0.3s var(--ease-standard);
}
.tc-period.is-day { background: color-mix(in srgb, var(--fun-gold) 20%, transparent); color: var(--fun-orange); }
.tc-period.is-night { background: color-mix(in srgb, var(--fun-violet) 20%, transparent); color: var(--fun-violet); }
/* 8 段时段（凌晨…深夜）：比"白天/黑夜"细一档，跟气温一类的中性标签 */
.tc-seg {
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

/* ── 区块 ── */
.tc-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.tc-sec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.tc-sec-title { font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.3px; }
.tc-sec-hint { font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.tc-days-input { width: 110px; }
.tc-unit { font-size: var(--fs-sm); color: var(--text-secondary); }
.tc-range { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-muted { color: var(--text-secondary); }

/* ── ② 角色感知 ── */
.tc-perception-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
/* 这一行就是注入提示词的原串：等宽、可换行，别改它的内容 */
.tc-tag {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--bg-sunken);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.tc-perception-line { margin: 0; font-size: var(--fs-xs); line-height: 1.7; }
.tc-perception-empty { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.tc-cast {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.tc-cast-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  font-size: var(--fs-xs);
}
.tc-cast-name { font-weight: 700; }
.tc-cast-state { padding: 1px 8px; border-radius: var(--radius-full); background: var(--bg-tertiary); }
.tc-cast-state.is-awake { color: var(--success); }
.tc-cast-state.is-asleep { color: var(--text-secondary); }
.tc-cast-summary { color: var(--text-primary); }
.tc-cast-light { color: var(--text-secondary); }

/* ── ③ 翻篇反馈 ── */
.tc-rollover {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: var(--fs-sm);
  line-height: 1.6;
}
.tc-rollover-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--radius-full);
  background: currentColor;
}
.tc-rollover.is-pending .tc-rollover-dot { animation: tc-pulse 1.2s ease-in-out infinite; }
.tc-rollover.is-confirmed { background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success); }
.tc-rollover.is-timeout { background: color-mix(in srgb, var(--fun-orange) 16%, transparent); color: var(--fun-orange); }
.tc-rollover.is-unchanged { background: var(--bg-sunken); color: var(--text-secondary); }
@keyframes tc-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.7); }
}

/* ── ⑤ 结果 ── */
.tc-notice {
  margin: 0;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}
.tc-notice.is-error {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}
.tc-notice.is-success {
  background: color-mix(in srgb, var(--success) 14%, transparent);
  color: var(--success);
}

/* ── ⑥ 口径说明 ── */
.tc-scope {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: var(--bg-sunken);
}
.tc-scope-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tc-scope-title { font-size: var(--fs-xs); font-weight: 700; color: var(--text-bright); }
.tc-scope-list {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1.6;
}

/* ── 弹窗 ── */
.tc-modal-line { margin: 0 0 8px; font-size: var(--fs-sm); color: var(--text-primary); line-height: 1.7; }
.tc-modal-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tc-modal-preview { margin: 10px 0 0; font-size: var(--fs-xs); color: var(--text-secondary); }

/* 0.3s 淡入淡出（与全局口径一致）：结果行 / 翻篇反馈 */
.tc-fade-enter-active, .tc-fade-leave-active { transition: opacity 0.3s var(--ease-standard); }
.tc-fade-enter-from, .tc-fade-leave-to { opacity: 0; }
/* 0.3s 内容切换（感知预览两个视图之间，避免生硬跳变） */
.tc-swap-enter-active, .tc-swap-leave-active { transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.tc-swap-enter-from { opacity: 0; transform: translateY(4px); }
.tc-swap-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── 移动端：单列不溢出 ── */
@media (max-width: 767px) {
  .tc-now-main { align-items: flex-start; }
  .tc-row { align-items: stretch; }
  .tc-days-input { width: 100%; }
  .tc-scope { grid-template-columns: 1fr; }
  .tc-modal-row { flex-direction: column; align-items: stretch; }
}

@media (prefers-reduced-motion: reduce) {
  .tc-fade-enter-active, .tc-fade-leave-active,
  .tc-swap-enter-active, .tc-swap-leave-active { transition: none; }
  .skeleton { animation: none; }
  .tc-rollover.is-pending .tc-rollover-dot { animation: none; }
}
</style>
