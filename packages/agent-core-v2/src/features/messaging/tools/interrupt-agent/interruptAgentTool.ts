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
import { ISessionMessagingService } from '#/features/messaging/messaging';

import {
  IInterruptAgentTool,
  InterruptAgentInputSchema,
  type InterruptAgentToolInput,
} from './interrupt-agent';
import INTERRUPT_AGENT_DESCRIPTION from './interrupt-agent.md?raw';

const INTERRUPT_EXPLANATION =
  'A requested interrupt lets the current step finish, including the tools it already called, and then stops the agent.';

export class InterruptAgentTool implements IInterruptAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'InterruptAgent' as const;
  readonly description: string = INTERRUPT_AGENT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(InterruptAgentInputSchema);

  private readonly callerAgentId: string;

  constructor(
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: InterruptAgentToolInput): ToolExecution {
    return {
      description: `Interrupting agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: InterruptAgentToolInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.messaging.interruptAgent(
        this.callerAgentId,
        args.agent_id,
        ctx.signal,
      );
      const summary = formatPlainObject({
        agent_id: result.agentId,
        name: result.label,
        interrupt: result.interrupted ? 'requested' : 'not_running',
      });
      return { output: [summary, '', INTERRUPT_EXPLANATION].join('\n') };
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
