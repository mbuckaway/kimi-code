import { z } from 'zod';

import type { IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CROSS_SESSION_INBOUND_SECTION = 'crossSessionInbound';

export const CrossSessionInboundSchema = z.enum(['accept', 'hold', 'refuse']);

export type CrossSessionInbound = z.infer<typeof CrossSessionInboundSchema>;

export const DEFAULT_CROSS_SESSION_INBOUND: CrossSessionInbound = 'accept';

registerConfigSection(CROSS_SESSION_INBOUND_SECTION, CrossSessionInboundSchema, {
  defaultValue: DEFAULT_CROSS_SESSION_INBOUND,
});

export function resolveCrossSessionInbound(config: IConfigService): CrossSessionInbound {
  return (
    config.get<CrossSessionInbound | undefined>(CROSS_SESSION_INBOUND_SECTION) ??
    DEFAULT_CROSS_SESSION_INBOUND
  );
}
