# Contributing / 参与贡献

Thanks for trying Pi Agent Gateway. Issues and pull requests in **English or Chinese** are welcome.

欢迎用中文或英文反馈问题、分享接入案例、改进文档或提交代码。

## Where to start

- Report installation problems with the [bug report form](https://github.com/Fucheng-Wu/pi-agent-gateway/issues/new?template=bug_report.yml).
- Describe a concrete workflow in the [feature request form](https://github.com/Fucheng-Wu/pi-agent-gateway/issues/new?template=feature_request.yml).
- Improve first-run instructions, translate documentation, or share an example of your own client integration.
- For a large behavior or protocol change, open an issue to discuss the use case before investing in implementation.

首次参与可以从安装流程、文档翻译和客户端集成示例入手。较大的行为或协议改动，建议先在 Issue 说明使用场景。

## Local development

Use Node.js 22.19+ and pnpm 10.22.0, then run:

```sh
pnpm install
pnpm dev
```

Set an absolute `PI_WORKSPACE_DIR` if the agent should operate on another project. See [configuration](./docs/configuration.md) for shell examples. You need your own provider credentials for live model conversations; backend tests use a local mock provider.

| Directory | Responsibility |
| --- | --- |
| `backend/src/` | Hono server, session lifecycle, models, permissions, and extensions |
| `backend/test/` | Backend tests, including WebSocket integration |
| `frontend/src/` | Vue console and client state |
| `shared/types.ts` | Versioned WebSocket command and event contract |
| `shared/validation.ts` | Exhaustive runtime validation of client commands |
| `client/` | Dependency-free typed WebSocket client and build |
| `examples/client.mjs` | Read-only example using the built client |
| `backend/primary-agents/` | Built-in role documentation and custom primary-agent resources |
| `backend/subagents/` | Subagent profiles and examples |
| `backend/skills/` | Gateway project Skills |
| `scripts/smoke.mjs` | Live-backend WebSocket smoke check |

## Before opening a pull request

Explain the problem, the resulting behavior, and how you verified it. Keep changes focused and include a screenshot for visible UI changes. Update both README versions when changing the onboarding flow or user-facing capability claims.

For code changes, run:

```sh
pnpm typecheck
pnpm build
pnpm --filter ./backend test
pnpm test:frontend
```

With a backend running, `pnpm smoke` also checks the handshake and session lifecycle. It creates and deletes its own empty test session and cancels an authentication challenge. Prefer a separate `PI_AGENT_DIR` and workspace when experimenting with tools or credentials.

Protocol changes must update `shared/types.ts` and both client and server handling. Add a targeted test when a behavior change or bug fix needs one. Documentation-only changes need link and rendering checks rather than model calls.

不要在 Issue、日志、截图或提交中附带 API Key、`auth.json`、真实会话记录或私人项目内容。复现问题时请使用脱敏后的最小示例。

## License

Contributions to this repository are provided under its [MIT license](./LICENSE). Third-party code and assets must retain any required notices.
