<template>
  <!--
    玩具面板（用户要求：玩具要有**独立按钮模块**，不再塞在动作面板里）。
    视觉完全复用 Linshe：LinsheModal 外壳 + LinsheButton / LinsheTabs / LinsheSwitch / LinsheSelect，不引入新体系。
    门控口径：**服务端 gate 说了算** —— 能不能装读 gate.allowed，被拒 toast 服务端那句；
    前端不许自己算门槛（好感 / 催眠 / 睡着都在后端）。

    2026-10-02 玩法扩充（用户原话「玩具玩法有点太少了」）：
      · 背包 = 服务端 `catalog`（11 件）；多件可同时戴，互不影响（一件一行，各自调档/模式/曲线/摘下）；
      · 每件已戴玩具：**实时状态**（此刻档位 / 模式 / 曲线剩余）+ 模式分段选择 + 强度曲线开关；
      · 「她自己」一栏：显示服务端给她的主动判定，并提供「逗她一下」（**只加分，不越过她的意愿**）；
      · 面板**自包含**：只要拿得到角色 id（props 或聊天 store），自己取数、自己轮询（4 秒 tick，
        曲线/档位随时间变），不依赖父组件的刷新节奏（父组件那三条 emit 依旧保留，兼容既有接线）。
  -->
  <linshe-modal :model-value="open" title="玩具" @update:model-value="onModalToggle">
    <div class="toy-panel">
      <template v-if="wornList.length">
        <div class="toy-panel__head">
          她正戴着
          <span class="toy-panel__count">{{ wornList.length }} 件</span>
        </div>
        <p v-if="comboText" class="toy-combo">{{ comboText }}</p>
        <ul class="toy-worn-list">
          <li v-for="toy in wornList" :key="toy.toyKey" class="toy-worn-item">
            <div class="toy-worn-line">
              <span class="toy-worn-name">{{ labelOf(toy.toyKey) }}</span>
              <span class="toy-worn-part">{{ partOf(toy.toyKey) }}</span>
              <span class="toy-worn-intensity">{{ statusOf(toy) }}</span>
              <span v-if="hasIntensity(toy.toyKey)" class="toy-worn-bump">
                <linshe-button
                  variant="chip" size="sm" aria-label="降低强度" title="降低强度"
                  :disabled="(Number(toy.intensity) || 0) <= 0 || busyKey === toy.toyKey"
                  @click="bumpIntensity(toy, -1)"
                >−</linshe-button>
                <linshe-button
                  variant="chip" size="sm" aria-label="提高强度" title="提高强度"
                  :disabled="(Number(toy.intensity) || 0) >= maxOf(toy.toyKey) || busyKey === toy.toyKey"
                  @click="bumpIntensity(toy, 1)"
                >＋</linshe-button>
              </span>
              <linshe-button variant="link" size="sm" :disabled="busyKey === toy.toyKey" @click="unequipToy(toy.toyKey)">摘下</linshe-button>
            </div>
            <div class="toy-worn-line toy-worn-line--play">
              <span class="toy-play-label">模式</span>
              <linshe-tabs
                class="toy-mode-tabs"
                size="sm"
                :model-value="toy.mode || 'steady'"
                :options="modeOptions"
                :disabled="busyKey === toy.toyKey"
                @update:model-value="value => setMode(toy, value)"
              />
            </div>
            <div class="toy-worn-line toy-worn-line--play">
              <linshe-switch
                class="toy-curve-switch"
                size="sm"
                :model-value="hasCurve(toy)"
                :disabled="busyKey === toy.toyKey"
                on-text="强度曲线"
                off-text="强度曲线"
                title="打开后档位会随时间自动升降"
                @change="value => toggleCurve(toy, value)"
              />
              <template v-if="hasCurve(toy)">
                <linshe-select
                  class="toy-curve-type"
                  size="sm"
                  :model-value="toy.curve.type"
                  :options="curveOptions"
                  :disabled="busyKey === toy.toyKey"
                  aria-label="曲线类型"
                  @update:model-value="value => setCurveType(toy, value)"
                />
                <linshe-tabs
                  class="toy-curve-duration"
                  size="sm"
                  :model-value="durationOf(toy)"
                  :options="durationOptions"
                  :disabled="busyKey === toy.toyKey"
                  @update:model-value="value => setCurveDuration(toy, value)"
                />
              </template>
              <span v-if="remainingOf(toy)" class="toy-curve-remain">{{ remainingOf(toy) }}</span>
            </div>
          </li>
        </ul>
      </template>
      <p v-else class="toy-worn-empty">还没给她戴上任何玩具 —— 从下面挑一件吧</p>

      <div class="toy-panel__head">她自己</div>
      <div class="toy-self">
        <div class="toy-self-text">
          {{ selfPlayLine }}
          <span v-if="lastSelfPlayText" class="toy-self-last">{{ lastSelfPlayText }}</span>
        </div>
        <linshe-button
          variant="chip" size="sm"
          :disabled="selfPlayBusy || !activeCharId"
          title="逗她一下：只是给她加一点念头，她自己决定要不要动手"
          @click="onEncourage"
        >逗她一下</linshe-button>
      </div>

      <div class="toy-panel__head">背包里的玩具</div>
      <!-- 玩法说明（2026-10-02，规划 §二）：每件玩具的 desc/effect 是给模型看的，
           用户看不到就等于不知道这套玩具能干嘛 ⇒ 面板里要有一段"怎么玩"。默认收起。 -->
      <div class="toy-guide">
        <linshe-button variant="link" size="sm" @click="toggleGuide">
          {{ showGuide ? '收起玩法说明' : '玩法说明：这套玩具怎么玩？' }}
        </linshe-button>
        <Transition name="toy-guide-fade">
          <div v-if="showGuide" class="toy-guide-body">
            <p><b>怎么戴 / 怎么摘</b>：从下面的背包点一件就戴上了；戴上之后她自己取不下来，要摘只能你点「摘下」。可以同时戴多件。</p>
            <p><b>强度档位</b>：每件上限不同（跳蛋 5 档、肛塞 3 档；项圈是象征物，没有档位）。档位越高刺激越强，她越难维持正常说话。</p>
            <p><b>振动模式（管节奏）</b>：持续＝一直同强度；脉冲＝一阵一阵；渐变＝慢慢起落；随机＝她猜不到下一拍。模式改的是节奏，不是强度。</p>
            <p><b>强度曲线（管档位随时间变）</b>：打开后档位按曲线自己走 —— 渐强一路推上去、渐弱慢慢退、起伏来回磨、冲刺直接顶到上限；所以你会看到「还剩…」在倒计时、强度自己变。</p>
            <p><b>组合佩戴</b>：同时戴多件会成立组合效果（双穴、上下两点、多点齐震…），叠到过载她会明显吃不消 —— 面板会写「同时成立：…」。</p>
            <p><b>她自己也会玩</b>：关系够近、够淫乱又独处时，她可能自己戴上一件（甚至偷偷用不让你发现）。「她自己」那一栏显示状态，也可以「逗她一下」推一把。</p>
          </div>
        </Transition>
      </div>
      <!-- 戴上前选档位（2026-10-02）：一件一件加、也可以同时多件戴；戴上后仍可随时 ± 调 -->
      <div class="toy-equip-level">
        <span class="toy-equip-level-label">戴上前选档位</span>
        <linshe-tabs v-model="equipLevel" size="sm" :options="EQUIP_LEVEL_OPTIONS" />
        <span class="toy-equip-level-hint">戴上后也能随时用 ± 调档</span>
      </div>
      <!-- 批量装卸（2026-10-04 用户：「玩具不能批量装卸 还得一个个点 比较麻烦 这个也加上」）。
           走 `api.batchToys` 的**静默**端点：只改穿戴状态 + 服务端广播一次 `toys_batch_changed`，
           **不逐件产 LLM 反应** —— 用户要的就是"别一个个点"；逐件调模型会把面板刷爆、还白烧额度。
           要与她互动（带反应消息）就继续用下面背包里的单件按钮，那条链一字未改。 -->
      <div class="toy-batch-row">
        <linshe-button
          variant="chip" size="sm"
          :loading="batchBusy" :disabled="batchBusy || !batchEquipCount"
          title="把背包里还没戴上的全部戴上（不产反应，纯操作）"
          @click="batchEquipAll"
        >全部戴上{{ batchEquipCount ? '（' + batchEquipCount + ' 件）' : '' }}</linshe-button>
        <linshe-button
          variant="chip" size="sm"
          :loading="batchBusy" :disabled="batchBusy || !wornList.length"
          title="把当前戴着的全部摘下（不产反应，纯操作）"
          @click="batchRemoveAll"
        >全部摘下{{ wornList.length ? '（' + wornList.length + ' 件）' : '' }}</linshe-button>
      </div>
      <div class="toy-backpack-grid">
        <linshe-button
          v-for="toy in toyList"
          :key="toy.key || toy.toyKey"
          variant="chip"
          size="sm"
          :active="isWorn(toy.key || toy.toyKey)"
          :disabled="isWorn(toy.key || toy.toyKey)"
          :title="gateMessage(toy)"
          :aria-disabled="toy.gate && toy.gate.allowed === false ? 'true' : undefined"
          @click="equipFromBackpack(toy)"
        >{{ labelOf(toy.key || toy.toyKey) }} · {{ partOf(toy.key || toy.toyKey) }} · {{ intensityCapText(toy) }}</linshe-button>
      </div>
      <p v-if="catalogNote" class="toy-note">{{ catalogNote }}</p>
    </div>
  </linshe-modal>
