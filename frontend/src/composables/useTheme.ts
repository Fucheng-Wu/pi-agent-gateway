import { readonly, ref } from 'vue'

type Theme = 'dark' | 'light'

const STORAGE_KEY = 'pi-agent-gateway-theme'
const theme = ref<Theme>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

function setTheme(next: Theme) {
  theme.value = next
  document.documentElement.dataset.theme = next
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'light' ? '#ffffff' : '#292a2d')
  try { localStorage.setItem(STORAGE_KEY, next) } catch { /* Theme still applies when storage is unavailable. */ }
}

export function useTheme() {
  return {
    theme: readonly(theme),
    toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }
}
