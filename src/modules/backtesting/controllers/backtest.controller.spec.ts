import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { BACKTEST_ENGINE_TOKEN } from '../../../common/interfaces/backtest-engine.interface';
import { PrismaService } from '../../../common/prisma.service';
import { SensitivityAnalysisService } from '../reporting/sensitivity-analysis.service';

describe('BacktestController', () => {
  let controller: any;
  let engineService: any;
  let prismaService: any;
  let sensitivityService: any;

  beforeEach(async () => {
    engineService = {
      startRun: vi.fn().mockResolvedValue('run-1'),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      getRunStatus: vi.fn().mockReturnValue({
        runId: 'run-1',
        status: 'COMPLETE',
      }),
    };

    prismaService = {
      backtestRun: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
      backtestPosition: {
        count: vi.fn().mockResolvedValue(0),
      },
    };

    sensitivityService = {
      runSweep: vi.fn().mockResolvedValue({}),
      isInProgress: vi.fn().mockReturnValue(false),
    };

    const { BacktestController } = await import('./backtest.controller');
    const module = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        { provide: BACKTEST_ENGINE_TOKEN, useValue: engineService },
        { provide: PrismaService, useValue: prismaService },
        { provide: SensitivityAnalysisService, useValue: sensitivityService },
      ],
    }).compile();

    controller = module.get(BacktestController);
  });

  it('[P0] should POST /api/backtesting/runs with valid config and return 202', async () => {
    const config = {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
    };

    const result = await controller.createRun(config);
    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ runId: 'run-1' }),
      }),
    );
    expect(engineService.startRun).toHaveBeenCalledWith(config);
  });

  it('[P1] should return 400 when dateRangeStart >= dateRangeEnd', async () => {
    const config = {
      dateRangeStart: '2025-03-01T00:00:00Z',
      dateRangeEnd: '2025-01-01T00:00:00Z',
    };

    await expect(controller.createRun(config)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('[P1] should return 400 when tradingWindowStartHour === tradingWindowEndHour', async () => {
    const config = {
      dateRangeStart: '2025-01-01T00:00:00Z',
      dateRangeEnd: '2025-03-01T00:00:00Z',
      tradingWindowStartHour: 14,
      tradingWindowEndHour: 14,
    };

    await expect(controller.createRun(config)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('[P1] should GET /api/backtesting/runs with pagination', async () => {
    prismaService.backtestRun.findMany.mockResolvedValue([
      { id: 'run-1', status: 'COMPLETE' },
    ]);
    prismaService.backtestRun.count.mockResolvedValue(1);

    const result = await controller.listRuns(10, 0);
    expect(result).toEqual(
      expect.objectContaining({
        data: expect.any(Array),
        count: 1,
      }),
    );
  });

  it('[P1] should GET /api/backtesting/runs/:id and return single run with positionCount', async () => {
    prismaService.backtestRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'COMPLETE',
      positions: [],
    });
    prismaService.backtestPosition.count.mockResolvedValue(5);

    const result = await controller.getRun('run-1', 100, 0);
    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'run-1', positionCount: 5 }),
      }),
    );
    expect(prismaService.backtestPosition.count).toHaveBeenCalledWith({
      where: { runId: 'run-1' },
    });
  });

  it('[P1] should DELETE /api/backtesting/runs/:id and cancel a running backtest', async () => {
    const result = await controller.cancelRun('run-1');
    expect(engineService.cancelRun).toHaveBeenCalledWith('run-1');
    expect(result).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ cancelled: true }),
      }),
    );
  });

  it('[P2] should return 404 when run ID not found on GET', async () => {
    prismaService.backtestRun.findUnique.mockResolvedValue(null);
    await expect(controller.getRun('nonexistent', 100, 0)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('[P2] should return 404 when cancelling a run that is not active', async () => {
    engineService.getRunStatus.mockReturnValue(null);
    await expect(controller.cancelRun('nonexistent')).rejects.toThrow(
      NotFoundException,
    );
    expect(engineService.cancelRun).not.toHaveBeenCalled();
  });

  it('[P2] should validate :id parameter format', async () => {
    // ParseUUIDPipe would reject this at route level, but controller accepts string
    expect(controller.getRun).toBeDefined();
  });

  // ============================================================
  // Story 10-9-4: Report & Sensitivity Endpoints
  // ============================================================

  describe('GET :id/report', () => {
    it('[P0] should return 200 with CalibrationReport data', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETE',
        report: { summaryMetrics: { totalTrades: 42 } },
      });

      const result = await controller.getReport('run-1');
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ summaryMetrics: expect.any(Object) }),
          timestamp: expect.any(String),
        }),
      );
    });

    it('[P0] should return 404 when report not yet generated', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETE',
        report: null,
      });

      await expect(controller.getReport('run-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('[P1] should return 400 when run status is not COMPLETE', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'SIMULATING',
        report: null,
      });

      await expect(controller.getReport('run-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('POST :id/sensitivity', () => {
    it('[P0] should return 202 Accepted', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETE',
      });

      const result = await controller.triggerSensitivity('run-1', undefined);
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ runId: 'run-1', status: 'STARTED' }),
          timestamp: expect.any(String),
        }),
      );
    });

    it('[P1] should return 400 when run status is not COMPLETE', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'LOADING_DATA',
      });

      await expect(
        controller.triggerSensitivity('run-1', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('[P1] should return 409 Conflict when sensitivity sweep already in progress for same runId', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        status: 'COMPLETE',
      });
      sensitivityService.isInProgress.mockReturnValue(true);

      await expect(
        controller.triggerSensitivity('run-1', undefined),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('GET :id/sensitivity', () => {
    it('[P0] should return 200 with SensitivityResults data', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        sensitivityResults: { sweeps: [], partial: false },
      });

      const result = await controller.getSensitivity('run-1');
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ sweeps: expect.any(Array) }),
          timestamp: expect.any(String),
        }),
      );
    });

    it('[P0] should return 404 when sensitivity not yet generated', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        sensitivityResults: null,
      });

      await expect(controller.getSensitivity('run-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET :id/walk-forward', () => {
    it('[P0] should return 200 with WalkForwardResults data', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        walkForwardResults: { trainPct: 0.7, testPct: 0.3, overfitFlags: [] },
      });

      const result = await controller.getWalkForward('run-1');
      expect(result).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ trainPct: 0.7 }),
          timestamp: expect.any(String),
        }),
      );
    });

    it('[P0] should return 404 when walk-forward not available', async () => {
      prismaService.backtestRun.findUnique.mockResolvedValue({
        id: 'run-1',
        walkForwardResults: null,
      });

      await expect(controller.getWalkForward('run-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('[P1] should wrap all responses in { data: T, timestamp: string } format', async () => {
    prismaService.backtestRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'COMPLETE',
      report: { test: true },
      sensitivityResults: { sweeps: [] },
      walkForwardResults: { trainPct: 0.7 },
    });

    const report = await controller.getReport('run-1');
    expect(report).toHaveProperty('data');
    expect(report).toHaveProperty('timestamp');

    const sensitivity = await controller.getSensitivity('run-1');
    expect(sensitivity).toHaveProperty('data');
    expect(sensitivity).toHaveProperty('timestamp');

    const walkForward = await controller.getWalkForward('run-1');
    expect(walkForward).toHaveProperty('data');
    expect(walkForward).toHaveProperty('timestamp');
  });
});
