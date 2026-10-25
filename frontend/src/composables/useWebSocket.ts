import { ref } from 'vue'
import type { ClientMessage, ConnectionState, ServerMessage } from '@/types'

const status = ref<ConnectionState>('disconnected')
const messageListeners = new Set<(message: ServerMessage) => void>()
const openListeners = new Set<() => void>()
let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
let stopped = true
let initTimer: ReturnType<typeof setTimeout> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let frame: number | null = null
const queued: ServerMessage[] = []

function flushMessages() {
  if (flushTimer) clearTimeout(flushTimer)
  if (frame !== null) cancelAnimationFrame(frame)
  flushTimer = null
  frame = null
  for (const message of queued.splice(0)) for (const listener of messageListeners) listener(message)
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (pongTimer) clearTimeout(pongTimer)
  if (initTimer) clearTimeout(initTimer)
  if (flushTimer) clearTimeout(flushTimer)
  if (frame !== null) cancelAnimationFrame(frame)
  queued.length = 0
  initTimer = flushTimer = null
  frame = null
  reconnectTimer = heartbeatTimer = pongTimer = null
}

function send(message: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try { socket.send(JSON.stringify(message)); return true }
  catch { return false }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (!send({ type: 'ping' })) return
    if (pongTimer) clearTimeout(pongTimer)
    pongTimer = setTimeout(() => socket?.close(), 10_000)
  }, 25_000)
}

function open() {
  if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  status.value = attempts === 0 ? 'connecting' : 'reconnecting'
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
  socket = ws

  ws.onopen = () => {
    if (socket !== ws) return
    status.value = 'connecting'
    initTimer = setTimeout(() => ws.close(), 10_000)
    for (const listener of openListeners) listener()
  }

  ws.onmessage = (event) => {
    if (socket !== ws) return
    let message: ServerMessage
    try { message = JSON.parse(String(event.data)) as ServerMessage } catch { return }
    if (!message || typeof message.type !== 'string') return
    if (message.type === 'init') {
      if (initTimer) clearTimeout(initTimer)
      initTimer = null
      attempts = 0
      status.value = 'connected'
      startHeartbeat()
    }
    if (message.type === 'pong') {
      if (pongTimer) clearTimeout(pongTimer)
      pongTimer = null
    }
    if (message.type === 'text_delta' || message.type === 'thinking_delta' || message.type === 'tool_update') {
      queued.push(message)
      if (queued.length >= 500) flushMessages()
      else if (!flushTimer) {
        frame = requestAnimationFrame(flushMessages)
        flushTimer = setTimeout(flushMessages, 50) // Hidden tabs still consume events.
      }
    } else {
      flushMessages()
      for (const listener of messageListeners) listener(message)
    }
  }

  ws.onclose = () => {
    if (socket !== ws) return
    flushMessages()
    if (initTimer) clearTimeout(initTimer)
    initTimer = null
    socket = null
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (pongTimer) clearTimeout(pongTimer)
    heartbeatTimer = pongTimer = null
    if (stopped) { status.value = 'disconnected'; return }
    status.value = 'reconnecting'
    const delay = Math.min(15_000, 800 * 2 ** Math.min(attempts++, 5)) + Math.random() * 400
    reconnectTimer = setTimeout(open, delay)
  }

  ws.onerror = () => ws.close()
}

function connect() {
  stopped = false
  open()
}

function disconnect() {
  stopped = true
  clearTimers()
  socket?.close()
  socket = null
  status.value = 'disconnected'
}

function onMessage(listener: (message: ServerMessage) => void) {
  messageListeners.add(listener)
  return () => messageListeners.delete(listener)
}

function onOpen(listener: () => void) {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

export function useWebSocket() {
  return { status, connect, disconnect, send, onMessage, onOpen }
}
