import { BaseEvent } from './base.event';

export interface DiscoveryRunStats {
  catalogsFetched: number;
  candidatesPreFiltered: number;
  pairsScored: number;
  autoApproved: number;
  autoRejected: number;
  pendingReview: number;
  scoringFailures: number;
  durationMs: number;
}

export class DiscoveryRunCompletedEvent extends BaseEvent {
  constructor(
    public readonly stats: DiscoveryRunStats,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
