import { BaseEvent } from './base.event';

export class ResolutionDivergedEvent extends BaseEvent {
  constructor(
    public readonly matchId: string,
    public readonly polymarketResolution: string,
    public readonly kalshiResolution: string,
    public readonly divergenceNotes: string | null,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
