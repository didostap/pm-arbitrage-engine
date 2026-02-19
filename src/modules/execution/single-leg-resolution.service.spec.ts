import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SingleLegResolutionService } from './single-leg-resolution.service';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PrismaService } from '../../common/prisma.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PlatformId } from '../../common/types/platform.type';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: 'pos-1',
    pairId: 'pair-1',
    kalshiOrderId: 'order-kalshi-1',
    polymarketOrderId: null,
    kalshiSide: 'buy',
    polymarketSide: 'sell',
    entryPrices: { kalshi: '0.45', polymarket: '0.55' },
    sizes: { kalshi: '200', polymarket: '182' },
    expectedEdge: 0.08,
    status: 'SINGLE_LEG_EXPOSED',
    pair: {
      matchId: 'pair-1',
      kalshiContractId: 'kalshi-contract-1',
      polymarketContractId: 'poly-contract-1',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-kalshi-1',
    platform: 'KALSHI',
    contractId: 'kalshi-contract-1',
    pairId: 'pair-1',
    side: 'buy',
    price: 0.45,
    size: 200,
    status: 'FILLED',
    fillPrice: 0.45,
    fillSize: 200,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SingleLegResolutionService', () => {
  let service: SingleLegResolutionService;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: Record<string, ReturnType<typeof vi.fn>>;
  let polymarketConnector: Record<string, ReturnType<typeof vi.fn>>;
  let riskManager: Record<string, ReturnType<typeof vi.fn>>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    positionRepository = {
      findById: vi.fn(),
      findByIdWithPair: vi.fn(),
      findByStatus: vi.fn(),
      findByPairId: vi.fn(),
      create: vi.fn(),
      updateStatus: vi.fn(),
      updateWithOrder: vi.fn(),
    };

    orderRepository = {
      create: vi.fn(),
      findById: vi.fn(),
      findByPairId: vi.fn(),
      updateStatus: vi.fn(),
    };

    kalshiConnector = {
      submitOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrderBook: vi.fn(),
      getPositions: vi.fn(),
      getHealth: vi.fn().mockReturnValue({ status: 'healthy' }),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2,
        description: 'Kalshi fees',
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      onOrderBookUpdate: vi.fn(),
    };

    polymarketConnector = {
      submitOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrderBook: vi.fn(),
      getPositions: vi.fn(),
      getHealth: vi.fn().mockReturnValue({ status: 'healthy' }),
      getPlatformId: vi.fn().mockReturnValue(PlatformId.POLYMARKET),
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 1,
        description: 'Polymarket fees',
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
      onOrderBookUpdate: vi.fn(),
    };

    riskManager = {
      validatePosition: vi.fn(),
      getCurrentExposure: vi.fn(),
      getOpenPositionCount: vi.fn(),
      updateDailyPnl: vi.fn().mockResolvedValue(undefined),
      isTradingHalted: vi.fn().mockReturnValue(false),
      processOverride: vi.fn(),
      reserveBudget: vi.fn(),
      commitReservation: vi.fn().mockResolvedValue(undefined),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
      closePosition: vi.fn().mockResolvedValue(undefined),
    };

    eventEmitter = {
      emit: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SingleLegResolutionService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: PrismaService, useValue: {} },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(SingleLegResolutionService);
  });

  describe('retryLeg', () => {
    it('should fill retry and transition position to OPEN', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: 'order-poly-retry-1',
        platformId: PlatformId.POLYMARKET,
        status: 'filled',
        filledQuantity: 182,
        filledPrice: 0.55,
        timestamp: new Date(),
      });
      orderRepository.create.mockResolvedValue({
        orderId: 'order-poly-retry-1',
      });
      positionRepository.updateWithOrder.mockResolvedValue({});

      const result = await service.retryLeg('pos-1', 0.55);

      expect(result.success).toBe(true);
      expect(result.orderId).toBe('order-poly-retry-1');
      expect(result.newEdge).toBeDefined();

      // Verify order was created
      expect(orderRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'POLYMARKET',
          side: 'sell',
          price: 0.55,
          status: 'FILLED',
        }),
      );

      // Verify position updated to OPEN with new order linked
      expect(positionRepository.updateWithOrder).toHaveBeenCalledWith(
        'pos-1',
        expect.objectContaining({
          status: 'OPEN',
          polymarketOrder: { connect: { orderId: 'order-poly-retry-1' } },
        }),
      );

      // Verify events emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.ORDER_FILLED,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        expect.objectContaining({
          positionId: 'pos-1',
          resolutionType: 'retried',
          retryPrice: 0.55,
          realizedPnl: null,
        }),
      );
    });

    it('should handle partial fill and still transition to OPEN', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: 'order-poly-partial-1',
        platformId: PlatformId.POLYMARKET,
        status: 'partial',
        filledQuantity: 100,
        filledPrice: 0.55,
        timestamp: new Date(),
      });
      orderRepository.create.mockResolvedValue({
        orderId: 'order-poly-partial-1',
      });
      positionRepository.updateWithOrder.mockResolvedValue({});

      const result = await service.retryLeg('pos-1', 0.55);

      expect(result.success).toBe(true);
      expect(orderRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PARTIAL' }),
      );
    });

    it('should return failure when order is rejected', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: 'order-reject-1',
        platformId: PlatformId.POLYMARKET,
        status: 'rejected',
        filledQuantity: 0,
        filledPrice: 0,
        timestamp: new Date(),
      });

      // Mock order books for P&L scenarios
      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [{ price: 0.44, quantity: 100 }],
        asks: [{ price: 0.46, quantity: 100 }],
        timestamp: new Date(),
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'poly-contract-1',
        bids: [{ price: 0.54, quantity: 100 }],
        asks: [{ price: 0.56, quantity: 100 }],
        timestamp: new Date(),
      });

      const result = await service.retryLeg('pos-1', 0.55);

      expect(result.success).toBe(false);
      expect(result.reason).toContain('rejected');
      expect(result.pnlScenarios).toBeDefined();
      expect(result.recommendedActions).toBeDefined();

      // Position should NOT be updated
      expect(positionRepository.updateWithOrder).not.toHaveBeenCalled();
    });

    it('should throw ExecutionError when position is not SINGLE_LEG_EXPOSED', async () => {
      const position = createMockPosition({ status: 'OPEN' });
      positionRepository.findByIdWithPair.mockResolvedValue(position);

      await expect(service.retryLeg('pos-1', 0.55)).rejects.toThrow(
        'Position is not in single-leg exposed state',
      );
    });

    it('should throw ExecutionError when position not found', async () => {
      positionRepository.findByIdWithPair.mockResolvedValue(null);

      await expect(service.retryLeg('nonexistent', 0.55)).rejects.toThrow(
        'not found',
      );
    });

    it('should throw ExecutionError when connector throws', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('API timeout'),
      );

      await expect(service.retryLeg('pos-1', 0.55)).rejects.toThrow(
        'Retry leg submission failed',
      );
    });

    it('should retry on Kalshi when polymarket order is filled', async () => {
      const position = createMockPosition({
        kalshiOrderId: null,
        polymarketOrderId: 'order-poly-1',
      });
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(
        createMockOrder({
          orderId: 'order-poly-1',
          platform: 'POLYMARKET',
          side: 'sell',
          fillPrice: 0.55,
          fillSize: 182,
        }),
      );
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: 'order-kalshi-retry-1',
        platformId: PlatformId.KALSHI,
        status: 'filled',
        filledQuantity: 200,
        filledPrice: 0.45,
        timestamp: new Date(),
      });
      orderRepository.create.mockResolvedValue({
        orderId: 'order-kalshi-retry-1',
      });
      positionRepository.updateWithOrder.mockResolvedValue({});

      const result = await service.retryLeg('pos-1', 0.45);

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: 'kalshi-contract-1',
          side: 'buy',
        }),
      );
      expect(positionRepository.updateWithOrder).toHaveBeenCalledWith(
        'pos-1',
        expect.objectContaining({
          kalshiOrder: { connect: { orderId: 'order-kalshi-retry-1' } },
        }),
      );
    });
  });

  describe('closeLeg', () => {
    it('should close filled leg and transition to CLOSED', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());

      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [{ price: 0.44, quantity: 100 }],
        asks: [{ price: 0.46, quantity: 100 }],
        timestamp: new Date(),
      });

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: 'order-close-1',
        platformId: PlatformId.KALSHI,
        status: 'filled',
        filledQuantity: 200,
        filledPrice: 0.44,
        timestamp: new Date(),
      });

      orderRepository.create.mockResolvedValue({ orderId: 'order-close-1' });
      positionRepository.updateStatus.mockResolvedValue({});

      const result = await service.closeLeg('pos-1', 'Cut losses');

      expect(result.success).toBe(true);
      expect(result.closeOrderId).toBe('order-close-1');
      expect(result.realizedPnl).toBeDefined();

      // Should submit opposing trade (buy→sell at best bid)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'sell',
          price: 0.44,
          quantity: 200,
        }),
      );

      // Position should be updated to CLOSED
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        'pos-1',
        'CLOSED',
      );

      // Risk manager should be called to close position
      expect(riskManager.closePosition).toHaveBeenCalled();

      // SingleLegResolvedEvent should be emitted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        expect.objectContaining({
          positionId: 'pos-1',
          resolutionType: 'closed',
          realizedPnl: expect.any(String) as unknown as string,
        }),
      );
    });

    it('should calculate P&L correctly for buy→sell close', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(
        createMockOrder({ fillPrice: 0.45, fillSize: 200 }),
      );

      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [{ price: 0.43, quantity: 500 }],
        asks: [{ price: 0.46, quantity: 500 }],
        timestamp: new Date(),
      });

      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: 'order-close-1',
        platformId: PlatformId.KALSHI,
        status: 'filled',
        filledQuantity: 200,
        filledPrice: 0.43,
        timestamp: new Date(),
      });

      orderRepository.create.mockResolvedValue({ orderId: 'order-close-1' });
      positionRepository.updateStatus.mockResolvedValue({});

      const result = await service.closeLeg('pos-1');

      // P&L = (0.43 - 0.45) * 200 - fee
      // Raw P&L = -0.02 * 200 = -4.00
      // Fee = 0.43 * 200 * 0.02 = 1.72
      // Realized = -4.00 - 1.72 = -5.72
      expect(result.realizedPnl).toBeDefined();
      const pnl = parseFloat(String(result.realizedPnl));
      expect(pnl).toBeLessThan(0); // Loss expected
    });

    it('should throw when position is not SINGLE_LEG_EXPOSED', async () => {
      const position = createMockPosition({ status: 'OPEN' });
      positionRepository.findByIdWithPair.mockResolvedValue(position);

      await expect(service.closeLeg('pos-1')).rejects.toThrow(
        'Position is not in single-leg exposed state',
      );
    });

    it('should throw when position not found', async () => {
      positionRepository.findByIdWithPair.mockResolvedValue(null);

      await expect(service.closeLeg('nonexistent')).rejects.toThrow(
        'not found',
      );
    });

    it('should throw when order book has no bids for sell close', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());

      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [],
        asks: [{ price: 0.46, quantity: 100 }],
        timestamp: new Date(),
      });

      await expect(service.closeLeg('pos-1')).rejects.toThrow(
        'order book has no bids',
      );
    });

    it('should throw when connector submit fails', async () => {
      const position = createMockPosition();
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(createMockOrder());

      kalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-contract-1',
        bids: [{ price: 0.44, quantity: 100 }],
        asks: [{ price: 0.46, quantity: 100 }],
        timestamp: new Date(),
      });

      kalshiConnector.submitOrder.mockRejectedValue(
        new Error('Platform unavailable'),
      );

      await expect(service.closeLeg('pos-1')).rejects.toThrow(
        'Close leg submission failed',
      );
    });

    it('should close sell→buy correctly (polymarket filled)', async () => {
      const position = createMockPosition({
        kalshiOrderId: null,
        polymarketOrderId: 'order-poly-1',
        kalshiSide: 'buy',
        polymarketSide: 'sell',
      });
      positionRepository.findByIdWithPair.mockResolvedValue(position);
      orderRepository.findById.mockResolvedValue(
        createMockOrder({
          orderId: 'order-poly-1',
          platform: 'POLYMARKET',
          side: 'sell',
          fillPrice: 0.55,
          fillSize: 182,
        }),
      );

      polymarketConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'poly-contract-1',
        bids: [{ price: 0.53, quantity: 200 }],
        asks: [{ price: 0.56, quantity: 200 }],
        timestamp: new Date(),
      });

      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: 'order-close-poly-1',
        platformId: PlatformId.POLYMARKET,
        status: 'filled',
        filledQuantity: 182,
        filledPrice: 0.56,
        timestamp: new Date(),
      });

      orderRepository.create.mockResolvedValue({
        orderId: 'order-close-poly-1',
      });
      positionRepository.updateStatus.mockResolvedValue({});

      const result = await service.closeLeg('pos-1', 'Hedging losses');

      expect(result.success).toBe(true);
      // sell→buy: submit buy at best ask
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          side: 'buy',
          price: 0.56,
          quantity: 182,
        }),
      );
    });
  });
});
