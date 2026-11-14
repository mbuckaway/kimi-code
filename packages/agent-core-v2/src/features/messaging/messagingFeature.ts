import type { ServicesAccessor } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation } from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentResultTool } from '#/agent/tools/task/agent-result/agent-result';
import { AgentResultTool } from '#/agent/tools/task/agent-result/agentResultTool';
import { IAgentHealthTool } from '#/agent/tools/task/agent-status/agent-status';
import { AgentHealthTool } from '#/agent/tools/task/agent-status/agentStatusTool';
import { IWaitForAllTool } from '#/agent/tools/task/task-wait-all/wait-for-all';
import { WaitForAllTool } from '#/agent/tools/task/task-wait-all/waitForAllTool';
import { IStopAgentsTool } from '#/agent/tools/task/task-stop-agents/task-stop-agents';
import { StopAgentsTool } from '#/agent/tools/task/task-stop-agents/taskStopAgentsTool';

import { AGENT_FLEET_CONTROL_FLAG_ID, AGENT_MESSAGING_FLAG_ID } from './flag';
import { ISessionMessagingService } from './messaging';
import { SessionMessagingService } from './sessionMessagingService';
import { messagingAgentRuntimeProvider } from './messagingAgentRuntime';
import { IBroadcastMessageTool } from './tools/broadcast-message/broadcast-message';
import { BroadcastMessageTool } from './tools/broadcast-message/broadcastMessageTool';
import { IDismissAgentsTool } from './tools/dismiss-agent/dismiss-agent';
import { DismissAgentsTool } from './tools/dismiss-agent/dismissAgentsTool';
import { IInterruptAgentTool } from './tools/interrupt-agent/interrupt-agent';
import { InterruptAgentTool } from './tools/interrupt-agent/interruptAgentTool';
import { IListAgentsTool } from './tools/list-agents/list-agents';
import { ListAgentsTool } from './tools/list-agents/listAgentsTool';
import { IListMessagesTool } from './tools/list-messages/list-messages';
import { ListMessagesTool } from './tools/list-messages/listMessagesTool';
import { IRenameAgentTool } from './tools/rename-agent/rename-agent';
import { RenameAgentTool } from './tools/rename-agent/renameAgentTool';
import { IReplyMessageTool } from './tools/reply-message/reply-message';
import { ReplyMessageTool } from './tools/reply-message/replyMessageTool';
import { ISendMessageTool } from './tools/send-message/send-message';
import { SendMessageTool } from './tools/send-message/sendMessageTool';
import { IStopAgentTool } from './tools/stop-agent/stop-agent';
import { StopAgentTool } from './tools/stop-agent/stopAgentTool';
import { ITagAgentTool } from './tools/tag-agent/tag-agent';
import { TagAgentTool } from './tools/tag-agent/tagAgentTool';

function messagingEnabled(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(AGENT_MESSAGING_FLAG_ID);
}

function fleetControlEnabled(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(AGENT_FLEET_CONTROL_FLAG_ID);
}

export class MessagingFeature extends Feature {
  static override readonly name = 'messaging';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, ISessionMessagingService, SessionMessagingService, {
      activation: ScopeActivation.OnScopeCreated,
    });
    this.contributeAgentRuntime(messagingAgentRuntimeProvider);
    this.contributeTool(ISendMessageTool, SendMessageTool, {
      name: 'SendMessage',
      domain: 'messaging',
      when: messagingEnabled,
    });
    this.contributeTool(IListAgentsTool, ListAgentsTool, {
      name: 'ListAgents',
      domain: 'messaging',
      when: messagingEnabled,
    });
    this.contributeTool(IListMessagesTool, ListMessagesTool, {
      name: 'ListMessages',
      domain: 'messaging',
      when: messagingEnabled,
    });
    this.contributeTool(IReplyMessageTool, ReplyMessageTool, {
      name: 'ReplyMessage',
      domain: 'messaging',
      when: messagingEnabled,
    });
    this.contributeTool(IBroadcastMessageTool, BroadcastMessageTool, {
      name: 'BroadcastMessage',
      domain: 'messaging',
      when: messagingEnabled,
    });
    this.contributeTool(IAgentResultTool, AgentResultTool, {
      name: 'AgentResult',
      domain: 'agentTask',
      when: messagingEnabled,
    });
    this.contributeTool(IAgentHealthTool, AgentHealthTool, {
      name: 'AgentHealth',
      domain: 'agentTask',
      when: messagingEnabled,
    });
    this.contributeTool(IWaitForAllTool, WaitForAllTool, {
      name: 'WaitForAll',
      domain: 'agentTask',
      when: messagingEnabled,
    });
    this.contributeTool(IStopAgentTool, StopAgentTool, {
      name: 'StopAgent',
      domain: 'messaging',
      when: fleetControlEnabled,
    });
    this.contributeTool(IInterruptAgentTool, InterruptAgentTool, {
      name: 'InterruptAgent',
      domain: 'messaging',
      when: fleetControlEnabled,
    });
    this.contributeTool(IDismissAgentsTool, DismissAgentsTool, {
      name: 'DismissAgents',
      domain: 'messaging',
      when: fleetControlEnabled,
    });
    this.contributeTool(ITagAgentTool, TagAgentTool, {
      name: 'TagAgent',
      domain: 'messaging',
      when: fleetControlEnabled,
    });
    this.contributeTool(IRenameAgentTool, RenameAgentTool, {
      name: 'RenameAgent',
      domain: 'messaging',
      when: fleetControlEnabled,
    });
    this.contributeTool(IStopAgentsTool, StopAgentsTool, {
      name: 'StopAgents',
      domain: 'agentTask',
      when: fleetControlEnabled,
    });
  }
}

registerFeature(MessagingFeature);
