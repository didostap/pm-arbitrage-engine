/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EngineLifecycleService } from './engine-lifecycle.service';
import { TradingEngineService } from './trading-engine.service';
import { PrismaService } from '../common/prisma.service';
import { StartupReconciliationService } from '../reconciliation/startup-reconciliation.service';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../connectors/connector.constants';
import { createMockPlatformConnector } from '../test/mock-factories';
import { PlatformId } from '../common/types/platform.type';
import { ConfigValidationError } from '../common/errors/config-validation-error';
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

const createMockReconciliationService = () => ({
  reconcile: vi.fn().mockResolvedValue({
    positionsChecked: 0,
    ordersVerified: 0,
    pendingOrdersResolved: 0,
    discrepanciesFound: 0,
    durationMs: 100,
    platformsUnavailable: [],
    discrepancies: [],
  }),
  getLastRunResult: vi.fn().mockReturnValue(null),
});

const createProviders = (overrides?: Record<string, unknown>) => [
  EngineLifecycleService,
  {
    provide: ConfigService,
    useValue: {
      get: vi.fn((key: string, defaultValue?: unknown): unknown => {
        if (key === 'POLLING_INTERVAL_MS') return 30000;
        if (key === 'ALLOW_MIXED_MODE') return defaultValue ?? 'false';
        return defaultValue;
      }),
      ...(overrides?.configService as object),
    },
  },
  {
    provide: PrismaService,
    useValue: {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      ...(overrides?.prisma as object),
    },
  },
  {
    provide: TradingEngineService,
    useValue: {
      initiateShutdown: vi.fn(),
      waitForShutdown: vi.fn().mockResolvedValue(undefined),
      ...(overrides?.tradingEngine as object),
    },
  },
  {
    provide: EventEmitter2,
    useValue: {
      emit: vi.fn(),
      ...(overrides?.eventEmitter as object),
    },
  },
  {
    provide: StartupReconciliationService,
    useValue:
      (overrides?.reconciliation as object) ??
      createMockReconciliationService(),
  },
  {
    provide: RISK_MANAGER_TOKEN,
    useValue: {
      haltTrading: vi.fn(),
      resumeTrading: vi.fn(),
      isTradingHalted: vi.fn().mockReturnValue(false),
      ...(overrides?.riskManager as object),
    },
  },
  {
    provide: KALSHI_CONNECTOR_TOKEN,
    useValue:
      (overrides?.kalshiConnector as object) ??
      createMockPlatformConnector(PlatformId.KALSHI),
  },
  {
    provide: POLYMARKET_CONNECTOR_TOKEN,
    useValue:
      (overrides?.polymarketConnector as object) ??
      createMockPlatformConnector(PlatformId.POLYMARKET),
  },
];

