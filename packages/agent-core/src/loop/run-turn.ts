/**
 * Turn-level loop for a stateless agent run.
 *
 * Owns convergence across steps: abort checks at loop boundaries, max-step
 * enforcement, usage aggregation, optional continuation after non-tool stops,
 * and final `TurnResult` mapping. One-step execution lives in `turn-step.ts`.
 */

import { addUsage, emptyUsage, type TokenUsage } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';

import { isUserCancellation } from '../utils/abort';
import {
  createMaxStepsExceededError,
  errorMessage,
  isAbortError,
  isMaxStepsExceededError,
} from './errors';
import type { LoopInterruptReason, LoopEventDispatcher, LoopTurnInterruptedEvent } from './events';
import type { LLM, LLMRequestTrace } from './llm';
import { executeLoopStep } from './turn-step';
import type {
  ExecutableTool,
  LoopHooks,
  LoopMessageBuilder,
  RecordStepUsageResult,
  LoopTerminalStepStopReason,
  LoopTurnStopReason,
  TurnResult,
} from './types';

export interface RunTurnInput {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly llm: LLM;
  readonly buildMessages: LoopMessageBuilder;
  /**
   * Optional strict, guaranteed wire-compliant rebuild of the request messages.
   * Used only to resend once after a provider rejects the normal projection with
   * a tool_use/tool_result adjacency 400 (see `executeLoopStep`).
   */
  readonly buildMessagesStrict?: LoopMessageBuilder | undefined;
  /**
   * Optional media-degraded rebuild of the request messages: old media parts
   * replaced by text markers, the most recent kept. Used to resend once after
   * the provider rejects the request body as too large (HTTP 413 on
   * accumulated media, see `executeLoopStep`); after a successful degraded
   * resend, later steps of the same turn build from this projection directly
   * so each step does not pay a fresh rejection.
   */
  readonly buildMessagesMediaDegraded?: LoopMessageBuilder | undefined;
  /**
   * Optional media-stripped rebuild of the request messages: EVERY media
   * part replaced by a text marker. Used to resend once after the provider
   * rejects an image's format, or as the final fallback when a request stays
   * too large after keeping only recent media (see `executeLoopStep`). After
   * a successful stripped resend, later steps of the same turn build from
   * this projection directly.
   */
  readonly buildMessagesMediaStripped?: LoopMessageBuilder | undefined;
  /**
   * Optional thinking-stripped rebuild of the request messages: EVERY thinking
   * part removed from every message, text and tool calls kept. Used to resend
   * once after the provider rejects its own `thinking` blocks — an
   * unverifiable `signature` (a reasoning blob from a different wire, replayed
   * after a mid-session model switch) or altered thinking in the latest
   * assistant message (see `executeLoopStep`). After a successful stripped
   * resend, later steps of the same turn build from this projection directly.
   *
   * The latch is turn-local, so a later turn starts from the normal projection
   * and re-pays one rejection. v1 keeps no durable recovery state of any kind
   * (`mediaDegradedActive` / `mediaStrippedActive` are locals too) and is
   * reachable only behind `KIMI_CODE_LEGACY_FLAG` / `kimi.useAgentCoreV1`, so
   * that cost is accepted rather than papered over with a persistence layer.
   */
  readonly buildMessagesThinkingStripped?: LoopMessageBuilder | undefined;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly tools?: readonly ExecutableTool[] | undefined;
  /**
   * Per-step tool table builder. When present it wins over `tools` and is
   * re-invoked before every step, so a tool loaded mid-turn (select_tools
   * schema injection) is dispatchable on the very next step and runtime tool
   * visibility stays fresh. `tools` remains as the
   * static per-turn snapshot for hosts without dynamic tool tables.
   */
  readonly buildTools?: (() => readonly ExecutableTool[]) | undefined;
  /**
   * Optional wording override for a tool call whose name resolves to no
   * executable tool. Lets the host distinguish "loaded but its server is
   * disconnected" from a plain unknown name under progressive disclosure.
   * Returning `undefined` keeps the default "not found" message.
   */
  readonly describeMissingTool?: ((name: string) => string | undefined) | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly maxSteps?: number | undefined;
  readonly maxRetryAttempts?: number;
  readonly recordStepUsage?:
    | ((usage: TokenUsage) => RecordStepUsageResult | void | Promise<RecordStepUsageResult | void>)
    | undefined;
  readonly onRequestTrace?: (trace: LLMRequestTrace) => void;
}

