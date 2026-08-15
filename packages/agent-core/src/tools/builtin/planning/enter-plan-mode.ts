/**
 * EnterPlanModeTool — plan-mode entry tool.
 *
 * The LLM calls this tool to enter plan mode directly. Entering plan mode
 * does not require approval in any permission mode.
 */


import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import DESCRIPTION from './enter-plan-mode.md?raw';

// ── Input schema ─────────────────────────────────────────────────────

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;

export class EnterPlanModeTool implements BuiltinTool<EnterPlanModeInput> {
  readonly name = 'EnterPlanMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterPlanModeInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: EnterPlanModeInput): ToolExecution {
    return {
      description: 'Requesting to enter plan mode',
      approvalRule: this.name,
      execute: async () => {
        // Guard: already in plan mode
        if (this.agent.planMode.isActive) {
          return {
            isError: true,
            output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
          };
        }

        try {
          await this.agent.planMode.enter();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
          return { isError: true, output: `Failed to enter plan mode: ${message}` };
        }

        this.agent.telemetry.track('plan_enter_resolved', { outcome: 'auto_approved' });
        return { output: enteredPlanModeMessage(this.agent.planMode.planFilePath) };
      },
    };
  }
}

function enteredPlanModeMessage(planPath: string | null): string {
  if (planPath === null) {
    return [
      'Plan mode is now active. Your workflow:',
      'Do not make shit up. Do your research. Ask questions for clarification and to resolve ambiguities.',
      '',
      '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
      '2. Design a concrete, step-by-step plan. If the plan has multiple approaches, ask the user which one to take with AskUserQuestion before writing the plan.',
      '3. Plan review gate — before calling ExitPlanMode: check whether the `plan-review` skill is available in your skill listing. If it is available AND the plan file does not already contain a `## Review Findings` section, run the `plan-review` skill and resolve every finding it raises — edit the plan inline, ask the user via AskUserQuestion, or annotate `BLOCKING:`; do not skip or defer its findings. The skill\'s close-out calls ExitPlanMode itself — do NOT call ExitPlanMode again after it. If the skill is unavailable or has already run, skip this step.',
      '4. Wait for the host to provide a plan file path before calling ExitPlanMode.',
      '',
      'Do NOT use Write or Edit while plan mode is active in this host; no plan file path is available.',
      'Use Bash only when needed; Bash follows the normal permission mode and rules.',
    ].join('\n');
  }

  return [
    'Plan mode is now active. Your workflow:',
    'Do not make shit up. Do your research. Ask questions for clarification and to resolve ambiguities.',
    '',
    `Plan file: ${planPath}`,
    '',
    '1. Use read-only tools (Read, Grep, Glob) to investigate the codebase. Use Bash only when needed.',
    '2. Design a concrete, step-by-step plan. If the plan has multiple approaches, ask the user which one to take with AskUserQuestion before writing the plan.',
    '3. Write the plan to the plan file with Write or Edit.',
    '4. Plan review gate — before calling ExitPlanMode: check whether the `plan-review` skill is available in your skill listing. If it is available AND the plan file does not already contain a `## Review Findings` section (that section is the plan-review skill\'s signature output; its presence means the skill has already run for this plan), run the `plan-review` skill and resolve every finding it raises — edit the plan inline, ask the user via AskUserQuestion, or annotate `BLOCKING:`; do not skip or defer its findings. The skill\'s close-out calls ExitPlanMode itself — do NOT call ExitPlanMode again after it. If the skill ends with a `BLOCKING:` finding or aborts on one of its gates, stop and surface the blocker to the user instead. If the skill is unavailable or has already run, skip this step.',
    '5. When the plan is ready, call ExitPlanMode for user approval.',
    '',
    'Do NOT edit files other than the plan file while plan mode is active.',
    'Use Bash only when needed; Bash follows the normal permission mode and rules.',
  ].join('\n');
}
