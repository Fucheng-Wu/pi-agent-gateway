# Connect your own client

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Configuration](./configuration.md)

The backend can run without the Vue console. Its current integration surface is a versioned WebSocket protocol, not an OpenAI-compatible HTTP chat endpoint.

```sh
pnpm --filter ./backend dev
```

- Health: `GET http://127.0.0.1:3000/api/health`
- WebSocket: `ws://127.0.0.1:3000/ws`
- Source of truth: [`shared/types.ts`](../shared/types.ts)
- Typed client with reconnects and deadlines: [`client/`](../client/README.md)
- Read-only built-client example: [`examples/client.mjs`](../examples/client.mjs)
- Working wire-protocol smoke client: [`scripts/smoke.mjs`](../scripts/smoke.mjs)

## 1. Complete the handshake

The first command must be `init` with `protocolVersion: 1`. Other commands receive `INIT_REQUIRED` until the handshake succeeds.

```json
{"type":"init","protocolVersion":1,"requestId":"init-1"}
```

The response is another `init` message containing `protocolVersion`, `sessions`, `models`, `providers`, `settings`, the current `primaryAgents` catalog, and `workspace: { path, recent }`. Commands may include a non-empty `requestId` of up to 128 characters to correlate direct responses and errors. All command fields are validated at runtime before dispatch. Broadcast lifecycle events are routed by `sessionId` and are not necessarily request-correlated.

Every successfully dispatched command with a `requestId` also receives `{ "type": "ack", "command": "COMMAND_TYPE", "requestId": "..." }`, after any dedicated response. Ignore this extra message when waiting for a payload such as `session_state`. For `prompt`, ack means accepted, not completed; wait for `agent_end`. For login, ack means the login flow started; listen for `auth_status`. A rejected command receives a correlated `error` without ack. On timeout/disconnect, the command outcome can be unknown; resynchronize and do not automatically repeat mutating requests.

This small Node.js 22.19+ example lists catalog counts without creating a session or calling a model. Save it as `catalog.mjs` and run `node catalog.mjs`:

```js
const socket = new WebSocket('ws://127.0.0.1:3000/ws')
const timer = setTimeout(() => {
  console.error('Timed out waiting for the gateway')
  process.exitCode = 1
  socket.close()
}, 10_000)

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    type: 'init', protocolVersion: 1, requestId: 'catalog-1',
  }))
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.type === 'init') {
    console.log({
      sessions: message.sessions.length,
      models: message.models.length,
      providers: message.providers.length,
    })
    socket.close()
  } else if (message.type === 'error') {
    console.error(message.message)
    process.exitCode = 1
    socket.close()
  }
})

socket.addEventListener('error', () => {
  console.error('Cannot connect to the gateway')
  process.exitCode = 1
  clearTimeout(timer)
  socket.close()
})
socket.addEventListener('close', () => clearTimeout(timer))
```

## 2. Create or load a session

```json
{"type":"create_session","requestId":"create-1"}
```

Read the new session ID from `session_created.session.summary.id`. To resume a known session:

```json
{"type":"load_session","sessionId":"YOUR_SESSION_ID","requestId":"load-1"}
```

Its `session_state` response contains the conversation snapshot. New sessions use Build by default. For an idle session, select Plan and an authenticated model before prompting:

```json
{"type":"set_primary_agent","sessionId":"YOUR_SESSION_ID","agentId":"plan","requestId":"role-1"}
{"type":"set_model","sessionId":"YOUR_SESSION_ID","provider":"YOUR_PROVIDER_ID","modelId":"YOUR_MODEL_ID","requestId":"model-1"}
```

Wait for the role's `session_state` and model's `session_updated` responses before sending dependent commands. Providers and model IDs must come from your actual catalog. Configure credentials in the console first, or implement the authentication messages in the shared contract.

## 3. Send a task and consume events

```json
{"type":"prompt","sessionId":"YOUR_SESSION_ID","text":"Explain this project's architecture.","requestId":"prompt-1"}
```

To ask about images, add `images: [{ mimeType: "image/png", data: "RAW_BASE64_BYTES", name: "optional.png" }]`. `data` must contain base64 bytes without a data URL prefix. PNG, JPEG, GIF, and WebP are supported, with at most four images per prompt and 5 MiB per image. `text` may be empty when images are present. The console supports file selection, clipboard paste, and drag-and-drop, with previews before sending.

Choose a model whose catalog entry has `supportsImages: true`; image prompts sent to text-only models are rejected before execution. For custom model configurations, set `input: ["text", "image"]` only when the upstream model supports images. Pi may resize images to meet provider limits. User `message_end` events and `session_state.session.messages` include the processed `images` for display and history restoration; original filenames are optional and are not persisted by Pi. Images are stored in the session's Pi JSONL history. The WebSocket accepts messages up to 32 MiB to accommodate base64 overhead.

