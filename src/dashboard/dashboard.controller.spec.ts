import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

describe('DashboardController', () => {
  let controller: DashboardController;
  let service: DashboardService;

  beforeEach(() => {
    service = {
      getOverview: vi.fn(),
      getHealth: vi.fn(),
      getPositions: vi.fn(),
      getAlerts: vi.fn(),
    } as unknown as DashboardService;
    controller = new DashboardController(service);
  });

  describe('GET /dashboard/overview', () => {
    it('should return overview wrapped in standard response', async () => {
      const overview = {
        systemHealth: 'healthy' as const,
        trailingPnl7d: '125.50',
        executionQualityRatio: 0.95,
        openPositionCount: 5,
        activeAlertCount: 1,
      };
      (service.getOverview as ReturnType<typeof vi.fn>).mockResolvedValue(
        overview,
      );

      const result = await controller.getOverview();

      expect(result.data).toEqual(overview);
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('GET /dashboard/health', () => {
    it('should return health array wrapped in standard response', async () => {
      const health = [
        {
          platformId: 'kalshi',
          status: 'healthy',
          apiConnected: true,
          dataFresh: true,
          lastUpdate: '2026-03-01T12:00:00Z',
          mode: 'live',
        },
      ];
      (service.getHealth as ReturnType<typeof vi.fn>).mockResolvedValue(health);

      const result = await controller.getHealth();

      expect(result.data).toEqual(health);
      expect(result.count).toBe(1);
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('GET /dashboard/positions', () => {
    it('should return positions with default mode=all', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await controller.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith(undefined);
      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should pass mode filter when specified', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await controller.getPositions('paper');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith('paper');
    });
  });

  describe('GET /dashboard/alerts', () => {
    it('should return alerts wrapped in standard response', async () => {
      const alerts = [
        {
          id: 'pos-1',
          type: 'single_leg_exposure',
          severity: 'critical',
          message: 'test',
          timestamp: '2026-03-01T12:00:00Z',
          acknowledged: false,
        },
      ];
      (service.getAlerts as ReturnType<typeof vi.fn>).mockResolvedValue(alerts);

      const result = await controller.getAlerts();

      expect(result.data).toEqual(alerts);
      expect(result.count).toBe(1);
    });
  });
});
