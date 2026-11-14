/**
 * Unit tests for the collaboration messaging tools: ListMessages, ReplyMessage,
 * and BroadcastMessage.
 *
 * Each tool forwards to a mocked `SessionSubagentHost` and only formats the
 * model-facing result, so the host methods are doubled with `vi.fn()`.
 */

import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import {
  MAX_AGENT_MESSAGE_CHARS,
  type AgentInbox,
  type SessionSubagentHost,
} from '../../src/session/subagent-host';
import {
  BroadcastMessageTool,
  BroadcastMessageToolInputSchema,
} from '../../src/tools/builtin/collaboration/broadcast-message';
import {
  ListMessagesTool,
  ListMessagesToolInputSchema,
} from '../../src/tools/builtin/collaboration/list-messages';
import {
  ReplyMessageTool,
  ReplyMessageToolInputSchema,
} from '../../src/tools/builtin/collaboration/reply-message';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(args: Input, toolCallId = 'call_msg') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockHost() {
  const listMessages = vi.fn();
  const replyMessage = vi.fn();
  const broadcastMessage = vi.fn();
  const host = {
    listMessages,
    replyMessage,
    broadcastMessage,
  } as unknown as SessionSubagentHost;
  return { host, listMessages, replyMessage, broadcastMessage };
}

describe('ListMessagesTool', () => {
  it('trims and bounds the from and limit inputs', () => {
    expect(
      ListMessagesToolInputSchema.parse({ from: ' agent-0 ', limit: 5 }),
    ).toEqual({ from: 'agent-0', limit: 5 });
    expect(ListMessagesToolInputSchema.safeParse({}).success).toBe(true);
    expect(ListMessagesToolInputSchema.safeParse({ from: '  ' }).success).toBe(false);
    expect(ListMessagesToolInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListMessagesToolInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListMessagesToolInputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it('declares the fixed activity description, no accesses, and its own approval rule', () => {
    const { host } = mockHost();
    const tool = new ListMessagesTool(host);

    const execution = tool.resolveExecution({});

    expect(execution.isError).toBeFalsy();
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Listing inbox messages');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('ListMessages');
  });

  it('reports an empty inbox with the pending count', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockReturnValue({ messages: [], pending: 2 } satisfies AgentInbox);

    const result = await executeTool(new ListMessagesTool(host), context({}));

    expect(result).toEqual({ output: 'Inbox is empty. 2 queued, not yet delivered.' });
    expect(listMessages).toHaveBeenCalledWith({ from: undefined, limit: undefined });
  });

  it('renders each message newest first with sender, delivery, and preview', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockReturnValue({
      pending: 1,
      messages: [
        {
          id: 'message-2',
          from: 'agent-0',
          fromLabel: 'reviewer',
          message: 'First line\nsecond line',
          delivery: 'steered',
          truncated: false,
        },
        {
          id: 'message-1',
          from: 'agent-1',
          message: 'Hello',
          delivery: 'buffered',
          truncated: true,
        },
      ],
    } satisfies AgentInbox);

    const result = await executeTool(new ListMessagesTool(host), context({}));

    expect(result).toEqual({
      output: [
        'Inbox: 2 message(s), newest first. 1 queued, not yet delivered.',
        '- message-2 · from reviewer (agent-0) · steered · First line',
        '- message-1 · from agent-1 (agent-1) · buffered · Hello [truncated]',
      ].join('\n'),
    });
  });

  it('truncates a long inbox message preview at 200 characters', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockReturnValue({
      pending: 0,
      messages: [
        { id: 'message-1', from: 'agent-0', message: 'x'.repeat(250), delivery: 'resumed', truncated: false },
      ],
    } satisfies AgentInbox);

    const result = await executeTool(new ListMessagesTool(host), context({}));

    expect(result.output).toContain(`${'x'.repeat(199)}…`);
  });

  it('forwards the from and limit filters to the host', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockReturnValue({ messages: [], pending: 0 } satisfies AgentInbox);

    await executeTool(new ListMessagesTool(host), context({ from: 'agent-0', limit: 10 }));

    expect(listMessages).toHaveBeenCalledWith({ from: 'agent-0', limit: 10 });
  });

  it('returns the host error as an error result', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockImplementation(() => {
      throw new Error('inbox unavailable');
    });

    const result = await executeTool(new ListMessagesTool(host), context({}));

    expect(result).toEqual({ isError: true, output: 'inbox unavailable' });
  });

  it('stringifies a non-Error host rejection as text', async () => {
    const { host, listMessages } = mockHost();
    listMessages.mockImplementation(() => {
      // Deliberate non-Error throw: verifies the tool stringifies a string rejection.
      // oxlint-disable-next-line typescript-eslint/only-throw-error
      throw 'inbox unavailable';
    });

    const result = await executeTool(new ListMessagesTool(host), context({}));

    expect(result).toEqual({ isError: true, output: 'inbox unavailable' });
  });
});

