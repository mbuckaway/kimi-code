/**
 * The `[server]` config section: defaults for `kimi web` / `kimi rc`.
 *
 * The section is declared in the v1 config schema (mirroring `[acp]`) and read
 * here through the SDK, because the app reaches core capabilities only through
 * `@moonshot-ai/kimi-code-sdk` and the CLI has no `IConfigService` to ask
 * before the server binds.
 *
 * Two rules shape this reader:
 *  - **It declares no built-in values.** Precedence is `CLI flag > [server] >
 *    built-in` and the built-ins live in `parseServerOptions` (`./shared`), so
 *    this returns exactly the keys the file set and an empty object when there
 *    is no section. `open: false` must stay distinguishable from "unset", or no
 *    flag could ever override it.
 *  - **A key this module does not understand is an error, not a warning.** A
 *    silently dropped `prot = 9000` would start the server on the built-in port
 *    while the file read as authoritative. zod's non-strict section strips
 *    unknown keys, so they are recovered as the difference between the raw TOML
 *    document (`config.raw`, pre-transform) and the parsed section — no
 *    hand-maintained key list to drift.
 */

import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  type KimiConfig,
} from '@moonshot-ai/kimi-code-sdk';

import { DEFAULT_LAN_HOST } from './shared';

/** The `[server]` section as the v1 schema types it: thirteen optional keys. */
export type ServerConfigDefaults = NonNullable<KimiConfig['server']>;

/** A `[server]` read: the configured values plus anything the loader warned. */
export interface ServerConfigResult {
  readonly defaults: ServerConfigDefaults;
  readonly warnings: readonly string[];
}

/** Reference page for the valid keys, named instead of enumerated (no drift). */
const SERVER_CONFIG_DOCS_URL =
  'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#server';

/**
 * `[server].host` spellings that mean "bind every interface". Looked up after
 * lower-casing, so `ALL` and `All` count too.
 */
const WILDCARD_HOST_VALUES: ReadonlySet<string> = new Set(['', 'all', '*']);

/**
 * snake_case → camelCase, byte-identical to the v1 loader's rule
 * (`packages/agent-core/src/config/toml.ts`). It is not exported there, and a
 * generic lodash-style camelizer diverges on keys like `port_2`, so the
 * comparison below would name a key the user never typed.
 */
function snakeToCamel(key: string): string {
  return key.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys written under `[server]` that the schema does not declare, compared in
 * the loader's camelCase space so a snake_case key that the loader accepted is
 * never reported.
 */
function unknownServerKeys(
  rawSection: Record<string, unknown>,
  section: ServerConfigDefaults,
): string[] {
  // `Object.hasOwn` rather than `in`: a key like `to_string` camelizes onto
  // `Object.prototype` and would otherwise look known.
  return Object.keys(rawSection).filter((key) => !Object.hasOwn(section, snakeToCamel(key)));
}

/**
 * Rewrites a sentinel `host` to the wildcard bind literal. This is the only
 * sentinel in the config system, so it is resolved here rather than
 * generalized: `parseHost` has no sentinel branch and returns an unknown string
 * verbatim, which would otherwise try to bind a hostname called `all`.
 */
function withResolvedHost(defaults: ServerConfigDefaults): ServerConfigDefaults {
  const host = defaults.host;
  if (host === undefined) return defaults;
  if (WILDCARD_HOST_VALUES.has(host.toLowerCase())) return { ...defaults, host: DEFAULT_LAN_HOST };
  return defaults;
}

/**
 * Read `[server]` from `<KIMI_CODE_HOME>/config.toml`.
 *
 * Never returns partially-validated values: anything the loader could not make
 * sense of is raised to the caller, which prints it and refuses to start.
 *
 * @throws when the section is present but invalid, or contains a key the schema
 *   does not declare.
 */
export function readServerConfig(): ServerConfigResult {
  const configPath = resolveConfigPath({ homeDir: resolveKimiHome() });
  const { config, fileWarnings } = loadRuntimeConfigSafe(configPath);
  const rawSection = config.raw?.['server'];

  // A missing, unreadable, whitespace-only or syntactically broken file leaves
  // `raw` unset, and a file without the section has no `server` key in it: both
  // mean "nothing configured". `fileError` cannot be the gate — it is unset for
  // a file that simply does not exist.
  if (rawSection === undefined) return { defaults: {}, warnings: fileWarnings };

  // Not a table (`server = 5`, `[[server]]`) or dropped by the loader after a
  // failed per-key validation: report what the loader itself said. Naming the
  // keys here would call every valid one unknown.
  if (!isRecord(rawSection) || config.server === undefined) {
    throw new Error(
      `the [server] section in ${configPath} is invalid and was ignored by the config loader: ` +
        `${fileWarnings.join(' ')} Fix that section or remove it; valid keys: ${SERVER_CONFIG_DOCS_URL}`,
    );
  }

  const unknownKeys = unknownServerKeys(rawSection, config.server);
  if (unknownKeys.length > 0) {
    const quoted = unknownKeys.map((key) => `'${snakeToCamel(key)}'`).join(', ');
    const noun = unknownKeys.length === 1 ? 'key' : 'keys';
    throw new Error(
      `unknown ${noun} ${quoted} in [server] of ${configPath}; valid keys: ${SERVER_CONFIG_DOCS_URL}`,
    );
  }

  return { defaults: withResolvedHost(config.server), warnings: fileWarnings };
}

/**
 * `readServerConfig` for callers where a `[server]` typo must not block an
 * unrelated operation — `kimi web rotate-token`, the TUI `/web` and `/rc`
 * commands (whose calls sit outside their `try` blocks), and the SIGHUP
 * re-read.
 *
 * The rejection becomes a stderr warning plus built-in defaults: the warning IS
 * the mitigation, so it is written here rather than returned for the caller to
 * print (a caller that printed both would double-report).
 */
export function tryReadServerConfig(): ServerConfigResult {
  try {
    return readServerConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warning: ${message}\n`);
    return { defaults: {}, warnings: [] };
  }
}
