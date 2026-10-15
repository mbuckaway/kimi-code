/**
 * Tests for the `kimi web` Commander wiring and its subcommands.
 *
 * These tests don't actually start the server — the foreground runner is
 * injected, so they verify option parsing, the ready banner / one-line ready
 * output, browser opening, and the rotate-token / deprecated `kimi server kill`
 * subcommands against fake deps. The termination tests drive the signal
 * controller with a fake process and the foreground runner with a stubbed
 * `startServer`, so no port is bound and no signal reaches the test worker.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';

import { CLI_SHUTDOWN_TIMEOUT_MS, WEB_SHUTDOWN_FORCE_EXIT_MS } from '#/constant/app';
import { registerWebCommand } from '#/cli/sub/web';
import type { LegacyKillDeps } from '#/cli/sub/web/legacy-kill';
import type { WebCommandDeps } from '#/cli/sub/web/run';
import { parseServerOptions, type ParsedServerOptions } from '#/cli/sub/web/shared';
import { darkColors } from '#/tui/theme/colors';

// Boundary stubs for the termination tests: `startServer` binds a real port and
// the telemetry client opens a network sink. Both are installed with `doMock`
// inside the suites that need them, never file-wide — kap-server resolves its
// instance-registry directory from `KIMI_CODE_HOME` at import time, so a
// file-level mock would leak past the `resetModules` isolation that the
// rotate-token tests depend on. Every factory spreads the original module so
// the rest of each surface stays real.
const webRunMocks = vi.hoisted(() => ({
  flushTelemetrySync: vi.fn(),
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
  startServer: vi.fn(),
  track: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

async function mockTelemetryBoundary() {
  vi.doMock('@moonshot-ai/kimi-telemetry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@moonshot-ai/kimi-telemetry')>();
    return {
      ...actual,
      flushTelemetrySync: webRunMocks.flushTelemetrySync,
      initializeTelemetry: webRunMocks.initializeTelemetry,
      shutdownTelemetry: webRunMocks.shutdownTelemetry,
      track: webRunMocks.track,
    };
  });
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerWebCommand(program);
  return program;
}

type ForegroundRunner = NonNullable<WebCommandDeps['startServerForeground']>;

/**
 * Fake foreground runner: records the parsed options and fires `onReady` with
 * a fixed origin, then returns (the real runner blocks until SIGINT/SIGTERM).
 */
function makeRunner(origin = 'http://127.0.0.1:58627'): {
  runner: ForegroundRunner;
  calls: { options: ParsedServerOptions | undefined };
} {
  const calls: { options: ParsedServerOptions | undefined } = { options: undefined };
  const runner: ForegroundRunner = async (options, hooks) => {
    calls.options = options;
    await hooks?.onReady?.(origin);
    return undefined as never;
  };
  return { runner, calls };
}

/** Capturing stdout/stderr pair for `WebCommandDeps`. */
function makeIo(): {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  readStdout(): string;
  readStderr(): string;
} {
  let out = '';
  let err = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        err += String(chunk);
        return true;
      },
    },
    readStdout: () => out,
    readStderr: () => err,
  };
}

/**
 * Fake process for the termination seam: records `once` listeners by signal so
 * a test can fire one and await the shutdown it started, and honours `off`.
 */
function fakeProcess() {
  const listeners = new Map<NodeJS.Signals, () => Promise<void> | void>();
  return {
    once: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      listeners.set(signal, listener);
    }),
    off: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
      }
    }),
    exit: vi.fn(),
    listener: (signal: NodeJS.Signals) => listeners.get(signal),
    listenerCount: () => listeners.size,
  };
}

/** A fake process plus the captured stdio pair the termination seam expects. */
function makeTermination() {
  const proc = fakeProcess();
  const io = makeIo();
  return { proc, io, targets: { proc, stdout: io.stdout, stderr: io.stderr } };
}

/** A `RunningServer` surface with only what `runServerInProcess` consumes. */
function startedServer(close?: () => Promise<unknown>) {
  return { host: '127.0.0.1', port: 58627, close: vi.fn(close ?? (async () => {})) };
}

/** A promise plus its resolver, so a test can hold `startServer` in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });
  return { promise, resolve };
}

/**
 * Runs the pending promise chains to completion. The foreground runner never
 * resolves, so a test cannot await it; this awaits the work a signal started.
 */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

