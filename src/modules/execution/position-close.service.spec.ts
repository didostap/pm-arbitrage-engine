import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PositionCloseService } from './position-close.service';
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
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { KALSHI_ERROR_CODES } from '../../common/errors/platform-api-error';
import { ExecutionLockService } from './execution-lock.service';
import { PrismaService } from '../../common/prisma.service';
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
    isPaper: false,
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

describe('PositionCloseService', () => {
  let service: PositionCloseService;
  let positionRepository: Record<string, ReturnType<typeof vi.fn>>;
  let orderRepository: Record<string, ReturnType<typeof vi.fn>>;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let eventEmitter: Record<string, ReturnType<typeof vi.fn>>;
  let executionLockService: Record<string, ReturnType<typeof vi.fn>>;
  let prisma: { openPosition: { update: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    positionRepository = {
      findByIdWithOrders: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue({}),
      closePosition: vi.fn().mockResolvedValue({}),
      updateStatusWithAccumulatedPnl: vi.fn().mockResolvedValue({}),
    };

    let orderCounter = 0;
    orderRepository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: asOrderId(`close-order-${++orderCounter}`),
        ...data,
      })),
      findById: vi.fn().mockResolvedValue(null),
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
        orderId: asOrderId('kalshi-close-1'),
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
        orderId: asOrderId('poly-close-1'),
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

    executionLockService = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };

    prisma = {
      openPosition: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionCloseService,
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ExecutionLockService, useValue: executionLockService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PositionCloseService>(PositionCloseService);
  });

  describe('closePosition — OPEN happy path', () => {
    it('should close an OPEN position with both legs filling', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position) // first read before lock
        .mockResolvedValueOnce(position); // re-read after lock

      const result = await service.closePosition(
        asPositionId('pos-1'),
        'Manual close test',
      );

      expect(result.success).toBe(true);
      expect(result.realizedPnl).toBeDefined();

      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );
      expect(riskManager.closePosition).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.EXIT_TRIGGERED,
        expect.objectContaining({
          exitType: 'manual',
          positionId: asPositionId('pos-1'),
        }),
      );
    });

    it('should acquire and release execution lock', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      await service.closePosition(asPositionId('pos-1'));

      expect(executionLockService.acquire).toHaveBeenCalled();
      expect(executionLockService.release).toHaveBeenCalled();
    });
  });

  describe('closePosition — EXIT_PARTIAL with residual', () => {
    it('should use residual sizes for EXIT_PARTIAL positions', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      // Entry + prior partial exit orders
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

      // Orders fill for residual 40
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-close-2'),
        status: 'filled',
        filledPrice: 0.66,
        filledQuantity: 40,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-close-2'),
        status: 'filled',
        filledPrice: 0.62,
        filledQuantity: 40,
        timestamp: new Date(),
      });

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(true);
      // Should submit orders for residual size (40), not entry size (100)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 40 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 40 }),
      );
    });
  });

  describe('closePosition — single-leg failure', () => {
    it('should transition to SINGLE_LEG_EXPOSED when secondary leg fails', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Order rejected'),
      );

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(positionRepository.updateStatus).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'SINGLE_LEG_EXPOSED',
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.objectContaining({
          positionId: asPositionId('pos-1'),
          origin: 'manual_close',
        }),
      );
    });
  });

  describe('closePosition — status guard', () => {
    it('should reject CLOSED positions with error', async () => {
      const position = createMockPosition({ status: 'CLOSED' });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in a closeable state');
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject SINGLE_LEG_EXPOSED positions', async () => {
      const position = createMockPosition({
        status: 'SINGLE_LEG_EXPOSED',
      });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in a closeable state');
    });

    it('should reject RECONCILIATION_REQUIRED positions', async () => {
      const position = createMockPosition({
        status: 'RECONCILIATION_REQUIRED',
      });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not in a closeable state');
    });

    it('should return not found when position does not exist', async () => {
      positionRepository.findByIdWithOrders!.mockResolvedValue(null);

      const result = await service.closePosition(asPositionId('nonexistent'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('closePosition — race condition', () => {
    it('should exit gracefully when position status changes during lock wait', async () => {
      const position = createMockPosition({ status: 'OPEN' });
      const closedPosition = createMockPosition({ status: 'CLOSED' });

      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position) // pre-lock read: OPEN
        .mockResolvedValueOnce(closedPosition); // post-lock re-read: CLOSED

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('already transitioning');
      // Should NOT submit any orders
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — lock release on error', () => {
    it('should release lock even when an error occurs after lock acquisition', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position) // pre-lock: found
        .mockRejectedValueOnce(new Error('DB error')); // post-lock re-read: fails

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(executionLockService.release).toHaveBeenCalled();
    });
  });

  describe('closePosition — partial fill handling', () => {
    it('should transition to EXIT_PARTIAL when fills are less than effective size', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      // Both legs only partially fill (50 of 100)
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-close-1'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 50,
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-close-1'),
        status: 'partial',
        filledPrice: 0.62,
        filledQuantity: 50,
        timestamp: new Date(),
      });

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(true);
      expect(result.realizedPnl).toBeDefined();
      expect(result.error).toContain('Partial fill');
      expect(
        positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
      expect(riskManager.releasePartialCapital).toHaveBeenCalled();
      // closePosition (full close) should NOT be called
      expect(riskManager.closePosition).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — zero residual EXIT_PARTIAL', () => {
    it('should transition to CLOSED when EXIT_PARTIAL has zero residual on both legs', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

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

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(true);
      expect(result.realizedPnl).toBe('0.00000000');
      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        new Decimal(0),
      );
      expect(riskManager.closePosition).toHaveBeenCalledWith(
        new Decimal(0),
        new Decimal(0),
        asPairId('pair-1'),
      );
      // Should NOT submit any orders
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — single-zero residual', () => {
    it('should return error when EXIT_PARTIAL has zero residual on one leg only', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

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

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('zero residual');
      expect(result.errorCode).toBe('EXECUTION_FAILED');
      // Should NOT submit any orders
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });
  });

  describe('closePosition — secondary order book re-fetch', () => {
    it('should re-fetch secondary order book after primary leg fills', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(true);
      // Secondary connector should have getOrderBook called twice:
      // once for initial VWAP, once for re-fetch after primary fills
      expect(polymarketConnector.getOrderBook).toHaveBeenCalledTimes(2);
    });
  });

  describe('closePosition — rate limit classification', () => {
    it('should return RATE_LIMITED errorCode when PlatformApiError is a rate limit', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      // Simulate rate limit error when fetching order book
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RATE_LIMITED');
    });

    it('should return EXECUTION_FAILED for non-rate-limit PlatformApiError', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          KALSHI_ERROR_CODES.MARKET_NOT_FOUND,
          'Market not found',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      const result = await service.closePosition(asPositionId('pos-1'));

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('EXECUTION_FAILED');
    });
  });

  describe('closeAllPositions', () => {
    function createMockPositionWithPair(
      id: string,
      overrides: Record<string, unknown> = {},
    ) {
      return {
        positionId: asPositionId(id),
        pairId: asPairId(`pair-${id}`),
        status: 'OPEN',
        isPaper: false,
        pair: {
          matchId: asMatchId(`pair-${id}`),
          kalshiContractId: asContractId(`kalshi-${id}`),
          polymarketContractId: asContractId(`poly-${id}`),
          polymarketClobTokenId: `mock-clob-${id}`,
          pairName: `Pair ${id}`,
          primaryLeg: 'kalshi',
          resolutionDate: null,
        },
        ...overrides,
      };
    }

    beforeEach(() => {
      // Add mock for findByStatusWithPair (not in default setup)
      positionRepository.findByStatusWithPair = vi.fn().mockResolvedValue([]);
    });

    it('should return batchId immediately', async () => {
      const result = await service.closeAllPositions('Emergency close');

      expect(result.batchId).toBeDefined();
      expect(typeof result.batchId).toBe('string');
      expect(result.batchId.length).toBeGreaterThan(0);
    });

    it('should emit batch.complete with empty results when no positions exist', async () => {
      positionRepository.findByStatusWithPair!.mockResolvedValue([]); // both live and paper return empty

      await service.closeAllPositions();

      await vi.waitFor(() => {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.BATCH_COMPLETE,
          expect.objectContaining({
            results: [],
          }),
        );
      });
    });

    it('should close all positions sequentially and emit batch.complete', async () => {
      const positions = [
        createMockPositionWithPair('1'),
        createMockPositionWithPair('2'),
        createMockPositionWithPair('3'),
      ];

      // First call (live) returns positions, second call (paper) returns empty
      positionRepository
        .findByStatusWithPair!.mockResolvedValueOnce(positions)
        .mockResolvedValueOnce([]);

      // Mock closePosition to succeed for each
      for (const pos of positions) {
        positionRepository
          .findByIdWithOrders!.mockResolvedValueOnce(
            createMockPosition({
              positionId: pos.positionId,
              pairId: pos.pairId,
            }),
          )
          .mockResolvedValueOnce(
            createMockPosition({
              positionId: pos.positionId,
              pairId: pos.pairId,
            }),
          );
      }

      await service.closeAllPositions('Batch close test');

      await vi.waitFor(() => {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.BATCH_COMPLETE,
          expect.anything(),
        );
      });

      const batchEmitCall = eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.BATCH_COMPLETE,
      );
      expect(batchEmitCall).toBeDefined();
      const batchResults = (
        batchEmitCall![1] as {
          results: Array<{
            positionId: string;
            pairName: string;
            status: string;
          }>;
        }
      ).results;
      expect(batchResults).toHaveLength(3);
      expect(batchResults[0]).toEqual(
        expect.objectContaining({
          positionId: '1',
          pairName: 'Pair 1',
          status: 'success',
        }),
      );
      expect(batchResults[1]).toEqual(
        expect.objectContaining({
          positionId: '2',
          pairName: 'Pair 2',
          status: 'success',
        }),
      );
      expect(batchResults[2]).toEqual(
        expect.objectContaining({
          positionId: '3',
          pairName: 'Pair 3',
          status: 'success',
        }),
      );
    });

    it('should classify mixed results correctly', async () => {
      const positions = [
        createMockPositionWithPair('ok'),
        createMockPositionWithPair('fail'),
        createMockPositionWithPair('rate'),
      ];

      positionRepository
        .findByStatusWithPair!.mockResolvedValueOnce(positions)
        .mockResolvedValueOnce([]);

      // Spy on closePosition and return predetermined results per positionId
      const closePositionSpy = vi.spyOn(service, 'closePosition');
      closePositionSpy
        .mockResolvedValueOnce({ success: true, realizedPnl: '0.01000000' }) // ok
        .mockResolvedValueOnce({
          success: false,
          error: 'Position not found',
          errorCode: 'NOT_FOUND',
        }) // fail
        .mockResolvedValueOnce({
          success: false,
          error: 'Rate limit exceeded',
          errorCode: 'RATE_LIMITED',
        }); // rate

      await service.closeAllPositions();

      await vi.waitFor(() => {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.BATCH_COMPLETE,
          expect.anything(),
        );
      });

      const batchCall = eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.BATCH_COMPLETE,
      );
      expect(batchCall).toBeDefined();
      const batchEvent = batchCall![1] as {
        results: Array<{ positionId: string; status: string; error?: string }>;
      };
      const results = batchEvent.results;

      expect(results).toHaveLength(3);
      expect(results.find((r) => r.positionId === 'ok')?.status).toBe(
        'success',
      );
      expect(results.find((r) => r.positionId === 'fail')?.status).toBe(
        'failure',
      );
      expect(results.find((r) => r.positionId === 'rate')?.status).toBe(
        'rate_limited',
      );

      closePositionSpy.mockRestore();
    });

    it('should handle race condition where position was closed during batch', async () => {
      const positions = [createMockPositionWithPair('1')];
      positionRepository
        .findByStatusWithPair!.mockResolvedValueOnce(positions)
        .mockResolvedValueOnce([]);

      // Pre-lock check: OPEN, post-lock re-read: CLOSED (exit monitor closed it)
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(
          createMockPosition({ positionId: asPositionId('1'), status: 'OPEN' }),
        )
        .mockResolvedValueOnce(
          createMockPosition({
            positionId: asPositionId('1'),
            status: 'CLOSED',
          }),
        );

      await service.closeAllPositions();

      await vi.waitFor(() => {
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.BATCH_COMPLETE,
          expect.anything(),
        );
      });

      const batchCall = eventEmitter.emit.mock.calls.find(
        (c: unknown[]) => c[0] === EVENT_NAMES.BATCH_COMPLETE,
      );
      expect(batchCall).toBeDefined();
      const batchEvent = batchCall![1] as {
        results: Array<{ positionId: string; status: string; error?: string }>;
      };
      expect(batchEvent.results[0].status).toBe('failure');
      expect(batchEvent.results[0].error).toContain('not in a closeable state');
    });
  });

  describe('realizedPnl persistence', () => {
    it('should persist realizedPnl to DB on full exit', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      await service.closePosition(asPositionId('pos-1'));

      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        expect.any(Decimal),
      );
      // Verify realizedPnl is a valid finite Decimal
      const callArgs = (
        positionRepository.closePosition as ReturnType<typeof vi.fn>
      ).mock.calls[0] as [string, Decimal];
      expect(callArgs[1].isFinite()).toBe(true);
    });

    it('should persist realizedPnl=0 on zero-residual EXIT_PARTIAL close', async () => {
      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      // Exit orders (different IDs from entry) that exactly match entry fills → zero residual
      orderRepository.findByPairId!.mockResolvedValue([
        {
          orderId: asOrderId('exit-kalshi-1'),
          platform: 'KALSHI',
          side: 'sell',
          fillPrice: new Decimal('0.66'),
          fillSize: new Decimal('100'),
        },
        {
          orderId: asOrderId('exit-poly-1'),
          platform: 'POLYMARKET',
          side: 'buy',
          fillPrice: new Decimal('0.62'),
          fillSize: new Decimal('100'),
        },
      ]);

      const result = await service.closePosition(asPositionId('pos-1'));
      expect(result.success).toBe(true);
      expect(positionRepository.closePosition).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        new Decimal(0),
      );
    });

    it('should persist accumulated realizedPnl on partial exit (EXIT_PARTIAL status)', async () => {
      const position = createMockPosition();
      positionRepository
        .findByIdWithOrders!.mockResolvedValueOnce(position)
        .mockResolvedValueOnce(position);

      // Partial fills on both legs
      kalshiConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('kalshi-close-1'),
        status: 'partial',
        filledPrice: 0.66,
        filledQuantity: 50, // only 50 of 100 filled
        timestamp: new Date(),
      });
      polymarketConnector.submitOrder.mockResolvedValue({
        orderId: asOrderId('poly-close-1'),
        status: 'partial',
        filledPrice: 0.62,
        filledQuantity: 50,
        timestamp: new Date(),
      });

      const result = await service.closePosition(asPositionId('pos-1'));
      expect(result.success).toBe(true);
      // Partial exit now persists accumulated PnL
      expect(
        positionRepository.updateStatusWithAccumulatedPnl,
      ).toHaveBeenCalledWith(
        asPositionId('pos-1'),
        'EXIT_PARTIAL',
        expect.any(Decimal),
        expect.any(Decimal),
      );
    });
  });
});
