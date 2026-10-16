/**
 * Shared helpers for `kimi web` and its subcommands.
 *
 * Owns the default host/port, option parsers, and health/readiness probes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerLogLevel } from '@moonshot-ai/kap-server';

import { bracketIpv6Host } from './networks';

// Type-only on purpose: this module is the parser every `kimi web` caller uses,
// so it must not pull in `server-config.ts`, which is the module that reads the
// file through the SDK. `parseServerOptions` is the single place where
// `CLI flag > [server] > built-in` is decided, and it declares every built-in
// because the reader returns only the keys the file actually set.
import type { ServerConfigDefaults } from './server-config';

export const LOCAL_SERVER_HOST = '127.0.0.1';
export const DEFAULT_LAN_HOST = '0.0.0.0';
export const DEFAULT_SERVER_HOST = LOCAL_SERVER_HOST;
export const DEFAULT_SERVER_PORT = 58627;
export const DEFAULT_SERVER_ORIGIN = serverOrigin(DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT);

/** Filename (under KIMI_CODE_HOME) of the persistent server bearer token. */
export const SERVER_TOKEN_FILE = 'server.token';

export const DEFAULT_LOG_LEVEL: ServerLogLevel = 'info';
export const DEFAULT_FOREGROUND_LOG_LEVEL: ServerLogLevel = 'silent';

export const VALID_LOG_LEVELS: readonly ServerLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export interface ParsedServerOptions {
  host: string;
  port: number;
  logLevel: ServerLogLevel;
  debugEndpoints: boolean;
  /** Allow a non-loopback bind without a TLS-terminating reverse proxy. */
  insecureNoTls: boolean;
  /** Allow `POST /api/v1/shutdown` on a non-loopback bind. */
  allowRemoteShutdown: boolean;
  /** Disable bearer-token auth on every route (`--dangerous-bypass-auth`). */
  dangerousBypassAuth: boolean;
  /** Enable kimi.com/kimi.ai OAuth login (`--enable-kimi-oauth`). */
  enableKimiOauth: boolean;
  /** Extra `Host` header values to allow through the DNS-rebinding check. */
  allowedHosts: readonly string[];
  /** Custom browser tab title for this web UI instance (`--web-title`). */
  webTitle?: string;
  /** Open the web UI in the default browser once the server is ready. */
  open: boolean;
  /** Print the IPv6 interface hints for a wildcard bind. */
  ipv6: boolean;
  /**
   * Expose the web UI through Kimi Remote Control. Resolved here rather than at
   * the call sites because `--rc` is read at four of them: reading it raw would
   * make `[server] remote_control = true` a silent no-op that also skips the
   * experimental-flag, bypass-auth and loopback guards.
   */
  remoteControl: boolean;
}

/**
 * The parsed `kimi web` / `kimi rc` option bag. `open`, `remoteControl` and
 * `ipv6` live here (and not on the command's own type) because this is where
 * their config defaults are resolved — declaring them twice would let one of
 * the two shadow the other.
 */
export interface ServerCliOptions {
  host?: string | boolean;
  port?: string;
  logLevel?: string;
  debugEndpoints?: boolean;
  /** Allow a non-loopback bind without TLS (`--insecure-no-tls`). */
  insecureNoTls?: boolean;
  /** Allow remote shutdown on a non-loopback bind (`--allow-remote-shutdown`). */
  allowRemoteShutdown?: boolean;
  /** Disable bearer-token auth on every route (`--dangerous-bypass-auth`). */
  dangerousBypassAuth?: boolean;
  /** Enable kimi.com/kimi.ai OAuth login (`--enable-kimi-oauth`). */
  enableKimiOauth?: boolean;
  /** Extra `Host` header values to allow (`--allowed-host`). */
  allowedHost?: string[];
  /** Custom browser tab title for this web UI instance (`--web-title`). */
  webTitle?: string;
  /** Open the browser (`--open` / `--no-open`). */
  open?: boolean;
  /** Expose the web UI through Kimi Remote Control (`--rc` / `--no-rc`). */
  remoteControl?: boolean;
  /** Print the IPv6 interface hints (`--ipv6` / `--no-ipv6`). */
  ipv6?: boolean;
}

/**
 * Resolve every server option as `CLI flag > [server] key > built-in default`.
 *
 * The built-ins are declared here — not in the config reader — because that is
 * where the precedence is visible, and a commander default would look like a
 * flag the user actually typed and outrank the file forever.
 *
 * @param config the `[server]` section as read by `readServerConfig`, which
 *   returns only the keys the file actually set, as written, and has validated
 *   `port` against the schema.
 */
