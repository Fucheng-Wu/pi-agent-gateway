<script setup lang="ts">
import { computed, ref } from 'vue'
import { Folder, MessageSquareText, Plus, Settings2, Trash2, Wifi, WifiOff, X } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import type { ConnectionState, SessionSummary } from '@/types'

defineProps<{ connection: ConnectionState; mobileOpen: boolean }>()
const emit = defineEmits<{ close: []; settings: []; workspace: [] }>()
const store = useSessionPool()
const confirmId = ref<string | null>(null)
const projectName = computed(() => store.workspace?.path.split(/[\\/]/).filter(Boolean).at(-1) || '选择项目')

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
  <aside class="fixed inset-y-0 left-0 z-40 flex w-[260px] shrink-0 flex-col bg-ink-900 transition-transform duration-200 lg:relative lg:translate-x-0" :class="mobileOpen ? 'translate-x-0' : '-translate-x-full'">
    <div class="flex h-[76px] items-center gap-2.5 px-6">
      <span class="text-[32px] font-medium leading-none text-accent-300" aria-hidden="true">π</span>
      <div class="min-w-0 flex-1 text-[17px] font-semibold tracking-tight text-slate-100">Pi Agent</div>
      <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-white lg:hidden" aria-label="关闭侧栏" @click="emit('close')"><X :size="17" /></button>
    </div>

    <div class="px-4 pt-3">
      <button type="button" class="flex w-full items-center gap-2.5 rounded-xl border border-accent-400/15 bg-accent-400/[.07] px-4 py-3 text-sm font-medium text-accent-300 transition hover:bg-accent-400/[.12] disabled:opacity-50" :disabled="connection !== 'connected'" @click="create">
        <Plus :size="19" :stroke-width="1.8" /> 新建对话
      </button>
      <button class="mt-3 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] text-slate-400 hover:bg-white/5" :title="store.workspace?.path" aria-label="选择项目" :disabled="connection !== 'connected'" @click="emit('workspace'); emit('close')"><Folder :size="16" class="shrink-0" /><span class="min-w-0 truncate">{{ projectName }}</span></button>
    </div>

    <div class="mt-7 flex min-h-0 flex-1 flex-col px-3">
      <div class="mb-3 flex items-center justify-between px-3 text-xs text-slate-500"><span>最近对话</span><span>{{ store.sessions.length }}</span></div>
      <div class="min-h-0 flex-1 space-y-1 overflow-y-auto pb-5">
        <div v-if="!store.sessions.length" class="px-3 py-8 text-center text-xs leading-6 text-slate-500">暂无对话<br />点击上方按钮开始</div>
        <div v-for="session in store.sortedSessions" :key="session.id" class="group relative rounded-xl transition" :class="store.activeSessionId === session.id ? 'bg-white/[.085]' : 'hover:bg-white/[.045]'">
          <button type="button" class="flex w-full items-start gap-2.5 rounded-xl px-3 py-3 text-left focus-ring" @click="choose(session.id)">
            <MessageSquareText :size="15" class="mt-0.5 shrink-0" :class="store.activeSessionId === session.id ? 'text-accent-300' : 'text-slate-500'" />
            <span class="min-w-0 flex-1"><span class="block truncate text-[14px] font-normal" :class="store.activeSessionId === session.id ? 'text-slate-100' : 'text-slate-300'">{{ session.title || '新对话' }}</span><span class="mt-1.5 block text-[11px] text-slate-500">{{ timeLabel(session) }}</span></span>
          </button>
          <button type="button" class="absolute right-2 top-2 rounded-md p-1.5 text-slate-500 opacity-60 transition hover:bg-rose-500/15 hover:text-rose-300 hover:opacity-100 focus:opacity-100 lg:opacity-0 lg:group-hover:opacity-100" :class="confirmId === session.id ? '!opacity-100 !text-rose-300' : ''" :aria-label="confirmId === session.id ? '确认删除对话' : '删除对话'" :title="confirmId === session.id ? '再次点击确认删除' : '删除对话'" @click.stop="remove(session.id)"><Trash2 :size="13" /></button>
        </div>
      </div>
    </div>

    <div class="px-4 py-4">
      <button type="button" class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-slate-400 transition hover:bg-white/[.055] hover:text-slate-200" @click="emit('settings'); emit('close')"><Settings2 :size="17" /> 设置</button>
      <div class="mx-1 mt-2 flex items-center gap-2 px-2 pt-2 text-xs text-slate-500">
        <Wifi v-if="connection === 'connected'" :size="13" class="text-emerald-400" /><WifiOff v-else :size="13" class="text-amber-400" />
        <span>{{ connection === 'connected' ? '已连接' : connection === 'reconnecting' ? '正在重连…' : connection === 'connecting' ? '连接中…' : '未连接' }}</span>
      </div>
    </div>
  </aside>
</template>
