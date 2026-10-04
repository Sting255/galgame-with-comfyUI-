<template>
  <!-- 亲密信息看板：所有字段可编辑，改动即保存（400ms 防抖）。
       弹窗容器由角色详情卡里的 LinsheModal 提供，本组件只负责内容与数据。 -->
  <div class="ip">
    <!-- 首屏骨架 -->
    <div v-if="initialLoading" class="ip-skeleton">
      <div v-for="n in 5" :key="n" class="skeleton ip-sk-row"></div>
    </div>

    <template v-else>
      <div v-if="loadError" class="ip-banner ip-banner-error">
        {{ loadError }}
        <linshe-button variant="link" size="sm" @click="loadAll">重试</linshe-button>
      </div>

      <!-- ── ① 知晓开关（对应截图：爱心标题 + 一行开关） ── -->
      <section class="ip-hero">
        <span class="ip-hero-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.8 5.6a5.2 5.2 0 0 0-7.4 0L12 7l-1.4-1.4a5.2 5.2 0 1 0-7.4 7.4L12 21.4l8.8-8.4a5.2 5.2 0 0 0 0-7.4z" />
          </svg>
        </span>
        <div class="ip-hero-text">
          <div class="ip-hero-line">
            <span class="ip-hero-label">让 {{ displayName }} 知晓这些信息</span>
            <linshe-switch
              v-model="injectEnabled"
              :disabled="injectSaving"
              aria-label="让角色知晓亲密信息"
              @change="onInjectChange"
            />
          </div>
          <p class="ip-hero-desc">开启后她会在对话中记得自己的身体档案（消耗少量 token）</p>
        </div>
      </section>

      <!-- ── ② 统计口径 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">统计口径</h4>
          <span class="ip-sec-hint">决定下面的统计与流水计入哪些对象</span>
        </header>
        <div class="ip-chips">
          <linshe-button
            v-for="opt in VIEW_SCOPE_DEFS"
            :key="opt.key"
            variant="chip"
            size="sm"
            :active="viewScope.includes(opt.key)"
            @click="onToggleScope(opt.key)"
          >
            {{ opt.label }}
          </linshe-button>
          <linshe-button
            variant="chip"
            size="sm"
            :active="isAllViewScope(viewScope)"
            title="勾选全部三类口径"
            @click="onSelectAllScope"
          >
            全部
          </linshe-button>
        </div>
      </section>

      <!-- ── ③ 身体信息（两列，<768px 单列） ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">身体信息</h4>
          <span class="ip-sec-hint">修改后自动保存</span>
        </header>
        <div class="ip-grid">
          <label v-for="field in BODY_FIELDS" :key="field.key" class="ip-field">
            <span class="ip-field-label">{{ field.label }}</span>
            <linshe-input
              size="sm"
              :model-value="form[field.key]"
              :placeholder="field.placeholder"
              @update:model-value="v => onBodyInput(field.key, v)"
            />
          </label>
        </div>
        <label class="ip-field ip-field-full">
          <span class="ip-field-label">备注</span>
          <linshe-input
            type="textarea"
            size="sm"
            :rows="3"
            :model-value="form.note"
            placeholder="体质、禁忌、偏好等会随档案一起注入对话"
            @update:model-value="v => onBodyInput('note', v)"
          />
        </label>
      </section>

      <!-- ── ④ 初次 / 破处信息 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">初次 / 破处信息</h4>
          <span class="ip-sec-hint">勾选后可手填日期，人工日期不会被流水覆盖</span>
        </header>
        <div class="ip-first-list stagger">
          <div v-for="row in firstRows" :key="row.actKey" class="ip-first-row">
            <linshe-switch
              class="ip-first-toggle"
              size="sm"
              :model-value="!!row.firstAt"
              :aria-label="`${row.label} 是否有记录`"
              @change="v => onFirstToggle(row, v)"
            />
            <span class="ip-first-label">{{ row.label }}</span>
            <linshe-input
              class="ip-first-date"
              type="date"
              size="sm"
              :model-value="toDateInput(row.firstAt)"
              :disabled="!row.firstAt"
              @update:model-value="v => onFirstDate(row, v)"
            />
            <span v-if="row.firstAt" class="ip-tag" :class="row.manual ? 'is-manual' : 'is-auto'">
              {{ row.manual ? '人工' : '自动' }}
            </span>
            <span v-else class="ip-tag is-empty">无记录</span>
          </div>
        </div>
      </section>

      <!-- ── ⑤ 基础统计 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">基础统计</h4>
          <span class="ip-sec-hint">{{ summaryHint }}</span>
        </header>
        <div class="ip-summary">
          <div v-for="cell in summaryCells" :key="cell.key" class="ip-summary-cell">
            <span class="ip-summary-label">{{ cell.label }}</span>
            <span class="ip-summary-value">{{ cell.value }}</span>
          </div>
        </div>
        <!-- 切换口径时整块 0.3s 淡入淡出，不生硬跳变 -->
        <Transition name="ip-fade" mode="out-in">
          <div v-if="actRows.length" :key="scopeKey" class="ip-stat-grid stagger">
            <div v-for="row in actRows" :key="row.key" class="ip-stat">
              <span class="ip-stat-label">{{ row.label }}</span>
              <span class="ip-stat-value">
                {{ row.count }}
                <em v-if="row.climax > 0" class="ip-stat-sub">高潮 {{ row.climax }}</em>
              </span>
            </div>
          </div>
          <p v-else :key="scopeKey" class="ip-empty">还没有可统计的记录</p>
        </Transition>
      </section>

      <!-- ── ⑥ 部位敏感度（可增删 + 横向色带） ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">部位敏感度</h4>
          <span class="ip-sec-hint">0~5 级，色带越宽表示越敏感</span>
        </header>
        <div class="ip-zone-list stagger">
          <div v-for="zone in zones" :key="zone.key" class="ip-zone">
            <linshe-input
              class="ip-zone-name"
              size="sm"
              :model-value="zone.label"
              placeholder="部位名"
              :maxlength="ZONE_LABEL_MAX"
              @update:model-value="v => onZoneLabel(zone, v)"
            />
            <div class="ip-zone-level">
              <linshe-slider
                :model-value="zone.level"
                :min="0"
                :max="ZONE_MAX_LEVEL"
                :step="1"
                @update:model-value="v => onZoneLevelDraft(zone, v)"
                @change="v => onZoneLevelCommit(zone, v)"
              />
              <span class="ip-zone-level-text">{{ zoneLevelLabel(zone.level) }}</span>
            </div>
            <linshe-button class="ip-zone-del" variant="ghost" size="sm" :aria-label="`删除部位 ${zone.label || ''}`" @click="onRemoveZone(zone)">删除</linshe-button>
            <div class="ip-zone-band" aria-hidden="true">
              <span
                class="ip-zone-band-fill"
                :style="{ width: `${zoneLevelPercent(zone.level)}%`, background: zoneLevelToken(zone.level) }"
              ></span>
            </div>
          </div>
          <p v-if="!zones.length" class="ip-empty">还没有记录敏感部位</p>
        </div>
        <linshe-button variant="secondary" size="sm" class="ip-add-btn" @click="onAddZone">＋ 添加部位</linshe-button>
      </section>

      <!-- ── ⑦ 体位排行 Top5 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">体位排行</h4>
          <span class="ip-sec-hint">按当前口径的累计次数</span>
        </header>
        <ol v-if="ranked.length" class="ip-rank-list stagger">
          <li v-for="(row, idx) in ranked" :key="row.positionKey" class="ip-rank-row">
            <span class="ip-rank-no" :class="{ 'is-top': idx === 0 }">{{ idx + 1 }}</span>
            <span class="ip-rank-label">{{ row.label }}</span>
            <span class="ip-rank-track"><span class="ip-rank-fill" :style="{ width: `${rankPercent(row.count)}%` }"></span></span>
            <span class="ip-rank-count">{{ row.count }}</span>
          </li>
        </ol>
        <p v-else class="ip-empty">还没有体位记录</p>
      </section>

      <!-- ── ⑧ AI 修改权限 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">AI 修改权限</h4>
          <span class="ip-sec-hint">允许邻舍在对话中自动补充这些字段（默认只开统计）</span>
        </header>
        <div class="ip-perm-grid">
          <div v-for="item in AI_EDIT_FIELD_DEFS" :key="item.key" class="ip-perm-row">
            <div class="ip-perm-text">
              <span class="ip-perm-label">{{ item.label }}</span>
              <span class="ip-perm-desc">{{ item.desc }}</span>
            </div>
            <linshe-switch
              size="sm"
              :model-value="aiEditFields.includes(item.key)"
              :aria-label="`允许 AI 修改${item.label}`"
              @change="onToggleAiField(item.key)"
            />
          </div>
        </div>
      </section>

      <!-- ── ⑨ AI 判断行为（开关＝默认是否自动判断；按钮＝手动补判最近若干轮） ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">AI 判断行为</h4>
          <span class="ip-sec-hint">开启后每轮回复由模型判断这轮是什么行为</span>
        </header>
        <div class="ip-backfill-row">
          <span class="ip-backfill-label">默认开启 AI 判断</span>
          <linshe-switch
            size="sm"
            v-model="aiJudgeEnabled"
            :disabled="aiJudgeSaving"
            aria-label="默认开启 AI 判断"
            @change="onAiJudgeEnabledChange"
          />
        </div>
        <p class="ip-note">开启后每轮回复完成会异步让模型判断这轮是什么行为并补记账；关闭时只能点下面的按钮手动判断</p>
        <div class="ip-backfill-row">
          <span class="ip-backfill-label">每日判定上限</span>
          <linshe-input
            v-model.number="aiJudgeDailyLimit"
            class="ip-quota-input"
            type="number"
            size="sm"
            :min="0"
            :max="AI_JUDGE_DAILY_LIMIT_MAX"
            :step="1"
            :disabled="aiJudgeQuotaSaving"
            aria-label="每日判定上限"
            @change="onAiJudgeDailyLimitChange"
          />
        </div>
        <p class="ip-note">{{ aiJudgeQuotaHint }}</p>
        <div class="ip-ai-row">
          <linshe-button
            class="ip-ai-btn"
            variant="secondary"
            size="sm"
            :loading="aiJudgeBusy"
            :disabled="aiJudgeBusy"
            @click="runAiJudge"
          >
            AI 判断行为
          </linshe-button>
          <span class="ip-ai-tip">补判最近 8 轮回复，自动归类并补记账</span>
        </div>
      </section>

      <!-- ── ⑩ 让 AI 整理档案（只有已授权字段会自动应用，其余进待确认提议） ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">让 AI 整理档案</h4>
          <span class="ip-sec-hint">按最近的对话补全档案；只有你在上面授权的字段会自动写入</span>
        </header>
        <div class="ip-ai-row">
          <linshe-button
            class="ip-ai-btn"
            variant="primary"
            size="sm"
            :loading="aiEditBusy"
            :disabled="aiEditBusy"
            @click="runAiEdit"
          >
            让 AI 根据最近的对话整理档案
          </linshe-button>
          <span class="ip-ai-tip">调用一次模型，可能补全身高三围、敏感带、备注与初次</span>
        </div>
        <p v-if="aiEditNotice" class="ip-note ip-note-warn">{{ aiEditNotice }}</p>

        <div class="ip-sug-head">
          <span class="ip-sug-title">待确认提议</span>
          <span v-if="suggestions.length" class="ip-tag is-manual">{{ suggestions.length }} 条</span>
          <span v-else class="ip-tag">{{ suggestionsLoading ? '读取中…' : '暂无' }}</span>
        </div>

        <!-- 列表 / 空态之间 0.3s 过渡，避免采纳后整块生硬跳变 -->
        <Transition name="ip-fade" mode="out-in">
          <div v-if="suggestions.length" key="list" class="ip-sug-list stagger">
            <div v-for="row in suggestions" :key="row.id" class="ip-sug-row">
              <div class="ip-sug-main">
                <span class="ip-sug-field">{{ row.fieldLabel }}</span>
                <span class="ip-sug-values">
                  <span class="ip-sug-current">{{ row.currentText }}</span>
                  <span class="ip-sug-arrow" aria-hidden="true">→</span>
                  <span class="ip-sug-next">{{ row.suggestionText }}</span>
                </span>
                <span v-if="row.reason" class="ip-sug-reason">{{ row.reason }}</span>
              </div>
              <div class="ip-sug-actions">
                <linshe-button
                  variant="ghost"
                  size="sm"
                  :disabled="!!suggestionBusy"
                  @click="onRejectSuggestion(row)"
                >
                  忽略
                </linshe-button>
                <linshe-button
                  variant="secondary"
                  size="sm"
                  :loading="suggestionBusy === row.id"
                  :disabled="!!suggestionBusy && suggestionBusy !== row.id"
                  @click="onAcceptSuggestion(row)"
                >
                  采纳
                </linshe-button>
              </div>
            </div>
          </div>
          <p v-else key="empty" class="ip-empty">没有待确认的提议</p>
        </Transition>
      </section>

      <!-- ── ⑪ 历史回填 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">历史回填</h4>
          <span class="ip-sec-hint">扫描过去已经聊过的会话，把亲密行为补进流水</span>
        </header>
        <div class="ip-backfill">
          <div class="ip-backfill-row">
            <span class="ip-backfill-label">开启历史回填</span>
            <linshe-switch
              size="sm"
              v-model="backfillEnabled"
              aria-label="开启历史回填"
              @change="onBackfillEnabledChange"
            />
          </div>
          <div class="ip-backfill-row">
            <div class="ip-backfill-progress">
              <span class="ip-backfill-status">{{ backfillStatusText(backfill, backfillEnabled) }}</span>
              <span class="ip-backfill-count">已扫描 {{ backfill.scanned }} · 新增 {{ backfill.inserted }}</span>
            </div>
            <linshe-button
              variant="secondary"
              size="sm"
              :loading="backfillBusy || backfill.status === 'running'"
              :disabled="!backfillEnabled || backfill.status === 'running'"
              @click="startBackfill"
            >
              {{ backfillButtonText(backfill) }}
            </linshe-button>
          </div>
          <p v-if="backfillError" class="ip-note ip-note-warn">{{ backfillError }}</p>
          <p v-else-if="backfillPlaceholder" class="ip-note">回填引擎尚未接入（后端占位接口），当前只记录开关与进度。</p>
        </div>
      </section>

      <!-- ── ⑫ 流水明细 ── -->
      <section class="ip-sec">
        <header class="ip-sec-head">
          <h4 class="ip-sec-title">流水明细</h4>
          <span class="ip-sec-hint">
            共 {{ counts.logs || 0 }} 条，最近 {{ Math.min(LOG_PAGE, logs.length) }} 条
            <!-- 口径收窄时群聊/NPC 流水不进列表，不提示会让用户以为记录凭空消失 -->
            <template v-if="hiddenLogCount > 0">，另有 {{ hiddenLogCount }} 条不在当前口径内</template>
          </span>
        </header>
        <div class="ip-log-list stagger">
          <div v-for="row in logRows" :key="row.id" class="ip-log-row">
            <div class="ip-log-main">
              <span class="ip-log-act">{{ row.text.actLabel }}</span>
              <span v-if="row.text.positionLabel" class="ip-log-pos">{{ row.text.positionLabel }}</span>
              <span class="ip-tag" :class="row.text.source === '人工' ? 'is-manual' : 'is-auto'">{{ row.text.source }}</span>
            </div>
            <div class="ip-log-meta">
              <span class="ip-log-count">×{{ row.text.actCount }}</span>
              <span v-if="row.text.climaxCount > 0" class="ip-log-count">高潮 {{ row.text.climaxCount }}</span>
              <span class="ip-log-time">{{ formatDateTime(row.text.occurredAt) }}</span>
              <linshe-button variant="danger" size="sm" :aria-label="`删除 ${row.text.actLabel}`" @click="onDeleteLog(row)">删除</linshe-button>
            </div>
          </div>
          <p v-if="!logRows.length" class="ip-empty">还没有流水记录</p>
        </div>

        <div class="ip-log-actions">
          <linshe-button
            v-if="logs.length < (counts.logs || 0)"
            variant="ghost"
            size="sm"
            :loading="logsLoading"
            @click="loadLogs(false)"
          >
            加载更多
          </linshe-button>
          <linshe-button variant="ghost" size="sm" @click="manualOpen = !manualOpen">
            {{ manualOpen ? '收起人工补录' : '＋ 人工补录' }}
          </linshe-button>
        </div>

        <Transition name="ip-drop">
          <div v-if="manualOpen" class="ip-manual">
            <div class="ip-manual-grid">
              <linshe-select
                v-model="manual.actKey"
                size="sm"
                :options="actOptions"
                placeholder="选择行为"
                aria-label="选择行为"
              />
              <linshe-select
                v-model="manual.positionKey"
                size="sm"
                :options="positionOptions"
                placeholder="体位（可留空）"
                aria-label="选择体位"
              />
              <linshe-input v-model.number="manual.count" type="number" size="sm" :min="1" placeholder="次数" />
              <linshe-input v-model.number="manual.climaxCount" type="number" size="sm" :min="0" placeholder="高潮次数" />
            </div>
            <div class="ip-manual-actions">
              <linshe-button variant="secondary" size="sm" :disabled="!manual.actKey" :loading="manualSaving" @click="submitManual">
                补录一条
              </linshe-button>
            </div>
          </div>
        </Transition>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import LinsheButton from '../ui/LinsheButton.vue'
