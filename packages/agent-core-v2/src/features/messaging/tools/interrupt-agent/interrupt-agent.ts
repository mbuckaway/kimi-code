import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const InterruptAgentInputSchema = z.object({
  agent_id: z.string().min(1),
});

export type InterruptAgentToolInput = z.infer<typeof InterruptAgentInputSchema>;

export interface IInterruptAgentTool extends AgentTool<InterruptAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const IInterruptAgentTool = createDecorator<IInterruptAgentTool>('interruptAgentTool');
