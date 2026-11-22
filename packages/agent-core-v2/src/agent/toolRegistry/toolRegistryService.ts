import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  ExecutableTool,
  ToolDisclosure,
  ToolInfo,
  ToolSource,
} from '#/tool/toolContract';
import {
  IAgentToolRegistryService,
  type ToolReference,
  type ToolRegistrationOptions,
} from './toolRegistry';

import './builtinToolAssemblyService';

interface ToolEntry {
  readonly tool: ExecutableTool;
  readonly source: ToolSource;
  readonly disclosure?: ToolDisclosure;
}

export class AgentToolRegistryService implements IAgentToolRegistryService {
  declare readonly _serviceBrand: undefined;
  private readonly tools = new Map<string, ToolEntry>();
  private currentRevision = 0;
  private cachedEntries: readonly ToolEntry[] | undefined;

  get revision(): number {
    return this.currentRevision;
  }

  register(tool: ExecutableTool, options: ToolRegistrationOptions = {}): IDisposable {
    const source = options.source ?? 'builtin';
    const entry: ToolEntry = { tool, source, disclosure: options.disclosure };
    this.tools.delete(tool.name);
    this.tools.set(tool.name, entry);
    this.invalidate();

    return toDisposable(() => {
      const current = this.tools.get(tool.name);
      if (current !== entry) return;
      this.unregisterTool(tool.name);
    });
  }

  list(): readonly ToolInfo[] {
    return this.entries().map(({ tool, source, disclosure }) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      source,
      disclosure,
    }));
  }

  listReferences(): readonly ToolReference[] {
    return this.entries().map(({ tool, source }) => ({ name: tool.name, source }));
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.tools.get(name)?.tool;
  }

  private entries(): readonly ToolEntry[] {
    this.cachedEntries ??= [...this.tools.values()].toSorted((a, b) =>
      a.tool.name.localeCompare(b.tool.name),
    );
    return this.cachedEntries;
  }

  private invalidate(): void {
    this.currentRevision += 1;
    this.cachedEntries = undefined;
  }

  private unregisterTool(name: string): void {
    if (!this.tools.has(name)) return;
    this.tools.delete(name);
    this.invalidate();
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolRegistryService,
  AgentToolRegistryService,
  ScopeActivation.OnScopeCreated,
  'toolRegistry',
);
