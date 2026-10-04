<template>
  <div class="chat-view">
    <!-- 头部（与私聊 chat-header 同款） -->
    <div class="chat-header">
      <linshe-button v-if="isMobile" variant="icon" class="btn-mobile-back" @click="toggleMobileSidebar" title="角色列表">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6" /></svg>
      </linshe-button>
      <!-- 有自定义群头像时整块展示，点击即进入更换；未设置时保留成员拼图 -->
      <div
        v-if="groupAvatarUrl"
        role="button"
        tabindex="0"
        class="group-avatar-grid group-avatar-single header-avatar avatar-clickable"
        title="设置群头像"
        aria-label="设置群头像"
        @keydown.enter.prevent="openGroupAvatarPicker"
        @keydown.space.prevent="openGroupAvatarPicker"
        @click.stop="openGroupAvatarPicker"
      >
        <img :src="groupAvatarUrl" class="group-avatar-img" alt="" />
      </div>
      <div v-else class="group-avatar-grid header-avatar">
        <div
          v-for="m in (store.activeGroup?.members || []).slice(0, 4)"
          :key="m.id"
          class="group-avatar-cell avatar-clickable"
          :style="m.avatar_path ? {} : { background: 'var(--accent)' }"
          @click.stop="openAvatarMenu(m, $event)"
        >
          <img v-if="m.avatar_path" :src="m.avatar_path" class="group-avatar-img" alt="" />
          <span v-else>{{ m.display_name.charAt(0) }}</span>
        </div>
      </div>
      <div class="chat-header-center">
        <div class="chat-header-title-row">
          <div class="chat-title">{{ store.activeGroup?.name || '群聊' }}</div>
        </div>
        <div class="chat-header-schedule">{{ store.activeGroup?.members?.length || 0 }} 位成员{{ store.activeGroup?.topic ? ' · ' + store.activeGroup.topic : '' }}</div>
      </div>
      <div class="chat-header-right">
        <!-- 催眠手机：群里对成员用手机（可单人可多人，见 HypnosisPhoneGroupPanel） -->
        <div class="btn-header-settings" title="催眠手机" aria-label="催眠手机" @click="showHypnosisPhone = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M11 5.5h2" /><circle cx="12" cy="13" r="3.2" /><path d="M12 10.2v5.6M9.4 13h5.2" /></svg>
        </div>
        <div class="btn-header-settings" title="群设置" @click="showSettings = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
        </div>
      </div>
    </div>

    <!-- 消息区（与私聊 message-list 同款） -->
    <div class="message-area">
      <div
        ref="scrollEl"
        class="message-list"
        @scroll="onMessageScroll"
        @wheel="onUserScrollIntent"
        @touchstart="onUserScrollIntent"
        @pointerdown="onUserScrollIntent"
      >
        <div v-if="store.hasMoreOlder" class="load-older load-older-hint">↑ 向上滚动加载更多</div>

        <div ref="msgListInner" class="msg-list-inner">
          <template v-for="(msg, idx) in store.visibleMessages" :key="msg.id">
          <!-- 时间分隔符（与私聊同款：间隔超 10 分钟显示） -->
          <div v-if="showTimeDivider(idx)" class="time-divider">{{ timeLabel(msg.created_at) }}</div>
          <div v-if="msg.id === store.lastSeenDividerId" class="last-seen-divider" role="separator" aria-label="上次看到这里">
            <span>上次看到这里</span>
          </div>
          <div
            class="message"
            :class="[msg.role === 'user' ? 'user' : 'assistant', { 'msg-same-role': isSameSpeaker(idx) }]"
          >
          <div
            class="msg-avatar"
            :class="{ 'avatar-clickable': msg.role !== 'user' && memberOf(msg) }"
            :style="msgAvatarSrc(msg) ? {} : { background: 'var(--accent)' }"
            @click="openMsgAvatarMenu(msg, $event)"
          >
            <img v-if="msgAvatarSrc(msg)" :src="msgAvatarSrc(msg)" class="avatar-img" loading="lazy" decoding="async" alt="" />
            <span v-else class="avatar-fallback">{{ avatarFallback(msg) }}</span>
          </div>
          <div class="msg-col">
            <div v-if="msg.role !== 'user' && !isSameSpeaker(idx)" class="speaker-name">{{ msg.speaker_name || '?' }}</div>
            <div v-if="msg.content" class="msg-bubble">
              <div class="msg-text">{{ msg.content }}</div>
            </div>
            <!-- 本次会话内的生图任务：与私聊同款遮罩/进度/错误气泡；历史图片直接展示 -->
            <ImageGenBubble
              v-if="msg.genStatus && !msg.hideImagePending"
              :msg="genMsgOf(msg)"
              :emit-loaded-when-initially-done="true"
              @preview="url => previewUrl = url"
              @loaded="onGroupImageLoaded(msg.id)"
            />
            <div v-else-if="msg.images && msg.images.length" class="msg-images">
              <img
                v-for="(url, i) in msg.images"
                :key="i"
                :src="url"
                class="msg-image"
                :class="{ 'msg-emoji-img': isEmojiSticker(url) }"
                @click="onImageClick(url)"
              />
            </div>
          </div>
          </div>
          </template>

          <div v-if="store.messages.length === 0" class="gc-empty">
            群聊已建立，发条消息热热场吧～
          </div>
        </div>
      </div>

      <Transition name="new-message">
        <div
          v-if="hasNewMessages"
          role="button"
          tabindex="0"
          class="new-message-bubble"
          aria-label="有新消息，回到底部"
          @keydown.enter.prevent="returnToLatest"
          @keydown.space.prevent="returnToLatest"
          @click="returnToLatest"
        >
          <span>有新消息</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </Transition>
    </div>

    <!-- SLG 动作快捷条（阶段二·群聊）：先选「对谁」，再选动作。
         选人复用本页既有的 @提及成员面板（同一套 .mention-panel / .mention-item 视觉，includeAll=false）。 -->
    <div class="touch-group-wrap">
      <Transition name="mention-fade">
        <div
          v-if="showTargetPicker"
          id="touch-target-list"
          class="mention-panel"
          role="listbox"
          aria-label="选择动作对象"
        >
          <div
            v-for="(opt, idx) in targetOptions"
            :key="opt.key"
            class="mention-item"
            :class="{ 'is-active': idx === targetIndex }"
            role="option"
            :aria-selected="idx === targetIndex"
            @mouseenter="targetIndex = idx"
            @click="pickTarget(opt)"
          >
            <div class="mention-avatar" :style="opt.avatar_path ? {} : { background: 'var(--accent)' }">
              <img v-if="opt.avatar_path" :src="opt.avatar_path" class="avatar-img" alt="" />
              <span v-else>{{ opt.display_name.charAt(0) }}</span>
            </div>
            <span>{{ opt.display_name }}</span>
          </div>
        </div>
      </Transition>
      <!-- SLG 动作系统（交互改版）：与私聊同一颗 ✋（输入区最右），点开底部弹层大卡片面板。
           群聊先选「对谁」（复用本页 @提及成员面板）；面板顶部有「对 XXX」可随时换人。 -->
      <TouchActionPanel
        :open="showTouchPanel"
        :server-groups="touchServerGroups"
        :busy-actions="touchBusyActions"
        :hypnosis-badge="touchHypnosisBadge"
        :pending-count="touchPendingCount"
        :pending-by-mode="touchPendingByMode"
        :states="touchStates"
        :target-name="touchTarget ? touchTarget.display_name : ''"
        :requires-target="true"
        @pick-target="openTargetPicker"
        @action="onTouchAction"
        @open="onTouchPanelOpen"
        @close="showTouchPanel = false"
      />
      <!-- 🧸 / ❤ 两个面板（2026-10-02）：**只做挂载 + 传 id**，面板自己取数、自己轮询、自己 POST。
           - `:character-id` 是"打开那一刻选定的那个群成员"（panelCharacterId）；
           - 不传 worn-toys / toy-options：面板有默认值并会自己去取（私聊那份只是回落）；
           - 门控不可用时的人话（玩具未解锁 / 「性爱推进」功能当前已关闭 / 还没进入亲密场景）
             由面板自己渲染 —— 群聊里照样能看到；
           - 换目标时 watch(touchTargetId) 会把两个面板关掉，避免继续作用在上一个人身上。 -->
      <ToyPanel
        :open="showToyPanel"
        :character-id="panelCharacterId"
        :worn-toys="groupWornToys"
        :toy-options="groupToyOptions"
        scene="group"
        :group-id="store.activeGroupId"
        @close="showToyPanel = false"
        @toy-equip="onGroupToyEquip"
        @toy-intensity="onGroupToyIntensity"
        @toy-remove="onGroupToyRemove"
        @toy-batch-done="onGroupToyBatchDone"
      />
      <IntimateActionPanel
        :open="showIntimatePanel"
        :character-id="panelCharacterId"
        scene="group"
        :group-id="store.activeGroupId"
        @close="showIntimatePanel = false"
      />
    </div>

    <!-- 输入区（与私聊 input-area 同款） -->
    <div class="input-area">
      <Transition name="mention-fade">
        <div
          v-if="showMentionPicker"
          id="mention-list"
          ref="mentionListEl"
          class="mention-panel"
          role="listbox"
          aria-label="选择要@的成员"
        >
          <div
            v-for="(opt, idx) in mentionOptions"
            :id="`mention-opt-${opt.key}`"
            :key="opt.key"
            class="mention-item"
            :class="{ 'is-active': idx === mentionIndex }"
            role="option"
            :aria-selected="idx === mentionIndex"
            @mouseenter="mentionIndex = idx"
            @click="pickMention(opt)"
          >
            <div class="mention-avatar" :style="opt.avatar_path ? {} : { background: 'var(--accent)' }">
              <img v-if="opt.avatar_path" :src="opt.avatar_path" class="avatar-img" alt="" />
              <span v-else>{{ opt.isAll ? '@' : opt.display_name.charAt(0) }}</span>
            </div>
            <span>{{ opt.display_name }}</span>
          </div>
        </div>
      </Transition>
      <textarea
        ref="inputEl"
        v-model="draft"
        class="chat-input"
        rows="1"
        placeholder="输入消息… "
        aria-autocomplete="list"
        :aria-expanded="showMentionPicker"
        aria-controls="mention-list"
        :aria-activedescendant="activeMentionId"
        @input="syncInputHeight"
        @keydown.enter.exact="onSendKey"
        @keydown.enter.shift.exact="draft += '\n'"
        @keydown.up="onMentionArrow(-1, $event)"
        @keydown.down="onMentionArrow(1, $event)"
        @keydown.esc="onMentionEscape"
      ></textarea>
      <!-- ✋ 动作入口：图标排最右（紧贴发送按钮左侧），与私聊同位置同皮肤；pendingCount>0 显示角标 -->
      <div
        role="button"
        tabindex="0"
        class="touch-icon-btn"
        :title="touchPendingHint || '动作'"
        aria-label="动作"
        @keydown.enter.prevent="showTouchPanel = true"
        @keydown.space.prevent="showTouchPanel = true"
        @click="showTouchPanel = true"
      >
        <svg viewBox="0 0 24 24" width="20" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v6" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
        <span v-if="touchPendingCount > 0" class="touch-icon-badge">{{ touchPendingCount }}</span>
      </div>
      <!-- 🧸 玩具入口（2026-10-02）：与私聊那排图标钮**同款同样例**（同一个 .touch-icon-btn 皮肤、
           同一套 SVG 风格、同样的 is-open 高亮）。群聊与私聊的区别只在点击后的行为：
           这里必须先选定"对谁"（见 openGroupPanel / groupPanelLogic.js）。
           和 ❤ 一样**不做"未解锁就不渲染"**——藏掉入口会让用户以为功能不存在（面板里有门控人话）。 -->
      <div
        role="button"
        tabindex="0"
        class="touch-icon-btn toy-icon-btn"
        :class="{ 'is-open': showToyPanel }"
        :title="showToyPanel ? '收起玩具面板' : (touchTarget ? '玩具（对 ' + touchTarget.display_name + '）' : '玩具（先选一个人）')"
        aria-label="玩具"
        @keydown.enter.prevent="openGroupPanel('toy')"
        @keydown.space.prevent="openGroupPanel('toy')"
        @click="openGroupPanel('toy')"
      >
        <svg viewBox="0 0 24 24" width="20" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" />
        </svg>
        <!-- 角标与私聊同口径：她正戴着几件（数量来自群聊自己按选中成员取的那份状态） -->
        <span v-if="groupWornToys.length > 0" class="touch-icon-badge">{{ groupWornToys.length }}</span>
      </div>
      <!-- ❤ 推进入口（2026-10-02）：同上，先选目标再开会话面板 -->
      <div
        role="button"
        tabindex="0"
        class="touch-icon-btn intimate-icon-btn"
        :class="{ 'is-open': showIntimatePanel }"
        :title="showIntimatePanel ? '收起推进面板' : (touchTarget ? '推进（对 ' + touchTarget.display_name + '）（继续抽插 / 加速 / 换姿势）' : '推进（先选一个人）')"
        aria-label="推进"
        @keydown.enter.prevent="openGroupPanel('intimate')"
        @keydown.space.prevent="openGroupPanel('intimate')"
        @click="openGroupPanel('intimate')"
      >
        <svg viewBox="0 0 24 24" width="20" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z" />
        </svg>
      </div>
      <div
        role="button"
        tabindex="0"
        class="send-btn"
        :class="{ 'is-disabled': !draft.trim() }"
        :aria-disabled="!draft.trim()"
        @keydown.enter.prevent="onSendClick"
        @keydown.space.prevent="onSendClick"
        @click="onSendClick"
        @pointerdown="onSendPressStart"
        @pointerup="onSendPressEnd"
        @pointercancel="onSendPressEnd"
        @pointerleave="onSendPressEnd"
        @contextmenu.prevent
        :title="store.undoing ? '正在撤回…' : '发送（长按可撤回上一轮）'"
      >
        <svg class="send-icon" viewBox="0 0 1024 1024" fill="#fff">
          <path d="M659.655431 521.588015q23.970037-6.71161 46.022472-13.423221 19.17603-5.752809 39.310861-11.505618t33.558052-10.546816l-13.423221 50.816479q-5.752809 21.093633-10.546816 31.640449-9.588015 25.88764-22.531835 47.940075t-24.449438 38.35206q-13.423221 19.17603-27.805243 35.475655l-117.932584 35.475655 96.838951 17.258427q-19.17603 16.299625-41.228464 33.558052-19.17603 14.382022-43.625468 30.202247t-51.29588 29.243446-59.925094 13.902622-62.801498-4.314607q-34.516854-4.794007-69.033708-16.299625 10.546816-16.299625 23.011236-36.434457 10.546816-17.258427 25.40824-40.749064t31.161049-52.254682q46.022472-77.662921 89.168539-152.449438t77.662921-135.191011q39.310861-69.992509 75.745318-132.314607-45.06367 51.775281-94.921348 116.014981-43.146067 54.651685-95.88015 129.917603t-107.385768 164.434457q-11.505618 18.217228-25.88764 42.187266t-30.202247 50.816479-32.599251 55.131086-33.078652 55.131086q-38.35206 62.322097-78.621723 130.397004 0.958801-20.134831 7.670412-51.775281 5.752809-26.846442 19.17603-67.116105t38.35206-94.921348q16.299625-34.516854 24.928839-53.692884t13.423221-29.722846q4.794007-11.505618 7.670412-15.340824-4.794007-5.752809-1.917603-23.011236 1.917603-15.340824 11.026217-44.58427t31.161049-81.977528q22.052434-53.692884 58.007491-115.535581t81.018727-122.726592 97.797753-117.932584 107.865169-101.153558 110.262172-72.389513 106.906367-32.11985q0.958801 33.558052-6.71161 88.689139t-19.17603 117.932584-25.88764 127.520599-27.805243 117.453184z" />
        </svg>
      </div>
    </div>

    <!-- 图片预览 -->
    <ImageLightbox
      :visible="!!previewUrl"
      :imgs="previewUrl || ''"
      @hide="previewUrl = null"
      @update:visible="v => { if (!v) previewUrl = null }"
      @deleted="onGroupImageDeleted"
    />

    <!-- 群头像选择器：本地上传 / 直接粘贴 / 相册最近图片，选完进裁剪 -->
    <Teleport to="body">
      <AvatarCropper
        v-if="showGroupAvatarPicker"
        title="设置群头像"
        :show-recent-tab="true"
        :recent-images="groupAlbumImages"
        :recent-loading="groupAlbumLoading"
        @close="showGroupAvatarPicker = false"
        @save="onGroupAvatarSave"
        @switch-to-recent="loadGroupAvatarRecents"
      />
    </Teleport>

    <!-- 群设置抽屉：头部标题 / 中部滚动表项 / 底部操作区三段式。
         表项再多也只撑中部滚动区，功能键永远留在屏幕内（PC 与手机同款）。 -->
    <Transition name="drawer">
      <div v-if="showSettings" class="gc-drawer-overlay" @click.self="showSettings = false">
        <div class="gc-drawer" role="dialog" aria-modal="true" aria-label="群设置">
          <div class="gc-drawer-head">
            <h3>群设置</h3>
            <linshe-button
              variant="icon"
              class="gc-drawer-close"
              title="关闭"
              aria-label="关闭群设置"
              @click="showSettings = false"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </linshe-button>
          </div>

          <div class="gc-drawer-body">
            <label class="gc-field">
              <span>群名称</span>
              <linshe-input v-model="editName" type="text" maxlength="24" />
            </label>
            <label class="gc-field">
              <span>群主题</span>
              <linshe-input v-model="editTopic" type="text" maxlength="60" placeholder="（可选）大家围绕什么话题聊" />
            </label>
            <div class="gc-field">
              <div class="gc-member-title"><span>群头像</span></div>
              <div class="gc-avatar-row">
                <div class="gc-avatar-preview" :style="groupAvatarUrl ? {} : { background: 'var(--accent)' }">
                  <img v-if="groupAvatarUrl" :src="groupAvatarUrl" alt="" />
                  <span v-else>{{ (store.activeGroup?.name || '群').charAt(0) }}</span>
                </div>
                <linshe-button size="sm" @click="openGroupAvatarPicker">设置群头像</linshe-button>
                <linshe-button
                  v-if="groupAvatarUrl"
                  variant="ghost"
                  size="sm"
                  :disabled="groupAvatarSaving"
                  @click="clearGroupAvatar"
                >
                  恢复默认
                </linshe-button>
              </div>
              <span class="gc-member-hint">上传图片、直接粘贴，或从相册最近图片中选取；不设置就显示成员拼图。</span>
            </div>
            <div class="gc-field">
              <div class="gc-member-title">
                <span>群相册</span>
                <span class="gc-temp-val">{{ groupImageCount }} 张</span>
              </div>
              <div class="gc-avatar-row">
                <linshe-button size="sm" @click="showGroupAlbum = true">查看群相册</linshe-button>
              </div>
              <span class="gc-member-hint">汇总本群里出现过的图片，可点开大图，或按成员筛选。</span>
            </div>
            <div class="gc-field">
              <div class="gc-member-title">
                <span>温度设置</span>
                <span class="gc-temp-val">{{ Number(editTemperature).toFixed(1) }}</span>
              </div>
              <linshe-slider
                aria-label="温度设置"
                :min="0.5" :max="1" :step="0.1"
                v-model="editTemperature"
                @change="onTemperatureChange"
              />
              <span class="gc-member-hint">群聊生成温度（所有群共享），越低越稳定、越高越有创意，默认 0.7。</span>
            </div>
            <div class="gc-field">
              <div class="gc-member-title">
                <span>携带上下文消息记忆轮数</span>
                <span class="gc-temp-val">{{ editSummaryInterval }} 轮</span>
              </div>
              <linshe-slider
                aria-label="携带上下文消息记忆轮数"
                :min="2" :max="6" :step="1"
                v-model="editSummaryInterval"
                @change="onSummaryIntervalChange"
              />
              <span class="gc-member-hint">达到设置轮数之后将上下文压缩成总结，默认 4 轮。</span>
            </div>
            <div class="gc-field">
              <div class="gc-member-title">
                <label for="group-activity">群聊活跃度</label>
                <span class="gc-temp-val">{{ editActivity }}</span>
              </div>
              <linshe-slider
                id="group-activity" v-model="editActivity"
                :min="1" :max="5" :step="1" :disabled="activitySaving"
                @change="onActivityChange"
              />
              <span class="gc-member-hint">所有群共享，默认 2。</span>
            </div>
            <div class="gc-field gc-member-field">
              <div class="gc-member-title">
                <span>群成员</span>
                <span>{{ editMemberIds.length }} / {{ sortedCharacters.length }}</span>
              </div>
              <div class="gc-member-edit">
                <div
                  v-for="c in sortedCharacters"
                  :key="c.id"
                  role="button"
                  tabindex="0"
                  class="gc-member-check"
                  :class="{ picked: editMemberIds.includes(c.id) }"
                  :aria-pressed="editMemberIds.includes(c.id)"
                  @keydown.enter.prevent="toggleMember(c.id)"
                  @keydown.space.prevent="toggleMember(c.id)"
                  @click="toggleMember(c.id)"
                >
                  <div class="gc-member-avatar" :style="c.avatar_path ? {} : { background: 'var(--accent)' }">
                    <img v-if="c.avatar_path" :src="c.avatar_path" class="avatar-img" alt="" />
                    <span v-else>{{ c.display_name.charAt(0) }}</span>
                  </div>
                  <span>{{ c.display_name }}</span>
                </div>
              </div>
              <span class="gc-member-hint">至少选择 2 位角色</span>
            </div>
          </div>

          <div class="gc-drawer-foot">
            <div class="gc-record-actions">
              <linshe-button
                class="gc-btn gc-btn-undo"
                variant="secondary"
                :disabled="!canUndo"
                @click="requestUndoLastRound"
              >
                撤回上一轮对话
              </linshe-button>
            </div>
            <div class="gc-drawer-actions">
              <linshe-button class="gc-btn" variant="danger" @click="onDissolve">解散群聊</linshe-button>
              <linshe-button class="gc-btn" variant="primary" :disabled="editMemberIds.length < 2" @click="onSaveSettings">保存</linshe-button>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 群相册：只收本群消息里的图片，入口在群设置的「群相册」 -->
    <GroupAlbumModal
      v-model="showGroupAlbum"
      :group="store.activeGroup"
      :messages="store.messages"
      @deleted="onGroupImageDeleted"
    />

    <!-- 点头像弹出的成员操作小窗 -->
    <Teleport to="body">
      <Transition name="avatar-pop">
        <div v-if="avatarMenu" class="avatar-pop-layer" @click.self="avatarMenu = null">
          <div class="avatar-pop-card" :style="avatarMenuStyle" role="dialog" aria-label="成员操作">
            <div class="avatar-pop-head">
              <div class="avatar-pop-avatar" :style="avatarMenu.member.avatar_path ? {} : { background: 'var(--accent)' }">
                <img v-if="avatarMenu.member.avatar_path" :src="avatarMenu.member.avatar_path" class="avatar-img" alt="" />
                <span v-else class="avatar-pop-fallback">{{ avatarMenu.member.display_name?.charAt(0) || '?' }}</span>
              </div>
              <div class="avatar-pop-info">
                <div class="avatar-pop-name">{{ avatarMenu.member.display_name }}</div>
                <div class="avatar-pop-sub">群聊成员</div>
              </div>
            </div>
            <div class="avatar-pop-actions">
              <div class="avatar-pop-btn" role="button" tabindex="0" @keydown.enter.prevent="startPrivateChat(avatarMenu.member)" @keydown.space.prevent="startPrivateChat(avatarMenu.member)" @click="startPrivateChat(avatarMenu.member)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                <span>私聊</span>
              </div>
              <div class="avatar-pop-btn" role="button" tabindex="0" @keydown.enter.prevent="viewMemberMoments(avatarMenu.member)" @keydown.space.prevent="viewMemberMoments(avatarMenu.member)" @click="viewMemberMoments(avatarMenu.member)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
                <span>查看ta的朋友圈</span>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 催眠手机（群聊版）：选人 → 单人=完整面板 / 多人=批量 -->
    <linshe-modal v-model="showHypnosisPhone" title="催眠手机" panel-class="gc-hypno-modal">
      <HypnosisPhoneGroupPanel :members="store.activeGroup?.members || []" />
    </linshe-modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted, inject } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGroupsStore } from '../stores/groups.js'
