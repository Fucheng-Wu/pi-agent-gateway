# Pi Agent Gateway client

A dependency-free TypeScript client for browsers and Node.js 22+. Build locally with `pnpm --filter @pi-agent-gateway/client build`; this package has not been published to npm.

```ts
import { GatewayClient } from '@pi-agent-gateway/client'

const gateway = new GatewayClient('ws://127.0.0.1:3000/ws', {
  onError: console.error,
  // Ask the user in your UI; no requests are approved by default.
  onPermission: async (permission) => showApprovalDialog(permission),
})
const off = gateway.onMessage((message) => {
  // Render snapshots and events using their epoch/sequence, as described in docs/protocol.md.
  console.log(message)
})
await gateway.connect()
const { session } = await gateway.request({ type: 'create_session' }, 'session_created')
await gateway.watchSession(session.summary.id)
await gateway.request({ type: 'prompt', sessionId: session.summary.id, text: 'Explain this project' })
// prompt's ack means accepted; agent_end signals completion.
// Later: off(); gateway.close()
```

`request(command, responseType = 'ack')` correlates the response and throws `GatewayError` on failure, disconnection or timeout. Use the dedicated response type when you need a payload. Options include `requestTimeoutMs`, `reconnect` (default true), `onPermission`, `onError` and an injectable `WebSocket` constructor. `onState` reports connection status. `unwatchSession(id)` stops automatic snapshot refresh for that session.

Every reconnect performs a new handshake and reloads watched sessions. Mutating requests are never automatically retried because their outcome can be unknown after a disconnect. Permission callbacks must return `allow_once`, `allow_session` or `deny`; without a callback, handle `permission_request` and send `permission_response` explicitly. `provider_login`, `auth_response` and `auth_cancel` use the same request API; listen for `auth_challenge` and `auth_status` events.

Run the read-only example after building the repository and starting the backend: `pnpm example:client`.
