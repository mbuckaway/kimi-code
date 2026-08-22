/**
 * ModelSetTool — switches the active model for this session.
 *
 * The switch is guarded by the context window (see `switch-guard.ts`): a
 * target model whose window is smaller than the current model's window is
 * rejected because the existing conversation may not fit. The change applies
 * from the next turn.
 *
 * Persisting a `default` / `planning` role is intentionally unsupported here:
 * the legacy engine has no config-write path reachable from a tool (writing
 * config.toml is core-level `setKimiConfig`, not on `Agent`), so those roles
 * return a clear error instead of pretending to persist.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { resolveModelInfo } from './model-info';
import { canSwitchModel } from './switch-guard';
import DESCRIPTION from './model-set.md?raw';

export interface ModelSetInput {
  readonly model: string;
  readonly role?: 'current' | 'default' | 'planning' | undefined;
}

export const ModelSetInputSchema: z.ZodType<ModelSetInput> = z
  .object({
    model: z.string().min(1).describe('The model alias to select.'),
    role: z
      .enum(['current', 'default', 'planning'])
      .default('current')
      .describe(
        'What the selection should change: the active model (current), or persist it as the default / planning model.',
      ),
  })
  .strict();

export class ModelSetTool implements BuiltinTool<ModelSetInput> {
  readonly name = 'modelset' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelSetInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: ModelSetInput): ToolExecution {
    return {
      description: `Setting the active model to "${args.model}"`,
      approvalRule: this.name,
      execute: async () => this.execution(args),
    };
  }

  private execution(args: ModelSetInput): ExecutableToolResult {
    if (args.role === 'default' || args.role === 'planning') {
      return {
        isError: true,
        output:
          'Persisting the default/planning model is not supported in the legacy engine; use /model or the web settings.',
      };
    }
    return this.switchCurrentModel(args.model);
  }

  private switchCurrentModel(model: string): ExecutableToolResult {
    let targetMax: number;
    try {
      targetMax =
        this.agent.modelProvider?.resolveProviderConfig(model)?.modelCapabilities
          .max_context_tokens ?? 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, output: `Cannot switch model: ${message}` };
    }

    const currentMax = this.agent.config.modelCapabilities.max_context_tokens;
    if (!canSwitchModel(targetMax, currentMax)) {
      return {
        isError: true,
        output:
          currentMax <= 0
            ? `Cannot switch to model "${model}": the current model's context window is unknown, so the switch cannot be verified as safe.`
            : `Cannot switch to model "${model}": its context window (${targetMax} tokens) is smaller than the current model's window (${currentMax} tokens). Switching would risk dropping part of the current conversation.`,
      };
    }

    this.agent.config.update({ modelAlias: model });
    const info = resolveModelInfo(this.agent, model);
    const detail = info === undefined ? '' : `\n${JSON.stringify(info, null, 2)}`;
    return { output: `Switched the current model to "${model}".${detail}` };
  }
}
