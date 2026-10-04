<template>
  <!-- API Key 未配置横幅 -->
  <div v-if="!settings.hasApiKey" class="api-key-banner">
    <span class="banner-icon">⚠️</span>
    <span class="banner-text">尚未配置 API Key，请前往设置页面填写 DeepSeek（或其他兼容）API Key</span>
    <router-link to="/settings" class="banner-link">前往设置 →</router-link>
  </div>
  <div class="app-layout" :class="{ 'is-mobile': isMobile }">
    <!-- 移动端遮罩层：Sidebar 拉出时覆盖聊天区域 -->
    <Transition name="scrim-fade">
      <div v-if="isMobile && mobileSidebarOpen" class="mobile-scrim" @click="closeMobileSidebar"></div>
    </Transition>
    <NavBar />
    <Sidebar
      :is-mobile="isMobile"
      :mobile-open="mobileSidebarOpen"
      @char-selected="closeMobileSidebar"
    />
    <div class="page-host" :class="contextPanelClass">
      <!-- 全局左上角上下文用量浮层：放在 .page-host 内，位置基准是内容区而非视口，
           因此不会压到 NavBar / Sidebar 的可点区域，切页面也不消失。
           各页面自带的标题栏高度不同，用一个变量把浮层的起始纵坐标让出来（见下方样式）。 -->
      <ContextUsagePanel />
      <router-view v-slot="{ Component }">
        <Transition name="page">
          <component v-if="Component" :is="Component" :key="route.path" />
        </Transition>
      </router-view>
      <!-- 页面弹窗独立挂载，避免 Teleport 锚点成为路由页面切换时的插入参照。 -->
      <div class="page-modal-host"></div>
    </div>
  </div>
  <ConfirmDialog ref="confirmDialog" />
  <Toast ref="toastEl" />
  <InstallGuideDialog ref="guideDialog" />
  <ChangelogDialog ref="changelogDialog" @close="onChangelogClose" />
  <ImageEditTaskFloater />

  <!-- 手机端访问提示 Toast -->
  <Transition name="toast-slide">
    <div v-if="mobileToast.visible" class="mobile-toast">
      <span class="toast-text">手机网页访问 <b>{{ mobileToast.url }}</b>打开邻舍</span>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useRoute } from 'vue-router'
import { createMobileSidebarBackHandler } from './utils/mobileSidebarBack.js'
import { useChatStore } from './stores/chat.js'
import { useSettingsStore } from './stores/settings.js'
import { useProactiveStore } from './stores/notifications.js'
import { forceProactive } from './api/index.js'
import { loadUserConfig } from './userConfig.js'
import { playNotificationSound } from './utils/sound.js'
import { useMailboxStore } from './stores/mailbox.js'
import { useUpdateStore } from './stores/updateInfo.js'
import { onEvent as onStreamEvent } from './stores/unifiedStream.js'
import { getProgramTime } from './api/timeControl.js'
import { programTimeViewModel } from './components/timeControlLogic.js'
import NavBar from './components/NavBar.vue'
import Sidebar from './components/Sidebar.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import Toast from './components/Toast.vue'
import InstallGuideDialog from './components/InstallGuideDialog.vue'
import ChangelogDialog from './components/ChangelogDialog.vue'
import ImageEditTaskFloater from './components/ImageEditTaskFloater.vue'
import ContextUsagePanel from './components/ContextUsagePanel.vue'
import { MAIBOT_AFTER_START_STEPS, MAIBOT_INSTALL_STEPS, MAIBOT_INTRO_TEXT } from './data/maibotTutorial.js'
import { CHANGELOG_FLAG } from './data/changelog.js'

const chat = useChatStore()
const settings = useSettingsStore()
const proactive = useProactiveStore()
const mailbox = useMailboxStore()
const update = useUpdateStore()
const route = useRoute()
// ── 上下文用量浮层的纵向基准 ──
// 浮层固定在内容区左上角，必须让开各页面自己的标题栏，否则会盖住
// 返回按钮 / 页面标题这些可点区域。聊天页标题栏是固定高度（桌面 64px、手机 68px），
// 其余页面标题栏多为内联流式（高度随内容），用 60px 这个保守值都能落在标题栏下方。
const CHAT_ROUTES = ['/chat', '/group']
const contextPanelClass = computed(() => (
  CHAT_ROUTES.some(prefix => route.path.startsWith(prefix)) ? 'is-chat-route' : ''
))
const confirmDialog = ref(null)
const toastEl = ref(null)
const guideDialog = ref(null)
const changelogDialog = ref(null)
const themeAutoTimer = ref(null)

