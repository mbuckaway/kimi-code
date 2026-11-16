# tower 模式

tower 模式是一种面向较大开发任务的多 Agent 协作模式。它把工作拆成多个 mission（子任务），让每个 mission 在独立的 Git worktree 中异步执行，因此相互独立的工作可以并行推进，不必逐个等待。

tower 开启期间，main agent 会成为 tower，负责协调这些 worker。worker 在后台运行时，你可以查看进展、传递指令、调整方向或优先级，也可以随时停止某个 Agent。

对于 build mission，tower 还会安排独立 review 检查每个 worker 的改动。每个 mission 都有独立的 branch 和 Git worktree：worker 在其中开发和提交，reviewer 以只读方式审查对应 branch。tower 负责传递消息和完成报告，只合并通过检查的 branch。

因此，tower 既不是普通的 subagent 调用，也不是 `AgentSwarm` 任务。它会把仓库状态保存在 `.tower/` 下，提供合并检查和清理命令，并针对及时响应和并行开发做了优化。

::: warning 注意
worker 和 reviewer 以 `auto` 权限模式运行：工具审批会自动处理，它们不会向你提问。tower 主控仍遵循当前会话的权限模式。
:::

## 适用场景

是否使用 tower，主要看任务能否并行，以及你是否接受更多的 token 消耗和磁盘占用。

一些合适的场景：

- 任务可以拆成多个相对独立、验证方式明确的 mission，并行推进能省去等待时间
- 需求仍在变化，需要频繁传达新要求、调整方向或优先级
- 希望每次改动都被仔细审核，有独立的 branch 和对应 review

## 启用与关闭 tower

tower 模式默认启用：`/tower` 已经在命令列表中，无需修改任何配置。