import { useChatStore } from '../stores/chat.js'
import { useMomentsStore } from '../stores/moments.js'
import { getConfig, updateGroupActivity, updateGroupSummaryInterval, updateGroupTemperature, listGalleryImages, fetchTouchActions, fetchTouchState, performTouchAction } from '../api/index.js'
// 玩具面板的"父组件那一半"要用到这几个接口（戴上/调强度/摘下/取状态）；
// 与 ChatView 同一写法：再引一个命名空间（api.xxx），这样与私聊的口径逐字对得上。
import * as api from '../api/index.js'
import TouchActionPanel from '../components/TouchActionPanel.vue'
// 群聊也要能开「🧸 玩具 / ❤ 推进」面板（2026-10-02 用户：「群聊里也没有动作系统和玩具 性爱系统的按钮」）。
// 两个面板都是**自包含**的（自己取数、自己轮询、自己 POST、门控文案也自己出），所以这里只做两件事：
//   ① 先校验"当前选中的群成员"（纯函数在 components/groupPanelLogic.js ⇒ 口径能被测试钉住）；
//   ② 把那个人的 id 喂进 `:character-id`。
// ⚠️ 刻意**不传** `worn-toys` / `toy-options`：ToyPanel 的这两个 prop 有默认值、面板会自己去取，
//    私聊那份 props 只是"打开瞬间别闪空"的回落（见 ToyPanel.vue 的 defineProps 注释）。
import ToyPanel from '../components/ToyPanel.vue'
import IntimateActionPanel from '../components/IntimateActionPanel.vue'
import { resolveGroupPanelTarget } from '../components/groupPanelLogic.js'
import { buildGroupsFromServer, createCoalescer, hypnosisBadgeOf, pendingHintByMode } from '../components/touchActionLogic.js'
import { getHypnosisState } from '../api/hypnosis.js'
import { userAvatar, loadUserAvatar } from '../userConfig.js'
import ImageLightbox from '../components/ImageLightbox.vue'
import ImageGenBubble from '../components/ImageGenBubble.vue'
import GroupAlbumModal from '../components/GroupAlbumModal.vue'
import AvatarCropper from '../components/AvatarCropper.vue'
import HypnosisPhoneGroupPanel from '../components/HypnosisPhoneGroupPanel.vue'
import LinsheModal from '../components/ui/LinsheModal.vue'
import LinsheButton from '../components/ui/LinsheButton.vue'
import LinsheSlider from '../components/ui/LinsheSlider.vue'
import LinsheInput from '../components/ui/LinsheInput.vue'
import { collectGroupImages } from '../utils/groupAlbum.js'
import { applyMention, useMentionPicker } from '../composables/useMentionPicker.js'

