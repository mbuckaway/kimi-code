import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { DisposableStore } from '#/_base/di/lifecycle';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { AnyAgentTool } from '#/agent/toolRegistry/toolContribution';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { Event2 } from '#/app/event/event2';
import { ISessionEventBus } from '#/app/event/eventBus';
import { TOWER_TOOL_CONTRIBUTIONS } from '#/features/tower/towerFeature';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import {
  TowerStore,
  type TowerInboxItem,
  type TowerSendResult,
  type TowerState,
} from '#/features/tower/protocol/index';
import { TowerInboxSent } from '#/features/tower/towerOps';
import { deliverTowerMessage } from '#/features/tower/tools/delivery';
import {
  ISessionMessagingService,
  type AgentMessageDelivery,
} from '#/features/messaging/messaging';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableTool } from '#/tool/toolContract';

import { ITowerInitTool } from '#/features/tower/tools/init/init';
import { TowerInitTool } from '#/features/tower/tools/init/initTool';
import { ITowerPlanTool } from '#/features/tower/tools/plan/plan';
import { TowerPlanTool } from '#/features/tower/tools/plan/planTool';
import { ITowerMergeTool } from '#/features/tower/tools/merge/merge';
import { TowerMergeTool } from '#/features/tower/tools/merge/mergeTool';
import { ITowerTeardownTool } from '#/features/tower/tools/teardown/teardown';
import { TowerTeardownTool } from '#/features/tower/tools/teardown/teardownTool';
import { ITowerSendTool } from '#/features/tower/tools/send/send';
import { TowerSendTool } from '#/features/tower/tools/send/sendTool';
import { ITowerInboxTool } from '#/features/tower/tools/inbox/inbox';
import { TowerInboxTool } from '#/features/tower/tools/inbox/inboxTool';
import { ITowerFindingTool } from '#/features/tower/tools/finding/finding';
import { TowerFindingTool } from '#/features/tower/tools/finding/findingTool';
import { ITowerReviewTool } from '#/features/tower/tools/review/review';
import { TowerReviewTool } from '#/features/tower/tools/review/reviewTool';
import { ITowerMissionTool } from '#/features/tower/tools/mission/mission';
import { TowerMissionTool } from '#/features/tower/tools/mission/missionTool';
import { ITowerStatusTool } from '#/features/tower/tools/status/status';
import { TowerStatusTool } from '#/features/tower/tools/status/statusTool';
import {
  ITowerCompleteTool,
  TowerCompleteToolInputSchema,
} from '#/features/tower/tools/complete/complete';
import { TowerCompleteTool } from '#/features/tower/tools/complete/completeTool';
import { TowerRebaseToolInputSchema } from '#/features/tower/tools/rebase/rebase';

import { executeTool } from '../../../tools/fixtures/execute-tool';
import { stubAgentContext } from '../../../agent/agentContext/stubs';
import type { AgentContext } from '#/agent/agentContext/agentContext';

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(
  cwd: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await git(cwd, 'add', rel);
  await git(cwd, 'commit', '-m', message);
}

