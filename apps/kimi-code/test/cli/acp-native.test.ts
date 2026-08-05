/**
 * `kimi acp`
 *
 * Verifies that the ACP v2 sub-command is registered on the program and that
 * the action wires `@moonshot-ai/acp-server`'s `runAcpServer` / socket
 * transport (the real server is stubbed so the test doesn't actually take
 * over stdio). The module is loaded via a lazy dynamic import in the action,
 * so the mock intercepts that import.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadRuntimeConfigSafe: vi.fn(
    (): { config: { acp?: { socket?: string } }; fileError: Error | undefined } => ({
      config: {},
      fileError: undefined,
    }),
  ),
}));

vi.mock('@moonshot-ai/acp-server', () => ({
  runAcpServer: vi.fn(async () => undefined),
  runAcpServerOnSocket: vi.fn(async () => undefined),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  // Spread the real module: acp-native.ts needs the real `resolveConfigPath`
  // and type surface; only the config read is stubbed so tests can control
  // the `[acp].socket` value without touching the real config.toml.
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
  };
});

import { runAcpServer, runAcpServerOnSocket } from '@moonshot-ai/acp-server';

import { registerAcpCommand } from '#/cli/sub/acp';
import { registerNativeAcpCommand } from '#/cli/sub/acp-native';
import { getDataDir } from '#/utils/paths';

class ExitCalled extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('kimi acp', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_LEGACY_FLAG', '');
    vi.mocked(runAcpServer).mockClear();
    vi.mocked(runAcpServerOnSocket).mockClear();
    mocks.loadRuntimeConfigSafe.mockClear();
    mocks.loadRuntimeConfigSafe.mockReturnValue({ config: {}, fileError: undefined });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new ExitCalled(code);
    }) as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('registers an `acp` subcommand on the program', () => {
    const program = new Command('kimi');
    registerNativeAcpCommand(program);

    const acpV2 = program.commands.find((c) => c.name() === 'acp');
    expect(acpV2).toBeDefined();
    expect(acpV2?.description()).toMatch(/Agent Client Protocol/);
  });

  it('uses the v2 server for the default `acp` command', async () => {
    const program = new Command('kimi').exitOverride();
    registerAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpServer).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ homeDir: getDataDir() }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('invokes runAcpServer with the v2 host options and exits 0 on success', async () => {
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
    expect(optsArg).toEqual(
      expect.objectContaining({
        homeDir: getDataDir(),
        agentInfo: { name: 'Kimi Code CLI', version: expect.any(String) },
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('forwards KIMI_CODE_HOME to terminalAuthEnv and homeDir when set', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = '/tmp/kimi-debug';
    try {
      const program = new Command('kimi').exitOverride();
      registerNativeAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[0];
      expect(optsArg).toEqual(
        expect.objectContaining({
          homeDir: '/tmp/kimi-debug',
          terminalAuthEnv: { KIMI_CODE_HOME: '/tmp/kimi-debug' },
        }),
      );
    } finally {
      if (previous === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('omits terminalAuthEnv when KIMI_CODE_HOME is unset', async () => {
    const previous = process.env['KIMI_CODE_HOME'];
    delete process.env['KIMI_CODE_HOME'];
    try {
      const program = new Command('kimi').exitOverride();
      registerNativeAcpCommand(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

      const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[0] as {
        terminalAuthEnv?: unknown;
      };
      expect(optsArg.terminalAuthEnv).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previous;
      }
    }
  });

  it('forwards process.argv[1] as terminalAuthLegacyCommand', async () => {
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    const optsArg = vi.mocked(runAcpServer).mock.calls[0]?.[0] as {
      terminalAuthLegacyCommand?: string;
    };
    expect(typeof optsArg.terminalAuthLegacyCommand).toBe('string');
    expect((optsArg.terminalAuthLegacyCommand ?? '').length).toBeGreaterThan(0);
    expect(optsArg.terminalAuthLegacyCommand).toBe(process.argv[1]);
  });

  it('exits without starting the ACP server when --login is passed', async () => {
    // Stub the SDK harness so runLoginFlow doesn't hit a real OAuth endpoint:
    // harness.auth.login resolves immediately and triggers exit 0.
    const loginStub = vi.fn(async () => ({ providerName: 'kimi-code' }));
    vi.doMock(import('@moonshot-ai/kimi-code-sdk'), async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        createKimiHarness: () =>
          ({
            auth: { login: loginStub },
          }) as unknown as ReturnType<typeof actual.createKimiHarness>,
      };
    });
    vi.resetModules();
    const { registerNativeAcpCommand: freshRegister } = await import('#/cli/sub/acp-native');
    try {
      const program = new Command('kimi').exitOverride();
      freshRegister(program);

      await expect(program.parseAsync(['node', 'kimi', 'acp', '--login'])).rejects.toThrow(
        ExitCalled,
      );

      expect(loginStub).toHaveBeenCalledTimes(1);
      expect(runAcpServer).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.doUnmock('@moonshot-ai/kimi-code-sdk');
      vi.resetModules();
    }
  });

  it('uses the socket transport when --socket is passed', async () => {
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(
      program.parseAsync(['node', 'kimi', 'acp', '--socket', '/tmp/x.sock']),
    ).rejects.toThrow(ExitCalled);

    expect(runAcpServer).not.toHaveBeenCalled();
    expect(runAcpServerOnSocket).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(runAcpServerOnSocket).mock.calls[0]?.[0];
    expect(optsArg).toEqual(
      expect.objectContaining({
        homeDir: getDataDir(),
        socketPath: '/tmp/x.sock',
        agentInfo: { name: 'Kimi Code CLI', version: expect.any(String) },
      }),
    );
    expect(stderrSpy).toHaveBeenCalledWith('acp server listening on /tmp/x.sock\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('uses the socket transport when [acp].socket is set in config', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { acp: { socket: '/tmp/cfg.sock' } },
      fileError: undefined,
    });
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServer).not.toHaveBeenCalled();
    expect(runAcpServerOnSocket).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(runAcpServerOnSocket).mock.calls[0]?.[0];
    expect(optsArg).toEqual(expect.objectContaining({ socketPath: '/tmp/cfg.sock' }));
    expect(stderrSpy).toHaveBeenCalledWith('acp server listening on /tmp/cfg.sock\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prefers the --socket flag over the [acp].socket config value', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { acp: { socket: '/tmp/cfg.sock' } },
      fileError: undefined,
    });
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(
      program.parseAsync(['node', 'kimi', 'acp', '--socket', '/tmp/flag.sock']),
    ).rejects.toThrow(ExitCalled);

    expect(runAcpServer).not.toHaveBeenCalled();
    expect(runAcpServerOnSocket).toHaveBeenCalledTimes(1);
    const optsArg = vi.mocked(runAcpServerOnSocket).mock.calls[0]?.[0];
    expect(optsArg).toEqual(expect.objectContaining({ socketPath: '/tmp/flag.sock' }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('falls back to stdio when neither --socket nor [acp].socket is set', async () => {
    const program = new Command('kimi').exitOverride();
    registerNativeAcpCommand(program);

    await expect(program.parseAsync(['node', 'kimi', 'acp'])).rejects.toThrow(ExitCalled);

    expect(runAcpServerOnSocket).not.toHaveBeenCalled();
    expect(runAcpServer).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
