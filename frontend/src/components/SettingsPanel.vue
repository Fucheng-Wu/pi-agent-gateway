<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Bot, Braces, Check, CircleAlert, CodeXml, Download, PackageOpen, Plus,
  RefreshCw, Save, Server, Sparkles, Trash2, X
} from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import AppSelect from '@/components/AppSelect.vue'
import ModelsSettings from '@/components/ModelsSettings.vue'
import type { SubagentProfileInfo } from '@/types'

const emit = defineEmits<{ close: [] }>()
const store = useSessionPool()
const section = ref<'models' | 'skills' | 'plugins' | 'agents' | 'mcp'>('models')
const pluginSource = ref('')
const pluginScope = ref<'global' | 'project'>('global')
const mcpContent = ref('')
const mcpBaseline = ref('')
const mcpAddError = ref('')
const showSkillForm = ref(false)
const showAgentForm = ref(false)
const showMcpForm = ref(false)
const skillDraft = ref({ name: '', description: '', instructions: '', scope: 'global' as 'global' | 'project' })
const agentDraft = ref({ id: '', name: '', description: '', systemPrompt: '', tools: ['read', 'grep', 'find', 'ls'] as string[], scope: 'global' as 'global' | 'project' })
const mcpDraft = ref({ name: '', transport: 'stdio' as 'stdio' | 'http', target: '', args: '' })

const sections = [
  { id: 'models' as const, label: '模型', icon: Braces },
  { id: 'skills' as const, label: '技能', icon: Sparkles },
  { id: 'plugins' as const, label: '插件', icon: PackageOpen },
  { id: 'agents' as const, label: '子代理', icon: Bot },
  { id: 'mcp' as const, label: 'MCP', icon: Server }
]
const availableTools = ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write']
const scopeOptions = [{ value: 'global', label: '全局' }, { value: 'project', label: '当前项目' }]
const transportOptions = [{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP / SSE' }]
const settings = computed(() => store.featureSettings)
const mcpDirty = computed(() => mcpContent.value !== mcpBaseline.value)
const mcpError = computed(() => jsonError(mcpContent.value, true))

function jsonError(content: string, requireMcp: boolean) {
  if (!content.trim()) return '配置不能为空'
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '顶层必须是对象'
    if (requireMcp && (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers))) return '必须包含 mcpServers 对象'
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON 格式有误'
  }
}

watch(() => store.featureSettings?.mcp.content, (content) => {
  if (content === undefined) return
  if (!mcpContent.value || mcpContent.value === mcpBaseline.value) mcpContent.value = content
  mcpBaseline.value = content
}, { immediate: true })

onMounted(() => {
  store.refreshFeatureSettings()
  store.fetchModelsConfig()
  store.refreshProviders()
})

function createSkill() {
  const draft = skillDraft.value
  if (!draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()) return
  if (store.createSkill({ ...draft })) {
    skillDraft.value = { name: '', description: '', instructions: '', scope: 'global' }
    showSkillForm.value = false
  }
}
function installPlugin() {
  const source = pluginSource.value.trim()
  if (source && store.runPluginAction('install', source, pluginScope.value)) pluginSource.value = ''
}
function removePlugin(source: string, scope: 'global' | 'project') {
  if (window.confirm(`确定卸载插件 ${source}？`)) store.runPluginAction('remove', source, scope)
}
function toggleProfile(profile: SubagentProfileInfo) { store.setSubagentProfileEnabled(profile.id, !profile.enabled) }
function createAgent() {
  const draft = agentDraft.value
  if (!draft.id.trim() || !draft.name.trim() || !draft.description.trim() || !draft.systemPrompt.trim()) return
  if (store.createSubagentProfile({ ...draft, tools: [...draft.tools] })) {
    agentDraft.value = { id: '', name: '', description: '', systemPrompt: '', tools: ['read', 'grep', 'find', 'ls'], scope: 'global' }
    showAgentForm.value = false
  }
}
function deleteAgent(profile: SubagentProfileInfo) {
  if (!profile.builtIn && window.confirm(`确定删除子代理 ${profile.name}？`)) store.deleteSubagentProfile(profile.id)
}
function toggleAgentTool(tool: string) {
  const tools = agentDraft.value.tools
  agentDraft.value.tools = tools.includes(tool) ? tools.filter((item) => item !== tool) : [...tools, tool]
}
function setMaxConcurrent(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isInteger(value)) store.setSubagentSettings({ maxConcurrent: value })
}
function addMcpServer() {
  const draft = mcpDraft.value
  const name = draft.name.trim()
  const target = draft.target.trim()
  mcpAddError.value = ''
  if (!name || !target || mcpError.value) return
  const parsed = JSON.parse(mcpContent.value) as { mcpServers: Record<string, unknown> }
  if (Object.prototype.hasOwnProperty.call(parsed.mcpServers, name)) {
    mcpAddError.value = `MCP Server ${name} 已存在`
    return
  }
  parsed.mcpServers[name] = draft.transport === 'http'
    ? { url: target, enabled: true }
    : { command: target, args: draft.args.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), enabled: true }
  const content = `${JSON.stringify(parsed, null, 2)}\n`
  mcpContent.value = content
  if (store.saveMcpConfig(content)) {
    mcpDraft.value = { name: '', transport: 'stdio', target: '', args: '' }
    showMcpForm.value = false
  }
}
function formatMcp() { if (!mcpError.value) mcpContent.value = `${JSON.stringify(JSON.parse(mcpContent.value), null, 2)}\n` }
</script>

