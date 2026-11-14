import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TagAgentInputSchema = z.object({
  agent_id: z.string().min(1),
  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(32)
        .refine((tag) => !tag.includes(','), {
          message: 'A tag must not contain a comma.',
        }),
    )
    .max(20),
});

export type TagAgentToolInput = z.infer<typeof TagAgentInputSchema>;

export interface ITagAgentTool extends AgentTool<TagAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const ITagAgentTool = createDecorator<ITagAgentTool>('tagAgentTool');
