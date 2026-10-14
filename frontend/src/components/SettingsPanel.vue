<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Bot, Braces, Check, CircleAlert, CodeXml, Download, KeyRound,
  PackageOpen, RefreshCw, Save, Server, Sparkles, Trash2, X
} from 'lucide-vue-next'
import { useSessionPool } from '@/stores/session-pool'
import type { SubagentProfileInfo } from '@/types'

const emit = defineEmits<{ close: []; models: []; providers: [] }>()
const store = useSessionPool()
const section = ref<'skills' | 'plugins' | 'agents' | 'mcp'>('skills')
const pluginSource = ref('')
const mcpContent = ref('')
const mcpBaseline = ref('')

const sections = [
  { id: 'skills' as const, label: '技能', icon: Sparkles },
  { id: 'plugins' as const, label: '插件', icon: PackageOpen },
  { id: 'agents' as const, label: '子代理', icon: Bot },
  { id: 'mcp' as const, label: 'MCP', icon: Server }
]
const settings = computed(() => store.featureSettings)
const mcpDirty = computed(() => mcpContent.value !== mcpBaseline.value)
const mcpError = computed(() => {
  if (!mcpContent.value.trim()) return '配置不能为空'
  try {
    const value = JSON.parse(mcpContent.value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '顶层必须是对象'
    if (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) return '必须包含 mcpServers 对象'
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : 'JSON 格式有误'
  }
})

watch(() => store.featureSettings?.mcp.content, (content) => {
  if (content === undefined) return
  if (!mcpContent.value || mcpContent.value === mcpBaseline.value) mcpContent.value = content
  mcpBaseline.value = content
}, { immediate: true })

onMounted(() => store.refreshFeatureSettings())

function toggleSkill(filePath: string, enabled: boolean) {
  store.setSkillEnabled(filePath, enabled)
}
function installPlugin() {
  const source = pluginSource.value.trim()
  if (!source) return
  if (store.runPluginAction('install', source)) pluginSource.value = ''
}
function removePlugin(source: string, scope: 'global' | 'project') {
  if (window.confirm(`确定卸载插件 ${source}？`)) store.runPluginAction('remove', source, scope)
}
function toggleProfile(profile: SubagentProfileInfo) {
  store.setSubagentProfileEnabled(profile.id, !profile.enabled)
}
function setMaxConcurrent(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isInteger(value)) store.setSubagentSettings({ maxConcurrent: value })
}
function formatMcp() {
  if (!mcpError.value) mcpContent.value = `${JSON.stringify(JSON.parse(mcpContent.value), null, 2)}\n`
}
function openNested(kind: 'models' | 'providers') {
  if (kind === 'models') emit('models')
  else emit('providers')
}
</script>

