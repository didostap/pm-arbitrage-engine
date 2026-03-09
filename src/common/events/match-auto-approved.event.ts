import { BaseEvent } from './base.event';

export class MatchAutoApprovedEvent extends BaseEvent {
  constructor(
    public readonly matchId: string,
    public readonly confidenceScore: number,
    public readonly model: string,
    public readonly escalated: boolean,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
