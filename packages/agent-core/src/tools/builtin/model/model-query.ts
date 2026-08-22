/**
 * ModelQueryTool — reports the model currently powering this session.
 *
 * The LLM calls this tool to learn which alias is active, which provider
 * serves it, the wire model id, the display name, and the context window.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { resolveModelInfo } from './model-info';
import DESCRIPTION from './model-query.md?raw';

export const ModelQueryInputSchema = z.object({}).strict();
export type ModelQueryInput = z.infer<typeof ModelQueryInputSchema>;

export class ModelQueryTool implements BuiltinTool<ModelQueryInput> {
  readonly name = 'modelquery' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelQueryInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: ModelQueryInput): ToolExecution {
    return {
      description: 'Reading the current model',
      approvalRule: this.name,
      execute: async () => {
        const alias = this.agent.config.modelAlias;
        if (alias === undefined) {
          return { isError: true, output: 'No model is currently selected.' };
        }
        const info = resolveModelInfo(this.agent, alias);
        if (info === undefined) {
          return {
            isError: true,
            output: `Could not resolve details for the current model "${alias}".`,
          };
        }
        return { output: JSON.stringify(info, null, 2) };
      },
    };
  }
}
