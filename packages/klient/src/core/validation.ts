/**
 * zod-backed wire validation. Every procedure in the contract validates its
 * input tuple before it goes on the wire (caller bugs) and its output when it
 * comes back (server drift). Event payloads are validated on delivery;
 * failures there are reported, not thrown, so one bad event cannot kill a
 * subscription stream.
 */

import { z } from 'zod';

import type { ProcedureContract, StreamingProcedureContract } from '#/contract/types';

export type ValidationPhase = 'input' | 'output' | 'event' | 'chunk';

export class KlientValidationError extends Error {
  constructor(
    readonly phase: ValidationPhase,
    /** `service.method` for calls, the klient event name for events. */
    readonly procedure: string,
    readonly issues: z.ZodError['issues'],
    /** The offending raw payload (input args, output data, or event data). */
    readonly payload: unknown,
  ) {
    super(
      `${phase} validation failed for ${procedure}: ${issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'KlientValidationError';
  }
}

/** Parse the positional-args tuple; returns the normalized args to send. */
export function parseInput<TInput, TOutput>(
  procedure: string,
  contract: ProcedureContract<TInput, TOutput> | StreamingProcedureContract<TInput>,
  args: unknown[],
): TInput {
  const result = contract.input.safeParse(args);
  if (!result.success) {
    throw new KlientValidationError('input', procedure, result.error.issues, args);
  }
  return result.data;
}

/** Parse a wire result; returns the normalized data to hand to the caller. */
export function parseOutput<TInput, TOutput>(
  procedure: string,
  contract: ProcedureContract<TInput, TOutput>,
  data: unknown,
): TOutput {
  const result = contract.output.safeParse(data);
  if (!result.success) {
    throw new KlientValidationError('output', procedure, result.error.issues, data);
  }
  return result.data;
}

/** Validate one streamed chunk; throws on mismatch. */
export function parseChunk<TInput, TChunk>(
  procedure: string,
  contract: StreamingProcedureContract<TInput, TChunk>,
  data: unknown,
): TChunk {
  const result = contract.chunk.safeParse(data);
  if (!result.success) {
    throw new KlientValidationError('chunk', procedure, result.error.issues, data);
  }
  return result.data;
}

/** Parse an event payload without throwing; an `ok: false` result on failure. */
export function parseEvent<TPayload>(
  event: string,
  schema: z.ZodType<TPayload>,
  data: unknown,
): { ok: true; data: TPayload } | { ok: false; error: KlientValidationError } {
  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: new KlientValidationError('event', event, result.error.issues, data) };
  }
  return { ok: true, data: result.data };
}
