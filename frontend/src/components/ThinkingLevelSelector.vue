<script setup lang="ts">
import { Brain, ChevronDown } from 'lucide-vue-next'
import type { ThinkingLevel } from '@/types'

defineProps<{ selected: ThinkingLevel; disabled?: boolean }>()
const emit = defineEmits<{ select: [level: ThinkingLevel] }>()
const options: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关闭思考' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' }
]
</script>

<template>
  <label class="relative inline-flex items-center gap-1.5 rounded-lg border border-white/[.08] bg-white/[.045] px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-white/[.085] focus-within:border-accent-400/60">
    <Brain :size="14" class="shrink-0 text-accent-300" />
    <span class="sr-only">思考强度</span>
    <select :value="selected" :disabled="disabled" class="appearance-none bg-transparent pr-4 outline-none" @change="emit('select', ($event.target as HTMLSelectElement).value as ThinkingLevel)">
      <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <ChevronDown :size="12" class="pointer-events-none absolute right-2 text-slate-500" />
  </label>
</template>

<style scoped>
select option { color: rgb(var(--slate-100)); background: rgb(var(--ink-800)); }
</style>
