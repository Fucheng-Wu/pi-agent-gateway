# GitHub 展示设置

这些设置保存在 GitHub 仓库中，不会随 README 自动更新。本页提供可直接使用的文案；实际操作后再视为已完成。

## About

建议描述：

```text
A web workspace and embeddable backend for Pi Coding Agent, with Plan/Build, permissions, model management, Skills, MCP, and subagents.
```

建议 Topics（只选择与实际功能相关的标签）：

```text
pi-coding-agent
coding-agent
ai-agent
web-ui
developer-tools
typescript
vue
hono
websocket
mcp
agent-skills
```

没有在线演示站点时，Website 留空。README 中的本地地址不是公共演示链接。

## Social preview

可以使用 [`images/console.png`](./images/console.png) 作为初版社交预览图。这张图来自隔离配置下的真实控制台，不含用户会话和模型密钥。

## 发布前检查

- 推送中英文 README、MIT 许可证、截图和社区模板。
- 查看首次 CI 的 Ubuntu / Windows 结果；本地通过不能替代远程结果。
- 用全新配置走完安装、Provider 配置和第一次回复，再决定是否发布首个 Release。
- 后续录制 30～45 秒真实任务视频，展示 Plan → Build → 权限确认 → 工具结果。未录制前不放演示占位链接。

README 当前使用静态技术与许可徽章。首次 CI 成功后，可按需添加工作流状态徽章。