</template>

<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import LinsheModal from './ui/LinsheModal.vue'
import LinsheButton from './ui/LinsheButton.vue'
import LinsheTabs from './ui/LinsheTabs.vue'
import LinsheSwitch from './ui/LinsheSwitch.vue'
import LinsheSelect from './ui/LinsheSelect.vue'
import { useChatStore } from '../stores/chat.js'
import { onEvent, offEvent } from '../stores/unifiedStream.js'
import * as api from '../api/index.js'
import {
  TOYS, VIBRATION_MODES, INTENSITY_CURVES, CURVE_DURATIONS, DEFAULT_CURVE_DURATION,
  clampIntensity, comboSummaryText, curveLabelOf, getToy, hasIntensity, intensityLabel, intensityCapText,
  listAllToys, liveIntensityOf, modeLabelOf, remainingText, selfPlayText, toyLabelOf, toyPartOf, wornStatusText,
} from './toyLogic.js'

/** 玩法说明的展开态（2026-10-02，规划 §二）：默认收起，点标题展开。
 *  放在 import 块**之后**（别插在 import 之间）；用**具名函数**而不是模板内联赋值 ——
 *  面板的守卫测试会逐个检查"模板里调用的处理函数真的存在"。 */
const showGuide = ref(false)
function toggleGuide() { showGuide.value = !showGuide.value }

