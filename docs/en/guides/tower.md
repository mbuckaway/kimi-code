# Tower Mode

Tower mode is a multi-agent collaboration mode for larger development tasks. It splits the work into missions (subtasks) and runs each one asynchronously in its own Git worktree, so independent work proceeds in parallel instead of waiting on a single sequence.

While Tower is active, the main agent becomes the tower and coordinates the workers. You can follow progress, relay instructions, redirect or reprioritize work, and stop any agent while the workers run in the background.

For build missions, the tower also arranges independent reviews of each worker's changes. Every mission has its own branch and Git worktree: workers develop and commit there, and reviewers inspect the corresponding branch read-only. The tower routes messages and completion reports, and merges only the branches that pass its checks.

Tower is therefore neither an ordinary subagent call nor an `AgentSwarm` task. It persists repository state under `.tower/`, provides merge checks and cleanup commands, and is designed for responsiveness and parallel development.

::: warning
Workers and reviewers run in `auto` permission mode: their tool approvals are handled automatically and they do not ask you questions. The coordinating agent still follows your session's permission mode.
:::

## When Tower fits

Use Tower when the work can run in parallel and you accept the extra token consumption and disk usage.

Good candidates include:

- The task can be split into relatively independent missions with clear verification methods, so parallel work reduces waiting time.
- Requirements are still evolving, and you expect to provide new input, redirect work, or change priorities frequently.
- You want every change reviewed carefully, with its own branch and a corresponding review.

## Enable or disable Tower

Tower mode is enabled by default: `/tower` is already in the command list and no configuration change is needed.

