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
  let prisma: ExitMonitorTestContext['prisma'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      orderRepository,
      kalshiConnector,
      polymarketConnector,
      thresholdEvaluator,
      prisma,
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
      // Story 10-7-5: 3rd+ call returns 0 depth to limit chunking to 1 iteration
      const emptyBook = { bids: [], asks: [], timestamp: new Date() };
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
        })
        .mockResolvedValue({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          ...emptyBook,
        });

      // Polymarket: plenty of depth for first chunk, then 0
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.64, quantity: 500 }],
          asks: [{ price: 0.64, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          bids: [{ price: 0.64, quantity: 500 }],
          asks: [{ price: 0.64, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValue({
          platformId: PlatformId.POLYMARKET,
          contractId: asContractId('poly-contract-1'),
          ...emptyBook,
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

      // 80 < 200 entry → EXIT_PARTIAL with accumulated PnL
      expect(
        positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
    });

    it('should defer exit when depth fetch fails (D2)', async () => {
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

      // D2: Should NOT submit orders — exit deferred to next cycle
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      // Position stays unchanged (no status update)
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
      expect(positionRepository.closePosition).not.toHaveBeenCalled();
    });
  });

  describe('tolerance band integration (10-7-3)', () => {
    beforeEach(() => {
      setupOrderCreateMock(orderRepository);
      // Enable model exit mode so depth is fetched for C5 evaluation
      service.reloadConfig({ exitMode: 'model' });
      // Mock contractMatch lookup needed in model mode
      (prisma as Record<string, unknown>)['contractMatch'] = {
        findUnique: vi.fn().mockResolvedValue({ confidenceScore: 0.85 }),
      };
    });

    it('C5 does NOT trigger when sufficient depth exists within tolerance band', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Order book: strict cutoff would give depth=1, but with 2% tolerance → depth=11
      // VWAP for buy-close of kalshi (sell to close = bids):
      // Book bids: [0.66×1, 0.645×10] → VWAP for 100 contracts walks through these
      // The close price is computed internally by getClosePrice()
      // For getAvailableExitDepth (sell-close, bids): bids at 0.66 and 0.645
      // With 2% tolerance: cutoff = closePrice × 0.98
      // We need enough depth within band for C5 to be satisfied

      // Kalshi book (buy side → sell to close → consume bids)
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [
          { price: 0.66, quantity: 5 },
          { price: 0.645, quantity: 10 },
        ],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      // Polymarket book (sell side → buy to close → consume asks)
      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [
          { price: 0.64, quantity: 5 },
          { price: 0.65, quantity: 10 },
        ],
        timestamp: new Date(),
      });

      // Mock evaluator: return NOT triggered (sufficient depth should mean no C5 issue)
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: false,
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('16.7'),
      });

      await service.evaluatePositions();

      // Evaluator called with depth values (tolerance-expanded, should be > exitMinDepth=5)
      const evalCall = thresholdEvaluator.evaluate!.mock.calls[0]?.[0] as {
        kalshiExitDepth: Decimal | null;
        polymarketExitDepth: Decimal | null;
      };
      expect(evalCall).toBeDefined();
      // Both depths should be non-null and > 0 (tolerance band included levels)
      expect(evalCall.kalshiExitDepth).toBeDefined();
      expect(evalCall.polymarketExitDepth).toBeDefined();
      expect(evalCall.kalshiExitDepth!.gte(5)).toBe(true);
      expect(evalCall.polymarketExitDepth!.gte(5)).toBe(true);

      // No exit submitted since evaluator said not triggered
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('C5 still triggers when depth is insufficient even with tolerance band', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Very thin book — even with 2% tolerance, total depth is only 2
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [{ price: 0.66, quantity: 2 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.64, quantity: 2 }],
        timestamp: new Date(),
      });

      // Mock evaluator: returns triggered (C5 fires due to insufficient depth)
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'liquidity_deterioration',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 2,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.64,
        filledQuantity: 2,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Evaluator called with low depth values
      const evalCall = thresholdEvaluator.evaluate!.mock.calls[0]?.[0] as {
        kalshiExitDepth: Decimal | null;
      };
      expect(evalCall).toBeDefined();
      expect(evalCall.kalshiExitDepth!.lte(5)).toBe(true);

      // Exit was triggered and orders submitted
      expect(kalshiConnector.submitOrder).toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).toHaveBeenCalled();
    });
  });
});
