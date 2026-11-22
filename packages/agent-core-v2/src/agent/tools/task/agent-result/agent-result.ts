import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const AgentResultInputSchema = z.object({
  agent_id: z
    .string()
    .min(1)
    .describe('The agent id whose result to read (from ListAgents or TaskList).'),
});

export type AgentResultInput = z.infer<typeof AgentResultInputSchema>;

export interface IAgentResultTool extends AgentTool<AgentResultInput> { readonly _serviceBrand: undefined }
export const IAgentResultTool = createDecorator<IAgentResultTool>('agentResultTool');
