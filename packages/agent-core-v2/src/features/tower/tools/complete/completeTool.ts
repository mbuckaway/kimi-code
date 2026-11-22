import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionEventBus } from '#/app/event/eventBus';
import { ISessionMessagingService } from '#/features/messaging/messaging';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { deliverTowerMessage } from '../delivery';
import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './complete.md?raw';
import {
  ITowerCompleteTool,
  TowerCompleteToolInputSchema,
  type TowerCompleteToolInput,
} from './complete';

export class TowerCompleteTool implements ITowerCompleteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerComplete' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerCompleteToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @ISessionMessagingService private readonly messaging: ISessionMessagingService,
  ) {}

  resolveExecution(rawArgs: TowerCompleteToolInput): ToolExecution {
    const parsed = TowerCompleteToolInputSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        output: parsed.error.issues.map((issue) => issue.message).join('; '),
      };
    }
    const args = parsed.data;
    return {
      description: 'Completing tower mission and storing its notification',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const result = await store.complete(caller, args.report, args.key_artifacts);
          const delivery =
            result.message === undefined
              ? ''
              : await deliverTowerMessage(
                  {
                    sessionBus: this.sessionBus,
                    messaging: this.messaging,
                    callerAgentId: this.scopeContext.agentId,
                    state,
                  },
                  result.message,
                );
          const lines = [`mission ${result.mission.id} persisted as ${result.mission.status}`];
          if (result.message !== undefined) {
            lines.push(
              `${result.message.item.subject} notification: ${result.message.item.file}`,
              result.notificationCreated
                ? 'notification: stored once'
                : 'notification: reused the stored message; no duplicate was written',
            );
          }
          if (result.notificationError !== undefined) {
            lines.push(`notification error: ${result.notificationError}`);
          }
          if (result.activityLogError !== undefined) {
            lines.push(`activity log error: ${result.activityLogError}`);
          }
          if (delivery.length > 0) lines.push(delivery);
          return {
            output: lines.join('\n'),
            isError:
              result.notificationError === undefined && result.activityLogError === undefined
                ? undefined
                : true,
          };
        }),
    };
  }
}
