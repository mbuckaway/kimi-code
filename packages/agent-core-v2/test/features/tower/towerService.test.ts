import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { TaskTerminatedNotice } from '#/agent/task/taskOps';
import { SubagentStarted } from '#/session/subagent/mirrorAgentRun';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { createReminderStub, lifecycleWithReminder } from '../reminder/stubs';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { runWillBeginStepHooks, type StubLoop } from '../../agent/loop/stubs';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import {
  TowerProtocolError,
  TowerStore,
  type TowerRosterEntry,
} from '#/features/tower/protocol/index';
import {
  IAgentTowerService,
  TOWER_FLAG_ID,
  TOWER_TOOL_NAMES,
  TOWER_WORKER_PROFILE,
  hasPinnedPermissionMode,
  towerEnterFailureMessage,
  type TowerExitReason,
} from '#/features/tower/tower';
import {
  TOWER_BASH_GUARD_PARSE_OPTIONS,
  analyzeTowerBashCommand,
  commandNeedsTowerGuard,
  towerWorkspaceOwned,
} from '#/features/tower/bashGuard';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { AgentTowerService, TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import { TowerInboxSent, towerKey } from '#/features/tower/towerOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { ToolCall } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ToolAccesses } from '#/tool/toolContract';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { stubFlag } from '../../app/flag/stubs';
import {
  appService,
  createTestAgent,
  type TestAgentContext,
} from '../../harness';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const execFileAsync = promisify(execFile);

async function initGitRepo(repo: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'tower-test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Tower Test'], { cwd: repo });
}

async function makeTowerRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'tower-enter-'));
  await initGitRepo(repo);
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
  return repo;
}

function ownerSessionHandle(input: {
  readonly busy: boolean;
  readonly title?: string;
  readonly onExit?: (reason: string) => void;
}): ISessionScopeHandle {
  const activity = {
    _serviceBrand: undefined,
    state: () => ({ busy: input.busy, mainTurnActive: input.busy, pendingInteraction: 'none' }),
    onDidChange: () => ({ dispose: () => {} }),
  };
  const metadata = {
    read: async () => ({
      id: 'session-original',
      title: input.title,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    }),
  };
  const ownerTower = {
    exit: async (reason?: TowerExitReason) => {
      input.onExit?.(reason ?? 'user');
    },
  };
  const mainHandle = {
    accessor: { get: (id: unknown) => (id === IAgentTowerService ? ownerTower : undefined) },
  };
  const lifecycle = {
    handleOf: (agentId: string) => (agentId === 'main' ? mainHandle : undefined),
  };
  const accessor = {
    get: (id: unknown) => {
      if (id === ISessionActivityView) return activity;
      if (id === ISessionMetadata) return metadata;
      if (id === IAgentLifecycleService) return lifecycle;
      return undefined;
    },
  };
  return {
    id: 'session-original',
    kind: 'session',
    accessor,
    dispose: () => {},
  } as unknown as ISessionScopeHandle;
}

_setTowerFeatureAssembledForTests(true);

const signal = new AbortController().signal;

let mainAgentContext: ReturnType<typeof makeAgentScopeContext>['agentContext'];

function stubMainAgentScope(ix: TestInstantiationService): void {
  const agentScope = makeAgentScopeContext({
    agentId: 'main',
    agentScope: testWireScope('wire', 'tower-test'),
    generation: 0,
  });
  ix.stub(IAgentScopeContext, agentScope);
  mainAgentContext = agentScope.agentContext;
  const bus = ix.get(IEventBus) as ISessionEventBus;
  if (typeof bus.activateAgent === 'function') bus.activateAgent(agentScope.agentContext);
}

function publishAsMain(ix: TestInstantiationService, event: Parameters<IEventBus['publish']>[0]): void {
  ix.get(IEventBus).publish(event, mainAgentContext);
}

function toolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function hookContext(toolCalls: ToolCall[]): ResolvedToolExecutionHookContext {
  return {
    turnId: 0,
    signal,
    toolCall: toolCalls[0]!,
    toolCalls,
    args: {},
    execution: { approvalRule: toolCalls[0]!.name, execute: async () => ({ output: '' }) },
  };
}

function writeHookContext(toolName: string, paths: readonly string[]): ResolvedToolExecutionHookContext {
  const call = toolCall(toolName, `call_${toolName.toLowerCase()}`);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: {},
    execution: {
      approvalRule: toolName,
      accesses: paths.flatMap((path) => ToolAccesses.writeFile(path)),
      execute: async () => ({ output: '' }),
    },
  };
}

function bashHookContext(command: string, cwd?: string): ResolvedToolExecutionHookContext {
  const call = toolCall('Bash', 'call_bash');
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args: cwd === undefined ? { command } : { command, cwd },
    execution: { approvalRule: 'Bash', execute: async () => ({ output: '' }) },
  };
}

function workspaceContextStub(workDir: string): ISessionWorkspaceContext {
  const root = resolve(workDir);
  return {
    _serviceBrand: undefined,
    workDir: root,
    additionalDirs: [],
    resolve: (path: string) => (isAbsolute(path) ? resolve(path) : resolve(root, path)),
    isWithin: (absPath: string) => absPath.startsWith(root),
    assertAllowed: (absPath: string) => absPath,
  };
}

