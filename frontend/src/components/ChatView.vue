<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Bot, Menu, Moon, Plus, Square, Sun } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import { useTheme } from '@/composables/useTheme'
import type { ConnectionState, SessionUiState, ThinkingLevel } from '@/types'
import ContextUsageIndicator from './ContextUsageIndicator.vue'
import MessageBubble from './MessageBubble.vue'
import ModelSelector from './ModelSelector.vue'
import ThinkingLevelSelector from './ThinkingLevelSelector.vue'
import PrimaryAgentSelector from './PrimaryAgentSelector.vue'
import RunReviewPanel from './RunReviewPanel.vue'

const props = defineProps<{ session?: SessionUiState; connection: ConnectionState }>()
const emit = defineEmits<{ menu: []; workspace: []; settings: [] }>()
const store = useSessionPool()
const { theme, toggleTheme } = useTheme()
const draft = ref('')
const drafts = new Map<string, string>()
const visibleCount = ref(60)
const visibleMessages = computed(() => props.session?.messages.slice(-visibleCount.value) ?? [])
const hiddenCount = computed(() => Math.max(0, (props.session?.messages.length ?? 0) - visibleCount.value))
const needsModel = computed(() => !store.providers.some((provider) => provider.authenticated) || !store.models.length)
let scrollFrame: number | undefined
const textarea = ref<HTMLTextAreaElement | null>(null)
const scrollArea = ref<HTMLDivElement | null>(null)
const nearBottom = ref(true)
const suggestions = ['帮我梳理这个项目的架构', '解释一段代码的工作原理', '一起制定一个实现计划']

const changingPrimary = computed(() => !!props.session && !!store.primaryAgentChanging[props.session.summary.id])
const syncing = computed(() => !!props.session && !!store.sessionLoading[props.session.summary.id])
const canSend = computed(() => !!props.session && props.connection === 'connected' && !props.session.isStreaming && !changingPrimary.value && !syncing.value && !!draft.value.trim())
const currentTitle = computed(() => props.session?.summary.title || '新对话')
const showStreamPlaceholder = computed(() => props.session?.isStreaming && !props.session.messages.some((m) => m.id === props.session?.streamMessageId && m.role === 'assistant'))

function send() {
  if (!canSend.value || !props.session) return
  if (store.prompt(props.session.summary.id, draft.value)) {
    draft.value = ''
    resizeTextarea()
    nearBottom.value = true
    scrollToBottom()
  }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && props.session && !props.session.isStreaming && !changingPrimary.value && props.connection === 'connected' && store.primaryAgents.length) {
    event.preventDefault()
    const index = store.primaryAgents.findIndex((agent) => agent.id === (props.session?.primaryAgentId || 'build'))
    const next = (index + (event.shiftKey ? -1 : 1) + store.primaryAgents.length) % store.primaryAgents.length
    store.setPrimaryAgent(props.session.summary.id, store.primaryAgents[next].id)
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}
function resizeTextarea() {
  nextTick(() => {
    if (!textarea.value) return
    textarea.value.style.height = 'auto'
    textarea.value.style.height = `${Math.min(textarea.value.scrollHeight, 180)}px`
  })
}
function scrollToBottom() {
  if (scrollFrame !== undefined) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    nextTick(() => { if (scrollArea.value && nearBottom.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight })
  })
}
async function loadEarlier() {
  const height = scrollArea.value?.scrollHeight ?? 0
  const top = scrollArea.value?.scrollTop ?? 0
  visibleCount.value += 60
  await nextTick()
  if (scrollArea.value) scrollArea.value.scrollTop = top + scrollArea.value.scrollHeight - height
}
function onScroll() {
  if (!scrollArea.value) return
  nearBottom.value = scrollArea.value.scrollHeight - scrollArea.value.scrollTop - scrollArea.value.clientHeight < 150
}
function chooseSuggestion(text: string) {
  draft.value = text
  resizeTextarea()
  textarea.value?.focus()
}
function setModel(provider: string, modelId: string) {
  if (props.session) store.setModel(props.session.summary.id, provider, modelId)
}
function setThinking(level: ThinkingLevel) {
  if (props.session) store.setThinkingLevel(props.session.summary.id, level)
}

watch(() => props.session?.summary.id, (next, previous) => {
  if (previous) drafts.set(previous, draft.value)
  draft.value = next ? drafts.get(next) ?? '' : ''
  visibleCount.value = 60
  nearBottom.value = true
  resizeTextarea()
  scrollToBottom()
})
watch(() => props.session ? store.recoveredDrafts[props.session.summary.id] : undefined, (text) => {
  if (text && !draft.value && props.session) {
    draft.value = text
    delete store.recoveredDrafts[props.session.summary.id]
    resizeTextarea()
  }
})
watch(() => props.session?.revision, () => { if (nearBottom.value) scrollToBottom() })
watch(() => props.session?.isStreaming, () => { if (nearBottom.value) scrollToBottom() })
onUnmounted(() => { if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame) })
</script>

