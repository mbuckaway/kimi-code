/**
 * `kimi web` — run the local server in the foreground and open the web UI.
 *
 * The server always runs in the current process, attached to the terminal, and
 * stops on SIGINT/SIGTERM: the shutdown is reported, bounded, and exits with
 * the signal's own code — see `./lifecycle.ts`. `--no-open` skips the browser.
 * Multiple instances can share the home directory: each registers itself in the
 * instance registry and takes the next free port (see kap-server's
 * `startServer`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  createServerLogger,
  reloadConfig,
  startServer,
  type ConfigReloadResult,
  type ServerLogger,
} from '@moonshot-ai/kap-server';
import { resolveConfigPath, resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import {
  flushTelemetrySync,
  shutdownTelemetry,
  track,
} from '@moonshot-ai/kimi-telemetry';
import chalk from 'chalk';
import { type Command, Option } from 'commander';

import { CLI_SHUTDOWN_TIMEOUT_MS, WEB_USER_AGENT_SUFFIX } from '#/constant/app';
import { getNativeWebAssetsDir } from '#/native/web-assets';
import { darkColors } from '#/tui/theme/colors';
import { openUrl as defaultOpenUrl } from '#/utils/open-url';
import { getDataDir } from '#/utils/paths';
import { generateRemoteControlQr } from '#/utils/remote-control-qr';

import { initializeServerTelemetry } from '../../telemetry';
import {
  createKimiCodeHostIdentity,
  getHostPackageRoot,
  getVersion,
} from '../../version';
import {
  accessUrlLines,
  buildOpenableUrl,
  isLoopbackHost,
  splitTokenFragment,
} from './access-urls';
import {
  installServerSignalHandlers,
  type ConfigReloadReport,
  type LifecycleTargets,
} from './lifecycle';
import { type NetworkAddress } from './networks';
import {
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  isRemoteControlEnabled,
  REMOTE_CONTROL_FLAG_ENV,
  startRemoteControl,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlStatus,
} from './remote-control';
import {
  readServerConfig,
  tryReadServerConfig,
  type ServerConfigDefaults,
} from './server-config';
import {
  DEFAULT_FOREGROUND_LOG_LEVEL,
  DEFAULT_LAN_HOST,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  parseServerOptions,
  serverOrigin,
  tryResolveServerToken,
  VALID_LOG_LEVELS,
  type ParsedServerOptions,
  type ServerCliOptions,
} from './shared';

const WEB_ASSETS_DIR = 'dist-web';

/**
 * The config domain this command owns. The engine passes it through on a reload
 * without applying it, so the reload report filters it out (see `reload`).
 */
const SERVER_CONFIG_DOMAIN = 'server';

/** The `[server]` keys that are security-relevant when their value is `true`. */
type SecurityConfigKey =
  | 'dangerousBypassAuth'
  | 'allowRemoteShutdown'
  | 'debugEndpoints'
  | 'enableKimiOauth'
  | 'insecureNoTls';

/** Key as the resolver reads it, and as the user wrote it in the file. */
const SECURITY_CONFIG_KEYS: readonly (readonly [SecurityConfigKey, string])[] = [
  ['dangerousBypassAuth', 'dangerous_bypass_auth'],
  ['allowRemoteShutdown', 'allow_remote_shutdown'],
  ['debugEndpoints', 'debug_endpoints'],
  ['enableKimiOauth', 'enable_kimi_oauth'],
  ['insecureNoTls', 'insecure_no_tls'],
];

/**
 * The config story, stated once instead of in eleven option descriptions. The
 * options no longer carry commander defaults (that would outrank the file), so
 * help has to say where a value comes from when no flag was passed.
 */
const SERVER_CONFIG_HELP = `
Configuration: every option above also reads from the [server] section of
<KIMI_CODE_HOME>/config.toml. Precedence is CLI > [server] > built-in default,
and a security-relevant value taken from the file is reported when the server
starts. A key this command does not know is a startup error, not a warning.`;

/**
 * Minimal surface `runServerInProcess` needs from the server. kap-server's
 * `RunningServer` is adapted to it (it returns `{ host, port, close }`
 * instead of `{ address, logger, close }`).
 */
interface RoutedServer {
  readonly address: string;
  readonly logger: ServerLogger;
  close(): Promise<void>;
  reloadConfig(): Promise<ConfigReloadResult>;
}

