<script setup lang="ts">
import { computed } from 'vue'
import { Cpu } from 'lucide-vue-next'
import type { ModelInfo } from '@/types'
import AppSelect from './AppSelect.vue'

const props = defineProps<{
  models: ModelInfo[]
  selected?: { provider: string; id: string }
  disabled?: boolean
}>()
const emit = defineEmits<{ select: [provider: string, modelId: string] }>()

const selectedValue = computed(() => props.selected ? JSON.stringify([props.selected.provider, props.selected.id]) : '')
const options = computed(() => {
  const values = props.models.map((model) => ({
    value: JSON.stringify([model.provider, model.id]),
    label: model.name || model.id,
    description: model.name && model.name !== model.id ? model.id : model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : '可用模型',
    group: model.provider,
    badge: model.reasoning ? '推理' : undefined,
  }))
  if (props.selected && !props.models.some((model) => model.provider === props.selected?.provider && model.id === props.selected?.id)) {
    values.unshift({ value: selectedValue.value, label: props.selected.id, description: '当前会话模型', group: props.selected.provider, badge: undefined })
  }
  return values
})
function onChange(value: string) {
  try {
    const [provider, modelId] = JSON.parse(value) as [string, string]
    if (provider && modelId) emit('select', provider, modelId)
  } catch { /* Ignore malformed option values. */ }
}
</script>

<template>
  <AppSelect
    :model-value="selectedValue"
    :options="options"
    :disabled="disabled || !models.length"
    :placeholder="models.length ? '选择模型' : '暂无模型'"
    aria-label="选择模型"
    search-placeholder="搜索模型或 Provider…"
    searchable
    placement="top"
    :menu-width="300"
    compact
    class="min-w-[140px] max-w-[14rem] flex-1 sm:flex-none sm:w-[13rem]"
    @change="onChange"
  >
    <template #prefix><Cpu :size="14" class="shrink-0 text-accent-300" /></template>
  </AppSelect>
</template>
