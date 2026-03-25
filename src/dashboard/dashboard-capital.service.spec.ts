import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardCapitalService } from './dashboard-capital.service';
import type { IRiskManager } from '../common/interfaces/risk-manager.interface';
import { EVENT_NAMES } from '../common/events/event-catalog';

function createMockRiskManager() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: null,
      updatedAt: new Date().toISOString(),
    }),
    reloadBankroll: vi.fn().mockResolvedValue(undefined),
  } as unknown as IRiskManager;
}

function createMockEventEmitter() {
  return {
    emit: vi.fn(),
  };
}

function createMockEngineConfigRepository() {
  return {
    upsertBankroll: vi.fn().mockResolvedValue({
      id: 'cfg-1',
      singletonKey: 'default',
      bankrollUsd: { toString: () => '15000' },
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };
}

function createMockAuditLogService() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DashboardCapitalService', () => {
  let service: DashboardCapitalService;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let engineConfigRepo: ReturnType<typeof createMockEngineConfigRepository>;
  let auditLogService: ReturnType<typeof createMockAuditLogService>;

  beforeEach(() => {
    riskManager = createMockRiskManager();
    eventEmitter = createMockEventEmitter();
    engineConfigRepo = createMockEngineConfigRepository();
    auditLogService = createMockAuditLogService();

    service = new DashboardCapitalService(
      riskManager,
      eventEmitter as any,
      engineConfigRepo as any,
      auditLogService as any,
    );
  });

  describe('computeCapitalBreakdown', () => {
    it('should compute entry capital, fees, and PnL from orders', () => {
      const position = {
        kalshiOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryKalshiFeeRate: new Decimal('0.07'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      };

      const allOrders = [
        {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'order-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'exit-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'exit-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
        },
      ];

      const result = service.computeCapitalBreakdown(position, allOrders);

      expect(result.entryCapitalKalshi).not.toBeNull();
      expect(result.entryCapitalPolymarket).not.toBeNull();
      expect(result.feesKalshi).not.toBeNull();
      expect(result.feesPolymarket).not.toBeNull();
      expect(result.grossPnl).not.toBeNull();
      expect(result.netPnl).not.toBeNull();
    });

    it('should return null fields when entry orders have no fill data', () => {
      const position = {
        kalshiOrder: { fillPrice: null, fillSize: null },
        polymarketOrder: { fillPrice: null, fillSize: null },
        kalshiOrderId: null,
        polymarketOrderId: null,
        kalshiSide: null,
        polymarketSide: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      };

      const result = service.computeCapitalBreakdown(position, []);

      expect(result.entryCapitalKalshi).toBeNull();
      expect(result.entryCapitalPolymarket).toBeNull();
      expect(result.grossPnl).toBeNull();
      expect(result.netPnl).toBeNull();
    });

    it('should return null grossPnl/netPnl when no exit orders exist', () => {
      const position = {
        kalshiOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryKalshiFeeRate: new Decimal('0.07'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      };

      const allOrders = [
        {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'order-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
      ];

      const result = service.computeCapitalBreakdown(position, allOrders);
      expect(result.entryCapitalKalshi).not.toBeNull();
      expect(result.grossPnl).toBeNull();
      expect(result.netPnl).toBeNull();
    });
  });

  describe('computeModeCapital', () => {
    it('should compute bankroll, deployed, available, reserved', () => {
      const result = service.computeModeCapital('10000', {
        totalCapitalDeployed: new Decimal('500'),
        reservedCapital: new Decimal('100'),
      });

      expect(result.bankroll).toBe('10000');
      expect(result.deployed).toBe('500');
      expect(result.reserved).toBe('100');
      expect(result.available).toBe('9400');
    });

    it('should floor available at zero when over-deployed', () => {
      const result = service.computeModeCapital('10000', {
        totalCapitalDeployed: new Decimal('9000'),
        reservedCapital: new Decimal('2000'),
      });

      expect(result.available).toBe('0');
    });

    it('should handle null risk state', () => {
      const result = service.computeModeCapital('10000', null);

      expect(result.deployed).toBe('0');
      expect(result.reserved).toBe('0');
      expect(result.available).toBe('10000');
    });
  });

  describe('computeRealizedPnl', () => {
    it('should compute realized PnL from entry and exit orders', () => {
      const position = {
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        entryKalshiFeeRate: new Decimal('0.07'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      };

      const allPairOrders = [
        {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'order-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'exit-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'exit-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
        },
      ];

      const result = service.computeRealizedPnl(position, allPairOrders);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });

    it('should return null when no exit orders', () => {
      const position = {
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      };

      const result = service.computeRealizedPnl(position, [
        {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
        },
        {
          orderId: 'order-p-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
        },
      ]);
      expect(result).toBeNull();
    });

    it('should return null when entry fill data missing', () => {
      const position = {
        kalshiOrderId: null,
        polymarketOrderId: null,
        kalshiSide: null,
        polymarketSide: null,
        kalshiOrder: { fillPrice: null, fillSize: null },
        polymarketOrder: { fillPrice: null, fillSize: null },
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      };

      const result = service.computeRealizedPnl(position, []);
      expect(result).toBeNull();
    });
  });

  describe('computeTimeHeld', () => {
    it('should format time held as "Xd Xh Xm"', () => {
      const start = new Date('2026-03-01T10:00:00Z');
      const end = new Date('2026-03-03T15:30:00Z');
      expect(service.computeTimeHeld(start, end)).toBe('2d 5h 30m');
    });

    it('should return "0m" for zero duration', () => {
      const date = new Date('2026-03-01T10:00:00Z');
      expect(service.computeTimeHeld(date, date)).toBe('0m');
    });

    it('should omit zero days and hours', () => {
      const start = new Date('2026-03-01T10:00:00Z');
      const end = new Date('2026-03-01T10:45:00Z');
      expect(service.computeTimeHeld(start, end)).toBe('45m');
    });
  });

  describe('getBankrollConfig', () => {
    it('should delegate to riskManager.getBankrollConfig()', async () => {
      const result = await service.getBankrollConfig();
      expect(result).toEqual(expect.objectContaining({ bankrollUsd: '10000' }));
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(riskManager.getBankrollConfig).toHaveBeenCalled();
    });
  });

  describe('updateBankroll', () => {
    it('should upsert to DB, reload risk manager, and emit event', async () => {
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '10000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          bankrollUsd: '15000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        });

      await service.updateBankroll('15000');

      expect(engineConfigRepo.upsertBankroll).toHaveBeenCalledWith('15000');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(riskManager.reloadBankroll).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
        expect.objectContaining({
          previousValue: '10000',
          newValue: '15000',
        }),
      );
    });

    it('should emit event with correct previous and new values', async () => {
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '5000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          bankrollUsd: '8000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        });

      await service.updateBankroll('8000');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
        expect.objectContaining({
          previousValue: '5000',
          newValue: '8000',
          updatedBy: 'dashboard',
        }),
      );
    });

    it('should create audit log entry for bankroll update', async () => {
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '10000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          bankrollUsd: '15000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        });

      await service.updateBankroll('15000');

      expect(auditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
          module: 'dashboard',
          details: expect.objectContaining({
            previousValue: '10000',
            newValue: '15000',
            updatedBy: 'dashboard',
          }),
        }),
      );
    });

    it('should not throw when audit log fails', async () => {
      auditLogService.append.mockRejectedValue(new Error('audit failure'));
      (riskManager.getBankrollConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          bankrollUsd: '10000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        })
        .mockResolvedValueOnce({
          bankrollUsd: '15000',
          paperBankrollUsd: null,
          updatedAt: new Date().toISOString(),
        });

      const result = await service.updateBankroll('15000');
      expect(result).toEqual(expect.objectContaining({ bankrollUsd: '15000' }));
    });
  });
});