/**
 * The `[server]` spelling of a resolved option, for the restart advisory.
 * `allowedHosts` is the only key whose plural form does not survive the
 * mechanical camelCase→snake_case conversion.
 */
const CONFIG_KEY_OVERRIDES: Readonly<Record<string, string>> = {
  allowedHosts: 'allowed_host',
};

function configKeyOf(parsedKey: string): string {
  return (
    CONFIG_KEY_OVERRIDES[parsedKey] ?? parsedKey.replaceAll(/([A-Z])/g, '_$1').toLowerCase()
  );
}

/**
 * Compare two resolved option values. Every field of `ParsedServerOptions` is a
 * primitive or a flat list of strings, so equality is element-wise.
 */
function isSameResolvedValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return a === b;
}

/**
 * The `[server]` keys that a restart would actually change.
 *
 * The question is "would restarting with the same flags pick up a different
 * value?", so the file is re-read and re-parsed with **the same CLI flags** the
 * server started with, then compared against what it is running on. Comparing
 * the two file states instead gets it wrong in both directions: it reports the
 * user's own `--port` as drift on every reload, and it demands a restart for a
 * key the flag pins, which a restart could not change.
 *
 * Lenient on purpose — the server is already running on the values it parsed at
 * startup, so a typo introduced since then must not turn a working reload into a
 * failure. `tryReadServerConfig` has already put that warning on stderr.
 */
function restartKeysFor(
  runningOptions: ParsedServerOptions,
  cliOptions: ServerCliOptions,
): string[] {
  const { defaults } = tryReadServerConfig();
  const reparsed = parseServerOptions(cliOptions, defaults);
  return (Object.keys(reparsed) as (keyof ParsedServerOptions)[])
    .filter((key) => !isSameResolvedValue(runningOptions[key], reparsed[key]))
    .map((key) => configKeyOf(key))
    .toSorted();
}

export interface StartForegroundHooks {
  /** Fires once the server is listening, before the foreground runner blocks. */
  onReady?: (origin: string) => void | Promise<void>;
  onShutdown?: (reason: string) => void | Promise<void>;
}

