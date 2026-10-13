<script setup lang="ts">
import { computed } from 'vue'
import { CircleGauge } from 'lucide-vue-next'
import type { ContextUsage } from '@/types'

const props = defineProps<{ usage?: ContextUsage }>()
const percentage = computed(() => Math.min(100, Math.max(0, props.usage?.percent ?? 0)))
const color = computed(() => percentage.value >= 85 ? 'rgb(var(--rose-400))' : percentage.value >= 65 ? 'rgb(var(--amber-400))' : 'rgb(var(--accent-400))')
const formatter = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
</script>

<template>
  <div class="group flex shrink-0 items-center gap-2 text-[11px] text-slate-500" :title="usage ? `上下文 ${formatter.format(usage.usedTokens)} / ${formatter.format(usage.contextWindow)} tokens` : '尚无上下文用量数据'">
    <CircleGauge :size="14" />
    <div class="hidden w-14 overflow-hidden rounded-full bg-white/10 sm:block" style="height: 4px">
      <div class="h-full rounded-full transition-all duration-500" :style="{ width: `${percentage}%`, background: color }" />
    </div>
    <span class="mono tabular-nums">{{ usage ? `${Math.round(percentage)}%` : '—' }}</span>
  </div>
</template>
