# Configuration and troubleshooting

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [WebSocket protocol](./protocol.md)

## Prerequisites

Use Node.js **22.19 or newer** and the pnpm version pinned in the root [`package.json`](../package.json), currently **10.22.0**. Check your tools with:

```sh
node --version
pnpm --version
```

If pnpm is missing, install the pinned version with `npm install --global pnpm@10.22.0`.

## Environment variables

Set variables in the shell before starting the servers. This project does not automatically load a root `.env` file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKSPACE_DIR` | Last selected project, then Gateway repository root | Startup working directory for Pi's tools; use an absolute path |
| `PI_AGENT_DIR` | `~/.pi/agent` | Pi configuration and session storage; use an absolute path when overriding it |
| `HOST` | `127.0.0.1` | Backend bind address |
| `PORT` | `3000` | Backend port; the development frontend proxy reads the same value |

Choose a directory in the console's sidebar project picker to switch without restarting. Recent projects and the last selection are saved in `PI_AGENT_DIR/gateway.json`. Switching updates all connected consoles and is rejected while any task, settings request, session load, or provider login is active. Saved conversations stay grouped by project. An explicit environment variable overrides the remembered directory on each startup:

```powershell
# PowerShell
$env:PI_WORKSPACE_DIR = 'C:\projects\my-app'
pnpm dev
```

```sh
# macOS / Linux shell
PI_WORKSPACE_DIR=/absolute/path/to/my-app pnpm dev
```

To use a separate Pi configuration directory, set `PI_AGENT_DIR` before startup. This is useful for keeping gateway sessions and model settings separate from another Pi installation.

## Model setup

Open **设置 → 模型 → 添加 Provider** (Settings → Models → Add Provider).

- **Built-in provider:** select a provider and complete its supported API key or OAuth flow. Authenticated models become available in the conversation's model selector.
- **Compatible endpoint:** create a custom provider, choose its API type, and enter its Base URL and credentials. Discover models if supported, or add a model ID manually. Save the model configuration before selecting it in a conversation.
- **Connection test:** select a custom model and choose **测试连接**. The test makes a model request, so it may incur provider charges.

Custom provider API choices currently include `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. Availability and compatibility depend on the upstream endpoint and Pi runtime.

The custom provider API Key field also accepts an environment variable name, so a secret does not need to be written directly into `models.json`. Set that environment variable in the backend's shell before startup. The field also supports Pi's `!shell-command` syntax; only use commands you trust.

## Where data lives

Paths below are relative to `PI_AGENT_DIR` unless noted otherwise:

| Resource | Location |
| --- | --- |
| Custom model configuration | `models.json` |
| Provider authentication | `auth.json` |
| Global settings | `settings.json` |
| Saved conversations | `sessions/`, grouped by workspace |
| Last workspace and recent projects | `gateway.json` |
| Latest run report per session | `gateway-reviews/<sessionId>.json` |
| MCP configuration | `mcp.json` |
| Global primary agents | `primary-agents/` |
| Global subagents | `agents/` |
| Gateway project Skills | [`backend/skills/`](../backend/skills/README.md) |
| Gateway project primary agents | [`backend/primary-agents/`](../backend/primary-agents/README.md) |
| Gateway project subagents and settings | [`backend/subagents/`](../backend/subagents/README.md), including `settings.json` |

Skills and plugins retain Pi's global and project discovery rules. The gateway also loads `backend/skills/`. Project resources created in Settings use these gateway resource directories; `PI_WORKSPACE_DIR` selects the directory the agent operates on, not the gateway's source directory.

After settings change, idle sessions reload automatically. Busy sessions use updated resources after a later reload or reopen.

Keep credentials, personal conversations, and private workspace contents out of commits, screenshots, and issue reports.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `pnpm` is not found | Install pnpm 10.22.0 and reopen the terminal if needed |
| Node or dependency errors | Verify Node 22.19+; run `pnpm install` from the repository root |
| Port 5173 is already in use | Stop the conflicting frontend or use the existing instance; Vite uses strict port selection |
| Backend port 3000 is already in use | Set `PORT` to a free port before `pnpm dev`; both processes need the same value |
| Console keeps reconnecting | Check backend logs and `http://127.0.0.1:3000/api/health` (use your configured port) |
| WebSocket returns 403 | Use a local frontend origin on port 5173 or the backend's port; the backend restricts browser origins |
| No usable model / authentication error | Complete provider authentication or save a compatible endpoint and model, then select it in the conversation |
| Model discovery fails | The provider may not offer a compatible model-list endpoint; add its documented model ID manually |
| Pi reads the wrong project | Check the sidebar path and select the intended project; `PI_WORKSPACE_DIR` overrides the remembered project at startup |
| Conversations appear missing | Check both `PI_AGENT_DIR` and `PI_WORKSPACE_DIR`; session listings are workspace-specific |
| Empty conversation disappears after restart | Pi persists a conversation only after its first assistant message |
| Resource changes are not visible | Wait until the session is idle, reload resources, or reopen the session |

## Build and deployment scope

Run `pnpm build`, then `pnpm start`. The backend serves `frontend/dist/`, `/api/health`, and `/ws` at the same address (default `http://127.0.0.1:3000`). The build also produces the standalone TypeScript client under `client/dist/`. The backend runs TypeScript from source through `tsx`, so retain source files and installed runtime dependencies. `pnpm --filter ./frontend preview` is a static preview without an API proxy; use `pnpm start` for the complete application.

The backend has no user authentication or tenant isolation. A production integration needs its own access control, workspace restrictions, and an explicit routing/origin strategy. Merely binding `HOST=0.0.0.0` does not provide those protections or make arbitrary browser origins acceptable.

Primary-agent permission policies are application-level checks. Extensions execute in the backend process and are not sandboxed. See [primary agents and permissions (Chinese)](../backend/primary-agents/README.md) before adding custom tools.

## Run review and long conversations

Each task records the workspace's Git-listed tracked and untracked non-ignored files before and after execution. Diffs use pre-task contents, not HEAD, so existing uncommitted edits are preserved as the baseline. The report includes concurrent edits by users or other sessions and is not proof of which process changed a file. Git-ignored files, external/symbolic-link targets, binary diffs, files above 256 KiB, snapshots above 16 MiB/5,000 files, and diffs beyond 200 files/240,000 characters are omitted or labeled. Non-Git directories retain command reports but cannot show file diffs. Commands shown are root-session Bash tool calls; completion means the tool returned successfully, not that every application-level assertion passed.

The latest report is stored in `gateway-reviews/` and restored with its session. Deleting a conversation deletes its report. These reports can contain project code and command output, so keep this directory private like session history. The UI renders 60 recent messages initially and loads older messages on demand; complete history remains available in the session snapshot. Tool output initially shows its last 12,000 characters, with explicit expansion.
