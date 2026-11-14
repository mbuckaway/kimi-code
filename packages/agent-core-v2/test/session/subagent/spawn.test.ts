import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AGENTS_MD_RECOMMENDED_MAX_BYTES } from '#/agent/profile/context';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { Error2, ErrorCodes, errorInfo, isError2 } from '#/errors';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { RuntimeLease } from '#/runtime/runtime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { SECONDARY_MODEL_SECTION } from '#/session/subagent/configSection';
import { AGENT_PERSONA_FLAG_ID, SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { SessionSubagentService } from '#/session/subagent/subagentService';
import {
  FORK_CONTEXT_NOTICE,
  PERSONA_EXPERIMENTAL_UNAVAILABLE,
  PERSONA_WITH_FORK_UNAVAILABLE,
  type SpawnedSubagent,
  type SpawnSubagentOptions,
  type SubagentSpawnPlan,
  type SubagentSpawnPlanInput,
} from '#/session/subagent/spawn';

import { stubLog } from '../../_base/log/stubs';
import { stubFlag } from '../../app/flag/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { stubAgentContext } from '../../agent/agentContext/stubs';

const CALLER_ID = 'main';

const PATH_PERSONA_TEXT = [
  '---',
  'name: security-review',
  'description: Security review persona',
  'extends: coder',
  'tools: Read, Grep',
  'disallowedTools: Bash',
  'subagents: explore',
  '---',
  'You audit code for security issues.',
].join('\n');

const REGULAR_FILE_STAT: HostFileStat = {
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  size: 128,
};

describe('SessionSubagentService planSpawn and spawn', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let callerData: ProfileData;
  let profiles: AgentProfile[];
  let modelIds: Set<string>;
  let modelMeta: Map<string, Partial<Model>>;
  let caller: IAgentScopeHandle;
  let createdHandles: Map<string, IAgentScopeHandle>;
  let createAgent: Mock<
    (input?: { readonly agentId?: string }) => Promise<ReturnType<typeof stubAgentContext>>
  >;
  let forkAgent: ReturnType<typeof vi.fn>;
  let acquireRuntime: ReturnType<typeof vi.fn>;
  let callerPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let createdPermissionMode: { mode: string; setMode: ReturnType<typeof vi.fn> };
  let callerUserTools: IAgentUserToolService;
  let createdUserTools: IAgentUserToolService;
  let lease: RuntimeLease;
  let sessionAgents: Record<string, AgentMeta>;
  let removeAgent: Mock<(context: AgentContext) => Promise<void>>;
  let unregisterAgent: Mock<(agentId: string) => Promise<void>>;
  let registerAgent: ReturnType<typeof vi.fn>;
  let hostFs: {
    lstat: Mock<(path: string) => Promise<HostFileStat>>;
    readText: Mock<(path: string) => Promise<string>>;
  };
  let workspaceContext: {
    resolve: Mock<(rel: string) => string>;
    assertAllowed: Mock<(path: string, op: string) => string>;
  };

  function userToolsStub(): IAgentUserToolService {
    return {
      _serviceBrand: undefined,
      list: () => [],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
  }

  function profileServiceStub(data: ProfileData): IAgentProfileService {
    return {
      _serviceBrand: undefined,
      data: () => data,
      getActiveToolNames: () => data.activeToolNames,
    } as unknown as IAgentProfileService;
  }

  function createdHandle(agentId: string): IAgentScopeHandle {
    return {
      id: agentId,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) => {
          if (serviceId === IAgentProfileService) {
            return profileServiceStub({ ...callerData, modelCapabilities: {} as never });
          }
          if (serviceId === IAgentPermissionModeService) return createdPermissionMode;
          if (serviceId === IAgentUserToolService) return createdUserTools;
          if (serviceId === IAgentScopeContext) {
            return makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}` });
          }
          return undefined;
        },
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    sessionAgents = { main: { type: 'main' } };
    removeAgent = vi.fn(async () => {});
    unregisterAgent = vi.fn(async () => {});
    registerAgent = vi.fn(async (agentId: string, meta: AgentMeta) => {
      sessionAgents[agentId] = meta;
    });
    callerData = {
      profileName: 'orchestrator',
      modelAlias: 'main-model',
      thinkingLevel: 'high',
      systemPrompt: 'caller prompt',
      modelCapabilities: {} as never,
    };
    profiles = [
      normalizeAgentProfile({
        name: 'coder',
        description: 'Coder',
        systemPrompt: () => 'coder',
      }),
      normalizeAgentProfile({
        name: 'explore',
        description: 'Explorer',
        systemPrompt: () => 'explore',
      }),
    ];
    modelIds = new Set(['main-model']);
    modelMeta = new Map();
    callerPermissionMode = { mode: 'auto', setMode: vi.fn() };
    createdPermissionMode = { mode: 'manual', setMode: vi.fn() };
    callerUserTools = userToolsStub();
    createdUserTools = userToolsStub();
    lease = {
      runtime: new FakeRuntime({ workspaceId: 'w1', runtimeId: 'acp:s1', generation: 'g1' }),
      track: (resource) => resource,
      dispose: vi.fn(),
    };
    acquireRuntime = vi.fn(() => lease);
    caller = {
      id: CALLER_ID,
      kind: LifecycleScope.Agent,
      accessor: {
        get: (serviceId: unknown) => {
          if (serviceId === IAgentProfileService) return profileServiceStub(callerData);
          if (serviceId === IAgentPermissionModeService) return callerPermissionMode;
          if (serviceId === IAgentUserToolService) return callerUserTools;
          if (serviceId === IAgentRuntimeService) {
            return {
              _serviceBrand: undefined,
              acquire: acquireRuntime,
            };
          }
          if (serviceId === IAgentScopeContext) {
            return {
              _serviceBrand: undefined,
              agentId: CALLER_ID,
              agentContext: stubAgentContext(CALLER_ID, 1),
              scope: () => '',
            };
          }
          return undefined;
        },
      } as IAgentScopeHandle['accessor'],
      dispose: () => {},
    };
    createdHandles = new Map();
    createAgent = vi.fn(async (input: { readonly agentId?: string } = {}) => {
      const agentId = input.agentId ?? 'agent-child';
      createdHandles.set(agentId, createdHandle(agentId));
      sessionAgents[agentId] = { type: 'sub', labels: { parentAgentId: CALLER_ID } };
      return stubAgentContext(agentId, 1);
    });
    forkAgent = vi.fn(async () => {
      createdHandles.set('agent-fork', createdHandle('agent-fork'));
      return stubAgentContext('agent-fork', 1);
    });
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: Event.None,
      onDidCreateScope: Event.None,
      onWillClose: Event.None,
      onDidClose: Event.None,
      create: createAgent,
      fork: forkAgent,
      get: (agentId: string) => (agentId === CALLER_ID ? stubAgentContext(CALLER_ID, 1) : undefined),
      handleOf: (agentId: string) =>
        agentId === CALLER_ID ? caller : createdHandles.get(agentId),
      list: () => [stubAgentContext(CALLER_ID, 1)],
      remove: removeAgent,
      broadcastPermissionMode: () => {},
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionAgentProfileCatalog, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None,
      get: (name: string) => profiles.find((profile) => profile.name === name),
      getDefault: () => profiles[0]!,
      list: () => profiles,
      inspect: (name: string) =>
        profiles.some((profile) => profile.name === name) ? { sourceId: 'builtin' } : undefined,
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (alias: string) => {
        if (!modelIds.has(alias)) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `Model "${alias}" is not configured in config.toml.`,
            { details: { model: alias } },
          );
        }
        return { id: alias, ...modelMeta.get(alias) } as Model;
      },
    } as unknown as IModelCatalog);
    ix.stub(ISessionContext, { _serviceBrand: undefined, cwd: '/repo' } as unknown as ISessionContext);
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None,
      read: vi.fn(
        async () =>
          ({
            id: 'session-1',
            createdAt: 0,
            updatedAt: 0,
            archived: false,
            agents: { ...sessionAgents },
          }) as SessionMeta,
      ),
      update: async () => {},
      setTitle: async () => {},
      setGeneratedTitleIfUncustomized: async () => false,
      setArchived: async () => {},
      registerAgent,
      unregisterAgent,
    } as ISessionMetadata);
    ix.stub(ILogService, stubLog());
    hostFs = {
      lstat: vi.fn(async () => REGULAR_FILE_STAT),
      readText: vi.fn(async () => PATH_PERSONA_TEXT),
    };
    workspaceContext = {
      resolve: vi.fn((rel: string) => `/repo/${rel}`),
      assertAllowed: vi.fn((path: string) => path),
    };
    ix.stub(IHostFileSystem, {
      _serviceBrand: undefined,
      lstat: hostFs.lstat,
      readText: hostFs.readText,
    } as unknown as IHostFileSystem);
    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: '/repo',
      additionalDirs: [],
      isWithin: () => true,
      resolve: workspaceContext.resolve,
      assertAllowed: workspaceContext.assertAllowed,
    } as unknown as ISessionWorkspaceContext);
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(
    configValues: Record<string, unknown> = {},
    secondaryModelEnabled = false,
    agentPersonaEnabled = false,
  ): ISessionSubagentService {
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.stub(
      IFlagService,
      stubFlag(
        (id) =>
          (secondaryModelEnabled && id === SECONDARY_MODEL_FLAG_ID) ||
          (agentPersonaEnabled && id === AGENT_PERSONA_FLAG_ID),
      ),
    );
    ix.set(ISessionSubagentService, new SyncDescriptor(SessionSubagentService));
    return ix.get(ISessionSubagentService);
  }

  async function planSpawnError(
    svc: ISessionSubagentService,
    input: SubagentSpawnPlanInput,
  ): Promise<Error2> {
    try {
      await svc.planSpawn(input);
    } catch (error) {
      if (!isError2(error)) throw error;
      return error;
    }
    throw new Error('planSpawn did not throw');
  }

  async function spawnError(
    svc: ISessionSubagentService,
    options: SpawnSubagentOptions,
  ): Promise<Error2> {
    try {
      await svc.spawn(options);
    } catch (error) {
      if (!isError2(error)) throw error;
      return error;
    }
    throw new Error('spawn did not throw');
  }

  function spawnNonForkChild(svc: ISessionSubagentService): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Review the file',
    });
  }

  function spawnForkChild(svc: ISessionSubagentService): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'orchestrator', model: 'main-model', thinking: 'high', fork: true },
      labels: { parentAgentId: 'main' },
      prompt: 'Continue the analysis',
    });
  }

  it('rejects an unknown subagent type', async () => {
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'ghost' });

    expect(error.code).toBe(ErrorCodes.PROFILE_UNKNOWN);
    expect(error.message).toBe('Unknown agent type: "ghost"');
  });

  it('rejects a subagent type outside the caller allowlist', async () => {
    callerData = { ...callerData, subagents: ['explore'] };
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.AGENT_TYPE_NOT_ALLOWED);
    expect(error.message).toBe(
      'Subagent type "coder" is not allowed for this agent. Allowed subagent types: explore.',
    );
  });

  it('rejects when the caller agent has no model bound', async () => {
    callerData = { ...callerData, modelAlias: undefined };
    const svc = service();

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.MODEL_NOT_CONFIGURED);
    expect(error.message).toBe('Caller agent has no model bound');
  });

  it('wraps an unresolvable pool model with the secondary-model config hint', async () => {
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/bad',
          models: { 'provider/bad': 'broken' },
        },
      },
      true,
    );

    const error = await planSpawnError(svc, { callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('passes [secondary_model].default_effort as the explicit subagent thinking', async () => {
    modelIds.add('provider/fast');
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
          defaultEffort: 'max',
        },
        thinking: { enabled: false },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'provider/fast',
      thinking: 'max',
      fork: false,
    });
  });

  it('prefers [secondary_model].default_effort over the bound model default_effort', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
          defaultEffort: 'max',
        },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBe('max');
  });

  it('falls back to the bound model default_effort when the section declares none', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBe('max');
  });

  it('leaves thinking unset for global resolution when thinking is disabled', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
        thinking: { enabled: false },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBeUndefined();
  });

  it('leaves the subagent thinking unset when the bound model declares no valid default_effort', async () => {
    modelIds.add('provider/fast');
    modelMeta.set('provider/fast', {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high'],
      defaultEffort: 'max',
    });
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast model' },
        },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan.thinking).toBeUndefined();
  });

  it('passes [secondary_model].default_effort with the forced model', async () => {
    modelIds.add('provider/fast');
    const svc = service(
      {
        [SECONDARY_MODEL_SECTION]: {
          force: true,
          defaultModel: 'provider/fast',
          defaultEffort: 'max',
        },
      },
      true,
    );

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'provider/fast',
      thinking: 'max',
      fork: false,
    });
  });

  it('inherits the caller model and thinking when the secondary-model experiment is off', async () => {
    const svc = service({
      [SECONDARY_MODEL_SECTION]: {
        defaultModel: 'provider/fast',
        models: { 'provider/fast': 'fast model' },
        defaultEffort: 'max',
      },
    });

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

    expect(plan).toEqual({
      profileName: 'coder',
      model: 'main-model',
      thinking: 'high',
      fork: false,
    });
  });

  it('skips the allowlist check when forking', async () => {
    callerData = { ...callerData, profileName: 'coder', subagents: ['explore'] };
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan.profileName).toBe('coder');
  });

  it('skips the unknown-profile check when forking', async () => {
    callerData = { ...callerData, profileName: 'ghost' };
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan.profileName).toBe('ghost');
  });

  it('returns the caller binding when forking', async () => {
    const svc = service();

    const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, fork: true });

    expect(plan).toEqual({
      profileName: 'orchestrator',
      model: 'main-model',
      thinking: 'high',
      fork: true,
    });
  });

  it('creates the child with the plan binding when the plan is not a fork', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: { profile: 'coder', model: 'provider/fast', thinking: 'low' },
      }),
    );
    expect(forkAgent).not.toHaveBeenCalled();
  });

  it('creates the child with the task labels when the plan is not a fork', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { parentAgentId: 'main' } }),
    );
  });

  it('creates the child on the acquired runtime lease', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'acp:s1' }));
  });

  it('inherits the caller permission mode and user tools', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(createdPermissionMode.setMode).toHaveBeenCalledWith('auto');
    expect(createdUserTools.inheritUserTools).toHaveBeenCalledWith(callerUserTools);
  });

  it('applies the profile prompt prefix to the spawned prompt', async () => {
    profiles = [
      normalizeAgentProfile({
        name: 'coder',
        description: 'Coder',
        promptPrefix: async () => 'FIXED-PREFIX',
        systemPrompt: () => 'coder',
      }),
    ];
    const svc = service();

    const spawned = await spawnNonForkChild(svc);

    expect(spawned).toEqual({
      agentId: 'agent-child',
      profileName: 'coder',
      model: 'provider/fast',
      promptText: 'FIXED-PREFIX\n\nReview the file',
    });
  });

  it('releases the runtime lease after spawn', async () => {
    const svc = service();

    await spawnNonForkChild(svc);

    expect(lease.dispose).toHaveBeenCalled();
  });

  it('delegates to manager.fork with the caller labels when the plan is a fork', async () => {
    const svc = service();

    await spawnForkChild(svc);

    expect(forkAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main' }),
      { labels: { parentAgentId: 'main' } },
    );
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('preserves the fork snapshot active tool names when inheriting user tools', async () => {
    callerData = { ...callerData, activeToolNames: ['Agent', 'Read'] };
    const svc = service();

    await spawnForkChild(svc);

    expect(createdUserTools.inheritUserTools).toHaveBeenCalledWith(callerUserTools, [
      'Agent',
      'Read',
    ]);
  });

  it('prefixes the prompt with the fork notice when the plan is a fork', async () => {
    const svc = service();

    const spawned = await spawnForkChild(svc);

    expect(spawned).toEqual({
      agentId: 'agent-fork',
      profileName: 'orchestrator',
      model: 'main-model',
      promptText: `${FORK_CONTEXT_NOTICE}\n\nContinue the analysis`,
    });
  });

  it('does not require the process capability when forking', async () => {
    acquireRuntime.mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });
    const svc = service();

    await expect(spawnForkChild(svc)).resolves.toMatchObject({ agentId: 'agent-fork' });

    expect(acquireRuntime).not.toHaveBeenCalled();
    expect(forkAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'main' }),
      { labels: { parentAgentId: 'main' } },
    );
  });

  it('wraps a create rejection with the secondary-model config hint', async () => {
    createAgent.mockRejectedValueOnce(
      new Error2(
        ErrorCodes.CONFIG_INVALID,
        'Model "provider/bad" is not configured in config.toml.',
        { details: { model: 'provider/bad' } },
      ),
    );
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/bad', thinking: 'low', fork: false },
      prompt: 'Review the file',
    });

    expect(error.code).toBe(ErrorCodes.CONFIG_INVALID);
    expect(error.message).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(error.message).toContain('comes from [secondary_model.models]');
  });

  it('spawn throws before creating anything when the caller runtime lease fails', async () => {
    acquireRuntime.mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });
    const svc = service();
    const plan: SubagentSpawnPlan = {
      profileName: 'coder',
      model: 'main-model',
      thinking: 'high',
      fork: false,
    };

    await expect(
      svc.spawn({ callerAgentId: CALLER_ID, plan, prompt: 'Review the file' }),
    ).rejects.toThrow('process capability is no longer available');

    expect(createAgent).not.toHaveBeenCalled();
    expect(forkAgent).not.toHaveBeenCalled();
  });

  function spawnNamed(svc: ISessionSubagentService, name: string): Promise<SpawnedSubagent> {
    return svc.spawn({
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      labels: { parentAgentId: 'main' },
      prompt: 'Review the file',
      name,
    });
  }

  it('rejects the reserved root name case-insensitively', async () => {
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'MAIN',
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_RESERVED);
    expect(error.message).toBe('The name "main" is reserved for the root agent.');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects a name that looks like an agent id', async () => {
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'agent-12',
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_INVALID);
    expect(error.message).toBe('Agent names must not look like an agent id ("agent-12").');
  });

  it.each(['has space', 'emoji🚀', 'slash/name', ''])(
    'rejects the invalid agent name %j',
    async (name) => {
      const svc = service();

      const error = await spawnError(svc, {
        callerAgentId: CALLER_ID,
        plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
        prompt: 'Review the file',
        name,
      });

      expect(error.code).toBe(ErrorCodes.AGENT_NAME_INVALID);
      expect(error.message).toContain('must be 1-64 characters of letters, digits, ".", "_" or "-"');
    },
  );

  it('accepts a 64-character name and rejects 65', async () => {
    const svc = service();

    await expect(spawnNamed(svc, 'a'.repeat(64))).resolves.toMatchObject({ profileName: 'coder' });
    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'a'.repeat(65),
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_INVALID);
  });

  it('stores the addressable name as a label on the created agent', async () => {
    const svc = service();

    await spawnNamed(svc, ' scout ');

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ labels: { parentAgentId: 'main', name: 'scout' } }),
    );
  });

  it('rejects a name already held by another subagent', async () => {
    sessionAgents['agent-4'] = { type: 'sub', labels: { parentAgentId: 'main', name: 'scout' } };
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'scout',
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_TAKEN);
    expect(error.message).toBe('An agent named "scout" already exists (agent-4).');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('rejects a name held by a parallel in-flight spawn', async () => {
    createAgent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const svc = service();
    void spawnNamed(svc, 'scout');
    await vi.waitFor(() => {
      expect(createAgent).toHaveBeenCalledTimes(1);
    });

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'scout',
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_TAKEN);
    expect(error.message).toBe(
      'An agent named "scout" is already reserved by an in-flight spawn.',
    );
  });

  it('reserves a name before the persisted-metadata uniqueness read', async () => {
    let releaseRead: (() => void) | undefined;
    const metadata = ix.get(ISessionMetadata) as unknown as {
      read: Mock<() => Promise<SessionMeta>>;
    };
    metadata.read.mockImplementation(
      () =>
        new Promise<SessionMeta>((resolve) => {
          releaseRead = () => {
            resolve({
              id: 'session-1',
              createdAt: 0,
              updatedAt: 0,
              archived: false,
              agents: { ...sessionAgents },
            });
          };
        }),
    );
    createAgent.mockImplementationOnce(() => new Promise<never>(() => {}));
    const svc = service();
    void spawnNamed(svc, 'scout');
    await Promise.resolve();

    const outcome = await Promise.race([
      spawnError(svc, {
        callerAgentId: CALLER_ID,
        plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
        prompt: 'Review the file',
        name: 'scout',
      }).then((error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
    ]);
    releaseRead?.();

    expect(outcome).toBe('An agent named "scout" is already reserved by an in-flight spawn.');
  });

  it('describes the agent name error codes', () => {
    expect(errorInfo(ErrorCodes.AGENT_NAME_INVALID)).toMatchObject({
      title: 'Invalid agent name',
      retryable: false,
    });
    expect(errorInfo(ErrorCodes.AGENT_NAME_RESERVED)).toMatchObject({
      title: 'That agent name is reserved',
      retryable: false,
    });
    expect(errorInfo(ErrorCodes.AGENT_NAME_TAKEN)).toMatchObject({
      title: 'That agent name is already in use',
      retryable: false,
    });
  });

  it('tears down a spawn that loses the name race to an earlier agent id', async () => {
    createAgent.mockImplementationOnce(async () => {
      sessionAgents['agent-8'] = {
        type: 'sub',
        labels: { parentAgentId: 'main', name: 'scout' },
      };
      createdHandles.set('agent-9', createdHandle('agent-9'));
      sessionAgents['agent-9'] = { type: 'sub', labels: { parentAgentId: 'main', name: 'scout' } };
      return stubAgentContext('agent-9', 1);
    });
    const svc = service();

    const error = await spawnError(svc, {
      callerAgentId: CALLER_ID,
      plan: { profileName: 'coder', model: 'provider/fast', thinking: 'low', fork: false },
      prompt: 'Review the file',
      name: 'scout',
    });

    expect(error.code).toBe(ErrorCodes.AGENT_NAME_TAKEN);
    expect(error.message).toBe('An agent named "scout" already exists (agent-8).');
    expect(removeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-9' }),
    );
    expect(unregisterAgent).toHaveBeenCalledWith('agent-9');
  });

  it('keeps a spawn that wins the name race against a later agent id', async () => {
    createAgent.mockImplementationOnce(async () => {
      createdHandles.set('agent-2', createdHandle('agent-2'));
      sessionAgents['agent-2'] = { type: 'sub', labels: { parentAgentId: 'main', name: 'scout' } };
      sessionAgents['agent-9'] = { type: 'sub', labels: { parentAgentId: 'main', name: 'scout' } };
      return stubAgentContext('agent-2', 1);
    });
    const svc = service();

    await expect(spawnNamed(svc, 'scout')).resolves.toMatchObject({ agentId: 'agent-2' });

    expect(removeAgent).not.toHaveBeenCalled();
    expect(unregisterAgent).not.toHaveBeenCalled();
  });

  describe('SessionSubagentService agent mutations', () => {
    function addSubagent(agentId: string, labels: Record<string, string> = {}): void {
      sessionAgents[agentId] = { type: 'sub', labels: { parentAgentId: CALLER_ID, ...labels } };
    }

    function attachHandle(agentId: string): void {
      createdHandles.set(agentId, createdHandle(agentId));
    }

    async function failure(action: Promise<unknown>): Promise<Error2> {
      try {
        await action;
      } catch (error) {
        if (!isError2(error)) throw error;
        return error;
      }
      throw new Error('expected the call to throw');
    }

    it('dismisses a child by id, removing the handle before unregistering metadata', async () => {
      const order: string[] = [];
      removeAgent.mockImplementation(async () => {
        order.push('remove');
      });
      unregisterAgent.mockImplementation(async () => {
        order.push('unregister');
      });
      addSubagent('agent-2');
      attachHandle('agent-2');
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, { ids: ['agent-2'] });

      expect(result.dismissed).toEqual([{ agentId: 'agent-2', ghost: false }]);
      expect(order).toEqual(['remove', 'unregister']);
      expect(removeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-2' }),
      );
      expect(unregisterAgent).toHaveBeenCalledWith('agent-2');
    });

    it('dismisses a ghost child by only unregistering its metadata', async () => {
      addSubagent('agent-2');
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, { ids: ['agent-2'] });

      expect(result.dismissed).toEqual([{ agentId: 'agent-2', ghost: true }]);
      expect(removeAgent).not.toHaveBeenCalled();
      expect(unregisterAgent).toHaveBeenCalledWith('agent-2');
    });

    it('dismisses every directly owned child and never main or a sibling', async () => {
      addSubagent('agent-1');
      addSubagent('agent-2', { parentAgentId: 'agent-1' });
      addSubagent('agent-3', { parentAgentId: 'agent-1' });
      addSubagent('agent-4');
      attachHandle('agent-2');
      attachHandle('agent-3');
      attachHandle('agent-4');
      const svc = service();

      const result = await svc.dismissAgents('agent-1', { all: true });

      expect(result.dismissed.map((entry) => entry.agentId)).toEqual(['agent-2', 'agent-3']);
      expect(removeAgent).toHaveBeenCalledTimes(2);
      expect(unregisterAgent).toHaveBeenCalledWith('agent-2');
      expect(unregisterAgent).toHaveBeenCalledWith('agent-3');
      expect(unregisterAgent).not.toHaveBeenCalledWith('main');
      expect(unregisterAgent).not.toHaveBeenCalledWith('agent-4');
      expect(removeAgent).not.toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'main' }),
      );
    });

    it('dismisses a child addressed by its name', async () => {
      addSubagent('agent-2', { name: 'scout' });
      attachHandle('agent-2');
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, { names: [' scout '] });

      expect(result.dismissed).toEqual([{ agentId: 'agent-2', name: 'scout', ghost: false }]);
      expect(unregisterAgent).toHaveBeenCalledWith('agent-2');
    });

    it('returns the dismissals in ids-then-names order', async () => {
      addSubagent('agent-2', { name: 'scout' });
      addSubagent('agent-3', { name: 'reviewer' });
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, {
        ids: ['agent-3'],
        names: ['scout'],
      });

      expect(result.dismissed.map((entry) => entry.agentId)).toEqual(['agent-3', 'agent-2']);
    });

    it('de-duplicates a target requested by both id and name', async () => {
      addSubagent('agent-2', { name: 'scout' });
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, {
        ids: ['agent-2'],
        names: ['scout'],
      });

      expect(result.dismissed).toHaveLength(1);
      expect(unregisterAgent).toHaveBeenCalledTimes(1);
      expect(unregisterAgent).toHaveBeenCalledWith('agent-2');
    });

    it('validates every target before mutating anything when one id is not owned', async () => {
      addSubagent('agent-2');
      attachHandle('agent-2');
      sessionAgents['agent-5'] = { type: 'sub', labels: { parentAgentId: 'agent-9' } };
      const svc = service();

      const error = await failure(
        svc.dismissAgents(CALLER_ID, { ids: ['agent-2', 'agent-5'] }),
      );

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_OWNED);
      expect(error.message).toBe('Agent "agent-5" is not owned by "main".');
      expect(removeAgent).not.toHaveBeenCalled();
      expect(unregisterAgent).not.toHaveBeenCalled();
    });

    it('validates every target before mutating anything when one id is unknown', async () => {
      addSubagent('agent-2');
      attachHandle('agent-2');
      const svc = service();

      const error = await failure(
        svc.dismissAgents(CALLER_ID, { ids: ['agent-2', 'agent-404'] }),
      );

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_FOUND);
      expect(error.details).toEqual({ agentId: 'agent-404' });
      expect(removeAgent).not.toHaveBeenCalled();
      expect(unregisterAgent).not.toHaveBeenCalled();
    });

    it('rejects dismissing the caller itself', async () => {
      addSubagent('agent-1');
      const svc = service();

      const error = await failure(svc.dismissAgents('agent-1', { ids: ['agent-1'] }));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_OWNED);
      expect(error.message).toBe('An agent cannot target itself.');
    });

    it('rejects dismissing the root agent', async () => {
      const svc = service();

      const error = await failure(svc.dismissAgents(CALLER_ID, { ids: ['main'] }));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_A_SUBAGENT);
      expect(error.message).toBe('The root agent "main" is not a subagent.');
      expect(removeAgent).not.toHaveBeenCalled();
    });

    it('rejects dismissing an unknown agent id', async () => {
      const svc = service();

      const error = await failure(svc.dismissAgents(CALLER_ID, { ids: ['agent-404'] }));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_FOUND);
      expect(error.message).toBe('Agent "agent-404" does not exist.');
      expect(error.details).toEqual({ agentId: 'agent-404' });
    });

    it('returns no dismissals when no target is requested', async () => {
      addSubagent('agent-2');
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, {});

      expect(result).toEqual({ dismissed: [] });
      expect(removeAgent).not.toHaveBeenCalled();
      expect(unregisterAgent).not.toHaveBeenCalled();
    });

    it('writes normalized tags to the agent labels', async () => {
      addSubagent('agent-2', { name: 'scout' });
      const svc = service();

      const result = await svc.setAgentTags(CALLER_ID, 'agent-2', [
        ' a ',
        'b',
        '',
        'a',
        ' b ',
      ]);

      expect(result).toEqual({ agentId: 'agent-2', name: 'scout', tags: ['a', 'b'] });
      expect(registerAgent).toHaveBeenCalledWith('agent-2', {
        type: 'sub',
        labels: { parentAgentId: 'main', name: 'scout', tags: 'a,b' },
      });
    });

    it('writes a single tag', async () => {
      addSubagent('agent-2');
      const svc = service();

      const result = await svc.setAgentTags(CALLER_ID, 'agent-2', ['solo']);

      expect(result.tags).toEqual(['solo']);
      expect(registerAgent).toHaveBeenCalledWith('agent-2', {
        type: 'sub',
        labels: { parentAgentId: 'main', tags: 'solo' },
      });
    });

    it('removes the tags key when the new tag list is empty', async () => {
      addSubagent('agent-2', { tags: 'old' });
      const svc = service();

      const result = await svc.setAgentTags(CALLER_ID, 'agent-2', []);

      expect(result.name).toBeUndefined();
      expect(result.tags).toEqual([]);
      expect(registerAgent).toHaveBeenCalledWith('agent-2', {
        type: 'sub',
        labels: { parentAgentId: 'main' },
      });
    });

    it('rejects tagging a non-owned agent without writing', async () => {
      sessionAgents['agent-5'] = { type: 'sub', labels: { parentAgentId: 'agent-9' } };
      const svc = service();

      const error = await failure(svc.setAgentTags(CALLER_ID, 'agent-5', ['a']));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_OWNED);
      expect(registerAgent).not.toHaveBeenCalled();
    });

    it('renames an owned agent and writes the normalized name', async () => {
      addSubagent('agent-2', { tags: 'a,b' });
      const svc = service();

      const result = await svc.renameAgent(CALLER_ID, 'agent-2', ' scout ');

      expect(result).toEqual({ agentId: 'agent-2', name: 'scout', tags: ['a', 'b'] });
      expect(registerAgent).toHaveBeenCalledWith('agent-2', {
        type: 'sub',
        labels: { parentAgentId: 'main', tags: 'a,b', name: 'scout' },
      });
    });

    it('does not write when the agent already has the requested name', async () => {
      addSubagent('agent-2', { name: 'scout' });
      const svc = service();

      const result = await svc.renameAgent(CALLER_ID, 'agent-2', ' scout ');

      expect(result).toEqual({ agentId: 'agent-2', name: 'scout', tags: [] });
      expect(registerAgent).not.toHaveBeenCalled();
    });

    it('rejects a name already held by another subagent without writing', async () => {
      addSubagent('agent-2');
      addSubagent('agent-3', { name: 'scout' });
      const svc = service();

      const error = await failure(svc.renameAgent(CALLER_ID, 'agent-2', 'scout'));

      expect(error.code).toBe(ErrorCodes.AGENT_NAME_TAKEN);
      expect(error.message).toBe('An agent named "scout" already exists (agent-3).');
      expect(registerAgent).not.toHaveBeenCalled();
    });

    it('releases the name reservation after a rename', async () => {
      addSubagent('agent-2');
      addSubagent('agent-3', { name: 'scout' });
      const svc = service();
      await svc.renameAgent(CALLER_ID, 'agent-3', 'scout-2');

      const result = await svc.renameAgent(CALLER_ID, 'agent-2', 'scout');

      expect(result.name).toBe('scout');
    });

    it.each<[string, string, string]>([
      [
        'main',
        ErrorCodes.AGENT_NAME_RESERVED,
        'The name "main" is reserved for the root agent.',
      ],
      [
        'agent-12',
        ErrorCodes.AGENT_NAME_INVALID,
        'Agent names must not look like an agent id ("agent-12").',
      ],
    ])('rejects renaming to the invalid name %j', async (name, code, message) => {
      addSubagent('agent-2');
      const svc = service();

      const error = await failure(svc.renameAgent(CALLER_ID, 'agent-2', name));

      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(registerAgent).not.toHaveBeenCalled();
    });

    it('rejects renaming an unknown target', async () => {
      const svc = service();

      const error = await failure(svc.renameAgent(CALLER_ID, 'agent-404', 'scout'));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_FOUND);
      expect(error.details).toEqual({ agentId: 'agent-404' });
    });

    it('rejects a main-typed agent addressed by its entry id', async () => {
      sessionAgents['agent-root'] = { type: 'main' };
      const svc = service();

      const error = await failure(svc.dismissAgents(CALLER_ID, { ids: ['agent-root'] }));

      expect(error.code).toBe(ErrorCodes.AGENT_NOT_A_SUBAGENT);
      expect(error.message).toBe('Agent "agent-root" is not a subagent.');
      expect(unregisterAgent).not.toHaveBeenCalled();
    });

    it('resolves a duplicated owned name to the first agent id', async () => {
      addSubagent('agent-2', { name: 'scout' });
      addSubagent('agent-3', { name: 'scout' });
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, { names: ['scout'] });

      expect(result.dismissed.map((entry) => entry.agentId)).toEqual(['agent-2']);
      expect(unregisterAgent).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates ids already selected by all', async () => {
      addSubagent('agent-2');
      addSubagent('agent-3');
      const svc = service();

      const result = await svc.dismissAgents(CALLER_ID, { ids: ['agent-3'], all: true });

      expect(result.dismissed.map((entry) => entry.agentId)).toEqual(['agent-3', 'agent-2']);
      expect(unregisterAgent).toHaveBeenCalledTimes(2);
    });
  });

  describe('SessionSubagentService persona', () => {
    function enablePersona(): ISessionSubagentService {
      return service({}, false, true);
    }

    function addPersonaProfile(overrides: {
      readonly name: string;
      readonly extends?: string;
      readonly persona?: string;
      readonly mode?: 'overlay' | 'replace';
      readonly tools?: readonly string[];
      readonly disallowedTools?: readonly string[];
      readonly subagents?: readonly string[];
    }): void {
      profiles.push(normalizeAgentProfile({ systemPrompt: () => 'catalog persona', ...overrides }));
    }

    function addSecurityPersona(): void {
      addPersonaProfile({
        name: 'security-persona',
        extends: 'coder',
        persona: 'You audit code for security issues.',
        mode: 'overlay',
        tools: ['Read', 'Grep'],
        disallowedTools: ['Bash'],
        subagents: ['explore'],
      });
    }

    it('plans a catalog persona with its extends as the default base', async () => {
      addSecurityPersona();
      const svc = enablePersona();

      const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, persona: 'security-persona' });

      expect(plan).toEqual({
        profileName: 'coder',
        model: 'main-model',
        thinking: 'high',
        fork: false,
        persona: {
          name: 'security-persona',
          mode: 'overlay',
          text: 'You audit code for security issues.',
          skills: undefined,
          tools: ['Read', 'Grep'],
          disallowedTools: ['Bash'],
          subagents: ['explore'],
          base: 'coder',
        },
      });
      expect(hostFs.lstat).not.toHaveBeenCalled();
    });

    it('threads the planned persona into the created agent binding', async () => {
      addSecurityPersona();
      const svc = enablePersona();
      const plan = await svc.planSpawn({
        callerAgentId: CALLER_ID,
        persona: 'security-persona',
      });

      await svc.spawn({
        callerAgentId: CALLER_ID,
        plan,
        labels: { parentAgentId: CALLER_ID },
        prompt: 'Audit the diff',
      });

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          binding: { profile: 'coder', model: 'main-model', thinking: 'high', persona: plan.persona },
        }),
      );
    });

    it('accepts an explicit subagent_type equal to the persona extends', async () => {
      addSecurityPersona();
      const svc = enablePersona();

      const plan = await svc.planSpawn({
        callerAgentId: CALLER_ID,
        profileName: 'coder',
        persona: 'security-persona',
      });

      expect(plan.profileName).toBe('coder');
      expect(plan.persona).toMatchObject({ name: 'security-persona', base: 'coder' });
    });

    it('rejects a base mismatch between subagent_type and extends', async () => {
      addSecurityPersona();
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        profileName: 'explore',
        persona: 'security-persona',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('persona.base_mismatch');
      expect(error.details).toEqual({
        reason: 'persona.base_mismatch',
        persona: 'security-persona',
        extends: 'coder',
        requested: 'explore',
      });
    });

    it('rejects a catalog persona without extends', async () => {
      addPersonaProfile({ name: 'unbased-persona', persona: 'You audit code.' });
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'unbased-persona',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('persona.base_required');
    });

    it('rejects a catalog persona without a body', async () => {
      addPersonaProfile({ name: 'empty-persona', extends: 'coder' });
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'empty-persona',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('persona body');
    });

    it('rejects an unknown non-path persona name and lists the catalog', async () => {
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'ghost-persona',
      });

      expect(error.code).toBe(ErrorCodes.PROFILE_UNKNOWN);
      expect(error.message).toBe(
        'Unknown persona: "ghost-persona". Available profiles: coder, explore',
      );
      expect(hostFs.lstat).not.toHaveBeenCalled();
    });

    it('parses a workspace path persona and returns its declared limits', async () => {
      const svc = enablePersona();

      const plan = await svc.planSpawn({
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(plan.profileName).toBe('coder');
      expect(plan.persona).toEqual({
        name: '/repo/personas/security.md',
        mode: 'overlay',
        text: 'You audit code for security issues.',
        skills: undefined,
        tools: ['Read', 'Grep'],
        disallowedTools: ['Bash'],
        subagents: ['explore'],
        base: 'coder',
      });
      expect(workspaceContext.resolve).toHaveBeenCalledWith('personas/security.md');
      expect(workspaceContext.assertAllowed).toHaveBeenCalledWith(
        '/repo/personas/security.md',
        'read',
      );
      expect(hostFs.lstat).toHaveBeenCalledWith('/repo/personas/security.md');
      expect(hostFs.readText).toHaveBeenCalledWith('/repo/personas/security.md');
    });

    it('propagates the workspace guard error for a path outside the roots', async () => {
      workspaceContext.assertAllowed.mockImplementationOnce(() => {
        throw new Error2(
          ErrorCodes.FS_PATH_ESCAPES,
          'Path outside workspace (read): /etc/persona.md',
          { details: { op: 'read', path: '/etc/persona.md' } },
        );
      });
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: '../etc/persona.md',
      });

      expect(error.code).toBe(ErrorCodes.FS_PATH_ESCAPES);
      expect(error.message).toContain('Path outside workspace');
      expect(hostFs.lstat).not.toHaveBeenCalled();
    });

    it('rejects a sensitive persona file', async () => {
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'personas/.env',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('sensitive');
      expect(hostFs.lstat).not.toHaveBeenCalled();
    });

    it.each<[string, HostFileStat]>([
      ['a directory', { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 }],
      ['a symlink', { isFile: true, isDirectory: false, isSymbolicLink: true, size: 10 }],
    ])('rejects %s as a persona file', async (_label, stat) => {
      hostFs.lstat.mockResolvedValueOnce(stat);
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('not a regular file');
      expect(hostFs.readText).not.toHaveBeenCalled();
    });

    it('accepts a persona file exactly at the size limit', async () => {
      hostFs.lstat.mockResolvedValueOnce({
        ...REGULAR_FILE_STAT,
        size: AGENTS_MD_RECOMMENDED_MAX_BYTES,
      });
      const svc = enablePersona();

      const plan = await svc.planSpawn({
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(plan.persona).toMatchObject({ base: 'coder' });
    });

    it('rejects an oversized persona file', async () => {
      hostFs.lstat.mockResolvedValueOnce({
        ...REGULAR_FILE_STAT,
        size: AGENTS_MD_RECOMMENDED_MAX_BYTES + 1,
      });
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain(String(AGENTS_MD_RECOMMENDED_MAX_BYTES));
      expect(hostFs.readText).not.toHaveBeenCalled();
    });

    it('wraps a persona file read failure with the path', async () => {
      hostFs.readText.mockRejectedValueOnce(new Error('disk gone'));
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('/repo/personas/security.md');
      expect(error.message).toContain('disk gone');
    });

    it('wraps a persona file parse failure', async () => {
      hostFs.readText.mockResolvedValueOnce(
        '---\nname: security-review\ndescription: Security\n---\nBody',
      );
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'personas/security.md',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toContain('persona.base_required');
    });

    it('rejects a persona combined with fork', async () => {
      const svc = enablePersona();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        fork: true,
        persona: 'security-persona',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toBe(PERSONA_WITH_FORK_UNAVAILABLE);
    });

    it('rejects a persona while the agent_persona flag is off', async () => {
      addSecurityPersona();
      const svc = service();

      const error = await planSpawnError(svc, {
        callerAgentId: CALLER_ID,
        persona: 'security-persona',
      });

      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
      expect(error.message).toBe(PERSONA_EXPERIMENTAL_UNAVAILABLE);
    });

    it('keeps the plan shape unchanged when no persona is requested', async () => {
      const svc = enablePersona();

      const plan = await svc.planSpawn({ callerAgentId: CALLER_ID, profileName: 'coder' });

      expect(plan).toEqual({
        profileName: 'coder',
        model: 'main-model',
        thinking: 'high',
        fork: false,
      });
    });
  });
});