describe('EngineLifecycleService', () => {
  let service: EngineLifecycleService;
  let prisma: PrismaService;
  let tradingEngine: TradingEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: createProviders(),
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
        providers: createProviders({
          configService: {
            get: vi.fn((key: string) => {
              if (key === 'POLLING_INTERVAL_MS') return 500; // Below minimum
              return 30000;
            }),
          },
        }),
      }).compile();

      const invalidService = module.get<EngineLifecycleService>(
        EngineLifecycleService,
      );

      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        'POLLING_INTERVAL_MS must be between',
      );
    });

    it('should reject polling interval above maximum (300000ms)', async () => {
      const module = await Test.createTestingModule({
        providers: createProviders({
          configService: {
            get: vi.fn((key: string) => {
              if (key === 'POLLING_INTERVAL_MS') return 999999; // Above maximum
              return 30000;
            }),
          },
        }),
      }).compile();

      const invalidService = module.get<EngineLifecycleService>(
        EngineLifecycleService,
      );

      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(invalidService.onApplicationBootstrap()).rejects.toThrow(
        'POLLING_INTERVAL_MS must be between',
      );
    });

    it('should call reconciliation service during startup', async () => {
      const mockRecon = createMockReconciliationService();
      const module = await Test.createTestingModule({
        providers: createProviders({ reconciliation: mockRecon }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      await svc.onApplicationBootstrap();

      expect(mockRecon.reconcile).toHaveBeenCalled();
    });

    it('should handle reconciliation failure with active positions by halting trading', async () => {
      const mockRecon = {
        ...createMockReconciliationService(),
        reconcile: vi.fn().mockRejectedValue(new Error('Platform timeout')),
      };
      const mockRisk = {
        haltTrading: vi.fn(),
        resumeTrading: vi.fn(),
        isTradingHalted: vi.fn().mockReturnValue(false),
      };
      const module = await Test.createTestingModule({
        providers: createProviders({
          reconciliation: mockRecon,
          riskManager: mockRisk,
          prisma: {
            $queryRaw: vi
              .fn()
              .mockResolvedValueOnce([{ '?column?': 1 }]) // DB check
              .mockResolvedValueOnce([{ count: BigInt(2) }]), // Active positions query
          },
        }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      await svc.onApplicationBootstrap();

      expect(mockRisk.haltTrading).toHaveBeenCalledWith(
        'reconciliation_discrepancy',
      );
    });

    it('should log platform modes at startup (both live)', async () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('[Kalshi: LIVE] [Polymarket: LIVE]'),
          module: 'core',
          data: expect.objectContaining({
            kalshiMode: 'live',
            polymarketMode: 'live',
          }),
        }),
      );
    });

    it('should log platform modes at startup (both paper)', async () => {
      const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      const polymarketConnector = createMockPlatformConnector(
        PlatformId.POLYMARKET,
      );
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });

      const module = await Test.createTestingModule({
        providers: createProviders({
          kalshiConnector,
          polymarketConnector,
        }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      const logSpy = vi.spyOn(svc['logger'], 'log');
      await svc.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            '[Kalshi: PAPER] [Polymarket: PAPER]',
          ),
          data: expect.objectContaining({
            kalshiMode: 'paper',
            polymarketMode: 'paper',
          }),
        }),
      );
    });

    it('should throw ConfigValidationError when mixed mode detected and ALLOW_MIXED_MODE=false', async () => {
      const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });

      const module = await Test.createTestingModule({
        providers: createProviders({
          kalshiConnector,
          configService: {
            get: vi.fn((key: string, defaultValue?: unknown): unknown => {
              if (key === 'POLLING_INTERVAL_MS') return 30000;
              if (key === 'ALLOW_MIXED_MODE') return 'false';
              return defaultValue;
            }),
          },
        }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        /Mixed mode detected/,
      );
    });

    it('should allow mixed mode and log warning when ALLOW_MIXED_MODE=true', async () => {
      const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });

      const module = await Test.createTestingModule({
        providers: createProviders({
          kalshiConnector,
          configService: {
            get: vi.fn((key: string, defaultValue?: unknown): unknown => {
              if (key === 'POLLING_INTERVAL_MS') return 30000;
              if (key === 'ALLOW_MIXED_MODE') return 'true';
              return defaultValue;
            }),
          },
        }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      const warnSpy = vi.spyOn(svc['logger'], 'warn');
      await svc.onApplicationBootstrap();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            'Mixed mode active — live capital at risk alongside paper trades',
          ),
        }),
      );
    });

    it('should treat missing mode field as live', async () => {
      // Default mock connectors have no mode field — should be treated as live
      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kalshiMode: 'live',
            polymarketMode: 'live',
          }),
        }),
      );
    });

    it('should throw ConfigValidationError when getHealth() throws', async () => {
      const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI);
      kalshiConnector.getHealth.mockImplementation(() => {
        throw new Error('Connector not initialized');
      });

      const module = await Test.createTestingModule({
        providers: createProviders({ kalshiConnector }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        ConfigValidationError,
      );
      await expect(svc.onApplicationBootstrap()).rejects.toThrow(
        /Failed to read connector health/,
      );
    });

    it('should skip halt when reconciliation fails with no active positions', async () => {
      const mockRecon = {
        ...createMockReconciliationService(),
        reconcile: vi.fn().mockRejectedValue(new Error('Platform timeout')),
      };
      const mockRisk = {
        haltTrading: vi.fn(),
        resumeTrading: vi.fn(),
        isTradingHalted: vi.fn().mockReturnValue(false),
      };
      const module = await Test.createTestingModule({
        providers: createProviders({
          reconciliation: mockRecon,
          riskManager: mockRisk,
          prisma: {
            $queryRaw: vi
              .fn()
              .mockResolvedValueOnce([{ '?column?': 1 }]) // DB check
              .mockResolvedValueOnce([{ count: BigInt(0) }]), // No active positions
          },
        }),
      }).compile();

      const svc = module.get<EngineLifecycleService>(EngineLifecycleService);
      await svc.onApplicationBootstrap();

      // Should NOT halt trading
      expect(mockRisk.haltTrading).not.toHaveBeenCalled();
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
