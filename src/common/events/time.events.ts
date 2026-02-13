import { BaseEvent } from './base.event';

/**
 * Emitted when clock drift exceeds 100ms but is below 500ms.
 * Operator should investigate but not urgent.
 */
export class TimeWarningEvent extends BaseEvent {
  constructor(
    public readonly driftMs: number,
    public readonly serverUsed: string,
    public readonly driftTimestamp: Date,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Emitted when clock drift exceeds 500ms but is below 1000ms.
 * Urgent attention required - potential audit trail issue.
 */
export class TimeCriticalEvent extends BaseEvent {
  constructor(
    public readonly driftMs: number,
    public readonly serverUsed: string,
    public readonly driftTimestamp: Date,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Emitted when clock drift exceeds 1000ms.
 * Triggers trading halt - unacceptable for financial system.
 */
export class TimeHaltEvent extends BaseEvent {
  constructor(
    public readonly driftMs: number,
    public readonly serverUsed: string,
    public readonly driftTimestamp: Date,
    public readonly haltReason: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
