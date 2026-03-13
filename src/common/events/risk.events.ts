import { BaseEvent } from './base.event';
import type {
  ClusterId,
  MatchId,
  OpportunityId,
  ReservationId,
} from '../types/branded.type';
import type { TriageRecommendationDto } from '../types/risk.type';

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

export class ClusterLimitApproachedEvent extends BaseEvent {
  constructor(
    public readonly clusterName: string,
    public readonly clusterId: ClusterId,
    public readonly currentExposurePct: number,
    public readonly threshold: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class ClusterOverrideEvent extends BaseEvent {
  constructor(
    public readonly matchId: MatchId,
    public readonly oldClusterId: ClusterId | null,
    public readonly newClusterId: ClusterId,
    public readonly rationale: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class ClusterAssignedEvent extends BaseEvent {
  constructor(
    public readonly matchId: MatchId,
    public readonly clusterId: ClusterId,
    public readonly clusterName: string,
    public readonly wasLlmClassified: boolean,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class ClusterLimitBreachedEvent extends BaseEvent {
  constructor(
    public readonly clusterName: string,
    public readonly clusterId: ClusterId,
    public readonly currentExposurePct: number,
    public readonly hardLimitPct: number,
    public readonly triageRecommendations: TriageRecommendationDto[],
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

export class AggregateClusterLimitBreachedEvent extends BaseEvent {
  constructor(
    public readonly aggregateExposurePct: number,
    public readonly aggregateLimitPct: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
