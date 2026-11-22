import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { IConfigService } from '#/app/config/config';

import {
  resolveCrossSessionInbound,
  type CrossSessionInbound,
} from './crossSessionInbound';

export interface ICrossSessionInboundService {
  readonly _serviceBrand: undefined;

  get(): CrossSessionInbound;
  set(value: CrossSessionInbound): void;

  readonly onDidChange: Event<CrossSessionInbound>;
}

export const ICrossSessionInboundService: ServiceIdentifier<ICrossSessionInboundService> =
  createDecorator<ICrossSessionInboundService>('crossSessionInboundService');

export class CrossSessionInboundService
  extends Disposable
  implements ICrossSessionInboundService
{
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<CrossSessionInbound>());
  readonly onDidChange: Event<CrossSessionInbound> = this._onDidChange.event;

  private value: CrossSessionInbound;

  constructor(@IConfigService configService: IConfigService) {
    super();
    this.value = resolveCrossSessionInbound(configService);
  }

  get(): CrossSessionInbound {
    return this.value;
  }

  set(value: CrossSessionInbound): void {
    if (value === this.value) return;
    this.value = value;
    this._onDidChange.fire(value);
  }
}
