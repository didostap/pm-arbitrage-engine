/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Dashboard Module
 *
 * Verifies that dashboard service correctly filters positions by mode
 * and returns separate live/paper capital in the overview response.
 *
 * TDD RED PHASE — all tests use it()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardService } from '../../../dashboard/dashboard.service';
import type { IRiskManager } from '../../../common/interfaces/risk-manager.interface';

// ──────────────────────────────────────────────────────────────
// Mock helpers
// ──────────────────────────────────────────────────────────────

function createMockPositionRepository() {
  return {
    findManyWithFilters: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    findActivePositions: vi.fn().mockResolvedValue([]),
    findByStatus: vi.fn().mockResolvedValue([]),
    sumClosedPnlByDateRange: vi.fn().mockResolvedValue('0'),
  };
}

function createMockPrisma() {
  return {
    openPosition: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { expectedEdge: null } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    platformHealthLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    riskState: {
      findMany: vi.fn().mockResolvedValue([
        {
          singletonKey: 'default',
          mode: 'live',
          capitalDeployedUsd: new Decimal('500'),
          capitalReservedUsd: new Decimal('100'),
          openPositionCount: 2,
        },
        {
          singletonKey: 'default',
          mode: 'paper',
          capitalDeployedUsd: new Decimal('200'),
          capitalReservedUsd: new Decimal('50'),
          openPositionCount: 1,
        },
      ]),
    },
  };
}

