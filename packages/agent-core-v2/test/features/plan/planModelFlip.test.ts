import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentProfileService,
  type ProfileData,
  type ProfileSetModelResult,
} from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventBus } from '#/app/event/eventBus';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentPlanService } from '#/features/plan/plan';
import { AgentPlanService } from '#/features/plan/planService';

import { stubLog } from '../../_base/log/stubs';
import { StubConfigService } from '../../kosong/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import { stubToolExecutorEvents } from '../../agent/toolExecutor/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
import { stubModelCatalog, type StubModelSpec } from '../model/stubs';

const SESSION_DIR = '/session';

const SPECS: readonly StubModelSpec[] = [
  { id: 'p1/current', provider: 'p1', model: 'current', maxContextSize: 200_000 },
  { id: 'p1/planning', provider: 'p1', model: 'planning', maxContextSize: 200_000 },
  { id: 'p1/default', provider: 'p1', model: 'default', maxContextSize: 200_000 },
  { id: 'p1/small', provider: 'p1', model: 'small', maxContextSize: 64_000 },
  { id: 'p1/big', provider: 'p1', model: 'big', maxContextSize: 300_000 },
];

interface PlanFlipFakes {
  readonly profile: ReturnType<typeof createStubProfile>;
  readonly config: StubConfigService;
}

function createStubProfile(initialModel: string): {
  readonly getModel: () => string;
  readonly setModel: Mock<(next: string) => Promise<ProfileSetModelResult>>;
  readonly data: () => ProfileData;
} {
  let model = initialModel;
  const setModel = vi.fn(
    async (next: string): Promise<ProfileSetModelResult> => {
      model = next;
      return { model: next };
    },
  );
  return {
    getModel: () => model,
    setModel,
    data: (): ProfileData => ({
      modelAlias: model,
      modelCapabilities: UNKNOWN_CAPABILITY,
      thinkingLevel: 'off',
      systemPrompt: '',
    }),
  };
}

describe('AgentPlanService plan/default model flip', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let profile: ReturnType<typeof createStubProfile>;
  let config: StubConfigService;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => disposables.dispose());

  function setup(options: {
    readonly config?: Record<string, unknown>;
    readonly currentModel?: string;
  }): PlanFlipFakes {
    config = new StubConfigService(options.config);
    profile = createStubProfile(options.currentModel ?? '');
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg);
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(IConfigService, config);
        reg.defineInstance(IModelCatalog, stubModelCatalog(SPECS));
        reg.definePartialInstance(IAgentProfileService, profile);
        reg.definePartialInstance(ISessionContext, {
          sessionId: 'session-1',
          sessionDir: SESSION_DIR,
        });
        reg.definePartialInstance(IAgentContextMemoryService, {});
        reg.definePartialInstance(IAgentContextInjectorService, {
          register: () => ({ dispose: () => {} }),
        });
        reg.definePartialInstance(IAgentTelemetryContextService, { set: () => {} });
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            mkdir: vi.fn().mockResolvedValue(undefined),
            readText: vi.fn().mockResolvedValue(''),
            writeText: vi.fn().mockResolvedValue(undefined),
          }),
        );
        reg.definePartialInstance(IBlobStore, {});
        reg.defineInstance(IAgentToolExecutorService, stubToolExecutorEvents().executor);
        reg.definePartialInstance(IAgentToolApprovalService, {
          formatDenyMessage: (message: string) => message,
        });
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => 'auto'));
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentPlanService, AgentPlanService);
      },
    });
    return { profile, config };
  }

  function plan(): IAgentPlanService {
    return ix.get(IAgentPlanService);
  }

  it('switches to the planning model on enter when configured', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/planning' },
      currentModel: 'p1/current',
    });

    await plan().enter('flip-plan');

    expect(profile.setModel).toHaveBeenCalledWith('p1/planning');
  });

  it('leaves the model unchanged on enter when planningModel is unset', async () => {
    setup({ config: { defaultModel: 'p1/default' }, currentModel: 'p1/current' });

    await plan().enter('flip-plan');

    expect(profile.setModel).not.toHaveBeenCalled();
  });

  it('keeps the current model when the planning model has a smaller context window', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/small' },
      currentModel: 'p1/big',
    });

    await plan().enter('flip-plan');

    expect(profile.setModel).not.toHaveBeenCalled();
    expect(profile.getModel()).toBe('p1/big');
  });

  it('warns and leaves the model unchanged on enter when no model is bound', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/planning' },
      currentModel: '',
    });

    await plan().enter('flip-plan');

    expect(profile.setModel).not.toHaveBeenCalled();
    expect(profile.getModel()).toBe('');
  });

  it('warns and leaves the model unchanged when switching to the planning model throws', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/does-not-exist' },
      currentModel: 'p1/current',
    });

    await plan().enter('flip-plan');

    expect(profile.setModel).not.toHaveBeenCalled();
    expect(profile.getModel()).toBe('p1/current');
  });

  it('restores the default model on exit after switching to planning', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/planning' },
      currentModel: 'p1/current',
    });
    await plan().enter('flip-plan');

    await plan().exit();

    expect(profile.setModel).toHaveBeenLastCalledWith('p1/default');
    expect(profile.getModel()).toBe('p1/default');
  });

  it('restores the model observed at enter when defaultModel is unset', async () => {
    setup({ config: { planningModel: 'p1/planning' }, currentModel: 'p1/current' });
    await plan().enter('flip-plan');

    await plan().exit();

    expect(profile.setModel).toHaveBeenLastCalledWith('p1/current');
    expect(profile.getModel()).toBe('p1/current');
  });

  it('restores the default model on cancel', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/planning' },
      currentModel: 'p1/current',
    });
    await plan().enter('flip-plan');

    await plan().cancel();

    expect(profile.setModel).toHaveBeenLastCalledWith('p1/default');
    expect(profile.getModel()).toBe('p1/default');
  });

  it('keeps the current model when the default restore target has a smaller context window', async () => {
    setup({
      config: { defaultModel: 'p1/default', planningModel: 'p1/big' },
      currentModel: 'p1/current',
    });
    await plan().enter('flip-plan');

    await plan().exit();

    // enter flipped to the 300k planning model; the 200k default cannot be
    // restored without truncating the conversation, so the model is left as-is.
    expect(profile.setModel).toHaveBeenCalledTimes(1);
    expect(profile.getModel()).toBe('p1/big');
  });

  it('logs a warning and keeps the model when restoring throws', async () => {
    setup({
      config: { defaultModel: 'p1/does-not-exist', planningModel: 'p1/planning' },
      currentModel: 'p1/current',
    });
    await plan().enter('flip-plan');

    await plan().exit();

    expect(profile.getModel()).toBe('p1/planning');
  });

  it('does not touch the model on exit when no restore target is configured', async () => {
    setup({ config: {}, currentModel: 'p1/current' });
    await plan().enter('flip-plan');

    await plan().exit();

    expect(profile.setModel).not.toHaveBeenCalled();
    expect(profile.getModel()).toBe('p1/current');
  });
});