export async function runTurn(input: RunTurnInput): Promise<TurnResult> {
  const {
    turnId,
    signal,
    llm,
    buildMessages,
    buildMessagesStrict,
    buildMessagesMediaDegraded,
    buildMessagesMediaStripped,
    buildMessagesThinkingStripped,
    dispatchEvent,
    tools,
    buildTools,
    describeMissingTool,
    hooks,
    log,
    maxSteps,
    maxRetryAttempts,
    recordStepUsage: hostRecordStepUsage,
    onRequestTrace,
  } = input;
  let usage: TokenUsage = emptyUsage();
  let steps = 0;
  // Normal exits overwrite this with the completed step's stop reason.
  let stopReason: LoopTurnStopReason = 'end_turn';
  let activeStep: number | undefined;
  let activeRequestTrace: LLMRequestTrace | undefined;
  // Once a step only succeeded via the media-degraded resend, later steps of
  // this turn build from the degraded projection directly: the full-media
  // history is deterministically over the provider's body-size limit, so
  // rebuilding it would pay a fresh rejection on every step.
  let mediaDegradedActive = false;
  // Same for the media-stripped resend after an image-format rejection or a
  // second 413: the rejected media is still in history, so later steps stay
  // stripped.
  let mediaStrippedActive = false;
  // Same for the thinking-stripped resend after the provider refused its own
  // `thinking` blocks: the offending block is still in history, so later steps
  // of this turn skip it. Ranked BELOW both media projections — the
  // thinking-stripped rebuild carries full media, and re-earning a 413 leads
  // into a recovery ladder that has no thinking rung to fall back on. When both
  // axes are active the thinking rung simply re-fires per step, which is
  // bounded at one extra rejection plus one resend.
  let thinkingStrippedActive = false;
  const recordStepUsage = async (
    stepUsage: TokenUsage,
  ): Promise<RecordStepUsageResult | void> => {
    usage = addUsage(usage, stepUsage);
    return hostRecordStepUsage?.(stepUsage);
  };
  const captureRequestTrace = (trace: LLMRequestTrace): void => {
    activeRequestTrace = trace;
    onRequestTrace?.(trace);
  };

  try {
    while (true) {
      signal.throwIfAborted();

      if (maxSteps !== undefined && maxSteps > 0 && steps >= maxSteps) {
        throw createMaxStepsExceededError(maxSteps);
      }

      steps += 1;
      activeStep = steps;
      activeRequestTrace = undefined;
      const projection = selectStepProjection({
        buildMessages,
        buildMessagesMediaDegraded,
        buildMessagesMediaStripped,
        buildMessagesThinkingStripped,
        mediaDegradedActive,
        mediaStrippedActive,
        thinkingStrippedActive,
      });
      const stepResult = await executeLoopStep({
        turnId,
        signal,
        buildMessages: projection.buildMessages,
        initialMediaProjection: projection.mediaProjection,
        initialThinkingStripped: projection.thinkingStripped,
        buildMessagesStrict,
        buildMessagesMediaDegraded,
        buildMessagesMediaStripped,
        buildMessagesThinkingStripped,
        dispatchEvent,
        llm,
        tools,
        // Passed through unresolved: the step evaluates it AFTER beforeStep,
        // next to buildMessages, so the tool table and the request messages
        // come from the same state (beforeStep can run compaction, which
        // discards loaded schemas and empties the ledger).
        buildTools,
        describeMissingTool,
        hooks,
        log,
        currentStep: steps,
        maxRetryAttempts,
        recordUsage: recordStepUsage,
        onRequestTrace: captureRequestTrace,
      });
      activeStep = undefined;
      mediaDegradedActive = mediaDegradedActive || stepResult.mediaDegradedResendUsed === true;
      mediaStrippedActive = mediaStrippedActive || stepResult.mediaStrippedResendUsed === true;
      thinkingStrippedActive =
        thinkingStrippedActive || stepResult.thinkingStrippedResendUsed === true;

      if (stepResult.stopReason === 'tool_use') {
        continue;
      }

      const terminalStopReason: LoopTerminalStepStopReason = stepResult.stopReason;
      stopReason = terminalStopReason;

      const continuation = await hooks?.shouldContinueAfterStop?.({
        turnId,
        stepNumber: steps,
        usage: stepResult.usage,
        stopReason: terminalStopReason,
        signal,
        llm,
      });
      if (continuation?.continue !== true) {
        break;
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      // A deliberate user cancel travels as the signal's reason (and may be the
      // thrown error itself). Report it distinctly from a timeout or other
      // programmatic abort so telemetry can tell the two apart.
      const interruptReason =
        isUserCancellation(signal.reason) || isUserCancellation(error) ? 'user_cancelled' : 'aborted';
      dispatchEvent(
        makeInterruptedEvent(
          'aborted',
          steps,
          activeStep,
          undefined,
          interruptReason,
          activeRequestTrace?.traceId,
        ),
      );
      return { stopReason: 'aborted', steps, usage };
    }
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    dispatchEvent(
      makeInterruptedEvent(
        reason,
        steps,
        activeStep,
        errorMessage(error),
        reason,
        activeRequestTrace?.traceId,
      ),
    );
    throw error;
  }

  return { stopReason, steps, usage };
}

interface StepProjectionInput {
  readonly buildMessages: LoopMessageBuilder;
  readonly buildMessagesMediaDegraded: LoopMessageBuilder | undefined;
  readonly buildMessagesMediaStripped: LoopMessageBuilder | undefined;
  readonly buildMessagesThinkingStripped: LoopMessageBuilder | undefined;
  readonly mediaDegradedActive: boolean;
  readonly mediaStrippedActive: boolean;
  readonly thinkingStrippedActive: boolean;
}

interface StepProjection {
  readonly buildMessages: LoopMessageBuilder;
  readonly mediaProjection: 'normal' | 'media-degraded' | 'media-stripped';
  readonly thinkingStripped: boolean;
}

/**
 * Pick the builder for a step from the turn's latched recovery state, and
 * report which projection it produced so `executeLoopStep` does not re-attempt
 * a rung the messages are already past.
 *
 * Media outranks thinking. The thinking-stripped rebuild carries full media, so
 * preferring it after a media rejection would re-earn that rejection every
 * step, and the media rung's inner recovery has no thinking fallback. With both
 * latched, the thinking rung simply re-fires per step — bounded at one extra
 * rejection plus one resend, and strictly better than looping on media.
 */
function selectStepProjection(input: StepProjectionInput): StepProjection {
  if (input.mediaStrippedActive && input.buildMessagesMediaStripped !== undefined) {
    return {
      buildMessages: input.buildMessagesMediaStripped,
      mediaProjection: 'media-stripped',
      thinkingStripped: false,
    };
  }
  if (input.mediaDegradedActive && input.buildMessagesMediaDegraded !== undefined) {
    return {
      buildMessages: input.buildMessagesMediaDegraded,
      mediaProjection: 'media-degraded',
      thinkingStripped: false,
    };
  }
  if (input.thinkingStrippedActive && input.buildMessagesThinkingStripped !== undefined) {
    return {
      buildMessages: input.buildMessagesThinkingStripped,
      mediaProjection: 'normal',
      thinkingStripped: true,
    };
  }
  // No latch matched a builder — a latch can only be set by a successful
  // resend through its own builder, so this is the plain first-choice path.
  // The reported projection describes the messages actually sent, which is
  // whatever the host's own `buildMessages` produces.
  return {
    buildMessages: input.buildMessages,
    mediaProjection: 'normal',
    thinkingStripped: false,
  };
}

function makeInterruptedEvent(
  reason: LoopInterruptReason,
  attemptedSteps: number,
  activeStep: number | undefined,
  message?: string | undefined,
  interruptReason: LoopTurnInterruptedEvent['interruptReason'] = reason,
  traceId?: string,
): LoopTurnInterruptedEvent {
  return {
    type: 'turn.interrupted',
    reason,
    attemptedSteps,
    ...(activeStep !== undefined ? { activeStep } : {}),
    ...(message !== undefined ? { message } : {}),
    interruptReason,
    traceId,
  };
}
