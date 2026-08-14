/**
 * `externalHooks` test helper — build a real `IExternalHooksRunnerService`
 * from a list of hook definitions.
 *
 * The runner is App-scoped in production; in tests we construct it directly
 * (its constructor params are the App services it reads plus the host process
 * service) with stub `IConfigService` / `IPluginService` / `IBootstrapService`
 * and a real `HostProcessService`. This keeps the matching / dedupe /
 * stdin-payload behavior under test identical to production while letting a
 * test feed an arbitrary hook list.
 */

import { Event } from '#/_base/event';
import { ExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunnerService';
import { HOOKS_SECTION } from '#/agent/externalHooks/configSection';
import type { HookDef } from '#/agent/externalHooks/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import type { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

import { stubLog } from '../../_base/log/stubs';

export function makeHookRunner(
  hooks: readonly HookDef[],
  options: {
    cwd?: string;
    onTriggered?: (event: string, target: string, count: number) => void;
    onResolved?: (
      event: string,
      target: string,
      action: string,
      reason: string | undefined,
      durationMs: number,
    ) => void;
    /** Emit when the backing config gains/loses hook sections (mirrors `IConfigService.onDidChangeConfiguration`). */
    onDidChangeConfiguration?: Event<void>;
    /** Override the plugin hook source (e.g. to make a rebuild fail). */
    enabledHooks?: () => Promise<readonly HookDef[]>;
    /** Log sink; defaults to a no-op stub. */
    log?: ILogService;
  } = {},
): ExternalHooksRunnerService {
  return new ExternalHooksRunnerService(
    {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (section: string) => (section === HOOKS_SECTION ? hooks : undefined),
      onDidChangeConfiguration: options.onDidChangeConfiguration ?? Event.None,
    } as unknown as IConfigService,
    {
      _serviceBrand: undefined,
      enabledHooks: options.enabledHooks ?? (async () => []),
      onDidReload: Event.None as IPluginService['onDidReload'],
    } as unknown as IPluginService,
    {
      _serviceBrand: undefined,
      cwd: options.cwd ?? '',
      clientIdentity: { productName: 'test', version: '0.0.0-test', platform: 'test_platform' },
    } as unknown as IBootstrapService,
    new HostProcessService(),
    options.log ?? stubLog(),
    { onTriggered: options.onTriggered, onResolved: options.onResolved },
  );
}
