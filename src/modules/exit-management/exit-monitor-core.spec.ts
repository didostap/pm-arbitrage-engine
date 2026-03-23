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
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — core', () => {
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

  describe('evaluatePositions', () => {
    it('should do nothing when no open positions exist', async () => {
      positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should skip evaluation when connector is disconnected', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({ status: 'disconnected' });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).not.toHaveBeenCalled();
    });

    it('should evaluate and not exit when no threshold triggered', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalled();
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should skip evaluation when position is missing side data', async () => {
      const position = createMockPosition({
        kalshiSide: null,
        polymarketSide: null,
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).not.toHaveBeenCalled();
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should skip evaluation when order fill data is missing', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: asOrderId('order-kalshi-1'),
          platform: 'KALSHI',
          side: 'buy',
          price: new Decimal('0.62'),
          size: new Decimal('100'),
          fillPrice: null,
          fillSize: null,
          status: 'PENDING',
        },
      });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).not.toHaveBeenCalled();
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should handle empty order book gracefully', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      // kalshi buy side → close by selling → need bids
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
        bids: [], // Empty
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).not.toHaveBeenCalled();
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });
  });

  describe('happy path exit', () => {
    it('should close position when threshold triggers and both legs fill', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });

      setupOrderCreateMock(orderRepository);

      await service.evaluatePositions();

      // Both connectors should have submitted orders
      expect(kalshiConnector.submitOrder).toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).toHaveBeenCalled();

      // Position should be marked CLOSED
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'CLOSED',
      );

      // Risk manager should release budget
      expect(riskManager.closePosition).toHaveBeenCalled();

      // ExitTriggeredEvent should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXIT_TRIGGERED,
        expect.objectContaining({
          positionId: asPositionId('pos-1'),
          pairId: asPairId('pair-1'),
          exitType: 'take_profit',
        }),
      );
    });
  });

  describe('partial exit', () => {
    it('should transition to EXIT_PARTIAL when second leg fails', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentEdge: new Decimal('-0.06'),
        currentPnl: new Decimal('-6.00'),
        capturedEdgePercent: new Decimal('-200'),
      });

      // Primary (kalshi) fills, secondary (polymarket) fails
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Polymarket API timeout'),
      );

      orderRepository.create!.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-order-1'),
        platform: 'KALSHI',
        price: new Decimal('0.66'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.66'),
        fillSize: new Decimal('100'),
      });
      orderRepository.findById!.mockResolvedValue({
        orderId: asOrderId('kalshi-exit-order-1'),
        platform: 'KALSHI',
        price: new Decimal('0.66'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.66'),
        fillSize: new Decimal('100'),
      });

      await service.evaluatePositions();

      // Position should be EXIT_PARTIAL
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
      );

      // SingleLegExposureEvent should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.objectContaining({
          positionId: asPositionId('pos-1'),
        }),
      );

      // Verify attemptedPrice/attemptedSize are not zero (actual values passed)
      const emitCall = eventEmitter.emit!.mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      ) as
        | [
            string,
            { failedLeg: { attemptedPrice: number; attemptedSize: number } },
          ]
        | undefined;
      expect(emitCall).toBeDefined();
      expect(emitCall![1].failedLeg.attemptedPrice).toBeGreaterThan(0);
      expect(emitCall![1].failedLeg.attemptedSize).toBeGreaterThan(0);

      // ExitTriggeredEvent should NOT be emitted
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.EXIT_TRIGGERED,
        expect.anything(),
      );
    });
  });

  describe('first leg failure', () => {
    it('should keep position OPEN when first exit leg fails', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'time_based',
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('17'),
      });

      // Primary (kalshi) fails
      kalshiConnector.submitOrder.mockRejectedValue(
        new Error('Connection reset'),
      );

      await service.evaluatePositions();

      // Position stays OPEN
      expect(positionRepository.updateStatus).not.toHaveBeenCalled();
      // No events emitted
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('should continue evaluating other positions when one fails', async () => {
      const pos1 = createMockPosition({ positionId: asPositionId('pos-1') });
      const pos2 = createMockPosition({ positionId: asPositionId('pos-2') });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([
        pos1,
        pos2,
      ]);

      // First position: connector throws on order book
      kalshiConnector.getOrderBook
        .mockRejectedValueOnce(new Error('First call fails'))
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: asContractId('kalshi-contract-1'),
          bids: [{ price: 0.66, quantity: 500 }],
          asks: [{ price: 0.68, quantity: 500 }],
          timestamp: new Date(),
        });

      await service.evaluatePositions();

      // Second position should still be evaluated
      expect(thresholdEvaluator.evaluate).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker', () => {
    it('should skip next cycle after 3 consecutive full failures', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      // Make all evaluations fail
      kalshiConnector.getOrderBook.mockRejectedValue(new Error('Always fails'));

      // 3 consecutive full failures
      await service.evaluatePositions();
      await service.evaluatePositions();
      await service.evaluatePositions();

      // 4th call should be skipped (circuit breaker)
      await service.evaluatePositions();

      // After skip, counter resets — 5th call should evaluate again
      await service.evaluatePositions();

      // getOrderBook should have been called on cycles 1,2,3 and 5 (not 4)
      expect(kalshiConnector.getOrderBook).toHaveBeenCalledTimes(4);
    });
  });
});
