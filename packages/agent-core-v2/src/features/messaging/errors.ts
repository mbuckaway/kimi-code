import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const MessagingErrors = {
  codes: {
    MESSAGE_EMPTY: 'message.empty',
    MESSAGE_SELF_SEND: 'message.self_send',
    MESSAGE_RECIPIENT_UNKNOWN: 'message.recipient_unknown',
    MESSAGE_RECIPIENT_AMBIGUOUS: 'message.recipient_ambiguous',
    MESSAGE_QUEUE_FULL: 'message.queue_full',
    MESSAGE_TARGET_INTERRUPTED: 'message.target_interrupted',
    MESSAGE_DELIVERY_TIMEOUT: 'message.delivery_timeout',
    MESSAGE_DELIVERY_FAILED: 'message.delivery_failed',
  },
  info: {
    'message.empty': {
      title: 'The message body is empty',
      retryable: false,
      public: true,
      action: 'Send a non-empty message body.',
    },
    'message.self_send': {
      title: 'An agent cannot message itself',
      retryable: false,
      public: true,
      action: 'Address another agent.',
    },
    'message.recipient_unknown': {
      title: 'The recipient is unknown',
      retryable: false,
      public: true,
      action: 'Use ListAgents to see the addressable agents, then retry with a listed id or name.',
    },
    'message.recipient_ambiguous': {
      title: 'The recipient name matches more than one agent',
      retryable: false,
      public: true,
      action: 'Address the agent by its raw agent id.',
    },
    'message.queue_full': {
      title: 'The receiver message queue is full',
      retryable: true,
      public: true,
      action: 'Retry later, once the receiver drains its queued messages.',
    },
    'message.target_interrupted': {
      title: 'The target agent was cancelled by the user',
      retryable: false,
      public: true,
      action: 'Use the Agent tool to start the agent again.',
    },
    'message.delivery_timeout': {
      title: 'Message delivery timed out',
      retryable: true,
      public: true,
      action: 'Retry the send or raise subagent.timeoutMs.',
    },
    'message.delivery_failed': {
      title: 'The message could not be delivered',
      retryable: true,
      public: true,
      action: 'Retry the send.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(MessagingErrors);