const route = useRoute()
const router = useRouter()
const store = useGroupsStore()
const chat = useChatStore()
const momentsStore = useMomentsStore()
const confirmFn = inject('confirm', null)
const toast = inject('toast', null)

const scrollEl = ref(null)
const msgListInner = ref(null)
const inputEl = ref(null)
const draft = ref('')
const mentionListEl = ref(null)
const mention = useMentionPicker(() => store.activeGroup?.members || [])
const {
  open: showMentionPicker,
  index: mentionIndex,
  options: mentionOptions,
  activeId: activeMentionId,
} = mention

// ── SLG 动作系统（阶段二·群聊）：对指定成员做动作 ──
// 门控吃服务端（GET .../touch/actions?scene=group 的逐条 gate），镜像只兜底；
// 反应由后端写进群会话并 broadcast('group_message')，本页 groups store 既有监听负责渲染 ——
// 前端**不自己插消息**（不伪造、不重复插）。
const touchTargetId = ref(null)
const touchTarget = computed(() =>
  (store.activeGroup?.members || []).find(m => m.id === touchTargetId.value) || null)
const touchServerGroups = ref([])
// §4.2 连点：**同动作在飞时忽略重复点击、不同动作可并发** ⇒ 单个 key 换成 Set
const touchBusyActions = ref(new Set())
const showTargetPicker = ref(false)

// 「对谁」复用本页既有的 @提及成员选择器：同一份 store.activeGroup.members、同一套 .mention-panel 视觉；
// includeAll=false —— 动作只能对具体成员做，不能对「全体成员」
const targetPicker = useMentionPicker(() => store.activeGroup?.members || [], { includeAll: false })
const { options: targetOptions, index: targetIndex } = targetPicker

function openTargetPicker() {
  if (!(store.activeGroup?.members || []).length) {
    toast?.('这个群里还没有成员', 'info')
    return
  }
  targetPicker.close()
  showTargetPicker.value = true
}

function closeTargetPicker() {
  showTargetPicker.value = false
  targetPicker.close()
}

function pickTarget(opt) {
  if (!opt || opt.isAll) return
  touchTargetId.value = opt.id
  closeTargetPicker()
}

/** 拉目标成员的动作清单 + 服务端逐条门控（群聊口径：scene=group） */
async function loadTouchActions() {
  const targetId = touchTargetId.value
  if (!targetId || !store.activeGroupId) { touchServerGroups.value = []; return }
  try {
    // allowGroupAdult 保持 false：专题 §2.2「群聊 Lv3 默认拦截」，服务端据此给 group_adult_blocked
    const payload = await fetchTouchActions(targetId, { scene: 'group' })
    if (touchTargetId.value !== targetId) return   // 期间换了对象：丢弃过期响应
    touchServerGroups.value = buildGroupsFromServer(payload)
  } catch (err) {
    console.warn('[touch] 群聊动作清单拉取失败，回落镜像门控:', err?.message || err)
    touchServerGroups.value = []
  }
}

// ── 待回应条数（task-29 问题 2/3）：群聊口径 ──
// 数据：GET .../touch/state?scene=group&groupId=<n> 的 pendingCount（不传参数 = 旧行为 / 私聊口径）。
// ⚠️ 口径（docs/touch-system.md §3.8）：群聊口径统计的是**整个群**还没被注入的动作，
//    **不按 character 过滤**（群聊页要的是「这个群还有几件事」）——路径里的角色 id 只用来定位会话。
//    响应同时带 pendingCounts.chat / pendingCounts.group，前端统一读 pendingCount 即可。
// ── 催眠状态徽标（复审遗留 2）──
// **状态一律服务端说了算**：读 GET /characters/:id/hypnosis 的 { active, mindAwake }，前端零推断；
// 取不到 / 形状不对 ⇒ null（面板不渲染，绝不默认「完全控制」）。
const touchHypnosisBadge = ref(null)
async function loadTouchHypnosis() {
  const charId = touchPathId()
  if (!charId) { touchHypnosisBadge.value = null; return }
  try {
    const st = await getHypnosisState(charId)
    if (charId !== touchPathId()) return   // 过期响应丢弃（切了目标 / 会话）
    touchHypnosisBadge.value = hypnosisBadgeOf(st)
  } catch {
    touchHypnosisBadge.value = null   // 取不到就不显示，绝不猜
  }
}
function onTouchPanelOpen() { loadTouchActions(); loadTouchHypnosis() }

