import { describe, expect, it, vi } from 'vitest';

import { PROVIDER_USAGE_LIMIT_CODE } from '#/constant/app';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '#/tui/constant/kimi-tui';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const streamingUI = {
    setTurnId: vi.fn(),
    flushNow: vi.fn(),
    resetToolUi: vi.fn(),
    finalizeLiveTextBuffers: vi.fn(),
    finalizeTurn: vi.fn(),
  };
  const showError = vi.fn();
  const showStatus = vi.fn();
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: {},
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI,
    requireSession: vi.fn(() => ({})),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError,
    showStatus,
    showNotice: vi.fn(),
    updateActivityPane: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as never, showError, showStatus, streamingUI };
}

function errorEvent(code: string, message: string) {
  return {
    type: 'error',
    sessionId: 's1',
    agentId: 'main',
    code,
    message,
  } as never;
}

const sendQueued = (): void => {};

describe('SessionEventHandler session errors', () => {
  it('renders a plain-language notice with guidance for a usage-limit failure', () => {
    const { host, showError } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(errorEvent(PROVIDER_USAGE_LIMIT_CODE, 'Weekly quota exceeded.'), sendQueued);

    expect(showError).toHaveBeenCalledTimes(1);
    const notice = showError.mock.calls[0]![0] as string;
    expect(notice).toContain('Weekly quota exceeded.');
    expect(notice).toContain('/usage');
    expect(notice).not.toContain(`[${PROVIDER_USAGE_LIMIT_CODE}]`);
  });

  it('does not show the error-report hint for a usage-limit failure', () => {
    const { host, showStatus } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(errorEvent(PROVIDER_USAGE_LIMIT_CODE, 'Weekly quota exceeded.'), sendQueued);

    expect(showStatus).not.toHaveBeenCalled();
  });

  it('keeps the raw [code] message rendering and report hint for other errors', () => {
    const { host, showError, showStatus } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(errorEvent('provider.api_error', 'boom'), sendQueued);

    expect(showError).toHaveBeenCalledWith('[provider.api_error] boom');
    expect(showStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps the OAuth login-required startup notice', () => {
    const { host, showError, showStatus } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(errorEvent('auth.login_required', 'login required'), sendQueued);

    expect(showError).toHaveBeenCalledWith(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    expect(showStatus).not.toHaveBeenCalled();
  });
});