import LinsheInput from '../ui/LinsheInput.vue'
import LinsheSelect from '../ui/LinsheSelect.vue'
import LinsheSlider from '../ui/LinsheSlider.vue'
import LinsheSwitch from '../ui/LinsheSwitch.vue'
import {
  acceptIntimateSuggestion,
  createIntimateLog,
  deleteIntimateLog,
  getIntimateBackfill,
  getIntimatePanel,
  getIntimateVocabulary,
  listIntimateLogs,
  listIntimateSuggestions,
  proposeIntimateProfileEdits,
  rejectIntimateSuggestion,
  runIntimateAiJudge,
  saveIntimateProfile,
  saveIntimateSettings,
  setIntimateAiJudge,
  setIntimateFirst,
  setIntimateInject,
  startIntimateBackfill,
} from '../../api/intimate.js'
// AI 判断的每日配额是全局配置（GET /api/config 顶层 aiJudge），因此走公共 api 模块
import { getConfig, updateAiJudgeDailyLimit } from '../../api/index.js'
import {
  AI_EDIT_FIELD_DEFS,
  AI_JUDGE_DAILY_LIMIT_MAX,
  ALL_VIEW_SCOPE,
  BACKFILL_STATUS,
  DEFAULT_AI_EDIT_FIELDS,
  DEFAULT_VIEW_SCOPE,
  VIEW_SCOPE_DEFS,
  ZONE_LABEL_MAX,
  ZONE_MAX_LEVEL,
  actStatRows,
  addZone,
  aiEditResultText,
  aiJudgeQuotaNote,
  aiJudgeRunToast,
  backfillButtonText,
  backfillStatusText,
  clampDailyLimit,
  clampLevel,
  firstsRows,
  formatDateTime,
  fromDateInput,
  isAllViewScope,
  logRowText,
  normalizeAiEditFields,
  normalizeAiJudgeQuota,
  normalizeBackfill,
  normalizeViewScope,
  normalizeZones,
  normalizeSuggestions,
  partnerKindsToViewScope,
  removeZone,
  statSummary,
  toDateInput,
  toggleAiEditField,
  topPositions,
  viewScopeToPartnerKinds,
  viewScopeToggleResult,
  zoneLevelLabel,
  zoneLevelPercent,
  zoneLevelToken,
  zonesForSave,
} from './intimateLogic.js'

