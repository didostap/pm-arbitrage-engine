import { BaseEvent } from './base.event';
import { PlatformId } from '../types/platform.type';

export class OrderFilledEvent extends BaseEvent {
  constructor(
    public readonly orderId: string,
    public readonly platform: PlatformId,
    public readonly side: string,
    public readonly price: number,
    public readonly size: number,
    public readonly fillPrice: number,
    public readonly fillSize: number,
    public readonly positionId: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class ExecutionFailedEvent extends BaseEvent {
  constructor(
    public readonly reasonCode: number,
    public readonly reason: string,
    public readonly opportunityId: string,
    public readonly context: Record<string, unknown>,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
