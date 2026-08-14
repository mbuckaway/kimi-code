/**
 * `kosong/contract` domain — the stream idle-stall watchdog.
 *
 * Bounds the shared stream-iteration layer (`generate.ts`) against provider
 * streams that silently stall (connection open, no bytes, no terminal event):
 * awaiting the next part is raced against an idle window that resets on every
 * received chunk, and an expired window cancels the stream and rejects the
 * iteration with the standard abort DOMException — so the existing
 * abort/interruption path classifies a stall like a cancellation instead of a
 * provider failure. The window resolves from the per-call option first
 * (`GenerateOptions.stallTimeoutMs`, where `0` disables the watchdog), then the
 * `KIMI_CODE_STREAM_STALL_TIMEOUT_MS` env binding, then a sane default.
 * Also exports the shared stream-cancel helper.
 */

import { createAbortError } from './errors';
import type { StreamedMessagePart } from './message';
import type { StreamedMessage } from './provider';

export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

export const STREAM_STALL_TIMEOUT_ENV = 'KIMI_CODE_STREAM_STALL_TIMEOUT_MS';

export function resolveStreamStallTimeoutMs(configured: number | undefined): number {
  if (configured !== undefined) {
    return configured > 0 ? configured : 0;
  }
  const raw = process.env[STREAM_STALL_TIMEOUT_ENV];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    if (parsed === 0) return 0;
  }
  return DEFAULT_STREAM_STALL_TIMEOUT_MS;
}

export function applyStreamStallTimeout(
  stream: StreamedMessage,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): AsyncIterable<StreamedMessagePart> {
  const { timeoutMs, signal } = options;
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
      const iterator = stream[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stalled = false;
      let stallReject: ((error: Error) => void) | undefined;

      const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };

      const armTimer = (): void => {
        clearTimer();
        timer = setTimeout(() => {
          if (signal?.aborted) return;
          const reject = stallReject;
          if (reject === undefined) return;
          stalled = true;
          reject(createAbortError());
        }, timeoutMs);
      };

      try {
        for (;;) {
          const nextPromise = iterator.next();
          nextPromise.catch(() => undefined);
          const idle = new Promise<never>((_resolve, reject) => {
            stallReject = reject;
            armTimer();
          });
          const result = await Promise.race([nextPromise, idle]);
          clearTimer();
          stallReject = undefined;
          if (result.done === true) return;
          yield result.value;
        }
      } finally {
        clearTimer();
        stallReject = undefined;
        if (stalled) await cancelStream(stream);
      }
    },
  };
}

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

export async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}
