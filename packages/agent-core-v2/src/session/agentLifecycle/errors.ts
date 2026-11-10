import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentLifecycleErrors = {
  codes: {
    AGENT_NOT_FOUND: 'agent.not_found',
    AGENT_ALREADY_EXISTS: 'agent.already_exists',
    AGENT_ALREADY_RUNNING: 'agent.already_running',
    AGENT_NOT_A_SUBAGENT: 'agent.not_a_subagent',
    AGENT_NOT_OWNED: 'agent.not_owned',
    AGENT_TYPE_NOT_ALLOWED: 'agent.type_not_allowed',
    AGENT_MAX_TOKENS_EXCEEDED: 'agent.max_tokens_exceeded',
    AGENT_NAME_INVALID: 'agent.name_invalid',
    AGENT_NAME_RESERVED: 'agent.name_reserved',
    AGENT_NAME_TAKEN: 'agent.name_taken',
  },
  info: {
    'agent.name_invalid': {
      title: 'Invalid agent name',
      retryable: false,
      public: true,
      action: 'Use 1-64 characters of letters, digits, ".", "_" or "-", and avoid agent-id shaped names.',
    },
    'agent.name_reserved': {
      title: 'That agent name is reserved',
      retryable: false,
      public: true,
      action: 'Pick another name: "main" always names the root agent.',
    },
    'agent.name_taken': {
      title: 'That agent name is already in use',
      retryable: false,
      public: true,
      action: 'Pick another name or address the existing agent by its id.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentLifecycleErrors);
