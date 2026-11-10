import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type AgentMessageDelivery = 'steered' | 'newTurn' | 'resumed' | 'duplicate';

export interface SendMessageResult {
  readonly delivery: AgentMessageDelivery;
  readonly agentId: string;
  readonly label: string;
  readonly truncated: boolean;
}

export interface AgentRosterEntry {
  readonly agentId: string;
  readonly name?: string;
  readonly role: 'main' | 'sub';
  readonly running: boolean;
}

export interface ISessionMessagingService {
  readonly _serviceBrand: undefined;

  sendMessage(
    callerAgentId: string,
    to: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<SendMessageResult>;

  listAgents(callerAgentId: string): Promise<readonly AgentRosterEntry[]>;

  rosterInstructions(callerAgentId: string): Promise<string | undefined>;
}

export const ISessionMessagingService: ServiceIdentifier<ISessionMessagingService> =
  createDecorator<ISessionMessagingService>('sessionMessagingService');