const props = defineProps({
  character: { type: Object, default: null },
})

const toastFn = inject('toast', null)
const confirmFn = inject('confirm', null)

/** 字段保存防抖（需求：blur / change 即保存，防抖 400ms） */
const SAVE_DEBOUNCE = 400
const LOG_PAGE = 20
const BACKFILL_POLL = 1500

const BODY_FIELDS = [
  { key: 'height', label: '身高', placeholder: '如 162cm' },
  { key: 'bust', label: '胸围', placeholder: '如 88cm' },
  { key: 'waist', label: '腰围', placeholder: '如 58cm' },
  { key: 'hip', label: '臀围', placeholder: '如 90cm' },
  { key: 'cup', label: '罩杯', placeholder: '如 D' },
]

const displayName = computed(() => props.character?.display_name || props.character?.name || '她')

// ── 状态 ──
const initialLoading = ref(true)
const loaded = ref(false)
const loadError = ref('')
const logsLoading = ref(false)
const manualSaving = ref(false)
const injectSaving = ref(false)
const injectEnabled = ref(false)
const backfillEnabled = ref(true)
const backfillBusy = ref(false)
const backfillError = ref('')
const backfillPlaceholder = ref(false)
const manualOpen = ref(false)

// AI 整理档案（task-13）：提议列表 + 请求态
const suggestions = ref([])
const suggestionsLoading = ref(false)
const aiEditBusy = ref(false)
const aiEditNotice = ref('')
const suggestionBusy = ref('')

