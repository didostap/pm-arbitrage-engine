import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../common/prisma.service';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { EnrichmentResult } from './position-enrichment.service';
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
    },
  } as unknown as PrismaService;
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

  beforeEach(() => {
    prisma = createMockPrisma();
    configService = createMockConfigService();
    enrichmentService = createMockEnrichmentService();
    service = new DashboardService(prisma, configService, enrichmentService);
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
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([mockPosition]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        1,
      );
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
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );

      await service.getPositions('paper');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          where: expect.objectContaining({ isPaper: true }),
        }),
      );
    });

    it('should include orders in query for enrichment', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );

      await service.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { pair: true, kalshiOrder: true, polymarketOrder: true },
        }),
      );
    });

    it('should apply pagination with skip and take', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );

      await service.getPositions(undefined, 3, 10);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });

    it('should clamp limit to max 200', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );

      await service.getPositions(undefined, 1, 500);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
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
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([mockPosition]);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        1,
      );
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
