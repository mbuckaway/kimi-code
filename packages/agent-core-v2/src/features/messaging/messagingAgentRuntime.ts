import { fromCallback, setup } from 'xstate';

import { IFlagService } from '#/app/flag/flag';
import type { ContextInjectionContext } from '#/features/reminder/types';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import { systemReminderContent } from '#/features/reminder/systemReminder';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AGENT_MESSAGING_VARIANT } from './envelope';
import { AGENT_MESSAGING_FLAG_ID } from './flag';
import { ISessionMessagingService } from './messaging';

const messagingInjection = fromCallback(
  ({ input }: { input: { readonly runtime: AgentRuntimeContext<null> } }) => {
    const runtime = input.runtime;
    const messaging = runtime.get(ISessionMessagingService);
    const reminder = runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentReminder);
    const registration = reminder.register(
      AGENT_MESSAGING_VARIANT,
      async (context: ContextInjectionContext) => {
        if (!runtime.get(IFlagService).enabled(AGENT_MESSAGING_FLAG_ID)) return undefined;
        const content = await messaging.rosterInstructions(runtime.agent.agentId);
        const lastText =
          context.lastInjection === undefined
            ? undefined
            : systemReminderContent(context.lastInjection);
        return shouldEmitMessagingRoster(content, lastText) ? content : undefined;
      },
    );
    return () => {
      registration.dispose();
    };
  },
);

const messagingActorLogic = setup({
  types: {} as {
    context: { readonly runtime: AgentRuntimeContext<null> };
    input: AgentRuntimeContext<null>;
    events: AgentRuntimeRestoreEvent;
  },
  actors: { messagingInjection },
}).createMachine({
  context: ({ input }) => ({ runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'messagingInjection',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
});

export interface MessagingRuntime {
  readonly kind: 'messaging';
}

export const AgentMessaging = defineAgentRuntimeContract<MessagingRuntime>('messaging');

export const messagingAgentRuntimeProvider = defineAgentRuntimeProvider<null, MessagingRuntime>(
  AgentMessaging,
  {
    id: 'messaging',
    logic: messagingActorLogic,
    eager: true,
    createApi: () => ({ kind: 'messaging' }),
  },
);

export function shouldEmitMessagingRoster(
  content: string | undefined,
  lastInjectedText: string | undefined,
): boolean {
  if (content === undefined) return false;
  if (lastInjectedText === undefined) return true;
  return lastInjectedText !== content;
}
