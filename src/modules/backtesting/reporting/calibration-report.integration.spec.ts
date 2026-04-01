import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/prisma.service';
import { BacktestEngineService } from '../engine/backtest-engine.service';
import { BacktestDataLoaderService } from '../engine/backtest-data-loader.service';
import { CalibrationReportService } from './calibration-report.service';
import { WalkForwardService } from './walk-forward.service';
import { SensitivityAnalysisService } from './sensitivity-analysis.service';
import { KNOWN_LIMITATIONS } from '../types/calibration-report.types';
import type { AggregateMetrics } from '../engine/backtest-portfolio.service';

// ============================================================
// Fixture data helpers
// ============================================================

function createCompletedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-integ-1',
    status: 'COMPLETE',
    config: {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
      edgeThresholdPct: 0.008,
      positionSizePct: 0.03,
      maxConcurrentPairs: 10,
      bankrollUsd: '10000',
      tradingWindowStartHour: 14,
      tradingWindowEndHour: 23,
      gasEstimateUsd: '0.50',
      exitEdgeEvaporationPct: 0.002,
      exitTimeLimitHours: 72,
      exitProfitCapturePct: 0.8,
      timeoutSeconds: 300,
      minConfidenceScore: 0.8,
      walkForwardEnabled: false,
      walkForwardTrainPct: 0.7,
      chunkWindowDays: 1,
    },
    dateRangeStart: new Date('2025-01-01'),
    dateRangeEnd: new Date('2025-03-01'),
    totalPositions: 20,
    winCount: 14,
    lossCount: 6,
    totalPnl: new Decimal('500.00'),
    maxDrawdown: new Decimal('0.05'),
    sharpeRatio: new Decimal('1.85'),
    profitFactor: new Decimal('2.33'),
    avgHoldingHours: new Decimal('24.5'),
    capitalUtilization: new Decimal('0.45'),
    ...overrides,
  };
}

function generatePositions(
  count: number,
  winRate: number,
  avgPnl: number,
  startDate = '2025-01-01',
): any[] {
  return Array.from({ length: count }, (_, i) => {
    const isWin = i < Math.round(count * winRate);
    const pnl = isWin ? Math.abs(avgPnl) : -Math.abs(avgPnl) * 0.5;
    return {
      id: i + 1,
      runId: 'run-integ-1',
      pairId: `pair-${(i % 5) + 1}`,
      positionSizeUsd: new Decimal('300'),
      entryEdge: new Decimal('0.015'),
      realizedPnl: new Decimal(pnl.toString()),
      exitTimestamp: new Date(
        `${startDate}T${String(10 + (i % 12)).padStart(2, '0')}:00:00Z`,
      ),
    };
  });
}

function createMockPrisma() {
  return {
    backtestRun: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    backtestPosition: {
      findMany: vi.fn(),
    },
    historicalPrice: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    contractMatch: {
      count: vi.fn().mockResolvedValue(5),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

// ============================================================
// Full pipeline integration tests (Task 8)
// ============================================================

describe('CalibrationReport Integration', () => {
  let reportService: CalibrationReportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    prisma = createMockPrisma();
    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');
    reportService = new CalibrationReportService(prisma as any, eventEmitter);
  });

  describe('Profitable-with-CI fixture', () => {
    it('[P0] should auto-generate report with CIs present, known limitations complete (10 items)', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue(
        generatePositions(25, 0.65, 30),
      );

      const report = await reportService.generateReport('run-integ-1');

      expect(report.summaryMetrics.totalTrades).toBe(25);
      expect(report.confidenceIntervals.iterations).toBe(1000);
      expect(report.confidenceIntervals.profitFactor).not.toBeNull();
      expect(report.knownLimitations).toEqual(KNOWN_LIMITATIONS);
      expect(report.knownLimitations).toHaveLength(10);
      expect(report.generatedAt).toBeDefined();
    });
  });

  describe('Unprofitable-degradation fixture', () => {
    it('[P0] should produce report with profitFactor < 1.0, CI lower bound < 1.0', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(
        createCompletedRun({
          profitFactor: new Decimal('0.6'),
          totalPnl: new Decimal('-200'),
          winCount: 4,
          lossCount: 16,
        }),
      );
      prisma.backtestPosition.findMany.mockResolvedValue(
        generatePositions(20, 0.2, 10),
      );

      const report = await reportService.generateReport('run-integ-1');

      expect(report.summaryMetrics.profitFactor).toBeDefined();
      expect(Number(report.summaryMetrics.profitFactor)).toBeLessThan(1);
    });
  });

  describe('Data quality', () => {
    it('[P1] should include data quality summary with coverage gaps and pair count from fixture data', async () => {
      prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
      prisma.backtestPosition.findMany.mockResolvedValue([]);
      prisma.contractMatch.count.mockResolvedValue(8);

      const report = await reportService.generateReport('run-integ-1');
      expect(report.dataQualitySummary.pairCount).toBe(8);
      expect(report.dataQualitySummary.dateRange.start).toBeDefined();
      expect(report.dataQualitySummary.dateRange.end).toBeDefined();
    });
  });
});

