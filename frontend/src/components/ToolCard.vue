<script setup lang="ts">
import { computed, ref } from 'vue'
import { Bot, ChevronDown, CircleCheck, CircleX, LoaderCircle, PanelRightOpen, Wrench } from 'lucide-vue-next'
import type { ToolCall } from '@/types'

const props = defineProps<{ tool: ToolCall }>()
const emit = defineEmits<{ subagent: [toolId: string] }>()
const isSubagent = computed(() => props.tool.name === 'Agent' || props.tool.name === 'spawn_agent' || !!props.tool.subagent)
const profile = computed(() => props.tool.subagent?.name || (props.tool.input as { profile?: string } | undefined)?.profile || '子代理')
const task = computed(() => props.tool.subagent?.task || (props.tool.input as { task?: string } | undefined)?.task || '点击查看执行过程')
const status = computed(() => isSubagent.value ? props.tool.subagent?.status ?? props.tool.status : props.tool.status)
const open = ref(false)
const showFullOutput = ref(false)
const output = computed(() => showFullOutput.value ? props.tool.output : props.tool.output?.slice(-12_000))
const input = computed(() => format(props.tool.input))
function format(value: unknown) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}
</script>

<template>
  <div class="my-2 overflow-hidden rounded-xl border border-white/[.09] bg-ink-950/60">
    <button type="button" class="flex w-full items-center gap-2 px-3 py-3 text-left text-[13px] transition hover:bg-white/[.045]" :aria-expanded="isSubagent ? undefined : open" :aria-label="isSubagent ? `查看子代理 ${profile} 的执行过程` : undefined" @click="isSubagent ? emit('subagent', tool.id) : open = !open">
      <Bot v-if="isSubagent" :size="16" class="text-accent-300" /><Wrench v-else :size="14" class="text-slate-400" />
      <span class="mono min-w-0 truncate font-medium text-slate-200">{{ isSubagent ? profile : tool.name }}</span>
      <span class="ml-auto flex items-center gap-1.5 text-[11px]" :class="status === 'error' ? 'text-rose-400' : status === 'done' ? 'text-emerald-400' : 'text-amber-300'">
        <LoaderCircle v-if="status === 'running'" :size="12" class="animate-spin" />
        <CircleCheck v-else-if="status === 'done'" :size="12" />
        <CircleX v-else :size="12" />
        {{ tool.subagent?.closed ? '已关闭' : status === 'running' ? (tool.subagent?.phase === 'queued' ? '排队中' : tool.subagent?.phase === 'waiting' ? '等待协作' : '执行中') : status === 'done' ? '已完成' : '失败或已中断' }}
      </span>
      <PanelRightOpen v-if="isSubagent" :size="15" class="text-accent-300" />
      <ChevronDown v-else :size="13" class="text-slate-500 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <button v-if="isSubagent" type="button" class="block w-full truncate px-3 pb-3 text-left text-xs text-slate-400 hover:text-accent-300" @click="emit('subagent', tool.id)">{{ task }}</button>
    <div v-if="open" class="grid gap-3 border-t border-white/[.08] px-3 py-3">
      <div v-if="input"><div class="mb-2 text-xs font-medium text-slate-500">输入</div><pre class="mono max-h-64 overflow-auto whitespace-pre-wrap break-all text-[13px] leading-6 text-slate-300">{{ input }}</pre></div>
      <div v-if="tool.output"><div class="mb-2 text-xs font-medium text-slate-500">输出</div><pre class="mono max-h-64 overflow-auto whitespace-pre-wrap break-all text-[13px] leading-6 text-slate-300">{{ output }}</pre><button v-if="tool.output.length > 12_000" class="mt-2 text-xs text-accent-300" @click="showFullOutput = !showFullOutput">{{ showFullOutput ? '收起，仅显示末尾' : '已截取末尾 12,000 字符，展开全部输出' }}</button></div>
      <div v-if="!input && !tool.output" class="text-xs text-slate-500">等待工具输出…</div>
    </div>
  </div>
</template>
