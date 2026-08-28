import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentSupermoonService } from '#/agent/supermoon/supermoon';

import DESCRIPTION from './exit-supermoon-mode.md?raw';
import {
  ExitSupermoonModeInputSchema,
  IExitSupermoonModeTool,
  type ExitSupermoonModeInput,
} from './exit-supermoon-mode';

export class ExitSupermoonModeTool implements IExitSupermoonModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ExitSupermoonMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ExitSupermoonModeInputSchema);

  constructor(@IAgentSupermoonService private readonly supermoon: IAgentSupermoonService) {}

  resolveExecution(_args: ExitSupermoonModeInput): ToolExecution {
    return {
      description: 'Requesting to exit supermoon mode',
      approvalRule: this.name,
      execute: async () => {
        if (!this.supermoon.isActive) {
          return {
            isError: true,
            output: 'Supermoon mode is not active.',
          };
        }

        this.supermoon.exit();
        return {
          output:
            'Supermoon mode is off. Use Agent or AgentSwarm only when the user asks for multi-agent work or the normal tool rules apply.',
        };
      },
    };
  }
}
