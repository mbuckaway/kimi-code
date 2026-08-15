/**
 * Supermoon-mode tools (EnterSupermoonMode / ExitSupermoonMode) against the
 * Agent-backed tool surface — guards, verbatim v2 output strings, and the
 * v2-parity trigger ('tool') handed to the mode engine.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import { EnterSupermoonModeTool } from '../../src/tools/builtin/supermoon/enter-supermoon-mode';
import { ExitSupermoonModeTool } from '../../src/tools/builtin/supermoon/exit-supermoon-mode';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function makeHarness(initialActive = false) {
  let active = initialActive;
  const enter = vi.fn((_trigger: string) => {
    active = true;
  });
  const exit = vi.fn(() => {
    active = false;
  });
  const agent = {
    supermoonMode: {
      get isActive() {
        return active;
      },
      enter,
      exit,
    },
  } as unknown as Agent;
  return { agent, enter, exit, isActive: () => active };
}

describe('EnterSupermoonModeTool', () => {
  it('enters supermoon mode with the tool trigger and returns the activation message', async () => {
    const h = makeHarness();
    const tool = new EnterSupermoonModeTool(h.agent);

    const result = await executeTool(tool, { args: {}, signal, turnId: 't', toolCallId: 'c1' });

    expect(h.enter).toHaveBeenCalledWith('tool');
    expect(h.isActive()).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Supermoon mode is now active.');
    expect(result.output).toContain('ExitSupermoonMode turns supermoon mode off');
  });

  it('reports an error when supermoon mode is already active', async () => {
    const h = makeHarness(true);
    const tool = new EnterSupermoonModeTool(h.agent);

    const result = await executeTool(tool, { args: {}, signal, turnId: 't', toolCallId: 'c1' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(
      'Supermoon mode is already active. Use ExitSupermoonMode when you want to leave it.',
    );
    expect(h.enter).not.toHaveBeenCalled();
  });

  it('exposes the empty strict input schema and approval rule = name', () => {
    const h = makeHarness();
    const tool = new EnterSupermoonModeTool(h.agent);

    expect(tool.name).toBe('EnterSupermoonMode');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    const execution = tool.resolveExecution({});
    expect('approvalRule' in execution ? execution.approvalRule : undefined).toBe('EnterSupermoonMode');
  });
});

describe('ExitSupermoonModeTool', () => {
  it('exits supermoon mode and returns the deactivation message', async () => {
    const h = makeHarness(true);
    const tool = new ExitSupermoonModeTool(h.agent);

    const result = await executeTool(tool, { args: {}, signal, turnId: 't', toolCallId: 'c1' });

    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.isActive()).toBe(false);
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('Supermoon mode is off.');
  });

  it('reports an error when supermoon mode is not active', async () => {
    const h = makeHarness(false);
    const tool = new ExitSupermoonModeTool(h.agent);

    const result = await executeTool(tool, { args: {}, signal, turnId: 't', toolCallId: 'c1' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('Supermoon mode is not active.');
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('exposes the empty strict input schema and approval rule = name', () => {
    const h = makeHarness();
    const tool = new ExitSupermoonModeTool(h.agent);

    expect(tool.name).toBe('ExitSupermoonMode');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    const execution = tool.resolveExecution({});
    expect('approvalRule' in execution ? execution.approvalRule : undefined).toBe('ExitSupermoonMode');
  });
});
