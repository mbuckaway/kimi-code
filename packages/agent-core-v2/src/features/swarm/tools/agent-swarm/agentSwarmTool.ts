import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes, BugIndicatingError } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionSwarmService, type SessionSwarmTask } from '#/features/swarm/session/sessionSwarm';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { resolveSwarmTimeoutMs } from '#/features/swarm/configSection';
import { AGENT_MESSAGING_FLAG_ID } from '#/features/messaging/flag';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  PERSONA_EXPERIMENTAL_UNAVAILABLE,
  PERSONA_WITH_FORK_UNAVAILABLE,
  forkIncompatibility,
  type SubagentSpawnPlan,
} from '#/session/subagent/spawn';
import { AGENT_PERSONA_FLAG_ID, SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import {
  buildSubagentModelDescriptions,
  exposesSubagentModelChoice,
  stripSubagentForkParameter,
  stripSubagentModelParameter,
  stripParameters,
} from '#/session/subagent/configSection';
import { normalizeAgentName } from '#/session/subagent/agentNames';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  NAMES_EXPERIMENTAL_UNAVAILABLE,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';
import AGENT_SWARM_FORK_DESCRIPTION from './agent-swarm-fork.md?raw';

const PERSONA_WITH_PERSONAS_UNAVAILABLE =
  'persona and personas cannot be combined; use persona for every member or personas per item/prompt.';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item?: string;
  readonly prompt: string;
  readonly name?: string;
  readonly persona?: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  get parameters(): Record<string, unknown> {
    const parameters = exposesSubagentModelChoice(this.config, this.flags)
      ? AGENT_SWARM_PARAMETERS
      : AGENT_SWARM_PARAMETERS_NO_MODEL;
    const withFork = this.flags.enabled(SUBAGENT_FORK_FLAG_ID)
      ? parameters
      : stripSubagentForkParameter(parameters);
    const withNames = this.flags.enabled(AGENT_MESSAGING_FLAG_ID)
      ? withFork
      : stripParameters(withFork, 'names');
    return this.flags.enabled(AGENT_PERSONA_FLAG_ID)
      ? withNames
      : stripParameters(withNames, 'persona', 'personas');
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    let description = AGENT_SWARM_DESCRIPTION;
    if (this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
      description += `\n\n${AGENT_SWARM_FORK_DESCRIPTION}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
    );
    return modelLines === undefined ? description : `${description}\n\n${modelLines}`;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount =
      (args.items?.length ?? 0) +
      (args.prompts?.length ?? 0) +
      Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const hasPersona = args.persona !== undefined;
    const hasPersonas = args.personas !== undefined;
    if ((hasPersona || hasPersonas) && !this.flags.enabled(AGENT_PERSONA_FLAG_ID)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, PERSONA_EXPERIMENTAL_UNAVAILABLE);
    }
    if (args.names !== undefined && !this.flags.enabled(AGENT_MESSAGING_FLAG_ID)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, NAMES_EXPERIMENTAL_UNAVAILABLE);
    }
    const fork = args.fork === true;
    if (fork && !this.flags.enabled(SUBAGENT_FORK_FLAG_ID)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, FORK_EXPERIMENTAL_UNAVAILABLE);
    }
    if (fork && (hasPersona || hasPersonas)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, PERSONA_WITH_FORK_UNAVAILABLE);
    }
    if (fork && Object.keys(args.resume_agent_ids ?? {}).length > 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, FORK_WITH_RESUME_UNAVAILABLE);
    }
    if (hasPersona && hasPersonas) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, PERSONA_WITH_PERSONAS_UNAVAILABLE);
    }
    if ((args.items?.length ?? 0) > 0 || (args.prompts?.length ?? 0) > 0) {
      if (fork) {
        const incompatible = forkIncompatibility(
          { subagent_type: args.subagent_type, model: args.model },
          this.profile.data(),
        );
        if (incompatible !== undefined) {
          throw new Error2(ErrorCodes.VALIDATION_FAILED, incompatible);
        }
      }
    }
    const timeoutMs = resolveSwarmTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const plans = await this.resolveSpawnPlans(args, specs, fork);
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const plan = spec.kind === 'spawn' ? requirePlan(plans, spec) : undefined;
      const profileName = plan?.profileName ?? 'subagent';
      const descriptionName = spec.kind === 'resume' ? 'resume' : (spec.name ?? profileName);
      const common = {
        data: spec,
        profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground: false,
        swarmItem: spec.item,
        name: spec.kind === 'spawn' ? spec.name : undefined,
        signal,
        timeout: timeoutMs,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
        };
      }
      return {
        ...common,
        kind: 'spawn' as const,
        plan: requirePlan(plans, spec),
      };
    });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data, ...result })),
    );
  }

  private async resolveSpawnPlans(
    args: AgentSwarmToolInput,
    specs: readonly AgentSwarmSpec[],
    fork: boolean,
  ): Promise<Map<string, SubagentSpawnPlan>> {
    const plans = new Map<string, SubagentSpawnPlan>();
    for (const spec of specs) {
      if (spec.kind === 'resume') continue;
      const key = spec.persona ?? '';
      if (plans.has(key)) continue;
      plans.set(
        key,
        await this.subagents.planSpawn({
          callerAgentId: this.callerAgentId,
          profileName: args.subagent_type,
          model: args.model,
          fork,
          persona: spec.persona,
        }),
      );
    }
    return plans;
  }
}

function requirePlan(
  plans: ReadonlyMap<string, SubagentSpawnPlan>,
  spec: AgentSwarmSpawnSpec,
): SubagentSpawnPlan {
  const plan = plans.get(spec.persona ?? '');
  if (plan === undefined) {
    throw new BugIndicatingError(`No spawn plan recorded for swarm member ${String(spec.index)}`);
  }
  return plan;
}

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const prompts = (args.prompts ?? []).map((prompt) => prompt.trim());
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  const itemCount = items.length;
  const promptCount = prompts.length;
  const resumeCount = resumeEntries.length;
  if (promptCount > 0 && (itemCount > 0 || promptTemplate !== undefined)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompts cannot be combined with items or prompt_template.',
    );
  }
  const newCount = promptCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(newCount, resumeCount)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      promptCount > 0
        ? 'AgentSwarm requires at least 2 prompts unless resume_agent_ids is provided.'
        : 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (resumeCount + newCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: resumeCount + newCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  if (itemCount > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }
  const namedSpecs = resolveSpecNames(args.names, newCount, promptCount, itemCount);
  const requestedPersonas = resolveSpecPersonas(
    args.personas,
    newCount,
    promptCount,
    itemCount,
  );
  const sharedPersona = normalizeOptionalString(args.persona);

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (promptCount > 0) {
    prompts.forEach((prompt, index) => {
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          'Duplicate subagent prompts. AgentSwarm requires distinct subagents.',
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        prompt,
        name: namedSpecs?.[index],
        persona: requestedPersonas?.[index] ?? sharedPersona,
      });
    });
  } else if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
        name: namedSpecs?.[index],
        persona: requestedPersonas?.[index] ?? sharedPersona,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function resolveCohortValues(
  values: readonly string[] | undefined,
  newCount: number,
  promptCount: number,
  itemCount: number,
  label: string,
  missingMessage: string,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (newCount === 0) {
    throw new Error2(ErrorCodes.VALIDATION_FAILED, missingMessage);
  }
  const expected = promptCount > 0 ? promptCount : itemCount;
  if (values.length !== expected) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm ${label} must match the number of items/prompts (expected ${String(expected)}, got ${String(values.length)}).`,
    );
  }
  return values;
}

