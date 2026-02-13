/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerService } from './scheduler.service';
import { TradingEngineService } from './trading-engine.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the NTP utility to avoid real network calls in tests
vi.mock('../common/utils', async () => {
  const actual = await vi.importActual('../common/utils');
  return {
    ...actual,
    syncAndMeasureDrift: vi.fn().mockResolvedValue({
      driftMs: 50,
      serverUsed: 'pool.ntp.org',
      timestamp: new Date(),
    }),
  };
});

describe('SchedulerService', () => {
  let service: SchedulerService;
  let tradingEngine: TradingEngineService;
  let configService: ConfigService;
  let schedulerRegistry: SchedulerRegistry;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, defaultValue: number): number => {
              if (key === 'POLLING_INTERVAL_MS') return 1000; // 1s for testing
              return defaultValue;
            }),
          },
        },
        {
          provide: TradingEngineService,
          useValue: {
            executeCycle: vi.fn().mockResolvedValue(undefined),
            isCycleInProgress: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: SchedulerRegistry,
          useValue: {
            addInterval: vi.fn(),
            deleteInterval: vi.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: vi.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<SchedulerService>(SchedulerService);
    tradingEngine = module.get<TradingEngineService>(TradingEngineService);
    configService = module.get<ConfigService>(ConfigService);
    schedulerRegistry = module.get<SchedulerRegistry>(SchedulerRegistry);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should register polling interval with SchedulerRegistry', () => {
      service.onModuleInit();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'pollingCycle',
        expect.any(Object),
      );
    });

    it('should use POLLING_INTERVAL_MS from config', () => {
      service.onModuleInit();

      expect(configService.get).toHaveBeenCalledWith(
        'POLLING_INTERVAL_MS',
        30000,
      );
    });

    it('should log scheduler initialization', () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      service.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Scheduler initialized'),
        }),
      );
    });
  });

  describe('handlePollingCycle', () => {
    it('should call trading engine executeCycle when no cycle in progress', async () => {
      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).toHaveBeenCalled();
    });

    it('should skip cycle if already in progress', async () => {
      vi.mocked(tradingEngine.isCycleInProgress).mockReturnValueOnce(true);

      await service['handlePollingCycle']();

      expect(tradingEngine.executeCycle).not.toHaveBeenCalled();
    });

    it('should log skipped interval when cycle in progress', async () => {
      vi.mocked(tradingEngine.isCycleInProgress).mockReturnValueOnce(true);
      const debugSpy = vi.spyOn(service['logger'], 'debug');

      await service['handlePollingCycle']();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Skipping'),
        }),
      );
    });

    it('should not throw if executeCycle fails', async () => {
      vi.mocked(tradingEngine.executeCycle).mockRejectedValueOnce(
        new Error('Cycle failed'),
      );

      await expect(service['handlePollingCycle']()).resolves.not.toThrow();
    });
  });
});
