import { userCancellationReason } from '#/_base/utils/abort';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { TERMINAL_STATUSES, type AgentTaskInfo, type AgentTaskStatus } from '#/agent/task/types';
import {
  mapWithConcurrency,
  resolveTowerRepoRoot,
  TOWER_GIT_CONCURRENCY,
  TowerStore,
  type TowerMissionGateBlock,
  type TowerReviewBinding,
  type TowerRosterEntry,
  type TowerState,
} from '#/features/tower/protocol/index';

import { callerName } from '../support';

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export interface TowerStatusConcurrency {
  readonly budget: number;
  readonly inflight: number;
  readonly blockedUntil: number | null;
}

export interface TowerStatusAgentRuntime {
  readonly taskStatus: AgentTaskStatus;
  readonly stopReason?: string;
}

export interface TowerStatusRosterEntry extends TowerRosterEntry {
  readonly runtime?: TowerStatusAgentRuntime;
}

export interface TowerStatusState {
  readonly base: TowerState['base'];
  readonly mode: TowerState['mode'];
  readonly recoveredAt?: string;
  readonly missions: TowerState['missions'];
  readonly roster: { readonly agents: readonly TowerStatusRosterEntry[] };
}

export interface TowerStatusReview {
  readonly reviewer: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
}

export interface TowerStatusGate {
  readonly missionId: string;
  readonly branch: string;
  readonly ready: boolean;
  readonly noop: boolean;
  readonly blocks: readonly TowerMissionGateBlock[];
  readonly selectedReview?: TowerStatusReview;
  readonly reviewBinding?: TowerReviewBinding;
}

export interface TowerStatusDeathWarning {
  readonly missionId: string;
  readonly name: string;
  readonly agentId: string;
  readonly kind: TowerRosterEntry['kind'];
  readonly diedAt: string;
  readonly deathStatus?: string;
  readonly deathReason?: string;
  readonly stoppedByUser: boolean;
}

export interface InitializedTowerStatus {
  readonly active: boolean;
  readonly initialized: true;
  readonly state: TowerStatusState;
  readonly caller: string;
  readonly gate: readonly TowerStatusGate[];
  readonly inbox: { readonly count: number };
  readonly concurrency: TowerStatusConcurrency;
  readonly recentActivity: readonly string[];
  readonly deadWorkers: readonly TowerStatusDeathWarning[];
}

export type ActiveTowerStatus = InitializedTowerStatus & { readonly active: true };

export type TowerStatus =
  | { readonly active: boolean; readonly initialized: false; readonly stateLost: boolean }
  | InitializedTowerStatus;

export interface ReadTowerStatusInput {
  readonly active: boolean;
  readonly cwd: string;
  readonly agentId: string;
  readonly concurrency: () => TowerStatusConcurrency;
  readonly agentTasks?: () => readonly AgentTaskInfo[];
}

export async function readTowerStatus(input: ReadTowerStatusInput): Promise<TowerStatus> {
  const store = new TowerStore(resolveTowerRepoRoot(input.cwd));
  const initialized = await store.isInitialized();
  if (!initialized) {
    return { active: input.active, initialized: false, stateLost: await store.isStateLost() };
  }

  const state = await store.load();
  const tasks = input.agentTasks?.();
  const caller = resolveCaller(store, state, input.agentId);
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  const activeAgentIds =
    tasks !== undefined && pending.length > 0 && input.agentId === 'main'
      ? new Set(
          tasks.flatMap((task) => {
            if (task.kind !== 'agent' || task.agentId === undefined) return [];
            if (TERMINAL_STATUSES.has(task.status)) return [];
            return [task.agentId];
          }),
        )
      : undefined;
  const gate = await mapWithConcurrency(
    pending,
    TOWER_GIT_CONCURRENCY,
    async (mission): Promise<TowerStatusGate> => {
      const result = await store.missionGate(state, mission, { activeAgentIds });
      return {
        missionId: mission.id,
        branch: mission.branch,
        ready: result.ready,
        noop: result.noop,
        blocks: result.blocks,
        selectedReview:
          result.selectedReview === undefined
            ? undefined
            : {
                reviewer: result.selectedReview.reviewer,
                round: result.selectedReview.round,
                status: result.selectedReview.status,
                merge: result.selectedReview.merge,
              },
        reviewBinding: result.reviewBinding,
      };
    },
  );
  const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
  const roster = state.roster.agents.map((agent) => {
    const task = tasks === undefined ? undefined : agentTaskFor(tasks, agent.agentId);
    return {
      ...agent,
      runtime:
        task === undefined ? undefined : { taskStatus: task.status, stopReason: task.stopReason },
    };
  });
  return {
    active: input.active,
    initialized: true,
    state: {
      base: state.base,
      mode: state.mode,
      recoveredAt: state.recoveredAt,
      missions: state.missions,
      roster: { agents: roster },
    },
    caller,
    gate,
    inbox: { count: inbox.length },
    concurrency: input.concurrency(),
    recentActivity: await store.recentLog(RECENT_LOG_LINES),
    deadWorkers: collectDeadWorkers(state),
  };
}

