import { BaseEvent } from './base.event';
import type { MatchId } from '../types/branded.type';

export class ResolutionDivergedEvent extends BaseEvent {
  constructor(
    public readonly matchId: MatchId,
    public readonly polymarketResolution: string,
    public readonly kalshiResolution: string,
    public readonly divergenceNotes: string | null,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
