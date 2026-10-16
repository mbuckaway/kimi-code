import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigChanged,
  IConfigService,
  IEventService,
  type ConfigChangeSource,
  type ConfigDiagnostic,
  type ConfigSectionChangedEvent,
  type Event2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { configResponseSchema, type ConfigResponse } from '../src/protocol/rest-config';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { startConfigChangedPublisher } from '../src/services/config/configChangedPublisher';
import { type ConfigReloadResult, reloadConfig } from '../src/services/config/configReload';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch, bearerToken } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getConfig(): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  it('GET echoes default_permission_mode and derives yolo = false', async () => {
    await boot('default_permission_mode = "auto"\n');
    const cfg = await getConfig();
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);
  });

  it('POST { yolo: true } sets default_permission_mode = yolo and echoes yolo = true', async () => {
    await boot();
    const cfg = await patchConfig({ yolo: true });
    expect(cfg.default_permission_mode).toBe('yolo');
    expect(cfg.yolo).toBe(true);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('yolo');
    expect(after.yolo).toBe(true);
  });

  it('POST { default_permission_mode: auto } writes the canonical field and derives yolo = false', async () => {
    await boot();
    const cfg = await patchConfig({ default_permission_mode: 'auto' });
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('auto');
    expect(after.yolo).toBe(false);
  });

  it('POST { planning_model } persists and GET echoes it', async () => {
    await boot();
    const cfg = await patchConfig({ planning_model: 'kimi/k3' });
    expect(cfg.planning_model).toBe('kimi/k3');

    const after = await getConfig();
    expect(after.planning_model).toBe('kimi/k3');
  });

  it('POST { secondary_model } persists the subagent model pool and GET echoes it', async () => {
    await boot();
    const cfg = await patchConfig({
      secondary_model: {
        default_model: 'provider/fast',
        models: { 'provider/fast': 'fast and cheap' },
      },
    });
    expect(cfg.secondary_model).toMatchObject({ defaultModel: 'provider/fast' });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast',
      models: { 'provider/fast': 'fast and cheap' },
    });
  });

  it('POST { secondary_model } preserves pool alias keys containing underscores', async () => {
    await boot();
    await patchConfig({
      secondary_model: { default_model: 'provider/fast_model', models: { 'provider/fast_model': '' } },
    });

    const after = await getConfig();
    expect(after.secondary_model).toMatchObject({
      defaultModel: 'provider/fast_model',
      models: { 'provider/fast_model': '' },
    });
    expect(
      Object.keys((after.secondary_model as { models: Record<string, string> }).models),
    ).not.toContain('provider/fastModel');
  });

  it('POST { providers } converts fields of a provider id colliding with a map-valued key', async () => {
    await boot();
    await patchConfig({
      providers: {
        models: { type: 'openai', base_url: 'https://example.test', api_key: 'sk-test' },
      },
    });

    const after = await getConfig();
    expect(after.providers['models']).toMatchObject({
      type: 'openai',
      base_url: 'https://example.test',
      has_api_key: true,
    });
  });

  it('session create with a broken subagent model pool fails with VALIDATION_FAILED', async () => {
    await boot(
      '[experimental]\n"secondary-model" = true\n\n[secondary_model.models]\n"provider/fast" = "fast and cheap"\n',
    );
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(body.msg).toContain('[secondary_model].default_model is required');
  });

  it('session create with a broken subagent model pool succeeds while the experiment is off', async () => {
    await boot('[secondary_model.models]\n"provider/fast" = "fast and cheap"\n');
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
  });
});