export function parseServerOptions(
  opts: ServerCliOptions,
  config: ServerConfigDefaults = {},
): ParsedServerOptions {
  const logLevel = opts.logLevel ?? config.logLevel ?? DEFAULT_FOREGROUND_LOG_LEVEL;
  return {
    host: parseHost(opts.host ?? config.host),
    port: parsePort(
      opts.port ?? config.port,
      opts.port === undefined ? '[server].port' : '--port',
      DEFAULT_SERVER_PORT,
    ),
    // A rejected value names the source that supplied it: `log_level` is a plain
    // string in the schema, so `[server] log_level = "shout"` lands here.
    logLevel: parseLogLevel(
      logLevel,
      opts.logLevel === undefined ? '[server].log_level' : '--log-level',
    ),
    debugEndpoints: opts.debugEndpoints ?? config.debugEndpoints ?? false,
    insecureNoTls: opts.insecureNoTls ?? config.insecureNoTls ?? true,
    allowRemoteShutdown: opts.allowRemoteShutdown ?? config.allowRemoteShutdown ?? false,
    dangerousBypassAuth: opts.dangerousBypassAuth ?? config.dangerousBypassAuth ?? false,
    enableKimiOauth: opts.enableKimiOauth ?? config.enableKimiOauth ?? false,
    allowedHosts: parseAllowedHostArgs(opts.allowedHost ?? config.allowedHost),
    webTitle: opts.webTitle ?? config.webTitle,
    // `open` defaults to true: it is the behavior `kimi web` promises by name,
    // and `[server] open = false` is what turns it off.
    open: opts.open ?? config.open ?? true,
    ipv6: opts.ipv6 ?? config.ipv6 ?? false,
    remoteControl: opts.remoteControl ?? config.remoteControl ?? false,
  };
}

export function parseAllowedHostArgs(raw: readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * `--host` / `[server] host` spellings that mean "bind every interface". Looked
 * up after lower-casing, so `ALL` and `All` count too. This is the one place the
 * sentinels resolve, so the flag and the file cannot disagree about `all`; `''`
 * is what `--host=` with an empty value reaches the parser as.
 */
const WILDCARD_HOST_VALUES: ReadonlySet<string> = new Set(['', 'all', '*']);

function parseHost(raw: string | boolean | undefined): string {
  if (raw === undefined || raw === false) return DEFAULT_SERVER_HOST;
  if (raw === true) return DEFAULT_LAN_HOST;
  return WILDCARD_HOST_VALUES.has(raw.toLowerCase()) ? DEFAULT_LAN_HOST : raw;
}

/**
 * Parse a port from either source: the CLI hands a raw string, `[server].port`
 * arrives as a number. `label` names whichever one supplied the value.
 */
export function parsePort(
  raw: string | number | undefined,
  label: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`error: invalid ${label} value: ${raw}`);
  }
  return n;
}

export function parseLogLevel(raw: string | undefined, label: string): ServerLogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as ServerLogLevel;
  }
  throw new Error(
    `error: invalid ${label} value: ${raw} (allowed: ${VALID_LOG_LEVELS.join(', ')})`,
  );
}

/**
 * The one producer of a server origin. Every URL the CLI prints or opens is
 * built here, so an IPv6 bind cannot reach a consumer unbracketed.
 */
export function serverOrigin(host: string, port: number): string {
  return `http://${bracketIpv6Host(host)}:${port}`;
}

/** Strip `/api/v1` and trailing slashes so user-supplied origins are uniform. */
export function normalizeServerOrigin(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Read the persistent bearer token for the server.
 *
 * The server writes `<homeDir>/server.token` (0600) on first boot and reuses
 * it across restarts (ROADMAP M5.1); CLI commands that hit a gated REST route
 * read it back here and send it as `Authorization: Bearer <token>`. `homeDir`
 * is the CLI's own KIMI_CODE_HOME resolution (`getDataDir()`).
 *
 * Throws a clear error when the file is missing/unreadable — the usual cause
 * is a server that has never been started (no token file yet), or an older
 * build that predates token auth.
 */
export function resolveServerToken(homeDir: string): string {
  const tokenPath = join(homeDir, SERVER_TOKEN_FILE);
  try {
    return readFileSync(tokenPath, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `unable to read server token at ${tokenPath}; has the server been started at least once?`,
      { cause: error },
    );
  }
}

/** Best-effort token read: returns `undefined` instead of throwing. */
export function tryResolveServerToken(homeDir: string): string | undefined {
  try {
    return resolveServerToken(homeDir);
  } catch {
    return undefined;
  }
}

/** An `Authorization: Bearer <token>` header bag for `fetch`. */
export function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
