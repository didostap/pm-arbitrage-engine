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
