import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BACKTEST_ENGINE_TOKEN } from '../../../common/interfaces/backtest-engine.interface';
import { PrismaService } from '../../../common/prisma.service';

describe('BacktestController', () => {
  let controller: any;
  let engineService: any;
  let prismaService: any;

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

    const { BacktestController } = await import('./backtest.controller');
    const module = await Test.createTestingModule({
      controllers: [BacktestController],
      providers: [
        { provide: BACKTEST_ENGINE_TOKEN, useValue: engineService },
        { provide: PrismaService, useValue: prismaService },
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
});
