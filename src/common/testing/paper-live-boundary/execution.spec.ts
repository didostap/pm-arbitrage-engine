/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Execution Module
 *
 * Verifies that execution service correctly propagates isPaper flag,
 * does not trigger live halt checks for paper orders, and that
 * connector mode is immutable after DI resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type { IPlatformConnector } from '../../../common/interfaces/platform-connector.interface';
import type { PlatformHealth } from '../../../common/types/platform.type';
import { PlatformId } from '../../../common/types/platform.type';
import { ExecutionService } from '../../../modules/execution/execution.service';
import { LegSequencingService } from '../../../modules/execution/leg-sequencing.service';
import { DepthAnalysisService } from '../../../modules/execution/depth-analysis.service';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../../connectors/connector.constants';
import { OrderRepository } from '../../../persistence/repositories/order.repository';
import { PositionRepository } from '../../../persistence/repositories/position.repository';
import { ComplianceValidatorService } from '../../../modules/execution/compliance/compliance-validator.service';
import { PlatformHealthService } from '../../../modules/data-ingestion/platform-health.service';
import { DataDivergenceService } from '../../../modules/data-ingestion/data-divergence.service';
import type {
  RankedOpportunity,
  BudgetReservation,
} from '../../../common/types/risk.type';
import type { EnrichedOpportunity } from '../../../modules/arbitrage-detection/types/enriched-opportunity.type';

// ──────────────────────────────────────────────────────────────
// Mock helpers
// ──────────────────────────────────────────────────────────────

