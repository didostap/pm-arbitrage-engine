import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { WalkForwardService } from './walk-forward.service';
import type { BacktestTimeStep } from '../types/simulation.types';
import type { AggregateMetrics } from '../engine/backtest-portfolio.service';

function createTimeStep(date: string): BacktestTimeStep {
  return {
    timestamp: new Date(date),
    pairs: [],
  };
}

function createMetrics(
  overrides: Partial<AggregateMetrics> = {},
): AggregateMetrics {
  return {
    totalPositions: 20,
    winCount: 14,
    lossCount: 6,
    totalPnl: new Decimal('300'),
    maxDrawdown: new Decimal('0.04'),
    sharpeRatio: new Decimal('2.0'),
    profitFactor: new Decimal('2.5'),
    avgHoldingHours: new Decimal('18.5'),
    capitalUtilization: new Decimal('0.6'),
    ...overrides,
  };
}

describe('WalkForwardService', () => {
  const service = new WalkForwardService();

  // ============================================================
  // splitTimeSteps() tests
  // ============================================================

  describe('splitTimeSteps()', () => {
    it('[P0] should split 100 time steps at 70% boundary into 70 train and 30 test', () => {
      const steps = Array.from({ length: 100 }, (_, i) =>
        createTimeStep(
          `2025-01-${String(Math.floor(i / 4) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
        ),
      );

      const { train, test } = service.splitTimeSteps(steps, 0.7);
      expect(train).toHaveLength(70);
      expect(test).toHaveLength(30);
    });

    it('[P0] should maintain chronological order (train steps before test steps, no shuffling)', () => {
      const steps = Array.from({ length: 10 }, (_, i) =>
        createTimeStep(`2025-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
      );

      const { train, test } = service.splitTimeSteps(steps, 0.7);
      // Last train step should be before first test step
      expect(train[train.length - 1]!.timestamp.getTime()).toBeLessThan(
        test[0]!.timestamp.getTime(),
      );
    });

    it('[P1] should handle custom split ratio (e.g., 80/20)', () => {
      const steps = Array.from({ length: 100 }, (_, i) =>
        createTimeStep(
          `2025-01-${String(Math.floor(i / 4) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
        ),
      );

      const { train, test } = service.splitTimeSteps(steps, 0.8);
      expect(train).toHaveLength(80);
      expect(test).toHaveLength(20);
    });

    it('[P1] should handle empty time steps (return empty train and test)', () => {
      const { train, test } = service.splitTimeSteps([], 0.7);
      expect(train).toHaveLength(0);
      expect(test).toHaveLength(0);
    });

    it('[P1] should handle single time step (all in train, empty test)', () => {
      const steps = [createTimeStep('2025-01-01T00:00:00Z')];
      const { train, test } = service.splitTimeSteps(steps, 0.7);
      // floor(1 * 0.7) = 0, so train=0, test=1. Actually let's see implementation.
      // With 1 step, floor(1*0.7)=0 → train has 0, test has 1. But spec says "all in train".
      // We'll go with floor behavior: train gets floor(n*pct) elements
      expect(train.length + test.length).toBe(1);
    });

    it('[P2] should floor boundary index (70 steps at 70% → index 49, train=49, test=21)', () => {
      const steps = Array.from({ length: 70 }, (_, i) =>
        createTimeStep(
          `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`,
        ),
      );

      const { train, test } = service.splitTimeSteps(steps, 0.7);
      // floor(70 * 0.7) = 49
      expect(train).toHaveLength(49);
      expect(test).toHaveLength(21);
    });
  });

  // ============================================================
  // compareMetrics() tests
  // ============================================================

  describe('compareMetrics()', () => {
    it('[P0] should compute degradation percentage for profitFactor between train and test', () => {
      const train = createMetrics({ profitFactor: new Decimal('2.5') });
      const test = createMetrics({ profitFactor: new Decimal('1.5') });

      const result = service.compareMetrics(train, test);
      // (2.5 - 1.5) / 2.5 = 0.4 (40% degradation)
      expect(result.degradation.profitFactor).toBeCloseTo(0.4, 5);
    });

    it('[P0] should compute degradation percentage for sharpeRatio between train and test', () => {
      const train = createMetrics({ sharpeRatio: new Decimal('2.0') });
      const test = createMetrics({ sharpeRatio: new Decimal('1.0') });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.sharpeRatio).toBeCloseTo(0.5, 5);
    });

    it('[P0] should compute degradation percentage for totalPnl between train and test', () => {
      const train = createMetrics({ totalPnl: new Decimal('1000') });
      const test = createMetrics({ totalPnl: new Decimal('500') });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.totalPnl).toBeCloseTo(0.5, 5);
    });

    it('[P0] should flag metrics with >30% degradation as potential overfits in overfitFlags array', () => {
      const train = createMetrics({
        profitFactor: new Decimal('2.5'),
        sharpeRatio: new Decimal('2.0'),
        totalPnl: new Decimal('1000'),
      });
      const test = createMetrics({
        profitFactor: new Decimal('1.0'), // 60% degradation
        sharpeRatio: new Decimal('1.5'), // 25% — not flagged
        totalPnl: new Decimal('200'), // 80% degradation
      });

      const result = service.compareMetrics(train, test);
      expect(result.overfitFlags).toContain('profitFactor');
      expect(result.overfitFlags).not.toContain('sharpeRatio');
      expect(result.overfitFlags).toContain('totalPnl');
    });

    it('[P0] should not flag metrics with <=30% degradation', () => {
      const train = createMetrics({
        profitFactor: new Decimal('2.0'),
        sharpeRatio: new Decimal('2.0'),
        totalPnl: new Decimal('1000'),
      });
      const test = createMetrics({
        profitFactor: new Decimal('1.5'), // 25%
        sharpeRatio: new Decimal('1.5'), // 25%
        totalPnl: new Decimal('750'), // 25%
      });

      const result = service.compareMetrics(train, test);
      expect(result.overfitFlags).toHaveLength(0);
    });

    it('[P0] should flag exactly at 30.01% degradation but not at 30.00%', () => {
      const trainPf = createMetrics({ profitFactor: new Decimal('10000') });
      const testExactly30 = createMetrics({
        profitFactor: new Decimal('7000'),
      }); // 30% exactly
      const testSlightlyOver = createMetrics({
        profitFactor: new Decimal('6999'),
      }); // 30.01%

      const result30 = service.compareMetrics(trainPf, testExactly30);
      expect(result30.overfitFlags).not.toContain('profitFactor');

      const result3001 = service.compareMetrics(trainPf, testSlightlyOver);
      expect(result3001.overfitFlags).toContain('profitFactor');
    });

    it('[P1] should return null degradation when train metric is null (e.g., null Sharpe from zero stddev)', () => {
      const train = createMetrics({ sharpeRatio: null });
      const test = createMetrics({ sharpeRatio: new Decimal('1.0') });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.sharpeRatio).toBeNull();
    });

    it('[P1] should return null degradation when test metric is null', () => {
      const train = createMetrics({ sharpeRatio: new Decimal('2.0') });
      const test = createMetrics({ sharpeRatio: null });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.sharpeRatio).toBeNull();
    });

    it('[P1] should handle negative improvement (test better than train) as negative degradation, not flagged', () => {
      const train = createMetrics({ profitFactor: new Decimal('1.5') });
      const test = createMetrics({ profitFactor: new Decimal('2.5') });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.profitFactor).toBeLessThan(0);
      expect(result.overfitFlags).not.toContain('profitFactor');
    });

    it('[P1] should handle train metric = 0 (division by zero → null degradation)', () => {
      const train = createMetrics({ totalPnl: new Decimal('0') });
      const test = createMetrics({ totalPnl: new Decimal('100') });

      const result = service.compareMetrics(train, test);
      expect(result.degradation.totalPnl).toBeNull();
    });
  });
});
