import { IConfigService, type Scope } from '@moonshot-ai/agent-core-v2';

export interface ConfigReloadResult {
  readonly changedDomains: readonly string[];
  readonly error?: string;
}

const RELOAD_SOURCE = 'reload';

export async function reloadConfig(core: Scope): Promise<ConfigReloadResult> {
  const config = core.accessor.get(IConfigService);
  await config.ready;

  const domainsCommittedByReload = new Set<string>();
  const reloadWindow = config.onDidSectionChange((event) => {
    if (event.source !== RELOAD_SOURCE) return;
    domainsCommittedByReload.add(event.domain);
  });

  try {
    await config.reload();
  } finally {
    reloadWindow.dispose();
  }

  const reloadError = config
    .diagnostics()
    .find((diagnostic) => diagnostic.severity === 'error')
    ?.message;

  return {
    changedDomains: [...domainsCommittedByReload].toSorted(),
    error: reloadError,
  };
}