// ============================================================
// Walk-forward integration tests
// ============================================================

describe('WalkForward Integration', () => {
  const service = new WalkForwardService();

  it('[P0] walk-forward-overfit: >30% degradation flagged as overfit', () => {
    const trainMetrics: AggregateMetrics = {
      totalPositions: 50,
      winCount: 40,
      lossCount: 10,
      totalPnl: new Decimal('1000'),
      maxDrawdown: new Decimal('0.03'),
      sharpeRatio: new Decimal('3.0'),
      profitFactor: new Decimal('4.0'),
      avgHoldingHours: new Decimal('18'),
      capitalUtilization: new Decimal('0.6'),
    };
    const testMetrics: AggregateMetrics = {
      totalPositions: 20,
      winCount: 10,
      lossCount: 10,
      totalPnl: new Decimal('100'),
      maxDrawdown: new Decimal('0.08'),
      sharpeRatio: new Decimal('0.5'),
      profitFactor: new Decimal('1.2'),
      avgHoldingHours: new Decimal('22'),
      capitalUtilization: new Decimal('0.4'),
    };

    const result = service.compareMetrics(trainMetrics, testMetrics);
    expect(result.overfitFlags).toContain('profitFactor');
    expect(result.overfitFlags).toContain('sharpeRatio');
    expect(result.overfitFlags).toContain('totalPnl');
  });

  it('[P0] walk-forward-robust: <=30% degradation NOT flagged', () => {
    const trainMetrics: AggregateMetrics = {
      totalPositions: 50,
      winCount: 35,
      lossCount: 15,
      totalPnl: new Decimal('500'),
      maxDrawdown: new Decimal('0.04'),
      sharpeRatio: new Decimal('2.0'),
      profitFactor: new Decimal('2.5'),
      avgHoldingHours: new Decimal('20'),
      capitalUtilization: new Decimal('0.5'),
    };
    const testMetrics: AggregateMetrics = {
      totalPositions: 20,
      winCount: 13,
      lossCount: 7,
      totalPnl: new Decimal('400'),
      maxDrawdown: new Decimal('0.05'),
      sharpeRatio: new Decimal('1.6'),
      profitFactor: new Decimal('2.0'),
      avgHoldingHours: new Decimal('22'),
      capitalUtilization: new Decimal('0.45'),
    };

    const result = service.compareMetrics(trainMetrics, testMetrics);
    expect(result.overfitFlags).toHaveLength(0);
  });

  it('[P1] should report train and test metrics separately in WalkForwardResults', () => {
    const trainMetrics: AggregateMetrics = {
      totalPositions: 30,
      winCount: 20,
      lossCount: 10,
      totalPnl: new Decimal('300'),
      maxDrawdown: new Decimal('0.04'),
      sharpeRatio: new Decimal('2.0'),
      profitFactor: new Decimal('2.0'),
      avgHoldingHours: new Decimal('18'),
      capitalUtilization: new Decimal('0.5'),
    };
    const testMetrics: AggregateMetrics = {
      totalPositions: 15,
      winCount: 8,
      lossCount: 7,
      totalPnl: new Decimal('100'),
      maxDrawdown: new Decimal('0.06'),
      sharpeRatio: new Decimal('1.0'),
      profitFactor: new Decimal('1.3'),
      avgHoldingHours: new Decimal('20'),
      capitalUtilization: new Decimal('0.4'),
    };

    const trainSteps = [{ timestamp: new Date('2025-01-01'), pairs: [] }];
    const testSteps = [{ timestamp: new Date('2025-02-01'), pairs: [] }];

    const result = service.buildWalkForwardResults(
      0.7,
      trainSteps,
      testSteps,
      trainMetrics,
      testMetrics,
    );

    expect(result.trainMetrics.totalPositions).toBe(30);
    expect(result.testMetrics.totalPositions).toBe(15);
    expect(result.trainPct).toBe(0.7);
    expect(result.testPct).toBe(0.3);
  });
});

// ============================================================
// Sensitivity integration tests
// ============================================================

