import { CalibrationCompletedEvent } from './calibration-completed.event';
import type { CalibrationResult } from './calibration-completed.event';

describe('CalibrationCompletedEvent', () => {
  const result: CalibrationResult = {
    timestamp: new Date('2026-03-11'),
    totalResolvedMatches: 20,
    tiers: {
      autoApprove: {
        range: '>= 85',
        matchCount: 10,
        divergedCount: 0,
        divergenceRate: 0,
      },
      pendingReview: {
        range: '40 - 84',
        matchCount: 5,
        divergedCount: 1,
        divergenceRate: 20,
      },
      autoReject: {
        range: '< 40',
        matchCount: 5,
        divergedCount: 0,
        divergenceRate: 0,
      },
    },
    boundaryAnalysis: [],
    currentAutoApproveThreshold: 85,
    currentMinReviewThreshold: 40,
    recommendations: [],
    minimumDataMet: true,
  };

  it('should construct with calibration result', () => {
    const event = new CalibrationCompletedEvent(result);
    expect(event.calibrationResult).toEqual(result);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('should accept optional correlationId', () => {
    const event = new CalibrationCompletedEvent(result, 'corr-789');
    expect(event.correlationId).toBe('corr-789');
  });

  it('should expose calibration result fields', () => {
    const event = new CalibrationCompletedEvent(result);
    expect(event.calibrationResult.totalResolvedMatches).toBe(20);
    expect(event.calibrationResult.minimumDataMet).toBe(true);
    expect(event.calibrationResult.tiers.autoApprove.matchCount).toBe(10);
  });
});
