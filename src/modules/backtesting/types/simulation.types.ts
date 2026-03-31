import Decimal from 'decimal.js';
import type { BacktestExitReason } from '@prisma/client';

export interface SimulatedPosition {
  positionId: string;
  pairId: string;
  kalshiContractId: string;
  polymarketContractId: string;
  kalshiSide: string;
  polymarketSide: string;
  kalshiEntryPrice: Decimal;
  polymarketEntryPrice: Decimal;
  kalshiExitPrice: Decimal | null;
  polymarketExitPrice: Decimal | null;
  positionSizeUsd: Decimal;
  entryEdge: Decimal;
  exitEdge: Decimal | null;
  entryTimestamp: Date;
  exitTimestamp: Date | null;
  exitReason: BacktestExitReason | null;
  realizedPnl: Decimal | null;
  fees: Decimal | null;
  holdingHours: Decimal | null;
}

export function createSimulatedPosition(params: {
  positionId: string;
  pairId: string;
  kalshiContractId: string;
  polymarketContractId: string;
  kalshiSide: string;
  polymarketSide: string;
  kalshiEntryPrice: Decimal;
  polymarketEntryPrice: Decimal;
  positionSizeUsd: Decimal;
  entryEdge: Decimal;
  entryTimestamp: Date;
}): SimulatedPosition {
  return {
    ...params,
    kalshiExitPrice: null,
    polymarketExitPrice: null,
    exitEdge: null,
    exitTimestamp: null,
    exitReason: null,
    realizedPnl: null,
    fees: null,
    holdingHours: null,
  };
}

export interface BacktestPortfolioState {
  availableCapital: Decimal;
  deployedCapital: Decimal;
  /** Cleanup: .delete() on closePosition, .clear() on reset */
  openPositions: Map<string, SimulatedPosition>;
  closedPositions: SimulatedPosition[];
  peakEquity: Decimal;
  currentEquity: Decimal;
  realizedPnl: Decimal;
  maxDrawdown: Decimal;
}

export function createInitialPortfolioState(
  bankroll: Decimal,
): BacktestPortfolioState {
  return {
    availableCapital: bankroll,
    deployedCapital: new Decimal(0),
    openPositions: new Map(),
    closedPositions: [],
    peakEquity: bankroll,
    currentEquity: bankroll,
    realizedPnl: new Decimal(0),
    maxDrawdown: new Decimal(0),
  };
}

export interface BacktestTimeStepPair {
  pairId: string;
  kalshiContractId: string;
  polymarketContractId: string;
  kalshiClose: Decimal;
  polymarketClose: Decimal;
  resolutionTimestamp: Date | null;
}

export interface BacktestTimeStep {
  timestamp: Date;
  pairs: BacktestTimeStepPair[];
}

export interface ExitEvaluation {
  triggered: boolean;
  reason: BacktestExitReason;
  priority: number;
  currentEdge: Decimal | null;
}
