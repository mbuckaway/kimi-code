/**
 * Unit tests for the collaboration messaging tools: ListMessages, ReplyMessage,
 * and BroadcastMessage.
 *
 * Each tool forwards to a mocked `SessionSubagentHost` and only formats the
 * model-facing result, so the host methods are doubled with `vi.fn()`.
 */

import { describe, expect, it, vi } from 'vitest';

import { ToolAccesses } from '../../src/loop';
import type { RunnableToolExecution, ToolExecution } from '../../src/loop/types';
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
  DismissAgentsTool,
  DismissAgentsInputSchema,
} from '../../src/tools/builtin/collaboration/dismiss-agents';
import {
  InterruptAgentTool,
  InterruptAgentInputSchema,
} from '../../src/tools/builtin/collaboration/interrupt-agent';
import { ListAgentsTool } from '../../src/tools/builtin/collaboration/list-agents';
import {
  ListMessagesTool,
  ListMessagesToolInputSchema,
} from '../../src/tools/builtin/collaboration/list-messages';
import {
  RenameAgentTool,
  RenameAgentInputSchema,
} from '../../src/tools/builtin/collaboration/rename-agent';
import {
  ReplyMessageTool,
  ReplyMessageToolInputSchema,
} from '../../src/tools/builtin/collaboration/reply-message';
import {
  StopAgentTool,
  StopAgentInputSchema,
} from '../../src/tools/builtin/collaboration/stop-agent';
import {
  StopAgentsTool,
  StopAgentsInputSchema,
} from '../../src/tools/builtin/collaboration/stop-agents';
import {
  MAX_AGENT_TAGS,
  MAX_AGENT_TAG_CHARS,
  TagAgentTool,
  TagAgentInputSchema,
} from '../../src/tools/builtin/collaboration/tag-agent';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(args: Input, toolCallId = 'call_msg') {
  return { turnId: '0', toolCallId, args, signal };
}

