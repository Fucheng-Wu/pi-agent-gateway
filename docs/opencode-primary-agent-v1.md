# OpenCode V1 Primary Agent 参数参考

核对日期：2026-10-21。本文用于配置 OpenCode 内能够通过 Tab 切换的主代理，不是 Pi Agent Gateway 自定义子代理的配置规范。

本文只介绍 V1 配置。另一版本请阅读 [V2 参数参考](./opencode-primary-agent-v2.md)。先执行 `opencode --version`，结合对应版本文档确认格式；兼容 schema 与文档存在差异的地方已标注。

**要加入 Tab 切换列表，明确设置 `mode: primary`，保持角色未隐藏、未禁用，并让 OpenCode 成功加载它。**

**配置入口与身份**

| 入口 | 位置 | 角色 ID 从哪里来 |
| --- | --- | --- |
| 项目 Markdown | `.opencode/agents/review.md` | 文件名，对应 `review` |
| 全局 Markdown | `~/.config/opencode/agents/review.md` | 文件名，对应 `review` |
| V1 JSON/JSONC | `opencode.json` 或 `opencode.jsonc` 的 `agent.review` | 对象键 `review` |

`~` 表示用户主目录。不要把角色文件放进 `skills` 目录。Markdown 的 YAML frontmatter 放参数，正文放角色指令；JSON 则使用提示词字段。

同名配置可覆盖或合并既有角色。新增独立角色宜用新 ID，例如 `architect`；定义 `build`、`plan` 则是在修改内置角色。

