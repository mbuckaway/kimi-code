# 内置工具

内置工具是 Kimi Code CLI 随核心引擎提供的工具集，无需安装 MCP server 即可使用。Agent 在每次对话中会根据任务需要自动选择并调用这些工具；用户可以通过权限审批界面查看每次工具调用的细节。

与 MCP 工具相比，内置工具由运行时直接管理，生命周期与会话绑定，无需外部进程。两者都遵循统一的审批机制：**只读类工具**（如 `Read`、`Grep`、`Glob`）默认自动放行，**写入与执行类工具**（如 `Write`、`Edit`、`Bash`）默认需要用户审批。YOLO 模式下普通工具调用的审批会被跳过，但 Plan 模式下的退出审批不受影响。

## 文件类

文件类工具负责读取、写入、搜索本地文件系统，是代码分析和修改任务的基础工具。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Read` | 自动放行 | 读取文本文件内容 |
| `Write` | 需审批 | 创建或覆盖文件 |
| `Edit` | 需审批 | 精确字符串替换 |
| `Grep` | 自动放行 | 基于 ripgrep 的全文搜索 |
| `Glob` | 自动放行 | 按 glob 模式查找文件 |
| `ReadMediaFile` | 自动放行 | 读取图片或视频文件 |

**`Read`** 接受文件路径（`path`）以及可选的 `line_offset`（起始行号，支持负数从末尾倒数）和 `n_lines`（读取行数上限）。单次最多返回 1000 行或 100 KB，超出部分会附带截断提示。如果文件是图片或视频，工具会提示改用 `ReadMediaFile`。

**`Write`** 接受 `path`、`content` 和可选的 `mode`（`overwrite` 或 `append`，默认覆盖）。缺失的父目录会自动创建；`append` 模式将内容追加到文件末尾，不自动添加换行。写入已存在的文件（无论 `overwrite` 还是 `append` 模式）要求本会话中先用 `Read` 读过该文件——若文件自上次读取后在磁盘上发生变化，写入会被拒绝；新建文件不受此限。

**`Edit`** 接受 `path`、`old_string`（要替换的精确文本）和 `new_string`（替换后的文本）。默认只替换唯一一处匹配，若文件中存在多处相同内容会报错并提示使用 `replace_all: true`。`old_string` 与 `new_string` 不能相同。目标文件必须在本会话中先用 `Read` 读过；若文件自读取后在磁盘上发生变化，编辑会被拒绝。

**`Grep`** 调用 ripgrep 搜索文件内容，支持正则表达式（`pattern`）、搜索路径（`path`）、文件类型过滤（`type`，如 `ts`、`py`）、glob 过滤（`glob`）和输出模式（`output_mode`：`files_with_matches` / `content` / `count_matches`，默认 `files_with_matches`）。`content` 模式支持上下文行（`-A`、`-B`、`-C`）、忽略大小写（`-i`）、行号（`-n`，默认 true）、跨行匹配（`multiline`）。所有模式支持 `offset` + `head_limit` 分页，`head_limit` 默认 250、传 0 表示不限。`.env`、私钥等敏感文件会被自动过滤；`include_ignored=true` 可搜索被 `.gitignore` 忽略的文件，但敏感文件仍保持过滤。

**`Glob`** 按 glob 模式（`pattern`）在指定目录（`path`，默认工作目录）中匹配文件，结果按修改时间倒序排列，最多返回 100 条。默认尊重 `.gitignore`、`.ignore` 和 `.rgignore`；设置 `include_ignored=true` 可包含构建产物等被忽略的文件，但敏感文件仍会被过滤。支持 `*.{ts,tsx}` 这类花括号模式，也允许宽泛通配符模式，但通常会在匹配上限处截断。

**`ReadMediaFile`** 将图片或视频以多模态内容发送给模型。它接受 `path`，以及 `region`、`full_resolution` 等可选的图片细节参数；文件大小上限为 100 MB。默认读图会按配置的模型限制压缩；如果自动压缩无法安全满足限制，工具会返回错误且不发送原图，并提示模型先创建更小的副本再读取。是否可用取决于当前模型的视觉能力（`image_in` / `video_in`）。

## Shell

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Bash` | 需审批 | 执行 Shell 命令 |

