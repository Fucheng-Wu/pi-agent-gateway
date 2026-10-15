<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { Check, ChevronDown, Search } from 'lucide-vue-next'

export interface SelectOption {
  value: string
  label: string
  description?: string
  group?: string
  badge?: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue?: string
  options: SelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  ariaLabel?: string
  disabled?: boolean
  searchable?: boolean
  placement?: 'auto' | 'top' | 'bottom'
  menuWidth?: number
  compact?: boolean
}>(), {
  modelValue: '',
  placeholder: '请选择',
  searchPlaceholder: '搜索选项…',
  ariaLabel: '选择选项',
  placement: 'auto',
  menuWidth: 210,
  compact: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLDivElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const open = ref(false)
const query = ref('')
const activeIndex = ref(-1)
const position = ref<Record<string, string>>({})

const selected = computed(() => props.options.find((option) => option.value === props.modelValue))
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.options
  return props.options.filter((option) => `${option.label} ${option.description ?? ''} ${option.group ?? ''}`.toLowerCase().includes(keyword))
})
const groups = computed(() => {
  const result: { name: string; options: SelectOption[] }[] = []
  const indexes = new Map<string, number>()
  for (const option of filtered.value) {
    const name = option.group ?? ''
    let index = indexes.get(name)
    if (index === undefined) {
      index = result.length
      indexes.set(name, index)
      result.push({ name, options: [] })
    }
    result[index].options.push(option)
  }
  return result
})
const enabledOptions = computed(() => filtered.value.filter((option) => !option.disabled))

function updatePosition() {
  const element = trigger.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const gap = 8
  const viewportPadding = 10
  const width = Math.min(Math.max(rect.width, props.menuWidth), window.innerWidth - viewportPadding * 2)
  const left = Math.min(Math.max(rect.left, viewportPadding), window.innerWidth - width - viewportPadding)
  const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding
  const spaceAbove = rect.top - gap - viewportPadding
  const useTop = props.placement === 'top' || (props.placement === 'auto' && spaceBelow < 260 && spaceAbove > spaceBelow)
  const available = Math.max(140, Math.min(300, useTop ? spaceAbove : spaceBelow))
  position.value = useTop
    ? { left: `${left}px`, width: `${width}px`, bottom: `${window.innerHeight - rect.top + gap}px`, maxHeight: `${available}px` }
    : { left: `${left}px`, width: `${width}px`, top: `${rect.bottom + gap}px`, maxHeight: `${available}px` }
}

function addListeners() {
  window.addEventListener('pointerdown', onOutside, true)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('resize', updatePosition)
  window.addEventListener('scroll', updatePosition, true)
}
function removeListeners() {
  window.removeEventListener('pointerdown', onOutside, true)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('resize', updatePosition)
  window.removeEventListener('scroll', updatePosition, true)
}
function show() {
  if (props.disabled || !props.options.length || open.value) return
  open.value = true
  query.value = ''
  activeIndex.value = Math.max(0, enabledOptions.value.findIndex((option) => option.value === props.modelValue))
  updatePosition()
  addListeners()
  nextTick(() => {
    updatePosition()
    if (props.searchable) searchInput.value?.focus()
    else panel.value?.focus()
  })
}
function hide(focus = false) {
  if (!open.value) return
  open.value = false
  removeListeners()
  if (focus) nextTick(() => trigger.value?.focus())
}
function choose(option: SelectOption) {
  if (option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
  hide(true)
}
function onOutside(event: PointerEvent) {
  const target = event.target as Node
  if (!trigger.value?.contains(target) && !panel.value?.contains(target)) hide()
}
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') hide(true)
}
function move(delta: number) {
  const options = enabledOptions.value
  if (!options.length) return
  activeIndex.value = (activeIndex.value + delta + options.length) % options.length
  const active = panel.value?.querySelector<HTMLElement>(`[data-option-index="${activeIndex.value}"]`)
  active?.scrollIntoView({ block: 'nearest' })
}
function onSearchInput() {
  activeIndex.value = enabledOptions.value.length ? 0 : -1
}
function onKeydown(event: KeyboardEvent) {
  if (!open.value && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
    event.preventDefault()
    show()
    return
  }
  if (!open.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const option = enabledOptions.value[activeIndex.value]
    if (option) choose(option)
  }
}

onBeforeUnmount(removeListeners)
</script>

