import Decimal from 'decimal.js';
import { ContractPairConfig } from '../../contract-matching/types';
import { NormalizedOrderBook, PlatformId } from '../../../common/types';

/**
 * Decimal fields are FinancialDecimal instances at runtime (precision=20).
 * Type uses base Decimal since FinancialDecimal is a value (cloned constructor), not a type.
 */
export interface RawDislocation {
  pairConfig: ContractPairConfig;
  buyPlatformId: PlatformId;
  sellPlatformId: PlatformId;
  buyPrice: Decimal;
  sellPrice: Decimal;
  grossEdge: Decimal;
  buyOrderBook: NormalizedOrderBook;
  sellOrderBook: NormalizedOrderBook;
  detectedAt: Date;
}