describe('AgentTowerService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;
  let towerFlagOn: boolean;
  let addedTools: string[];
  let removedTools: string[];
  let activeTools: string[] | undefined;
  let liveSessionIds: string[];
  let fireUnitsChanged: () => void = () => {};

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    formatDenyMessage = vi.fn((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    towerFlagOn = true;
    ix.stub(IFlagService, stubFlag((id) => towerFlagOn && id === TOWER_FLAG_ID));
    liveSessionIds = [];
    ix.stub(ISessionManager, {
      get: (id: string) => (liveSessionIds.includes(id) ? {} : undefined),
    } as unknown as ISessionManager);
    ix.stub(IFeatureManager, {
      onDidChangeUnits: (handler: () => void) => {
        fireUnitsChanged = handler;
        return { dispose: () => {} };
      },
    } as unknown as IFeatureManager);
    addedTools = [];
    removedTools = [];
    activeTools = undefined;
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      getActiveToolNames: () => activeTools,
      addActiveTool: (name: string) => {
        addedTools.push(name);
        activeTools = [...(activeTools ?? []), name];
      },
      removeActiveTool: (name: string) => {
        removedTools.push(name);
        activeTools = activeTools?.filter((candidate) => candidate !== name);
      },
    } as unknown as IAgentProfileService);
    ix.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    ix.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix.stub(ISessionWorkspaceContext, workspaceContextStub('/nonexistent-tower-repo'));
    ix.stub(IBashParserService, new BashParserService());
    registerTestAgentWire(ix, testWireScope('wire', 'tower-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    stubMainAgentScope(ix);
    registerTestEventDispatcher(ix);
    ix.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
  });
  afterEach(() => disposables.dispose());

  async function fire(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    disposables.add(
      executorEvents.executor.onBeforeExecuteTool(() => {
        permissionGateRan = true;
      }),
    );
    return executorEvents.fireBeforeExecute(ctx);
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', async () => {
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    expect(tower.isActive).toBe(false);
    await expect(tower.enter()).resolves.toEqual({ entered: true });
    expect(tower.isActive).toBe(true);
    await tower.exit();
    expect(tower.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', towerMode: true },
      { type: 'agent.status.updated', towerMode: false },
    ]);
  });

  it('enter / exit are idempotent while already in that state', async () => {
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    await tower.exit();
    expect(tower.isActive).toBe(false);
    await expect(tower.enter()).resolves.toEqual({ entered: true });
    await expect(tower.enter()).resolves.toEqual({ entered: true });
    expect(tower.isActive).toBe(true);

    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: true }]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the flag (silent)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'tower_mode.enter', agentId: 'main', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.get(IAgentStateService).contributeState(towerKey);
    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-replay'),
      records,
    );
    expect(ix2.get(IAgentStateService).get(towerKey)).toBe(true);
  });

  it('replays legacy v1 tower_mode records written without a payload', async () => {
    const records: WireRecord[] = [
      { type: 'tower_mode.enter', time: 1 },
      { type: 'tower_mode.exit', time: 2 },
      { type: 'tower_mode.enter', time: 3 },
    ];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-legacy'), {
      log: ix2.get(IAppendLogStore),
    });
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.get(IAgentStateService).contributeState(towerKey);
    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-legacy'),
      records,
    );
    expect(ix2.get(IAgentStateService).get(towerKey)).toBe(true);
  });

  it('leaves AskUserQuestion alone while tower mode is active (the tower may ask)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on AskUserQuestion while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('AskUserQuestion', 'call_ask')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('vetoes TodoList while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('TodoList is not available while tower mode is active'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('abstains on TodoList while tower mode is inactive', async () => {
    ix.get(IAgentTowerService);

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('abstains on other tools while tower mode is active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('denies tower tools while the tower flag is off, even with the mode active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    towerFlagOn = false;

    const decision = await fire(hookContext([toolCall('TowerTeardown', 'call_td')]));

    expect(decision).toEqual({
      veto: {
        output: expect.stringContaining('The tower experiment is disabled'),
        isError: true,
      },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledTimes(1);
  });

  it('enter() returns experiment-off while the tower flag is off', async () => {
    towerFlagOn = false;
    const tower = ix.get(IAgentTowerService);
    const events: { readonly type: string }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') events.push({ type: e.type });
      }),
    );

    await expect(tower.enter()).resolves.toEqual({ entered: false, reason: 'experiment-off' });

    expect(tower.isActive).toBe(false);
    expect(events).toEqual([]);
  });

  it('enter() returns feature-not-assembled until the feature is assembled — a live flag flip needs a restart', async () => {
    _setTowerFeatureAssembledForTests(false);
    try {
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({
        entered: false,
        reason: 'feature-not-assembled',
      });

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
    } finally {
      _setTowerFeatureAssembledForTests(true);
    }
  });

  it('publishes towerMode:false when the tower feature becomes unavailable while active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    _setTowerFeatureAssembledForTests(false);
    try {
      fireUnitsChanged();

      expect(tower.isActive).toBe(false);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      _setTowerFeatureAssembledForTests(true);
    }
  });

  it('publishes towerMode:false when the flag is disabled through a live config change', async () => {
    let fireConfigChanged: () => void = () => {};
    ix.stub(IConfigService, {
      onDidChangeConfiguration: (handler: () => void) => {
        fireConfigChanged = handler;
        return { dispose: () => {} };
      },
    } as unknown as IConfigService);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );

    towerFlagOn = false;
    fireConfigChanged();

    expect(tower.isActive).toBe(false);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });

    towerFlagOn = true;
    fireConfigChanged();

    expect(tower.isActive).toBe(true);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: true });
  });

  it('enter() reports the live owner while a foreign session is busy with the tower', async () => {
    const repo = await makeTowerRepo();
    try {
      await new TowerStore(repo).init('session-original');

      let ownerExited = false;
      liveSessionIds = ['session-original'];
      ix.stub(ISessionManager, {
        get: (id: string) =>
          id === 'session-original'
            ? ownerSessionHandle({
                busy: true,
                title: 'Main session',
                onExit: () => {
                  ownerExited = true;
                },
              })
            : undefined,
      } as unknown as ISessionManager);
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'session-original',
        ownerTitle: 'Main session',
      });

      expect(tower.isActive).toBe(false);
      expect(addedTools).toEqual([]);
      expect(ownerExited).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() takes the tower over from an idle live session', async () => {
    const repo = await makeTowerRepo();
    try {
      await new TowerStore(repo).init('session-original');

      const exitReasons: string[] = [];
      liveSessionIds = ['session-original'];
      ix.stub(ISessionManager, {
        get: (id: string) =>
          id === 'session-original'
            ? ownerSessionHandle({
                busy: false,
                onExit: (reason) => {
                  exitReasons.push(reason);
                },
              })
            : undefined,
      } as unknown as ISessionManager);
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({ entered: true });

      expect(exitReasons).toEqual(['takeover']);
      expect(tower.isActive).toBe(true);
      expect((await new TowerStore(repo).load()).sessionId).toBe('session-fork');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter() adopts the tower once the owning session is gone — TowerInit stays reachable', async () => {
    const repo = await makeTowerRepo();
    try {
      await new TowerStore(repo).init('session-original');

      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({ entered: true });

      expect(tower.isActive).toBe(true);
      expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
      expect((await new TowerStore(repo).load()).sessionId).toBe('session-fork');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) initializes the tower on an existing local base branch', async () => {
    const repo = await makeTowerRepo();
    try {
      await execFileAsync('git', ['branch', 'release'], { cwd: repo });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter('release')).resolves.toEqual({ entered: true });

      const state = await new TowerStore(repo).load();
      expect(state.base).toBe('release');
      expect(state.sessionId).toBe('session-fork');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('enter(base) creates the base branch and snapshots a dirty checkout onto it', async () => {
    const repo = await makeTowerRepo();
    try {
      await new TowerStore(repo).init('session-original');
      await writeFile(join(repo, 'dirty.txt'), 'wip\n');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter('release')).resolves.toEqual({ entered: true });

      const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repo,
      });
      const { stdout: head } = await execFileAsync(
        'git',
        ['show', '--name-only', '--pretty=%s', 'HEAD'],
        { cwd: repo },
      );
      expect(branch.trim()).toBe('release');
      expect(head).toContain('tower: snapshot of uncommitted base checkout changes');
      expect(head).toContain('dirty.txt');
      expect((await new TowerStore(repo).load()).base).toBe('release');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exit releases tower ownership so a later session can adopt it', async () => {
    const repo = await makeTowerRepo();
    try {
      await new TowerStore(repo).init('session-fork');
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-fork' } as unknown as ISessionContext);
      const tower = ix.get(IAgentTowerService);

      await expect(tower.enter()).resolves.toEqual({ entered: true });
      expect((await new TowerStore(repo).load()).sessionId).toBe('session-fork');

      await tower.exit('user');

      expect((await new TowerStore(repo).load()).sessionId).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not veto TodoList while the tower flag is off, even with tower mode persisted active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);
    towerFlagOn = false;

    const decision = await fire(hookContext([toolCall('TodoList', 'call_todo')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
    expect(tower.isActive).toBe(false);
  });

  it('enter activates the tower tool set on the main agent; exit keeps it', async () => {
    const tower = ix.get(IAgentTowerService);

    await tower.enter();
    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
    expect(removedTools).toEqual([]);

    await tower.exit();
    expect(removedTools).toEqual([]);
  });

  it('enter is inert on a non-main agent', async () => {
    ix.stub(
      IAgentScopeContext,
      makeAgentScopeContext({ agentId: 'test-agent', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
    );
    const tower = ix.get(IAgentTowerService);

    await expect(tower.enter()).resolves.toEqual({ entered: false, reason: 'not-main-agent' });

    expect(tower.isActive).toBe(false);
    expect(addedTools).toEqual([]);

    await tower.exit();
    expect(removedTools).toEqual([]);
  });

  it('restore re-applies the tower tool set and re-emits the status while active', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'tower_mode.enter', agentId: 'main', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore'),
      records,
    );

    expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: true });
  });

  it('exit clears persisted tower state even while the tower flag is off', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(tower.isActive).toBe(true);

    towerFlagOn = false;
    expect(tower.isActive).toBe(false);

    await tower.exit();

    towerFlagOn = true;
    expect(tower.isActive).toBe(false);
  });

  it('reapplies the tower tool set when a profile change wipes the allow-list', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();
    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);

    addedTools.length = 0;
    activeTools = ['Bash'];
    const events: { readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    publishAsMain(ix, new AgentStatusUpdated({ agentId: 'main' }));

    expect(addedTools).toEqual([...TOWER_MODE_TOOLS]);
    expect(activeTools).toEqual(['Bash', ...TOWER_MODE_TOOLS]);
    expect(events).toContainEqual({ towerMode: true });
  });

  it('restore keeps the feature inert while the tower flag is off', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag(() => false));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-flag-off'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-flag-off'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toEqual([{ type: 'agent.status.updated', towerMode: false }]);
  });

  it('restore keeps a persisted enter record inert on a non-main agent', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-non-main'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-non-main'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toEqual([]);
  });

  it('exits a replayed tower mode when the store owner is another session (fork)', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
      ix2.stub(ISessionManager, {
        get: (id: string) => (id === 'session-original' ? {} : undefined),
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentLifecycleService,
        lifecycleWithReminder(createReminderStub()),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-restore'),
        records,
      );

      expect(restored.isActive).toBe(false);
      expect(restoredAdded).toEqual([]);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('keeps a replayed tower mode when the store owner session is gone — adoption survives resume', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-stale-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
      ix2.stub(ISessionManager, {
        get: () => undefined,
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentLifecycleService,
        lifecycleWithReminder(createReminderStub()),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-stale-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-stale-restore'),
        records,
      );

      expect(restored.isActive).toBe(true);
      expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
      expect(events).not.toContainEqual({ type: 'agent.status.updated', towerMode: false });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits a replayed tower mode on a fork restored while the flag is off when the owner is live', async () => {
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const repo = await mkdtemp(join(tmpdir(), 'tower-fork-flag-off-'));
    try {
      await initGitRepo(repo);
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repo });
      await new TowerStore(repo).init('session-original');

      const ix2 = disposables.add(new TestInstantiationService());
      ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
      ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      ix2.set(IEventBus, new SyncDescriptor(EventBusService));
      ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
      ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
      ix2.stub(IFlagService, stubFlag(() => false));
      ix2.stub(ISessionManager, {
        get: (id: string) => (id === 'session-original' ? {} : undefined),
      } as unknown as ISessionManager);
      ix2.stub(ISessionContext, {
        cwd: repo,
        sessionId: 'session-fork',
      } as unknown as ISessionContext);
      ix2.stub(
        IAgentLifecycleService,
        lifecycleWithReminder(createReminderStub()),
      );
      ix2.stub(IAgentContextMemoryService, {
        get: () => [],
      } as unknown as IAgentContextMemoryService);
      const restoredAdded: string[] = [];
      ix2.stub(IAgentProfileService, {
        data: () => ({ profileName: undefined }),
        addActiveTool: (name: string) => {
          restoredAdded.push(name);
        },
        removeActiveTool: () => {},
      } as unknown as IAgentProfileService);
      registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-flag-off-restore'), {
        log: ix2.get(IAppendLogStore),
        eventBus: ix2.get(IEventBus),
      });
      stubMainAgentScope(ix2);
      const dispatcher = registerTestEventDispatcher(ix2);
      ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
      const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
      disposables.add(
        ix2.get(IEventBus).subscribe((e) => {
          if (e.type === 'agent.status.updated') {
            events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
          }
        }),
      );
      const restored = ix2.get(IAgentTowerService);

      await restoreTestEventDispatcher(
        dispatcher,
        ix2.get(IAppendLogStore),
        testWireScope('wire', 'tower-fork-flag-off-restore'),
        records,
      );

      expect(restored.isActive).toBe(false);
      expect(restoredAdded).toEqual([]);
      expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
      expect(ix2.get(IAgentStateService).get(towerKey)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exits a replayed tower mode without a store when the enter record belongs to another session', async () => {
    ix.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-original',
    } as unknown as ISessionContext);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionManager, {
      get: (id: string) => (id === 'session-original' ? {} : undefined),
    } as unknown as ISessionManager);
    ix2.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-fork',
    } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-fork-noinit'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-fork-noinit'),
      records,
    );

    expect(restored.isActive).toBe(false);
    expect(restoredAdded).toEqual([]);
    expect(events).toContainEqual({ type: 'agent.status.updated', towerMode: false });
  });

  it('restores a pre-init tower mode on the owning session even without a store', async () => {
    ix.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-owner',
    } as unknown as ISessionContext);
    const tower = ix.get(IAgentTowerService);
    await tower.enter();

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'tower-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, {
      cwd: '/nonexistent-tower-repo',
      sessionId: 'session-owner',
    } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-resume-noinit'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    const events: { readonly type: string; readonly towerMode?: boolean }[] = [];
    disposables.add(
      ix2.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, towerMode: (e as AgentStatusUpdated).towerMode });
        }
      }),
    );
    const restored = ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-resume-noinit'),
      records,
    );

    expect(restored.isActive).toBe(true);
    expect(restoredAdded).toEqual([...TOWER_MODE_TOOLS]);
    expect(events).not.toContainEqual({ type: 'agent.status.updated', towerMode: false });
  });

  it('restore does not touch the profile tool overlay while tower mode is inactive', async () => {
    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IEventBus, new SyncDescriptor(EventBusService));
    ix2.stub(IAgentToolExecutorService, stubToolExecutorEvents().executor);
    ix2.stub(IAgentToolApprovalService, { formatDenyMessage });
    ix2.stub(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID));
    ix2.stub(ISessionContext, { cwd: '/nonexistent-tower-repo' } as unknown as ISessionContext);
    ix2.stub(
      IAgentLifecycleService,
      lifecycleWithReminder(createReminderStub()),
    );
    ix2.stub(IAgentContextMemoryService, {
      get: () => [],
    } as unknown as IAgentContextMemoryService);
    const restoredAdded: string[] = [];
    ix2.stub(IAgentProfileService, {
      data: () => ({ profileName: undefined }),
      addActiveTool: (name: string) => {
        restoredAdded.push(name);
      },
      removeActiveTool: () => {},
    } as unknown as IAgentProfileService);
    registerTestAgentWire(ix2, testWireScope('wire', 'tower-restore-idle'), {
      log: ix2.get(IAppendLogStore),
      eventBus: ix2.get(IEventBus),
    });
    stubMainAgentScope(ix2);
    const dispatcher = registerTestEventDispatcher(ix2);
    ix2.set(IAgentTowerService, new SyncDescriptor(AgentTowerService));
    ix2.get(IAgentTowerService);

    await restoreTestEventDispatcher(
      dispatcher,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'tower-restore-idle'),
      [],
    );

    expect(restoredAdded).toEqual([]);
  });

  describe('tower-worker write guard', () => {
    const WORKER_AGENT_ID = 'agent-worker-1';
    let repo: string;
    let worktree: string;

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd });
    }

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-guard-test-'));
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.email', 'tower-test@example.com');
      await git(repo, 'config', 'user.name', 'Tower Test');
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await git(repo, 'add', 'README.md');
      await git(repo, 'commit', '-m', 'initial');
      const store = new TowerStore(repo);
      await store.init();
      await store.registerAgent({
        name: 'agent-build',
        agentId: WORKER_AGENT_ID,
        kind: 'worker',
        missionId: 'M1',
        worktree: 'wt-1',
        branch: 'feat/build',
        spawnedAt: new Date().toISOString(),
      });
      worktree = join(repo, '.tower/worktrees/wt-1');

      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'tower-worker' }),
      } as unknown as IAgentProfileService);
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: WORKER_AGENT_ID, agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
      );
      ix.stub(ISessionContext, { cwd: repo } as unknown as ISessionContext);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it('allows a worker Write inside its own worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${worktree}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('denies a worker Write outside its worktree', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(
        writeHookContext('Edit', [`${repo}/src/gemm.cpp`, `${repo}/.tower/worktrees/wt-2/x.ts`]),
      );

      expect(decision?.veto?.isError).toBe(true);
      const output = decision?.veto?.output;
      expect(output).toContain(`tower workers may only write inside their own worktree (${worktree})`);
      expect(output).toContain(`${repo}/src/gemm.cpp`);
      expect(output).toContain(`${repo}/.tower/worktrees/wt-2/x.ts`);
      expect(output).toContain('TowerFinding');
      expect(output).toContain('TowerSend');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('abstains on non-Write/Edit tools for a worker', async () => {
      ix.get(IAgentTowerService);

      const decision = await fire(hookContext([toolCall('Bash', 'call_bash')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('guards worker writes even while the tower flag is off — isolation is identity-scoped', async () => {
      towerFlagOn = false;
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain(
        'tower workers may only write inside their own worktree',
      );
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('abstains when the agent is not a tower worker', async () => {
      ix.stub(IAgentProfileService, {
        data: () => ({ profileName: 'coder' }),
      } as unknown as IAgentProfileService);
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('abstains when the worker has no roster entry', async () => {
      ix.stub(
        IAgentScopeContext,
        makeAgentScopeContext({ agentId: 'agent-unregistered', agentScope: testWireScope('wire', 'tower-test'), generation: 0 }),
      );
      ix.get(IAgentTowerService);

      const decision = await fire(writeHookContext('Write', [`${repo}/src/gemm.cpp`]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });
  });

  describe('tower bash guard wiring', () => {
    let repo: string;
    let parser: BashParserService;
    let stateFile: string;

    async function git(cwd: string, ...args: string[]): Promise<void> {
      await execFileAsync('git', args, { cwd });
    }

    async function ownTowerWorkspace(): Promise<void> {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ sessionId: 'session-tower-owner' }));
    }

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'tower-bash-guard-'));
      await git(repo, 'init', '-b', 'main');
      await git(repo, 'config', 'user.email', 'tower-test@example.com');
      await git(repo, 'config', 'user.name', 'Tower Test');
      await writeFile(join(repo, 'README.md'), '# fixture\n');
      await git(repo, 'add', 'README.md');
      await git(repo, 'commit', '-m', 'initial');
      stateFile = join(repo, '.tower/comms/state.json');
      parser = new BashParserService();
      ix.stub(IBashParserService, parser);
      ix.stub(ISessionContext, { cwd: repo } as unknown as ISessionContext);
      ix.stub(ISessionWorkspaceContext, workspaceContextStub(repo));
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    it('denies a destructive Bash command in a tower-owned workspace', async () => {
      expect.assertions(5);
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('rm -rf .tower/comms'));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('`rm` is not allowed on tower protocol paths');
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledWith(
        expect.stringContaining('`rm` is not allowed on tower protocol paths'),
      );
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
    });

    it('denies git reset --hard at the main checkout root', async () => {
      expect.assertions(2);
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git reset --hard HEAD'));

      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain(
        '`git reset --hard` is not allowed in the tower main checkout',
      );
    });

    it('allows a non-destructive Bash command and never parses it', async () => {
      expect.assertions(4);
      await ownTowerWorkspace();
      const parse = vi.spyOn(parser, 'parse');
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git status'));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(parse).not.toHaveBeenCalled();
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('keeps the guard inert when the workspace is not tower-owned', async () => {
      expect.assertions(3);
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('rm -rf .tower'));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('keeps the guard inert when the state file carries no session id', async () => {
      expect.assertions(1);
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ sessionId: '' }));
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git reset --hard HEAD'));

      expect(decision).toBeUndefined();
    });

    it('resolves a relative cwd argument through the session workspace', async () => {
      expect.assertions(2);
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const insideWorktree = await fire(
        bashHookContext('git reset --hard HEAD', join('.tower', 'worktrees', 'M1')),
      );
      expect(insideWorktree).toBeUndefined();

      const insideMainCheckout = await fire(bashHookContext('git reset --hard HEAD', 'src'));
      expect(insideMainCheckout?.veto?.output).toContain('`git reset --hard` is not allowed');
    });

    it('resolves an absolute cwd argument as-is', async () => {
      expect.assertions(2);
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const insideWorktree = await fire(
        bashHookContext('git reset --hard HEAD', join(repo, '.tower/worktrees/M1')),
      );
      expect(insideWorktree).toBeUndefined();

      const atMainCheckout = await fire(bashHookContext('git reset --hard HEAD', repo));
      expect(atMainCheckout?.veto?.output).toContain('`git reset --hard` is not allowed');
    });

    it('defaults the analysis cwd to the workspace working directory, not the session cwd', async () => {
      expect.assertions(1);
      await ownTowerWorkspace();
      ix.stub(
        ISessionWorkspaceContext,
        workspaceContextStub(join(repo, '.tower/worktrees/M1')),
      );
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('git reset --hard HEAD'));

      expect(decision).toBeUndefined();
    });

    it.each<[string, () => ResolvedToolExecutionHookContext]>([
      ['a non-Bash tool', () => hookContext([toolCall('Read', 'call_read')])],
      ['a Bash call with no command', () => ({ ...bashHookContext('noop'), args: {} })],
      ['a Bash call with non-object args', () => ({ ...bashHookContext('noop'), args: 'nope' })],
      ['a Bash call with null args', () => ({ ...bashHookContext('noop'), args: null })],
      [
        'a Bash call with a non-string command',
        () => ({ ...bashHookContext('noop'), args: { command: 42 } }),
      ],
    ])('abstains for %s', async (_label, build) => {
      expect.assertions(2);
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const decision = await fire(build());

      expect(decision).toBeUndefined();
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('still guards a tower-owned workspace when the tower flag is off', async () => {
      expect.assertions(1);
      towerFlagOn = false;
      await ownTowerWorkspace();
      ix.get(IAgentTowerService);

      const decision = await fire(bashHookContext('rm -rf .tower/comms'));

      expect(decision?.veto?.output).toContain('`rm` is not allowed on tower protocol paths');
    });
  });

  describe('branch leases', () => {
    it('holds the lease while the guarded operation runs and frees it afterwards', async () => {
      const tower = ix.get(IAgentTowerService);
      let observed: boolean | undefined;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const run = tower.withBranchLease('tower/M1', async () => {
        observed = tower.isBranchLeased('tower/M1');
        await gate;
        return 'done';
      });

      expect(tower.isBranchLeased('tower/M1')).toBe(true);
      expect(tower.isBranchLeased('tower/M2')).toBe(false);
      await expect(tower.withBranchLease('tower/M1', async () => 'second')).rejects.toThrow(
        TowerProtocolError,
      );
      await expect(tower.withBranchLease('tower/M1', async () => 'second')).rejects.toThrow(
        /leased by another tower merge\/rebase/,
      );

      release();
      await expect(run).resolves.toBe('done');
      expect(observed).toBe(true);
      expect(tower.isBranchLeased('tower/M1')).toBe(false);
    });

    it('frees the lease when the guarded operation throws', async () => {
      const tower = ix.get(IAgentTowerService);

      await expect(
        tower.withBranchLease('tower/M1', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(tower.isBranchLeased('tower/M1')).toBe(false);
    });

    it('does not serialize different mission branches', async () => {
      const tower = ix.get(IAgentTowerService);

      const results = await Promise.all([
        tower.withBranchLease('tower/M1', async () => 'one'),
        tower.withBranchLease('tower/M2', async () => 'two'),
      ]);

      expect(results).toEqual(['one', 'two']);
    });
  });

  describe('worker death tracking', () => {
    let repo: string;

    beforeEach(async () => {
      repo = await makeTowerRepo();
      const store = new TowerStore(repo);
      await store.init('session-test');
      await store.registerAgent({
        name: 'w1',
        agentId: 'agent-w1',
        sessionId: 'session-test',
        kind: 'worker',
        missionId: 'M1',
        branch: 'tower/M1',
        worktree: 'M1',
        spawnedAt: new Date().toISOString(),
      });
      ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-test' } as unknown as ISessionContext);
      await ix.get(IAgentTowerService).enter();
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    async function rosterEntry(): Promise<TowerRosterEntry | undefined> {
      const state = await new TowerStore(repo).load();
      return state.roster.agents.find((agent) => agent.agentId === 'agent-w1');
    }

    it('markAgentDied writes the roster fields surfaced by status', async () => {
      const tower = ix.get(IAgentTowerService);

      await expect(tower.markAgentDied('agent-w1', 'failed', 'boom')).resolves.toBe(true);

      const entry = await rosterEntry();
      expect(entry?.deathStatus).toBe('failed');
      expect(entry?.deathReason).toBe('boom');
      expect(entry?.diedAt).toBeDefined();
    });

    it('markAgentDied ignores an agent outside the roster', async () => {
      const tower = ix.get(IAgentTowerService);

      await expect(tower.markAgentDied('agent-ghost', 'failed', 'boom')).resolves.toBe(false);
    });

    it('clearAgentDied revives the roster entry', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.markAgentDied('agent-w1', 'failed', 'boom');

      await expect(tower.clearAgentDied('agent-w1')).resolves.toBe(true);

      const entry = await rosterEntry();
      expect(entry?.diedAt).toBeUndefined();
      expect(entry?.deathStatus).toBeUndefined();
    });

    it('marks the roster agent died when its background task terminates abnormally', async () => {
      publishAsMain(
        ix,
        new TaskTerminatedNotice({
          agentId: 'main',
          info: {
            kind: 'agent',
            taskId: 'task-1',
            agentId: 'agent-w1',
            description: 'worker',
            status: 'failed',
            startedAt: 0,
            endedAt: 1,
            stopReason: 'kaput',
          },
        }),
      );

      await vi.waitFor(async () => {
        const entry = await rosterEntry();
        expect(entry?.deathStatus).toBe('failed');
        expect(entry?.deathReason).toBe('kaput');
      });
    });

    it('ignores a completed task termination', async () => {
      publishAsMain(
        ix,
        new TaskTerminatedNotice({
          agentId: 'main',
          info: {
            kind: 'agent',
            taskId: 'task-1',
            agentId: 'agent-w1',
            description: 'worker',
            status: 'completed',
            startedAt: 0,
            endedAt: 1,
          },
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await rosterEntry())?.diedAt).toBeUndefined();
    });

    it('clears the death mark when the subagent starts again', async () => {
      const tower = ix.get(IAgentTowerService);
      await tower.markAgentDied('agent-w1', 'failed', 'boom');

      publishAsMain(ix, new SubagentStarted({ subagentId: 'agent-w1' }));

      await vi.waitFor(async () => {
        expect((await rosterEntry())?.diedAt).toBeUndefined();
      });
    });
  });
});

async function injectDynamic(ctx: TestAgentContext): Promise<void> {
  await runWillBeginStepHooks(ctx.get(IAgentLoopService) as StubLoop, false);
}

function appendAssistantTurn(
  ctx: TestAgentContext,
  context: IAgentContextMemoryService,
  text: string,
): void {
  ctx.appendAssistantTurn(context.get().length, text);
}

function towerReminderMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'tower_mode';
  });
}

function lastTowerReminder(context: IAgentContextMemoryService): string {
  const message = towerReminderMessages(context).at(-1);
  if (message === undefined) return '';
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

describe('TowerModeInjection', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tower: IAgentTowerService;
  let towerFlagOn: boolean;
  let cwd: string;

  beforeEach(async () => {
    towerFlagOn = true;
    cwd = await mkdtemp(join(tmpdir(), 'tower-injection-'));
    ctx = createTestAgent(
      { cwd },
      appService(IFlagService, stubFlag((id) => towerFlagOn && id === TOWER_FLAG_ID)),
    );
    context = ctx.get(IAgentContextMemoryService);
    tower = ctx.get(IAgentTowerService);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('injects the full reminder when tower mode turns on', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    const text = lastTowerReminder(context);

    expect(text).toContain('Tower mode is active');
    expect(text).toContain('TowerSpawn');
    expect(text).toContain('TowerMerge');
  });

  it('injects the exit reminder when tower mode turns off after being active', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    await tower.exit();
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
    expect(lastTowerReminder(context)).toContain('Tower mode is no longer active');
  });

  it('emits the exit reminder once when the tower flag is turned off with an active reminder in context', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    expect(towerReminderMessages(context)).toHaveLength(1);

    towerFlagOn = false;
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
    expect(lastTowerReminder(context)).toContain('Tower mode is no longer active');

    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);
  });

  it('does not inject anything when tower mode is inactive from the start', async () => {
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(0);
    expect(context.get()).toHaveLength(0);
  });

  it('skips reinjection before the assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(1);
  });

  it('injects the sparse reminder after the short assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    appendAssistantTurn(ctx, context, 'assistant two');
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode still active');
    expect(text).toContain('never create or edit protocol artifacts under `.tower/comms/` by hand');
  });

  it('refreshes the full reminder after the long assistant-turn threshold', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    for (let i = 0; i < 5; i += 1) {
      appendAssistantTurn(ctx, context, `assistant ${String(i)}`);
    }
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode is active');
    expect(text).not.toContain('Tower mode still active');
  });

  it('refreshes the full reminder when a user message follows at least one assistant turn', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    appendAssistantTurn(ctx, context, 'assistant one');
    ctx.appendUserMessage([{ type: 'text', text: 'next task' }]);
    await injectDynamic(ctx);

    const text = lastTowerReminder(context);
    expect(text).toContain('Tower mode is active');
    expect(text).not.toContain('Tower mode still active');
  });

  it('does not duplicate the full reminder when the first objective follows activation directly', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    ctx.appendUserMessage([{ type: 'text', text: 'first objective' }]);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(1);
  });

  it('emits the exit reminder only once and returns the full reminder on re-entry', async () => {
    await tower.enter();

    await injectDynamic(ctx);
    await tower.exit();
    await injectDynamic(ctx);
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(2);

    await tower.enter();
    await injectDynamic(ctx);

    expect(towerReminderMessages(context)).toHaveLength(3);
    expect(lastTowerReminder(context)).toContain('Tower mode is active');
  });
});

