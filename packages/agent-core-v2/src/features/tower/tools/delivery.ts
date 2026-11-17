import type { ISessionEventBus } from '#/app/event/eventBus';
import type {
  AgentMessageDelivery,
  ISessionMessagingService,
} from '#/features/messaging/messaging';
import { BROADCAST_NAME, TOWER_NAME } from '#/features/tower/protocol/index';
import type { TowerSendResult, TowerState } from '#/features/tower/protocol/index';
import { TowerInboxSent } from '#/features/tower/towerOps';

const STEER_SUBJECT_PREVIEW_MAX = 120;

export interface TowerDeliveryServices {
  readonly sessionBus: ISessionEventBus | undefined;
  readonly messaging: ISessionMessagingService | undefined;
  readonly callerAgentId: string;
  readonly state: TowerState;
}

export async function deliverTowerMessage(
  services: TowerDeliveryServices,
  sent: TowerSendResult,
): Promise<string> {
  const { item } = sent;
  if (
    services.sessionBus !== undefined &&
    item.from !== TOWER_NAME &&
    (item.to === TOWER_NAME || item.to === BROADCAST_NAME)
  ) {
    services.sessionBus.publish(
      new TowerInboxSent({
        from: item.from,
        to: item.to,
        subject: item.subject,
        messageId: item.messageId,
        file: item.file,
        sentAt: item.sentAt,
        missionId: sent.missionId,
      }),
    );
  }
  if (item.to === TOWER_NAME || item.to === BROADCAST_NAME) return '';
  const entry = services.state.roster.agents.find((agent) => agent.name === item.to);
  if (entry === undefined) return '';
  if (services.messaging === undefined) {
    return `\nnote: agent messaging is unavailable in this session — the message for ${item.to} stays in the tower inbox and is picked up on its next inbox read.`;
  }
  try {
    const result = await services.messaging.sendMessage(
      services.callerAgentId,
      entry.agentId,
      steerDirective(item),
    );
    return deliveryNote(item.to, result.delivery);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `\nnote: could not steer ${item.to}: ${reason} — the message stays in the tower inbox and is picked up on its next inbox read.`;
  }
}

function steerDirective(item: TowerSendResult['item']): string {
  const subject =
    item.subject.length > STEER_SUBJECT_PREVIEW_MAX
      ? `${item.subject.slice(0, STEER_SUBJECT_PREVIEW_MAX)}…`
      : item.subject;
  return `[tower inbox] new message from ${item.from}: "${subject}" — read it now with TowerInbox and act on it before continuing.`;
}

function deliveryNote(label: string, delivery: AgentMessageDelivery): string {
  switch (delivery) {
    case 'steered':
      return `\nnote: ${label} is mid-turn — the message was steered into its running turn; it sees the directive at its next step boundary.`;
    case 'newTurn':
      return `\nnote: ${label} was idle — the message started a new turn.`;
    case 'resumed':
      return `\nnote: ${label} was idle — it was resumed in the background to handle the message.`;
    case 'duplicate':
      return `\nnote: ${label} already had this message — it was not delivered again.`;
  }
}
