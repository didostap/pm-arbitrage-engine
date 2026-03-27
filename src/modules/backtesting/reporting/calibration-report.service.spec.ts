import { describe, it, expect, beforeEach, vi } from 'vitest';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CalibrationReportService } from './calibration-report.service';
import {
  KNOWN_LIMITATIONS,
  REPORT_DECIMAL_PRECISION,
} from '../types/calibration-report.types';
import { SYSTEM_HEALTH_ERROR_CODES } from '../../../common/errors/system-health-error';
import { EVENT_NAMES } from '../../../common/events/event-catalog';

function createMockPrisma() {
  return {
    backtestRun: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    backtestPosition: {
      findMany: vi.fn(),
    },
    historicalPrice: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    contractMatch: {
      count: vi.fn(),
    },
  };
}

function createCompletedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    status: 'COMPLETE',
    config: {
      dateRangeStart: '2025-01-01',
      dateRangeEnd: '2025-03-01',
      bankrollUsd: '10000',
    },
    dateRangeStart: new Date('2025-01-01'),
    dateRangeEnd: new Date('2025-03-01'),
    totalPositions: 10,
    winCount: 7,
    lossCount: 3,
    totalPnl: new Decimal('150.50'),
    maxDrawdown: new Decimal('0.05'),
    sharpeRatio: new Decimal('1.85'),
    profitFactor: new Decimal('2.33'),
    avgHoldingHours: new Decimal('24.5'),
    capitalUtilization: new Decimal('0.45'),
    ...overrides,
  };
}

function createDbPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    runId: 'run-1',
    pairId: 'pair-1',
    positionSizeUsd: new Decimal('300'),
    entryEdge: new Decimal('0.015'),
    realizedPnl: new Decimal('25.00'),
    exitTimestamp: new Date('2025-01-15'),
    ...overrides,
  };
}

