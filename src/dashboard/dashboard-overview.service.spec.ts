import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardOverviewService } from './dashboard-overview.service';
import { PrismaService } from '../common/prisma.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';

function createMockPrisma() {
  return {
    platformHealthLog: {
      findMany: vi.fn(),
    },
    openPosition: {
      count: vi.fn(),
    },
    order: {
      count: vi.fn(),
    },
    riskState: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

function createMockPositionRepository() {
  return {
    sumClosedPnlByDateRange: vi.fn().mockResolvedValue('0'),
  } as unknown as PositionRepository;
}

function createMockRiskManager() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: null,
      updatedAt: new Date().toISOString(),
    }),
    isTradingHalted: vi.fn().mockReturnValue(false),
    getActiveHaltReasons: vi.fn().mockReturnValue([]),
  } as unknown as IRiskManager;
}

function createMockDataIngestionService() {
  return {
    getActiveSubscriptionCount: vi.fn().mockReturnValue(0),
  };
}

function createMockDivergenceService() {
  return {
    getDivergenceStatus: vi.fn().mockReturnValue('normal'),
  };
}

function createMockPlatformHealthService() {
  return {
    getWsLastMessageTimestamp: vi.fn().mockReturnValue(null),
  };
}

function createMockShadowComparisonService() {
  return {
    getClosedPositionEntries: vi.fn().mockReturnValue([]),
    generateDailySummary: vi.fn().mockReturnValue({
      totalComparisons: 0,
      fixedTriggerCount: 0,
      modelTriggerCount: 0,
      cumulativePnlDelta: new Decimal(0),
      triggerCountByCriterion: {},
    }),
  };
}

function createMockConfigService() {
  return {
    get: vi.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        PLATFORM_MODE_KALSHI: 'paper',
        PLATFORM_MODE_POLYMARKET: 'paper',
      };
      return config[key] ?? defaultValue;
    }),
  };
}

