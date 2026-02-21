import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { ExitMonitorService } from './exit-monitor.service';
import { ThresholdEvaluatorService } from './threshold-evaluator.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformId } from '../../common/types/platform.type';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: 'pos-1',
    pairId: 'pair-1',
    kalshiOrderId: 'order-kalshi-1',
    polymarketOrderId: 'order-poly-1',
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.62', polymarket: '0.65' },
    sizes: { kalshi: '100', polymarket: '100' },
    expectedEdge: new Decimal('0.03'),
    status: 'OPEN',
    pair: {
      matchId: 'pair-1',
      kalshiContractId: 'kalshi-contract-1',
      polymarketContractId: 'poly-contract-1',
      primaryLeg: 'kalshi',
      resolutionDate: null,
    },
    kalshiOrder: {
      orderId: 'order-kalshi-1',
      platform: 'KALSHI',
      side: 'buy',
      price: new Decimal('0.62'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.62'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    polymarketOrder: {
      orderId: 'order-poly-1',
      platform: 'POLYMARKET',
      side: 'sell',
      price: new Decimal('0.65'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.65'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ExitMonitorService', () => {
  let service: ExitMonitorService;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: Record<string, ReturnType<typeof vi.fn>>;
  let polymarketConnector: Record<string, ReturnType<typeof vi.fn>>;
  let riskManager: Record<string, ReturnType<typeof vi.fn>>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let thresholdEvaluator: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    positionRepository = {
      findByStatusWithOrders: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn().mockResolvedValue({}),
    };

    orderRepository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: `exit-order-${Date.now()}`,
        ...data,
      })),
      findById: vi.fn(),
    };

    kalshiConnector = {
      getHealth: vi.fn().mockReturnValue({ status: 'healthy' }),
      getOrder: vi.fn(),
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [{ price: 0.66, quantity: 500 }],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      }),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2,
        description: 'Kalshi fees',
      }),
      submitOrder: vi.fn().mockResolvedValue({
        orderId: 'kalshi-exit-1',
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
    };

    polymarketConnector = {
      getHealth: vi.fn().mockReturnValue({ status: 'healthy' }),
      getOrder: vi.fn(),
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'poly-contract-1',
        bids: [{ price: 0.62, quantity: 500 }],
        asks: [{ price: 0.64, quantity: 500 }],
        timestamp: new Date(),
      }),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 1,
        description: 'Polymarket fees',
      }),
      submitOrder: vi.fn().mockResolvedValue({
        orderId: 'poly-exit-1',
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.POLYMARKET),
    };

    riskManager = {
      closePosition: vi.fn().mockResolvedValue(undefined),
      haltTrading: vi.fn(),
      resumeTrading: vi.fn(),
      recalculateFromPositions: vi.fn().mockResolvedValue(undefined),
    };

    eventEmitter = {
      emit: vi.fn(),
    };

    thresholdEvaluator = {
      evaluate: vi.fn().mockReturnValue({
        triggered: false,
        currentEdge: new Decimal('0.01'),
        currentPnl: new Decimal('0.50'),
        capturedEdgePercent: new Decimal('16.7'),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExitMonitorService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ThresholdEvaluatorService, useValue: thresholdEvaluator },
      ],
    }).compile();

    service = module.get(ExitMonitorService);
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
      kalshiConnector.getHealth!.mockReturnValue({ status: 'disconnected' });

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
          orderId: 'order-kalshi-1',
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
      kalshiConnector.getOrderBook!.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
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

      let orderCounter = 0;
      orderRepository.create!.mockImplementation(
        (data: Record<string, unknown>) => ({
          orderId: `exit-order-${++orderCounter}`,
          ...data,
        }),
      );

      await service.evaluatePositions();

      // Both connectors should have submitted orders
      expect(kalshiConnector.submitOrder).toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).toHaveBeenCalled();

      // Position should be marked CLOSED
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        'pos-1',
        'CLOSED',
      );

      // Risk manager should release budget
      expect(riskManager.closePosition).toHaveBeenCalled();

      // ExitTriggeredEvent should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXIT_TRIGGERED,
        expect.objectContaining({
          positionId: 'pos-1',
          pairId: 'pair-1',
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
      kalshiConnector.submitOrder!.mockResolvedValue({
        orderId: 'kalshi-exit-1',
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder!.mockRejectedValue(
        new Error('Polymarket API timeout'),
      );

      orderRepository.create!.mockResolvedValue({
        orderId: 'kalshi-exit-order-1',
        platform: 'KALSHI',
        price: new Decimal('0.66'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.66'),
        fillSize: new Decimal('100'),
      });
      orderRepository.findById!.mockResolvedValue({
        orderId: 'kalshi-exit-order-1',
        platform: 'KALSHI',
        price: new Decimal('0.66'),
        size: new Decimal('100'),
        fillPrice: new Decimal('0.66'),
        fillSize: new Decimal('100'),
      });

      await service.evaluatePositions();

      // Position should be EXIT_PARTIAL
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        'pos-1',
        'EXIT_PARTIAL',
      );

      // SingleLegExposureEvent should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.objectContaining({
          positionId: 'pos-1',
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
      kalshiConnector.submitOrder!.mockRejectedValue(
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
      const pos1 = createMockPosition({ positionId: 'pos-1' });
      const pos2 = createMockPosition({ positionId: 'pos-2' });
      positionRepository.findByStatusWithOrders!.mockResolvedValue([
        pos1,
        pos2,
      ]);

      // First position: connector throws on order book
      kalshiConnector
        .getOrderBook!.mockRejectedValueOnce(new Error('First call fails'))
        .mockResolvedValueOnce({
          platformId: PlatformId.KALSHI,
          contractId: 'kalshi-contract-1',
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
      kalshiConnector.getOrderBook!.mockRejectedValue(
        new Error('Always fails'),
      );

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

  describe('getClosePrice', () => {
    it('should return best bid when original side is buy (selling to close)', async () => {
      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        'contract-1',
        'buy',
      );
      expect(price).toEqual(new Decimal(0.66));
    });

    it('should return best ask when original side is sell (buying to close)', async () => {
      const price = await service.getClosePrice(
        polymarketConnector as unknown as IPlatformConnector,
        'contract-1',
        'sell',
      );
      expect(price).toEqual(new Decimal(0.64));
    });

    it('should return null when order book is empty on relevant side', async () => {
      kalshiConnector.getOrderBook!.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'contract-1',
        bids: [],
        asks: [{ price: 0.68, quantity: 500 }],
        timestamp: new Date(),
      });

      const price = await service.getClosePrice(
        kalshiConnector as unknown as IPlatformConnector,
        'contract-1',
        'buy',
      );
      expect(price).toBeNull();
    });
  });
});