/** 戴上前选的档位（2026-10-02 用户：「玩具只能一档一档的加 加入档位随时可调 而且可以同时多个或者单个穿戴」）
 *  —— 默认 1 档；先挑好再戴上，戴上之后照样能随时用 ± 调（那条走 emit 给父组件，是旧契约）。 */
const equipLevel = ref(1)
const EQUIP_LEVEL_OPTIONS = [1, 2, 3, 4, 5].map(v => ({ label: v + ' 档', value: v }))

const props = defineProps({
  /** 受控显隐（父组件持有 showToyPanel） */
  open: { type: Boolean, default: false },
  /** 已戴玩具（服务端下发）：[{ toyKey, intensity, equippedAt, gate? }] */
  wornToys: { type: Array, default: () => [] },
  /** 背包可选项（服务端下发；缺省回落前端镜像，gate 默认放行） */
  toyOptions: { type: Array, default: () => [] },
  /** 角色 id（不传就从聊天 store 取当前角色 —— 面板自己取数，保证"打开就能用"） */
  characterId: { type: [Number, String], default: null },
  /**
   * 场景（2026-10-03 群聊 bug）：群聊里必须传 `scene="group"` + `:group-id`，
   * 否则她的反应会写到私聊去（「在哪里聊天就在哪里继续进行」）。
   * **默认 'chat'** ⇒ 私聊那份接线一字未改（请求体逐字节不变）。
   */
  scene: { type: String, default: 'chat' },
  /** 群 id（`scene='group'` 时必传；服务端据此校验"群存在 + 她是成员"并写 `group_<gid>`） */
  groupId: { type: [Number, String], default: null },
})

const emit = defineEmits(['close', 'toy-equip', 'toy-intensity', 'toy-remove', 'toy-batch-done'])

/**
 * 场景参数：面板**每一个**请求都要带上（装 / 调 / 摘 / 模式 / 曲线 / tick / 她自己玩 / 取清单），
 * 一处写清、处处透传。私聊返回空对象 ⇒ 请求与改造前逐字节一致（老接线零影响）。
 *
 * ⚠️ 群 id 还没拿到时**仍然声明 `scene:'group'`**（只是不带 groupId）：服务端会回 400 + 人话，
 * 而绝不会像"什么都不传"那样**悄悄按私聊写进 `char_<id>`** —— 那正是这次 bug 的形态。
 * groupId 判空用 undefined/null/''（0 是合法群 id，不能被假值判断吃掉 —— 同 fetchTouchState）。
 */
const sceneOpts = computed(() => {
  if (props.scene !== 'group') return {}
  const groupId = props.groupId
  if (groupId === undefined || groupId === null || groupId === '') return { scene: 'group' }
  return { scene: 'group', groupId }
})

