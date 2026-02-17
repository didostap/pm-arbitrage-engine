import Decimal from 'decimal.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  maxPositionSizeUsd: Decimal;
  currentOpenPairs: number;
  dailyPnl?: Decimal;
  overrideApplied?: boolean;
  overrideRationale?: string;
}

export interface RiskExposure {
  openPairCount: number;
  totalCapitalDeployed: Decimal;
  bankrollUsd: Decimal;
  availableCapital: Decimal;
  dailyPnl: Decimal;
  dailyLossLimitUsd: Decimal;
}

export interface RiskConfig {
  bankrollUsd: number;
  maxPositionPct: number;
  maxOpenPairs: number;
  dailyLossPct: number;
}

export interface ReservationRequest {
  opportunityId: string;
  recommendedPositionSizeUsd: Decimal;
  pairId: string;
}

export interface BudgetReservation {
  reservationId: string;
  opportunityId: string;
  reservedPositionSlots: number;
  reservedCapitalUsd: Decimal;
  correlationExposure: Decimal;
  createdAt: Date;
}

export interface RankedOpportunity {
  opportunity: unknown;
  netEdge: Decimal;
  reservationRequest: ReservationRequest;
}

export interface ExecutionQueueResult {
  opportunityId: string;
  reserved: boolean;
  executed: boolean;
  committed: boolean;
  error?: string;
}
