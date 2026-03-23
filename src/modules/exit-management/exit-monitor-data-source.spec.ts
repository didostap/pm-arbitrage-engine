import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  createExitMonitorTestModule,
  createMockPosition,
  type ExitMonitorTestContext,
} from './exit-monitor.test-helpers';
import { asPositionId } from '../../common/types/branded.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

describe('ExitMonitorService — data source', () => {
  let service: ExitMonitorTestContext['service'];
  let positionRepository: ExitMonitorTestContext['positionRepository'];
  let kalshiConnector: ExitMonitorTestContext['kalshiConnector'];
  let polymarketConnector: ExitMonitorTestContext['polymarketConnector'];
  let eventEmitter: ExitMonitorTestContext['eventEmitter'];
  let thresholdEvaluator: ExitMonitorTestContext['thresholdEvaluator'];
  let prisma: ExitMonitorTestContext['prisma'];

  beforeEach(async () => {
    ({
      service,
      positionRepository,
      kalshiConnector,
      polymarketConnector,
      eventEmitter,
      thresholdEvaluator,
      prisma,
    } = await createExitMonitorTestModule());
  });

  describe('data source determination (Story 10.1)', () => {
    it('should classify as websocket when both WS are fresh', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      const freshDate = new Date(Date.now() - 10_000); // 10s ago
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'websocket' }),
      );
    });

    it('should classify as polling when no WS subscription exists', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: null,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: null,
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'polling' }),
      );
      // No fallback event for polling (normal pre-WS behavior)
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.DATA_FALLBACK,
        expect.anything(),
      );
    });

    it('should classify as stale_fallback when WS data is stale', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      const staleDate = new Date(Date.now() - 120_000); // 120s ago (> 60s threshold)
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(Date.now() - 5_000), // fresh
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'stale_fallback' }),
      );
    });

    it('should use worst-of-two: websocket + polling = polling', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: new Date(Date.now() - 5_000), // fresh WS
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: null, // no WS
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'polling' }),
      );
    });
  });

  describe('recalculated edge computation (Story 10.1)', () => {
    it('should compute recalculated edge from current prices and fees', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);

      await service.evaluatePositions();

      // Verify prisma.openPosition.update was called with recalculated edge fields
      expect(prisma.openPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { positionId: position.positionId },
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            recalculatedEdge: expect.any(String),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            lastRecalculatedAt: expect.any(Date),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            recalculationDataSource: expect.any(String),
          }),
        }),
      );
    });

    it('should persist recalculated edge even when threshold is not triggered', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: false,
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('16.7'),
      });

      await service.evaluatePositions();

      expect(prisma.openPosition.update).toHaveBeenCalledTimes(1);
    });

    it('should persist recalculated edge when threshold IS triggered', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'stop_loss',
        currentEdge: new Decimal('-0.05'),
        currentPnl: new Decimal('-5'),
        capturedEdgePercent: new Decimal('-166'),
      });

      await service.evaluatePositions();

      expect(prisma.openPosition.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale fallback event deduplication (Story 10.1)', () => {
    it('should emit fallback event on first stale cycle', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      const staleDate = new Date(Date.now() - 120_000);
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });

      await service.evaluatePositions();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DATA_FALLBACK,
        expect.objectContaining({
          positionId: asPositionId(position.positionId),
          fallbackSource: 'polling',
        }),
      );
    });

    it('should NOT emit fallback event on second consecutive stale cycle', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      const staleDate = new Date(Date.now() - 120_000);
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });

      // First cycle — emits event
      await service.evaluatePositions();
      const emitCalls1 = eventEmitter.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EVENT_NAMES.DATA_FALLBACK,
      );
      expect(emitCalls1).toHaveLength(1);

      // Second cycle — does NOT re-emit
      eventEmitter.emit.mockClear();
      await service.evaluatePositions();
      const emitCalls2 = eventEmitter.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EVENT_NAMES.DATA_FALLBACK,
      );
      expect(emitCalls2).toHaveLength(0);
    });

    it('should emit again after fresh→stale transition', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      const staleDate = new Date(Date.now() - 120_000);
      const freshDate = new Date(Date.now() - 5_000);

      // Cycle 1: stale → emits
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      await service.evaluatePositions();

      // Cycle 2: fresh → clears flag
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });
      eventEmitter.emit.mockClear();
      await service.evaluatePositions();

      // Cycle 3: stale again → should emit
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: staleDate,
      });
      eventEmitter.emit.mockClear();
      await service.evaluatePositions();

      const emitCalls = eventEmitter.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === EVENT_NAMES.DATA_FALLBACK,
      );
      expect(emitCalls).toHaveLength(1);
    });
  });

  describe('paper mode freshness tracking (Story 10.1)', () => {
    it('should work identically for paper mode positions', async () => {
      const position = createMockPosition();
      positionRepository.findByStatusWithOrders!.mockResolvedValue([position]);
      kalshiConnector.getHealth.mockReturnValue({
        status: 'healthy',
        mode: 'paper',
      });
      const freshDate = new Date(Date.now() - 5_000);
      kalshiConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });
      polymarketConnector.getOrderBookFreshness.mockReturnValue({
        lastWsUpdateAt: freshDate,
      });

      await service.evaluatePositions();

      expect(thresholdEvaluator.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ dataSource: 'websocket' }),
      );
      expect(prisma.openPosition.update).toHaveBeenCalled();
    });
  });
});