function createMockConnector(mode: 'paper' | 'live'): IPlatformConnector {
  return {
    getHealth: vi.fn().mockReturnValue({
      platformId: PlatformId.KALSHI,
      status: 'healthy',
      lastHeartbeat: new Date(),
      latencyMs: 50,
      mode,
    } satisfies PlatformHealth),
    getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
    getFeeSchedule: vi.fn().mockReturnValue({
      platformId: PlatformId.KALSHI,
      takerFeePercent: 2,
      makerFeePercent: 0,
      description: 'Mock fee schedule',
    }),
    submitOrder: vi.fn().mockResolvedValue({
      orderId: 'order-1',
      status: 'filled',
      filledPrice: 0.55,
      filledQuantity: 10,
    }),
    getOrder: vi.fn(),
    getOrderBook: vi.fn().mockResolvedValue({
      bids: [{ price: 0.6, quantity: 1000 }],
      asks: [{ price: 0.4, quantity: 1000 }],
    }),
    getOrderBookFreshness: vi.fn().mockReturnValue({
      lastWsUpdateAt: new Date(),
      lastRestUpdateAt: new Date(),
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as IPlatformConnector;
}

function createMockOpportunity(pairId: string): {
  opportunity: RankedOpportunity;
  reservation: BudgetReservation;
} {
  const enriched = {
    dislocation: {
      buyPlatformId: PlatformId.KALSHI,
      sellPlatformId: PlatformId.POLYMARKET,
      buyPrice: new Decimal('0.45'),
      sellPrice: new Decimal('0.57'),
      pairConfig: {
        kalshiContractId: 'kalshi-contract-1',
        polymarketClobTokenId: 'poly-token-1',
        polymarketContractId: 'poly-contract-1',
        eventDescription: 'Test event',
        primaryLeg: 'kalshi',
      },
    },
    netEdge: new Decimal('0.02'),
    feeBreakdown: {
      gasFraction: new Decimal('0.001'),
      kalshiFee: new Decimal('0.01'),
      polymarketFee: new Decimal('0.005'),
    },
  } as unknown as EnrichedOpportunity;

  const opportunity: RankedOpportunity = {
    opportunity: enriched,
    reservationRequest: {
      pairId,
      opportunityId: 'opp-1',
      requiredCapitalUsd: new Decimal('100'),
    },
    score: 1,
  } as unknown as RankedOpportunity;

  const reservation: BudgetReservation = {
    reservedCapitalUsd: new Decimal('100'),
    reservationId: 'res-1',
    pairId,
    expiresAt: new Date(Date.now() + 60_000),
  } as unknown as BudgetReservation;

  return { opportunity, reservation };
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('Paper/Live Boundary — ExecutionService', () => {
  let kalshiConnector: IPlatformConnector;
  let polymarketConnector: IPlatformConnector;
  let orderRepository: {
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let positionRepository: {
    create: ReturnType<typeof vi.fn>;
    updateWithOrder: ReturnType<typeof vi.fn>;
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    orderRepository = {
      create: vi.fn().mockResolvedValue({ orderId: 'order-primary-1' }),
      findById: vi.fn(),
    };
    positionRepository = {
      create: vi.fn().mockResolvedValue({ positionId: 'pos-1' }),
      updateWithOrder: vi.fn(),
    };
    eventEmitter = { emit: vi.fn() };
    configService = {
      get: vi
        .fn()
        .mockImplementation(
          (_key: string, defaultValue?: unknown) => defaultValue,
        ),
    };
  });

  async function buildService(
    mode: 'paper' | 'live',
  ): Promise<ExecutionService> {
    kalshiConnector = createMockConnector(mode);
    polymarketConnector = createMockConnector(mode);
    const platformHealthService = {
      getPlatformHealth: vi
        .fn()
        .mockImplementation((platformId: PlatformId) => ({
          platformId,
          status: 'healthy',
          lastHeartbeat: new Date(),
          latencyMs: 50,
          mode,
        })),
    };
    const dataDivergenceService = {
      getDivergenceStatus: vi.fn().mockReturnValue('aligned'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionService,
        LegSequencingService,
        DepthAnalysisService,
        { provide: KALSHI_CONNECTOR_TOKEN, useValue: kalshiConnector },
        { provide: POLYMARKET_CONNECTOR_TOKEN, useValue: polymarketConnector },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: OrderRepository, useValue: orderRepository },
        { provide: PositionRepository, useValue: positionRepository },
        {
          provide: ComplianceValidatorService,
          useValue: {
            validate: vi
              .fn()
              .mockReturnValue({ approved: true, violations: [] }),
          },
        },
        { provide: ConfigService, useValue: configService },
        { provide: PlatformHealthService, useValue: platformHealthService },
        { provide: DataDivergenceService, useValue: dataDivergenceService },
      ],
    }).compile();

    return module.get<ExecutionService>(ExecutionService);
  }

  describe.each([
    [true, 'paper'],
    [false, 'live'],
  ] as const)('when isPaper=%s (%s mode)', (isPaper, modeLabel) => {
    it(`[P1] ${modeLabel} order creation sets isPaper=${isPaper} on order records`, async () => {
      const service = await buildService(modeLabel);
      const { opportunity, reservation } = createMockOpportunity('pair-1');

      await service.execute(opportunity, reservation);

      expect(orderRepository.create).toHaveBeenCalled();
      const firstCallArgs = orderRepository.create.mock.calls[0]![0];
      expect(firstCallArgs.isPaper).toBe(isPaper);
    });
  });

  it('[P1] paper execution does not trigger live halt checks', async () => {
    const service = await buildService('paper');
    const { opportunity, reservation } =
      createMockOpportunity('pair-paper-halt');

    await service.execute(opportunity, reservation);

    const emittedEvents = eventEmitter.emit.mock.calls
      .filter(
        ([name]: [string]) =>
          name.includes('order') || name.includes('execution'),
      )
      .map(([, event]: [string, unknown]) => event);
    expect(emittedEvents.length).toBeGreaterThan(0);
    for (const event of emittedEvents) {
      expect((event as Record<string, unknown>).isPaper).toBe(true);
    }

    const haltEvents = eventEmitter.emit.mock.calls.filter(([name]: [string]) =>
      name.includes('halt'),
    );
    expect(haltEvents).toHaveLength(0);
  });

  it('[P1] mode immutability — isPaper is derived from connector health at execute() time', async () => {
    const service = await buildService('paper');
    const { opportunity, reservation } =
      createMockOpportunity('pair-immutable');

    await service.execute(opportunity, reservation);

    expect(orderRepository.create).toHaveBeenCalled();
    const createArgs = orderRepository.create.mock.calls[0]![0];
    expect(createArgs.isPaper).toBe(true);
  });

  // ════════════════════════════════════════════════════════════════
  // Story 10-7-1: Dual-Leg Depth Gate — Paper/Live Boundary
  // ════════════════════════════════════════════════════════════════

  describe('Story 10-7-1: Dual-Leg Depth Gate boundary', () => {
    describe.each([
      [true, 'paper'],
      [false, 'live'],
    ] as const)(
      'when isPaper=%s (%s mode) — dual-leg depth gate',
      (_isPaper, modeLabel) => {
        it(`[P1] 5.1/5.2 — dual-leg depth gate runs in ${modeLabel} mode`, async () => {
          const service = await buildService(modeLabel);

          // Override order books with shallow depth AFTER service is built
          (
            kalshiConnector.getOrderBook as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            bids: [{ price: 0.6, quantity: 1 }],
            asks: [{ price: 0.4, quantity: 1 }],
          });
          (
            polymarketConnector.getOrderBook as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            bids: [{ price: 0.6, quantity: 1 }],
            asks: [{ price: 0.4, quantity: 1 }],
          });

          const { opportunity, reservation } = createMockOpportunity(
            `pair-depth-${modeLabel}`,
          );
          const result = await service.execute(opportunity, reservation);

          expect(result.success).toBe(false);
          expect(
            (kalshiConnector.submitOrder as ReturnType<typeof vi.fn>).mock.calls
              .length,
          ).toBe(0);
          expect(
            (polymarketConnector.submitOrder as ReturnType<typeof vi.fn>).mock
              .calls.length,
          ).toBe(0);

          const filteredCalls = eventEmitter.emit.mock.calls.filter(
            ([name]: [string]) => name === 'detection.opportunity.filtered',
          );
          expect(filteredCalls).toHaveLength(1);
          expect(
            (filteredCalls[0]![1] as Record<string, unknown>).reason,
          ).toEqual(expect.stringContaining('insufficient dual-leg depth'));
        });
      },
    );
  });
});
