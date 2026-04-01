import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma.service';
import { BacktestStateMachineService } from './backtest-state-machine.service';

describe('BacktestStateMachineService', () => {
  let service: BacktestStateMachineService;
  let prismaService: any;
  let eventEmitter: EventEmitter2;
  let configService: any;

  const mockConfig = {
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
  };

  beforeEach(async () => {
    prismaService = {
      backtestRun: {
        create: vi.fn().mockResolvedValue({ id: 'run-1', status: 'IDLE' }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    eventEmitter = new EventEmitter2();
    vi.spyOn(eventEmitter, 'emit');

    configService = {
      get: vi.fn().mockReturnValue('2'),
    };

    const module = await Test.createTestingModule({
      providers: [
        BacktestStateMachineService,
        { provide: PrismaService, useValue: prismaService },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(BacktestStateMachineService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Config parsing (P-7)', () => {
    it('[P1] should parse maxConcurrentRuns from string config value', () => {
      expect(service.maxConcurrentRuns).toBe(2);
    });

    it('[P1] should default to 2 when config value is NaN', async () => {
      configService.get.mockReturnValue('abc');
      const mod = await Test.createTestingModule({
        providers: [
          BacktestStateMachineService,
          { provide: PrismaService, useValue: prismaService },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();
      const svc = mod.get(BacktestStateMachineService);
      expect(svc.maxConcurrentRuns).toBe(2);
    });

    it('[P1] should default to 2 when config value is null', async () => {
      configService.get.mockReturnValue(null);
      const mod = await Test.createTestingModule({
        providers: [
          BacktestStateMachineService,
          { provide: PrismaService, useValue: prismaService },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: ConfigService, useValue: configService },
        ],
      }).compile();
      const svc = mod.get(BacktestStateMachineService);
      expect(svc.maxConcurrentRuns).toBe(2);
    });
  });

  describe('State machine transitions', () => {
    it('[P0] should validate IDLE → CONFIGURING', () => {
      expect(() =>
        service.validateTransition('IDLE', 'CONFIGURING'),
      ).not.toThrow();
    });

    it('[P0] should reject IDLE → SIMULATING', () => {
      expect(() => service.validateTransition('IDLE', 'SIMULATING')).toThrow();
    });

    it('[P0] should validate COMPLETE/FAILED/CANCELLED → IDLE', () => {
      expect(() =>
        service.validateTransition('COMPLETE', 'IDLE'),
      ).not.toThrow();
      expect(() => service.validateTransition('FAILED', 'IDLE')).not.toThrow();
      expect(() =>
        service.validateTransition('CANCELLED', 'IDLE'),
      ).not.toThrow();
    });

    it('[P0] should emit BacktestEngineStateChangedEvent on transition', async () => {
      await service.createRun(mockConfig);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'backtesting.engine.state-changed',
        expect.objectContaining({
          fromState: 'IDLE',
          toState: 'CONFIGURING',
        }),
      );
    });
  });

  describe('Run lifecycle', () => {
    it('[P0] should create run and return runId', async () => {
      const runId = await service.createRun(mockConfig);
      expect(runId).toBe('run-1');
      expect(service.getRunStatus(runId)).toEqual(
        expect.objectContaining({ status: 'CONFIGURING' }),
      );
    });

    it('[P0] should cancel active run and emit event', async () => {
      const runId = await service.createRun(mockConfig);
      await service.cancelRun(runId);
      expect(service.isCancelled(runId)).toBe(true);
      expect(prismaService.backtestRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: runId },
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'backtesting.run.cancelled',
        expect.objectContaining({ runId }),
      );
    });

    it('[P1] should silently ignore cancel for unknown runId', async () => {
      await service.cancelRun('nonexistent');
      expect(prismaService.backtestRun.update).not.toHaveBeenCalled();
    });

    it('[P1] should return null for unknown runId getRunStatus', () => {
      expect(service.getRunStatus('nonexistent')).toBeNull();
    });
  });

  describe('Concurrency guard', () => {
    it('[P1] should reject when max concurrent runs reached', async () => {
      prismaService.backtestRun.create
        .mockResolvedValueOnce({ id: 'run-a', status: 'IDLE' })
        .mockResolvedValueOnce({ id: 'run-b', status: 'IDLE' });

      await service.createRun(mockConfig);
      await service.createRun(mockConfig);

      await expect(service.createRun(mockConfig)).rejects.toThrow(
        /Max concurrent runs/,
      );
    });

    it('[P1] should allow new run after previous completes', async () => {
      prismaService.backtestRun.create
        .mockResolvedValueOnce({ id: 'run-x', status: 'IDLE' })
        .mockResolvedValueOnce({ id: 'run-y', status: 'IDLE' })
        .mockResolvedValueOnce({ id: 'run-z', status: 'IDLE' });

      await service.createRun(mockConfig);
      await service.createRun(mockConfig);

      // Complete one run
      service.transitionRun('run-x', 'LOADING_DATA');
      service.transitionRun('run-x', 'SIMULATING');
      service.transitionRun('run-x', 'GENERATING_REPORT');
      service.transitionRun('run-x', 'COMPLETE');
      service.cleanupRun('run-x');

      await expect(service.createRun(mockConfig)).resolves.toBeDefined();
    });
  });

  describe('Startup recovery', () => {
    it('[P1] should fail orphaned runs older than timeoutSeconds * 2', async () => {
      const oldDate = new Date(Date.now() - 1200000);
      prismaService.backtestRun.findMany.mockResolvedValue([
        {
          id: 'orphan-1',
          status: 'SIMULATING',
          startedAt: oldDate,
          config: { timeoutSeconds: 300 },
        },
      ]);

      await service.onModuleInit();

      expect(prismaService.backtestRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'orphan-1' },
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('[P1] should not affect recent runs during startup', async () => {
      const recentDate = new Date(Date.now() - 60000);
      prismaService.backtestRun.findMany.mockResolvedValue([
        {
          id: 'recent-1',
          status: 'SIMULATING',
          startedAt: recentDate,
          config: { timeoutSeconds: 300 },
        },
      ]);

      await service.onModuleInit();

      expect(prismaService.backtestRun.update).not.toHaveBeenCalled();
    });
  });

  describe('failRun (P-15 double-fault)', () => {
    it('[P1] should handle DB failure in failRun gracefully', async () => {
      const runId = await service.createRun(mockConfig);
      prismaService.backtestRun.update.mockRejectedValueOnce(
        new Error('DB down'),
      );

      await expect(
        service.failRun(runId, 4204, 'test error'),
      ).resolves.not.toThrow();

      // In-memory status should still be FAILED
      const status = service.getRunStatus(runId);
      expect(status?.status).toBe('FAILED');
    });

    it('[P1] should emit BacktestRunFailedEvent even if DB fails', async () => {
      const runId = await service.createRun(mockConfig);
      prismaService.backtestRun.update.mockRejectedValueOnce(
        new Error('DB down'),
      );

      await service.failRun(runId, 4210, 'timeout');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'backtesting.run.failed',
        expect.objectContaining({ runId, errorCode: 4210 }),
      );
    });
  });

  describe('Cleanup (P-17)', () => {
    it('[P1] should delete runId from maps on cleanupRun', async () => {
      const runId = await service.createRun(mockConfig);
      await service.cancelRun(runId);

      expect(service.isCancelled(runId)).toBe(true);
      expect(service.getRunStatus(runId)).not.toBeNull();

      service.cleanupRun(runId);

      expect(service.isCancelled(runId)).toBe(false);
      expect(service.getRunStatus(runId)).toBeNull();
    });

    it('[P1] should clear all maps on onModuleDestroy', async () => {
      await service.createRun(mockConfig);
      service.onModuleDestroy();
      expect(service.getRunStatus('run-1')).toBeNull();
    });
  });
});
