import { BaseEvent } from './base.event';

/**
 * Emitted when trading is halted for any reason (time drift, risk limits, etc.)
 */
export class TradingHaltedEvent extends BaseEvent {
  constructor(
    public readonly reason: string,
    public readonly details: unknown,
    public readonly haltTimestamp: Date,
    public readonly severity: 'critical' | 'warning',
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
