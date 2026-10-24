# 主代理

内置 Build 和 Plan，可在输入框左下角选择，或在输入框按 Tab / Shift+Tab 切换。切换仅在会话空闲时进行，保留原会话 ID、历史、模型及思考强度；角色选择随会话保存。内置角色的 ID 保留，请用新 ID 定义自己的角色。

- **Build**：参考 [OpenCode 的默认权限](https://docs.opencode.ai/docs/permissions/)，常规读取、检索、文件修改、命令执行及工具调用自动允许；使用文件／目录工具访问项目外路径、读取 `.env` / `.env.*` 时需要确认（`.env.example` 自动允许）。
- **Plan**：探索与规划，阻止普通项目文件修改和命令执行。用户明确要求保存计划时，可申请写入工作目录 `.pi/plans/*.md`。只允许委派不带专属扩展、工具均为只读的子代理，子代理还受主角色权限约束。

每个项目主代理使用独立目录：

```text
backend/primary-agents/
└── reviewer/
    ├── agent.md
    └── tools.ts
```

也可以使用 `backend/primary-agents/reviewer.md`。全局配置位于 `PI_AGENT_DIR/primary-agents/`（默认 `~/.pi/agent/primary-agents/`），项目同名角色优先。

`agent.md` 示例（创建后重新打开页面以刷新角色目录）：

```markdown
---
name: reviewer
display_name: "代码审查"
description: "只读审查代码中的错误和回归风险"
mode: primary
tools: ["read", "grep", "find", "ls"]
skills: []
extensions: []
permissions: [{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"},{"action":"find","resource":"*","effect":"allow"},{"action":"ls","resource":"*","effect":"allow"}]
---

先阅读相关实现，再按严重程度输出问题、文件位置、触发条件及建议。不修改代码。
```

当前 frontmatter 数组按单行 JSON 解析，请按上述格式书写。字段：

| 字段 | 含义 |
| --- | --- |
| `name` | 小写角色 ID；省略时取目录名或 Markdown 文件名 |
| `display_name` | 前端显示名称 |
| `description` | 职责摘要 |
| `mode` | `primary`（默认）或 `all`；`all` 同时加入子代理列表，配置统一在本目录管理 |
| `tools` | 工具白名单，支持 `*`、`?`；默认 read/grep/find/ls，不接受 +/- 修饰写法 |
| `skills` | Skill 名称白名单；`["*"]` 使用全部已发现技能；默认空数组 |
| `extensions` | 相对于角色文件的专属扩展，解析后的真实路径必须在该角色目录内 |
| `permissions` | 有序的 action/resource/effect 规则；默认未知操作需要确认，读取及检索允许 |
| 正文 | 追加到基础提示词的角色指令 |

`tools` 限制可选择的工具，执行前仍检查白名单及 `permissions`。规则最后匹配者生效，effect 为 allow、ask、deny。文件及目录工具的 resource 使用规范化后的工作目录相对路径，目录外使用绝对路径并单独检查 external_directory；操作权限和目录权限都必须允许。write/edit/apply_patch 统一使用 edit 动作；命令使用具体 bash/powershell 工具名，匹配 command；其他工具使用其名称。主代理与子代理均配置规则时，取更严格的结果。明确的 deny 不会被会话授权覆盖。自定义角色未配置 permissions 时仍采用“读取及检索允许，其余询问”的默认值，敏感环境文件读取需要确认。

权限确认弹窗提供“本次允许”“本会话允许”“拒绝”，并展示会话授权的具体范围：

- 文件修改记住 `edit: *`，write/edit 共用授权；项目外目录仍需单独确认。
- 项目外路径记住当前目录及其子路径，不会自动允许相邻目录。目录授权不会跳过 `.env` 等文件自身的操作权限。
- 简单命令可记住受支持的前缀，例如 `git status` / `git status *`、`pnpm run build` / `pnpm run build *`。带引号、命令拼接、换行、重定向或替换的命令，以及不支持的命令，使用完整命令精确授权。
- 敏感文件读取及其他操作仅记住当前对象，不会放行其他敏感文件。

会话授权绑定主角色及子角色，不跨会话共享；匹配的待确认请求会同时放行。切换角色、关闭／回收会话或后端重启即清除，不写入项目永久配置。拒绝会同时拒绝本会话其他待确认请求。确认只能由启动任务的浏览器连接回应；取消、断线或五分钟超时都会拒绝尚未完成的确认。确认队列可以包含多个会话或并行子任务。

这些是应用层权限，不是操作系统沙箱。扩展运行在后端进程中，必须信任其代码；Skill 白名单限制发现，不意味着共享文件对其他角色保密。

子代理仍然一次性执行，结束后销毁，不保存或恢复子代理会话。