const touchPendingCount = ref(0)
/** 分模式待回应数（专题 §七 问题 3；后端未落地时为空对象 → 文案回落） */
const touchPendingByMode = ref({})
/** 入口角标标题 / 面板提示行同源文案 */
const touchPendingHint = computed(() => pendingHintByMode({ count: touchPendingCount.value, byMode: touchPendingByMode.value }))
/** 动作面板显隐（✋ 入口点开） */
const showTouchPanel = ref(false)

// ── 群聊里的「🧸 玩具 / ❤ 推进」入口（2026-10-02 用户：「群聊里也没有动作系统和玩具 性爱系统的按钮」）──
/** 玩具面板显隐（🧸 入口点开） */
const showToyPanel = ref(false)
/** 性爱推进面板显隐（❤ 入口点开） */
const showIntimatePanel = ref(false)
/** 面板作用的群成员 id：在**打开那一刻**从 touchTargetId 锁定（换人时下面的 watch 会把面板关掉） */
const panelCharacterId = ref(null)

/**
 * 点 🧸 / ❤ 的统一入口。
 *
 * 群聊与私聊最大的差别：群里有很多人，这两个面板一次只能作用于**一个人** ⇒ 必须先选定"对谁"。
 * 这里刻意**不**回落到 `members[0]`（纯函数 resolveGroupPanelTarget 里也是这么写的）：
 * 默认拿第一个人会让用户以为"点一下就能玩"，实际作用在别人身上 —— 那是更难查的错。
 * 没选目标时给一句人话就返回，不打开面板、也不默默无反应。
 */
function openGroupPanel (kind) {
  const r = resolveGroupPanelTarget({
    targetId: touchTargetId.value,
    members: store.activeGroup?.members || [],
  })
  if (!r.ok) {
    toast?.(r.message, 'info')
    return
  }
  panelCharacterId.value = r.characterId
  if (kind === 'toy') {
    showToyPanel.value = !showToyPanel.value
    if (showToyPanel.value) loadGroupToys()   // 打开时按选中成员取一次穿戴状态（与私聊同口径）
  } else {
    showIntimatePanel.value = !showIntimatePanel.value
  }
}

// 换目标（或换群导致目标被清空）时把面板收起来：面板里的 id 是打开那一刻锁定的，继续开着会作用错人。
watch(touchTargetId, () => {
  showToyPanel.value = false
  showIntimatePanel.value = false
  groupWornToys.value = []
  groupToyOptions.value = []
})

// ── 玩具面板的"父组件那一半" ──────────────────────────────────────────────
// ⚠️ 实测结论（2026-10-02，别被"面板是自包含的"误导）：
//   `IntimateActionPanel` 是**完全自包含**的（自己 GET 状态、自己 POST 动作）⇒ 群聊只要给 characterId；
//   而 `ToyPanel` **只有一半自包含**：模式 / 曲线 / "她自己玩" 由它自己 POST，
//   但**戴上 / 调强度 / 摘下**三件事是 `emit` 给父组件去做的（见 ToyPanel.vue 的 emit('toy-equip' | 'toy-intensity' | 'toy-remove')）。
//   私聊由 ChatView.onToyEquip / onToyIntensity / onToyRemove + loadToys 承担 ⇒ 群聊必须按**同一口径**补齐，
//   否则那三个按钮在群里点了没反应（正是用户抱怨的"按钮点不出来"）。
//   同理 `worn-toys` / `toy-options` 也要喂（私聊就是这么喂的），这样戴上之后角标与列表会立刻更新。
/** 选中成员当前戴着的玩具（喂给面板 + 用于 🧸 入口角标） */
const groupWornToys = ref([])
/** 选中成员的背包可选项（喂给面板；不喂也能用，面板会回落前端镜像） */
const groupToyOptions = ref([])

/**
 * 玩具接口的场景参数（2026-10-03 群聊 bug）：
 * 群聊里**每一次**玩具请求都要带 `scene:'group'` + `groupId`，否则她的反应与配图会被写到私聊
 * （群里什么都看不到），群聊成人开关也形同虚设。判定只写这一处，三个 handler + 取状态共用。
 * ⚠️ 群 id 万一还没拿到也**照样声明 scene:'group'**（只是不带 groupId）：服务端会回 400 + 人话，
 * 而不会像"什么都不传"那样悄悄按私聊写进 `char_<id>`（那正是这次 bug 的形态）。
 */
function groupToyScene () {
  const groupId = store.activeGroupId
  return groupId ? { scene: 'group', groupId } : { scene: 'group' }
}

/** 取选中成员的玩具状态（与 ChatView.loadToys 同一口径，只是角色换成"群里选中的那个人"） */
async function loadGroupToys () {
  const charId = panelCharacterId.value
  if (!charId || !showToyPanel.value) {
    if (!showToyPanel.value) { groupWornToys.value = []; groupToyOptions.value = [] }
    return
  }
  try {
    // 群聊口径：服务端据此给出**群里**的逐件门控（群聊成人开关关着 = 每件 allowed:false）
    const res = await api.fetchToys(charId, groupToyScene())
    groupWornToys.value = Array.isArray(res?.worn) ? res.worn : []
    groupToyOptions.value = Array.isArray(res?.available) ? res.available : []
  } catch {
    // 门控被拒 / 网络问题：留空即可，面板自己还会再取一次并显示它自己的人话
    groupWornToys.value = []
    groupToyOptions.value = []
  }
}

/**
 * 批量装卸完成的回执：重取群聊那份玩具状态。
 *
 * 与 ChatView.onToyBatchDone **同一口径、同一理由**（2026-10-04 用户反馈：
 * 「清空是清空了，但是右下角的红色数字角标还是继续在」）：
 * 角标读的是**父组件自己的** `groupWornToys`（L289 `v-if="groupWornToys.length > 0"`），
 * 而批量是面板直接 POST、父组件毫不知情 —— 单件那三条 emit 没这问题是因为本来就经过父组件。
 *
 * 她的一句话由**服务端**在批量端点里发布（一次批量 = 一条汇总反应），这里只补父组件那份状态。
 */
async function onGroupToyBatchDone () {
  await loadGroupToys()
}

async function onGroupToyEquip (toyKey) {
  const charId = panelCharacterId.value
  if (!charId || !toyKey) return
  try {
    const res = await api.equipToy(charId, toyKey, { intensity: 1 }, groupToyScene())
    toast?.(res?.toy?.label ? `已给她戴上：${res.toy.label}` : '已经戴上了', 'info')
    await loadGroupToys()
  } catch (err) {
    toast?.(err?.message || '没戴上', 'error')   // 门控被拒时后端会带人话文案
  }
}

async function onGroupToyIntensity ({ toyKey, intensity } = {}) {
  const charId = panelCharacterId.value
  if (!charId || !toyKey) return
  try {
    await api.setToyIntensity(charId, toyKey, intensity, groupToyScene())
    await loadGroupToys()
  } catch (err) {
    toast?.(err?.message || '强度没调成', 'error')
  }
}

async function onGroupToyRemove (toyKey) {
  const charId = panelCharacterId.value
  if (!charId || !toyKey) return
  try {
    await api.removeToy(charId, toyKey, groupToyScene())
    await loadGroupToys()
  } catch (err) {
    toast?.(err?.message || '没摘下来', 'error')
  }
}
/** 每动作的耐受 / 偏好（GET /touch/state 的 states）→ 面板卡片状态行与偏好角标 */
const touchStates = ref({})

/** 群聊口径的路径角色：优先当前选中的对象，没选就用群里第一个成员（计数与谁无关，只用来定位） */
function touchPathId() {
  return touchTargetId.value || (store.activeGroup?.members || [])[0]?.id || null
}

async function loadTouchState() {
  const groupId = store.activeGroupId
  const pathId = touchPathId()
  if (!groupId || !pathId) { touchPendingCount.value = 0; touchStates.value = {}; touchPendingByMode.value = {}; return }
  try {
    const payload = await fetchTouchState(pathId, { scene: 'group', groupId })
    // 换群 / 换路径角色：丢弃过期响应
    if (store.activeGroupId !== groupId || touchPathId() !== pathId) return
    const raw = Number(payload && payload.pendingCount) || 0
    touchPendingCount.value = raw > 0 ? Math.floor(raw) : 0
    // 卡片状态行（耐受档 / 偏好角标）吃 states；缺字段就空着，不影响可用性
    touchStates.value = payload && payload.states && typeof payload.states === 'object' ? payload.states : {}
    touchPendingByMode.value = payload && payload.pendingByMode && typeof payload.pendingByMode === 'object' ? payload.pendingByMode : {}
    touchPendingByMode.value = payload && payload.pendingByMode && typeof payload.pendingByMode === 'object' ? payload.pendingByMode : {}
  } catch (err) {
    // 端点不可用 / 字段缺失：静默归零，别打断主流程
    touchPendingCount.value = 0
    touchStates.value = {}
  }
}

// 她回应那一轮会连续插好几条群消息 —— 合并成一次刷新，别把请求打爆
const touchStateCoalescer = createCoalescer({ run: () => { loadTouchState() } })
function scheduleTouchStateRefresh() { touchStateCoalescer.schedule() }

// 换群 / 换对象时重拉；成员被移出群导致对象失效时清掉选择
watch([() => store.activeGroupId, touchTargetId], () => {
  const members = store.activeGroup?.members || []
  if (touchTargetId.value && !members.some(m => m.id === touchTargetId.value)) touchTargetId.value = null
  touchStateCoalescer.cancel()   // 换对象 / 换群：别让上一轮待合并的刷新落到新对象头上
  loadTouchActions()
  loadTouchState()
}, { immediate: true })

