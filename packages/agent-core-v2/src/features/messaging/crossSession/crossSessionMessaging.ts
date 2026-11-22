import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import {
  type AgentInboxDelivery,
  type CrossSessionReceiveResult,
  type CrossSessionRefusalReason,
  ISessionMessagingService,
} from '#/features/messaging/messaging';

import { CROSS_SESSION_MESSAGING_FLAG_ID } from '../flag';
import {
  createCrossSessionRegistry,
  resolveCrossSessionRegistryDir,
  type CrossSessionRegistration,
  type ICrossSessionRegistry,
} from './crossSessionRegistry';
import {
  ackFromReceiveResult,
  sendCrossSessionFrame,
  type CrossSessionAckFrame,
  type CrossSessionInboundFrame,
} from './crossSessionTransport';

export type CrossSessionSessionStatus = 'running' | 'idle' | 'live' | 'offline';

export interface CrossSessionSessionEntry {
  readonly sessionId: string;
  readonly title?: string;
  readonly status: CrossSessionSessionStatus;
}

export interface CrossSessionSendInput {
  readonly messageId: string;
  readonly message: string;
  readonly fromSessionTitle?: string;
  readonly inReplyTo?: string;
  readonly signal?: AbortSignal;
}

export type CrossSessionSendResult =
  | {
      readonly kind: 'delivered';
      readonly delivery: AgentInboxDelivery;
      readonly truncated: boolean;
    }
  | { readonly kind: 'held'; readonly truncated: boolean }
  | {
      readonly kind: 'refused';
      readonly reason: CrossSessionRefusalReason;
      readonly truncated: boolean;
    }
  | { readonly kind: 'offline' }
  | { readonly kind: 'error'; readonly error: string };

export interface ICrossSessionMessagingService {
  readonly _serviceBrand: undefined;

  listSessions(callerSessionId: string): Promise<readonly CrossSessionSessionEntry[]>;

  send(
    fromSessionId: string,
    toSessionId: string,
    input: CrossSessionSendInput,
  ): Promise<CrossSessionSendResult>;

  receive(sessionId: string, frame: CrossSessionInboundFrame): Promise<CrossSessionAckFrame>;
}

export const ICrossSessionMessagingService: ServiceIdentifier<ICrossSessionMessagingService> =
  createDecorator<ICrossSessionMessagingService>('crossSessionMessagingService');

