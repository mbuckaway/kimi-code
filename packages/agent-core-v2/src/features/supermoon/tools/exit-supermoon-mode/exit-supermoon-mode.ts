/**
 * `supermoon` domain — `IExitSupermoonModeTool` contract.
 *
 * Public contract of the ExitSupermoonMode tool — the supermoon-mode exit tool
 * the LLM calls to leave supermoon mode directly: the (empty) input schema and
 * the Agent-scope identifier used to resolve the implementation through the
 * container. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const ExitSupermoonModeInputSchema = z.object({}).strict();
export type ExitSupermoonModeInput = z.infer<typeof ExitSupermoonModeInputSchema>;

export interface IExitSupermoonModeTool extends AgentTool<ExitSupermoonModeInput> {
  readonly _serviceBrand: undefined;
}
export const IExitSupermoonModeTool =
  createDecorator<IExitSupermoonModeTool>('exitSupermoonModeTool');
