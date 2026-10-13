<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Bolt, Menu, Moon, Plus, Sparkles, Square, Sun } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import { useTheme } from '@/composables/useTheme'
import type { ConnectionState, SessionUiState, ThinkingLevel } from '@/types'
import ContextUsageIndicator from './ContextUsageIndicator.vue'
import MessageBubble from './MessageBubble.vue'
import ModelSelector from './ModelSelector.vue'
import ThinkingLevelSelector from './ThinkingLevelSelector.vue'

const props = defineProps<{ session?: SessionUiState; connection: ConnectionState }>()
const emit = defineEmits<{ menu: [] }>()
const store = useSessionPool()
const { theme, toggleTheme } = useTheme()
const draft = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const scrollArea = ref<HTMLDivElement | null>(null)
const nearBottom = ref(true)
const suggestions = ['帮我梳理这个项目的架构', '解释一段代码的工作原理', '一起制定一个实现计划']

const canSend = computed(() => !!props.session && props.connection === 'connected' && !props.session.isStreaming && !!draft.value.trim())
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
  nextTick(() => {
    if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight
  })
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

watch(() => props.session?.summary.id, () => { nearBottom.value = true; scrollToBottom() })
watch(() => props.session?.messages, () => { if (nearBottom.value) scrollToBottom() }, { deep: true })
watch(() => props.session?.isStreaming, () => { if (nearBottom.value) scrollToBottom() })
</script>

