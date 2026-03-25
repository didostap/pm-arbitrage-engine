import { describe, it, expect } from 'vitest';
import {
  formatResolutionDivergence,
  formatResolutionPollCompleted,
  formatCalibrationCompleted,
  formatShadowDailySummary,
} from './resolution-formatters.js';

describe('formatResolutionDivergence', () => {
  it('should format divergence alert with match details', () => {
    const result = formatResolutionDivergence({
      matchId: 'match-123',
      polymarketResolution: 'yes',
      kalshiResolution: 'no',
      divergenceNotes: null,
      timestamp: new Date(),
    });
    expect(result).toContain('RESOLUTION DIVERGED');
    expect(result).toContain('match-123');
    expect(result).toContain('yes');
    expect(result).toContain('no');
    expect(result).toContain('root cause');
  });
});

describe('formatResolutionPollCompleted', () => {
  it('should format poll summary with no divergence', () => {
    const result = formatResolutionPollCompleted({
      stats: {
        totalChecked: 5,
        newlyResolved: 2,
        diverged: 0,
        skippedInvalid: 0,
        pendingOnePlatform: 3,
        errors: 0,
      },
      timestamp: new Date(),
    });
    expect(result).toContain('Resolution Poll');
    expect(result).toContain('5');
    expect(result).toContain('2');
  });

  it('should escalate when divergence detected', () => {
    const result = formatResolutionPollCompleted({
      stats: {
        totalChecked: 10,
        newlyResolved: 5,
        diverged: 2,
        skippedInvalid: 0,
        pendingOnePlatform: 3,
        errors: 0,
      },
      timestamp: new Date(),
    });
    expect(result).toContain('⚠️');
    expect(result).toContain('Diverged');
  });
});

describe('formatCalibrationCompleted', () => {
  it('should format calibration analysis with tiers', () => {
    const result = formatCalibrationCompleted({
      calibrationResult: {
        totalResolvedMatches: 50,
        minimumDataMet: true,
        tiers: {
          autoApprove: { matchCount: 30, divergenceRate: 0 },
          pendingReview: { matchCount: 15, divergenceRate: 6.7 },
          autoReject: { matchCount: 5, divergenceRate: 0 },
        },
        recommendations: ['Consider lowering threshold'],
      },
      timestamp: new Date(),
    });
    expect(result).toContain('Calibration Analysis');
    expect(result).toContain('50');
    expect(result).toContain('30');
    expect(result).toContain('Recommendations');
  });

  it('should show insufficient data', () => {
    const result = formatCalibrationCompleted({
      calibrationResult: {
        totalResolvedMatches: 3,
        minimumDataMet: false,
        tiers: {
          autoApprove: { matchCount: 0, divergenceRate: 0 },
          pendingReview: { matchCount: 0, divergenceRate: 0 },
          autoReject: { matchCount: 0, divergenceRate: 0 },
        },
        recommendations: [],
      },
      timestamp: new Date(),
    });
    expect(result).toContain('no');
    expect(result).toContain('3');
  });
});

describe('formatShadowDailySummary', () => {
  it('should show date, agreement rate, and criterion triggers', () => {
    const result = formatShadowDailySummary({
      date: '2026-03-25',
      totalComparisons: 100,
      fixedTriggerCount: 40,
      modelTriggerCount: 60,
      criterionTriggerCounts: { edge_threshold: 25, time_decay: 15 },
      cumulativePnlDelta: '+$12.50',
      agreeCount: 85,
      disagreeCount: 15,
      timestamp: new Date(),
    });

    expect(result).toContain('\u{1F7E2}');
    expect(result).toContain('Shadow Mode Daily Summary');
    expect(result).toContain('2026-03-25');
    expect(result).toContain('85/100');
    expect(result).toContain('85.0%');
    expect(result).toContain('edge_threshold');
    expect(result).toContain('+$12.50');
  });
});
