import type { AgentInboxMessage } from './messaging';

export const MAX_INBOX_MESSAGES = 100;

export function appendInboxEntry(
  inbox: Map<string, AgentInboxMessage[]>,
  agentId: string,
  entry: AgentInboxMessage,
): void {
  const entries = inbox.get(agentId) ?? [];
  entries.push(entry);
  if (entries.length > MAX_INBOX_MESSAGES) {
    entries.splice(0, entries.length - MAX_INBOX_MESSAGES);
  }
  inbox.set(agentId, entries);
}
