import Decimal from 'decimal.js';

export interface RiskDecision {
  approved: boolean;
  reason: string;
  maxPositionSizeUsd: Decimal;
  currentOpenPairs: number;
}

export interface RiskExposure {
  openPairCount: number;
  totalCapitalDeployed: Decimal;
  bankrollUsd: Decimal;
  availableCapital: Decimal;
}

export interface RiskConfig {
  bankrollUsd: number;
  maxPositionPct: number;
  maxOpenPairs: number;
}