function createMockRiskManager(): IRiskManager {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({
      bankrollUsd: '10000',
      paperBankrollUsd: '5000',
    }),
    isTradingHalted: vi.fn().mockReturnValue(false),
    getActiveHaltReasons: vi.fn().mockReturnValue([]),
    recalculateFromPositions: vi.fn(),
    reloadBankroll: vi.fn(),
  } as unknown as IRiskManager;
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('Paper/Live Boundary — DashboardService', () => {
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let prisma: ReturnType<typeof createMockPrisma>;
  let riskManager: IRiskManager;
  let configService: { get: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    positionRepository = createMockPositionRepository();
    prisma = createMockPrisma();
    riskManager = createMockRiskManager();
    configService = {
      get: vi
        .fn()
        .mockImplementation(
          (_key: string, defaultValue?: unknown) => defaultValue,
        ),
    };
    eventEmitter = { emit: vi.fn() };
  });

  describe.each([
    ['paper', true],
    ['live', false],
  ] as const)('getPositions(mode=%s) filtering', (mode, expectedIsPaper) => {
    it(`[P1] getPositions(mode='${mode}') returns only ${mode} positions`, async () => {
      // ARRANGE: Set up position data for both modes
      const makePair = (id: string) => ({
        kalshiContractId: `kalshi-${id}`,
        polymarketContractId: `poly-${id}`,
        kalshiDescription: `Kalshi ${id}`,
        polymarketDescription: `Poly ${id}`,
      });
      const paperPositions = [
        {
          positionId: 'pos-paper-1',
          isPaper: true,
          status: 'OPEN',
          pairId: 'pair-1',
          pair: makePair('pair-1'),
          expectedEdge: new Decimal('0.02'),
          entryPrices: { kalshi: '0.45', polymarket: '0.55' },
          realizedPnl: null,
          createdAt: new Date(),
        },
        {
          positionId: 'pos-paper-2',
          isPaper: true,
          status: 'OPEN',
          pairId: 'pair-2',
          pair: makePair('pair-2'),
          expectedEdge: new Decimal('0.03'),
          entryPrices: { kalshi: '0.40', polymarket: '0.60' },
          realizedPnl: null,
          createdAt: new Date(),
        },
      ];
      const livePositions = [
        {
          positionId: 'pos-live-1',
          isPaper: false,
          status: 'OPEN',
          pairId: 'pair-3',
          pair: makePair('pair-3'),
          expectedEdge: new Decimal('0.015'),
          entryPrices: { kalshi: '0.50', polymarket: '0.50' },
          realizedPnl: null,
          createdAt: new Date(),
        },
      ];

      positionRepository.findManyWithFilters.mockImplementation(
        (_statuses: string[] | undefined, isPaper: boolean | undefined) => {
          if (isPaper === true)
            return Promise.resolve({ data: paperPositions, count: 2 });
          if (isPaper === false)
            return Promise.resolve({ data: livePositions, count: 1 });
          return Promise.resolve({
            data: [...livePositions, ...paperPositions],
            count: 3,
          });
        },
      );

      const enrichMock = vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 'enriched',
          data: {
            currentPrices: { kalshi: '0.50', polymarket: '0.50' },
            currentEdge: '0.02',
            unrealizedPnl: '0.00',
            exitProximity: null,
            resolutionDate: null,
            timeToResolution: null,
            projectedSlPnl: null,
            projectedTpPnl: null,
            recalculatedEdge: null,
            edgeDelta: null,
            lastRecalculatedAt: null,
            dataSource: null,
          },
        }),
      );

      const service = new DashboardService(
        prisma as any,
        configService as any,
        { enrich: enrichMock } as any,
        positionRepository as any,
        eventEmitter as any,
        riskManager,
        { findByKey: vi.fn() } as any,
        { getActiveSubscriptionCount: vi.fn().mockReturnValue(0) } as any,
        { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
        { getWsLastMessageTimestamp: vi.fn().mockReturnValue(null) } as any,
        { getComparisons: vi.fn().mockReturnValue([]) } as any,
        { append: vi.fn().mockResolvedValue(undefined) } as any,
      );

      // ACT: Call getPositions with specific mode
      const result = await service.getPositions(mode);

      // ASSERT: findManyWithFilters was called with correct isPaper boolean
      expect(positionRepository.findManyWithFilters).toHaveBeenCalled();
      const callArgs = positionRepository.findManyWithFilters.mock.calls[0]!;
      // The second argument is isPaper: mode='paper' maps to true, mode='live' maps to false
      expect(callArgs[1]).toBe(expectedIsPaper);

      // ASSERT: Returned positions match the requested mode
      const expectedCount = mode === 'paper' ? 2 : 1;
      expect(result.count).toBe(expectedCount);
      for (const pos of result.data) {
        expect((pos as any).isPaper).toBe(expectedIsPaper);
      }
    });
  });

  it('[P1] getOverview() returns separate live/paper capital in response', async () => {
    // ARRANGE: Set up risk manager with distinct live/paper bankrolls
    const service = new DashboardService(
      prisma as any,
      configService as any,
      {
        enrich: vi.fn().mockResolvedValue({ status: 'enriched', data: {} }),
      } as any,
      positionRepository as any,
      eventEmitter as any,
      riskManager,
      { findByKey: vi.fn() } as any,
      { getActiveSubscriptionCount: vi.fn().mockReturnValue(0) } as any,
      { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
      { getWsLastMessageTimestamp: vi.fn().mockReturnValue(null) } as any,
      { getComparisons: vi.fn().mockReturnValue([]) } as any,
      { append: vi.fn().mockResolvedValue(undefined) } as any,
    );

    // ACT: Get the overview
    const overview = await service.getOverview();

    // ASSERT: capitalOverview contains separate live and paper objects
    expect(overview.capitalOverview).not.toBeNull();
    expect(overview.capitalOverview!.live).toBeDefined();
    expect(overview.capitalOverview!.paper).toBeDefined();

    // ASSERT: Live and paper have independent bankroll values
    // Live bankroll: '10000', Paper bankroll: '5000'
    expect(overview.capitalOverview!.live.bankroll).not.toBe(
      overview.capitalOverview!.paper.bankroll,
    );

    // ASSERT: Flat convenience fields resolve to live-mode values
    expect(overview.totalBankroll).toBe(
      overview.capitalOverview!.live.bankroll,
    );
    expect(overview.deployedCapital).toBe(
      overview.capitalOverview!.live.deployed,
    );
    expect(overview.availableCapital).toBe(
      overview.capitalOverview!.live.available,
    );
    expect(overview.reservedCapital).toBe(
      overview.capitalOverview!.live.reserved,
    );

    // ASSERT: Paper capital values reflect the separate paper bankroll
    const paperCap = overview.capitalOverview!.paper;
    expect(paperCap.bankroll).toBeDefined();
    // Paper deployed + available + reserved should relate to paper bankroll, not live
    expect(new Decimal(paperCap.bankroll ?? '0').toString()).not.toBe('0');
  });
});