describe('tower mode API helpers', () => {
  it('lists TowerRebase among the tower tool names', () => {
    expect(TOWER_TOOL_NAMES).toContain('TowerRebase');
  });

  it('pins the permission mode only for the tower-worker profile', () => {
    expect(hasPinnedPermissionMode(TOWER_WORKER_PROFILE)).toBe(true);
    expect(hasPinnedPermissionMode('coder')).toBe(false);
    expect(hasPinnedPermissionMode(undefined)).toBe(false);
  });

  it('describes every enter failure', () => {
    expect(towerEnterFailureMessage({ entered: false, reason: 'not-main-agent' })).toBe(
      'tower mode is only supported by the main agent',
    );
    expect(towerEnterFailureMessage({ entered: false, reason: 'experiment-off' })).toContain(
      'KIMI_CODE_EXPERIMENTAL_TOWER=1',
    );
    expect(towerEnterFailureMessage({ entered: false, reason: 'feature-not-assembled' })).toContain(
      'restart is required',
    );
    expect(
      towerEnterFailureMessage({ entered: false, reason: 'owned-by-live-session', owner: 'sess-1' }),
    ).toBe('another live session owns the workspace tower (session sess-1)');
    expect(
      towerEnterFailureMessage({
        entered: false,
        reason: 'owned-by-live-session',
        owner: 'sess-1',
        ownerTitle: 'Main session',
      }),
    ).toBe('another live session owns the workspace tower (session Main session (sess-1))');
  });
});

