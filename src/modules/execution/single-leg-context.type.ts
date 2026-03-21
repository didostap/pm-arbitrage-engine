import type Decimal from 'decimal.js';
import type { OrderResult } from '../../common/types/platform.type';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import type { RankedOpportunity } from '../../common/types/risk.type';

/**
 * Context object for handleSingleLeg — replaces 17 positional parameters.
 * The unused `_reservation: BudgetReservation` (param 13) is intentionally omitted.
 */
export interface SingleLegContext {
  pairId: string;
  primaryLeg: string;
  primaryOrderId: string;
  primaryOrder: OrderResult;
  primarySide: string;
  secondarySide: string;
  primaryPrice: Decimal;
  secondaryPrice: Decimal;
  primarySize: number;
  secondarySize: number;
  enriched: EnrichedOpportunity;
  opportunity: RankedOpportunity;
  errorCode: number;
  errorMessage: string;
  isPaper: boolean;
  mixedMode: boolean;
  executionMetadata?: Record<string, unknown>;
}
