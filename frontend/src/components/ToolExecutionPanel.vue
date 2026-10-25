<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, LoaderCircle, Wrench } from 'lucide-vue-next'
import type { ToolCall } from '@/types'
import ToolCard from './ToolCard.vue'

const props = defineProps<{ tools: ToolCall[]; streaming?: boolean }>()
const emit = defineEmits<{ subagent: [toolId: string] }>()
const open = ref(false)
const running = computed(() => props.tools.filter(tool => tool.status === 'running').length)
const failed = computed(() => props.tools.filter(tool => tool.status === 'error').length)

// Collapse once when body output starts; subsequent chunks respect manual expansion.
watch(() => props.streaming, streaming => { open.value = !!streaming }, { immediate: true })
</script>

<template>
  <div class="mb-4">
    <button type="button" class="flex w-full items-center gap-2 py-2 text-left text-sm text-slate-400 hover:text-slate-200" :aria-expanded="open" aria-label="工具执行过程" @click="open = !open">
      <LoaderCircle v-if="running" :size="14" class="shrink-0 animate-spin text-accent-300" />
      <Wrench v-else :size="14" class="shrink-0" />
      <span class="font-medium">工具执行过程</span>
      <span class="text-xs text-slate-500">{{ tools.length }} 项<span v-if="running"> · {{ running }} 项执行中</span><span v-if="failed" class="text-rose-400"> · {{ failed }} 项失败</span></span>
      <ChevronDown :size="14" class="ml-auto shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <div v-show="open">
      <ToolCard v-for="tool in tools" :key="tool.id" :tool="tool" @subagent="emit('subagent', $event)" />
    </div>
  </div>
</template>