let repo: string;
let disposables: DisposableStore;
let ix: TestInstantiationService;
let towerActive: boolean;
let currentAgentId: string;
let currentSessionId: string;
let liveSessionIds: string[];
let publishedEvents: Event2<unknown>[];
let sendMessageStub: ReturnType<typeof vi.fn>;
const agentContexts = new Map<string, AgentContext>();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-tools-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');

  towerActive = false;
  currentAgentId = 'main';
  liveSessionIds = [];
  currentSessionId = 'session-test';
  agentContexts.clear();
  publishedEvents = [];
  sendMessageStub = vi.fn();

  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        get sessionId() {
          return currentSessionId;
        },
        workspaceId: 'workspace-test',
        sessionDir: join(repo, '.session'),
        metaScope: 'sessions/test',
        cwd: repo,
        scope: (subKey?: string) =>
          subKey === undefined || subKey === '' ? 'sessions/test' : `sessions/test/${subKey}`,
      });
      reg.defineInstance(IAgentScopeContext, {
        _serviceBrand: undefined,
        get agentId() {
          return currentAgentId;
        },
        get agentContext() {
          let context = agentContexts.get(currentAgentId);
          if (context === undefined) {
            context = stubAgentContext(currentAgentId, 0);
            agentContexts.set(currentAgentId, context);
          }
          return context;
        },
        scope: (subKey?: string) => subKey ?? '',
      });
      reg.defineInstance(IAgentTowerService, {
        _serviceBrand: undefined,
        get isActive() {
          return towerActive;
        },
        enter: () => {
          towerActive = true;
        },
        exit: () => {
          towerActive = false;
        },
      });
      reg.defineInstance(ISessionManager, {
        get: (id: string) => (liveSessionIds.includes(id) ? {} : undefined),
      } as unknown as ISessionManager);
      reg.defineInstance(ISessionEventBus, {
        publish: (event: Event2<unknown>) => {
          publishedEvents.push(event);
        },
      } as unknown as ISessionEventBus);
      reg.defineInstance(ISessionMessagingService, {
        _serviceBrand: undefined,
        sendMessage: sendMessageStub,
      } as unknown as ISessionMessagingService);
      reg.definePartialInstance(ITowerRateLimitService, {
        snapshot: () => ({ budget: 2, inflight: 0, blockedUntil: null }),
      });
      reg.define(ITowerInitTool, TowerInitTool);
      reg.define(ITowerPlanTool, TowerPlanTool);
      reg.define(ITowerMergeTool, TowerMergeTool);
      reg.define(ITowerTeardownTool, TowerTeardownTool);
      reg.define(ITowerSendTool, TowerSendTool);
      reg.define(ITowerInboxTool, TowerInboxTool);
      reg.define(ITowerFindingTool, TowerFindingTool);
      reg.define(ITowerReviewTool, TowerReviewTool);
      reg.define(ITowerMissionTool, TowerMissionTool);
      reg.define(ITowerStatusTool, TowerStatusTool);
      reg.define(ITowerCompleteTool, TowerCompleteTool);
    },
  });
});

afterEach(async () => {
  disposables.dispose();
  await rm(repo, { recursive: true, force: true });
});

async function run<Input>(tool: ExecutableTool<Input>, args: Input) {
  return executeTool(tool, { turnId: 0, toolCallId: 'call_1', args, signal });
}

async function initViaTool() {
  const result = await run(ix.get(ITowerInitTool), {});
  expect(result.isError).toBeFalsy();
  return result;
}

describe('TowerInitTool', () => {
  it('creates .tower and enters tower mode', async () => {
    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower workspace initialized');
    expect(result.output).toContain('base branch: main');
    expect((await stat(join(repo, '.tower/comms'))).isDirectory()).toBe(true);
    expect(towerActive).toBe(true);
  });

  it('accepts an explicit base branch and notes the checkout mismatch', async () => {
    await git(repo, 'branch', 'develop');

    const result = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('base branch: develop');
    expect(result.output).toContain('the main checkout is on "main", not base "develop"');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('develop');
  });

  it('reports an ignored base when re-initializing with a different one', async () => {
    await git(repo, 'branch', 'develop');
    await initViaTool();

    const second = await run(ix.get(ITowerInitTool), { base: 'develop' });

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('requested base "develop" ignored');
    const state = await new TowerStore(repo).load();
    expect(state.base).toBe('main');
  });

  it('rejects a base that is not a local branch', async () => {
    const result = await run(ix.get(ITowerInitTool), { base: 'origin/main' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist as a local branch');
  });

  it('is idempotent — a second run reports already-initialized and keeps state', async () => {
    await initViaTool();
    await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'kept mission', scope: ['src/kept/**'] }],
    });

    const second = await run(ix.get(ITowerInitTool), {});
    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('tower workspace already initialized');
    const state = await new TowerStore(repo).load();
    expect(state.missions).toHaveLength(1);
  });

  it('adopting from a previous session retires its roster and says so', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'agent-0',
      sessionId: 'session-test',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    currentSessionId = 'session-next';

    const second = await run(ix.get(ITowerInitTool), {});

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('retired its stale roster entries: agent-build');
    const state = await store.load();
    expect(state.sessionId).toBe('session-next');
    expect(state.roster.agents).toEqual([]);
  });

  it('refuses to adopt while the owning session is live in this process', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const result = await run(ix.get(ITowerInitTool), {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('owned by a live session (session-test)');
    const state = await new TowerStore(repo).load();
    expect(state.sessionId).toBe('session-test');
  });
});