<template>
  <div class="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" @click.self="emit('close')">
    <section role="dialog" aria-modal="true" aria-labelledby="settings-title" class="surface flex h-[min(840px,94vh)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl shadow-panel">
      <header class="flex items-start gap-3 border-b subtle-border px-5 py-4 sm:px-6">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-400/10 text-accent-300"><Braces :size="18" /></div>
        <div class="min-w-0 flex-1"><h2 id="settings-title" class="text-sm font-semibold text-slate-100">Pi 设置</h2><p class="mt-1 text-xs text-slate-500">统一管理模型、技能、插件、子代理与 MCP 服务。</p></div>
        <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="关闭" @click="emit('close')"><X :size="17" /></button>
      </header>

      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="设置分类" class="flex shrink-0 gap-1 overflow-x-auto border-b subtle-border p-3 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
          <button v-for="item in sections" :key="item.id" type="button" class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition" :class="section === item.id ? 'bg-accent-400/12 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'" @click="section = item.id">
            <component :is="item.icon" :size="15" />{{ item.label }}
            <span v-if="item.id === 'skills' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.skills.length }}</span>
            <span v-else-if="item.id === 'plugins' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.plugins.length }}</span>
            <span v-else-if="item.id === 'agents' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.subagents.profiles.length }}</span>
            <span v-else-if="item.id === 'mcp' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.mcp.serverCount }}</span>
          </button>
        </nav>

        <main class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <ModelsSettings v-if="section === 'models'" />

          <div v-else-if="store.featureSettingsLoading && !settings" class="flex h-full items-center justify-center text-xs text-slate-500"><RefreshCw :size="14" class="mr-2 animate-spin" />正在读取 Pi 资源…</div>
          <template v-else-if="settings">
            <section v-if="section === 'skills'" class="space-y-4">
              <div class="flex items-start gap-3"><div class="flex-1"><h3 class="text-sm font-semibold text-slate-100">技能</h3><p class="mt-1 text-xs leading-5 text-slate-500">创建标准 SKILL.md，或管理 Pi 已发现技能的模型调用状态。</p></div><button type="button" class="flex items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" @click="showSkillForm = !showSkillForm"><Plus :size="14" />新增技能</button></div>
              <form v-if="showSkillForm" class="space-y-3 rounded-xl border border-accent-400/20 bg-accent-400/[.04] p-4" @submit.prevent="createSkill">
                <div class="grid gap-3 sm:grid-cols-[1fr_150px]"><label class="text-[11px] text-slate-400">名称<input v-model="skillDraft.name" required pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="my-skill" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200 outline-none" /></label><label class="text-[11px] text-slate-400">保存到<AppSelect v-model="skillDraft.scope" :options="scopeOptions" aria-label="技能保存位置" class="mt-1 w-full" /></label></div>
                <label class="block text-[11px] text-slate-400">描述<input v-model="skillDraft.description" required maxlength="500" class="mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200 outline-none" /></label><label class="block text-[11px] text-slate-400">技能指令<textarea v-model="skillDraft.instructions" required rows="7" placeholder="告诉模型何时以及如何使用这个技能…" class="mt-1 w-full resize-y rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs leading-5 text-slate-200 outline-none" /></label>
                <div class="flex justify-end gap-2"><button type="button" class="px-3 py-2 text-xs text-slate-400" @click="showSkillForm = false">取消</button><button type="submit" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!!store.featureAction">创建技能</button></div>
              </form>
              <div v-if="!settings.skills.length" class="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-xs text-slate-500">当前没有发现技能。</div>
              <div v-for="skill in settings.skills" :key="skill.filePath" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-start gap-3"><div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300"><Sparkles :size="15" /></div><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="text-xs font-semibold text-slate-100">{{ skill.name }}</span><span class="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">{{ skill.scope }}</span></div><p class="mt-1 text-[11px] leading-5 text-slate-500">{{ skill.description || '无描述' }}</p><p class="mono mt-2 break-all text-[10px] text-slate-600">{{ skill.filePath }}</p></div><button type="button" role="switch" :aria-checked="skill.modelInvocable" class="relative h-6 w-11 shrink-0 rounded-full transition" :class="skill.modelInvocable ? 'bg-accent-400' : 'bg-white/10'" :disabled="!!store.featureAction" @click="store.setSkillEnabled(skill.filePath, !skill.modelInvocable)"><span class="absolute top-1 h-4 w-4 rounded-full bg-white transition" :class="skill.modelInvocable ? 'left-6' : 'left-1'" /></button></div></div>
            </section>

            <section v-else-if="section === 'plugins'" class="space-y-4">
              <div><h3 class="text-sm font-semibold text-slate-100">插件</h3><p class="mt-1 text-xs leading-5 text-slate-500">通过 Pi 包管理器添加 npm 包、Git 地址或本地插件。</p></div>
              <form class="grid gap-2 rounded-xl border border-white/[.08] bg-ink-950/45 p-3 sm:grid-cols-[1fr_130px_auto]" @submit.prevent="installPlugin"><input v-model="pluginSource" class="mono min-w-0 rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200 outline-none" placeholder="npm:@scope/pi-plugin 或 Git 地址" /><AppSelect v-model="pluginScope" :options="scopeOptions" aria-label="插件安装位置" class="w-full" /><button type="submit" class="flex items-center justify-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!pluginSource.trim() || !!store.featureAction"><Download :size="14" />新增插件</button></form>
              <div v-if="!settings.plugins.length" class="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-xs text-slate-500">尚未配置插件。</div>
              <div v-for="plugin in settings.plugins" :key="`${plugin.scope}:${plugin.source}`" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-start gap-3"><PackageOpen :size="17" class="mt-0.5 shrink-0 text-cyan-300" /><div class="min-w-0 flex-1"><div class="mono break-all text-xs text-slate-200">{{ plugin.source }}</div><div class="mt-1 flex gap-2 text-[10px] text-slate-500"><span>{{ plugin.scope }}</span><span :class="plugin.installed ? 'text-emerald-400' : 'text-amber-300'">{{ plugin.installed ? '已安装' : '缺失' }}</span></div><p v-if="plugin.installedPath" class="mono mt-2 break-all text-[10px] text-slate-600">{{ plugin.installedPath }}</p></div><div class="flex shrink-0 items-center gap-1"><button type="button" role="switch" :aria-checked="plugin.enabled" class="relative mr-1 h-5 w-9 rounded-full" :class="plugin.enabled ? 'bg-accent-400' : 'bg-white/10'" :disabled="!!store.featureAction" @click="store.setPluginEnabled(plugin.source, plugin.scope, !plugin.enabled)"><span class="absolute top-1 h-3 w-3 rounded-full bg-white transition" :class="plugin.enabled ? 'left-5' : 'left-1'" /></button><button type="button" class="rounded-lg p-2 text-slate-500 hover:bg-white/5" @click="store.runPluginAction('update', plugin.source, plugin.scope)"><RefreshCw :size="14" /></button><button type="button" class="rounded-lg p-2 text-slate-500 hover:text-rose-300" @click="removePlugin(plugin.source, plugin.scope)"><Trash2 :size="14" /></button></div></div></div>
            </section>

            <section v-else-if="section === 'agents'" class="space-y-4">
              <div class="flex items-start gap-3"><div class="flex-1"><h3 class="text-sm font-semibold text-slate-100">子代理</h3><p class="mt-1 text-xs leading-5 text-slate-500">创建可被主代理通过 Agent 工具调用的独立角色。</p></div><button type="button" class="flex items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" @click="showAgentForm = !showAgentForm"><Plus :size="14" />新增子代理</button></div>
              <div class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-center gap-3"><Bot :size="17" class="text-accent-300" /><div class="flex-1"><div class="text-xs font-medium text-slate-100">子代理功能</div><div class="mt-1 text-[11px] text-slate-500">当前运行 {{ settings.subagents.active }} / {{ settings.subagents.maxConcurrent }}</div></div><button type="button" role="switch" :aria-checked="settings.subagents.enabled" class="relative h-6 w-11 rounded-full" :class="settings.subagents.enabled ? 'bg-accent-400' : 'bg-white/10'" @click="store.setSubagentSettings({ enabled: !settings.subagents.enabled })"><span class="absolute top-1 h-4 w-4 rounded-full bg-white transition" :class="settings.subagents.enabled ? 'left-6' : 'left-1'" /></button></div><label class="mt-4 flex items-center gap-3 border-t border-white/[.07] pt-4 text-xs text-slate-400">最大并发数<input type="number" min="1" max="8" :value="settings.subagents.maxConcurrent" class="mono ml-auto w-20 rounded-lg border border-white/10 bg-ink-950 px-2 py-1.5 text-right text-slate-200" @change="setMaxConcurrent" /></label></div>
              <form v-if="showAgentForm" class="space-y-3 rounded-xl border border-accent-400/20 bg-accent-400/[.04] p-4" @submit.prevent="createAgent">
                <div class="grid gap-3 sm:grid-cols-2"><label class="text-[11px] text-slate-400">ID<input v-model="agentDraft.id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" placeholder="reviewer" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200" /></label><label class="text-[11px] text-slate-400">显示名称<input v-model="agentDraft.name" required class="mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200" /></label></div><label class="block text-[11px] text-slate-400">描述<input v-model="agentDraft.description" required maxlength="500" class="mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200" /></label><label class="block text-[11px] text-slate-400">系统提示<textarea v-model="agentDraft.systemPrompt" required rows="6" class="mt-1 w-full resize-y rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs leading-5 text-slate-200" /></label>
                <div class="flex flex-wrap gap-2"><button v-for="tool in availableTools" :key="tool" type="button" class="mono rounded-lg border px-2 py-1 text-[10px]" :class="agentDraft.tools.includes(tool) ? 'border-accent-400/35 bg-accent-400/10 text-accent-300' : 'border-white/10 text-slate-500'" @click="toggleAgentTool(tool)">{{ tool }}</button></div><div class="flex items-center gap-2"><AppSelect v-model="agentDraft.scope" :options="scopeOptions" aria-label="子代理保存位置" class="w-40" /><button type="button" class="ml-auto px-3 py-2 text-xs text-slate-400" @click="showAgentForm = false">取消</button><button type="submit" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" :disabled="!!store.featureAction">创建子代理</button></div>
              </form>
              <div class="grid gap-3 lg:grid-cols-2"><div v-for="profile in settings.subagents.profiles" :key="profile.id" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-start gap-2"><div class="min-w-0 flex-1"><div class="flex items-center gap-2 text-xs font-semibold text-slate-100">{{ profile.name }}<span class="rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-normal text-slate-500">{{ profile.scope }}</span></div><div class="mono mt-1 text-[10px] text-slate-600">{{ profile.id }}</div></div><button type="button" role="switch" :aria-checked="profile.enabled" class="relative h-5 w-9 shrink-0 rounded-full" :class="profile.enabled ? 'bg-accent-400' : 'bg-white/10'" @click="toggleProfile(profile)"><span class="absolute top-1 h-3 w-3 rounded-full bg-white transition" :class="profile.enabled ? 'left-5' : 'left-1'" /></button><button v-if="!profile.builtIn" type="button" class="rounded p-1 text-slate-600 hover:text-rose-300" @click="deleteAgent(profile)"><Trash2 :size="13" /></button></div><p class="mt-3 text-[11px] leading-5 text-slate-500">{{ profile.description }}</p><div class="mt-3 flex flex-wrap gap-1"><span v-for="tool in profile.tools" :key="`tool:${tool}`" class="mono rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-500">{{ tool }}</span><span v-for="skill in profile.skills" :key="`skill:${skill}`" class="mono rounded bg-violet-400/10 px-1.5 py-0.5 text-[9px] text-violet-300">skill:{{ skill }}</span><span v-for="extension in profile.extensions" :key="`extension:${extension}`" class="mono rounded bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan-300">ext:{{ extension }}</span></div><p v-if="profile.filePath" class="mono mt-2 break-all text-[9px] text-slate-700">{{ profile.filePath }}</p></div></div>
            </section>

            <section v-else class="flex min-h-[560px] flex-col space-y-4">
              <div class="flex items-start gap-3"><div class="flex-1"><h3 class="text-sm font-semibold text-slate-100">MCP 服务</h3><p class="mt-1 text-xs leading-5 text-slate-500">添加 stdio 或 HTTP Server，也可直接编辑完整 mcp.json。</p><p class="mono mt-2 break-all text-[10px] text-slate-600">{{ settings.mcp.path }}</p></div><button type="button" class="flex items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" @click="showMcpForm = !showMcpForm"><Plus :size="14" />新增 MCP</button></div>
              <form v-if="showMcpForm" class="space-y-3 rounded-xl border border-accent-400/20 bg-accent-400/[.04] p-4" @submit.prevent="addMcpServer"><div class="grid gap-3 sm:grid-cols-[1fr_140px]"><label class="text-[11px] text-slate-400">Server 名称<input v-model="mcpDraft.name" required class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200" /></label><label class="text-[11px] text-slate-400">传输方式<AppSelect v-model="mcpDraft.transport" :options="transportOptions" aria-label="MCP 传输方式" class="mt-1 w-full" /></label></div><label class="block text-[11px] text-slate-400">{{ mcpDraft.transport === 'stdio' ? '命令' : '服务 URL' }}<input v-model="mcpDraft.target" required :placeholder="mcpDraft.transport === 'stdio' ? 'npx' : 'https://example.com/mcp'" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200" /></label><label v-if="mcpDraft.transport === 'stdio'" class="block text-[11px] text-slate-400">参数（每行一个）<textarea v-model="mcpDraft.args" rows="4" placeholder="-y&#10;@modelcontextprotocol/server-filesystem" class="mono mt-1 w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs leading-5 text-slate-200" /></label><p v-if="mcpAddError" class="text-xs text-rose-400">{{ mcpAddError }}</p><div class="flex justify-end gap-2"><button type="button" class="px-3 py-2 text-xs text-slate-400" @click="showMcpForm = false">取消</button><button type="submit" class="rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950" :disabled="!!store.featureAction">添加并保存</button></div></form>
              <div class="flex items-center gap-2 text-[11px] text-slate-500"><span class="rounded bg-white/5 px-2 py-1">{{ settings.mcp.enabledServerCount }} / {{ settings.mcp.serverCount }} 已启用</span><span v-if="mcpDirty" class="text-amber-300">有未保存修改</span><span v-else class="flex items-center gap-1 text-emerald-400"><Check :size="12" />已同步</span></div>
              <textarea v-model="mcpContent" spellcheck="false" class="mono min-h-[300px] flex-1 resize-y rounded-xl border border-white/[.1] bg-ink-950 p-4 text-[12px] leading-6 text-slate-200 outline-none focus:border-accent-400/50" /><div class="flex items-center gap-1.5 text-[11px]" :class="mcpError ? 'text-rose-400' : 'text-emerald-400'"><CircleAlert v-if="mcpError" :size="13" /><Check v-else :size="13" />{{ mcpError || 'JSON 结构正确' }}</div><div class="flex gap-2"><button type="button" class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5" :disabled="!!mcpError" @click="formatMcp"><CodeXml :size="14" />格式化</button><button type="button" class="rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 disabled:opacity-40" :disabled="!mcpDirty" @click="mcpContent = mcpBaseline">还原</button><button type="button" class="ml-auto flex items-center gap-1.5 rounded-lg bg-accent-400 px-4 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!mcpDirty || !!mcpError || !!store.featureAction" @click="store.saveMcpConfig(mcpContent)"><Save :size="14" />保存 MCP 配置</button></div>
            </section>
          </template>
        </main>
      </div>
    </section>
  </div>
</template>
