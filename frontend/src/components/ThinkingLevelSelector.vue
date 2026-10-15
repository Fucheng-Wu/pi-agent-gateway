<script setup lang="ts">
import { Brain } from 'lucide-vue-next'
import type { ThinkingLevel } from '@/types'
import AppSelect from './AppSelect.vue'

defineProps<{ selected: ThinkingLevel; disabled?: boolean }>()
const emit = defineEmits<{ select: [level: ThinkingLevel] }>()
const options: { value: ThinkingLevel; label: string; description: string; badge?: string }[] = [
  { value: 'off', label: 'off', description: '速度优先，适合直接问答' },
  { value: 'minimal', label: 'minimal', description: '少量推理，响应更快' },
  { value: 'low', label: 'low', description: '轻量分析日常任务' },
  { value: 'medium', label: 'medium', description: '速度与推理的均衡选择', badge: '推荐' },
  { value: 'high', label: 'high', description: '深入分析复杂问题' },
  { value: 'xhigh', label: 'xhigh', description: '更充分的推理预算' },
  { value: 'max', label: 'max', description: '最强推理，耗时也更长' }
]
</script>

<template>
  <AppSelect
    :model-value="selected"
    :options="options"
    :disabled="disabled"
    aria-label="思考强度"
    placement="top"
    :menu-width="230"
    compact
    class="w-[7.5rem]"
    @change="emit('select', $event as ThinkingLevel)"
  >
    <template #prefix><Brain :size="14" class="shrink-0 text-accent-300" /></template>
  </AppSelect>
</template>
