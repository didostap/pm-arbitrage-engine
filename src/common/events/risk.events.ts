import { BaseEvent } from './base.event';

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
    public readonly opportunityId: string,
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
    public readonly opportunityId: string,
    public readonly rationale: string,
    public readonly denialReason: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetReservedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: string,
    public readonly opportunityId: string,
    public readonly reservedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetCommittedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: string,
    public readonly opportunityId: string,
    public readonly committedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class BudgetReleasedEvent extends BaseEvent {
  constructor(
    public readonly reservationId: string,
    public readonly opportunityId: string,
    public readonly releasedCapitalUsd: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
