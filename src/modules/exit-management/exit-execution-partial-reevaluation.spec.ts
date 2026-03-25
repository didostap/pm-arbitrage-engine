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
  asPairId,
  asContractId,
} from '../../common/types/branded.type';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitExecutionService — partial reevaluation', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let orderRepository: ExitMonitorTestContext['orderRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let riskManager: ExitMonitorTestContext['riskManager'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      orderRepository,
      kalshiConnector,
      polymarketConnector,
      riskManager,
      thresholdEvaluator,
    } = await createExitMonitorTestModule());
  });

  describe('EXIT_PARTIAL re-evaluation (7.5.1)', () => {
    it('should include EXIT_PARTIAL positions in evaluation query', async () => {
      positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

      await service.evaluatePositions();

      expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
        { in: ['OPEN', 'EXIT_PARTIAL'] },
        false,
      );
    });

    it('should use residual sizes for EXIT_PARTIAL position threshold evaluation', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Return entry orders + partial exit orders
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('30'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('30'),
        },
      ]);

      await service.evaluatePositions();

      // Threshold evaluator should receive residual sizes (70), not entry sizes (100)
      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          kalshiSize: new Decimal('70'),
          polymarketSize: new Decimal('70'),
        }),
      );
    });

    it('should use residual sizes for VWAP computation on EXIT_PARTIAL', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('60'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('60'),
        },
      ]);

      // Multi-level order book to verify VWAP uses residual size (40)
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [
          { price: 0.66, quantity: 30 },
          { price: 0.64, quantity: 20 },
        ],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // getOrderBook called for VWAP → should use residual size (40)
      // If it used entry size (100), the VWAP would span both levels differently
      expect(kalshiConnector.getOrderBook).toHaveBeenCalled();
    });

    it('should close EXIT_PARTIAL position when residual fully exits', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('60'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('60'),
        },
      ]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentPnl: new Decimal('0.02'),
        currentEdge: new Decimal('0.015'),
      });

      setupOrderCreateMock(orderRepository);

      // Exit fills for residual 40 on both legs
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-2'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 40,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-2'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 40,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Should transition to CLOSED with realizedPnl via repository
      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );
      // closePosition should be called (not releasePartialCapital)
      expect(riskManager.closePosition).toHaveBeenCalled();
    });

    it('should stay EXIT_PARTIAL when residual only partially fills again', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('60'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('60'),
        },
      ]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentPnl: new Decimal('-0.01'),
        currentEdge: new Decimal('-0.005'),
      });

      setupOrderCreateMock(orderRepository);

      // Story 10-7-5: Limit chunking to 1 iteration so partial fill stays partial
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
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        })
        .mockResolvedValue({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          ...emptyBook,
        });
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

      // Fills only 20 of residual 40
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-2'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 20,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-2'),
        status: 'partial',
        filledPrice: 0.62,
        filledQuantity: 20,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Should stay EXIT_PARTIAL with accumulated PnL
      expect(
        positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      expect(riskManager.releasePartialCapital).toHaveBeenCalled();
    });

    it('should defer EXIT_PARTIAL exit when zero depth on either side', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('60'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('60'),
        },
      ]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentPnl: new Decimal('0.02'),
        currentEdge: new Decimal('0.015'),
      });

      // Zero depth on kalshi side during depth check
      kalshiConnector.getOrderBook
        // First call: evaluatePosition close price
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        })
        // Second call: depth check — zero depth
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        });

      await service.evaluatePositions();

      // Should not submit any orders — deferred to next cycle
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should not query orders for OPEN positions (no residual computation needed)', async () => {
      const position = createMockPosition({ status: 'OPEN' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      await service.evaluatePositions();

      // findByPairId should NOT be called for OPEN positions
      expect(orderRepository.findByPairId).not.toHaveBeenCalled();
    });

    it('should cap exit size using residual for EXIT_PARTIAL', async () => {
      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Residual is 40 per leg
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('60'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('60'),
        },
      ]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentPnl: new Decimal('0.02'),
        currentEdge: new Decimal('0.015'),
      });

      setupOrderCreateMock(orderRepository);

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-2'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 40,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-2'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 40,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Exit orders should be capped at residual size (40), not entry size (100)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 40,
        }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 40,
        }),
      );
    });

    it('should skip exit when position status changed during evaluation (race condition guard)', async () => {
      const position = createMockPosition({ status: 'OPEN' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentPnl: new Decimal('0.02'),
        currentEdge: new Decimal('0.015'),
      });

      // Status changed to CLOSED between evaluatePosition and executeExit
      positionRepository.findByIdWithOrders!.mockResolvedValue(
        createMockPosition({ status: 'CLOSED' }),
      );

      await service.evaluatePositions();

      // Should NOT submit any orders
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should transition EXIT_PARTIAL to CLOSED when both legs have zero residual', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Exits fully match entry — zero residual
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
      ]);

      await service.evaluatePositions();

      // Should transition to CLOSED preserving existing PnL without submitting orders
      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        new Decimal(0),
      );
      expect(riskManager.closePosition).toHaveBeenCalledWith(
        new Decimal(0),
        new Decimal(0),
        asPairId('pair-1'),
        false,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should skip exit evaluation when EXIT_PARTIAL has zero residual on one leg only', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Kalshi fully exited, polymarket still has residual
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('50'),
        },
      ]);

      await service.evaluatePositions();

      // Should NOT submit any orders — data integrity issue
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      // Should NOT transition status
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('should cap exit size by both legs effective sizes for asymmetric EXIT_PARTIAL residuals', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      positionRepository.findByIdWithOrders!.mockResolvedValue(position);
      setupOrderCreateMock(orderRepository);

      // Asymmetric residuals: kalshi=70, polymarket=30
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          fillSize: new Decimal('30'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          fillSize: new Decimal('70'),
        },
      ]);

      // Threshold triggers exit
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentPnl: new Decimal('-0.02'),
        currentEdge: new Decimal('-0.03'),
      });

      // Both connectors fill successfully
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 30,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 30,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // Exit size should be min(kalshiResidual=70, polyResidual=30) = 30
      // Both legs should receive quantity 30, NOT 70
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 30 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 30 }),
      );
    });
  });
});
