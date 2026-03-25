/**
 * Shared test factories and setup helpers for ExecutionService spec files.
 *
 * Extracted to avoid duplicating boilerplate across
 * execution.service.spec.ts, execution-sizing.spec.ts, and execution-metadata.spec.ts.
 */
import { vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { ExecutionService } from './execution.service';
import { LegSequencingService } from './leg-sequencing.service';
import { DepthAnalysisService } from './depth-analysis.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import { DataDivergenceService } from '../data-ingestion/data-divergence.service';
import { createMockPlatformConnector } from '../../test/mock-factories.js';
import { PlatformId } from '../../common/types/platform.type';
import {
  asContractId,
  asMatchId,
  asOpportunityId,
  asOrderId,
  asPairId,
  asReservationId,
} from '../../common/types/branded.type';
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

export function makePairConfig(
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

export function makeKalshiOrderBook(): NormalizedOrderBook {
  // Kalshi buy side: asks at ≤0.45 with qty ≥223 (100/0.45≈222)
  return {
    platformId: PlatformId.KALSHI,
    contractId: asContractId('kalshi-contract-1'),
    bids: [{ price: 0.44, quantity: 500 }],
    asks: [{ price: 0.45, quantity: 500 }],
    timestamp: new Date(),
  };
}

export function makePolymarketOrderBook(): NormalizedOrderBook {
  // Polymarket sell side: bids at ≥0.55 with qty ≥182 (100/0.55≈181)
  return {
    platformId: PlatformId.POLYMARKET,
    contractId: asContractId('pm-contract-1'),
    bids: [{ price: 0.55, quantity: 500 }],
    asks: [{ price: 0.56, quantity: 500 }],
    timestamp: new Date(),
  };
}

export function makeEnriched(
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

export function makeOpportunity(
  enrichedOverrides?: Parameters<typeof makeEnriched>[0],
): RankedOpportunity {
  return {
    opportunity: makeEnriched(enrichedOverrides),
    netEdge: new Decimal('0.08'),
    reservationRequest: {
      opportunityId: asOpportunityId('opp-1'),
      recommendedPositionSizeUsd: new Decimal('100'),
      pairId: asPairId('pair-1'),
      isPaper: false,
    },
  };
}

export function makeReservation(): BudgetReservation {
  return {
    reservationId: asReservationId('res-1'),
    opportunityId: asOpportunityId('opp-1'),
    pairId: asPairId('pair-1'),
    isPaper: false,
    reservedPositionSlots: 1,
    reservedCapitalUsd: new Decimal('100'),
    correlationExposure: new Decimal('0'),
    createdAt: new Date(),
  };
}

export function makeFilledOrder(
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

export function createConfigService(overrides: Record<string, string> = {}): {
  get: ReturnType<typeof vi.fn>;
} {
  const defaults: Record<string, string> = {
    EXECUTION_MIN_FILL_RATIO: '0.25',
    DETECTION_MIN_EDGE_THRESHOLD: '0.008',
    // Low ratio so existing per-leg tests aren't affected by dual-leg gate;
    // the ATDD tests in dual-leg-depth-gate.spec.ts cover ratio=1.0 behavior.
    DUAL_LEG_MIN_DEPTH_RATIO: '0.01',
    ...overrides,
  };
  return {
    get: vi.fn((key: string, defaultValue?: string) => {
      return defaults[key] ?? defaultValue;
    }),
  };
}

/** Standard mock shapes returned by createExecutionTestContext(). */
export interface ExecutionTestContext {
  service: ExecutionService;
  kalshiConnector: ReturnType<typeof createMockPlatformConnector>;
  polymarketConnector: ReturnType<typeof createMockPlatformConnector>;
  eventEmitter: { emit: ReturnType<typeof vi.fn> };
  orderRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  positionRepo: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  complianceValidator: { validate: ReturnType<typeof vi.fn> };
  configService: ReturnType<typeof createConfigService>;
  platformHealthService: { getPlatformHealth: ReturnType<typeof vi.fn> };
  dataDivergenceService: { getDivergenceStatus: ReturnType<typeof vi.fn> };
}

/**
 * Creates the full NestJS test module with all mocks wired up.
 * Call in beforeEach to get a fresh ExecutionTestContext each test.
 */
export async function createExecutionTestContext(
  configOverrides?: Record<string, string>,
): Promise<ExecutionTestContext> {
  const kalshiConnector = createMockPlatformConnector(PlatformId.KALSHI, {
    getFeeSchedule: vi.fn().mockReturnValue({
      platformId: PlatformId.KALSHI,
      makerFeePercent: 0,
      takerFeePercent: 2.0,
      description: 'Kalshi fee schedule',
    }),
  });
  const polymarketConnector = createMockPlatformConnector(
    PlatformId.POLYMARKET,
    {
      getFeeSchedule: vi.fn().mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        makerFeePercent: 0,
        takerFeePercent: 2.0,
        description: 'Polymarket fee schedule',
      }),
    },
  );
  const eventEmitter = { emit: vi.fn() };
  const orderRepo = {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      orderId: `order-${Date.now()}`,
      ...data,
    })),
    findById: vi.fn(),
  };
  const positionRepo = {
    create: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      positionId: `pos-${Date.now()}`,
      ...data,
    })),
    findById: vi.fn(),
  };
  const complianceValidator = {
    validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
  };
  const configService = createConfigService(configOverrides);
  const platformHealthService = {
    getPlatformHealth: vi.fn().mockReturnValue({
      platformId: 'kalshi',
      status: 'healthy',
      latencyMs: null,
      lastHeartbeat: new Date(),
      mode: 'live',
    }),
  };
  const dataDivergenceService = {
    getDivergenceStatus: vi.fn().mockReturnValue('normal'),
  };

  const module = await Test.createTestingModule({
    providers: [
      ExecutionService,
      LegSequencingService,
      DepthAnalysisService,
      { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
      { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
      { provide: EventEmitter2, useValue: eventEmitter },
      { provide: OrderRepository, useValue: orderRepo },
      { provide: PositionRepository, useValue: positionRepo },
      { provide: ComplianceValidatorService, useValue: complianceValidator },
      { provide: ConfigService, useValue: configService },
      { provide: PlatformHealthService, useValue: platformHealthService },
      { provide: DataDivergenceService, useValue: dataDivergenceService },
    ],
  }).compile();

  return {
    service: module.get<ExecutionService>(ExecutionService),
    kalshiConnector,
    polymarketConnector,
    eventEmitter,
    orderRepo,
    positionRepo,
    complianceValidator,
    configService,
    platformHealthService,
    dataDivergenceService,
  };
}