describe('kimi web', () => {
  it('registers the `web` command with only the rotate-token subcommand', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const subs = web?.commands.map((c) => c.name()).toSorted();
    // Foreground servers stop with Ctrl+C, so there is no kill/ps.
    expect(subs).toEqual(['rotate-token']);
  });

  it('exposes the foreground server options on `web` itself', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--allowed-host');
    expect(longs).toContain('--insecure-no-tls');
    expect(longs).toContain('--allow-remote-shutdown');
    expect(longs).toContain('--dangerous-bypass-auth');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    expect(longs).toContain('--web-title');
    const remoteControl = web!.options.find((option) => option.long === '--remote-control');
    expect(remoteControl?.short).toBe('--rc');
    // web opens the browser by default → the option is the negative --no-open.
    expect(longs).toContain('--no-open');
    // The background/daemon era flags are gone: the server always runs in the
    // foreground.
    expect(longs).not.toContain('--foreground');
    expect(longs).not.toContain('--keep-alive');
    expect(longs).not.toContain('--daemon');
    expect(longs).not.toContain('--idle-grace-ms');
    expect(longs).not.toContain('--allow-remote-terminals');
  });

  it('routes `kimi server` and any legacy subcommand to a deprecation notice', async () => {
    for (const argv of [
      ['node', 'kimi', 'server'],
      ['node', 'kimi', 'server', 'run', '--port', '1'],
      ['node', 'kimi', 'server', 'status'],
      ['node', 'kimi', 'server', 'ps', '--json'],
    ]) {
      const program = makeProgram();
      let stderr = '';
      const exitCalls: number[] = [];
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined;
      }) as never);

      await program.parseAsync(argv);
      errSpy.mockRestore();
      exitSpy.mockRestore();

      expect(exitCalls).toEqual([1]);
      expect(stderr).toContain('`kimi server` has been deprecated and no longer works.');
      expect(stderr).toContain('kimi web');
      expect(stderr).toContain('kimi server kill');
      expect(stderr).toContain('0.28.0');
      expect(stderr).toContain('next major version');
    }
  });
});

describe('`kimi web` ready banner', () => {
  it('prints the TUI-style ready panel once listening', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    // The runner reports the actual bound origin — the banner must take the
    // port from it, not from the requested --port.
    const { runner } = makeRunner('http://127.0.0.1:58628');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('Local:');
    expect(plain).toContain('http://127.0.0.1:58628/#token=tok');
    expect(plain).toContain('Token:');
    // Loopback bind shows a Network hint for enabling network access.
    expect(plain).toContain('Network:');
    expect(plain).toContain('use --host to enable');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('Ctrl+C');
    // No bordered panel (the token URL must print in full for copying), but
    // the Kimi sprite stays next to the title.
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).not.toContain('Kimi server:');

    // Title is above the URLs; Logs/Stop are at the bottom.
    expect(plain.indexOf('Kimi server ready')).toBeLessThan(plain.indexOf('Local:'));
    expect(plain.indexOf('Logs:')).toBeLessThan(plain.indexOf('Stop:'));
  });

  it('uses the TUI dark palette for the ready banner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', host: '127.0.0.1', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const out = readStdout();
    const color = new Chalk({ level: 3 });
    expect(out).toContain(color.hex(darkColors.primary)('▐█▛█▛█▌'));
    expect(out).toContain(color.bold.hex(darkColors.primary)('Kimi server ready'));
    expect(out).toContain(color.hex(darkColors.accent)('http://127.0.0.1:58627/'));
    expect(out).toContain(color.bold.hex(darkColors.textDim)('Local:    '));
    expect(out).toContain(color.hex(darkColors.textMuted)('off'));
  });

  it('renders the bypass danger notice in the error color', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', dangerousBypassAuth: true, open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const color = new Chalk({ level: 3 });
    expect(readStdout()).toContain(
      color.bold.hex(darkColors.error)(
        '⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).',
      ),
    );
  });

  it('prints the danger notice and suppresses the token when auth is bypassed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', host: '127.0.0.1', dangerousBypassAuth: true, open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl,
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    // Red, impossible-to-miss danger notice.
    expect(plain).toContain('DANGER: authentication is DISABLED');
    expect(plain).toContain('--dangerous-bypass-auth');
    expect(plain).toContain('Ctrl+C');
    // The token is irrelevant when bypassed — neither printed nor carried in
    // any URL (so it cannot leak via copy/paste of the banner).
    expect(plain).not.toContain('tok');
    expect(plain).not.toContain('#token=');
    // The opened browser URL carries no token fragment either.
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('ready banner reflects the bind class', () => {
  it('lists Local + Network addresses for a 0.0.0.0 bind (Vite-style)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        networkAddresses: [
          { address: '192.0.2.66', family: 'IPv4' },
          { address: '198.51.100.216', family: 'IPv4' },
        ],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('Network:');
    // Full token-bearing URLs are printed plainly (no box, no truncation) so
    // they are easy to copy.
    expect(raw).toContain('http://localhost:58627/#token=tok-xyz');
    expect(raw).toContain('http://192.0.2.66:58627/#token=tok-xyz');
    expect(raw).toContain('http://198.51.100.216:58627/#token=tok-xyz');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-xyz');
    expect(raw).not.toContain('╭');
  });

  it('lists only the Local URL for a 127.0.0.1 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-loop',
        // Injected interface addresses must NOT leak into a loopback banner.
        networkAddresses: [{ address: '192.0.2.66', family: 'IPv4' }],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('http://127.0.0.1:58627/#token=tok-loop');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-loop');
    // No network URLs on a loopback bind — just the "off" hint.
    expect(raw).toContain('use --host to enable');
    expect(raw).not.toContain('Network:  http');
    expect(raw).not.toContain('192.0.2.66');
    expect(raw).not.toContain('╭');
  });
});