// AI 判断行为（task-32）：默认开启开关 + 手动补判 + 全局每日配额
const aiJudgeEnabled = ref(false)
const aiJudgeSaving = ref(false)
const aiJudgeBusy = ref(false)
/** 手动补判的轮数（与后端默认值一致） */
const AI_JUDGE_LIMIT = 8
/** 每日判定上限输入框的值（0 = 不限制），与后端配额对象双向校准 */
const aiJudgeDailyLimit = ref(0)
/** 全局配额对象：{ dailyLimit, usedToday, remaining, unlimited }；known=false 表示还没读到 */
const aiJudgeQuota = ref(normalizeAiJudgeQuota(null))
const aiJudgeQuotaSaving = ref(false)
const aiJudgeQuotaHint = computed(() => aiJudgeQuotaNote(aiJudgeQuota.value))

const form = reactive({ height: '', bust: '', waist: '', hip: '', cup: '', note: '' })
const zones = ref([])
const rawFirsts = ref([])
const firstRows = ref([])
const stats = ref({})
const counts = ref({ logs: 0 })
/** 口径外流水数（后端 counts.allLogs 已返回但此前从未显示）：收窄口径时解释"记录为什么变少" */
const hiddenLogCount = computed(() => {
  const all = Number(counts.value?.allLogs) || 0
  const inScope = Number(counts.value?.logs) || 0
  return Math.max(0, all - inScope)
})
const logs = ref([])
const vocab = ref({ acts: [], positions: [] })
const aiEditFields = ref([...DEFAULT_AI_EDIT_FIELDS])
const viewScope = ref([...DEFAULT_VIEW_SCOPE])
const backfill = ref(normalizeBackfill(null))
const manual = reactive({ actKey: '', positionKey: '', count: 1, climaxCount: 0 })

// ── 派生数据 ──
const actRows = computed(() => actStatRows(stats.value))
const ranked = computed(() => topPositions(stats.value?.byPosition, 5))
const rankMax = computed(() => ranked.value[0]?.count || 0)
const summary = computed(() => statSummary(stats.value))
const summaryCells = computed(() => [
  { key: 'acts', label: '总次数', value: String(summary.value.totalActs) },
  { key: 'climax', label: '高潮次数', value: String(summary.value.totalClimax) },
  { key: 'kinds', label: '行为种类', value: String(summary.value.actKinds) },
  { key: 'first', label: '最早记录', value: toDateInput(summary.value.firstAt) || '—' },
  { key: 'last', label: '最近记录', value: toDateInput(summary.value.lastAt) || '—' },
])
const summaryHint = computed(() => {
  const names = VIEW_SCOPE_DEFS.filter(o => viewScope.value.includes(o.key)).map(o => o.label)
  return names.length ? `口径：${names.join(' / ')}` : '口径：全部'
})
/** 口径指纹：用于统计块的过渡 key */
const scopeKey = computed(() => viewScope.value.join(',') || 'all')
const logRows = computed(() => logs.value.map(log => ({ id: log.id, text: logRowText(log, vocab.value) })))
const actOptions = computed(() => (vocab.value.acts || []).map(a => ({ value: a.key, label: a.label })))
const positionOptions = computed(() => [
  { value: '', label: '不指定' },
  ...(vocab.value.positions || []).map(p => ({ value: p.key, label: p.group ? `${p.label}（${p.group}）` : p.label })),
])
function rankPercent(count) {
  if (!rankMax.value) return 0
  return Math.max(6, Math.round((count / rankMax.value) * 100))
}

function notify(message, type = 'info') {
  if (typeof toastFn === 'function') toastFn(message, type)
  else console.warn('[亲密看板]', message)
}

// ── 读取 ──
function applyProfile(profile) {
  const p = profile || {}
  form.height = p.height || ''
  form.bust = p.bust || ''
  form.waist = p.waist || ''
  form.hip = p.hip || ''
  form.cup = p.cup || ''
  form.note = p.note || ''
  zones.value = normalizeZones(p.sensitiveZones)
  injectEnabled.value = !!p.injectEnabled
  aiJudgeEnabled.value = !!p.aiJudgeEnabled
}

function rebuildFirstRows() {
  firstRows.value = firstsRows(vocab.value.acts, rawFirsts.value)
}

/** 面板设置来自多处（后端字段可能放在 settings / profile / 顶层），逐一兜底 */
function applySettings(res) {
  const p = res?.profile || {}
  aiEditFields.value = normalizeAiEditFields(
    res?.settings?.aiEditFields ?? p.aiEditFields ?? res?.aiEditFields,
  )
  viewScope.value = normalizeViewScope(
    res?.settings?.viewScope ?? p.viewScope ?? res?.viewScope,
  )
  const enabled = res?.settings?.backfillEnabled ?? p.backfillEnabled ?? res?.backfillEnabled
  backfillEnabled.value = enabled === undefined || enabled === null ? true : !!enabled
  backfill.value = normalizeBackfill(res?.backfill)
}

/**
 * 轻量刷新：统计 / 里程碑 / 流水始终刷新；
 * withProfile=true 时同时刷新身体档案与敏感带（AI 整理 / 采纳提议后要看到字段变化）。
 */
async function refreshData({ withProfile = false } = {}) {
  const id = props.character?.id
  if (!id) return
  try {
    const res = await getIntimatePanel(id)
    if (withProfile && res?.profile) applyProfile(res.profile)
    rawFirsts.value = res?.firsts || []
    rebuildFirstRows()
    stats.value = res?.stats || {}
    counts.value = res?.counts || {}
    syncScopeFromStats(res?.stats)
    if (res?.backfill) backfill.value = normalizeBackfill(res.backfill)
  } catch (err) {
    notify(err?.message || '统计刷新失败', 'error')
  }
}

/** 提议里的行为键 → 中文名（用词表兜底，避免采纳列表里显示 vaginal 之类的机器键） */
const actLabelMap = computed(() => new Map((vocab.value.acts || []).map(a => [a.key, a.label])))

