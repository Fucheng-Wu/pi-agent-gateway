<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Braces, Check, CircleAlert, CodeXml, RotateCcw, Save, X } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'

const emit = defineEmits<{ close: [] }>()
const store = useSessionPool()
const content = ref('')
const dirty = computed(() => content.value !== store.modelsConfig)
const parseError = computed(() => {
  if (!content.value.trim()) return '内容不能为空'
  try { JSON.parse(content.value); return '' } catch (error) { return error instanceof Error ? error.message : 'JSON 格式有误' }
})

onMounted(() => store.fetchModelsConfig())
watch(() => store.modelsConfig, (value) => { if (!dirty.value || !content.value) content.value = value }, { immediate: true })

function formatJson() {
  try { content.value = JSON.stringify(JSON.parse(content.value), null, 2) + '\n' } catch { /* Inline validation explains errors. */ }
}
function save() { store.saveModelsConfig(content.value) }
</script>

<template>
  <div class="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" @click.self="emit('close')">
    <section role="dialog" aria-modal="true" aria-labelledby="models-title" class="surface flex h-[min(750px,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-panel">
      <header class="flex items-start gap-3 border-b subtle-border px-5 py-4 sm:px-6">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-400/10 text-accent-300"><Braces :size="18" /></div>
        <div class="min-w-0 flex-1"><h2 id="models-title" class="text-sm font-semibold text-slate-100">模型配置</h2><p class="mt-1 text-xs text-slate-500">编辑当前 Pi 配置目录中的 models.json，保存后模型列表会自动刷新。</p></div>
        <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="关闭" @click="emit('close')"><X :size="17" /></button>
      </header>
      <div class="flex flex-wrap items-center gap-2 border-b subtle-border px-5 py-3 sm:px-6"><span class="mono rounded-md border border-white/[.08] bg-ink-950 px-2 py-1 text-[11px] text-slate-400">models.json</span><span class="text-[11px] text-slate-600">本机 Pi 配置文件</span><span v-if="dirty" class="ml-auto flex items-center gap-1 text-[11px] text-amber-300"><span class="h-1.5 w-1.5 rounded-full bg-amber-300" />未保存</span><span v-else class="ml-auto flex items-center gap-1 text-[11px] text-emerald-400"><Check :size="12" />已同步</span></div>
      <div class="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
        <div v-if="!store.configLoaded" class="flex flex-1 items-center justify-center text-xs text-slate-500">正在读取配置…</div>
        <textarea v-else v-model="content" spellcheck="false" aria-label="models.json 内容" class="mono min-h-0 flex-1 resize-none rounded-xl border border-white/[.1] bg-ink-950 p-4 text-[12px] leading-6 text-slate-200 outline-none focus:border-accent-400/50" />
        <div class="mt-3 min-h-5 text-[11px]" :class="parseError ? 'text-rose-400' : 'text-emerald-400'"><span v-if="store.configLoaded" class="flex items-center gap-1.5"><CircleAlert v-if="parseError" :size="13" /><Check v-else :size="13" />{{ parseError || 'JSON 格式正确' }}</span></div>
      </div>
      <footer class="flex flex-wrap items-center gap-2 border-t subtle-border px-5 py-3 sm:px-6"><button type="button" class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white" :disabled="!store.configLoaded || !!parseError" @click="formatJson"><CodeXml :size="14" /> 格式化</button><button type="button" class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white" :disabled="!dirty" @click="content = store.modelsConfig"><RotateCcw :size="14" /> 还原</button><button type="button" class="ml-auto flex items-center gap-1.5 rounded-lg bg-accent-400 px-4 py-2 text-xs font-semibold text-ink-950 transition hover:bg-accent-300 disabled:opacity-40" :disabled="!dirty || !!parseError || store.configSaving" @click="save"><Save :size="14" /> {{ store.configSaving ? '保存中…' : '保存配置' }}</button></footer>
    </section>
  </div>
</template>
