<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ShieldCheck } from 'lucide-vue-next'
import type { PermissionDecision, PermissionRequest } from '@/types'

const props = defineProps<{ request: PermissionRequest; busy?: boolean; remaining: number; sessionTitle?: string }>()
const emit = defineEmits<{ decide: [decision: PermissionDecision] }>()
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const inputText = computed(() => JSON.stringify(props.request.input, null, 2))
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); if (!props.busy) emit('decide', 'deny') }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0)
  if (!controls.length) { event.preventDefault(); return }
  const index = controls.indexOf(document.activeElement as HTMLElement)
  if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
  else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0]?.focus() }
}
async function focusDialog() { await nextTick(); dialog.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
onMounted(() => { previousFocus = document.activeElement as HTMLElement | null; document.addEventListener('keydown', onKeydown); void focusDialog() })
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown); previousFocus?.focus() })
watch(() => props.request.id, focusDialog)
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="permission-title" aria-describedby="permission-description"
        class="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-ink-850 text-slate-100 shadow-panel">
        <div class="flex items-center gap-3 border-b border-white/10 p-5"><ShieldCheck :size="23" class="text-amber-300" /><div><h2 id="permission-title" class="font-semibold">允许代理执行此操作？</h2><p class="mt-1 text-xs text-slate-400">{{ request.agentName }} · {{ sessionTitle || request.sessionId.slice(0, 8) }}</p></div></div>
        <div class="min-h-0 space-y-4 overflow-auto p-5">
          <p id="permission-description" class="text-sm text-slate-300">代理正在等待你的决定。允许后将继续执行，拒绝后会把结果返回给代理。</p>
          <dl class="space-y-2 text-xs"><div><dt class="text-slate-500">工具</dt><dd class="mono mt-1 break-all">{{ request.toolName }}</dd></div><div><dt class="text-slate-500">操作对象</dt><dd class="mono mt-1 whitespace-pre-wrap break-all">{{ request.resource }}</dd></div></dl>
          <details><summary class="cursor-pointer text-xs text-slate-400">查看完整参数</summary><pre class="mono mt-2 whitespace-pre-wrap break-all rounded-lg bg-ink-950 p-3 text-xs text-slate-300">{{ inputText }}</pre></details>
          <p class="text-xs leading-5 text-slate-500">“本会话允许”仅记住当前角色、工具及相同操作对象；切换角色后失效。{{ remaining > 1 ? `还有 ${remaining - 1} 项待确认。` : '' }}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-2 border-t border-white/10 p-4">
          <button type="button" class="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40" :disabled="busy" @click="emit('decide', 'deny')">拒绝</button>
          <button type="button" class="rounded-lg border border-accent-400/30 px-3 py-2 text-xs text-accent-300 hover:bg-accent-400/10 disabled:opacity-40" :disabled="busy" @click="emit('decide', 'allow_session')">本会话允许</button>
          <button type="button" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950 hover:bg-accent-300 disabled:opacity-40" :disabled="busy" @click="emit('decide', 'allow_once')">{{ busy ? '处理中…' : '本次允许' }}</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
