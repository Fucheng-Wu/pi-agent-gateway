<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDown, CircleCheck, CircleX, LoaderCircle, Wrench } from 'lucide-vue-next'
import type { ToolCall } from '@/types'

const props = defineProps<{ tool: ToolCall }>()
const open = ref(false)
const input = computed(() => format(props.tool.input))
function format(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
</script>

<template>
  <div class="my-2 overflow-hidden rounded-xl border border-white/[.09] bg-ink-950/60">
    <button type="button" class="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs transition hover:bg-white/[.045]" :aria-expanded="open" @click="open = !open">
      <Wrench :size="14" class="text-slate-400" />
      <span class="mono min-w-0 truncate font-medium text-slate-200">{{ tool.name }}</span>
      <span class="ml-auto flex items-center gap-1.5 text-[11px]" :class="tool.status === 'error' ? 'text-rose-400' : tool.status === 'done' ? 'text-emerald-400' : 'text-amber-300'">
        <LoaderCircle v-if="tool.status === 'running'" :size="12" class="animate-spin" />
        <CircleCheck v-else-if="tool.status === 'done'" :size="12" />
        <CircleX v-else :size="12" />
        {{ tool.status === 'running' ? '执行中' : tool.status === 'done' ? '已完成' : '失败' }}
      </span>
      <ChevronDown :size="13" class="text-slate-500 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <div v-if="open" class="grid gap-3 border-t border-white/[.08] px-3 py-3">
      <div v-if="input"><div class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">输入</div><pre class="mono max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-slate-300">{{ input }}</pre></div>
      <div v-if="tool.output"><div class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">输出</div><pre class="mono max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-slate-300">{{ tool.output }}</pre></div>
      <div v-if="!input && !tool.output" class="text-xs text-slate-500">等待工具输出…</div>
    </div>
  </div>
</template>
