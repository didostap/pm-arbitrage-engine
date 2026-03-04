import { BaseEvent } from './base.event';

export class MatchApprovedEvent extends BaseEvent {
  constructor(
    public readonly matchId: string,
    public readonly polymarketContractId: string,
    public readonly kalshiContractId: string,
    public readonly operatorRationale: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
