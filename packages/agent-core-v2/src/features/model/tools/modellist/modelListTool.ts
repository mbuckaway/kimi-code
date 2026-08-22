import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { IModelToolsService } from '#/features/model/model';

import DESCRIPTION from './modellist.md?raw';
import { IModelListTool, ModelListInputSchema, type ModelListInput } from './modellist';

export class ModelListTool implements IModelListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'modellist' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelListInputSchema);

  constructor(@IModelToolsService private readonly models: IModelToolsService) {}

  resolveExecution(args: ModelListInput): ToolExecution {
    return {
      description: 'Listing available models',
      approvalRule: this.name,
      execute: async () => {
        const result = await this.models.list(args.provider);
        if (!result.ok) return { isError: true, output: result.error };
        if (result.data.length === 0) return { output: 'No models available.' };
        return {
          output: result.data
            .map((entry) => {
              const markers = [
                entry.isCurrent ? 'current' : undefined,
                entry.isDefault ? 'default' : undefined,
                entry.isPlanning ? 'planning' : undefined,
              ].filter((marker): marker is string => marker !== undefined);
              const suffix = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
              return `${entry.id}${suffix} (${entry.provider}, context ${entry.maxContextSize})`;
            })
            .join('\n'),
        };
      },
    };
  }
}
