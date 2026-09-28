/**
 * Scenario: protocol success/error envelopes and canonical error codes.
 * Responsibilities: verify schema round-trips, stable numeric codes, and reason labels.
 * Wiring: pure protocol schemas and constructors; no external boundaries.
 * Run: `pnpm --filter @moonshot-ai/protocol exec vitest run src/__tests__/envelope.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { envelopeSchema, errEnvelope, okEnvelope, summarizeStack, type Envelope } from '../envelope';
import { ErrorCode, ErrorCodeReason } from '../error-codes';

describe('envelope', () => {
  it('okEnvelope round-trips through envelopeSchema', () => {
    const built = okEnvelope({ ok: true }, 'req_test');

    expect(built).toEqual({
      code: 0,
      msg: 'success',
      data: { ok: true },
      request_id: 'req_test',
    });

    const schema = envelopeSchema(z.object({ ok: z.boolean() }));
    const parsed = schema.parse(built);
    expect(parsed).toEqual(built);
  });

  it('errEnvelope round-trips with data: null', () => {
    const built = errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'session abc123 does not exist', 'req_x');

    expect(built).toEqual({
      code: 40401,
      msg: 'session abc123 does not exist',
      data: null,
      request_id: 'req_x',
    });

    const parsed = envelopeSchema(z.any()).parse(built);
    expect(parsed.data).toBeNull();
    expect(parsed.code).toBe(40401);
  });

  it('envelopeSchema rejects non-integer code', () => {
    const schema = envelopeSchema(z.unknown());
    expect(schema.safeParse({ code: 1.5, msg: 'x', data: null, request_id: 'r' }).success).toBe(
      false,
    );
  });

  it('envelopeSchema rejects missing request_id', () => {
    const schema = envelopeSchema(z.unknown());
    expect(schema.safeParse({ code: 0, msg: 'success', data: null }).success).toBe(false);
  });

  it('wire shape matches the daemon helper byte-for-byte', () => {
    const ours = okEnvelope({ id: 'sess_1' }, 'req_y');
    const oursJson = JSON.stringify(ours);
    expect(oursJson).toBe('{"code":0,"msg":"success","data":{"id":"sess_1"},"request_id":"req_y"}');

    const errJson = JSON.stringify(errEnvelope(40001, 'validation failed', 'req_z'));
    expect(errJson).toBe(
      '{"code":40001,"msg":"validation failed","data":null,"request_id":"req_z"}',
    );
  });

  it('errEnvelope surfaces a summarized stack when provided and omits it when absent', () => {
    const err = new Error('boom');
    const withStack = errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', err.stack);
    expect(withStack.stack).toContain('Error: boom');
    expect(JSON.stringify(withStack)).toContain('"stack":');
    expect(envelopeSchema(z.any()).parse(withStack).stack).toBe(withStack.stack);

    // No stack → field is absent and the wire shape is byte-identical to before.
    const without = errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s');
    expect(JSON.stringify(without)).toBe(
      '{"code":50001,"msg":"boom","data":null,"request_id":"req_s"}',
    );
  });

  it('errEnvelope omits stack when the caller passes an empty or whitespace-only stack', () => {
    expect(errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', '').stack).toBeUndefined();
    expect(errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', '   \n  ').stack).toBeUndefined();
    expect(JSON.stringify(errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', ''))).toBe(
      '{"code":50001,"msg":"boom","data":null,"request_id":"req_s"}',
    );
  });

  it('errEnvelope strips directory components from stack frame paths', () => {
    const stack = [
      'Error: boom',
      '    at handler (/Users/alice/work/kimi-code/packages/protocol/src/handler.ts:12:5)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');

    const env = errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', stack);

    expect(env.stack).toBe(
      [
        'Error: boom',
        '    at handler (handler.ts:12:5)',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ].join('\n'),
    );
    expect(env.stack).not.toContain('/Users/alice');
  });

  it('errEnvelope redacts absolute paths that leak through the message line', () => {
    const stack =
      "Error: ENOENT: no such file or directory, open '/home/alice/private/secret.txt'";

    const env = errEnvelope(ErrorCode.INTERNAL_ERROR, 'boom', 'req_s', stack);

    expect(env.stack).toBe("Error: ENOENT: no such file or directory, open 'secret.txt'");
    expect(env.stack).not.toContain('/home/alice');
  });
});

describe('summarizeStack', () => {
  it('caps the frame list and records how many frames were dropped', () => {
    const stack = [
      'Error: boom',
      ...Array.from(
        { length: 6 },
        (_value, index) => `    at fn${String(index)} (/home/ci/build/file${String(index)}.ts:${String(index)}:1)`,
      ),
    ].join('\n');

    const summary = summarizeStack(stack);

    expect(summary.split('\n')).toEqual([
      'Error: boom',
      '    at fn0 (file0.ts:0:1)',
      '    at fn1 (file1.ts:1:1)',
      '    at fn2 (file2.ts:2:1)',
      '    ... 3 more frame(s) omitted',
    ]);
  });

  it('honors a custom frame limit', () => {
    const stack = [
      'Error: boom',
      '    at first (/abs/first.ts:1:1)',
      '    at second (/abs/second.ts:2:2)',
    ].join('\n');

    expect(summarizeStack(stack, 1).split('\n')).toEqual([
      'Error: boom',
      '    at first (first.ts:1:1)',
      '    ... 1 more frame(s) omitted',
    ]);
  });

  it('leaves already-relative frames untouched', () => {
    const stack = ['Error: boom', '    at handler (handler.ts:12:5)'].join('\n');

    expect(summarizeStack(stack)).toBe(stack);
  });

  it('keeps frames that carry no file location', () => {
    const stack = ['Error: boom', '    at async Promise.all (index 0)'].join('\n');

    expect(summarizeStack(stack)).toBe(stack);
  });

  it('handles a frame-only stack with no message line', () => {
    const stack = '    at handler (/abs/deep/path/handler.ts:9:3)';

    expect(summarizeStack(stack)).toBe('    at handler (handler.ts:9:3)');
  });
});

describe('error-codes', () => {
  it('canonical codes match REST.md §1.4', () => {
    expect(ErrorCode.SUCCESS).toBe(0);
    expect(ErrorCode.VALIDATION_FAILED).toBe(40001);
    expect(ErrorCode.SESSION_NOT_FOUND).toBe(40401);
    expect(ErrorCode.GOAL_UNSUPPORTED_AGENT).toBe(40920);
    expect(ErrorCode.APPROVAL_EXPIRED).toBe(41001);
    expect(ErrorCode.FS_WATCH_LIMIT_EXCEEDED).toBe(42902);
    expect(ErrorCode.INTERNAL_ERROR).toBe(50001);
    expect(ErrorCode.TOOL_EXECUTION_FAILED).toBe(60001);
  });

  it('ErrorCodeReason maps every numeric code to its domain.reason label', () => {
    expect(ErrorCodeReason[ErrorCode.SESSION_NOT_FOUND]).toBe('session.not_found');
    expect(ErrorCodeReason[ErrorCode.PROVIDER_NOT_FOUND]).toBe('provider.not_found');
    expect(ErrorCodeReason[ErrorCode.MODEL_NOT_FOUND]).toBe('model.not_found');
    expect(ErrorCodeReason[ErrorCode.VALIDATION_FAILED]).toBe('validation.failed');
    expect(ErrorCodeReason[ErrorCode.FS_WATCH_LIMIT_EXCEEDED]).toBe('fs.watch_limit_exceeded');
    expect(ErrorCodeReason[ErrorCode.GOAL_UNSUPPORTED_AGENT]).toBe('goal.unsupported_agent');
  });

  it('reserved codes are not redefined (40101, 50002 absent)', () => {
    const allValues = Object.values(ErrorCode);
    expect(allValues).not.toContain(40101);
    expect(allValues).not.toContain(40102);
    expect(allValues).not.toContain(40103);
    expect(allValues).not.toContain(42901);
    expect(allValues).not.toContain(50002);
  });

  it('ErrorCode type narrows to the literal union', () => {
    const code: ErrorCode = ErrorCode.SESSION_NOT_FOUND;
    const env: Envelope<null> = errEnvelope(code, 'x', 'req_t');
    expect(env.code).toBe(40401);
  });
});