describe('`kimi web` opens the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
  });

  it('opens the Web UI URL with the #token= fragment by default', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#token=tok-xyz');
  });

  it('opens the plain origin when no token is resolvable', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });

  it('does not open the browser when open is false', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:9000');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl, stdout, stderr },
    );

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps --remote-control and --rc to the same option', () => {
    for (const flag of ['--remote-control', '--rc']) {
      const program = makeProgram();
      const web = program.commands.find((command) => command.name() === 'web')!;
      web.parseOptions([flag]);
      expect(web.opts()).toMatchObject({ remoteControl: true });
    }
  });

  it('rejects Remote Control on a non-loopback host', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '1');
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { remoteControl: true, host: '0.0.0.0', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow('--remote-control requires a loopback host.');
  });

  it('rejects --remote-control while the experimental flag is off', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '0');
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { remoteControl: true, open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow('--remote-control is experimental:');
  });

  it('hides --remote-control from help unless the experimental flag is on', () => {
    const remoteControlOption = () =>
      makeProgram()
        .commands.find((command) => command.name() === 'web')!
        .options.find((option) => option.long === '--remote-control');

    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '0');
    expect(remoteControlOption()?.hidden).toBe(true);
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '1');
    expect(remoteControlOption()?.hidden).toBe(false);
  });
});

describe('kimi rc', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers `rc` with the `remote` alias and the web server options, without a --remote-control flag', () => {
    const program = makeProgram();
    const rc = program.commands.find((c) => c.name() === 'rc');
    expect(rc).toBeDefined();
    expect(rc!.alias()).toBe('remote');
    const longs = rc!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--no-open');
    expect(longs).not.toContain('--remote-control');
  });

  it('hides `rc` from help unless the experimental flag is on', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '0');
    expect(makeProgram().helpInformation()).not.toContain('rc|remote');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '1');
    expect(makeProgram().helpInformation()).toContain('rc|remote');
  });

  it('forces Remote Control for both `rc` and `remote`', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL', '0');
    for (const name of ['rc', 'remote']) {
      const program = makeProgram();
      let stderr = '';
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      try {
        await program.parseAsync(['node', 'kimi', name]);
      } finally {
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
      // The flag-off experimental error proves remoteControl was forced before
      // the runner could start.
      expect(stderr).toContain('--remote-control is experimental:');
    }
  });
});

