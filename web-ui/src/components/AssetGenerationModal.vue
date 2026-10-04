<template>
  <linshe-modal :model-value="true" full title="一键生成全部角色资产" @update:model-value="onRequestClose">
    <div class="ag-body">
      <!-- ── 配置态 / 运行态：0.3s 交叉淡入（AGENTS.md：切换不许生硬跳变）── -->
      <Transition name="ag-fade" mode="out-in">
        <section v-if="!job" key="config" class="ag-config">
          <p class="ag-lead">
            立绘、表情包、表情立绘要一张张点开角色等 —— 这里丢到后台串行跑，
            <strong>关掉这个窗口也会继续跑</strong>，跑完在角色页能看到。
          </p>

          <div class="ag-block">
            <h4 class="ag-block-title">要生成哪几类</h4>
            <div class="ag-kinds">
              <linshe-switch v-model="kindOn.standing" size="sm" on-text="立绘" />
              <linshe-switch v-model="kindOn.emoji" size="sm" on-text="表情包" />
              <linshe-switch v-model="kindOn.expressionStanding" size="sm" on-text="表情立绘" />
            </div>
          </div>

          <div class="ag-block">
            <h4 class="ag-block-title">
              给哪些角色生成
              <linshe-button variant="link" size="sm" @click="toggleAll">{{ allPicked ? '全不选' : '全选' }}</linshe-button>
            </h4>
            <div class="ag-chars">
              <div v-for="c in characters" :key="c.id" class="ag-char">
                <linshe-switch v-model="picked[c.id]" size="sm" :on-text="c.display_name || ('#' + c.id)" />
              </div>
            </div>
          </div>

          <div class="ag-block">
            <linshe-switch v-model="skipExisting" size="sm" on-text="只补缺（文件已经在的跳过）" />
            <p class="ag-hint">
              判断依据是<strong>图片文件是否真的在磁盘上</strong>，不是数据库状态 ——
              真机上出现过"数据库说已完成、文件却不在"的情况，那种会照常重画。
            </p>
          </div>

          <p v-if="error" class="ag-error">{{ error }}</p>
        </section>

        <!-- ── 运行态 ── -->
        <section v-else key="running" class="ag-running">
          <div class="ag-progress-head" role="status" aria-live="polite">
            <span class="ag-progress-count">已完成 {{ job.completed }}/{{ job.total }}</span>
            <span v-if="job.failed" class="ag-progress-failed">失败 {{ job.failed }}</span>
            <span v-if="job.skipped" class="ag-progress-skipped">跳过 {{ job.skipped }}</span>
            <span class="ag-progress-status">{{ statusText }}</span>
          </div>
          <div class="ag-bar" :class="{ 'is-done': job.done }">
            <div class="ag-bar-fill" :style="{ width: percent + '%' }"></div>
          </div>
          <p v-if="job.currentLabel" class="ag-current">正在生成：{{ job.currentLabel }}</p>
          <p v-if="job.error" class="ag-error">{{ job.error }}</p>

          <div v-if="job.failures.length" class="ag-failures">
            <h4 class="ag-block-title">失败项（{{ job.failures.length }}）</h4>
            <ul class="ag-failure-list">
              <li v-for="(f, i) in job.failures" :key="i" class="ag-failure">
                <span class="ag-failure-name">{{ f.characterName }} · {{ f.kindLabel }}</span>
                <span class="ag-failure-reason">{{ f.error }}</span>
              </li>
            </ul>
          </div>
          <p v-else-if="job.done" class="ag-hint">全部跑完了，回角色页就能看到新素材。</p>
        </section>
      </Transition>
    </div>

    <template #footer>
      <template v-if="!job">
        <linshe-button variant="ghost" size="sm" @click="onRequestClose">取消</linshe-button>
        <linshe-button
          variant="primary"
          size="sm"
          :loading="starting"
          :disabled="!canStart"
          @click="onStart"
        >
          开始后台生成
        </linshe-button>
      </template>
      <template v-else>
        <linshe-button
          v-if="job.status === 'running' || job.status === 'queued'"
          variant="secondary"
          size="sm"
          @click="onControl('pause')"
        >
          暂停
        </linshe-button>
        <linshe-button
          v-else-if="job.status === 'paused' || job.status === 'interrupted'"
          variant="primary"
          size="sm"
          @click="onControl('resume')"
        >
          继续
        </linshe-button>
        <linshe-button
          v-if="job.failed > 0"
          variant="secondary"
          size="sm"
          @click="onControl('retry')"
        >
          重试失败项
        </linshe-button>
        <linshe-button
          v-if="!job.done"
          variant="danger"
          size="sm"
          @click="onControl('cancel')"
        >
          取消任务
        </linshe-button>
        <linshe-button variant="ghost" size="sm" @click="onRequestClose">关闭</linshe-button>
      </template>
    </template>
  </linshe-modal>
