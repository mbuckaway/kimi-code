import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentHealthState } from '#/agent/task/agentHealth';

export type AgentMessageDelivery = 'steered' | 'newTurn' | 'resumed' | 'duplicate';

export type AgentInboxDelivery = Exclude<AgentMessageDelivery, 'duplicate'>;

export interface AgentInboxMessage {
  readonly id: string;
  readonly from: string;
  readonly fromLabel?: string;
  readonly message: string;
  readonly delivery: AgentInboxDelivery;
  readonly truncated: boolean;
}

export interface ListMessagesOptions {
  readonly from?: string;
  readonly limit?: number;
}

export interface AgentInbox {
  readonly messages: readonly AgentInboxMessage[];
  readonly pending: number;
}

export interface SendMessageResult {
  readonly delivery: AgentMessageDelivery;
  readonly agentId: string;
  readonly label: string;
  readonly truncated: boolean;
}

export interface ReplyMessageResult extends SendMessageResult {
  readonly inReplyTo: string;
}

export interface BroadcastDelivery {
  readonly agentId: string;
  readonly label: string;
  readonly delivery: AgentMessageDelivery;
}

export interface BroadcastFailure {
  readonly agentId: string;
  readonly label: string;
  readonly reason: string;
  readonly message: string;
}

export interface BroadcastMessageResult {
  readonly delivered: readonly BroadcastDelivery[];
  readonly failed: readonly BroadcastFailure[];
}

export interface SendMessageOptions {
  readonly inReplyTo?: string;
}

export interface StopAgentResult {
  readonly agentId: string;
  readonly label: string;
  readonly stopped: boolean;
  readonly pendingTurnIds: readonly number[];
}

export interface InterruptAgentResult {
  readonly agentId: string;
  readonly label: string;
  readonly interrupted: boolean;
}

export interface AgentRosterEntry {
  readonly agentId: string;
  readonly name?: string;
  readonly role: 'main' | 'sub' | 'independent';
  readonly running: boolean;
  readonly parentAgentId?: string;
  readonly tags?: readonly string[];
  readonly state?: AgentHealthState;
}

export interface ISessionMessagingService {
  readonly _serviceBrand: undefined;

  sendMessage(
    callerAgentId: string,
    to: string,
    message: string,
    signal?: AbortSignal,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;

  listMessages(callerAgentId: string, options?: ListMessagesOptions): Promise<AgentInbox>;

  replyMessage(
    callerAgentId: string,
    messageId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<ReplyMessageResult>;

  broadcastMessage(
    callerAgentId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<BroadcastMessageResult>;

  stopAgent(
    callerAgentId: string,
    to: string,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<StopAgentResult>;

  interruptAgent(
    callerAgentId: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<InterruptAgentResult>;

  listAgents(callerAgentId: string): Promise<readonly AgentRosterEntry[]>;

  rosterInstructions(callerAgentId: string): Promise<string | undefined>;
}

export const ISessionMessagingService: ServiceIdentifier<ISessionMessagingService> =
  createDecorator<ISessionMessagingService>('sessionMessagingService');