describe('`kimi web` option threading', () => {
  it('threads the CLI flags into the foreground runner options', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      {
        port: '59000',
        host: '0.0.0.0',
        insecureNoTls: true,
        allowedHost: ['.example.com'],
        dangerousBypassAuth: true,
        debugEndpoints: true,
        allowRemoteShutdown: true,
        open: false,
      },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toEqual({
      host: '0.0.0.0',
      port: 59000,
      logLevel: 'silent',
      debugEndpoints: true,
      insecureNoTls: true,
      allowRemoteShutdown: true,
      dangerousBypassAuth: true,
      enableKimiOauth: false,
      allowedHosts: ['.example.com'],
      webTitle: undefined,
    });
  });

  it('defaults the host to 127.0.0.1 and insecureNoTls to true', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({
      host: '127.0.0.1',
      insecureNoTls: true,
      logLevel: 'silent',
    });
  });

  it('maps a bare --host to the default LAN host', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', host: true, open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });

  it('passes --log-level through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'debug', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ logLevel: 'debug' });
  });

  it('passes --web-title through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', webTitle: 'My Dev Box', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ webTitle: 'My Dev Box' });
  });

  it('leaves webTitle undefined when --web-title is not passed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options?.webTitle).toBeUndefined();
  });

  it('rejects an invalid --log-level before calling the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const startServerForeground = vi.fn(async () => undefined as never);
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { logLevel: 'shout', open: false },
        { startServerForeground, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(startServerForeground).not.toHaveBeenCalled();
  });

  it('prints the one-line ready line instead of the full banner with a non-default --log-level', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'info', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server: http://127.0.0.1:58627/#token=tok');
    expect(plain).not.toContain('Kimi server ready');
    expect(plain).not.toContain('Local:');
  });

  it('parses comma-separated --allowed-host values', async () => {
    const { parseAllowedHostArgs } = await import('#/cli/sub/web/shared');
    expect(parseAllowedHostArgs(['.example.com, app.example.com'])).toEqual([
      '.example.com',
      'app.example.com',
    ]);
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/web/shared');
    expect(() => parsePort('99999', '--port', 58627)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 58627)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 58627)).toBe(58627);
    expect(parsePort('8080', '--port', 58627)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/web/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir('/cache/kimi/dist-web')).toBe('/cache/kimi/dist-web');
  });

  it('falls back to package dist-web outside SEA mode', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist-web$/);
  });

  it('returns the assets dir when it is built, dev mode or not', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires built assets outside dev mode', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates missing assets in dev mode (API-only server)', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeLegacyKillDeps(overrides: Partial<LegacyKillDeps> = {}): {
  deps: LegacyKillDeps;
  writes: string[];
  errors: string[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  state: { shutdownCalls: number; removeCalls: number };
  clock: { t: number };
} {
  const writes: string[] = [];
  const errors: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const state = { shutdownCalls: 0, removeCalls: 0 };
  const clock = { t: 0 };
  const deps: LegacyKillDeps = {
    readLock: async () => undefined,
    removeLock: async () => {
      state.removeCalls += 1;
    },
    requestShutdown: async () => {
      state.shutdownCalls += 1;
    },
    resolveToken: () => undefined,
    signalPid: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
    pidAlive: () => false,
    sleep: async (ms) => {
      clock.t += ms;
    },
    stdout: {
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        errors.push(String(chunk));
        return true;
      },
    },
    now: () => clock.t,
    ...overrides,
  };
  return { deps, writes, errors, signals, state, clock };
}

describe('`kimi server kill` (deprecated, legacy servers only)', () => {
  const legacyLock = { pid: 1234, host: '127.0.0.1', port: 58627 };

  it('is registered as the only working subcommand of the deprecated `server` command', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    expect(server?.commands.map((c) => c.name())).toEqual(['kill']);
  });

  it('prints a deprecation notice naming the 0.28.0 cutoff on every run', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, errors } = makeLegacyKillDeps();

    await handleLegacyKillCommand(deps);

    const notice = errors.join('');
    expect(notice).toContain('deprecated');
    expect(notice).toContain('0.28.0');
    expect(notice).toContain('Ctrl+C');
  });

  it('prints "No running legacy Kimi server." and sends no signal when no lock exists', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals } = makeLegacyKillDeps({ readLock: async () => undefined });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
  });

  it('sweeps a stale lock whose pid is already dead', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => false,
    });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
    expect(state.shutdownCalls).toBe(0);
    expect(state.removeCalls).toBe(1);
  });

  it('attempts the API shutdown, then stops after SIGTERM when the pid exits promptly', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(1);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
    expect(writes.join('')).toContain('pid 1234');
    expect(writes.join('')).toContain('stopped.');
    // The lock is removed once the pid is confirmed dead.
    expect(state.removeCalls).toBe(1);
  });

  it('escalates to SIGKILL when the pid survives SIGTERM', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, clock } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 5678 }),
      // Survives the 3s SIGTERM grace, dies during the 2s SIGKILL grace.
      pidAlive: () => clock.t < 3100,
    });

    await handleLegacyKillCommand(deps);

    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(writes.join('')).toContain('pid 5678');
    expect(writes.join('')).toContain('killed.');
  });

  it('throws a permissions error when the pid survives SIGKILL', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 9999 }),
      pidAlive: () => true,
    });

    await expect(handleLegacyKillCommand(deps)).rejects.toThrow(/insufficient permissions/);
  });

  it('skips the API path when the lock records no port', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => ({ pid: 1234 }),
      // Alive at the initial check, dead when the SIGTERM grace polls.
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(0);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
  });

  it('passes the resolved token to requestShutdown', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => 'tok-123',
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBe('tok-123');
  });

  it('passes undefined when the token cannot be read (best-effort)', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => undefined,
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBeUndefined();
  });
});

describe('readLegacyLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-legacy-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a lock written by an old build', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, started_at: '2026-01-01T00:00:00.000Z', port: 58627 }),
    );

    await expect(readLegacyLock(lockPath)).resolves.toEqual({
      pid: 1234,
      host: undefined,
      port: 58627,
    });
  });

  it('rejects a corrupt lock whose pid is not a positive integer', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    // pid 0 / negative pids have process-group semantics on POSIX — the lock
    // must be treated as unusable rather than signaled.
    for (const pid of [0, -1, 1.5, '1234']) {
      writeFileSync(lockPath, JSON.stringify({ pid, port: 58627 }));
      await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
    }
  });

  it('returns undefined when the lock file is missing or unparseable', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    await expect(readLegacyLock(join(dir, 'missing'))).resolves.toBeUndefined();
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, 'not json');
    await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
  });
});

describe('resolveServerToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the token from <homeDir>/server.token', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), 'secret-token\n');
    expect(resolveServerToken(dir)).toBe('secret-token');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), '  tok  \n');
    expect(resolveServerToken(dir)).toBe('tok');
  });

  it('throws a clear error when the token file is missing', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/);
  });
});