async function onTouchAction(actionId) {
  const targetId = touchTargetId.value
  const groupId = store.activeGroupId
  if (!targetId || !groupId || !actionId || touchBusyActions.value.has(actionId)) return
  touchBusyActions.value = new Set(touchBusyActions.value).add(actionId)
  try {
    const res = await performTouchAction(targetId, actionId, { scene: 'group', groupId })
    // 门控拒绝 = 200 + { allowed:false, code, message }（叙事结果，不是请求失败）→ 直接 toast 服务端那句
    if (!res || res.allowed !== true) {
      if (res?.message) toast?.(res.message, 'info')
      return
    }
    // 真机反馈问题 2：她开始说话了，面板让位（隐式这轮没反应 ⇒ 留着让用户接着来）
    // §4.2：「成功后自动收起」作废（面板常驻，可连着摸 / 连点不同动作并发）。
    // 注：占位气泡只在私聊实现（群聊走 group_message 另一条流），这里不涉及。
    if (res.notice) toast?.(res.notice, 'info')
    else if (res.mode === 'implicit') toast?.('她的反应会在下次发言时出现', 'info')
    // 即时反应由后端写进群会话并广播 group_message —— 本页 groups store 会渲染成该成员的气泡，
    // 所以这里**不手动渲染、不重复插入**。
  } catch (err) {
    toast?.(err?.message || '动作失败', 'error')
  } finally {
    touchBusyActions.value.delete(actionId)
    loadTouchActions()
    loadTouchState()   // 待回应条数也变了（task-29）
  }
}

const showGroupAlbum = ref(false)
const showSettings = ref(false)
/** 催眠手机（群聊版）弹窗 */
const showHypnosisPhone = ref(false)
const previewUrl = ref(null)
const isFollowingLatest = ref(true)
const hasNewMessages = ref(false)
const avatarMenu = ref(null)

const editName = ref('')
const editTopic = ref('')
const editMemberIds = ref([])
const editTemperature = ref(0.7)
const editSummaryInterval = ref(4)
const editActivity = ref(2)
const activityDelaySeconds = { 1: 80, 2: 40, 3: 27, 4: 20, 5: 16 }
const savedActivity = ref(2)
const activitySaving = ref(false)

async function loadGroupActivity() {
  try {
    const cfg = await getConfig()
    const level = cfg?.groupChat?.activity
    if (Number.isInteger(level) && level >= 1 && level <= 5) {
      savedActivity.value = editActivity.value = level
    }
  } catch { /* 保留最近一次成功读取的值 */ }
}

async function onActivityChange() {
  if (activitySaving.value) return
  activitySaving.value = true
  try {
    const res = await updateGroupActivity(editActivity.value)
    savedActivity.value = editActivity.value = res.activity
    armLullTimer()
    toast?.('群聊活跃度已保存', 'success')
  } catch (err) {
    editActivity.value = savedActivity.value
    toast?.(err.message || '群聊活跃度保存失败', 'error')
  } finally { activitySaving.value = false }
}
// 群设置里的群相册入口：只在抽屉打开时统计，避免长会话在后台反复重算
const groupImageCount = computed(() => (
  showSettings.value ? collectGroupImages(store.messages, store.activeGroup).length : 0
))
const canUndo = computed(() => (
  store.messages.length > 0 && !store.sending && !store.playing && !store.undoing
))
const sortedCharacters = computed(() => [...chat.characters].sort((left, right) => (
  (left.display_name || '').localeCompare(right.display_name || '', 'zh-CN-u-co-pinyin', { sensitivity: 'base' })
)))

// ── 头像 ──

function memberOf(msg) {
  return (store.activeGroup?.members || []).find(m => m.id === msg.speaker_character_id)
    || chat.characters.find(c => c.id === msg.speaker_character_id)
    || null
}
function msgAvatarSrc(msg) {
  if (msg.role === 'user') return userAvatar.value || ''
  return memberOf(msg)?.avatar_path || msg.speaker_avatar || ''
}
function avatarFallback(msg) {
  return msgAvatarSrc(msg) ? '' : (msg.role === 'user' ? '我' : (msg.speaker_name || '?').charAt(0))
}
// 表情包贴纸（/images/emoji/）按 140px 渲染，与私聊 .msg-sticker-img 同款
function isEmojiSticker(url) {
  return typeof url === 'string' && url.includes('/images/emoji/')
}
// 表情包与私聊一致不可点击放大，仅普通图片打开大图预览
function onImageClick(url) {
  if (isEmojiSticker(url)) return
  previewUrl.value = url
}

const AVATAR_POP_W = 320
const AVATAR_POP_H = 168
const avatarMenuStyle = computed(() => {
  const menu = avatarMenu.value
  if (!menu) return {}
  const gap = 12
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  let left = Math.min(menu.x + gap, viewportW - AVATAR_POP_W - gap)
  let top = menu.y + gap
  if (top + AVATAR_POP_H > viewportH - gap) top = menu.y - AVATAR_POP_H - gap
  left = Math.max(gap, Math.min(left, viewportW - AVATAR_POP_W - gap))
  top = Math.max(gap, Math.min(top, viewportH - AVATAR_POP_H - gap))
  return { left: `${left}px`, top: `${top}px` }
})

function openAvatarMenu(member, event) {
  if (!member?.id) return
  avatarMenu.value = { member, x: event?.clientX ?? 0, y: event?.clientY ?? 0 }
}

function openMsgAvatarMenu(msg, event) {
  const member = memberOf(msg)
  if (member) openAvatarMenu(member, event)
}

function startPrivateChat(member) {
  avatarMenu.value = null
  router.push(`/chat/${member.id}`)
}

function viewMemberMoments(member) {
  avatarMenu.value = null
  momentsStore.setFilter(member.id)
  router.push({ path: '/moments', query: { character_id: member.id } })
}

/** 适配 ImageGenBubble 的 msg 结构：群聊 images 存 url 字符串数组，组件期望 [{url}] */
function genMsgOf(msg) {
  return {
    genId: msg.id,
    genStatus: msg.genStatus,
    genProgress: msg.genProgress,
    genError: msg.genError,
    images: (msg.images || []).map(u => (typeof u === 'string' ? { url: u } : u)),
  }
}

function onGroupImageLoaded(msgId) {
  store.markGroupImageLoaded(msgId)
}

function onGroupImageDeleted(deletedUrl) {
  const base = String(deletedUrl || '').replace(/\?.*$/, '')
  if (!base) return
  for (const msg of store.messages) {
    if (!Array.isArray(msg.images)) continue
    msg.images = msg.images.filter(img => {
      const url = typeof img === 'string' ? img : img?.url
      return !url || url.replace(/\?.*$/, '') !== base
    })
  }
  previewUrl.value = null
}
/** 连续同一发言人 → 隐藏头像和名字（与私聊 msg-same-role 一致）；跨时间分隔符时重新显示 */
function isSameSpeaker(idx) {
  if (idx === 0) return false
  if (store.visibleMessages[idx]?.id === store.lastSeenDividerId) return false
  if (showTimeDivider(idx)) return false
  const cur = store.visibleMessages[idx]
  const prev = store.visibleMessages[idx - 1]
  return cur.role === prev.role && cur.speaker_character_id === prev.speaker_character_id
}

// ── 时间分隔符（与私聊同款规则：相邻消息间隔超 10 分钟显示一条时间） ──

function showTimeDivider(idx) {
  const cur = store.visibleMessages[idx]
  if (!cur?.created_at) return false
  if (idx === 0) return true
  const prev = store.visibleMessages[idx - 1]
  if (!prev?.created_at) return false
  return Math.abs(new Date(cur.created_at) - new Date(prev.created_at)) > 10 * 60 * 1000
}

function timeLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso); const now = new Date(); const diff = now - d
  const hh = d.getHours().toString().padStart(2,'0'); const mm = d.getMinutes().toString().padStart(2,'0')
  const time = hh + ':' + mm
  if (d.toDateString() === now.toDateString()) return time
  const y = new Date(now); y.setDate(y.getDate()-1)
  if (d.toDateString() === y.toDateString()) return '昨天 ' + time
  y.setDate(y.getDate()-1)
  if (d.toDateString() === y.toDateString()) return '前天 ' + time
  if (Math.floor(diff/86400000) < 7 && d.getDay() !== now.getDay()) {
    return ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()] + ' ' + time
  }
  return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate()+' '+time
}

// ── 进入/切换群 ──

async function enterGroup(id) {
  if (!id) return
  isFollowingLatest.value = true
  hasNewMessages.value = false
  await loadGroupActivity()
  await store.loadGroups()
  await store.selectGroup(parseInt(id, 10))
  scrollToBottom(true)   // 进群直接定位底部，不要缓动
  setupResizeObserver()  // 与私聊一致：历史图片异步加载撑高列表时自动追底
  armLullTimer()
}

let observedMessageCount = 0

watch(() => route.params.id, (id) => { if (route.path.startsWith('/group/')) enterGroup(id) })
watch(() => store.scrollSignal, () => {
  const messageCount = store.messages.length
  const receivedNewMessage = messageCount > observedMessageCount
  observedMessageCount = messageCount
  if (isFollowingLatest.value) scrollToBottom()
  else if (receivedNewMessage) hasNewMessages.value = true
  armLullTimer()
  // task-29 问题 3：新消息往往就是「她回应了」⇒ 刷新「还有 N 个动作」（合并，同一轮多条只刷一次）
  scheduleTouchStateRefresh()
})

// 切换群时收起群相册，避免停留时看到上一个群的图片
watch(() => store.activeGroupId, () => { showGroupAlbum.value = false })

watch(showSettings, (open) => {
  if (open && store.activeGroup) {
    editName.value = store.activeGroup.name
    editTopic.value = store.activeGroup.topic || ''
    editMemberIds.value = store.activeGroup.members.map(m => m.id)
    loadGroupActivity()
    loadGroupTemperature()
    loadGroupSummaryInterval()
  }
})

// Esc 关闭群设置（手机端铺满整宽、点不到遮罩时靠头部关闭键与 Esc 兜底）
function onSettingsKeydown(e) {
  if (e.key === 'Escape') showSettings.value = false
}
watch(showSettings, (open) => {
  if (open) window.addEventListener('keydown', onSettingsKeydown)
  else window.removeEventListener('keydown', onSettingsKeydown)
}, { immediate: true })

// ── 温度设置（全局共享，写入 system_settings） ──

let temperatureLoading = false

async function loadGroupTemperature() {
  if (temperatureLoading) return
  temperatureLoading = true
  try {
    const cfg = await getConfig()
    const t = cfg?.groupChat?.temperature
    if (typeof t === 'number') editTemperature.value = Math.max(0.5, Math.min(1.2, t))
  } catch { /* 拉取失败保留当前值 */ }
  finally { temperatureLoading = false }
}

async function onTemperatureChange() {
  const v = Math.max(0.5, Math.min(1.2, Number(editTemperature.value) || 0.7))
  editTemperature.value = v
  try {
    const res = await updateGroupTemperature(v)
    if (typeof res?.temperature === 'number') editTemperature.value = res.temperature
    toast?.('温度设置已保存', 'success')
  } catch (err) {
    toast?.(err.message || '温度设置保存失败', 'error')
  }
}

