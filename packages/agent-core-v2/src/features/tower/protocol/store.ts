import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import picomatch from 'picomatch';

import { parseFrontmatter, renderFrontmatter } from './frontmatter';
import {
  branchExists,
  branchTip,
  currentBranch,
  diffNameOnly,
  hasAnyCommit,
  isInsideRepo,
  isWorktreeDirty,
  mergeNoFf,
  tryGit,
  worktreeAdd,
  worktreeRemove,
} from './git';
import { evaluateMissionGate } from './missionGate';
import type { TowerMissionGateResult, TowerMissionGitObservations } from './missionGate';
import {
  ACTIVITY_LOG,
  BROADCAST_NAME,
  FINDINGS_DIR,
  INBOX_DIR,
  LOG_DIR,
  MISSIONS_DIR,
  MISSIONS_INDEX,
  REVIEWS_DIR,
  STATE_FILE,
  TOWER_NAME,
  WORKTREES_DIR,
  dateDash,
  findingFileName,
  inboxFileName,
  missionFileName,
  reviewFileName,
  slugify,
  targetSlug,
} from './paths';
import type {
  TowerFindingSeverity,
  TowerFindingType,
  TowerInboxItem,
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
} from './types';

export class TowerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowerProtocolError';
  }
}

export interface TowerInitResult {
  readonly base: string;
  readonly created: boolean;
  readonly retiredAgents: readonly string[];
  readonly checkout: string;
  readonly ignoredBase?: string;
  readonly openMissions: readonly string[];
}

export interface TowerPlanInput {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tasks?: readonly string[];
  readonly deps?: readonly string[];
  readonly kind?: TowerMissionKind;
}

export interface TowerSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
}

export interface TowerSendResult {
  readonly item: TowerInboxItem;
  readonly missionId?: string;
  readonly activityLogError?: string;
}

export interface TowerCompleteResult {
  readonly mission: TowerMission;
  readonly message?: TowerSendResult;
  readonly notificationCreated: boolean;
  readonly notificationError?: string;
  readonly activityLogError?: string;
}

export interface TowerFindingInput {
  readonly type: TowerFindingType;
  readonly title: string;
  readonly severity?: TowerFindingSeverity;
  readonly summary: string;
  readonly location?: string;
  readonly details: string;
  readonly suggestedFix: string;
}

export interface TowerReviewInput {
  readonly target: string;
  readonly status: string;
  readonly merge: string;
  readonly findings: string;
  readonly checks?: readonly string[];
  readonly decision: string;
}

export interface TowerMissionPatch {
  readonly status?: TowerMissionStatus;
  readonly note?: string;
  readonly blocker?: string;
  readonly clearBlockers?: boolean;
  readonly taskDone?: string;
  readonly owner?: string;
  readonly scope?: readonly string[];
}