describe('authHeaders', () => {
  it('builds a Bearer Authorization header', async () => {
    const { authHeaders } = await import('#/cli/sub/web/shared');
    expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('buildWebUrl', () => {
  it('carries the token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('#token=abc123');
    // The token is client-side only: it must NOT appear in the path or query
    // (which WOULD be sent to the server and logged).
    expect(parsed.pathname).not.toContain('abc123');
    expect(parsed.search).not.toContain('abc123');
  });

  it('normalizes a trailing slash', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe(
      'http://127.0.0.1:58627/#token=t',
    );
  });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('0.0.0.0', 58627, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
    ]);
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://localhost:58627/#token=tok' },
      { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' },
    ]);
  });

  it('returns a single Local line for a loopback bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('127.0.0.1', 58627, 'tok');
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' },
    ]);
  });

  it('returns a single URL line for a specific host (no token)', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('192.168.1.5', 58627, undefined);
    expect(lines).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]);
  });

  it('splitTokenFragment splits off the #token= fragment', async () => {
    const { splitTokenFragment } = await import('#/cli/sub/web/access-urls');
    expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']);
    expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']);
  });
});

describe('`kimi web rotate-token`', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rotate-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new token to server.token and prints it', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(token);
  });

  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    // Fake a live instance-registry entry pointing at this (alive) process so
    // getLiveServerInstance() finds the running server and the command can
    // re-print its links.
    mkdirSync(join(dir, 'server', 'instances'), { recursive: true });
    writeSync(
      join(dir, 'server', 'instances', '01JTEST0000000000000000000.json'),
      JSON.stringify({
        server_id: '01JTEST0000000000000000000',
        pid: process.pid,
        host: '127.0.0.1',
        port: 58627,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      }),
    );

    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
    // Token line sits between the note and the links.
    expect(stdout.indexOf('picks up the new token')).toBeLessThan(
      stdout.indexOf('New server token'),
    );
    expect(stdout.indexOf('New server token')).toBeLessThan(
      stdout.indexOf(`http://127.0.0.1:58627/#token=${token}`),
    );
  });
});

