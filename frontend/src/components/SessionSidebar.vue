<script setup lang="ts">
import { ref } from 'vue'
import { ArrowUpRight, MessageSquareText, Plus, Settings2, Trash2, Wifi, WifiOff, X } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import type { ConnectionState, SessionSummary } from '@/types'

defineProps<{ connection: ConnectionState; mobileOpen: boolean }>()
const emit = defineEmits<{ close: []; settings: [] }>()
const store = useSessionPool()
const confirmId = ref<string | null>(null)

function choose(sessionId: string) {
  store.selectSession(sessionId)
  emit('close')
}
function create() {
  store.createSession()
  emit('close')
}
function remove(sessionId: string) {
  if (confirmId.value !== sessionId) { confirmId.value = sessionId; return }
  store.deleteSession(sessionId)
  confirmId.value = null
}
function timeLabel(summary: SessionSummary) {
  const date = new Date(summary.updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
</script>

<template>
  <div v-if="mobileOpen" class="fixed inset-0 z-30 bg-black/60 lg:hidden" @click="emit('close')" />
  <aside class="fixed inset-y-0 left-0 z-40 flex w-[282px] shrink-0 flex-col border-r border-white/[.075] bg-ink-900 transition-transform duration-200 lg:relative lg:translate-x-0" :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'">
    <div class="flex h-[70px] items-center gap-3 px-5">
      <div class="relative flex h-9 w-9 items-center justify-center rounded-xl bg-accent-400 text-ink-950 shadow-[0_0_25px_rgba(180,156,255,.22)]">
        <Bolt :size="19" :stroke-width="2.5" />
        <span class="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-emerald-400" />
      </div>
      <div class="min-w-0 flex-1"><div class="text-[15px] font-bold tracking-tight text-white">Pi Agent Gateway</div><div class="mono text-[10px] text-slate-500">AGENT GATEWAY</div></div>
      <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white lg:hidden" aria-label="关闭侧栏" @click="emit('close')"><X :size="17" /></button>
    </div>

    <div class="px-3 pt-5">
      <button type="button" class="flex w-full items-center justify-center gap-2 rounded-xl border border-accent-400/25 bg-accent-400/[.14] px-3 py-3 text-sm font-semibold text-accent-300 transition hover:bg-accent-400/[.22] disabled:opacity-50" :disabled="connection !== 'connected'" @click="create">
        <Plus :size="17" :stroke-width="2.5" /> 新建对话 <span class="ml-auto text-accent-300/50">↗</span>
      </button>
    </div>

    <div class="mt-7 flex min-h-0 flex-1 flex-col px-3">
      <div class="mb-2 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500"><span>最近对话</span><span class="mono">{{ store.sessions.length }}</span></div>
      <div class="min-h-0 flex-1 space-y-1 overflow-y-auto pb-5">
        <div v-if="!store.sessions.length" class="px-3 py-8 text-center text-xs leading-6 text-slate-500">暂无对话<br />点击上方按钮开始</div>
        <div v-for="session in store.sortedSessions" :key="session.id" class="group relative rounded-xl transition" :class="store.activeSessionId === session.id ? 'bg-white/[.085]' : 'hover:bg-white/[.045]'">
          <button type="button" class="flex w-full items-start gap-2.5 rounded-xl px-3 py-3 text-left focus-ring" @click="choose(session.id)">
            <MessageSquareText :size="15" class="mt-0.5 shrink-0" :class="store.activeSessionId === session.id ? 'text-accent-300' : 'text-slate-500'" />
            <span class="min-w-0 flex-1"><span class="block truncate text-[12px] font-medium" :class="store.activeSessionId === session.id ? 'text-slate-100' : 'text-slate-400'">{{ session.title || '新对话' }}</span><span class="mono mt-1 block text-[10px] text-slate-600">{{ timeLabel(session) }}</span></span>
          </button>
          <button type="button" class="absolute right-2 top-2 rounded-md p-1.5 text-slate-500 opacity-60 transition hover:bg-rose-500/15 hover:text-rose-300 hover:opacity-100 focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100" :class="confirmId === session.id ? '!opacity-100 !text-rose-300' : ''" :aria-label="confirmId === session.id ? '确认删除对话' : '删除对话'" :title="confirmId === session.id ? '再次点击确认删除' : '删除对话'" @click.stop="remove(session.id)"><Trash2 :size="13" /></button>
        </div>
      </div>
    </div>

    <div class="border-t border-white/[.075] px-3 py-3">
      <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs text-slate-400 transition hover:bg-white/[.055] hover:text-slate-200" @click="emit('settings'); emit('close')"><Settings2 :size="15" /> 设置 <ArrowUpRight :size="13" class="ml-auto" /></button>
      <div class="mx-1 mt-3 flex items-center gap-2 border-t border-white/[.07] px-2 pt-3 text-[11px] text-slate-500">
        <Wifi v-if="connection === 'connected'" :size="13" class="text-emerald-400" /><WifiOff v-else :size="13" class="text-amber-400" />
        <span>{{ connection === 'connected' ? '已连接' : connection === 'reconnecting' ? '正在重连…' : connection === 'connecting' ? '连接中…' : '未连接' }}</span>
        <span class="mono ml-auto text-[10px]">WS /ws</span>
      </div>
    </div>
  </aside>
</template>
