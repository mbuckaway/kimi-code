import { randomUUID } from 'node:crypto';

import type {
  CrossSessionSendResult,
  CrossSessionSessionEntry,
  ICrossSessionMessagingService,
} from './crossSession/crossSessionMessaging';
import { isEngineSessionId } from './crossSession/crossSessionRegistry';

export const CROSS_SESSION_ADDRESS_PREFIX = 'session:';

export type MessageAddress =
  | { readonly kind: 'intraSession' }
  | { readonly kind: 'crossSession'; readonly target: string };

export interface CrossSessionTarget {
  readonly sessionId: string;
  readonly title?: string;
}

export type CrossSessionTargetResolution =
  | { readonly kind: 'resolved'; readonly session: CrossSessionSessionEntry }
  | { readonly kind: 'unknown'; readonly sessions: readonly CrossSessionSessionEntry[] }
  | { readonly kind: 'ambiguous'; readonly matches: readonly CrossSessionSessionEntry[] };

export interface CrossSessionSendOutput {
  readonly output: string;
  readonly isError: boolean;
  readonly truncated: boolean;
}

export function classifyMessageAddress(to: string): MessageAddress {
  const address = to.trim();
  if (address.startsWith(CROSS_SESSION_ADDRESS_PREFIX)) {
    return {
      kind: 'crossSession',
      target: address.slice(CROSS_SESSION_ADDRESS_PREFIX.length).trim(),
    };
  }
  if (isEngineSessionId(address)) return { kind: 'crossSession', target: address };
  return { kind: 'intraSession' };
}

export async function resolveCrossSessionTarget(
  crossSession: Pick<ICrossSessionMessagingService, 'listSessions'>,
  callerSessionId: string,
  target: string,
): Promise<CrossSessionTargetResolution> {
  const address = target.trim();
  const sessions = await crossSession.listSessions(callerSessionId);
  const exact = sessions.find((entry) => entry.sessionId === address);
  if (exact !== undefined) return { kind: 'resolved', session: exact };
  if (address.length > 0) {
    const titled = sessions.filter((entry) => entry.title === address);
    const single = titled.length === 1 ? titled[0] : undefined;
    if (single !== undefined) return { kind: 'resolved', session: single };
    if (titled.length > 1) return { kind: 'ambiguous', matches: titled };
  }
  return { kind: 'unknown', sessions };
}

export function formatUnknownCrossSessionMessage(
  target: string,
  sessions: readonly CrossSessionSessionEntry[],
): string {
  const lines = [`Unknown session "${target}".`];
  if (sessions.length === 0) {
    lines.push('No other sessions are reachable for cross-session messaging.');
    return lines.join('\n');
  }
  lines.push('Reachable sessions:', ...sessionRows(sessions));
  return lines.join('\n');
}

export function formatAmbiguousCrossSessionMessage(
  target: string,
  matches: readonly CrossSessionSessionEntry[],
): string {
  return `Ambiguous session "${target}": ${matches.map((entry) => entry.sessionId).join(', ')}. Use the session id.`;
}

export function formatCrossSessionRoster(
  sessions: readonly CrossSessionSessionEntry[],
): string {
  if (sessions.length === 0) return '';
  return [
    'Other sessions you can message:',
    ...sessionRows(sessions),
    'Use `SendMessage` with `to: "session:<sessionId>"` to reach one.',
  ].join('\n');
}

export function formatCrossSessionSendResult(input: {
  readonly kind: 'message' | 'reply';
  readonly inReplyTo?: string;
  readonly target: CrossSessionTarget;
  readonly result: CrossSessionSendResult;
}): CrossSessionSendOutput {
  const { kind, target, result } = input;
  const label = crossSessionTargetLabel(target);
  const leader =
    kind === 'reply' && input.inReplyTo !== undefined
      ? `Reply to ${input.inReplyTo}`
      : capitalize(kind);
  switch (result.kind) {
    case 'delivered':
      return formatDelivered(leader, label, result);
    case 'held':
      return output(
        `${leader} was held for ${label} by the receiving session's cross-session inbound policy. It is delivered once that session accepts cross-session messages.`,
        result.truncated,
      );
    case 'refused':
      return formatRefused(kind, label, result);
    case 'offline':
      return output(`${label} is offline; the ${kind} was not delivered.`, false);
    case 'error':
      return {
        output: `${leader} to ${label} failed: ${result.error}`,
        isError: true,
        truncated: false,
      };
  }
}

type DeliveredCrossSessionSendResult = Extract<CrossSessionSendResult, { kind: 'delivered' }>;
type RefusedCrossSessionSendResult = Extract<CrossSessionSendResult, { kind: 'refused' }>;

function formatDelivered(
  leader: string,
  label: string,
  result: DeliveredCrossSessionSendResult,
): CrossSessionSendOutput {
  switch (result.delivery) {
    case 'steered':
      return output(
        `${leader} delivered to ${label}; it reaches the receiving session's main agent at its next step boundary.`,
        result.truncated,
      );
    case 'newTurn':
      return output(
        `${leader} delivered to ${label} and started a new turn in that session.`,
        result.truncated,
      );
    case 'resumed':
      return output(
        `${leader} delivered to ${label}; the receiving session's main agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.`,
        result.truncated,
      );
  }
}

function formatRefused(
  kind: 'message' | 'reply',
  label: string,
  result: RefusedCrossSessionSendResult,
): CrossSessionSendOutput {
  switch (result.reason) {
    case 'policy':
      return output(
        `Cross-session messaging is unavailable, so the ${kind} to ${label} was refused.`,
        result.truncated,
      );
    case 'duplicate':
      return output(
        `Duplicate ${kind}: ${label} already received this message; it was not delivered again.`,
        result.truncated,
      );
    case 'self':
      return output(
        `Cannot send a cross-session ${kind} to your own session.`,
        result.truncated,
      );
    case 'queue_full':
      return output(
        `The ${kind} to ${label} was refused because the receiving session's cross-session hold queue is full. Retry later.`,
        result.truncated,
      );
  }
}

export function createCrossSessionMessageId(): string {
  return randomUUID();
}

function sessionRows(sessions: readonly CrossSessionSessionEntry[]): readonly string[] {
  return sessions.map((entry) => {
    const title = entry.title === undefined ? '' : ` ("${entry.title}")`;
    return `- ${entry.sessionId}${title} — ${entry.status}`;
  });
}

function crossSessionTargetLabel(target: CrossSessionTarget): string {
  return target.title === undefined
    ? target.sessionId
    : `${target.sessionId} ("${target.title}")`;
}

function output(text: string, truncated: boolean): CrossSessionSendOutput {
  return { output: text, isError: false, truncated };
}

function capitalize(kind: 'message' | 'reply'): string {
  return kind === 'message' ? 'Message' : 'Reply';
}