// ── 手机端访问 Toast（启动器打开时通过 ?mobile_ip= 传入）──
const mobileToast = ref({ visible: false, url: '' })

// ── 临时调试：强制主动聊天 ──
const forceLoading = ref(false)
const forceResult = ref('')
async function onForceProactive() {
  if (forceLoading.value) return
  forceLoading.value = true
  forceResult.value = ''
  try {
    const r = await forceProactive()
    if (r.ok) {
      forceResult.value = `${r.character}: ${r.motive} — "${r.greeting}"`
      setTimeout(() => { forceResult.value = '' }, 5000)
    } else {
      forceResult.value = r.error || '失败'
    }
  } catch (e) {
    forceResult.value = e.message || '请求失败'
  } finally {
    forceLoading.value = false
  }
}

function confirm(opts) {
  return confirmDialog.value?.show(opts) ?? Promise.resolve(false)
}
function toast(message, type = 'info', duration) {
  toastEl.value?.show(message, type, duration)
}

/**
 * 程序世界的「今天」（日期键 YYYY-MM-DD）。
 *
 * 2026-10-02 修：日程的 `target_date` 与 `daily_schedules.schedule_date` 都是**程序日期键**，
 * 原来这里拿 `new Date()`（真实今天）去比，世界钟被拨过之后「明天 / 后天」会指错天。
 * 前端**不自己算偏移**：只读后端 `GET /api/time` 的 `date`；读不到给空串（那时不做相对日期判断）。
 */
async function programDateKeyNow() {
  try {
    const view = programTimeViewModel(await getProgramTime())
    return view.date || ''
  } catch {
    return ''
  }
}

/**
 * 目标日期的口语化描述：明天 / 后天 / 大后天，再往后（或判断不了）显示 M月D日。
 * 基准 `todayKey` 是**程序世界的今天**；拿不到时不做"明天/后天"的相对判断，宁可少说也不说错。
 */
function describeTargetDate(dateKey, todayKey = '') {
  const target = new Date(`${dateKey}T00:00:00`)
  if (Number.isNaN(target.getTime())) return dateKey
  const base = /^\d{4}-\d{2}-\d{2}$/.test(String(todayKey)) ? new Date(`${todayKey}T00:00:00`) : null
  const diffDays = base ? Math.round((target - base) / 86400000) : null
  if (diffDays === 1) return '明天'
  if (diffDays === 2) return '后天'
  if (diffDays === 3) return '大后天'
  return `${target.getMonth() + 1}月${target.getDate()}日`
}
function showGuide(opts) {
  return guideDialog.value?.show(opts) ?? Promise.resolve()
}
function showInstallGuide() {
  return showGuide({
    title: 'MaiBot 安装教程',
    intro: MAIBOT_INTRO_TEXT,
    steps: MAIBOT_INSTALL_STEPS,
    afterStartSteps: MAIBOT_AFTER_START_STEPS,
  })
}
provide('confirm', confirm)
provide('toast', toast)
provide('showGuide', showGuide)
provide('showInstallGuide', showInstallGuide)

// ══════════════════════════════════════════════════
// 更新说明 — 「内容变了就弹一次」
//
// CHANGELOG_FLAG 由 `npm run tag` 从 src/data/changelog.js 的内容哈希生成，
// 用户浏览器里存着上次看过的值。两者不一致 = 首次启动，或更新说明被改过 → 弹一次；
// 关闭时把当前标志位写回去，于是同一个版本只会弹一次。
// ══════════════════════════════════════════════════
const CHANGELOG_SEEN_KEY = 'linshe_changelog_seen'

function readChangelogSeen() {
  try {
    return localStorage.getItem(CHANGELOG_SEEN_KEY)
  } catch {
    return null // 隐私模式等场景下 localStorage 不可用：退化为每次启动都弹
  }
}

function markChangelogSeen() {
  try {
    if (CHANGELOG_FLAG) localStorage.setItem(CHANGELOG_SEEN_KEY, CHANGELOG_FLAG)
  } catch {}
}