const BIND_WINDOW_TOTAL_MS = 500;
const BIND_WINDOW_STEP_MS = 50;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindWindowDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason ?? new Error('cross-session send aborted'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('cross-session send aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sendResultFromAck(ack: CrossSessionAckFrame): CrossSessionSendResult {
  switch (ack.kind) {
    case 'delivered':
      return {
        kind: 'delivered',
        delivery: ack.delivery ?? 'newTurn',
        truncated: ack.truncated,
      };
    case 'held':
      return { kind: 'held', truncated: ack.truncated };
    case 'refused':
      return {
        kind: 'refused',
        reason: ack.reason ?? 'policy',
        truncated: ack.truncated,
      };
    case 'error':
      return { kind: 'error', error: ack.error ?? 'cross-session delivery failed' };
  }
}

export class CrossSessionMessagingService
  extends Service
  implements ICrossSessionMessagingService
{
  declare readonly _serviceBrand: undefined;

  private readonly registry: ICrossSessionRegistry;

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @IFlagService private readonly flags: IFlagService,
    @IBootstrapService bootstrap: IBootstrapService,
  ) {
    super();
    this.registry = createCrossSessionRegistry({
      registryDir: resolveCrossSessionRegistryDir(bootstrap.homeDir),
    });
  }

  async listSessions(callerSessionId: string): Promise<readonly CrossSessionSessionEntry[]> {
    if (!this.flags.enabled(CROSS_SESSION_MESSAGING_FLAG_ID)) return [];

    const rows = new Map<string, CrossSessionSessionEntry>();
    for (const handle of this.sessions.list()) {
      if (handle.id === callerSessionId || rows.has(handle.id)) continue;
      const [title, status] = await Promise.all([
        this.titleOf(handle),
        Promise.resolve(this.inProcessStatusOf(handle)),
      ]);
      rows.set(handle.id, {
        sessionId: handle.id,
        status,
        ...(title !== undefined ? { title } : {}),
      });
    }

    for (const entry of await this.registry.listLive()) {
      if (entry.sessionId === callerSessionId || rows.has(entry.sessionId)) continue;
      rows.set(entry.sessionId, {
        sessionId: entry.sessionId,
        status: this.registry.statusOf(entry),
        ...(entry.title !== undefined ? { title: entry.title } : {}),
      });
    }

    return [...rows.values()];
  }

  async send(
    fromSessionId: string,
    toSessionId: string,
    input: CrossSessionSendInput,
  ): Promise<CrossSessionSendResult> {
    input.signal?.throwIfAborted();
    if (!this.flags.enabled(CROSS_SESSION_MESSAGING_FLAG_ID)) {
      return { kind: 'refused', reason: 'policy', truncated: false };
    }
    if (fromSessionId === toSessionId) {
      return { kind: 'refused', reason: 'self', truncated: false };
    }

    const deadline = Date.now() + BIND_WINDOW_TOTAL_MS;
    for (;;) {
      input.signal?.throwIfAborted();
      const inProcess = await this.deliverInProcess(fromSessionId, toSessionId, input);
      if (inProcess !== undefined) return inProcess;

      const registration = await this.registry.get(toSessionId);
      if (registration !== undefined) {
        return this.deliverOverSocket(registration, toSessionId, fromSessionId, input);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: 'offline' };
      await bindWindowDelay(Math.min(BIND_WINDOW_STEP_MS, remaining), input.signal);
    }
  }

  async receive(
    sessionId: string,
    frame: CrossSessionInboundFrame,
  ): Promise<CrossSessionAckFrame> {
    const target = this.sessions.get(sessionId);
    if (target === undefined) {
      return {
        type: 'ack',
        messageId: frame.messageId,
        kind: 'error',
        truncated: false,
        error: 'session not live',
      };
    }
    try {
      const result = await target.accessor.get(ISessionMessagingService).receiveCrossSession({
        fromSessionId: frame.from.sessionId,
        fromSessionTitle: frame.from.title,
        messageId: frame.messageId,
        message: frame.message,
        inReplyTo: frame.inReplyTo,
      });
      return ackFromReceiveResult(frame.messageId, result);
    } catch (error) {
      return {
        type: 'ack',
        messageId: frame.messageId,
        kind: 'error',
        truncated: false,
        error: errorMessage(error),
      };
    }
  }

  private async deliverInProcess(
    fromSessionId: string,
    toSessionId: string,
    input: CrossSessionSendInput,
  ): Promise<CrossSessionSendResult | undefined> {
    const target = this.sessions.get(toSessionId);
    if (target === undefined) return undefined;
    try {
      const result: CrossSessionReceiveResult = await target.accessor
        .get(ISessionMessagingService)
        .receiveCrossSession({
          fromSessionId,
          fromSessionTitle: input.fromSessionTitle,
          messageId: input.messageId,
          message: input.message,
          inReplyTo: input.inReplyTo,
          signal: input.signal,
        });
      return result;
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      return { kind: 'error', error: errorMessage(error) };
    }
  }

  private async deliverOverSocket(
    registration: CrossSessionRegistration,
    toSessionId: string,
    fromSessionId: string,
    input: CrossSessionSendInput,
  ): Promise<CrossSessionSendResult> {
    try {
      const ack = await sendCrossSessionFrame(
        registration.socketPath,
        registration.token,
        {
          sessionId: toSessionId,
          messageId: input.messageId,
          from: {
            sessionId: fromSessionId,
            ...(input.fromSessionTitle !== undefined
              ? { title: input.fromSessionTitle }
              : {}),
          },
          message: input.message,
          ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
        },
        { signal: input.signal },
      );
      return sendResultFromAck(ack);
    } catch (error) {
      if (input.signal?.aborted === true) throw error;
      return { kind: 'error', error: errorMessage(error) };
    }
  }

  private inProcessStatusOf(handle: ISessionScopeHandle): 'running' | 'idle' {
    try {
      const agent = handle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (agent === undefined) return 'idle';
      return agent.accessor.get(IAgentLoopService).status().state === 'running'
        ? 'running'
        : 'idle';
    } catch {
      return 'idle';
    }
  }

  private async titleOf(handle: ISessionScopeHandle): Promise<string | undefined> {
    try {
      return (await handle.accessor.get(ISessionMetadata).read()).title;
    } catch {
      return undefined;
    }
  }
}
