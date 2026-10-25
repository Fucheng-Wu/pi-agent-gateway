<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { markdown } from '@/lib/markdown'
import { Bot, Check, Copy } from 'lucide-vue-next'
import type { ChatMessage } from '@/types'
import ThinkingPanel from './ThinkingPanel.vue'
import ToolCard from './ToolCard.vue'

const props = defineProps<{ message: ChatMessage; streaming?: boolean }>()
const rendered = ref('')
let renderTimer: ReturnType<typeof setTimeout> | undefined
function render() {
  renderTimer = undefined
  rendered.value = markdown.render(props.message.text || '')
}
watch([() => props.message.text, () => props.streaming], () => {
  if (!props.streaming) { clearTimeout(renderTimer); render() }
  else if (!renderTimer) renderTimer = setTimeout(render, 60)
}, { immediate: true })
onUnmounted(() => clearTimeout(renderTimer))
const copied = ref(false)

async function copyText() {
  try {
    await navigator.clipboard.writeText(props.message.text)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* Clipboard may be unavailable outside a secure context. */ }
}
</script>

<template>
  <article class="message-row group" :class="message.role === 'user' ? 'message-row--user' : 'message-row--assistant'">
    <div v-if="message.role !== 'user'" class="message-avatar" aria-hidden="true">
      <Bot :size="24" :stroke-width="1.6" />
    </div>
    <div class="message-body" :class="message.role === 'user' ? 'user-bubble' : ''">
      <div v-if="message.role !== 'user'" class="message-label">
        {{ message.role === 'tool' ? '工具' : 'Pi' }}
        <span v-if="streaming" class="h-1.5 w-1.5 rounded-full bg-accent-300 typing-dot" />
      </div>
      <div>
        <ThinkingPanel v-if="message.thinking" :text="message.thinking" :streaming="streaming && !message.text" />
        <ToolCard v-for="tool in message.tools" :key="tool.id" :tool="tool" />
        <div v-if="message.text" class="markdown" v-html="rendered" />
        <div v-else-if="streaming && !message.thinking && !message.tools?.length" class="flex h-5 items-center gap-1.5" aria-label="正在回复">
          <span v-for="i in 3" :key="i" class="typing-dot h-1.5 w-1.5 rounded-full bg-accent-300" :style="{ animationDelay: `${i * 0.16}s` }" />
        </div>
        <div v-if="message.error" class="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">{{ message.error }}</div>
      </div>
      <div v-if="message.role !== 'user' && message.text && !streaming" class="message-actions">
        <button type="button" class="flex items-center gap-1.5 text-xs focus-ring" :aria-label="copied ? '已复制' : '复制回复'" :title="copied ? '已复制' : '复制回复'" @click="copyText">
          <Check v-if="copied" :size="15" /><Copy v-else :size="15" /><span v-if="copied">已复制</span>
        </button>
      </div>
    </div>
  </article>
</template>