const toastFn = inject('toast', null)
const chat = useChatStore()

/** 面板自己的服务端状态（worn/catalog/combos/selfPlay）；父组件的 props 只作回落 */
const server = ref(null)
const liveWorn = ref([])
/**
 * 服务端**给过** wearing 清单了吗（哪怕是空数组也算给过）。
 *
 * ⚠️ 为什么需要这个标志：`wornList` 原来用 `liveWorn.value.length` 判断"服务端有没有给数据"，
 * 而**空数组是 falsy** ⇒ "她身上一件都没有"这个**有效状态**没法表达，会掉进 props 回落分支，
 * 拿着父组件的**旧清单**不放。
 *
 * 2026-10-04 真机复现（用户点「全部摘下」）：后端 `POST /toys/batch` 回了
 * `{"applied":["collar","vibe_egg"],"worn":[]}`、随后的 `GET /toys` 也是 `worn: []`，
 * 但面板从 +400ms 到 +8000ms 一直显示「项圈 / 跳蛋 / 2 件」——**服务端说摘光了，UI 死抱旧数据**。
 *
 * 为什么以前没暴露：单件摘下时 `liveWorn` 至少还剩 1 件（非空）⇒ 走服务端分支 ⇒ 正常；
 * **只有"一次全摘光"才会掉进回落分支**，而批量装卸是第一个能一次摘光的入口。
 */
const serverWornReady = ref(false)
const busyKey = ref('')
const selfPlayBusy = ref(false)
const activeCharId = computed(() => props.characterId || chat.activeCharId || null)

const modeOptions = VIBRATION_MODES.map(m => ({ label: m.label, value: m.value, title: m.desc }))
const curveOptions = INTENSITY_CURVES.map(c => ({ label: c.label, value: c.value, title: c.desc }))
const durationOptions = CURVE_DURATIONS.map(s => ({ label: (s / 60) + ' 分钟', value: s }))

/** 背包清单：服务端 catalog > 父组件下发的 available > 前端镜像 */
const toyList = computed(() => {
  const catalog = server.value && server.value.catalog
  if (Array.isArray(catalog) && catalog.length) return catalog
  if (props.toyOptions && props.toyOptions.length) return props.toyOptions
  // 2026-10-01：镜像项统一补齐 `toyKey`（真机出现过 key 拿不到 ⇒
  // `POST /toys/undefined/equip`，现在 api 层有闸门、这里保证形状本身也对）
  return listAllToys().map(t => ({ ...t, toyKey: t.toyKey || t.key, gate: { allowed: true } }))
})

/**
 * 已戴清单：服务端（带实时档位/模式/曲线）优先，**服务端没答复过**才用父组件那份。
 *
 * ⚠️ 判据必须是 `serverWornReady`，**不能**是 `liveWorn.value.length` —— 见上面那个 ref 的注释：
 * 空数组是「她一件都没戴」的**有效答案**，不是「还没拿到答案」。
 */
const wornList = computed(() => {
  if (serverWornReady.value) return liveWorn.value
  return Array.isArray(props.wornToys) ? props.wornToys : []
})

const comboText = computed(() => comboSummaryText(server.value && server.value.combos))
const catalogNote = computed(() => {
  const list = toyList.value
  if (!list.length) return ''
  const locked = list.filter(t => t.gate && t.gate.allowed === false).length
  return locked > 0 ? (locked + ' 件现在还不行（好感 / 授权 / 群聊开关由服务端判定，鼠标悬停看原因）') : ''
})
const selfPlayLine = computed(() => selfPlayText(server.value && server.value.selfPlay && server.value.selfPlay.decision))
const lastSelfPlayText = computed(() => {
  const last = server.value && server.value.selfPlay && server.value.selfPlay.last
  if (!last) return ''
  const ago = Number(last.minutesAgo) || 0
  return '（' + ago + ' 分钟前她自己用过：' + (last.label || last.toyKey) + (last.secret ? '，没让你发现' : '') + '）'
})

