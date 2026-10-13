import { onMounted, onUnmounted, watch } from 'vue'
import { useSessionPool } from '@/stores/session-pool'
import { useWebSocket } from './useWebSocket'

/** Connects the transport once at the app root and keeps the Pinia store in sync. */
export function useEventBridge() {
  const store = useSessionPool()
  const ws = useWebSocket()
  let offMessage: (() => void) | undefined
  let offOpen: (() => void) | undefined
  const offStatus = watch(ws.status, (next, previous) => {
    if (previous === 'connected' && next !== 'connected') store.onTransportDisconnected()
  })

  onMounted(() => {
    store.setSender(ws.send)
    offMessage = ws.onMessage((message) => store.handleServerMessage(message))
    offOpen = ws.onOpen(() => {
      store.refreshSessions()
      store.refreshModels()
      store.refreshProviders()
      if (store.activeSessionId) store.loadSession(store.activeSessionId)
    })
    ws.connect()
  })

  onUnmounted(() => {
    offMessage?.()
    offOpen?.()
    offStatus()
    ws.disconnect()
  })

  return ws
}
