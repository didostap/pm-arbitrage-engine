/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StartupReconciliationService } from './startup-reconciliation.service';
import { PrismaService } from '../common/prisma.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../modules/risk-management/risk-management.constants';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { EVENT_NAMES } from '../common/events';
import { PlatformId } from '../common/types/platform.type';

const createMockConnector = (platformId: PlatformId) => ({
  getHealth: vi.fn().mockReturnValue({
    platformId,
    status: 'healthy' as const,
    lastHeartbeat: new Date(),
    latencyMs: 50,
  }),
  getOrder: vi.fn().mockResolvedValue({
    orderId: 'order-1',
    status: 'filled',
    fillPrice: 0.45,
    fillSize: 100,
  }),
  submitOrder: vi.fn(),
  cancelOrder: vi.fn(),
  getOrderBook: vi.fn(),
  getPositions: vi.fn(),
  getPlatformId: vi.fn().mockReturnValue(platformId),
  getFeeSchedule: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  onOrderBookUpdate: vi.fn(),
});

const createMockRiskManager = () => ({
  validatePosition: vi.fn(),
  getCurrentExposure: vi.fn(),
  getOpenPositionCount: vi.fn(),
  updateDailyPnl: vi.fn(),
  isTradingHalted: vi.fn().mockReturnValue(false),
  haltTrading: vi.fn(),
  resumeTrading: vi.fn(),
  recalculateFromPositions: vi.fn().mockResolvedValue(undefined),
  processOverride: vi.fn(),
  reserveBudget: vi.fn(),
  commitReservation: vi.fn(),
  releaseReservation: vi.fn(),
  closePosition: vi.fn().mockResolvedValue(undefined),
});

