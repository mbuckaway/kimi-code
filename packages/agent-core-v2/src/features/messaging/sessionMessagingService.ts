import { createControlledPromise } from '@antfu/utils';

import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import {
  abortable,
  abortError,
  createDeadlineAbortSignal,
  isUserCancellation,
  linkAbortSignal,
  type DeadlineAbortSignal,
} from '#/_base/utils/abort';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { Error2, ErrorCodes } from '#/errors';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type {
  AgentMessageOrigin,
  ContextMessage,
  SessionMessageOrigin,
} from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { deriveAgentHealth } from '#/agent/task/agentHealth';
import { agentTaskFor } from '#/agent/task/agentTaskLookup';
import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { AgentReminder, type ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import {
  labelsFromAgentMeta,
  ownMeta,
  subagentAncestorIds,
  subagentChildrenIndex,
  subagentDescendantsChildFirst,
  subagentParentAgentId,
  tagsOf,
} from '#/session/agentLifecycle/subagentMetadata';
import { agentNameOf } from '#/session/subagent/agentNames';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  formatSubagentTimeoutDescription,
  resolveSubagentTimeoutMs,
} from '#/session/subagent/configSection';
import { latestAssistantText } from '#/session/subagent/runAgentTurn';
import {
  ISessionMetadata,
  type AgentMeta,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { AgentMessageStepRequest } from './agentMessageRequest';
import { ICrossSessionInboundService } from './crossSessionInboundService';
import { AGENT_MESSAGING_FLAG_ID } from './flag';
import {
  AGENT_MESSAGING_ROSTER_CHANGE_VARIANT,
  CROSS_SESSION_INBOUND_HOLD_VARIANT,
  DEFAULT_INBOX_LIMIT,
  MAX_BUFFERED_AGENT_MESSAGES,
  MAX_HELD_CROSS_SESSION_MESSAGES,
  MESSAGING_INSTRUCTIONS,
  formatHeldCrossSessionNotice,
  formatRosterChangeNotice,
  recordRecentKey,
  recordRecentSend,
  truncateAgentMessage,
  wrapAgentMessage,
  wrapSessionMessage,
} from './envelope';
import { MAX_INBOX_MESSAGES, appendInboxEntry } from './sessionInbox';
import {
  type AgentInbox,
  type AgentInboxDelivery,
  type AgentInboxMessage,
  type AgentRosterEntry,
  type BroadcastDelivery,
  type BroadcastFailure,
  type BroadcastMessageResult,
  type CrossSessionInboundMessage,
  type CrossSessionReceiveResult,
  type HeldCrossSessionMessage,
  type InterruptAgentResult,
  type ISessionMessagingService,
  type ListMessagesOptions,
  type ReplyMessageResult,
  type SendMessageOptions,
  type SendMessageResult,
  type StopAgentResult,
} from './messaging';

const QUEUE_FULL_MESSAGE = "The receiver's message queue is full — retry later.";

interface InFlightLaunch {
  readonly started: Promise<void>;
  readonly settled: Promise<void>;
  markStarted(): void;
  release(): void;
}

interface AgentMessageRecipient {
  readonly agentId: string;
  readonly label: string;
  readonly role: 'main' | 'sub';
}

interface AddressableAgent {
  readonly agentId: string;
  readonly meta: AgentMeta | undefined;
  readonly role: 'main' | 'sub';
}

type RecipientReach = 'addressable' | 'any';

type DeliverySource = AgentMessageOrigin | SessionMessageOrigin;

interface DeliverySender {
  readonly origin: DeliverySource;
  readonly identity: string;
  readonly inboxFrom: string;
  readonly inboxLabel?: string;
  readonly fromSessionId?: string;
  readonly fromSessionLabel?: string;
  readonly resumeOwnerAgentId: string;
  readonly resumeDescription: string;
}

interface DeliveryOutcome {
  readonly delivery: AgentInboxDelivery;
  readonly agentId: string;
  readonly label: string;
  readonly truncated: boolean;
}

interface DeliveryInput {
  readonly sender: DeliverySender;
  readonly recipient: AgentMessageRecipient;
  readonly text: string;
  readonly truncated: boolean;
  readonly signal: AbortSignal | undefined;
  readonly inReplyTo: string | undefined;
  readonly onDelivered: () => void;
}

export class SessionMessagingService extends Service implements ISessionMessagingService {
  declare readonly _serviceBrand: undefined;

  private readonly lastSentMessage = new Map<string, string>();
  private readonly inFlightSends = new Map<string, string>();
  private readonly launches = new Map<string, InFlightLaunch>();
  private readonly pendingMessages = new Map<string, number>();
  private readonly interruptedAgents = new Set<string>();
  private readonly runControllers = new Map<string, AbortController>();
  private readonly pendingInterrupts = new Map<string, IDisposable>();
  private readonly watchedAgents = new Map<string, IDisposable>();
  private readonly inbox = new Map<string, AgentInboxMessage[]>();
  private readonly lastRosterText = new Map<string, string>();
  private readonly rosterSyncs = new Map<string, Promise<void>>();
  private readonly receivedCrossSessionIds = new Set<string>();
  private readonly heldCrossSessionMessages: HeldCrossSessionMessage[] = [];
  private nextMessageNumber = 1;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IConfigService private readonly configService: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ICrossSessionInboundService private readonly crossSessionInbound: ICrossSessionInboundService,
  ) {
    super();
    for (const agent of this.agentLifecycle.list()) {
      this.watchAgent(agent.agentId);
      this.scheduleRosterSync(agent.agentId);
    }
    this._register(
      this.agentLifecycle.onDidCreate((agent) => {
        this.watchAgent(agent.agentId);
        this.scheduleRosterSyncForAll();
      }),
    );
    this._register(
      this.agentLifecycle.onDidClose((agent) => {
        this.unwatchAgent(agent.agentId);
        this.scheduleRosterSyncForAll();
      }),
    );
    this._register(
      this.sessionMetadata.onDidChangeMetadata((event) => {
        if (event.changed.includes('agents')) this.scheduleRosterSyncForAll();
      }),
    );
    this._register(
      toDisposable(() => {
        for (const disposables of this.watchedAgents.values()) disposables.dispose();
        this.watchedAgents.clear();
        for (const pending of this.pendingInterrupts.values()) pending.dispose();
        this.pendingInterrupts.clear();
      }),
    );
  }

  async rosterInstructions(callerAgentId: string): Promise<string | undefined> {
    if (!this.flags.enabled(AGENT_MESSAGING_FLAG_ID)) return undefined;
    const roster = await this.addressableAgents(callerAgentId);
    return [
      MESSAGING_INSTRUCTIONS,
      '',
      'Addressable agents (use SendMessage with the id):',
      ...roster
        .filter((entry) => entry.agentId !== callerAgentId)
        .map((entry) => this.rosterLineOf(entry)),
    ].join('\n');
  }

  async listAgents(callerAgentId: string): Promise<readonly AgentRosterEntry[]> {
    const roster = await this.addressableAgents(callerAgentId);
    const callerHandle = this.agentLifecycle.handleOf(callerAgentId);
    const tasks = callerHandle === undefined ? [] : this.taskServiceOf(callerHandle).list(false);
    return roster
      .filter((entry) => entry.agentId !== callerAgentId)
      .map((entry) => {
        const handle = this.agentLifecycle.handleOf(entry.agentId);
        const loopState = handle === undefined ? undefined : this.loopOf(handle).status().state;
        return {
          agentId: entry.agentId,
          name: entry.role === 'main' ? undefined : agentNameOf(entry.meta),
          role: entry.role === 'main' ? 'main' : (entry.meta?.type ?? 'sub'),
          running: this.isRunning(entry.agentId),
          parentAgentId: subagentParentAgentId(entry.meta),
          tags: parseAgentTags(entry.meta),
          state: deriveAgentHealth({
            hasHandle: handle !== undefined,
            loopState,
            task: agentTaskFor(tasks, entry.agentId),
          }),
        };
      });
  }

  async sendMessage(
    callerAgentId: string,
    to: string,
    message: string,
    signal?: AbortSignal,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    return this.sendMessageTo(
      callerAgentId,
      to,
      message,
      signal,
      options?.inReplyTo,
      'addressable',
    );
  }

  async listMessages(
    callerAgentId: string,
    options: ListMessagesOptions = {},
  ): Promise<AgentInbox> {
    const from = options.from?.trim();
    const limit = Math.min(
      MAX_INBOX_MESSAGES,
      Math.max(1, options.limit ?? DEFAULT_INBOX_LIMIT),
    );
    const entries = this.inbox.get(callerAgentId) ?? [];
    const filtered =
      from === undefined || from.length === 0
        ? entries
        : entries.filter((entry) => entry.from === from || entry.fromLabel === from);
    return {
      messages: [...filtered].toReversed().slice(0, limit),
      pending: this.pendingMessages.get(callerAgentId) ?? 0,
    };
  }

  async receiveCrossSession(
    input: CrossSessionInboundMessage,
  ): Promise<CrossSessionReceiveResult> {
    input.signal?.throwIfAborted();
    if (input.message.trim().length === 0) {
      throw new Error2(ErrorCodes.MESSAGE_EMPTY, 'Cannot send an empty message.');
    }
    const messageId = input.messageId.trim();
    if (messageId.length === 0) {
      throw new Error2(ErrorCodes.MESSAGE_EMPTY, 'A cross-session message needs a message id.');
    }
    if (input.fromSessionId === this.sessionContext.sessionId) {
      return { kind: 'refused', reason: 'self', truncated: false };
    }
    const dedupeKey = this.crossSessionDedupeKey(input.fromSessionId, messageId);
    if (this.receivedCrossSessionIds.has(dedupeKey)) {
      return { kind: 'refused', reason: 'duplicate', truncated: false };
    }
    const { text, truncated } = truncateAgentMessage(input.message);
    switch (this.crossSessionInbound.get()) {
      case 'refuse':
        return { kind: 'refused', reason: 'policy', truncated };
      case 'hold':
        recordRecentKey(this.receivedCrossSessionIds, dedupeKey);
        this.holdCrossSessionMessage(input, text, truncated);
        return { kind: 'held', truncated };
      case 'accept':
        return this.acceptCrossSessionMessage(input, text, truncated, dedupeKey);
    }
  }

  listHeldCrossSessionMessages(): readonly HeldCrossSessionMessage[] {
    return [...this.heldCrossSessionMessages];
  }

  async replyMessage(
    callerAgentId: string,
    messageId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<ReplyMessageResult> {
    const id = messageId.trim();
    if (message.trim().length === 0) {
      throw new Error2(ErrorCodes.MESSAGE_EMPTY, 'Cannot send an empty message.');
    }
    const original = this.inbox
      .get(callerAgentId)
      ?.find((entry) => entry.id === id);
    if (original === undefined) {
      throw new Error2(
        ErrorCodes.MESSAGE_NOT_FOUND,
        `Unknown inbox message "${id}".`,
        { details: { messageId: id } },
      );
    }
    const result = await this.sendMessageTo(
      callerAgentId,
      original.from,
      message,
      signal,
      original.id,
      'any',
    );
    return { ...result, inReplyTo: original.id };
  }

  async broadcastMessage(
    callerAgentId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<BroadcastMessageResult> {
    signal?.throwIfAborted();
    if (message.trim().length === 0) {
      throw new Error2(ErrorCodes.MESSAGE_EMPTY, 'Cannot send an empty message.');
    }
    const roster = await this.addressableAgents(callerAgentId);
    const delivered: BroadcastDelivery[] = [];
    const failed: BroadcastFailure[] = [];
    for (const entry of roster) {
      if (entry.agentId === callerAgentId) continue;
      const agentId = entry.agentId;
      const label = this.labelOf(entry);
      const recipient: AgentMessageRecipient = { agentId, label, role: entry.role };
      try {
        const result = await this.deliverResolved(callerAgentId, recipient, message, signal);
        delivered.push({ agentId, label, delivery: result.delivery });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        failed.push({
          agentId,
          label,
          reason: broadcastFailureReason(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { delivered, failed };
  }

  async stopAgent(
    callerAgentId: string,
    to: string,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<StopAgentResult> {
    signal?.throwIfAborted();
    const recipient = await this.resolveRecipient(callerAgentId, to, 'any');
    this.assertStoppable(callerAgentId, recipient);
    await this.subagents.assertOwned(callerAgentId, recipient.agentId);
    const cancelReason = abortError(stopReasonFor(callerAgentId, reason));
    const controller = this.runControllers.get(recipient.agentId);
    controller?.abort(cancelReason);
    const handle = this.agentLifecycle.handleOf(recipient.agentId);
    if (handle === undefined) {
      return {
        agentId: recipient.agentId,
        label: recipient.label,
        stopped: false,
        pendingTurnIds: [],
      };
    }
    const loop = this.loopOf(handle);
    const status = loop.status();
    const pendingTurnIds = [...status.pendingTurnIds];
    const stopped =
      status.state === 'running' || pendingTurnIds.length > 0 || controller !== undefined;
    if (stopped) {
      for (const turnId of pendingTurnIds) loop.cancel(turnId, cancelReason);
      loop.cancel(undefined, cancelReason);
    }
    return {
      agentId: recipient.agentId,
      label: recipient.label,
      stopped,
      pendingTurnIds,
    };
  }

  async interruptAgent(
    callerAgentId: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<InterruptAgentResult> {
    signal?.throwIfAborted();
    const recipient = await this.resolveRecipient(callerAgentId, to, 'any');
    this.assertStoppable(callerAgentId, recipient);
    await this.subagents.assertOwned(callerAgentId, recipient.agentId);
    const handle = this.agentLifecycle.handleOf(recipient.agentId);
    if (handle === undefined) {
      return { agentId: recipient.agentId, label: recipient.label, interrupted: false };
    }
    const loop = this.loopOf(handle);
    if (loop.status().state !== 'running') {
      return { agentId: recipient.agentId, label: recipient.label, interrupted: false };
    }
    this.clearPendingInterrupt(recipient.agentId);
    this.pendingInterrupts.set(
      recipient.agentId,
      loop.hooks.onDidFinishStep.register(
        `agent-interrupt:${recipient.agentId}`,
        async (context, next) => {
          context.stopTurn = true;
          await next();
        },
      ),
    );
    return { agentId: recipient.agentId, label: recipient.label, interrupted: true };
  }

  private assertStoppable(callerAgentId: string, recipient: AgentMessageRecipient): void {
    if (recipient.agentId === MAIN_AGENT_ID) {
      throw new Error2(
        ErrorCodes.STOP_MAIN_DENIED,
        'The root agent cannot be stopped by an agent.',
      );
    }
    if (recipient.agentId === callerAgentId) {
      throw new Error2(ErrorCodes.STOP_SELF, 'An agent cannot stop itself.');
    }
  }

  private clearPendingInterrupt(agentId: string): void {
    this.pendingInterrupts.get(agentId)?.dispose();
    this.pendingInterrupts.delete(agentId);
  }

  private async deliverResolved(
    callerAgentId: string,
    recipient: AgentMessageRecipient,
    message: string,
    signal?: AbortSignal,
    inReplyTo?: string,
  ): Promise<SendMessageResult> {
    const sender = await this.agentSender(callerAgentId);
    const { text, truncated } = truncateAgentMessage(message);
    const dedupeKey = this.dedupeKey(sender, recipient.agentId);
    const duplicate = (): SendMessageResult => ({
      delivery: 'duplicate',
      agentId: recipient.agentId,
      label: recipient.label,
      truncated,
    });
    if (this.lastSentMessage.get(dedupeKey) === text) return duplicate();
    const inFlightText = this.inFlightSends.get(dedupeKey);
    if (inFlightText === text) return duplicate();
    const ownsInFlight = inFlightText === undefined;
    if (ownsInFlight) this.inFlightSends.set(dedupeKey, text);
    try {
      return await this.deliverCore({
        sender,
        recipient,
        text,
        truncated,
        signal,
        inReplyTo,
        onDelivered: () => {
          recordRecentSend(this.lastSentMessage, dedupeKey, text);
        },
      });
    } finally {
      if (ownsInFlight && this.inFlightSends.get(dedupeKey) === text) {
        this.inFlightSends.delete(dedupeKey);
      }
    }
  }

  private async deliverCore(input: DeliveryInput): Promise<DeliveryOutcome> {
    const { sender, recipient, text, truncated, signal, inReplyTo, onDelivered } = input;
    const message = buildDeliveryMessage(sender.origin, text, inReplyTo);
    const target = await this.ensureTarget(recipient.agentId, signal);
    signal?.throwIfAborted();
    if (target === undefined) {
      throw new Error2(
        ErrorCodes.MESSAGE_RECIPIENT_UNKNOWN,
        `Unknown recipient "${recipient.agentId}".`,
      );
    }
    this.refreshInterruptedFromState(recipient.agentId, target);
    if (!this.isHandleRunning(target) && this.interruptedAgents.has(recipient.agentId)) {
      throw interruptedAgentError(recipient.agentId);
    }
    const launch = this.launches.get(recipient.agentId);
    if (!this.isHandleRunning(target) && launch !== undefined) {
      await this.awaitDeliveryWindow(
        Promise.race([launch.started, launch.settled]),
        recipient.agentId,
        signal,
      );
      signal?.throwIfAborted();
    }
    const running = this.isHandleRunning(target);
    if (!running && this.interruptedAgents.has(recipient.agentId)) {
      throw interruptedAgentError(recipient.agentId);
    }
    if (running || recipient.role === 'main') {
      this.steerMessage(target, recipient, message);
      const delivery: AgentInboxDelivery = running ? 'steered' : 'newTurn';
      onDelivered();
      this.recordDelivery(sender, recipient, text, truncated, delivery);
      return {
        delivery,
        agentId: recipient.agentId,
        label: recipient.label,
        truncated,
      };
    }
    const outcome = await this.resumeAgentForMessage(
      sender,
      recipient,
      target,
      message,
      signal,
      onDelivered,
    );
    signal?.throwIfAborted();
    if (outcome === 'busy') {
      this.steerMessage(target, recipient, message);
      onDelivered();
      this.recordDelivery(sender, recipient, text, truncated, 'steered');
      return {
        delivery: 'steered',
        agentId: recipient.agentId,
        label: recipient.label,
        truncated,
      };
    }
    onDelivered();
    this.recordDelivery(sender, recipient, text, truncated, 'resumed');
    return { delivery: 'resumed', agentId: recipient.agentId, label: recipient.label, truncated };
  }

  private recordDelivery(
    sender: DeliverySender,
    recipient: AgentMessageRecipient,
    text: string,
    truncated: boolean,
    delivery: AgentInboxDelivery,
  ): void {
    this.recordInboxEntry(recipient.agentId, {
      from: sender.inboxFrom,
      fromLabel: sender.inboxLabel,
      fromSessionId: sender.fromSessionId,
      fromSessionLabel: sender.fromSessionLabel,
      message: text,
      delivery,
      truncated,
    });
  }

  private async agentSender(callerAgentId: string): Promise<DeliverySender> {
    const origin = await this.agentMessageOrigin(callerAgentId);
    return {
      origin,
      identity: `${this.sessionContext.sessionId}\0agent:${callerAgentId}`,
      inboxFrom: callerAgentId,
      inboxLabel: origin.replyTo,
      resumeOwnerAgentId: callerAgentId,
      resumeDescription: `Message reply from agent ${callerAgentId}`,
    };
  }

  private sessionSender(
    fromSessionId: string,
    fromSessionTitle: string | undefined,
  ): DeliverySender {
    const origin: SessionMessageOrigin = {
      kind: 'session_message',
      fromSessionId,
      fromSessionTitle,
    };
    return {
      origin,
      identity: `${fromSessionId}\0agent:${MAIN_AGENT_ID}`,
      inboxFrom: fromSessionId,
      inboxLabel: fromSessionTitle,
      fromSessionId,
      fromSessionLabel: fromSessionTitle,
      resumeOwnerAgentId: MAIN_AGENT_ID,
      resumeDescription: `Message reply from session ${fromSessionId}`,
    };
  }

  private async acceptCrossSessionMessage(
    input: CrossSessionInboundMessage,
    text: string,
    truncated: boolean,
    dedupeKey: string,
  ): Promise<CrossSessionReceiveResult> {
    recordRecentKey(this.receivedCrossSessionIds, dedupeKey);
    try {
      const result = await this.deliverCore({
        sender: this.sessionSender(input.fromSessionId, input.fromSessionTitle),
        recipient: { agentId: MAIN_AGENT_ID, label: MAIN_AGENT_ID, role: 'main' },
        text,
        truncated,
        signal: input.signal,
        inReplyTo: input.inReplyTo,
        onDelivered: () => {},
      });
      return { kind: 'delivered', delivery: result.delivery, truncated: result.truncated };
    } catch (error) {
      this.receivedCrossSessionIds.delete(dedupeKey);
      throw error;
    }
  }

  private holdCrossSessionMessage(
    input: CrossSessionInboundMessage,
    text: string,
    truncated: boolean,
  ): void {
    this.heldCrossSessionMessages.push({
      messageId: input.messageId.trim(),
      fromSessionId: input.fromSessionId,
      fromSessionTitle: input.fromSessionTitle,
      message: text,
      truncated,
      inReplyTo: input.inReplyTo,
    });
    if (this.heldCrossSessionMessages.length > MAX_HELD_CROSS_SESSION_MESSAGES) {
      this.heldCrossSessionMessages.splice(
        0,
        this.heldCrossSessionMessages.length - MAX_HELD_CROSS_SESSION_MESSAGES,
      );
    }
    this.notifyHeldCrossSession(input.fromSessionId, input.fromSessionTitle);
  }

  private notifyHeldCrossSession(
    fromSessionId: string,
    fromSessionTitle: string | undefined,
  ): void {
    const context = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (context === undefined) return;
    let reminder: ReminderRuntime;
    try {
      reminder = this.agentLifecycle.resolve(context, AgentReminder);
    } catch {
      return;
    }
    reminder.notify(formatHeldCrossSessionNotice(fromSessionId, fromSessionTitle), {
      variant: CROSS_SESSION_INBOUND_HOLD_VARIANT,
    });
  }

  private crossSessionDedupeKey(fromSessionId: string, messageId: string): string {
    return `${fromSessionId}\0${messageId}`;
  }

  private recordInboxEntry(
    agentId: string,
    entry: Omit<AgentInboxMessage, 'id'>,
  ): void {
    appendInboxEntry(this.inbox, agentId, {
      id: `message-${this.nextMessageNumber++}`,
      ...entry,
    });
  }

  private dedupeKey(sender: DeliverySender, recipientAgentId: string): string {
    return `${sender.identity}\0${recipientAgentId}`;
  }

  private steerMessage(
    target: IAgentScopeHandle,
    recipient: AgentMessageRecipient,
    message: ContextMessage,
  ): void {
    const release = this.reservePendingMessage(recipient.agentId);
    const request = new AgentMessageStepRequest(message, release);
    try {
      const receipt = this.loopOf(target).enqueue(request);
      void receipt.assigned.catch(() => {
        release();
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  private async resumeAgentForMessage(
    sender: DeliverySender,
    recipient: AgentMessageRecipient,
    target: IAgentScopeHandle,
    message: ContextMessage,
    signal: AbortSignal | undefined,
    onDelivered: () => void,
  ): Promise<'resumed' | 'busy'> {
    const launch = this.acquireLaunch(recipient.agentId);
    if (launch === undefined) return 'busy';
    const controller = new AbortController();
    this.runControllers.set(recipient.agentId, controller);
    const unlinkSignal = signal === undefined ? () => {} : linkAbortSignal(signal, controller);
    const startedAt = Date.now();
    try {
      const loop = this.loopOf(target);
      signal?.throwIfAborted();
      if (loop.status().state === 'running') return 'busy';
      if (this.interruptedAgents.has(recipient.agentId)) {
        throw interruptedAgentError(recipient.agentId);
      }
      const receipt = loop.enqueue(new AgentMessageStepRequest(message, () => {}));
      let turn: Turn;
      try {
        turn = (await this.awaitDeliveryWindow(receipt.assigned, recipient.agentId, signal)).turn;
      } catch (error) {
        receipt.abort(error);
        throw error;
      }
      const cancelTurn = (): void => {
        loop.cancel(turn.id, controller.signal.reason);
      };
      controller.signal.addEventListener('abort', cancelTurn, { once: true });
      if (controller.signal.aborted) cancelTurn();
      try {
        await this.waitForDeliveryStart(turn, recipient.agentId, signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      unlinkSignal();
      try {
        signal?.throwIfAborted();
        if (controller.signal.aborted) throw toDeliveryError(controller.signal.reason);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      launch.markStarted();
      onDelivered();
      void turn.result.then(
        () => {
          controller.signal.removeEventListener('abort', cancelTurn);
        },
        () => {
          controller.signal.removeEventListener('abort', cancelTurn);
        },
      );
      const remainingTimeoutMs = this.remainingDeliveryBudget(startedAt);
      const task = new SubagentTask(
        {
          agentId: recipient.agentId,
          profileName: this.profileNameOf(target) ?? 'subagent',
          completion: this.replyOf(target, turn),
        },
        sender.resumeDescription,
        controller,
        { messageDelivery: true },
      );
      try {
        this.taskServiceOf(this.requireHandle(sender.resumeOwnerAgentId)).registerTask(task, {
          detached: true,
          timeoutMs: remainingTimeoutMs,
        });
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      return 'resumed';
    } finally {
      unlinkSignal();
      if (this.runControllers.get(recipient.agentId) === controller) {
        this.runControllers.delete(recipient.agentId);
      }
      launch.release();
    }
  }

  private acquireLaunch(agentId: string): InFlightLaunch | undefined {
    if (this.isRunning(agentId)) return undefined;
    return this.beginLaunch(agentId);
  }

  private beginLaunch(agentId: string): InFlightLaunch {
    const started = createControlledPromise<void>();
    const settled = createControlledPromise<void>();
    const entry: InFlightLaunch = {
      started,
      settled,
      markStarted: () => {
        started.resolve();
      },
      release: () => {
        if (this.launches.get(agentId) === entry) this.launches.delete(agentId);
        settled.resolve();
      },
    };
    this.launches.set(agentId, entry);
    return entry;
  }

  private async waitForDeliveryStart(
    turn: Turn,
    recipientAgentId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const started = Promise.race([turn.ready, turn.result.then(() => undefined)]);
    await this.awaitDeliveryWindow(started, recipientAgentId, signal);
  }

  private async awaitDeliveryWindow<T>(
    wait: Promise<T>,
    recipientAgentId: string,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const timeoutMs = resolveSubagentTimeoutMs(this.configService);
    if (timeoutMs <= 0) {
      try {
        return await (signal === undefined ? wait : abortable(wait, signal));
      } catch (error) {
        throw toDeliveryError(error);
      }
    }
    const deadline: DeadlineAbortSignal = createDeadlineAbortSignal(
      signal ?? new AbortController().signal,
      timeoutMs,
    );
    try {
      return await abortable(wait, deadline.signal);
    } catch (error) {
      if (deadline.timedOut()) {
        throw new Error2(
          ErrorCodes.MESSAGE_DELIVERY_TIMEOUT,
          `Message delivery to "${recipientAgentId}" timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`,
          { cause: error },
        );
      }
      throw toDeliveryError(error);
    } finally {
      deadline.clear();
    }
  }

  private remainingDeliveryBudget(startedAt: number): number {
    const timeoutMs = resolveSubagentTimeoutMs(this.configService);
    if (timeoutMs <= 0) return 0;
    return Math.max(1, timeoutMs - (Date.now() - startedAt));
  }

  private replyOf(target: IAgentScopeHandle, turn: Turn): Promise<{ readonly result: string }> {
    const context = this.contextOf(target);
    return turn.result.then((result) => {
      switch (result.type) {
        case 'completed':
          return { result: latestAssistantText(context.get()) };
        case 'failed':
          throw toDeliveryError(result.error);
        case 'cancelled':
          throw toDeliveryError(result.reason);
      }
    });
  }

  private reservePendingMessage(agentId: string): () => void {
    const pending = this.pendingMessages.get(agentId) ?? 0;
    if (pending >= MAX_BUFFERED_AGENT_MESSAGES) {
      throw new Error2(ErrorCodes.MESSAGE_QUEUE_FULL, QUEUE_FULL_MESSAGE);
    }
    this.pendingMessages.set(agentId, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.pendingMessages.get(agentId) ?? 1;
      if (current <= 1) this.pendingMessages.delete(agentId);
      else this.pendingMessages.set(agentId, current - 1);
    };
  }

  private async sendMessageTo(
    callerAgentId: string,
    to: string,
    message: string,
    signal: AbortSignal | undefined,
    inReplyTo: string | undefined,
    reach: RecipientReach,
  ): Promise<SendMessageResult> {
    signal?.throwIfAborted();
    if (message.trim().length === 0) {
      throw new Error2(ErrorCodes.MESSAGE_EMPTY, 'Cannot send an empty message.');
    }
    const recipient = await this.resolveRecipient(callerAgentId, to, reach);
    if (recipient.agentId === callerAgentId) {
      throw new Error2(
        ErrorCodes.MESSAGE_SELF_SEND,
        `Cannot send a message to yourself ("${recipient.agentId}").`,
      );
    }
    return this.deliverResolved(callerAgentId, recipient, message, signal, inReplyTo);
  }

  private async resolveRecipient(
    callerAgentId: string,
    to: string,
    reach: RecipientReach,
  ): Promise<AgentMessageRecipient> {
    const address = to.trim();
    if (address === MAIN_AGENT_ID) {
      return { agentId: MAIN_AGENT_ID, label: MAIN_AGENT_ID, role: 'main' };
    }
    const agents = await this.agentMetadata();
    const roster =
      reach === 'addressable' ? await this.addressableAgents(callerAgentId, agents) : undefined;
    const assertReachable = (agentId: string): void => {
      if (roster === undefined || agentId === callerAgentId) return;
      if (roster.some((entry) => entry.agentId === agentId)) return;
      throw unknownRecipientError(roster, agentId);
    };
    const raw = ownMeta(agents, address);
    if (raw !== undefined) {
      assertReachable(address);
      return {
        agentId: address,
        label: agentNameOf(raw) ?? address,
        role: raw.type === 'main' ? 'main' : 'sub',
      };
    }
    if (this.agentLifecycle.handleOf(address) !== undefined) {
      assertReachable(address);
      return { agentId: address, label: address, role: 'sub' };
    }
    if (address === agentNameOf(ownMeta(agents, callerAgentId))) {
      return { agentId: callerAgentId, label: address, role: 'sub' };
    }
    const known = roster ?? (await this.addressableAgents(callerAgentId, agents));
    const named = known.filter(
      (entry) => entry.role === 'sub' && agentNameOf(entry.meta) === address,
    );
    if (named.length > 1) {
      throw new Error2(
        ErrorCodes.MESSAGE_RECIPIENT_AMBIGUOUS,
        `Ambiguous recipient "${address}": ${named.map((entry) => entry.agentId).join(', ')}. Use the agent id.`,
      );
    }
    const onlyMatch = named[0];
    if (onlyMatch !== undefined) {
      return { agentId: onlyMatch.agentId, label: address, role: 'sub' };
    }
    throw unknownRecipientError(known, address);
  }

  private async addressableAgents(
    callerAgentId: string,
    knownAgents?: Readonly<Record<string, AgentMeta>>,
  ): Promise<readonly AddressableAgent[]> {
    const agents = knownAgents ?? (await this.agentMetadata());
    const byId = new Map<string, AddressableAgent>([
      [
        MAIN_AGENT_ID,
        { agentId: MAIN_AGENT_ID, meta: ownMeta(agents, MAIN_AGENT_ID), role: 'main' },
      ],
    ]);
    for (const ancestorId of subagentAncestorIds(callerAgentId, agents)) {
      if (ancestorId === MAIN_AGENT_ID || byId.has(ancestorId)) continue;
      byId.set(ancestorId, {
        agentId: ancestorId,
        meta: ownMeta(agents, ancestorId),
        role: 'sub',
      });
    }
    const children = subagentChildrenIndex(agents);
    for (const descendantId of subagentDescendantsChildFirst(callerAgentId, children)) {
      byId.set(descendantId, {
        agentId: descendantId,
        meta: ownMeta(agents, descendantId),
        role: 'sub',
      });
    }
    if (callerAgentId !== MAIN_AGENT_ID) byId.delete(callerAgentId);
    return [...byId.values()].toSorted((left, right) => {
      if (left.agentId === MAIN_AGENT_ID) return -1;
      if (right.agentId === MAIN_AGENT_ID) return 1;
      return left.agentId.localeCompare(right.agentId);
    });
  }

  private async ensureTarget(
    agentId: string,
    signal: AbortSignal | undefined,
  ): Promise<IAgentScopeHandle | undefined> {
    const meta = ownMeta(await this.agentMetadata(), agentId);
    if (meta === undefined) return this.agentLifecycle.handleOf(agentId);
    await this.awaitDeliveryWindow(
      this.agentLifecycle.create({
        agentId,
        labels: labelsFromAgentMeta(meta),
        forkedFrom: meta.forkedFrom,
      }),
      agentId,
      signal,
    );
    return this.agentLifecycle.handleOf(agentId);
  }

  private async agentMessageOrigin(callerAgentId: string): Promise<AgentMessageOrigin> {
    const meta = ownMeta(await this.agentMetadata(), callerAgentId);
    return { kind: 'agent_message', from: callerAgentId, replyTo: agentNameOf(meta) };
  }

  private async agentMetadata(): Promise<Readonly<Record<string, AgentMeta>>> {
    return (await this.sessionMetadata.read()).agents ?? {};
  }

  private labelOf(entry: AddressableAgent): string {
    return this.labelPartsOf(entry).label;
  }

  private rosterLineOf(entry: AddressableAgent): string {
    const { label, profile } = this.labelPartsOf(entry);
    const marker = profile ? ' (profile)' : '';
    return `- ${label}${marker} (id: ${entry.agentId})`;
  }

  private labelPartsOf(entry: AddressableAgent): {
    readonly label: string;
    readonly profile: boolean;
  } {
    if (entry.role === 'main') return { label: MAIN_AGENT_ID, profile: false };
    const name = agentNameOf(entry.meta);
    if (name !== undefined) return { label: name, profile: false };
    const profileName = this.profileNameOfId(entry.agentId);
    if (profileName !== undefined) return { label: profileName, profile: true };
    return { label: entry.agentId, profile: false };
  }

  private profileNameOfId(agentId: string): string | undefined {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) return undefined;
    return this.profileNameOf(handle);
  }

  private isRunning(agentId: string): boolean {
    if (this.launches.has(agentId)) return true;
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) return false;
    return this.isHandleRunning(handle);
  }

  private isHandleRunning(handle: IAgentScopeHandle): boolean {
    return this.loopOf(handle).status().state === 'running';
  }

  private watchAgent(agentId: string): void {
    if (this.watchedAgents.has(agentId)) return;
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) return;
    const disposables = new DisposableStore();
    const loop = this.loopOf(handle);
    disposables.add(
      loop.hooks.onWillCancelTurn.register('agent-messaging', (event) => {
        if (!isUserCancellation(event.reason)) return;
        if (event.target === 'queued' && this.isHandleRunning(handle)) return;
        this.interruptedAgents.add(agentId);
      }),
    );
    const bus = handle.accessor.get(IEventBus);
    disposables.add(
      bus.subscribe(TurnEnded, (event) => {
        if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
          this.interruptedAgents.add(agentId);
        }
        this.clearPendingInterrupt(agentId);
      }),
    );
    disposables.add(
      bus.subscribe(TurnStarted, () => {
        this.interruptedAgents.delete(agentId);
      }),
    );
    const dispatcher = handle.accessor.get(IEventDispatcher) as IEventDispatcher | undefined;
    if (dispatcher !== undefined) {
      disposables.add(
        dispatcher.hooks.onDidRestore.register('agent-messaging', async (_context, next) => {
          await next();
          this.refreshInterruptedFromState(agentId, handle);
        }),
      );
    }
    this.refreshInterruptedFromState(agentId, handle);
    this.watchedAgents.set(agentId, disposables);
  }

  private refreshInterruptedFromState(agentId: string, handle: IAgentScopeHandle): void {
    const states = handle.accessor.get(IAgentStateService) as IAgentStateService | undefined;
    if (states === undefined || !states.has(turnKey)) return;
    const lastEnded = states.get(turnKey).lastEnded;
    if (lastEnded?.interruptReason === 'user_cancelled') this.interruptedAgents.add(agentId);
    else this.interruptedAgents.delete(agentId);
  }

  async syncRoster(agentId: string): Promise<void> {
    const previous = this.rosterSyncs.get(agentId) ?? Promise.resolve();
    const run = previous.then(() => this.applyRosterSync(agentId));
    const tail = run.then(() => undefined, onUnexpectedError);
    this.rosterSyncs.set(agentId, tail);
    try {
      await run;
    } finally {
      if (this.rosterSyncs.get(agentId) === tail) this.rosterSyncs.delete(agentId);
    }
  }

  private async applyRosterSync(agentId: string): Promise<void> {
    if (!this.flags.enabled(AGENT_MESSAGING_FLAG_ID)) {
      this.lastRosterText.delete(agentId);
      return;
    }
    const text = await this.rosterInstructions(agentId);
    if (text === undefined) {
      this.lastRosterText.delete(agentId);
      return;
    }
    const previous = this.lastRosterText.get(agentId);
    if (previous === undefined) {
      this.lastRosterText.set(agentId, text);
      return;
    }
    if (previous === text) return;
    this.lastRosterText.set(agentId, text);
    const context = this.agentLifecycle.get(agentId);
    if (context === undefined) return;
    let reminder: ReminderRuntime;
    try {
      reminder = this.agentLifecycle.resolve(context, AgentReminder);
    } catch {
      return;
    }
    reminder.notify(formatRosterChangeNotice(previous, text), {
      variant: AGENT_MESSAGING_ROSTER_CHANGE_VARIANT,
    });
  }

  private scheduleRosterSync(agentId: string): void {
    void this.syncRoster(agentId).catch(onUnexpectedError);
  }

  private scheduleRosterSyncForAll(): void {
    for (const agent of this.agentLifecycle.list()) this.scheduleRosterSync(agent.agentId);
  }

  private unwatchAgent(agentId: string): void {
    this.watchedAgents.get(agentId)?.dispose();
    this.watchedAgents.delete(agentId);
    this.clearPendingInterrupt(agentId);
    this.interruptedAgents.delete(agentId);
    this.inbox.delete(agentId);
    this.lastRosterText.delete(agentId);
    this.rosterSyncs.delete(agentId);
  }

  private loopOf(handle: IAgentScopeHandle): IAgentLoopService {
    return handle.accessor.get(IAgentLoopService);
  }

  private contextOf(handle: IAgentScopeHandle): IAgentContextMemoryService {
    return handle.accessor.get(IAgentContextMemoryService);
  }

  private taskServiceOf(handle: IAgentScopeHandle): IAgentTaskService {
    return handle.accessor.get(IAgentTaskService);
  }

  private profileNameOf(handle: IAgentScopeHandle): string | undefined {
    return handle.accessor.get(IAgentProfileService).data().profileName;
  }

  private requireHandle(agentId: string): IAgentScopeHandle {
    const handle = this.agentLifecycle.handleOf(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    return handle;
  }
}

function buildDeliveryMessage(
  origin: DeliverySource,
  text: string,
  inReplyTo: string | undefined,
): ContextMessage {
  const envelopeOptions = inReplyTo === undefined ? undefined : { inReplyTo };
  return {
    role: 'user',
    content: [
      { type: 'text', text: wrapDeliveryMessage(origin, text, envelopeOptions) },
    ],
    toolCalls: [],
    origin,
  };
}

function wrapDeliveryMessage(
  origin: DeliverySource,
  body: string,
  options: { readonly inReplyTo?: string } | undefined,
): string {
  switch (origin.kind) {
    case 'agent_message':
      return wrapAgentMessage(origin, body, options);
    case 'session_message':
      return wrapSessionMessage(origin, body, options);
  }
}

function unknownRecipientError(roster: readonly AddressableAgent[], address: string): Error2 {
  const known = roster.map((entry) => agentNameOf(entry.meta) ?? entry.agentId);
  return new Error2(
    ErrorCodes.MESSAGE_RECIPIENT_UNKNOWN,
    `Unknown recipient "${address}" — address main, a named child agent, or a known agent id (known: ${known.join(', ')}).`,
  );
}

function broadcastFailureReason(error: unknown): string {
  if (!(error instanceof Error2)) return 'delivery_failed';
  const prefix = 'message.';
  return error.code.startsWith(prefix) ? error.code.slice(prefix.length) : 'delivery_failed';
}

function stopReasonFor(callerAgentId: string, reason: string | undefined): string {
  const trimmed = reason?.trim() ?? '';
  return trimmed.length === 0
    ? `Stopped by agent ${callerAgentId}`
    : `Stopped by agent ${callerAgentId}: ${trimmed}`;
}

function parseAgentTags(meta: AgentMeta | undefined): readonly string[] | undefined {
  if (meta === undefined) return undefined;
  const tags = tagsOf(meta);
  return tags.length > 0 ? tags : undefined;
}

function interruptedAgentError(agentId: string): Error2 {
  const remedy =
    agentId === MAIN_AGENT_ID
      ? 'Send a new prompt to resume it.'
      : 'Use the Agent tool to start it again.';
  return new Error2(
    ErrorCodes.MESSAGE_TARGET_INTERRUPTED,
    `Agent "${agentId}" was cancelled by the user during its last run. ${remedy}`,
  );
}

function toDeliveryError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string' && error.length > 0) return new Error(error);
  return new Error2(ErrorCodes.MESSAGE_DELIVERY_FAILED, 'The message could not be delivered.');
}
