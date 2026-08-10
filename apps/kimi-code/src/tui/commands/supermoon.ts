import type { PermissionMode, Session } from '@moonshot-ai/kimi-code-sdk';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import {
  SupermoonStartPermissionPromptComponent,
  type SupermoonStartPermissionChoice,
} from '../components/dialogs/supermoon-start-permission-prompt';
import {
  SupermoonModeMarkerComponent,
  type SupermoonModeMarkerState,
} from '../components/messages/supermoon-markers';
import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

/**
 * Supermoon entry trigger — mirrors the SDK's `SupermoonModeTrigger`
 * ('manual' | 'task'). There is no `tool` trigger: Supermoon is entered
 * manually or one-shot via a task-triggered prompt.
 */
type SupermoonModeTrigger = 'manual' | 'task';

/**
 * The node-sdk `Session` surface lands `setSupermoonMode` in parallel with the
 * engine work; reach it structurally so the TUI compiles before that lands
 * (the same feature-detection approach the SDK itself uses for supermoon
 * RPCs). Drop this cast once `Session` declares the method.
 */
interface SupermoonSession extends Session {
  setSupermoonMode(enabled: boolean, trigger: SupermoonModeTrigger): Promise<void>;
}

export async function handleSupermoonCommand(host: SlashCommandHost, args: string): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }

  const prompt = args.trim();
  const mode = supermoonModeSubcommand(prompt);
  if (mode !== undefined) {
    await applySupermoonMode(host, mode, `/supermoon ${prompt}`);
    return;
  }

  if (prompt.length === 0) {
    await applySupermoonMode(host, !host.state.appState.supermoonMode, '/supermoon');
    return;
  }

  if (host.state.appState.model.trim().length === 0) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }

  if (host.state.appState.permissionMode === 'manual') {
    showSupermoonStartPermissionPrompt(
      host,
      `/supermoon ${prompt}`,
      'Supermoon task not started.',
      (choice) => startSupermoonWithPermission(host, prompt, choice),
    );
    return;
  }

  await startSupermoonTask(host, prompt);
}

function showSupermoonStartPermissionPrompt(
  host: SlashCommandHost,
  commandText: string,
  cancelStatus: string,
  onSelect: (choice: SupermoonStartPermissionChoice) => Promise<void>,
): void {
  const cancelStart = (): void => {
    host.restoreInputText(commandText);
    host.showStatus(cancelStatus);
  };
  host.mountEditorReplacement(
    new SupermoonStartPermissionPromptComponent({
      onSelect: (choice) => {
        host.restoreEditor();
        void onSelect(choice);
      },
      onCancel: cancelStart,
    }),
  );
}

async function startSupermoonWithPermission(
  host: SlashCommandHost,
  prompt: string,
  choice: SupermoonStartPermissionChoice,
): Promise<void> {
  if (choice === 'auto' || choice === 'yolo') {
    if (!(await setPermissionForSupermoon(host, choice))) return;
  }
  await startSupermoonTask(host, prompt);
}

async function setPermissionForSupermoon(host: SlashCommandHost, mode: PermissionMode): Promise<boolean> {
  try {
    await host.requireSession().setPermission(mode);
  } catch (error) {
    host.showError(`Failed to set permission mode: ${formatErrorMessage(error)}`);
    return false;
  }
  host.setAppState({ permissionMode: mode });
  return true;
}

async function startSupermoonTask(host: SlashCommandHost, prompt: string): Promise<void> {
  if (!host.state.appState.supermoonMode && !(await setSupermoonMode(host, true, 'task'))) {
    return;
  }
  renderSupermoonModeMarker(host, 'active');
  host.sendNormalUserInput(prompt);
}

async function applySupermoonMode(
  host: SlashCommandHost,
  enabled: boolean,
  commandText: string,
): Promise<void> {
  if (enabled && host.state.appState.supermoonMode) {
    host.showStatus('Supermoon mode is already on.');
    return;
  }
  if (!enabled && !host.state.appState.supermoonMode) {
    host.showStatus('Supermoon mode is already off.');
    return;
  }
  if (enabled && host.state.appState.permissionMode === 'manual') {
    showSupermoonStartPermissionPrompt(host, commandText, 'Supermoon mode not enabled.', async (choice) => {
      if ((choice === 'auto' || choice === 'yolo') && !(await setPermissionForSupermoon(host, choice))) {
        return;
      }
      if (!(await setSupermoonMode(host, true, 'manual'))) return;
      renderSupermoonModeMarker(host, 'active');
    });
    return;
  }
  if (!(await setSupermoonMode(host, enabled, 'manual'))) return;
  renderSupermoonModeMarker(host, enabled ? 'active' : 'inactive');
}

async function setSupermoonMode(
  host: SlashCommandHost,
  enabled: boolean,
  trigger: SupermoonModeTrigger,
): Promise<boolean> {
  const session = host.requireSession() as unknown as SupermoonSession;
  try {
    await session.setSupermoonMode(enabled, trigger);
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} supermoon mode: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  host.setAppState({ supermoonMode: enabled });
  host.state.supermoonModeEntry = enabled ? trigger : undefined;
  if (enabled) {
    await pinEffort(host, session);
  } else {
    await restoreEffort(host, session);
  }
  return true;
}

/**
 * Pin the session's thinking effort to the active model's highest supported
 * effort while supermoon mode is on, remembering the previous effort so it can
 * be restored on exit. Best-effort: a failed pin leaves the mode enabled and
 * surfaces an error rather than blocking the command.
 */
async function pinEffort(host: SlashCommandHost, session: Session): Promise<void> {
  const efforts = resolveSupportEfforts(host);
  if (efforts.length === 0) return;
  const highest = efforts.at(-1)!;
  const previous = host.state.appState.thinkingEffort;
  try {
    await session.setThinking(highest);
  } catch (error) {
    host.showError(`Failed to pin thinking effort for supermoon mode: ${formatErrorMessage(error)}`);
    return;
  }
  host.state.supermoonPreviousEffort = previous;
  host.setAppState({ thinkingEffort: highest });
}

/** Restore the thinking effort captured before supermoon mode pinned it. */
async function restoreEffort(host: SlashCommandHost, session: Session): Promise<void> {
  const previous = host.state.supermoonPreviousEffort;
  if (previous === undefined) return;
  try {
    await session.setThinking(previous);
  } catch (error) {
    host.showError(`Failed to restore thinking effort after supermoon mode: ${formatErrorMessage(error)}`);
    return;
  }
  host.state.supermoonPreviousEffort = undefined;
  host.setAppState({ thinkingEffort: previous });
}

/** Declared selectable efforts of the active model alias, or [] when absent. */
function resolveSupportEfforts(host: SlashCommandHost): readonly string[] {
  const alias = host.state.appState.model;
  const model = host.state.appState.availableModels[alias];
  if (model === undefined) return [];
  const effective = effectiveModelAlias(model);
  return effective?.supportEfforts ?? [];
}

function supermoonModeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}

function renderSupermoonModeMarker(host: SlashCommandHost, state: SupermoonModeMarkerState): void {
  host.state.transcriptContainer.addChild(
    new SupermoonModeMarkerComponent(state),
  );
  host.state.ui.requestRender();
}