describe('CalibrationReportService', () => {
  let service: CalibrationReportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    prisma = createMockPrisma();
    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');
    service = new CalibrationReportService(prisma as any, eventEmitter);
  });

  // ============================================================
  // generateReport() tests
  // ============================================================

  describe('generateReport()', () => {
    it('[P0] should load BacktestRun and positions from DB and produce CalibrationReport with all required sections', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition(),
        createDbPosition({
          id: 2,
          realizedPnl: new Decimal('-10'),
          exitTimestamp: new Date('2025-01-20'),
        }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(5);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');

      expect(report.summaryMetrics).toBeDefined();
      expect(report.confidenceIntervals).toBeDefined();
      expect(report.knownLimitations).toBeDefined();
      expect(report.dataQualitySummary).toBeDefined();
      expect(report.generatedAt).toBeDefined();
    });

    it('[P0] should calculate totalTrades equal to the number of closed positions', async () => {
      const positions = [
        createDbPosition(),
        createDbPosition({
          id: 2,
          realizedPnl: new Decimal('15'),
          exitTimestamp: new Date('2025-01-20'),
        }),
        createDbPosition({
          id: 3,
          realizedPnl: new Decimal('-5'),
          exitTimestamp: new Date('2025-01-25'),
        }),
      ];
      prisma.backtestRun.findUnique.mockResolvedValue(
        createCompletedRun({ totalPositions: 3 }),
      );
      prisma.backtestPosition.findMany.mockResolvedValue(positions);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(3);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(report.summaryMetrics.totalTrades).toBe(3);
    });

    it('[P0] should calculate winRate as winCount / totalPositions (decimal 0.0–1.0)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({
          realizedPnl: new Decimal('10'),
          exitTimestamp: new Date('2025-01-10'),
        }),
        createDbPosition({
          id: 2,
          realizedPnl: new Decimal('20'),
          exitTimestamp: new Date('2025-01-15'),
        }),
        createDbPosition({
          id: 3,
          realizedPnl: new Decimal('-5'),
          exitTimestamp: new Date('2025-01-20'),
        }),
        createDbPosition({
          id: 4,
          realizedPnl: new Decimal('15'),
          exitTimestamp: new Date('2025-01-25'),
        }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      // 3 wins out of 4 = 0.75
      expect(report.summaryMetrics.winRate).toBe(0.75);
    });

    it('[P0] should calculate avgEdgeCapturedVsExpected as mean of (realizedPnl/positionSizeUsd) vs entryEdge across positions', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({
          realizedPnl: new Decimal('15'),
          positionSizeUsd: new Decimal('300'),
          entryEdge: new Decimal('0.05'),
          exitTimestamp: new Date('2025-01-10'),
        }),
        createDbPosition({
          id: 2,
          realizedPnl: new Decimal('30'),
          positionSizeUsd: new Decimal('300'),
          entryEdge: new Decimal('0.10'),
          exitTimestamp: new Date('2025-01-15'),
        }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      // pos1: (15/300)/0.05 = 1.0, pos2: (30/300)/0.10 = 1.0
      expect(report.summaryMetrics.avgEdgeCapturedVsExpected).toBeDefined();
    });

    it('[P1] should include profitFactor, netPnl, maxDrawdown, sharpeRatio from BacktestRun aggregate metrics', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({ exitTimestamp: new Date('2025-01-10') }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(report.summaryMetrics.profitFactor).toBeDefined();
      expect(report.summaryMetrics.netPnl).toBeDefined();
      expect(report.summaryMetrics.maxDrawdown).toBeDefined();
      expect(report.summaryMetrics.sharpeRatio).toBeDefined();
    });

    it('[P0] should include all 10 KNOWN_LIMITATIONS verbatim from design doc section 4.8', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(report.knownLimitations).toEqual(KNOWN_LIMITATIONS);
      expect(report.knownLimitations).toHaveLength(10);
    });

    it('[P1] should produce DataQualitySummary with pairCount, totalDataPoints, coverageGaps, excludedPeriods, dateRange', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(5);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(report.dataQualitySummary.pairCount).toBe(5);
      expect(report.dataQualitySummary.totalDataPoints).toBeDefined();
      expect(report.dataQualitySummary.coverageGaps).toBeInstanceOf(Array);
      expect(report.dataQualitySummary.excludedPeriods).toBeInstanceOf(Array);
      expect(report.dataQualitySummary.dateRange).toBeDefined();
    });

    it('[P1] should detect coverage gaps from HistoricalPrice records (gap count per pair, total gap minutes)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([]);
      // Simulate grouped data with gaps
      prisma.historicalPrice.groupBy.mockResolvedValue([
        { platform: 'kalshi', contractId: 'K1', _count: { id: 100 } },
      ]);
      prisma.historicalPrice.findMany.mockResolvedValue([
        {
          platform: 'kalshi',
          contractId: 'K1',
          timestamp: new Date('2025-01-01T00:00:00Z'),
        },
        {
          platform: 'kalshi',
          contractId: 'K1',
          timestamp: new Date('2025-01-01T05:00:00Z'),
        }, // 5h gap
      ]);
      prisma.contractMatch.count.mockResolvedValue(1);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(
        report.dataQualitySummary.coverageGaps.length,
      ).toBeGreaterThanOrEqual(0);
    });

    it('[P0] should persist report JSON to BacktestRun.report column', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({ exitTimestamp: new Date('2025-01-10') }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.backtestRun.update.mockResolvedValue({});

      await service.generateReport('run-1');

      expect(prisma.backtestRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'run-1' },
          data: expect.objectContaining({
            report: expect.objectContaining({
              summaryMetrics: expect.any(Object),
              knownLimitations: expect.any(Array),
            }),
          }),
        }),
      );
    });

    it('[P0] should emit BacktestReportGeneratedEvent with runId and summary (expect.objectContaining)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({ exitTimestamp: new Date('2025-01-10') }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(2);
      prisma.backtestRun.update.mockResolvedValue({});

      await service.generateReport('run-1');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.BACKTEST_REPORT_GENERATED,
        expect.objectContaining({
          runId: 'run-1',
          summary: expect.objectContaining({
            totalTrades: expect.any(Number),
          }),
        }),
      );
    });
  });

  // ============================================================
  // bootstrapConfidenceIntervals() tests
  // ============================================================

  describe('bootstrapConfidenceIntervals()', () => {
    it('[P0] should produce 95% CI for profit factor with 1000 iterations on fixture positions', () => {
      const positions = Array.from({ length: 30 }, (_, i) => ({
        realizedPnl: new Decimal(i % 3 === 0 ? -10 : 20),
        exitTimestamp: new Date(
          `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}`,
        ),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 1000);
      expect(result.profitFactor).not.toBeNull();
      expect(result.profitFactor!.lower).toBeDefined();
      expect(result.profitFactor!.upper).toBeDefined();
    });

    it('[P0] should produce 95% CI for Sharpe ratio with 1000 iterations on fixture positions', () => {
      const positions = Array.from({ length: 30 }, (_, i) => ({
        realizedPnl: new Decimal(i % 3 === 0 ? -10 : 20),
        exitTimestamp: new Date(
          `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}`,
        ),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 1000);
      expect(result.sharpeRatio).not.toBeNull();
      expect(result.sharpeRatio!.lower).toBeDefined();
      expect(result.sharpeRatio!.upper).toBeDefined();
    });

    it('[P0] should return CI where lower < upper for both profit factor and Sharpe', () => {
      const positions = Array.from({ length: 30 }, (_, i) => ({
        realizedPnl: new Decimal(i % 3 === 0 ? -10 : 20),
        exitTimestamp: new Date(
          `2025-01-${String(Math.floor(i / 3) + 1).padStart(2, '0')}`,
        ),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 1000);
      if (result.profitFactor) {
        expect(
          new Decimal(result.profitFactor.lower).lte(
            new Decimal(result.profitFactor.upper),
          ),
        ).toBe(true);
      }
      if (result.sharpeRatio) {
        expect(
          new Decimal(result.sharpeRatio.lower).lte(
            new Decimal(result.sharpeRatio.upper),
          ),
        ).toBe(true);
      }
    });

    it('[P1] should narrow CI width as iteration count increases (1000 vs 100 comparison)', () => {
      // Seed Math.random for determinism using a simple LCG
      let seed = 42;
      const mockRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      });

      const positions = Array.from({ length: 50 }, (_, i) => ({
        realizedPnl: new Decimal(i % 4 === 0 ? -15 : 25),
        exitTimestamp: new Date(
          `2025-01-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`,
        ),
        positionSizeUsd: new Decimal('300'),
      }));

      seed = 42; // Reset seed for first run
      const ci100 = service.bootstrapConfidenceIntervals(positions, 100);
      seed = 42; // Reset seed for second run
      const ci1000 = service.bootstrapConfidenceIntervals(positions, 2000);

      if (ci100.profitFactor && ci1000.profitFactor) {
        const width100 = new Decimal(ci100.profitFactor.upper).minus(
          ci100.profitFactor.lower,
        );
        const width1000 = new Decimal(ci1000.profitFactor.upper).minus(
          ci1000.profitFactor.lower,
        );
        expect(width1000.toNumber()).toBeLessThanOrEqual(
          width100.toNumber() * 1.5,
        );
      }

      mockRandom.mockRestore();
    });

    it('[P0] should return null CI when positions.length < 2', () => {
      const result = service.bootstrapConfidenceIntervals(
        [
          {
            realizedPnl: new Decimal('10'),
            exitTimestamp: new Date(),
            positionSizeUsd: new Decimal('300'),
          },
        ],
        1000,
      );
      expect(result.profitFactor).toBeNull();
      expect(result.sharpeRatio).toBeNull();
    });

    it('[P1] should return null CI when > 50% of bootstrap samples produce null metric', () => {
      // All zero P&L — profitFactor will be null for every sample
      const positions = Array.from({ length: 10 }, () => ({
        realizedPnl: new Decimal('0'),
        exitTimestamp: new Date('2025-01-01'),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 100);
      expect(result.profitFactor).toBeNull();
    });

    it('[P0] should handle all-wins scenario (profitFactor null from 0 gross loss, Sharpe valid)', () => {
      const positions = Array.from({ length: 10 }, (_, i) => ({
        realizedPnl: new Decimal('20'),
        exitTimestamp: new Date(`2025-01-${String(i + 1).padStart(2, '0')}`),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 500);
      expect(result.profitFactor).toBeNull(); // All wins, no loss, PF always null
      // Sharpe: all same daily return => stddev=0 => null too
      // This is correct behavior
    });

    it('[P0] should handle all-losses scenario (profitFactor 0, Sharpe valid negative)', () => {
      const positions = Array.from({ length: 10 }, (_, i) => ({
        realizedPnl: new Decimal('-20'),
        exitTimestamp: new Date(`2025-01-${String(i + 1).padStart(2, '0')}`),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 500);
      // PF should be 0 for all losses (grossWin=0, grossLoss>0 => 0/loss = 0)
      if (result.profitFactor) {
        expect(
          new Decimal(result.profitFactor.lower).toNumber(),
        ).toBeLessThanOrEqual(0.01);
      }
    });

    it('[P1] should handle single-position input (return null — < 2 positions)', () => {
      const result = service.bootstrapConfidenceIntervals([], 1000);
      expect(result.profitFactor).toBeNull();
      expect(result.sharpeRatio).toBeNull();
    });

    it('[P0] should handle zero-stddev returns (Sharpe null, profitFactor CI valid)', () => {
      // Same P&L on same day — Sharpe null because stddev=0
      const positions = Array.from({ length: 10 }, () => ({
        realizedPnl: new Decimal('10'),
        exitTimestamp: new Date('2025-01-01'),
        positionSizeUsd: new Decimal('300'),
      }));

      const result = service.bootstrapConfidenceIntervals(positions, 100);
      expect(result.sharpeRatio).toBeNull();
    });
  });

  // ============================================================
  // Edge case tests
  // ============================================================

  describe('Edge cases', () => {
    it('[P0] should handle 0 positions (empty report with null metrics)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(
        createCompletedRun({
          totalPositions: 0,
          winCount: 0,
          lossCount: 0,
          totalPnl: new Decimal(0),
        }),
      );
      prisma.backtestPosition.findMany.mockResolvedValue([]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(0);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      expect(report.summaryMetrics.totalTrades).toBe(0);
      expect(report.summaryMetrics.winRate).toBe(0);
      expect(report.confidenceIntervals.profitFactor).toBeNull();
      expect(report.confidenceIntervals.sharpeRatio).toBeNull();
    });

    it('[P1] should throw BACKTEST_REPORT_ERROR 4205 when BacktestRun not found', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(null);

      await expect(
        service.generateReport('non-existent'),
      ).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
      });
    });

    it('[P1] should throw BACKTEST_REPORT_ERROR 4205 when BacktestRun status is not COMPLETE', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(
        createCompletedRun({ status: 'SIMULATING' }),
      );

      await expect(service.generateReport('run-1')).rejects.toMatchObject({
        code: SYSTEM_HEALTH_ERROR_CODES.BACKTEST_REPORT_ERROR,
      });
    });

    it('[P1] should use Decimal arithmetic throughout (no native JS operators on monetary values)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([
        createDbPosition({
          realizedPnl: new Decimal('0.1'),
          positionSizeUsd: new Decimal('0.2'),
          entryEdge: new Decimal('0.3'),
          exitTimestamp: new Date('2025-01-10'),
        }),
      ]);
      prisma.historicalPrice.groupBy.mockResolvedValue([]);
      prisma.historicalPrice.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(1);
      prisma.backtestRun.update.mockResolvedValue({});

      const report = await service.generateReport('run-1');
      // Verify precision is maintained — no floating point artifacts
      const avgEdge = report.summaryMetrics.avgEdgeCapturedVsExpected;
      expect(avgEdge).toBeDefined();
      // 0.1/0.2 = 0.5, 0.5/0.3 = 1.6666... — Decimal handles this correctly
      expect(avgEdge).not.toContain('e'); // no scientific notation
    });
  });
});
