import { BaseEvent } from './base.event';

export interface ResolutionPollStats {
  totalChecked: number;
  newlyResolved: number;
  diverged: number;
  skippedInvalid: number;
  pendingOnePlatform: number;
  errors: number;
}

export class ResolutionPollCompletedEvent extends BaseEvent {
  constructor(
    public readonly stats: ResolutionPollStats,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
