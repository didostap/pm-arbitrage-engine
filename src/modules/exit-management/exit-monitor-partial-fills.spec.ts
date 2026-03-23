import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  setupOrderCreateMock,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { asPositionId, asOrderId } from '../../common/types/branded.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — partial fills', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let orderRepository: ExitMonitorTestContext['orderRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let riskManager: ExitMonitorTestContext['riskManager'];
  let eventEmitter: ExitMonitorTestContext['eventEmitter'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      orderRepository,
      kalshiConnector,
      polymarketConnector,
      riskManager,
      eventEmitter,
      thresholdEvaluator,
    } = await createExitMonitorTestModule());
  });

  describe('partial fill handling (6.5.5k)', () => {
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

    it('should use exit fill sizes for P&L calculation, not entry fill sizes', async () => {
      // Entry: 400 contracts at 0.62 / 0.65
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Exit fills only 300 of 400 on both legs
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 300,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 300,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      // P&L should be on 300, not 400
      // Kalshi: buy side, (0.66 - 0.62) * 300 = 12
      // Polymarket: sell side, (0.65 - 0.62) * 300 = 9
      // Total before fees: 21
      // Exit fees computed on exit fill sizes (300 each)
      const closeCall =
        riskManager.closePosition.mock.calls[0] ??
        riskManager.releasePartialCapital.mock.calls[0];
      expect(closeCall).toBeDefined();
      const pnlArg = closeCall![1] as Decimal;
      // With 300 contracts, P&L should be roughly 21 minus fees
      // NOT 28 (which would be 400 * 0.04 + 400 * 0.03)
      expect(pnlArg.toNumber()).toBeLessThan(22);
      expect(pnlArg.toNumber()).toBeGreaterThan(15);
    });

    it('should transition to EXIT_PARTIAL when exit fills less than entry', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Both legs only fill 300 of 400
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 300,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'partial',
        filledPrice: 0.62,
        filledQuantity: 300,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
      );
    });

    it('should call releasePartialCapital (not closePosition) on partial fills', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 300,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 300,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(riskManager.releasePartialCapital).toHaveBeenCalled();
      expect(riskManager.closePosition).not.toHaveBeenCalled();
    });

    it('should emit SingleLegExposureEvent with remainder details on partial fills', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
        polymarketOrder: {
          orderId: asOrderId('order-poly-1'),
          platform: 'POLYMARKET',
          side: 'sell',
          price: new Decimal('0.65'),
          size: new Decimal('400'),
          fillPrice: new Decimal('0.65'),
          fillSize: new Decimal('400'),
          status: 'FILLED',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 300,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 300,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.objectContaining({
          positionId: asPositionId('pos-1'),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          filledLeg: expect.objectContaining({
            price: expect.any(Number) as number,
            size: expect.any(Number) as number,
            fillPrice: 0.66,
            fillSize: 300,
          }),
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          failedLeg: expect.objectContaining({
            reason: 'Partial exit — remainder contracts unexited',
            reasonCode: 2008,
          }),
          recommendedActions: expect.arrayContaining([
            expect.stringContaining('retry-leg') as string,
            expect.stringContaining('close-leg') as string,
          ]) as string[],
        }),
      );
      // filledLeg.price must be a valid probability (0-1), NOT a quantity
      const singleLegCall = eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const filledLegPrice = singleLegCall![1].filledLeg.price as number;
      expect(filledLegPrice).toBeGreaterThan(0);
      expect(filledLegPrice).toBeLessThanOrEqual(1);
    });

    it('should transition to CLOSED when exit fills equal entry fills', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Full fill (100 = 100)
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'CLOSED',
      );
      expect(riskManager.closePosition).toHaveBeenCalled();
    });

    it('should handle partial primary, full secondary as EXIT_PARTIAL', async () => {
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

      // Primary fills 150, secondary fills 200
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 150,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 200,
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
      );
      expect(riskManager.releasePartialCapital).toHaveBeenCalled();
    });
  });
});
