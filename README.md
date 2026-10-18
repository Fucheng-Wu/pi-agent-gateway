# Pi Agent Gateway

可嵌入现有系统的 Pi Agent 后端，并附带前后端分离的 Web 控制台。

后端基于 Hono、WebSocket 和 `@earendil-works/pi-coding-agent`，能够作为独立 Agent 服务运行或提取后嵌入其他系统；前端使用 Vue 3、Pinia、Vite 和 Tailwind，是该服务的一套参考客户端。前后端通过 `shared/types.ts` 中的版本化消息协议通信。

## 启动

需要 Node.js 22.19+ 和 pnpm 10+。

```powershell
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:5173>。Vite 将 `/ws` 和 `/api` 转发到本机的后端 `127.0.0.1:3000`。

后端默认以它**启动时的工作目录**作为 pi 的工作目录。从根目录执行 `pnpm dev` 时，pnpm 会在 `backend/` 中启动后端脚本。需要让 pi 操作其他项目时，在启动前指定绝对路径：

```powershell
$env:PI_WORKSPACE_DIR = 'C:\path\to\your\project'
pnpm dev
```

可选环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PI_WORKSPACE_DIR` | 后端进程的工作目录 | pi 文件和终端工具的工作目录 |
| `PI_AGENT_DIR` | `~/.pi/agent` | pi 的设置、模型、认证和会话数据目录 |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `3000` | 后端监听端口 |

界面支持多会话、会话文件恢复、流式回复、思维过程、工具执行记录、模型和思考强度切换。侧栏“设置”统一提供模型配置与 Provider 认证，并可新增和管理技能、插件、子代理及 MCP 服务；这些能力直接接入 `@earendil-works/pi-coding-agent` 的资源加载器与扩展运行时。进程内最多保留 5 个活跃 AgentSession；被淘汰的会话仍可从 pi 的 JSONL 文件恢复。

pi 只会在首次产生助手消息后写出会话文件，因此尚未开始回复的空对话在后端重启后不会保留。

## 模型配置

如果已有 pi 配置，后端会读取 `~/.pi/agent/` 下的 `models.json`、`settings.json`、`auth.json` 和 `sessions/`。可以在“设置 → 模型”中通过结构化表单添加 Provider、发现或手动添加模型、测试连接，并完成内置 Provider 认证。密钥只保存在本机的 pi 配置中，不要将配置文件提交到仓库。

技能和插件保留 Pi 原有的全局及项目资源发现规则，并额外把 [`backend/skills`](./backend/skills/README.md) 交给 `DefaultResourceLoader` 加载。可以直接把符合 Agent Skills 规范的目录放进去；设置页选择“当前项目”创建技能时也会写到这里。

项目自定义子 agent 放在 [`backend/subagents`](./backend/subagents/README.md)。每个角色可以分别配置系统提示词、内置工具白名单、技能白名单和专属 TypeScript 工具扩展。项目级开关和并发上限保存在 `backend/subagents/settings.json`；全局子 agent 仍兼容 `~/.pi/agent/agents/`。MCP 服务保存在 `~/.pi/agent/mcp.json`。设置保存后会自动重载当前空闲会话，正在回复的会话会在下次重载或重新打开后生效。

## WebSocket 协议

连接 `/ws` 后必须先完成 v1 握手：

```json
{"type":"init","protocolVersion":1,"requestId":"..."}
```

服务端返回同类型 `init` 消息，其中一次包含 `sessions`、`models`、`providers` 和 `settings` 初始目录。握手前发送其他命令会收到 `INIT_REQUIRED`。

Agent 的实时输出是扁平顶层事件，不再使用 `session_event.event` 包装。所有运行事件都带 `sessionId`，可直接按会话分流：

```json
{"type":"agent_start","sessionId":"..."}
{"type":"text_delta","sessionId":"...","delta":"你好"}
{"type":"tool_start","sessionId":"...","tool":{"id":"...","name":"read","status":"running"}}
{"type":"tool_end","sessionId":"...","toolCallId":"...","output":"..."}
{"type":"message_end","sessionId":"...","message":{"id":"...","role":"assistant","text":"..."}}
{"type":"agent_end","sessionId":"..."}
```

完整协议类型位于 `shared/types.ts`。

本项目默认只监听本机地址。后端能够调用 pi 的文件和终端工具，也会读取本机模型凭证；如需让其他设备访问，应先增加身份验证并限制可访问的工作目录。

## 检查

```powershell
pnpm typecheck
pnpm build
```

`pnpm build` 会检查后端类型并构建前端静态文件。开发模式下后端通过 `tsx` 运行。连接到已启动的后端后，可执行 `pnpm smoke` 检查 WebSocket 的会话创建、读取、删除和认证挑战；该命令会创建并删除一个测试空会话。
