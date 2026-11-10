import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const AGENT_MESSAGING_FLAG_ID = 'agent_messaging';
export const AGENT_MESSAGING_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_MESSAGING';

export const agentMessagingFlag: FlagDefinitionInput = {
  id: AGENT_MESSAGING_FLAG_ID,
  title: 'Agent messaging',
  description:
    'Let agents message each other with SendMessage and discover recipients with ListAgents, and let the Agent tool assign addressable names to spawned subagents.',
  env: AGENT_MESSAGING_FLAG_ENV,
  default: true,
  surface: 'both',
};

registerFlagDefinition(agentMessagingFlag);
