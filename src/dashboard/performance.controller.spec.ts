import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import type {
  WeeklySummaryDto,
  DailyPerformanceDto,
  PerformanceTrendsDto,
} from './dto/performance.dto';

const sampleWeek: WeeklySummaryDto = {
  weekStart: '2026-03-02T00:00:00.000Z',
  weekEnd: '2026-03-09T00:00:00.000Z',
  totalTrades: 10,
  closedPositions: 3,
  pnl: '0.05',
  hitRate: 0.67,
  averageSlippage: '0.002',
  opportunitiesDetected: 12,
  opportunitiesFiltered: 2,
  opportunitiesExecuted: 10,
  manualInterventions: 1,
  autonomyRatio: '10',
};

const sampleDay: DailyPerformanceDto = {
  date: '2026-03-04',
  totalTrades: 5,
  closedPositions: 1,
  pnl: '0.02',
  hitRate: 1.0,
  averageSlippage: '0.001',
  opportunitiesDetected: 6,
  opportunitiesFiltered: 1,
  opportunitiesExecuted: 5,
  manualInterventions: 0,
  autonomyRatio: '5',
};

const sampleTrends: PerformanceTrendsDto = {
  rollingAverages: {
    opportunityFrequency: 12,
    edgeCaptured: '0.04',
    slippage: '0.002',
  },
  opportunityBelowBaseline: false,
  edgeTrend: 'stable',
  latestWeekSummary: sampleWeek,
};

describe('PerformanceController', () => {
  let controller: PerformanceController;
  let service: {
    getWeeklySummary: ReturnType<typeof vi.fn>;
    getDailySummary: ReturnType<typeof vi.fn>;
    getRollingAverages: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      getWeeklySummary: vi.fn(),
      getDailySummary: vi.fn(),
      getRollingAverages: vi.fn(),
    };
    controller = new PerformanceController(
      service as unknown as PerformanceService,
    );
  });

  describe('GET /performance/weekly', () => {
    it('should return weekly summaries with default 8 weeks', async () => {
      const weeks = [sampleWeek];
      service.getWeeklySummary.mockResolvedValue(weeks);

      const result = await controller.getWeekly({ weeks: 8 });

      expect(result.data).toEqual(weeks);
      expect(result.count).toBe(1);
      expect(result.timestamp).toBeDefined();
      expect(service.getWeeklySummary).toHaveBeenCalledWith(8, undefined);
    });

    it('should pass weeks=4 to service', async () => {
      service.getWeeklySummary.mockResolvedValue([]);

      await controller.getWeekly({ weeks: 4 });
      expect(service.getWeeklySummary).toHaveBeenCalledWith(4, undefined);
    });

    it('should pass mode=paper to service', async () => {
      service.getWeeklySummary.mockResolvedValue([]);

      await controller.getWeekly({ weeks: 8, mode: 'paper' as const });
      expect(service.getWeeklySummary).toHaveBeenCalledWith(8, 'paper');
    });

    it('should use default weeks=8 when weeks is undefined', async () => {
      service.getWeeklySummary.mockResolvedValue([]);

      await controller.getWeekly({});
      expect(service.getWeeklySummary).toHaveBeenCalledWith(8, undefined);
    });
  });

  describe('GET /performance/daily', () => {
    it('should return daily summaries with default 30 days', async () => {
      const days = [sampleDay];
      service.getDailySummary.mockResolvedValue(days);

      const result = await controller.getDaily({ days: 30 });

      expect(result.data).toEqual(days);
      expect(result.count).toBe(1);
      expect(result.timestamp).toBeDefined();
      expect(service.getDailySummary).toHaveBeenCalledWith(30, undefined);
    });

    it('should pass days=7 to service', async () => {
      service.getDailySummary.mockResolvedValue([]);

      await controller.getDaily({ days: 7 });
      expect(service.getDailySummary).toHaveBeenCalledWith(7, undefined);
    });
  });

  describe('GET /performance/trends', () => {
    it('should return trends with rolling averages', async () => {
      service.getRollingAverages.mockResolvedValue(sampleTrends);

      const result = await controller.getTrends({});

      expect(result.data).toEqual(sampleTrends);
      expect(result.timestamp).toBeDefined();
      expect(service.getRollingAverages).toHaveBeenCalledWith(undefined);
    });

    it('should pass mode=live to service', async () => {
      service.getRollingAverages.mockResolvedValue(sampleTrends);

      await controller.getTrends({ mode: 'live' as const });
      expect(service.getRollingAverages).toHaveBeenCalledWith('live');
    });
  });

  describe('decorators', () => {
    it('should have AuthTokenGuard applied', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        PerformanceController,
      ) as unknown[];
      expect(guards).toBeDefined();
      expect(guards.length).toBeGreaterThan(0);
    });

    it('should have Swagger ApiTags decorator', () => {
      const tags = Reflect.getMetadata(
        'swagger/apiUseTags',
        PerformanceController,
      ) as string[];
      expect(tags).toContain('Performance');
    });
  });
});