/** 待确认提议：读失败静默处理（后端 ai-edit 路由未就绪时不该打断整个看板） */
async function loadSuggestions({ silent = true } = {}) {
  const id = props.character?.id
  if (!id) return
  suggestionsLoading.value = true
  try {
    const res = await listIntimateSuggestions(id)
    suggestions.value = normalizeSuggestions(res?.suggestions, { actLabels: actLabelMap.value })
  } catch (err) {
    suggestions.value = []
    if (!silent) notify(err?.message || '待确认提议读取失败', 'error')
  } finally {
    suggestionsLoading.value = false
  }
}

/** 用后端回显的生效口径（stats.partnerKinds）校准 chip 选中态，不靠前端猜 */
function syncScopeFromStats(statsRes) {
  const echo = statsRes?.partnerKinds
  if (!Array.isArray(echo) || !echo.length) return
  viewScope.value = partnerKindsToViewScope(echo)
}

async function loadLogs(reset = true) {
  const id = props.character?.id
  if (!id) return
  logsLoading.value = true
  try {
    const res = await listIntimateLogs(id, {
      limit: LOG_PAGE,
      offset: reset ? 0 : logs.value.length,
      partnerKinds: viewScopeToPartnerKinds(viewScope.value),
    })
    const list = res?.logs || []
    logs.value = reset ? list : [...logs.value, ...list]
  } catch (err) {
    notify(err?.message || '流水加载失败', 'error')
  } finally {
    logsLoading.value = false
  }
}

async function loadAll() {
  const id = props.character?.id
  if (!id) {
    initialLoading.value = false
    return
  }
  initialLoading.value = !loaded.value
  loadError.value = ''
  try {
    // 词表失败不阻塞看板（回填 / 权限接口在后端任务里分头实现）
    const [panelRes, vocabRes] = await Promise.all([
      getIntimatePanel(id),
      getIntimateVocabulary(id).catch(() => ({ acts: [], positions: [] })),
    ])
    vocab.value = { acts: vocabRes?.acts || [], positions: vocabRes?.positions || [] }
    applyProfile(panelRes?.profile)
    rawFirsts.value = panelRes?.firsts || []
    rebuildFirstRows()
    stats.value = panelRes?.stats || {}
    counts.value = panelRes?.counts || {}
    applySettings(panelRes)
    syncScopeFromStats(panelRes?.stats)
    await loadLogs(true)
    await loadSuggestions()
    loaded.value = true
    maybeAutoBackfill()
  } catch (err) {
    loadError.value = err?.message || '亲密看板加载失败'
  } finally {
    initialLoading.value = false
  }
}

// ── 身体档案：防抖保存 ──
let profileTimer = null
let pendingPatch = {}
let zonesDirty = false
let zonesTimer = null

function onBodyInput(key, value) {
  form[key] = value
  pendingPatch = { ...pendingPatch, [key]: value }
  clearTimeout(profileTimer)
  profileTimer = setTimeout(flushProfile, SAVE_DEBOUNCE)
}

async function flushProfile() {
  clearTimeout(profileTimer)
  profileTimer = null
  const patch = pendingPatch
  pendingPatch = {}
  const id = props.character?.id
  if (!id || !Object.keys(patch).length) return
  try {
    await saveIntimateProfile(id, patch)
  } catch (err) {
    notify(err?.message || '身体档案保存失败', 'error')
  }
}

function queueZonesSave(immediate = false) {
  zonesDirty = true
  clearTimeout(zonesTimer)
  if (immediate) flushZones()
  else zonesTimer = setTimeout(flushZones, SAVE_DEBOUNCE)
}

async function flushZones() {
  clearTimeout(zonesTimer)
  zonesTimer = null
  const id = props.character?.id
  if (!id || !zonesDirty) return
  zonesDirty = false
  try {
    await saveIntimateProfile(id, { sensitiveZones: zonesForSave(zones.value) })
  } catch (err) {
    zonesDirty = true
    notify(err?.message || '部位敏感度保存失败', 'error')
  }
}

function onZoneLabel(zone, value) {
  zone.label = value
  queueZonesSave()
}

/** 拖动过程中只改本地值，松手（change）才落库 */
function onZoneLevelDraft(zone, value) {
  zone.level = clampLevel(value)
}

function onZoneLevelCommit(zone, value) {
  zone.level = clampLevel(value)
  queueZonesSave(true)
}

function onAddZone() {
  zones.value = addZone(zones.value)
  queueZonesSave(true)
}

function onRemoveZone(zone) {
  zones.value = removeZone(zones.value, zone.key)
  queueZonesSave(true)
}

// ── 注入开关 ──
async function onInjectChange(value) {
  const id = props.character?.id
  if (!id) return
  injectSaving.value = true
  try {
    await setIntimateInject(id, value)
  } catch (err) {
    injectEnabled.value = !value
    notify(err?.message || '注入开关保存失败', 'error')
  } finally {
    injectSaving.value = false
  }
}

// ── 面板设置（口径 / AI 权限 / 回填开关） ──
async function saveSettings(patch) {
  const id = props.character?.id
  if (!id) return
  try {
    await saveIntimateSettings(id, patch)
  } catch (err) {
    notify(err?.message || '面板设置保存失败（后端设置接口未就绪）', 'warning')
  }
}

async function onToggleScope(key) {
  const { scope, clamped } = viewScopeToggleResult(viewScope.value, key)
  viewScope.value = scope
  await saveSettings({ viewScope: scope })
  // 文案里的口径名从默认口径现算，别写死「用户↔角色」——默认值改过一次（task-26 加入群聊）
  if (clamped) {
    const names = VIEW_SCOPE_DEFS.filter(o => DEFAULT_VIEW_SCOPE.includes(o.key)).map(o => o.label).join(' + ')
    notify(`至少保留一个统计口径，已切回“${names}”`, 'warning')
  }
  await refreshData()
  await loadLogs(true)
}

/** 「全部」＝三类全勾（后端不接受空数组，也不使用 ?partnerKinds=all 逃生门） */
async function onSelectAllScope() {
  viewScope.value = [...ALL_VIEW_SCOPE]
  await saveSettings({ viewScope: viewScope.value })
  await refreshData()
  await loadLogs(true)
}

async function onToggleAiField(key) {
  aiEditFields.value = toggleAiEditField(aiEditFields.value, key)
  await saveSettings({ aiEditFields: aiEditFields.value })
}

// ── AI 判断行为（task-32） ──

/** 默认开关：失败回滚（与注入开关同一套口径） */
async function onAiJudgeEnabledChange(value) {
  const id = props.character?.id
  if (!id) return
  aiJudgeSaving.value = true
  try {
    await setIntimateAiJudge(id, value)
  } catch (err) {
    aiJudgeEnabled.value = !value
    notify(err?.message || 'AI 判断开关保存失败', 'error')
  } finally {
    aiJudgeSaving.value = false
  }
}