function metaOf(toyKey) {
  // 解析统一走镜像的 getToy（TOYS + EXTRA_TOYS 合并表）。
  // ⚠️ 这里曾经自己写 `listAllToys().find(t => t.toyKey === toyKey)` —— 记录字段其实叫 `key`，
  //    第二批 6 件永远找不到 ⇒ 面板显示英文键名（用户截图 `clit_sucker · · 最多 5 档`）。
  return getToy(String(toyKey ?? ''))
}
function labelOf(toyKey) {
  return toyLabelOf(toyKey)
}
function partOf(toyKey) {
  return toyPartOf(toyKey)
}
function maxOf(toyKey) {
  const m = metaOf(toyKey)
  return m ? m.maxIntensity : 0
}
function isWorn(toyKey) {
  return wornList.value.some(t => t.toyKey === toyKey)
}
function statusOf(toy) {
  return wornStatusText(toy)
}
function hasCurve(toy) {
  return Boolean(toy && toy.curve)
}
function durationOf(toy) {
  const sec = toy && toy.curve ? Number(toy.curve.durationSec) : 0
  return CURVE_DURATIONS.includes(sec) ? sec : DEFAULT_CURVE_DURATION
}
function remainingOf(toy) {
  return remainingText(toy)
}
/** 能装不能装：**只看服务端 gate**；被拒就把服务端那句原样 toast 出去 */
function gateMessage(toy) {
  const g = toy && toy.gate
  if (g && g.allowed === false) return g.message || '现在还不行'
  const m = metaOf(toy.key || toy.toyKey)
  return labelOf(toy.key || toy.toyKey) + '（' + partOf(toy.key || toy.toyKey) + '）' + (m && m.effect ? '：' + m.effect : '')
}
function onModalToggle(v) {
  if (!v) emit('close')
}

// ── 取数：面板自包含（打开就拉一次 + 每 4 秒 tick 一次看曲线推进）──────────────

/**
 * 把服务端的一份载荷并进面板状态。
 *
 * ⚠️ `payload.worn` 是数组（**含空数组**）就表示"服务端给了权威答案" ⇒ 立 `serverWornReady`，
 * 让 `wornList` 认这份（空也认）。不这样做的后果见 `serverWornReady` 的注释。
 */
function adopt(payload) {
  if (!payload) return
  server.value = { ...(server.value || {}), ...payload }
  if (Array.isArray(payload.worn)) {
    liveWorn.value = payload.worn
    serverWornReady.value = true
  }
}

async function refresh() {
  const id = activeCharId.value
  if (!id) { server.value = null; liveWorn.value = []; serverWornReady.value = false; return }
  try {
    // 场景要带上：群聊口径下服务端逐件给的是**群里**的门控结论（群聊成人开关关着 = allowed:false）
    const res = await api.fetchToys(id, sceneOpts.value)
    if (activeCharId.value !== id) return
    if (res && res.unlocked === true) adopt(res)
    else { server.value = null; liveWorn.value = []; serverWornReady.value = false }
  } catch (err) {
    // 取数失败：退回父组件那份（面板不能因此变白）
    server.value = null
    liveWorn.value = []
    serverWornReady.value = false
  }
}

/** 轮询用轻量 tick：返回 worn（实时档位）+ combos + 她的主动判定预览 */
async function pollTick() {
  const id = activeCharId.value
  if (!id || !props.open) return
  try {
    const res = await api.tickToys(id, sceneOpts.value)
    if (activeCharId.value !== id || !res || res.ok !== true) return
    adopt({ worn: res.worn, combos: res.combos, selfPlay: res.selfPlay, transitions: res.transitions })
  } catch (err) { /* 轮询失败不打断面板 */ }
}

let timer = null
function startPolling() {
  if (timer) return
  timer = setInterval(pollTick, 4000)
}
function stopPolling() {
  if (timer) { clearInterval(timer); timer = null }
}

let refreshTimer = null
function refreshSoon(delay = 700) {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh() }, delay)
}

watch(() => props.open, (v) => {
  if (v) { refresh(); startPolling() } else stopPolling()
}, { immediate: true })
watch(activeCharId, () => { if (props.open) refresh() })
// 换群（或场景变了）也要重取：门控是**按场景**算的（群聊成人开关关着时每件 allowed:false），
// 不重取就会拿着上一个群/私聊的结论继续显示（2026-10-03 群聊 bug 的同一批口径）。
watch([() => props.scene, () => props.groupId], () => { if (props.open) refresh() })
// 父组件（ChatView）装/摘成功后会给新的 wornToys：结构变了就再取一次服务端真值
watch(() => props.wornToys, (list) => {
  if (!props.open) return
  const next = (Array.isArray(list) ? list : []).map(t => t.toyKey).sort().join(',')
  const now = liveWorn.value.map(t => t.toyKey).sort().join(',')
  if (next !== now) refresh()
}, { deep: true })
onBeforeUnmount(() => {
  stopPolling()
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
})