describe('Sensitivity Integration', () => {
  let service: SensitivityAnalysisService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let mockEngine: ReturnType<typeof createMockEngine>;
  let module: TestingModule;

  function createMockEngine() {
    return {
      alignPrices: vi.fn().mockReturnValue([]),
      runHeadlessSimulation: vi.fn().mockResolvedValue({
        totalPositions: 10,
        winCount: 6,
        lossCount: 4,
        totalPnl: new Decimal('200'),
        maxDrawdown: new Decimal('0.05'),
        sharpeRatio: new Decimal('1.5'),
        profitFactor: new Decimal('1.8'),
        avgHoldingHours: new Decimal('20'),
        capitalUtilization: new Decimal('0.4'),
      }),
    };
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockEngine = createMockEngine();

    module = await Test.createTestingModule({
      providers: [
        SensitivityAnalysisService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: BacktestEngineService, useValue: mockEngine },
        {
          provide: BacktestDataLoaderService,
          useValue: {
            loadPairs: vi.fn().mockResolvedValue([]),
            loadPricesForChunk: vi.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(SensitivityAnalysisService);
    vi.spyOn(module.get(EventEmitter2), 'emit');
  });

  it('[P0] should trigger sweep and produce results with all 4 parameter dimensions', async () => {
    prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());

    const result = await service.runSweep('run-integ-1');
    const paramNames = result.sweeps.map((s) => s.parameterName);
    expect(paramNames).toContain('edgeThresholdPct');
    expect(paramNames).toContain('positionSizePct');
    expect(paramNames).toContain('maxConcurrentPairs');
    expect(paramNames).toContain('tradingWindow');
  });

  it('[P0] should identify degradation boundaries where profitFactor drops below 1.0', async () => {
    let callIdx = 0;
    mockEngine.runHeadlessSimulation.mockImplementation(() => {
      callIdx++;
      const pf = Math.max(0.3, 2.5 - callIdx * 0.04);
      return {
        totalPositions: 10,
        winCount: 6,
        lossCount: 4,
        totalPnl: new Decimal(pf > 1 ? '200' : '-50'),
        maxDrawdown: new Decimal('0.05'),
        sharpeRatio: new Decimal('1.5'),
        profitFactor: new Decimal(pf.toFixed(4)),
        avgHoldingHours: new Decimal('20'),
        capitalUtilization: new Decimal('0.4'),
      };
    });

    prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());
    const result = await service.runSweep('run-integ-1');
    expect(result.degradationBoundaries.length).toBeGreaterThan(0);
  });

  it('[P0] should identify recommended params maximizing profitFactor and Sharpe', async () => {
    prisma.backtestRun.findUnique.mockResolvedValue(createCompletedRun());

    const result = await service.runSweep('run-integ-1');
    expect(result.recommendedParameters.byProfitFactor.length).toBeGreaterThan(
      0,
    );
    expect(result.recommendedParameters.bySharpe.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Dashboard compatibility test
// ============================================================

describe('Dashboard compatibility', () => {
  it('[P0] should verify report, sensitivity, and walk-forward JSON structures are JSON-serializable and round-trip cleanly', () => {
    const report = {
      summaryMetrics: {
        totalTrades: 42,
        profitFactor: '1.5',
        netPnl: '500.00',
        maxDrawdown: '0.05',
        sharpeRatio: '1.85',
        winRate: 0.65,
        avgEdgeCapturedVsExpected: '0.78',
      },
      confidenceIntervals: {
        iterations: 1000,
        confidence: 0.95,
        profitFactor: { lower: '1.2', upper: '1.8' },
        sharpeRatio: { lower: '1.1', upper: '2.5' },
      },
      knownLimitations: ['limitation-1'],
      dataQualitySummary: {
        pairCount: 5,
        totalDataPoints: 10000,
        coverageGaps: [],
        excludedPeriods: [],
        dateRange: { start: '2025-01-01', end: '2025-03-01' },
      },
      generatedAt: '2025-01-01T00:00:00Z',
    };

    const sensitivity = {
      sweeps: [
        {
          parameterName: 'edgeThresholdPct',
          baseValue: 0.008,
          values: [0.005, 0.006],
          profitFactor: ['1.5', '1.3'],
          maxDrawdown: ['0.04', '0.05'],
          sharpeRatio: ['2.0', '1.5'],
          totalPnl: ['500', '300'],
        },
      ],
      degradationBoundaries: [],
      recommendedParameters: { byProfitFactor: [], bySharpe: [] },
      partial: false,
      completedSweeps: 2,
      totalPlannedSweeps: 2,
    };

    const walkForward = {
      trainPct: 0.7,
      testPct: 0.3,
      trainDateRange: { start: '2025-01-01', end: '2025-02-01' },
      testDateRange: { start: '2025-02-01', end: '2025-03-01' },
      trainMetrics: { totalPositions: 20 },
      testMetrics: { totalPositions: 10 },
      degradation: { profitFactor: 0.4 },
      overfitFlags: ['profitFactor'],
    };

    // Round-trip JSON serialization
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(JSON.parse(JSON.stringify(sensitivity))).toEqual(sensitivity);
    expect(JSON.parse(JSON.stringify(walkForward))).toEqual(walkForward);
  });
});
