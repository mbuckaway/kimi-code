import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { DEFAULT_BACKGROUND_TIMEOUT_S } from '#/agent/tools/os/bash/bash';

export const WAIT_FOR_ALL_MAX_TIMEOUT_S = DEFAULT_BACKGROUND_TIMEOUT_S;

export const WaitForAllInputSchema = z
  .object({
    timeout: z
      .number()
      .int()
      .positive()
      .max(WAIT_FOR_ALL_MAX_TIMEOUT_S)
      .describe(
        `Maximum time to wait, in seconds (1-${String(WAIT_FOR_ALL_MAX_TIMEOUT_S)}). The deadline is shared by the whole cohort. A timeout is not an error: the tool returns the tasks that are still running, and you can call it again to keep waiting.`,
      ),
    agent_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe('Agent ids whose latest tasks form the cohort to wait for.'),
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Background task IDs that form the cohort to wait for. Omit both lists to wait for every task that is running at call time.',
      ),
  })
  .refine((value) => value.agent_ids === undefined || value.task_ids === undefined, {
    message: 'Provide agent_ids or task_ids, not both.',
  });

export type WaitForAllInput = z.infer<typeof WaitForAllInputSchema>;

export interface IWaitForAllTool extends AgentTool<WaitForAllInput> { readonly _serviceBrand: undefined }
export const IWaitForAllTool = createDecorator<IWaitForAllTool>('waitForAllTool');
