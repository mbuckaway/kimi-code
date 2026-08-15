/**
 * `plan` domain — `IEnterPlanModeTool` implementation.
 *
 * Enters plan mode through the plan service (`plan`), reporting an error when
 * plan mode is already active, and tracks the `plan_enter_resolved`
 * `auto_approved` outcome (`telemetry`). The result message walks the model
 * through the plan-mode workflow, including the plan file path when the host
 * provides one. Bound at Agent scope.
 */

import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPlanService } from '#/features/plan/plan';

import DESCRIPTION from './enter-plan-mode.md?raw';
import {
  EnterPlanModeInputSchema,
  IEnterPlanModeTool,
  type EnterPlanModeInput,
} from './enter-plan-mode';

export class EnterPlanModeTool implements IEnterPlanModeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'EnterPlanMode' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EnterPlanModeInputSchema);

  constructor(
    @IAgentPlanService private readonly planMode: IAgentPlanService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  resolveExecution(_args: EnterPlanModeInput): ToolExecution {
    return {
      description: 'Requesting to enter plan mode',
      approvalRule: this.name,
      execute: async () => {
        const before = await this.planMode.status();
        if (before !== null) {
          return {
            isError: true,
            output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.',
          };
        }

        try {
          await this.planMode.enter();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enter plan mode.';
          return { isError: true, output: `Failed to enter plan mode: ${message}` };
        }

        this.telemetry.track2('plan_enter_resolved', {
          outcome: 'auto_approved',
        });
        const after = await this.planMode.status();
        return { output: enteredPlanModeMessage(after?.path ?? null) };
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
