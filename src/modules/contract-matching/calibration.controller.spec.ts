import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CalibrationController } from './calibration.controller';
import { CalibrationService } from './calibration.service';
import type { CalibrationResult } from '../../common/events/calibration-completed.event';

function buildCalibrationResult(
  overrides: Partial<CalibrationResult> = {},
): CalibrationResult {
  return {
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
    ...overrides,
  };
}

describe('CalibrationController', () => {
  let controller: CalibrationController;
  let calibrationService: {
    runCalibration: ReturnType<typeof vi.fn>;
    getLatestResult: ReturnType<typeof vi.fn>;
    getCalibrationHistory: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    calibrationService = {
      runCalibration: vi.fn(),
      getLatestResult: vi.fn(),
      getCalibrationHistory: vi.fn(),
    };

    controller = new CalibrationController(
      calibrationService as unknown as CalibrationService,
    );
  });

  describe('POST /api/knowledge-base/calibration', () => {
    it('should trigger calibration with operator triggeredBy', async () => {
      const result = buildCalibrationResult();
      calibrationService.runCalibration.mockResolvedValue(result);

      const response = await controller.runCalibration();

      expect(calibrationService.runCalibration).toHaveBeenCalledWith(
        'operator',
      );
      expect(response.data).toBe(result);
      expect(response.timestamp).toBeDefined();
    });
  });

  describe('GET /api/knowledge-base/calibration', () => {
    it('should return latest result when available', () => {
      const result = buildCalibrationResult();
      calibrationService.getLatestResult.mockReturnValue(result);

      const response = controller.getCalibration();

      expect(response.data).toBe(result);
      expect(response.timestamp).toBeDefined();
    });

    it('should return null data when no calibration has run', () => {
      calibrationService.getLatestResult.mockReturnValue(null);

      const response = controller.getCalibration();

      expect(response.data).toBeNull();
      expect(response.timestamp).toBeDefined();
    });
  });

  describe('GET /api/knowledge-base/calibration/history', () => {
    it('should return history with default limit', async () => {
      const historyData = {
        data: [
          {
            id: 'cal-1',
            timestamp: new Date('2026-03-11'),
            totalResolvedMatches: 20,
            tiers: buildCalibrationResult().tiers,
            currentAutoApproveThreshold: 85,
            currentMinReviewThreshold: 40,
            recommendations: [],
            minimumDataMet: true,
            triggeredBy: 'cron',
          },
        ],
        count: 1,
      };
      calibrationService.getCalibrationHistory.mockResolvedValue(historyData);

      const response = await controller.getCalibrationHistory();

      expect(calibrationService.getCalibrationHistory).toHaveBeenCalledWith(10);
      expect(response.data).toHaveLength(1);
      expect(response.count).toBe(1);
      expect(response.timestamp).toBeDefined();
    });

    it('should pass custom limit parameter', async () => {
      calibrationService.getCalibrationHistory.mockResolvedValue({
        data: [],
        count: 0,
      });

      await controller.getCalibrationHistory('5');

      expect(calibrationService.getCalibrationHistory).toHaveBeenCalledWith(5);
    });

    it('should default to 10 when limit is invalid', async () => {
      calibrationService.getCalibrationHistory.mockResolvedValue({
        data: [],
        count: 0,
      });

      await controller.getCalibrationHistory('invalid');

      expect(calibrationService.getCalibrationHistory).toHaveBeenCalledWith(10);
    });
  });
});
