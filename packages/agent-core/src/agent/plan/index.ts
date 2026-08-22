import { randomUUID } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Agent } from '..';
import { generateHeroSlug } from '../../utils/hero-slug';
import { canSwitchModel, planningModelMatchesDefault } from '../../tools/builtin/model/switch-guard';

export type PlanData = null | {
  id: string;
  content: string;
  path: string;
};
export type PlanFilePath = string | null;

export class PlanMode {
  protected _isActive = false;
  protected _planId: null | string = null;
  protected _planFilePath: PlanFilePath = null;
  /**
   * The model alias observed at enter() when plan mode flipped the active
   * model to the configured planning model. exit()/cancel() restore the
   * configured default model, falling back to this alias when the config
   * does not name a default. Stays undefined when plan mode never switched
   * the model, so the restore path is a no-op.
   */
  private enterModelAlias: string | undefined;

  constructor(protected readonly agent: Agent) {}

  createPlanId(): string {
    return generateHeroSlug(randomUUID(), new Set());
  }

  async enter(id = this.createPlanId(), createFile = false, emitStatus = true): Promise<void> {
    if (this._isActive) {
      throw new Error('Already in plan mode');
    }

    this._isActive = true;
    this._planId = id;
    this._planFilePath = null;

    let enterRecorded = false;
    try {
      const planFilePath = this.planFilePathFor(id);
      this._planFilePath = planFilePath;
      await this.ensurePlanDirectory(planFilePath);
      this.agent.records.logRecord({ type: 'plan_mode.enter', id });
      enterRecorded = true;
      if (createFile) {
        await this.writeEmptyPlanFile(planFilePath);
      }
    } catch (error) {
      if (enterRecorded) {
        this.cancel(id);
      } else {
        this._isActive = false;
        this._planId = null;
        this._planFilePath = null;
      }
      throw error;
    }

    // A configured planning model may replace the active model for the
    // planning phase. The plan still enters when the switch is blocked or the
    // planning model cannot be resolved.
    this.maybeFlipToPlanningModel();

    if (emitStatus) this.agent.emitStatusUpdated();
  }

  restoreEnter({ id }: { readonly id: string }): void {
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: true,
    });

    this._isActive = true;
    this._planId = id;
    this._planFilePath = this.planFilePathFor(id);
  }

  cancel(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.cancel', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.maybeRestoreModelAfterPlan();
    this.agent.emitStatusUpdated();
  }

  async clear(): Promise<void> {
    if (!this._planFilePath) return;
    await this.writeEmptyPlanFile(this._planFilePath);
  }

  exit(id?: string): void {
    this.agent.records.logRecord({ type: 'plan_mode.exit', id });
    this.agent.replayBuilder.push({
      type: 'plan_updated',
      enabled: false,
    });
    this._isActive = false;
    this._planId = null;
    this._planFilePath = null;
    this.maybeRestoreModelAfterPlan();
    this.agent.emitStatusUpdated();
  }

  get isActive() {
    return this._isActive;
  }

  get planFilePath(): PlanFilePath {
    return this._planFilePath;
  }

  async data(): Promise<PlanData> {
    if (!this._planId || !this._planFilePath) return null;
    let content = '';
    try {
      content = await this.agent.kaos.readText(this._planFilePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      id: this._planId,
      content,
      path: this._planFilePath,
    };
  }

  private async writeEmptyPlanFile(path: string): Promise<void> {
    await this.ensurePlanDirectory(path);
    await this.agent.kaos.writeText(path, '');
  }

  private async ensurePlanDirectory(path: string): Promise<void> {
    await this.agent.kaos.mkdir(dirname(path), {
      parents: true,
      existOk: true,
    });
  }

  private planFilePathFor(id: string): string {
    const plansDir =
      this.agent.homedir === undefined
        ? join(this.agent.config.cwd, 'plan')
        : join(this.agent.homedir, 'plans');
    return join(plansDir, `${id}.md`);
  }

  /**
   * Flip the active model to the configured planning model. Guarded by the
   * context-window switch guard: the planning model must have a window at
   * least as large as the current model's, and both must resolve. On a
   * successful flip the model observed here is remembered so exit()/cancel()
   * can restore it.
   */
  private maybeFlipToPlanningModel(): void {
    const planningModel = this.agent.kimiConfig?.planningModel;
    const currentAlias = this.agent.config.modelAlias;
    if (planningModel === undefined || currentAlias === undefined) return;
    if (planningModel === currentAlias) return;
    const target = this.resolveMaxContext(planningModel);
    const current = this.resolveMaxContext(currentAlias);
    if (target === undefined || current === undefined) return;
    if (!canSwitchModel(target, current)) return;
    this.enterModelAlias = currentAlias;
    this.agent.config.update({ modelAlias: planningModel });
  }

  /**
   * Restore the model the user was on before plan mode (the configured default
   * model, falling back to the model observed at enter()). Only runs when plan
   * mode actually flipped the model, and only when the restore target has a
   * context window large enough to keep the current conversation.
   */
  private maybeRestoreModelAfterPlan(): void {
    if (this.enterModelAlias === undefined) return;
    const enterAlias = this.enterModelAlias;
    this.enterModelAlias = undefined;
    const currentAlias = this.agent.config.modelAlias;
    if (currentAlias === undefined) return;
    const defaultModel = this.agent.kimiConfig?.defaultModel;
    // When the planning model doubles as the configured default, restoring the
    // default keeps the planning model active — nothing to restore.
    if (planningModelMatchesDefault(this.agent.kimiConfig?.planningModel, defaultModel)) return;
    const restoreAlias = defaultModel ?? enterAlias;
    if (restoreAlias === currentAlias) return;
    const target = this.resolveMaxContext(restoreAlias);
    const current = this.resolveMaxContext(currentAlias);
    if (target === undefined || current === undefined) return;
    if (!canSwitchModel(target, current)) return;
    this.agent.config.update({ modelAlias: restoreAlias });
  }

  private resolveMaxContext(alias: string): number | undefined {
    try {
      return this.agent.modelProvider?.resolveProviderConfig(alias)?.modelCapabilities
        .max_context_tokens;
    } catch {
      return undefined;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT';
}
