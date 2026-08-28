import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ExitSupermoonModeInputSchema = z.object({}).strict();
export type ExitSupermoonModeInput = z.infer<typeof ExitSupermoonModeInputSchema>;

export interface IExitSupermoonModeTool extends AgentTool<ExitSupermoonModeInput> {
  readonly _serviceBrand: undefined;
}
export const IExitSupermoonModeTool =
  createDecorator<IExitSupermoonModeTool>('exitSupermoonModeTool');
