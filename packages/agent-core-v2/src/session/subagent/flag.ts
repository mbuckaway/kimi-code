import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Secondary model for subagents',
  description:
    'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);

export const SUBAGENT_FORK_FLAG_ID = 'subagent_fork';
export const SUBAGENT_FORK_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK';

export const subagentForkFlag: FlagDefinitionInput = {
  id: SUBAGENT_FORK_FLAG_ID,
  title: 'Fork context for subagents',
  description:
    'Let the Agent and AgentSwarm tools start a subagent with a snapshot of the calling agent\'s conversation history via the fork parameter.',
  env: SUBAGENT_FORK_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentForkFlag);

export const AGENT_PERSONA_FLAG_ID = 'agent_persona';
export const AGENT_PERSONA_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_AGENT_PERSONA';

export const agentPersonaFlag: FlagDefinitionInput = {
  id: AGENT_PERSONA_FLAG_ID,
  title: 'Agent persona',
  description:
    'Let the Agent and AgentSwarm tools layer a Markdown persona (overlay or replace) onto a spawned agent profile via the persona/personas parameters.',
  env: AGENT_PERSONA_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentPersonaFlag);
