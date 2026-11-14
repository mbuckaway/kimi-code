import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENT_MESSAGING_FLAG_ID = 'agent_messaging';
export const AGENT_MESSAGING_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_MESSAGING';

export const AGENT_FLEET_CONTROL_FLAG_ID = 'agent_fleet_control';
export const AGENT_FLEET_CONTROL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_FLEET_CONTROL';

export const agentMessagingFlag: FlagDefinitionInput = {
  id: AGENT_MESSAGING_FLAG_ID,
  title: 'Agent messaging',
  description:
    'Let agents message each other with SendMessage, discover recipients and fleet state with ListAgents, AgentResult, AgentHealth and WaitForAll, and let the Agent tool assign addressable names to spawned subagents.',
  env: AGENT_MESSAGING_FLAG_ENV,
  default: true,
  surface: 'both',
};

export const agentFleetControlFlag: FlagDefinitionInput = {
  id: AGENT_FLEET_CONTROL_FLAG_ID,
  title: 'Agent fleet control',
  description:
    'Let agents stop, interrupt, dismiss, tag, and rename the agents they own through StopAgent, StopAgents, InterruptAgent, DismissAgents, TagAgent and RenameAgent.',
  env: AGENT_FLEET_CONTROL_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(agentMessagingFlag);
registerFlagDefinition(agentFleetControlFlag);
