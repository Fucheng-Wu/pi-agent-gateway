import { randomUUID } from 'node:crypto'

const url = process.env.WS_URL || 'ws://127.0.0.1:3000/ws'
const socket = new WebSocket(url)

function waitFor(predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for WebSocket response')), timeoutMs)
    function finish(error, value) {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (error) reject(error)
      else resolve(value)
    }
    function onMessage(event) {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (predicate(message)) finish(null, message)
      else if (message.type === 'error' && message.requestId === predicate.requestId) {
        finish(new Error(message.message))
      }
    }
    socket.addEventListener('message', onMessage)
  })
}

async function request(command, responseType) {
  const requestId = randomUUID()
  const predicate = (message) => message.type === responseType && message.requestId === requestId
  predicate.requestId = requestId
  const response = waitFor(predicate)
  socket.send(JSON.stringify({ ...command, requestId }))
  return response
}

try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  await request({ type: 'ping' }, 'pong')
  await request({ type: 'list_sessions' }, 'sessions')
  await request({ type: 'list_models' }, 'models')
  await request({ type: 'list_providers' }, 'providers')
  await request({ type: 'get_models_config' }, 'models_config')
  const featureSettings = await request({ type: 'get_feature_settings' }, 'feature_settings')
  if (!Array.isArray(featureSettings.settings?.skills)) throw new Error('Skills settings missing')
  if (!Array.isArray(featureSettings.settings?.plugins)) throw new Error('Plugins settings missing')
  if (!Array.isArray(featureSettings.settings?.subagents?.profiles)) throw new Error('Subagent settings missing')
  if (typeof featureSettings.settings?.mcp?.content !== 'string') throw new Error('MCP settings missing')

  const created = await request({ type: 'create_session' }, 'session_created')
  const sessionId = created.session.summary.id
  if (!sessionId) throw new Error('Session ID missing')
  const loaded = await request({ type: 'load_session', sessionId }, 'session_state')
  if (loaded.session.summary.id !== sessionId) throw new Error('Loaded wrong session')

  const deleted = waitFor((message) => message.type === 'session_deleted' && message.sessionId === sessionId)
  socket.send(JSON.stringify({ type: 'delete_session', sessionId }))
  await deleted
  const listed = await request({ type: 'list_sessions' }, 'sessions')
  if (listed.sessions.some((session) => session.id === sessionId)) throw new Error('Deleted session is still listed')

  const challenge = waitFor((message) => message.type === 'auth_challenge' && message.providerId === 'anthropic')
  socket.send(JSON.stringify({ type: 'provider_login', providerId: 'anthropic', methodId: 'api_key' }))
  const prompt = await challenge
  const cancelled = waitFor((message) => message.type === 'auth_status' && message.providerId === 'anthropic' && message.status === 'cancelled')
  socket.send(JSON.stringify({ type: 'auth_cancel', challengeId: prompt.challengeId }))
  await cancelled

  console.log(`WebSocket smoke passed: ${url}`)
} finally {
  socket.close()
}
