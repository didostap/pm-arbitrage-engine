/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EngineLifecycleService } from './engine-lifecycle.service';
import { TradingEngineService } from './trading-engine.service';
import { PrismaService } from '../common/prisma.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('EngineLifecycleService', () => {
  let service: EngineLifecycleService;
  let prisma: PrismaService;
  let tradingEngine: TradingEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineLifecycleService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, defaultValue: number): number => {
              if (key === 'POLLING_INTERVAL_MS') return 30000;
              return defaultValue;
            }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
          },
        },
        {
          provide: TradingEngineService,
          useValue: {
            initiateShutdown: vi.fn(),
            waitForShutdown: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<EngineLifecycleService>(EngineLifecycleService);
    prisma = module.get<PrismaService>(PrismaService);
    tradingEngine = module.get<TradingEngineService>(TradingEngineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onApplicationBootstrap', () => {
    it('should verify database connectivity on startup', async () => {
      await service.onApplicationBootstrap();
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it('should throw if database connection fails', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(
        new Error('Connection failed'),
      );
      await expect(service.onApplicationBootstrap()).rejects.toThrow(
        'Connection failed',
      );
    });

    it('should log startup with configuration summary', async () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('startup'),
        }),
      );
    });

    it('should validate polling interval configuration', async () => {
      // Valid configuration should succeed
      await expect(service.onApplicationBootstrap()).resolves.not.toThrow();
    });

    it('should reject polling interval below minimum (1000ms)', async () => {
      const module = await Test.createTestingModule({
        providers: [
          EngineLifecycleService,
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn((key: string) => {
                if (key === 'POLLING_INTERVAL_MS') return 500; // Below minimum
                return 30000;
              }),
            },
          },
          {
            provide: PrismaService,
            useValue: {
              $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
            },
          },
          {
            provide: TradingEngineService,
            useValue: {
              initiateShutdown: vi.fn(),
              waitForShutdown: vi.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      const invalidService = module.get<EngineLifecycleService>(
        EngineLifecycleService,
      );

      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        'POLLING_INTERVAL_MS must be between',
      );
    });

    it('should reject polling interval above maximum (300000ms)', async () => {
      const module = await Test.createTestingModule({
        providers: [
          EngineLifecycleService,
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn((key: string) => {
                if (key === 'POLLING_INTERVAL_MS') return 999999; // Above maximum
                return 30000;
              }),
            },
          },
          {
            provide: PrismaService,
            useValue: {
              $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
            },
          },
          {
            provide: TradingEngineService,
            useValue: {
              initiateShutdown: vi.fn(),
              waitForShutdown: vi.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      const invalidService = module.get<EngineLifecycleService>(
        EngineLifecycleService,
      );

      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        'POLLING_INTERVAL_MS must be between',
      );
    });
  });

  describe('onApplicationShutdown', () => {
    it('should stop trading engine on shutdown', async () => {
      await service.onApplicationShutdown('SIGTERM');

      expect(tradingEngine.initiateShutdown).toHaveBeenCalled();
      expect(tradingEngine.waitForShutdown).toHaveBeenCalledWith(12000);
    });

    it('should handle shutdown without signal parameter', async () => {
      await service.onApplicationShutdown();

      expect(tradingEngine.initiateShutdown).toHaveBeenCalled();
      expect(tradingEngine.waitForShutdown).toHaveBeenCalled();
    });

    it('should log shutdown completion', async () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.onApplicationShutdown('SIGTERM');

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('shutdown'),
        }),
      );
    });

    it('should complete gracefully even if trading engine fails', async () => {
      vi.mocked(tradingEngine.waitForShutdown).mockRejectedValueOnce(
        new Error('Shutdown timeout'),
      );

      await expect(
        service.onApplicationShutdown('SIGTERM'),
      ).resolves.not.toThrow();
    });
  });
});
