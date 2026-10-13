<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowUpRight, Bolt, Check, CircleAlert, KeyRound, LoaderCircle, LockKeyhole, Search, X } from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import type { ProviderInfo } from '@/types'

const emit = defineEmits<{ close: [] }>()
const store = useSessionPool()
const chosenMethods = ref<Record<string, string>>({})
const answer = ref('')
const query = ref('')
const selectedProvider = computed(() => store.providers.find((p) => p.id === store.authChallenge?.providerId))
const challenge = computed(() => store.authChallenge)
const isSecret = computed(() => /api.?key|token|secret|密钥|令牌/i.test(challenge.value?.prompt ?? ''))
const filteredProviders = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return needle ? store.providers.filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(needle)) : store.providers
})

onMounted(() => store.refreshProviders())

function methods(provider: ProviderInfo) {
  return provider.authMethods?.length ? provider.authMethods : [{ id: 'api_key', name: 'API Key' }]
}
function selectedMethod(provider: ProviderInfo) {
  return chosenMethods.value[provider.id] || methods(provider)[0]?.id || 'api_key'
}
function begin(provider: ProviderInfo) {
  answer.value = ''
  store.login(provider.id, selectedMethod(provider))
}
function submit() {
  if (!challenge.value) return
  const value = challenge.value.mode === 'confirm' ? 'yes' : answer.value
  if (challenge.value.mode !== 'confirm' && !challenge.value.allowEmpty && !value.trim()) return
  store.submitAuth(challenge.value.challengeId, value)
  answer.value = ''
}
function cancel() {
  if (challenge.value) store.cancelAuth(challenge.value.challengeId)
  answer.value = ''
}
</script>