<template>
  <div class="relative inline-flex min-w-0">
    <button
      ref="trigger"
      type="button"
      class="group flex min-w-0 w-full items-center gap-1.5 rounded-lg border border-white/[.09] bg-white/[.045] text-left text-slate-200 shadow-[inset_0_1px_0_rgb(var(--white)/.035)] transition duration-150 hover:border-white/[.16] hover:bg-white/[.075] focus-visible:border-accent-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/15 disabled:hover:bg-white/[.045]"
      :class="compact ? 'h-[30px] px-2 text-[11px]' : 'h-9 px-2.5 text-xs'"
      :disabled="disabled || !options.length"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open ? hide() : show()"
      @keydown="onKeydown"
    >
      <slot name="prefix" />
      <span class="min-w-0 flex-1 truncate" :class="selected ? 'text-slate-200' : 'text-slate-500'">{{ selected?.label ?? placeholder }}</span>
      <span v-if="selected?.badge" class="hidden rounded-md bg-accent-400/10 px-1.5 py-0.5 text-[9px] text-accent-300 sm:inline">{{ selected.badge }}</span>
      <ChevronDown :size="13" class="shrink-0 text-slate-500 transition-transform duration-200 group-hover:text-slate-300" :class="open ? 'rotate-180' : ''" />
    </button>

    <Teleport to="body">
      <Transition name="select-pop">
        <div
          v-if="open"
          ref="panel"
          tabindex="-1"
          role="listbox"
          :aria-label="ariaLabel"
          class="fixed z-[100] flex overflow-hidden rounded-xl border border-white/[.11] bg-ink-850/95 shadow-[0_18px_52px_rgba(0,0,0,.34),inset_0_1px_0_rgb(var(--white)/.05)] backdrop-blur-xl focus:outline-none"
          :style="position"
          @keydown="onKeydown"
        >
          <div class="flex min-h-0 w-full flex-col p-1">
            <div v-if="searchable" class="mb-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/[.08] bg-ink-950/65 px-2 focus-within:border-accent-400/40">
              <Search :size="12" class="shrink-0 text-slate-600" />
              <input ref="searchInput" v-model="query" :placeholder="searchPlaceholder" class="min-w-0 flex-1 bg-transparent text-[11px] text-slate-200 outline-none placeholder:text-slate-600" @input="onSearchInput" />
              <kbd class="mono text-[9px] text-slate-600">ESC</kbd>
            </div>
            <div class="min-h-0 overflow-y-auto overscroll-contain py-0.5">
              <template v-for="group in groups" :key="group.name">
                <div v-if="group.name" class="sticky top-0 z-10 bg-ink-850/95 px-2 pb-0.5 pt-1.5 text-[8px] font-semibold uppercase tracking-[.12em] text-slate-600 backdrop-blur-xl">{{ group.name }}</div>
                <button
                  v-for="option in group.options"
                  :key="option.value"
                  type="button"
                  role="option"
                  :aria-selected="option.value === modelValue"
                  :disabled="option.disabled"
                  :data-option-index="enabledOptions.indexOf(option)"
                  class="group/option flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition disabled:opacity-40"
                  :class="option.value === modelValue ? 'bg-accent-400/[.11]' : enabledOptions[activeIndex] === option ? 'bg-white/[.07]' : 'hover:bg-white/[.055]'"
                  @mouseenter="activeIndex = enabledOptions.indexOf(option)"
                  @click="choose(option)"
                >
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5"><span class="truncate text-[11px] font-medium" :class="option.value === modelValue ? 'text-accent-300' : 'text-slate-200'">{{ option.label }}</span><span v-if="option.badge" class="rounded bg-white/[.055] px-1 py-px text-[8px] text-slate-500">{{ option.badge }}</span></span>
                    <span v-if="option.description" class="block truncate text-[9px] leading-4 text-slate-600">{{ option.description }}</span>
                  </span>
                  <Check v-if="option.value === modelValue" :size="12" class="shrink-0 text-accent-300" />
                </button>
              </template>
              <div v-if="!filtered.length" class="px-3 py-8 text-center text-xs text-slate-600">没有匹配的选项</div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.select-pop-enter-active, .select-pop-leave-active { transition: opacity .14s ease, transform .14s ease; transform-origin: center; }
.select-pop-enter-from, .select-pop-leave-to { opacity: 0; transform: translateY(4px) scale(.985); }
</style>
