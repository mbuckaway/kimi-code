import { randomBytes } from 'node:crypto';

import { toDisposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { CROSS_SESSION_MESSAGING_FLAG_ID } from '../flag';
import {
  createCrossSessionRegistry,
  resolveCrossSessionRegistryDir,
  type CrossSessionRegistryHandle,
  type ICrossSessionRegistry,
} from './crossSessionRegistry';
import {
  resolveCrossSessionInboxSocketPath,
  startCrossSessionInbox,
  type CrossSessionAckFrame,
  type CrossSessionInboundFrame,
  type CrossSessionInboxServer,
} from './crossSessionTransport';
import { ICrossSessionMessagingService } from './crossSessionMessaging';

export interface ICrossSessionInboxHost {
  readonly _serviceBrand: undefined;
  readonly enabled: boolean;
  bindSession(sessionId: string, handle: ISessionScopeHandle): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  boundSessions(): readonly string[];
}

export const ICrossSessionInboxHost: ServiceIdentifier<ICrossSessionInboxHost> =
  createDecorator<ICrossSessionInboxHost>('crossSessionInboxHost');

interface BoundSession {
  readonly registration: CrossSessionRegistryHandle;
}

interface SharedInbox {
  readonly server: CrossSessionInboxServer;
  readonly socketPath: string;
  readonly token: string;
}

const BIND_RETRY_DELAY_MS = 100;

export class CrossSessionInboxHost extends Service implements ICrossSessionInboxHost {
  declare readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  private readonly registry: ICrossSessionRegistry | undefined;
  private readonly bound = new Map<string, BoundSession>();
  private readonly routable = new Set<string>();
  private readonly pendingBinds = new Map<string, Promise<void>>();
  private readonly pendingReleases = new Map<string, Promise<void>>();
  private readonly bindGenerations = new Map<string, number>();
  private serverGate: Promise<void> = Promise.resolve();
  private shared: SharedInbox | undefined;
  private socketSuffix: string | undefined;

  constructor(
    @ISessionManager private readonly sessions: ISessionManager,
    @IBootstrapService bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ICrossSessionMessagingService private readonly messaging: ICrossSessionMessagingService,
  ) {
    super();
    this.enabled = this.flags.enabled(CROSS_SESSION_MESSAGING_FLAG_ID);
    if (!this.enabled) return;

    this.registry = createCrossSessionRegistry({
      registryDir: resolveCrossSessionRegistryDir(bootstrap.homeDir),
    });

    const onDidCreate = this.sessions.onDidCreateSession;
    if (onDidCreate !== undefined) {
      this._register(
        onDidCreate((event) => {
          void this.bindSession(event.sessionId, event.handle).catch(onUnexpectedError);
        }),
      );
    }
    const onWillClose = this.sessions.onWillCloseSession;
    if (onWillClose !== undefined) {
      this._register(
        onWillClose((event) => {
          event.waitUntil(this.releaseSession(event.sessionId));
        }),
      );
    }
    const onDidClose = this.sessions.onDidCloseSession;
    if (onDidClose !== undefined) {
      this._register(
        onDidClose((event) => {
          void this.releaseSession(event.sessionId).catch(onUnexpectedError);
        }),
      );
    }
    const onDidArchive = this.sessions.onDidArchiveSession;
    if (onDidArchive !== undefined) {
      this._register(
        onDidArchive((event) => {
          void this.releaseSession(event.sessionId).catch(onUnexpectedError);
        }),
      );
    }

    for (const handle of this.sessions.list()) {
      void this.bindSession(handle.id, handle).catch(onUnexpectedError);
    }

    this._register(
      toDisposable(() => {
        const pending = new Set<string>([...this.bound.keys(), ...this.pendingBinds.keys()]);
        if (pending.size === 0) {
          void this.closeSharedIfIdle().catch(onUnexpectedError);
          return;
        }
        for (const sessionId of pending) {
          void this.releaseSession(sessionId).catch(onUnexpectedError);
        }
      }),
    );
  }

  boundSessions(): readonly string[] {
    return [...this.bound.keys()];
  }

  async bindSession(sessionId: string, handle: ISessionScopeHandle): Promise<void> {
    if (!this.enabled) return;
    const pendingRelease = this.pendingReleases.get(sessionId);
    if (pendingRelease !== undefined) {
      try {
        await pendingRelease;
      } catch {}
    }
    if (this.bound.has(sessionId)) return;
    const pending = this.pendingBinds.get(sessionId);
    if (pending !== undefined) return pending;
    const generation = this.bumpBindGeneration(sessionId);
    const work = this.openSessionWithRetry(sessionId, handle, generation);
    this.pendingBinds.set(sessionId, work);
    let failed = false;
    try {
      await work;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.pendingBinds.delete(sessionId);
      if (
        failed &&
        !this.pendingBinds.has(sessionId) &&
        !this.pendingReleases.has(sessionId)
      ) {
        this.bindGenerations.delete(sessionId);
      }
      if (!this.bound.has(sessionId)) {
        void this.closeSharedIfIdle().catch(onUnexpectedError);
      }
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const pendingRelease = this.pendingReleases.get(sessionId);
    if (pendingRelease !== undefined) return pendingRelease;
    const work = (async (): Promise<void> => {
      this.bumpBindGeneration(sessionId);
      const pendingBind = this.pendingBinds.get(sessionId);
      if (pendingBind !== undefined) {
        try {
          await pendingBind;
        } catch {}
      }
      const entry = this.bound.get(sessionId);
      if (entry === undefined) {
        await this.closeSharedIfIdle().catch(onUnexpectedError);
        return;
      }
      await entry.registration.release().catch((error: unknown) => {
        this.reportReleaseFailure(sessionId, error);
      });
      if (this.bound.get(sessionId) === entry) this.bound.delete(sessionId);
      this.routable.delete(sessionId);
      await this.closeSharedIfIdle().catch(onUnexpectedError);
    })();
    this.pendingReleases.set(sessionId, work);
    try {
      await work;
    } finally {
      this.pendingReleases.delete(sessionId);
    }
    if (!this.pendingBinds.has(sessionId) && !this.pendingReleases.has(sessionId)) {
      this.bindGenerations.delete(sessionId);
    }
  }

  private bumpBindGeneration(sessionId: string): number {
    const generation = (this.bindGenerations.get(sessionId) ?? 0) + 1;
    this.bindGenerations.set(sessionId, generation);
    return generation;
  }

  private async openSessionWithRetry(
    sessionId: string,
    handle: ISessionScopeHandle,
    generation: number,
  ): Promise<void> {
    try {
      await this.openSession(sessionId, handle, generation);
      return;
    } catch {
      if (this.bindGenerations.get(sessionId) !== generation) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BIND_RETRY_DELAY_MS);
        timer.unref?.();
      });
      if (this.bindGenerations.get(sessionId) !== generation) return;
      await this.openSession(sessionId, handle, generation);
    }
  }

  private async openSession(
    sessionId: string,
    handle: ISessionScopeHandle,
    generation: number,
  ): Promise<void> {
    const registry = this.requireRegistry();
    const title = await this.readTitle(handle);
    const shared = await this.ensureSharedInbox();
    if (this.bindGenerations.get(sessionId) !== generation) return;
    this.routable.add(sessionId);
    let registration: CrossSessionRegistryHandle;
    try {
      registration = await registry.register({
        sessionId,
        socketPath: shared.socketPath,
        token: shared.token,
        ...(title !== undefined ? { title } : {}),
      });
    } catch (error) {
      this.routable.delete(sessionId);
      throw error;
    }
    if (this.bindGenerations.get(sessionId) !== generation) {
      this.routable.delete(sessionId);
      await registration.release().catch((error: unknown) => {
        this.reportReleaseFailure(sessionId, error);
      });
      return;
    }
    this.bound.set(sessionId, { registration });
  }

  private ensureSharedInbox(): Promise<SharedInbox> {
    return this.withServerGate(async () => {
      if (this.shared !== undefined) return this.shared;
      const token = randomBytes(32).toString('hex');
      const socketPath = this.sharedSocketPath();
      const server = await startCrossSessionInbox({
        socketPath,
        token,
        handle: (sessionId, frame) => this.routeFrame(sessionId, frame),
      });
      const shared: SharedInbox = { server, socketPath, token };
      this.shared = shared;
      return shared;
    });
  }

  private reportReleaseFailure(sessionId: string, error: unknown): void {
    onUnexpectedError(
      new Error(`cross-session registry release failed for session ${sessionId}`, {
        cause: error,
      }),
    );
  }

  private async routeFrame(
    sessionId: string,
    frame: CrossSessionInboundFrame,
  ): Promise<CrossSessionAckFrame> {
    if (!this.routable.has(sessionId)) {
      return {
        type: 'ack',
        messageId: frame.messageId,
        kind: 'error',
        truncated: false,
        error: 'unknown session',
      };
    }
    return this.messaging.receive(sessionId, frame);
  }

  private async closeSharedIfIdle(): Promise<void> {
    if (this.bound.size > 0 || this.pendingBinds.size > 0) return;
    await this.withServerGate(async () => {
      if (this.bound.size > 0 || this.pendingBinds.size > 0) return;
      const shared = this.shared;
      if (shared === undefined) return;
      this.shared = undefined;
      this.socketSuffix = undefined;
      await shared.server.close();
    });
  }

  private withServerGate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serverGate.then(work, work);
    this.serverGate = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private sharedSocketPath(): string {
    this.socketSuffix ??= randomBytes(4).toString('hex');
    return resolveCrossSessionInboxSocketPath({ suffix: this.socketSuffix });
  }

  private requireRegistry(): ICrossSessionRegistry {
    if (this.registry === undefined) {
      throw new Error('cross-session inbox host is disabled');
    }
    return this.registry;
  }

  private async readTitle(handle: ISessionScopeHandle): Promise<string | undefined> {
    try {
      return (await handle.accessor.get(ISessionMetadata).read()).title;
    } catch {
      return undefined;
    }
  }
}
