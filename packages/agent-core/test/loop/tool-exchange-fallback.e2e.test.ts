/**
 * Post-rejection resend fallbacks in `executeLoopStep`.
 *
 * Strict resend: when a strict provider rejects a step with a
 * tool_use/tool_result adjacency 400, the same history would be re-sent every
 * turn and the session would stay stuck forever. `executeLoopStep` resends
 * ONCE with a strict, guaranteed wire-compliant rebuild
 * (`buildMessagesStrict`).
 *
 * Media-degraded resend: when the provider rejects the request BODY as too
 * large (HTTP 413, `APIRequestTooLargeError` — accumulated base64 media, not
 * tokens), the step first resends with the media-degraded projection
 * (`buildMessagesMediaDegraded`). If that is still too large, one final
 * all-media-stripped projection is attempted. Later steps keep using the
 * projection that recovered so each step does not pay a fresh 413.
 *
 * Any other error propagates unchanged and the builders are never consulted.
 */

import { APIRequestTooLargeError, APIStatusError, type Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  createLoopEventDispatcher,
  runTurn,
  type LoopMessageBuilder,
  type RunTurnInput,
} from '../../src/loop/index';
import { CollectingSink } from './fixtures/collecting-sink';
import { FakeLLM, makeEndTurnResponse, makeToolCall, makeToolUseResponse } from './fixtures/fake-llm';
import { RecordingContext } from './fixtures/recording-context';
import { EchoTool } from './fixtures/tools';

const ADJACENCY_400 = new APIStatusError(
  400,
  'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: ' +
    'toolu_01MWFhDRqdbB4nzCJNuWYiun. Each `tool_use` block must have a corresponding ' +
    '`tool_result` block in the next message.',
);

// The OpenAI-compatible (Moonshot / Kimi) phrasing of the same tool-exchange
// structural rejection. Verbatim from the field, doubled space included.
const MOONSHOT_TOOL_CALL_ID_400 = new APIStatusError(400, '400 tool_call_id  is not found');

// The OpenAI / DeepSeek phrasing of an orphan `tool` result — a `tool` message
// with no preceding assistant `tool_calls`. This is what a DeepSeek / OpenAI-
// compatible provider returns for a history bricked by a stray tool result.
const OPENAI_ROLE_TOOL_400 = new APIStatusError(
  400,
  "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
);

// Verbatim from the live Anthropic API after a mid-session model switch left an
// OpenAI Responses Fernet blob (`gAAAAAB…`) in a ThinkPart's `encrypted` slot,
// which the Anthropic adapter then replayed as its own `signature`.
const THINKING_SIGNATURE_400 = new APIStatusError(
  400,
  'messages.1.content.0: Invalid `signature` in `thinking` block',
);

// The sibling replay rejection: the latest assistant turn's thinking blocks
// were altered since the original response.
const THINKING_MODIFIED_400 = new APIStatusError(
  400,
  'messages.5.content.0: thinking or redacted_thinking blocks in the latest assistant message ' +
    'cannot be modified',
);

// The configuration family, which must NOT trigger a strip: the request shape
// is wrong, and no amount of history repair fixes it.
const THINKING_CONFIG_400 = new APIStatusError(
  400,
  'thinking.type.enabled is not supported for this model',
);

function userMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

interface Harness {
  readonly input: RunTurnInput;
  readonly llm: FakeLLM;
  readonly strictCalls: { count: number };
  readonly strictMessages: Message[];
}

function makeHarness(error: unknown): Harness {
  const llm = new FakeLLM({
    responses: [makeEndTurnResponse('unused'), makeEndTurnResponse('recovered')],
    throwOnIndex: { index: 0, error },
  });
  const context = new RecordingContext({ messages: [userMessage('normal projection')] });
  const sink = new CollectingSink({});
  const strictMessages: Message[] = [userMessage('strict projection')];
  const strictCalls = { count: 0 };
  const buildMessagesStrict: LoopMessageBuilder = () => {
    strictCalls.count += 1;
    return strictMessages;
  };
  const input: RunTurnInput = {
    turnId: 'turn-1',
    signal: new AbortController().signal,
    llm,
    buildMessages: context.buildMessages,
    buildMessagesStrict,
    dispatchEvent: createLoopEventDispatcher({
      appendTranscriptRecord: context.appendTranscriptRecord,
      emitLiveEvent: sink.emit,
    }),
  };
  return { input, llm, strictCalls, strictMessages };
}