describe('ReplyMessageTool', () => {
  it('trims the message id and rejects a blank reply body', () => {
    expect(
      ReplyMessageToolInputSchema.parse({ message_id: ' message-3 ', message: 'Reply text' }),
    ).toEqual({ message_id: 'message-3', message: 'Reply text' });
    expect(ReplyMessageToolInputSchema.safeParse({ message_id: '  ', message: 'x' }).success).toBe(
      false,
    );
    expect(ReplyMessageToolInputSchema.safeParse({ message_id: 'm', message: '' }).success).toBe(
      false,
    );
    expect(ReplyMessageToolInputSchema.safeParse({ message_id: 'm', message: '   ' }).success).toBe(
      false,
    );
    expect(ReplyMessageToolInputSchema.safeParse({ message_id: 'm', message: 'x' }).success).toBe(
      true,
    );
  });

  it('uses the summary as the activity preview', () => {
    const { host } = mockHost();
    const tool = new ReplyMessageTool(host);

    const execution = tool.resolveExecution({
      message_id: ' message-3 ',
      message: 'First line\nsecond line',
      summary: 'Summary line',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Reply to message-3: Summary line');
    expect(execution.approvalRule).toBe('ReplyMessage');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('falls back to the first message line as the activity preview', () => {
    const { host } = mockHost();
    const tool = new ReplyMessageTool(host);

    const execution = tool.resolveExecution({ message_id: 'message-3', message: 'First line\nsecond line' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Reply to message-3: First line');
  });

  it('uses the whole message as the preview when it has no newline', () => {
    const { host } = mockHost();
    const tool = new ReplyMessageTool(host);

    const execution = tool.resolveExecution({ message_id: 'message-3', message: 'Single line' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Reply to message-3: Single line');
  });

  it('truncates the activity preview at 200 characters', () => {
    const { host } = mockHost();
    const tool = new ReplyMessageTool(host);
    const longSummary = `s${'x'.repeat(250)}`;

    const execution = tool.resolveExecution({
      message_id: 'message-3',
      message: 'First line\nsecond line',
      summary: longSummary,
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe(`Reply to message-3: s${'x'.repeat(198)}…`);
  });

  it('reports that a steered reply started a new turn', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockResolvedValue({
      delivery: 'steered',
      agentId: 'agent-0',
      label: 'reviewer',
      truncated: false,
      inReplyTo: 'message-3',
    });

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({
      output: 'Reply to message-3 delivered to reviewer (agent-0) and started a new turn.',
    });
    expect(replyMessage).toHaveBeenCalledWith('message-3', 'Reply text', signal);
  });

  it('reports that a buffered reply arrives at the next step boundary', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockResolvedValue({
      delivery: 'buffered',
      agentId: 'agent-0',
      label: 'reviewer',
      truncated: false,
      inReplyTo: 'message-3',
    });

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({
      output:
        'Reply to message-3 delivered to reviewer (agent-0). It arrives at the receiver\'s next step boundary.',
    });
  });

  it('reports that an idle agent was resumed in the background', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockResolvedValue({
      delivery: 'resumed',
      agentId: 'agent-0',
      label: 'reviewer',
      truncated: false,
      inReplyTo: 'message-3',
    });

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({
      output:
        'Reply to message-3 delivered to reviewer (agent-0); the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.',
    });
  });

  it('reports a duplicate reply without delivering it again', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockResolvedValue({
      delivery: 'duplicate',
      agentId: 'agent-0',
      label: 'reviewer',
      truncated: false,
      inReplyTo: 'message-3',
    });

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({
      output:
        'Duplicate reply: the same message was already sent to reviewer (agent-0); it was not delivered again.',
    });
  });

  it('appends a truncation note when the reply was truncated', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockResolvedValue({
      delivery: 'resumed',
      agentId: 'agent-0',
      label: 'reviewer',
      truncated: true,
      inReplyTo: 'message-3',
    });

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({
      output: `Reply to message-3 delivered to reviewer (agent-0); the agent was idle and has been resumed in the background. Its reply arrives automatically in a later turn.\n\nNote: the message exceeded ${String(MAX_AGENT_MESSAGE_CHARS)} characters and was truncated before delivery.`,
    });
  });

  it('returns the host error as an error result', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockRejectedValue(new Error('Unknown inbox message "message-3".'));

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({ isError: true, output: 'Unknown inbox message "message-3".' });
  });

  it('stringifies a non-Error host rejection as text', async () => {
    const { host, replyMessage } = mockHost();
    replyMessage.mockRejectedValue('delivery failed');

    const result = await executeTool(
      new ReplyMessageTool(host),
      context({ message_id: 'message-3', message: 'Reply text' }),
    );

    expect(result).toEqual({ isError: true, output: 'delivery failed' });
  });
});

describe('BroadcastMessageTool', () => {
  it('rejects a blank broadcast body', () => {
    expect(BroadcastMessageToolInputSchema.parse({ message: 'Update', summary: 's' })).toEqual({
      message: 'Update',
      summary: 's',
    });
    expect(BroadcastMessageToolInputSchema.safeParse({ message: '' }).success).toBe(false);
    expect(BroadcastMessageToolInputSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(BroadcastMessageToolInputSchema.safeParse({ message: 'x' }).success).toBe(true);
  });

  it('uses the summary as the activity preview', () => {
    const { host } = mockHost();
    const tool = new BroadcastMessageTool(host);

    const execution = tool.resolveExecution({ message: 'First line\nsecond line', summary: 'Summary' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Broadcast message: Summary');
    expect(execution.approvalRule).toBe('BroadcastMessage');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('falls back to the first message line as the activity preview', () => {
    const { host } = mockHost();
    const tool = new BroadcastMessageTool(host);

    const execution = tool.resolveExecution({ message: 'First line\nsecond line' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Broadcast message: First line');
  });

  it('uses the whole message as the preview when it has no newline', () => {
    const { host } = mockHost();
    const tool = new BroadcastMessageTool(host);

    const execution = tool.resolveExecution({ message: 'Single line' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Broadcast message: Single line');
  });

  it('truncates the activity preview at 200 characters', () => {
    const { host } = mockHost();
    const tool = new BroadcastMessageTool(host);
    const longSummary = `s${'x'.repeat(250)}`;

    const execution = tool.resolveExecution({
      message: 'First line\nsecond line',
      summary: longSummary,
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe(`Broadcast message: s${'x'.repeat(198)}…`);
  });

  it('reports delivered and failed recipients', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockResolvedValue({
      delivered: [{ agentId: 'agent-0', label: 'reviewer', delivery: 'steered' }],
      failed: [
        { agentId: 'agent-1', label: 'coder', reason: 'delivery_failed', message: 'queue full' },
      ],
    });

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'Update' }),
    );

    expect(result).toEqual({
      output: [
        'Broadcast: 1 delivered, 1 failed.',
        '- reviewer (agent-0): steered',
        '- coder (agent-1): failed — delivery_failed: queue full',
      ].join('\n'),
    });
    expect(broadcastMessage).toHaveBeenCalledWith('Update', signal);
  });

  it('reports that there is no one to broadcast to', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockResolvedValue({ delivered: [], failed: [] });

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'Update' }),
    );

    expect(result).toEqual({ output: 'No other agents to broadcast to.' });
  });

  it('does not append a truncation note at exactly the character limit', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockResolvedValue({
      delivered: [{ agentId: 'agent-0', label: 'reviewer', delivery: 'buffered' }],
      failed: [],
    });

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'x'.repeat(MAX_AGENT_MESSAGE_CHARS) }),
    );

    expect(result).toEqual({
      output: ['Broadcast: 1 delivered, 0 failed.', '- reviewer (agent-0): buffered'].join('\n'),
    });
  });

  it('appends a truncation note when the message exceeds the character limit', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockResolvedValue({
      delivered: [{ agentId: 'agent-0', label: 'reviewer', delivery: 'buffered' }],
      failed: [],
    });

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'x'.repeat(MAX_AGENT_MESSAGE_CHARS + 1) }),
    );

    expect(result).toEqual({
      output: `Broadcast: 1 delivered, 0 failed.\n- reviewer (agent-0): buffered\n\nNote: the message exceeded ${String(MAX_AGENT_MESSAGE_CHARS)} characters and was truncated before delivery.`,
    });
  });

  it('returns the host error as an error result', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockRejectedValue(new Error('Cannot send an empty message.'));

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'Update' }),
    );

    expect(result).toEqual({ isError: true, output: 'Cannot send an empty message.' });
  });

  it('stringifies a non-Error host rejection as text', async () => {
    const { host, broadcastMessage } = mockHost();
    broadcastMessage.mockRejectedValue('delivery failed');

    const result = await executeTool(
      new BroadcastMessageTool(host),
      context({ message: 'Update' }),
    );

    expect(result).toEqual({ isError: true, output: 'delivery failed' });
  });
});
