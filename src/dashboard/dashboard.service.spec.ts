import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../common/prisma.service';
import Decimal from 'decimal.js';

function createMockPrisma() {
  return {
    platformHealthLog: {
      findMany: vi.fn(),
    },
    openPosition: {
      count: vi.fn(),
      findMany: vi.fn(),
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

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let configService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    configService = createMockConfigService();
    service = new DashboardService(prisma, configService);
  });

  describe('getOverview', () => {
    it('should return composite overview with all metrics', async () => {
      // Mock health logs
      (
        prisma.platformHealthLog.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { platform: 'KALSHI', status: 'healthy' },
        { platform: 'POLYMARKET', status: 'healthy' },
      ]);

      // Mock open position count (first call: open positions, second call: single-leg alerts)
      (prisma.openPosition.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(0);

      // Mock trailing 7d P&L (sum of closed position edges)
      (
        prisma.openPosition.aggregate as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        _sum: { expectedEdge: new Decimal('125.50') },
      });

      // Mock execution quality: total orders and filled orders
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(100) // total orders
        .mockResolvedValueOnce(95); // filled orders

      const result = await service.getOverview();

      expect(result.systemHealth).toBe('healthy');
      expect(result.trailingPnl7d).toBe('125.5');
      expect(result.executionQualityRatio).toBe(0.95);
      expect(result.openPositionCount).toBe(5);
      expect(result.activeAlertCount).toBe(0); // no single-leg positions
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
      ).mockResolvedValue({
        _sum: { expectedEdge: null },
      });
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
      ).mockResolvedValue({
        _sum: { expectedEdge: null },
      });
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
      ).mockResolvedValue({
        _sum: { expectedEdge: null },
      });
      (prisma.order.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0) // total
        .mockResolvedValueOnce(0); // filled

      const result = await service.getOverview();

      expect(result.executionQualityRatio).toBe(0);
      expect(result.trailingPnl7d).toBe('0');
      expect(result.systemHealth).toBe('critical'); // no health logs = critical
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

      // Must be "0.1" not "0.1000000000000000055511151231257827021181583404541015625"
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
    it('should return open positions with decimal strings', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        {
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
          },
        },
      ]);

      const result = await service.getPositions();

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('pos-1');
      expect(result[0]!.initialEdge).toBe('0.012');
      expect(result[0]!.isPaper).toBe(false);
    });

    it('should filter by mode when specified', async () => {
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);

      await service.getPositions('paper');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prisma.openPosition.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          where: expect.objectContaining({ isPaper: true }),
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