如需长期关闭，在 `config.toml`（默认位于 `~/.kimi-code/config.toml`，详见[配置文件](../configuration/config-files.md#experimental)）中加入：

```toml
[experimental]
tower = false
```

也可以在 `/experiments` 中关闭 **Tower mode**。如果只想在当前进程中关闭，可在启动前设置环境变量：

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=0 kimi
```

tower 的工具和 tower-worker profile 只在进程启动时加载。运行过程中修改 `/experiments` 或 `config.toml` 后，需要重启 Kimi Code 才会生效。

开始之前，先切换到最终接收改动的本地 branch，并检查工作区状态：

```sh
cd /path/to/project
git status
```

tower 的合并目标必须是本地 branch，不能是 remote-tracking ref 或 tag。tower 初始化工作区时，会把当时检出的 branch 记录为 base。如需使用其他 branch，请先切换或创建它；detached HEAD 没有可记录的 base。使用已有 branch 并保持工作区干净，是最稳妥的做法。

::: warning 注意
项目必须已经是 Git 仓库，并且至少有一个 commit。tower 还可能把 base checkout 中未提交和未跟踪的文件快照到 worker branch 中，开始前请确认其中没有机密文件或超大文件。
:::

## 从启动到合并

1. **开启 tower。** 输入 `/tower on`。第一次初始化时，当时检出的 branch 会成为 base；以后开启时会沿用已记录的 base。这个命令只开启 tower，不会发送任务目标。

   如果要在开启的同时发送目标，可以输入 `/tower <objective>`，例如 `/tower 把结算文档更新拆成相互独立的 mission，分别测试，只合并通过独立 review 的 branch`。

2. **发送开发目标。** 如果 tower 已经开启，像平常对话一样输入任务即可。最好同时说明如何验证、什么情况下算完成。tower 会初始化 `.tower/`、规划 mission，并在后台启动依赖已经满足的 worker。worker 完成任务或 tower 收到 inbox 消息时，tower 会自动继续处理，不用你反复查询。

3. **让任务在后台推进。** worker 会在各自的 branch 上提交改动。对于 build mission，tower 会安排独立 reviewer；对于 artifact mission，tower 会等待你明确验收。必要时 tower 会 rebase，并按依赖顺序合并通过审核的 mission。如果出现审批提示，或 tower 询问任务范围和优先级，请及时处理。

4. **验收合并结果。** 检查 `git status`、base branch 的提交历史和最终 diff，并运行你关心的测试或验收命令。这些检查只能作为基础保障，不能替代人工验收。

5. **清理并退出。** 所有 mission 都已合并或放弃后，输入 `/tower teardown` 移除可以移除的 mission worktree 并退出 tower。如果只想离开 tower 而不清理文件，改用 `/tower off`。不同操作的区别见[停止、清理与重启](#停止清理与重启)。

## 选择 mission 类型

tower 支持三种 mission 类型。可以根据 worker 能否写入产物以及关闭 mission 前需要哪些检查来选择。

- **Build（`kind: "build"`）**：为代码改动预留 scope，要求有已提交的 Diff 和独立 clean review，最后执行实际合并。
- **Artifact（`kind: "artifact"`）**：为渲染结果、训练结果、分析报告等业务产物预留 scope。不要求独立 reviewer，但必须指定已提交的关键产物，并由你明确验收整个已提交的 tip，然后执行实际合并。
- **Survey（`kind: "survey"`）**：scope 仅用于说明调查范围，全程只读，最终以 zero-diff 关闭，不需要 review，也不执行 Git merge。

当工作需要读取业务输入并写出交付物时，使用 `artifact`。例如："创建一个 artifact mission 生成季度分析，提交 `reports/q3/summary.html` 和 `reports/q3/data.csv`，然后把这些文件交给我验收。"

worker 会在预留的 scope 内提交所有交付物，并将 `reports/q3/summary.html` 和 `reports/q3/data.csv` 标记为关键产物；未提交的文件不会参与验收或合并。tower 展示关键产物和其他已提交文件的数量，需要查看细节时也可以打开完整清单。你的批准覆盖当前整个 tip，包括未列入关键产物清单的改动。你提出修改时会进入返工，任何新 commit 或 rebase 后都需要重新验收。在自动或其他非交互场景中，tower 会让产物保持等待，不会替你自行验收。

## 查看状态并干预

你不需要了解 worker 间的通讯协议，也能查看和干预 tower。

- **查看状态面板：** `/tower` 或 `/tower status` 会让 Agent 调用 `TowerStatus` 读取当前状态并汇总。汇总内容包括 base、mission、roster、合并检查、inbox 数量、并发情况和近期活动。
- **调整任务方向：** tower 开启期间，直接发送普通消息即可补充约束、调整优先级或要求总结。tower 把消息转给 worker 后，worker 会在下一步看到，不会打断当前工具调用。
- **检查或停止 Agent：** 打开 `/tasks` 查看后台 Agent 的进展和输出，必要时可以停止其中一个。对于你主动停止的 worker 或 reviewer，tower 默认不会恢复、改派或替换，除非你另有指示。
- **检查 worker 死亡：** `/tower status` 会标出 owner 或 reviewer 已死亡的 mission。先诊断：查看其状态、原因和任务状态，只有遇到失联、超时等临时原因时才恢复；系统性问题要先修复或上报，再决定是否恢复。
- **每个工作区只有一个主控：** 如果另一个活跃会话正在使用本项目的 tower 且处于忙碌状态，当前会话无法开启；如果那个会话空闲，在这里开启 tower 会接管所有权。

## 合并与 rebase 规则

合并 mission 前，tower 会确认 mission 已完成，并且 branch 已跟上 base。build mission 需要有效的 clean review 和 merge 批准，通常来自独立 reviewer。artifact mission 则需要你在当前 branch tip 上明确验收，独立 review 不能替代。survey 始终保持 zero-diff，不需要 review。改动必须属于 mission 范围，主 checkout 必须位于记录的 base，且不能有与合并内容冲突的未提交改动。

对于 build 或 artifact mission，base 更新后，如果 worker 空闲且 worktree 干净，tower 可以在对应 worktree 中把 mission branch rebase 到新 base。无冲突时，build mission 原有 clean review 的绑定会保留；artifact mission 在 tip 变化后总是需要重新验收。发生冲突时，rebase 会中止，并交回 worker 处理。

合并和 rebase 都交给 tower 完成，不要另外手动执行 Git 整合命令。不要直接编辑 `.tower/comms/` 下的文件，状态、通知和合并检查都依赖这些记录。你可以只读查看 branch 和 worktree。

## 停止、清理与重启

这些操作的清理范围不同：

| 操作 | 作用 | 保留内容 |
| --- | --- | --- |
| `/tower off` | 退出当前会话的 tower 模式，不停止已在后台运行的 Agent，也不清理文件 | `.tower/`、mission branch 和 worktree |
| `/tower teardown` | 让 Agent 移除符合条件的 mission worktree 并报告结果，然后退出 tower 模式；有未提交改动的 worktree 默认保留 | mission branch 和 `.tower/comms/` 审计记录 |
| 退出 Kimi Code 或关闭会话 | 停止 tower worker 和 reviewer，之后需要重新派发 | 磁盘上的 `.tower/` 状态、branch 和 worktree |

Kimi Code 重启后，如果改由另一个会话接管当前项目，原会话的 roster 条目会失效，但 mission 和 worktree 会保留；新的主控需要重新派发 worker。一个项目不能同时存在多个 tower 主控。

## 模式互斥

tower 与 Goal、Plan 和 swarm 模式互斥。进入 tower 会退出 Plan 或 swarm，并暂停正在运行的 goal；启用 goal、Plan 或 swarm 也会退出 tower。tower 的状态会保留在磁盘上，之后可以用 `/tower on` 返回。

## 安全边界与资源开销

worktree 只能隔离写入，不能当作安全沙箱。worker 可以读取仓库内容，并以你的权限运行工具；在 `auto` 权限模式下，worker 和 reviewer 不会逐项向你请求审批。tower worker 没有 `Agent` 工具，不能再派发 subagent。不过，mission 范围和合并检查只是流程约束，不是安全边界。

worker 和 reviewer 都有独立的模型上下文，也会分别消耗 token。tower 的规划、消息路由、故障恢复和合并轮次还会产生额外消耗。Agent 越多，配额、CPU 和磁盘压力越大。tower 同时运行的 worker 和 reviewer 合计最多 256 个，`/tower status` 的汇总会显示当前数值预算和运行数量。建议先拆少量相互独立的 mission，完成后及时清理 worktree，释放磁盘空间。

## 下一步

- [环境变量](../configuration/env-vars.md#运行时开关) — `KIMI_CODE_EXPERIMENTAL_TOWER` 及相关运行时开关
- [配置文件](../configuration/config-files.md#experimental) — `[experimental] tower` 设置
- [Agent 与 subagent](../customization/agents.md) — 适合聚焦子任务的简单委派方式
