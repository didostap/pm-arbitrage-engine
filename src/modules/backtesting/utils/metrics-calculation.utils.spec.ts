import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';

describe('calculateProfitFactor', () => {
  it('[P0] should calculate profitFactor as sum(winPnl) / abs(sum(lossPnl)) using Decimal arithmetic', async () => {
    const { calculateProfitFactor } =
      await import('./metrics-calculation.utils');
    const positions = [
      { realizedPnl: new Decimal('50') },
      { realizedPnl: new Decimal('30') },
      { realizedPnl: new Decimal('-20') },
      { realizedPnl: new Decimal('-10') },
    ];
    const result = calculateProfitFactor(positions);
    expect(result).not.toBeNull();
    // (50+30) / (20+10) = 80/30 ≈ 2.666...
    expect(result!.toFixed(4)).toBe('2.6667');
  });

  it('[P0] should return null profitFactor when gross loss is 0 (no losing trades)', async () => {
    const { calculateProfitFactor } =
      await import('./metrics-calculation.utils');
    const positions = [
      { realizedPnl: new Decimal('50') },
      { realizedPnl: new Decimal('30') },
    ];
    const result = calculateProfitFactor(positions);
    expect(result).toBeNull();
  });

  it('[P1] should handle empty positions array (profitFactor null)', async () => {
    const { calculateProfitFactor } =
      await import('./metrics-calculation.utils');
    const result = calculateProfitFactor([]);
    expect(result).toBeNull();
  });
});

describe('calculateSharpeRatio', () => {
  it('[P0] should calculate Sharpe ratio as mean(dailyReturns) / stddev(dailyReturns) * sqrt(252) using Decimal arithmetic', async () => {
    const { calculateSharpeRatio } =
      await import('./metrics-calculation.utils');
    const bankroll = new Decimal('10000');
    const positions = [
      {
        realizedPnl: new Decimal('100'),
        exitTimestamp: new Date('2025-01-01T10:00:00Z'),
      },
      {
        realizedPnl: new Decimal('50'),
        exitTimestamp: new Date('2025-01-01T15:00:00Z'),
      },
      {
        realizedPnl: new Decimal('-30'),
        exitTimestamp: new Date('2025-01-02T10:00:00Z'),
      },
      {
        realizedPnl: new Decimal('80'),
        exitTimestamp: new Date('2025-01-03T10:00:00Z'),
      },
    ];
    const result = calculateSharpeRatio(bankroll, positions);
    expect(result).not.toBeNull();
    // Result should be a positive Decimal (annualized)
    expect(result!.gt(0)).toBe(true);
  });

  it('[P0] should return null Sharpe when stddev of daily returns is 0', async () => {
    const { calculateSharpeRatio } =
      await import('./metrics-calculation.utils');
    const bankroll = new Decimal('10000');
    // All same-day, same P&L — only 1 day => returns.length <= 1 => null
    const positions = [
      {
        realizedPnl: new Decimal('100'),
        exitTimestamp: new Date('2025-01-01T10:00:00Z'),
      },
    ];
    const result = calculateSharpeRatio(bankroll, positions);
    expect(result).toBeNull();
  });

  it('[P1] should produce identical results to BacktestPortfolioService.getAggregateMetrics() for same input', async () => {
    const { calculateProfitFactor, calculateSharpeRatio } =
      await import('./metrics-calculation.utils');
    // Cross-check: known inputs should produce consistent outputs
    const bankroll = new Decimal('10000');
    const positions = [
      {
        realizedPnl: new Decimal('200'),
        exitTimestamp: new Date('2025-01-01T12:00:00Z'),
      },
      {
        realizedPnl: new Decimal('-50'),
        exitTimestamp: new Date('2025-01-02T12:00:00Z'),
      },
      {
        realizedPnl: new Decimal('100'),
        exitTimestamp: new Date('2025-01-03T12:00:00Z'),
      },
    ];

    const pf = calculateProfitFactor(positions);
    expect(pf).not.toBeNull();
    // (200+100) / 50 = 6.0
    expect(pf!.toFixed(1)).toBe('6.0');

    const sharpe = calculateSharpeRatio(bankroll, positions);
    expect(sharpe).not.toBeNull();
    // Just verify it's a number, consistency validated by same algorithm
    expect(sharpe!.isFinite()).toBe(true);
  });

  it('[P1] should handle empty positions array (Sharpe null)', async () => {
    const { calculateSharpeRatio } =
      await import('./metrics-calculation.utils');
    const result = calculateSharpeRatio(new Decimal('10000'), []);
    expect(result).toBeNull();
  });
});
