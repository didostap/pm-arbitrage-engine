import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  SingleLegExposureEvent,
  DepthCheckFailedEvent,
} from '../../common/events/execution.events';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
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
    matchId: 'match-uuid-1',
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
      isPaper: false,
    },
  };
}

function makeReservation(): BudgetReservation {
  return {
    reservationId: 'res-1',
    opportunityId: 'opp-1',
    pairId: 'pair-1',
    isPaper: false,
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

function createConfigService(overrides: Record<string, string> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  const defaults: Record<string, string> = {
    EXECUTION_MIN_FILL_RATIO: '0.25',
    DETECTION_MIN_EDGE_THRESHOLD: '0.008',
    ...overrides,
  };
  return {
    get: vi.fn((key: string, defaultValue?: string) => {
      return defaults[key] ?? defaultValue;
    }),
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
  let complianceValidator: {
    validate: ReturnType<typeof vi.fn>;
  };
  let configService: ReturnType<typeof createConfigService>;

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
    complianceValidator = {
      validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
    };
    configService = createConfigService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderRepository, useValue: orderRepo },
        { provide: PositionRepository, useValue: positionRepo },
        { provide: ComplianceValidatorService, useValue: complianceValidator },
        { provide: ConfigService, useValue: configService },
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
    it('should return clean rejection when secondary depth fails (pre-submission check)', async () => {
      // Both depths checked BEFORE any submission (6.5.5h flow)
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
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
      expect(result.partialFill).toBe(false); // Clean rejection — no orders submitted
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
      // No orders should have been submitted
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
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

  describe('isPaper flag propagation', () => {
    it('should set isPaper false when both connectors are live (no mode field)', async () => {
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

      // Verify orders created with isPaper: false
      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: false }));
      }
      // Verify position created with isPaper: false
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: false }),
      );
    });

    it('should set isPaper true when primary connector health has mode paper', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
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

      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
    });

    it('should set isPaper true when secondary connector health has mode paper', async () => {
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
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

      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
    });

    it('should return clean rejection when secondary depth fails (no single-leg with paper)', async () => {
      kalshiConnector.getHealth.mockReturnValue({
        platformId: PlatformId.KALSHI,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        asks: [],
        bids: [],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      // Clean rejection — secondary depth checked before any submission
      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should set isPaper on pending secondary order persist before handleSingleLeg', async () => {
      polymarketConnector.getHealth.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        status: 'healthy',
        lastHeartbeat: new Date(),
        latencyMs: 50,
        mode: 'paper',
      });
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      // Secondary returns pending (not filled)
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, {
          status: 'pending',
          filledQuantity: 0,
          filledPrice: 0,
        }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);

      // Should have 2 order creates: primary + pending secondary
      expect(orderRepo.create).toHaveBeenCalledTimes(2);
      // Both orders should have isPaper: true
      for (const call of orderRepo.create.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ isPaper: true }));
      }
      // Pending secondary order should have status PENDING
      const secondCall = orderRepo.create.mock.calls[1]![0] as Record<
        string,
        unknown
      >;
      expect(secondCall.status).toBe('PENDING');
      // Position should also have isPaper: true
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
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

  describe('compliance gate', () => {
    it('should call compliance check before depth verification', async () => {
      // Compliance blocks — depth should never be checked
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'assassination',
            rule: 'Blocked category: assassination',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      await service.execute(
        makeOpportunity({
          pairConfig: { eventDescription: 'Assassination contract' },
        }),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalled();
      expect(kalshiConnector.getOrderBook).not.toHaveBeenCalled();
    });

    it('should return ExecutionError(2009) on compliance block', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'terrorism',
            rule: 'Blocked category: terrorism',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED);
    });

    it('should proceed to depth verification on compliance approval', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: true,
        violations: [],
      });

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

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalled();
      expect(kalshiConnector.getOrderBook).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should pass correct context to compliance validator', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'test',
            rule: 'test',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      await service.execute(
        makeOpportunity({
          pairConfig: {
            eventDescription: 'Test event description',
            kalshiContractId: 'kalshi-c1',
            polymarketContractId: 'pm-c1',
          },
        }),
        makeReservation(),
      );

      expect(complianceValidator.validate).toHaveBeenCalledWith(
        expect.objectContaining({
          pairId: 'pair-1',
          opportunityId: 'opp-1',
          primaryPlatform: PlatformId.KALSHI,
          secondaryPlatform: PlatformId.POLYMARKET,
          eventDescription: 'Test event description',
          kalshiContractId: 'kalshi-c1',
          polymarketContractId: 'pm-c1',
        }),
        false,
        false,
      );
    });

    it('should not trigger single-leg handling on compliance failure', async () => {
      complianceValidator.validate.mockReturnValue({
        approved: false,
        violations: [
          {
            platform: 'KALSHI',
            category: 'terrorism',
            rule: 'Blocked category: terrorism',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      // No orders should have been submitted
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
      // No single-leg events emitted
      const singleLegEmit = eventEmitter.emit.mock.calls.find(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegEmit).toBeUndefined();
    });

    it('should fail safely when compliance validator throws', async () => {
      complianceValidator.validate.mockImplementation(() => {
        throw new Error('Unexpected compliance error');
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED);
      expect(result.error?.message).toContain('Compliance validation error');
    });
  });

  describe('verifyDepth — error handling (AC #1)', () => {
    it('should return false when connector.getOrderBook throws', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
    });

    it('should emit DepthCheckFailedEvent when getOrderBook throws', async () => {
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const depthFailedCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DEPTH_CHECK_FAILED,
      );
      expect(depthFailedCalls).toHaveLength(1);

      const event = depthFailedCalls[0]![1] as DepthCheckFailedEvent;
      expect(event).toBeInstanceOf(DepthCheckFailedEvent);
      expect(event.platform).toBe(PlatformId.KALSHI);
      expect(event.contractId).toBe('kalshi-contract-1');
      expect(event.side).toBe('buy');
      expect(event.errorType).toBe('PlatformApiError');
      expect(event.errorMessage).toBe('Rate limit exceeded');
    });

    it('should emit structured warning log when getOrderBook throws', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const warnSpy = vi.spyOn((service as any).logger as Logger, 'warn');
      kalshiConnector.getOrderBook.mockRejectedValue(
        new PlatformApiError(
          1002,
          'Rate limit exceeded',
          PlatformId.KALSHI,
          'warning',
        ),
      );

      await service.execute(makeOpportunity(), makeReservation());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Depth query failed',
          module: 'execution',
          platform: PlatformId.KALSHI,
          contractId: 'kalshi-contract-1',
          side: 'buy',
          errorMessage: 'Rate limit exceeded',
        }),
      );
    });

    it('should emit DepthCheckFailedEvent for secondary depth failure', async () => {
      // Primary depth OK + fills
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      // Secondary depth throws
      polymarketConnector.getOrderBook.mockRejectedValue(
        new Error('Connection timeout'),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const depthFailedCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DEPTH_CHECK_FAILED,
      );
      expect(depthFailedCalls).toHaveLength(1);

      const event = depthFailedCalls[0]![1] as DepthCheckFailedEvent;
      expect(event.platform).toBe(PlatformId.POLYMARKET);
      expect(event.contractId).toBe('pm-contract-1');
      expect(event.side).toBe('sell');
      expect(event.errorType).toBe('Error');
      expect(event.errorMessage).toBe('Connection timeout');
    });
  });

  describe('EXECUTION_MIN_FILL_RATIO config validation', () => {
    it('should use default value 0.25 when not configured', async () => {
      const cs = createConfigService();
      const mod = await Test.createTestingModule({
        providers: [
          ExecutionService,
          { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
          {
            provide: POLYMARKET_CONNECTOR_TOKEN,
            useValue: polymarketConnector,
          },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: OrderRepository, useValue: orderRepo },
          { provide: PositionRepository, useValue: positionRepo },
          {
            provide: ComplianceValidatorService,
            useValue: complianceValidator,
          },
          { provide: ConfigService, useValue: cs },
        ],
      }).compile();

      const svc = mod.get<ExecutionService>(ExecutionService);
      expect(svc).toBeDefined();
    });

    it('should accept custom value from config', async () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '0.5' });
      const mod = await Test.createTestingModule({
        providers: [
          ExecutionService,
          { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
          {
            provide: POLYMARKET_CONNECTOR_TOKEN,
            useValue: polymarketConnector,
          },
          { provide: EventEmitter2, useValue: eventEmitter },
          { provide: OrderRepository, useValue: orderRepo },
          { provide: PositionRepository, useValue: positionRepo },
          {
            provide: ComplianceValidatorService,
            useValue: complianceValidator,
          },
          { provide: ConfigService, useValue: cs },
        ],
      }).compile();

      const svc = mod.get<ExecutionService>(ExecutionService);
      expect(svc).toBeDefined();
    });

    it('should throw on invalid value 0', () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '0' });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on invalid value > 1', () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '1.5' });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on NaN value', () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: 'abc' });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on negative value', () => {
      const cs = createConfigService({ EXECUTION_MIN_FILL_RATIO: '-0.1' });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid EXECUTION_MIN_FILL_RATIO');
    });

    it('should throw on invalid DETECTION_MIN_EDGE_THRESHOLD (non-numeric)', () => {
      const cs = createConfigService({
        DETECTION_MIN_EDGE_THRESHOLD: 'not-a-number',
      });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid DETECTION_MIN_EDGE_THRESHOLD');
    });

    it('should throw on invalid DETECTION_MIN_EDGE_THRESHOLD (zero)', () => {
      const cs = createConfigService({ DETECTION_MIN_EDGE_THRESHOLD: '0' });
      expect(
        () =>
          new ExecutionService(
            kalshiConnector,
            polymarketConnector,
            eventEmitter as unknown as EventEmitter2,
            orderRepo as unknown as OrderRepository,
            positionRepo as unknown as PositionRepository,
            complianceValidator as unknown as ComplianceValidatorService,
            cs as unknown as ConfigService,
          ),
      ).toThrow('Invalid DETECTION_MIN_EDGE_THRESHOLD');
    });
  });

  describe('depth-aware sizing', () => {
    it('should execute at full ideal size when depth is sufficient', async () => {
      // Default: qty=500 > idealSize=222 (100/0.45), so no capping
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

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      // idealSize = floor(100/0.45) = 222
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 222 }),
      );
      // actualCapitalUsed should reflect both legs
      expect(result.actualCapitalUsed).toBeDefined();
    });

    it('should cap primary to available depth and equalize both legs', async () => {
      // Primary has only 100 contracts (idealSize=222, 100 < 222 but 100 >= ceil(222*0.25)=56)
      // Secondary ideal: floor(100/(1-0.55))=222, depth 500 → capped 222
      // Equalized: min(100, 222) = 100. Both legs at 100.
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      // Provide gasFraction so edge re-validation can pass
      const opp = makeOpportunity({ netEdge: new Decimal('0.08') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const reservation = makeReservation();
      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(false);
      // Both legs equalized to 100
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      // Capital: buy 100*0.45=45, sell 100*(1-0.55)=45 → total 90
      expect(result.actualCapitalUsed).toBeDefined();
      const expected = new Decimal(100)
        .mul('0.45')
        .plus(new Decimal(100).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });

    it('should reject when primary depth below threshold', async () => {
      // Primary has only 10 contracts (idealSize=222, minFillSize=ceil(222*0.25)=56, 10 < 56)
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 10 }],
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
      expect(result.actualCapitalUsed).toBeUndefined();
    });

    it('should reject cleanly when secondary depth below threshold (pre-submission)', async () => {
      // Primary OK, secondary has only 5 contracts
      // secondaryIdealSize=floor(100/(1-0.55))=222, minFillSize=ceil(222*0.25)=56, 5 < 56
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 5 }],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection — pre-submission
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should compute secondary ideal size with collateral-aware formula', async () => {
      // primaryPrice=0.10 (buy), secondaryPrice=0.90 (sell)
      // Buy ideal: floor(100/0.10) = 1000
      // Sell ideal: floor(100/(1-0.90)) = floor(100/0.10) = 1000
      // Depth: primary 2000, secondary 300 → capped: 1000, 300
      // minFillSize = ceil(1000*0.25) = 250. Secondary 300 >= 250 → passes
      // Equalized: min(1000, 300) = 300
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.10'),
        sellPrice: new Decimal('0.90'),
        netEdge: new Decimal('0.08'),
      });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.1, quantity: 2000 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.9, quantity: 300 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      // Both equalized to 300
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 300 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 300 }),
      );
    });

    it('should equalize asymmetric depth to smaller leg', async () => {
      // Primary depth=200, secondary depth=150
      // Buy ideal=222, sell ideal=floor(100/0.45)=222
      // primary capped to 200, secondary capped to 150
      // Equalized: min(200, 150) = 150
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 200 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 150 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      // Need gasFraction for edge re-validation since both sizes are reduced
      const opp = makeOpportunity({ netEdge: new Decimal('0.08') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.002'),
        totalCosts: new Decimal('0.022'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      // Both equalized to 150
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 150 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 150 }),
      );
    });

    it('should reject when ideal size is 0 (tiny reservation, high price)', async () => {
      // reservation $1, targetPrice $5 → idealSize = floor(1/5) = 0
      const opp = makeOpportunity({
        buyPrice: new Decimal('5.00'),
        sellPrice: new Decimal('5.10'),
      });
      const reservation = {
        ...makeReservation(),
        reservedCapitalUsd: new Decimal('1'),
      };

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      );
      expect(result.error?.message).toContain('Ideal position size is 0');
    });

    it('should reject cleanly when secondary ideal size is 0 (pre-submission)', async () => {
      // reservation $1, sell @ $5 → collateral = 1-5 = -4 → idealSize ≤ 0
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('5.00'),
      });
      const reservation = {
        ...makeReservation(),
        reservedCapitalUsd: new Decimal('1'),
      };

      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.5, quantity: 500 }],
      });

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection — pre-submission
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should pass edge re-validation when size reduced but edge still above threshold', async () => {
      // size reduced to 50% but edge still comfortable
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 111 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.08') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'), // Small gas fraction → won't erode much
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
    });

    it('should reject cleanly with EDGE_ERODED_BY_SIZE when gas fraction quadruples (pre-submission)', async () => {
      // idealSize=222, but primary capped to 56 (just above min fill)
      // Equalized to 56. Gas fraction was 0.01 at 222, now quadruples → edge below threshold
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.015') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.01'), // 1% of position at detection size
        totalCosts: new Decimal('0.03'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection — pre-submission
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should skip edge re-validation when no size was capped', async () => {
      // Full depth available — no capping → no edge re-validation
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

      // No gasFraction set — if edge re-validation ran, it would fail
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
    });

    it('should reject cleanly when gasFraction is missing during edge re-validation (pre-submission)', async () => {
      // Primary capped to 100 → equalized → edge re-validation runs → gasFraction undefined → clean rejection
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      // Default feeBreakdown has no gasFraction
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection — pre-submission
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should not leak capital on failure after depth cap', async () => {
      // Primary capped, secondary fails → reservation should be untouched
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 100 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );

      const reservation = makeReservation();
      const originalCapital = reservation.reservedCapitalUsd.toString();

      const result = await service.execute(makeOpportunity(), reservation);

      // Failure path (gasFraction missing → single-leg)
      expect(result.success).toBe(false);
      // Reservation capital should be UNCHANGED
      expect(reservation.reservedCapitalUsd.toString()).toBe(originalCapital);
      // actualCapitalUsed should NOT be set on failure
      expect(result.actualCapitalUsed).toBeUndefined();
    });

    it('should return collateral-aware actualCapitalUsed reflecting both legs on success', async () => {
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

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(result.actualCapitalUsed).toBeDefined();
      // Both legs equalized to 222
      // Buy capital = 222 * 0.45 = 99.9
      // Sell capital (collateral) = 222 * (1-0.55) = 222 * 0.45 = 99.9
      // total = 199.8
      const expected = new Decimal(222)
        .mul('0.45')
        .plus(new Decimal(222).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });
  });

  describe('equal leg sizing (collateral-aware + equalization)', () => {
    function setupHappyPath() {
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
    }

    it('should use collateral-aware formula for sell legs: floor(budget / (1 - price))', async () => {
      // Default: kalshi buys @ 0.45, polymarket sells @ 0.55
      // Buy: floor(100/0.45) = 222
      // Sell: floor(100/(1-0.55)) = floor(100/0.45) = 222 (NOT floor(100/0.55)=181)
      // Equalized: min(222, 222) = 222
      setupHappyPath();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      // Both legs should submit at equalized size = 222
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 222 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 222 }),
      );
    });

    it('should produce different sell sizes than buy-only formula', async () => {
      // Sell @ 0.21 → old: floor(100/0.21)=476, new: floor(100/0.79)=126
      // Buy @ 0.17 → floor(100/0.17)=588
      // Equalized: min(588, 126) = 126
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.17'),
        sellPrice: new Decimal('0.21'),
        buyPlatformId: PlatformId.KALSHI,
        sellPlatformId: PlatformId.POLYMARKET,
        netEdge: new Decimal('0.08'),
      });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.001'),
        totalCosts: new Decimal('0.021'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.17, quantity: 1000 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.21, quantity: 1000 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      // Both legs at equalized 126 (not 588 vs 476)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 126 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 126 }),
      );
    });

    it('should equalize to smaller leg when depths differ asymmetrically', async () => {
      // Buy @ 0.45 → ideal 222, depth 200 → capped 200
      // Sell @ 0.55 → ideal floor(100/0.45)=222, depth 150 → capped 150
      // Equalized: min(200, 150) = 150
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 200 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 150 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      // Provide gasFraction for edge re-validation
      const opp = makeOpportunity({ netEdge: new Decimal('0.08') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.002'),
        totalCosts: new Decimal('0.022'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      // BOTH legs submit at 150 (equalized)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 150 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 150 }),
      );
    });

    it('should persist position with equal sizes for both legs', async () => {
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const positionData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const sizes = positionData.sizes as {
        kalshi: string;
        polymarket: string;
      };
      expect(sizes.kalshi).toBe(sizes.polymarket);
    });

    it('should compute actualCapitalUsed with collateral-aware formula', async () => {
      setupHappyPath();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      // Default: buy @ 0.45, sell @ 0.55, equalized to 222
      // Buy capital: 222 * 0.45 = 99.9
      // Sell capital (collateral): 222 * (1 - 0.55) = 222 * 0.45 = 99.9
      // Total: 199.8
      const expected = new Decimal(222)
        .mul('0.45')
        .plus(new Decimal(222).mul('0.45'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });

    it('should check both depths BEFORE submitting any orders', async () => {
      // Secondary depth fails → clean rejection (no single-leg since primary not submitted)
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 5 }],
      });

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection, NOT single-leg
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(polymarketConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject cleanly when secondary ideal size is 0 (pre-submission)', async () => {
      // Sell @ very high price → collateral = 1-price ≈ 0 → ideal = 0
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('0.99'),
      });
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.5, quantity: 500 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.99, quantity: 500 }],
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection, NOT single-leg
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject when edge eroded at equalized size (pre-submission)', async () => {
      // Primary depth 56 (barely above minFill), edge marginal
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );

      const opp = makeOpportunity({ netEdge: new Decimal('0.015') });
      const enriched = opp.opportunity as EnrichedOpportunity;
      enriched.feeBreakdown = {
        buyFeeCost: new Decimal('0.01'),
        sellFeeCost: new Decimal('0.01'),
        gasFraction: new Decimal('0.01'),
        totalCosts: new Decimal('0.03'),
        buyFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        sellFeeSchedule: {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-assignment
      };

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false); // Clean rejection, NOT single-leg
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
      );
    });

    it('should guarantee profit under YES outcome with equal sizes', async () => {
      // Buy @ 0.45 (kalshi), Sell @ 0.55 (polymarket), equalized 222
      // YES outcome (contract resolves to 1.0):
      //   Buy profit: (1.0 - 0.45) * 222 = 122.1
      //   Sell loss: (1.0 - 0.55) * 222 = -99.9
      //   Net: 122.1 - 99.9 = 22.2 (positive)
      setupHappyPath();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const kalshiCall = kalshiConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const pmCall = polymarketConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const legSize = kalshiCall.quantity;
      expect(legSize).toBe(pmCall.quantity); // Equal sizes

      const buyPrice = new Decimal('0.45');
      const sellPrice = new Decimal('0.55');
      // YES outcome: buy wins (1-buyPrice)*size, sell loses (1-sellPrice)*size
      const yesProfit = new Decimal(1)
        .minus(buyPrice)
        .mul(legSize)
        .minus(new Decimal(1).minus(sellPrice).mul(legSize));
      expect(yesProfit.toNumber()).toBeGreaterThan(0);
    });

    it('should guarantee profit under NO outcome with equal sizes', async () => {
      // NO outcome (contract resolves to 0):
      //   Buy loss: 0.45 * 222 = -99.9 (lose cost)
      //   Sell profit: 0.55 * 222 = 122.1 (keep premium)
      //   Net: 122.1 - 99.9 = 22.2 (positive)
      setupHappyPath();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      const kalshiCall = kalshiConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const pmCall = polymarketConnector.submitOrder.mock.calls[0]?.[0] as {
        quantity: number;
      };
      const legSize = kalshiCall.quantity;
      expect(legSize).toBe(pmCall.quantity);

      const buyPrice = new Decimal('0.45');
      const sellPrice = new Decimal('0.55');
      // NO outcome: buy loses buyPrice*size, sell gains sellPrice*size
      const noProfit = sellPrice.mul(legSize).minus(buyPrice.mul(legSize));
      expect(noProfit.toNumber()).toBeGreaterThan(0);
    });

    it('should not change equalization when both legs have identical ideal sizes and depth', async () => {
      // Symmetric case: buy @ 0.45, sell @ 0.55
      // Buy ideal: floor(100/0.45) = 222
      // Sell ideal: floor(100/(1-0.55)) = floor(100/0.45) = 222
      // Both depth 500 > 222 → no capping → equalized = 222
      setupHappyPath();

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(true);
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 222 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 222 }),
      );
    });

    it('should handle single-leg when primary fills but secondary submission fails', async () => {
      // Primary fills, secondary throws → single-leg exposure (primary already submitted)
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockRejectedValue(
        new Error('Network timeout'),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true); // Single-leg since primary was submitted
      expect(result.positionId).toBeDefined();
    });

    it('should handle single-leg when primary fills but secondary is rejected', async () => {
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
    });

    it('should reject when sell price = 1.0 (zero collateral divisor)', async () => {
      // Sell @ 1.0 → collateral = 1 - 1.0 = 0 → division by zero
      // Primary is buy (Kalshi), secondary is sell (Polymarket) at 1.0
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('1.00'),
      });
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.5, quantity: 500 }],
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
      );
      expect(result.error?.message).toContain(
        'Non-positive collateral divisor',
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    it('should reject when primary sell price = 1.0 (zero collateral divisor)', async () => {
      // Swap legs: primary is sell (Kalshi) at 1.0
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.50'),
        sellPrice: new Decimal('1.00'),
        buyPlatformId: PlatformId.POLYMARKET,
        sellPlatformId: PlatformId.KALSHI,
      });

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(false);
      expect(result.error?.message).toContain(
        'Non-positive collateral divisor',
      );
      expect(kalshiConnector.submitOrder).not.toHaveBeenCalled();
    });

    // NOTE: LEG_SIZE_MISMATCH runtime invariant (targetSize !== secondarySize) is
    // unreachable by construction — equalization sets both to equalizedSize 3 lines
    // above the check. It exists as a regression safety net. The positive path
    // (sizes ARE equal) is implicitly verified by every successful execution test.
  });

  describe('close-side price capture (6.5.5i)', () => {
    function setupHappyPath() {
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
    }

    it('should persist entry close prices from close-side order books', async () => {
      // Kalshi buy@0.45 → close side is best bid (0.44)
      // Polymarket sell@0.55 → close side is best ask (0.56)
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // Primary is kalshi (buy) → close price = best bid = 0.44
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.44, 4);
      // Secondary is polymarket (sell) → close price = best ask = 0.56
      expect(posData.entryClosePricePolymarket).toBeCloseTo(0.56, 4);
    });

    it('should persist entry fee rates at close prices', async () => {
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // Both fee schedules: takerFeePercent=2.0, no takerFeeForPrice
      // FinancialMath.calculateTakerFeeRate: 2.0/100 = 0.02
      expect(posData.entryKalshiFeeRate).toBeCloseTo(0.02, 4);
      expect(posData.entryPolymarketFeeRate).toBeCloseTo(0.02, 4);
    });

    it('should fall back to fill price when close-side book is empty', async () => {
      // Kalshi buy@0.45 → close side = bids, make bids empty
      // Call 1: depth check (normal book), Call 2: close-side capture (empty bids)
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce(makeKalshiOrderBook()) // depth check
        .mockResolvedValue({
          ...makeKalshiOrderBook(),
          bids: [], // empty close side for buy leg
        });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { filledPrice: 0.45 }),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { filledPrice: 0.55 }),
      );

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // Kalshi close price falls back to fill price (0.45) since bids empty
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.45, 4);
    });

    it('should fall back to fill prices when order book fetch fails', async () => {
      // First 2 calls succeed (depth checks), then close-side capture fails
      kalshiConnector.getOrderBook
        .mockResolvedValueOnce(makeKalshiOrderBook()) // depth check
        .mockRejectedValue(new Error('Network timeout'));
      polymarketConnector.getOrderBook
        .mockResolvedValueOnce(makePolymarketOrderBook()) // depth check
        .mockRejectedValue(new Error('Rate limited'));
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI, { filledPrice: 0.45 }),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET, { filledPrice: 0.55 }),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      // Position creation should still succeed
      expect(result.success).toBe(true);
      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // Falls back to fill prices
      expect(posData.entryClosePriceKalshi).toBeCloseTo(0.45, 4);
      expect(posData.entryClosePricePolymarket).toBeCloseTo(0.55, 4);
    });

    it('should compute fee rates at close prices not fill prices', async () => {
      // Use dynamic Kalshi fee schedule (takerFeeForPrice callback)
      kalshiConnector.getFeeSchedule.mockReturnValue({
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 7.0,
        description: 'Kalshi dynamic fee schedule',
        takerFeeForPrice: (price: number) => {
          // Dynamic fee: rate scales with price distance from 0.5
          return Math.min(0.07, 0.02 + 0.1 * Math.abs(price - 0.5));
        },
      });

      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      // Kalshi close price = 0.44 (best bid), dynamic fee at 0.44:
      // 0.02 + 0.1 * |0.44 - 0.5| = 0.02 + 0.006 = 0.026
      expect(posData.entryKalshiFeeRate).toBeCloseTo(0.026, 4);
    });

    it('should capture all four fields on position record', async () => {
      setupHappyPath();

      await service.execute(makeOpportunity(), makeReservation());

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData).toHaveProperty('entryClosePriceKalshi');
      expect(posData).toHaveProperty('entryClosePricePolymarket');
      expect(posData).toHaveProperty('entryKalshiFeeRate');
      expect(posData).toHaveProperty('entryPolymarketFeeRate');
      // All should be numbers (Decimal.toNumber())
      expect(typeof posData.entryClosePriceKalshi).toBe('number');
      expect(typeof posData.entryClosePricePolymarket).toBe('number');
      expect(typeof posData.entryKalshiFeeRate).toBe('number');
      expect(typeof posData.entryPolymarketFeeRate).toBe('number');
    });
  });
});
