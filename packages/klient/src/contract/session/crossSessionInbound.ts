/**
 * `crossSessionInboundService` — this session's cross-session inbound policy
 * (`accept` / `hold` / `refuse`). Mirrors
 * `agent-core-v2/features/messaging/crossSessionInbound.ts`; the service is
 * Session-scoped, so these methods run on `session(id)` rather than an agent.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const crossSessionInboundSchema = z.enum(['accept', 'hold', 'refuse']);

export const crossSessionInboundContract = {
  get: { input: z.tuple([]), output: crossSessionInboundSchema },
  set: { input: z.tuple([crossSessionInboundSchema]), output: noResult },
} satisfies ServiceContract;
