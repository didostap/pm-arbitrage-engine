export class BacktestRunResponseDto {
  id!: string;
  status!: string;
  config!: Record<string, unknown>;
  dateRangeStart!: string;
  dateRangeEnd!: string;
  startedAt!: string;
  completedAt!: string | null;
  totalPositions!: number | null;
  winCount!: number | null;
  lossCount!: number | null;
  totalPnl!: string | null;
  maxDrawdown!: string | null;
  sharpeRatio!: string | null;
  profitFactor!: string | null;
  avgHoldingHours!: string | null;
  capitalUtilization!: string | null;
  errorMessage!: string | null;
  createdAt!: string;
  updatedAt!: string;
  positions?: BacktestPositionResponseDto[];
}

export class BacktestPositionResponseDto {
  id!: number;
  runId!: string;
  pairId!: string;
  kalshiContractId!: string;
  polymarketContractId!: string;
  kalshiSide!: string;
  polymarketSide!: string;
  entryTimestamp!: string;
  exitTimestamp!: string | null;
  kalshiEntryPrice!: string;
  polymarketEntryPrice!: string;
  kalshiExitPrice!: string | null;
  polymarketExitPrice!: string | null;
  positionSizeUsd!: string;
  entryEdge!: string;
  exitEdge!: string | null;
  realizedPnl!: string | null;
  fees!: string | null;
  exitReason!: string | null;
  holdingHours!: string | null;
  qualityFlags!: Record<string, unknown> | null;
  createdAt!: string;
}