/**
 * 批量装卸的 SSE 广播（2026-10-04）—— 后端 `POST /:id/toys/batch` 是**静默操作**
 * （不逐件产反应消息 ⇒ 没有别的东西会把这件事件在 UI 上带出来），所以它只能靠这条广播。
 *
 * 场景：PC 与手机同时开着（启动器首页就给手机访问地址），一边批量操作，另一边要跟着更新。
 * 按 `characterId` 过滤 —— 别的角色的事件不许刷本面板（与 IntimateActionPanel 同一口径）。
 */
function onToysBatchChanged(payload) {
  const id = activeCharId.value
  if (!id) return
  const evId = payload?.characterId
  if (evId !== undefined && evId !== null && Number(evId) !== Number(id)) return
  refreshSoon(0)
}
onMounted(() => onEvent('toys_batch_changed', onToysBatchChanged))
onBeforeUnmount(() => offEvent('toys_batch_changed', onToysBatchChanged))

// ── 操作 ─────────────────────────────────────────────────────────────────────

/** 服务端返回的已戴玩具（带实时档位）直接并回本地状态，不必等下一次轮询 */
function applyToyUpdate(toy) {
  if (!toy || !toy.toyKey) return
  const others = liveWorn.value.filter(t => t.toyKey !== toy.toyKey)
  liveWorn.value = toy.status === 'worn' ? [...others, toy] : others
}

function bumpIntensity(toy, delta) {
  if (!hasIntensity(toy.toyKey)) return
  const next = clampIntensity(toy.toyKey, (Number(toy.intensity) || 0) + delta)
  if (next === (Number(toy.intensity) || 0)) return
  emit('toy-intensity', { toyKey: toy.toyKey, intensity: next })
  refreshSoon()
}
function unequipToy(toyKey) {
  emit('toy-remove', toyKey)
  refreshSoon()
}
function equipFromBackpack(toy) {
  const key = toy.key || toy.toyKey
  if (toy.gate && toy.gate.allowed === false) {
    toastFn?.(toy.gate.message || '现在还不行', 'info')
    return
  }
  if (isWorn(key)) return
  // 2026-10-02（用户：「玩具只能一档一档的加 加入档位随时可调」）：戴上前可以先挑档位。
  // 档位 >1 时**面板自己写服务端**（与"模式 / 曲线"同一口径：不扩父组件那三条旧 emit，免得接线两处）；
  // 档位 =1 仍走原来的 emit，保持既有接线逐字不变。
  if (Number(equipLevel.value) > 1 && activeCharId.value) {
    callPlay(api.equipToy, key, { intensity: Number(equipLevel.value) },
      '已戴上：' + labelOf(key) + '（' + equipLevel.value + ' 档）')
    return
  }
  emit('toy-equip', key)
  refreshSoon()
}

// ── 批量装卸（2026-10-04 用户：「玩具不能批量装卸 还得一个个点 比较麻烦 这个也加上」）──────
// 与上面 `callPlay` **同一口径**：面板直接写服务端，不扩父组件那三条旧 emit（免得接线两处）。
// 差别在**它是静默的** —— 服务端 `POST /:id/toys/batch` 不逐件调模型产反应，
// 只改穿戴状态 + 广播一次 `toys_batch_changed`，所以这里做完 `refreshSoon(0)` 立刻重取清单即可。
const batchBusy = ref(false)
/** 还能装的件数（按钮文案与禁用态用）：背包里**还没戴上**的那些 */
const batchEquipCount = computed(() => toyList.value.filter(t => !isWorn(t.key || t.toyKey)).length)

/** 服务端的 `skipped[]` 是给人看的：把原因码去重后附在提示里，**不静默吞掉** */
function batchSkipNote(skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return ''
  const codes = [...new Set(skipped.map(s => (s && s.reason) || 'unknown'))]
  return '（' + skipped.length + ' 件跳过：' + codes.join(' / ') + '）'
}

/**
 * 把「全部」翻译成**明确的 key 清单**再发给服务端。
 *
 * ⚠️ 为什么必须显式传 `toyKeys`（2026-10-04 真机抓到的不一致）：
 *   面板的背包格子渲染的是服务端 `catalog`（含第二批扩展玩具，实测 11 件），
 *   而服务端的批量端点在不传 `toyKeys` 时按 **`availablePayload`** 推导（实测只有 5 件基础玩具）
 *   —— 两套清单**不是同一个**。结果就是按钮写着「全部戴上（11 件）」、实际只戴上 5 件。
 *   现在按**用户眼前的这份清单**（`toyList` / `wornList`）取 key，按钮文案与实际动作按构造一致。
 */