describe('TowerPlanTool', () => {
  it('refuses when tower mode is inactive', async () => {
    const result = await run(ix.get(ITowerPlanTool), {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('tower mode is not active — run TowerInit first');
  });

  it('plans missions on a real repo once tower mode is active', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerPlanTool), {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'], tasks: ['scaffold'] },
        { title: 'Build UI', scope: ['src/ui/**'], deps: ['M1'] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('planned 2 mission(s):');
    expect(result.output).toContain('| M1 | Build engine | build | feat/build-engine | wt-1 | src/engine/** |');
    expect(result.output).toContain('| M2 | Build UI | build | feat/build-ui | wt-2 | src/ui/** |');
  });
});

describe('TowerMergeTool', () => {
  async function setupMergeableMission(): Promise<{
    store: TowerStore;
    missionId: string;
    branch: string;
    worktree: string;
  }> {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([{ title: 'merge me', scope: ['src/merge/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    const worktree = join(repo, '.tower/worktrees', mission!.worktree);
    await commitFile(worktree, 'src/merge/a.ts', 'export const a = 1;\n', 'mission work');
    await store.registerAgent({
      name: 'rev-m',
      agentId: 'agent-rev-m',
      kind: 'reviewer',
      reviewTarget: mission!.branch,
      spawnedAt: new Date().toISOString(),
    });
    await store.submitReview('rev-m', {
      target: mission!.branch,
      status: 'clean',
      merge: 'merge',
      findings: 'none',
      decision: 'ship it',
    });
    await store.updateMission('tower', mission!.id, { status: 'completed' });
    return { store, missionId: mission!.id, branch: mission!.branch, worktree };
  }

  it('merges a completed, cleanly reviewed mission and suggests teardown', async () => {
    const { store, missionId, branch } = await setupMergeableMission();

    const result = await run(ix.get(ITowerMergeTool), { branch });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`merged ${branch} (merge commit`);
    expect(result.output).toContain('The mission is now marked merged.');
    expect(result.output).toContain('ready for TowerTeardown');
    expect((await store.load()).missions.find((m) => m.id === missionId)?.status).toBe('merged');
  });

  it('surfaces a gate refusal as an error result', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([{ title: 'not ready', scope: ['src/ready/**'] }]);

    const result = await run(ix.get(ITowerMergeTool), { branch: mission!.branch });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('only a completed mission can merge');
  });

  it('closes a zero-diff survey as a noop', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([
      { title: 'scan all', scope: ['src/**'], kind: 'survey' },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await store.updateMission('tower', mission!.id, { status: 'completed' });

    const result = await run(ix.get(ITowerMergeTool), { branch: mission!.branch });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('read-only survey with a zero-diff branch');
    expect(result.output).toContain('ready for TowerTeardown');
  });

  it('does not suggest teardown while another mission is still open', async () => {
    const { store, branch } = await setupMergeableMission();
    await store.plan([{ title: 'later work', scope: ['src/later/**'] }]);

    const result = await run(ix.get(ITowerMergeTool), { branch });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Continue with the remaining missions in Dependency Flow order.');
    expect(result.output).not.toContain('ready for TowerTeardown');
  });

  it('reports a partial merge when the branch advances during the merge', async () => {
    const { branch, worktree } = await setupMergeableMission();
    await mkdir(join(repo, '.git/hooks'), { recursive: true });
    const hook = join(repo, '.git/hooks/post-merge');
    await writeFile(
      hook,
      `#!/bin/sh\ngit -C '${worktree}' commit --allow-empty -m 'advanced during merge'\n`,
    );
    await chmod(hook, 0o755);

    const result = await run(ix.get(ITowerMergeTool), { branch });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('PARTIAL MERGE');
    expect(result.output).toContain('was not marked merged');
  });
});

describe('TowerTeardownTool', () => {
  it('tears down the workspace and exits tower mode', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerTeardownTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
    expect(result.output).toContain('Tower mode exited.');
    expect(towerActive).toBe(false);
  });

  it('refuses to tear down while the owning session is live in this process', async () => {
    await initViaTool();
    liveSessionIds = ['session-test'];
    currentSessionId = 'session-next';

    const result = await run(ix.get(ITowerTeardownTool), {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain('dismantle that session');
    expect((await new TowerStore(repo).load()).sessionId).toBe('session-test');
  });
});

describe('TowerSendTool + TowerInboxTool', () => {
  beforeEach(async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId: 'agent-w1',
      spawnedAt: new Date().toISOString(),
    });
    await store.registerAgent({
      name: 'w2',
      kind: 'worker',
      agentId: 'agent-w2',
      spawnedAt: new Date().toISOString(),
    });
  });

  it('worker inbox shows only own and broadcast messages; the tower sees everything', async () => {
    await run(ix.get(ITowerSendTool), { to: 'w1', subject: 'for w1', body: 'a' });
    await run(ix.get(ITowerSendTool), { to: 'w2', subject: 'for w2', body: 'b' });
    await run(ix.get(ITowerSendTool), { to: 'all', subject: 'broadcast', body: 'c' });

    currentAgentId = 'agent-w1';
    const w1Inbox = await run(ix.get(ITowerInboxTool), {});
    expect(w1Inbox.isError).toBeFalsy();
    expect(w1Inbox.output).toContain('2 message(s) for w1');
    expect(w1Inbox.output).toContain('subject: for w1');
    expect(w1Inbox.output).toContain('subject: broadcast');
    expect(w1Inbox.output).not.toContain('subject: for w2');

    currentAgentId = 'agent-w1';
    await run(ix.get(ITowerSendTool), { to: 'tower', subject: 'report', body: 'd' });

    currentAgentId = 'main';
    const towerInbox = await run(ix.get(ITowerInboxTool), {});
    expect(towerInbox.output).toContain('4 message(s) for tower');
    for (const subject of ['for w1', 'for w2', 'broadcast', 'report']) {
      expect(towerInbox.output).toContain(`subject: ${subject}`);
    }
  });

  it('maps a TowerProtocolError (unknown recipient) to an isError result', async () => {
    const result = await run(ix.get(ITowerSendTool), {
      to: 'ghost',
      subject: 'hi',
      body: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unknown recipient "ghost"');
    expect(result.output).toContain('known: tower, all, w1, w2');
  });
});

describe('TowerStatusTool', () => {
  it('renders the dashboard including the rate-limiter concurrency section', async () => {
    await initViaTool();

    const result = await run(ix.get(ITowerStatusTool), {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch), you are: tower');
    expect(result.output).toContain('(no missions planned — use TowerPlan)');
    expect(result.output).toContain('budget: 2 agent(s) · inflight: 0 · spawns open');
  });
});

describe('tool registration', () => {
  it('declares no when gate on any tower tool contribution', () => {
    for (const contribution of TOWER_TOOL_CONTRIBUTIONS) {
      expect('when' in contribution, contribution.name).toBe(false);
    }
  });

  it('rejects orchestration tools at execution time for non-main agents', async () => {
    currentAgentId = 'agent-w1';
    const cases: readonly (readonly [ServiceIdentifier<AnyAgentTool>, unknown])[] = [
      [ITowerInitTool, {}],
      [ITowerPlanTool, { missions: [] }],
      [ITowerMergeTool, { branch: 'tower/x' }],
      [ITowerTeardownTool, {}],
    ];
    for (const [id, args] of cases) {
      const result = await run(ix.get(id), args as never);
      expect(result.isError).toBe(true);
      expect(result.output).toBe('Tower orchestration tools are only supported by the main agent.');
    }
    expect(towerActive).toBe(false);
    expect((await stat(join(repo, '.tower')).catch(() => undefined))).toBeUndefined();
  });
});

describe('TowerCompleteToolInputSchema', () => {
  it('accepts a report with optional key artifacts', () => {
    expect(TowerCompleteToolInputSchema.parse({ report: 'implemented the engine' })).toEqual({
      report: 'implemented the engine',
    });
    expect(
      TowerCompleteToolInputSchema.parse({
        report: 'implemented the engine',
        key_artifacts: ['src/engine/report.html'],
      }),
    ).toEqual({ report: 'implemented the engine', key_artifacts: ['src/engine/report.html'] });
  });

  it('rejects a blank report', () => {
    const attempt = (): unknown => TowerCompleteToolInputSchema.parse({ report: '   ' });

    expect(attempt).toThrow(ZodError);
    expect(attempt).toThrow(/report must not be empty/);
  });

  it('rejects a missing report and unknown keys', () => {
    expect(() => TowerCompleteToolInputSchema.parse({})).toThrow(ZodError);
    expect(() =>
      TowerCompleteToolInputSchema.parse({ report: 'done', mission: 'M1' }),
    ).toThrow(ZodError);
  });
});

describe('TowerRebaseToolInputSchema', () => {
  it('accepts a mission id', () => {
    expect(TowerRebaseToolInputSchema.parse({ mission: 'M3' })).toEqual({ mission: 'M3' });
  });

  it('rejects a missing mission and unknown keys', () => {
    expect(() => TowerRebaseToolInputSchema.parse({})).toThrow(ZodError);
    expect(() => TowerRebaseToolInputSchema.parse({ mission: 'M3', force: true })).toThrow(
      ZodError,
    );
  });
});

function deliveryState(agentName: string, agentId: string): TowerState {
  return {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: '2026-01-01T00:00:00.000Z',
    roster: {
      agents: [
        { name: agentName, agentId, kind: 'worker', spawnedAt: '2026-01-01T00:00:00.000Z' },
      ],
    },
    missions: [],
  };
}

function sentResult(to: string, overrides: Partial<TowerInboxItem> = {}): TowerSendResult {
  return {
    item: {
      file: '.tower/comms/inbox/message.md',
      from: 'tower',
      to,
      subject: 'get started',
      sentAt: '2026-01-01T00:00:00.000Z',
      body: 'please start',
      ...overrides,
    },
  };
}

describe('deliverTowerMessage', () => {
  it('publishes a TowerInboxSent event for a message addressed to the tower', async () => {
    const published: Event2<unknown>[] = [];
    const sessionBus = {
      publish: (event: Event2<unknown>) => {
        published.push(event);
      },
    } as unknown as ISessionEventBus;
    const sendMessage = vi.fn();

    const note = await deliverTowerMessage(
      {
        sessionBus,
        messaging: { sendMessage } as unknown as ISessionMessagingService,
        callerAgentId: 'agent-w1',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('tower', { from: 'w1' }),
    );

    expect(note).toBe('');
    expect(published).toHaveLength(1);
    const event = published[0] as TowerInboxSent;
    expect(event).toBeInstanceOf(TowerInboxSent);
    expect(event.from).toBe('w1');
    expect(event.to).toBe('tower');
    expect(event.subject).toBe('get started');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('steers a message into a running roster agent through the messaging service', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      delivery: 'steered',
      agentId: 'agent-w1',
      label: 'w1',
      truncated: false,
    });

    const note = await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: { sendMessage } as unknown as ISessionMessagingService,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1'),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'main',
      'agent-w1',
      expect.stringContaining('[tower inbox] new message from tower: "get started"'),
    );
    expect(note).toContain('steered into its running turn');
  });

  it('truncates an over-long subject inside the steer directive', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      delivery: 'steered',
      agentId: 'agent-w1',
      label: 'w1',
      truncated: false,
    });
    const subject = 's'.repeat(140);

    await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: { sendMessage } as unknown as ISessionMessagingService,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1', { subject }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'main',
      'agent-w1',
      expect.stringContaining('…'),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'main',
      'agent-w1',
      expect.not.stringContaining(subject),
    );
  });

  it.each<readonly [AgentMessageDelivery, string]>([
    ['newTurn', 'started a new turn'],
    ['resumed', 'resumed in the background'],
    ['duplicate', 'not delivered again'],
  ])('maps a %s delivery onto a delivery note', async (delivery, expected) => {
    const sendMessage = vi.fn().mockResolvedValue({
      delivery,
      agentId: 'agent-w1',
      label: 'w1',
      truncated: false,
    });

    const note = await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: { sendMessage } as unknown as ISessionMessagingService,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1'),
    );

    expect(note).toContain(expected);
  });

  it('falls back to the inbox when messaging is unavailable or steering fails', async () => {
    const unavailable = await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: undefined,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1'),
    );

    expect(unavailable).toContain('agent messaging is unavailable');
    expect(unavailable).toContain('stays in the tower inbox');

    const failing = {
      sendMessage: vi.fn().mockRejectedValue(new Error('no live turn')),
    } as unknown as ISessionMessagingService;
    const failed = await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: failing,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1'),
    );

    expect(failed).toContain('could not steer w1: no live turn');
    expect(failed).toContain('stays in the tower inbox');

    const failingWithText = {
      sendMessage: vi.fn().mockRejectedValue('boom'),
    } as unknown as ISessionMessagingService;
    const failedWithText = await deliverTowerMessage(
      {
        sessionBus: undefined,
        messaging: failingWithText,
        callerAgentId: 'main',
        state: deliveryState('w1', 'agent-w1'),
      },
      sentResult('w1'),
    );

    expect(failedWithText).toContain('could not steer w1: boom');
  });

  it('ignores unknown recipients and the tower addressing itself', async () => {
    const published: Event2<unknown>[] = [];
    const sessionBus = {
      publish: (event: Event2<unknown>) => {
        published.push(event);
      },
    } as unknown as ISessionEventBus;
    const services = {
      sessionBus,
      messaging: undefined,
      callerAgentId: 'main',
      state: deliveryState('w1', 'agent-w1'),
    };

    expect(await deliverTowerMessage(services, sentResult('ghost'))).toBe('');
    expect(await deliverTowerMessage(services, sentResult('tower', { from: 'tower' }))).toBe('');
    expect(published).toEqual([]);
  });
});

