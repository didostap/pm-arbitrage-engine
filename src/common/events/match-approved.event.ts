import { BaseEvent } from './base.event';
import type { ContractId, MatchId } from '../types/branded.type';

export class MatchApprovedEvent extends BaseEvent {
  constructor(
    public readonly matchId: MatchId,
    public readonly polymarketContractId: ContractId,
    public readonly kalshiContractId: ContractId,
    public readonly operatorRationale: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