</template>

<script setup>
/**
 * 角色资产「一键后台生成」弹窗（2026-10-01，用户原话：「弄个按钮一键后台生成得了」）
 *
 * 口径（与后端 assetGenerationQueue 对齐，别在组件里重算）：
 * · **计划由后端展开**：前端只传「哪些角色 / 哪几类 / 是否只补缺」，总数与跳过数用后端返回的。
 * · **任务生命周期不绑组件**：关窗只停轮询，后端继续跑；重开时 `GET /jobs?active=1` 把进度恢复回来。
 * · 进度双通道：SSE `asset_generation_progress` 为主，2.5s 轮询兜底（与 ExpressionStandingManager 同节奏）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
import { onEvent } from '../stores/unifiedStream.js'
import {
  controlAssetGenerationJob,
  createAssetGenerationJob,
  getAssetGenerationJob,
  listAssetGenerationJobs,
} from '../api/index.js'

const props = defineProps({
  characters: { type: Array, default: () => [] },
})
const emit = defineEmits(['close'])

const picked = ref({})
const kindOn = ref({ standing: true, emoji: true, expressionStanding: true })
const skipExisting = ref(true)
const starting = ref(false)
const error = ref('')
const job = ref(null)

let timer = null
const unsubscribe = onEvent('asset_generation_progress', (payload) => {
  if (!payload || !job.value || payload.jobId !== job.value.jobId) return
  job.value = { ...job.value, ...payload }
  if (payload.done) stopPolling()
})

const allPicked = computed(() => props.characters.length > 0 && props.characters.every(c => picked.value[c.id]))
const chosenIds = computed(() => props.characters.filter(c => picked.value[c.id]).map(c => c.id))
const chosenKinds = computed(() => Object.keys(kindOn.value).filter(k => kindOn.value[k]))
const canStart = computed(() => chosenIds.value.length > 0 && chosenKinds.value.length > 0 && !starting.value)
const percent = computed(() => {
  const total = job.value?.total || 0
  if (!total) return 0
  return Math.min(100, Math.round(((job.value.completed + job.value.failed) / total) * 100))
})
const STATUS_TEXT = {
  queued: '排队中', running: '生成中', paused: '已暂停', interrupted: '服务重启中断（可继续）',
  done: '全部完成', partial_failed: '完成但有失败', failed: '任务失败', cancelled: '已取消',
}
const statusText = computed(() => STATUS_TEXT[job.value?.status] || job.value?.status || '')

function startPolling() {
  if (timer) return
  timer = setInterval(refresh, 2500)
}
function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}
async function refresh() {
  if (!job.value?.jobId) return
  try {
    const next = await getAssetGenerationJob(job.value.jobId)
    if (next) {
      job.value = next
      if (next.done) stopPolling()
    }
  } catch { /* 轮询失败不打扰用户，下一轮再来 */ }
}

function toggleAll() {
  const next = !allPicked.value
  for (const c of props.characters) picked.value[c.id] = next
}

