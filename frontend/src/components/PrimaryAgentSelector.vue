<script setup lang="ts">
import { computed } from 'vue'
import { Bot } from 'lucide-vue-next'
import type { PrimaryAgentInfo } from '@/types'
import AppSelect from './AppSelect.vue'

const props = defineProps<{ agents: PrimaryAgentInfo[]; selected?: string; disabled?: boolean; changing?: boolean }>()
const emit = defineEmits<{ select: [agentId: string] }>()
const options = computed(() => props.agents.map((agent) => ({ value: agent.id, label: agent.name, description: agent.description })))
</script>

<template>
  <AppSelect :model-value="selected || 'build'" :options="options" :disabled="disabled || changing || !agents.length"
    :placeholder="changing ? '切换中…' : '选择主代理'" aria-label="选择主代理" placement="top" :menu-width="280" compact
    class="w-[7.5rem] shrink-0" @change="emit('select', $event)">
    <template #prefix><Bot :size="14" class="shrink-0 text-accent-300" /></template>
  </AppSelect>
</template>