/** 手动补判最近若干轮：成功后统计与流水都要跟着刷新 */
async function runAiJudge() {
  const id = props.character?.id
  if (!id || aiJudgeBusy.value) return
  aiJudgeBusy.value = true
  try {
    const res = await runIntimateAiJudge(id, AI_JUDGE_LIMIT)
    // 补判会消耗当日配额：把回执里的 quota 用起来，旁注里的「已用 N 次」立刻准
    const quota = normalizeAiJudgeQuota(res?.quota)
    if (quota.known) {
      aiJudgeQuota.value = quota
      if (!aiJudgeQuotaSaving.value) aiJudgeDailyLimit.value = quota.dailyLimit
    }
    // 配额耗尽时后端 message / errors 里已经有人话，直接用（aiJudgeRunToast 内部就这么选）
    const text = aiJudgeRunToast(res)
    notify(text.text, text.type)
    await refreshData()
    await loadLogs(true)
  } catch (err) {
    // 409 → 看板功能当前已关闭（api 层已转中文）
    notify(err?.message || 'AI 判断失败', 'error')
  } finally {
    aiJudgeBusy.value = false
  }
}

/**
 * 读取全局每日配额（GET /api/config 顶层 aiJudge）。
 * 读不到就只显示「0 = 不限制」，不假装「已用 0 次」——配额是附加信息，不能挡住看板本身。
 */
async function refreshAiJudgeQuota() {
  try {
    const res = await getConfig()
    const quota = normalizeAiJudgeQuota(res?.aiJudge)
    if (!quota.known) return
    aiJudgeQuota.value = quota
    aiJudgeDailyLimit.value = quota.dailyLimit
  } catch (err) {
    console.warn('[亲密看板] 读取 AI 判断配额失败:', err?.message || err)
  }
}

/** 每日判定上限：改完立刻 PUT，失败回滚输入框并 toast */
async function onAiJudgeDailyLimitChange() {
  const next = clampDailyLimit(aiJudgeDailyLimit.value)
  const previous = aiJudgeQuota.value.known ? aiJudgeQuota.value.dailyLimit : 0
  if (next === previous) {
    aiJudgeDailyLimit.value = next
    return
  }
  aiJudgeQuotaSaving.value = true
  try {
    const res = await updateAiJudgeDailyLimit(next)
    // 写接口返回同一个配额对象（可能裸给，也可能包在 aiJudge 里），两种都认
    const quota = normalizeAiJudgeQuota(res?.aiJudge ?? res)
    if (quota.known) {
      aiJudgeQuota.value = quota
      aiJudgeDailyLimit.value = quota.dailyLimit
    } else {
      aiJudgeDailyLimit.value = next
    }
  } catch (err) {
    aiJudgeDailyLimit.value = previous
    notify(`${err?.message || '每日判定上限保存失败'}`, 'error')
  } finally {
    aiJudgeQuotaSaving.value = false
  }
}

// ── AI 整理档案（task-13） ──

/** 采纳/整理会改动档案字段：先把防抖中的本地改动落库，避免被服务端值覆盖 */
async function flushPendingEdits() {
  clearTimeout(profileTimer)
  clearTimeout(zonesTimer)
  await Promise.all([flushProfile(), flushZones()])
}

async function runAiEdit() {
  const id = props.character?.id
  if (!id || aiEditBusy.value) return
  aiEditBusy.value = true
  aiEditNotice.value = ''
  try {
    await flushPendingEdits()
    const res = await proposeIntimateProfileEdits(id)
    const applied = Array.isArray(res?.applied) ? res.applied : []
    notify(aiEditResultText(res), applied.length ? 'success' : 'info')
    // 已授权字段由后端直接落库：这里立刻把档案拉回来，面板字段同步可见
    suggestions.value = normalizeSuggestions(res?.suggestions, { actLabels: actLabelMap.value })
    if (applied.length) await refreshData({ withProfile: true })
    await loadSuggestions()
  } catch (err) {
    // 409 → 看板功能当前已关闭；503 → 尚未配置 LLM，无法整理（api 层已转中文）
    aiEditNotice.value = err?.message || '整理失败，请稍后再试'
    notify(aiEditNotice.value, 'warning')
  } finally {
    aiEditBusy.value = false
  }
}

async function onAcceptSuggestion(row) {
  const id = props.character?.id
  if (!id || suggestionBusy.value) return
  suggestionBusy.value = row.id
  try {
    await flushPendingEdits()
    await acceptIntimateSuggestion(id, row.id)
    suggestions.value = suggestions.value.filter(s => s.id !== row.id)
    aiEditNotice.value = ''
    notify(`已采纳「${row.fieldLabel}」的提议`, 'success')
    // 采纳后身体信息 / 敏感带 / 初次区块要同步刷新
    await refreshData({ withProfile: true })
  } catch (err) {
    notify(err?.message || '采纳提议失败', 'error')
  } finally {
    suggestionBusy.value = ''
  }
}

async function onRejectSuggestion(row) {
  const id = props.character?.id
  if (!id || suggestionBusy.value) return
  suggestionBusy.value = row.id
  try {
    await rejectIntimateSuggestion(id, row.id)
    suggestions.value = suggestions.value.filter(s => s.id !== row.id)
    notify(`已忽略「${row.fieldLabel}」的提议`, 'info')
  } catch (err) {
    notify(err?.message || '忽略提议失败', 'error')
  } finally {
    suggestionBusy.value = ''
  }
}

// ── 初次 / 破处 ──
function todayStr() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function putFirst(row, firstAt) {
  const id = props.character?.id
  if (!id) return
  try {
    await setIntimateFirst(id, row.actKey, { firstAt, note: row.note || '' })
    const source = firstAt ? 'manual' : ''
    row.firstAt = firstAt || ''
    row.source = source
    row.manual = !!firstAt
    const entry = { actKey: row.actKey, label: row.label, firstAt: firstAt || null, note: row.note || '', source }
    const idx = rawFirsts.value.findIndex(f => String(f?.actKey || '') === String(row.actKey))
    if (idx >= 0) rawFirsts.value[idx] = { ...rawFirsts.value[idx], ...entry }
    else if (firstAt) rawFirsts.value = [...rawFirsts.value, entry]
  } catch (err) {
    notify(err?.message || '初次信息保存失败', 'error')
  }
}

function onFirstToggle(row, checked) {
  putFirst(row, checked ? (toDateInput(row.firstAt) || todayStr()) : null)
}

function onFirstDate(row, value) {
  putFirst(row, fromDateInput(value))
}

// ── 回填 ──
let backfillTimer = null
let autoBackfillTried = false

function stopBackfillPolling() {
  if (backfillTimer) {
    clearInterval(backfillTimer)
    backfillTimer = null
  }
}

function startBackfillPolling() {
  if (backfillTimer) return
  backfillTimer = setInterval(async () => {
    const id = props.character?.id
    if (!id) {
      stopBackfillPolling()
      return
    }
    try {
      backfill.value = normalizeBackfill(await getIntimateBackfill(id))
      if (backfill.value.status !== BACKFILL_STATUS.running) {
        stopBackfillPolling()
        await refreshData()
      }
    } catch {
      stopBackfillPolling()
    }
  }, BACKFILL_POLL)
}