// ── 记忆总结轮次（全局共享，写入 system_settings） ──

let summaryIntervalLoading = false

async function loadGroupSummaryInterval() {
  if (summaryIntervalLoading) return
  summaryIntervalLoading = true
  try {
    const cfg = await getConfig()
    const n = cfg?.groupChat?.summaryInterval
    if (Number.isInteger(n)) editSummaryInterval.value = Math.max(2, Math.min(6, n))
  } catch { /* 拉取失败保留当前值 */ }
  finally { summaryIntervalLoading = false }
}

async function onSummaryIntervalChange() {
  const v = Math.max(2, Math.min(6, Math.round(Number(editSummaryInterval.value) || 4)))
  editSummaryInterval.value = v
  try {
    const res = await updateGroupSummaryInterval(v)
    if (Number.isInteger(res?.summaryInterval)) editSummaryInterval.value = res.summaryInterval
    toast?.('记忆总结轮次已保存', 'success')
  } catch (err) {
    toast?.(err.message || '记忆总结轮次保存失败', 'error')
  }
}

onMounted(() => {
  store.connectSSE()
  enterGroup(route.params.id)
  if (chat.characters.length === 0) chat.loadCharacters?.()
  if (!userAvatar.value) loadUserAvatar()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  clearLullTimer()
  clearSendPressTimer()
  clearTimeout(autoScrollTimer)
  teardownResizeObserver()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('keydown', onSettingsKeydown)
  store.leaveGroup()
})

// ResizeObserver：进群后临时监听内容区高度变化（图片加载撑高），追底后自毁（与私聊同款）
let resizeObserver = null
let resizeRaf = null
let lastObservedSH = 0
let resizeObserverTimer = null
const RESIZE_OBSERVER_TTL = 2000
const BOTTOM_THRESHOLD = 16
let autoScrollTimer = null
let isAutoScrolling = false

function isNearBottom(el = scrollEl.value) {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
}

function syncFollowingState() {
  const atBottom = isNearBottom()
  isFollowingLatest.value = atBottom
  if (atBottom) hasNewMessages.value = false
}

function onMessageScroll() {
  if (isAutoScrolling) return
  syncFollowingState()

  const el = scrollEl.value
  if (el?.scrollTop < 40 && store.hasMoreOlder) {
    const prevHeight = el.scrollHeight
    store.expandWindow()
    nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollTop += scrollEl.value.scrollHeight - prevHeight
    })
  }
}

function onUserScrollIntent() {
  isAutoScrolling = false
  clearTimeout(autoScrollTimer)
  autoScrollTimer = null
  requestAnimationFrame(syncFollowingState)
}

function returnToLatest() {
  isFollowingLatest.value = true
  hasNewMessages.value = false
  scrollToBottom()
}

function setupResizeObserver() {
  teardownResizeObserver()
  nextTick(() => {
    const inner = msgListInner.value
    const el = scrollEl.value
    if (!inner || !el) return
    lastObservedSH = el.scrollHeight
    resizeObserver = new ResizeObserver(() => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        const el2 = scrollEl.value
        if (!el2 || store.playing) return
        const newSH = el2.scrollHeight
        if (newSH === lastObservedSH) return
        // 必须用变化前的高度判断：进群时异步内容撑高，不等于用户主动离开底部。
        const distBefore = lastObservedSH - el2.scrollTop - el2.clientHeight
        lastObservedSH = newSH
        if (distBefore > BOTTOM_THRESHOLD) return
        isFollowingLatest.value = true
        hasNewMessages.value = false
        el2.scrollTop = el2.scrollHeight
        // 完成一次追底后延迟自毁：给剩余图片 500ms 缓冲
        clearTimeout(resizeObserverTimer)
        resizeObserverTimer = setTimeout(teardownResizeObserver, 500)
      })
    })
    resizeObserver.observe(inner)
    // TTL 到期强制自毁，防意外长驻
    resizeObserverTimer = setTimeout(teardownResizeObserver, RESIZE_OBSERVER_TTL)
  })
}

function teardownResizeObserver() {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeRaf) { cancelAnimationFrame(resizeRaf); resizeRaf = null }
  clearTimeout(resizeObserverTimer)
  resizeObserverTimer = null
  lastObservedSH = 0
}

