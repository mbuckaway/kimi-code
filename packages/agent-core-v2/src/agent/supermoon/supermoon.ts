import { createDecorator } from '#/_base/di/instantiation';

export type SupermoonModeTrigger = 'manual' | 'task' | 'tool';

export interface IAgentSupermoonService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: SupermoonModeTrigger): void;
  exit(): void;
}

export const IAgentSupermoonService = createDecorator<IAgentSupermoonService>('agentSupermoonService');
