# OpenCode V2 Primary Agent 参数参考

核对日期：2026-10-21。本文用于配置 OpenCode 内能够通过 Tab 切换的主代理，不是 Pi Agent Gateway 自定义子代理的配置规范。

本文只介绍 V2 配置，依据核对日期的官方 V2 文档及 dev 分支，不代表所有已发布版本。另一版本请阅读 [V1 参数参考](./opencode-primary-agent-v1.md)。先执行 `opencode --version`，结合安装版本确认支持情况。

**要加入 Tab 切换列表，明确设置 `mode: primary`，保持角色未隐藏、未禁用，并让 OpenCode 成功加载它。**

**配置入口与身份**

| 入口 | 位置 | 角色 ID 从哪里来 |
| --- | --- | --- |
| 项目 Markdown | `.opencode/agents/review.md` | 文件名，对应 `review` |
| 全局 Markdown | `~/.config/opencode/agents/review.md` | 文件名，对应 `review` |
| V2 JSON/JSONC | `opencode.json` 或 `opencode.jsonc` 的 `agents.review` | 对象键 `review` |

`~` 表示用户主目录。不要把角色文件放进 `skills` 目录。Markdown 的 YAML frontmatter 放参数，正文放角色指令；JSON 则使用提示词字段。

同名配置可覆盖或合并既有角色。新增独立角色宜用新 ID，例如 `architect`；定义 `build`、`plan` 则是在修改内置角色。