export async function readTowerStatusSummary(input: ReadTowerStatusInput): Promise<string> {
  const status = await readTowerStatus(input);
  if (!status.initialized) {
    if (status.stateLost) {
      return status.active
        ? 'Tower mode: ON\nTower state was lost: .tower/comms/state.json is missing but the .tower/ directory still exists — all recorded mission, roster, and review history is gone. Report this history loss to the user; TowerSend/TowerComplete recover a minimal state (stamped recoveredAt) automatically.'
        : 'Tower mode: OFF';
    }
    return status.active ? 'Tower mode: ON\nTower is not initialized.' : 'Tower mode: OFF';
  }
  const lines = [
    status.active ? 'Tower status — ON' : 'Tower mode: OFF',
    `Base: ${status.state.base} (mode: ${status.state.mode}) · You are: ${status.caller}`,
    ...summaryRecoveredAt(status.state),
    'Missions:',
    ...summaryMissions(status.state),
    ...summaryDeadWorkers(status.deadWorkers),
    'Roster:',
    ...summaryRoster(status.state),
    'Review gate:',
    ...summaryGate(status.gate),
    `Inbox: ${String(status.inbox.count)} message(s)`,
    `Concurrency: ${summaryConcurrency(status.concurrency)}`,
    'Recent activity:',
    ...(status.recentActivity.length > 0
      ? status.recentActivity.map((line) => `  ${line}`)
      : ['  (empty)']),
  ];
  return lines.join('\n');
}

function resolveCaller(store: TowerStore, state: TowerState, agentId: string): string {
  try {
    return callerName(agentId, store, state);
  } catch {
    return agentId;
  }
}

function collectDeadWorkers(state: TowerState): readonly TowerStatusDeathWarning[] {
  const byName = new Map(state.roster.agents.map((agent) => [agent.name, agent]));
  const warnings: TowerStatusDeathWarning[] = [];
  for (const mission of state.missions) {
    if (mission.status === 'merged' || mission.status === 'abandoned') continue;
    const entries: TowerRosterEntry[] = [];
    const add = (entry: TowerRosterEntry | undefined): void => {
      if (entry === undefined || entries.includes(entry)) return;
      entries.push(entry);
    };
    if (mission.owner !== undefined) add(byName.get(mission.owner));
    for (const agent of state.roster.agents) {
      if (agent.kind === 'worker' && agent.missionId === mission.id) {
        add(agent);
        continue;
      }
      if (agent.kind === 'reviewer' && agent.reviewTarget === mission.branch) add(agent);
    }
    for (const entry of entries) {
      if (entry.diedAt === undefined) continue;
      warnings.push({
        missionId: mission.id,
        name: entry.name,
        agentId: entry.agentId,
        kind: entry.kind,
        diedAt: entry.diedAt,
        deathStatus: entry.deathStatus,
        deathReason: entry.deathReason,
        stoppedByUser: isStoppedByUser(entry),
      });
    }
  }
  return warnings.toSorted((a, b) => b.diedAt.localeCompare(a.diedAt));
}

function isStoppedByUser(entry: TowerRosterEntry): boolean {
  return entry.deathReason?.trim() === userCancellationReason().message;
}

function summaryMissions(state: TowerStatusState): string[] {
  if (state.missions.length === 0) return ['  (none)'];
  return state.missions.map(
    (mission) =>
      `  ${mission.id} ${mission.title} — ${mission.status} · owner ${mission.owner ?? '—'} · ${mission.branch} · kind ${mission.kind}`,
  );
}

function summaryRecoveredAt(state: TowerStatusState): string[] {
  if (state.recoveredAt === undefined) return [];
  return [
    `⚠️ State recovered at ${state.recoveredAt} after a state loss — all mission, roster, and review history from before that point is gone; report this history loss to the user instead of continuing as if nothing happened.`,
  ];
}

function summaryDeadWorkers(warnings: readonly TowerStatusDeathWarning[]): string[] {
  if (warnings.length === 0) return [];
  return [
    'Dead workers:',
    ...warnings.map((warning) =>
      warning.stoppedByUser
        ? `  🛑 ${warning.missionId} ${warning.kind} ${warning.name} was stopped by the user (${warning.deathStatus ?? 'unknown'}) — dead by intent: never resume it and do not reassign the mission unless the human asks`
        : `  ⚠️ ${warning.missionId} ${warning.kind} ${warning.name} died (${warning.deathStatus ?? 'unknown'}) — diagnose first: check why it died before reviving anything`,
    ),
  ];
}

function summaryRoster(state: TowerStatusState): string[] {
  if (state.roster.agents.length === 0) return ['  (none)'];
  return state.roster.agents.map((agent) => {
    const assignment =
      agent.kind === 'worker'
        ? `mission ${agent.missionId ?? '?'}`
        : `reviewing ${agent.reviewTarget ?? '?'}`;
    const death = agent.diedAt === undefined ? '' : ` · died ${agent.deathStatus ?? 'unknown'}`;
    const runtime =
      agent.runtime === undefined
        ? ''
        : ` · task ${agent.runtime.taskStatus}${agent.runtime.stopReason === undefined ? '' : ` (${agent.runtime.stopReason})`}`;
    return `  ${agent.name} (${agent.kind}) — ${assignment} · ${agent.agentId}${death}${runtime}`;
  });
}

function summaryGate(gate: readonly TowerStatusGate[]): string[] {
  if (gate.length === 0) return ['  (no open missions)'];
  return gate.map((missionGate) => {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : ` · review round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} · binding ${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      return `  ${missionGate.missionId} ${missionGate.branch} — READY${missionGate.noop ? ' (zero-diff no-op)' : ''}${reviewText}`;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(', ');
    return `  ${missionGate.missionId} ${missionGate.branch} — BLOCKED: ${reasons}${reviewText}`;
  });
}

function summaryConcurrency(snapshot: TowerStatusConcurrency): string {
  const budget = Number.isFinite(snapshot.budget) ? String(snapshot.budget) : 'unlimited';
  const base = `budget: ${budget} agent(s) · inflight: ${String(snapshot.inflight)}`;
  if (snapshot.blockedUntil === null) return `${base} · spawns open`;
  const remainingMs = snapshot.blockedUntil - Date.now();
  return remainingMs > 0
    ? `${base} · spawns paused for ~${String(Math.ceil(remainingMs / 1000))}s`
    : `${base} · spawn pause expired`;
}
