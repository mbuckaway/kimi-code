/**
 * ExitSupermoonModeTool — supermoon-mode exit tool.
 *
 * Exits supermoon mode through the agent's supermoon mode engine, reporting
 * an error when supermoon mode is already inactive. Semantics and wording
 * mirror the v2 engine (agent-core-v2 features/supermoon) for v1/v2 parity.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './exit-supermoon-mode.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const ExitSupermoonModeInputSchema = z.object({}).strict();
export type ExitSupermoonModeInput = z.infer<typeof ExitSupermoonModeInputSchema>;

export class ExitSupermoonModeTool implements BuiltinTool<ExitSupermoonModeInput> {
  readonly name = 'ExitSupermoonMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitSupermoonModeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: ExitSupermoonModeInput): ToolExecution {
    return {
      description: 'Requesting to exit supermoon mode',
      approvalRule: this.name,
      execute: async () => {
        if (!this.agent.supermoonMode.isActive) {
          return {
            isError: true,
            output: 'Supermoon mode is not active.',
          };
        }

        this.agent.supermoonMode.exit();
        return {
          output:
            'Supermoon mode is off. Use Agent or AgentSwarm only when the user asks for multi-agent work or the normal tool rules apply.',
        };
      },
    };
  }
}
