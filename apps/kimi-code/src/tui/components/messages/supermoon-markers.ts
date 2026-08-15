import { truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

export type SupermoonModeMarkerState = 'active' | 'inactive';

export class SupermoonModeMarkerComponent implements Component {
  constructor(private readonly state: SupermoonModeMarkerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, supermoonMarkerLabel(this.state));
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}

function supermoonMarkerLabel(state: SupermoonModeMarkerState): string {
  switch (state) {
    case 'active':
      return 'Supermoon activated';
    case 'inactive':
      return 'Supermoon deactivated';
  }
}