export interface WebCommandDeps {
  /** Foreground runner; defaults to the real in-process runner when omitted. */
  startServerForeground?: (
    options: ParsedServerOptions,
    hooks?: StartForegroundHooks,
    targets?: LifecycleTargets,
    cliOptions?: ServerCliOptions,
  ) => Promise<never>;
  startRemoteControl?: (options: RemoteControlOptions) => Promise<RemoteControlHandle>;
  openUrl(url: string): void;
  /**
   * Best-effort read of the server's persistent bearer token. When it returns
   * a token, the ready banner prints it and the opened Web UI URL carries it in
   * the `#token=` fragment (M5.5). Optional so callers/tests that don't supply
   * it simply print/open the plain origin.
   */
  resolveToken?: () => string | undefined;
  /**
   * Non-loopback interface addresses to display for a wildcard bind. Defaults
   * to the machine's own interfaces (`listNetworkAddresses()`); inject a fixed
   * list in tests for deterministic output.
   */
  networkAddresses?: NetworkAddress[];
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Build the Web UI URL, carrying the bearer token in the URL fragment.
 *
 * The token rides in `#token=<token>` — a client-side fragment that is never
 * sent to the server (so it never appears in server access logs) and is not
 * logged by proxies. The Web UI reads it from `location.hash` after load.
 */
export function buildWebUrl(origin: string, token: string): string {
  return buildOpenableUrl(origin, token);
}

/**
 * Build the `web` command, mounting the runner action on `cmd` itself.
 *
 * No option carries a commander default: a seeded default is indistinguishable
 * from a flag the user typed, and it would outrank `[server]` forever. Each
 * boolean that the file could turn on therefore needs its negated counterpart —
 * registered AFTER the positive flag, which is what keeps "not passed" a state
 * commander can express.
 */
export function buildWebCommand(
  cmd: Command,
  opts: { forceRemoteControl?: boolean } = {},
): Command {
  const forceRemoteControl = opts.forceRemoteControl === true;
  const hideRemoteControlHelp = !isRemoteControlEnabled();
  const withServerOptions = cmd
    .option('--port <port>', `Bind port (default ${DEFAULT_SERVER_PORT})`)
    .option(
      '--host [host]',
      `Bind host. Omit to bind ${DEFAULT_SERVER_HOST} (this machine only); pass --host to bind ${DEFAULT_LAN_HOST} (all interfaces), or --host <host> for a specific host. The bearer token is printed at startup.`,
    )
    .option(
      '--allowed-host <host...>',
      'Extra Host header value to allow through the DNS-rebinding check. Repeat or comma-separate; a leading dot matches a domain suffix (e.g. .example.com).',
    )
    .option(
      '--ipv6',
      'Also list the IPv6 interface hints for a wildcard bind. OFF by default; it changes what is printed, never what is bound.',
    )
    .option('--no-ipv6', 'Do not list the IPv6 interface hints (default).')
    // The one security key with no negated counterpart: this flag can only ever
    // turn the refusal off, and `[server] insecure_no_tls = false` is the way to
    // require TLS again.
    .option(
      '--insecure-no-tls',
      'Allow a non-loopback bind without a TLS-terminating reverse proxy. Defaults to true; only relevant for non-loopback binds.',
    )
    .option(
      '--allow-remote-shutdown',
      'On a non-loopback bind, keep POST /api/v1/shutdown enabled (default: route is disabled → 404).',
    )
    .option(
      '--no-allow-remote-shutdown',
      'Disable POST /api/v1/shutdown on a non-loopback bind, overriding [server] allow_remote_shutdown.',
    )
    .option(
      '--dangerous-bypass-auth',
      'Disable bearer-token auth on every REST and WebSocket route, and advertise it via /api/v1/meta so the web UI connects without a token. Only use on a trusted network or behind your own authenticating proxy.',
    )
    .option(
      '--no-dangerous-bypass-auth',
      'Keep bearer-token auth enabled, overriding [server] dangerous_bypass_auth.',
    )
    .option(
      '--enable-kimi-oauth',
      'Enable kimi.com/kimi.ai OAuth device-code login for the web UI and TUI. Disabled by default; token/apiKey auth remains the default.',
    )
    .option(
      '--no-enable-kimi-oauth',
      'Keep kimi.com/kimi.ai OAuth login disabled, overriding [server] enable_kimi_oauth.',
    )
    .option(
      '--log-level <level>',
      `Server log level: ${VALID_LOG_LEVELS.join('|')}. Omit to keep logs off.`,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection. OFF by default; production callers leave this unset.',
    )
    .option(
      '--no-debug-endpoints',
      'Do not mount the /api/v1/debug/* routes, overriding [server] debug_endpoints.',
    )
    .option(
      '--web-title <title>',
      'Set a custom browser tab title for this web UI instance (default: "<workspace dir> | Kimi Code").',
    );
  if (!forceRemoteControl) {
    const remoteControlOffDescription =
      'Do not expose the web UI through Kimi Remote Control, overriding [server] remote_control.';
    withServerOptions
      .addOption(
        new Option(
          '--rc, --remote-control',
          'Expose the web UI through Kimi Remote Control (experimental).',
        ).hideHelp(hideRemoteControlHelp),
      )
      // Both flags are spelled out: a lone `--no-rc` would take its key from
      // the long form and write `rc`, so the value would never reach the runner.
      // `hideHelp` is per-Option, so it is applied to each polarity.
      .addOption(
        new Option(
          '--no-rc, --no-remote-control',
          remoteControlOffDescription,
        ).hideHelp(hideRemoteControlHelp),
      );
  }
  return withServerOptions
    .option('--open', 'Open the web UI in the default browser once the server is ready (default).')
    .option('--no-open', 'Do not open the web UI in the default browser.')
    .addHelpText('after', SERVER_CONFIG_HELP)
    .action(async (opts: ServerCliOptions) => {
      try {
        await handleWebCommand(
          forceRemoteControl ? { ...opts, remoteControl: true } : opts,
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

/**
 * `kimi web` — parse, merge with `[server]`, warn about what the file decided,
 * and run the server. The `[server]` section is read here (once), because the
 * options the runner consumes are decided once too: a `[server]` typo is a hard
 * error, and the action's `catch` turns it into exit 1.
 */
export async function handleWebCommand(
  opts: ServerCliOptions,
  deps: WebCommandDeps = DEFAULT_WEB_COMMAND_DEPS,
): Promise<void> {
  const serverConfig = readServerConfig();
  // The reader hands these over instead of printing them, so this is the only
  // place they get said — printing the reader's own rejection too would
  // report one problem twice.
  for (const warning of serverConfig.warnings) deps.stderr.write(`warning: ${warning}\n`);
  const parsed = parseServerOptions(opts, serverConfig.defaults);
  for (const line of formatConfigProvenanceLines(opts, serverConfig.defaults)) {
    deps.stderr.write(`${line}\n`);
  }
  if (parsed.remoteControl && !isRemoteControlEnabled()) {
    throw new Error(
      `--remote-control is experimental: set ${REMOTE_CONTROL_FLAG_ENV}=1 (or KIMI_CODE_EXPERIMENTAL_FLAG=1) to enable it; ` +
        'the env gate also covers [server] remote_control, which cannot enable it on its own.',
    );
  }
  if (parsed.remoteControl && parsed.dangerousBypassAuth) {
    throw new Error('--remote-control cannot be combined with --dangerous-bypass-auth.');
  }
  if (parsed.remoteControl && !isLoopbackHost(parsed.host)) {
    throw new Error('--remote-control requires a loopback host.');
  }
  const run = deps.startServerForeground ?? startServerForeground;
  let remoteControl: RemoteControlHandle | undefined;
  await run(parsed, {
    onReady: async (origin) => {
      // Resolve the persistent token only once the server is up: a fresh
      // server writes `server.token` on first boot, so reading it beforehand
      // would miss first-time starts and the browser would hit the auth gate.
      // It is printed in the ready banner and rides in the opened Web UI
      // URL's `#token=` fragment (M5.5); falls back to the plain origin / no
      // token line when unavailable. When auth is bypassed, the token is
      // meaningless and is intentionally NOT shown or carried in the URL.
      const token = parsed.dangerousBypassAuth ? undefined : deps.resolveToken?.();
      if (parsed.remoteControl) {
        if (token === undefined) throw new Error('Unable to read the local server token.');
        const dataDir = getDataDir();
        let outputReady = false;
        const pendingStatuses: string[] = [];
        const onStatus = (status: RemoteControlStatus): void => {
          const line = formatRemoteControlStatus(status);
          if (outputReady) deps.stdout.write(line);
          else pendingStatuses.push(line);
        };
        remoteControl = await (deps.startRemoteControl ?? startRemoteControl)({
          homeDir: dataDir,
          localOrigin: origin,
          localServerToken: token,
          stderr: deps.stderr,
          onStatus,
        });
        const qrCode = await generateRemoteControlQr(remoteControl.url, dataDir);
        deps.stdout.write(
          formatRemoteControlOutput({
            url: remoteControl.url,
            localOrigin: origin,
            deviceName: remoteControl.deviceName,
            qrCode: qrCode.terminal,
            pngPath: qrCode.pngPath,
          }),
        );
        outputReady = true;
        for (const line of pendingStatuses) deps.stdout.write(line);
        if (parsed.open) deps.openUrl(remoteControl.url);
        return;
      }
      deps.stdout.write(
        parsed.logLevel === DEFAULT_FOREGROUND_LOG_LEVEL
          ? formatReadyBanner(origin, parsed.host, {
              token,
              networkAddresses: deps.networkAddresses,
              dangerousBypassAuth: parsed.dangerousBypassAuth,
              includeIpv6: parsed.ipv6,
            })
          : formatReadyLine(origin, token, parsed.dangerousBypassAuth),
      );
      if (parsed.open) {
        deps.openUrl(token !== undefined ? buildWebUrl(origin, token) : origin);
      }
    },
    onShutdown: async () => {
      await remoteControl?.close();
    },
  }, undefined, opts);
}

function formatReadyLine(
  origin: string,
  token: string | undefined,
  dangerousBypassAuth = false,
): string {
  const notice = dangerousBypassAuth
    ? `${formatDangerNoticeLines().join('\n')}\n`
    : '';
  return `${notice}Kimi server: ${buildOpenableUrl(origin, token)}\n`;
}

/**
 * Red, impossible-to-miss notice emitted when `--dangerous-bypass-auth`
 * disables the bearer-token gate. Shared by the full ready banner and the
 * compact one-line output so the warning always shows regardless of log level.
 */
function formatDangerNoticeLines(): string[] {
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return [
    `  ${dangerBold('⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).')}`,
    `  ${danger('Anyone who can reach this port gets full access. Only continue if you understand the risk.')}`,
    `  ${danger('If you are unsure, stop this process now with ')}${dangerBold('Ctrl+C')}${danger('.')}`,
  ];
}

/**
 * One red line per security-relevant `[server]` key the file set to `true` and
 * the command line did not. A value the user never typed still widens the
 * server, so it is named with the file it came from — that is the line to find
 * and delete.
 */
function formatConfigProvenanceLines(
  opts: ServerCliOptions,
  defaults: ServerConfigDefaults,
): string[] {
  const configSourced = SECURITY_CONFIG_KEYS.filter(
    ([key]) => opts[key] === undefined && defaults[key] === true,
  ).map(([, tomlKey]) => tomlKey);
  if (configSourced.length === 0) return [];

  // The same resolution `readServerConfig` used, so the notice names the file
  // that was actually read.
  const configPath = resolveConfigPath({ homeDir: resolveKimiHome() });
  const danger = (text: string): string => chalk.hex(darkColors.error)(text);
  const dangerBold = (text: string): string => chalk.bold.hex(darkColors.error)(text);
  return configSourced.map(
    (tomlKey) =>
      `  ${dangerBold('⚠ security setting from config:')} ${danger(
        `[server] ${tomlKey} = true comes from ${configPath}, not from the command line.`,
      )}`,
  );
}

/** The process and stdio a real foreground run reports termination through. */
const DEFAULT_LIFECYCLE_TARGETS: LifecycleTargets = {
  proc: process,
  stdout: process.stdout,
  stderr: process.stderr,
};

/**
 * `kimi web` — runs the local server in-process, attached to the current
 * terminal. It settles only by exiting: the termination handler ends a healthy
 * run with the signal's code, and a failed startup rethrows.
 *
 * `targets` is a test seam for the process and stdio the signal handlers arm
 * on; production callers leave it unset. `cliOptions` is the raw flag bag the
 * options were parsed from, needed to tell a config-file change apart from a
 * flag the user typed (see `restartKeysFor`); callers with no flags — the TUI's
 * `/web` and `/rc` — leave it empty.
 */
export async function startServerForeground(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks = {},
  targets: LifecycleTargets = DEFAULT_LIFECYCLE_TARGETS,
  cliOptions: ServerCliOptions = {},
): Promise<never> {
  return runServerInProcess(options, hooks, targets, cliOptions);
}

/**
 * Start the server in the current process and block until shutdown.
 * `onReady` fires once the server is listening.
 */
async function runServerInProcess(
  options: ParsedServerOptions,
  hooks: StartForegroundHooks,
  targets: LifecycleTargets,
  cliOptions: ServerCliOptions,
): Promise<never> {
  const version = getVersion();
  // Registers the telemetry provider for `track` / `shutdownTelemetry`; the
  // client itself is not passed into kap-server.
  initializeServerTelemetry({ version });

  let running: RoutedServer | undefined;
  // The reason of the first shutdown request, and the guard that keeps a second
  // one from starting a competing teardown. `undefined` while the server runs.
  let stopReason: string | undefined;
  // A SIGHUP can land while `startServer` is still in flight. Rather than
  // report a reload that did not happen, the handler waits for the engine
  // handle: startup either produces one or ends the process, so this cannot
  // outlive the run.
  let resolveRunningServer!: (server: RoutedServer) => void;
  const runningServer = new Promise<RoutedServer>((resolve) => {
    resolveRunningServer = resolve;
  });

  /** Closes the server and flushes what it still owes. Never rethrows. */
  async function closeRunningServer(server: RoutedServer, reason: string): Promise<void> {
    server.logger.info({ reason }, 'server shutting down');
    try {
      await hooks.onShutdown?.(reason);
    } catch (error) {
      server.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'foreground shutdown hook error',
      );
    }
    try {
      await server.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    } catch (error) {
      server.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'server shutdown error',
      );
    }
  }

  async function shutdown(reason: string): Promise<void> {
    if (stopReason !== undefined) return;
    stopReason = reason;
    if (running === undefined) {
      // The signal landed while `startServer` was still in flight: nothing is
      // listening yet, so there is no connection to drain, and neither telemetry
      // flush is reachable on this path — `closeRunningServer`'s never runs and
      // the `onReady` failure path is not in play. Report it, flush by hand, and
      // let the handler exit; the check after `startServer` closes the server if
      // the startup still completes.
      targets.stderr.write(`Startup aborted (${reason})\n`);
      flushTelemetrySync();
      return;
    }
    await closeRunningServer(running, reason);
  }

  /**
   * Ask the running engine to re-read `config.toml`, then work out which of the
   * server's own options would need a restart to take effect.
   *
   * The two halves are separate because they come from separate config systems:
   * the engine owns every section it registers, while `[server]` is read by this
   * CLI before the socket binds and never reaches the engine. So a `[server]`-only
   * edit honestly reports no changed domains and still needs the advisory below.
   */
  async function reload(): Promise<ConfigReloadReport> {
    const server = await runningServer;
    const { changedDomains, error } = await server.reloadConfig();
    if (error !== undefined) {
      return { changedDomains, error, restartKeys: [] };
    }
    // The engine reports `server` as a changed domain because it passes the
    // section through, but it never applies it: `[server]` is read by this CLI
    // before the socket binds. Listing it as "reloaded" would imply the new
    // port or host took effect, which it did not — the restart advisory below
    // is the honest signal, so the passthrough domain is dropped here.
    const appliedDomains = changedDomains.filter((domain) => domain !== SERVER_CONFIG_DOMAIN);
    return {
      changedDomains: appliedDomains,
      error: undefined,
      restartKeys: restartKeysFor(options, cliOptions),
    };
  }

  // Armed before `startServer` so a Ctrl+C during bootstrap is reported and
  // flushed instead of dying by Node's default disposition.
  installServerSignalHandlers({ ...targets, shutdown, reload });

  // kap-server (the DI × Scope engine server) is the only server flavor. Its
  // `startServer` returns `{ host, port, close }` rather than `{ address,
  // logger, close }`, so adapt it to the `RoutedServer` surface the rest of
  // this runner consumes.
  const logger = createServerLogger({ level: options.logLevel });
  const webAssetsDir = serverWebAssetsDir();
  if (webAssetsDir === undefined) {
    logger.info(
      'dev mode: web assets not built; starting the API server without the web UI',
    );
  }
  const v2 = await startServer({
    host: options.host,
    port: options.port,
    // Report the CLI's product version as `server_version` (/meta, web UI)
    // rather than kap-server's private package version.
    serverVersion: version,
    // The CLI's host identity: feeds the engine's bootstrap client identity
    // and the derived outbound headers (User-Agent + X-Msh-*), so web-UI
    // OAuth flows and model / WebSearch requests carry the CLI identity. The
    // `web` User-Agent suffix distinguishes web-UI traffic from direct CLI
    // runs upstream (same product token, same platform).
    hostIdentity: {
      ...createKimiCodeHostIdentity(version),
      userAgentSuffix: WEB_USER_AGENT_SUFFIX,
    },
    logLevel: options.logLevel,
    logger,
    debugEndpoints: options.debugEndpoints,
    insecureNoTls: options.insecureNoTls,
    allowRemoteShutdown: options.allowRemoteShutdown,
    allowedHosts: options.allowedHosts,
    disableAuth: options.dangerousBypassAuth,
    enableKimiOauth: options.enableKimiOauth,
    webTitle: options.webTitle,
    // Attach the engine's cloud telemetry appender (still gated by the config
    // `telemetry` toggle). Complements the v1 client registered above, which
    // only covers host-level events.
    telemetry: true,
    webAssetsDir,
  });
  logger.info('serving the REST/WS API and the bundled web UI');
  running = {
    address: serverOrigin(v2.host, v2.port),
    logger,
    close: () => v2.close(),
    reloadConfig: () => reloadConfig(v2.core),
  };
  resolveRunningServer(running);

  // A signal that arrived during bootstrap had no server to close, so its
  // handler only reported the abort. Close the server that just finished
  // starting instead of serving a port the process is already leaving. Getting
  // here with `stopReason` set proves the abort branch ran: a shutdown that
  // found a server in hand never leaves this stretch of code pending.
  if (stopReason !== undefined) {
    await closeRunningServer(running, stopReason);
    return new Promise<never>(() => {
      // The termination handler exits the process in production; this keeps the
      // runner's `never` contract for a host that stubs the exit out.
    });
  }

  track('server_started', { daemon: false });

  running.logger.info({ address: running.address }, 'server ready');

  try {
    await hooks.onReady?.(running.address);
  } catch (error) {
    try {
      await hooks.onShutdown?.('startup_failed');
    } finally {
      await running.close();
      await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS });
    }
    throw error;
  }

  return new Promise<never>(() => {
    // Keeps the event loop alive; the process ends via a termination signal.
  });
}

/**
 * Resolve the web assets directory passed to kap-server. In dev mode
 * (`KIMI_CODE_DEV_SERVER=1`, set by the repo's `dev:server` / `dev:kap-server*`
 * scripts) a missing `dist-web` build is tolerated: the server starts API-only
 * and the web UI is expected to come from a Vite dev server (the web UI source lives in the code-app repo).
 * Outside dev mode the directory is always returned and kap-server keeps
 * failing fast when the assets are missing.
 */
export function serverWebAssetsDir(
  env: NodeJS.ProcessEnv = process.env,
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string | undefined {
  const dir = resolveServerWebAssetsDir(nativeWebAssetsDir);
  if (env['KIMI_CODE_DEV_SERVER'] === '1' && !existsSync(join(dir, 'index.html'))) {
    return undefined;
  }
  return dir;
}

export function resolveServerWebAssetsDir(
  nativeWebAssetsDir: string | null = getNativeWebAssetsDir(),
): string {
  return nativeWebAssetsDir ?? join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

interface FormatReadyBannerOptions {
  /** Persistent bearer token to print; omitted when unresolvable. */
  token?: string;
  /** Non-loopback interface addresses to list for a wildcard bind. */
  networkAddresses?: NetworkAddress[];
  /** When true, render a red danger notice (auth is disabled). */
  dangerousBypassAuth?: boolean;
  /** List the IPv6 interface hints for a wildcard bind. */
  includeIpv6?: boolean;
}

export function formatReadyBanner(
  origin: string,
  host: string,
  opts: FormatReadyBannerOptions = {},
): string {
  const primary = (text: string): string => chalk.hex(darkColors.primary)(text);
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const url = (text: string): string => chalk.hex(darkColors.accent)(text);
  // Render the `#token=…` fragment in a de-emphasized gray so the host/port
  // stands out while the full URL stays selectable for copying.
  const urlWithDimToken = (href: string): string => {
    const [base, frag] = splitTokenFragment(href);
    return frag === '' ? url(base) : url(base) + dim(frag);
  };

  const port = Number(new URL(origin).port);
  // Borderless header: the Kimi sprite (the little mascot with eyes) sits next
  // to the title, keeping the brand without the enclosing box.
  const logo = ['▐█▛█▛█▌', '▐█████▌'] as const;
  const lines: string[] = [
    '',
    `  ${primary(logo[0])}  ${title('Kimi server ready')}  ${dim(getVersion())}`,
    `  ${primary(logo[1])}  ${dim('Local web UI is available from this machine.')}`,
    '',
  ];

  if (opts.dangerousBypassAuth === true) {
    // Red, impossible-to-miss notice: the bearer-token gate is off, so anyone
    // who can reach this port gets full session / filesystem / shell access.
    lines.push(...formatDangerNoticeLines(), '');
  }

  // Access links.
  for (const { label: text, url: href } of accessUrlLines(
    host,
    port,
    opts.token,
    opts.networkAddresses,
    opts.includeIpv6,
  )) {
    lines.push(`  ${label(text)}${urlWithDimToken(href)}`);
  }
  // On a loopback bind there is no network URL; show how to enable one.
  if (isLoopbackHost(host)) {
    lines.push(`  ${label('Network:  ')}${muted('off')}${dim('  use --host to enable')}`);
  }
  if (opts.token !== undefined) {
    // Set the token off with surrounding whitespace rather than color, so it is
    // easy to spot without being highlighted.
    lines.push('');
    lines.push(`  ${label('Token:    ')}${opts.token}`);
    lines.push('');
  }

  // Auxiliary controls last.
  lines.push(`  ${label('Logs:     ')}${muted('off')}${dim('  use --log-level info to enable')}`);
  // Ctrl+C is the documented stop: the termination handler reports it, bounds
  // the teardown, and exits with the signal's code. The banner text itself stays
  // as short as the terminal width allows.
  lines.push(`  ${label('Stop:     ')}${muted('Ctrl+C')}`);
  lines.push('');
  return lines.join('\n');
}

const DEFAULT_WEB_COMMAND_DEPS: WebCommandDeps = {
  startServerForeground,
  openUrl: defaultOpenUrl,
  resolveToken: () => {
    // Read the persistent `<homeDir>/server.token` written on first boot
    // (M5.1). Best-effort: a missing/older server yields undefined and the
    // caller opens the plain origin.
    return tryResolveServerToken(getDataDir());
  },
  stdout: process.stdout,
  stderr: process.stderr,
};
