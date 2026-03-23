import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { asContractId } from '../../common/types/branded.type';
import { PlatformId } from '../../common/types/platform.type';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — pricing', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      kalshiConnector,
      polymarketConnector,
      thresholdEvaluator,
    } = await createExitMonitorTestModule());
  });

  describe('getClosePrice', () => {
    it('should return best bid when original side is buy (selling to close)', async () => {
      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toEqual(new Decimal(0.66));
    });

    it('should return best ask when original side is sell (buying to close)', async () => {
      const price = await service.getClosePrice(
        polymarketConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'sell',
      );
      expect(price).toEqual(new Decimal(0.64));
    });

    it('should return null when order book is empty on relevant side', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toBeNull();
    });
  });

  describe('entry close price forwarding (6.5.5i)', () => {
    it('should forward entry close prices and fee rates to threshold evaluator', async () => {
      const position = createMockPosition({
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.015'),
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({ status: 'connected' });
      polymarketConnector.getHealth.mockReturnValue({ status: 'connected' });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          entryClosePriceKalshi: expect.any(Decimal) as unknown,
          entryClosePricePolymarket: expect.any(Decimal) as unknown,
          entryKalshiFeeRate: expect.any(Decimal) as unknown,
          entryPolymarketFeeRate: expect.any(Decimal) as unknown,
        }),
      );

      const evalInput = thresholdEvaluator.evaluate.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect((evalInput.entryClosePriceKalshi as Decimal).toString()).toBe(
        '0.6',
      );
      expect((evalInput.entryClosePricePolymarket as Decimal).toString()).toBe(
        '0.67',
      );
      expect((evalInput.entryKalshiFeeRate as Decimal).toString()).toBe('0.02');
      expect((evalInput.entryPolymarketFeeRate as Decimal).toString()).toBe(
        '0.015',
      );
    });

    it('should forward null values for legacy positions', async () => {
      const position = createMockPosition({
        entryClosePriceKalshi: null,
        entryClosePricePolymarket: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({ status: 'connected' });
      polymarketConnector.getHealth.mockReturnValue({ status: 'connected' });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          entryClosePriceKalshi: null,
          entryClosePricePolymarket: null,
          entryKalshiFeeRate: null,
          entryPolymarketFeeRate: null,
        }),
      );
    });
  });

  describe('VWAP-aware close pricing (6.5.5k)', () => {
    it('should return top-of-book when no positionSize provided (backward compat)', async () => {
      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
      );
      expect(price).toEqual(new Decimal(0.66));
    });

    it('should return VWAP across multiple levels for buy side close', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [
          { price: 0.66, quantity: 60 },
          { price: 0.64, quantity: 40 },
        ],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
        new Decimal(100),
      );

      // VWAP: (60 * 0.66 + 40 * 0.64) / 100 = (39.6 + 25.6) / 100 = 0.652
      expect(price!.toNumber()).toBeCloseTo(0.652, 6);
    });

    it('should return VWAP of available depth when book cannot fill full position', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [{ price: 0.66, quantity: 50 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
        new Decimal(200),
      );

      // Only 50 available: VWAP = 0.66 (single level)
      expect(price!.toNumber()).toBeCloseTo(0.66, 6);
    });

    it('should return null when book has no levels on close side', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('contract-1'),
        bids: [],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'buy',
        new Decimal(100),
      );

      expect(price).toBeNull();
    });

    it('should compute VWAP for sell side close (using asks)', async () => {
      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('contract-1'),
        bids: [{ price: 0.6, quantity: 500 }],
        asks: [
          { price: 0.64, quantity: 30 },
          { price: 0.66, quantity: 70 },
        ],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        polymarketConnector as unknown as IPlatformConnector,
        asContractId('contract-1'),
        'sell',
        new Decimal(100),
      );

      // VWAP: (30 * 0.64 + 70 * 0.66) / 100 = (19.2 + 46.2) / 100 = 0.654
      expect(price!.toNumber()).toBeCloseTo(0.654, 6);
    });
  });
});
