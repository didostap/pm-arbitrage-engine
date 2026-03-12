import Decimal from 'decimal.js';
import type {
  ClusterId,
  OpportunityId,
  PairId,
  ReservationId,
} from './branded.type.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  maxPositionSizeUsd: Decimal;
  currentOpenPairs: number;
  dailyPnl?: Decimal;
  overrideApplied?: boolean;
  overrideRationale?: string;
}

export interface ClusterExposure {
  clusterId: ClusterId;
  clusterName: string;
  exposureUsd: Decimal;
  exposurePct: Decimal;
  pairCount: number;
}

export interface RiskExposure {
  openPairCount: number;
  totalCapitalDeployed: Decimal;
  bankrollUsd: Decimal;
  availableCapital: Decimal;
  dailyPnl: Decimal;
  dailyLossLimitUsd: Decimal;
  clusterExposures: ClusterExposure[];
  aggregateClusterExposurePct: Decimal;
}

export interface ClusterAssignment {
  clusterId: ClusterId;
  clusterName: string;
  rawCategories: { platform: string; rawCategory: string }[];
  wasLlmClassified: boolean;
}

export interface RiskConfig {
  bankrollUsd: number;
  maxPositionPct: number;
  maxOpenPairs: number;
  dailyLossPct: number;
}

export interface ReservationRequest {
  opportunityId: OpportunityId;
  recommendedPositionSizeUsd: Decimal;
  pairId: PairId;
  isPaper: boolean;
}

export interface BudgetReservation {
  reservationId: ReservationId;
  opportunityId: OpportunityId;
  pairId: PairId;
  isPaper: boolean;
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
  opportunityId: OpportunityId;
  reserved: boolean;
  executed: boolean;
  committed: boolean;
  error?: string;
}
