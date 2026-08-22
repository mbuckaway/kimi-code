import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { IModelToolsService } from '#/features/model/model';

import DESCRIPTION from './modelquery.md?raw';
import { IModelQueryTool, ModelQueryInputSchema, type ModelQueryInput } from './modelquery';

export class ModelQueryTool implements IModelQueryTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'modelquery' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelQueryInputSchema);

  constructor(@IModelToolsService private readonly models: IModelToolsService) {}

  resolveExecution(_args: ModelQueryInput): ToolExecution {
    return {
      description: 'Querying the current model',
      approvalRule: this.name,
      execute: async () => {
        const result = await this.models.getCurrent();
        if (!result.ok) return { isError: true, output: result.error };
        const data = result.data;
        return {
          output: [
            `Current model: ${data.id}`,
            `Role: ${data.role}`,
            `Provider: ${data.provider}`,
            `Model: ${data.model}`,
            `Display name: ${data.displayName ?? data.model}`,
            `Max context size: ${data.maxContextSize}`,
          ].join('\n'),
        };
      },
    };
  }
}