/** 关闭即视为已读（Esc / 点遮罩 / 「我知道了」都走这里） */
function onChangelogClose() {
  markChangelogSeen()
}

/** 供设置页手动重新打开 */
function showChangelog() {
  changelogDialog.value?.open()
}

provide('showChangelog', showChangelog)

// ══════════════════════════════════════════════════
// 移动端响应式 — Sidebar 抽屉状态
// ══════════════════════════════════════════════════
const MOBILE_MAX = 767
const isMobile = ref(false)
const mobileSidebarOpen = ref(false)

function checkMobile() {
  isMobile.value = window.innerWidth <= MOBILE_MAX
  if (!isMobile.value) mobileSidebarOpen.value = false
}

function toggleMobileSidebar() {
  mobileSidebarOpen.value = !mobileSidebarOpen.value
}

function closeMobileSidebar() {
  mobileSidebarOpen.value = false
}

const handleAndroidBack = createMobileSidebarBackHandler({
  isMobile: () => isMobile.value,
  isOpen: () => mobileSidebarOpen.value,
  open: () => { mobileSidebarOpen.value = true },
})

provide('isMobile', isMobile)
provide('toggleMobileSidebar', toggleMobileSidebar)

onMounted(async () => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
  window.addEventListener('linshe:notification-opened', closeMobileSidebar)
  window.__linsheHandleAndroidBack = handleAndroidBack

  settings.loadComfyConfig()
  // 按时间主题：打开期间每分钟 + 回到前台时刷新
  themeAutoTimer.value = window.setInterval(() => settings.refreshTheme(), 60_000)
  window.addEventListener('focus', settings.refreshTheme)
  loadUserConfig()  // 应用启动即加载，不阻塞渲染
  update.check()  // 版本更新检查：设置页「有更新噢」标签与侧边栏红点共用；失败静默
  await chat.loadCharacters()

  // 连接主动聊天 SSE 通知流
  proactive.connectSSE()
  proactive.setOnMessage((data) => {
    // 更新聊天 store
    chat.handleProactiveMessage(data)

    // 非当前活跃角色 → 播放提示音
    if (data.character_id !== chat.activeCharId) {
      playNotificationSound()
    }
  })

  // 私聊两段式反应的**后半段**（专题 §八 8.2）：她的文字反应先上屏，图好了再补到那条气泡上。
  // payload（后端定，未落地前按此写）：{ msg_id, raw_id, images }；找不到 msg_id 会安全忽略。
  onStreamEvent('proactive_message_update', (data) => {
    chat.handleProactiveMessageUpdate(data)
  })

  // 订阅日程延迟回复 SSE 事件
  onStreamEvent('delayed_reply', (data) => {
    chat.handleDelayedReply(data)
    // 非当前活跃角色 → 播放提示音 + 红点（延迟回复也应有通知）
    if (data.character_id !== chat.activeCharId) {
      playNotificationSound()
      proactive.addProactive(data)
    }
  })

  // 日程更改成功（手动编辑 / 聊天约定 / 跨天约定应用）→ 右上角提示
  onStreamEvent('schedule_changed', async (data) => {
    const name = data.display_name || '角色'
    // 基准是**程序世界的今天**（日程日期键属于世界钟；不拿现实日期冒充，也不在前端算偏移）
    const todayKey = await programDateKeyNow()
    if (data.target_date && data.target_date !== todayKey) {
      toast(`「${name}」的约定已排入${describeTargetDate(data.target_date, todayKey)}的日程`, 'success')
    } else {
      toast(`「${name}」日程已更新`, 'success')
    }
  })

  // 信箱新回信 → 播放提示音
  watch(() => mailbox.unreadCount, (newVal, oldVal) => {
    if (newVal > oldVal) playNotificationSound()
  })

  if (isMobile.value) {
    // 移动端：角色列表默认藏在屏幕左侧，用户点击按钮才拉出
  } else if (chat.characters.length > 0 && !chat.activeCharId && !route.params.id) {
    // 仅在无路由角色参数时自动选第一个（有路由时 ChatView 会根据路由自行 selectChar）
    chat.selectChar(chat.characters[0].id)
  }

  // ── 手机端访问 Toast：启动器通过 ?mobile_ip= 传入本机 IP，底部浮窗 2s ──
  const TOAST_KEY = 'mobile_toast_shown'
  const params = new URLSearchParams(window.location.search)
  const mobileIp = params.get('mobile_ip')
  if (mobileIp && !sessionStorage.getItem(TOAST_KEY)) {
    sessionStorage.setItem(TOAST_KEY, '1')
    mobileToast.value = { visible: true, url: `http://${mobileIp}:3099` }
    setTimeout(() => { mobileToast.value.visible = false }, 5000)
  }
  // 清理 URL 中的 mobile_ip 参数（无论是否弹 toast）
  if (mobileIp) {
    params.delete('mobile_ip')
    const newSearch = params.toString()
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash
    window.history.replaceState(null, '', newUrl)
  }
})

