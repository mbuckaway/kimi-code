/**
 * ModelListTool — lists the models configured for this session.
 *
 * Each entry carries the alias, provider, wire model id, display name, and
 * context window, and marks which aliases are the current model, the configured
 * default model, and the configured planning model. An optional `provider`
 * filter narrows the list to one provider.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './model-list.md?raw';

export const ModelListInputSchema = z
  .object({
    provider: z
      .string()
      .optional()
      .describe('Only list models served by this provider.'),
  })
  .strict();
export type ModelListInput = z.infer<typeof ModelListInputSchema>;

export interface ListedModel {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly displayName: string | undefined;
  readonly maxContextSize: number;
  readonly current: boolean;
  readonly default: boolean;
  readonly planning: boolean;
}

export class ModelListTool implements BuiltinTool<ModelListInput> {
  readonly name = 'modellist' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelListInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: ModelListInput): ToolExecution {
    const providerFilter = args.provider;
    return {
      description: 'Listing configured models',
      approvalRule: this.name,
      execute: async () => {
        const models = this.agent.kimiConfig?.models;
        if (models === undefined || Object.keys(models).length === 0) {
          return { isError: true, output: 'No models are configured.' };
        }
        const current = this.agent.config.modelAlias;
        const defaultModel = this.agent.kimiConfig?.defaultModel;
        const planningModel = this.agent.kimiConfig?.planningModel;
        const list: ListedModel[] = [];
        for (const [id, alias] of Object.entries(models)) {
          if (providerFilter !== undefined && alias.provider !== providerFilter) continue;
          list.push({
            id,
            provider: alias.provider,
            model: alias.model,
            displayName: alias.displayName,
            maxContextSize: alias.maxContextSize,
            current: id === current,
            default: id === defaultModel,
            planning: id === planningModel,
          });
        }
        if (list.length === 0) {
          return {
            isError: true,
            output: `No models are configured for provider "${providerFilter}".`,
          };
        }
        return { output: JSON.stringify(list, null, 2) };
      },
    };
  }
}
