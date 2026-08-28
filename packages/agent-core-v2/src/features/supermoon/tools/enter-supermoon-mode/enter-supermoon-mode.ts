import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterSupermoonModeInputSchema = z.object({}).strict();
export type EnterSupermoonModeInput = z.infer<typeof EnterSupermoonModeInputSchema>;

export interface IEnterSupermoonModeTool extends AgentTool<EnterSupermoonModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterSupermoonModeTool =
  createDecorator<IEnterSupermoonModeTool>('enterSupermoonModeTool');
