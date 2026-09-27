/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @moonshot-ai/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { maybe } from '../src/contract/helpers.js';
import type { ProcedureContract, StreamingProcedureContract } from '../src/contract/types.js';
import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { promptPayloadSchema } from '../src/contract/agent/schemas.js';
import {
  KlientValidationError,
  parseChunk,
  parseEvent,
  parseInput,
  parseOutput,
} from '../src/core/validation.js';

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('completeAuth timeoutMs accepts the setTimeout maximum and rejects above it', () => {
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_647 })
        .success,
    ).toBe(true);
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_648 })
        .success,
    ).toBe(false);
  });
});

describe('prompt contract validation', () => {
  it('rejects an empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: '' }).success).toBe(false);
  });

  it('accepts a non-empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: 'submission-1' }).success).toBe(true);
  });
});

describe('wire parse helpers', () => {
  it('parseInput returns the zod-normalized tuple with its inferred tuple type', () => {
    const contract = {
      input: z.tuple([z.string().transform((value) => value.trim())]),
      output: z.number(),
    } satisfies ProcedureContract;

    const args = parseInput('demo.trim', contract, ['  padded  ']);

    expectTypeOf(args).toEqualTypeOf<[string]>();
    expect(args).toEqual(['padded']);
  });

  it('parseInput accepts a streaming contract tuple and returns it unchanged', () => {
    const contract = {
      input: z.tuple([z.number()]),
      chunk: z.string(),
      streaming: true,
    } satisfies StreamingProcedureContract;

    const args = parseInput('demo.count', contract, [3]);

    expect(args).toEqual([3]);
  });

  it('parseInput reports the input phase, the message, and the offending payload', () => {
    const contract = {
      input: z.tuple([z.number()]),
      output: z.number(),
    } satisfies ProcedureContract;

    const failure = capture(() => parseInput('demo.count', contract, ['nope']));

    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('input');
    expect((failure as KlientValidationError).procedure).toBe('demo.count');
    expect((failure as KlientValidationError).message).toMatch(
      /input validation failed for demo\.count/,
    );
    expect((failure as KlientValidationError).payload).toEqual(['nope']);
  });

  it('parseOutput returns the inferred output type after normalizing null to undefined', () => {
    const contract = {
      input: z.tuple([]),
      output: maybe(z.object({ id: z.string() })),
    } satisfies ProcedureContract;

    const output = parseOutput('demo.get', contract, null);

    expectTypeOf(output).toEqualTypeOf<{ id: string } | undefined>();
    expect(output).toBeUndefined();
  });

  it('parseOutput returns the inferred output shape for a present value', () => {
    const contract = {
      input: z.tuple([]),
      output: z.object({ id: z.string(), count: z.number() }),
    } satisfies ProcedureContract;

    const output = parseOutput('demo.read', contract, { id: 'row-1', count: 2 });

    expectTypeOf(output).toEqualTypeOf<{ id: string; count: number }>();
    expect(output).toEqual({ id: 'row-1', count: 2 });
  });

  it('parseOutput rejects a drifted payload with the output phase', () => {
    const contract = {
      input: z.tuple([]),
      output: z.object({ id: z.string() }),
    } satisfies ProcedureContract;

    const failure = capture(() => parseOutput('demo.read', contract, { id: 7 }));

    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('output');
  });

  it('parseChunk returns the inferred chunk type', () => {
    const contract = {
      input: z.tuple([z.string()]),
      chunk: z.object({ delta: z.string() }),
      streaming: true,
    } satisfies StreamingProcedureContract;

    const chunk = parseChunk('demo.stream', contract, { delta: 'part' });

    expectTypeOf(chunk).toEqualTypeOf<{ delta: string }>();
    expect(chunk).toEqual({ delta: 'part' });
  });

  it('parseChunk rejects a drifted chunk with the chunk phase', () => {
    const contract = {
      input: z.tuple([z.string()]),
      chunk: z.object({ delta: z.string() }),
      streaming: true,
    } satisfies StreamingProcedureContract;

    const failure = capture(() => parseChunk('demo.stream', contract, { delta: 3 }));

    expect(failure).toBeInstanceOf(KlientValidationError);
    expect((failure as KlientValidationError).phase).toBe('chunk');
  });

  it('parseEvent returns the inferred payload instead of unknown', () => {
    const parsed = parseEvent('demo.updated', z.object({ id: z.string() }), { id: 'row-1' });

    expectTypeOf(parsed).toEqualTypeOf<
      { ok: true; data: { id: string } } | { ok: false; error: KlientValidationError }
    >();
    expect(parsed).toEqual({ ok: true, data: { id: 'row-1' } });
  });

  it('parseEvent reports a bad payload without throwing', () => {
    const parsed = parseEvent('demo.updated', z.object({ id: z.string() }), { id: 7 });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toBeInstanceOf(KlientValidationError);
      expect(parsed.error.phase).toBe('event');
    }
  });
});

function capture(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
