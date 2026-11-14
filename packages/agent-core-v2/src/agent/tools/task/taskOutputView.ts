import type { AgentTaskInfo, AgentTaskOutputSnapshot } from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';

export const OUTPUT_PREVIEW_BYTES = 32 * 1024;

const PAGING_HINT_LINES = 300;

export function retrievalStatus(status: AgentTaskStatus): 'success' | 'not_ready' {
  return TERMINAL_STATUSES.has(status) ? 'success' : 'not_ready';
}

export function terminalReasonOf(
  info: AgentTaskInfo,
): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

export function fullOutputHintOf(output: AgentTaskOutputSnapshot): string | undefined {
  if (!output.fullOutputAvailable || output.outputPath === undefined) return undefined;
  if (output.truncated) {
    return (
      `Only the last ${String(OUTPUT_PREVIEW_BYTES)} bytes are shown above. ` +
      'Use the Read tool with the output_path to page through the full log ' +
      `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
      'lines per page).'
    );
  }
  return (
    'The preview above is the complete output. Use the Read tool with the output_path ' +
    'if you need to re-read the full log later ' +
    `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
    'lines per page).'
  );
}