<template>
  <section class="relative flex h-full min-w-0 flex-1 flex-col bg-ink-950">
    <header class="chat-header flex shrink-0 items-center gap-3 px-4 sm:px-8">
      <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white lg:hidden" aria-label="打开侧栏" @click="emit('menu')"><Menu :size="20" /></button>
      <div class="min-w-0 flex-1"><h1 class="truncate text-slate-100">{{ session ? currentTitle : 'Pi Agent' }}</h1></div>
      <button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/5 hover:text-slate-100 focus-ring" :aria-label="theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'" :title="theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'" @click="toggleTheme">
        <Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" />
      </button>
      <div v-if="connection !== 'connected'" class="text-xs text-amber-300">正在连接…</div>
    </header>

    <div ref="scrollArea" class="min-h-0 flex-1 overflow-y-auto overscroll-contain" @scroll="onScroll">
      <div v-if="!session || session.messages.length === 0" class="chat-welcome mx-auto flex min-h-full flex-col items-center justify-center px-6 py-12 text-center">
        <div class="welcome-mark"><Bot :size="42" :stroke-width="1.4" /></div>
        <h2 class="welcome-title text-slate-100">今天有什么可以帮你？</h2>
        <p class="mt-3 max-w-md text-[15px] leading-7 text-slate-400">分析项目、讨论思路，或一起完成一个任务。</p>
        <div class="welcome-setup mt-7 w-full max-w-lg space-y-3.5 text-left text-slate-400">
          <button class="flex w-full items-center gap-2 text-left" :disabled="connection !== 'connected'" @click="emit('workspace')"><span class="text-accent-300">1. 项目</span><span class="min-w-0 flex-1 truncate" :title="store.workspace?.path">{{ store.workspace?.path || '选择要操作的目录' }}</span><span>更换</span></button>
          <button class="flex w-full items-center gap-2 text-left" :disabled="connection !== 'connected'" @click="emit('settings')"><span class="text-accent-300">2. 模型</span><span class="flex-1">{{ needsModel ? '添加 Provider 并配置可用模型' : '模型已配置，可以开始对话' }}</span><span>{{ needsModel ? '配置' : '管理' }}</span></button>
          <p class="border-t border-white/10 pt-3 leading-6">3. 新建对话，选择 Plan 分析项目，再切换 Build 执行。</p>
        </div>
        <button v-if="!session" type="button" class="welcome-primary mt-6 flex items-center gap-2" :disabled="connection !== 'connected'" @click="store.createSession()"><Plus :size="17" /> 新建对话</button>
        <div v-else class="mt-9 flex w-full max-w-lg flex-wrap justify-center gap-2">
          <button v-for="suggestion in suggestions" :key="suggestion" type="button" class="rounded-full border border-white/[.09] bg-white/[.035] px-3.5 py-2 text-xs text-slate-400 transition hover:border-accent-400/30 hover:bg-accent-400/[.07] hover:text-slate-200" @click="chooseSuggestion(suggestion)">{{ suggestion }}</button>
        </div>
      </div>
      <div v-else class="chat-thread mx-auto w-full">
        <button v-if="hiddenCount" class="mb-5 w-full rounded-lg border border-white/10 py-2 text-xs text-accent-300" @click="loadEarlier">加载更早的消息（还有 {{ hiddenCount }} 条）</button>
        <MessageBubble v-for="message in visibleMessages" :key="message.id" :message="message" :streaming="session.isStreaming && message.id === session.streamMessageId" />
        <RunReviewPanel v-if="session.review && !session.isStreaming" :key="session.summary.id + session.review.startedAt" :review="session.review" />
        <div v-if="showStreamPlaceholder" class="flex items-center gap-4 py-5 text-accent-300"><Bot :size="24" :stroke-width="1.6" /><span class="text-sm text-slate-400">正在思考</span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-accent-300" /></div>
      </div>
    </div>

    <button v-if="session?.messages.length && !nearBottom" type="button" class="absolute bottom-44 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-ink-800 px-3 py-1.5 text-xs text-slate-300 shadow-panel hover:bg-ink-700" @click="nearBottom = true; scrollToBottom()"><ArrowDown :size="13" /> 回到最新</button>

    <div class="composer-shell shrink-0">
        <div class="composer">
          <textarea ref="textarea" v-model="draft" rows="1" aria-label="消息输入框" :disabled="!session || connection !== 'connected' || session.isStreaming" :placeholder="!session ? '新建对话，开始与 Pi 协作' : connection !== 'connected' ? '正在连接服务器…' : session.isStreaming ? 'Pi 正在回复…' : '给 Pi 发送消息'" class="block max-h-[180px] w-full resize-none bg-transparent text-slate-100 outline-none placeholder:text-slate-500 disabled:opacity-60" @input="resizeTextarea" @keydown="onKeydown" />
          <div class="composer-toolbar">
            <PrimaryAgentSelector :agents="store.primaryAgents" :selected="session?.primaryAgentId" :disabled="!session || session.isStreaming || connection !== 'connected'" :changing="changingPrimary" @select="session && store.setPrimaryAgent(session.summary.id, $event)" />
            <ModelSelector :models="store.models" :selected="session?.model" :disabled="!session || session.isStreaming || changingPrimary || connection !== 'connected'" @select="setModel" />
            <ThinkingLevelSelector v-if="session" :selected="session.thinkingLevel" :disabled="session.isStreaming || changingPrimary || connection !== 'connected'" @select="setThinking" />
            <div class="ml-auto flex items-center gap-3">
              <ContextUsageIndicator :usage="session?.contextUsage" />
              <button v-if="session?.isStreaming" type="button" class="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-400/15 text-rose-300 transition hover:bg-rose-400/25" aria-label="取消生成" title="取消生成" @click="store.abort(session.summary.id)"><Square :size="13" fill="currentColor" /></button>
              <button v-else type="button" class="send-button" :disabled="!canSend" aria-label="发送消息" title="发送消息" @click="send"><ArrowUp :size="20" :stroke-width="2" /></button>
            </div>
          </div>
        </div>
        <div class="composer-hint"><span>Enter 发送 · Shift + Enter 换行<span class="hidden sm:inline"> · Tab 切换角色</span></span></div>
    </div>
  </section>
</template>
