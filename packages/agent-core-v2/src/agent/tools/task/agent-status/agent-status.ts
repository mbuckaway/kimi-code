import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const AgentHealthInputSchema = z.object({
  agent_id: z.string().min(1).describe('The agent id to inspect (from ListAgents).'),
});

export type AgentHealthInput = z.infer<typeof AgentHealthInputSchema>;

export interface IAgentHealthTool extends AgentTool<AgentHealthInput> { readonly _serviceBrand: undefined }
export const IAgentHealthTool = createDecorator<IAgentHealthTool>('agentHealthTool');
