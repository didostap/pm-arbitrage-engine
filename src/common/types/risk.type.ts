import Decimal from 'decimal.js';
import type {
  ClusterId,
  OpportunityId,
  PairId,
  PositionId,
  ReservationId,
} from './branded.type.js';

export interface TriageRecommendation {
  positionId: PositionId;
  pairId: PairId;
  expectedEdge: Decimal;
  capitalDeployed: Decimal;
  suggestedAction: 'close';
  reason: string;
}

export interface TriageRecommendationDto {
  positionId: string;
  pairId: string;
  expectedEdge: string;
  capitalDeployed: string;
  suggestedAction: 'close';
  reason: string;
}

export interface RiskDecision {
  approved: boolean;
  reason: string;
  maxPositionSizeUsd: Decimal;
  currentOpenPairs: number;
  dailyPnl?: Decimal;
  overrideApplied?: boolean;
  overrideRationale?: string;
  adjustedMaxPositionSizeUsd?: Decimal;
  clusterExposurePct?: Decimal;
  triageRecommendations?: TriageRecommendation[];
  confidenceScore?: number;
  confidenceAdjustedSizeUsd?: Decimal;
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

export interface StressTestResult {
  numScenarios: number;
  numPositions: number;
  bankrollUsd: Decimal;
  var95: Decimal;
  var99: Decimal;
  worstCaseLoss: Decimal;
  drawdown15PctProbability: Decimal;
  drawdown20PctProbability: Decimal;
  drawdown25PctProbability: Decimal;
  alertEmitted: boolean;
  suggestions: string[];
  scenarioDetails: {
    percentiles: Record<string, string>;
    syntheticResults: { name: string; portfolioPnl: string }[];
    volatilities: {
      contractId: string;
      platform: string;
      vol: string;
      source: string;
    }[];
  };
}