const createMockOrder = (overrides: Record<string, unknown> = {}) => ({
  orderId: 'order-1',
  platform: 'KALSHI' as const,
  contractId: 'contract-1',
  pairId: 'pair-1',
  side: 'buy',
  price: new Decimal('0.45'),
  size: new Decimal('100'),
  status: 'PENDING' as const,
  fillPrice: null,
  fillSize: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMockPosition = (overrides: Record<string, unknown> = {}) => ({
  positionId: 'pos-1',
  pairId: 'pair-1',
  polymarketOrderId: 'order-pm-1',
  kalshiOrderId: 'order-k-1',
  polymarketSide: 'buy',
  kalshiSide: 'sell',
  entryPrices: { polymarket: '0.55', kalshi: '0.45' },
  sizes: { polymarket: '100', kalshi: '100' },
  expectedEdge: new Decimal('0.08'),
  status: 'OPEN' as const,
  reconciliationContext: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  pair: { matchId: 'pair-1' },
  kalshiOrder: {
    orderId: 'order-k-1',
    platform: 'KALSHI',
    status: 'FILLED',
    fillPrice: new Decimal('0.45'),
    fillSize: new Decimal('100'),
  },
  polymarketOrder: {
    orderId: 'order-pm-1',
    platform: 'POLYMARKET',
    status: 'FILLED',
    fillPrice: new Decimal('0.55'),
    fillSize: new Decimal('100'),
  },
  ...overrides,
});

describe('StartupReconciliationService', () => {
  let service: StartupReconciliationService;
  let kalshiConnector: ReturnType<typeof createMockConnector>;
  let polymarketConnector: ReturnType<typeof createMockConnector>;
  let riskManager: ReturnType<typeof createMockRiskManager>;
  let positionRepository: {
    findActivePositions: ReturnType<typeof vi.fn>;
    findByStatus: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    updateWithOrder: ReturnType<typeof vi.fn>;
  };
  let orderRepository: {
    findPendingOrders: ReturnType<typeof vi.fn>;
    updateOrderStatus: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let mockPrisma: {
    openPosition: {
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    kalshiConnector = createMockConnector(PlatformId.KALSHI);
    polymarketConnector = createMockConnector(PlatformId.POLYMARKET);
    riskManager = createMockRiskManager();
    eventEmitter = { emit: vi.fn() };
    mockPrisma = {
      openPosition: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    positionRepository = {
      findActivePositions: vi.fn().mockResolvedValue([]),
      findByStatus: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(null),
      updateStatus: vi.fn().mockResolvedValue({}),
      updateWithOrder: vi.fn().mockResolvedValue({}),
    };
    orderRepository = {
      findPendingOrders: vi.fn().mockResolvedValue([]),
      updateOrderStatus: vi.fn().mockResolvedValue({}),
      findById: vi.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StartupReconciliationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: RISK_MANAGER_TOKEN, useValue: riskManager },
        { provide: PositionRepository, useValue: positionRepository },
        { provide: OrderRepository, useValue: orderRepository },
      ],
    }).compile();

    service = module.get<StartupReconciliationService>(
      StartupReconciliationService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reconcile() — clean path', () => {
    it('should return clean result when no positions or orders exist', async () => {
      const result = await service.reconcile();

      expect(result.positionsChecked).toBe(0);
      expect(result.ordersVerified).toBe(0);
      expect(result.pendingOrdersResolved).toBe(0);
      expect(result.discrepanciesFound).toBe(0);
      expect(result.platformsUnavailable).toEqual([]);
      expect(result.discrepancies).toEqual([]);
    });

    it('should emit ReconciliationCompleteEvent on clean path', async () => {
      await service.reconcile();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.RECONCILIATION_COMPLETE,
        expect.objectContaining({
          positionsChecked: 0,
          ordersVerified: 0,
          discrepanciesFound: 0,
        }),
      );
    });

    it('should recalculate risk budget on clean path', async () => {
      positionRepository.findActivePositions.mockResolvedValue([
        createMockPosition(),
      ]);

      // Make getOrder return filled for both
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      await service.reconcile();

      expect(riskManager.recalculateFromPositions).toHaveBeenCalledWith(
        1,
        expect.any(Decimal),
      );
    });

    it('should store lastRunResult', async () => {
      expect(service.getLastRunResult()).toBeNull();

      await service.reconcile();

      const lastResult = service.getLastRunResult();
      expect(lastResult).not.toBeNull();
      expect(lastResult?.discrepanciesFound).toBe(0);
    });
  });

  describe('reconcile() — pending order resolved', () => {
    it('should update PENDING order to FILLED when platform confirms fill', async () => {
      const pendingOrder = createMockOrder({
        orderId: 'order-pending-1',
        platform: 'KALSHI',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-pending-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });
      positionRepository.findByStatus.mockResolvedValue([]);

      const result = await service.reconcile();

      expect(orderRepository.updateOrderStatus).toHaveBeenCalledWith(
        'order-pending-1',
        'FILLED',
        0.45,
        100,
      );
      expect(result.pendingOrdersResolved).toBe(1);
    });

    it('should transition SINGLE_LEG_EXPOSED position to OPEN when pending order fills', async () => {
      const pendingOrder = createMockOrder({
        orderId: 'order-pm-pending',
        platform: 'POLYMARKET',
        pairId: 'pair-1',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-pending',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      // Position with missing polymarket order
      const singleLegPosition = createMockPosition({
        positionId: 'pos-single',
        pairId: 'pair-1',
        status: 'SINGLE_LEG_EXPOSED',
        polymarketOrderId: null,
        polymarketOrder: null,
      });
      positionRepository.findByStatus.mockResolvedValue([singleLegPosition]);

      await service.reconcile();

      expect(positionRepository.updateWithOrder).toHaveBeenCalledWith(
        'pos-single',
        expect.objectContaining({
          polymarketOrder: {
            connect: { orderId: 'order-pm-pending' },
          },
          status: 'OPEN',
        }),
      );
    });

    it('should update PENDING order to CANCELLED when platform confirms cancel', async () => {
      const pendingOrder = createMockOrder({
        orderId: 'order-cancel',
        platform: 'POLYMARKET',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-cancel',
        status: 'cancelled',
      });

      await service.reconcile();

      expect(orderRepository.updateOrderStatus).toHaveBeenCalledWith(
        'order-cancel',
        'CANCELLED',
      );
    });

    it('should emit OrderFilledEvent when pending order is now filled', async () => {
      const pendingOrder = createMockOrder({
        orderId: 'order-fill',
        platform: 'KALSHI',
        pairId: 'pair-1',
        side: 'buy',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-fill',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });

      // A single-leg position that matches
      const singleLeg = createMockPosition({
        positionId: 'pos-sl',
        pairId: 'pair-1',
        status: 'SINGLE_LEG_EXPOSED',
        kalshiOrderId: null,
        kalshiOrder: null,
      });
      positionRepository.findByStatus.mockResolvedValue([singleLeg]);

      await service.reconcile();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.ORDER_FILLED,
        expect.objectContaining({
          orderId: 'order-fill',
          platform: PlatformId.KALSHI,
        }),
      );
    });
  });

  describe('reconcile() — discrepancy detected', () => {
    it('should flag position as RECONCILIATION_REQUIRED on order status mismatch', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          status: 'FILLED',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
        },
      });
      positionRepository.findActivePositions.mockResolvedValue([position]);
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'cancelled',
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      const result = await service.reconcile();

      expect(result.discrepanciesFound).toBeGreaterThan(0);
      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { positionId: 'pos-1' },
          data: expect.objectContaining({
            status: 'RECONCILIATION_REQUIRED',
          }),
        }),
      );
    });

    it('should halt trading when discrepancies are found', async () => {
      const position = createMockPosition();
      positionRepository.findActivePositions.mockResolvedValue([position]);
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'not_found',
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      await service.reconcile();

      expect(riskManager.haltTrading).toHaveBeenCalledWith(
        'reconciliation_discrepancy',
      );
    });

    it('should emit ReconciliationDiscrepancyEvent for each discrepancy', async () => {
      const position = createMockPosition();
      positionRepository.findActivePositions.mockResolvedValue([position]);
      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'not_found',
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      await service.reconcile();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.RECONCILIATION_DISCREPANCY,
        expect.objectContaining({
          positionId: 'pos-1',
          discrepancyType: 'order_not_found',
        }),
      );
    });
  });

  describe('reconcile() — platform unavailable', () => {
    it('should flag Kalshi positions when Kalshi is disconnected', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
      });

      const position = createMockPosition();
      positionRepository.findActivePositions.mockResolvedValue([position]);

      const result = await service.reconcile();

      expect(result.platformsUnavailable).toContain(PlatformId.KALSHI);
      expect(result.discrepanciesFound).toBeGreaterThan(0);
    });

    it('should not query disconnected platform for pending orders', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
      });

      const pendingOrder = createMockOrder({
        platform: 'KALSHI',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);

      await service.reconcile();

      expect(kalshiConnector.getOrder).not.toHaveBeenCalled();
    });

    it('should still reconcile Polymarket when only Kalshi is disconnected', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
      });

      const pendingPmOrder = createMockOrder({
        orderId: 'order-pm-2',
        platform: 'POLYMARKET',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingPmOrder]);
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-2',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });
      positionRepository.findByStatus.mockResolvedValue([]);

      await service.reconcile();

      expect(polymarketConnector.getOrder).toHaveBeenCalled();
    });
  });

  describe('reconcile() — API timeout', () => {
    it('should handle API call timeout gracefully', async () => {
      const pendingOrder = createMockOrder({
        platform: 'KALSHI',
        status: 'PENDING',
      });
      orderRepository.findPendingOrders.mockResolvedValue([pendingOrder]);
      kalshiConnector.getOrder.mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      // Override the timeout for testing (we'll use vi.useFakeTimers)
      vi.useFakeTimers();
      const reconcilePromise = service.reconcile();

      // Fast-forward past the API timeout
      await vi.advanceTimersByTimeAsync(11_000);

      const result = await reconcilePromise;
      vi.useRealTimers();

      // Should have failed the API call but not crashed
      expect(result).toBeDefined();
    });
  });

  describe('reconcile() — capital calculation', () => {
    it('should calculate capital deployed using Decimal from order fill data', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          status: 'FILLED',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
        },
        polymarketOrder: {
          orderId: 'order-pm-1',
          platform: 'POLYMARKET',
          status: 'FILLED',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
        },
      });
      positionRepository.findActivePositions.mockResolvedValue([position]);

      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      await service.reconcile();

      // Expected: 100 * 0.45 + 100 * 0.55 = 45 + 55 = 100
      expect(riskManager.recalculateFromPositions).toHaveBeenCalledWith(
        1,
        new Decimal('100'),
      );
    });

    it('should exclude RECONCILIATION_REQUIRED from openCount but include in capital', async () => {
      const openPosition = createMockPosition({
        positionId: 'pos-open',
        status: 'OPEN',
      });
      const reconPosition = createMockPosition({
        positionId: 'pos-recon',
        status: 'RECONCILIATION_REQUIRED',
      });
      // For the recalculation call, findActivePositions is called separately
      positionRepository.findActivePositions
        .mockResolvedValueOnce([openPosition, reconPosition]) // phase 3
        .mockResolvedValueOnce([openPosition, reconPosition]); // recalculation

      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      await service.reconcile();

      // openCount should be 1 (only OPEN, not RECONCILIATION_REQUIRED)
      // capitalDeployed should include both positions = 200
      expect(riskManager.recalculateFromPositions).toHaveBeenCalledWith(
        1,
        new Decimal('200'),
      );
    });
  });

  describe('resolveDiscrepancy()', () => {
    it('should acknowledge discrepancy and update to recommended status', async () => {
      const position = createMockPosition({
        positionId: 'pos-recon',
        status: 'RECONCILIATION_REQUIRED',
        reconciliationContext: {
          recommendedStatus: 'OPEN',
          discrepancyType: 'pending_filled',
          platformState: {},
          detectedAt: new Date().toISOString(),
        },
      });
      positionRepository.findById.mockResolvedValue(position);
      positionRepository.findByStatus.mockResolvedValue([]);
      positionRepository.findActivePositions.mockResolvedValue([]);

      const result = await service.resolveDiscrepancy(
        'pos-recon',
        'acknowledge',
        'Verified fill on Kalshi dashboard',
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('OPEN');
      expect(mockPrisma.openPosition.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { positionId: 'pos-recon' },
          data: expect.objectContaining({
            status: 'OPEN',
            reconciliationContext: undefined,
          }),
        }),
      );
    });

    it('should force close position and call riskManager.closePosition', async () => {
      const position = createMockPosition({
        positionId: 'pos-force',
        status: 'RECONCILIATION_REQUIRED',
        reconciliationContext: {
          recommendedStatus: 'CLOSED',
          discrepancyType: 'order_status_mismatch',
          platformState: {},
          detectedAt: new Date().toISOString(),
        },
      });
      positionRepository.findById.mockResolvedValue(position);
      positionRepository.findByStatus.mockResolvedValue([]);
      positionRepository.findActivePositions.mockResolvedValue([]);

      const result = await service.resolveDiscrepancy(
        'pos-force',
        'force_close',
        'Operator confirmed position should be closed',
      );

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe('CLOSED');
      expect(riskManager.closePosition).toHaveBeenCalledWith(
        new Decimal(0),
        new Decimal(0),
      );
    });

    it('should resume trading when last discrepancy is resolved', async () => {
      const position = createMockPosition({
        positionId: 'pos-last',
        status: 'RECONCILIATION_REQUIRED',
        reconciliationContext: {
          recommendedStatus: 'OPEN',
          discrepancyType: 'platform_unavailable',
          platformState: {},
          detectedAt: new Date().toISOString(),
        },
      });
      positionRepository.findById.mockResolvedValue(position);
      positionRepository.findByStatus.mockResolvedValue([]); // No remaining
      positionRepository.findActivePositions.mockResolvedValue([]);

      await service.resolveDiscrepancy(
        'pos-last',
        'acknowledge',
        'Platform recovered, fills confirmed',
      );

      expect(riskManager.resumeTrading).toHaveBeenCalledWith(
        'reconciliation_discrepancy',
      );
    });

    it('should not resume trading when other discrepancies remain', async () => {
      const position = createMockPosition({
        positionId: 'pos-one',
        status: 'RECONCILIATION_REQUIRED',
        reconciliationContext: {
          recommendedStatus: 'OPEN',
          discrepancyType: 'platform_unavailable',
          platformState: {},
          detectedAt: new Date().toISOString(),
        },
      });
      positionRepository.findById.mockResolvedValue(position);
      positionRepository.findByStatus.mockResolvedValue([
        createMockPosition({
          positionId: 'pos-two',
          status: 'RECONCILIATION_REQUIRED',
        }),
      ]);
      positionRepository.findActivePositions.mockResolvedValue([]);

      const result = await service.resolveDiscrepancy(
        'pos-one',
        'acknowledge',
        'Verified one position',
      );

      expect(result.remainingDiscrepancies).toBe(1);
      expect(riskManager.resumeTrading).not.toHaveBeenCalled();
    });

    it('should throw if position not found', async () => {
      positionRepository.findById.mockResolvedValue(null);

      await expect(
        service.resolveDiscrepancy('pos-nonexistent', 'acknowledge', 'reason'),
      ).rejects.toThrow('Position not found');
    });

    it('should throw if position is not in RECONCILIATION_REQUIRED state', async () => {
      positionRepository.findById.mockResolvedValue(
        createMockPosition({ status: 'OPEN' }),
      );

      await expect(
        service.resolveDiscrepancy('pos-1', 'acknowledge', 'reason'),
      ).rejects.toThrow('not in RECONCILIATION_REQUIRED state');
    });
  });

  describe('reconcile() — both platforms disconnected', () => {
    it('should flag both platforms as unavailable', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
      });
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'disconnected',
        lastHeartbeat: null,
        latencyMs: null,
      });

      const result = await service.reconcile();

      expect(result.platformsUnavailable).toContain(PlatformId.KALSHI);
      expect(result.platformsUnavailable).toContain(PlatformId.POLYMARKET);
    });
  });

  describe('reconcile() — mixed scenarios', () => {
    it('should handle position with only one leg (single-leg exposed)', async () => {
      const position = createMockPosition({
        status: 'SINGLE_LEG_EXPOSED',
        polymarketOrderId: null,
        polymarketOrder: null,
      });
      positionRepository.findActivePositions.mockResolvedValue([position]);

      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });

      const result = await service.reconcile();

      // Should only verify the Kalshi order, not the missing Polymarket order
      expect(kalshiConnector.getOrder).toHaveBeenCalledWith('order-k-1');
      expect(polymarketConnector.getOrder).not.toHaveBeenCalled();
      expect(result.positionsChecked).toBe(1);
    });

    it('should detect pending_filled discrepancy during position verification', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: 'order-k-1',
          platform: 'KALSHI',
          status: 'PENDING',
          fillPrice: null,
          fillSize: null,
        },
      });
      positionRepository.findActivePositions.mockResolvedValue([position]);

      kalshiConnector.getOrder.mockResolvedValue({
        orderId: 'order-k-1',
        status: 'filled',
        fillPrice: 0.45,
        fillSize: 100,
      });
      polymarketConnector.getOrder.mockResolvedValue({
        orderId: 'order-pm-1',
        status: 'filled',
        fillPrice: 0.55,
        fillSize: 100,
      });

      const result = await service.reconcile();

      expect(result.discrepanciesFound).toBeGreaterThan(0);
      const disc = result.discrepancies.find(
        (d) => d.discrepancyType === 'pending_filled',
      );
      expect(disc).toBeDefined();
    });
  });
});