**`Bash`** 是权限要求最严格的工具，也是功能最通用的工具。参数：

- `command`（必填）：要执行的 Shell 命令
- `cwd`：工作目录
- `timeout`：超时时间（毫秒）；前台默认 60 秒、最长 5 分钟
- `run_in_background`：是否以后台任务运行；后台默认 10 分钟超时（print 模式 `kimi -p` 下默认无超时）
- `description`：后台任务描述，`run_in_background=true` 时必填
- `disable_timeout`：后台任务是否取消超时限制

前台模式会阻塞当前轮次，直到命令结束或超时；命令运行期间，TUI 会把 stdout 和 stderr 流式显示在正在运行的 `Bash` 工具卡片中。前台命令超时后默认不会被终止，而是转为后台任务继续运行（受 600 秒默认后台超时约束）；如需恢复超时即终止的行为，将 `[background]` 的 [`bash_auto_background_on_timeout`](../configuration/config-files.md#background) 设为 `false`。600 秒的默认后台超时可通过 [`bash_task_timeout_s`](../configuration/config-files.md#background) 配置（`0` = 无超时），且在 print 模式（`kimi -p`）下默认无超时。后台模式立即返回任务 ID，任务结束时自动通知 Agent。stdin 始终被关闭，交互式命令会立即收到 EOF。任务被停止或后台超时时采用两阶段终止策略（SIGTERM → 5 秒宽限期 → SIGKILL），确保进程可靠结束。Windows 平台默认使用 Git Bash。

## 网络类

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `WebSearch` | 自动放行 | 网络搜索 |
| `FetchURL` | 自动放行 | 获取指定 URL 的内容 |

**`WebSearch`** 接受 `query`（搜索词）。需要宿主提供搜索实现，未注入时不会出现在工具列表中。

**`FetchURL`** 接受单个 `url` 参数，返回页面内容。对 HTML 页面，宿主会提取正文而非返回完整 HTML；纯文本或 Markdown 页面直接透传。同样需要宿主注入实现。

## Plan 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterPlanMode` | 自动放行 | 进入 Plan 模式 |
| `ExitPlanMode` | 自动放行（需用户确认计划） | 退出 Plan 模式并提交计划 |

Plan 模式是一种受约束的工作状态：进入后 `Write` 与 `Edit` 只允许写入当前的计划文件，`TaskStop`、`StopAgent`、`StopAgents`、`DismissAgents` 和 `InterruptAgent` 被完全拦截（`TagAgent` 与 `RenameAgent` 仍可用）。其余工具（包括 `Bash`）仍按当前权限规则处理。

**`EnterPlanMode`** 不接受任何参数，进入成功后返回工作流指引及计划文件路径。

**`ExitPlanMode`** 读取当前计划文件内容，将计划呈现给用户审批后退出 Plan 模式。可选参数 `options` 允许 Agent 提供 1–3 个备选方案（每项含 `label` 与 `description`，`label` 最长 80 字符），供用户在审批时选择；`label` 不能重复，也不能使用 `Approve`、`Reject`、`Reject and Exit`、`Revise` 等保留词。

## Supermoon 模式

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `EnterSupermoonMode` | 自动放行 | 开启 Supermoon 模式 |
| `ExitSupermoonMode` | 自动放行 | 关闭 Supermoon 模式 |

Supermoon 模式是最大严谨度的工作状态：开启后，Agent 默认用子代理编排实质性任务并应用优先严谨性的质量模式，客户端会把模型的思考强度锁定到支持的最高档位。参见 [Supermoon 模式指南](../guides/supermoon-mode.md)。

**`EnterSupermoonMode`** 不接受任何参数，为当前会话开启该模式；模式会保持开启，直到调用 `ExitSupermoonMode`。

**`ExitSupermoonMode`** 不接受任何参数，关闭该模式并恢复此前的思考强度。

## 模型类

模型工具负责查看和切换 Agent 运行的模型，包括 Plan 模式激活期间使用的模型（[`planning_model`](../configuration/config-files.md#顶层字段)）。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `modelquery` | 需审批 | 报告当前生效的模型 |
| `modellist` | 需审批 | 列出已配置模型及其上下文窗口 |
| `modelset` | 需审批 | 切换当前生效模型，或持久化默认 / 规划模型 |

**`modelquery`** 不接受任何参数，报告当前会话正在使用的模型：别名、供应商、模型 ID、显示名称和上下文窗口。

**`modellist`** 列出当前会话已配置的模型。每个条目显示别名、供应商、模型 ID、显示名称和上下文窗口，并标记哪些别名是当前模型、配置的默认模型和配置的规划模型。可选参数 `provider` 可将列表过滤为单个供应商。

**`modelset`** 接受 `model`（要选择的模型别名）和可选的 `role`（`current` / `default` / `planning`，默认 `current`）。默认角色下切换当前会话的生效模型——切换在下一轮次生效，并受上下文窗口守卫约束，只有上下文窗口不小于当前模型的模型才能被选中。`default` 和 `planning` 角色会把选择持久化到 `config.toml`（`default_model` / `planning_model`；规划模型必须与默认模型有相同的上下文窗口）——仅在 v2 引擎和 web 设置中可用；旧版（v1）引擎只支持 `current`，会拒绝持久化角色。

## 状态管理

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TodoList` | 自动放行 | 管理任务待办列表 |

**`TodoList`** 在多步骤操作中维护一份可见的子任务列表，状态存储在 Agent 会话内。`todos` 参数接受一个数组，每项含 `title` 和 `status`（`pending` / `in_progress` / `done`）；省略 `todos` 则仅查询当前列表，传入空数组则清空列表。

## 协作类

协作类工具负责 Agent 间协作、用户交互和 Skill 调用。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `Agent` | 自动放行 | 派生 subagent 执行子任务 |
| `AgentSwarm` | swarm mode 中自动放行，否则需审批 | 从 item 或 prompt 启动 subagent，或恢复已有 subagent |
| `SendMessage` | 自动放行 | 向会话中的其他 Agent 发送消息 |
| `ListAgents` | 自动放行 | 列出可以发消息的 Agent |
| `ListMessages` | 自动放行 | 列出你收到的消息，最新的在前 |
| `ReplyMessage` | 自动放行 | 按 id 回复收件箱中的消息 |
| `BroadcastMessage` | 自动放行 | 向可以寻址的每个 Agent 发送一条消息 |
| `AskUserQuestion` | 自动放行 | 向用户提问以获取结构化输入 |
| `Skill` | 自动放行 | 调用已注册的 inline Skill |

**`Agent`** 将子任务委托给 subagent 执行。必填参数：`prompt`（完整任务描述）和 `description`（3–5 个词的简短说明）。可选参数：`subagent_type`（默认 `coder`）、`persona`（实验功能；仅在启用 `agent_persona` flag 时可用——persona 名称或工作区内的 persona 文件路径，应用于新 subagent；见 [Persona](../customization/agents.md#persona)）、`resume`（恢复已有 Agent 的 ID，与 `subagent_type` 互斥）、`run_in_background`（默认 false）、`name`（实验功能；仅在启用 `agent_messaging` flag 时可用——为新 subagent 指定可按名称寻址的名字，由 1–64 个字母、数字、`.`、`_` 或 `-` 组成，在会话的所有 subagent 中唯一，`main` 保留给根 agent；resume 时忽略）和 `model`（仅在启用 [subagent 模型池](../configuration/config-files.md#subagent-模型池) 实验功能并配置模型池后可用——`[secondary_model.models]` 表或仅一行 `default_model`：池中别名，或 `"primary"` 表示调用方自己运行的模型；resume 时无效）。未传入时 subagent 绑定池的 `default_model`；未配置模型池时，subagent 一律继承调用方模型。Persona 必须通过 `extends` 指向本次派生的基座 Agent：缺少 `extends` 会以 `persona.base_required` 拒绝，指向其他基座会以 `persona.base_mismatch` 拒绝。Persona 只会收窄基座 Agent 的 `tools`、`disallowedTools` 和 `subagents`，绝不放宽。`persona` 与 `resume` 或 `fork` 同时传入会被拒绝。通过 `KIMI_CODE_EXPERIMENTAL_AGENT_PERSONA=1` 或 `config.toml` 中 `[experimental]` 下的 `agent_persona = true` 开启该功能。Agent 任务默认 2 小时超时，可通过 `config.toml` 的 `[subagent] timeout_ms`（`0` = 无超时，或 `KIMI_SUBAGENT_TIMEOUT_MS` 环境变量）配置，且在 print 模式（`kimi -p`）下默认无超时。前台模式下父 Agent 等待 subagent 完成再继续；后台模式立即返回任务 ID，完成时通过合成 User 消息自动回到 main agent。多个前台 `Agent` 调用在同一步运行时，TUI 会合并展示，并为每个 subagent 显示运行、等待、完成或失败状态以及已耗时长。subagent 体系细节见 [Agent 与 subagent](../customization/agents.md)。

**`AgentSwarm`** 可以从共享的 `prompt_template` 和 `items` 数组启动 subagent，也可以通过 `resume_agent_ids` 恢复已有 subagent，或在一次调用中同时使用两者。也可以改用 `prompts`（由至少 2 条互不相同的完整提示词组成的数组，每条对应一个 subagent）来代替 `items` 和 `prompt_template`；`prompts` 不能与二者同时传入。模板必须包含 `{{item}}` 占位符；每个 item 会替换该占位符，并启动一个新的 subagent。传入 `subagent_type` 可以指定整个 swarm 中所有新启动的 subagent 使用的 profile；省略时默认使用 `coder`。传入 `persona` 可为所有新启动的 subagent 统一应用一个 persona，或传入 `personas`——与 `items` 或 `prompts` 按位置一一对应，每项一条——为每个 subagent 分别指定；两者互斥。二者遵循与 `Agent` 相同的基座匹配规则：每个 persona 都必须通过 `extends` 指向本次 swarm 的基座 Agent（`subagent_type`；省略 `subagent_type` 时，以 persona 的 `extends` 为基座），缺少 `extends` 会以 `persona.base_required` 拒绝，基座不一致会以 `persona.base_mismatch` 拒绝。Persona 只会收窄工具、禁止工具与 subagent。恢复的 subagent 会忽略 `persona` 与 `personas` 并保留自己的角色，与 `fork` 同时传入则会被拒绝。二者都是实验功能，由 `agent_persona` flag 控制（`KIMI_CODE_EXPERIMENTAL_AGENT_PERSONA=1`，或 `config.toml` 中 `[experimental]` 下的 `agent_persona = true`）。传入 `model`（仅在启用 [subagent 模型池](../configuration/config-files.md#subagent-模型池) 实验功能并配置模型池后可用——`[secondary_model.models]` 表或仅一行 `default_model`）可以让新启动的 subagent 运行在池中别名指定的模型或调用方自己的模型（`"primary"`）上。未传入时新启动的 subagent 绑定池的 `default_model`；未配置模型池时则继承调用方模型。恢复的 subagent 保持其原有模型。不传 `resume_agent_ids` 时，本工具要求至少 2 个 item 或 prompt；传入 `resume_agent_ids` 时，可以恢复 1 个或多个已有 subagent。本工具最多支持 128 个 subagent，会等待全部 subagent 完成，并返回聚合报告。每个 subagent 默认 2 小时超时，可通过 `config.toml` 的 [`[swarm] timeout_ms`](../configuration/config-files.md#swarm)（`0` = 无超时，或 `KIMI_CODE_SWARM_TIMEOUT_MS` 环境变量）配置，且在 print 模式（`kimi -p`）下默认无超时；超时的 subagent 会被中止，并在聚合报告中标记为失败。在 TUI 中，前台 swarm 会在输入框上方显示实时 `Agent swarm` 进度面板。在 `manual` 权限模式下，未处于 swarm mode 时调用 `AgentSwarm` 会触发审批，除非已有权限规则允许；swarm mode 已开启时，`AgentSwarm` 本身会自动放行。权限规则只能按工具名 `AgentSwarm` 匹配，不支持 `AgentSwarm(swarm)` 这类参数模式。默认情况下，本工具会逐步提升并发且不设上限（立即启动 5 个 subagent，之后每 700 毫秒再启动 1 个）；将 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 设为正整数可限制该阶段同时运行的 subagent 数量，不设置则表示不限制。若设置为非正整数的值，本次 AgentSwarm 调用会立即失败。

**`SendMessage`** 向会话中的另一个 Agent 发送消息——`main`、父 Agent 或同级 Agent——用于询问信息、交付发现或回复收到的消息。`to` 接受 `main`、Agent 名称或原始 Agent id；`message` 是消息正文，`summary` 是可选的单行预览。运行中的接收方会在下一个步骤边界收到消息，空闲的 Agent 会在后台被唤醒，空闲的 `main` 则会开启新的轮次。**`ListAgents`** 不接受参数，列出可以发消息的 Agent 及其 id、名称和运行状态，并显示每个 Agent 的角色、父 Agent id、标签和派生状态；id 和名称仍然是用于寻址的句柄，且不会列出调用方自己。五个工具（`SendMessage`、`ListAgents`、`ListMessages`、`ReplyMessage` 和 `BroadcastMessage`）都是实验功能且默认启用：通过 `agent_messaging` flag 禁用（`KIMI_CODE_EXPERIMENTAL_AGENT_MESSAGING=0`，或 `config.toml` 中 `[experimental]` 下的 `agent_messaging = false`）。消息和回复以 `<agent-message>` 信封送达，属于来自其他 Agent 的不受信任输入——既不是用户审批，也不授予任何权限。

**`ListMessages`** 接受可选的 `from`（发送方 Agent 的 id 或名称）和 `limit`（默认 20，取值范围 1–100），按从新到旧的顺序返回调用方收到的消息。每条消息包含消息 id、发送方、投递模式和正文的简短预览，头部会报告有多少条消息已排入调用方的队列但尚未投递（`<N> queued, not yet delivered`）。**`ReplyMessage`** 接受 `message_id`（来自 `ListMessages` 的 id）、`message` 和可选的 `summary`；它会解析原发送方，并通过与 `SendMessage` 相同的路径投递回复，同时在信封上标记 `[re: <id>]`。id 未知时以 `message.not_found` 失败。**`BroadcastMessage`** 接受 `message` 和可选的 `summary`，按顺序向调用方可以寻址的每个 Agent 发送——与 `ListAgents` 相同的名册，绝不会包含调用方自己——并为每个接收方报告一行。单个接收方的失败（`queue_full`、`delivery_timeout`、`target_interrupted`）会作为数据报告，不会中断其他投递；只有调用方自己中止才会停止整个分发。没有其他可寻址的 Agent 时，它会报告没有可发送的对象。

**`AskUserQuestion`** 以结构化多选题的形式向用户提问，适用于需要消歧或选择方案的场景。`questions` 参数接受 1–4 道题，每道题需提供 `question`（以 `?` 结尾）、`options`（2–4 个选项，每项含 `label` 和 `description`）以及可选的 `header`（最多 12 字符）和 `multi_select`（默认 false）。系统自动附加"其他"选项。`background` 为 true 时启动后台问题任务并立即返回任务 ID。宿主未实现交互式提问能力时返回失败提示，Agent 应改为在文本回复中直接提问。

**`Skill`** 允许 Agent 主动调用已注册的 inline 类型 Skill。接受 `skill`（Skill 名称）和可选的 `args`（附加参数文本）。只有 `type = "inline"` 的 Skill 能通过此工具调用；`disableModelInvocation: true` 的 Skill 会被拒绝。嵌套调用深度上限 3 层。Skill 体系细节见 [Agent Skills](../customization/skills.md)。

## 集群控制

集群控制工具让 Agent 停止、移除、打标签和重命名其集群中的 Agent。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `StopAgent` | 需审批 | 取消单个 Agent 当前的运行，但不解除其名称 |
| `InterruptAgent` | 需审批 | 让单个 Agent 完成当前步骤后再停止 |
| `StopAgents` | 需审批 | 在一次调用中停止多个后台任务或 Agent |
| `DismissAgents` | 需审批 | 把你拥有的 Agent 从会话名册中移除 |
| `TagAgent` | 需审批 | 设置你拥有的 Agent 的标签 |
| `RenameAgent` | 需审批 | 重命名你拥有的 Agent |

**`StopAgent`** 接受 `agent_id` 和可选的 `reason`。它会取消目标当前的运行：活跃轮次、排队中的轮次，以及任何进行中的消息投递运行。停止不会解除目标的名称，之后发一条消息即可恢复它。Agent 不能停止自己，也不能停止 `main`。如果希望目标先完成当前步骤再停止，改用 `InterruptAgent`。

**`InterruptAgent`** 接受 `agent_id`。它会请求目标优雅停止：目标完成当前步骤——包括已经调用的工具——然后停止，而不是在步骤中途被取消。需要立即终止时使用 `StopAgent`。Agent 不能中断自己，也不能中断 `main`。

**`StopAgents`** 接受一个互斥选择器——`agent_ids`、`task_ids` 或 `all: true`——以及可选的 `include_foreground`（默认 `false`）和 `reason`。除非 `include_foreground` 为 true，否则前台任务会被排除，因为调用方可能正在等待它们。已处于终止状态的任务会按原样汇报，不会再次停止；结果会为每个请求的任务报告一段，状态为 `stopped`、`already_terminal`、`skipped_foreground` 或 `not_found`。停止不会解除名称，Agent 会保留其启动时获得的名称。

**`DismissAgents`** 接受一个互斥选择器——`ids`、`names` 或 `all: true`——并把你拥有的 Agent 从会话名册中移除。归属关系指直接父级：只有父级是调用方的 Agent 才能被移除。该工具会拒绝 `main`、调用方自身以及任何你不拥有的 Agent。它会在移除任何内容之前校验每个 id，因此被拒绝的调用不会移除任何内容。运行中的 Agent 会先被关闭再移除；ghost 条目——只有元数据而没有存活 Agent——只会被注销。

**`TagAgent`** 接受 `agent_id` 和 `tags`，后者最多包含 20 个标签。每个标签最多 32 个字符，且不能包含逗号，因为标签以逗号连接的形式存储在 Agent 的 `labels.tags` 中。传入 `tags: []` 可清空所有标签。只有你拥有的 Agent 才能打标签；`main`、调用方自身以及其他 Agent 的 subagent 都会被拒绝。打标签只改标签，绝不会中断或停止 Agent。

**`RenameAgent`** 接受 `agent_id` 和 `name`。新名称会像启动时选择的名称一样校验并保留（1–64 个字母、数字、`.`、`_` 或 `-`；`main` 为保留名称），因此在该 Agent 存活期间其他 Agent 无法占用它。Agent id 永远不会改变，Agent 仍可通过 id 寻址，标签也不受影响。只有你拥有的 Agent 才能重命名；`main`、调用方自身以及其他 Agent 的 subagent 都会被拒绝。

六个工具都是实验功能，默认关闭，由 `agent_fleet_control` flag 控制（`KIMI_CODE_EXPERIMENTAL_AGENT_FLEET_CONTROL=1`，或 `config.toml` 中 `[experimental]` 下的 `agent_fleet_control = true`）。它们不会自动放行，且停止与移除类工具在 Plan 模式下会被拦截。

## 后台任务

后台任务工具用于管理通过 `Bash`、`Agent` 或 `AskUserQuestion` 启动的后台任务。任务进入终止状态时会自动把状态和已保存的输出路径送回 Agent；如需提前检查进度，使用 `TaskOutput`；如果下一步必须等待某个任务的结果，使用 `WaitFor` 在当前轮次内等待。另有三个只读工具用于查看更全面的情况：`AgentResult` 按 agent id 读取子 Agent 的最终结果，`AgentHealth` 报告单个 Agent 的健康状态与后台容量，`WaitForAll` 在同一个截止时间下等待整批后台任务。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `TaskList` | 自动放行 | 列出后台任务 |
| `TaskOutput` | 自动放行 | 查看后台任务的输出 |
| `TaskStop` | 需审批 | 停止正在运行的后台任务 |
| `WaitFor` | 自动放行 | 等待后台任务结束 |
| `AgentResult` | 自动放行 | 按 agent id 读取子 Agent 的最新结果 |
| `AgentHealth` | 自动放行 | 查看单个 Agent 的派生健康状态与后台容量 |
| `WaitForAll` | 自动放行 | 在同一个截止时间下等待整批后台任务 |

**`TaskList`** 返回后台任务列表。可选参数 `active_only`（默认 true，仅列出运行中的任务）和 `limit`（默认 20，取值范围 1–100）。

**`TaskOutput`** 根据 `task_id` 返回任务状态与输出。内联预览最多包含最近 32 KB 的内容；完整日志保存在磁盘上，工具会一并返回 `output_path` 并提示通过 `Read` 分页读取。该调用始终是非阻塞的——立即返回当前快照，任务完成会通过自动通知送达。

**`TaskStop`** 接受 `task_id` 和可选的 `reason`（默认 `Stopped by TaskStop`）。对已处于终止状态的任务也能安全调用。

**`WaitFor`** 把当前轮次挂起，直到后台任务结束或超时。参数：`timeout`（必填，单位秒，上限 600）和可选的 `task_id`。不传 `task_id` 时，调用时刻运行中的任意一个后台任务结束即返回；当前没有运行中的后台任务时立即返回。超时不是错误——结果会列出仍在运行的任务，Agent 可以再次等待，也可以先处理其他工作。已通过 `WaitFor` 汇报结果的任务不会再推送自动完成通知。

**`AgentResult`** 只接受一个 `agent_id`（来自 `ListAgents`，或来自 `TaskList` 中 agent 类型的任务），并解析该 Agent 最近的一次 agent 任务：仍在运行的任务优先于更早结束的任务，因此尚未完成的 Agent 不会返回最终结果。返回内容是结构化的任务元数据，加上最多最近 32 KB 的输出（已完成的 subagent 即为它的最终消息），以及指向完整日志的 `output_path`；预览被截断时用 `Read` 读取完整日志。该工具是只读的：它不会停止、恢复或以其他方式改变 Agent 及其任务。读取结果既不会抑制也不会重复自动完成通知——结果只会通过最先到达的途径送达一次。

**`AgentHealth`** 接受 `agent_id`，返回该 Agent 的派生 `state`：`running`（循环正在处理一个轮次）、`stalled`（agent 任务仍在运行但循环空闲）、`orphaned`（元数据仍在，但没有存活的 Agent 句柄，已无法控制）、`lost`（任务在进程重启后残留，已无法再检查）、`idle`（Agent 存活且没有任务），或最后一个任务的终止状态（`completed`、`failed`、`timed_out`、`killed`）。除了状态之外，它还报告循环状态、当前轮次阶段与步骤、活跃工具、待审批项、上一轮次的结束原因、上下文 token 大小、累计输入 / 输出 token，以及 `background_capacity: <running>/<max>`（未配置上限时显示 `<running>/unlimited`）。`AgentHealth` 是只读工具，因此任何情况下都可以安全调用，包括在 Plan 模式下。

**`WaitForAll`** 在同一个共享截止时间下等待整批后台任务。参数：`timeout`（必填，单位秒，上限 600），以及可选的 `agent_ids` 或 `task_ids`——二者最多只能传一个；都不传则等待调用时刻所有运行中的后台任务。它在调用开始时对整批任务做一次快照，因此等待期间新启动的任务不在覆盖范围内，仍通过常规的自动通知汇报。已完成的任务会被标记为已送达，不再额外产生自动完成通知。超时不是错误：结果会报告 `completed`、`partial` 或 `timed_out`，列出已完成的任务和仍在运行的任务，Agent 可以再次调用 `WaitForAll` 继续等待。该工具对任务只读——它不会停止任何任务，中断等待也会让所有任务继续运行。

三个工具都是实验功能且默认启用：通过 `agent_messaging` flag 禁用（`KIMI_CODE_EXPERIMENTAL_AGENT_MESSAGING=0`，或 `config.toml` 中 `[experimental]` 下的 `agent_messaging = false`）。`WaitForAll` 还需要 `wait_for` flag，该 flag 默认开启。

## 定时任务

定时任务工具允许 Agent 把一段 prompt 在未来某个时间重新注入到当前会话——既可以是一次性提醒，也可以是按 cron 周期触发的任务（定期巡检、每日报表、部署监控等）。计划绑定到会话，用 `kimi --session` 恢复会话后仍然有效，但不会带入全新的会话。单个会话最多保留 50 个生效中的定时任务。设置 `KIMI_DISABLE_CRON=1` 可整体禁用，详见[环境变量](../configuration/env-vars.md#运行时开关)。

| 工具 | 默认审批 | 说明 |
| --- | --- | --- |
| `CronCreate` | 需审批 | 安排一个在未来时刻触发的 prompt |
| `CronList` | 自动放行 | 列出已安排的定时任务 |
| `CronDelete` | 需审批 | 取消已安排的定时任务 |

**`CronCreate`** 接受 `cron`（用户本地时区下标准的 5 段 cron 表达式：`minute hour day-of-month month day-of-week`）、`prompt`（触发时要注入的文本，UTF-8 上限 8 KB）以及可选的 `recurring`（默认 `true`；传 `false` 表示一次性提醒，触发后自动删除）。成功时返回 8 位 16 进制 `id`、人类可读的 `humanSchedule`（如 `every 5 minutes`）和 `nextFireAt`（下次触发时间的 ISO 时间戳）。

为避免整批用户在整点同时触发，调度器会做确定性抖动：周期任务向后偏移 `min(周期的 10%, 15 分钟)`；一次性任务若恰好落在 `:00` 或 `:30` 则向前提前最多 90 秒。如果调度器错过了若干触发时刻（如笔记本合盖），唤醒后只会触发一次，prompt 会包裹在 `<cron-fire>` 信封里并附带 `coalescedCount`。周期任务存活超过 7 天后会以 `stale="true"` 做最后一次触发后自动删除；想继续保留时，再次调用 `CronCreate` 即可。

**`CronList`** 是只读工具，不接受任何参数。为每个生效中的任务返回一条记录，字段包括 `id`、`cron`、`humanSchedule`、`nextFireAt`、`recurring`、`ageDays` 和 `stale`。记录用 `---` 分隔，按调度时间排列。

**`CronDelete`** 只接受一个 `id`。对周期任务，未来所有触发立即停止；对一次性任务，挂起的那次触发会被取消。已触发的一次性任务会自动删除，因此对已触发过的一次性任务调用 `CronDelete` 会返回 `No cron job with id ...`。删除不可撤销，需要还原时只能再次 `CronCreate`。`CronDelete` 在 Plan 模式下同样会被拦截。

## 下一步

- [Agent 与 subagent](../customization/agents.md) — `Agent` 工具的调度机制与上下文隔离
- [Hooks](../customization/hooks.md) — 在工具调用前后触发本地脚本
- [斜杠命令](./slash-commands.md) — TUI 内置控制命令速查
