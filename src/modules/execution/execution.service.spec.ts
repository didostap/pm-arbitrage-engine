import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { ExecutionService } from './execution.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { PlatformId } from '../../common/types/platform.type';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import type {
  RankedOpportunity,
  BudgetReservation,
} from '../../common/types/risk.type';
import type {
  OrderResult,
  NormalizedOrderBook,
} from '../../common/types/index';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import type { ContractPairConfig } from '../contract-matching/types/contract-pair-config.type';

function makePairConfig(
  overrides?: Partial<ContractPairConfig>,
): ContractPairConfig {
  return {
    polymarketContractId: 'pm-contract-1',
    kalshiContractId: 'kalshi-contract-1',
    eventDescription: 'Test event',
    operatorVerificationTimestamp: new Date(),
    primaryLeg: 'kalshi',
    ...overrides,
  };
}

function makeEnriched(
  overrides?: Partial<{
    pairConfig: Partial<ContractPairConfig>;
    buyPlatformId: PlatformId;
    sellPlatformId: PlatformId;
    buyPrice: Decimal;
    sellPrice: Decimal;
    netEdge: Decimal;
  }>,
): EnrichedOpportunity {
  return {
    dislocation: {
      pairConfig: makePairConfig(overrides?.pairConfig),
      buyPlatformId: overrides?.buyPlatformId ?? PlatformId.KALSHI,
      sellPlatformId: overrides?.sellPlatformId ?? PlatformId.POLYMARKET,
      buyPrice: overrides?.buyPrice ?? new Decimal('0.45'),
      sellPrice: overrides?.sellPrice ?? new Decimal('0.55'),
      grossEdge: new Decimal('0.10'),
      buyOrderBook: makeKalshiOrderBook(),
      sellOrderBook: makePolymarketOrderBook(),
      detectedAt: new Date(),
    },
    netEdge: overrides?.netEdge ?? new Decimal('0.08'),
    grossEdge: new Decimal('0.10'),
    feeBreakdown: {
      kalshiFee: new Decimal('0.01'),
      polymarketFee: new Decimal('0.01'),
      totalFees: new Decimal('0.02'),
    } as unknown as EnrichedOpportunity['feeBreakdown'],
    liquidityDepth: {
      buyBestAskSize: 100,
      sellBestAskSize: 100,
      buyBestBidSize: 100,
      sellBestBidSize: 100,
    },
    recommendedPositionSize: null,
    enrichedAt: new Date(),
  };
}

function makeKalshiOrderBook(): NormalizedOrderBook {
  // Kalshi buy side: asks at ≤0.45 with qty ≥223 (100/0.45≈222)
  return {
    platformId: PlatformId.KALSHI,
    contractId: 'kalshi-contract-1',
    bids: [{ price: 0.44, quantity: 500 }],
    asks: [{ price: 0.45, quantity: 500 }],
    timestamp: new Date(),
  };
}

function makePolymarketOrderBook(): NormalizedOrderBook {
  // Polymarket sell side: bids at ≥0.55 with qty ≥182 (100/0.55≈181)
  return {
    platformId: PlatformId.POLYMARKET,
    contractId: 'pm-contract-1',
    bids: [{ price: 0.55, quantity: 500 }],
    asks: [{ price: 0.56, quantity: 500 }],
    timestamp: new Date(),
  };
}

function makeOpportunity(
  enrichedOverrides?: Parameters<typeof makeEnriched>[0],
): RankedOpportunity {
  return {
    opportunity: makeEnriched(enrichedOverrides),
    netEdge: new Decimal('0.08'),
    reservationRequest: {
      opportunityId: 'opp-1',
      recommendedPositionSizeUsd: new Decimal('100'),
      pairId: 'pair-1',
    },
  };
}

function makeReservation(): BudgetReservation {
  return {
    reservationId: 'res-1',
    opportunityId: 'opp-1',
    reservedPositionSlots: 1,
    reservedCapitalUsd: new Decimal('100'),
    correlationExposure: new Decimal('0'),
    createdAt: new Date(),
  };
}

