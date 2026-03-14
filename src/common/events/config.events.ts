import { BaseEvent } from './base.event';

export class BankrollUpdatedEvent extends BaseEvent {
  constructor(
    public readonly previousValue: string,
    public readonly newValue: string,
    public readonly updatedBy: string = 'dashboard',
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
