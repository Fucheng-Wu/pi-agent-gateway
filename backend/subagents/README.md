# 自定义子 agent

每个项目子 agent 使用一个独立目录：

```text
backend/subagents/
└── reviewer/
    ├── agent.md
    └── tools.ts
```

`agent.md` 的正文是该子 agent 的系统提示，frontmatter 支持：

- `name`：调用时使用的唯一 ID。
- `display_name`、`description`：设置页展示信息。
- `tools`：允许的内置或扩展工具名；支持 Pi 的工具匹配模式。
- `skills`：只加载列出的技能名；`["*"]` 表示加载全部已发现技能。
- `extensions`：相对于 `agent.md` 的 Pi 扩展模块。扩展必须位于该子 agent 目录中，可以注册专属工具。
- `permissions`：可选的单行 JSON 权限规则数组（action/resource/effect）；子代理执行时同时受当前主代理策略约束，不能通过自身 allow 覆盖主代理的 deny。

复制 `_template` 目录，改名后把 `agent.md.example` 改成 `agent.md`。如果不需要专属工具，删除 `extensions` 并移除 `tools` 中对应的工具名即可。

`settings.json` 控制总开关、并发上限和禁用角色。设置页修改后也会写回此文件。

主代理配置见 [primary-agents](../primary-agents/README.md)。其中 `mode: all` 的角色同时可作为子代理调用。需要确认的子代理操作在主任务所属浏览器弹出确认，显示具体角色；取消主任务会一并取消审批和正在执行的子任务。

## 协作工具

启用子代理后，主代理可以使用以下工具：

| 工具 | 用途 |
| --- | --- |
| `spawn_agent({profile, task, name?, fork_context?})` | 后台启动并立即返回 `agent_id`，主代理可以继续工作 |
| `send_message({agent_id, message})` | 运行中发送引导消息；空闲时补充上下文，不启动新任务 |
| `followup_agent({agent_id, task})` / `resume_agent(...)` | 复用子代理及其历史；忙碌时排队，已完成或中断时继续 |
| `list_agents({})` | 查看当前会话的协作代理状态 |
| `wait_agents({agent_ids, timeout_ms?})` | 任意一个指定代理完成即返回；默认等 30 秒，最多 60 秒，0 表示立即查看；超时不会停止工作 |
| `interrupt_agent({agent_id})` | 中断当前任务，保留上下文供继续执行 |
| `close_agent({agent_id})` | 停止并释放子会话，历史保留，关闭后不能续跑 |
| `Agent({profile, task})` | 兼容原来等待完成后返回结果的一次性委派 |

`fork_context` 默认关闭；开启时把启动时主对话的消息和工具记录作为背景快照提供给子代理。各代理共享工作目录，应在任务说明中划分负责的文件，避免并行覆盖。当前由主代理协调子代理，不向子代理默认提供创建团队的工具。

完成结果自动进入主对话上下文。主代理提前结束而子任务仍在运行时，Gateway 会等子任务完成，再启动主代理汇总；整个过程仍属于同一轮任务，审批、停止与本轮变更检查保持有效。Plan 只能启动不含扩展的只读角色。

浏览器侧栏持续显示同一个子代理的任务、消息、工具与状态。协作过程作为主会话的自定义记录保存，重连可恢复。续跑依赖仍在内存中的子会话；后端重启、会话淘汰、切换主代理、资源重载或项目切换会释放子会话，保存的历史会标为已关闭。每个主会话最多创建 64 个协作代理，并发设置限制全局正在执行的子任务，空闲子代理不占运行名额。