async function startBackfill() {
  const id = props.character?.id
  if (!id || backfillBusy.value) return
  backfillBusy.value = true
  backfillError.value = ''
  try {
    const res = await startIntimateBackfill(id)
    backfill.value = normalizeBackfill(res?.backfill || res)
    backfillPlaceholder.value = res?.placeholder === true
    if (backfill.value.status === BACKFILL_STATUS.running) startBackfillPolling()
    else await refreshData()
  } catch (err) {
    // 功能总开关关闭时是 409，错误文案已由 api 层转成中文
    backfillError.value = err?.message || '历史回填启动失败'
    notify(backfillError.value, 'warning')
  } finally {
    backfillBusy.value = false
  }
}

async function onBackfillEnabledChange(value) {
  await saveSettings({ backfillEnabled: !!value })
  if (value && backfill.value.status === BACKFILL_STATUS.idle) await startBackfill()
}

/** 开关打开且后端还是 idle 时，自动补一次回填（只尝试一次） */
function maybeAutoBackfill() {
  if (autoBackfillTried) return
  autoBackfillTried = true
  if (backfillEnabled.value && backfill.value.status === BACKFILL_STATUS.idle) startBackfill()
}

// ── 流水：人工补录 / 删除 ──
async function submitManual() {
  const id = props.character?.id
  if (!id || !manual.actKey || manualSaving.value) return
  manualSaving.value = true
  try {
    await createIntimateLog(id, {
      actKey: manual.actKey,
      positionKey: manual.positionKey || undefined,
      count: Number(manual.count) || 1,
      climaxCount: Number(manual.climaxCount) || 0,
    })
    notify('已补录一条流水', 'success')
    manual.actKey = ''
    manual.positionKey = ''
    manual.count = 1
    manual.climaxCount = 0
    manualOpen.value = false
    await refreshData()
    await loadLogs(true)
  } catch (err) {
    notify(err?.message || '人工补录失败', 'error')
  } finally {
    manualSaving.value = false
  }
}

async function onDeleteLog(row) {
  const id = props.character?.id
  if (!id) return
  if (typeof confirmFn === 'function') {
    const ok = await confirmFn({
      title: '删除流水',
      message: `确定删除「${row.text.actLabel}」这条记录吗？删除后统计会同步回落。`,
      okText: '删除',
    })
    if (!ok) return
  }
  try {
    await deleteIntimateLog(id, row.id)
    logs.value = logs.value.filter(l => l.id !== row.id)
    notify('已删除该条流水', 'success')
    await refreshData()
  } catch (err) {
    notify(err?.message || '删除流水失败', 'error')
  }
}

// ── 生命周期 ──
// 每日配额是全局的：随组件挂载读一次即可，不必跟着换角色重复打 /api/config
onMounted(() => { refreshAiJudgeQuota() })

watch(() => props.character?.id, (id, old) => {
  if (!id || id === old) return
  pendingPatch = {}
  clearTimeout(profileTimer)
  clearTimeout(zonesTimer)
  zonesDirty = false
  stopBackfillPolling()
  autoBackfillTried = false
  backfillError.value = ''
  backfillPlaceholder.value = false
  // 换角色：清掉上一个角色的 AI 整理状态，避免串号
  suggestions.value = []
  aiEditNotice.value = ''
  aiEditBusy.value = false
  suggestionBusy.value = ''
  aiJudgeSaving.value = false
  aiJudgeBusy.value = false
  aiJudgeQuotaSaving.value = false
  loaded.value = false
  loadAll()
}, { immediate: true })

onBeforeUnmount(() => {
  // 关窗即落库：把还没到防抖时间的改动补发出去
  clearTimeout(profileTimer)
  clearTimeout(zonesTimer)
  const id = props.character?.id
  if (id && Object.keys(pendingPatch).length) {
    saveIntimateProfile(id, pendingPatch).catch(() => {})
  }
  if (id && zonesDirty) {
    saveIntimateProfile(id, { sensitiveZones: zonesForSave(zones.value) }).catch(() => {})
  }
  stopBackfillPolling()
})
</script>

<style scoped>
/* 色值一律走 tokens.css，暖色 / 暗夜两套主题自动联动；不出现硬编码色值。 */
.ip {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  color: var(--text-primary);
}

/* ── 骨架 ── */
.ip-skeleton { display: flex; flex-direction: column; gap: 12px; }
.ip-sk-row { height: 58px; border-radius: var(--radius-md); }
.skeleton {
  background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-hover) 37%, var(--bg-tertiary) 63%);
  background-size: 400% 100%;
  animation: ip-shimmer 1.4s ease infinite;
}
@keyframes ip-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

/* ── 提示条 ── */
.ip-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  font-size: var(--fs-sm);
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
}
.ip-banner-error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }

/* ── 顶部知晓开关 ── */
.ip-hero {
  display: flex;
  gap: 12px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent-4) 8%, var(--bg-secondary));
  transition: background-color 0.3s var(--ease-standard), border-color 0.3s var(--ease-standard);
}
.ip-hero-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  color: var(--accent-4);
  background: color-mix(in srgb, var(--accent-4) 16%, transparent);
}
.ip-hero-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.ip-hero-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ip-hero-label { font-size: var(--fs-md); font-weight: 700; }
.ip-hero-desc { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }

