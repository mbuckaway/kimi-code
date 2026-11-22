import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const RenameAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1),
});

export type RenameAgentToolInput = z.infer<typeof RenameAgentInputSchema>;

export interface IRenameAgentTool extends AgentTool<RenameAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const IRenameAgentTool = createDecorator<IRenameAgentTool>('renameAgentTool');
