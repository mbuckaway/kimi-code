import type { TowerMission } from '#/features/tower/protocol/index';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { runTowerTool } from '../support';
import DESCRIPTION from './status.md?raw';
import {
  ITowerStatusTool,
  TowerStatusToolInputSchema,
  type TowerStatusToolInput,
} from './status';
import {
  readTowerStatus,
  type TowerStatusConcurrency,
  type TowerStatusDeathWarning,
  type TowerStatusGate,
  type TowerStatusState,
} from './statusReader';

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

const DEFAULT_LIMIT = 20;

export class TowerStatusTool implements ITowerStatusTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerStatus' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerStatusToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITowerRateLimitService private readonly rateLimit: ITowerRateLimitService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
  ) {}

  resolveExecution(args: TowerStatusToolInput): ToolExecution {
    const limit = args.limit ?? DEFAULT_LIMIT;
    return {
      description: 'Reading tower status',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const status = await readTowerStatus({
            active: this.tower.isActive,
            cwd: this.sessionContext.cwd,
            agentId: this.scopeContext.agentId,
            concurrency: () => this.rateLimit.snapshot(),
            agentTasks: () => this.tasks.list(),
          });
          if (!status.initialized) {
            if (status.stateLost) {
              return { output: renderStateLostReport() };
            }
            return {
              output: 'tower is not initialized in this repository — run TowerInit first',
              isError: true,
            };
          }
          if (!status.active) return { output: '# Tower status — OFF' };
          const { state, caller, gate, inbox, concurrency, recentActivity, deadWorkers } = status;
          const sections: string[] = [
            `# Tower status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
            '',
            ...renderRecoveredAtWarning(state),
            '## Missions',
            '',
            ...renderMissions(state, limit),
            ...renderUnspawnedMissions(state, limit),
            ...renderDeathWarnings(deadWorkers, limit),
            '',
            '## Roster',
            '',
            ...renderRoster(state, limit),
            '',
            '## Review gate (unmerged branches)',
            '',
            ...renderReviewGate(state, gate, limit),
          ];

          if (
            state.missions.length > 0 &&
            state.missions.every(
              (mission) => mission.status === 'merged' || mission.status === 'abandoned',
            )
          ) {
            sections.push(
              '',
              '## Done',
              '',
              'All missions are merged or abandoned. Free the worktree checkouts now: run TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).',
            );
          }

          sections.push(
            '',
            '## Inbox',
            '',
            `${String(inbox.count)} message(s) visible to you — read with TowerInbox.`,
            '',
            '## Concurrency (adaptive)',
            '',
            renderConcurrency(concurrency),
            '',
            '## Recent activity',
            '',
            ...(recentActivity.length > 0 ? recentActivity : ['(activity log is empty)']),
          );
          return { output: sections.join('\n') };
        }),
    };
  }
}

function renderStateLostReport(): string {
  return [
    '# Tower status — STATE LOST',
    '',
    '.tower/comms/state.json is missing but the .tower/ directory still exists — this tower was initialized here before, and its comms state was deleted (e.g. by git clean). All recorded mission, roster, and review history is lost.',
    '',
    'Report this history loss to the user now — continuing silently would pretend the loss never happened.',
    '',
    'What still works:',
    '- TowerSend and TowerComplete recover a minimal state automatically (stamped recoveredAt, base taken from the current checkout branch) and keep delivering messages — worker reports are not lost.',
    '- TowerMerge and TowerRebase refuse with an explicit state-lost error instead of silently running against an empty history.',
    '- Mission branches and worktrees under .tower/worktrees survive on disk; re-plan from that evidence only after the user decides how to proceed.',
  ].join('\n');
}

function renderRecoveredAtWarning(state: TowerStatusState): string[] {
  if (state.recoveredAt === undefined) return [];
  return [
    '## ⚠️ State recovered after a loss',
    '',
    `This tower's state was reconstructed at ${state.recoveredAt} after .tower/comms/state.json was lost — every mission, roster entry, and review from before that point is gone, so the lists below are the recovered minimum, not reality. Report the history loss to the user before continuing routine orchestration.`,
    '',
  ];
}

function renderReviewGate(
  state: TowerStatusState,
  gate: readonly TowerStatusGate[],
  limit: number,
): string[] {
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  if (pending.length === 0) return ['(no open missions — or none planned yet)'];
  const visible = gate.slice(-limit).toReversed();
  const lines: string[] = [
    `Showing ${String(visible.length)} of ${String(pending.length)} open mission(s), newest first.`,
    '',
  ];
  for (const missionGate of visible) {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : `; review=round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} binding=${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      lines.push(
        `- ${missionGate.branch} (${missionGate.missionId}): READY reasons=none${missionGate.noop ? '; zero-diff survey no-op, review skipped' : ''}${reviewText}`,
      );
      continue;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(',');
    const details = missionGate.blocks
      .map((block) => block.message.replace(/^merge blocked: /, ''))
      .join(' | ');
    lines.push(
      `- ${missionGate.branch} (${missionGate.missionId}): BLOCKED reasons=${reasons}; ${details}${reviewText}`,
    );
  }
  return [
    ...lines,
    ...renderOmission(pending.length - visible.length, 'review gate entries'),
  ];
}

function renderConcurrency(snapshot: TowerStatusConcurrency): string {
  const budget = Number.isFinite(snapshot.budget) ? String(snapshot.budget) : 'unlimited';
  const parts = [`budget: ${budget} agent(s) · inflight: ${String(snapshot.inflight)}`];
  if (snapshot.blockedUntil !== null) {
    const remainingMs = snapshot.blockedUntil - Date.now();
    parts.push(
      remainingMs > 0
        ? `spawns PAUSED for ~${String(Math.ceil(remainingMs / 1000))}s (provider rate limit — successful requests lift the pause early)`
        : 'spawn pause expired — budget probing resumes',
    );
  } else {
    parts.push('spawns open');
  }
  return parts.join(' · ');
}

function renderMissions(state: TowerStatusState, limit: number): string[] {
  if (state.missions.length === 0) return ['(no missions planned — use TowerPlan)'];
  const counts = new Map<TowerMission['status'], number>();
  for (const mission of state.missions) {
    counts.set(mission.status, (counts.get(mission.status) ?? 0) + 1);
  }
  const totals = [...counts]
    .map(([status, count]) => `${String(count)} ${status}`)
    .join(', ');
  const visible = state.missions.slice(-limit).toReversed();
  return [
    `Showing ${String(visible.length)} of ${String(state.missions.length)} mission(s), newest first.`,
    `Status totals: ${totals}.`,
    '',
    '| ID | Mission | Branch | Worktree | Status | Owner | Kind |',
    '| -- | ------- | ------ | -------- | ------ | ----- | ---- |',
    ...visible.map(
      (mission) =>
        `| ${mission.id} | ${mission.title}${mission.kind === 'survey' ? ' 🔍' : ''} | ${mission.branch} | ${mission.worktree} | ${STATUS_EMOJI[mission.status]} ${mission.status} | ${mission.owner ?? '—'} | ${mission.kind} |`,
    ),
    ...renderOmission(state.missions.length - visible.length, 'missions'),
  ];
}

function renderRoster(state: TowerStatusState, limit: number): string[] {
  if (state.roster.agents.length === 0) {
    return ['(no agents registered — spawn workers/reviewers with TowerSpawn)'];
  }
  const workers = state.roster.agents.filter((agent) => agent.kind === 'worker').length;
  const reviewers = state.roster.agents.length - workers;
  const visible = [...state.roster.agents]
    .toSorted((a, b) => b.spawnedAt.localeCompare(a.spawnedAt))
    .slice(0, limit);
  const lines = visible.map((agent) => {
    const assignment =
      agent.kind === 'worker'
        ? `mission ${agent.missionId ?? '?'} (branch ${agent.branch ?? '?'}, worktree ${agent.worktree ?? '?'})`
        : `reviewing ${agent.reviewTarget ?? '?'}`;
    const death = agent.diedAt === undefined ? '' : ` — 💀 ${agent.deathStatus ?? 'died'}`;
    const runtime =
      agent.runtime === undefined
        ? ''
        : ` · task ${agent.runtime.taskStatus}${agent.runtime.stopReason === undefined ? '' : ` (${agent.runtime.stopReason})`}`;
    return `- ${agent.name} (${agent.kind}) — agent ${agent.agentId}, ${assignment}${death}${runtime}`;
  });
  return [
    `Showing ${String(visible.length)} of ${String(state.roster.agents.length)} agent(s) (${String(workers)} workers, ${String(reviewers)} reviewers), newest spawned first.`,
    '',
    ...lines,
    ...renderOmission(state.roster.agents.length - visible.length, 'roster entries'),
  ];
}

function renderUnspawnedMissions(state: TowerStatusState, limit: number): string[] {
  const pending = state.missions.filter(
    (mission) => mission.status === 'planned' && mission.owner === undefined,
  );
  if (pending.length === 0) return [];
  const visible = pending.slice(-limit).toReversed();
  return [
    '',
    '## Awaiting spawn',
    '',
    `Showing ${String(visible.length)} of ${String(pending.length)} planned mission(s), newest first.`,
    '',
    ...visible.map(
      (mission) =>
        `- ${mission.id} [${mission.kind}] (${mission.branch}) — planned but no worker spawned yet: launch one with TowerSpawn(kind="worker", mission_id="${mission.id}", name="...")`,
    ),
    ...renderOmission(pending.length - visible.length, 'awaiting-spawn missions'),
  ];
}

function renderDeathWarnings(
  warnings: readonly TowerStatusDeathWarning[],
  limit: number,
): string[] {
  if (warnings.length === 0) return [];
  const visible = warnings.slice(0, limit);
  return [
    '',
    '## Dead workers',
    '',
    `Showing ${String(visible.length)} of ${String(warnings.length)} death warning(s), newest death first.`,
    '',
    ...visible.map((warning) =>
      warning.stoppedByUser
        ? `- 🛑 ${warning.missionId} ${warning.kind} ${warning.name} was stopped by the user (${warning.deathStatus ?? 'unknown'}) — dead by intent: never resume it and do not reassign the mission unless the human asks`
        : warning.kind === 'reviewer'
          ? `- ⚠️ ${warning.missionId} reviewer ${warning.name} died (${warning.deathStatus ?? 'unknown'}) — diagnose first: check the death status/reason and task state. A reviewer is one-shot: do not resume it or another roster agent; after diagnosis, spawn a fresh reviewer only if the mission still needs one`
          : `- ⚠️ ${warning.missionId} owner ${warning.name} died (${warning.deathStatus ?? 'unknown'}) — diagnose first: check why it died (the died entry's status/reason, its task state) before reviving anything. Resume it only when the cause is transient (lost contact, timeout, OOM); a systematic cause (code or environment defect) is fixed or escalated to the human before any revive`,
    ),
    ...renderOmission(warnings.length - visible.length, 'death warnings'),
  ];
}

function renderOmission(omitted: number, noun: string): string[] {
  if (omitted === 0) return [];
  return [
    '',
    `${String(omitted)} earlier ${noun} omitted; call TowerStatus with a larger limit to inspect them.`,
  ];
}
