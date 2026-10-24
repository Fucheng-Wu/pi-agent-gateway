<div align="center">

# Pi Agent Gateway

**A web workspace for Pi Coding Agent. An agent backend for your own app.**

Manage conversations, models, Skills, MCP, and subagents in the browser — or connect your own client to the same backend.

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-417E38?logo=nodedotjs&logoColor=white)](#quick-start)
[![pnpm](https://img.shields.io/badge/pnpm-10.22.0-F69220?logo=pnpm&logoColor=white)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-A78BFA)](./LICENSE)

[Quick start](#quick-start) · [Features](#features) · [Use your own frontend](#use-your-own-frontend) · [Contributing](./CONTRIBUTING.md)

</div>

![Pi Agent Gateway web console, connected to a local backend](./docs/images/console.png)

*Actual console with a fresh configuration. The current UI is in Chinese; no model conversation is shown.*

## Why Pi Agent Gateway?

Pi Agent Gateway gives Pi a browser interface and exposes its session workflow through a typed WebSocket protocol. Use the included Vue console for local coding tasks, or use the Hono backend as the starting point for an agent feature in your own application.

- **Work visually:** follow streaming replies, reasoning output, and tool execution in one conversation.
- **Plan, then build:** switch between planning and implementation while keeping the same conversation history.
- **Bring your own interface:** the backend and frontend are separate workspaces, with their message contract in [`shared/types.ts`](./shared/types.ts).

Built on `@earendil-works/pi-coding-agent`. This is an independent project, not an official Pi product.

## Features

| Capability | What you can do |
| --- | --- |
| Conversations | Create and switch sessions; restore saved Pi JSONL conversations |
| Live execution | Read reasoning as it streams; it collapses when answer text starts and can be reopened |
| Plan / Build | Change the primary agent in an idle session without losing history or model selection |
| Permissions | Routine Build operations run automatically; approve sensitive access once or by a visible session scope |
| Models | Authenticate built-in providers or configure compatible endpoints; discover models and test connections |
| Extensions | Manage Skills, plugins, subagent profiles, and MCP configuration from Settings |
| Custom clients | Consume versioned, session-scoped events over `/ws` |
| Appearance | Switch between light and dark themes |

<details>
<summary>See the model and extension settings</summary>

![Settings for models, Skills, plugins, subagents, and MCP](./docs/images/settings.png)

*Actual settings screen with a fresh configuration. Provider availability depends on the Pi runtime and your configuration.*

</details>

## Quick start

You need **Git**, **Node.js 22.19+**, **pnpm 10.22.0** (the pinned version), and access to a model provider. Model requests use your own provider credentials and may incur provider charges.

### 1. Clone and start

```sh
git clone https://github.com/Fucheng-Wu/pi-agent-gateway.git
cd pi-agent-gateway
pnpm install
pnpm dev
```

Open **<http://127.0.0.1:5173>**. The frontend proxies `/ws` and `/api` to the backend on `127.0.0.1:3000`.

### 2. Connect a model

If you already use Pi, the backend reads the default `~/.pi/agent/` configuration.

Otherwise, open **Settings (`设置`) → Models (`模型`) → Add Provider (`添加 Provider`)**:

1. Select a built-in provider and complete its authentication, or add a custom compatible endpoint.
2. For a custom endpoint, set the API type, Base URL, API Key, and model ID. Use model discovery if the provider supports it.
3. Save custom model configuration, create a conversation, and choose your model in the composer.

### 3. Point Pi at your project

Stop the development servers and set an **absolute** workspace path before restarting:

**PowerShell**

```powershell
$env:PI_WORKSPACE_DIR = 'C:\path\to\your\project'
pnpm dev
```

**macOS / Linux shell**

```sh
PI_WORKSPACE_DIR=/absolute/path/to/your/project pnpm dev
```

Without this setting, the root `pnpm dev` command uses `backend/` as Pi's working directory.

### 4. Try a first task

Create a conversation, choose **Plan**, and ask:

> Read this project's entry points and explain its architecture. Propose a small improvement and an implementation plan.

When the session is idle, switch to **Build** to implement the agreed change. Build asks for confirmation before file changes, commands, and other operations that its policy does not allow automatically. `Tab` / `Shift+Tab` in the composer cycles primary agents.

See [configuration and troubleshooting](./docs/configuration.md) for environment variables, storage, and connection problems.

## Use your own frontend

The Vue console is one client of the backend. You can run the backend alone:

```sh
pnpm --filter ./backend dev
```

Your client connects to `ws://127.0.0.1:3000/ws`, completes the v1 handshake, and receives the session, model, provider, and settings catalogs. Every execution event includes a `sessionId` so clients can route concurrent output.

```mermaid
flowchart LR
    UI[Vue web console] <-->|WebSocket v1| Gateway[Hono agent backend]
    App[Your own client] <-->|WebSocket v1| Gateway
    Gateway <--> Pi[Pi Coding Agent SDK]
    Pi <--> Models[Model providers]
    Pi <--> Tools[Workspace tools and extensions]
```

Start with the [protocol guide](./docs/protocol.md), the [shared TypeScript contract](./shared/types.ts), and the existing [WebSocket smoke client](./scripts/smoke.mjs). The backend currently runs from source; it is not published as a standalone SDK package.

## Current scope

- Designed for trusted local use. The backend binds to `127.0.0.1` by default and does not provide user authentication or tenant isolation. Add access control and workspace restrictions before enabling remote access.
- Permission rules are application-level checks, not an operating-system sandbox. Only install extensions you trust.
- Up to **5 AgentSession instances** remain active in memory; evicted conversations can be restored from their session files. This is not a user limit or a promise of five simultaneous tasks.
- Pi writes session files after the first assistant message. Empty conversations do not survive a backend restart.
- Subagent runs are currently one-shot and cannot be resumed. Resource changes reload idle sessions; busy sessions pick them up after a later reload or reopen.
- The web UI is currently in Chinese. Both English and Chinese README files are available.

## Development

```sh
pnpm typecheck
pnpm build
pnpm --filter ./backend test
pnpm test:frontend
```

`pnpm build` checks backend types and produces the frontend's static build. It does not create a combined production server. Backend tests include a local mock model provider and do not require a paid model key.

With a backend running, `pnpm smoke` checks the WebSocket handshake, catalogs, session lifecycle, and an authentication challenge. It creates and deletes a temporary empty session and cancels the challenge without saving credentials.

## Documentation and community

- [中文介绍与快速开始](./README.zh-CN.md)
- [Configuration and troubleshooting](./docs/configuration.md)
- [WebSocket integration](./docs/protocol.md)
- [Primary agents and permissions · 中文](./backend/primary-agents/README.md)
- [Custom subagents · 中文](./backend/subagents/README.md)
- [Project Skills · 中文](./backend/skills/README.md)
- [Contributing](./CONTRIBUTING.md) · [Report a bug](https://github.com/Fucheng-Wu/pi-agent-gateway/issues/new?template=bug_report.yml) · [Request a feature](https://github.com/Fucheng-Wu/pi-agent-gateway/issues/new?template=feature_request.yml)

Tried it in your own workflow? Share what you built or where you got stuck in an issue. If the project is useful to you, a star helps others discover it.

## License

[MIT](./LICENSE) © 2026 Fucheng Wu. Third-party dependencies retain their respective licenses.
