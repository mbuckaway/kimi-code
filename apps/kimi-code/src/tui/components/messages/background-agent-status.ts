import { Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { BRAILLE_SPINNER_FRAMES, MESSAGE_INDENT } from '#/tui/constant/rendering';
import { FAILURE_MARK, STATUS_BULLET } from '#/tui/constant/symbols';
import type {
  SubagentActivityRecord,
  SubagentActivityStore,
} from '#/tui/controllers/subagent-activity-store';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { BackgroundAgentStatusData } from '#/tui/types';

const LIVE_REFRESH_INTERVAL_MS = 1000;
const LIVE_ACTIVITY_MAX_CHARS = 160;
const HEADLINE_STARTED_SUFFIX = ' started in background';

interface LiveStatusContent {
  readonly phase: 'running' | 'completed' | 'failed';
  readonly headline: string;
  readonly detail?: string;
  readonly activity?: string;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

/** Build the one-line activity hint: the latest tool call or the latest
 *  assistant text, plus the step count. */
function activitySummary(record: SubagentActivityRecord): string | undefined {
  const lastStep = record.steps.at(-1);
  const lastToolCall = lastStep?.toolCalls.at(-1);
  const parts: string[] = [];
  if (lastToolCall !== undefined && lastToolCall.name.length > 0) {
    parts.push(`${lastToolCall.status === 'running' ? 'Using' : 'Used'} ${lastToolCall.name}`);
  } else {
    const text = lastStep?.textTail.replaceAll(/\s+/g, ' ').trim();
    if (text !== undefined && text.length > 0) {
      parts.push(
        text.length <= LIVE_ACTIVITY_MAX_CHARS
          ? text
          : `…${text.slice(text.length - LIVE_ACTIVITY_MAX_CHARS)}`,
      );
    }
  }
  if (record.totalSteps > 0) {
    parts.push(`${String(record.totalSteps)} step${record.totalSteps === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

export class BackgroundAgentStatusComponent implements Component {
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly data: BackgroundAgentStatusData,
    private readonly activityStore?: SubagentActivityStore,
    private readonly requestRender?: () => void,
  ) {
    this.startRefresh();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const live = this.liveContent();
    // A terminal record, or a store cleared on session switch, ends the refresh
    // loop; the static fallback below still renders the spawn data.
    if (live === undefined || live.phase !== 'running') this.dispose();

    const headline = live?.headline ?? this.data.headline;
    const detail = live === undefined ? this.data.detail : live.detail;
    const phase = live?.phase ?? this.data.phase;

    const tone: keyof ColorPalette =
      phase === 'completed' ? 'success' : phase === 'failed' ? 'error' : 'primary';
    const marker =
      phase === 'failed'
        ? currentTheme.fg(tone, FAILURE_MARK)
        : phase === 'running'
          ? currentTheme.fg(
              tone,
              `${BRAILLE_SPINNER_FRAMES[this.spinnerFrame] ?? BRAILLE_SPINNER_FRAMES[0]} `,
            )
          : currentTheme.fg(tone, STATUS_BULLET);
    const text =
      currentTheme.fg(tone, headline) +
      (detail !== undefined && detail.length > 0
        ? currentTheme.fg('textDim', ` (${detail})`)
        : '');

    const textComponent = new Text(text, 0, 0);
    const contentWidth = Math.max(1, safeWidth - MESSAGE_INDENT.length);
    const contentLines = textComponent.render(contentWidth);
    const lines = [
      '',
      ...contentLines.map((line, index) => (index === 0 ? marker : MESSAGE_INDENT) + line),
    ];
    if (live?.activity !== undefined) {
      lines.push(MESSAGE_INDENT + currentTheme.dim(live.activity));
    }
    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private liveContent(): LiveStatusContent | undefined {
    const { agentId } = this.data;
    if (
      this.data.phase !== 'started' ||
      agentId === undefined ||
      this.activityStore === undefined
    ) {
      return undefined;
    }
    const record = this.activityStore.get(agentId);
    if (record === undefined) return undefined;

    const subject = this.subjectPrefix();
    if (record.status === 'running') {
      return {
        phase: 'running',
        headline: `${subject} running in background`,
        detail: this.elapsedLabel(),
        activity: activitySummary(record),
      };
    }
    const detail = record.status === 'completed' ? record.resultSummary : record.error;
    return {
      phase: record.status,
      headline: `${subject} ${record.status} in background`,
      detail: detail ?? this.data.detail,
    };
  }

  private subjectPrefix(): string {
    const suffixIndex = this.data.headline.indexOf(HEADLINE_STARTED_SUFFIX);
    return suffixIndex >= 0 ? this.data.headline.slice(0, suffixIndex) : this.data.headline;
  }

  private elapsedLabel(): string | undefined {
    const { startedAtMs } = this.data;
    if (startedAtMs === undefined) return undefined;
    return formatElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
  }

  private startRefresh(): void {
    if (this.requestRender === undefined || this.timer !== undefined) return;
    if (this.data.phase !== 'started' || this.data.agentId === undefined) return;
    if (this.activityStore === undefined) return;
    const requestRender = this.requestRender;
    this.timer = setInterval(() => {
      const live = this.liveContent();
      if (live === undefined || live.phase !== 'running') {
        this.dispose();
        return;
      }
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      requestRender();
    }, LIVE_REFRESH_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }
}