describe('server-v2 config changed WS notifications', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-ws-'));
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  interface ConfigChangedFrame {
    type: 'event.config.changed';
    payload: {
      changedFields: string[];
      config: Record<string, unknown>;
    };
  }

  async function openWs(): Promise<ConfigChangedFrame[]> {
    const live = server as RunningServer;
    const ws = new WebSocket(`ws://127.0.0.1:${live.port}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(live)}`,
    ]);
    sockets.push(ws);
    const frames: ConfigChangedFrame[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse((data as Buffer).toString()) as { type?: string };
      if (frame.type === 'event.config.changed') frames.push(frame as ConfigChangedFrame);
    });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'client_hello', payload: { client_id: 'config-ws-test' } }));
    return frames;
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<void> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
  }

  it('publishes a trailing event with camelCase changedFields and the full snapshot after POST /config', async () => {
    await boot('default_permission_mode = "auto"\n');
    const frames = await openWs();

    await patchConfig({ yolo: true });

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toEqual(['defaultPermissionMode']);
    expect(last.payload.config['default_permission_mode']).toBe('yolo');
    expect(last.payload.config['yolo']).toBe(true);
    expect(last.payload.config).toHaveProperty('providers');
  });

  it('publishes camelCase changedFields on the engine write path used by OAuth refreshes', async () => {
    await boot();
    const frames = await openWs();

    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.replace('defaultModel', 'k2');

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toEqual(['defaultModel']);
    expect(last.payload.config['default_model']).toBe('k2');
  });

  it('publishes an event when config.toml is edited outside the process and reloaded', async () => {
    await boot('default_permission_mode = "auto"\n');
    const frames = await openWs();

    await writeFile(
      join(home as string, 'config.toml'),
      'default_permission_mode = "yolo"\n',
      'utf-8',
    );
    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.reload();

    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });
    const last = frames.at(-1) as ConfigChangedFrame;
    expect(last.payload.changedFields).toContain('defaultPermissionMode');
    expect(last.payload.config['default_permission_mode']).toBe('yolo');
  });

  it('closes the config publisher before the app, so a pending change is never delivered during shutdown', async () => {
    await boot();
    const published: string[] = [];
    const events = (server as RunningServer).core.accessor.get(IEventService);
    const subscription = events.subscribe((event) => {
      if (event.type === 'event.config.changed') published.push(event.type);
    });

    const config = (server as RunningServer).core.accessor.get(IConfigService);
    await config.ready;
    await config.replace('defaultModel', 'k2');
    for (const ws of sockets.splice(0)) ws.close();
    const live = server as RunningServer;
    server = undefined;
    await live.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published).toHaveLength(0);
    subscription.dispose();
  });
});

describe('configChangedPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const listeners = new Set<(event: ConfigSectionChangedEvent) => void>();
    let backing: Record<string, unknown> = {};
    const published: ConfigChanged[] = [];
    let disposed = false;
    const core = {
      accessor: {
        get: (token: unknown) => {
          if (token === IConfigService) {
            return {
              onDidSectionChange: (listener: (event: ConfigSectionChangedEvent) => void) => {
                listeners.add(listener);
                return {
                  dispose: () => {
                    disposed = true;
                    listeners.delete(listener);
                  },
                };
              },
              getAll: () => backing,
            };
          }
          return {
            publish: (event: Event2<unknown>) => published.push(event as ConfigChanged),
          };
        },
      },
    } as unknown as Scope;
    const publisher = startConfigChangedPublisher(core);
    const fire = (domain: string): void => {
      for (const listener of listeners) {
        listener({ domain, source: 'set', value: undefined, previousValue: undefined });
      }
    };
    return {
      publisher,
      published,
      fire,
      isDisposed: () => disposed,
      setBacking: (value: Record<string, unknown>) => {
        backing = value;
      },
    };
  }

  it('merges section events inside one flush window into a single ConfigChanged', () => {
    vi.useFakeTimers();
    const { published, fire } = setup();

    fire('defaultPermissionMode');
    fire('defaultModel');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload.changedFields).toEqual(['defaultModel', 'defaultPermissionMode']);
  });

  it('projects the full config snapshot at flush time', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();

    fire('defaultModel');
    setBacking({ defaultModel: 'k2', providers: {} });
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload.config).toEqual({ default_model: 'k2', providers: {} });
  });

  it('redacts inline model credentials from the published config projection', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();
    setBacking({
      providers: {},
      models: {
        'p/m': { provider: 'p', model: 'm', maxContextSize: 4096, apiKey: 'sk-secret' },
        'p/flat': { baseUrl: 'https://x.test', model: 'm', oauth: { storage: 'file', key: 'oauth/x' } },
      },
    });

    fire('models');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    const config = published[0]?.payload.config as Record<string, unknown>;
    const models = config['models'] as Record<string, Record<string, unknown>>;
    expect(models['p/m']).toEqual({ provider: 'p', model: 'm', maxContextSize: 4096, has_api_key: true });
    expect(models['p/flat']).toEqual({ baseUrl: 'https://x.test', model: 'm', has_api_key: true });
    expect(JSON.stringify(models)).not.toContain('sk-secret');
  });

  it('redacts inline service credentials from the published config projection', () => {
    vi.useFakeTimers();
    const { published, fire, setBacking } = setup();
    setBacking({
      providers: {},
      services: {
        moonshotSearch: {
          baseUrl: 'https://s.test',
          apiKey: 'sk-svc',
          customHeaders: { Authorization: 'Bearer abc', 'x-team': 'core' },
        },
      },
    });

    fire('services');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(1);
    const config = published[0]?.payload.config as Record<string, unknown>;
    const services = config['services'] as Record<string, Record<string, unknown>>;
    expect(services['moonshotSearch']).toEqual({
      baseUrl: 'https://s.test',
      has_api_key: true,
      custom_header_keys: ['Authorization', 'x-team'],
    });
    expect(JSON.stringify(services)).not.toContain('sk-svc');
    expect(JSON.stringify(services)).not.toContain('Bearer abc');
  });

  it('always delivers a trailing event for late-arriving changes', () => {
    vi.useFakeTimers();
    const { published, fire } = setup();

    fire('defaultPermissionMode');
    vi.advanceTimersByTime(12);
    fire('models');
    vi.advanceTimersByTime(12);

    expect(published).toHaveLength(2);
    expect(published[1]?.payload.changedFields).toEqual(['models']);
  });

  it('drops pending changes on close and never publishes afterwards', () => {
    vi.useFakeTimers();
    const { published, publisher, fire, isDisposed } = setup();

    fire('defaultModel');
    publisher.close();
    vi.advanceTimersByTime(50);
    fire('models');
    vi.advanceTimersByTime(50);

    expect(published).toHaveLength(0);
    expect(isDisposed()).toBe(true);
  });
});

