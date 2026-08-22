/**
 * Scenario: /planning-model command behavior in the interactive TUI.
 * Responsibilities: picker filtering, persistence of `planning_model`, clearing
 * via the harness (atomic section replace on the v2 engine, empty-alias write
 * on the v1 engine), and error paths.
 * Wiring: real command and selector with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/planning-model.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handlePlanningModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly title?: string;
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: { alias: string }) => void;
}

function model(name: string, maxContextSize = 200_000): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly planningModel?: string;
  readonly defaultModel?: string;
  readonly atomicReplace?: boolean;
}) {
  const appState = {
    model: 'cheap',
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
      small: model('small', 128_000),
      // The v1 derived entry must never be selectable.
      '__secondary__': model('cheap'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        planningModel: options?.planningModel,
        defaultModel: options?.defaultModel,
      })),
      setConfig: vi.fn(async () => ({})),
      supportsAtomicSectionReplace: vi.fn(() => options?.atomicReplace ?? true),
      replaceConfigSections: vi.fn(async () => {}),
    },
    setAppState: vi.fn((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
      supportsAtomicSectionReplace: ReturnType<typeof vi.fn>;
      replaceConfigSections: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handlePlanningModelCommand', () => {
  it('persists the planning model when given an explicit alias', async () => {
    const { host } = makeHost();

    await handlePlanningModelCommand(host, 'k2');

    expect(host.harness.setConfig).toHaveBeenCalledWith({ planningModel: 'k2' });
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Planning model set to'),
      'success',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('persists the model picked from the selector', async () => {
    const { host } = makeHost();

    await handlePlanningModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({ planningModel: 'k2' });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('opens the picker with the configured planning model as current', async () => {
    const { host } = makeHost({ planningModel: 'cheap' });

    await handlePlanningModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap', 'small']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('planning model');
    // The planning role carries no thinking level — the picker hides the
    // Thinking footer instead of offering a no-op choice.
    expect(opts.thinkingControl).toBe(false);
  });

  it('clears the planning model via atomic section replace on the v2 harness', async () => {    const { host } = makeHost({ planningModel: 'k2' });

    await handlePlanningModelCommand(host, 'clear');

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      planningModel: undefined,
    });
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Planning model cleared'),
      'success',
    );
  });

  it('clears the planning model with an empty alias on the v1 harness', async () => {
    const { host } = makeHost({ planningModel: 'k2', atomicReplace: false });

    await handlePlanningModelCommand(host, 'unset');

    expect(host.harness.setConfig).toHaveBeenCalledWith({ planningModel: '' });
    expect(host.harness.replaceConfigSections).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Planning model cleared'),
      'success',
    );
  });

  it('reports when no planning model is set instead of writing', async () => {
    const { host } = makeHost();

    await handlePlanningModelCommand(host, 'clear');

    expect(host.showStatus).toHaveBeenCalledWith('No planning model is set.');
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.harness.replaceConfigSections).not.toHaveBeenCalled();
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handlePlanningModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the synthesized derived alias as an argument', async () => {
    const { host } = makeHost();

    await handlePlanningModelCommand(host, '__secondary__');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: __secondary__');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handlePlanningModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handlePlanningModelCommand(host, 'k2');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('reports a clear failure without a status message', async () => {
    const { host } = makeHost({ planningModel: 'k2' });
    host.harness.replaceConfigSections.mockRejectedValueOnce(new Error('read-only'));

    await handlePlanningModelCommand(host, 'clear');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    expect(host.showStatus).not.toHaveBeenCalled();
  });

  it('warns when the planning model context window differs from the default model', async () => {
    const { host } = makeHost({ defaultModel: 'cheap' });

    await handlePlanningModelCommand(host, 'small');

    expect(host.harness.setConfig).toHaveBeenCalledWith({ planningModel: 'small' });
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('context window'),
      'warning',
    );
  });

  it('does not warn when the planning model context window matches the default model', async () => {
    const { host } = makeHost({ defaultModel: 'cheap' });

    await handlePlanningModelCommand(host, 'k2');

    expect(host.harness.setConfig).toHaveBeenCalledWith({ planningModel: 'k2' });
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('Planning model set to'),
      'success',
    );
    expect(host.showStatus).not.toHaveBeenCalledWith(
      expect.stringContaining('context window'),
      'warning',
    );
  });
});
