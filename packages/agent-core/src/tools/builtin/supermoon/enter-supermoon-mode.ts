/**
 * EnterSupermoonModeTool — supermoon-mode entry tool.
 *
 * Enters supermoon mode through the agent's supermoon mode engine, reporting
 * an error when supermoon mode is already active, and walks the model through
 * the supermoon-mode behavior in the result message. Semantics and wording
 * mirror the v2 engine (agent-core-v2 features/supermoon) for v1/v2 parity.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './enter-supermoon-mode.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const EnterSupermoonModeInputSchema = z.object({}).strict();
export type EnterSupermoonModeInput = z.infer<typeof EnterSupermoonModeInputSchema>;

export class EnterSupermoonModeTool implements BuiltinTool<EnterSupermoonModeInput> {
  readonly name = 'EnterSupermoonMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterSupermoonModeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: EnterSupermoonModeInput): ToolExecution {
    return {
      description: 'Requesting to enter supermoon mode',
      approvalRule: this.name,
      execute: async () => {
        if (this.agent.supermoonMode.isActive) {
          return {
            isError: true,
            output:
              'Supermoon mode is already active. Use ExitSupermoonMode when you want to leave it.',
          };
        }

        this.agent.supermoonMode.enter('tool');
        return { output: supermoonModeMessage() };
      },
    };
  }
}

function supermoonModeMessage(): string {
  return [
    'Supermoon mode is now active.',
    'Orchestrate substantive work with subagents by default (Agent / AgentSwarm), apply thoroughness-first quality patterns, and pin thinking effort to its highest supported level.',
    'ExitSupermoonMode turns supermoon mode off when you no longer need it.',
  ].join('\n\n');
}
