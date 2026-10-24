<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { Brain, ChevronDown, LoaderCircle } from 'lucide-vue-next'

const props = defineProps<{ text: string; streaming?: boolean }>()
const open = ref(false)
const content = ref<HTMLDivElement | null>(null)
const followLatest = ref(true)

watch(() => props.streaming, (streaming) => { open.value = !!streaming }, { immediate: true })
watch([() => props.text, open], async () => {
  if (!open.value || !props.streaming || !followLatest.value) return
  await nextTick()
  if (content.value) content.value.scrollTop = content.value.scrollHeight
})

function onScroll() {
  if (!content.value) return
  followLatest.value = content.value.scrollHeight - content.value.scrollTop - content.value.clientHeight < 40
}
</script>

<template>
  <div class="my-3 overflow-hidden rounded-xl border border-accent-400/15 bg-accent-400/[.045]">
    <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-accent-300 transition hover:bg-accent-400/[.055]" :aria-expanded="open" @click="open = !open">
      <LoaderCircle v-if="streaming" :size="14" class="animate-spin" />
      <Brain v-else :size="14" />
      <span class="font-medium">{{ streaming ? '正在思考' : '思考过程' }}</span>
      <span class="ml-auto text-[10px] text-accent-300/50">{{ text.length.toLocaleString() }} 字</span>
      <ChevronDown :size="14" class="transition-transform" :class="open ? 'rotate-180' : ''" />
    </button>
    <div v-if="open" ref="content" class="max-h-80 overflow-y-auto border-t border-accent-400/10 px-3 py-3 text-xs leading-6 whitespace-pre-wrap text-slate-400" @scroll="onScroll">{{ text }}</div>
  </div>
</template>
