import { describe, it, expect } from 'vitest';

describe('BacktestRunResponseDto', () => {
  it('[P2] should construct with aggregate metrics fields', async () => {
    const { BacktestRunResponseDto } = await import('./backtest-result.dto');
    const dto = new BacktestRunResponseDto();
    dto.id = 'uuid-1';
    dto.status = 'COMPLETE';
    dto.totalPositions = 10;
    dto.winCount = 7;
    dto.lossCount = 3;
    dto.totalPnl = '150.50';
    dto.maxDrawdown = '0.05';
    dto.sharpeRatio = '1.85';
    dto.profitFactor = '2.33';
    dto.avgHoldingHours = '24.5';
    dto.capitalUtilization = '0.45';

    expect(dto).toEqual(
      expect.objectContaining({
        id: 'uuid-1',
        status: 'COMPLETE',
        totalPositions: 10,
        winCount: 7,
        lossCount: 3,
        totalPnl: '150.50',
        maxDrawdown: '0.05',
        sharpeRatio: '1.85',
        profitFactor: '2.33',
        avgHoldingHours: '24.5',
        capitalUtilization: '0.45',
      }),
    );
  });
});

describe('BacktestPositionResponseDto', () => {
  it('[P2] should construct with entry/exit fields', async () => {
    const { BacktestPositionResponseDto } =
      await import('./backtest-result.dto');
    const dto = new BacktestPositionResponseDto();
    dto.id = 1;
    dto.pairId = 'pair-1';
    dto.kalshiSide = 'BUY';
    dto.polymarketSide = 'SELL';
    dto.kalshiEntryPrice = '0.45';
    dto.polymarketEntryPrice = '0.52';
    dto.kalshiExitPrice = '0.50';
    dto.polymarketExitPrice = '0.48';
    dto.realizedPnl = '25.00';
    dto.exitReason = 'PROFIT_CAPTURE';
    dto.holdingHours = '12.5';

    expect(dto).toEqual(
      expect.objectContaining({
        id: 1,
        pairId: 'pair-1',
        kalshiSide: 'BUY',
        polymarketSide: 'SELL',
        realizedPnl: '25.00',
        exitReason: 'PROFIT_CAPTURE',
      }),
    );
  });
});