来源：[V1 Agent 文档](https://opencode.ai/docs/agents/)、[配置加载源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/config/plugin/agent.ts)。

**V1：一份可以直接开始使用的模板**

创建 `.opencode/agents/review.md`：

```markdown
---
description: 阅读项目代码，检查逻辑错误与回归风险
mode: primary
color: "#6384D6"
steps: 16
permission:
  "*": deny
  read: allow
  glob: allow
  grep: allow
  question: allow
---

你负责代码审查。

先阅读相关实现，再报告可以由代码支持的问题。
每项发现写明文件位置、触发条件、影响和建议。
按严重程度排序；没有发现问题时直接说明。
不修改文件。用户要求修复时，提示切换到 Build。
```

这是一份只开放读取、检索和提问的示例。没有填写 `model`，便于先使用现有模型；`steps: 16` 是示例预算，不是官方默认值。若希望更充分探索，可以提高或省略。

保存后重新打开 OpenCode，使用 Tab、Shift+Tab 检查角色列表。加载失败时先检查 YAML 缩进、字段格式及版本。

**V1 参数总表**

下表的“省略行为”针对新建自定义角色；修改内置角色时，还会保留或合并已有配置，不是把每个字段都清空重设。

| 参数 | 类型 | 用途 | 省略行为或填写建议 |
| --- | --- | --- | --- |
| `description` | string | 简述角色职责及适用场景 | 始终填写；文档要求填写，当前兼容 schema 允许省略 |
| `mode` | string 枚举 | 决定作为主代理还是子代理 | V1 文档默认 `all`；本需求明确写 `primary` |
| `model` | string | 选择 Provider 及模型 | 使用当前配置和客户端的模型选择逻辑，不写死统一模型 |
| `variant` | string | 选择该模型已有的变体 | 不指定角色级变体 |
| `prompt` | string | JSON 配置中的角色指令 | 使用正常基础提示及其他指令来源；Markdown 用正文 |
| `temperature` | number | 调整采样随机性 | 依模型及其他配置；无跨模型统一默认值 |
| `top_p` | number | 调整核采样候选范围 | 依模型及其他配置 |
| `steps` | 正整数 | 限制 Agent 的模型迭代步数 | 不设置该角色的显式步数上限 |
| `permission` | 权限值或规则对象 | 工具及操作权限 | 合并内置、全局等既有规则，绝非默认全部拒绝 |
| `color` | string | UI 中角色的颜色 | 使用界面分配的颜色 |
| `hidden` | boolean | 交互发现时的隐藏选项 | 默认不隐藏；要通过 Tab 选择就省略或设 `false` |
| `disable` | boolean | 禁用角色 | 默认不禁用 |
| `options` | object | 模型/Provider 特定选项容器 | 不增加此处的模型选项 |
| 额外字段 | Provider 特定 | V1 的模型选项扩展方式 | 取决于实际模型适配器 |
| `tools` | `Record<string, boolean>` | 旧式工具开关 | 已弃用，新配置用 `permission` |
| `maxSteps` | 正整数 | `steps` 的旧名 | 已弃用，新配置用 `steps` |

字段及类型依据：[V1 兼容 schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/agent.ts)。默认模式等使用行为依据 [V1 Agent 文档](https://opencode.ai/docs/agents/)。文档与兼容 schema 不完全一致时，本文明确标出，不把 schema 接受等同于安装版本已生效。

**`description`：职责摘要**

写清任务范围，例如“审查后端接口的权限校验和错误处理”。它用于说明角色用途，子代理场景中还帮助模型选择委派对象。主代理的详细执行规则写入提示词，而非全部塞进摘要。

建议：一句话写“做什么、何时用”，不要只写“智能助手”。

**`mode`：角色运行位置**

| 值 | 主角色选择列表 | 子代理调用 |
| --- | --- | --- |
| `primary` | 可进入 | 不作为子代理启动 |
| `subagent` | 不进入主角色切换列表 | 可供委派 |
| `all` | 可进入 | 也可供委派 |

是否实际显示，还受隐藏、禁用、配置加载等条件影响。`primary` 决定使用位置，不会自动赋予更大的权限。

**`model`：模型标识**

V1 使用 `provider/model-id` 字符串。`provider` 必须是已配置的提供商标识，`model-id` 必须是该提供商实际提供的模型。它不是 API Key 或 Base URL 的填写位置。

可用 `opencode models` 查看标识。不要把展示名称、聊天产品名称或订阅档位当成模型 ID。

省略时不代表固定使用某一家模型；模型的最终选择还受配置、当前会话及客户端选择影响。

来源：[模型配置与选择](https://opencode.ai/docs/models/)。

**`variant`：模型变体**

类型为字符串，例如 `high`。变体是同一个模型的一组已定义设置，常用于推理预算等差异。它必须存在于所选模型上；`high` 并非每个模型都通用。

V1 兼容 schema 的含义是“使用该角色配置的模型时，应用这个默认变体”。因此不要只设置 `variant`，却假设任何当前模型都拥有这个变体。

来源：[V1 字段定义](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/agent.ts)、[模型变体](https://opencode.ai/docs/models/#variants)。

**`prompt` / Markdown 正文：角色工作指令**

JSON 中可直接写字符串，也可引用文件：

```json
{
  "agent": {
    "review": {
      "mode": "primary",
      "description": "检查项目代码",
      "prompt": "{file:./prompts/review.txt}"
    }
  }
}
```

上述文件路径相对于配置文件所在位置。Markdown 定义角色时，把这些内容放在结束的 `---` 后面，无须再写一份 `prompt`。

建议写清职责、工作步骤、交付格式和边界。提示词表达工作要求；需要程序阻止的操作还应配置权限。项目指令、技能等仍可能参与上下文，不能把角色正文理解成全部上下文。

来源：[配置中的文件引用](https://opencode.ai/docs/config/#files)、[Agent 提示词说明](https://opencode.ai/docs/agents/#prompt)。

**`temperature`：采样随机性**

数值越低通常越稳定，越高通常变化越大。它不等于模型推理强度。常见接口使用 0 到 1 一类的区间，但实际范围、是否接受以及默认值由模型接口决定。

代码审查可以从省略开始；确需调整且模型支持时，再尝试较低值。不要同时大幅修改它和 `top_p`，以免难以判断效果。

**`top_p`：核采样范围**

通常使用 0 到 1 的数值，控制按累计概率保留的候选范围。值较低通常减少输出多样性。它同样不控制思考时长或工具权限。没有明确需求时省略，沿用模型设置。

**`steps`：模型迭代预算**

必须是正整数，例如 `steps: 16`。它限制 Agent 继续推进的模型步骤，达到上限后要求用文本收尾。

它不是用户消息条数、Token 上限、超时秒数，也不是严格的工具调用次数：一次模型输出可能调用多个工具。不要用 `steps: 0` 表示无限或禁用。

V1 文档描述省略后由模型结束或用户中断；`steps` 和旧名 `maxSteps` 同时存在时，兼容 schema 优先取 `steps`。

**`permission`：规则结构**

常用值：`allow` 自动执行，`ask` 请求用户决定，`deny` 拒绝。规则可以按工具整体配置，也可以为资源写更细的匹配。

```yaml
permission:
  "*": deny
  read: allow
  glob: allow
  grep: allow
  edit: ask
  task:
    "*": deny
    explore: allow
```

这里默认拒绝，允许读取和检索，修改需询问，模型委派只允许 `explore`。`explore` 仍须真实存在且可作为子代理运行。V1 的 `task` 规则控制模型委派，不应当作用户手动 `@` 选择的同一套入口限制。

规则按顺序处理，最后匹配者优先，因此宽泛规则写在前面。角色规则和全局规则会合并；省略某项不等于拒绝，也不等于重置默认规则。

通配符 `*` 匹配任意长度字符，`?` 匹配单个字符；其他字符按字面匹配，不能直接把 JavaScript 正则当作权限模式。路径规则中的 `~`、`$HOME` 可以展开，shell 命令文本不能据此推断同样展开。

当前 V1 兼容 schema 对 `question`、`websearch`、`doom_loop` 只接受单个动作值，不能给它们写路径/资源对象。版本支持的其他工具可使用更细的规则；具体匹配对象按下表区分。

来源：[V1 权限规则](https://opencode.ai/docs/permissions/)、[权限 schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/permission.ts)。

常见权限键及其匹配对象：

| 键 | 匹配对象与作用 |
| --- | --- |
| `read` | 文件路径，控制读取 |
| `edit` | 修改路径，覆盖编辑、写入、补丁 |
| `glob` | 文件匹配表达式 |
| `grep` | 搜索表达式，不要误当成文件访问路径规则 |
| `list` | V1 中的目录列举工具，是否存在及可细分程度以安装版本为准 |
| `shell` / 较早 V1 的 `bash` | 命令；采用本机版本实际使用的工具动作名 |
| `task` | V1 的子代理类型/标识 |
| `skill` | 技能名，控制按需加载 |
| `question` | 执行期间向用户提问 |
| `webfetch` | URL 抓取 |
| `websearch` | 网络搜索 |
| `external_directory` | 访问工作目录之外的路径 |
| `lsp` | V1 的语言服务查询，是否可用取决于版本 |
| `doom_loop` | V1 的重复调用保护检查 |

当前 V1 主站示例已经出现 `shell`；V2 迁移文档仍将旧 V1 对应项写为 `bash`。这是不同版本资料的差异，不能仅凭字段名判断整个安装版本。上面的只读模板通过默认拒绝避免依赖 shell 动作名。

权限限制不是操作系统沙箱。例如只禁止 `edit`，却允许任意 shell，并不能保证无法修改文件。权限允许也不代表相应工具、MCP 服务或技能已经安装。

来源：[工具文档](https://opencode.ai/docs/tools/)、[V2 权限迁移说明](https://dev.opencode.ai/v2/docs/permissions/)。

**`color`：界面颜色**

V1 支持六位十六进制颜色，例如 `"#6384D6"`，也支持 `primary`、`secondary`、`accent`、`success`、`warning`、`error`、`info` 等主题名。YAML 中十六进制色必须加引号，避免 `#` 被视为注释。

它只影响显示，不影响权限或模型能力。

**`hidden`：隐藏入口**

布尔值。V1 文档主要将其描述为隐藏子代理的 `@` 补全。对于要用 Tab 选择的主代理，保持省略或 `false`。

隐藏不等于禁用或权限隔离。

**`disable`：禁用角色**

V1 布尔值。设为 `true` 表示停用该角色；如果想保留配置、暂不使用，可以用它。

**`options` 与额外 Provider 字段**

V1 允许 `options` 对象，兼容 schema 还会把未识别的额外键收集为模型选项。文档中的 `reasoningEffort`、`textVerbosity` 属于这类 Provider 特定设置。

这些不是所有主代理都通用的固定参数。能否生效、可用取值和冲突优先级要看具体模型适配器；不要往这里随意填 `skills`、`memory`、`schedule`，以为会获得平台能力。

| 常见扩展选项示例 | 类型 | 说明 |
| --- | --- | --- |
| `reasoningEffort` | string | 部分推理模型的思考强度；允许值依模型变化，不能假定每个模型都支持 `high` |
| `textVerbosity` | string | 部分模型的输出详略偏好，不是严格字数上限 |

`options` 内没有一份跨 Provider 通用且封闭的“全部参数表”；参数由所用模型适配器定义。本文列全的是 Agent 自身字段，而非所有模型 API 的参数。

**旧参数 `tools` 与 `maxSteps`**

`tools` 是工具名到布尔值的旧开关，缺少 `ask` 和细粒度资源规则。新配置改用 `permission`。当前兼容逻辑先转换旧工具开关，再合并显式权限。

`maxSteps` 是 `steps` 的旧名；两者同时填写时优先 `steps`。不要为“兼容”同时堆放两套参数。

上述 V1 字段的类型、别名及归一化行为见 [V1 schema 源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/agent.ts)。

**角色外部的相关参数**

以下字段不写进角色 frontmatter。

| 配置 | 位置 | 用途 |
| --- | --- | --- |
| `default_agent` | 主配置顶层 | 选择默认主代理 ID；不是设置 `mode`，也不替换已有会话选择 |
| `agent` | 主配置顶层 | V1 的角色字典 |
| `$schema` | 主配置顶层 | 编辑器配置校验与补全，不授予运行权限 |
| `keybinds.agent_cycle` | `tui.json` | 默认 Tab，循环切换主角色 |
| `keybinds.agent_cycle_reverse` | `tui.json` | 默认 Shift+Tab，反向切换 |

例如主配置设 `"default_agent": "review"`，不会创建 `review`，仍需先定义该角色。Tab 的候选列表还会过滤仅用于子代理和隐藏的角色。

来源：[默认代理配置](https://opencode.ai/docs/config/#default-agent)、[TUI 快捷键](https://opencode.ai/docs/keybinds/)、[TUI 角色筛选源码](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/context/local.tsx)。

**不要混入其他框架的参数**

你项目的 Pi 子代理格式有 `name`、`display_name`、`tools` 数组、`skills` 数组和 `extensions`；这些不等于 OpenCode Agent 的字段。

OpenCode 的角色 ID 由文件名或 JSON 键确定。MCP 连接、技能目录、模型 Provider 注册属于各自配置；角色侧通过对应权限控制使用，不能仅加一个 `mcp`、`skills` 或 `memory` 字段就启用。

OpenCode 的技能按需加载，V1 可通过 `permission.skill` 控制；这不同于 Pi 项目中直接列举技能文件的做法。

来源：[技能发现与权限](https://opencode.ai/docs/skills/)。