// 与私聊一致：新消息平滑滚动到底，force 时（进群/切群）瞬间定位
function scrollToBottom(force = false) {
  nextTick(() => {
    const el = scrollEl.value
    if (!el) return
    isAutoScrolling = true
    clearTimeout(autoScrollTimer)
    autoScrollTimer = null
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (force || reduceMotion) {
      el.scrollTop = el.scrollHeight
      // 首次渲染的字体/图片可能在同一帧继续改变高度，再校正一次后才开放用户滚动判定。
      autoScrollTimer = setTimeout(() => {
        if (!isAutoScrolling) return
        el.scrollTop = el.scrollHeight
        isAutoScrolling = false
        autoScrollTimer = null
        syncFollowingState()
      }, force ? 50 : 0)
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    autoScrollTimer = setTimeout(() => {
      isAutoScrolling = false
      autoScrollTimer = null
      syncFollowingState()
    }, 450)
  })
}

// ── 冷场检测：活跃度只调整等待时长和轮数上限（默认 40 秒 / 2 轮） ──
let lullTimer = null

function clearLullTimer() {
  if (lullTimer) { clearTimeout(lullTimer); lullTimer = null }
}

function armLullTimer() {
  clearLullTimer()
  if (!route.path.startsWith('/group/')) return
  lullTimer = setTimeout(tryLull, activityDelaySeconds[savedActivity.value] * 1000)
}

async function tryLull() {
  lullTimer = null
  if (!route.path.startsWith('/group/')) return
  // 页面不可见 / 正在发送 / 正在播放 / 次数用尽 → 不触发；除次数用尽外重新计时
  if (document.visibilityState !== 'visible') return  // 等 visibilitychange 恢复计时
  if (store.sending || store.playing) { armLullTimer(); return }
  store.resetLullOnNewDay()
  if (store.lullCount >= savedActivity.value) { armLullTimer(); return }
  store.lullCount++
  const accepted = await store.nudge()
  if (!accepted) store.lullCount--
  // 新消息到达会经 scrollSignal 重新计时；这里兜底再计一次
  armLullTimer()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') armLullTimer()
  else clearLullTimer()
}

// ── 输入 / @点名 ──

// @ 面板：输入 @ 后可按名字过滤；↑↓ 选择、回车确认（面板打开时回车不发送）、Esc 关闭。
// 候选与状态机见 composables/useMentionPicker.js，首项固定是 @全体成员。

function syncInputHeight() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function scrollMentionIntoView() {
  nextTick(() => {
    const el = mentionListEl.value?.children?.[mentionIndex.value]
    el?.scrollIntoView({ block: 'nearest' })
  })
}

/** draft 任何变化（打字、Shift+Enter 换行、选中后回填）都重新对齐面板 */
function syncMention(text) {
  // 一开始打字就收起「对谁」面板：两个面板互斥，同开会在输入区上方打架
  if (showTargetPicker.value) closeTargetPicker()
  if (mention.sync(text)) scrollMentionIntoView()
}

watch(draft, syncMention)

/** ↑↓ 在面板里挪选择；面板没开时保持光标默认行为 */
function onMentionArrow(delta, event) {
  if (event.isComposing) return   // 中文输入法选词时把 ↑↓ 留给输入法
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
  if (!mention.move(delta)) return
  event.preventDefault()
  scrollMentionIntoView()
}

function onMentionEscape() {
  mention.close()
}

function pickMention(opt) {
  if (!opt) return false
  draft.value = applyMention(draft.value, opt.display_name)
  mention.close()
  syncInputHeight()
  inputEl.value?.focus()
  return true
}

/** 回车：@ 面板打开时优先确认选择，不发送文本 */
function onSendKey(event) {
  if (event?.isComposing) return   // 输入法还在选词，这一下回车交给输入法
  event?.preventDefault()
  if (pickMention(mention.current.value)) return
  onSend()
}

async function onSend() {
  if (store.undoing) return
  const text = draft.value.trim()
  if (!text) return   // 播放/请求中也允许发言：打断播放或进入 5s 聚合
  draft.value = ''
  mention.close()
  syncInputHeight()
  clearLullTimer()
  isFollowingLatest.value = true
  hasNewMessages.value = false
  store.sendMessage(text)
  armLullTimer()
}

const LONG_PRESS_MS = 600
let sendPressTimer = null
let longPressFired = false

function clearSendPressTimer() {
  if (sendPressTimer) clearTimeout(sendPressTimer)
  sendPressTimer = null
}

function onSendPressStart(event) {
  if (!canUndo.value) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  clearSendPressTimer()
  longPressFired = false
  sendPressTimer = setTimeout(() => {
    sendPressTimer = null
    longPressFired = true
    requestUndoLastRound()
  }, LONG_PRESS_MS)
}

function onSendPressEnd() {
  clearSendPressTimer()
}

function onSendClick() {
  if (!draft.value.trim()) return
  if (longPressFired) {
    longPressFired = false
    return
  }
  onSend()
}

async function requestUndoLastRound() {
  if (!canUndo.value) return
  const options = {
    title: '撤回上一轮群聊',
    message: '确定撤回上一轮群聊吗？\n上一轮用户消息和角色回复都会被删除，本轮生成的图片和已经写入的相关记忆也会一并清理。\n\n提示：长按发送键也可以快速撤回。',
    okText: '撤回',
    danger: true,
  }
  const confirmed = confirmFn
    ? await confirmFn(options)
    : confirm(options.message)
  if (!confirmed) return

  try {
    const result = await store.undoLastRound()
    if (!result?.deleted) toast?.('当前没有可撤回的群聊记录', 'warning')
    showSettings.value = false
    scrollToBottom(true)
    armLullTimer()
  } catch (err) {
    toast?.(err.message || '撤回失败，请稍后重试', 'error')
  }
}

// 与私聊一致：移动端返回键拉起角色列表侧栏
const isMobile = inject('isMobile')
const toggleMobileSidebar = inject('toggleMobileSidebar')

// ── 群设置 ──

function toggleMember(id) {
  const idx = editMemberIds.value.indexOf(id)
  if (idx >= 0) editMemberIds.value.splice(idx, 1)
  else editMemberIds.value.push(id)
}

async function onSaveSettings() {
  if (editMemberIds.value.length < 2) {
    toast?.('群聊至少保留 2 个角色成员', 'warning')
    return
  }
  await store.updateGroup(store.activeGroupId, {
    name: editName.value,
    topic: editTopic.value,
    member_ids: editMemberIds.value,
  })
  await store.selectGroup(store.activeGroupId)
  showSettings.value = false
}

async function onDissolve() {
  const message = `确定解散「${store.activeGroup?.name}」吗？群消息和群记忆将被清空。`
  const confirmed = confirmFn
    ? await confirmFn({ title: '解散群聊', message, okText: '解散', danger: true })
    : confirm(message)
  if (!confirmed) return
  await store.deleteGroup(store.activeGroupId)
  showSettings.value = false
  router.push('/chat')
}

// ── 群头像（上传 / 粘贴 / 相册最近图片，选完统一进裁剪） ──

const showGroupAvatarPicker = ref(false)
const groupAvatarSaving = ref(false)
const groupAlbumImages = ref([])
const groupAlbumLoading = ref(false)
const groupAvatarUrl = computed(() => store.activeGroup?.avatar_path || '')

function openGroupAvatarPicker() {
  groupAlbumImages.value = []   // 每次打开重新拉取，避免选中已被清理的旧图
  showGroupAvatarPicker.value = true
}

async function loadGroupAvatarRecents() {
  if (groupAlbumLoading.value) return
  groupAlbumLoading.value = true
  try {
    const data = await listGalleryImages(24)
    groupAlbumImages.value = (data.images || []).map(img => img.url)
  } catch { /* 拉取失败保留空列表，仍可上传 / 粘贴 */ }
  finally { groupAlbumLoading.value = false }
}

async function onGroupAvatarSave(base64) {
  if (!store.activeGroupId || groupAvatarSaving.value || !base64) return
  groupAvatarSaving.value = true
  try {
    await store.setGroupAvatar(store.activeGroupId, base64)
    showGroupAvatarPicker.value = false
    toast?.('群头像已更新', 'success')
  } catch (err) {
    toast?.(err.message || '群头像保存失败', 'error')
  } finally { groupAvatarSaving.value = false }
}

async function clearGroupAvatar() {
  if (!store.activeGroupId || groupAvatarSaving.value) return
  groupAvatarSaving.value = true
  try {
    await store.setGroupAvatar(store.activeGroupId, '')
    toast?.('已恢复默认群头像', 'success')
  } catch (err) {
    toast?.(err.message || '恢复默认群头像失败', 'error')
  } finally { groupAvatarSaving.value = false }
}
</script>

<style scoped>
/* ══ 与私聊 ChatView 对齐的基础布局 ══ */
.chat-view { flex:1; display:flex; flex-direction:column; height:100vh; height:100dvh; overflow:hidden; background:transparent; }

/* ── 头部 ── */
.chat-header {
  padding:14px 24px;
  border-bottom: 1px solid var(--glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  display:flex; align-items:center; gap: 10px;
}
.chat-title { font-size:16px; font-weight:600; color:var(--text-bright); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chat-header-center { display: flex; flex-direction: column; gap: 0; flex: 1; min-width: 0; }
.chat-header-title-row { display: flex; align-items: center; gap: 8px; }
.chat-header-schedule {
  font-size: 11px; color: var(--accent);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.75; margin-top: 2px;
}
.chat-header-right { display: flex; align-items: center; gap: 10px; }

.btn-mobile-back {
  width: 44px; height: 44px; flex-shrink: 0;
  background: transparent;
}

.btn-header-settings {
  width:32px; height:32px; border-radius:10px;
  border:1px solid var(--glass-border);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s ease;
}
.btn-header-settings:hover { color: var(--text-bright); border-color: var(--accent); }

.header-avatar { flex-shrink: 0; }
.group-avatar-grid {
  width: 42px; height: 42px; border-radius: 10px; overflow: hidden;
  display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  background: var(--bg-tertiary);
}
.group-avatar-cell {
  background-size: cover; background-position: center;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 10px; font-weight: 600;
  min-height: 20px;
}
.group-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 自定义群头像：整块一张图，不再切分成员格 */
.group-avatar-grid.group-avatar-single { grid-template-columns: 1fr; gap: 0; }

/* ── 消息区 ── */
.message-area { position:relative; flex:1; min-height:0; }
.message-list {
  box-sizing:border-box; width:100%; height:100%; overflow-y:auto; padding:16px 24px;
  background: transparent;
}
.msg-list-inner { display:flex; flex-direction:column; gap:4px; }
.load-older { text-align:center; padding:8px 0; font-size:12px; color:var(--text-secondary); user-select:none; }
.load-older-hint { opacity:0.6; }

.new-message-bubble {
  position:absolute; right:24px; bottom:16px; z-index:10;
  min-height:44px; padding:0 14px 0 16px;
  display:flex; align-items:center; justify-content:center; gap:6px;
  border:1px solid rgba(var(--accent-rgb),0.34); border-radius:22px;
  background:var(--popover-bg); color:var(--accent);
  box-shadow:0 6px 22px rgba(92,55,45,0.16);
  font-size:13px; font-weight:600; cursor:pointer;
  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
  transition:background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  user-select: none;
}
.new-message-bubble:hover { background:var(--bg-tertiary); border-color:var(--accent); box-shadow:0 8px 26px rgba(92,55,45,0.2); }
.new-message-bubble:active { transform:scale(0.96); }
.new-message-bubble:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.new-message-enter-active, .new-message-leave-active { transition:opacity 0.2s ease, transform 0.2s ease; }
.new-message-enter-from, .new-message-leave-to { opacity:0; transform:translateY(8px); }

.message { display:flex; margin:3px 0; align-items:flex-start; gap:8px; }
.message.user { flex-direction:row-reverse; }
.message.assistant { flex-direction:row; }

.msg-avatar {
  width:42px; height:42px; border-radius:50%; flex-shrink:0;
  display:flex; align-items:center; justify-content:center;
  /* 顶部对齐：文字+图片同属一条消息时，头像跟着第一行而不是沉到图片底部 */
  align-self:flex-start;
}
/* 头像图片：填满容器，圆角随容器（与私聊同款） */
.avatar-img {
  width:100%; height:100%; object-fit:cover;
  border-radius:inherit; display:block;
}
.msg-same-role .msg-avatar { opacity: 0; pointer-events: none; }
.avatar-fallback { color:#fff; font-size:14px; font-weight:700; user-select:none; }
.avatar-clickable { cursor:pointer; transition:filter 0.15s ease, transform 0.15s ease; }
.avatar-clickable:hover { filter:brightness(0.93); }
.avatar-clickable:active { transform:scale(0.96); }

/* ── 点头像弹出的成员操作小窗 ── */
.avatar-pop-layer {
  position: fixed; inset: 0; z-index: 1200;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.avatar-pop-card {
  position: fixed; width: 320px; max-width: calc(100vw - 24px); min-height: 150px;
  background: var(--popover-bg);
  border: 1px solid var(--glass-border);
  border-radius: 16px;
  box-shadow: 0 14px 42px rgba(60, 34, 25, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04);
  padding: 14px;
}
.avatar-pop-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.avatar-pop-avatar {
  width: 48px; height: 48px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: #fff;
}
.avatar-pop-fallback { font-size: 17px; font-weight: 700; user-select: none; }
.avatar-pop-info { min-width: 0; }
.avatar-pop-name {
  font-size: 15px; font-weight: 600; color: var(--text-bright);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.avatar-pop-sub { font-size: 11px; color: var(--text-secondary); margin-top: 3px; }
.avatar-pop-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.avatar-pop-btn {
  min-height: 42px; padding: 8px 4px;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid rgba(var(--accent-rgb), 0.26); border-radius: 12px;
  background: var(--bg-secondary); color: var(--text-primary);
  font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
  user-select: none;
}
.avatar-pop-btn:hover { background: var(--bg-tertiary); border-color: var(--accent); color: var(--accent); }
.avatar-pop-btn:active { transform: scale(0.97); }
.avatar-pop-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
.avatar-pop-enter-active, .avatar-pop-leave-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.avatar-pop-enter-from, .avatar-pop-leave-to { opacity: 0; transform: translateY(-4px) scale(0.97); }


.msg-col { display:flex; flex-direction:column; max-width:75%; }
.message.user .msg-col { align-items:flex-end; }
.speaker-name { font-size:11px; color:var(--text-secondary); margin:0 4px 3px; user-select:none; }

.msg-bubble {
  padding:10px 14px; border-radius:8px;
  font-size:14px; line-height:1.6; word-break:break-word;
  width: fit-content;
}
/* 赛璐璐漫画格气泡：尖角朝向说话方 + 描边 + 微硬阴影 */
.message.user .msg-bubble {
  background: linear-gradient(135deg, var(--accent), var(--accent-hover));
  color:#fff; border:none;
  border-radius: 14px 4px 14px 14px;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.16), var(--shadow-glow);
}
.message.assistant .msg-bubble {
  background:var(--bg-secondary); color:var(--text-primary);
  border-radius: 4px 14px 14px 14px;
  box-shadow: var(--shadow-hard-sm);
}
.msg-text { font-size:14px; line-height:1.6; white-space:pre-wrap; }

.msg-images { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
/* 与私聊 ImageGenBubble 的 .igb-img 对齐 */
.msg-image {
  max-width: min(600px, 70vw); max-height: min(800px, 60vh);
  width: auto; height: auto;
  border-radius: 20px; cursor: pointer; object-fit: contain;
}
/* 表情包贴纸高度固定 140px，宽度随图片比例自适应，与私聊 .msg-sticker-img 同款；不可点击放大 */
.msg-image.msg-emoji-img { height:140px; width:auto; max-width:none; max-height:none; border-radius:8px; cursor:default; }

.gc-empty { text-align:center; color:var(--text-secondary); font-size:13px; padding:60px 0; }

/* 时间分隔符（与私聊 .time-divider 同款） */
.time-divider { text-align:center; padding:16px 0 8px; font-size:12px; color:var(--text-secondary); user-select:none; }
.last-seen-divider { display:flex; align-items:center; gap:12px; padding:18px 0; color:var(--accent); font-size:var(--fs-xs); font-weight:700; user-select:none; }
.last-seen-divider span { display:inline-flex; align-items:center; gap:7px; flex-shrink:0; }
.last-seen-divider span::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px rgba(var(--accent-rgb), .14); }
.last-seen-divider::before, .last-seen-divider::after { content:''; flex:1; height:2px; border-radius:var(--radius-full); background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 64%, var(--border))); }
.last-seen-divider::after { transform:scaleX(-1); }

/* ── 输入区 ── */
.input-area {
  position: relative;
  padding:8px 24px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--glass-border);
  display:flex; gap:10px; align-items:flex-end;
  background: var(--glass-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.chat-input {
  flex:1; min-height:40px; max-height:120px; padding:10px 14px; font-size:14px;
  background: var(--bg-secondary);
  border-radius: 14px; color:var(--text-bright); outline:none; resize:none;
  overflow: hidden; caret-color: var(--accent);
  transition: border-color 0.2s ease, box-shadow 0.3s ease, background 0.2s ease;
}
.chat-input::placeholder { color: var(--text-secondary); opacity: 0.5; }
.chat-input:hover { border-color: rgba(var(--accent-rgb), 0.35); }
.chat-input:focus {
  background: var(--bg-secondary);
  border-color: var(--accent-light);
  box-shadow:
    0 0 0 4px rgba(var(--accent-rgb), 0.10),
    0 0 24px rgba(var(--accent-rgb), 0.08),
    inset 0 0 10px rgba(var(--accent-rgb), 0.04);
}

/* ── ✋ 动作入口（与私聊同皮肤）：输入区图标排最右，紧贴发送按钮 ── */
.touch-icon-btn {
  position: relative;
  width: 42px; height: 42px; flex-shrink: 0;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  color: var(--accent);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
}
.touch-icon-btn:hover { transform: scale(1.08); border-color: var(--accent); }
.touch-icon-btn:active { transform: scale(0.94); }
.touch-icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* 面板开着时入口高亮（2026-10-02 补；与私聊 .touch-icon-btn.is-open 同款口径）：
   入口自己就是开关（再点一下就收），所以必须让人一眼看出"面板是我开着的"。
   渐变 + 0.3s 过渡，与设计系统的其它状态变化同节奏。 */
.touch-icon-btn.is-open {
  background: linear-gradient(135deg, var(--accent), rgba(var(--accent-rgb), 0.72));
  border-color: var(--accent);
  color: #fff;
  transition: background 0.3s var(--ease-standard), color 0.3s var(--ease-standard), transform 0.3s var(--ease-standard);
}
.touch-icon-badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 999px;
  background: var(--accent); color: #fff;
  font-size: 10px; line-height: 16px; font-weight: 600;
  text-align: center;
}

.send-btn {
  width: 42px; height: 42px; flex-shrink: 0;
  border-radius: 50%;
  font-size: 0;
  background: var(--grad-brand);
  color: #fff;
  border: none; padding: 0;
  opacity: 1; cursor: pointer;
  position: relative;
  display: flex; align-items: center; justify-content: center;
  box-shadow:
    0 2px 8px rgba(var(--accent-rgb), 0.22),
    0 0 0 0 rgba(var(--accent-rgb), 0);
  transition:
    opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.3s ease, transform 0.2s ease;
  touch-action: manipulation;
  -webkit-touch-callout: none;
  user-select: none;
}
.send-icon { width: 18px; height: 18px; display: block; transition: transform 0.2s ease; }
.send-btn:not(.is-disabled):hover {
  box-shadow:
    0 4px 18px rgba(var(--accent-rgb), 0.35),
    0 0 32px rgba(var(--accent-rgb), 0.10);
  transform: scale(1.06);
}
.send-btn:not(.is-disabled):active { transform: scale(0.94); }
.send-btn.is-disabled { opacity: 0.35; box-shadow: none; cursor: default; }

/* 动作条的槽位：position:relative 让复用的 .mention-panel 仍按「贴在本块上方」定位 */
.touch-group-wrap { position: relative; }

/* @点名面板 */
.mention-panel {
  position: absolute; bottom: calc(100% + 4px); left: 24px;
  background: var(--popover-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: 14px; padding: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.12);
  z-index: 20;
  max-height: 240px; overflow-y: auto;
}
/* 出现/消失：淡入淡出 + 从输入框上方浮起（只动 opacity/transform，时长缓动走 token） */
.mention-fade-enter-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.mention-fade-leave-active { transition: opacity var(--dur-fast) var(--ease-standard), transform var(--dur-fast) var(--ease-standard); }
.mention-fade-enter-from, .mention-fade-leave-to { opacity: 0; transform: translateY(6px); }
.mention-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px 8px 8px; border-radius: 10px;
  font-size: 14px; color: var(--text-primary); cursor: pointer;
}
.mention-item:hover { background: var(--tint-subtle); }
.mention-item.is-active { background: rgba(var(--accent-rgb), 0.16); }
.mention-item-hint {
  margin-left: auto; padding-left: 10px;
  font-size: 11px; color: var(--text-secondary); white-space: nowrap;
}
.mention-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  color: #fff; font-size: 12px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

/* ── 群设置抽屉 ──
   三段式布局：头部标题 / 中部滚动表项 / 底部操作区。
   中部是唯一滚动容器，表项再往里塞也只加长它自己的滚动区，
   底部的「撤回上一轮 / 解散群聊 / 保存」永远留在屏幕内（PC 与手机同款）。 */
.gc-drawer-overlay {
  position: fixed; inset: 0; z-index: var(--z-drawer);
  background: rgba(0, 0, 0, 0.45);
  display: flex; justify-content: flex-end;
}
.gc-drawer {
  width: min(480px, 94vw);
  height: 100%; height: 100dvh;
  background: var(--bg-secondary);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-left: 1px solid var(--border);
  box-shadow: -6px 0 28px rgba(0, 0, 0, 0.1);
  display: flex; flex-direction: column;
  /* ── 2026-10-01 真机 bug（底部按钮点不到）在 v3.6.3 换了实现，这里按上游结构走 ──
     本地当时的修法是「抽屉自己当整块滚动容器」（overflow-y:auto）——那是在**没有分段包裹**时的权宜之计。
     上游 v3.6.3 把抽屉重构成 head / body / foot 三段，底部操作区 `flex-shrink:0` **常驻视口**，
     正文由 `.gc-drawer-body` 独立滚动 ⇒ 同一个意图被更强的结构满足了：按钮根本不会滚走，
     不需要用户先滚到底。所以外壳回到 `overflow: hidden`，由 body 承担滚动。
     ⚠️ 别再改回「抽屉自己滚」：那会和 body 的滚动容器嵌套，两层互相打架。 */
  overflow: hidden;
  transition: transform 0.22s ease;
}
/* 头部：标题与关闭键常驻，不跟着表项滚走 */
.gc-drawer-head {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 10px;
  padding: 18px 18px 12px;
  padding-top: calc(18px + env(safe-area-inset-top, 0px));
  border-bottom: 1px solid var(--border);
}
.gc-drawer-head h3 { margin: 0; font-size: 17px; color: var(--text-bright); }
.gc-drawer-close { margin-left: auto; flex-shrink: 0; }
/* 中部：全抽屉唯一的滚动区，滚到边界不把滚动传给底下的消息列表 */
/* （-webkit-overflow-scrolling 从旧版 `.gc-drawer` 迁移过来：滚动容器换成了 body，
     iOS 上的惯性滚动得跟着一起搬，否则手机端滚动手感会退步） */
.gc-drawer-body {
  flex: 1; min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  display: flex; flex-direction: column; gap: 16px;
  padding: 16px 18px 18px;
  scrollbar-width: thin; scrollbar-color: rgba(var(--accent-rgb),0.35) transparent;
}
/* 底部：操作区常驻，并让出手势条安全区 */
.gc-drawer-foot {
  flex-shrink: 0;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 18px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
}
.gc-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text-secondary); }
.gc-member-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; color: var(--text-secondary);
}
/* 群成员区不再「吃掉全部剩余高度」：改成定高区间，让抽屉本体在有溢出时真的能滚 */
.gc-member-field { flex: 0 0 auto; min-height: 0; }
.gc-member-edit {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 8px;
  flex: 1 1 auto; min-height: 124px; max-height: min(46dvh, 420px); overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid rgba(var(--accent-rgb),0.14); border-radius: 12px; padding: 8px;
}
.gc-member-check {
  min-width: 0; min-height: 92px; padding: 9px 5px 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); cursor: pointer;
  font-size: 12px; color: var(--text-primary); transition: all 0.15s ease;
  user-select: none;
}
.gc-member-check:hover { background: var(--bg-tertiary); border-color: rgba(var(--accent-rgb),0.4); }
.gc-member-check.picked {
  background: rgba(var(--accent-rgb),0.1); border-color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb),0.12);
}
.gc-member-check span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-member-avatar {
  width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 16px; font-weight: 600;
}
.gc-member-hint { font-size: 12px; color: var(--text-secondary); }
.gc-avatar-row { display: flex; align-items: center; gap: 10px; }
.gc-avatar-preview {
  width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 16px; font-weight: 600;
}
.gc-avatar-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.gc-temp-val { font-size: 13px; font-weight: 600; color: var(--accent); }
.gc-record-actions { flex-shrink: 0; }
.gc-drawer-actions { display: flex; gap: 10px; flex-shrink: 0; }
.gc-btn {
  flex: 1; padding: 11px 0;
}
.gc-btn-undo {
  width: 100%;
}

