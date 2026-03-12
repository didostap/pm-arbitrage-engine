import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CalibrationService } from './calibration.service';
import { PrismaService } from '../../common/prisma.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { CalibrationCompletedEvent } from '../../common/events/calibration-completed.event';

function buildMatchRow(confidenceScore: number, resolutionDiverged: boolean) {
  return { confidenceScore, resolutionDiverged };
}

describe('CalibrationService', () => {
  let service: CalibrationService;
  let prisma: {
    contractMatch: { findMany: ReturnType<typeof vi.fn> };
    calibrationRun: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let configService: ConfigService;
  let schedulerRegistry: {
    addCronJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    prisma = {
      contractMatch: { findMany: vi.fn() },
      calibrationRun: {
        create: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    emitter = { emit: vi.fn() };
    schedulerRegistry = { addCronJob: vi.fn() };
    configService = {
      get: vi.fn((key: string, defaultVal?: unknown) => {
        const overrides: Record<string, unknown> = {
          LLM_AUTO_APPROVE_THRESHOLD: 85,
          LLM_MIN_REVIEW_THRESHOLD: 40,
          CALIBRATION_ENABLED: true,
          CALIBRATION_CRON_EXPRESSION: '0 0 7 1 */3 *',
        };
        return overrides[key] ?? defaultVal;
      }),
    } as unknown as ConfigService;

    service = new CalibrationService(
      prisma as unknown as PrismaService,
      emitter as unknown as EventEmitter2,
      configService,
      schedulerRegistry as unknown as SchedulerRegistry,
    );
  });

  describe('onModuleInit', () => {
    it('should register cron job when enabled', async () => {
      await service.onModuleInit();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'calibration',
        expect.anything(),
      );
    });

    it('should not register cron job when disabled', async () => {
      configService = {
        get: vi.fn((key: string, defaultVal?: unknown) => {
          if (key === 'CALIBRATION_ENABLED') return false;
          if (key === 'LLM_AUTO_APPROVE_THRESHOLD') return 85;
          if (key === 'LLM_MIN_REVIEW_THRESHOLD') return 40;
          return defaultVal;
        }),
      } as unknown as ConfigService;

      service = new CalibrationService(
        prisma as unknown as PrismaService,
        emitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      await service.onModuleInit();

      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('should load latest calibration result from database on init', async () => {
      const dbRecord = {
        id: 'cal-1',
        timestamp: new Date('2026-03-10'),
        totalResolvedMatches: 25,
        tiers: {
          autoApprove: {
            range: '>= 85',
            matchCount: 15,
            divergedCount: 0,
            divergenceRate: 0,
          },
          pendingReview: {
            range: '40 - 84',
            matchCount: 7,
            divergedCount: 1,
            divergenceRate: 14.3,
          },
          autoReject: {
            range: '< 40',
            matchCount: 3,
            divergedCount: 0,
            divergenceRate: 0,
          },
        },
        boundaryAnalysis: [],
        currentAutoApproveThreshold: 85,
        currentMinReviewThreshold: 40,
        recommendations: ['Some recommendation'],
        minimumDataMet: true,
        triggeredBy: 'cron',
        createdAt: new Date(),
      };
      prisma.calibrationRun.findFirst.mockResolvedValue(dbRecord);

      await service.onModuleInit();

      const result = service.getLatestResult();
      expect(result).not.toBeNull();
      expect(result!.totalResolvedMatches).toBe(25);
      expect(result!.tiers.autoApprove.matchCount).toBe(15);
      expect(result!.recommendations).toEqual(['Some recommendation']);
    });

    it('should handle database load failure gracefully', async () => {
      prisma.calibrationRun.findFirst.mockRejectedValue(
        new Error('DB unavailable'),
      );

      await service.onModuleInit();

      expect(service.getLatestResult()).toBeNull();
    });
  });

  describe('runCalibration', () => {
    it('should return insufficient data result when fewer than 10 matches', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        buildMatchRow(90, false),
        buildMatchRow(80, false),
      ]);

      const result = await service.runCalibration();

      expect(result.minimumDataMet).toBe(false);
      expect(result.totalResolvedMatches).toBe(2);
      expect(result.recommendations).toContain(
        'Insufficient data for calibration (2/10 required)',
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CALIBRATION_COMPLETED,
        expect.any(CalibrationCompletedEvent),
      );
    });

    it('should classify matches into tiers correctly', async () => {
      const matches = [
        // Auto-approve tier (>= 85)
        buildMatchRow(92, false),
        buildMatchRow(88, false),
        buildMatchRow(85, true), // diverged
        // Pending review tier (40-84)
        buildMatchRow(70, false),
        buildMatchRow(60, false),
        buildMatchRow(50, true), // diverged
        // Auto-reject tier (< 40)
        buildMatchRow(30, false),
        buildMatchRow(20, false),
        buildMatchRow(10, false),
        buildMatchRow(5, true), // diverged
      ];
      prisma.contractMatch.findMany.mockResolvedValue(matches);

      const result = await service.runCalibration();

      expect(result.minimumDataMet).toBe(true);
      expect(result.tiers.autoApprove.matchCount).toBe(3);
      expect(result.tiers.autoApprove.divergedCount).toBe(1);
      expect(result.tiers.autoApprove.divergenceRate).toBeCloseTo(33.3, 0);

      expect(result.tiers.pendingReview.matchCount).toBe(3);
      expect(result.tiers.pendingReview.divergedCount).toBe(1);

      expect(result.tiers.autoReject.matchCount).toBe(4);
      expect(result.tiers.autoReject.divergedCount).toBe(1);
    });

    it('should generate boundary analysis at 5-point decrements down to 75', async () => {
      // 15 matches all above 75, no divergence
      const matches = Array.from({ length: 15 }, (_, i) =>
        buildMatchRow(75 + i, false),
      );
      prisma.contractMatch.findMany.mockResolvedValue(matches);

      const result = await service.runCalibration();

      // With threshold=85, should analyze at 80 and 75
      expect(result.boundaryAnalysis).toHaveLength(2);
      expect(result.boundaryAnalysis[0]!.threshold).toBe(80);
      expect(result.boundaryAnalysis[1]!.threshold).toBe(75);
    });

    it('should recommend lowering threshold when 0% divergence over 10+ matches', async () => {
      const matches = Array.from({ length: 15 }, (_, i) =>
        buildMatchRow(78 + i, false),
      );
      prisma.contractMatch.findMany.mockResolvedValue(matches);

      const result = await service.runCalibration();

      const recEntry = result.boundaryAnalysis.find(
        (b) => b.recommendation !== null,
      );
      expect(recEntry).toBeDefined();
      expect(recEntry!.recommendation).toContain('could be lowered');
    });

    it('should recommend raising threshold when auto-approve divergence > 5%', async () => {
      const matches = [
        // Auto-approve: 10 matches, 2 diverged = 20%
        ...Array.from({ length: 8 }, () => buildMatchRow(90, false)),
        buildMatchRow(90, true),
        buildMatchRow(90, true),
      ];
      prisma.contractMatch.findMany.mockResolvedValue(matches);

      const result = await service.runCalibration();

      expect(
        result.recommendations.some((r) => r.includes('Consider raising')),
      ).toBe(true);
    });

    it('should store result as latest and make it retrievable', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        buildMatchRow(90, false),
      ]);

      expect(service.getLatestResult()).toBeNull();

      const result = await service.runCalibration();

      expect(service.getLatestResult()).toBe(result);
    });

    it('should emit CalibrationCompletedEvent with full result', async () => {
      prisma.contractMatch.findMany.mockResolvedValue(
        Array.from({ length: 10 }, () => buildMatchRow(90, false)),
      );

      await service.runCalibration();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CALIBRATION_COMPLETED,
        expect.any(CalibrationCompletedEvent),
      );
      const event = emitter.emit.mock.calls[0]![1] as CalibrationCompletedEvent;
      expect(event.calibrationResult.totalResolvedMatches).toBe(10);
    });

    it('should handle empty matches gracefully', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([]);

      const result = await service.runCalibration();

      expect(result.minimumDataMet).toBe(false);
      expect(result.totalResolvedMatches).toBe(0);
    });

    it('should skip when concurrent run is in progress', async () => {
      let resolveFn: ((value: unknown[]) => void) | undefined;
      prisma.contractMatch.findMany.mockReturnValue(
        new Promise<unknown[]>((resolve) => {
          resolveFn = resolve;
        }),
      );

      const firstRun = service.runCalibration();
      const secondRun = service.runCalibration();

      resolveFn!([]);

      const [first, second] = await Promise.all([firstRun, secondRun]);

      expect(first.totalResolvedMatches).toBe(0);
      expect(second.totalResolvedMatches).toBe(0);
      expect(prisma.contractMatch.findMany).toHaveBeenCalledTimes(1);
    });

    it('should catch DB errors and return empty result', async () => {
      prisma.contractMatch.findMany.mockRejectedValue(new Error('DB error'));

      const result = await service.runCalibration();

      expect(result.minimumDataMet).toBe(false);
      expect(result.recommendations).toContain(
        'Calibration failed — see logs for details',
      );
    });

    it('should persist calibration result to database', async () => {
      prisma.contractMatch.findMany.mockResolvedValue(
        Array.from({ length: 10 }, () => buildMatchRow(90, false)),
      );

      await service.runCalibration('operator');

      expect(prisma.calibrationRun.create).toHaveBeenCalledTimes(1);
      const callArg = prisma.calibrationRun.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(callArg.data.totalResolvedMatches).toBe(10);
      expect(callArg.data.triggeredBy).toBe('operator');
      expect(callArg.data.minimumDataMet).toBe(true);
    });

    it('should persist with cron triggeredBy by default', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        buildMatchRow(90, false),
      ]);

      await service.runCalibration();

      expect(prisma.calibrationRun.create).toHaveBeenCalledTimes(1);
      const callArg = prisma.calibrationRun.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(callArg.data.triggeredBy).toBe('cron');
    });

    it('should persist even when insufficient data', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        buildMatchRow(90, false),
      ]);

      await service.runCalibration('operator');

      expect(prisma.calibrationRun.create).toHaveBeenCalledTimes(1);
      const callArg = prisma.calibrationRun.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(callArg.data.totalResolvedMatches).toBe(1);
      expect(callArg.data.minimumDataMet).toBe(false);
      expect(callArg.data.triggeredBy).toBe('operator');
    });

    it('should continue working if persistence fails', async () => {
      prisma.contractMatch.findMany.mockResolvedValue([
        buildMatchRow(90, false),
      ]);
      prisma.calibrationRun.create.mockRejectedValue(
        new Error('DB write failed'),
      );

      const result = await service.runCalibration();

      expect(result.totalResolvedMatches).toBe(1);
      expect(service.getLatestResult()).toBe(result);
      expect(emitter.emit).toHaveBeenCalled();
    });
  });

  describe('getCalibrationHistory', () => {
    it('should return calibration run history', async () => {
      const runs = [
        {
          id: 'cal-2',
          timestamp: new Date('2026-03-11'),
          totalResolvedMatches: 30,
          tiers: {
            autoApprove: {
              range: '>= 85',
              matchCount: 20,
              divergedCount: 0,
              divergenceRate: 0,
            },
            pendingReview: {
              range: '40 - 84',
              matchCount: 5,
              divergedCount: 0,
              divergenceRate: 0,
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
          triggeredBy: 'operator',
          createdAt: new Date(),
        },
      ];
      prisma.calibrationRun.findMany.mockResolvedValue(runs);
      prisma.calibrationRun.count.mockResolvedValue(5);

      const { data, count } = await service.getCalibrationHistory(10);

      expect(count).toBe(5);
      expect(data[0]!.id).toBe('cal-2');
      expect(data[0]!.triggeredBy).toBe('operator');
      expect(data[0]!.totalResolvedMatches).toBe(30);
      expect(prisma.calibrationRun.findMany).toHaveBeenCalledWith({
        orderBy: { timestamp: 'desc' },
        take: 10,
      });
      expect(prisma.calibrationRun.count).toHaveBeenCalled();
    });

    it('should return empty array when no runs exist', async () => {
      prisma.calibrationRun.findMany.mockResolvedValue([]);
      prisma.calibrationRun.count.mockResolvedValue(0);

      const { data, count } = await service.getCalibrationHistory(5);

      expect(count).toBe(0);
      expect(data).toEqual([]);
    });
  });
});
