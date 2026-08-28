import { describe, expect, it, vi } from 'vitest';

import { type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { IAgentPromptService, type PromptHandle } from '#/agent/prompt/prompt';
import { Error2, ErrorCodes } from '#/errors';
import { APIProviderRateLimitError } from '#/kosong/contract/errors';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';

const signal = new AbortController().signal;

function failedTurnHandle(error: unknown): IAgentScopeHandle {
  const result: TurnResult = { type: 'failed', steps: 1, error };
  const turn: Turn = {
    id: 1,
    signal,
    ready: Promise.resolve(),
    result: Promise.resolve(result),
    cancel: () => true,
  };
  const prompt = {
    _serviceBrand: undefined,
    enqueue: vi.fn(async () => ({ launched: Promise.resolve(turn) }) as unknown as PromptHandle),
  } as unknown as IAgentPromptService;
  const loop = {
    _serviceBrand: undefined,
    cancel: vi.fn(() => true),
  } as unknown as IAgentLoopService;
  return {
    id: 'agent-child',
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IAgentPromptService) return prompt;
        if (serviceId === IAgentLoopService) return loop;
        throw new Error('unexpected service resolution');
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

async function runFailure(error: unknown): Promise<unknown> {
  const run = await runAgentTurn(
    failedTurnHandle(error),
    { kind: 'prompt', prompt: 'Investigate' },
    { signal },
  );
  return run.completion.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('runAgentTurn failed-turn classification', () => {
  it('passes a usage-limit-coded failure through without rate-limit reclassification', async () => {
    const failure = new Error2(
      ErrorCodes.PROVIDER_USAGE_LIMIT,
      'Too many requests: reached your usage limit for this billing cycle',
    );

    const caught = await runFailure(failure);

    expect(caught).toBe(failure);
    expect(caught).not.toBeInstanceOf(APIProviderRateLimitError);
    expect((caught as Error2).code).toBe(ErrorCodes.PROVIDER_USAGE_LIMIT);
  });

  it('re-mints a rate-limit-coded failure the wording fallback cannot recognize', async () => {
    const failure = new Error2(ErrorCodes.PROVIDER_RATE_LIMIT, 'slow down', {
      details: { requestId: 'req-429' },
    });

    const caught = await runFailure(failure);

    expect(caught).toBeInstanceOf(APIProviderRateLimitError);
    expect(caught).not.toBe(failure);
    expect((caught as APIProviderRateLimitError).requestId).toBe('req-429');
  });
});
