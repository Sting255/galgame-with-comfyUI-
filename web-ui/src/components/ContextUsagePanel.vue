<template>
  <!--
    全局左上角上下文用量浮层（App.vue 挂载，切页面不消失）。
    位置在 .page-host 内（position: absolute），所以固定在「内容区左上角」——
    侧栏（NavBar 75px + Sidebar 300px）的可点区域完全不被遮挡。
  -->
  <div class="ctx-usage" :class="[`is-${levelClass}`, { 'is-open': open, 'is-idle': !conversationId }]">
    <!-- 收起态：环形进度 + 百分比胶囊 -->
    <div
      class="ctx-usage__pill"
      role="button"
      tabindex="0"
      :aria-expanded="open"
      aria-label="上下文用量面板"
      :title="pillTitle"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <svg class="ctx-usage__ring" viewBox="0 0 28 28" aria-hidden="true">
        <circle class="ctx-usage__ring-track" cx="14" cy="14" :r="RING_R" />
        <circle
          class="ctx-usage__ring-fill"
          cx="14"
          cy="14"
          :r="RING_R"
          :stroke-dasharray="RING_CIRCUMFERENCE"
          :stroke-dashoffset="RING_CIRCUMFERENCE * (1 - ringRatioValue)"
        />
      </svg>
      <span class="ctx-usage__pill-pct">{{ percentLabel }}</span>
      <span class="ctx-usage__pill-caret" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </span>
    </div>

    <!-- 展开态：卡片 -->
    <Transition name="ctx-usage-pop">
      <div v-if="open" class="ctx-usage__card" role="dialog" aria-label="上下文用量详情">
        <div class="ctx-usage__head">
          <span class="ctx-usage__head-label">上下文已用</span>
          <strong class="ctx-usage__head-pct">{{ percentLabel }}</strong>
          <span class="ctx-usage__head-nums">{{ usedLabel }} / {{ windowLabel }}</span>
        </div>

        <div class="ctx-usage__bar" role="progressbar" :aria-valuenow="barWidth" aria-valuemin="0" aria-valuemax="100" :aria-label="`上下文已用 ${percentLabel}`">
          <span class="ctx-usage__bar-fill" :style="{ width: barWidth + '%' }"></span>
        </div>

        <!-- 更新时间：null / 非法值时不渲染这一行（宁可没有，也不写「刚刚」） -->
        <p v-if="updatedAtLabel" class="ctx-usage__updated">{{ updatedAtLabel }}</p>

        <!-- 稳定前缀指纹 vs 上一轮（审查 §2.3）：判断这轮前缀缓存为什么可能没命中。无指纹 / 首轮不显示结论 -->
        <p
          v-if="fingerprint.text"
          class="ctx-usage__fingerprint"
          :class="'is-' + fingerprint.state"
          :title="fingerprint.detail ? '依据：' + fingerprint.detail : ''"
        >
          <span class="ctx-usage__fingerprint-label">前缀指纹</span>
          <span class="ctx-usage__fingerprint-text">{{ fingerprint.text }}</span>
        </p>

        <div v-if="breakdown.length" class="ctx-usage__breakdown">
          <div class="ctx-usage__list-head">
            <span class="ctx-usage__list-title">分项明细</span>
            <span class="ctx-usage__list-tag" :class="{ 'is-calibrated': breakdownCalibrated }">{{ breakdownTag }}</span>
          </div>
          <p v-if="breakdownNote" class="ctx-usage__list-note">{{ breakdownNote }}</p>
          <ul class="ctx-usage__list">
            <li
              v-for="item in breakdown"
              :key="item.key"
              class="ctx-usage__item"
              :title="item.calibrated ? `按真实总量标定；估算值 ${item.estimateLabel}` : '估算值'"
            >
              <span class="ctx-usage__item-label">{{ item.label }}</span>
              <span class="ctx-usage__item-tokens">~{{ item.tokensLabel }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="ctx-usage__empty">{{ emptyBreakdownText }}</p>

        <div class="ctx-usage__foot">
          <span class="ctx-usage__meta">{{ metaText }}</span>
          <linshe-button
            class="ctx-usage__compress"
            variant="secondary"
            size="sm"
            :loading="compressing"
            :disabled="!canCompress"
            @click="onCompress"
          >
            {{ compressing ? '压缩中…' : '压缩上下文' }}
          </linshe-button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { compressContext, getContextUsage } from '../api/index.js'
import { onEvent } from '../stores/unifiedStream.js'
import { useChatStore } from '../stores/chat.js'
import { useGroupsStore } from '../stores/groups.js'
import {
  UsageRefreshGovernor,
  isAssistantMessage,
  isCompressConflict,
  normalizeUsage,
  resolveConversationId,
  ringRatio,
  prefixFingerprintVerdict,
} from '../utils/contextUsage.js'
import LinsheButton from './ui/LinsheButton.vue'

// 兜底轮询周期：事件触发之外的保底刷新（收到 AI 回复、切会话都会即时刷新）
const POLL_INTERVAL_MS = 10_000
// 同一会话两次真实请求的最小间隔，避免连续事件把接口打爆
const MIN_FETCH_INTERVAL_MS = 2_000

const RING_R = 10.5
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R

const chat = useChatStore()
const groups = useGroupsStore()
const route = useRoute()
const toast = inject('toast', null)

const open = ref(false)
const compressing = ref(false)
const usage = ref(normalizeUsage(null))
const failure = ref(false)

const governor = new UsageRefreshGovernor({ minIntervalMs: MIN_FETCH_INTERVAL_MS })

/** 当前生效会话：私聊 char_<角色id>、群聊 group_<群id>；非聊天页为空（浮层显示 —） */
const conversationId = computed(() => resolveConversationId({
  path: route.path,
  activeCharId: chat.activeCharId,
  activeGroupId: groups.activeGroupId,
}))

const percentLabel = computed(() => (conversationId.value ? usage.value.percentLabel : '—'))
const usedLabel = computed(() => (conversationId.value ? usage.value.usedLabel : '—'))
const windowLabel = computed(() => (conversationId.value ? usage.value.windowLabel : '—'))
const barWidth = computed(() => (conversationId.value ? usage.value.barWidth : 0))
const breakdown = computed(() => (conversationId.value ? usage.value.breakdown : []))
const breakdownCalibrated = computed(() => Boolean(conversationId.value) && usage.value.breakdownCalibrated)
const breakdownTag = computed(() => usage.value.breakdownTag)
const breakdownNote = computed(() => usage.value.breakdownNote)
/** 「更新于 09:26」；后端给 null 时为空串，模板不渲染这一行 */
const updatedAtLabel = computed(() => (conversationId.value ? usage.value.updatedAtLabel : ''))
const ringRatioValue = computed(() => (conversationId.value ? ringRatio(usage.value.percent) : 0))
const canCompress = computed(() => Boolean(conversationId.value) && !compressing.value)

const levelClass = computed(() => (conversationId.value ? usage.value.level : 'normal'))

const emptyBreakdownText = computed(() => {
  if (!conversationId.value) return '还没有进行中的会话'
  if (!usage.value.hasData) return '暂无用量数据'
  return '暂无分项明细'
})

const metaText = computed(() => {
  if (!conversationId.value) return '选择一个角色或群聊后可用'
  if (!usage.value.hasData) return '暂无数据'
  const parts = []
  if (failure.value) parts.push('刷新失败，显示上次结果')
  if (!usage.value.windowKnown) parts.push('窗口未知')
  if (usage.value.model) parts.push(usage.value.model)
  // 窗口来源三种口径（declared / provider / default）各自的人话在 utils 里统一给
  if (usage.value.windowSourceText) parts.push(usage.value.windowSourceText)
  if (usage.value.sourceLabel) parts.push(usage.value.sourceLabel)
  return parts.join(' · ') || '—'
})

const pillTitle = computed(() => {
  if (!conversationId.value) return '上下文用量：当前没有进行中的会话'
  if (!usage.value.hasData) return `上下文用量：暂无数据（${conversationId.value}）`
  return `上下文已用 ${percentLabel.value} · ${usedLabel.value} / ${windowLabel.value}`
})

function toggle() {
  open.value = !open.value
}

/**
 * 「上一轮」的用量快照（审查 §2.3）：**只放内存**、按会话隔离。
 * 刷新页面丢缓存属正常（那时显示首轮），**绝不做持久化** —— 否则跨刷新会误报「稳定前缀变化」。
 */
const prevUsageByConversation = new Map()
/** 与上一轮同会话的指纹结论（纯函数算，组件只存上一轮快照） */
const fingerprint = ref(prefixFingerprintVerdict(null, null))

async function refreshNow() {
  const id = conversationId.value
  if (!id) {
    usage.value = normalizeUsage(null)
    fingerprint.value = prefixFingerprintVerdict(null, null)
    failure.value = false
    return null
  }
  return governor.run(id, async () => {
    try {
      const data = await getContextUsage(id)
      // 请求返回时可能已经切了会话，丢弃过期结果
      if (id !== conversationId.value) return null
      const normalized = normalizeUsage(data)
      // 先与「上一轮同会话」比，**再**覆盖缓存 —— 顺序反了就成了自己跟自己比
      fingerprint.value = prefixFingerprintVerdict(prevUsageByConversation.get(id) || null, normalized)
      prevUsageByConversation.set(id, normalized)
      usage.value = normalized
      failure.value = false
    } catch (err) {
      if (id !== conversationId.value) return null
      // 接口还没上好时不要把界面清空，保留上一次结果并标注
      failure.value = true
      console.warn('[context-usage] 刷新失败:', err?.message || err)
    }
    return null
  })
}

async function onCompress() {
  const id = conversationId.value
  if (!id || compressing.value) return
  compressing.value = true
  try {
    const result = await compressContext(id)
    toast?.(result?.message || '上下文已压缩', 'success')
    await refreshNow()
  } catch (err) {
    if (isCompressConflict(err)) toast?.('正在压缩中，请稍候', 'warning')
    else toast?.(`压缩失败：${err?.message || '未知错误'}`, 'error')
  } finally {
    compressing.value = false
  }
}

// ── 刷新触发：切会话立即刷新；AI 回复完成后刷新；10s 兜底轮询 ──
watch(conversationId, () => { refreshNow() })

// 私聊：流式回复结束（sendMessage 完成）后刷新一次上下文用量
watch(() => chat.streaming, (now, was) => { if (!now && was) refreshNow() })
// 群聊：一轮发言播放结束
watch(() => groups.playing, (now, was) => { if (!now && was) refreshNow() })

let offProactive = null
let offGroupMessage = null
let pollTimer = null

onMounted(() => {
  refreshNow()
  // 主动聊天 / 延迟回复的私聊 AI 消息
  offProactive = onEvent('proactive_message', () => refreshNow())
  // 群聊 AI 发言（跳过「我」的消息）
  offGroupMessage = onEvent('group_message', (data) => { if (isAssistantMessage(data)) refreshNow() })
  pollTimer = window.setInterval(() => refreshNow(), POLL_INTERVAL_MS)
})

onUnmounted(() => {
  offProactive?.()
  offGroupMessage?.()
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<style scoped>
/* ── 定位：内容区左上角，不压侧栏 ──
   纵向起点由 .page-host 上的 --ctx-usage-top 给出（App.vue），让开各页面自己的标题栏；
   横向 12px 落在内容区内部，天然避开 NavBar(75px) / Sidebar(300px) 的可点区域。 */
.ctx-usage {
  position: absolute;
  top: var(--ctx-usage-top, 60px);
  left: 12px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  user-select: none;
}

/* ── 收起态胶囊 ── */
.ctx-usage__pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 9px 0 5px;
  border-radius: var(--radius-full);
  background: var(--glass-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--text-primary);
  cursor: pointer;
  transition:
    background-color var(--dur-base) var(--ease-standard),
    border-color var(--dur-base) var(--ease-standard),
    box-shadow var(--dur-base) var(--ease-standard),
    transform var(--dur-fast) var(--ease-standard);
}
.ctx-usage__pill:hover {
  background: var(--glass-bg-hover);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}
.ctx-usage__pill:active { transform: translateY(1px); }
.ctx-usage__pill:focus-visible { outline: 3px solid rgba(var(--accent-rgb), 0.3); outline-offset: 2px; }

.ctx-usage__ring { width: 20px; height: 20px; flex-shrink: 0; }
.ctx-usage__ring-track,
.ctx-usage__ring-fill {
  fill: none;
  stroke-width: 3;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
}
.ctx-usage__ring-track { stroke: rgba(var(--accent-rgb), 0.16); }
.ctx-usage__ring-fill {
  stroke: var(--accent);
  stroke-linecap: round;
  transition: stroke-dashoffset 0.3s var(--ease-standard), stroke var(--dur-base) var(--ease-standard);
}

.ctx-usage__pill-pct {
  font-size: var(--fs-sm);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  min-width: 24px;
  text-align: right;
}
.ctx-usage__pill-caret {
  display: inline-flex;
  color: var(--text-secondary);
  transition: transform 0.3s var(--ease-standard);
}
.ctx-usage.is-open .ctx-usage__pill-caret { transform: rotate(180deg); }

/* 占用分档：低=主色、中=警示、高=危险（阈值见 utils/contextUsage.js）
   SVG 圆弧只能改 stroke，HTML 进度条只能改 background，分开写避免互相污染。 */
.ctx-usage.is-warn .ctx-usage__ring-fill { stroke: var(--warning); }
.ctx-usage.is-warn .ctx-usage__bar-fill { background: var(--warning); }
.ctx-usage.is-warn .ctx-usage__head-pct,
.ctx-usage.is-warn .ctx-usage__pill-pct { color: var(--warning); }
.ctx-usage.is-danger .ctx-usage__ring-fill { stroke: var(--danger); }
.ctx-usage.is-danger .ctx-usage__bar-fill { background: var(--danger); }
.ctx-usage.is-danger .ctx-usage__head-pct,
.ctx-usage.is-danger .ctx-usage__pill-pct { color: var(--danger); }

/* 没有进行中的会话：整体降权 */
.ctx-usage.is-idle .ctx-usage__pill-pct { color: var(--text-secondary); }
.ctx-usage.is-idle .ctx-usage__ring-fill { stroke: var(--text-secondary); }

/* ── 展开卡片 ── */
.ctx-usage__card {
  width: 250px;
  padding: 11px 12px 10px;
  border-radius: var(--radius-lg);
  background: var(--popover-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.ctx-usage__head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 9px;
}
.ctx-usage__head-label { font-size: var(--fs-sm); color: var(--text-secondary); }
.ctx-usage__head-pct {
  font-size: var(--fs-lg);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
}
.ctx-usage__head-nums {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.ctx-usage__bar {
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--bg-sunken);
  overflow: hidden;
}
.ctx-usage__bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--accent);
  transition: width 0.3s var(--ease-standard), background-color var(--dur-base) var(--ease-standard);
}

/* 更新时间：右对齐的一行小字，null 时不渲染 */
.ctx-usage__updated {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ctx-usage__list-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.ctx-usage__list-title {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
/* 标定状态标签：已标定用主色，估算用弱化底色，两套主题都靠 token 自适应 */
.ctx-usage__list-tag {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--bg-sunken);
  color: var(--text-secondary);
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.ctx-usage__list-tag.is-calibrated {
  background: rgba(var(--accent-rgb), 0.14);
  color: var(--accent);
}
.ctx-usage__list-note {
  margin: 5px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.ctx-usage__list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 168px;
  overflow-y: auto;
}
.ctx-usage__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
}
.ctx-usage__item-label {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-usage__item-tokens {
  margin-left: auto;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  flex-shrink: 0;
}
.ctx-usage__empty {
  margin: 10px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}

.ctx-usage__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
}
.ctx-usage__meta {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-usage__compress { flex-shrink: 0; }

/* ── 展开 / 收起：0.3s 淡入淡出 + 轻微位移 ── */
.ctx-usage-pop-enter-active { transition: opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out); }
.ctx-usage-pop-leave-active { transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.ctx-usage-pop-enter-from,
.ctx-usage-pop-leave-to { opacity: 0; transform: translateY(-6px) scale(0.97); }

/* ── 窄屏：缩小胶囊、卡片贴住可用宽度（纵向起点仍由 --ctx-usage-top 决定） ── */
@media (max-width: 767px) {
  .ctx-usage { left: 8px; }
  .ctx-usage__pill { height: 26px; padding: 0 8px 0 4px; }
  .ctx-usage__pill-pct { font-size: var(--fs-xs); min-width: 22px; }
  .ctx-usage__card {
    width: min(250px, calc(100vw - 32px));
    max-height: calc(100dvh - 90px);
    overflow-y: auto;
  }
  .ctx-usage__list { max-height: 130px; }
}
/* 前缀指纹那一行（审查 §2.3）：与 .ctx-usage__updated 同级的小字，颜色走 token（双主题） */
.ctx-usage__fingerprint {
  display: flex; align-items: baseline; gap: 6px;
  margin: 4px 0 0;
  font-size: 11px; line-height: 1.5;
  color: var(--text-secondary);
}
.ctx-usage__fingerprint-label { flex-shrink: 0; opacity: 0.8; }
.ctx-usage__fingerprint.is-stable-changed .ctx-usage__fingerprint-text { color: var(--accent); font-weight: 500; }
.ctx-usage__fingerprint.is-tail-only .ctx-usage__fingerprint-text { color: var(--accent); opacity: 0.85; }
.ctx-usage__fingerprint.is-same .ctx-usage__fingerprint-text { opacity: 0.8; }
</style>
