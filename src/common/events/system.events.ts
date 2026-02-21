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

/**
 * Emitted when a halt reason is removed and trading may resume.
 */
export class TradingResumedEvent extends BaseEvent {
  constructor(
    public readonly removedReason: string,
    public readonly remainingReasons: string[],
    public readonly resumeTimestamp: Date,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Emitted when startup reconciliation completes, regardless of outcome.
 */
export class ReconciliationCompleteEvent extends BaseEvent {
  constructor(
    public readonly positionsChecked: number,
    public readonly ordersVerified: number,
    public readonly pendingOrdersResolved: number,
    public readonly discrepanciesFound: number,
    public readonly durationMs: number,
    public readonly summary: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Emitted for each discrepancy found during reconciliation.
 */
export class ReconciliationDiscrepancyEvent extends BaseEvent {
  constructor(
    public readonly positionId: string,
    public readonly pairId: string,
    public readonly discrepancyType:
      | 'order_status_mismatch'
      | 'order_not_found'
      | 'pending_filled'
      | 'platform_unavailable',
    public readonly localState: string,
    public readonly platformState: string,
    public readonly recommendedAction: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
