import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  setupOrderCreateMock,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import {
  asPositionId,
  asOrderId,
  asContractId,
} from '../../common/types/branded.type';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — depth check', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let orderRepository: ExitMonitorTestContext['orderRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      orderRepository,
      kalshiConnector,
      polymarketConnector,
      thresholdEvaluator,
    } = await createExitMonitorTestModule());
  });

  describe('pre-exit depth check (6.5.5k)', () => {
    beforeEach(() => {
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });
      setupOrderCreateMock(orderRepository);
    });

    it('should defer exit when primary side has zero depth', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // After threshold evaluation fetch, return empty bids for kalshi (buy side close = sell = use bids)
      // First call: evaluatePosition's getClosePrice (has data)
      // Second call: executeExit's depth check (empty)
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        });

      await service.evaluatePositions();

      // No orders submitted — exit deferred
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      // Position stays OPEN
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('should defer exit when secondary side has zero depth', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Polymarket: sell side, close = buy = use asks
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.62, quantity: 500 }],
          asks: [{ price: 0.64, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.62, quantity: 500 }],
          asks: [],
          timestamp: new Date(),
        });

      await service.evaluatePositions();

      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('should cap exit sizes to available depth and equalize across legs', async () => {
      // Entry: 200 contracts
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('200'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('200'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('200'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('200'),
          status: 'FILLED',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Depth check: kalshi bids only 80 contracts at close price or better
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 80 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        });

      // Polymarket: plenty of depth
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.62, quantity: 500 }],
          asks: [{ price: 0.64, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.62, quantity: 500 }],
          asks: [{ price: 0.64, quantity: 500 }],
          timestamp: new Date(),
        });

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 80,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 80,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Both legs should submit 80 (min of 80, 500, 200)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 80 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 80 }),
      );

      // 80 < 200 entry → EXIT_PARTIAL
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
      );
    });

    it('should fall back to entry fill size when depth fetch fails', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // First call: evaluatePosition's getClosePrice — succeeds
      // Second call: executeExit's depth check — throws
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockRejectedValueOnce(new Error('Network timeout'));

      await service.evaluatePositions();

      // Should still submit orders (fall back to entry fill size)
      expect(kalshiConnector.submitOrder).toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).toHaveBeenCalled();
    });
  });
});