Execution events are top-level messages, without a nested `session_event.event` envelope. Examples below are individual messages, not an exhaustive or guaranteed event order:

```json
{"type":"agent_start","sessionId":"YOUR_SESSION_ID"}
{"type":"text_delta","sessionId":"YOUR_SESSION_ID","delta":"The entry point is..."}
{"type":"tool_start","sessionId":"YOUR_SESSION_ID","tool":{"id":"tool-1","name":"read","status":"running"}}
{"type":"tool_end","sessionId":"YOUR_SESSION_ID","toolCallId":"tool-1","output":"..."}
{"type":"agent_end","sessionId":"YOUR_SESSION_ID"}
```

Other events include `thinking_delta`, `tool_update`, `message_end`, `run_review`, and `session_updated`. Reasoning availability depends on the model. Multiple sessions can interleave events on the same connection. `agent_end` may include an `error`; clients should also handle `error` messages and connection loss. `run_review` contains the latest report with files/diffs, root-session Bash commands, and any omission note; it is also included as `session.review` when loading a snapshot.

### Snapshots and concurrent events

Session snapshots carry `epoch` (a new ID whenever the in-memory session is attached) and `sequence` (the last event included). Each execution event carries the same `epoch` and a strictly increasing `sequence` for that session. These are additive v1 fields; clients that ignore them can still connect.

While requesting a snapshot, buffer live events. Install the authoritative snapshot through sequence N and apply only buffered events from the same epoch with sequence greater than N. Ignore duplicates. If the epoch changes, a sequence gap is detected, or a bounded event buffer overflows, request a fresh snapshot. Never discard the entire snapshot merely because an event arrived during loading: it may contain text missed during disconnection. Reconnect with a fresh init and reload every cached/watched session, including background sessions. There is no event replay cursor.

### Switching projects

`get_workspace` returns `workspace`. `browse_directories` accepts an optional absolute `path` and returns `directories` with `{ path, parent, directories: [{ name, path }] }`. `set_workspace` requires an existing absolute directory. It is rejected while tasks, settings operations, loads, or logins are active. Successful switching broadcasts `workspace` followed by a new `init` catalog to every initialized connection, then acknowledges the request. Clear cached session state when the workspace changes. All connected clients share the current project; this command does not create a separate tenant.

To cancel a task:

```json
{"type":"abort","sessionId":"YOUR_SESSION_ID","requestId":"abort-1"}
```

## 4. Handle permissions explicitly

A custom client must handle `permission_request` before using tasks that require approval. Display the requested agent, tool, resource, and input to the user, then reply on the **same connection that started the task**:

```json
{"type":"permission_response","permissionId":"ID_FROM_REQUEST","decision":"allow_once"}
```

Decisions are `allow_once`, `allow_session`, or `deny`. Build allows routine tools by default; file/directory access outside the workspace and sensitive `.env` reads still require approval. Plan blocks ordinary project file modifications and commands.

Requests may include `action` (the normalized permission, such as `edit` or `external_directory`) and `patterns` (the suggested scope of `allow_session`). Display those patterns before approval; absent patterns mean only the exact `resource`. For example, `write` and `edit` can share `edit: *`, directory approval covers its subtree, and simple shell commands can propose `git status` / `git status *`. Complex shell commands require exact approval. File operations and external directory permissions are evaluated independently, and configured denies always remain enforced.

Session approval stays scoped to the current primary agent and subagent; matching pending requests are also resolved. Rejecting a request rejects other pending requests in the same session. Grants are held in memory until a role change, session disposal/eviction, or backend restart. Pending approvals are rejected on cancellation, disconnection, or the five-minute timeout. See the [primary-agent guide (Chinese)](../backend/primary-agents/README.md) for permission configuration and Plan's exception for explicitly requested plan files.

Permission messages are delivered to the initiating connection; they cannot be approved from a separate console connection. Do not silently approve every request in an integration.

## Connection and deployment notes

- The console uses `ping` / `pong` heartbeats. Reconnecting clients must perform a fresh `init` and load the required session snapshot; the server does not provide an event replay cursor.
- The current server broadcasts session catalogs and execution events to initialized clients. It is a trusted local service, not a tenant-isolated transport.
- CLI WebSocket clients may omit `Origin`. Browser clients must use an allowed local origin: `localhost`, `127.0.0.1`, or `[::1]`, on port 5173 or the configured backend port.
- A different browser origin or remote deployment requires an intentional routing/origin and authentication design. The dev proxy is configured in [`frontend/vite.config.ts`](../frontend/vite.config.ts).
- `delete_session` deletes the saved conversation file. The smoke script uses it only for its own temporary empty session.

For the full command and event shapes, import the shared types rather than copying this guide's illustrative payloads.
