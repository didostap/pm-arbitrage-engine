import Decimal from 'decimal.js';
import { BaseEvent } from './base.event';

/**
 * Emitted when an arbitrage opportunity meets minimum edge threshold.
 * Payload is an EnrichedOpportunity (defined in modules/arbitrage-detection/types),
 * typed as Record<string, unknown> here to avoid common/ → modules/ import.
 */
export class OpportunityIdentifiedEvent extends BaseEvent {
  constructor(
    public readonly opportunity: Record<string, unknown>,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}

/**
 * Emitted when an opportunity is filtered out (below threshold or negative edge).
 */
export class OpportunityFilteredEvent extends BaseEvent {
  constructor(
    public readonly pairEventDescription: string,
    public readonly netEdge: Decimal,
    public readonly threshold: Decimal,
    public readonly reason: string,
    correlationId?: string,
  ) {
    super(correlationId);
  }
}
