<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown, Files } from 'lucide-vue-next'
import type { RunReview } from '@/types'
defineProps<{ review: RunReview }>()
const open = ref(false)
const selected = ref<string | null>(null)
</script>

<template>
  <section class="my-5 rounded-xl border border-white/10 bg-ink-900" aria-label="本轮变更与命令">
    <button class="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-slate-300" :aria-expanded="open" @click="open = !open">
      <Files :size="15" class="text-accent-300" /><span>本轮变更</span><span class="text-slate-500">{{ review.files.length }} 个文件 · {{ review.commands.length }} 条命令</span><ChevronDown :size="14" class="ml-auto" :class="open ? 'rotate-180' : ''" />
    </button>
    <div v-if="open" class="space-y-3 border-t border-white/10 p-4 text-xs">
      <p class="break-all text-slate-500">{{ review.workspace }}</p>
      <p class="text-slate-500">与本轮任务开始前比较，包含期间手动或其他会话产生的修改。</p>
      <p v-if="review.note" class="text-amber-300">{{ review.note }}</p>
      <p v-if="!review.files.length" class="text-slate-500">未发现可展示的文件变化。</p>
      <div v-for="file in review.files" :key="file.path" class="overflow-hidden rounded-lg border border-white/10">
        <button class="flex w-full items-center gap-2 px-3 py-2 text-left" :aria-expanded="selected === file.path" @click="selected = selected === file.path ? null : file.path"><span class="text-accent-300">{{ ({ added: '新增', modified: '修改', deleted: '删除' })[file.status] }}</span><span class="mono min-w-0 break-all text-slate-300">{{ file.path }}</span></button>
        <pre v-if="selected === file.path && file.diff" class="mono max-h-96 overflow-auto border-t border-white/10 p-3 text-[11px] leading-5"><span v-for="(line, index) in file.diff.split('\n')" :key="index" class="block" :class="line.startsWith('+') ? 'text-emerald-300' : line.startsWith('-') ? 'text-rose-300' : 'text-slate-400'">{{ line || ' ' }}</span></pre>
        <p v-else-if="selected === file.path" class="px-3 pb-3 text-slate-500">{{ file.omitted }}</p>
      </div>
      <div v-if="review.commands.length" class="space-y-2 pt-2">
        <h3 class="font-medium text-slate-300">执行的命令</h3>
        <details v-for="command in review.commands" :key="command.id" class="rounded-lg border border-white/10 p-3">
          <summary class="cursor-pointer break-all"><span :class="command.status === 'error' ? 'text-rose-300' : 'text-emerald-300'">{{ command.status === 'error' ? '失败或中止' : command.status === 'running' ? '执行中' : '执行结束' }}</span><code class="ml-2 text-slate-300">{{ command.command }}</code></summary>
          <pre v-if="command.output" class="mono mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-[11px] text-slate-400">{{ command.output }}</pre>
        </details>
      </div>
    </div>
  </section>
</template>
