import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const StopAgentsInputSchema = z
  .object({
    agent_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Agent ids whose latest tasks to stop.'),
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Background task ids to stop.'),
    all: z
      .boolean()
      .optional()
      .describe('Stop every running background task selected by include_foreground.'),
    include_foreground: z
      .boolean()
      .optional()
      .describe('Also stop foreground tasks. Defaults to false.'),
    reason: z.string().optional().describe('Short reason recorded when each task is stopped.'),
  })
  .refine(
    (value) =>
      [value.agent_ids !== undefined, value.task_ids !== undefined, value.all === true].filter(
        Boolean,
      ).length === 1,
    { message: 'Provide exactly one of agent_ids, task_ids, or all=true.' },
  );

export type StopAgentsInput = z.infer<typeof StopAgentsInputSchema>;

export interface IStopAgentsTool extends AgentTool<StopAgentsInput> {
  readonly _serviceBrand: undefined;
}
export const IStopAgentsTool = createDecorator<IStopAgentsTool>('stopAgentsTool');
