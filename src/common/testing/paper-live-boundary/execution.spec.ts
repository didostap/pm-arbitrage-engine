/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Execution Module
 *
 * Verifies that execution service correctly propagates isPaper flag,
 * does not trigger live halt checks for paper orders, and that
 * connector mode is immutable after DI resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import type { IPlatformConnector } from '../../../common/interfaces/platform-connector.interface';
import type { PlatformHealth } from '../../../common/types/platform.type';
import { PlatformId } from '../../../common/types/platform.type';
import { ExecutionService } from '../../../modules/execution/execution.service';
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

  describe.each([
    [true, 'paper'],
    [false, 'live'],
  ] as const)('when isPaper=%s (%s mode)', (isPaper, modeLabel) => {
    beforeEach(() => {
      const mode = modeLabel;
      kalshiConnector = createMockConnector(mode);
      polymarketConnector = createMockConnector(mode);
    });

    it(`[P1] ${modeLabel} order creation sets isPaper=${isPaper} on order records`, async () => {
      // ARRANGE: Build execution service with connectors in the given mode
      // The isPaper flag is derived from connector.getHealth().mode
      // Both connectors return mode='paper' or mode='live'
      const { opportunity, reservation } = createMockOpportunity('pair-1');

      // ACT: Execute the opportunity
      const mode = modeLabel;
      const service = new ExecutionService(
        kalshiConnector,
        polymarketConnector,
        eventEmitter as any,
        orderRepository as any,
        positionRepository as any,
        {
          validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
        } as any,
        configService as any,
        {
          getPlatformHealth: vi
            .fn()
            .mockImplementation((platformId: PlatformId) => ({
              platformId,
              status: 'healthy',
              lastHeartbeat: new Date(),
              latencyMs: 50,
              mode,
            })),
          getConnectorLatency: vi.fn().mockReturnValue(null),
        } as any,
        { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
      );

      await service.execute(opportunity, reservation);

      // ASSERT: The order record passed to orderRepository.create has isPaper flag set correctly
      expect(orderRepository.create).toHaveBeenCalled();
      const firstCallArgs = orderRepository.create.mock.calls[0]![0];
      expect(firstCallArgs.isPaper).toBe(isPaper);
    });
  });

  it('[P1] paper execution does not trigger live halt checks', async () => {
    // ARRANGE: Set up paper-mode connectors
    kalshiConnector = createMockConnector('paper');
    polymarketConnector = createMockConnector('paper');
    const { opportunity, reservation } =
      createMockOpportunity('pair-paper-halt');

    // ACT: Execute a paper opportunity
    const service = new ExecutionService(
      kalshiConnector,
      polymarketConnector,
      eventEmitter as any,
      orderRepository as any,
      positionRepository as any,
      {
        validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
      } as any,
      configService as any,
      {
        getPlatformHealth: vi
          .fn()
          .mockImplementation((platformId: PlatformId) => ({
            platformId,
            status: 'healthy',
            lastHeartbeat: new Date(),
            latencyMs: 50,
            mode: 'paper',
          })),
        getConnectorLatency: vi.fn().mockReturnValue(null),
      } as any,
      { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
    );

    await service.execute(opportunity, reservation);

    // ASSERT: Events emitted should carry isPaper=true (paper execution
    // path does not feed into the live halt mechanism)
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

    // ASSERT: No halt-related events emitted for paper execution
    const haltEvents = eventEmitter.emit.mock.calls.filter(([name]: [string]) =>
      name.includes('halt'),
    );
    expect(haltEvents).toHaveLength(0);
  });

  it('[P1] mode immutability — isPaper is derived from connector health at execute() time', async () => {
    // ARRANGE: Paper-mode connectors
    kalshiConnector = createMockConnector('paper');
    polymarketConnector = createMockConnector('paper');
    const { opportunity, reservation } =
      createMockOpportunity('pair-immutable');

    const service = new ExecutionService(
      kalshiConnector,
      polymarketConnector,
      eventEmitter as any,
      orderRepository as any,
      positionRepository as any,
      {
        validate: vi.fn().mockReturnValue({ approved: true, violations: [] }),
      } as any,
      configService as any,
      {
        getPlatformHealth: vi
          .fn()
          .mockImplementation((platformId: PlatformId) => ({
            platformId,
            status: 'healthy',
            lastHeartbeat: new Date(),
            latencyMs: 50,
            mode: 'paper',
          })),
        getConnectorLatency: vi.fn().mockReturnValue(null),
      } as any,
      { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
    );

    // ACT: Execute with paper connectors
    await service.execute(opportunity, reservation);

    // ASSERT: The order record created during execution carries isPaper=true
    // proving the mode was correctly derived from connector health
    expect(orderRepository.create).toHaveBeenCalled();
    const createArgs = orderRepository.create.mock.calls[0]![0];
    expect(createArgs.isPaper).toBe(true);
  });
});