<template>
  <div class="dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6" @click.self="emit('close')">
    <section role="dialog" aria-modal="true" aria-labelledby="settings-title" class="surface flex h-[min(800px,94vh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl shadow-panel">
      <header class="flex items-start gap-3 border-b subtle-border px-5 py-4 sm:px-6">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-400/10 text-accent-300"><Braces :size="18" /></div>
        <div class="min-w-0 flex-1"><h2 id="settings-title" class="text-sm font-semibold text-slate-100">Pi 设置</h2><p class="mt-1 text-xs text-slate-500">管理 AgentSession 使用的技能、插件、子代理与 MCP 服务。</p></div>
        <button type="button" class="rounded-lg p-1.5 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="关闭" @click="emit('close')"><X :size="17" /></button>
      </header>

      <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="设置分类" class="flex shrink-0 gap-1 overflow-x-auto border-b subtle-border p-3 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
          <button v-for="item in sections" :key="item.id" type="button" class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-left text-xs transition" :class="section === item.id ? 'bg-accent-400/12 text-accent-200' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'" @click="section = item.id"><component :is="item.icon" :size="15" />{{ item.label }}<span v-if="item.id === 'skills' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.skills.length }}</span><span v-else-if="item.id === 'plugins' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.plugins.length }}</span><span v-else-if="item.id === 'mcp' && settings" class="mono ml-auto text-[10px] opacity-60">{{ settings.mcp.serverCount }}</span></button>
          <div class="mt-auto hidden space-y-1 border-t border-white/[.07] pt-3 sm:block">
            <button type="button" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-200" @click="openNested('models')"><Braces :size="14" />模型配置</button>
            <button type="button" class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-white/5 hover:text-slate-200" @click="openNested('providers')"><KeyRound :size="14" />Provider 认证</button>
          </div>
        </nav>

        <main class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div v-if="store.featureSettingsLoading && !settings" class="flex h-full items-center justify-center text-xs text-slate-500"><RefreshCw :size="14" class="mr-2 animate-spin" />正在读取 Pi 资源…</div>

          <template v-else-if="settings">
            <section v-if="section === 'skills'" class="space-y-4">
              <div><h3 class="text-sm font-semibold text-slate-100">技能</h3><p class="mt-1 text-xs leading-5 text-slate-500">与 AgentSession 使用同一套发现规则。关闭后技能仍可手动调用，但不会出现在模型的技能目录中。</p></div>
              <div v-if="!settings.skills.length" class="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-xs text-slate-500">当前没有发现技能。</div>
              <div v-for="skill in settings.skills" :key="skill.filePath" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4">
                <div class="flex items-start gap-3"><div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300"><Sparkles :size="15" /></div><div class="min-w-0 flex-1"><div class="flex flex-wrap items-center gap-2"><span class="text-xs font-semibold text-slate-100">{{ skill.name }}</span><span class="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-500">{{ skill.scope }}</span></div><p class="mt-1 text-[11px] leading-5 text-slate-500">{{ skill.description || '无描述' }}</p><p class="mono mt-2 break-all text-[10px] text-slate-600">{{ skill.filePath }}</p></div><button type="button" role="switch" :aria-checked="skill.modelInvocable" class="relative h-6 w-11 shrink-0 rounded-full transition" :class="skill.modelInvocable ? 'bg-accent-400' : 'bg-white/10'" :disabled="store.featureAction === `skill:${skill.filePath}`" @click="toggleSkill(skill.filePath, !skill.modelInvocable)"><span class="absolute top-1 h-4 w-4 rounded-full bg-white transition" :class="skill.modelInvocable ? 'left-6' : 'left-1'" /></button></div>
              </div>
            </section>

            <section v-else-if="section === 'plugins'" class="space-y-4">
              <div><h3 class="text-sm font-semibold text-slate-100">插件</h3><p class="mt-1 text-xs leading-5 text-slate-500">通过 Pi 包管理器安装扩展包。支持 npm 包、Git 地址和本地来源。</p></div>
              <form class="flex gap-2 rounded-xl border border-white/[.08] bg-ink-950/45 p-3" @submit.prevent="installPlugin"><input v-model="pluginSource" class="mono min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-accent-400/50" placeholder="npm:@scope/pi-plugin 或 Git 地址" aria-label="插件来源" /><button type="submit" class="flex items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!pluginSource.trim() || !!store.featureAction"><Download :size="14" />安装</button></form>
              <div v-if="!settings.plugins.length" class="rounded-xl border border-dashed border-white/10 px-4 py-10 text-center text-xs text-slate-500">尚未配置插件。</div>
              <div v-for="plugin in settings.plugins" :key="`${plugin.scope}:${plugin.source}`" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4">
                <div class="flex items-start gap-3">
                  <PackageOpen :size="17" class="mt-0.5 shrink-0 text-cyan-300" />
                  <div class="min-w-0 flex-1"><div class="mono break-all text-xs text-slate-200">{{ plugin.source }}</div><div class="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-500"><span>{{ plugin.scope }}</span><span :class="plugin.installed ? 'text-emerald-400' : 'text-amber-300'">{{ plugin.installed ? '已安装' : '缺失' }}</span><span v-if="plugin.filtered">已过滤资源</span></div><p v-if="plugin.installedPath" class="mono mt-2 break-all text-[10px] text-slate-600">{{ plugin.installedPath }}</p></div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button type="button" role="switch" :aria-checked="plugin.enabled" class="relative mr-1 h-5 w-9 rounded-full transition" :class="plugin.enabled ? 'bg-accent-400' : 'bg-white/10'" :disabled="!!store.featureAction" @click="store.setPluginEnabled(plugin.source, plugin.scope, !plugin.enabled)"><span class="absolute top-1 h-3 w-3 rounded-full bg-white transition" :class="plugin.enabled ? 'left-5' : 'left-1'" /></button>
                    <button type="button" class="rounded-lg p-2 text-slate-500 hover:bg-white/5 hover:text-slate-200" aria-label="更新插件" :disabled="!!store.featureAction" @click="store.runPluginAction('update', plugin.source, plugin.scope)"><RefreshCw :size="14" /></button>
                    <button type="button" class="rounded-lg p-2 text-slate-500 hover:bg-rose-400/10 hover:text-rose-300" aria-label="卸载插件" :disabled="!!store.featureAction" @click="removePlugin(plugin.source, plugin.scope)"><Trash2 :size="14" /></button>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="section === 'agents'" class="space-y-4">
              <div><h3 class="text-sm font-semibold text-slate-100">子代理</h3><p class="mt-1 text-xs leading-5 text-slate-500">启用后，主代理获得模型专用的 <span class="mono text-slate-300">Agent</span> 工具，可把独立任务委派给隔离会话。</p></div>
              <div class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-center gap-3"><Bot :size="17" class="text-accent-300" /><div class="flex-1"><div class="text-xs font-medium text-slate-100">内置子代理</div><div class="mt-1 text-[11px] text-slate-500">当前运行 {{ settings.subagents.active }} / {{ settings.subagents.maxConcurrent }}</div></div><button type="button" role="switch" :aria-checked="settings.subagents.enabled" class="relative h-6 w-11 rounded-full transition" :class="settings.subagents.enabled ? 'bg-accent-400' : 'bg-white/10'" :disabled="!!store.featureAction" @click="store.setSubagentSettings({ enabled: !settings.subagents.enabled })"><span class="absolute top-1 h-4 w-4 rounded-full bg-white transition" :class="settings.subagents.enabled ? 'left-6' : 'left-1'" /></button></div><label class="mt-4 flex items-center gap-3 border-t border-white/[.07] pt-4 text-xs text-slate-400"><span>最大并发数</span><input type="number" min="1" max="8" :value="settings.subagents.maxConcurrent" class="mono ml-auto w-20 rounded-lg border border-white/10 bg-ink-950 px-2 py-1.5 text-right text-slate-200 outline-none focus:border-accent-400/50" :disabled="!!store.featureAction" @change="setMaxConcurrent" /></label></div>
              <div class="grid gap-3 lg:grid-cols-3"><div v-for="profile in settings.subagents.profiles" :key="profile.id" class="rounded-xl border border-white/[.08] bg-ink-950/45 p-4"><div class="flex items-start gap-2"><div class="min-w-0 flex-1"><div class="text-xs font-semibold text-slate-100">{{ profile.name }}</div><div class="mono mt-1 text-[10px] text-slate-600">{{ profile.id }}</div></div><button type="button" role="switch" :aria-checked="profile.enabled" class="relative h-5 w-9 shrink-0 rounded-full transition" :class="profile.enabled ? 'bg-accent-400' : 'bg-white/10'" :disabled="!!store.featureAction" @click="toggleProfile(profile)"><span class="absolute top-1 h-3 w-3 rounded-full bg-white transition" :class="profile.enabled ? 'left-5' : 'left-1'" /></button></div><p class="mt-3 text-[11px] leading-5 text-slate-500">{{ profile.description }}</p><div class="mt-3 flex flex-wrap gap-1"><span v-for="tool in profile.tools" :key="tool" class="mono rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-500">{{ tool }}</span></div></div></div>
              <p class="text-[11px] leading-5 text-slate-600">设置变更会重载空闲会话；正在回复的会话将在下次重载或重新打开后生效。</p>
            </section>

            <section v-else class="flex min-h-[520px] flex-col space-y-4">
              <div><h3 class="text-sm font-semibold text-slate-100">MCP 服务</h3><p class="mt-1 text-xs leading-5 text-slate-500">编辑全局 mcp.json。保存后 Pi 的 MCP、工具搜索和 Code mode 扩展会在空闲会话中重载。</p><p class="mono mt-2 break-all text-[10px] text-slate-600">{{ settings.mcp.path }}</p></div>
              <div class="flex items-center gap-2 text-[11px] text-slate-500"><span class="rounded bg-white/5 px-2 py-1">{{ settings.mcp.enabledServerCount }} / {{ settings.mcp.serverCount }} 已启用</span><span v-if="mcpDirty" class="text-amber-300">有未保存修改</span><span v-else class="flex items-center gap-1 text-emerald-400"><Check :size="12" />已同步</span></div>
              <textarea v-model="mcpContent" spellcheck="false" aria-label="mcp.json 内容" class="mono min-h-[340px] flex-1 resize-none rounded-xl border border-white/[.1] bg-ink-950 p-4 text-[12px] leading-6 text-slate-200 outline-none focus:border-accent-400/50" />
              <div class="flex min-h-5 items-center gap-1.5 text-[11px]" :class="mcpError ? 'text-rose-400' : 'text-emerald-400'"><CircleAlert v-if="mcpError" :size="13" /><Check v-else :size="13" />{{ mcpError || 'JSON 结构正确' }}</div>
              <div class="flex flex-wrap gap-2"><button type="button" class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white" :disabled="!!mcpError" @click="formatMcp"><CodeXml :size="14" />格式化</button><button type="button" class="rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-40" :disabled="!mcpDirty" @click="mcpContent = mcpBaseline">还原</button><button type="button" class="ml-auto flex items-center gap-1.5 rounded-lg bg-accent-400 px-4 py-2 text-xs font-semibold text-ink-950 disabled:opacity-40" :disabled="!mcpDirty || !!mcpError || !!store.featureAction" @click="store.saveMcpConfig(mcpContent)"><Save :size="14" />保存 MCP 配置</button></div>
            </section>
          </template>
        </main>
      </div>
    </section>
  </div>
</template>
