import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SystemHealthError } from '../common/errors/system-health-error';

describe('DashboardController', () => {
  let controller: DashboardController;
  let service: DashboardService;

  beforeEach(() => {
    service = {
      getOverview: vi.fn(),
      getHealth: vi.fn(),
      getPositions: vi.fn(),
      getPositionById: vi.fn(),
      getPositionDetails: vi.fn(),
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
    it('should return positions with default mode=all and pagination', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        count: 0,
      });

      const result = await controller.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith(
        undefined,
        1,
        50,
        undefined,
      );
      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('should pass mode filter and pagination when specified', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        count: 0,
      });

      await controller.getPositions('paper', '2', '25');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith(
        'paper',
        2,
        25,
        undefined,
      );
    });

    it('should convert mode=all to undefined', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        count: 0,
      });

      await controller.getPositions('all');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith(
        undefined,
        1,
        50,
        undefined,
      );
    });

    it('should pass status filter to service', async () => {
      (service.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        count: 0,
      });

      await controller.getPositions(undefined, undefined, undefined, 'CLOSED');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(service.getPositions).toHaveBeenCalledWith(
        undefined,
        1,
        50,
        'CLOSED',
      );
    });
  });

  describe('GET /dashboard/positions/:id', () => {
    it('should return single enriched position', async () => {
      const position = {
        id: 'pos-1',
        pairName: 'BTC-100K',
        currentEdge: '0.08',
      };
      (service.getPositionById as ReturnType<typeof vi.fn>).mockResolvedValue(
        position,
      );

      const result = await controller.getPositionById('pos-1');
      expect(result.data).toEqual(position);
      expect(result.timestamp).toBeDefined();
    });

    it('should throw 404 when position not found', async () => {
      (service.getPositionById as ReturnType<typeof vi.fn>).mockResolvedValue(
        null,
      );

      await expect(controller.getPositionById('nonexistent')).rejects.toThrow(
        SystemHealthError,
      );
    });
  });

  describe('GET /dashboard/positions/:id/details', () => {
    it('should return full position detail', async () => {
      const detail = {
        id: 'pos-1',
        pairName: 'Test Pair',
        status: 'OPEN',
        orders: [],
        auditEvents: [],
      };
      (
        service.getPositionDetails as ReturnType<typeof vi.fn>
      ).mockResolvedValue(detail);

      const result = await controller.getPositionDetails('pos-1');
      expect(result.data).toEqual(detail);
      expect(result.timestamp).toBeDefined();
    });

    it('should throw 404 when position not found', async () => {
      (
        service.getPositionDetails as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      await expect(
        controller.getPositionDetails('nonexistent'),
      ).rejects.toThrow(SystemHealthError);
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
