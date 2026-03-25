import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { LegSequencingService } from './leg-sequencing.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { PlatformId } from '../../common/types/platform.type';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import {
  asContractId,
  asMatchId,
  asOpportunityId,
  asOrderId,
  asPairId,
} from '../../common/types/branded.type';
import type {
  OrderResult,
  NormalizedOrderBook,
} from '../../common/types/index';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import type { ContractPairConfig } from '../contract-matching/types/contract-pair-config.type';
import type { SingleLegContext } from './single-leg-context.type';

// ──────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────

function makePairConfig(
  overrides?: Partial<ContractPairConfig>,
): ContractPairConfig {
  return {
    polymarketContractId: 'pm-contract-1',
    polymarketClobTokenId: 'mock-clob-token-1',
    kalshiContractId: 'kalshi-contract-1',
    eventDescription: 'Test event',
    operatorVerificationTimestamp: new Date(),
    primaryLeg: 'kalshi',
    matchId: asMatchId('match-uuid-1'),
    ...overrides,
  };
}

function makeKalshiOrderBook(
  overrides?: Partial<NormalizedOrderBook>,
): NormalizedOrderBook {
  return {
    platformId: PlatformId.KALSHI,
    contractId: asContractId('kalshi-contract-1'),
    bids: [{ price: 0.44, quantity: 500 }],
    asks: [{ price: 0.45, quantity: 500 }],
    timestamp: new Date(),
    ...overrides,
  };
}

function makePolymarketOrderBook(
  overrides?: Partial<NormalizedOrderBook>,
): NormalizedOrderBook {
  return {
    platformId: PlatformId.POLYMARKET,
    contractId: asContractId('pm-contract-1'),
    bids: [{ price: 0.55, quantity: 500 }],
    asks: [{ price: 0.56, quantity: 500 }],
    timestamp: new Date(),
    ...overrides,
  };
}

function makeFilledOrder(
  platform: PlatformId,
  overrides?: Partial<OrderResult>,
): OrderResult {
  return {
    orderId: asOrderId(`order-${platform}-1`),
    platformId: platform,
    status: 'filled',
    filledQuantity: 200,
    filledPrice: 0.45,
    timestamp: new Date(),
    ...overrides,
  };
}

function makeEnriched(
  overrides?: Partial<{
    pairConfig: Partial<ContractPairConfig>;
  }>,
): EnrichedOpportunity {
  return {
    dislocation: {
      pairConfig: makePairConfig(overrides?.pairConfig),
      buyPlatformId: PlatformId.KALSHI,
      sellPlatformId: PlatformId.POLYMARKET,
      buyPrice: new Decimal('0.45'),
      sellPrice: new Decimal('0.55'),
      grossEdge: new Decimal('0.10'),
      buyOrderBook: makeKalshiOrderBook(),
      sellOrderBook: makePolymarketOrderBook(),
      detectedAt: new Date(),
    },
    netEdge: new Decimal('0.08'),
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
      buyTotalDepth: 200,
      sellTotalDepth: 200,
    },
    bestLevelNetEdge: new Decimal('0.08'),
    vwapBuyPrice: new Decimal('0.45'),
    vwapSellPrice: new Decimal('0.55'),
    buyFillRatio: 1.0,
    sellFillRatio: 1.0,
    recommendedPositionSize: null,
    annualizedReturn: new Decimal('1.56'),
    effectiveMinEdge: new Decimal('0.008'),
    enrichedAt: new Date(),
  };
}

function makeSingleLegContext(
  overrides?: Partial<SingleLegContext>,
): SingleLegContext {
  return {
    pairId: 'pair-1',
    primaryLeg: 'kalshi',
    primaryOrderId: 'order-kalshi-1',
    primaryOrder: makeFilledOrder(PlatformId.KALSHI),
    primarySide: 'buy',
    secondarySide: 'sell',
    primaryPrice: new Decimal('0.45'),
    secondaryPrice: new Decimal('0.55'),
    primarySize: 200,
    secondarySize: 200,
    enriched: makeEnriched(),
    opportunity: {
      opportunity: makeEnriched(),
      netEdge: new Decimal('0.08'),
      reservationRequest: {
        opportunityId: asOpportunityId('opp-1'),
        recommendedPositionSizeUsd: new Decimal('100'),
        pairId: asPairId('pair-1'),
        isPaper: false,
      },
    },
    errorCode: EXECUTION_ERROR_CODES.ORDER_REJECTED,
    errorMessage: 'Secondary leg rejected',
    isPaper: false,
    mixedMode: false,
    ...overrides,
  };
}

