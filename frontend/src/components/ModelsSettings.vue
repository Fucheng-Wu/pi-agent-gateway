<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArrowLeft, ArrowUpRight, Bot, Check, ChevronRight, CircleAlert, Cpu,
  KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, Save, Search, Trash2, X
} from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import type { ProviderInfo } from '@/types'

interface ModelEntry {
  id: string
  name?: string
  api?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  headers?: Record<string, string>
  [key: string]: unknown
}
interface ProviderEntry {
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  models?: ModelEntry[]
  [key: string]: unknown
}
interface ModelsConfig { providers: Record<string, ProviderEntry>; [key: string]: unknown }
type Selection = { type: 'builtin'; providerId: string } | { type: 'provider'; providerId: string } | { type: 'model'; providerId: string; index: number }

const store = useSessionPool()
const config = ref<ModelsConfig>({ providers: {} })
const baseline = ref('')
const loadError = ref('')
const selection = ref<Selection | null>(null)
const pickerOpen = ref(false)
const pickerQuery = ref('')
const providerNameDraft = ref('')
const headersDraft = ref('{}')
const authAnswer = ref('')
const chosenMethods = ref<Record<string, string>>({})
const apiOptions = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']

function canonical(value: unknown) { return JSON.stringify(value, null, 2) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function parseConfig(content: string): ModelsConfig {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const providers = parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
    ? parsed.providers as Record<string, ProviderEntry>
    : {}
  return { ...parsed, providers }
}

watch(() => store.modelsConfig, (content) => {
  if (!content) return
  try {
    const parsed = parseConfig(content)
    config.value = clone(parsed)
    baseline.value = canonical(parsed)
    loadError.value = ''
    const first = Object.keys(parsed.providers)[0]
    if (!selection.value && first) selection.value = { type: 'provider', providerId: first }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'models.json 无法读取'
  }
}, { immediate: true })

const customProviderIds = computed(() => new Set(Object.keys(config.value.providers)))
const customProviders = computed(() => Object.entries(config.value.providers))
const configuredBuiltins = computed(() => store.providers.filter((provider) => provider.authenticated && !customProviderIds.value.has(provider.id)))
const availableProviders = computed(() => {
  const query = pickerQuery.value.trim().toLowerCase()
  return store.providers.filter((provider) => !provider.authenticated && !customProviderIds.value.has(provider.id)
    && (!query || `${provider.name} ${provider.id}`.toLowerCase().includes(query)))
})
const availableOAuth = computed(() => availableProviders.value.filter((provider) => provider.authMethods?.some((method) => method.id === 'oauth')))
const availableApiKey = computed(() => availableProviders.value.filter((provider) => provider.authMethods?.some((method) => method.id === 'api_key')))
const selectedBuiltin = computed(() => selection.value?.type === 'builtin' ? store.providers.find((provider) => provider.id === selection.value?.providerId) : undefined)
const selectedProviderId = computed(() => selection.value && selection.value.type !== 'builtin' ? selection.value.providerId : '')
const selectedCustomProvider = computed(() => selectedProviderId.value ? config.value.providers[selectedProviderId.value] : undefined)
const selectedModel = computed(() => selection.value?.type === 'model' ? selectedCustomProvider.value?.models?.[selection.value.index] : undefined)
const challenge = computed(() => store.authChallenge)
const challengeProvider = computed(() => store.providers.find((provider) => provider.id === challenge.value?.providerId))
const isSecret = computed(() => /api.?key|token|secret|密钥|令牌/i.test(challenge.value?.prompt ?? ''))
const dirty = computed(() => canonical(config.value) !== baseline.value)
const configError = computed(() => {
  for (const [providerId, provider] of customProviders.value) {
    if (!providerId.trim()) return 'Provider ID 不能为空'
    if ((provider.models ?? []).some((model) => !model.id?.trim())) return `${providerId} 中有模型尚未填写 ID`
  }
  return ''
})
const discovery = computed(() => store.modelDiscovery.providerName === selectedProviderId.value ? store.modelDiscovery : null)
const testState = computed(() => {
  if (!selectedModel.value || store.modelTest.providerName !== selectedProviderId.value || store.modelTest.modelId !== selectedModel.value.id) return null
  return store.modelTest
})

watch(selection, (value) => {
  if (!value || value.type === 'builtin') return
  providerNameDraft.value = value.providerId
  headersDraft.value = canonical(config.value.providers[value.providerId]?.headers ?? {})
})

function providerMethods(provider: ProviderInfo) { return provider.authMethods?.length ? provider.authMethods : [{ id: 'api_key', name: 'API Key' }] }
function selectedMethod(provider: ProviderInfo) { return chosenMethods.value[provider.id] || providerMethods(provider)[0]?.id || 'api_key' }
function selectBuiltin(provider: ProviderInfo) { selection.value = { type: 'builtin', providerId: provider.id }; pickerOpen.value = false; authAnswer.value = '' }
function beginAuth(provider: ProviderInfo) { authAnswer.value = ''; store.login(provider.id, selectedMethod(provider)) }
function submitAuth() {
  if (!challenge.value) return
  const value = challenge.value.mode === 'confirm' ? 'yes' : authAnswer.value
  if (challenge.value.mode !== 'confirm' && !challenge.value.allowEmpty && !value.trim()) return
  store.submitAuth(challenge.value.challengeId, value)
  authAnswer.value = ''
}
function cancelAuth() { if (challenge.value) store.cancelAuth(challenge.value.challengeId); authAnswer.value = '' }

function addCustomProvider() {
  let name = 'new-provider'
  let suffix = 2
  while (config.value.providers[name]) name = `new-provider-${suffix++}`
  config.value.providers[name] = { api: 'openai-completions', models: [] }
  selection.value = { type: 'provider', providerId: name }
  pickerOpen.value = false
}
function renameProvider() {
  const current = selectedProviderId.value
  const next = providerNameDraft.value.trim()
  if (!current || !next || next === current) return
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(next)) { loadError.value = 'Provider ID 只能包含字母、数字、点、下划线和连字符'; return }
  if (config.value.providers[next]) { loadError.value = `Provider ${next} 已存在`; return }
  const entries = Object.entries(config.value.providers).map(([key, value]) => [key === current ? next : key, value] as const)
  config.value.providers = Object.fromEntries(entries)
  selection.value = selection.value?.type === 'model'
    ? { type: 'model', providerId: next, index: selection.value.index }
    : { type: 'provider', providerId: next }
  loadError.value = ''
}
function deleteProvider(providerId: string) {
  if (!window.confirm(`确定删除 Provider ${providerId}？`)) return
  delete config.value.providers[providerId]
  const next = Object.keys(config.value.providers)[0]
  selection.value = next ? { type: 'provider', providerId: next } : null
}
function addModel(providerId: string) {
  const provider = config.value.providers[providerId]
  const models = provider.models ?? (provider.models = [])
  models.push({ id: '' })
  selection.value = { type: 'model', providerId, index: models.length - 1 }
}
function deleteModel() {
  if (selection.value?.type !== 'model') return
  selectedCustomProvider.value?.models?.splice(selection.value.index, 1)
  selection.value = { type: 'provider', providerId: selection.value.providerId }
}
function applyHeaders() {
  if (!selectedCustomProvider.value) return
  try {
    const value = JSON.parse(headersDraft.value)
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((item) => typeof item !== 'string')) throw new Error('Headers 必须是字符串键值对象')
    if (Object.keys(value).length) selectedCustomProvider.value.headers = value
    else delete selectedCustomProvider.value.headers
    loadError.value = ''
  } catch (error) { loadError.value = error instanceof Error ? error.message : 'Headers JSON 无效' }
}
function updateInputs(event: Event) {
  if (!selectedModel.value) return
  const values = (event.target as HTMLInputElement).value.split(',').map((item) => item.trim()).filter(Boolean)
  if (values.length) selectedModel.value.input = values
  else delete selectedModel.value.input
}
function discoverModels() {
  if (selectedProviderId.value && selectedCustomProvider.value) store.discoverProviderModels(selectedProviderId.value, clone(selectedCustomProvider.value))
}
function addDiscovered(model: { id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }) {
  if (!selectedCustomProvider.value) return
  const models = selectedCustomProvider.value.models ?? (selectedCustomProvider.value.models = [])
  if (!models.some((item) => item.id === model.id)) models.push({ ...model })
}
function addAllDiscovered() { for (const model of discovery.value?.models ?? []) addDiscovered(model) }
function testModel() {
  if (selectedProviderId.value && selectedCustomProvider.value && selectedModel.value) store.testModelConfig(selectedProviderId.value, clone(selectedCustomProvider.value), clone(selectedModel.value))
}
function save() {
  if (configError.value || loadError.value) return
  store.saveModelsConfig(`${canonical(config.value)}\n`)
}
</script>

