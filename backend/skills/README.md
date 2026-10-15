# 项目技能

这里的技能会由 `DefaultResourceLoader` 自动加载，并同时提供给主 agent。目录结构遵循 Agent Skills 规范：

```text
backend/skills/
└── my-skill/
    ├── SKILL.md
    ├── scripts/
    ├── references/
    └── assets/
```

复制 `_template/SKILL.md.example` 为 `my-skill/SKILL.md`，并保证目录名与 frontmatter 中的 `name` 相同。修改后，新会话立即生效；已有空闲会话可在设置页触发资源重载。

子 agent 默认不继承全部技能。请在 `backend/subagents/<id>/agent.md` 的 `skills` 中列出技能名，或使用 `skills: ["*"]`。