interface ReloadCoreConfig {
  readonly domain: string;
  readonly source: ConfigChangeSource;
}

function setupReloadCore(options: {
  readonly committed?: readonly ReloadCoreConfig[];
  readonly diagnostics?: readonly ConfigDiagnostic[];
  readonly reloadError?: Error;
  readonly readyDeferred?: boolean;
} = {}) {
  const listeners = new Set<(event: ConfigSectionChangedEvent) => void>();
  const callLog: string[] = [];
  let disposedCount = 0;
  let resolveReady: () => void = () => {};
  const ready = options.readyDeferred === true
    ? new Promise<void>((resolve) => {
        resolveReady = resolve;
      })
    : Promise.resolve();

  const fire = (events: readonly ReloadCoreConfig[]): void => {
    for (const event of events) {
      for (const listener of [...listeners]) {
        listener({ domain: event.domain, source: event.source, value: {}, previousValue: {} });
      }
    }
  };

  const config = {
    ready,
    onDidSectionChange: (listener: (event: ConfigSectionChangedEvent) => void) => {
      callLog.push('subscribe');
      listeners.add(listener);
      return {
        dispose: () => {
          disposedCount += 1;
          listeners.delete(listener);
        },
      };
    },
    reload: async (): Promise<void> => {
      callLog.push('reload');
      if (options.reloadError !== undefined) throw options.reloadError;
      fire(options.committed ?? []);
    },
    diagnostics: () => options.diagnostics ?? [],
  };
  const requestedTokens: unknown[] = [];
  const core = {
    accessor: {
      get: (token: unknown) => {
        requestedTokens.push(token);
        return token === IConfigService ? config : undefined;
      },
    },
  } as unknown as Scope;

  return {
    callLog,
    core,
    requestedTokens,
    disposedCount: () => disposedCount,
    liveListeners: () => listeners.size,
    fire,
    markReady: () => {
      resolveReady();
    },
  };
}