describe('DashboardOverviewService', () => {
  let service: DashboardOverviewService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let dataIngestionService: ReturnType<typeof createMockDataIngestionService>;
  let divergenceService: ReturnType<typeof createMockDivergenceService>;
  let healthService: ReturnType<typeof createMockPlatformHealthService>;
  let shadowComparisonService: ReturnType<
    typeof createMockShadowComparisonService
  >;
  let configService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    positionRepository = createMockPositionRepository();
    riskManager = createMockRiskManager();
    dataIngestionService = createMockDataIngestionService();
    divergenceService = createMockDivergenceService();
    healthService = createMockPlatformHealthService();
    shadowComparisonService = createMockShadowComparisonService();
    configService = createMockConfigService();

    service = new DashboardOverviewService(
      prisma,
      positionRepository,
      riskManager,
      dataIngestionService as any,
      divergenceService as any,
      healthService as any,
      shadowComparisonService as any,
      configService as any,
    );
  });

  describe('getOverview', () => {
    it('should return composite overview with all metrics', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'healthy' },
        { platform: 'POLYMARKET', status: 'healthy' },
      ]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('125.5');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(95);

      const result = await service.getOverview();

      expect(result.systemHealth).toBe('healthy');
      expect(result.trailingPnl7d).toBe('125.5');
      expect(result.executionQualityRatio).toBe(0.95);
      expect(result.openPositionCount).toBe(5);
      expect(result.activeAlertCount).toBe(0);
    });

    it('should return degraded health when any platform is degraded', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'healthy' },
        { platform: 'POLYMARKET', status: 'degraded' },
      ]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.systemHealth).toBe('degraded');
    });

    it('should return critical health when any platform is disconnected', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'disconnected' },
        { platform: 'POLYMARKET', status: 'healthy' },
      ]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.systemHealth).toBe('critical');
    });

    it('should handle zero orders without division by zero', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.executionQualityRatio).toBe(0);
      expect(result.systemHealth).toBe('critical');
    });

    it('should include balance fields from risk state and config', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'healthy' },
        { platform: 'POLYMARKET', status: 'healthy' },
      ]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('10');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(10);
      (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [
          {
            mode: 'live',
            totalCapitalDeployed: new Decimal('500'),
            reservedCapital: new Decimal('100'),
          },
        ],
      );

      const result = await service.getOverview();

      expect(result.capitalOverview).not.toBeNull();
      expect(result.capitalOverview!.live.bankroll).toBe('10000');
      expect(result.capitalOverview!.live.deployed).toBe('500');
      expect(result.capitalOverview!.live.reserved).toBe('100');
      expect(result.capitalOverview!.live.available).toBe('9400');
    });

    it('should include paper capital overview from paper risk state and paperBankrollUsd', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'healthy' },
        { platform: 'POLYMARKET', status: 'healthy' },
      ]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [
          {
            mode: 'live',
            totalCapitalDeployed: new Decimal('200'),
            reservedCapital: new Decimal('50'),
          },
          {
            mode: 'paper',
            totalCapitalDeployed: new Decimal('300'),
            reservedCapital: new Decimal('0'),
          },
        ],
      );
      (
        riskManager.getBankrollConfig as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        bankrollUsd: '10000',
        paperBankrollUsd: '5000',
        updatedAt: new Date().toISOString(),
      });

      const result = await service.getOverview();

      expect(result.capitalOverview).not.toBeNull();
      expect(result.capitalOverview!.live.bankroll).toBe('10000');
      expect(result.capitalOverview!.live.deployed).toBe('200');
      expect(result.capitalOverview!.paper.bankroll).toBe('5000');
      expect(result.capitalOverview!.paper.deployed).toBe('300');
      expect(result.capitalOverview!.paper.available).toBe('4700');
    });

    it('should return null balance fields when bankroll is zero', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [],
      );
      (
        riskManager.getBankrollConfig as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        bankrollUsd: '0',
        paperBankrollUsd: null,
        updatedAt: new Date().toISOString(),
      });

      const result = await service.getOverview();
      expect(result.capitalOverview).toBeNull();
    });

    it('should floor availableCapital at zero when over-deployed', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([{ platform: 'KALSHI', status: 'healthy' }]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('10');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(10);
      (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [
          {
            mode: 'live',
            totalCapitalDeployed: new Decimal('9000'),
            reservedCapital: new Decimal('2000'),
          },
        ],
      );

      const result = await service.getOverview();
      expect(result.capitalOverview!.live.available).toBe('0');
    });

    it('should return tradingHalted=false when not halted', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.tradingHalted).toBe(false);
      expect(result.haltReasons).toEqual([]);
    });

    it('should return tradingHalted=true with halt reasons when halted', async () => {
      (riskManager.isTradingHalted as ReturnType<typeof vi.fn>).mockReturnValue(
        true,
      );
      (
        riskManager.getActiveHaltReasons as ReturnType<typeof vi.fn>
      ).mockReturnValue(['daily_loss_limit']);
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        positionRepository.sumClosedPnlByDateRange as ReturnType<typeof vi.fn>
      ).mockResolvedValue('0');
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.tradingHalted).toBe(true);
      expect(result.haltReasons).toEqual(['daily_loss_limit']);
    });
  });

  describe('getHealth', () => {
    it('should return health per platform', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          platform: 'KALSHI',
          status: 'healthy',
          created_at: new Date('2026-03-01T12:00:00Z'),
        },
        {
          platform: 'POLYMARKET',
          status: 'degraded',
          created_at: new Date('2026-03-01T11:59:00Z'),
        },
      ]);

      const result = await service.getHealth();
      expect(result).toHaveLength(2);
      expect(result[0]!.platformId).toBe('kalshi');
      expect(result[0]!.status).toBe('healthy');
      expect(result[1]!.platformId).toBe('polymarket');
      expect(result[1]!.status).toBe('degraded');
    });

    it('should populate wsSubscriptionCount, divergenceStatus, and wsLastMessageTimestamp', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          platform: 'KALSHI',
          status: 'healthy',
          created_at: new Date('2026-03-01T12:00:00Z'),
        },
      ]);

      const result = await service.getHealth();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('wsSubscriptionCount');
      expect(result[0]).toHaveProperty('divergenceStatus');
      expect(result[0]).toHaveProperty('wsLastMessageTimestamp');
      expect(result[0]!.wsSubscriptionCount).toBe(0);
      expect(result[0]!.divergenceStatus).toBe('normal');
      expect(result[0]!.wsLastMessageTimestamp).toBeNull();
    });
  });

  describe('getAlerts', () => {
    it('should return single-leg exposed positions as alerts', async () => {
      (prisma.openPosition as any).findMany = vi.fn().mockResolvedValue([
        {
          positionId: 'pos-alert-1',
          pairId: 'pair-1',
          status: 'SINGLE_LEG_EXPOSED',
          updatedAt: new Date('2026-03-01T10:00:00Z'),
          pair: { kalshiDescription: 'Test' },
        },
      ]);

      const result = await service.getAlerts();
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('single_leg_exposure');
      expect(result[0]!.severity).toBe('critical');
    });
  });

  describe('getShadowComparisons', () => {
    it('should return mapped shadow comparison entries', () => {
      shadowComparisonService.getClosedPositionEntries.mockReturnValue([
        {
          positionId: 'pos-1',
          pairId: 'pair-1',
          pnlDelta: new Decimal('0.05'),
          modelExitTimestamp: new Date('2026-03-01T10:00:00Z'),
          fixedWouldHaveExitedAt: new Date('2026-03-01T10:30:00Z'),
          triggerCriterion: 'stop_loss',
        },
      ]);

      const result = service.getShadowComparisons();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          positionId: 'pos-1',
          pnlDelta: '0.05000000',
          triggerCriterion: 'stop_loss',
        }),
      );
    });
  });

  describe('getShadowSummary', () => {
    it('should return aggregate shadow summary', () => {
      shadowComparisonService.generateDailySummary.mockReturnValue({
        totalComparisons: 10,
        fixedTriggerCount: 3,
        modelTriggerCount: 7,
        cumulativePnlDelta: new Decimal('1.5'),
        triggerCountByCriterion: { stop_loss: 2, resolution: 1 },
      });
      shadowComparisonService.getClosedPositionEntries.mockReturnValue([
        { pnlDelta: new Decimal('0.5') },
        { pnlDelta: new Decimal('-0.2') },
      ]);

      const result = service.getShadowSummary() as any;
      expect(result.totalEvaluations).toBe(10);
      expect(result.fixedTriggerCycles).toBe(3);
      expect(result.closedPositionPnlDelta).toBe('0.30000000');
      expect(result.closedPositionCount).toBe(2);
    });
  });

  describe('computeCompositeHealth', () => {
    it('should return critical for empty logs', () => {
      expect(service.computeCompositeHealth([])).toBe('critical');
    });

    it('should return critical when disconnected', () => {
      expect(service.computeCompositeHealth([{ status: 'disconnected' }])).toBe(
        'critical',
      );
    });

    it('should return degraded when degraded', () => {
      expect(
        service.computeCompositeHealth([
          { status: 'healthy' },
          { status: 'degraded' },
        ]),
      ).toBe('degraded');
    });

    it('should return healthy when all healthy', () => {
      expect(
        service.computeCompositeHealth([
          { status: 'healthy' },
          { status: 'healthy' },
        ]),
      ).toBe('healthy');
    });
  });
});
