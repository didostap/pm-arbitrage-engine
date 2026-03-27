import type { BacktestStatus } from '@prisma/client';

export interface IBacktestConfig {
  dateRangeStart: string;
  dateRangeEnd: string;
  edgeThresholdPct: number;
  minConfidenceScore: number;
  positionSizePct: number;
  maxConcurrentPairs: number;
  bankrollUsd: string;
  tradingWindowStartHour: number;
  tradingWindowEndHour: number;
  gasEstimateUsd: string;
  exitEdgeEvaporationPct: number;
  exitTimeLimitHours: number;
  exitProfitCapturePct: number;
  walkForwardEnabled: boolean;
  walkForwardTrainPct: number;
  timeoutSeconds: number;
}

export interface BacktestRunStatus {
  runId: string;
  status: BacktestStatus;
  progress?: number;
  error?: string;
}

export interface IBacktestEngine {
  startRun(config: IBacktestConfig): Promise<string>;
  cancelRun(runId: string): Promise<void>;
  getRunStatus(runId: string): BacktestRunStatus | null;
}

export const BACKTEST_ENGINE_TOKEN = Symbol('IBacktestEngine');
