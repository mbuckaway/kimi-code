import type { ServicesAccessor } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation } from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AGENT_MESSAGING_FLAG_ID } from './flag';
import { ISessionMessagingService } from './messaging';
import { SessionMessagingService } from './sessionMessagingService';
import { messagingAgentRuntimeProvider } from './messagingAgentRuntime';
import { IListAgentsTool } from './tools/list-agents/list-agents';
import { ListAgentsTool } from './tools/list-agents/listAgentsTool';
import { ISendMessageTool } from './tools/send-message/send-message';
import { SendMessageTool } from './tools/send-message/sendMessageTool';

function messagingEnabled(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(AGENT_MESSAGING_FLAG_ID);
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
  }
}

registerFeature(MessagingFeature);
