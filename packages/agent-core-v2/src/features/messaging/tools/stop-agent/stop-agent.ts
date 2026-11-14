import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const StopAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  reason: z.string().optional(),
});

export type StopAgentToolInput = z.infer<typeof StopAgentInputSchema>;

export interface IStopAgentTool extends AgentTool<StopAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const IStopAgentTool = createDecorator<IStopAgentTool>('stopAgentTool');
