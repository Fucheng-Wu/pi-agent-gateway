<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ArrowUp, Folder, X } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
const store = useSessionPool()
const emit = defineEmits<{ close: [] }>()
const path = ref(store.workspace?.path ?? '')
const busy = computed(() => store.workspaceChanging || store.directoriesLoading)
onMounted(() => store.browseDirectories(path.value || undefined))
watch(() => store.directoryListing?.path, (next) => { if (next) path.value = next })
watch(() => store.workspace, (next) => { if (next && (next.path === path.value || next.path === store.directoryListing?.path)) emit('close') })
function browse() { store.browseDirectories(path.value) }
</script>

<template>
  <div class="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="emit('close')">
    <section role="dialog" aria-modal="true" aria-labelledby="workspace-title" class="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-white/10 bg-ink-900 shadow-panel" @keydown.esc="emit('close')">
      <header class="flex items-center gap-3 border-b border-white/10 p-5"><Folder :size="20" class="text-accent-300" /><h2 id="workspace-title" class="flex-1 font-semibold text-slate-100">选择项目</h2><button aria-label="关闭项目选择" @click="emit('close')"><X :size="18" class="text-slate-400" /></button></header>
      <div class="space-y-4 overflow-y-auto p-5">
        <p class="text-xs leading-6 text-slate-400">切换后，所有已连接的窗口都会使用这个项目。请先等待正在执行的任务完成。</p>
        <form class="flex gap-2" @submit.prevent="browse"><input v-model="path" aria-label="项目绝对路径" placeholder="输入项目的绝对路径" class="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent-400" /><button class="rounded-lg border border-white/10 px-3 text-xs text-slate-300" :disabled="busy">浏览</button></form>
        <div v-if="store.workspace?.recent.length" class="space-y-1"><h3 class="mb-2 text-xs text-slate-500">最近项目</h3><button v-for="recent in store.workspace.recent" :key="recent" class="block w-full truncate rounded-lg px-2 py-2 text-left text-xs text-slate-300 hover:bg-white/5" :title="recent" :disabled="busy" @click="store.browseDirectories(recent)">{{ recent }}</button></div>
        <div class="rounded-xl border border-white/10">
          <div class="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-slate-500"><span class="min-w-0 flex-1 truncate" :title="store.directoryListing?.path">{{ store.directoryListing?.path || '选择目录' }}</span><button v-if="store.directoryListing?.parent" aria-label="上一级目录" :disabled="busy" @click="store.browseDirectories(store.directoryListing!.parent!)"><ArrowUp :size="15" /></button></div>
          <div class="max-h-56 overflow-y-auto p-2" :aria-busy="store.directoriesLoading"><p v-if="store.directoriesLoading" class="p-3 text-xs text-slate-500">正在读取目录…</p><template v-else><button v-for="directory in store.directoryListing?.directories" :key="directory.path" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5" @click="store.browseDirectories(directory.path)"><Folder :size="14" class="text-accent-300" />{{ directory.name }}</button><p v-if="!store.directoryListing?.directories.length" class="p-3 text-xs text-slate-500">此目录没有可浏览的子目录。</p></template></div>
        </div>
      </div>
      <footer class="flex items-center justify-end gap-3 border-t border-white/10 p-4"><button class="px-3 py-2 text-sm text-slate-400" @click="emit('close')">取消</button><button class="rounded-lg bg-accent-400 px-4 py-2 text-sm font-medium text-ink-950" :disabled="busy || !path.trim()" @click="store.setWorkspace(path)">{{ store.workspaceChanging ? '正在切换…' : '使用此项目' }}</button></footer>
    </section>
  </div>
</template>
