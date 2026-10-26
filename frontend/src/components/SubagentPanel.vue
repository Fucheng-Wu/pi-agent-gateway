<script setup lang="ts">
import { computed, watch } from 'vue'
import { ArrowDown, Bot, LoaderCircle, X } from 'lucide-vue-next'
import type { ToolCall } from '@/types'
import { useChatScroll } from '@/composables/useChatScroll'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{ tool: ToolCall; agents: ToolCall[] }>()
const emit = defineEmits<{ close: []; select: [toolId: string] }>()
const { scrollArea, content, following, scrollToBottom, resume, onScroll, onWheel, onTouchStart, onTouchMove, onScrollKey } = useChatScroll()
const run = computed(() => props.tool.subagent)
const input = computed(() => props.tool.input as { profile?: string; task?: string } | undefined)
const title = computed(() => run.value?.name || input.value?.profile || '子代理')
const status = computed(() => run.value?.status || props.tool.status)
const messages = computed(() => run.value?.messages ?? [])
const lastAssistant = computed(() => messages.value.findLast((message) => message.role === 'assistant')?.id)
const communication = computed(() => run.value?.communications?.slice(-20) ?? [])
function agentLabel(agent: ToolCall) { return agent.subagent?.path || agent.subagent?.name || (agent.input as { profile?: string } | undefined)?.profile || '子代理' }
function selectAddress(path: string) {
  if (path === '/root') { emit('close'); return }
  const agent = props.agents.find(agent => agent.subagent?.path === path)
  if (agent) emit('select', agent.id)
}
function selectTool(toolId: string) {
  const tool = messages.value.flatMap(message => message.tools ?? []).find(tool => tool.id === toolId)
  let id = tool?.subagent?.id
  if (!id && tool?.output) { try { id = JSON.parse(tool.output).agent_id } catch { /* Not a collaboration result. */ } }
  const agent = props.agents.find(agent => agent.subagent?.id === id)
  if (agent) emit('select', agent.id)
}
watch(() => props.tool.id, resume, { immediate: true })
watch(() => props.tool.subagent, scrollToBottom)
</script>

<template>
  <aside class="subagent-panel relative flex min-h-0 min-w-0 flex-col bg-ink-950" aria-label="子代理聊天">
    <header class="chat-header flex shrink-0 items-center gap-2 border-b border-white/10 px-4">
      <Bot :size="19" class="shrink-0 text-accent-300" />
      <div class="min-w-0 flex-1"><h2 class="truncate text-sm font-semibold">{{ title }}</h2><p class="mt-1 text-[11px] text-slate-500">子代理 · {{ run?.closed ? '已关闭' : status === 'running' ? (run?.phase === 'queued' ? '排队中' : run?.phase === 'waiting' ? '等待协作' : '执行中') : status === 'error' ? '执行失败或已中断' : '已完成，可追加任务' }}</p></div>
      <LoaderCircle v-if="status === 'running'" :size="15" class="animate-spin text-accent-300" />
      <button type="button" class="rounded-lg p-2 text-slate-400 hover:bg-white/5" aria-label="关闭子代理聊天" @click="emit('close')"><X :size="18" /></button>
    </header>
    <nav v-if="agents.length > 1" class="flex shrink-0 gap-2 overflow-x-auto border-b border-white/10 px-4 py-2" aria-label="切换子代理">
      <button v-for="agent in agents" :key="agent.id" type="button" class="shrink-0 rounded-lg px-3 py-2 text-xs" :class="agent.id === tool.id ? 'bg-accent-400/10 text-accent-300' : 'text-slate-400 hover:bg-white/5'" :aria-pressed="agent.id === tool.id" @click="emit('select', agent.id)">{{ agentLabel(agent) }} · {{ agent.subagent?.closed ? '已关闭' : agent.status === 'running' ? '执行中' : agent.status === 'error' ? '失败或中断' : '已完成' }}</button>
    </nav>
    <div v-if="run" class="shrink-0 border-b border-white/10 px-4 py-2 text-[11px] leading-5 text-slate-500">
      <p v-if="!run.closed">可在主对话中要求给此代理发消息、追加任务、中断或关闭。</p>
      <p v-if="run.path" class="mono break-all text-accent-300">{{ run.path }}</p>
      <p v-if="run.parentPath">父代理：<button type="button" class="mono text-accent-300 hover:underline" @click="selectAddress(run.parentPath)">{{ run.parentPath }}</button></p>
      <span class="mono block truncate" :title="run.id">{{ run.id }}</span>
    </div>
    <div ref="scrollArea" tabindex="0" class="min-h-0 flex-1 overflow-y-auto overscroll-contain" @scroll="onScroll" @wheel.passive="onWheel" @touchstart.passive="onTouchStart" @touchmove.passive="onTouchMove" @keydown="onScrollKey">
      <div ref="content" class="chat-thread mx-auto w-full">
        <details v-if="communication.length" class="mb-4 rounded-xl border border-white/10 bg-white/[.02] p-3">
          <summary class="cursor-pointer text-xs text-accent-300">团队通信 · {{ run?.communications?.length }}<span v-if="(run?.communications?.length ?? 0) > 20">（最近 20 条）</span></summary>
          <ol class="mt-3 max-h-64 space-y-3 overflow-y-auto" aria-label="代理间通信记录">
            <li v-for="message in communication" :key="message.id" class="border-t border-white/5 pt-2 text-xs">
              <p class="mono break-all text-[10px] text-slate-400"><button type="button" class="text-accent-300 hover:underline" @click="selectAddress(message.sender)">{{ message.sender }}</button> → <button type="button" class="text-accent-300 hover:underline" @click="selectAddress(message.recipient)">{{ message.recipient }}</button><span class="ml-2">{{ message.kind === 'result' ? '结果' : '消息' }}</span></p>
              <p class="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap break-words leading-5 text-slate-300">{{ message.text }}</p>
            </li>
          </ol>
        </details>
        <MessageBubble v-if="!messages.some(message => message.role === 'user')" :message="{ id: 'task', role: 'user', text: run?.task || input?.task || '正在启动子代理…' }" />
        <MessageBubble v-for="message in messages" :key="message.id" :message="message" :streaming="status === 'running' && message.id === lastAssistant" @subagent="selectTool" />
        <p v-if="status === 'running' && !lastAssistant" class="flex items-center gap-2 py-4 text-sm text-slate-400"><LoaderCircle :size="15" class="animate-spin" />正在执行委派任务…</p>
        <p v-if="run?.error" class="rounded-lg bg-rose-400/10 px-3 py-2 text-sm text-rose-300">{{ run.error }}</p>
        <p v-if="!run && status !== 'running'" class="text-xs leading-6 text-slate-500">这次调用未记录详细过程。</p>
        <MessageBubble v-if="!run && tool.output" :message="{ id: 'result', role: 'assistant', text: tool.output }" />
      </div>
    </div>
    <button v-if="!following" type="button" class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-ink-800 px-3 py-2 text-xs shadow-panel" @click="resume"><ArrowDown :size="14" />回到最新</button>
  </aside>
</template>
