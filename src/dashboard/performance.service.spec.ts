import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { PerformanceService } from './performance.service';
import { PrismaService } from '../common/prisma.service';
import { EVENT_NAMES } from '../common/events/event-catalog';
import { SystemHealthError } from '../common/errors/system-health-error';

function createMockPrisma() {
  return {
    order: { count: vi.fn(), findMany: vi.fn() },
    openPosition: { count: vi.fn(), findMany: vi.fn() },
    auditLog: { count: vi.fn() },
    riskOverrideLog: { count: vi.fn() },
  } as unknown as PrismaService;
}

describe('PerformanceService', () => {
  let service: PerformanceService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new PerformanceService(prisma as unknown as PrismaService);
  });

  describe('getWeeklySummary', () => {
    it('should return weekly summaries with data across multiple weeks', async () => {
      // Mock: 2 filled orders in first week
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      // Mock: 1 closed position
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        1,
      );
      // Mock: filled orders for slippage calc
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { price: new Decimal('0.55'), fillPrice: new Decimal('0.56') },
        { price: new Decimal('0.40'), fillPrice: new Decimal('0.39') },
      ]);
      // Mock: closed positions for P&L
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([{ expectedEdge: new Decimal('0.025') }]);
      // Mock: audit log counts (detected=5, filtered=2, executed=3)
      (prisma.auditLog.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(5) // OPPORTUNITY_IDENTIFIED - week 1
        .mockResolvedValueOnce(2) // OPPORTUNITY_FILTERED - week 1
        .mockResolvedValueOnce(3); // ORDER_FILLED - week 1
      // Mock: manual interventions
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getWeeklySummary(1);

      expect(result).toHaveLength(1);
      const week = result[0]!;
      expect(week.totalTrades).toBe(2);
      expect(week.closedPositions).toBe(1);
      expect(week.pnl).toBe('0.025');
      expect(week.hitRate).toBe(1.0); // 1 profitable / 1 total
      expect(week.averageSlippage).toBe('0.01'); // (0.01 + 0.01) / 2
      expect(week.opportunitiesDetected).toBe(5);
      expect(week.opportunitiesFiltered).toBe(2);
      expect(week.opportunitiesExecuted).toBe(3);
      expect(week.manualInterventions).toBe(0);
      expect(week.autonomyRatio).toBe('2'); // 2 / max(0, 1) = 2
    });

    it('should return zeroes and N/A for empty week', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getWeeklySummary(1);

      expect(result).toHaveLength(1);
      const week = result[0]!;
      expect(week.totalTrades).toBe(0);
      expect(week.closedPositions).toBe(0);
      expect(week.pnl).toBe('0');
      expect(week.hitRate).toBe(0);
      expect(week.averageSlippage).toBe('0');
      expect(week.autonomyRatio).toBe('N/A');
    });

    it('should compute slippage as absolute value of fill vs price', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { price: new Decimal('0.60'), fillPrice: new Decimal('0.55') }, // |0.55 - 0.60| = 0.05
        { price: new Decimal('0.30'), fillPrice: new Decimal('0.35') }, // |0.35 - 0.30| = 0.05
      ]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getWeeklySummary(1);
      expect(result[0]!.averageSlippage).toBe('0.05');
    });

    it('should handle hit rate edge cases', async () => {
      // 0 closed positions → hitRate = 0
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.openPosition.count as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(0); // total closed
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getWeeklySummary(1);
      expect(result[0]!.hitRate).toBe(0);
    });

    it('should compute autonomy ratio with zero manual interventions as trades / 1', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(10);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getWeeklySummary(1);
      expect(result[0]!.autonomyRatio).toBe('10'); // 10 / max(0, 1)
    });

    it('should use exclusive upper bound for date ranges (Monday < next Monday)', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      await service.getWeeklySummary(1);

      // Verify the date range used in the first order.count call
      const call = (prisma.order.count as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as {
        where: {
          createdAt: { gte: Date; lt: Date; lte?: Date };
          isPaper?: boolean;
        };
      };
      const where = call.where;
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.lt).toBeInstanceOf(Date);

      // Verify it's gte/lt (not lte)
      expect(where.createdAt).not.toHaveProperty('lte');

      // Verify Monday boundaries
      const start = where.createdAt.gte;
      const end = where.createdAt.lt;
      expect(start.getUTCDay()).toBe(1); // Monday
      expect(end.getUTCDay()).toBe(1); // Next Monday
      expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should filter paper mode: mode=paper only includes isPaper=true orders/positions', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      await service.getWeeklySummary(1, 'paper');

      const orderCall = (prisma.order.count as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { where: { isPaper?: boolean } };
      expect(orderCall.where.isPaper).toBe(true);
    });

    it('should filter paper mode: mode=live excludes isPaper=true', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      await service.getWeeklySummary(1, 'live');

      const orderCall = (prisma.order.count as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { where: { isPaper?: boolean } };
      expect(orderCall.where.isPaper).toBe(false);
    });

    it('should not filter paper mode when mode=undefined', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      await service.getWeeklySummary(1);

      const orderCall = (prisma.order.count as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as { where: { isPaper?: boolean } };
      expect(orderCall.where).not.toHaveProperty('isPaper');
    });

    it('should query AuditLog using EVENT_NAMES constants', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      await service.getWeeklySummary(1);

      const auditCalls = (prisma.auditLog.count as ReturnType<typeof vi.fn>)
        .mock.calls as Array<[{ where: { eventType: string } }]>;
      expect(auditCalls).toHaveLength(3);
      expect(auditCalls[0]![0].where.eventType).toBe(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      );
      expect(auditCalls[1]![0].where.eventType).toBe(
        EVENT_NAMES.OPPORTUNITY_FILTERED,
      );
      expect(auditCalls[2]![0].where.eventType).toBe(EVENT_NAMES.ORDER_FILLED);
    });
  });

  describe('getDailySummary', () => {
    it('should return daily summaries with data across multiple days', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        2,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { price: new Decimal('0.50'), fillPrice: new Decimal('0.51') },
      ]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([
        { expectedEdge: new Decimal('0.01') },
        { expectedEdge: new Decimal('-0.005') },
      ]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getDailySummary(1);

      expect(result).toHaveLength(1);
      const day = result[0]!;
      expect(day.totalTrades).toBe(3);
      expect(day.closedPositions).toBe(2);
      expect(day.pnl).toBe('0.005'); // 0.01 + (-0.005)
      expect(day.hitRate).toBe(0.5); // 1 profitable / 2 total
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return zeroes for empty day', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.openPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(
        0,
      );
      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockResolvedValue([]);
      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockResolvedValue(0);

      const result = await service.getDailySummary(1);

      expect(result).toHaveLength(1);
      const day = result[0]!;
      expect(day.totalTrades).toBe(0);
      expect(day.pnl).toBe('0');
      expect(day.autonomyRatio).toBe('N/A');
    });
  });

  describe('getRollingAverages', () => {
    /* eslint-disable @typescript-eslint/no-misused-promises, @typescript-eslint/require-await */
    function mockWeekData(
      prisma: ReturnType<typeof createMockPrisma>,
      weekPatterns: Array<{
        trades: number;
        closedPositions: number;
        pnl: string;
        profitablePositions: number;
        slippageOrders: Array<{ price: string; fillPrice: string }>;
        detected: number;
        filtered: number;
        executed: number;
        overrides: number;
      }>,
    ) {
      let orderCountCall = 0;
      let posCountCall = 0;
      let orderFindCall = 0;
      let posFindCall = 0;
      let auditCountCall = 0;
      let overrideCountCall = 0;

      (prisma.order.count as ReturnType<typeof vi.fn>).mockImplementation(
        async () => weekPatterns[orderCountCall++]?.trades ?? 0,
      );

      (
        prisma.openPosition.count as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async () => weekPatterns[posCountCall++]?.closedPositions ?? 0,
      );

      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          const week = weekPatterns[orderFindCall++];
          return (week?.slippageOrders ?? []).map((o) => ({
            price: new Decimal(o.price),
            fillPrice: new Decimal(o.fillPrice),
          }));
        },
      );

      (
        prisma.openPosition.findMany as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => {
        const week = weekPatterns[posFindCall++];
        if (!week) return [];
        const positions: Array<{ expectedEdge: Decimal }> = [];
        for (let j = 0; j < (week.profitablePositions ?? 0); j++) {
          positions.push({ expectedEdge: new Decimal(week.pnl) });
        }
        for (
          let j = week.profitablePositions ?? 0;
          j < (week.closedPositions ?? 0);
          j++
        ) {
          positions.push({ expectedEdge: new Decimal('-0.001') });
        }
        return positions;
      });

      (prisma.auditLog.count as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          const weekIdx = Math.floor(auditCountCall / 3);
          const type = auditCountCall % 3;
          auditCountCall++;
          const week = weekPatterns[weekIdx];
          if (!week) return 0;
          if (type === 0) return week.detected;
          if (type === 1) return week.filtered;
          return week.executed;
        },
      );

      (
        prisma.riskOverrideLog.count as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async () => weekPatterns[overrideCountCall++]?.overrides ?? 0,
      );
    }
    /* eslint-enable @typescript-eslint/no-misused-promises, @typescript-eslint/require-await */

    it('should compute rolling averages from 8 weeks of data', async () => {
      const weeks = Array.from({ length: 8 }, () => ({
        trades: 10,
        closedPositions: 2,
        pnl: '0.05',
        profitablePositions: 2,
        slippageOrders: [{ price: '0.50', fillPrice: '0.51' }],
        detected: 12,
        filtered: 2,
        executed: 10,
        overrides: 0,
      }));
      mockWeekData(prisma, weeks);

      const result = await service.getRollingAverages();

      expect(result.rollingAverages.opportunityFrequency).toBe(12); // avg of 12,12,12,12
      expect(result.edgeTrend).toBe('stable'); // same data across all weeks
    });

    it('should flag opportunity below baseline when avg < 8', async () => {
      const weeks = Array.from({ length: 8 }, () => ({
        trades: 5,
        closedPositions: 1,
        pnl: '0.01',
        profitablePositions: 1,
        slippageOrders: [],
        detected: 5, // below baseline of 8
        filtered: 1,
        executed: 4,
        overrides: 0,
      }));
      mockWeekData(prisma, weeks);

      const result = await service.getRollingAverages();
      expect(result.opportunityBelowBaseline).toBe(true);
    });

    it('should detect improving edge trend', async () => {
      // Latest 4 weeks: high PnL, previous 4 weeks: low PnL
      const weeks = [
        // weeks[0] = most recent
        ...Array.from({ length: 4 }, () => ({
          trades: 10,
          closedPositions: 2,
          pnl: '0.10',
          profitablePositions: 2,
          slippageOrders: [],
          detected: 10,
          filtered: 0,
          executed: 10,
          overrides: 0,
        })),
        ...Array.from({ length: 4 }, () => ({
          trades: 10,
          closedPositions: 2,
          pnl: '0.02',
          profitablePositions: 2,
          slippageOrders: [],
          detected: 10,
          filtered: 0,
          executed: 10,
          overrides: 0,
        })),
      ];
      mockWeekData(prisma, weeks);

      const result = await service.getRollingAverages();
      expect(result.edgeTrend).toBe('improving');
    });

    it('should detect declining edge trend', async () => {
      const weeks = [
        ...Array.from({ length: 4 }, () => ({
          trades: 10,
          closedPositions: 2,
          pnl: '0.02',
          profitablePositions: 2,
          slippageOrders: [],
          detected: 10,
          filtered: 0,
          executed: 10,
          overrides: 0,
        })),
        ...Array.from({ length: 4 }, () => ({
          trades: 10,
          closedPositions: 2,
          pnl: '0.10',
          profitablePositions: 2,
          slippageOrders: [],
          detected: 10,
          filtered: 0,
          executed: 10,
          overrides: 0,
        })),
      ];
      mockWeekData(prisma, weeks);

      const result = await service.getRollingAverages();
      expect(result.edgeTrend).toBe('declining');
    });

    it('should detect improving trend when previous 4 weeks have zero data', async () => {
      // Only 4 weeks of real data — previous 4 weeks are all zeros
      // latest avg > 0 * 1.1 → improving (any positive > zero)
      const weeks = Array.from({ length: 4 }, () => ({
        trades: 5,
        closedPositions: 1,
        pnl: '0.03',
        profitablePositions: 1,
        slippageOrders: [],
        detected: 10,
        filtered: 1,
        executed: 9,
        overrides: 0,
      }));
      // Pad with 4 empty weeks (service always fetches 8)
      const allWeeks = [
        ...weeks,
        ...Array.from({ length: 4 }, () => ({
          trades: 0,
          closedPositions: 0,
          pnl: '0',
          profitablePositions: 0,
          slippageOrders: [] as Array<{ price: string; fillPrice: string }>,
          detected: 0,
          filtered: 0,
          executed: 0,
          overrides: 0,
        })),
      ];
      mockWeekData(prisma, allWeeks);

      const result = await service.getRollingAverages();
      expect(result.edgeTrend).toBe('improving');
      expect(result.rollingAverages.opportunityFrequency).toBe(10);
    });

    it('should set dataInsufficient=true when fewer than 8 non-empty weeks exist', async () => {
      // 4 real weeks + 4 empty weeks
      const allWeeks = [
        ...Array.from({ length: 4 }, () => ({
          trades: 5,
          closedPositions: 1,
          pnl: '0.03',
          profitablePositions: 1,
          slippageOrders: [] as Array<{ price: string; fillPrice: string }>,
          detected: 10,
          filtered: 1,
          executed: 9,
          overrides: 0,
        })),
        ...Array.from({ length: 4 }, () => ({
          trades: 0,
          closedPositions: 0,
          pnl: '0',
          profitablePositions: 0,
          slippageOrders: [] as Array<{ price: string; fillPrice: string }>,
          detected: 0,
          filtered: 0,
          executed: 0,
          overrides: 0,
        })),
      ];
      mockWeekData(prisma, allWeeks);

      const result = await service.getRollingAverages();
      expect(result.dataInsufficient).toBe(true);
    });

    it('should set dataInsufficient=false when 8 non-empty weeks exist', async () => {
      const weeks = Array.from({ length: 8 }, () => ({
        trades: 10,
        closedPositions: 2,
        pnl: '0.05',
        profitablePositions: 2,
        slippageOrders: [{ price: '0.50', fillPrice: '0.51' }],
        detected: 12,
        filtered: 2,
        executed: 10,
        overrides: 0,
      }));
      mockWeekData(prisma, weeks);

      const result = await service.getRollingAverages();
      expect(result.dataInsufficient).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should wrap database errors in SystemHealthError for getWeeklySummary', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      await expect(service.getWeeklySummary(1)).rejects.toThrow(
        SystemHealthError,
      );
      await expect(service.getWeeklySummary(1)).rejects.toMatchObject({
        code: 4002,
      });
    });

    it('should wrap database errors in SystemHealthError for getDailySummary', async () => {
      (prisma.order.count as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Timeout'),
      );

      await expect(service.getDailySummary(1)).rejects.toThrow(
        SystemHealthError,
      );
    });

    it('should re-throw SystemHealthError without wrapping', async () => {
      const original = new SystemHealthError(
        4002,
        'Already wrapped',
        'error',
        'test',
      );
      (prisma.order.count as ReturnType<typeof vi.fn>).mockRejectedValue(
        original,
      );

      await expect(service.getWeeklySummary(1)).rejects.toBe(original);
    });
  });
});