<template>
  <section class="flex min-h-[610px] flex-col gap-4">
    <div class="flex items-start gap-3"><div class="flex-1"><h3 class="text-sm font-semibold text-slate-100">模型</h3><p class="mt-1 text-xs leading-5 text-slate-500">添加内置 Provider 认证，或创建 OpenAI / Anthropic 兼容的自定义端点与模型。</p></div><button type="button" class="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" @click="pickerOpen = true"><Plus :size="14" />添加 Provider</button></div>

    <div v-if="!store.configLoaded" class="flex flex-1 items-center justify-center text-xs text-slate-500"><LoaderCircle :size="14" class="mr-2 animate-spin" />正在读取模型配置…</div>
    <div v-else class="grid min-h-0 flex-1 overflow-hidden rounded-xl border border-white/[.08] bg-ink-950/35 lg:grid-cols-[250px_1fr]">
      <aside class="max-h-[560px] overflow-y-auto border-b border-white/[.08] p-3 lg:border-b-0 lg:border-r">
        <div v-if="configuredBuiltins.length" class="mb-4"><div class="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">已连接</div><button v-for="provider in configuredBuiltins" :key="provider.id" type="button" class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs" :class="selection?.type === 'builtin' && selection.providerId === provider.id ? 'bg-accent-400/12 text-accent-200' : 'text-slate-400 hover:bg-white/5'" @click="selection = { type: 'builtin', providerId: provider.id }"><KeyRound :size="13" /><span class="min-w-0 flex-1 truncate">{{ provider.name }}</span><Check :size="11" class="text-emerald-400" /></button></div>
        <div><div class="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">自定义 Provider</div><div v-if="!customProviders.length" class="px-2 py-5 text-center text-[11px] leading-5 text-slate-600">点击“添加 Provider”创建兼容端点</div><div v-for="[providerId, provider] in customProviders" :key="providerId" class="mb-2"><button type="button" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs" :class="selection?.type === 'provider' && selection.providerId === providerId ? 'bg-accent-400/12 text-accent-200' : 'text-slate-400 hover:bg-white/5'" @click="selection = { type: 'provider', providerId }"><Cpu :size="13" /><span class="min-w-0 flex-1 truncate">{{ providerId }}</span><span class="mono text-[9px] text-slate-600">{{ provider.models?.length ?? 0 }}</span></button><button v-for="(model, index) in provider.models ?? []" :key="`${providerId}:${index}`" type="button" class="mt-0.5 flex w-full items-center gap-2 rounded-lg py-1.5 pl-8 pr-2 text-left text-[11px]" :class="selection?.type === 'model' && selection.providerId === providerId && selection.index === index ? 'bg-white/[.07] text-slate-200' : 'text-slate-500 hover:bg-white/[.035]'" @click="selection = { type: 'model', providerId, index }"><Bot :size="11" /><span class="min-w-0 flex-1 truncate">{{ model.id || '新模型' }}</span><ChevronRight :size="10" /></button><button type="button" class="mt-1 flex w-full items-center gap-1.5 rounded-lg py-1.5 pl-8 text-[10px] text-slate-600 hover:text-accent-300" @click="addModel(providerId)"><Plus :size="10" />添加模型</button></div></div>
      </aside>

      <div class="max-h-[560px] min-h-[460px] overflow-y-auto p-4 sm:p-5">
        <div v-if="!selection" class="flex h-full items-center justify-center text-xs text-slate-600">选择或添加一个 Provider</div>

        <div v-else-if="selectedBuiltin" class="space-y-4"><div class="flex items-start gap-3"><div class="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300"><KeyRound :size="18" /></div><div class="flex-1"><h4 class="text-sm font-semibold text-slate-100">{{ selectedBuiltin.name }}</h4><p class="mono mt-1 text-[10px] text-slate-600">{{ selectedBuiltin.id }} · {{ selectedBuiltin.modelCount ?? 0 }} 个模型</p></div><span class="flex items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-400"><Check :size="11" />已连接</span></div><p class="text-xs leading-6 text-slate-500">认证信息由 Pi Runtime 管理。可以重新认证，保存后模型会自动出现在会话模型选择器中。</p><div class="flex gap-2"><select :value="selectedMethod(selectedBuiltin)" class="rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-300" @change="chosenMethods[selectedBuiltin.id] = ($event.target as HTMLSelectElement).value"><option v-for="method in providerMethods(selectedBuiltin)" :key="method.id" :value="method.id">{{ method.name }}</option></select><button type="button" class="rounded-lg border border-accent-400/25 bg-accent-400/10 px-3 py-2 text-xs text-accent-300" @click="beginAuth(selectedBuiltin)">重新认证</button></div></div>

        <div v-else-if="selection.type === 'provider' && selectedCustomProvider" class="space-y-5">
          <div class="flex items-center gap-2"><div class="flex-1"><h4 class="text-sm font-semibold text-slate-100">Provider 配置</h4><p class="mt-1 text-[11px] text-slate-500">配置兼容端点、认证和请求协议。</p></div><button type="button" class="rounded-lg p-2 text-slate-600 hover:bg-rose-400/10 hover:text-rose-300" @click="deleteProvider(selection.providerId)"><Trash2 :size="15" /></button></div>
          <div class="grid gap-3 sm:grid-cols-2"><label class="text-[11px] text-slate-400">Provider ID<div class="mt-1 flex gap-2"><input v-model="providerNameDraft" class="mono min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200 outline-none" /><button v-if="providerNameDraft !== selection.providerId" type="button" class="rounded-lg bg-accent-400 px-3 text-[11px] font-semibold text-ink-950" @click="renameProvider">重命名</button></div></label><label class="text-[11px] text-slate-400">API<select v-model="selectedCustomProvider.api" class="mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200"><option v-for="api in apiOptions" :key="api" :value="api">{{ api }}</option></select></label></div>
          <label class="block text-[11px] text-slate-400">Base URL<input v-model="selectedCustomProvider.baseUrl" placeholder="https://api.example.com/v1" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200 outline-none" /></label>
          <label class="block text-[11px] text-slate-400">API Key<input v-model="selectedCustomProvider.apiKey" type="password" autocomplete="off" placeholder="环境变量名、!shell-command 或直接填写 Key" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200 outline-none" /><span class="mt-1 block text-[10px] text-slate-600">建议填写环境变量名；以 ! 开头可从命令读取。</span></label>
          <label class="block text-[11px] text-slate-400">Headers（JSON）<textarea v-model="headersDraft" rows="4" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs leading-5 text-slate-200 outline-none" @blur="applyHeaders" /></label>
          <div class="border-t border-white/[.07] pt-4"><div class="flex items-center gap-2"><button type="button" class="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40" :disabled="store.modelDiscovery.loading" @click="discoverModels"><RefreshCw :size="13" :class="store.modelDiscovery.loading ? 'animate-spin' : ''" />{{ store.modelDiscovery.loading ? '正在发现…' : '发现上游模型' }}</button><button type="button" class="ml-auto flex items-center gap-1 rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-300" @click="addModel(selection.providerId)"><Plus :size="13" />手动添加模型</button></div><div v-if="discovery?.models.length" class="mt-3 rounded-lg border border-white/[.08] bg-ink-900/60"><div class="flex items-center border-b border-white/[.07] px-3 py-2"><span class="text-[11px] text-slate-500">发现 {{ discovery.models.length }} 个模型</span><button type="button" class="ml-auto text-[11px] text-accent-300" @click="addAllDiscovered">全部添加</button></div><div class="max-h-52 overflow-y-auto"><div v-for="model in discovery.models" :key="model.id" class="flex items-center gap-2 border-b border-white/[.04] px-3 py-2 last:border-0"><div class="min-w-0 flex-1"><div class="mono truncate text-[11px] text-slate-300">{{ model.id }}</div><div v-if="model.name" class="truncate text-[10px] text-slate-600">{{ model.name }}</div></div><span v-if="selectedCustomProvider.models?.some((item) => item.id === model.id)" class="text-[10px] text-emerald-400">已添加</span><button v-else type="button" class="rounded px-2 py-1 text-[10px] text-accent-300 hover:bg-accent-400/10" @click="addDiscovered(model)">添加</button></div></div></div></div>
        </div>

        <div v-else-if="selection.type === 'model' && selectedCustomProvider && selectedModel" class="space-y-5"><div class="flex items-center gap-2"><button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5" @click="selection = { type: 'provider', providerId: selection.providerId }"><ArrowLeft :size="15" /></button><div class="flex-1"><h4 class="text-sm font-semibold text-slate-100">模型配置</h4><p class="mono mt-1 text-[10px] text-slate-600">{{ selection.providerId }}/{{ selectedModel.id || 'new-model' }}</p></div><button type="button" class="rounded-lg p-2 text-slate-600 hover:text-rose-300" @click="deleteModel"><Trash2 :size="15" /></button></div><div class="grid gap-3 sm:grid-cols-2"><label class="text-[11px] text-slate-400">模型 ID<input v-model="selectedModel.id" required placeholder="model-id" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" /></label><label class="text-[11px] text-slate-400">显示名称<input v-model="selectedModel.name" placeholder="可选" class="mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" /></label><label class="text-[11px] text-slate-400">API 覆盖<select v-model="selectedModel.api" class="mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200"><option value="">继承 Provider</option><option v-for="api in apiOptions" :key="api" :value="api">{{ api }}</option></select></label><label class="text-[11px] text-slate-400">输入类型<input :value="selectedModel.input?.join(', ') ?? ''" placeholder="text, image" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" @change="updateInputs" /></label><label class="text-[11px] text-slate-400">Context Window<input v-model.number="selectedModel.contextWindow" type="number" min="1" placeholder="例如 128000" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" /></label><label class="text-[11px] text-slate-400">Max Tokens<input v-model.number="selectedModel.maxTokens" type="number" min="1" placeholder="例如 8192" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" /></label></div><label class="flex items-center gap-2 text-xs text-slate-400"><input v-model="selectedModel.reasoning" type="checkbox" class="accent-violet-400" />支持推理/思考</label><div class="border-t border-white/[.07] pt-4"><button type="button" class="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 disabled:opacity-40" :disabled="!selectedModel.id.trim() || store.modelTest.loading" @click="testModel"><LoaderCircle v-if="store.modelTest.loading" :size="13" class="animate-spin" /><Check v-else :size="13" />{{ store.modelTest.loading ? '测试中…' : '测试连接' }}</button><div v-if="testState?.result" class="mt-3 rounded-lg border px-3 py-2 text-xs" :class="testState.result.ok ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-rose-400/20 bg-rose-400/5 text-rose-300'"><div class="flex items-center gap-2"><Check v-if="testState.result.ok" :size="13" /><CircleAlert v-else :size="13" />{{ testState.result.ok ? '连接成功' : testState.result.error }}<span v-if="testState.result.latencyMs" class="mono ml-auto text-[10px] opacity-70">{{ testState.result.latencyMs }}ms<span v-if="testState.result.status"> · HTTP {{ testState.result.status }}</span></span></div><p v-if="testState.result.responseText" class="mt-2 text-[11px] opacity-80">{{ testState.result.responseText }}</p></div></div></div>
      </div>
    </div>

    <form v-if="challenge" class="rounded-xl border border-accent-400/25 bg-accent-400/[.06] p-4" @submit.prevent="submitAuth"><div class="mb-2 text-xs font-medium text-slate-100">{{ challengeProvider?.name || challenge.providerId }} · 认证信息</div><p class="mb-3 text-xs leading-5 text-slate-300">{{ challenge.prompt }}</p><select v-if="challenge.mode === 'select'" v-model="authAnswer" class="w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200"><option value="" disabled>请选择…</option><option v-for="option in challenge.options" :key="option" :value="option">{{ option }}</option></select><input v-else-if="challenge.mode === 'input'" v-model="authAnswer" :type="isSecret ? 'password' : 'text'" :placeholder="challenge.placeholder || '请输入…'" autocomplete="off" class="w-full rounded-lg border border-white/10 bg-ink-900 px-3 py-2 text-xs text-slate-200" /><div class="mt-3 flex justify-end gap-2"><button type="button" class="px-3 py-2 text-xs text-slate-400" @click="cancelAuth">取消</button><button type="submit" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950">{{ challenge.mode === 'confirm' ? '确认' : '提交' }}</button></div></form>
    <div v-if="store.authStatus" class="rounded-lg border px-3 py-2.5 text-xs" :class="store.authStatus.status === 'error' ? 'border-rose-400/20 text-rose-300' : 'border-accent-400/20 text-slate-300'"><div class="flex items-center gap-2"><LoaderCircle v-if="store.authStatus.status === 'started'" :size="13" class="animate-spin" /><CircleAlert v-else-if="store.authStatus.status === 'error'" :size="13" /><Check v-else :size="13" />{{ store.authStatus.message || (store.authStatus.status === 'started' ? '正在等待认证…' : store.authStatus.status) }}</div><a v-if="store.authStatus.url" :href="store.authStatus.url" target="_blank" rel="noopener noreferrer" class="mt-2 inline-flex items-center gap-1 text-accent-300 underline">打开认证页面 <ArrowUpRight :size="11" /></a></div>
    <div class="flex min-h-5 items-center gap-2"><span v-if="loadError || configError" class="flex items-center gap-1.5 text-[11px] text-rose-400"><CircleAlert :size="13" />{{ loadError || configError }}</span><span v-else-if="dirty" class="text-[11px] text-amber-300">有未保存修改</span><span v-else class="flex items-center gap-1 text-[11px] text-emerald-400"><Check :size="12" />models.json 已同步</span><button type="button" class="ml-auto flex items-center gap-1.5 rounded-lg bg-accent-400 px-4 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!dirty || !!configError || !!loadError || store.configSaving" @click="save"><Save :size="14" />{{ store.configSaving ? '保存中…' : '保存模型配置' }}</button></div>

    <div v-if="pickerOpen" class="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" @click.self="pickerOpen = false"><div class="surface flex max-h-[75vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-panel"><div class="flex items-center gap-2 border-b border-white/[.08] p-4"><Search :size="15" class="text-slate-500" /><input v-model="pickerQuery" autofocus placeholder="搜索 Provider" class="min-w-0 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600" /><button type="button" class="rounded p-1 text-slate-500 hover:bg-white/5" @click="pickerOpen = false"><X :size="16" /></button></div><div class="space-y-5 overflow-y-auto p-4"><div><div class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">自定义</div><button type="button" class="flex w-full items-center gap-3 rounded-xl border border-dashed border-white/15 bg-ink-950/50 p-4 text-left hover:border-accent-400/40" @click="addCustomProvider"><div class="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-400/10 text-accent-300"><Plus :size="17" /></div><div class="flex-1"><div class="text-xs font-semibold text-slate-100">OpenAI / Anthropic compatible</div><div class="mt-1 text-[11px] text-slate-500">添加自定义 Base URL、API Key 和模型</div></div><ChevronRight :size="15" class="text-slate-600" /></button></div><div v-if="availableOAuth.length"><div class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">订阅 / OAuth</div><div class="grid gap-2 sm:grid-cols-2"><button v-for="provider in availableOAuth" :key="provider.id" type="button" class="flex items-center gap-3 rounded-xl border border-white/[.08] bg-ink-950/50 p-3 text-left hover:border-accent-400/35" @click="selectBuiltin(provider)"><KeyRound :size="16" class="text-amber-300" /><div class="min-w-0 flex-1"><div class="truncate text-xs font-semibold text-slate-100">{{ provider.name }}</div><div class="mono mt-1 text-[9px] text-slate-600">{{ provider.id }} · OAuth</div></div></button></div></div><div v-if="availableApiKey.length"><div class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">API Key</div><div class="grid gap-2 sm:grid-cols-2"><button v-for="provider in availableApiKey" :key="provider.id" type="button" class="flex items-center gap-3 rounded-xl border border-white/[.08] bg-ink-950/50 p-3 text-left hover:border-accent-400/35" @click="selectBuiltin(provider)"><LockKeyhole :size="16" class="text-cyan-300" /><div class="min-w-0 flex-1"><div class="truncate text-xs font-semibold text-slate-100">{{ provider.name }}</div><div class="mono mt-1 text-[9px] text-slate-600">{{ provider.id }} · {{ provider.modelCount ?? 0 }} models</div></div></button></div></div></div></div></div>
  </section>
</template>
