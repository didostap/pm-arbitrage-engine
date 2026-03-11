import { BaseEvent } from './base.event';
import type { MatchId } from '../types/branded.type';

export class MatchAutoApprovedEvent extends BaseEvent {
  constructor(
    public readonly matchId: MatchId,
    public readonly confidenceScore: number,
    public readonly model: string,
    public readonly escalated: boolean,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
