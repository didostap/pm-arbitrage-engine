import { BaseEvent } from './base.event';

export interface ExternalPairIngestionSourceStats {
  source: string;
  fetched: number;
  deduplicated: number;
  scored: number;
  autoApproved: number;
  pendingReview: number;
  autoRejected: number;
  scoringFailures: number;
  unresolvable: number;
  providerError?: string;
}

export class ExternalPairIngestionRunCompletedEvent extends BaseEvent {
  public readonly eventName = 'contract.external-pair-ingestion.run_completed';

  constructor(
    public readonly sources: ExternalPairIngestionSourceStats[],
    public readonly durationMs: number,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