function makeFilledOrder(
  platform: PlatformId,
  overrides?: Partial<OrderResult>,
): OrderResult {
  return {
    orderId: `order-${platform}-1`,
    platformId: platform,
    status: 'filled',
    filledQuantity: 200,
    filledPrice: 0.45,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('ExecutionService', () => {
  let service: ExecutionService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let orderRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let positionRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 2.0,
        description: 'Kalshi fee schedule',
      }),
    });
    polymarketConnector = createMockPlatformConnector(PlatformId.POLYMARKET, {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 2.0,
        description: 'Polymarket fee schedule',
      }),
    });
    eventEmitter = { emit: vi.fn() };
    orderRepo = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        orderId: `order-${Date.now()}`,
        ...data,
      })),
      findById: vi.fn(),
    };
    positionRepo = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        positionId: `pos-${Date.now()}`,
        ...data,
      })),
      findById: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderRepository, useValue: orderRepo },
        { provide: PositionRepository, useValue: positionRepo },
      ],
    }).compile();

    service = module.get<ExecutionService>(ExecutionService);
  });

  describe('happy path — two-leg fill', () => {
    it('should execute both legs and return success', async () => {
      // Depth verification returns sufficient liquidity
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      // Both legs fill
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(false);
      expect(result.positionId).toBeDefined();
      expect(result.primaryOrder).toBeDefined();
      expect(result.secondaryOrder).toBeDefined();
    });

    it('should emit two OrderFilledEvents on two-leg fill', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const orderFilledCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(orderFilledCalls).toHaveLength(2);
    });

    it('should persist two orders and one position', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(orderRepo.create).toHaveBeenCalledTimes(2);
      expect(positionRepo.create).toHaveBeenCalledTimes(1);

      // Verify position status is OPEN
      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(positionData.status).toBe('OPEN');
    });
  });

  describe('depth verification failure — pre-primary', () => {
    it('should abandon and return failure when primary depth insufficient', async () => {
      // Return empty order book — no liquidity
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [],
        bids: [],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should emit EXECUTION_FAILED event, not ORDER_FILLED', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [],
        bids: [],
      });

      await service.execute(makeOpportunity(), makeReservation());

      const failedCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.EXECUTION_FAILED,
      );
      const filledCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(failedCalls).toHaveLength(1);
      expect(filledCalls).toHaveLength(0);
    });
  });

  describe('primary leg ordering by config', () => {
    it('should use kalshi as primary when primaryLeg is kalshi', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(
        makeOpportunity({ pairConfig: { primaryLeg: 'kalshi' } }),
        makeReservation(),
      );

      // Kalshi should be called first (primary)
      expect(kalshiConnector.submitOrder).toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).toHaveBeenCalled();

      // Verify submission order
      const kalshiCallOrder =
        kalshiConnector.submitOrder.mock.invocationCallOrder[0];
      const pmCallOrder =
        polymarketConnector.submitOrder.mock.invocationCallOrder[0];
      expect(kalshiCallOrder).toBeLessThan(pmCallOrder!);
    });

    it('should use polymarket as primary when primaryLeg is polymarket', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      await service.execute(
        makeOpportunity({ pairConfig: { primaryLeg: 'polymarket' } }),
        makeReservation(),
      );

      // Polymarket should be called first (primary)
      const pmCallOrder =
        polymarketConnector.submitOrder.mock.invocationCallOrder[0];
      const kalshiCallOrder =
        kalshiConnector.submitOrder.mock.invocationCallOrder[0];
      expect(pmCallOrder).toBeLessThan(kalshiCallOrder!);
    });
  });

  describe('single-leg exposure — primary fills, secondary depth fails', () => {
    it('should return partialFill true and status single_leg_exposed', async () => {
      // Primary depth OK
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      // Primary fills
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      // Secondary depth fails
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        asks: [],
        bids: [],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
      expect(result.positionId).toBeDefined();
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      );

      // Verify position status is SINGLE_LEG_EXPOSED
      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(positionData.status).toBe('SINGLE_LEG_EXPOSED');
    });
  });

  describe('single-leg exposure — primary fills, secondary rejected', () => {
    it('should return partialFill true when secondary is rejected', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
      expect(result.positionId).toBeDefined();

      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(positionData.status).toBe('SINGLE_LEG_EXPOSED');
    });

    it('should emit only one OrderFilledEvent for the filled primary leg', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const orderFilledCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(orderFilledCalls).toHaveLength(1);
    });
  });

  describe('single-leg exposure — SingleLegExposureEvent emission', () => {
    it('should emit SingleLegExposureEvent with correct payload on single-leg exposure', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const singleLegCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCalls).toHaveLength(1);

      const event = singleLegCalls[0]![1] as SingleLegExposureEvent;
      expect(event).toBeInstanceOf(SingleLegExposureEvent);
      expect(event.positionId).toBeDefined();
      expect(event.pairId).toBe('pair-1');
      expect(event.expectedEdge).toBe(0.08);
      expect(event.filledLeg.platform).toBe(PlatformId.KALSHI);
      expect(event.filledLeg.orderId).toBeDefined();
      expect(event.filledLeg.side).toBe('buy');
      expect(event.failedLeg.platform).toBe(PlatformId.POLYMARKET);
      expect(event.failedLeg.reasonCode).toBeDefined();
      expect(event.pnlScenarios).toBeDefined();
      expect(event.pnlScenarios.closeNowEstimate).toBeDefined();
      expect(event.pnlScenarios.retryAtCurrentPrice).toBeDefined();
      expect(event.pnlScenarios.holdRiskAssessment).toContain('EXPOSED');
      expect(event.recommendedActions.length).toBeGreaterThanOrEqual(1);
    });

    it('should include pnlScenarios and recommendedActions in ExecutionError metadata', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe(
        EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      );
      const metadata = result.error!.metadata;
      expect(metadata).toBeDefined();
      expect(metadata!.pnlScenarios).toBeDefined();
      expect(metadata!.recommendedActions).toBeDefined();
      expect(Array.isArray(metadata!.recommendedActions)).toBe(true);
    });

    it('should handle order book fetch failure gracefully', async () => {
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce(makeKalshiOrderBook()) // depth check
        .mockRejectedValueOnce(new Error('API timeout')); // P&L fetch fails
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce(makePolymarketOrderBook()) // depth check
        .mockRejectedValueOnce(new Error('API timeout')); // P&L fetch fails
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);

      const singleLegCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCalls).toHaveLength(1);

      const event = singleLegCalls[0]![1] as SingleLegExposureEvent;
      expect(event.currentPrices.kalshi.bestBid).toBeNull();
      expect(event.currentPrices.polymarket.bestBid).toBeNull();
      expect(event.pnlScenarios.closeNowEstimate).toBe('UNAVAILABLE');
      expect(event.pnlScenarios.holdRiskAssessment).toContain(
        'Current market prices unavailable',
      );
    });
  });

  describe('primary leg fails', () => {
    it('should return success false and partialFill false when primary rejected', async () => {
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { status: 'rejected' }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });
  });
});
