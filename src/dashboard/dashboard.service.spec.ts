import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../common/prisma.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { PositionEnrichmentService } from './position-enrichment.service';
import type { EnrichmentResult } from './position-enrichment.service';
import { DashboardOverviewService } from './dashboard-overview.service';
import { DashboardCapitalService } from './dashboard-capital.service';
import { DashboardAuditService } from './dashboard-audit.service';

function createMockPrisma() {
  return {
    openPosition: {
      findUnique: vi.fn(),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

function createMockPositionRepository() {
  return {
    findManyWithFilters: vi.fn(),
  } as unknown as PositionRepository;
}

function createMockEnrichmentService() {
  return {
    enrich: vi.fn(),
  } as unknown as PositionEnrichmentService;
}

function createMockOverviewService() {
  return {
    getOverview: vi.fn().mockResolvedValue({ systemHealth: 'healthy' }),
    getHealth: vi.fn().mockResolvedValue([]),
    getAlerts: vi.fn().mockResolvedValue([]),
    getShadowComparisons: vi.fn().mockReturnValue([]),
    getShadowSummary: vi.fn().mockReturnValue({}),
  } as unknown as DashboardOverviewService;
}

function createMockCapitalService() {
  return {
    getBankrollConfig: vi.fn().mockResolvedValue({ bankrollUsd: '10000' }),
    updateBankroll: vi.fn().mockResolvedValue({ bankrollUsd: '15000' }),
    computeRealizedPnl: vi.fn().mockReturnValue(null),
  } as unknown as DashboardCapitalService;
}

function createMockAuditService() {
  return {
    getPositionDetails: vi.fn().mockResolvedValue(null),
    parseJsonFieldWithEvent: vi
      .fn()
      .mockImplementation((_schema: unknown, value: unknown) => value),
  } as unknown as DashboardAuditService;
}

const mockEnrichedResult: EnrichmentResult = {
  status: 'enriched',
  data: {
    currentPrices: { kalshi: '0.60', polymarket: '0.40' },
    currentEdge: '0.08000000',
    unrealizedPnl: '8.00000000',
    exitProximity: { stopLoss: '0.25000000', takeProfit: '0.80000000' },
    resolutionDate: '2026-04-01T00:00:00.000Z',
    timeToResolution: '27d 12h',
  },
};

describe('DashboardService (facade)', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let enrichmentService: ReturnType<typeof createMockEnrichmentService>;
  let positionRepository: ReturnType<typeof createMockPositionRepository>;
  let overviewService: ReturnType<typeof createMockOverviewService>;
  let capitalService: ReturnType<typeof createMockCapitalService>;
  let auditService: ReturnType<typeof createMockAuditService>;

  beforeEach(() => {
    prisma = createMockPrisma();
    enrichmentService = createMockEnrichmentService();
    positionRepository = createMockPositionRepository();
    overviewService = createMockOverviewService();
    capitalService = createMockCapitalService();
    auditService = createMockAuditService();

    service = new DashboardService(
      overviewService,
      capitalService,
      auditService,
      positionRepository,
      enrichmentService,
      prisma,
    );
  });

  // ── Delegation tests ──────────────────────────────────────────────

  /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
  describe('delegation', () => {
    it('should delegate getOverview to OverviewService', async () => {
      const expected = { systemHealth: 'healthy' };
      overviewService.getOverview.mockResolvedValue(expected);
      const result = await service.getOverview();
      expect(result).toBe(expected);
      expect(overviewService.getOverview).toHaveBeenCalled();
    });

    it('should delegate getHealth to OverviewService', async () => {
      const expected = [{ platformId: 'kalshi' }];
      overviewService.getHealth.mockResolvedValue(expected);
      const result = await service.getHealth();
      expect(result).toBe(expected);
      expect(overviewService.getHealth).toHaveBeenCalled();
    });

    it('should delegate getAlerts to OverviewService', async () => {
      const expected = [{ type: 'single_leg_exposure' }];
      overviewService.getAlerts.mockResolvedValue(expected);
      const result = await service.getAlerts();
      expect(result).toBe(expected);
      expect(overviewService.getAlerts).toHaveBeenCalled();
    });

    it('should delegate getShadowComparisons to OverviewService', () => {
      const expected = [{ positionId: 'pos-1' }];
      overviewService.getShadowComparisons.mockReturnValue(expected);
      const result = service.getShadowComparisons();
      expect(result).toBe(expected);
      expect(overviewService.getShadowComparisons).toHaveBeenCalled();
    });

    it('should delegate getShadowSummary to OverviewService', () => {
      const expected = { totalEvaluations: 10 };
      overviewService.getShadowSummary.mockReturnValue(expected);
      const result = service.getShadowSummary();
      expect(result).toBe(expected);
      expect(overviewService.getShadowSummary).toHaveBeenCalled();
    });

    it('should delegate getBankrollConfig to CapitalService', async () => {
      const expected = { bankrollUsd: '10000' };
      capitalService.getBankrollConfig.mockResolvedValue(expected);
      const result = await service.getBankrollConfig();
      expect(result).toBe(expected);
      expect(capitalService.getBankrollConfig).toHaveBeenCalled();
    });

    it('should delegate updateBankroll to CapitalService', async () => {
      const expected = { bankrollUsd: '15000' };
      capitalService.updateBankroll.mockResolvedValue(expected);
      const result = await service.updateBankroll('15000');
      expect(result).toBe(expected);
      expect(capitalService.updateBankroll).toHaveBeenCalledWith('15000');
    });

    it('should delegate getPositionDetails to AuditService', async () => {
      const expected = { id: 'pos-1', pairId: 'pair-1' };
      auditService.getPositionDetails.mockResolvedValue(expected);
      const result = await service.getPositionDetails('pos-1');
      expect(result).toBe(expected);
      expect(auditService.getPositionDetails).toHaveBeenCalledWith('pos-1');
    });
  });
  /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */

  // ── Owned: getPositions ─────────────────────────────────────────────

  describe('getPositions', () => {
    it('should return enriched positions with pagination', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        sizes: { kalshi: '100', polymarket: '100' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: 'Poly Yes',
          resolutionDate: new Date('2026-04-01'),
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();

      expect(result.data).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.data[0]!.id).toBe('pos-1');
      expect(result.data[0]!.initialEdge).toBe('0.012');
      expect(result.data[0]!.currentEdge).toBe('0.08000000');
      expect(result.data[0]!.unrealizedPnl).toBe('8.00000000');
      expect(result.data[0]!.exitProximity).toEqual({
        stopLoss: '0.25000000',
        takeProfit: '0.80000000',
      });
      expect(result.data[0]!.resolutionDate).toBe('2026-04-01T00:00:00.000Z');
    });

    it('should filter by mode when specified', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions('paper');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        true,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should delegate to positionRepository for data fetching', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should apply pagination with page and limit', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 3, 10);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        3,
        10,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should clamp limit to max 200', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 500);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        200,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should accept status filter and pass to repository', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 50, 'OPEN,EXIT_PARTIAL');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should use default open statuses when no status param provided', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions();

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should return all statuses when empty string status provided', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(undefined, 1, 50, '');

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        undefined,
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
      );
    });

    it('should pass sortBy and order through to repository', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        'expectedEdge',
        'asc',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        'expectedEdge',
        'asc',
        undefined,
      );
    });

    it('should compute realizedPnl for CLOSED positions from order fills', async () => {
      const mockPosition = {
        positionId: 'pos-closed-1',
        pairId: 'pair-1',
        status: 'CLOSED',
        expectedEdge: new Decimal('0.02'),
        entryPrices: { kalshi: '0.45', polymarket: '0.55' },
        sizes: { kalshi: '50', polymarket: '50' },
        isPaper: false,
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        kalshiOrderId: 'order-k-1',
        polymarketOrderId: 'order-p-1',
        entryKalshiFeeRate: new Decimal('0.07'),
        entryPolymarketFeeRate: new Decimal('0.02'),
        createdAt: new Date('2026-03-01T10:00:00Z'),
        updatedAt: new Date('2026-03-01T12:00:00Z'),
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Test Pair',
          polymarketDescription: null,
          resolutionDate: null,
        },
        kalshiOrder: {
          orderId: 'order-k-1',
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('50'),
          side: 'buy',
          platform: 'KALSHI',
        },
        polymarketOrder: {
          orderId: 'order-p-1',
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('50'),
          side: 'sell',
          platform: 'POLYMARKET',
        },
        realizedPnl: null,
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });

      const exitOrders = [
        {
          orderId: 'exit-k-1',
          pairId: 'pair-1',
          platform: 'KALSHI',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
        {
          orderId: 'exit-p-1',
          pairId: 'pair-1',
          platform: 'POLYMARKET',
          fillPrice: new Decimal('0.50'),
          fillSize: new Decimal('50'),
          createdAt: new Date('2026-03-01T11:00:00Z'),
        },
      ];

      (prisma.order.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        exitOrders,
      );
      (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
        [],
      );
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );
      capitalService.computeRealizedPnl.mockReturnValue('1.50000000');

      const result = await service.getPositions(undefined, 1, 50, 'CLOSED');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.realizedPnl).toBe('1.50000000');
    });

    it('should return null realizedPnl and exitType for OPEN positions', async () => {
      const mockPosition = {
        positionId: 'pos-open-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.02'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Test',
          polymarketDescription: null,
        },
        createdAt: new Date(),
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();
      expect(result.data[0]!.realizedPnl).toBeNull();
      expect(result.data[0]!.exitType).toBeNull();
    });

    it('should handle partial enrichment gracefully', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: null,
        },
        createdAt: new Date(),
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'partial',
        data: {
          currentPrices: { kalshi: '0.60', polymarket: null },
          currentEdge: null,
          unrealizedPnl: null,
          exitProximity: null,
          resolutionDate: null,
          timeToResolution: null,
        },
        errors: ['Polymarket API timeout'],
      });

      const result = await service.getPositions();
      expect(result.data).toHaveLength(1);
    });

    it('should pass matchId through to repository as pairId', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
        'match-123',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
        undefined,
        1,
        50,
        undefined,
        undefined,
        'match-123',
      );
    });

    it('should combine matchId with status and mode filters', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      await service.getPositions(
        'paper',
        2,
        25,
        'OPEN,CLOSED',
        'expectedEdge',
        'desc',
        'match-456',
      );

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(positionRepository.findManyWithFilters).toHaveBeenCalledWith(
        ['OPEN', 'CLOSED'],
        true,
        2,
        25,
        'expectedEdge',
        'desc',
        'match-456',
      );
    });

    it('should return empty results when matchId has no matching positions', async () => {
      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [], count: 0 });

      const result = await service.getPositions(
        undefined,
        1,
        50,
        undefined,
        undefined,
        undefined,
        'nonexistent-match',
      );

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    it('should return pairId in position summary DTOs', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-abc-123',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          polymarketDescription: null,
        },
        createdAt: new Date(),
      };

      (
        positionRepository.findManyWithFilters as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ data: [mockPosition], count: 1 });
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositions();
      expect(result.data[0]!.pairId).toBe('pair-abc-123');
    });
  });

  // ── Owned: getPositionById ──────────────────────────────────────────

  describe('getPositionById', () => {
    it('should return enriched position by ID', async () => {
      const mockPosition = {
        positionId: 'pos-1',
        pairId: 'pair-1',
        status: 'OPEN',
        expectedEdge: new Decimal('0.012'),
        entryPrices: { kalshi: '0.55', polymarket: '0.45' },
        isPaper: false,
        pair: {
          kalshiContractId: 'k-contract',
          polymarketContractId: 'p-contract',
          kalshiDescription: 'Kalshi Yes',
          resolutionDate: new Date('2026-04-01'),
        },
        kalshiOrder: {
          fillPrice: new Decimal('0.55'),
          fillSize: new Decimal('100'),
          side: 'buy',
        },
        polymarketOrder: {
          fillPrice: new Decimal('0.45'),
          fillSize: new Decimal('100'),
          side: 'sell',
        },
      };

      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockPosition);
      (enrichmentService.enrich as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockEnrichedResult,
      );

      const result = await service.getPositionById('pos-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('pos-1');
      expect(result!.currentEdge).toBe('0.08000000');
    });

    it('should return null when position not found', async () => {
      (
        prisma.openPosition.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue(null);

      const result = await service.getPositionById('nonexistent');
      expect(result).toBeNull();
    });
  });
});
