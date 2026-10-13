# learn-pi

基于 pi SDK 的本地 Web 聊天界面。前端使用 Vue 3、Pinia、Vite 和 Tailwind；后端使用 Hono、WebSocket 和 `@mariozechner/pi-coding-agent`。前后端共用 `shared/types.ts` 中的消息协议。

## 启动

需要 Node.js 22+ 和 pnpm 10+。

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

界面支持多会话、会话文件恢复、流式回复、思维过程、工具执行记录、模型和思考强度切换、模型配置编辑，以及 Provider 的 OAuth / API Key 配置。进程内最多保留 5 个活跃 AgentSession；被淘汰的会话仍可从 pi 的 JSONL 文件恢复。

pi 只会在首次产生助手消息后写出会话文件，因此尚未开始回复的空对话在后端重启后不会保留。

## 模型配置

如果已有 pi 配置，后端会读取 `~/.pi/agent/` 下的 `models.json`、`settings.json`、`auth.json` 和 `sessions/`。也可以在界面左侧打开“模型设置”编辑 `models.json`，或通过“快捷配置”完成 Provider 认证。密钥只保存在本机的 pi 配置中，不要将配置文件提交到仓库。

本项目默认只监听本机地址。后端能够调用 pi 的文件和终端工具，也会读取本机模型凭证；如需让其他设备访问，应先增加身份验证并限制可访问的工作目录。

## 检查

```powershell
pnpm typecheck
pnpm build
```

`pnpm build` 会检查后端类型并构建前端静态文件。开发模式下后端通过 `tsx` 运行。连接到已启动的后端后，可执行 `pnpm smoke` 检查 WebSocket 的会话创建、读取、删除和认证挑战；该命令会创建并删除一个测试空会话。