async function onStart() {
  starting.value = true
  error.value = ''
  try {
    const res = await createAssetGenerationJob({
      character_ids: chosenIds.value,
      kinds: chosenKinds.value,
      skipExisting: skipExisting.value,
    })
    job.value = res?.job || (res?.jobId ? await getAssetGenerationJob(res.jobId) : null)
    if (job.value) startPolling()
  } catch (err) {
    error.value = err?.message || '启动失败'
  } finally {
    starting.value = false
  }
}

async function onControl(action) {
  if (!job.value?.jobId) return
  try {
    await controlAssetGenerationJob(job.value.jobId, action)
    await refresh()
    if (job.value && !job.value.done && job.value.status !== 'paused' && job.value.status !== 'cancelled') startPolling()
    if (job.value?.done) stopPolling()
  } catch (err) {
    error.value = err?.message || '操作失败'
  }
}

function onRequestClose() {
  stopPolling()
  emit('close')
}

onBeforeUnmount(() => {
  stopPolling()
  unsubscribe()
})

// 打开时恢复进度：页面重开 / 服务重启后（interrupted）都能接着看、接着跑。
// ⚠️ 刻意不因为"没有活跃任务"就清空 job —— 上一次的失败清单要留给用户看。
watch(() => props.characters, () => {
  for (const c of props.characters) if (picked.value[c.id] === undefined) picked.value[c.id] = false
}, { immediate: true })

;(async () => {
  try {
    const res = await listAssetGenerationJobs({ active: true })
    const list = res?.jobs || []
    const active = list[0]
    if (active) { job.value = active; if (!active.done) startPolling() }
  } catch { /* 拿不到活跃任务就当没有 */ }
})()
</script>

<style scoped>
.ag-body { display: flex; flex-direction: column; gap: 14px; min-height: 220px; }
.ag-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.6; }
.ag-block { display: flex; flex-direction: column; gap: 8px; }
.ag-block-title {
  display: flex; align-items: center; gap: 10px;
  margin: 0; font-size: var(--fs-sm); font-weight: 600; color: var(--text-bright);
}
.ag-kinds { display: flex; flex-wrap: wrap; gap: 14px; }
.ag-chars {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;
  max-height: 240px; overflow-y: auto;
}
.ag-char { min-height: 32px; display: flex; align-items: center; }
.ag-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.6; }
.ag-error { margin: 0; font-size: var(--fs-sm); color: var(--danger, #d9534f); }
.ag-running { display: flex; flex-direction: column; gap: 10px; }
.ag-progress-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; font-size: var(--fs-sm); }
.ag-progress-count { font-weight: 600; color: var(--text-bright); }
.ag-progress-failed { color: var(--danger, #d9534f); }
.ag-progress-skipped, .ag-progress-status { color: var(--text-secondary); }
.ag-bar {
  height: 8px; border-radius: 999px; overflow: hidden;
  background: var(--tint-subtle);
}
.ag-bar-fill {
  height: 100%; width: 0; border-radius: 999px;
  background: var(--accent);
  transition: width 0.3s var(--ease-standard);
}
.ag-current { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.ag-failures { display: flex; flex-direction: column; gap: 6px; }
.ag-failure-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.ag-failure { display: flex; gap: 10px; font-size: var(--fs-xs); }
.ag-failure-name { flex: 0 0 auto; color: var(--text-bright); }
.ag-failure-reason { color: var(--text-secondary); }

/* 配置态 ↔ 运行态：0.3s 交叉淡入（与 ExpressionStandingManager 同节奏） */
.ag-fade-enter-active, .ag-fade-leave-active { transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.ag-fade-enter-from, .ag-fade-leave-to { opacity: 0; transform: translateY(8px); }

@media (max-width: 767px) {
  .ag-chars { grid-template-columns: 1fr; max-height: 40vh; }
}
</style>
