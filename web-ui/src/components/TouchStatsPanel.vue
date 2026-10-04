<template>
  <div class="touch-stats">
    <div class="touch-stats__head">
      <span class="touch-stats__title">触摸互动</span>
      <span v-if="stats.hasData" class="touch-stats__summary">共 {{ stats.total }} 次<template v-if="stats.images > 0"> · 配图 {{ stats.images }}</template> · 最近 {{ lastSeen }}</span>
    </div>

    <div v-if="loading" class="touch-stats__hint">读取中…</div>

    <div v-else-if="!stats.hasData" class="touch-stats__empty">
      <div class="touch-stats__empty-title">还没有触摸互动记录</div>
      <div class="touch-stats__hint">在聊天页输入框上方点「动作」，摸摸她、抱抱她，这里会记下她的偏好与耐受度。</div>
    </div>

    <!-- 内层也要带 v-if：vue/require-toggle-inside-transition 要求 Transition 的直接子元素有开关 -->
    <Transition v-else name="touch-stats-fade">
      <div v-if="stats.hasData" class="touch-stats__body">
        <div class="touch-stats__levels">
          <div v-for="level in stats.levels" :key="level.level" class="touch-stats__level">
            <span class="touch-stats__level-label">{{ level.label }}</span>
            <span class="touch-stats__level-bar"><i :style="{ width: levelPercent(level) + '%' }"></i></span>
            <span class="touch-stats__level-count">{{ level.count }}</span>
          </div>
        </div>

        <div v-if="stats.daily.length" class="touch-stats__daily">
          <div class="touch-stats__daily-head">
            <span>按天次数</span>
            <span class="touch-stats__daily-sum">{{ stats.dailyTotal }} 次 / {{ stats.daily.length }} 天</span>
          </div>
          <svg
            v-if="dailyPoints"
            class="touch-stats__spark"
            :viewBox="'0 0 ' + chartWidth + ' ' + chartHeight"
            preserveAspectRatio="none"
            role="img"
            aria-label="最近每天被触摸的次数"
          >
            <polyline
              :points="dailyPoints"
              stroke-width="2"
              vector-effect="non-scaling-stroke"
            ></polyline>
          </svg>
          <div v-else class="touch-stats__hint">还不满两天，攒够两天就能看到曲线</div>
          <div v-if="dailyPoints" class="touch-stats__daily-axis" aria-hidden="true">
            <span
              v-for="tick in dailyTicks"
              :key="tick.date"
              class="touch-stats__tick"
              :style="{ left: tick.percent + '%' }"
            >{{ tick.label }}</span>
          </div>
        </div>

        <div class="touch-stats__rows">
          <div v-for="row in topRows" :key="row.key" class="touch-stats__row">
            <span class="touch-stats__row-label">{{ row.label }}</span>
            <span class="touch-stats__row-count">{{ row.count }} 次</span>
            <span class="touch-stats__row-tags">
              <span class="touch-stats__tag">{{ row.likeTier }}</span>
              <span class="touch-stats__tag is-muted">{{ row.annoyanceTier }}</span>
            </span>
          </div>
        </div>

        <div v-if="stats.peakAnnoyance > 0" class="touch-stats__hint">她的最高腻烦：{{ peakLabel }}</div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
/**
 * SLG 动作系统 · 阶段三 · 触摸互动统计小节（挂在角色详情弹窗里）
 *
 * 口径：专题 §3.3 —— 各动作次数 / 偏好 / 当前耐受度，**不暴露原始数值**，用档位文案。
 * 数据：GET /api/characters/:id/touch/stats（⚠️ task-20 时点后端尚未落地；
 * 归一化在 ./touchStatsLogic.js 里写得宽容，落地后对齐字段名即可）。
 * 拉不到 / 没记录一律按**空态**呈现，不弹错、不伪造数字。
 */
import { computed, ref, watch } from 'vue'
import { fetchTouchStats } from '../api/index.js'
import { annoyanceTierOf, buildDailyPoints, buildDailyTicks, formatLastSeen, normalizeTouchStats } from './touchStatsLogic.js'

const props = defineProps({
  character: { type: Object, default: null },
  /** 最多列出几个动作（按次数降序） */
  maxRows: { type: Number, default: 6 },
})

const stats = ref(normalizeTouchStats(null))
const loading = ref(false)

const topRows = computed(() => stats.value.rows.filter(row => row.count > 0).slice(0, props.maxRows))
const lastSeen = computed(() => formatLastSeen(stats.value.lastAt))
const peakLabel = computed(() => annoyanceTierOf(stats.value.peakAnnoyance))
const levelMax = computed(() => Math.max(1, ...stats.value.levels.map(level => level.count)))

