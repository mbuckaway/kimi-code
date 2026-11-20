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
  resolveCrossSessionSocketPath,
  startCrossSessionInbox,
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
  readonly server: CrossSessionInboxServer;
  readonly registration: CrossSessionRegistryHandle;
}

export class CrossSessionInboxHost extends Service implements ICrossSessionInboxHost {
  declare readonly _serviceBrand: undefined;

  readonly enabled: boolean;

  private readonly registry: ICrossSessionRegistry | undefined;
  private readonly bound = new Map<string, BoundSession>();
  private readonly pendingBinds = new Map<string, Promise<void>>();
  private readonly pendingReleases = new Map<string, Promise<void>>();

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
          event.waitUntil(this.bindSession(event.sessionId, event.handle));
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
        const pending = new Set<string>([
          ...this.bound.keys(),
          ...this.pendingBinds.keys(),
        ]);
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
    if (this.bound.has(sessionId)) return;
    const pending = this.pendingBinds.get(sessionId);
    if (pending !== undefined) return pending;
    const work = this.openSession(sessionId, handle);
    this.pendingBinds.set(sessionId, work);
    try {
      await work;
    } finally {
      this.pendingBinds.delete(sessionId);
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    const pendingRelease = this.pendingReleases.get(sessionId);
    if (pendingRelease !== undefined) return pendingRelease;
    const work = (async (): Promise<void> => {
      const pendingBind = this.pendingBinds.get(sessionId);
      if (pendingBind !== undefined) {
        try {
          await pendingBind;
        } catch {}
      }
      const entry = this.bound.get(sessionId);
      if (entry === undefined) return;
      this.bound.delete(sessionId);
      await Promise.allSettled([entry.server.close(), entry.registration.release()]);
    })();
    this.pendingReleases.set(sessionId, work);
    try {
      await work;
    } finally {
      this.pendingReleases.delete(sessionId);
    }
  }

  private async openSession(
    sessionId: string,
    handle: ISessionScopeHandle,
  ): Promise<void> {
    const registry = this.requireRegistry();
    const token = randomBytes(32).toString('hex');
    const socketPath = resolveCrossSessionSocketPath(sessionId);
    const title = await this.readTitle(handle);
    const server = await startCrossSessionInbox({
      sessionId,
      socketPath,
      token,
      handle: (frame) => this.messaging.receive(sessionId, frame),
    });
    let registration: CrossSessionRegistryHandle;
    try {
      registration = await registry.register({
        sessionId,
        socketPath,
        token,
        ...(title !== undefined ? { title } : {}),
      });
    } catch (error) {
      await server.close().catch(() => {});
      throw error;
    }
    this.bound.set(sessionId, { server, registration });
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