export interface TowerMissionRuntimeOptions {
  readonly activeAgentIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

export interface TowerMergeResult {
  readonly status: 'merged' | 'advanced' | 'noop';
  readonly mergeCommit: string;
  readonly evaluatedBranchTip: string;
  readonly currentBranchTip: string;
  readonly conflictsWith: ReadonlyArray<{
    readonly branch: string;
    readonly files: readonly string[];
  }>;
  readonly noop?: boolean;
}

const FINDING_TYPES: readonly TowerFindingType[] = ['bug', 'improve', 'vuln', 'idea'];
const STATUS_EMOJI: Record<TowerMissionStatus, string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

function isOpenMission(mission: Pick<TowerMission, 'status'>): boolean {
  return mission.status !== 'merged' && mission.status !== 'abandoned';
}

function missionNumber(id: string): number {
  const parsed = Number.parseInt(id.replace(/^M/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function resolveMissionByBranch(
  state: TowerState,
  branch: string,
): TowerMission | undefined {
  let resolved: TowerMission | undefined;
  for (const mission of state.missions) {
    if (mission.branch !== branch || !isOpenMission(mission)) continue;
    if (resolved === undefined || missionNumber(mission.id) > missionNumber(resolved.id)) {
      resolved = mission;
    }
  }
  return resolved;
}

export class TowerStore {
  constructor(readonly repoRoot: string) {}

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async init(sessionId?: string, base?: string): Promise<TowerInitResult> {
    if (!(await isInsideRepo(this.repoRoot))) {
      throw new TowerProtocolError(
        'tower needs a git repository (the session working directory is not inside one)',
      );
    }
    if (!(await hasAnyCommit(this.repoRoot))) {
      throw new TowerProtocolError(
        'the repository has no commits yet — create an initial commit first',
      );
    }
    if (await this.isInitialized()) {
      const state = await this.load();
      const retiredAgents = await this.adoptForeignRoster(state, sessionId);
      return {
        base: state.base,
        created: false,
        retiredAgents,
        checkout: await this.checkedOutBranch(),
        ignoredBase: base !== undefined && base !== state.base ? base : undefined,
        openMissions: state.missions.filter(isOpenMission).map((m) => m.id),
      };
    }

    const checkout = await this.checkedOutBranch();
    let resolvedBase: string;
    if (base !== undefined) {
      if (!(await branchExists(this.repoRoot, base))) {
        throw new TowerProtocolError(
          `base branch "${base}" does not exist as a local branch — merges land on a local branch, so remote-tracking refs and tags are not accepted; create a local branch first`,
        );
      }
      resolvedBase = base;
    } else {
      if (checkout === 'HEAD') {
        throw new TowerProtocolError(
          'cannot determine the base branch from a detached HEAD — pass the base branch explicitly',
        );
      }
      resolvedBase = checkout;
    }

    for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
      await mkdir(this.abs(dir), { recursive: true });
    }
    await this.ensureGitExclude();

    const state: TowerState = {
      version: 1,
      base: resolvedBase,
      mode: 'branch',
      createdAt: new Date().toISOString(),
      sessionId,
      roster: { agents: [] },
      missions: [],
    };
    await this.save(state);
    await writeFile(this.abs(ACTIVITY_LOG), '', 'utf8');
    await this.renderMissionsIndex(state);
    await this.appendLog(TOWER_NAME, 'init', { mode: state.mode, base: resolvedBase }, MISSIONS_INDEX);
    return { base: resolvedBase, created: true, retiredAgents: [], checkout, openMissions: [] };
  }

  private async checkedOutBranch(): Promise<string> {
    return (await tryGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD';
  }

  private async adoptForeignRoster(
    state: TowerState,
    sessionId: string | undefined,
  ): Promise<readonly string[]> {
    if (sessionId === undefined || state.sessionId === sessionId) return [];
    const previous = state.sessionId;
    const stale = state.roster.agents.filter((agent) => agent.sessionId !== sessionId);
    state.roster.agents.splice(
      0,
      state.roster.agents.length,
      ...state.roster.agents.filter((agent) => agent.sessionId === sessionId),
    );
    state.sessionId = sessionId;
    await this.save(state);
    await this.appendLog(TOWER_NAME, 'adopt', {
      session: sessionId,
      previous: previous ?? 'unknown',
      retired: stale.length > 0 ? stale.map((agent) => agent.name).join(',') : undefined,
    });
    return stale.map((agent) => agent.name);
  }

  private async ensureGitExclude(): Promise<void> {
    const gitDir = (await readGitDir(this.repoRoot)) ?? join(this.repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === '.tower/')) return;
    await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}.tower/\n`, 'utf8');
  }

  async load(): Promise<TowerState> {
    let raw: string;
    try {
      raw = await readFile(this.abs(STATE_FILE), 'utf8');
    } catch {
      throw new TowerProtocolError(
        'tower is not initialized in this repository — run TowerInit first',
      );
    }
    const state = JSON.parse(raw) as TowerState;
    for (const mission of state.missions) {
      mission.kind ??= 'build';
    }
    return state;
  }

  private async save(state: TowerState): Promise<void> {
    const file = this.abs(STATE_FILE);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  }

  async appendLog(
    actor: string,
    action: string,
    details: Readonly<Record<string, string | number | undefined>> = {},
    ref?: string,
  ): Promise<void> {
    const kv = Object.entries(details)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    const parts = [new Date().toISOString(), actor, action];
    if (kv.length > 0) parts.push(kv);
    if (ref !== undefined) parts.push(`ref=${ref}`);
    await appendFile(this.abs(ACTIVITY_LOG), `${parts.join(' ')}\n`, 'utf8');
  }

  async recentLog(lines: number): Promise<readonly string[]> {
    let content = '';
    try {
      content = await readFile(this.abs(ACTIVITY_LOG), 'utf8');
    } catch {
      return [];
    }
    const all = content.split('\n').filter((line) => line.trim().length > 0);
    return all.slice(-lines);
  }

  resolveCallerName(state: TowerState, agentId: string): string {
    if (agentId === 'main') return TOWER_NAME;
    const entry = state.roster.agents.find((agent) => agent.agentId === agentId);
    if (entry === undefined) {
      throw new TowerProtocolError(
        `agent "${agentId}" is not a tower participant — only spawned workers/reviewers and the tower can use tower tools`,
      );
    }
    return entry.name;
  }

  findAgent(state: TowerState, name: string): TowerRosterEntry | undefined {
    return state.roster.agents.find((agent) => agent.name === name);
  }

  findByName(state: TowerState, name: string): TowerRosterEntry | undefined {
    return this.findAgent(state, name);
  }

  async registerAgent(entry: TowerRosterEntry): Promise<void> {
    const state = await this.load();
    if (this.findAgent(state, entry.name) !== undefined) {
      throw new TowerProtocolError(`tower agent name "${entry.name}" is already registered`);
    }
    state.roster.agents.push(entry);
    await this.save(state);
  }

  async plan(input: readonly TowerPlanInput[]): Promise<readonly TowerMission[]> {
    if (input.length === 0) {
      throw new TowerProtocolError('TowerPlan needs at least one mission');
    }
    const state = await this.load();
    const startIndex = state.missions.length;

    const missions: TowerMission[] = input.map((item, index) => {
      const n = startIndex + index + 1;
      const slug = slugify(item.title, 40);
      return {
        id: `M${n}`,
        title: item.title,
        slug,
        kind: item.kind ?? 'build',
        scope: [...item.scope],
        branch: `feat/${slug}`,
        worktree: `wt-${n}`,
        deps: item.deps ?? [],
        status: 'planned',
        tasks: (item.tasks ?? []).map((text) => ({ text, done: false })),
        notes: [],
        blockers: [],
      };
    });

    const knownIds = new Set([...state.missions.map((m) => m.id), ...missions.map((m) => m.id)]);
    for (const mission of missions) {
      for (const dep of mission.deps) {
        if (!knownIds.has(dep)) {
          throw new TowerProtocolError(`mission ${mission.id} depends on unknown mission "${dep}"`);
        }
      }
    }
    this.assertScopesDisjoint([
      ...state.missions.filter(isOpenMission),
      ...missions,
    ]);

    state.missions.push(...missions);
    await this.save(state);
    await this.renderMissionsIndex(state);
    for (const mission of missions) {
      await this.renderMissionFile(mission);
    }
    await this.appendLog(
      TOWER_NAME,
      'plan',
      { missions: missions.map((m) => m.id).join(',') },
      MISSIONS_INDEX,
    );
    return missions;
  }

  private assertScopesDisjoint(missions: readonly TowerMission[]): void {
    const scopes: Array<{ readonly id: string; readonly raw: string; readonly stem: string }> = [];
    for (const mission of missions) {
      if (mission.kind === 'survey') continue;
      for (const raw of mission.scope) {
        const stem = raw.replace(/\/\*\*?$/, '').replace(/\*$/, '').replace(/\/+$/, '');
        if (stem.length === 0) {
          throw new TowerProtocolError(
            `mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`,
          );
        }
        scopes.push({ id: mission.id, raw, stem });
      }
    }
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const a = scopes[i]!;
        const b = scopes[j]!;
        if (a.id === b.id) continue;
        if (a.stem === b.stem || a.stem.startsWith(`${b.stem}/`) || b.stem.startsWith(`${a.stem}/`)) {
          throw new TowerProtocolError(
            `mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") — split the shared files into exactly one mission; if one of them is stale finished work, abandon it first (TowerMission status=abandoned)`,
          );
        }
      }
    }
  }

  async updateMission(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    options: { readonly silent?: boolean } = {},
  ): Promise<TowerMission> {
    const state = await this.load();
    const mission = state.missions.find((m) => m.id === id);
    if (mission === undefined) {
      throw new TowerProtocolError(`unknown mission "${id}"`);
    }
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'worker' || caller.missionId !== id) {
        throw new TowerProtocolError(
          `agent "${callerName}" does not own mission ${id} — workers update only their own mission file`,
        );
      }
    }

    const isNoOp =
      patch.status === mission.status &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDone === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined;
    if (isNoOp) return mission;

    if (patch.owner !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot assign mission ownership — only the tower sets owner`,
        );
      }
      mission.owner = patch.owner;
    }
    if (patch.scope !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot change mission scope — only the tower widens a scope, and every change is logged`,
        );
      }
      this.assertScopesDisjoint([
        ...state.missions.filter((m) => m.id !== id && isOpenMission(m)),
        { ...mission, scope: [...patch.scope] },
      ]);
      mission.scope = [...patch.scope];
    }
    if (patch.status !== undefined) {
      if (patch.status === 'abandoned' && callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot abandon mission ${id} — abandoning releases the mission scope, so only the tower does it`,
        );
      }
      mission.status = patch.status;
    }
    if (patch.note !== undefined) mission.notes.push(patch.note);
    if (patch.blocker !== undefined) {
      mission.blockers.push(patch.blocker);
      mission.status = 'blocked';
    }
    if (patch.clearBlockers === true) mission.blockers = [];
    if (patch.taskDone !== undefined) {
      const task = mission.tasks.find((t) => !t.done && t.text.includes(patch.taskDone!));
      if (task === undefined) {
        throw new TowerProtocolError(
          `mission ${id} has no open task matching "${patch.taskDone}"`,
        );
      }
      task.done = true;
    }

    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    const taskTickOnly =
      patch.taskDone !== undefined &&
      patch.status === undefined &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined;
    if (!taskTickOnly && options.silent !== true) {
      await this.appendLog(callerName, 'mission.update', {
        id,
        status: patch.status,
        note: patch.note !== undefined ? 'added' : undefined,
        blocker: patch.blocker !== undefined ? 'added' : undefined,
        owner: patch.owner,
        scope: patch.scope?.join(','),
      });
    }
    return mission;
  }

  async send(callerName: string, input: TowerSendInput): Promise<string> {
    const state = await this.load();
    return (await this.sendDetailed(callerName, input, state)).item.file;
  }

  private async sendDetailed(
    callerName: string,
    input: TowerSendInput,
    state: TowerState,
  ): Promise<TowerSendResult> {
    const to = input.to.trim();
    if (
      to !== TOWER_NAME &&
      to !== BROADCAST_NAME &&
      this.findAgent(state, to) === undefined
    ) {
      const known = [TOWER_NAME, BROADCAST_NAME, ...state.roster.agents.map((a) => a.name)];
      throw new TowerProtocolError(
        `unknown recipient "${to}" — address a roster agent, ${TOWER_NAME}, or ${BROADCAST_NAME} (known: ${known.join(', ')})`,
      );
    }
    if (to === callerName) {
      throw new TowerProtocolError('cannot send an inbox message to yourself');
    }

    const messageId = randomUUID();
    const sentAt = new Date().toISOString();
    const body = input.body.trim();
    const frontmatter = renderFrontmatter({
      type: 'inbox',
      message_id: messageId,
      from: callerName,
      to,
      subject: input.subject,
      sent_at: sentAt,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.consentRef !== undefined ? { consent_ref: input.consentRef } : {}),
    });
    const content = `${frontmatter}\n\n${body}\n`;
    const baseName = inboxFileName({ from: callerName, to, subject: input.subject });
    const rel = await this.writeUnique(join(INBOX_DIR, baseName), content);
    let activityLogError: string | undefined;
    try {
      await this.appendLog(callerName, 'inbox.send', { to, subject: slugify(input.subject) }, rel);
    } catch (error) {
      activityLogError = `inbox message ${rel} was stored, but appending its inbox.send activity log failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const caller = this.findAgent(state, callerName);
    const recipient =
      to === TOWER_NAME || to === BROADCAST_NAME ? undefined : this.findAgent(state, to);
    const missionId =
      caller?.missionId ??
      caller?.reviewMissionId ??
      (callerName === TOWER_NAME
        ? (recipient?.missionId ?? recipient?.reviewMissionId)
        : undefined);
    return {
      item: {
        messageId,
        file: rel,
        from: callerName,
        to,
        subject: input.subject,
        sentAt,
        scope: input.scope,
        action: input.action,
        consentRef: input.consentRef,
        body,
      },
      missionId,
      activityLogError,
    };
  }

  async complete(
    callerName: string,
    report: string,
    keyArtifacts: readonly string[] = [],
  ): Promise<TowerCompleteResult> {
    const trimmed = report.trim();
    if (trimmed.length === 0) {
      throw new TowerProtocolError('TowerComplete report must not be empty');
    }
    const normalizedKeyArtifacts = normalizeArtifactPaths(keyArtifacts);
    const state = await this.load();
    const caller = this.findAgent(state, callerName);
    const mission =
      caller?.kind === 'worker' && caller.missionId !== undefined
        ? state.missions.find((candidate) => candidate.id === caller.missionId)
        : undefined;
    if (callerName === TOWER_NAME || caller?.kind !== 'worker' || mission === undefined) {
      if (caller?.kind === 'worker' && caller.missionId !== undefined) {
        throw new TowerProtocolError(`unknown mission "${caller.missionId}"`);
      }
      throw new TowerProtocolError(
        `agent "${callerName}" cannot use TowerComplete — only the worker who owns a mission can complete it`,
      );
    }
    if (mission.kind !== 'artifact' && normalizedKeyArtifacts.length > 0) {
      throw new TowerProtocolError(
        'TowerComplete key_artifacts is only supported for artifact missions',
      );
    }
    if (mission.kind === 'artifact' && normalizedKeyArtifacts.length === 0) {
      throw new TowerProtocolError(
        `TowerComplete key_artifacts for artifact mission ${mission.id} must name at least one committed key deliverable`,
      );
    }

    await this.assertCompletable(state, mission);

    let completionTip: string | undefined;
    let completionChanged: readonly string[] = [];
    if (mission.kind === 'artifact') {
      completionTip = await branchTip(this.repoRoot, mission.branch);
      const completionBase = mission.spawnBase ?? state.base;
      completionChanged = await diffNameOnly(this.repoRoot, completionBase, completionTip);
      const changed = new Set(completionChanged);
      const uncommitted = normalizedKeyArtifacts.filter((path) => !changed.has(path));
      if (uncommitted.length > 0) {
        throw new TowerProtocolError(
          `TowerComplete key_artifacts for artifact mission ${mission.id} must name paths from the committed branch diff; not found: ${uncommitted.join(', ')}`,
        );
      }
      const outOfScope = normalizedKeyArtifacts.filter(
        (path) => !mission.scope.some((glob) => picomatch.isMatch(path, glob)),
      );
      if (outOfScope.length > 0) {
        throw new TowerProtocolError(
          `TowerComplete key_artifacts for artifact mission ${mission.id} must stay inside its scope (${mission.scope.join(', ')}): ${outOfScope.join(', ')}`,
        );
      }
      const missingAtTip: string[] = [];
      for (const path of normalizedKeyArtifacts) {
        const type = await tryGit(this.repoRoot, ['cat-file', '-t', `${completionTip}:${path}`]);
        if (type !== 'blob') missingAtTip.push(path);
      }
      if (missingAtTip.length > 0) {
        throw new TowerProtocolError(
          `TowerComplete key_artifacts for artifact mission ${mission.id} must name files present at completion tip ${completionTip.slice(0, 7)}; missing or not files: ${missingAtTip.join(', ')}`,
        );
      }
    }

    const subject =
      mission.kind === 'survey'
        ? 'survey-summary'
        : mission.kind === 'artifact'
          ? 'acceptance-request'
          : 'review-request';
    const completionReport =
      mission.kind === 'artifact' && completionTip !== undefined
        ? artifactAcceptanceReport(
            trimmed,
            normalizedKeyArtifacts,
            completionChanged,
            completionTip,
          )
        : trimmed;
    const wasCompleted = mission.status === 'completed';
    if (wasCompleted) {
      const sameCompletion =
        mission.kind !== 'artifact' ||
        (mission.completionTip === completionTip &&
          sameArtifactPaths(mission.keyArtifacts, normalizedKeyArtifacts));
      if (sameCompletion) {
        const existing = await this.findCompletionMessage(
          callerName,
          mission,
          subject,
          completionReport,
        );
        if (existing !== undefined) {
          return {
            mission,
            message: { item: existing, missionId: mission.id },
            notificationCreated: false,
          };
        }
      }
    }

    mission.status = 'completed';
    if (mission.kind === 'artifact') {
      mission.completionTip = completionTip;
      mission.keyArtifacts = [...normalizedKeyArtifacts];
    }
    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    await this.appendLog(callerName, 'mission.update', { id: mission.id, status: 'completed' });
    try {
      const message = await this.sendDetailed(
        callerName,
        {
          to: TOWER_NAME,
          subject,
          body: completionReport,
          scope: mission.id,
          action: 'complete',
        },
        state,
      );
      return {
        mission,
        message,
        notificationCreated: true,
        activityLogError: message.activityLogError,
      };
    } catch (error) {
      const existing = await this.findCompletionMessage(
        callerName,
        mission,
        subject,
        completionReport,
      );
      return {
        mission,
        message:
          existing === undefined ? undefined : { item: existing, missionId: mission.id },
        notificationCreated: false,
        notificationError: `mission ${mission.id} was persisted as completed, but storing its ${subject} notification failed: ${error instanceof Error ? error.message : String(error)} — retry with the same report to reuse an already stored notification instead of duplicating it`,
      };
    }
  }

  private async assertCompletable(state: TowerState, mission: TowerMission): Promise<void> {
    const open = mission.tasks.filter((task) => !task.done && task.dropped !== true);
    if (open.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(open.length)} open task(s): ${open.map((task) => `"${task.text}"`).join(', ')}; tick finished tasks with TowerMission task_done, or drop legitimately descoped ones`,
      );
    }
    if (mission.blockers.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(mission.blockers.length)} blocker(s) remain: ${mission.blockers.join(' | ')}; clear or resolve them before completing`,
      );
    }
    const base = mission.spawnBase ?? state.base;
    if (mission.kind === 'survey') {
      if (!(await branchExists(this.repoRoot, mission.branch))) return;
      const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
      if (changed.length > 0) {
        throw new TowerProtocolError(
          `mission ${mission.id} cannot transition to completed — it is a read-only survey but branch "${mission.branch}" has ${String(changed.length)} changed file(s) vs "${base}": ${changed.slice(0, 5).join(', ')}; move any changes worth keeping to a build mission and leave the survey branch zero-diff`,
        );
      }
      return;
    }
    if (!(await branchExists(this.repoRoot, mission.branch))) {
      throw new TowerProtocolError(
        mission.kind === 'artifact'
          ? `mission ${mission.id} cannot transition to completed — its branch "${mission.branch}" does not exist, so there are no committed deliverables to accept`
          : `mission ${mission.id} cannot transition to completed — its branch "${mission.branch}" does not exist, so no work has landed; a build mission must produce a diff on its branch`,
      );
    }
    const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
    if (changed.length === 0) {
      throw new TowerProtocolError(
        mission.kind === 'artifact'
          ? `mission ${mission.id} cannot transition to completed — branch "${mission.branch}" has no changes vs "${base}"; commit the deliverables there first`
          : `mission ${mission.id} cannot transition to completed — branch "${mission.branch}" has no changes vs "${base}"; commit the work there first`,
      );
    }
  }

  private async findCompletionMessage(
    callerName: string,
    mission: TowerMission,
    subject: string,
    report: string,
  ): Promise<TowerInboxItem | undefined> {
    return (await this.listInboxItems()).find(
      (item) =>
        item.from === callerName &&
        item.to === TOWER_NAME &&
        item.subject === subject &&
        item.scope === mission.id &&
        item.action === 'complete' &&
        item.body === report,
    );
  }

  async readInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const items = (await this.listInboxItems()).filter(
      (item) => callerName === TOWER_NAME || item.to === callerName || item.to === BROADCAST_NAME,
    );
    return items.slice(0, Math.max(1, limit));
  }

  private async listInboxItems(): Promise<readonly TowerInboxItem[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(INBOX_DIR));
    } catch {
      return [];
    }
    const items: TowerInboxItem[] = [];
    for (const file of files.filter((f) => f.endsWith('.md'))) {
      const rel = join(INBOX_DIR, file);
      let text: string;
      try {
        text = await readFile(this.abs(rel), 'utf8');
      } catch {
        continue;
      }
      const { fields, body } = parseFrontmatter(text);
      if (fields['type'] !== 'inbox') continue;
      items.push({
        messageId: fields['message_id'],
        file: rel,
        from: fields['from'] ?? 'unknown',
        to: fields['to'] ?? '',
        subject: fields['subject'] ?? '',
        sentAt: fields['sent_at'] ?? '',
        scope: fields['scope'],
        action: fields['action'],
        consentRef: fields['consent_ref'],
        body,
      });
    }
    items.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    return items;
  }

  async fileFinding(callerName: string, input: TowerFindingInput): Promise<string> {
    if (!FINDING_TYPES.includes(input.type)) {
      throw new TowerProtocolError(
        `finding type must be one of ${FINDING_TYPES.join(' | ')}`,
      );
    }
    const state = await this.load();
    const caller = this.findAgent(state, callerName);
    const mission =
      caller?.missionId !== undefined
        ? state.missions.find((m) => m.id === caller.missionId)
        : undefined;

    const lines = [
      `# Finding: ${input.title}`,
      '',
      `**Date**: ${dateDash().replaceAll('-', '')}`,
      `**Agent**: ${callerName}`,
      `**Type**: ${input.type}`,
      `**Severity**: ${input.severity ?? 'medium'}`,
      `**Mission**: ${mission === undefined ? '(none)' : `${mission.id} — ${mission.title}`}`,
      '',
      '---',
      '',
      '## Summary',
      input.summary.trim(),
      '',
      '## Location',
      (input.location ?? '(not specified)').trim(),
      '',
      '## Details',
      input.details.trim(),
      '',
      '## Suggested Fix / Action',
      input.suggestedFix.trim(),
      '',
      '## Why Not Fixed Directly',
      mission === undefined
        ? 'This finding is outside the reporting agent’s assignment. Assigning to the control tower for routing.'
        : `This finding is outside the scope of mission ${mission.id} (${mission.scope.join(', ')}). Fixing it directly would violate scope isolation. Assigning to the control tower for routing.`,
      '',
      '---',
      '',
      `*Filed by tower agent ${callerName} via \`${FINDINGS_DIR}/\`*`,
      '',
    ];
    const baseName = findingFileName({
      agent: callerName,
      type: input.type,
      slug: input.title,
    });
    const rel = await this.writeUnique(join(FINDINGS_DIR, baseName), lines.join('\n'));
    await this.appendLog(callerName, 'finding.file', { type: input.type, slug: slugify(input.title) }, rel);
    return rel;
  }

  async submitReview(callerName: string, input: TowerReviewInput): Promise<string> {
    const state = await this.load();
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'reviewer' || caller.reviewTarget !== input.target) {
        throw new TowerProtocolError(
          `agent "${callerName}" is not an assigned reviewer for "${input.target}"`,
        );
      }
    }
    if (!/^(clean|p[12]-\d+items)$/.test(input.status)) {
      throw new TowerProtocolError(
        `review status must be clean | p1-Nitems | p2-Nitems, got "${input.status}"`,
      );
    }
    if (!['merge', 'fix-then-merge', 'hold'].includes(input.merge)) {
      throw new TowerProtocolError(
        `review merge verdict must be merge | fix-then-merge | hold, got "${input.merge}"`,
      );
    }

    const existing = await this.reviewsFor(input.target);
    const myRounds = existing.filter((r) => r.reviewer === callerName).length;
    const round = myRounds + 1;
    const seq = existing.length + 1;
    const reviewedCommit = await branchTip(this.repoRoot, input.target);
    const reviewMissionId =
      (callerName === TOWER_NAME ? undefined : this.findAgent(state, callerName)?.reviewMissionId) ??
      resolveMissionByBranch(state, input.target)?.id;

    const frontmatter = renderFrontmatter({
      date: dateDash(),
      reviewer: callerName,
      target: input.target,
      round: String(round),
      seq: String(seq),
      status: input.status,
      merge: input.merge,
      reviewed_commit: reviewedCommit,
      mission: reviewMissionId,
    });
    const checks = (input.checks ?? []).map((c) => `- [x] ${c}`).join('\n');
    const content = [
      frontmatter,
      '',
      '## Findings',
      '',
      input.findings.trim(),
      '',
      '## Checks',
      checks.length > 0 ? checks : '- [x] (reviewer reported no formal checks)',
      '',
      '## Decision',
      input.decision.trim(),
      '',
    ].join('\n');

    const rel = await this.writeUnique(
      join(REVIEWS_DIR, reviewFileName({ target: input.target, reviewer: callerName, round })),
      content,
    );
    await this.appendLog(
      callerName,
      'review.write',
      { target: input.target, round, verdict: input.status, reviewed: reviewedCommit.slice(0, 7) },
      rel,
    );
    return rel;
  }

  async reviewsFor(target: string): Promise<readonly TowerReviewInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(REVIEWS_DIR));
    } catch {
      return [];
    }
    const prefix = `review-${targetSlug(target)}-`;
    const reviews: TowerReviewInfo[] = [];
    for (const file of files.filter((f) => f.startsWith(prefix) && f.endsWith('.md'))) {
      const rel = join(REVIEWS_DIR, file);
      let text: string;
      try {
        text = await readFile(this.abs(rel), 'utf8');
      } catch {
        continue;
      }
      const { fields } = parseFrontmatter(text);
      const round = Number.parseInt(fields['round'] ?? '', 10);
      if (Number.isNaN(round)) continue;
      const seq = Number.parseInt(fields['seq'] ?? '', 10);
      const { mtimeMs } = await stat(this.abs(rel));
      reviews.push({
        reviewer: fields['reviewer'] ?? 'unknown',
        target: fields['target'] ?? target,
        round,
        status: fields['status'] ?? '',
        merge: fields['merge'] ?? '',
        reviewedCommit: fields['reviewed_commit'] ?? '',
        date: fields['date'] ?? '',
        file: rel,
        mtimeMs,
        seq: Number.isNaN(seq) ? undefined : seq,
        mission: fields['mission'],
      });
    }
    reviews.sort(
      (a, b) =>
        (a.seq ?? -1) - (b.seq ?? -1) ||
        (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) ||
        a.round - b.round ||
        a.file.localeCompare(b.file),
    );
    return reviews;
  }

  async latestReview(target: string): Promise<TowerReviewInfo | undefined> {
    const reviews = await this.reviewsFor(target);
    return reviews.at(-1);
  }

  async merge(
    branch: string,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMergeResult> {
    const state = await this.load();
    const block = async (reason: string, message: string): Promise<TowerProtocolError> => {
      await this.appendLog(TOWER_NAME, 'merge.blocked', { branch, reason });
      return new TowerProtocolError(message);
    };
    const mission = resolveMissionByBranch(state, branch);
    if (mission === undefined) {
      const closed = state.missions.filter((candidate) => candidate.branch === branch);
      if (closed.length > 0) {
        throw await block(
          'branch-owned-by-closed-missions',
          `merge blocked: branch "${branch}" resolves only to closed mission(s) ${closed.map((candidate) => `${candidate.id} (${candidate.status})`).join(', ')} — TowerMerge never flips a closed mission's status; re-plan the work under a new title if it should land`,
        );
      }
      throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
    }

    const gate = await this.missionGate(state, mission, runtime);
    if (!gate.ready) {
      const primary = gate.blocks[0];
      if (primary !== undefined) {
        throw await block(primary.reason, primary.message);
      }
      throw new TowerProtocolError(
        `merge blocked: the mission gate produced no reason for "${branch}"`,
      );
    }
    const observation = gate.observations.branch;
    if (observation === undefined) {
      throw await block(
        'branch-missing',
        `merge blocked: mission ${mission.id} branch "${branch}" does not exist`,
      );
    }
    const evaluatedBranchTip = observation.tip;

    if (gate.noop) {
      const currentBranchTip = await branchTip(this.repoRoot, branch);
      if (currentBranchTip !== evaluatedBranchTip) {
        await this.appendLog(TOWER_NAME, 'merge.advanced', {
          branch,
          evaluated: evaluatedBranchTip.slice(0, 7),
          current: currentBranchTip.slice(0, 7),
        });
        return {
          status: 'advanced',
          mergeCommit: gate.observations.headTip,
          evaluatedBranchTip,
          currentBranchTip,
          conflictsWith: [],
          noop: true,
        };
      }
      mission.status = 'merged';
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      await this.appendLog(TOWER_NAME, 'merge.noop', { branch, kind: 'survey' });
      return {
        status: 'noop',
        mergeCommit: gate.observations.headTip,
        evaluatedBranchTip,
        currentBranchTip,
        conflictsWith: [],
        noop: true,
      };
    }

    const mergeCommit = await mergeNoFf(this.repoRoot, branch);
    const currentBranchTip = await branchTip(this.repoRoot, branch);
    if (currentBranchTip !== evaluatedBranchTip) {
      await this.appendLog(TOWER_NAME, 'merge.advanced', {
        branch,
        evaluated: evaluatedBranchTip.slice(0, 7),
        current: currentBranchTip.slice(0, 7),
        merge_commit: mergeCommit.slice(0, 7),
      });
      return {
        status: 'advanced',
        mergeCommit,
        evaluatedBranchTip,
        currentBranchTip,
        conflictsWith: [],
      };
    }

    const changedSet = new Set(observation.changedFiles);
    const conflictsWith: Array<{ readonly branch: string; readonly files: readonly string[] }> = [];
    for (const other of state.missions) {
      if (other.branch === branch || !isOpenMission(other)) continue;
      if (!(await branchExists(this.repoRoot, other.branch))) continue;
      const otherChanged = await diffNameOnly(this.repoRoot, state.base, other.branch);
      const overlap = otherChanged.filter((file) => changedSet.has(file));
      if (overlap.length > 0) {
        conflictsWith.push({ branch: other.branch, files: overlap });
      }
    }

    mission.status = 'merged';
    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    await this.appendLog(TOWER_NAME, 'merge', {
      branch,
      base: state.base,
      merge_commit: mergeCommit.slice(0, 7),
      review_waived: gate.reviewBinding === 'clean-rebase-waived' ? 'yes' : undefined,
    });
    return {
      status: 'merged',
      mergeCommit,
      evaluatedBranchTip,
      currentBranchTip,
      conflictsWith,
    };
  }

  async missionGate(
    state: TowerState,
    mission: TowerMission,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMissionGateResult> {
    const [reviews, observations] = await Promise.all([
      this.reviewsFor(mission.branch),
      this.observeMissionGit(state, mission),
    ]);
    const activeAgentIds =
      typeof runtime.activeAgentIds === 'function'
        ? runtime.activeAgentIds()
        : runtime.activeAgentIds;
    const workers =
      activeAgentIds === undefined
        ? []
        : state.roster.agents
            .filter(
              (agent) =>
                agent.kind === 'worker' &&
                (agent.missionId === mission.id ||
                  agent.branch === mission.branch ||
                  agent.worktree === mission.worktree),
            )
            .map((agent) => ({
              agentId: agent.agentId,
              name: agent.name,
              status: activeAgentIds.has(agent.agentId)
                ? ('busy' as const)
                : ('idle' as const),
            }));
    return evaluateMissionGate({ state, mission, reviews, workers, observations });
  }

  private async observeMissionGit(
    state: TowerState,
    mission: TowerMission,
  ): Promise<TowerMissionGitObservations> {
    let checkedOutBranch: string | undefined;
    try {
      checkedOutBranch = await currentBranch(this.repoRoot);
    } catch {
      checkedOutBranch = undefined;
    }
    const [baseTip, headTip, hasBranch] = await Promise.all([
      branchTip(this.repoRoot, state.base),
      branchTip(this.repoRoot, 'HEAD'),
      branchExists(this.repoRoot, mission.branch),
    ]);
    if (!hasBranch) return { baseTip, headTip, checkedOutBranch };
    const tip = await branchTip(this.repoRoot, mission.branch);
    const changedFiles = await diffNameOnly(this.repoRoot, baseTip, tip);
    return { baseTip, headTip, checkedOutBranch, branch: { tip, changedFiles } };
  }

  async addWorktree(worktree: string, branch: string, base: string): Promise<string> {
    const rel = join(WORKTREES_DIR, worktree);
    await worktreeAdd(this.repoRoot, this.abs(rel), branch, base);
    await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base });
    return rel;
  }

  async teardown(options: { readonly force?: boolean } = {}): Promise<readonly string[]> {
    const state = await this.load();
    const report: string[] = [];
    for (const mission of state.missions) {
      const rel = join(WORKTREES_DIR, mission.worktree);
      const absPath = this.abs(rel);
      if (await isWorktreeDirty(absPath)) {
        if (options.force !== true) {
          report.push(`kept ${rel} (uncommitted changes — rerun with force to remove)`);
          await this.appendLog(TOWER_NAME, 'worktree.keep', {
            worktree: mission.worktree,
            reason: 'uncommitted-changes',
          });
          continue;
        }
      }
      try {
        await worktreeRemove(this.repoRoot, absPath);
        report.push(`removed ${rel}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove', { worktree: mission.worktree });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.push(`failed to remove ${rel}: ${reason}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove.failed', {
          worktree: mission.worktree,
          reason,
        });
      }
    }
    await this.appendLog(TOWER_NAME, 'teardown', { force: options.force === true ? 'yes' : undefined });
    return report;
  }

  private async renderMissionsIndex(state: TowerState): Promise<void> {
    const rows = state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} | ${m.owner ?? '—'} |`,
    );
    const deps = state.missions
      .flatMap((m) => m.deps.map((dep) => `${dep} → ${m.id}`))
      .join('\n');
    const scopes = state.missions
      .map((m) => `- ${m.id}${m.kind === 'survey' ? ' (survey — informational, reserves nothing)' : ''}: ${m.scope.join(', ')}`)
      .join('\n');
    const content = [
      '# MISSIONS',
      '',
      '<!-- Generated by tower tools from state.json — do not edit by hand. -->',
      '',
      '| ID | Mission | Branch | Worktree | Status | Owner |',
      '| -- | ------- | ------ | -------- | ------ | ----- |',
      ...rows,
      '',
      'Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged · 🚫 abandoned',
      `Mode: ${state.mode} — Base: ${state.base}`,
      '',
      '## Dependency Flow',
      deps.length > 0 ? deps : '(none)',
      '',
      '## Scope Map',
      scopes.length > 0 ? scopes : '(none)',
      '',
    ].join('\n');
    await writeFile(this.abs(MISSIONS_INDEX), content, 'utf8');
  }

  private async renderMissionFile(mission: TowerMission): Promise<void> {
    const rel = join(MISSIONS_DIR, missionFileName(mission.id, mission.slug));
    const content = [
      `# Mission ${mission.id}: ${mission.title}${mission.kind === 'survey' ? ' 🔍 (read-only survey)' : ''}`,
      '',
      '<!-- Generated by tower tools from state.json — update via the TowerMission tool. -->',
      '',
      '| Branch | Worktree | Status | Scope | Owner |',
      '| ------ | -------- | ------ | ----- | ----- |',
      `| ${mission.branch} | ${mission.worktree} | ${STATUS_EMOJI[mission.status]} | ${mission.scope.join(', ')} | ${mission.owner ?? '—'} |`,
      '',
      '## Tasks',
      ...(mission.tasks.length > 0
        ? mission.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`)
        : ['- [ ] (no tasks recorded)']),
      '',
      '## Dependencies',
      mission.deps.length > 0 ? mission.deps.join(', ') : '(none)',
      '',
      '## Blockers',
      ...(mission.blockers.length > 0 ? mission.blockers.map((b) => `- ${b}`) : ['- (none)']),
      '',
      '## Notes',
      ...(mission.notes.length > 0 ? mission.notes.map((n) => `- ${n}`) : ['- (none)']),
      '',
    ].join('\n');
    await writeFile(this.abs(rel), content, 'utf8');
  }

  abs(rel: string): string {
    return join(this.repoRoot, rel);
  }

  private async writeUnique(rel: string, content: string): Promise<string> {
    const dot = rel.lastIndexOf('.');
    const stem = dot === -1 ? rel : rel.slice(0, dot);
    const ext = dot === -1 ? '' : rel.slice(dot);
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = attempt === 0 ? rel : `${stem}-${attempt + 1}${ext}`;
      try {
        const handle = await open(this.abs(candidate), 'wx');
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new TowerProtocolError(`could not create a unique file for ${rel}`);
  }
}

async function readGitDir(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(join(cwd, '.git'), 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(raw.trim());
    if (match?.[1] !== undefined) return match[1];
    return null;
  } catch {
    return null;
  }
}

function normalizeArtifactPaths(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => {
    const trimmed = path.trim();
    const candidate = posix.normalize(trimmed.replaceAll('\\', '/'));
    if (
      trimmed.length === 0 ||
      /[\0\r\n]/.test(trimmed) ||
      candidate === '.' ||
      candidate === '..' ||
      candidate.startsWith('../') ||
      posix.isAbsolute(candidate)
    ) {
      throw new TowerProtocolError(
        `TowerComplete key_artifacts entries must be non-empty relative file paths inside the repository; received "${path}"`,
      );
    }
    return candidate;
  });
  return [...new Set(normalized)];
}

function sameArtifactPaths(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function artifactAcceptanceReport(
  report: string,
  keyArtifacts: readonly string[],
  changed: readonly string[],
  completionTip: string,
): string {
  const key = new Set(keyArtifacts);
  const additional = changed.filter((path) => !key.has(path));
  return [
    'Key artifacts for human acceptance:',
    ...keyArtifacts.map((path) => `- ${path}`),
    '',
    `Completion tip: ${completionTip}`,
    'Approval authorizes the entire current mission tip presented for acceptance, not only these key artifacts.',
    `Additional committed files included in this approval: ${String(additional.length)}.`,
    'Optional full manifest: inspect the current mission branch diff on request; reading every path is not required.',
    '',
    report,
  ].join('\n');
}