function mockHost() {
  const listMessages = vi.fn();
  const replyMessage = vi.fn();
  const broadcastMessage = vi.fn();
  const stopAgent = vi.fn();
  const interruptAgent = vi.fn();
  const dismissAgents = vi.fn();
  const setAgentTags = vi.fn();
  const renameAgent = vi.fn();
  const stopAgents = vi.fn();
  const host = {
    listMessages,
    replyMessage,
    broadcastMessage,
    stopAgent,
    interruptAgent,
    dismissAgents,
    setAgentTags,
    renameAgent,
    stopAgents,
  } as unknown as SessionSubagentHost;
  return {
    host,
    listMessages,
    replyMessage,
    broadcastMessage,
    stopAgent,
    interruptAgent,
    dismissAgents,
    setAgentTags,
    renameAgent,
    stopAgents,
  };
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

describe('StopAgentTool', () => {
  it('trims the reason and bounds its length', () => {
    expect(StopAgentInputSchema.parse({ agent_id: 'agent-0', reason: '  too slow  ' })).toEqual({
      agent_id: 'agent-0',
      reason: 'too slow',
    });
    expect(StopAgentInputSchema.safeParse({ agent_id: '' }).success).toBe(false);
    expect(
      StopAgentInputSchema.safeParse({ agent_id: 'agent-0', reason: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(
      StopAgentInputSchema.safeParse({ agent_id: 'agent-0', reason: 'x'.repeat(500) }).success,
    ).toBe(true);
  });

  it('declares its activity description, no accesses, and its own approval rule', () => {
    const { host } = mockHost();
    const execution = new StopAgentTool(host).resolveExecution({ agent_id: 'agent-0' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Stopping agent agent-0');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('StopAgent');
    expect(execution.matchesRule?.('agent-0')).toBe(true);
    expect(execution.matchesRule?.('agent-1')).toBe(false);
  });

  it('reports a stop with its pending turns and the resume hint', async () => {
    const { host, stopAgent } = mockHost();
    stopAgent.mockResolvedValue({
      agentId: 'agent-0',
      label: 'reviewer',
      stopped: true,
      pendingTurnIds: [1, 2],
    });

    const result = await executeTool(
      new StopAgentTool(host),
      context({ agent_id: 'agent-0', reason: 'too slow' }),
    );

    expect(result).toEqual({
      output: [
        'agent_id: agent-0',
        'name: reviewer',
        'status: stopped',
        'pending_turns: 2',
        '',
        'Send it a message to resume it; stopping does not detach its name.',
      ].join('\n'),
    });
    expect(stopAgent).toHaveBeenCalledWith('agent-0', 'too slow', signal);
  });

  it('reports an already-idle target without claiming a stop', async () => {
    const { host, stopAgent } = mockHost();
    stopAgent.mockResolvedValue({
      agentId: 'agent-0',
      label: 'agent-0',
      stopped: false,
      pendingTurnIds: [],
    });

    const result = await executeTool(new StopAgentTool(host), context({ agent_id: 'agent-0' }));

    expect(result.output).toContain('status: already_idle');
    expect(result.output).toContain('pending_turns: 0');
  });

  it('returns the host error as an error result', async () => {
    const { host, stopAgent } = mockHost();
    stopAgent.mockRejectedValue(new Error('The root agent cannot be stopped by an agent.'));

    const result = await executeTool(new StopAgentTool(host), context({ agent_id: 'main' }));

    expect(result).toEqual({
      isError: true,
      output: 'The root agent cannot be stopped by an agent.',
    });
  });

  it('stringifies a non-Error host rejection as text', async () => {
    const { host, stopAgent } = mockHost();
    stopAgent.mockRejectedValue('nope');

    const result = await executeTool(new StopAgentTool(host), context({ agent_id: 'agent-0' }));

    expect(result).toEqual({ isError: true, output: 'nope' });
  });
});

describe('InterruptAgentTool', () => {
  it('rejects an empty agent id', () => {
    expect(InterruptAgentInputSchema.parse({ agent_id: 'agent-0' })).toEqual({
      agent_id: 'agent-0',
    });
    expect(InterruptAgentInputSchema.safeParse({ agent_id: '' }).success).toBe(false);
  });

  it('declares its activity description, no accesses, and its own approval rule', () => {
    const { host } = mockHost();
    const execution = new InterruptAgentTool(host).resolveExecution({ agent_id: 'agent-0' });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Interrupting agent agent-0');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('InterruptAgent');
  });

  it('reports a requested interrupt with the finish-step explanation', async () => {
    const { host, interruptAgent } = mockHost();
    interruptAgent.mockResolvedValue({
      agentId: 'agent-0',
      label: 'reviewer',
      interrupted: true,
    });

    const result = await executeTool(
      new InterruptAgentTool(host),
      context({ agent_id: 'agent-0' }),
    );

    expect(result).toEqual({
      output: [
        'agent_id: agent-0',
        'name: reviewer',
        'interrupt: requested',
        '',
        'A requested interrupt lets the current step finish, including the tools it already called, and then stops the agent.',
      ].join('\n'),
    });
    expect(interruptAgent).toHaveBeenCalledWith('agent-0', signal);
  });

  it('reports an idle target as not_running', async () => {
    const { host, interruptAgent } = mockHost();
    interruptAgent.mockResolvedValue({
      agentId: 'agent-0',
      label: 'agent-0',
      interrupted: false,
    });

    const result = await executeTool(
      new InterruptAgentTool(host),
      context({ agent_id: 'agent-0' }),
    );

    expect(result.output).toContain('interrupt: not_running');
  });

  it('returns the host error as an error result', async () => {
    const { host, interruptAgent } = mockHost();
    interruptAgent.mockRejectedValue(new Error('An agent cannot stop itself.'));

    const result = await executeTool(
      new InterruptAgentTool(host),
      context({ agent_id: 'agent-0' }),
    );

    expect(result).toEqual({ isError: true, output: 'An agent cannot stop itself.' });
  });
});

describe('DismissAgentsTool', () => {
  it('requires exactly one selector', () => {
    expect(DismissAgentsInputSchema.safeParse({ ids: ['agent-0'] }).success).toBe(true);
    expect(DismissAgentsInputSchema.safeParse({ names: ['reviewer'] }).success).toBe(true);
    expect(DismissAgentsInputSchema.safeParse({ all: true }).success).toBe(true);
    expect(DismissAgentsInputSchema.safeParse({}).success).toBe(false);
    expect(DismissAgentsInputSchema.safeParse({ all: false }).success).toBe(false);
    expect(DismissAgentsInputSchema.safeParse({ ids: ['agent-0'], all: true }).success).toBe(false);
    expect(DismissAgentsInputSchema.safeParse({ ids: [], names: ['reviewer'] }).success).toBe(false);
  });

  it.each([
    [{ ids: ['agent-0', 'agent-1'] }, 'Dismissing agent subtrees: agent-0, agent-1'],
    [{ names: ['reviewer'] }, 'Dismissing agent subtrees: reviewer'],
    [{ all: true }, 'Dismissing the entire owned agent subtree'],
  ])('describes %o as %s', (args, description) => {
    const { host } = mockHost();
    const execution = new DismissAgentsTool(host).resolveExecution(args);

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe(description);
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('DismissAgents');
  });

  it('formats removed and ghost-removed agents', async () => {
    const { host, dismissAgents } = mockHost();
    dismissAgents.mockResolvedValue({
      dismissed: [
        { agentId: 'agent-0', name: 'reviewer', ghost: false },
        { agentId: 'agent-1', ghost: true },
      ],
    });

    const result = await executeTool(
      new DismissAgentsTool(host),
      context({ ids: ['agent-0', 'agent-1'] }),
    );

    expect(result).toEqual({
      output: [
        'dismissed: 2',
        '',
        'agent_id: agent-0',
        'name: reviewer',
        'removal: removed',
        '---',
        'agent_id: agent-1',
        'removal: ghost_removed',
      ].join('\n'),
    });
    expect(dismissAgents).toHaveBeenCalledWith({ ids: ['agent-0', 'agent-1'] });
  });

  it('forwards name and all selectors', async () => {
    const { host, dismissAgents } = mockHost();
    dismissAgents.mockResolvedValue({ dismissed: [] });

    const byName = await executeTool(
      new DismissAgentsTool(host),
      context({ names: ['reviewer'] }),
    );
    const byAll = await executeTool(new DismissAgentsTool(host), context({ all: true }));

    expect(byName).toEqual({ output: 'dismissed: 0' });
    expect(byAll).toEqual({ output: 'dismissed: 0' });
    expect(dismissAgents).toHaveBeenNthCalledWith(1, { names: ['reviewer'] });
    expect(dismissAgents).toHaveBeenNthCalledWith(2, { all: true });
  });

  it('returns the host error as an error result', async () => {
    const { host, dismissAgents } = mockHost();
    dismissAgents.mockRejectedValue(new Error('The root agent "main" is not a subagent.'));

    const result = await executeTool(new DismissAgentsTool(host), context({ ids: ['main'] }));

    expect(result).toEqual({
      isError: true,
      output: 'The root agent "main" is not a subagent.',
    });
  });
});

describe('TagAgentTool', () => {
  it('trims tags and enforces the tag bounds', () => {
    expect(TagAgentInputSchema.parse({ agent_id: 'agent-0', tags: ['  ui  ', 'fast'] })).toEqual({
      agent_id: 'agent-0',
      tags: ['ui', 'fast'],
    });
    expect(TagAgentInputSchema.safeParse({ agent_id: 'agent-0', tags: [] }).success).toBe(true);
    expect(TagAgentInputSchema.safeParse({ agent_id: 'agent-0', tags: [''] }).success).toBe(false);
    expect(TagAgentInputSchema.safeParse({ agent_id: 'agent-0', tags: ['  '] }).success).toBe(false);
    expect(
      TagAgentInputSchema.safeParse({ agent_id: 'agent-0', tags: ['a,b'] }).success,
    ).toBe(false);
    expect(
      TagAgentInputSchema.safeParse({
        agent_id: 'agent-0',
        tags: ['x'.repeat(MAX_AGENT_TAG_CHARS + 1)],
      }).success,
    ).toBe(false);
    expect(
      TagAgentInputSchema.safeParse({
        agent_id: 'agent-0',
        tags: Array.from({ length: MAX_AGENT_TAGS + 1 }, (_value, index) => `t${String(index)}`),
      }).success,
    ).toBe(false);
  });

  it('declares its activity description, no accesses, and its own approval rule', () => {
    const { host } = mockHost();
    const execution = new TagAgentTool(host).resolveExecution({ agent_id: 'agent-0', tags: ['ui'] });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Tagging agent agent-0');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('TagAgent');
  });

  it('reports the applied tags', async () => {
    const { host, setAgentTags } = mockHost();
    setAgentTags.mockResolvedValue({ agentId: 'agent-0', name: 'reviewer', tags: ['ui', 'fast'] });

    const result = await executeTool(
      new TagAgentTool(host),
      context({ agent_id: 'agent-0', tags: ['ui', 'fast'] }),
    );

    expect(result).toEqual({
      output: ['agent_id: agent-0', 'name: reviewer', 'tags: ui, fast'].join('\n'),
    });
    expect(setAgentTags).toHaveBeenCalledWith('agent-0', ['ui', 'fast']);
  });

  it('reports an (none) marker when the tags were cleared', async () => {
    const { host, setAgentTags } = mockHost();
    setAgentTags.mockResolvedValue({ agentId: 'agent-0', name: 'reviewer', tags: [] });

    const result = await executeTool(
      new TagAgentTool(host),
      context({ agent_id: 'agent-0', tags: [] }),
    );

    expect(result).toEqual({ output: 'agent_id: agent-0\nname: reviewer\ntags: (none)' });
  });

  it('returns the host error as an error result', async () => {
    const { host, setAgentTags } = mockHost();
    setAgentTags.mockRejectedValue(new Error('Agent "agent-9" does not exist.'));

    const result = await executeTool(
      new TagAgentTool(host),
      context({ agent_id: 'agent-9', tags: ['ui'] }),
    );

    expect(result).toEqual({ isError: true, output: 'Agent "agent-9" does not exist.' });
  });
});

describe('RenameAgentTool', () => {
  it('rejects an empty target id or name', () => {
    expect(RenameAgentInputSchema.parse({ agent_id: 'agent-0', name: 'scout' })).toEqual({
      agent_id: 'agent-0',
      name: 'scout',
    });
    expect(RenameAgentInputSchema.safeParse({ agent_id: '', name: 'scout' }).success).toBe(false);
    expect(RenameAgentInputSchema.safeParse({ agent_id: 'agent-0', name: '' }).success).toBe(false);
  });

  it('declares its activity description, no accesses, and its own approval rule', () => {
    const { host } = mockHost();
    const execution = new RenameAgentTool(host).resolveExecution({
      agent_id: 'agent-0',
      name: 'scout',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Renaming agent agent-0 to scout');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('RenameAgent');
  });

  it('reports the new name and keeps the tags', async () => {
    const { host, renameAgent } = mockHost();
    renameAgent.mockResolvedValue({ agentId: 'agent-0', name: 'scout', tags: ['ui'] });

    const result = await executeTool(
      new RenameAgentTool(host),
      context({ agent_id: 'agent-0', name: 'scout' }),
    );

    expect(result).toEqual({
      output: ['agent_id: agent-0', 'name: scout', 'tags: ui'].join('\n'),
    });
    expect(renameAgent).toHaveBeenCalledWith('agent-0', 'scout');
  });

  it('omits the tags line for an untagged agent', async () => {
    const { host, renameAgent } = mockHost();
    renameAgent.mockResolvedValue({ agentId: 'agent-0', name: 'scout', tags: [] });

    const result = await executeTool(
      new RenameAgentTool(host),
      context({ agent_id: 'agent-0', name: 'scout' }),
    );

    expect(result).toEqual({ output: 'agent_id: agent-0\nname: scout' });
  });

  it('returns the host error as an error result', async () => {
    const { host, renameAgent } = mockHost();
    renameAgent.mockRejectedValue(new Error('An agent named "scout" already exists (agent-5).'));

    const result = await executeTool(
      new RenameAgentTool(host),
      context({ agent_id: 'agent-0', name: 'scout' }),
    );

    expect(result).toEqual({
      isError: true,
      output: 'An agent named "scout" already exists (agent-5).',
    });
  });
});

describe('StopAgentsTool', () => {
  it('requires exactly one selector and keeps the optional filters', () => {
    expect(StopAgentsInputSchema.parse({ task_ids: ['bash-1'] })).toEqual({
      task_ids: ['bash-1'],
    });
    expect(StopAgentsInputSchema.safeParse({ agent_ids: ['agent-0'] }).success).toBe(true);
    expect(StopAgentsInputSchema.safeParse({ all: true, include_foreground: true }).success).toBe(
      true,
    );
    expect(StopAgentsInputSchema.safeParse({}).success).toBe(false);
    expect(StopAgentsInputSchema.safeParse({ all: false }).success).toBe(false);
    expect(
      StopAgentsInputSchema.safeParse({ agent_ids: ['agent-0'], task_ids: ['bash-1'] }).success,
    ).toBe(false);
    expect(
      StopAgentsInputSchema.safeParse({ task_ids: ['bash-1'], reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it.each([
    [{ task_ids: ['bash-1'] }, 'Stopping 1 task'],
    [{ task_ids: ['bash-1', 'bash-2'] }, 'Stopping 2 tasks'],
    [{ agent_ids: ['agent-0'] }, 'Stopping 1 agent'],
    [{ agent_ids: ['agent-0', 'agent-1'] }, 'Stopping 2 agents'],
    [{ all: true }, 'Stopping all background tasks'],
  ])('describes %o as %s', (args, description) => {
    const { host } = mockHost();
    const execution = new StopAgentsTool(host).resolveExecution(args);

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe(description);
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('StopAgents');
  });

  it('formats the stop status, capacity, and every row', async () => {
    const { host, stopAgents } = mockHost();
    stopAgents.mockResolvedValue({
      stopped: 1,
      requested: 2,
      capacity: { running: 1, max: 4 },
      rows: [
        { taskId: 'bash-1', kind: 'process', status: 'stopped', reason: 'Stopped by StopAgents' },
        {
          taskId: 'bash-2',
          kind: 'process',
          status: 'already_terminal',
          reason: 'Task already completed',
        },
      ],
    });

    const result = await executeTool(
      new StopAgentsTool(host),
      context({ task_ids: ['bash-1', 'bash-2'] }),
    );

    expect(result).toEqual({
      isError: false,
      output: [
        'stop_status: 1/2',
        'background_capacity: 1/4',
        '---',
        'task_id: bash-1',
        'kind: process',
        'status: stopped',
        'reason: Stopped by StopAgents',
        '---',
        'task_id: bash-2',
        'kind: process',
        'status: already_terminal',
        'reason: Task already completed',
      ].join('\n'),
    });
  });

  it('forwards the camelCase request to the host', async () => {
    const { host, stopAgents } = mockHost();
    stopAgents.mockResolvedValue({
      stopped: 0,
      requested: 0,
      capacity: { running: 0 },
      rows: [],
    });

    await executeTool(
      new StopAgentsTool(host),
      context({ agent_ids: ['agent-0'], include_foreground: true, reason: 'cohort done' }),
    );

    expect(stopAgents).toHaveBeenCalledWith({
      agentIds: ['agent-0'],
      taskIds: undefined,
      all: undefined,
      includeForeground: true,
      reason: 'cohort done',
    });
  });

  it('returns the host error as an error result', async () => {
    const { host, stopAgents } = mockHost();
    stopAgents.mockRejectedValue(new Error('Agent "main" is not ready to control tasks.'));

    const result = await executeTool(new StopAgentsTool(host), context({ all: true }));

    expect(result).toEqual({
      isError: true,
      output: 'Agent "main" is not ready to control tasks.',
    });
  });
});

describe('ListAgentsTool tags', () => {
  it('renders tags only for agents that carry them', async () => {
    const listAgents = vi.fn(() => [
      { agentId: 'agent-0', name: 'reviewer', role: 'sub' as const, running: false, tags: ['ui', 'fast'] },
      { agentId: 'agent-1', role: 'sub' as const, running: true },
    ]);
    const host = { listAgents } as unknown as SessionSubagentHost;

    const result = await executeTool(new ListAgentsTool(host), context({}));

    expect(result).toEqual({
      output: [
        'Agents you can message:',
        '- reviewer (id: agent-0) — idle · tags: ui, fast',
        '- agent-1 (id: agent-1) — running',
      ].join('\n'),
    });
  });
});

describe('fleet-control tool rule subjects and non-Error rejections', () => {
  it('matches approval rules against the resolved subject', () => {
    const { host } = mockHost();

    const dismiss = runnable(
      new DismissAgentsTool(host).resolveExecution({ names: ['reviewer', 'ghost'] }),
    );
    const dismissById = runnable(
      new DismissAgentsTool(host).resolveExecution({ ids: ['agent-0', 'agent-1'] }),
    );
    const dismissAll = runnable(new DismissAgentsTool(host).resolveExecution({ all: true }));
    const stopAgents = runnable(
      new StopAgentsTool(host).resolveExecution({ agent_ids: ['agent-0'] }),
    );
    const stopAgent = runnable(new StopAgentTool(host).resolveExecution({ agent_id: 'agent-0' }));
    const interrupt = runnable(
      new InterruptAgentTool(host).resolveExecution({ agent_id: 'agent-0' }),
    );
    const tag = runnable(
      new TagAgentTool(host).resolveExecution({ agent_id: 'agent-0', tags: ['ui'] }),
    );
    const rename = runnable(
      new RenameAgentTool(host).resolveExecution({ agent_id: 'agent-0', name: 'scout' }),
    );

    expect(dismiss.matchesRule?.('reviewer,ghost')).toBe(true);
    expect(dismiss.matchesRule?.('someone-else')).toBe(false);
    expect(dismissById.matchesRule?.('agent-0,agent-1')).toBe(true);
    expect(dismissById.matchesRule?.('agent-9')).toBe(false);
    expect(dismissAll.matchesRule?.('all')).toBe(true);
    expect(stopAgents.matchesRule?.('agent-0')).toBe(true);
    expect(stopAgents.matchesRule?.('agent-9')).toBe(false);
    expect(stopAgent.matchesRule?.('agent-0')).toBe(true);
    expect(stopAgent.matchesRule?.('agent-9')).toBe(false);
    expect(interrupt.matchesRule?.('agent-0')).toBe(true);
    expect(interrupt.matchesRule?.('agent-9')).toBe(false);
    expect(tag.matchesRule?.('agent-0')).toBe(true);
    expect(tag.matchesRule?.('agent-9')).toBe(false);
    expect(rename.matchesRule?.('agent-0')).toBe(true);
    expect(rename.matchesRule?.('agent-9')).toBe(false);
  });

  it.each(['StopAgent', 'InterruptAgent', 'DismissAgents', 'TagAgent', 'RenameAgent', 'StopAgents'] as const)(
    '%s stringifies a non-Error host rejection as text',
    async (toolName) => {
      const { host, ...methods } = mockHost();
      const args = rejectionArgsFor(toolName);
      const method = fleetHostMethodFor(toolName);
      (methods[method] as ReturnType<typeof vi.fn>).mockRejectedValue('host failure');

      const result = await executeTool(fleetToolFor(toolName, host), context(args));

      expect(result).toEqual({ isError: true, output: 'host failure' });
    },
  );
});

type FleetToolName =
  | 'StopAgent'
  | 'InterruptAgent'
  | 'DismissAgents'
  | 'TagAgent'
  | 'RenameAgent'
  | 'StopAgents';

function runnable(execution: ToolExecution): RunnableToolExecution {
  if (execution.isError === true) throw new Error('expected runnable execution');
  return execution;
}

function fleetToolFor(name: FleetToolName, host: SessionSubagentHost) {
  switch (name) {
    case 'StopAgent':
      return new StopAgentTool(host);
    case 'InterruptAgent':
      return new InterruptAgentTool(host);
    case 'DismissAgents':
      return new DismissAgentsTool(host);
    case 'TagAgent':
      return new TagAgentTool(host);
    case 'RenameAgent':
      return new RenameAgentTool(host);
    case 'StopAgents':
      return new StopAgentsTool(host);
  }
}

function fleetHostMethodFor(name: FleetToolName) {
  switch (name) {
    case 'StopAgent':
      return 'stopAgent' as const;
    case 'InterruptAgent':
      return 'interruptAgent' as const;
    case 'DismissAgents':
      return 'dismissAgents' as const;
    case 'TagAgent':
      return 'setAgentTags' as const;
    case 'RenameAgent':
      return 'renameAgent' as const;
    case 'StopAgents':
      return 'stopAgents' as const;
  }
}

function rejectionArgsFor(name: FleetToolName): Record<string, unknown> {
  switch (name) {
    case 'StopAgent':
    case 'InterruptAgent':
      return { agent_id: 'agent-0' };
    case 'TagAgent':
      return { agent_id: 'agent-0', tags: [] };
    case 'RenameAgent':
      return { agent_id: 'agent-0', name: 'scout' };
    case 'DismissAgents':
    case 'StopAgents':
      return { all: true };
  }
}