function resolveSpecNames(
  names: readonly string[] | undefined,
  newCount: number,
  promptCount: number,
  itemCount: number,
): readonly string[] | undefined {
  const resolved = resolveCohortValues(
    names,
    newCount,
    promptCount,
    itemCount,
    'names',
    'names requires items or prompts; resumed subagents keep their existing names.',
  );
  if (resolved === undefined) return undefined;
  const seenNames = new Map<string, number>();
  return resolved.map((raw, index) => {
    const name = normalizeAgentName(raw);
    const previousIndex = seenNames.get(name);
    if (previousIndex !== undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'Duplicate subagent names. AgentSwarm requires distinct names.',
        { details: { name, previousIndex, index: index + 1 } },
      );
    }
    seenNames.set(name, index + 1);
    return name;
  });
}

function resolveSpecPersonas(
  personas: readonly string[] | undefined,
  newCount: number,
  promptCount: number,
  itemCount: number,
): readonly string[] | undefined {
  return resolveCohortValues(
    personas,
    newCount,
    promptCount,
    itemCount,
    'personas',
    'personas requires items or prompts; resumed subagents keep their existing roles.',
  )?.map((persona) => persona.trim());
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const name =
      result.spec.kind === 'spawn' && result.spec.name !== undefined
        ? ` name="${escapeXmlAttribute(result.spec.name)}"`
        : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${name}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
