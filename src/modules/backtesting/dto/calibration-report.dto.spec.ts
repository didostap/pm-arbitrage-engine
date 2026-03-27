import { describe, it, expect } from 'vitest';
import {
  CalibrationReportResponseDto,
  SensitivityResultsResponseDto,
  WalkForwardResultsResponseDto,
} from './calibration-report.dto';

describe('CalibrationReportResponseDto', () => {
  it('[P1] should construct with summaryMetrics, confidenceIntervals, knownLimitations, dataQualitySummary', () => {
    const dto = new CalibrationReportResponseDto();
    dto.summaryMetrics = { totalTrades: 42 };
    dto.confidenceIntervals = { iterations: 1000 };
    dto.knownLimitations = ['limitation-1'];
    dto.dataQualitySummary = { pairCount: 5 };
    dto.generatedAt = '2025-01-01T00:00:00Z';

    expect(dto.summaryMetrics).toEqual({ totalTrades: 42 });
    expect(dto.knownLimitations).toHaveLength(1);
    expect(dto.generatedAt).toBeDefined();
  });
});

describe('SensitivityResultsResponseDto', () => {
  it('[P1] should construct with sweeps, degradationBoundaries, recommendedParameters, partial flag', () => {
    const dto = new SensitivityResultsResponseDto();
    dto.sweeps = [{ parameterName: 'edge' }];
    dto.degradationBoundaries = [];
    dto.recommendedParameters = { byProfitFactor: [] };
    dto.partial = false;
    dto.completedSweeps = 66;
    dto.totalPlannedSweeps = 66;

    expect(dto.sweeps).toHaveLength(1);
    expect(dto.partial).toBe(false);
    expect(dto.completedSweeps).toBe(66);
  });
});

describe('WalkForwardResultsResponseDto', () => {
  it('[P1] should construct with trainMetrics, testMetrics, degradation, overfitFlags', () => {
    const dto = new WalkForwardResultsResponseDto();
    dto.trainPct = 0.7;
    dto.testPct = 0.3;
    dto.trainMetrics = { totalPositions: 20 };
    dto.testMetrics = { totalPositions: 10 };
    dto.degradation = { profitFactor: 0.4 };
    dto.overfitFlags = ['profitFactor'];

    expect(dto.trainPct).toBe(0.7);
    expect(dto.overfitFlags).toContain('profitFactor');
  });
});
