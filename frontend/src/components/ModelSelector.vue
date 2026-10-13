<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown, Cpu } from 'lucide-vue-next'
import type { ModelInfo } from '@/types'

const props = defineProps<{
  models: ModelInfo[]
  selected?: { provider: string; id: string }
  disabled?: boolean
}>()
const emit = defineEmits<{ select: [provider: string, modelId: string] }>()

const groups = computed(() => {
  const grouped = new Map<string, ModelInfo[]>()
  for (const model of props.models) {
    if (!grouped.has(model.provider)) grouped.set(model.provider, [])
    grouped.get(model.provider)!.push(model)
  }
  return [...grouped.entries()]
})
const selectedValue = computed(() => props.selected ? `${props.selected.provider}\u0000${props.selected.id}` : '')
function onChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const separator = value.indexOf('\u0000')
  if (separator < 0) return
  emit('select', value.slice(0, separator), value.slice(separator + 1))
}
</script>

<template>
  <label class="relative inline-flex min-w-0 max-w-[15rem] items-center gap-1.5 rounded-lg border border-white/[.08] bg-white/[.045] px-2.5 py-1.5 text-xs text-slate-200 transition hover:bg-white/[.085] focus-within:border-accent-400/60">
    <Cpu :size="14" class="shrink-0 text-accent-300" />
    <span class="sr-only">选择模型</span>
    <select :value="selectedValue" :disabled="disabled || !models.length" class="min-w-0 flex-1 appearance-none truncate bg-transparent pr-3 outline-none" @change="onChange">
      <option value="" disabled>{{ models.length ? '选择模型' : '暂无模型' }}</option>
      <option v-if="selected && !models.some(m => m.provider === selected?.provider && m.id === selected?.id)" :value="selectedValue">{{ selected.provider }} / {{ selected.id }}</option>
      <optgroup v-for="[provider, items] in groups" :key="provider" :label="provider">
        <option v-for="model in items" :key="model.id" :value="`${model.provider}\u0000${model.id}`">{{ model.name || model.id }}</option>
      </optgroup>
    </select>
    <ChevronDown :size="12" class="pointer-events-none absolute right-2 text-slate-500" />
  </label>
</template>

<style scoped>
select option, select optgroup { color: rgb(var(--slate-100)); background: rgb(var(--ink-800)); }
</style>