describe('TowerInboxSent', () => {
  it('declares an observable event carrying the inbox message metadata', () => {
    const event = new TowerInboxSent({
      from: 'tower',
      to: 'w1',
      subject: 'review done',
      messageId: 'msg-1',
      file: '.tower/comms/inbox/msg-1.md',
      sentAt: '2026-01-01T00:00:00.000Z',
      missionId: 'M1',
    });

    expect(event.type).toBe('tower.inbox.sent');
    expect(TowerInboxSent.observable).toBe(true);
    expect(TowerInboxSent.durable).toBe(false);
    expect(event.messageId).toBe('msg-1');
    expect(event.missionId).toBe('M1');
    expect(event.serialize()).toMatchObject({
      type: 'tower.inbox.sent',
      from: 'tower',
      to: 'w1',
      subject: 'review done',
    });
  });
});

describe('tower bash guard', () => {
  const parser = new BashParserService();
  const parse = (source: string) => parser.parse(source, TOWER_BASH_GUARD_PARSE_OPTIONS);
  let mainCheckout: string;

  beforeEach(async () => {
    mainCheckout = await mkdtemp(join(tmpdir(), 'tower-guard-test-'));
  });

  afterEach(async () => {
    await rm(mainCheckout, { recursive: true, force: true });
  });

  const analyze = (command: string, cwd = mainCheckout): string | undefined =>
    analyzeTowerBashCommand({ command, cwd, mainCheckout }, parse);

  it.each([
    ['ls -la', false],
    ['git status', false],
    ['git clean -fdx', true],
    ['git reset --hard HEAD', true],
    ['rm -rf build', true],
  ])('commandNeedsTowerGuard(%s) is %s', (command, expected) => {
    expect(commandNeedsTowerGuard(command)).toBe(expected);
  });

  it('vetoes git reset --hard in the main checkout but allows it in a mission worktree', () => {
    expect(analyze('git reset --hard HEAD')).toContain('git reset --hard');

    expect(analyze('git reset --hard HEAD', join(mainCheckout, '.tower/worktrees/M1'))).toBe(
      undefined,
    );
  });

  it('vetoes forced ignored-file clean at the main checkout but not in a worktree or without -x', () => {
    expect(analyze('git clean -fdx')).toContain('git clean');
    expect(analyze('git clean -fd')).toBeUndefined();
    expect(analyze('git clean -fdx', join(mainCheckout, '.tower/worktrees/M1'))).toBeUndefined();
  });

  it('vetoes recursive removal of the tower root and any removal inside comms', () => {
    expect(analyze('rm -rf .tower')).toContain('`rm` is not allowed');
    expect(analyze('rm -f .tower/comms/state.json')).toContain('`rm` is not allowed');
    expect(analyze('rm -rf .tower/worktrees/M1/build')).toBeUndefined();
    expect(analyze('rm -f notes.txt')).toBeUndefined();
  });

  it('looks through privilege wrappers, launch wrappers, and nested shells', () => {
    expect(analyze('sudo git reset --hard')).toContain('git reset --hard');
    expect(analyze('env FOO=1 git reset --hard')).toContain('git reset --hard');
    expect(analyze("bash -c 'git reset --hard'")).toContain('git reset --hard');
  });

  it('blocks conservatively when the command cannot be analyzed', () => {
    expect(
      analyzeTowerBashCommand(
        { command: 'git reset --hard', cwd: mainCheckout, mainCheckout },
        () => ({ ok: false, reason: 'aborted' }),
      ),
    ).toContain('could not parse');
  });

  it('treats a state file with a session id as a tower-owned workspace', async () => {
    const stateFile = join(mainCheckout, '.tower/comms/state.json');
    await expect(towerWorkspaceOwned(stateFile)).resolves.toBe(false);

    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ sessionId: 'sess-1' }));
    await expect(towerWorkspaceOwned(stateFile)).resolves.toBe(true);

    await writeFile(stateFile, JSON.stringify({ sessionId: '' }));
    await expect(towerWorkspaceOwned(stateFile)).resolves.toBe(false);
  });
});
