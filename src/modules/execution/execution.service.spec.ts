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

    it('should pass isPaper to handleSingleLeg position creation', async () => {
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
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );

      await service.execute(makeOpportunity(), makeReservation());

      // Primary order created with isPaper
      expect(orderRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
      // Single-leg position created with isPaper
      expect(positionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isPaper: true }),
      );
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

    it('should cap primary to available depth and execute both legs at reduced size', async () => {
      // Primary has only 100 contracts (idealSize=222, 100 < 222 but 100 >= ceil(222*0.25)=56)
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

      // Should cap primary to available depth = 100
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      // Both legs execute successfully
      expect(result.success).toBe(true);
      expect(result.partialFill).toBe(false);
      expect(result.actualCapitalUsed).toBeDefined();
      // primary: 100 * 0.45 = 45, secondary: 181 * 0.55 = 99.55 → total = 144.55
      // Note: total can exceed single-leg reservation because each leg divides reservedCapitalUsd independently
      const expectedPrimary = new Decimal(100).mul('0.45'); // 45
      const expectedSecondary = new Decimal(181).mul('0.55'); // 99.55
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expectedPrimary.plus(expectedSecondary).toNumber(),
        2,
      );
      // Verify primary was capped (100 < idealSize 222)
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 100 }),
      );
      // Verify secondary was NOT capped (181 < 500 depth)
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 181 }),
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

    it('should reject when secondary depth below threshold', async () => {
      // Primary OK, secondary has only 5 contracts (secondaryIdealSize=floor(100/0.55)=181, minFillSize=ceil(181*0.25)=46)
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.55, quantity: 5 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );

      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true); // single-leg
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      );
    });

    it('should compute secondary ideal size independently from secondary price', async () => {
      // primaryPrice=0.10, secondaryPrice=0.90
      // idealSize = floor(100/0.10) = 1000
      // secondaryIdealSize = floor(100/0.90) = 111
      const opp = makeOpportunity({
        buyPrice: new Decimal('0.10'),
        sellPrice: new Decimal('0.90'),
      });
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.1, quantity: 2000 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue({
        ...makePolymarketOrderBook(),
        bids: [{ price: 0.9, quantity: 200 }],
      });
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );
      polymarketConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.POLYMARKET),
      );

      const result = await service.execute(opp, makeReservation());

      expect(result.success).toBe(true);
      // Primary submits 1000, secondary submits 111
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 1000 }),
      );
      expect(polymarketConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 111 }),
      );
    });

    it('should handle asymmetric depth with different sizes per leg', async () => {
      // Primary depth=200, secondary depth=150
      // idealSize=222, secondaryIdealSize=181
      // primary capped to 200, secondary capped to 150
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
      expect(kalshiConnector.submitOrder).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 200 }),
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

    it('should invoke single-leg when secondary ideal size is 0', async () => {
      // reservation $1, secondaryPrice $5 → secondaryIdealSize = 0
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
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
      );

      const result = await service.execute(opp, reservation);

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
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

    it('should reject with EDGE_ERODED_BY_SIZE when gas fraction quadruples', async () => {
      // idealSize=222, but primary capped to 56 (just above min fill)
      // Gas fraction was 0.01 at 222 contracts, now 0.01*(222/56) = 0.0396
      // Net edge was 0.015, adjusted = 0.015 + 0.01 - 0.0396 = -0.0146 < 0.008
      kalshiConnector.getOrderBook.mockResolvedValue({
        ...makeKalshiOrderBook(),
        asks: [{ price: 0.45, quantity: 56 }],
      });
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
      kalshiConnector.submitOrder.mockResolvedValue(
        makeFilledOrder(PlatformId.KALSHI),
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
      expect(result.partialFill).toBe(true); // single-leg
      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      );
      // Verify EDGE_ERODED_BY_SIZE is preserved as reasonCode in error metadata
      expect(result.error?.metadata).toEqual(
        expect.objectContaining({
          reasonCode: EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
        }),
      );
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

    it('should invoke single-leg when gasFraction is missing during edge re-validation', async () => {
      // Primary capped → edge re-validation runs → gasFraction undefined → single-leg
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

      // Default feeBreakdown has no gasFraction
      const result = await service.execute(
        makeOpportunity(),
        makeReservation(),
      );

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true); // single-leg
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

    it('should return actualCapitalUsed reflecting both legs on success', async () => {
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
      // idealSize=222, secondaryIdealSize=181
      // primaryCapital = 222 * 0.45 = 99.9
      // secondaryCapital = 181 * 0.55 = 99.55
      // total ≈ 199.45
      const expected = new Decimal(222)
        .mul('0.45')
        .plus(new Decimal(181).mul('0.55'));
      expect(result.actualCapitalUsed!.toNumber()).toBeCloseTo(
        expected.toNumber(),
        2,
      );
    });
  });
});