describe('reloadConfig', () => {
  it('reports every domain a reload committed, deduped and sorted', async () => {
    const { core, requestedTokens } = setupReloadCore({
      committed: [
        { domain: 'thinking', source: 'reload' },
        { domain: 'providers', source: 'reload' },
        { domain: 'thinking', source: 'reload' },
      ],
    });

    const result = await reloadConfig(core);

    expect(result).toEqual({ changedDomains: ['providers', 'thinking'] });
    expect(result.error).toBeUndefined();
    expect(requestedTokens).toEqual([IConfigService]);
  });

  it('ignores section changes that did not come from the reload', async () => {
    const { core } = setupReloadCore({
      committed: [
        { domain: 'providers', source: 'set' },
        { domain: 'thinking', source: 'load' },
      ],
    });

    const result = await reloadConfig(core);

    expect(result.changedDomains).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('subscribes and reloads only after the config is ready', async () => {
    const { core, callLog, markReady } = setupReloadCore({ readyDeferred: true });

    const pending = reloadConfig(core);
    await Promise.resolve();
    expect(callLog).toEqual([]);

    markReady();
    const result = await pending;

    expect(callLog).toEqual(['subscribe', 'reload']);
    expect(result.changedDomains).toEqual([]);
  });

  it('releases the section-change subscription when the reload settles', async () => {
    const { core, disposedCount, fire, liveListeners } = setupReloadCore({
      committed: [{ domain: 'providers', source: 'reload' }],
    });

    const result = await reloadConfig(core);
    fire([{ domain: 'thinking', source: 'reload' }]);

    expect(result.changedDomains).toEqual(['providers']);
    expect(disposedCount()).toBe(1);
    expect(liveListeners()).toBe(0);
  });

  it('reports the first error diagnostic and keeps reporting the committed domains', async () => {
    const { core } = setupReloadCore({
      committed: [{ domain: 'providers', source: 'reload' }],
      diagnostics: [
        { severity: 'warning', message: 'Ignored invalid config section' },
        { severity: 'error', message: 'Failed to parse /tmp/example/config.toml: expected a key' },
        { severity: 'error', message: 'a second error must not surface' },
      ],
    });

    const result = await reloadConfig(core);

    expect(result.error).toBe('Failed to parse /tmp/example/config.toml: expected a key');
    expect(result.changedDomains).toEqual(['providers']);
  });

  it('reports an error over a reload that committed nothing', async () => {
    const { core, callLog, disposedCount } = setupReloadCore({
      diagnostics: [{ severity: 'error', message: 'Failed to parse /tmp/example/config.toml' }],
    });

    const result = await reloadConfig(core);

    expect(result).toEqual({
      changedDomains: [],
      error: 'Failed to parse /tmp/example/config.toml',
    });
    expect(callLog).toEqual(['subscribe', 'reload']);
    expect(disposedCount()).toBe(1);
  });

  it('reports no error when the reload left only warnings behind', async () => {
    const { core } = setupReloadCore({
      diagnostics: [{ severity: 'warning', message: 'Environment variable is deprecated' }],
    });

    const result = await reloadConfig(core);

    expect(result.error).toBeUndefined();
    expect(result.changedDomains).toEqual([]);
  });

  it('propagates a rejected reload and still releases the subscription', async () => {
    const reloadError = new Error('config reload exploded');
    const { core, disposedCount, liveListeners } = setupReloadCore({ reloadError });

    const failure = await reloadConfig(core).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBe(reloadError);
    expect(disposedCount()).toBe(1);
    expect(liveListeners()).toBe(0);
  });
});

describe('reloadConfig against a running server', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-reload-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function boot(toml: string): Promise<RunningServer> {
    await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    await server.core.accessor.get(IConfigService).ready;
    return server;
  }

  function configOf(live: RunningServer): IConfigService {
    return live.core.accessor.get(IConfigService);
  }

  async function reloadOverEditsUntilOneLandsInsideAReloadWindow(
    live: RunningServer,
    modes: readonly string[],
  ): Promise<ConfigReloadResult> {
    for (const mode of modes) {
      await writeFile(
        join(home as string, 'config.toml'),
        `default_permission_mode = "${mode}"\n`,
        'utf-8',
      );
      const report = await reloadConfig(live.core);
      if (report.changedDomains.length > 0) return report;
    }
    return { changedDomains: [] };
  }

  it('reports the domains an external config.toml edit changed', async () => {
    const live = await boot('default_permission_mode = "auto"\n');

    const result = await reloadOverEditsUntilOneLandsInsideAReloadWindow(live, [
      'yolo',
      'manual',
      'yolo',
      'manual',
    ]);

    expect(result.error).toBeUndefined();
    expect(result.changedDomains).toEqual(['defaultPermissionMode']);
  });

  it('reports no changed domains once the engine watcher already applied the edit', async () => {
    const live = await boot('default_permission_mode = "auto"\n');

    await writeFile(
      join(home as string, 'config.toml'),
      'default_permission_mode = "yolo"\n',
      'utf-8',
    );
    await vi.waitFor(() => {
      expect(configOf(live).get<string>('defaultPermissionMode')).toBe('yolo');
    });
    const result = await reloadConfig(live.core);

    expect(result).toEqual({ changedDomains: [] });
  });

  it('reports no changed domains when config.toml was not touched', async () => {
    const live = await boot('default_permission_mode = "auto"\n');

    const result = await reloadConfig(live.core);

    expect(result).toEqual({ changedDomains: [] });
    expect(configOf(live).get<string>('defaultPermissionMode')).toBe('auto');
  });

  it('reports the parse error of a broken config.toml and keeps the previous values', async () => {
    const live = await boot('default_permission_mode = "auto"\n');

    await writeFile(join(home as string, 'config.toml'), '[providers\nbroken\n', 'utf-8');
    const result = await reloadConfig(live.core);

    expect(result.error).toMatch(/failed to decode .*config\.toml as toml/);
    expect(result.changedDomains).toEqual([]);
    expect(configOf(live).get<string>('defaultPermissionMode')).toBe('auto');
  });
});
