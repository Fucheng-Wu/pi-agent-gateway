<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { Bot, Check, Copy, UserRound } from 'lucide-vue-next'
import type { ChatMessage } from '@/types'
import ThinkingPanel from './ThinkingPanel.vue'
import ToolCard from './ToolCard.vue'

const props = defineProps<{ message: ChatMessage; streaming?: boolean }>()
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const rendered = computed(() => markdown.render(props.message.text || ''))
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
  <article class="group flex gap-3.5 py-5 sm:gap-4" :class="message.role === 'user' ? 'justify-end' : ''">
    <div v-if="message.role !== 'user'" class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent-400/20 bg-accent-400/10 text-accent-300 shadow-sm">
      <Bot :size="17" />
    </div>
    <div class="min-w-0" :class="message.role === 'user' ? 'max-w-[88%] sm:max-w-[78%]' : 'w-full max-w-[48rem]'">
      <div v-if="message.role !== 'user'" class="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300">
        {{ message.role === 'tool' ? '工具' : 'Pi' }}
        <span v-if="streaming" class="h-1.5 w-1.5 rounded-full bg-accent-300 typing-dot" />
      </div>
      <div :class="message.role === 'user' ? 'rounded-2xl rounded-tr-md border border-accent-400/15 bg-accent-400/[.105] px-4 py-3 text-slate-100' : 'text-slate-200'">
        <ThinkingPanel v-if="message.thinking" :text="message.thinking" :streaming="streaming && !message.text" />
        <ToolCard v-for="tool in message.tools" :key="tool.id" :tool="tool" />
        <div v-if="message.text" class="markdown text-[13.5px] sm:text-sm" v-html="rendered" />
        <div v-else-if="streaming && !message.thinking && !message.tools?.length" class="flex h-5 items-center gap-1.5" aria-label="正在回复">
          <span v-for="i in 3" :key="i" class="typing-dot h-1.5 w-1.5 rounded-full bg-accent-300" :style="{ animationDelay: `${i * 0.16}s` }" />
        </div>
        <div v-if="message.error" class="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-300">{{ message.error }}</div>
      </div>
      <div v-if="message.role !== 'user' && message.text && !streaming" class="mt-2 flex h-6 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button type="button" class="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-300 focus-ring" :aria-label="copied ? '已复制' : '复制回复'" @click="copyText">
          <Check v-if="copied" :size="12" /><Copy v-else :size="12" />{{ copied ? '已复制' : '复制' }}
        </button>
      </div>
    </div>
    <div v-if="message.role === 'user'" class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-ink-800 text-slate-300">
      <UserRound :size="16" />
    </div>
  </article>
</template>
