import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DismissAgentsInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).optional(),
    names: z.array(z.string().min(1)).min(1).optional(),
    all: z.boolean().optional(),
  })
  .refine(
    (value) =>
      [value.ids !== undefined, value.names !== undefined, value.all === true].filter(Boolean)
        .length === 1,
    { message: 'Provide exactly one of ids, names, or all=true.' },
  );

export type DismissAgentsToolInput = z.infer<typeof DismissAgentsInputSchema>;

export interface IDismissAgentsTool extends AgentTool<DismissAgentsToolInput> {
  readonly _serviceBrand: undefined;
}

export const IDismissAgentsTool = createDecorator<IDismissAgentsTool>('dismissAgentsTool');