function batchTargets(action) {
  const seen = new Set()
  const out = []
  const src = action === 'remove' ? (wornList.value || []) : (toyList.value || [])
  for (const t of src) {
    const key = t && (t.toyKey || t.key)
    if (!key || seen.has(key)) continue
    // 「全部戴上」跳过已经戴着的；「全部摘下」只取清单里的（wornList 本身就只有戴着的）
    if (action === 'equip' && isWorn(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

async function runBatch(action) {
  const id = activeCharId.value
  if (!id || batchBusy.value) return
  const keys = batchTargets(action)
  if (!keys.length) {
    toastFn?.(action === 'remove' ? '她本来就没戴着' : '已经没有可戴的了', 'info')
    return
  }
  batchBusy.value = true
  try {
    const res = await api.batchToys(id, { action, toyKeys: keys }, sceneOpts.value)
    const n = res && Array.isArray(res.applied) ? res.applied.length : 0
    const note = batchSkipNote(res && res.skipped)
    const head = n
      ? (action === 'remove' ? `已全部摘下（${n} 件）` : `已戴上 ${n} 件`)
      : (action === 'remove' ? '她本来就没戴着' : '已经没有可戴的了')
    toastFn?.(head + note, 'info')
    // ⚠️ 必须通知父组件（2026-10-04 用户反馈「右下角的红色数字角标还是继续在」）：
    // 角标读的是**父组件自己的** `wornToys`（ChatView 的 ref），批量是面板直接 POST、
    // 父组件毫不知情 ⇒ 面板清空了、角标还挂着旧数字。
    // 单件那三条 emit 之所以没这个问题，就是因为它们本来就经过父组件。
    emit('toy-batch-done', { action, applied: (res && res.applied) || [] })
    refreshSoon(0)
  } catch (err) {
    toastFn?.(err && err.message ? err.message : '批量操作失败', 'error')
  } finally {
    batchBusy.value = false
  }
}
function batchEquipAll() { return runBatch('equip') }
function batchRemoveAll() { return runBatch('remove') }

/** 模式 / 曲线是**面板直接写服务端**（父组件那三条 emit 是旧契约，不扩它，免得接线两处）。
 *  第四个参数是场景（群聊必带，否则她自己玩/反应会写到私聊）—— 所有玩具 api 的签名统一。 */
async function callPlay(fn, toyKey, payload, okText) {
  const id = activeCharId.value
  if (!id) return
  busyKey.value = toyKey
  try {
    const res = await fn(id, toyKey, payload, sceneOpts.value)
    if (res && res.toy) applyToyUpdate(res.toy)
    else refreshSoon(0)
    if (okText) toastFn?.(okText, 'info')
  } catch (err) {
    toastFn?.(err && err.message ? err.message : '设置失败', 'error')
  } finally {
    busyKey.value = ''
  }
}

function setMode(toy, mode) {
  if (!toy || toy.mode === mode) return
  callPlay(api.setToyMode, toy.toyKey, mode, '模式：' + modeLabelOf(mode))
}
function toggleCurve(toy, on) {
  if (!toy) return
  if (!on) return callPlay(api.setToyCurve, toy.toyKey, null, '已关掉强度曲线')
  const max = Math.max(1, maxOf(toy.toyKey))
  const from = Math.max(1, Math.min(max, Number(toy.intensity) || 1))
  return callPlay(api.setToyCurve, toy.toyKey, {
    type: 'ramp_up', from, to: max, durationSec: DEFAULT_CURVE_DURATION, loop: false,
  }, '曲线：' + curveLabelOf({ type: 'ramp_up', from, to: max, durationSec: DEFAULT_CURVE_DURATION }))
}
function setCurveType(toy, type) {
  if (!toy || !toy.curve || toy.curve.type === type) return
  const max = Math.max(1, maxOf(toy.toyKey))
  return callPlay(api.setToyCurve, toy.toyKey, {
    type,
    from: Number(toy.curve.from) || 0,
    to: Number.isFinite(Number(toy.curve.to)) ? Number(toy.curve.to) : max,
    durationSec: Number(toy.curve.durationSec) || DEFAULT_CURVE_DURATION,
    loop: toy.curve.loop === true,
  })
}
function setCurveDuration(toy, durationSec) {
  if (!toy || !toy.curve || Number(toy.curve.durationSec) === Number(durationSec)) return
  const max = Math.max(1, maxOf(toy.toyKey))
  return callPlay(api.setToyCurve, toy.toyKey, {
    type: toy.curve.type,
    from: Number(toy.curve.from) || 0,
    to: Number.isFinite(Number(toy.curve.to)) ? Number(toy.curve.to) : max,
    durationSec: Number(durationSec) || DEFAULT_CURVE_DURATION,
    loop: toy.curve.loop === true,
  })
}

/** 「逗她一下」：只给她加一点念头（服务端 +0.12），**她自己决定要不要动手** */
async function onEncourage() {
  const id = activeCharId.value
  if (!id) return
  selfPlayBusy.value = true
  try {
    const res = await api.triggerSelfPlay(id, { encourage: true }, sceneOpts.value)
    if (res && res.play === true) {
      toastFn?.('她' + (res.secret ? '偷偷' : '') + '把' + (res.label || '玩具') + '用上了', 'info')
      await refresh()
    } else {
      toastFn?.((res && res.reason) || '她这次没那个念头', 'info')
      refreshSoon(200)
    }
  } catch (err) {
    toastFn?.(err && err.message ? err.message : '没能逗到她', 'error')
  } finally {
    selfPlayBusy.value = false
  }
}
</script>

<style scoped>
/* 玩具面板：与设计系统一致的小字/间距，色值全走 token（双主题）；状态变化一律 0.3s 过渡 */
.toy-panel__head {
  margin: 12px 0 8px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
  color: var(--text-secondary);
  display: flex; align-items: center; gap: 6px;
}
.toy-panel__head:first-child { margin-top: 0; }
.toy-panel__count {
  font-weight: 500; color: var(--text-bright);
  background: var(--bg-sunken); border-radius: 999px; padding: 1px 8px;
  transition: background-color 0.3s ease, color 0.3s ease;
}
.toy-combo {
  margin: 0 0 6px; font-size: 12px; color: var(--text-secondary);
  transition: color 0.3s ease;
}
.toy-worn-list { list-style: none; margin: 0; padding: 0; }
.toy-worn-item {
  padding: 8px 6px;
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius-md);
  transition: background-color 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
}
.toy-worn-item:hover { background: var(--bg-sunken); }
.toy-worn-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.toy-worn-line--play { margin-top: 6px; }
.toy-play-label { font-size: 12px; color: var(--text-secondary); }
.toy-worn-name { font-size: 14px; color: var(--text-bright); }
.toy-worn-part { font-size: 12px; color: var(--text-secondary); }
.toy-worn-intensity {
  margin-left: auto; font-size: 12px; color: var(--text-secondary);
  transition: color 0.3s ease;
}
.toy-worn-bump { display: inline-flex; align-items: center; gap: 4px; }
.toy-mode-tabs { max-width: 260px; }
.toy-curve-type { min-width: 96px; }
.toy-curve-duration { max-width: 240px; }
.toy-curve-remain { font-size: 12px; color: var(--text-secondary); }
.toy-worn-empty { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); }
.toy-backpack-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.toy-self {
  display: flex; align-items: center; gap: 10px;
  font-size: 12px; color: var(--text-secondary);
}
.toy-self-text { flex: 1; min-width: 0; }
.toy-self-last { color: var(--text-secondary); opacity: 0.8; }
.toy-note { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }
/* 玩法说明（2026-10-02）：展开/收起 0.3s，与设计系统的窗口过渡同一时长口径 */
.toy-guide { margin: 6px 0 10px; }
.toy-guide-body { margin-top: 8px; padding: 10px 12px; border-radius: 10px; background: rgba(var(--accent-rgb), 0.05); font-size: 12px; line-height: 1.75; color: var(--text-secondary); }
.toy-guide-body p { margin: 0 0 6px; }
.toy-guide-body p:last-child { margin-bottom: 0; }
.toy-guide-body b { color: var(--text-primary); font-weight: 600; }
.toy-guide-fade-enter-active, .toy-guide-fade-leave-active { transition: opacity 0.3s var(--ease-standard), transform 0.3s var(--ease-standard); }
.toy-guide-fade-enter-from, .toy-guide-fade-leave-to { opacity: 0; transform: translateY(-4px); }
/* 曲线控制行出现时 0.3s 渐入（与设计系统的窗口/页签过渡同一时长口径） */
.toy-worn-line--play { animation: toy-reveal 0.3s ease; }
@keyframes toy-reveal {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@media (max-width: 520px) {
  .toy-backpack-grid { grid-template-columns: minmax(0, 1fr); }
  .toy-mode-tabs, .toy-curve-duration { max-width: none; }
}
/* 批量装卸那一行（2026-10-04）：与档位行 / 背包区同宽，控件走 Linshe，颜色一律 token */
.toy-batch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0 0 8px;
}
.toy-equip-level {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 6px;
}
.toy-equip-level-label {
  font-size: 12px;
  color: var(--text-secondary);
}
.toy-equip-level-hint {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.85;
}
</style>
