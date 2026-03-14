import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../common/prisma.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { EnrichmentResult } from './position-enrichment.service';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { EngineConfigRepository } from '../persistence/repositories/engine-config.repository';
import Decimal from 'decimal.js';

function createMockPrisma() {
  return {
    platformHealthLog: {
      findMany: vi.fn(),
    },
    openPosition: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
    },
    order: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
    riskState: {
      findMany: vi.fn(),
    },
  } as unknown as PrismaService;
}

function createMockPositionRepository() {
  return {
    findManyWithFilters: vi.fn(),
  } as unknown as PositionRepository;
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
  } as unknown as ConfigService;
}

function createMockEnrichmentService() {
  return {
    enrich: vi.fn(),
  } as unknown as PositionEnrichmentService;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
  } as unknown as EventEmitter2;
}

function createMockRiskManager() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: null,
      updatedAt: new Date().toISOString(),
    }),
    getBankrollUsd: vi.fn().mockReturnValue(new Decimal('10000')),
    reloadBankroll: vi.fn().mockResolvedValue(undefined),
  } as unknown as IRiskManager;
}

function createMockEngineConfigRepository() {
  return {
    get: vi.fn().mockResolvedValue(null),
    upsertBankroll: vi.fn().mockResolvedValue({
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '10000' },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };
}

const mockEnrichedResult: EnrichmentResult = {
  status: 'enriched',
  data: {
    currentPrices: { kalshi: '0.60', polymarket: '0.40' },
    currentEdge: '0.08000000',
    unrealizedPnl: '8.00000000',
    exitProximity: { stopLoss: '0.25000000', takeProfit: '0.80000000' },
    resolutionDate: '2026-04-01T00:00:00.000Z',
    timeToResolution: '27d 12h',
  },
};

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let configService: ReturnType<typeof createMockConfigService>;
  let enrichmentService: ReturnType<typeof createMockEnrichmentService>;
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let engineConfigRepo: ReturnType<typeof createMockEngineConfigRepository>;

  beforeEach(() => {
    prisma = createMockPrisma();
    configService = createMockConfigService();
    enrichmentService = createMockEnrichmentService();
    positionRepository = createMockPositionRepository();
    eventEmitter = createMockEventEmitter();
    riskManager = createMockRiskManager();
    engineConfigRepo = createMockEngineConfigRepository();
    service = new DashboardService(
      prisma,
      configService,
      enrichmentService,
      positionRepository,
      eventEmitter,
      riskManager,
      engineConfigRepo as unknown as EngineConfigRepository,
    );

    // Default mock for riskState (overview balance computation)
    (prisma.riskState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: new Decimal('125.50') },
      });
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ _sum: { expectedEdge: null } });
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ _sum: { expectedEdge: null } });
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ _sum: { expectedEdge: null } });
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getOverview();
      expect(result.executionQualityRatio).toBe(0);
      expect(result.trailingPnl7d).toBe('0');
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: new Decimal('10') },
      });
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: null },
      });
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
      // Live section uses live bankroll
      expect(result.capitalOverview!.live.bankroll).toBe('10000');
      expect(result.capitalOverview!.live.deployed).toBe('200');
      expect(result.capitalOverview!.live.reserved).toBe('50');
      expect(result.capitalOverview!.live.available).toBe('9750');
      // Paper section uses paper bankroll
      expect(result.capitalOverview!.paper.bankroll).toBe('5000');
      expect(result.capitalOverview!.paper.deployed).toBe('300');
      expect(result.capitalOverview!.paper.reserved).toBe('0');
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ _sum: { expectedEdge: null } });
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
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: new Decimal('10') },
      });
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

      expect(result.capitalOverview).not.toBeNull();
      expect(result.capitalOverview!.live.available).toBe('0');
    });

    it('should use decimal.js for P&L calculation', async () => {
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);
      (
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: new Decimal('0.1') },
      });
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(10);

      const result = await service.getOverview();
      expect(result.trailingPnl7d).toBe('0.1');
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
          connection_state: 'connected',
        },
        {
          platform: 'POLYMARKET',
          status: 'degraded',
          created_at: new Date('2026-03-01T11:59:00Z'),
          connection_state: 'websocket_only',
        },
      ]);

      const result = await service.getHealth();
      expect(result).toHaveLength(2);
      expect(result[0]!.platformId).toBe('kalshi');
      expect(result[0]!.status).toBe('healthy');
      expect(result[1]!.platformId).toBe('polymarket');
      expect(result[1]!.status).toBe('degraded');
    });
  });

  describe('getPositions', () => {
    it('should return enriched positions with pagination', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        sizes: { kalshi: '100', polymarket: '100' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: 'Poly Yes',
          resolutionDate: new Date('2026-04-01'),
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.data[0]!.id).toBe('pos-1');
      expect(result.data[0]!.initialEdge).toBe('0.012');
      expect(result.data[0]!.currentEdge).toBe('0.08000000');
      expect(result.data[0]!.unrealizedPnl).toBe('8.00000000');
      expect(result.data[0]!.exitProximity).toEqual({
        stopLoss: '0.25000000',
        takeProfit: '0.80000000',
      });
      expect(result.data[0]!.resolutionDate).toBe('2026-04-01T00:00:00.000Z');
    });

    it('should filter by mode when specified', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions('paper');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        true,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should delegate to positionRepository for data fetching', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should apply pagination with page and limit', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 3, 10);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        3,
        10,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should clamp limit to max 200', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 500);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        200,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should accept status filter and pass to repository', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 50, 'OPEN,EXIT_PARTIAL');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should use default open statuses when no status param provided', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should return all statuses when empty string status provided', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 50, '');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        undefined,
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass sortBy and order through to repository', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        'expectedEdge',
        'asc',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        'expectedEdge',
        'asc',
        undefined,
      );
    });

    it('should compute realizedPnl for CLOSED positions from order fills', async () => {
      const mockPosition = {
        positionId: 'pos-closed-1',
        pairId: 'pair-1',
        status: 'CLOSED',
        expectedEdge: new Decimal('0.02'),
        entryPrices: { kalshi: '0.45', polymarket: '0.55' },
        sizes: { kalshi: '50', polymarket: '50' },
        isPaper: false,
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        entryKalshiFeeRate: new Decimal('0.07'),
        entryPolymarketFeeRate: new Decimal('0.02'),
        createdAt: new Date('2026-03-01T10:00:00Z'),
        updatedAt: new Date('2026-03-01T12:00:00Z'),
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Test Pair',
          polymarketDescription: null,
          resolutionDate: null,
        },
        kalshiOrder: {
          orderId: 'order-k-1',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
          side: 'buy',
          platform: 'KALSHI',
        },
        polymarketOrder: {
          orderId: 'order-p-1',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
          side: 'sell',
          platform: 'POLYMARKET',
        },
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      // Exit orders for realized P&L
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          orderId: 'exit-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
          side: 'sell',
          pairId: 'pair-1',
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
        {
          orderId: 'exit-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
          side: 'buy',
          pairId: 'pair-1',
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
      ]);

      // Exit type audit events
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          eventType: 'execution.exit.triggered',
          details: { pairId: 'pair-1', type: 'take_profit' },
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
      ]);

      const result = await service.getPositions(undefined, 1, 50, 'CLOSED');

      expect(result.data[0]!.realizedPnl).toBeDefined();
      expect(result.data[0]!.realizedPnl).not.toBeNull();
      expect(result.data[0]!.exitType).toBe('take_profit');
    });

    it('should return null realizedPnl and exitType for OPEN positions', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        sizes: { kalshi: '100', polymarket: '100' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: 'Poly Yes',
          resolutionDate: null,
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();

      expect(result.data[0]!.realizedPnl).toBeNull();
      expect(result.data[0]!.exitType).toBeNull();
    });

    it('should handle partial enrichment gracefully', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          resolutionDate: null,
        },
        kalshiOrder: null,
        polymarketOrder: null,
      };
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'failed',
        data: {
          currentPrices: { kalshi: null, polymarket: null },
          currentEdge: null,
          unrealizedPnl: null,
          exitProximity: null,
          resolutionDate: null,
          timeToResolution: null,
        },
        errors: ['Missing order fill data'],
      });

      const result = await service.getPositions();

      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.currentEdge).toBeNull();
      expect(result.data[0]!.unrealizedPnl).toBeNull();
    });

    it('should pass matchId through to repository as pairId', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
        'match-uuid-1',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        'match-uuid-1',
      );
    });

    it('should combine matchId with status and mode filters', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        'paper',
        1,
        50,
        'OPEN,EXIT_PARTIAL',
        undefined,
        undefined,
        'match-uuid-1',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'EXIT_PARTIAL'],
        true,
        1,
        50,
        undefined,
        undefined,
        'match-uuid-1',
      );
    });

    it('should return empty results when matchId has no matching positions', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      const result = await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
        'no-match-uuid',
      );

      expect(result.data).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('should return pairId in position summary DTOs', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        sizes: { kalshi: '100', polymarket: '100' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: 'Poly Yes',
          resolutionDate: new Date('2026-04-01'),
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();

      expect(result.data[0]!.pairId).toBe('pair-1');
    });
  });

  describe('getPositionById', () => {
    it('should return enriched position by ID', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          resolutionDate: new Date('2026-04-01'),
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockPosition);
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositionById('pos-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('pos-1');
      expect(result!.currentEdge).toBe('0.08000000');
    });

    it('should return null when position not found', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      const result = await service.getPositionById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getPositionDetails', () => {
    const mockDetailPosition = {
      positionId: 'pos-1',
      pairId: 'pair-1',
      status: 'OPEN',
      expectedEdge: new Decimal('0.02'),
      entryPrices: { kalshi: '0.45', polymarket: '0.55' },
      sizes: { kalshi: '50', polymarket: '50' },
      isPaper: false,
      kalshiSide: 'buy',
      polymarketSide: 'sell',
      kalshiOrderId: 'order-k-1',
      polymarketOrderId: 'order-p-1',
      entryKalshiFeeRate: new Decimal('0.07'),
      entryPolymarketFeeRate: new Decimal('0.02'),
      entryClosePriceKalshi: new Decimal('0.44'),
      entryClosePricePolymarket: new Decimal('0.56'),
      createdAt: new Date('2026-03-01T10:00:00Z'),
      updatedAt: new Date('2026-03-01T12:00:00Z'),
      pair: {
        kalshiContractId: 'k-contract',
        polymarketContractId: 'p-contract',
        kalshiDescription: 'Test Pair',
        polymarketDescription: null,
        resolutionDate: null,
      },
      kalshiOrder: {
        orderId: 'order-k-1',
        fillPrice: new Decimal('0.45'),
        fillSize: new Decimal('50'),
        side: 'buy',
        platform: 'KALSHI',
        price: new Decimal('0.45'),
        size: new Decimal('50'),
        status: 'FILLED',
        createdAt: new Date('2026-03-01T10:00:00Z'),
        updatedAt: new Date('2026-03-01T10:01:00Z'),
      },
      polymarketOrder: {
        orderId: 'order-p-1',
        fillPrice: new Decimal('0.55'),
        fillSize: new Decimal('50'),
        side: 'sell',
        platform: 'POLYMARKET',
        price: new Decimal('0.55'),
        size: new Decimal('50'),
        status: 'FILLED',
        createdAt: new Date('2026-03-01T10:00:00Z'),
        updatedAt: new Date('2026-03-01T10:01:00Z'),
      },
    };

    it('should assemble full position detail with orders and audit events', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockDetailPosition);

      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        mockDetailPosition.kalshiOrder,
        mockDetailPosition.polymarketOrder,
      ]);

      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'audit-1',
          eventType: 'risk.budget.reserved',
          createdAt: new Date('2026-03-01T10:00:00Z'),
          details: { pairId: 'pair-1', reason: 'Edge sufficient' },
        },
      ]);

      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositionDetails('pos-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('pos-1');
      expect(result!.orders).toHaveLength(2);
      expect(result!.auditEvents).toHaveLength(1);
      expect(result!.auditEvents[0]!.eventType).toBe('risk.budget.reserved');
      expect(result!.capitalBreakdown).toBeDefined();
    });

    it('should return null for non-existent position', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      const result = await service.getPositionDetails('nonexistent');
      expect(result).toBeNull();
    });

    it('should bound orders by position lifecycle timestamps', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockDetailPosition);

      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [],
      );
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      await service.getPositionDetails('pos-1');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          where: expect.objectContaining({
            pairId: 'pair-1',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            createdAt: expect.objectContaining({
              gte: mockDetailPosition.createdAt,
            }),
          }),
        }),
      );
    });

    it('should extract entry reasoning from BUDGET_RESERVED audit event', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockDetailPosition);

      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'audit-1',
          eventType: 'risk.budget.reserved',
          createdAt: new Date('2026-03-01T10:00:00Z'),
          details: {
            pairId: 'pair-1',
            reason: 'Edge 2.5% > 0.8% threshold',
            bankrollPercentage: '2.8%',
          },
        },
      ]);

      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositionDetails('pos-1');

      expect(result!.entryReasoning).toContain('Edge 2.5%');
    });
  });

  describe('getBankrollConfig', () => {
    it('should delegate to riskManager.getBankrollConfig()', async () => {
      const expected = {
        bankrollUsd: '10000',
        updatedAt: '2026-03-14T10:00:00.000Z',
      };
      (
        riskManager.getBankrollConfig as ReturnType<typeof vi.fn>
      ).mockResolvedValue(expected);

      const result = await service.getBankrollConfig();

      expect(result).toEqual(expected);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(riskManager.getBankrollConfig).toHaveBeenCalled();
    });
  });

  describe('updateBankroll', () => {
    it('should upsert to DB, reload risk manager, and emit event', async () => {
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '10000',
          updatedAt: '2026-03-14T10:00:00.000Z',
        })
        .mockResolvedValueOnce({
          bankrollUsd: '15000',
          updatedAt: '2026-03-14T11:00:00.000Z',
        });

      const result = await service.updateBankroll('15000');

      expect(engineConfigRepo.upsertBankroll).toHaveBeenCalledWith('15000');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(riskManager.reloadBankroll).toHaveBeenCalled();
      expect(result.bankrollUsd).toBe('15000');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'config.bankroll.updated',
        expect.objectContaining({
          previousValue: '10000',
          newValue: '15000',
          updatedBy: 'dashboard',
        }),
      );
    });

    it('should emit event with correct previous and new values', async () => {
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '5000',
          updatedAt: '2026-03-14T10:00:00.000Z',
        })
        .mockResolvedValueOnce({
          bankrollUsd: '7500',
          updatedAt: '2026-03-14T11:00:00.000Z',
        });

      await service.updateBankroll('7500');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'config.bankroll.updated',
        expect.objectContaining({
          previousValue: '5000',
          newValue: '7500',
        }),
      );
    });
  });

  describe('getAlerts', () => {
    it('should return single-leg exposed positions as alerts', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
          positionId: 'pos-1',
          pairId: 'pair-1',
          status: 'SINGLE_LEG_EXPOSED',
          updatedAt: new Date('2026-03-01T12:00:00Z'),
          pair: {
            kalshiDescription: 'K-desc',
            polymarketDescription: 'P-desc',
          },
        },
      ]);

      const result = await service.getAlerts();
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe('single_leg_exposure');
      expect(result[0]!.severity).toBe('critical');
    });
  });
});
