import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ModelQueryInputSchema = z.object({}).strict();
export type ModelQueryInput = z.infer<typeof ModelQueryInputSchema>;

export interface IModelQueryTool extends AgentTool<ModelQueryInput> {
  readonly _serviceBrand: undefined;
}
export const IModelQueryTool = createDecorator<IModelQueryTool>('modelQueryTool');
