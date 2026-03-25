/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Dashboard Module
 *
 * Verifies that dashboard services correctly filter positions by mode
 * and return separate live/paper capital in the overview response.
 *
 * Updated Story 10-8-4: Tests now target decomposed services.
 * - getPositions → DashboardService (facade, still owns this method)
 * - getOverview → DashboardOverviewService (extracted)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardService } from '../../../dashboard/dashboard.service';
import { DashboardOverviewService } from '../../../dashboard/dashboard-overview.service';
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
          totalCapitalDeployed: new Decimal('500'),
          reservedCapital: new Decimal('100'),
        },
        {
          singletonKey: 'default',
          mode: 'paper',
          totalCapitalDeployed: new Decimal('200'),
          reservedCapital: new Decimal('50'),
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

describe('Paper/Live Boundary — Dashboard', () => {
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let prisma: ReturnType<typeof createMockPrisma>;
  let riskManager: IRiskManager;

  beforeEach(() => {
    positionRepository = createMockPositionRepository();
    prisma = createMockPrisma();
    riskManager = createMockRiskManager();
  });

  describe.each([
    ['paper', true],
    ['live', false],
  ] as const)('getPositions(mode=%s) filtering', (mode, expectedIsPaper) => {
    it(`[P1] getPositions(mode='${mode}') returns only ${mode} positions`, async () => {
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

      // DashboardService facade: 6 constructor args
      const service = new DashboardService(
        {
          getOverview: vi.fn(),
          getHealth: vi.fn(),
          getAlerts: vi.fn(),
          getShadowComparisons: vi.fn(),
          getShadowSummary: vi.fn(),
        } as any,
        {
          getBankrollConfig: vi.fn(),
          updateBankroll: vi.fn(),
          computeRealizedPnl: vi.fn().mockReturnValue(null),
        } as any,
        {
          getPositionDetails: vi.fn(),
          parseJsonFieldWithEvent: vi
            .fn()
            .mockImplementation((_s: unknown, v: unknown) => v),
        } as any,
        positionRepository as any,
        { enrich: enrichMock } as any,
        prisma as any,
      );

      const result = await service.getPositions(mode);

      expect(positionRepository.findManyWithFilters).toHaveBeenCalled();
      const callArgs = positionRepository.findManyWithFilters.mock.calls[0]!;
      expect(callArgs[1]).toBe(expectedIsPaper);

      const expectedCount = mode === 'paper' ? 2 : 1;
      expect(result.count).toBe(expectedCount);
      for (const pos of result.data) {
        expect((pos as any).isPaper).toBe(expectedIsPaper);
      }
    });
  });

  it('[P1] getOverview() returns separate live/paper capital in response', async () => {
    // Test DashboardOverviewService directly (where getOverview now lives)
    const overviewService = new DashboardOverviewService(
      prisma as any,
      positionRepository as any,
      riskManager,
      { getActiveSubscriptionCount: vi.fn().mockReturnValue(0) } as any,
      { getDivergenceStatus: vi.fn().mockReturnValue('aligned') } as any,
      { getWsLastMessageTimestamp: vi.fn().mockReturnValue(null) } as any,
      {
        getClosedPositionEntries: vi.fn().mockReturnValue([]),
        generateDailySummary: vi.fn(),
      } as any,
      {
        get: vi
          .fn()
          .mockImplementation(
            (_key: string, defaultValue?: unknown) => defaultValue,
          ),
      } as any,
    );

    const overview = await overviewService.getOverview();

    expect(overview.capitalOverview).not.toBeNull();
    expect(overview.capitalOverview!.live).toBeDefined();
    expect(overview.capitalOverview!.paper).toBeDefined();

    expect(overview.capitalOverview!.live.bankroll).not.toBe(
      overview.capitalOverview!.paper.bankroll,
    );

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

    const paperCap = overview.capitalOverview!.paper;
    expect(paperCap.bankroll).toBeDefined();
    expect(new Decimal(paperCap.bankroll ?? '0').toString()).not.toBe('0');
  });
});