// ── 更新说明弹窗：首次启动 / 更新说明内容有变化时弹一次 ──
// 刻意独立成一个 onMounted：它不依赖角色加载、SSE 等任何启动流程，
// 上面那段万一中途出错，更新说明也照样能弹出来。
onMounted(() => {
  if (!CHANGELOG_FLAG) return
  if (readChangelogSeen() === CHANGELOG_FLAG) return
  // 稍作延迟，避免和首屏 page 过渡动画抢注意力
  window.setTimeout(() => changelogDialog.value?.open(), 400)
})

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile)
  window.removeEventListener('linshe:notification-opened', closeMobileSidebar)
  if (themeAutoTimer.value) window.clearInterval(themeAutoTimer.value)
  window.removeEventListener('focus', settings.refreshTheme)
  if (window.__linsheHandleAndroidBack === handleAndroidBack) {
    delete window.__linsheHandleAndroidBack
  }
  proactive.disconnectSSE()
})
</script>

<style>
.app-layout { display: flex; flex: 1; min-height: 0; position: relative; z-index: 1; }
.page-modal-host { position: absolute; inset: 0; pointer-events: none; }
.page-modal-host .modal-overlay { pointer-events: auto; }
.page-host {
  position: relative;
  flex: 1;
  min-width: 0;
  /* 上下文用量浮层（ContextUsagePanel）的纵向起点：让开当前页面的标题栏。
     聊天页标题栏是固定高度（桌面 64px），其余页面是内联流式标题，60px 是通用保守值。 */
  --ctx-usage-top: 60px;
}
.page-host.is-chat-route { --ctx-usage-top: 64px; }
@media (max-width: 767px) {
  /* 手机端聊天页有 44px 的返回按钮，标题栏更高 */
  .page-host.is-chat-route { --ctx-usage-top: 68px; }
  .page-host { --ctx-usage-top: 58px; }
}
#app { position: relative; z-index: 1; }

/* ── 移动端 Sidebar 遮罩 ── */
.mobile-scrim {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 99;
}
.scrim-fade-enter-active { transition: opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
.scrim-fade-leave-active { transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
.scrim-fade-enter-from,
.scrim-fade-leave-to { opacity: 0; }

/* ── API Key 未配置横幅 ── */
.api-key-banner {
  width: 100%;
  background: #e04444;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 10px 16px;
  font-size: 14px;
  z-index: 1000;
  position: relative;
  flex-shrink: 0;
}
.banner-icon { font-size: 16px; flex-shrink: 0; }
.banner-text { font-weight: 500; }
.banner-link {
  color: #fff;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: nowrap;
  margin-left: 4px;
  transition: opacity 0.15s;
}
.banner-link:hover { opacity: 0.8; }

/* ── 手机端访问 Toast（底部浮窗，2s 自动消失）── */
.mobile-toast {
  position: fixed;
  bottom: 88px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(46, 42, 39, 0.92);
  color: #FCFAF8;
  font-size: 14px;
  padding: 14px 26px;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(12px);
  white-space: nowrap;
  pointer-events: none;
}
.mobile-toast b {
  color: var(--accent-light);
  font-weight: 600;
}
.toast-icon { font-size: 18px; flex-shrink: 0; }
.toast-text { line-height: 1.4; }

/* Toast 动画：底部滑入 + 淡入 */
.toast-slide-enter-active {
  transition: all 0.35s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.toast-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.55, 0.06, 0.68, 0.19);
}
.toast-slide-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(20px);
}
.toast-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(12px);
}
</style>
