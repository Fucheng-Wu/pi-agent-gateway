import { GatewayClient } from '../client/dist/client/src/index.js'

const client = new GatewayClient(process.env.WS_URL || 'ws://127.0.0.1:3000/ws', {
  reconnect: false,
  onError: (error) => console.error(error.message),
})

try {
  await client.connect()
  const { workspace } = await client.request({ type: 'get_workspace' }, 'workspace')
  const { sessions } = await client.request({ type: 'list_sessions' }, 'sessions')
  const { models } = await client.request({ type: 'list_models' }, 'models')
  console.log({ workspace: workspace.path, sessions: sessions.length, models: models.length })
} finally {
  client.close()
}