<template>
  <section class="relative flex h-full min-w-0 flex-1 flex-col bg-ink-950">
    <header class="flex h-[70px] shrink-0 items-center gap-3 border-b border-white/[.075] px-4 sm:px-7">
      <button type="button" class="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white lg:hidden" aria-label="打开侧栏" @click="emit('menu')"><Menu :size="20" /></button>
      <div class="min-w-0 flex-1"><h1 class="truncate text-sm font-semibold text-slate-100">{{ currentTitle }}</h1><p class="mono mt-0.5 text-[10px] text-slate-600">{{ session ? 'SESSION ' + session.summary.id.slice(0, 8) : 'YOUR AGENT WORKSPACE' }}</p></div>
      <button type="button" class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/[.09] bg-white/[.045] px-2.5 text-xs text-slate-400 transition hover:bg-white/[.085] hover:text-slate-100 focus-ring" :aria-label="theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'" :title="theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'" @click="toggleTheme">
        <Sun v-if="theme === 'dark'" :size="15" /><Moon v-else :size="15" />
        <span class="hidden sm:inline">{{ theme === 'dark' ? '亮色' : '暗色' }}</span>
      </button>
      <div class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px]" :class="connection === 'connected' ? 'border-emerald-400/15 bg-emerald-400/[.06] text-emerald-300' : 'border-amber-400/15 bg-amber-400/[.06] text-amber-300'"><span class="h-1.5 w-1.5 rounded-full" :class="connection === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'" />{{ connection === 'connected' ? '在线' : '连接中' }}</div>
    </header>

    <div ref="scrollArea" class="min-h-0 flex-1 overflow-y-auto overscroll-contain" @scroll="onScroll">
      <div v-if="!session || session.messages.length === 0" class="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 py-14 text-center">
        <div class="relative mb-7 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-accent-400/25 bg-accent-400/[.11] text-accent-300 shadow-[0_0_80px_rgba(148,114,250,.13)]"><Bolt :size="31" :stroke-width="1.7" /><Sparkles :size="15" class="absolute -right-2 -top-2 text-accent-300" /></div>
        <div class="mono mb-3 text-[10px] tracking-[.23em] text-accent-300/70">PI SDK · WEB WORKSPACE</div>
        <h2 class="text-2xl font-semibold tracking-tight text-slate-100 sm:text-[28px]">{{ session ? '从一个想法开始' : '你的 Pi 工作空间' }}</h2>
        <p class="mt-3 max-w-md text-sm leading-7 text-slate-500">{{ session ? '写下问题、任务或灵感，Pi 会在这里与你协作。' : '创建一个对话，连接模型，开始探索。每个会话都会独立保存。' }}</p>
        <button v-if="!session" type="button" class="mt-7 flex items-center gap-2 rounded-xl bg-accent-400 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-300 disabled:opacity-50" :disabled="connection !== 'connected'" @click="store.createSession()"><Plus :size="17" /> 新建对话</button>
        <div v-else class="mt-9 flex w-full max-w-lg flex-wrap justify-center gap-2">
          <button v-for="suggestion in suggestions" :key="suggestion" type="button" class="rounded-full border border-white/[.09] bg-white/[.035] px-3.5 py-2 text-xs text-slate-400 transition hover:border-accent-400/30 hover:bg-accent-400/[.07] hover:text-slate-200" @click="chooseSuggestion(suggestion)">{{ suggestion }}</button>
        </div>
      </div>
      <div v-else class="mx-auto w-full max-w-[850px] px-4 pb-8 pt-7 sm:px-8">
        <div class="mb-4 flex items-center gap-3 text-[10px] text-slate-600"><div class="h-px flex-1 bg-white/[.07]" />对话开始<div class="h-px flex-1 bg-white/[.07]" /></div>
        <MessageBubble v-for="message in session.messages" :key="message.id" :message="message" :streaming="session.isStreaming && message.id === session.streamMessageId" />
        <div v-if="showStreamPlaceholder" class="flex items-center gap-3.5 py-5 text-accent-300"><div class="flex h-8 w-8 items-center justify-center rounded-xl border border-accent-400/20 bg-accent-400/10"><Bolt :size="15" /></div><span class="text-xs text-slate-500">正在思考</span><span class="typing-dot h-1.5 w-1.5 rounded-full bg-accent-300" /></div>
      </div>
    </div>

    <button v-if="session?.messages.length && !nearBottom" type="button" class="absolute bottom-44 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-ink-800 px-3 py-1.5 text-xs text-slate-300 shadow-panel hover:bg-ink-700" @click="nearBottom = true; scrollToBottom()"><ArrowDown :size="13" /> 回到最新</button>

    <div class="shrink-0 px-3 pb-4 pt-2 sm:px-6 sm:pb-6">
      <div class="mx-auto max-w-[820px]">
        <div class="rounded-2xl border border-white/[.12] bg-ink-850 shadow-panel transition-colors focus-within:border-accent-400/40">
          <textarea ref="textarea" v-model="draft" rows="1" :disabled="!session || connection !== 'connected' || session.isStreaming" :placeholder="!session ? '先创建一个对话…' : connection !== 'connected' ? '正在连接服务器…' : session.isStreaming ? 'Pi 正在回复…' : '给 Pi 发送消息…'" class="block max-h-[180px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[13px] leading-6 text-slate-100 outline-none placeholder:text-slate-600 disabled:opacity-60 sm:px-5 sm:text-sm" @input="resizeTextarea" @keydown="onKeydown" />
          <div class="flex min-h-[50px] flex-wrap items-center gap-2 px-3 pb-3 sm:px-4">
            <ModelSelector :models="store.models" :selected="session?.model" :disabled="!session || session.isStreaming || connection !== 'connected'" @select="setModel" />
            <ThinkingLevelSelector v-if="session" :selected="session.thinkingLevel" :disabled="session.isStreaming || connection !== 'connected'" @select="setThinking" />
            <div class="ml-auto flex items-center gap-3">
              <ContextUsageIndicator :usage="session?.contextUsage" />
              <button v-if="session?.isStreaming" type="button" class="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-400/15 text-rose-300 transition hover:bg-rose-400/25" aria-label="取消生成" title="取消生成" @click="store.abort(session.summary.id)"><Square :size="13" fill="currentColor" /></button>
              <button v-else type="button" class="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-400 text-ink-950 transition hover:bg-accent-300 disabled:opacity-40" :disabled="!canSend" aria-label="发送消息" title="发送消息" @click="send"><ArrowUp :size="17" :stroke-width="2.5" /></button>
            </div>
          </div>
        </div>
        <div class="mt-2 flex items-center justify-between gap-2 px-1 text-[10px] text-slate-600"><span><kbd class="mono">Enter</kbd> 发送 · <kbd class="mono">Shift + Enter</kbd> 换行</span><span class="hidden items-center gap-1 sm:flex"><Bolt :size="10" /> Powered by pi SDK</span></div>
      </div>
    </div>
  </section>
</template>
