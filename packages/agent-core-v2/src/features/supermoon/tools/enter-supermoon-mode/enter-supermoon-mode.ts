/**
 * `supermoon` domain — `IEnterSupermoonModeTool` contract.
 *
 * Public contract of the EnterSupermoonMode tool — the supermoon-mode entry
 * tool the LLM calls to enter supermoon mode directly: the (empty) input
 * schema and the Agent-scope identifier used to resolve the implementation
 * through the container. Entering supermoon mode does not require approval in
 * any permission mode. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const EnterSupermoonModeInputSchema = z.object({}).strict();
export type EnterSupermoonModeInput = z.infer<typeof EnterSupermoonModeInputSchema>;

export interface IEnterSupermoonModeTool extends AgentTool<EnterSupermoonModeInput> {
  readonly _serviceBrand: undefined;
}
export const IEnterSupermoonModeTool =
  createDecorator<IEnterSupermoonModeTool>('enterSupermoonModeTool');
