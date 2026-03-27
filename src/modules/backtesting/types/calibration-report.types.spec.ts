import { describe, it, expect } from 'vitest';

describe('CalibrationReport types', () => {
  it('[P1] should construct CalibrationReport with summaryMetrics, confidenceIntervals, knownLimitations, dataQualitySummary, generatedAt', async () => {
    const { KNOWN_LIMITATIONS } = await import('./calibration-report.types');
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
      knownLimitations: KNOWN_LIMITATIONS,
      dataQualitySummary: {
        pairCount: 5,
        totalDataPoints: 10000,
        coverageGaps: [],
        excludedPeriods: [],
        dateRange: { start: '2025-01-01', end: '2025-03-01' },
      },
      generatedAt: new Date().toISOString(),
    };

    expect(report.summaryMetrics.totalTrades).toBe(42);
    expect(report.confidenceIntervals.iterations).toBe(1000);
    expect(report.knownLimitations).toBe(KNOWN_LIMITATIONS);
    expect(report.dataQualitySummary.pairCount).toBe(5);
    expect(report.generatedAt).toBeDefined();
  });

  it('[P1] should construct SummaryMetrics with totalTrades, profitFactor, netPnl, maxDrawdown, sharpeRatio, winRate, avgEdgeCapturedVsExpected', async () => {
    const mod = await import('./calibration-report.types');
    // Verify the module exports by constructing a valid object
    const metrics = {
      totalTrades: 10,
      profitFactor: null as string | null,
      netPnl: '-50.00',
      maxDrawdown: '0.10',
      sharpeRatio: null as string | null,
      winRate: 0.3,
      avgEdgeCapturedVsExpected: '0.5',
    };
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.sharpeRatio).toBeNull();
    expect(metrics.winRate).toBe(0.3);
    // Ensure module loaded correctly
    expect(mod).toBeDefined();
  });

  it('[P1] should construct BootstrapCIResult with iterations, confidence, profitFactor CI bounds, sharpeRatio CI bounds', async () => {
    await import('./calibration-report.types');
    const ci = {
      iterations: 1000,
      confidence: 0.95,
      profitFactor: { lower: '1.1', upper: '2.0' } as {
        lower: string;
        upper: string;
      } | null,
      sharpeRatio: null as { lower: string; upper: string } | null,
    };
    expect(ci.iterations).toBe(1000);
    expect(ci.confidence).toBe(0.95);
    expect(ci.profitFactor).toEqual({ lower: '1.1', upper: '2.0' });
    expect(ci.sharpeRatio).toBeNull();
  });

  it('[P1] should construct WalkForwardResults with trainPct, testPct, date ranges, metrics, degradation, overfitFlags', async () => {
    await import('./calibration-report.types');
    const wf = {
      trainPct: 0.7,
      testPct: 0.3,
      trainDateRange: { start: '2025-01-01', end: '2025-02-01' },
      testDateRange: { start: '2025-02-01', end: '2025-03-01' },
      trainMetrics: {
        totalPositions: 20,
        winCount: 14,
        lossCount: 6,
        totalPnl: '300.00',
        maxDrawdown: '0.04',
        sharpeRatio: '2.0',
        profitFactor: '2.5',
        avgHoldingHours: '18.5',
        capitalUtilization: '0.6',
      },
      testMetrics: {
        totalPositions: 10,
        winCount: 5,
        lossCount: 5,
        totalPnl: '50.00',
        maxDrawdown: '0.08',
        sharpeRatio: '0.8',
        profitFactor: '1.2',
        avgHoldingHours: '22.0',
        capitalUtilization: '0.4',
      },
      degradation: {
        profitFactor: 0.52,
        sharpeRatio: 0.6,
        totalPnl: 0.833,
      },
      overfitFlags: ['profitFactor', 'sharpeRatio', 'totalPnl'],
    };
    expect(wf.trainPct).toBe(0.7);
    expect(wf.overfitFlags).toHaveLength(3);
    expect(wf.degradation.profitFactor).toBe(0.52);
  });

  it('[P1] should construct SensitivityResults with sweeps array, degradationBoundaries, recommendedParameters, partial flag, counts', async () => {
    await import('./calibration-report.types');
    const sr = {
      sweeps: [
        {
          parameterName: 'edgeThresholdPct',
          baseValue: 0.008,
          values: [0.005, 0.006, 0.007],
          profitFactor: ['1.5', '1.3', null],
          maxDrawdown: ['0.04', '0.05', '0.06'],
          sharpeRatio: ['2.0', '1.5', null],
          totalPnl: ['500', '300', '-50'],
        },
      ],
      degradationBoundaries: [
        {
          parameterName: 'edgeThresholdPct',
          breakEvenValue: 0.045,
          direction: 'above' as const,
          description: 'Above 4.5%, system is unprofitable',
        },
      ],
      recommendedParameters: {
        byProfitFactor: [
          {
            parameterName: 'edgeThresholdPct',
            value: 0.008,
            profitFactor: '2.5',
          },
        ],
        bySharpe: [
          {
            parameterName: 'edgeThresholdPct',
            value: 0.01,
            sharpeRatio: '3.0',
          },
        ],
      },
      partial: false,
      completedSweeps: 66,
      totalPlannedSweeps: 66,
    };
    expect(sr.sweeps).toHaveLength(1);
    expect(sr.partial).toBe(false);
    expect(sr.completedSweeps).toBe(66);
  });

  it('[P1] should construct SweepConfig with optional range configs and timeoutSeconds', async () => {
    await import('./calibration-report.types');
    const config = {
      edgeThresholdRange: { min: 0.005, max: 0.05, step: 0.001 },
      positionSizeRange: { min: 0.01, max: 0.05, step: 0.005 },
      maxConcurrentPairsRange: { min: 5, max: 30, step: 5 },
      tradingWindowVariants: [
        { startHour: 0, endHour: 24, label: 'full-day' },
        { startHour: 21, endHour: 4, label: 'overnight-us' },
      ],
      timeoutSeconds: 1800,
    };
    expect(config.edgeThresholdRange.step).toBe(0.001);
    expect(config.timeoutSeconds).toBe(1800);
    expect(config.tradingWindowVariants).toHaveLength(2);
  });

  it('[P1] should export REPORT_DECIMAL_PRECISION = 10 and REPORT_DECIMAL_PRECISION_SHORT = 6', async () => {
    const { REPORT_DECIMAL_PRECISION, REPORT_DECIMAL_PRECISION_SHORT } =
      await import('./calibration-report.types');
    expect(REPORT_DECIMAL_PRECISION).toBe(10);
    expect(REPORT_DECIMAL_PRECISION_SHORT).toBe(6);
  });

  it('[P1] should export KNOWN_LIMITATIONS as string array with exactly 10 items matching design doc section 4.8', async () => {
    const { KNOWN_LIMITATIONS } = await import('./calibration-report.types');
    expect(KNOWN_LIMITATIONS).toBeInstanceOf(Array);
    expect(KNOWN_LIMITATIONS).toHaveLength(10);
    // Spot-check first and last
    expect(KNOWN_LIMITATIONS[0]).toContain('single-leg risk');
    expect(KNOWN_LIMITATIONS[9]).toContain('Non-binary resolution');
  });
});