describe('executeLoopStep — tool exchange adjacency fallback', () => {
  it('resends once with strict messages after an adjacency 400 and recovers', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(ADJACENCY_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    // The first attempt used the normal projection; the resend used the strict one.
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('resends once and recovers after a Moonshot tool_call_id-not-found 400', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(MOONSHOT_TOOL_CALL_ID_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('resends once and recovers after an OpenAI/DeepSeek role-tool 400', async () => {
    const { input, llm, strictCalls, strictMessages } = makeHarness(OPENAI_ROLE_TOOL_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the strict resend.
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(strictMessages);
  });

  it('does not resend for an unrelated 400 — the error propagates and strict is untouched', async () => {
    const { input, llm, strictCalls } = makeHarness(new APIStatusError(400, 'Bad request'));

    await expect(runTurn(input)).rejects.toThrow('Bad request');

    expect(llm.callCount).toBe(1);
    expect(strictCalls.count).toBe(0);
  });

  it('resends only once: if the strict rebuild is also rejected, it gives up (no loop)', async () => {
    // Throw a recoverable structural 400 on every attempt; the loop must stop
    // after exactly two provider calls (first attempt + one strict resend).
    const llm = new FakeLLM({ responses: [] });
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      throw ADJACENCY_400;
    };
    const context = new RecordingContext({ messages: [userMessage('normal')] });
    const sink = new CollectingSink({});
    let strictCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesStrict: () => {
        strictCount += 1;
        return [userMessage('strict')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(ADJACENCY_400);
    expect(calls).toBe(2); // first attempt + one strict resend, then give up
    expect(strictCount).toBe(1);
  });
});

describe('executeLoopStep — request-too-large media-degraded fallback', () => {
  const REQUEST_TOO_LARGE = new APIRequestTooLargeError(413, 'Request exceeds the maximum size');

  interface MediaHarness {
    readonly input: RunTurnInput;
    readonly llm: FakeLLM;
    readonly degradedCalls: { count: number };
    readonly degradedMessages: Message[];
    readonly strictCalls: { count: number };
    readonly normalCalls: { count: number };
  }

  function makeMediaHarness(
    error: unknown,
    extra: Partial<Pick<RunTurnInput, 'tools'>> & { responses?: number } = {},
  ): MediaHarness {
    const responseCount = extra.responses ?? 2;
    const llm = new FakeLLM({
      responses: Array.from({ length: responseCount }, (_, index) =>
        makeEndTurnResponse(index === 0 ? 'unused' : 'recovered'),
      ),
      throwOnIndex: { index: 0, error },
    });
    const sink = new CollectingSink({});
    const normalCalls = { count: 0 };
    const normalMessages: Message[] = [userMessage('normal projection')];
    const context = new RecordingContext({ messages: normalMessages });
    const buildMessages: LoopMessageBuilder = () => {
      normalCalls.count += 1;
      return normalMessages;
    };
    const degradedMessages: Message[] = [userMessage('media-degraded projection')];
    const degradedCalls = { count: 0 };
    const buildMessagesMediaDegraded: LoopMessageBuilder = () => {
      degradedCalls.count += 1;
      return degradedMessages;
    };
    const strictCalls = { count: 0 };
    const buildMessagesStrict: LoopMessageBuilder = () => {
      strictCalls.count += 1;
      return [userMessage('strict projection')];
    };
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages,
      buildMessagesStrict,
      buildMessagesMediaDegraded,
      tools: extra.tools,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };
    return { input, llm, degradedCalls, degradedMessages, strictCalls, normalCalls };
  }

  it('resends once with the media-degraded projection after a request-too-large 413 and recovers', async () => {
    const { input, llm, degradedCalls, degradedMessages, strictCalls } =
      makeMediaHarness(REQUEST_TOO_LARGE);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the degraded resend —
    // and the strict builder is never consulted for a body-size rejection.
    expect(llm.callCount).toBe(2);
    expect(degradedCalls.count).toBe(1);
    expect(strictCalls.count).toBe(0);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(degradedMessages);
  });

  it('does not degrade for an unclassified 413 — the error propagates', async () => {
    const { input, llm, degradedCalls } = makeMediaHarness(
      new APIStatusError(413, 'Request failed'),
    );

    await expect(runTurn(input)).rejects.toThrow('Request failed');

    expect(llm.callCount).toBe(1);
    expect(degradedCalls.count).toBe(0);
  });

  it('resends only once: a degraded rebuild that is also rejected gives up (no loop)', async () => {
    const llm = new FakeLLM({ responses: [] });
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      throw REQUEST_TOO_LARGE;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal')] });
    let degradedCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => {
        degradedCount += 1;
        return [userMessage('degraded')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(REQUEST_TOO_LARGE);
    expect(calls).toBe(2); // first attempt + one degraded resend, then give up
    expect(degradedCount).toBe(1);
  });

  it('propagates a later 413 without reintroducing media when the turn is already stripped', async () => {
    const echo = new EchoTool();
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts <= 2) throw REQUEST_TOO_LARGE;
      if (attempts === 3) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-stripped')]);
      }
      throw REQUEST_TOO_LARGE;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const degradedMessages = [userMessage('media-degraded projection')];
    const strippedMessages = [userMessage('media-stripped projection')];
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => degradedMessages,
      buildMessagesMediaStripped: () => strippedMessages,
      tools: [echo],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(REQUEST_TOO_LARGE);

    expect(attempts).toBe(4);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(degradedMessages);
    expect(llm.calls[2]?.messages).toBe(strippedMessages);
    expect(llm.calls[3]?.messages).toBe(strippedMessages);
    expect(llm.calls[3]?.requestLogFields).toMatchObject({ projection: 'media-stripped' });
    expect(echo.calls).toHaveLength(1);
  });

  it('skips a duplicate degraded retry when the active degraded projection receives 413', async () => {
    const echo = new EchoTool();
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts === 1 || attempts === 3) throw REQUEST_TOO_LARGE;
      if (attempts === 2) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-degraded')]);
      }
      return makeEndTurnResponse('recovered');
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const degradedMessages = [userMessage('media-degraded projection')];
    const strippedMessages = [userMessage('media-stripped projection')];
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => degradedMessages,
      buildMessagesMediaStripped: () => strippedMessages,
      tools: [echo],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(attempts).toBe(4);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(degradedMessages);
    expect(llm.calls[2]?.messages).toBe(degradedMessages);
    expect(llm.calls[3]?.messages).toBe(strippedMessages);
    expect(llm.calls[2]?.requestLogFields).toMatchObject({ projection: 'media-degraded' });
    expect(llm.calls[3]?.requestLogFields).toMatchObject({ projection: 'media-stripped' });
    expect(echo.calls).toHaveLength(1);
  });

  it('strips all media when the degraded resend exposes an unsupported image format', async () => {
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts === 1) throw REQUEST_TOO_LARGE;
      if (attempts === 2) throw new APIStatusError(400, 'unsupported image format');
      return makeEndTurnResponse('recovered');
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const degradedMessages = [userMessage('media-degraded projection')];
    const strippedMessages = [userMessage('media-stripped projection')];
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => degradedMessages,
      buildMessagesMediaStripped: () => strippedMessages,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(attempts).toBe(3);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(degradedMessages);
    expect(llm.calls[1]?.requestLogFields).toMatchObject({ projection: 'media-degraded' });
    expect(llm.calls[2]?.messages).toBe(strippedMessages);
    expect(llm.calls[2]?.requestLogFields).toMatchObject({ projection: 'media-stripped' });
  });

  it('stops after the all-media-stripped attempt when every projection receives 413', async () => {
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      throw REQUEST_TOO_LARGE;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => [userMessage('media-degraded projection')],
      buildMessagesMediaStripped: () => [userMessage('media-stripped projection')],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(REQUEST_TOO_LARGE);
    expect(attempts).toBe(3);
  });

  it('gives up when the all-media-stripped resend from an already-degraded step is rejected', async () => {
    // Step 1 recovers via the degraded projection; step 2 starts degraded, is
    // rejected again, and its final all-media-stripped attempt also fails —
    // the request cannot be reduced further, so that error propagates.
    const echo = new EchoTool();
    const llm = new FakeLLM({ responses: [] });
    const strippedRejection = new APIRequestTooLargeError(413, 'still too large after stripping');
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts === 1) throw REQUEST_TOO_LARGE;
      if (attempts === 2) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]);
      }
      if (attempts === 3) throw REQUEST_TOO_LARGE;
      throw strippedRejection;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const degradedMessages = [userMessage('media-degraded projection')];
    const strippedMessages = [userMessage('media-stripped projection')];
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => degradedMessages,
      buildMessagesMediaStripped: () => strippedMessages,
      tools: [echo],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(strippedRejection);

    expect(attempts).toBe(4);
    expect(llm.calls[3]?.messages).toBe(strippedMessages);
    expect(llm.calls[3]?.requestLogFields).toMatchObject({ projection: 'media-stripped' });
  });

  it('ranks the degraded projection above the thinking-stripped one once both latch', async () => {
    // Both latches can be set within one turn. Media wins for later steps: the
    // thinking-stripped rebuild carries full media and would deterministically
    // re-earn the 413, whose inner ladder has no thinking rung to fall back on.
    const echo = new EchoTool();
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      // Step 1: thinking 400 -> stripped resend -> tool call.
      if (attempts === 1) throw THINKING_SIGNATURE_400;
      if (attempts === 2) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'a' }, 'tc-1')]);
      }
      // Step 2 (already thinking-stripped): 413 -> degraded resend -> tool call.
      if (attempts === 3) throw REQUEST_TOO_LARGE;
      if (attempts === 4) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'b' }, 'tc-2')]);
      }
      return makeEndTurnResponse('done');
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const degradedMessages = [userMessage('media-degraded projection')];
    const thinkingStrippedMessages = [userMessage('thinking-stripped projection')];
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => degradedMessages,
      buildMessagesThinkingStripped: () => thinkingStrippedMessages,
      tools: [echo],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(thinkingStrippedMessages);
    expect(llm.calls[2]?.messages).toBe(thinkingStrippedMessages);
    expect(llm.calls[3]?.messages).toBe(degradedMessages);
    // Step 3 builds from the media projection, not the thinking-stripped one.
    expect(llm.calls[4]?.messages).toBe(degradedMessages);
    expect(llm.calls[4]?.requestLogFields).toMatchObject({ projection: 'media-degraded' });
    expect(echo.calls).toHaveLength(2);
  });

  it('propagates a thinking rejection raised by the media-degraded resend (v1 ladder is flat)', async () => {
    // Documents a real v1 limitation: the 413 rung's inner recovery handles
    // only media errors, so a thinking 400 surfacing there is not caught by the
    // sibling thinking rung. v2's policy object composes the two axes; v1's
    // if/else-if chain cannot, and deepening the nesting is not worth it for
    // the legacy engine.
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts === 1) throw REQUEST_TOO_LARGE;
      throw THINKING_SIGNATURE_400;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    let thinkingCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesMediaDegraded: () => [userMessage('media-degraded projection')],
      buildMessagesThinkingStripped: () => {
        thinkingCount += 1;
        return [userMessage('thinking-stripped projection')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(THINKING_SIGNATURE_400);

    expect(attempts).toBe(2);
    expect(thinkingCount).toBe(0);
  });

  it('keeps using the degraded projection for later steps of the same turn', async () => {
    // Step 1 is rejected with a 413 and recovers via the degraded projection,
    // then issues a tool call; step 2 must build from the degraded projection
    // directly — re-sending the full-media history would deterministically
    // pay a fresh 413 on every step.
    const echo = new EchoTool();
    const llm = new FakeLLM({
      responses: [
        makeEndTurnResponse('unused'),
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      throwOnIndex: { index: 0, error: REQUEST_TOO_LARGE },
    });
    const harness = makeMediaHarness(REQUEST_TOO_LARGE);
    const input: RunTurnInput = {
      ...harness.input,
      llm,
      tools: [echo],
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(3);
    // Step 1: normal projection rejected, degraded resend recovers.
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(harness.degradedMessages);
    // Step 2: built straight from the degraded projection, not the normal one.
    expect(llm.calls[2]?.messages).toBe(harness.degradedMessages);
    expect(harness.normalCalls.count).toBe(1);
    expect(harness.degradedCalls.count).toBe(2);
    expect(echo.calls).toHaveLength(1);
  });
});

/**
 * Thinking-stripped resend.
 *
 * `ThinkPart.encrypted` is one untagged slot written by three incompatible
 * providers. Switching models mid-session used to hand Anthropic another
 * provider's blob as its own `signature`; Anthropic verifies it and answers
 * `400 messages.1.content.0: Invalid \`signature\` in \`thinking\` block`. The
 * offending block sits in the replayed history, so every later turn re-earns
 * the same 400 and the session is permanently bricked.
 *
 * The rung resends ONCE with every think part removed from every message
 * (text and tool calls kept). A total strip is verified against the live API
 * as accepted even when the latest assistant turn carried thinking plus
 * `tool_use`, so there is no special-casing by position or error subtype.
 *
 * v1 has no durable recovery state: the latch is a `runTurn` local, so a
 * session re-pays one 400 per turn. v1 is reachable only via
 * `KIMI_CODE_LEGACY_FLAG` / the VS Code `kimi.useAgentCoreV1` setting, so that
 * cost is accepted rather than papered over with a persistence layer.
 */
describe('executeLoopStep — thinking-signature stripped-thinking fallback', () => {
  interface ThinkingHarness {
    readonly input: RunTurnInput;
    readonly llm: FakeLLM;
    readonly thinkingCalls: { count: number };
    readonly thinkingStrippedMessages: Message[];
    readonly strictCalls: { count: number };
    readonly normalCalls: { count: number };
  }

  function makeThinkingHarness(
    error: unknown,
    extra: { readonly withBuilder?: boolean; readonly tools?: RunTurnInput['tools'] } = {},
  ): ThinkingHarness {
    const llm = new FakeLLM({
      responses: [makeEndTurnResponse('unused'), makeEndTurnResponse('recovered')],
      throwOnIndex: { index: 0, error },
    });
    const sink = new CollectingSink({});
    const normalMessages: Message[] = [userMessage('normal projection')];
    const context = new RecordingContext({ messages: normalMessages });
    const normalCalls = { count: 0 };
    const buildMessages: LoopMessageBuilder = () => {
      normalCalls.count += 1;
      return normalMessages;
    };
    const thinkingStrippedMessages: Message[] = [userMessage('thinking-stripped projection')];
    const thinkingCalls = { count: 0 };
    const buildMessagesThinkingStripped: LoopMessageBuilder = () => {
      thinkingCalls.count += 1;
      return thinkingStrippedMessages;
    };
    const strictCalls = { count: 0 };
    const buildMessagesStrict: LoopMessageBuilder = () => {
      strictCalls.count += 1;
      return [userMessage('strict projection')];
    };
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages,
      buildMessagesStrict,
      buildMessagesThinkingStripped:
        extra.withBuilder === false ? undefined : buildMessagesThinkingStripped,
      tools: extra.tools,
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };
    return { input, llm, thinkingCalls, thinkingStrippedMessages, strictCalls, normalCalls };
  }

  it('resends once with thinking stripped after an invalid-signature 400 and recovers', async () => {
    const { input, llm, thinkingCalls, thinkingStrippedMessages, strictCalls } =
      makeThinkingHarness(THINKING_SIGNATURE_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    // Exactly two provider calls: the rejected one and the stripped resend —
    // and the strict builder is never consulted, because a strict
    // re-projection does not touch thinking blocks and would fail identically.
    expect(llm.callCount).toBe(2);
    expect(thinkingCalls.count).toBe(1);
    expect(strictCalls.count).toBe(0);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(thinkingStrippedMessages);
  });

  it('labels the stripped resend with the thinking-stripped projection', async () => {
    const { input, llm } = makeThinkingHarness(THINKING_SIGNATURE_400);

    await runTurn(input);

    expect(llm.calls[1]?.requestLogFields).toMatchObject({ projection: 'thinking-stripped' });
  });

  it('resends once after a latest-assistant-thinking-modified 400 and recovers', async () => {
    const { input, llm, thinkingCalls, thinkingStrippedMessages } = makeThinkingHarness(
      THINKING_MODIFIED_400,
    );

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(thinkingCalls.count).toBe(1);
    expect(llm.calls[1]?.messages).toBe(thinkingStrippedMessages);
  });

  it('does not strip for an Anthropic thinking CONFIGURATION 400 — the error propagates', async () => {
    // A request-shape problem, not a poisoned history: stripping cannot help.
    const { input, llm, thinkingCalls } = makeThinkingHarness(THINKING_CONFIG_400);

    await expect(runTurn(input)).rejects.toThrow(APIStatusError);

    expect(llm.callCount).toBe(1);
    expect(thinkingCalls.count).toBe(0);
  });

  it('does not strip for an unrelated 400 — the error propagates', async () => {
    const { input, llm, thinkingCalls } = makeThinkingHarness(new APIStatusError(400, 'Bad request'));

    await expect(runTurn(input)).rejects.toThrow(/Bad request/);

    expect(llm.callCount).toBe(1);
    expect(thinkingCalls.count).toBe(0);
  });

  it('propagates the 400 unchanged when the host supplied no thinking-stripped builder', async () => {
    const { input, llm, strictCalls } = makeThinkingHarness(THINKING_SIGNATURE_400, {
      withBuilder: false,
    });

    await expect(runTurn(input)).rejects.toBe(THINKING_SIGNATURE_400);

    expect(llm.callCount).toBe(1);
    expect(strictCalls.count).toBe(0);
  });

  it('resends only once: a stripped rebuild that is also rejected gives up (no loop)', async () => {
    const llm = new FakeLLM({ responses: [] });
    let calls = 0;
    llm.chat = async () => {
      calls += 1;
      throw THINKING_SIGNATURE_400;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal')] });
    let thinkingCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesThinkingStripped: () => {
        thinkingCount += 1;
        return [userMessage('thinking-stripped')];
      },
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(THINKING_SIGNATURE_400);
    expect(calls).toBe(2); // first attempt + one stripped resend, then give up
    expect(thinkingCount).toBe(1);
  });

  it('keeps using the thinking-stripped projection for later steps of the same turn', async () => {
    // Step 1 is rejected and recovers via the strip, then issues a tool call;
    // step 2 must build from the stripped projection directly — the poisoned
    // block is still in history and would earn a fresh 400 on every step.
    const echo = new EchoTool();
    const llm = new FakeLLM({
      responses: [
        makeEndTurnResponse('unused'),
        makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]),
        makeEndTurnResponse('done'),
      ],
      throwOnIndex: { index: 0, error: THINKING_SIGNATURE_400 },
    });
    const harness = makeThinkingHarness(THINKING_SIGNATURE_400, { tools: [echo] });
    const input: RunTurnInput = { ...harness.input, llm, tools: [echo] };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(3);
    expect(llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(llm.calls[1]?.messages).toBe(harness.thinkingStrippedMessages);
    expect(llm.calls[2]?.messages).toBe(harness.thinkingStrippedMessages);
    expect(harness.normalCalls.count).toBe(1);
    expect(harness.thinkingCalls.count).toBe(2);
    expect(echo.calls).toHaveLength(1);
  });

  it('propagates without a duplicate resend when the step is already thinking-stripped', async () => {
    // Step 2 already builds from the stripped projection; re-sending the very
    // same messages could not change the outcome, so the 400 propagates.
    const echo = new EchoTool();
    const llm = new FakeLLM({ responses: [] });
    let attempts = 0;
    llm.chat = async (params) => {
      llm.calls.push(params);
      attempts += 1;
      if (attempts === 1) throw THINKING_SIGNATURE_400;
      if (attempts === 2) {
        return makeToolUseResponse([makeToolCall('echo', { text: 'hi' }, 'tc-1')]);
      }
      throw THINKING_SIGNATURE_400;
    };
    const sink = new CollectingSink({});
    const context = new RecordingContext({ messages: [userMessage('normal projection')] });
    const thinkingStrippedMessages = [userMessage('thinking-stripped projection')];
    let thinkingCount = 0;
    const input: RunTurnInput = {
      turnId: 'turn-1',
      signal: new AbortController().signal,
      llm,
      buildMessages: context.buildMessages,
      buildMessagesThinkingStripped: () => {
        thinkingCount += 1;
        return thinkingStrippedMessages;
      },
      tools: [echo],
      dispatchEvent: createLoopEventDispatcher({
        appendTranscriptRecord: context.appendTranscriptRecord,
        emitLiveEvent: sink.emit,
      }),
    };

    await expect(runTurn(input)).rejects.toBe(THINKING_SIGNATURE_400);

    // Step 1 attempt + stripped resend + step 2 (already stripped, no resend).
    expect(attempts).toBe(3);
    expect(thinkingCount).toBe(2);
    expect(llm.calls[2]?.messages).toBe(thinkingStrippedMessages);
    expect(llm.calls[2]?.requestLogFields).toMatchObject({ projection: 'thinking-stripped' });
  });

  it('re-pays one 400 on the next turn — v1 keeps no recovery state across turns', async () => {
    // Documents the accepted v1 limitation: `thinkingStrippedActive` is a
    // `runTurn` local, so a fresh turn starts from the normal projection again.
    const first = makeThinkingHarness(THINKING_SIGNATURE_400);
    await runTurn(first.input);
    const second = makeThinkingHarness(THINKING_SIGNATURE_400);

    await runTurn(second.input);

    expect(second.llm.callCount).toBe(2);
    expect(second.llm.calls[0]?.messages).toEqual([userMessage('normal projection')]);
    expect(second.thinkingCalls.count).toBe(1);
  });

  it('still routes a structural 400 to the strict builder, not the thinking one', async () => {
    const { input, llm, strictCalls, thinkingCalls } = makeThinkingHarness(ADJACENCY_400);

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(llm.callCount).toBe(2);
    expect(strictCalls.count).toBe(1);
    expect(thinkingCalls.count).toBe(0);
  });

  it('still routes a 413 to the media builder, not the thinking one', async () => {
    const harness = makeThinkingHarness(
      new APIRequestTooLargeError(413, 'Request exceeds the maximum size'),
    );
    const degradedMessages = [userMessage('media-degraded projection')];
    const input: RunTurnInput = {
      ...harness.input,
      buildMessagesMediaDegraded: () => degradedMessages,
    };

    const result = await runTurn(input);

    expect(result.stopReason).toBe('end_turn');
    expect(harness.llm.calls[1]?.messages).toBe(degradedMessages);
    expect(harness.thinkingCalls.count).toBe(0);
  });
});
