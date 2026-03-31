export { PlatformId } from './platform.type.js';
export type {
  PlatformHealth,
  OrderParams,
  OrderResult,
  OrderStatusResult,
  CancelResult,
  Position,
  FeeSchedule,
} from './platform.type.js';
export type {
  NormalizedOrderBook,
  PriceLevel,
} from './normalized-order-book.type.js';
export type { DriftResult } from './ntp.type.js';
export type { RiskDecision, RiskExposure, RiskConfig } from './risk.type.js';
export type {
  ReconciliationContext,
  ReconciliationResult,
  ReconciliationDiscrepancy,
} from './reconciliation.types.js';
export type {
  Branded,
  PositionId,
  OrderId,
  PairId,
  MatchId,
  ContractId,
  OpportunityId,
  ReservationId,
} from './branded.type.js';
export {
  asPositionId,
  asOrderId,
  asPairId,
  asMatchId,
  asContractId,
  asOpportunityId,
  asReservationId,
  unwrapId,
} from './branded.type.js';
export type {
  ExternalMatchedPair,
  ExternalMatchSource,
} from '../../modules/backtesting/types/match-validation.types.js';
