import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ModelSetInputSchema = z
  .object({
    model: z.string().trim().min(1).describe('Model id to set.'),
    role: z
      .enum(['current', 'default', 'planning'])
      .optional()
      .describe(
        'What role to assign the model: "current" switches the running agent model, "default" persists the default model, "planning" configures the model used while plan mode is active. Defaults to "current".',
      ),
  })
  .strict();
export type ModelSetInput = z.infer<typeof ModelSetInputSchema>;

export interface IModelSetTool extends AgentTool<ModelSetInput> {
  readonly _serviceBrand: undefined;
}
export const IModelSetTool = createDecorator<IModelSetTool>('modelSetTool');