function createConfigService(overrides: Record<string, string> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  const defaults: Record<string, string> = {
    ADAPTIVE_SEQUENCING_ENABLED: 'true',
    ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS: '200',
    ...overrides,
  };
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key in defaults) return defaults[key];
      return defaultValue;
    }),
  };
}

// ──────────────────────────────────────────────────────────────
// Test Suite
// ──────────────────────────────────────────────────────────────

describe('LegSequencingService', () => {
  let service: LegSequencingService;
  let kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  let polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let positionRepo: {
    create: ReturnType<typeof vi.fn>;
  };
  let configService: ReturnType<typeof createConfigService>;
  let platformHealthService: {
    getPlatformHealth: ReturnType<typeof vi.fn>;
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
    positionRepo = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        positionId: `pos-${Date.now()}`,
        ...data,
      })),
    };
    configService = createConfigService();
    platformHealthService = {
      getPlatformHealth: vi.fn().mockReturnValue({
        platformId: 'kalshi',
        status: 'healthy',
        latencyMs: null,
        lastHeartbeat: new Date(),
        mode: 'live',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LegSequencingService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: PositionRepository, useValue: positionRepo },
        { provide: ConfigService, useValue: configService },
        { provide: PlatformHealthService, useValue: platformHealthService },
      ],
    }).compile();

    service = module.get<LegSequencingService>(LegSequencingService);
  });

  // ════════════════════════════════════════════════════════════════
  // resolveConnectors
  // ════════════════════════════════════════════════════════════════

  describe('resolveConnectors', () => {
    it('should return kalshi as primary when primaryLeg is kalshi', () => {
      const result = service.resolveConnectors('kalshi');
      expect(result.primaryConnector).toBe(kalshiConnector);
      expect(result.secondaryConnector).toBe(polymarketConnector);
      expect(result.primaryPlatform).toBe(PlatformId.KALSHI);
      expect(result.secondaryPlatform).toBe(PlatformId.POLYMARKET);
    });

    it('should return polymarket as primary when primaryLeg is polymarket', () => {
      const result = service.resolveConnectors('polymarket');
      expect(result.primaryConnector).toBe(polymarketConnector);
      expect(result.secondaryConnector).toBe(kalshiConnector);
      expect(result.primaryPlatform).toBe(PlatformId.POLYMARKET);
      expect(result.secondaryPlatform).toBe(PlatformId.KALSHI);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // determineSequencing
  // ════════════════════════════════════════════════════════════════

  describe('determineSequencing', () => {
    function mockPlatformLatencies(
      kalshiMs: number | null,
      polymarketMs: number | null,
    ) {
      platformHealthService.getPlatformHealth.mockImplementation(
        (platformId: PlatformId) => {
          if (platformId === PlatformId.KALSHI) {
            return {
              platformId: PlatformId.KALSHI,
              status: 'healthy',
              latencyMs: kalshiMs,
              lastHeartbeat: new Date(),
              mode: 'live',
            };
          }
          return {
            platformId: PlatformId.POLYMARKET,
            status: 'healthy',
            latencyMs: polymarketMs,
            lastHeartbeat: new Date(),
            mode: 'live',
          };
        },
      );
    }

    it('should override to kalshi when kalshi latency < polymarket by > threshold', () => {
      mockPlatformLatencies(100, 400);
      const result = service.determineSequencing('polymarket');
      expect(result.primaryLeg).toBe('kalshi');
      expect(result.reason).toBe('latency_override');
      expect(result.kalshiLatencyMs).toBe(100);
      expect(result.polymarketLatencyMs).toBe(400);
    });

    it('should override to polymarket when polymarket latency < kalshi by > threshold', () => {
      mockPlatformLatencies(400, 100);
      const result = service.determineSequencing('kalshi');
      expect(result.primaryLeg).toBe('polymarket');
      expect(result.reason).toBe('latency_override');
    });

    it('should use static config when latency diff <= threshold', () => {
      mockPlatformLatencies(200, 300); // diff=100 ≤ 200
      const result = service.determineSequencing('kalshi');
      expect(result.primaryLeg).toBe('kalshi');
      expect(result.reason).toBe('static_config');
    });

    it('should use static config when kalshi latency is null', () => {
      mockPlatformLatencies(null, 300);
      const result = service.determineSequencing('polymarket');
      expect(result.primaryLeg).toBe('polymarket');
      expect(result.reason).toBe('static_config');
    });

    it('should use static config when both latencies are null', () => {
      mockPlatformLatencies(null, null);
      const result = service.determineSequencing('kalshi');
      expect(result.primaryLeg).toBe('kalshi');
      expect(result.reason).toBe('static_config');
    });

    it('should use static config when ADAPTIVE_SEQUENCING_ENABLED=false', () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: unknown) => {
          if (key === 'ADAPTIVE_SEQUENCING_ENABLED') return 'false';
          return defaultValue;
        },
      );
      mockPlatformLatencies(100, 500);

      const result = service.determineSequencing('polymarket');
      expect(result.primaryLeg).toBe('polymarket');
      expect(result.reason).toBe('static_config');
      expect(result.kalshiLatencyMs).toBeNull();
    });

    it('should log sequencing override with latency details', () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const logSpy = vi.spyOn((service as any).logger as Logger, 'log');
      mockPlatformLatencies(100, 500);

      service.determineSequencing('polymarket');

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Adaptive sequencing override',
          module: 'execution',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            staticPrimaryLeg: 'polymarket',
            overridePrimaryLeg: 'kalshi',
            kalshiLatencyMs: 100,
            polymarketLatencyMs: 500,
          }),
        }),
      );
    });

    it('should not log when using static config', () => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const logSpy = vi.spyOn((service as any).logger as Logger, 'log');
      mockPlatformLatencies(200, 300); // diff ≤ threshold

      service.determineSequencing('kalshi');

      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  // ════════════════════════════════════════════════════════════════
  // handleSingleLeg
  // ════════════════════════════════════════════════════════════════

  describe('handleSingleLeg', () => {
    beforeEach(() => {
      // Setup connector mocks for order book fetches in handleSingleLeg
      kalshiConnector.getOrderBook.mockResolvedValue(makeKalshiOrderBook());
      polymarketConnector.getOrderBook.mockResolvedValue(
        makePolymarketOrderBook(),
      );
    });

    it('should create SINGLE_LEG_EXPOSED position', async () => {
      const result = await service.handleSingleLeg(makeSingleLegContext());

      expect(result.success).toBe(false);
      expect(result.partialFill).toBe(true);
      expect(result.positionId).toBeDefined();

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.status).toBe('SINGLE_LEG_EXPOSED');
    });

    it('should emit OrderFilledEvent for the filled primary leg only', async () => {
      await service.handleSingleLeg(makeSingleLegContext());

      const orderFilledCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.ORDER_FILLED,
      );
      expect(orderFilledCalls).toHaveLength(1);
    });

    it('should emit SingleLegExposureEvent with correct payload', async () => {
      await service.handleSingleLeg(makeSingleLegContext());

      const singleLegCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      expect(singleLegCalls).toHaveLength(1);

      const event = singleLegCalls[0]![1] as SingleLegExposureEvent;
      expect(event).toBeInstanceOf(SingleLegExposureEvent);
      expect(event.filledLeg).toEqual(
        expect.objectContaining({
          platform: PlatformId.KALSHI,
          side: 'buy',
        }),
      );
      expect(event.failedLeg).toEqual(
        expect.objectContaining({
          platform: PlatformId.POLYMARKET,
          reason: 'Secondary leg rejected',
        }),
      );
    });

    it('should return ExecutionError with SINGLE_LEG_EXPOSURE code', async () => {
      const result = await service.handleSingleLeg(makeSingleLegContext());

      expect(result.error?.code).toBe(
        EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      );
      expect(result.error?.severity).toBe('critical');
    });

    it('should connect kalshi order when primary is kalshi', async () => {
      await service.handleSingleLeg(
        makeSingleLegContext({ primaryLeg: 'kalshi' }),
      );

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData).toHaveProperty('kalshiOrder');
      expect(posData).not.toHaveProperty('polymarketOrder');
    });

    it('should connect polymarket order when primary is polymarket', async () => {
      await service.handleSingleLeg(
        makeSingleLegContext({ primaryLeg: 'polymarket' }),
      );

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData).toHaveProperty('polymarketOrder');
      expect(posData).not.toHaveProperty('kalshiOrder');
    });

    it('should include pnlScenarios and recommendedActions in event', async () => {
      await service.handleSingleLeg(makeSingleLegContext());

      const singleLegCalls = eventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      );
      const event = singleLegCalls[0]![1] as SingleLegExposureEvent;
      expect(event.pnlScenarios).toBeDefined();
      expect(event.recommendedActions).toBeDefined();
    });

    it('should propagate isPaper flag to position', async () => {
      await service.handleSingleLeg(makeSingleLegContext({ isPaper: true }));

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(posData.isPaper).toBe(true);
    });

    it('should include executionMetadata when provided', async () => {
      const metadata = {
        primaryLeg: 'kalshi',
        sequencingReason: 'static_config',
      };
      await service.handleSingleLeg(
        makeSingleLegContext({ executionMetadata: metadata }),
      );

      const posData = positionRepo.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;

      expect(posData.executionMetadata).toEqual(metadata);
    });
  });
});