.drawer-enter-active, .drawer-leave-active { transition: opacity 0.22s ease; }
.drawer-enter-from, .drawer-leave-to { opacity: 0; }
.drawer-enter-from .gc-drawer, .drawer-leave-to .gc-drawer { transform: translateX(40px); }

/* ── 移动端（与私聊断点一致） ── */
@media (max-width: 767px) {
  .chat-header { padding: 12px 16px; }
  .message-list { padding: 5px 10px; }
  .new-message-bubble { right:14px; bottom:12px; }
  .input-area { padding: 8px 16px; padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); }
  .mention-panel { left: 16px; }

  /* 群设置抽屉在手机上铺满整宽：表项更宽、成员格子更好按；
     遮罩被盖满后关闭改走头部关闭键与 Esc */
  .gc-drawer {
    width: 100%; max-width: 100%;
    border-left: none; box-shadow: none;
  }
  .gc-drawer-head { padding-left: 14px; padding-right: 14px; }
  .gc-drawer-body { padding: 14px 14px 16px; gap: 14px; }
  .gc-drawer-foot { padding-left: 14px; padding-right: 14px; }
  .gc-member-edit { grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); }
}

@media (prefers-reduced-motion: reduce) {
  .new-message-bubble,
  .new-message-enter-active,
  .new-message-leave-active { transition:none; }
}
</style>