<template>
  <div class="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" @click.self="emit('close')">
    <section role="dialog" aria-modal="true" aria-labelledby="provider-title" class="surface flex max-h-[min(750px,92vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl shadow-panel">
      <header class="flex items-start gap-3 border-b subtle-border px-5 py-4 sm:px-6">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300"><Bolt :size="18" /></div>
        <div class="min-w-0 flex-1"><h2 id="provider-title" class="text-sm font-semibold text-slate-100">Provider 快捷配置</h2><p class="mt-1 text-xs text-slate-500">通过 Pi 的认证流程连接模型服务。</p></div>
        <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="关闭" @click="emit('close')"><X :size="17" /></button>
      </header>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-5 sm:p-6">
        <label v-if="store.providers.length" class="flex items-center gap-2 rounded-lg border border-white/[.08] bg-ink-950/65 px-3 text-slate-500 focus-within:border-accent-400/45">
          <Search :size="15" class="shrink-0" />
          <input v-model="query" type="search" placeholder="搜索 Provider" aria-label="搜索 Provider" class="w-full bg-transparent py-2.5 text-xs text-slate-200 outline-none placeholder:text-slate-600" />
        </label>
        <div v-if="!store.providers.length" class="rounded-xl border border-white/[.07] p-7 text-center text-xs text-slate-500">尚未发现 Provider。可以在模型配置中添加自定义 Provider。</div>
        <div v-else-if="!filteredProviders.length" class="rounded-xl border border-white/[.07] p-7 text-center text-xs text-slate-500">没有找到匹配的 Provider</div>
        <div v-for="provider in filteredProviders" :key="provider.id" class="rounded-xl border border-white/[.08] bg-ink-950/55 p-4">
          <div class="flex items-start gap-3"><div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[.055] text-slate-300"><KeyRound :size="16" /></div><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="text-xs font-semibold text-slate-100">{{ provider.name }}</span><span class="mono text-[10px] text-slate-600">{{ provider.id }}</span></div><div class="mt-1 text-[11px] text-slate-500">{{ provider.modelCount ?? 0 }} 个模型</div></div><span class="flex items-center gap-1 rounded-full px-2 py-1 text-[10px]" :class="provider.authenticated ? 'bg-emerald-400/10 text-emerald-400' : 'bg-slate-400/10 text-slate-400'"><Check v-if="provider.authenticated" :size="11" /><LockKeyhole v-else :size="11" />{{ provider.authenticated ? '已配置' : '未配置' }}</span></div>
          <div class="mt-4 flex gap-2"><label class="min-w-0 flex-1"><span class="sr-only">{{ provider.name }} 认证方式</span><select :value="selectedMethod(provider)" class="w-full rounded-lg border border-white/[.08] bg-ink-800 px-2.5 py-2 text-xs text-slate-300 outline-none focus:border-accent-400/50" @change="chosenMethods[provider.id] = ($event.target as HTMLSelectElement).value"><option v-for="method in methods(provider)" :key="method.id" :value="method.id">{{ method.name }}</option></select></label><button type="button" class="flex items-center gap-1.5 rounded-lg border border-accent-400/25 bg-accent-400/10 px-3 py-2 text-xs font-medium text-accent-300 transition hover:bg-accent-400/20" @click="begin(provider)">{{ provider.authenticated ? '重新认证' : '开始配置' }}<ArrowUpRight :size="12" /></button></div>
        </div>

        <div v-if="store.authStatus" class="rounded-xl border px-3 py-3 text-xs" :class="store.authStatus.status === 'error' ? 'border-rose-400/20 bg-rose-400/5 text-rose-300' : 'border-accent-400/20 bg-accent-400/5 text-slate-300'"><div class="flex items-center gap-2"><LoaderCircle v-if="store.authStatus.status === 'started'" :size="14" class="animate-spin text-accent-300" /><Check v-else-if="store.authStatus.status === 'complete'" :size="14" class="text-emerald-400" /><CircleAlert v-else :size="14" /><span>{{ store.authStatus.message || (store.authStatus.status === 'started' ? '正在等待认证…' : store.authStatus.status) }}</span></div><a v-if="store.authStatus.url" :href="store.authStatus.url" target="_blank" rel="noopener noreferrer" class="mt-2 inline-flex items-center gap-1 text-accent-300 underline underline-offset-2">打开认证页面 <ArrowUpRight :size="12" /></a></div>

        <form v-if="challenge" class="rounded-xl border border-accent-400/25 bg-accent-400/[.06] p-4" @submit.prevent="submit">
          <div class="mb-3 text-xs font-medium text-slate-100">{{ selectedProvider?.name || challenge.providerId }} · 认证信息</div>
          <p class="mb-3 text-xs leading-5 text-slate-300">{{ challenge.prompt }}</p>
          <select v-if="challenge.mode === 'select'" v-model="answer" class="w-full rounded-lg border border-white/10 bg-ink-800 px-3 py-2.5 text-xs text-slate-200 outline-none focus:border-accent-400/60"><option value="" disabled>请选择…</option><option v-for="option in challenge.options" :key="option" :value="option">{{ option }}</option></select>
          <input v-else-if="challenge.mode === 'input'" v-model="answer" :type="isSecret ? 'password' : 'text'" :placeholder="challenge.placeholder || '请输入…'" autocomplete="off" class="w-full rounded-lg border border-white/10 bg-ink-800 px-3 py-2.5 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent-400/60" />
          <div class="mt-3 flex justify-end gap-2"><button type="button" class="rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5" @click="cancel">取消</button><button type="submit" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950 hover:bg-accent-300" :disabled="challenge.mode !== 'confirm' && !challenge.allowEmpty && !answer.trim()">{{ challenge.mode === 'confirm' ? '确认' : '提交' }}</button></div>
        </form>
      </div>
      <footer class="border-t subtle-border px-5 py-3 text-[11px] leading-5 text-slate-600 sm:px-6">认证信息由后端 Pi SDK 管理；输入的 API Key 只通过当前 WebSocket 提交。</footer>
    </section>
  </div>
</template>
