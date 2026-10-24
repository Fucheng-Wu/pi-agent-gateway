<script setup lang="ts">
import { ref } from 'vue'
import { Check, CircleAlert, X } from 'lucide-vue-next'
import { storeToRefs } from 'pinia'
import { useEventBridge } from '@/composables/useEventBridge'
import { useSessionPool } from '@/stores/session-pool'
import ChatView from '@/components/ChatView.vue'
import SessionSidebar from '@/components/SessionSidebar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import PermissionDialog from '@/components/PermissionDialog.vue'

const store = useSessionPool()
const { activeSession, notice } = storeToRefs(store)
const { status } = useEventBridge()
const mobileOpen = ref(false)
const panel = ref<'settings' | null>(null)
</script>

<template>
  <div class="flex h-full min-h-0 bg-ink-950 text-slate-100">
    <SessionSidebar :connection="status" :mobile-open="mobileOpen" @close="mobileOpen = false" @settings="panel = 'settings'" />
    <ChatView :session="activeSession" :connection="status" @menu="mobileOpen = true" />
    <SettingsPanel v-if="panel === 'settings'" @close="panel = null" />
    <PermissionDialog v-if="store.permissionRequests[0]" :key="store.permissionRequests[0].id" :request="store.permissionRequests[0]"
      :busy="store.permissionResponding[store.permissionRequests[0].id]" :remaining="store.permissionRequests.length"
      :session-title="store.sessions.find(s => s.id === store.permissionRequests[0]?.sessionId)?.title"
      @decide="store.respondPermission(store.permissionRequests[0].id, $event)" />
    <div v-if="notice" role="status" class="fixed bottom-5 right-5 z-[60] flex max-w-[min(420px,calc(100vw-40px))] items-start gap-2 rounded-xl border px-3.5 py-3 text-xs shadow-panel" :class="notice.kind === 'error' ? 'border-rose-400/25 bg-ink-800 text-rose-200' : 'border-emerald-400/25 bg-ink-800 text-emerald-200'"><CircleAlert v-if="notice.kind === 'error'" :size="15" class="mt-0.5 shrink-0" /><Check v-else :size="15" class="mt-0.5 shrink-0" /><span class="leading-5">{{ notice.text }}</span><button type="button" aria-label="关闭提示" class="ml-2 rounded p-0.5 opacity-60 hover:opacity-100" @click="store.notice = null"><X :size="14" /></button></div>
  </div>
</template>