// ── 按天曲线（P2-1）──
// 自绘 SVG 折线：不引图表库、不新造视觉。viewBox 固定，宽度由 CSS 拉伸（preserveAspectRatio=none），
// 描边用 vector-effect="non-scaling-stroke" 保证拉伸后仍是 2px。
const CHART_WIDTH = 260
const CHART_HEIGHT = 44
const chartWidth = CHART_WIDTH
const chartHeight = CHART_HEIGHT

const dailyPoints = computed(() => buildDailyPoints(stats.value.daily, { width: CHART_WIDTH, height: CHART_HEIGHT }))
// 横轴日期刻度（C1）：首尾必在、中间均分；位置与折线同一套归一化，所以刻度对得上节点
const dailyTicks = computed(() => buildDailyTicks(stats.value.daily, 4))

function levelPercent(level) {
  return Math.round((Number(level.count) || 0) / levelMax.value * 100)
}

async function load() {
  const id = props.character && props.character.id
  if (!id) { stats.value = normalizeTouchStats(null); return }
  loading.value = true
  try {
    const payload = await fetchTouchStats(id)
    if (!props.character || props.character.id !== id) return   // 期间换了角色：丢弃
    stats.value = normalizeTouchStats(payload)
  } catch (err) {
    // 端点未落地 / 网络失败：按「还没有记录」呈现（不弹错、不伪造）
    console.warn('[touch] 统计拉取失败，按空态呈现:', err && err.message ? err.message : err)
    stats.value = normalizeTouchStats(null)
  } finally {
    loading.value = false
  }
}

watch(() => props.character && props.character.id, () => { load() }, { immediate: true })
</script>

<style scoped>
/* 与角色详情弹窗内的「凹陷小节」同一语言（--bg-sunken + --tint-subtle），不新造视觉 */
.touch-stats {
  margin-top: 12px;
  background: var(--bg-sunken);
  border: 1px solid var(--tint-subtle);
  border-radius: 10px;
  padding: 12px 14px 14px;
}
.touch-stats__head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
}
.touch-stats__title { font-size: 13px; font-weight: 700; color: var(--text-bright); }
.touch-stats__summary { font-size: 12px; color: var(--text-secondary); }
.touch-stats__hint { margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--text-secondary); }
.touch-stats__empty-title { margin-top: 8px; font-size: 13px; color: var(--text-primary); }

.touch-stats__levels { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.touch-stats__level { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.touch-stats__level-label { width: 28px; flex-shrink: 0; color: var(--text-secondary); }
.touch-stats__level-bar {
  flex: 1; min-width: 0; height: 6px; border-radius: 999px;
  background: var(--tint-subtle); overflow: hidden;
}
.touch-stats__level-bar > i {
  display: block; height: 100%; border-radius: 999px;
  background: var(--accent);
  transition: width 0.3s ease;
}
.touch-stats__level-count { width: 34px; flex-shrink: 0; text-align: right; color: var(--text-secondary); }

/* 按天曲线：描边色走 token（双主题自动跟随），宽度随容器拉伸、高度固定 */
.touch-stats__daily { margin-top: 12px; }
.touch-stats__daily-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; font-size: 12px; color: var(--text-secondary);
}
.touch-stats__spark {
  display: block; width: 100%; height: 44px; margin-top: 6px;
}
.touch-stats__spark polyline {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
/* 横轴刻度：相对定位的轨道 + 按百分比绝对定位的刻字（与折线共用同一套归一化） */
.touch-stats__daily-axis {
  position: relative;
  height: 14px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary);
}
.touch-stats__tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  white-space: nowrap;
  line-height: 14px;
}

.touch-stats__rows { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.touch-stats__row {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; color: var(--text-primary);
}
.touch-stats__row-label { min-width: 56px; }
.touch-stats__row-count { color: var(--text-secondary); }
.touch-stats__row-tags { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }
.touch-stats__tag {
  padding: 1px 8px; border-radius: 999px; font-size: 11px;
  color: var(--accent); background: rgba(var(--accent-rgb), 0.12);
}
.touch-stats__tag.is-muted { color: var(--text-secondary); background: var(--tint-subtle); }

/* 内容出现 0.3s（AGENTS.md 硬要求） */
.touch-stats-fade-enter-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.touch-stats-fade-leave-active { transition: opacity 0.3s ease, transform 0.3s ease; }
.touch-stats-fade-enter-from,
.touch-stats-fade-leave-to { opacity: 0; transform: translateY(4px); }

@media (max-width: 767px) {
  .touch-stats { padding: 10px 12px 12px; }
  .touch-stats__row-tags { margin-left: 0; }
}
</style>
