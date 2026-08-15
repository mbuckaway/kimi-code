/**
 * `supermoon` domain — `IEnterSupermoonModeTool` implementation.
 *
 * Enters supermoon mode through the supermoon service (`supermoon`), reporting
 * an error when supermoon mode is already active, and walks the model through
 * the supermoon-mode behavior in the result message. Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentSupermoonService } from '#/agent/supermoon/supermoon';

import DESCRIPTION from './enter-supermoon-mode.md?raw';
import {
  EnterSupermoonModeInputSchema,
  IEnterSupermoonModeTool,
  type EnterSupermoonModeInput,
} from './enter-supermoon-mode';

export class EnterSupermoonModeTool implements IEnterSupermoonModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterSupermoonMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterSupermoonModeInputSchema);

  constructor(@IAgentSupermoonService private readonly supermoon: IAgentSupermoonService) {}

  resolveExecution(_args: EnterSupermoonModeInput): ToolExecution {
    return {
      description: 'Requesting to enter supermoon mode',
      approvalRule: this.name,
      execute: async () => {
        if (this.supermoon.isActive) {
          return {
            isError: true,
            output:
              'Supermoon mode is already active. Use ExitSupermoonMode when you want to leave it.',
          };
        }

        this.supermoon.enter('tool');
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