来源：[V2 Agent 文档](https://dev.opencode.ai/v2/docs/agents/)、[配置加载源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/plugin/agent.ts)。

**V2 可复制模板**

创建 `.opencode/agents/review.md`：

```markdown
---
description: 阅读项目代码，检查逻辑错误与回归风险
mode: primary
color: "#6384D6"
steps: 16
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: question
    resource: "*"
    effect: allow
---

你负责代码审查。
先阅读相关实现，再报告可以由代码支持的问题。
每项发现写明文件位置、触发条件、影响和建议。
不修改文件，按严重程度排序输出。
```

模板中的 `read: *` 是明确开放读取的示例，会覆盖更早匹配的读取规则；如需排除某些文件，必须在后面追加更具体的规则。不要把本模板的示例读取范围理解成默认敏感文件策略。

**V2：完整参数列表**

V2 Agent 配置 schema 的字段是以下 10 个；JSON 中放在 `agents.<角色ID>` 下，Markdown frontmatter 使用相同字段，但指令写在正文。

| 字段 | 类型 | 作用与省略行为 |
| --- | --- | --- |
| `description` | string | 职责摘要；可省略，实际配置建议写清楚 |
| `mode` | `primary` / `subagent` / `all` | 新自定义角色默认 `primary`，仍建议显式填写 |
| `model` | string 或 object | 模型偏好；省略不施加角色级选择 |
| `system` | string | JSON 中的角色系统指令；Markdown 用正文 |
| `permissions` | 规则数组 | 追加权限规则；省略继承生效配置，并非默认拒绝 |
| `steps` | 正整数 | 模型步骤上限；最后一步文本收尾，新用户输入重置预算 |
| `hidden` | boolean | 默认 `false`；隐藏正常选择及发现入口 |
| `disabled` | boolean | 默认不禁用；`true` 在对应配置加载阶段移除角色 |
| `color` | 六位 HEX string | UI 颜色；省略由界面决定 |
| `request` | object | 请求覆盖配置，当前存在“保存但不发送”的运行器限制 |

`system` 的非空值会替换该角色的 Provider 基础提示，但项目指令、技能等其他来源仍会添加。切换角色不意味着清除原会话历史。

来源：[V2 Agent schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/config/agent.ts)、[Agent 默认数据](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/agent.ts)。

V2 的 `model` 可用简写 `provider/model-id#variant`，或如下展开结构：

```json
{
  "providerID": "你的提供商ID",
  "model": "你的模型ID",
  "variant": "该模型已有的变体ID"
}
```

`providerID`、`model` 必填；`variant` 可省略。以上字符串是格式占位，不能直接当作真实模型使用。注意这里模型 ID 的键是 `model`，不是 `modelId`。

V2 会话会单独保存选中的模型，因此不要假设给已有会话切换代理 ID 就一定覆盖它的模型选择。

来源：[V2 模型选择 schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/config/model.ts)。

V2 的 `permissions` 每一项必须包含：

| 子字段 | 类型 | 含义 |
| --- | --- | --- |
| `action` | string | 操作名，例如 `read`、`edit`、`shell`、`subagent`、`skill`；支持通配 |
| `resource` | string | 被匹配的路径、命令、角色 ID、技能名等；含义由 action 决定 |
| `effect` | `allow` / `ask` / `deny` | 允许、询问或拒绝 |

规则是有序数组，最后匹配者生效。全局规则在前、角色规则在后。子代理使用自身规则，而不是自动继承父代理的权限子集。

来源：[V2 权限参考](https://dev.opencode.ai/v2/docs/permissions/)。

V2 的 `request` 有两个可选子字段：

| 子字段 | 类型 | 含义 |
| --- | --- | --- |
| `headers` | `Record<string, string>` | 请求头覆盖 |
| `body` | `Record<string, JSON值>` | 请求 JSON body 覆盖 |

截至核对日期，官方明确说明 V2 会话运行器保留这些配置，却尚未发送到模型请求。不要据此认为 `request.body.temperature` 已经生效；需使用实际生效的 Provider、模型或变体层配置。

来源：[request schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/config/provider.ts)、[V2 request 的运行限制](https://dev.opencode.ai/v2/docs/agents/#request)。

**各参数的填写方法**

**`description`：职责摘要**

类型是 string，可省略，实际使用建议填写。一句话说明角色负责的任务，例如“只读分析接口实现并报告回归风险”。它用于展示和角色发现，详细步骤放在正文或 `system` 中。

**`mode`：运行位置**

| 值 | 主角色切换 | 子代理委派 |
| --- | --- | --- |
| `primary` | 可进入列表 | 不作为子代理启动 |
| `subagent` | 不进入主角色切换列表 | 可供委派 |
| `all` | 可进入列表 | 也可供委派 |

新建自定义角色省略时默认 `primary`；要表达明确意图，仍建议填写。该字段决定角色运行位置，不决定它拥有多少工具权限。

**`system` / Markdown 正文：角色指令**

JSON 中 `system` 是 string；Markdown 中把指令放在 YAML frontmatter 之后。两种入口选择一种，不需要重复维护同一份提示词。非空自定义系统指令替换 Provider 基础提示，但项目指令、技能等其他来源仍会添加。

建议写清职责、执行顺序、交付格式和边界。例如“先阅读实现，再按严重程度列出问题，每项包含文件位置和触发条件”。需要阻止的工具操作同时设置权限。

**`steps`：模型迭代预算**

正整数，例如 `steps: 16`。省略时不增加该角色的显式步数上限。达到限制时运行器移除工具并要求文本收尾；新的用户输入会重置预算。

它不是 Token 上限、超时秒数、用户消息条数，也不是严格的工具调用次数；一次模型输出可以包含多个工具调用。不要用 `0` 表示无限。模板中的 `16` 是示例值，可提高或省略。

**`hidden`：入口可见性**

boolean，默认 `false`。设为 `true` 后，从正常列表、交互发现及子代理目录隐藏。想通过 Tab 选择的角色应省略该字段或设为 `false`。隐藏不会代替权限检查，也不等于停用角色。

**`disabled`：停用角色**

boolean，默认不禁用。设为 `true` 时，在对应配置加载阶段移除该角色；适合临时关闭自定义角色或内置角色。若配置来源较多，仍需考虑后续加载内容的覆盖效果。

**`color`：界面颜色**

六位十六进制字符串，例如 `color: "#6384D6"`。YAML 必须加引号，避免 `#` 被当成注释。省略时由界面分配。V2 不使用主题颜色名；该字段不影响模型能力或权限。

字段类型依据：[V2 Agent schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/config/agent.ts)。

**权限匹配补充**

每条规则的 `action`、`resource`、`effect` 都必填。`allow` 自动执行，`ask` 请求决定，`deny` 阻止。使用 `*`、`?` 通配，其他字符按字面匹配；不要直接使用正则表达式语法。

| action | resource 的含义 |
| --- | --- |
| `read`、`edit` | 文件路径；`edit` 覆盖编辑、写入、补丁 |
| `glob` | 文件匹配表达式 |
| `grep` | 搜索表达式，不是文件访问路径规则 |
| `shell` | 命令文本 |
| `subagent` | 被委派的角色 ID |
| `skill` | 技能 ID |
| `question` | 通常使用 `*` |
| `webfetch` | URL |
| `websearch` | 搜索请求 |
| `external_directory` | 项目边界之外的目录 |

`read`、`edit`、`external_directory` 的路径资源支持主目录展开；不要据此假设 shell 命令中的变量同样展开。权限许可不等于工具、技能或 MCP 服务已经安装。只拒绝 `edit` 而开放任意 shell，不能保证文件无法被修改。

省略权限不是默认拒绝：角色会合并已有策略。若想明确只读，可以像模板那样先拒绝所有操作，再允许读取和检索。子代理使用自身规则，不能假定自动继承父代理限制。

来源：[V2 权限参考](https://dev.opencode.ai/v2/docs/permissions/)。

**V2 不使用的旧参数**

新配置不写 `prompt`、`permission`、`disable`、`tools`、`maxSteps`、顶层 `temperature` 或 `top_p`。角色指令用 `system`，权限用 `permissions`，停用用 `disabled`，步数用 `steps`。模型变体写在 `model` 内，不另加角色级 `variant`。

`request` 是否实际发送的限制已在上文单列，不要把成功解析当成请求参数已经生效。Provider 特定参数也不是通用的角色字段。

**JSON 配置示例**

Markdown 模板与以下 JSON 是两种定义入口，选择一种即可：

```json
{
  "agents": {
    "review": {
      "description": "只读检查代码与回归风险",
      "mode": "primary",
      "system": "阅读相关实现，按严重程度报告问题，提供文件位置和触发条件。",
      "color": "#6384D6",
      "steps": 16,
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "read", "resource": "*", "effect": "allow" },
        { "action": "glob", "resource": "*", "effect": "allow" },
        { "action": "grep", "resource": "*", "effect": "allow" },
        { "action": "question", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

**角色外部的相关参数**

以下字段不写进角色 frontmatter。

| 配置 | 位置 | 用途 |
| --- | --- | --- |
| `default_agent` | 主配置顶层 | 选择默认主代理 ID；不是设置 `mode`，也不替换已有会话选择 |
| `agents` | 主配置顶层 | V2 的角色字典 |
| `$schema` | 主配置顶层 | 编辑器配置校验与补全，不授予运行权限 |
| `keybinds.agent_cycle` | `tui.json` | 默认 Tab，循环切换主角色 |
| `keybinds.agent_cycle_reverse` | `tui.json` | 默认 Shift+Tab，反向切换 |

例如主配置设 `"default_agent": "review"`，不会创建 `review`，仍需先定义该角色。Tab 的候选列表还会过滤仅用于子代理和隐藏的角色。

来源：[默认代理配置](https://dev.opencode.ai/v2/docs/agents/#selection)、[TUI 快捷键](https://opencode.ai/docs/keybinds/)、[TUI 角色筛选源码](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/context/local.tsx)。

**不要混入其他框架的参数**

你项目的 Pi 子代理格式有 `name`、`display_name`、`tools` 数组、`skills` 数组和 `extensions`；这些不等于 OpenCode Agent 的字段。

OpenCode 的角色 ID 由文件名或 JSON 键确定。MCP 连接、技能目录、模型 Provider 注册属于各自配置；角色侧通过对应权限控制使用，不能仅加一个 `mcp`、`skills` 或 `memory` 字段就启用。

OpenCode 的技能按需加载，V2 可通过 `permissions` 中的 `action: skill` 控制；这不同于 Pi 项目中直接列举技能文件的做法。

来源：[技能发现与权限](https://opencode.ai/docs/skills/)。
