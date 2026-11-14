import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';

import { IAgentTaskService } from '#/agent/task/task';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { deriveAgentHealth, formatBackgroundCapacity } from '#/agent/task/agentHealth';
import { formatPlainObject } from '#/agent/task/tools/format';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { inputTotal } from '#/kosong/contract/usage';
import { IFlagService } from '#/app/flag/flag';
import { AGENT_MESSAGING_FLAG_ID } from '#/features/messaging/flag';
import { IAgentHealthTool, AgentHealthInputSchema, type AgentHealthInput } from './agent-status';
import AGENT_HEALTH_DESCRIPTION from './agent-status.md?raw';

export class AgentHealthTool implements IAgentHealthTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentHealth' as const;
  readonly description: string = AGENT_HEALTH_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(AgentHealthInputSchema);

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  resolveExecution(args: AgentHealthInput): ToolExecution {
    return {
      description: `Inspecting health of agent ${args.agent_id}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.agent_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: AgentHealthInput): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(AGENT_MESSAGING_FLAG_ID)) {
      return {
        isError: true,
        output: 'AgentHealth is disabled: the agent_messaging experimental flag is off.',
      };
    }

    const task = agentTaskFor(this.tasks.list(false), args.agent_id);
    const handle = this.agents.handleOf(args.agent_id);
    if (task === undefined && handle === undefined) {
      return { isError: true, output: `Agent not found: ${args.agent_id}` };
    }

    const loopState =
      handle === undefined
        ? undefined
        : handle.accessor.get(IAgentLoopService).status().state;
    const activity =
      handle === undefined ? undefined : handle.accessor.get(IAgentActivityView).state();

    let contextTokens: number | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    if (handle !== undefined) {
      const context = agentContextOf(handle);
      const usageStatus = this.usage.status(context);
      contextTokens = this.tokenCounting.statusSize(context);
      totalInputTokens = usageStatus.total === undefined ? undefined : inputTotal(usageStatus.total);
      totalOutputTokens = usageStatus.total?.output;
    }

    const activeTools = activity?.turn?.activeToolCalls.map((call) => call.name).join(', ');

    return {
      output: formatPlainObject({
        agentId: args.agent_id,
        state: deriveAgentHealth({ hasHandle: handle !== undefined, loopState, task }),
        loopState,
        taskId: task?.taskId,
        taskStatus: task?.status,
        taskKind: task?.kind,
        taskStartedAt: task?.startedAt,
        taskEndedAt: task?.endedAt,
        turnPhase: activity?.turn?.phase,
        turnStep: activity?.turn?.step,
        activeTools: activeTools === '' ? undefined : activeTools,
        pendingApprovals: activity?.turn?.pendingApprovals.length,
        lastTurnReason: activity?.lastTurn?.reason,
        contextTokens,
        totalInputTokens,
        totalOutputTokens,
        backgroundCapacity: formatBackgroundCapacity(this.tasks.capacity()),
      }),
      isError: false,
    };
  }
}