/* ── 区块 ── */
.ip-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.ip-sec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ip-sec-title { margin: 0; font-size: var(--fs-md); font-weight: 700; letter-spacing: 0.3px; }
.ip-sec-hint { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-chips { display: flex; flex-wrap: wrap; gap: 8px; }

/* ── 身体信息 ── */
.ip-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ip-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.ip-field-full { margin-top: 10px; }
.ip-field-label { font-size: var(--fs-sm); color: var(--text-secondary); }

/* ── 初次 / 破处 ── */
.ip-first-list { display: flex; flex-direction: column; gap: 6px; }
.ip-first-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 150px auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  transition: background-color 0.3s var(--ease-standard);
}
.ip-first-row:hover { background: var(--bg-hover); }
.ip-first-label { font-size: var(--fs-base); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 标签 ── */
.ip-tag {
  justify-self: start;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.ip-tag.is-manual { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.ip-tag.is-auto { background: color-mix(in srgb, var(--accent-3) 16%, transparent); color: var(--accent-3); }
.ip-tag.is-empty { opacity: 0.72; }

/* ── 基础统计 ── */
.ip-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.ip-summary-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}
.ip-summary-label { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-summary-value { font-size: var(--fs-lg); font-weight: 700; color: var(--accent); }
.ip-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.ip-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  min-width: 0;
}
.ip-stat-label { font-size: var(--fs-base); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ip-stat-value { font-size: var(--fs-md); font-weight: 700; color: var(--accent); flex-shrink: 0; }
.ip-stat-sub { font-size: var(--fs-xs); font-style: normal; font-weight: 500; color: var(--text-secondary); margin-left: 3px; }

/* ── 部位敏感度 ── */
.ip-zone-list { display: flex; flex-direction: column; gap: 8px; }
.ip-zone {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
}
.ip-zone-name { min-width: 0; }
.ip-zone-level { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ip-zone-level-text { font-size: var(--fs-xs); color: var(--text-secondary); flex-shrink: 0; width: 4em; }
.ip-zone-band {
  grid-column: 1 / -1;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  overflow: hidden;
}
.ip-zone-band-fill { display: block; height: 100%; border-radius: var(--radius-full); transition: width 0.3s var(--ease-standard), background-color 0.3s var(--ease-standard); }
.ip-add-btn { align-self: flex-start; }

/* ── 体位排行 ── */
.ip-rank-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ip-rank-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) minmax(60px, 1.4fr) 42px; align-items: center; gap: 10px; }
.ip-rank-no {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  font-weight: 700;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.ip-rank-no.is-top { background: color-mix(in srgb, var(--fun-gold) 22%, transparent); color: var(--fun-gold); }
.ip-rank-label { font-size: var(--fs-base); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ip-rank-track { height: 8px; border-radius: var(--radius-full); background: var(--bg-sunken); overflow: hidden; }
.ip-rank-fill { display: block; height: 100%; border-radius: var(--radius-full); background: var(--accent); transition: width 0.3s var(--ease-standard); }
.ip-rank-count { font-size: var(--fs-sm); font-weight: 700; color: var(--accent); text-align: right; }

/* ── AI 修改权限 ── */
.ip-perm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ip-perm-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  min-width: 0;
}
.ip-perm-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ip-perm-label { font-size: var(--fs-base); font-weight: 600; }
.ip-perm-desc { font-size: var(--fs-xs); color: var(--text-secondary); }

/* ── AI 判断行为：每日判定上限输入框（0 = 不限制） ── */
.ip-quota-input { width: 96px; flex-shrink: 0; }

/* ── 让 AI 整理档案（入口 + 待确认提议） ── */
.ip-ai-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ip-ai-tip { font-size: var(--fs-xs); color: var(--text-secondary); min-width: 0; }
.ip-sug-head { display: flex; align-items: center; gap: 8px; }
.ip-sug-title { font-size: var(--fs-base); font-weight: 600; }
.ip-sug-list { display: flex; flex-direction: column; gap: 8px; }
.ip-sug-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--bg-sunken);
  flex-wrap: wrap;
  transition: border-color 0.3s var(--ease-standard), background-color 0.3s var(--ease-standard);
}
.ip-sug-row:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.ip-sug-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.ip-sug-field { font-size: var(--fs-sm); font-weight: 700; color: var(--accent); }
.ip-sug-values { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.ip-sug-current { font-size: var(--fs-xs); color: var(--text-secondary); text-decoration: line-through; }
.ip-sug-arrow { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-sug-next { font-size: var(--fs-base); font-weight: 600; word-break: break-word; }
.ip-sug-reason { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-sug-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* ── 历史回填 ── */
.ip-backfill { display: flex; flex-direction: column; gap: 10px; }
.ip-backfill-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ip-backfill-label { font-size: var(--fs-base); }
.ip-backfill-progress { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ip-backfill-status { font-size: var(--fs-base); font-weight: 600; }
.ip-backfill-count { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-note { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-note-warn { color: var(--warning); }

/* ── 流水明细 ── */
.ip-log-list { display: flex; flex-direction: column; gap: 6px; }
.ip-log-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-sunken);
  flex-wrap: wrap;
}
.ip-log-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ip-log-act { font-size: var(--fs-base); font-weight: 600; }
.ip-log-pos { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-log-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ip-log-count { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-log-time { font-size: var(--fs-xs); color: var(--text-secondary); }
.ip-log-actions { display: flex; gap: 8px; flex-wrap: wrap; }

/* ── 人工补录 ── */
.ip-manual { display: flex; flex-direction: column; gap: 10px; padding: 10px; border-radius: var(--radius-md); border: 1px dashed var(--border-strong); }
.ip-manual-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.ip-manual-actions { display: flex; justify-content: flex-end; }

.ip-empty { margin: 0; padding: 10px 0; font-size: var(--fs-sm); color: var(--text-secondary); text-align: center; }

/* 区块内列表的淡入（0.3s），切换口径 / 重算统计时不生硬跳变 */
.ip-fade-enter-active, .ip-fade-leave-active { transition: opacity 0.3s var(--ease-standard); }
.ip-fade-enter-from, .ip-fade-leave-to { opacity: 0; }

/* 人工补录区展开 */
.ip-drop-enter-active, .ip-drop-leave-active { transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.ip-drop-enter-from, .ip-drop-leave-to { opacity: 0; transform: translateY(-4px); }

/* ── 移动端：全部单列，不溢出 ── */
@media (max-width: 767px) {
  .ip-grid,
  .ip-stat-grid,
  .ip-perm-grid,
  .ip-manual-grid { grid-template-columns: minmax(0, 1fr); }
  .ip-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /* 初次信息：第一行 开关 + 名称 + 标记，日期整行铺开 */
  .ip-first-row { grid-template-columns: auto minmax(0, 1fr) auto; }
  .ip-first-row > .ip-first-toggle { grid-column: 1; grid-row: 1; }
  .ip-first-label { grid-column: 2; grid-row: 1; }
  .ip-first-date { grid-column: 1 / -1; grid-row: 2; }
  .ip-first-row > .ip-tag { grid-column: 3; grid-row: 1; justify-self: end; }
  /* 部位敏感度：名称 + 删除一行，滑杆一行，色带一行 */
  .ip-zone { grid-template-columns: minmax(0, 1fr) auto; }
  .ip-zone-name { grid-column: 1; grid-row: 1; }
  .ip-zone-del { grid-column: 2; grid-row: 1; justify-self: end; }
  .ip-zone-level { grid-column: 1 / -1; grid-row: 2; }
  .ip-zone-band { grid-column: 1 / -1; grid-row: 3; }
  /* 体位排行：名次 / 名称 / 次数一行，条形图整行 */
  .ip-rank-row { grid-template-columns: 24px minmax(0, 1fr) 40px; }
  .ip-rank-no { grid-column: 1; grid-row: 1; }
  .ip-rank-label { grid-column: 2; grid-row: 1; }
  .ip-rank-count { grid-column: 3; grid-row: 1; }
  .ip-rank-track { grid-column: 1 / -1; grid-row: 2; }
  /* AI 整理档案：按钮整行、提议行上下排布 */
  .ip-ai-row { align-items: stretch; }
  .ip-ai-btn { width: 100%; }
  .ip-sug-row { flex-direction: column; align-items: stretch; }
  .ip-sug-actions { justify-content: flex-end; }
  .ip-sug-actions > * { flex: 1; }
  .ip-hero { padding: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .ip-fade-enter-active, .ip-fade-leave-active,
  .ip-drop-enter-active, .ip-drop-leave-active,
  .ip-zone-band-fill, .ip-rank-fill { transition: none; }
  .skeleton { animation: none; }
}
</style>
