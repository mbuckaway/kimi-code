import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { IModelToolsService } from '#/features/model/model';

import DESCRIPTION from './modelset.md?raw';
import { IModelSetTool, ModelSetInputSchema, type ModelSetInput } from './modelset';

export class ModelSetTool implements IModelSetTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'modelset' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ModelSetInputSchema);

  constructor(@IModelToolsService private readonly models: IModelToolsService) {}

  resolveExecution(args: ModelSetInput): ToolExecution {
    return {
      description: 'Setting the model',
      approvalRule: this.name,
      execute: async () => {
        const role = args.role ?? 'current';
        const result = await this.models.set(args.model, role);
        if (!result.ok) return { isError: true, output: result.error };
        return { output: `Model set: ${args.model} as ${role}.` };
      },
    };
  }
}
