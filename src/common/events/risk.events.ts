import { BaseEvent } from './base.event';
import type { OpportunityId, ReservationId } from '../types/branded.type';

export class LimitApproachedEvent extends BaseEvent {
  constructor(
    public readonly limitType: string,
    public readonly currentValue: number,
    public readonly threshold: number,
    public readonly percentUsed: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class LimitBreachedEvent extends BaseEvent {
  constructor(
    public readonly limitType: string,
    public readonly currentValue: number,
    public readonly threshold: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class OverrideAppliedEvent extends BaseEvent {
  constructor(
    public readonly opportunityId: OpportunityId,
    public readonly rationale: string,
    public readonly originalRejectionReason: string,
    public readonly overrideAmountUsd: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class OverrideDeniedEvent extends BaseEvent {
  constructor(
    public readonly opportunityId: OpportunityId,
    public readonly rationale: string,
    public readonly denialReason: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetReservedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: ReservationId,
    public readonly opportunityId: OpportunityId,
    public readonly reservedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetCommittedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: ReservationId,
    public readonly opportunityId: OpportunityId,
    public readonly committedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetReleasedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: ReservationId,
    public readonly opportunityId: OpportunityId,
    public readonly releasedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