describe('TowerCompleteTool', () => {
  async function setupWorkerMission(): Promise<{ store: TowerStore; missionId: string }> {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([
      { title: 'complete me', scope: ['src/complete/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(
      join(repo, '.tower/worktrees', mission!.worktree),
      'src/complete/a.ts',
      'export const a = 1;\n',
      'mission work',
    );
    await store.registerAgent({
      name: 'w1',
      agentId: 'agent-w1',
      kind: 'worker',
      missionId: mission!.id,
      spawnedAt: new Date().toISOString(),
    });
    currentAgentId = 'agent-w1';
    return { store, missionId: mission!.id };
  }

  it('completes the worker mission and queues the review-request through delivery', async () => {
    const { store, missionId } = await setupWorkerMission();

    const result = await run(ix.get(ITowerCompleteTool), {
      report: 'implemented the mission',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`mission ${missionId} persisted as completed`);
    expect(result.output).toContain('review-request notification:');
    expect(result.output).toContain('notification: stored once');
    expect((await store.load()).missions.find((m) => m.id === missionId)?.status).toBe(
      'completed',
    );
    const inbox = await store.readInbox('tower', 20);
    expect(inbox.map((item) => item.subject)).toContain('review-request');
    expect(publishedEvents.some((event) => event instanceof TowerInboxSent)).toBe(true);
    expect(sendMessageStub).not.toHaveBeenCalled();
  });

  it('rejects schema-invalid args before touching the store', async () => {
    await initViaTool();
    const store = new TowerStore(repo);

    const result = await run(ix.get(ITowerCompleteTool), { report: '   ' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('report must not be empty');
    expect((await store.recentLog(20)).join('\n')).not.toContain('inbox.send');
  });

  it('maps a protocol refusal to an error result', async () => {
    const { store, missionId } = await setupWorkerMission();

    const result = await run(ix.get(ITowerCompleteTool), {
      report: 'done',
      key_artifacts: ['src/complete/a.ts'],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('key_artifacts is only supported for artifact missions');
    expect((await store.load()).missions.find((m) => m.id === missionId)?.status).toBe('planned');
  });

  it('reports a notification storage failure as an error result', async () => {
    const { store, missionId } = await setupWorkerMission();
    const inbox = join(repo, '.tower/comms/inbox');
    await chmod(inbox, 0o500);
    try {
      const result = await run(ix.get(ITowerCompleteTool), { report: 'done' });

      expect(result.isError).toBe(true);
      expect(result.output).toContain('notification error:');
      expect(result.output).toContain('was persisted as completed');
    } finally {
      await chmod(inbox, 0o700);
    }
    expect((await store.load()).missions.find((m) => m.id === missionId)?.status).toBe(
      'completed',
    );
  });
});
