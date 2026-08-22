/**
 * Shared model-info resolution for the modelquery / modellist / modelset
 * builtins. A model's canonical fields come from its `[models."<alias>"]`
 * entry; when the agent has no model table (or the alias is missing from it),
 * fall back to the provider resolver.
 */

import type { Agent } from '#/agent';

export interface ModelInfo {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string | undefined;
  readonly maxContextSize: number;
}

export function resolveModelInfo(agent: Agent, id: string): ModelInfo | undefined {
  const alias = agent.kimiConfig?.models?.[id];
  if (alias !== undefined) {
    return {
      id,
      provider: alias.provider,
      model: alias.model,
      displayName: alias.displayName,
      maxContextSize: alias.maxContextSize,
    };
  }
  try {
    const resolved = agent.modelProvider?.resolveProviderConfig(id);
    if (resolved === undefined) return undefined;
    return {
      id,
      provider: resolved.providerName,
      model: resolved.provider.model,
      displayName: undefined,
      maxContextSize: resolved.modelCapabilities.max_context_tokens,
    };
  } catch {
    return undefined;
  }
}
