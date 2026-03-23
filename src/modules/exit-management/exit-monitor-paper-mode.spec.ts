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
} from '../../common/types/branded.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — paper mode', () => {
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

  describe('paper mode support', () => {
    function setPaperMode() {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
    }

    function setMixedMode() {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy' as const,
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'live',
      });
    }

    describe('evaluatePositions mode-aware query', () => {
      it('should pass isPaper=true to repository when in paper mode', async () => {
        setPaperMode();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          true,
        );
      });

      it('should pass isPaper=false to repository when in live mode', async () => {
        // Default mock health has no mode field (undefined = live)
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          false,
        );
      });

      it('should pass isPaper=true to repository when in mixed mode', async () => {
        setMixedMode();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([]);

        await service.evaluatePositions();

        expect(positionRepository.findByStatusWithOrders).toHaveBeenCalledWith(
          { in: ['OPEN', 'EXIT_PARTIAL'] },
          true,
        );
      });
    });

    describe('paper mode exit orders', () => {
      beforeEach(() => {
        setPaperMode();
        thresholdEvaluator.evaluate!.mockReturnValue({
          triggered: true,
          type: 'take_profit',
          currentEdge: new Decimal('0.025'),
          currentPnl: new Decimal('3.00'),
          capturedEdgePercent: new Decimal('100'),
        });
      });

      it('should set isPaper=true on both exit orders in paper mode', async () => {
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        // Both order creates should include isPaper: true
        const createCalls = orderRepository.create!.mock.calls;
        expect(createCalls).toHaveLength(2);
        expect(createCalls[0]![0]).toEqual(
          expect.objectContaining({ isPaper: true }),
        );
        expect(createCalls[1]![0]).toEqual(
          expect.objectContaining({ isPaper: true }),
        );
      });

      it('should NOT set isPaper on exit orders in live mode', async () => {
        // Reset to live mode (default mocks)
        kalshiConnector.getHealth.mockReturnValue({
          platformId: PlatformId.KALSHI,
          status: 'healthy' as const,
          lastHeartbeat: new Date(),
          latencyMs: 50,
        });
        polymarketConnector.getHealth.mockReturnValue({
          platformId: PlatformId.POLYMARKET,
          status: 'healthy' as const,
          lastHeartbeat: new Date(),
          latencyMs: 50,
        });

        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        const createCalls = orderRepository.create!.mock.calls;
        expect(createCalls).toHaveLength(2);
        expect(createCalls[0]![0]).toEqual(
          expect.objectContaining({ isPaper: false }),
        );
        expect(createCalls[1]![0]).toEqual(
          expect.objectContaining({ isPaper: false }),
        );
      });
    });

    describe('paper mode ExitTriggeredEvent flags', () => {
      beforeEach(() => {
        thresholdEvaluator.evaluate!.mockReturnValue({
          triggered: true,
          type: 'take_profit',
          currentEdge: new Decimal('0.025'),
          currentPnl: new Decimal('3.00'),
          capturedEdgePercent: new Decimal('100'),
        });
      });

      it('should emit ExitTriggeredEvent with isPaper=true, mixedMode=false in paper mode', async () => {
        setPaperMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.EXIT_TRIGGERED,
          expect.objectContaining({
            isPaper: true,
            mixedMode: false,
          }),
        );
      });

      it('should emit ExitTriggeredEvent with isPaper=true, mixedMode=true in mixed mode', async () => {
        setMixedMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.EXIT_TRIGGERED,
          expect.objectContaining({
            isPaper: true,
            mixedMode: true,
          }),
        );
      });

      it('should emit ExitTriggeredEvent with isPaper=false, mixedMode=false in live mode', async () => {
        // Default mocks = live mode
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.EXIT_TRIGGERED,
          expect.objectContaining({
            isPaper: false,
            mixedMode: false,
          }),
        );
      });
    });

    describe('paper mode SingleLegExposureEvent flags', () => {
      beforeEach(() => {
        thresholdEvaluator.evaluate!.mockReturnValue({
          triggered: true,
          type: 'stop_loss',
          currentEdge: new Decimal('-0.06'),
          currentPnl: new Decimal('-6.00'),
          capturedEdgePercent: new Decimal('-200'),
        });

        // Primary fills, secondary fails
        kalshiConnector.submitOrder.mockResolvedValue({
          orderId: asOrderId('kalshi-exit-1'),
          status: 'filled',
          filledPrice: 0.66,
          filledQuantity: 100,
          timestamp: new Date(),
        });
        polymarketConnector.submitOrder.mockRejectedValue(
          new Error('API timeout'),
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
      });

      it('should emit SingleLegExposureEvent with isPaper=true in paper mode', async () => {
        setPaperMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        await service.evaluatePositions();

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          expect.objectContaining({
            isPaper: true,
            mixedMode: false,
          }),
        );
      });

      it('should emit SingleLegExposureEvent with isPaper=true, mixedMode=true in mixed mode', async () => {
        setMixedMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        await service.evaluatePositions();

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          expect.objectContaining({
            isPaper: true,
            mixedMode: true,
          }),
        );
      });

      it('should emit SingleLegExposureEvent when secondary leg returns non-filled status in paper mode', async () => {
        setPaperMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        // Secondary returns 'rejected' instead of throwing
        polymarketConnector.submitOrder.mockResolvedValue({
          orderId: asOrderId('poly-exit-1'),
          status: 'rejected',
          filledPrice: 0,
          filledQuantity: 0,
          timestamp: new Date(),
        });

        await service.evaluatePositions();

        expect(positionRepository.updateStatus).toHaveBeenCalledWith(
          asPositionId('pos-1'),
          'EXIT_PARTIAL',
        );
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          expect.objectContaining({
            isPaper: true,
            mixedMode: false,
          }),
        );
      });
    });

    describe('paper mode cache cleanup on exit', () => {
      it('should call closePosition with pairId enabling cache cleanup', async () => {
        setPaperMode();
        const position = createMockPosition();
        positionRepository.findByStatusWithOrders!.mockResolvedValue([
          position,
        ]);

        thresholdEvaluator.evaluate!.mockReturnValue({
          triggered: true,
          type: 'take_profit',
          currentEdge: new Decimal('0.025'),
          currentPnl: new Decimal('3.00'),
          capturedEdgePercent: new Decimal('100'),
        });

        setupOrderCreateMock(orderRepository);

        await service.evaluatePositions();

        // closePosition called with pairId and isPaper
        expect(riskManager.closePosition).toHaveBeenCalledWith(
          expect.any(Decimal),
          expect.any(Decimal),
          asPairId('pair-1'),
          true,
        );
      });
    });
  });
});
