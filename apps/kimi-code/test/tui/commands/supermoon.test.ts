import { describe, expect, it, vi } from 'vitest';

import { handleSupermoonCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '\u001B';
const DOWN = '\u001B[B';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

interface TestComponent {
  render(width: number): string[];
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
    supermoonMode?: boolean;
    thinkingEffort?: string;
    supportEfforts?: readonly string[];
  } = {},
) {
  const session = {
    setPermission: vi.fn(async () => {}),
    setSupermoonMode: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const model = overrides.model ?? 'kimi-model';
  const availableModels =
    overrides.supportEfforts === undefined
      ? {}
      : { [model]: { provider: 'managed:kimi-code', model, supportEfforts: overrides.supportEfforts } };
  const host = {
    state: {
      appState: {
        model,
        permissionMode: overrides.permissionMode ?? 'auto',
        supermoonMode: overrides.supermoonMode ?? false,
        thinkingEffort: overrides.thinkingEffort ?? 'low',
        availableModels,
      },
      supermoonModeEntry: undefined,
      supermoonPreviousEffort: undefined,
      theme: currentTheme,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

function markerAddChild(host: SlashCommandHost): ReturnType<typeof vi.fn> {
  return host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
}

function expectSupermoonMarker(host: SlashCommandHost, text: string): void {
  const components = markerAddChild(host).mock.calls.map(([component]) => component as TestComponent);
  const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(rendered).toContain(text);
}

describe('handleSupermoonCommand', () => {
  it('sends the supermoon prompt as a normal prompt after enabling supermoon mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setThinking).toHaveBeenCalledWith('max');
    expect(host.state.supermoonModeEntry).toBe('task');
    expect(host.state.supermoonPreviousEffort).toBe('low');
    expect(host.setAppState).toHaveBeenCalledWith({ thinkingEffort: 'max' });
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('sends the supermoon prompt without re-entering supermoon mode when already on', async () => {
    const { host, session } = makeHost({
      permissionMode: 'auto',
      supermoonMode: true,
      supportEfforts: ['low', 'high', 'max'],
    });

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(host.state.supermoonModeEntry).toBeUndefined();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('turns supermoon mode on without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'on');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: true });
    expect(host.setAppState).toHaveBeenCalledWith({ thinkingEffort: 'max' });
    expect(host.state.supermoonModeEntry).toBe('manual');
    expect(host.state.supermoonPreviousEffort).toBe('low');
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before turning supermoon mode on in Manual mode', async () => {
    const { host, session } = makeHost({ model: '', permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'on');

    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block supermoon work');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'manual');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSupermoonMode).toHaveBeenCalledTimes(1);
    expect(session.setThinking).toHaveBeenCalledWith('max');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: true });
    expect(host.state.supermoonModeEntry).toBe('manual');
    expect(host.state.supermoonPreviousEffort).toBe('low');
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns supermoon mode on when called without args while supermoon mode is off', async () => {
    const { host, session } = makeHost({ model: '', supermoonMode: false, supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, '');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: true });
    expect(host.state.supermoonModeEntry).toBe('manual');
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when supermoon mode is already on', async () => {
    const { host, session } = makeHost({ model: '', supermoonMode: true });

    await handleSupermoonCommand(host, 'on');

    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ supermoonMode: true });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Supermoon mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns supermoon mode off without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '', supermoonMode: true, supportEfforts: ['low', 'high', 'max'] });
    host.state.supermoonPreviousEffort = 'low';

    await handleSupermoonCommand(host, 'off');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(false, 'manual');
    expect(session.setThinking).toHaveBeenCalledWith('low');
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: false });
    expect(host.setAppState).toHaveBeenCalledWith({ thinkingEffort: 'low' });
    expect(host.state.supermoonModeEntry).toBeUndefined();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
    expectSupermoonMarker(host, 'Supermoon deactivated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns supermoon mode off when called without args while supermoon mode is on', async () => {
    const { host, session } = makeHost({ model: '', supermoonMode: true, supportEfforts: ['low', 'high', 'max'] });
    host.state.supermoonPreviousEffort = 'low';

    await handleSupermoonCommand(host, '');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(false, 'manual');
    expect(session.setThinking).toHaveBeenCalledWith('low');
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: false });
    expect(host.state.supermoonModeEntry).toBeUndefined();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
    expectSupermoonMarker(host, 'Supermoon deactivated');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when supermoon mode is already off', async () => {
    const { host, session } = makeHost({ model: '', supermoonMode: false });

    await handleSupermoonCommand(host, 'off');

    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ supermoonMode: false });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Supermoon mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before starting a supermoon task in Manual mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block supermoon work');
    expect(text).toContain('Switch to YOLO and start');
    expect(text).not.toContain('Do not start');
  });

  it('defaults to Auto when confirming a Manual-mode supermoon start', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSupermoonMode).toHaveBeenCalledTimes(1);
    expect(session.setThinking).toHaveBeenCalledWith('max');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: true });
    expect(host.state.supermoonModeEntry).toBe('task');
    expect(host.state.supermoonPreviousEffort).toBe('low');
    expectSupermoonMarker(host, 'Supermoon activated');
  });

  it('can start a Manual-mode supermoon task without changing permission', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSupermoonMode).toHaveBeenCalledTimes(1);
    expect(host.state.supermoonModeEntry).toBe('task');
    expectSupermoonMarker(host, 'Supermoon activated');
  });

  it('can start a Manual-mode supermoon task after switching to YOLO', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSupermoonMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
    expect(host.setAppState).toHaveBeenCalledWith({ supermoonMode: true });
    expect(host.state.supermoonModeEntry).toBe('task');
    expectSupermoonMarker(host, 'Supermoon activated');
  });

  it('returns the command to the input box when a Manual-mode supermoon start is cancelled', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/supermoon Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Supermoon task not started.');
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not start when permission update fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });
    session.setPermission.mockRejectedValueOnce(new Error('denied'));

    await handleSupermoonCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set permission mode'),
      );
    });
    expect(session.setSupermoonMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send from Manual mode when enabling supermoon mode fails after confirmation', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual', supportEfforts: ['low', 'high', 'max'] });
    session.setSupermoonMode.mockRejectedValueOnce(new Error('denied'));

    await handleSupermoonCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to enable supermoon mode'),
      );
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send a prompt when enabling supermoon mode fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', supportEfforts: ['low', 'high', 'max'] });
    session.setSupermoonMode.mockRejectedValueOnce(new Error('denied'));

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable supermoon mode'),
    );
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not pin the thinking effort when the model advertises no supportEfforts', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
    expect(host.setAppState).not.toHaveBeenCalledWith({ thinkingEffort: 'max' });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('does not pin the thinking effort when no model is selected', async () => {
    const { host, session } = makeHost({ model: '', permissionMode: 'auto' });

    await handleSupermoonCommand(host, 'on');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'manual');
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
  });

  it('does not restore the thinking effort when none was captured', async () => {
    const { host, session } = makeHost({ model: 'kimi-model', supermoonMode: true, supportEfforts: ['low', 'high', 'max'] });

    await handleSupermoonCommand(host, 'off');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(false, 'manual');
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
  });

  it('does not restore the effort or clear state when disabling supermoon mode fails', async () => {
    const { host, session } = makeHost({ model: 'kimi-model', supermoonMode: true, thinkingEffort: 'max', supportEfforts: ['low', 'high', 'max'] });
    host.state.supermoonModeEntry = 'manual';
    host.state.supermoonPreviousEffort = 'low';
    session.setSupermoonMode.mockRejectedValueOnce(new Error('denied'));

    await handleSupermoonCommand(host, 'off');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to disable supermoon mode'),
    );
    expect(session.setThinking).not.toHaveBeenCalled();
    expect(host.state.supermoonModeEntry).toBe('manual');
    expect(host.state.supermoonPreviousEffort).toBe('low');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
  });

  it('keeps supermoon mode on and sends the prompt when the effort pin fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', supportEfforts: ['low', 'high', 'max'] });
    session.setThinking.mockRejectedValueOnce(new Error('boom'));

    await handleSupermoonCommand(host, 'Ship feature X');

    expect(session.setSupermoonMode).toHaveBeenCalledWith(true, 'task');
    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to pin thinking effort'),
    );
    expect(host.state.supermoonModeEntry).toBe('task');
    expect(host.state.supermoonPreviousEffort).toBeUndefined();
    expectSupermoonMarker(host, 'Supermoon activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });
});
