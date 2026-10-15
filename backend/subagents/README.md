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

复制 `_template` 目录，改名后把 `agent.md.example` 改成 `agent.md`。如果不需要专属工具，删除 `extensions` 并移除 `tools` 中对应的工具名即可。

`settings.json` 控制总开关、并发上限和禁用角色。设置页修改后也会写回此文件。