To turn it off persistently, add this to `config.toml` (by default, `~/.kimi-code/config.toml`; see [Config files](../configuration/config-files.md#experimental)):

```toml
[experimental]
tower = false
```

You can also toggle **Tower mode** in `/experiments`. To disable Tower for one process only, set this environment variable before launch:

```sh
KIMI_CODE_EXPERIMENTAL_TOWER=0 kimi
```

Tower tools and the tower-worker profile load only at process startup. If you change `/experiments` or `config.toml` while Kimi Code is running, restart Kimi Code for the change to take effect.

Before starting, check out the local branch that should receive the changes and inspect the worktree:

```sh
cd /path/to/project
git status
```

Tower can merge only into a local branch, not a remote-tracking ref or tag. When Tower initializes its workspace, it records the branch checked out at that moment as the base. To use another branch, check it out first (or create it); a detached HEAD has no base to record. Using an existing branch with a clean worktree is the safest option.

::: warning
The project must already be a Git repository with at least one commit. Tower may also snapshot uncommitted and untracked files from the base checkout into worker branches, so check for secrets and large files before starting.
:::

## Run a workflow

1. **Activate Tower.** Run `/tower on`. On first initialization, the branch checked out at that moment becomes the base; on later activations, Tower reuses the recorded base. This command only enables Tower and sends no objective.

   To enable Tower and send the objective in one step, run `/tower <objective>`, for example `/tower split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review`.

2. **Send the development objective.** If Tower is already on, enter the task as a normal chat message. It is best to include how to verify the work and what completion means. Tower initializes `.tower/`, plans missions, and starts workers whose dependencies are satisfied in the background. When a worker finishes or Tower receives an inbox message, Tower resumes automatically, so you do not need to poll repeatedly.

3. **Let the work proceed in the background.** Workers commit changes on their branches. For build missions, Tower assigns independent reviewers; for artifact missions, it waits for your explicit acceptance. Tower rebases when needed and merges approved missions in dependency order. Handle approval prompts and questions about scope or priority when they appear.

4. **Verify the merged result.** Inspect `git status`, the base branch history, and the final diff, and run the tests or acceptance checks you care about. These checks are only a baseline safeguard and do not replace human acceptance.

5. **Clean up and exit.** After every mission is merged or abandoned, run `/tower teardown` to remove eligible mission worktrees and exit Tower. Use `/tower off` instead when you want to leave Tower without cleaning up. See [Stop, teardown, and restart](#stop-teardown-and-restart) for the differences between these actions.

## Choose a mission kind

Tower supports three mission kinds. Choose according to what the worker may write and what must happen before the mission closes.

- **Build (`kind: "build"`)**: reserves its scope for code changes, requires a committed diff and an independent clean review, and performs a real merge.
- **Artifact (`kind: "artifact"`)**: reserves its scope for business deliverables such as rendered results, training outputs, or analysis reports. It requires key committed deliverables and your explicit acceptance of the entire committed tip, but no independent reviewer, followed by a real merge.
- **Survey (`kind: "survey"`)**: treats its scope as informational, remains read-only, and closes with zero diff, no review, and no Git merge.

Use `artifact` when the work reads business inputs but must write deliverables. For example: "Create an artifact mission for the quarterly analysis. Commit `reports/q3/summary.html` and `reports/q3/data.csv`, then show me those files for acceptance."

The worker commits all deliverables inside the reserved scope and marks `reports/q3/summary.html` and `reports/q3/data.csv` as key artifacts; uncommitted files are not accepted or merged. Tower presents the key artifacts and the number of additional committed files, with an optional full manifest when you want more detail. Your approval authorizes the entire current tip, including changes not shown in the key-artifact list. Requested changes trigger rework, and any new commit or rebase requires fresh acceptance. In automatic or noninteractive runs, Tower leaves the artifact waiting rather than approving it for you.

## Check status and intervene

You do not need to understand the worker communication protocol to monitor and intervene in Tower.

- **Read the dashboard:** `/tower` or `/tower status` asks the agent to read the current state with `TowerStatus` and summarize it. The summary covers the base, missions, roster, merge checks, inbox count, concurrency, and recent activity.
- **Redirect work:** while Tower is active, send a normal message to add constraints, change priorities, or request a summary. After Tower relays a message to a worker, the worker sees it at its next step without interrupting the current tool call.
- **Inspect or stop an agent:** open `/tasks` to view background agent progress and output, and stop one if needed. For a worker or reviewer you stop deliberately, Tower does not resume, reassign, or replace it unless you say otherwise.
- **Check a worker death:** `/tower status` flags a mission whose owner or reviewer died. Diagnose first: inspect its status, reason, and task state, and resume it only for a transient cause such as lost contact or a timeout. Fix or escalate a systematic cause before any revive.
- **One coordinator per workspace:** if another live session owns Tower for this project and is busy, the current session cannot enable it. If that session is idle, enabling Tower here takes over ownership.

## Understand merges and rebases

Before merging a mission, Tower confirms that it is complete and that its branch is up to date with the base. A build mission requires a valid clean review and merge approval, usually from an independent reviewer. An artifact mission instead requires your explicit acceptance of the exact branch tip; an independent review cannot substitute for it. A survey remains zero-diff and needs no review. Changes must stay within the mission scope, the main checkout must be on the recorded base, and there must be no conflicting uncommitted changes.

For a build or artifact mission, after the base advances, if the worker is idle and the worktree is clean, Tower can rebase the mission branch onto the new base in the corresponding worktree. If there are no conflicts, a build mission's existing clean review binding is preserved; an artifact mission always requires fresh acceptance after the tip moves. If a conflict occurs, the rebase is aborted and the worker resolves it.

Let Tower handle merges and rebases; do not run additional Git integration commands yourself. Do not edit files under `.tower/comms/` directly: status, notifications, and merge checks depend on these records. You can inspect branches and worktrees read-only.

## Stop, teardown, and restart

These actions clean up different things:

| Action | What it does | What remains |
| --- | --- | --- |
| `/tower off` | Exits Tower mode in the current session without stopping background agents or cleaning up files | `.tower/`, mission branches, and worktrees |
| `/tower teardown` | Asks the agent to remove eligible mission worktrees and report the result, then exits Tower mode; worktrees with uncommitted changes are kept unless forced | Mission branches and `.tower/comms/` audit records |
| Exit Kimi Code or close the session | Stops Tower workers and reviewers; they must be spawned again later | On-disk `.tower/` state, branches, and worktrees |

After Kimi Code restarts, if another session takes over the project, the previous session's roster entries become inactive, but missions and worktrees are preserved. The new coordinator must spawn workers again. A project cannot have two tower coordinators at the same time.

## Mode exclusivity

Tower is mutually exclusive with Goal, Plan, and swarm modes. Entering Tower exits Plan or swarm and pauses the active goal; activating a goal or entering Plan or swarm also exits Tower. Tower state remains on disk, and you can return later with `/tower on`.

## Safety and resource cost

Worktrees isolate writes, but they are not a security sandbox. Workers can read repository content and run tools with your permissions. In `auto` permission mode, workers and reviewers do not request your approval for individual actions. Tower workers do not have the `Agent` tool and cannot spawn subagents. Mission scopes and merge checks are process constraints, not security boundaries.

Each worker and reviewer has an independent model context and consumes tokens separately. Tower's planning, message routing, recovery, and merge turns also consume tokens. More agents increase pressure on quota, CPU, and disk. Tower caps concurrently running workers and reviewers at a combined total of 256, and `/tower status` reports the current budget and running count in its summary. Start with a small number of independent missions and remove finished worktrees to reclaim disk space.

## Next steps

- [Environment variables](../configuration/env-vars.md#runtime-switches) — `KIMI_CODE_EXPERIMENTAL_TOWER` and related runtime switches
- [Config files](../configuration/config-files.md#experimental) — the `[experimental] tower` setting
- [Agents and Subagents](../customization/agents.md) — simpler delegation for focused subtasks
