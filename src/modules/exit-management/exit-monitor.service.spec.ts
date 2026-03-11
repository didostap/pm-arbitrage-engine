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
import {
  asPositionId,
  asOrderId,
  asPairId,
  asContractId,
  asMatchId,
} from '../../common/types/branded.type';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import {
  createMockPlatformConnector,
  createMockRiskManager,
} from '../../test/mock-factories.js';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: asPositionId('pos-1'),
    pairId: asPairId('pair-1'),
    kalshiOrderId: asOrderId('order-kalshi-1'),
    polymarketOrderId: asOrderId('order-poly-1'),
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.62', polymarket: '0.65' },
    sizes: { kalshi: '100', polymarket: '100' },
    expectedEdge: new Decimal('0.03'),
    status: 'OPEN',
    pair: {
      matchId: asMatchId('pair-1'),
      kalshiContractId: asContractId('kalshi-contract-1'),
      polymarketContractId: asContractId('poly-contract-1'),
      polymarketClobTokenId: 'mock-clob-token-1',
      primaryLeg: 'kalshi',
      resolutionDate: null,
    },
    kalshiOrder: {
      orderId: asOrderId('order-kalshi-1'),
      platform: 'KALSHI',
      side: 'buy',
      price: new Decimal('0.62'),
      size: new Decimal('100'),
      fillPrice: new Decimal('0.62'),
      fillSize: new Decimal('100'),
      status: 'FILLED',
    },
    polymarketOrder: {
      orderId: asOrderId('order-poly-1'),
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
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let thresholdEvaluator: Record<string, ReturnType<typeof vi.fn>>;

  function setupOrderCreateMock() {
    let orderCounter = 0;
    orderRepository.create!.mockImplementation(
      (data: Record<string, unknown>) => ({
        orderId: asOrderId(`exit-order-${++orderCounter}`),
        ...data,
      }),
    );
  }

  beforeEach(async () => {
    positionRepository = {
      findByStatusWithOrders: vi.fn().mockResolvedValue([]),
      findByIdWithOrders: vi.fn().mockResolvedValue(createMockPosition()),
      updateStatus: vi.fn().mockResolvedValue({}),
    };

    orderRepository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: asOrderId(`exit-order-${Date.now()}`),
        ...data,
      })),
      findById: vi.fn(),
      findByPairId: vi.fn().mockResolvedValue([]),
    };

    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: asContractId('kalshi-contract-1'),
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
        orderId: asOrderId('kalshi-exit-1'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
    });

    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getOrderBook: vi.fn().mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: asContractId('poly-contract-1'),
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
        orderId: asOrderId('poly-exit-1'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 100,
        timestamp: new Date(),
      }),
    });

    riskManager = createMockRiskManager();

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

      setupOrderCreateMock();

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

        setupOrderCreateMock();

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

        setupOrderCreateMock();

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

        setupOrderCreateMock();

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

        setupOrderCreateMock();

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

        setupOrderCreateMock();

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

        setupOrderCreateMock();

        await service.evaluatePositions();

        // closePosition called with 3 args including pairId
        expect(riskManager.closePosition).toHaveBeenCalledWith(
          expect.any(Decimal),
          expect.any(Decimal),
          asPairId('pair-1'),
        );
      });
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

  describe('partial fill handling (6.5.5k)', () => {
    beforeEach(() => {
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });
      setupOrderCreateMock();
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

  describe('pre-exit depth check (6.5.5k)', () => {
    beforeEach(() => {
      thresholdEvaluator.evaluate!.mockReturnValue({
        triggered: true,
        type: 'take_profit',
        currentEdge: new Decimal('0.025'),
        currentPnl: new Decimal('3.00'),
        capturedEdgePercent: new Decimal('100'),
      });
      setupOrderCreateMock();
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

      setupOrderCreateMock();

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

      // Should transition to CLOSED (exit fills match residual of 40)
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'CLOSED',
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

      setupOrderCreateMock();

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

      // Should stay EXIT_PARTIAL (not full residual)
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
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

      setupOrderCreateMock();

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

      // Should transition to CLOSED without submitting orders
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'CLOSED',
      );
      expect(riskManager.closePosition).toHaveBeenCalledWith(
        new Decimal(0),
        new Decimal(0),
        asPairId('pair-1'),
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
      setupOrderCreateMock();

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
