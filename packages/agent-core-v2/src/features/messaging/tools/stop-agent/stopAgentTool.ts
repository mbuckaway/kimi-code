import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

import { formatPlainObject } from '#/agent/task/tools/format';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_FLEET_CONTROL_FLAG_ID } from '#/features/messaging/flag';
import { ISessionMessagingService } from '#/features/messaging/messaging';

import { IStopAgentTool, StopAgentInputSchema, type StopAgentToolInput } from './stop-agent';
import STOP_AGENT_DESCRIPTION from './stop-agent.md?raw';

export class StopAgentTool implements IStopAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'StopAgent' as const;
  readonly description: string = STOP_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(StopAgentInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IFlagService private readonly flags: IFlagService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: StopAgentToolInput): ToolExecution {
    return {
      description: `Stopping agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: StopAgentToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(AGENT_FLEET_CONTROL_FLAG_ID)) {
      return {
        isError: true,
        output: 'StopAgent is disabled: the agent_fleet_control experimental flag is off.',
      };
    }
    try {
      const result = await this.messaging.stopAgent(
        this.callerAgentId,
        args.agent_id,
        args.reason,
        ctx.signal,
      );
      const summary = formatPlainObject({
        agent_id: result.agentId,
        name: result.label,
        status: result.stopped ? 'stopped' : 'already_idle',
        pending_turns: result.pendingTurnIds.length,
      });
      return {
        output: [
          summary,
          '',
          'Send it a message to resume it; stopping does not detach its name.',
        ].join('\n'),
      };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
