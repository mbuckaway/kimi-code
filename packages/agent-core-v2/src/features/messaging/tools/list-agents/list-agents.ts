import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const ListAgentsToolInputSchema = z.object({}).strict();

export type ListAgentsToolInput = z.infer<typeof ListAgentsToolInputSchema>;

export interface IListAgentsTool extends AgentTool<ListAgentsToolInput> {
  readonly _serviceBrand: undefined;
}

export const IListAgentsTool = createDecorator<IListAgentsTool>('listAgentsTool');