describe('formatHostForUrl', () => {
  it('bracket-wraps IPv6 and leaves IPv4 as-is', async () => {
    const { formatHostForUrl } = await import('#/cli/sub/web/networks');
    expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5');
    expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/web/networks');
    const out = filterDisplayAddresses([
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '192.168.1.5', family: 'IPv4' },
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: 'fe80::1', family: 'IPv6' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
    expect(out).toEqual([
      { address: '192.168.1.5', family: 'IPv4' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });
});

describe('`kimi web` termination controller', () => {
  beforeEach(async () => {
    vi.resetModules();
    await mockTelemetryBoundary();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.doUnmock('@moonshot-ai/kimi-telemetry');
  });

  /** Wire the controller against a fake process and a captured stdio pair. */
  async function installController(shutdown: (reason: string) => Promise<void>) {
    const { installServerTerminationHandlers } = await import('#/cli/sub/web/lifecycle');
    const { proc, io, targets } = makeTermination();
    const uninstall = installServerTerminationHandlers({ shutdown, ...targets });
    return { proc, io, uninstall };
  }

  it('arms SIGINT and SIGTERM once each', async () => {
    expect.assertions(3);
    const { proc } = await installController(vi.fn(async () => {}));

    expect(proc.once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(proc.once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(proc.listenerCount()).toBe(2);
  });

  it('reports SIGTERM on stderr and exits 143, never 0', async () => {
    expect.assertions(5);
    const shutdown = vi.fn(async () => {});
    const { proc, io } = await installController(shutdown);

    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    expect(io.readStderr()).toContain('Shutting down (SIGTERM)…');
    expect(io.readStdout()).toBe('');
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(proc.exit).toHaveBeenCalledWith(143);
    expect(proc.exit).not.toHaveBeenCalledWith(0);
  });

  it('reports SIGINT on stderr and exits 130, never 0', async () => {
    expect.assertions(4);
    const shutdown = vi.fn(async () => {});
    const { proc, io } = await installController(shutdown);

    void proc.listener('SIGINT')?.();
    await flushMicrotasks();

    expect(io.readStderr()).toContain('Shutting down (SIGINT)…');
    expect(shutdown).toHaveBeenCalledWith('SIGINT');
    expect(proc.exit).toHaveBeenCalledWith(130);
    expect(proc.exit).not.toHaveBeenCalledWith(0);
  });

  it('uninstalls both handlers on the first signal', async () => {
    expect.assertions(4);
    // A shutdown that never settles models the wedged close this deadline is for.
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { proc } = await installController(shutdown);
    const sigint = proc.listener('SIGINT');
    const sigterm = proc.listener('SIGTERM');
    expect(sigint).toBeDefined();
    expect(sigterm).toBeDefined();

    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    expect(proc.off).toHaveBeenCalledWith('SIGINT', sigint);
    expect(proc.off).toHaveBeenCalledWith('SIGTERM', sigterm);
  });

  it('leaves a repeat signal of the other kind to the default disposition', async () => {
    expect.assertions(3);
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { proc } = await installController(shutdown);

    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    // Nothing intercepts a second Ctrl+C any more, and the wedged first
    // shutdown is not re-entered or exited a second time.
    expect(proc.listener('SIGINT')).toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('restores the listener baseline when uninstalled before any signal', async () => {
    expect.assertions(4);
    const shutdown = vi.fn(async () => {});
    const { proc, io, uninstall } = await installController(shutdown);

    uninstall();

    expect(proc.listenerCount()).toBe(0);
    expect(io.readStderr()).toBe('');
    expect(shutdown).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('force-exits at the deadline when the shutdown never settles', async () => {
    expect.assertions(4);
    vi.useFakeTimers();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const { proc, io } = await installController(shutdown);

    void proc.listener('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(WEB_SHUTDOWN_FORCE_EXIT_MS - 1);

    expect(proc.exit).not.toHaveBeenCalled();
    expect(io.readStderr()).not.toContain('Force-exiting');

    await vi.advanceTimersByTimeAsync(1);

    expect(io.readStderr()).toContain(`Force-exiting after ${WEB_SHUTDOWN_FORCE_EXIT_MS}ms`);
    expect(proc.exit).toHaveBeenCalledWith(143);
  });

  it('flushes telemetry exactly once, only when it force-exits', async () => {
    expect.assertions(2);
    vi.useFakeTimers();
    const wedged = await installController(vi.fn(() => new Promise<void>(() => {})));

    void wedged.proc.listener('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(WEB_SHUTDOWN_FORCE_EXIT_MS);

    expect(webRunMocks.flushTelemetrySync).toHaveBeenCalledTimes(1);
    expect(wedged.proc.exit).toHaveBeenCalledWith(143);
  });

  it('does not force-exit when the shutdown settles in time', async () => {
    expect.assertions(4);
    vi.useFakeTimers();
    const { proc, io } = await installController(vi.fn(async () => {}));

    void proc.listener('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(WEB_SHUTDOWN_FORCE_EXIT_MS);

    expect(io.readStderr()).toContain('Shutting down (SIGTERM)…');
    expect(io.readStderr()).not.toContain('Force-exiting');
    expect(webRunMocks.flushTelemetrySync).not.toHaveBeenCalled();
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });
});

describe('`kimi web` foreground shutdown', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'kimi-web-termination-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    vi.resetModules();
    await mockTelemetryBoundary();
    vi.doMock('@moonshot-ai/kap-server', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
      return { ...actual, startServer: webRunMocks.startServer };
    });
    webRunMocks.startServer.mockReset();
    webRunMocks.initializeTelemetry.mockReset();
    webRunMocks.flushTelemetrySync.mockReset();
    webRunMocks.track.mockReset();
    webRunMocks.shutdownTelemetry.mockReset();
    webRunMocks.shutdownTelemetry.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.doUnmock('@moonshot-ai/kap-server');
    vi.doUnmock('@moonshot-ai/kimi-telemetry');
  });

  /**
   * Drive the real foreground runner against a fake process and a stubbed
   * `startServer`. The returned promise never settles by design, so the caller
   * must not await it.
   */
  async function runForeground(
    hooks: Parameters<ForegroundRunner>[1],
    startServer: (options: unknown) => unknown,
  ) {
    const { startServerForeground } = await import('#/cli/sub/web/run');
    const { proc, io, targets } = makeTermination();
    webRunMocks.startServer.mockImplementation(startServer);
    const run = startServerForeground(parseServerOptions({}), hooks, targets);
    await flushMicrotasks();
    return { proc, io, run };
  }

  it('arms the signal handlers before startServer resolves', async () => {
    expect.assertions(3);
    const gate = deferred<unknown>();

    const { proc } = await runForeground({}, () => gate.promise);

    expect(webRunMocks.startServer).toHaveBeenCalledTimes(1);
    expect(proc.listener('SIGTERM')).toBeDefined();
    expect(proc.listener('SIGINT')).toBeDefined();
  });

  it('aborts startup with the signal code when a signal lands during bootstrap', async () => {
    expect.assertions(4);
    const onReady = vi.fn();
    const gate = deferred<unknown>();

    const { proc, io } = await runForeground({ onReady }, () => gate.promise);
    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    expect(io.readStderr()).toContain('Startup aborted (SIGTERM)');
    expect(webRunMocks.flushTelemetrySync).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(143);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('closes a server whose bootstrap finishes after a startup signal', async () => {
    expect.assertions(2);
    const server = startedServer();
    const gate = deferred<unknown>();
    const onReady = vi.fn();

    const { proc } = await runForeground({ onReady }, () => gate.promise);
    void proc.listener('SIGINT')?.();
    await flushMicrotasks();
    gate.resolve(server);
    await flushMicrotasks();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('shuts a listening server down in hook, close, telemetry order and exits 143', async () => {
    expect.assertions(4);
    const events: string[] = [];
    const server = startedServer(async () => {
      events.push('close');
    });
    webRunMocks.shutdownTelemetry.mockImplementation(async () => {
      events.push('telemetry');
    });
    const onShutdown = vi.fn(async () => {
      events.push('hook');
    });
    const onReady = vi.fn();

    const { proc, io } = await runForeground({ onReady, onShutdown }, () => server);

    expect(onReady).toHaveBeenCalledWith('http://127.0.0.1:58627');

    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    expect(events).toEqual(['hook', 'close', 'telemetry']);
    expect(onShutdown).toHaveBeenCalledWith('SIGTERM');
    expect(io.readStderr()).toContain('Shutting down (SIGTERM)…');
  });

  it('keeps closing and exiting when the shutdown hook rejects', async () => {
    expect.assertions(3);
    const server = startedServer();
    const onShutdown = vi.fn(async () => {
      throw new Error('tunnel close failed');
    });

    const { proc } = await runForeground({ onShutdown }, () => server);
    void proc.listener('SIGTERM')?.();
    await flushMicrotasks();

    // A hook failure must not strand the server: the close and the exit follow.
    expect(onShutdown).toHaveBeenCalledWith('SIGTERM');
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(143);
  });

  it('exits with the signal code when the server close rejects', async () => {
    expect.assertions(2);
    const server = startedServer(async () => {
      throw new Error('close wedged');
    });

    const { proc } = await runForeground({}, () => server);
    void proc.listener('SIGINT')?.();
    await flushMicrotasks();

    expect(proc.exit).toHaveBeenCalledWith(130);
    expect(proc.exit).not.toHaveBeenCalledWith(0);
  });

  it('force-exits at the deadline when the server close never settles', async () => {
    expect.assertions(3);
    vi.useFakeTimers();
    const { startServerForeground } = await import('#/cli/sub/web/run');
    const { proc, io, targets } = makeTermination();
    webRunMocks.startServer.mockResolvedValue(
      startedServer(() => new Promise<void>(() => {})),
    );

    const run = startServerForeground(parseServerOptions({}), {}, targets);
    await vi.advanceTimersByTimeAsync(0);
    void proc.listener('SIGTERM')?.();
    await vi.advanceTimersByTimeAsync(WEB_SHUTDOWN_FORCE_EXIT_MS);

    expect(io.readStderr()).toContain(`Force-exiting after ${WEB_SHUTDOWN_FORCE_EXIT_MS}ms`);
    expect(webRunMocks.flushTelemetrySync).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(143);
    void run;
  });
});

/** Runs `act` and returns the message of the error it threw (empty if none). */
function errorMessageOf(act: () => unknown): string {
  try {
    act();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('readServerConfig', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-config-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(text: string): void {
    writeFileSync(join(dir, 'config.toml'), text, 'utf-8');
  }

  it('reads every [server] key as a camelCase default', async () => {
    writeConfig(`
[server]
host = "192.0.2.7"
port = 8080
log_level = "info"
allowed_host = ["tr.example.com", "www.example.com"]
web_title = "My Dev Box"
open = false
ipv6 = true
insecure_no_tls = true
allow_remote_shutdown = true
dangerous_bypass_auth = false
enable_kimi_oauth = true
debug_endpoints = false
remote_control = true
`);
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig()).toEqual({
      defaults: {
        host: '192.0.2.7',
        port: 8080,
        logLevel: 'info',
        allowedHost: ['tr.example.com', 'www.example.com'],
        webTitle: 'My Dev Box',
        open: false,
        ipv6: true,
        insecureNoTls: true,
        allowRemoteShutdown: true,
        dangerousBypassAuth: false,
        enableKimiOauth: true,
        debugEndpoints: false,
        remoteControl: true,
      },
      warnings: [],
    });
  });

  it('leaves [server] keys the file does not set out of the defaults', async () => {
    // The reader must not invent values: `open: false` has to stay distinguishable
    // from "not configured", or `[server] open = false` could never be overridden.
    writeConfig('[server]\nport = 8080\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig().defaults).toEqual({ port: 8080 });
  });

  it('returns built-in defaults when config.toml does not exist', async () => {
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig()).toEqual({ defaults: {}, warnings: [] });
  });

  it('returns built-in defaults when config.toml is only whitespace', async () => {
    writeConfig('   \n\t\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig()).toEqual({ defaults: {}, warnings: [] });
  });

  it('returns built-in defaults and a warning when config.toml is not valid TOML', async () => {
    // No `[server]` to read must never crash an unrelated operation: `raw` is
    // unset here, so the unknown-key comparison must not touch it.
    writeConfig('[server\nport = 1\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const result = readServerConfig();
    expect(result.defaults).toEqual({});
    expect(result.warnings.join(' ')).toContain('Invalid TOML in');
  });

  it('returns built-in defaults when the section belongs to another domain', async () => {
    writeConfig('[acp]\nsocket = "/tmp/kimi-acp.sock"\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig()).toEqual({ defaults: {}, warnings: [] });
  });

  it('rejects an unknown [server] key, naming it and pointing at the docs', async () => {
    writeConfig('[server]\nport = 8080\nbost = "127.0.0.1"\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const message = errorMessageOf(readServerConfig);

    expect(message).toContain("unknown key 'bost' in [server] of");
    expect(message).toContain(join(dir, 'config.toml'));
    expect(message).toContain('config-files.html#server');
  });

  it('lists every unknown [server] key in one rejection', async () => {
    writeConfig('[server]\nbost = "127.0.0.1"\nportt = 1\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const message = errorMessageOf(readServerConfig);

    expect(message).toContain("'bost'");
    expect(message).toContain("'portt'");
  });

  it('camelizes with the loader rule: log_level is known, port_2 is not', async () => {
    // Pins the local camelizer against `toml.ts`'s `/_([a-z])/g`. A lodash-style
    // `camelCase` would report the typo as `port2` and send the user hunting for
    // a line that is not in their file.
    writeConfig('[server]\nlog_level = "info"\nport_2 = 1\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const message = errorMessageOf(readServerConfig);

    expect(message).toContain("unknown key 'port_2'");
    expect(message).not.toContain('port2');
    expect(message).not.toContain('log_level');
    expect(message).not.toContain('logLevel');
  });

  it('rejects a [server] section the loader discarded, quoting its warning', async () => {
    // The whole section failed validation, so EVERY key looks missing: the
    // rejection must quote the loader instead of calling valid keys unknown.
    writeConfig('[server]\nport = "http"\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const message = errorMessageOf(readServerConfig);

    expect(message).toContain('Ignored invalid config in');
    expect(message).toContain('config-files.html#server');
    expect(message).not.toContain('dangerous_bypass_auth');
    expect(message).not.toContain('unknown key');
  });

  it('rejects a top-level server key that is not a table', async () => {
    // `server = 5` reaches the raw document as a number: it must not be read as
    // "no section" (silent no-op) nor camelized through `Object.keys`.
    writeConfig('server = 5\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const message = errorMessageOf(readServerConfig);

    expect(message).toContain('[server]');
    expect(message).toContain(join(dir, 'config.toml'));
  });

  it('rejects an array-of-tables server section', async () => {
    writeConfig('[[server]]\nport = 1\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(errorMessageOf(readServerConfig)).toContain('[server]');
  });

  it.each([
    ['"all"', '0.0.0.0'],
    ['"ALL"', '0.0.0.0'],
    ['"All"', '0.0.0.0'],
    ['"*"', '0.0.0.0'],
    ['""', '0.0.0.0'],
    ['"192.0.2.7"', '192.0.2.7'],
    ['"localhost"', 'localhost'],
  ])('resolves the configured host %s to the bind address %s', async (written, expected) => {
    // `parseHost` has no sentinel branch: an unresolved `all` would bind a
    // hostname called "all" instead of every interface.
    writeConfig(`[server]\nhost = ${written}\n`);
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    expect(readServerConfig().defaults).toEqual({ host: expected });
  });

  it('surfaces loader warnings while keeping a valid [server] section', async () => {
    writeConfig('[acp]\nsocket = 5\n[server]\nport = 8080\n');
    const { readServerConfig } = await import('#/cli/sub/web/server-config');

    const result = readServerConfig();

    expect(result.defaults).toEqual({ port: 8080 });
    expect(result.warnings.join(' ')).toContain('acp');
  });
});

describe('tryReadServerConfig', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-config-soft-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(text: string): void {
    writeFileSync(join(dir, 'config.toml'), text, 'utf-8');
  }

  it('warns on stderr instead of throwing when a [server] key is unknown', async () => {
    // A `[server]` typo must not block an unrelated operation
    // (`rotate-token`, the TUI `/web`, the SIGHUP re-read) — but under
    // no-silent-failure the warning has to actually be written.
    writeConfig('[server]\nbost = "127.0.0.1"\n');
    let stderr = '';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    const { tryReadServerConfig } = await import('#/cli/sub/web/server-config');
    const result = tryReadServerConfig();
    errSpy.mockRestore();

    expect(result.defaults).toEqual({});
    expect(stderr).toContain("unknown key 'bost' in [server] of");
  });

  it('warns on stderr instead of throwing when the [server] section is invalid', async () => {
    writeConfig('[server]\nport = "http"\n');
    let stderr = '';
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    const { tryReadServerConfig } = await import('#/cli/sub/web/server-config');
    const result = tryReadServerConfig();
    errSpy.mockRestore();

    expect(result.defaults).toEqual({});
    expect(stderr).toContain('Ignored invalid config in');
  });

  it('returns the parsed defaults and stays silent for a valid section', async () => {
    writeConfig('[server]\nport = 8080\nopen = false\n');
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { tryReadServerConfig } = await import('#/cli/sub/web/server-config');
    const result = tryReadServerConfig();
    errSpy.mockRestore();

    expect(result.defaults).toEqual({ port: 8080, open: false });
    expect(errSpy).not.toHaveBeenCalled();
  });
});

