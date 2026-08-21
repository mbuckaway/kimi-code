import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ModelListInputSchema = z
  .object({
    provider: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Restrict the list to models from a single provider.'),
  })
  .strict();
export type ModelListInput = z.infer<typeof ModelListInputSchema>;

export interface IModelListTool extends AgentTool<ModelListInput> {
  readonly _serviceBrand: undefined;
}
export const IModelListTool = createDecorator<IModelListTool>('modelListTool');
