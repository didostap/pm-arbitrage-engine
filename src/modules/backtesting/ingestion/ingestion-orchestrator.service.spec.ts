import { describe, it, expect, vi } from 'vitest';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

vi.mock('../../../common/events/backtesting.events', async () => {
  const actual = await vi.importActual(
    '../../../common/events/backtesting.events',
  );
  return actual;
});

function createMockPrisma() {
  return {
    contractMatch: { findMany: vi.fn().mockResolvedValue([]) },
    historicalPrice: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    historicalTrade: {
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    historicalDepth: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

function createMockService() {
  return {
    ingestPrices: vi.fn().mockResolvedValue({ recordCount: 0 }),
    ingestTrades: vi.fn().mockResolvedValue({ recordCount: 0 }),
    getSupportedSources: vi.fn().mockReturnValue([]),
  };
}

function createMockPmxtArchive() {
  return {
    ingestDepth: vi
      .fn()
      .mockResolvedValue({ recordCount: 0, source: 'PMXT_ARCHIVE' }),
  };
}

function createMockOddsPipe() {
  return {
    resolveMarketId: vi.fn().mockResolvedValue(42),
    ingestPrices: vi
      .fn()
      .mockResolvedValue({ recordCount: 0, source: 'ODDSPIPE' }),
  };
}

function createMockQualityAssessor() {
  return {
    runQualityAssessment: vi.fn().mockResolvedValue(undefined),
  };
}

function createOrchestratorService(
  prismaOverride?: any,
  kalshiOverride?: any,
  polyOverride?: any,
  emitterOverride?: any,
  pmxtOverride?: any,
  oddsPipeOverride?: any,
  qualityAssessorOverride?: any,
) {
  const prisma = prismaOverride ?? createMockPrisma();
  const kalshi = kalshiOverride ?? createMockService();
  const poly = polyOverride ?? createMockService();
  const pmxt = pmxtOverride ?? createMockPmxtArchive();
  const oddsPipe = oddsPipeOverride ?? createMockOddsPipe();
  const qualityAssessor =
    qualityAssessorOverride ?? createMockQualityAssessor();
  const emitter = emitterOverride ?? new EventEmitter2();

  return new IngestionOrchestratorService(
    prisma,
    kalshi,
    poly,
    pmxt,
    oddsPipe,
    qualityAssessor,
    emitter,
  );
}

describe('IngestionOrchestratorService', () => {
  describe('buildTargetList', () => {
    it('[P1] should query ContractMatch for approved pairs only', async () => {
      const mockPrisma = createMockPrisma();

      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'match-1',
          kalshiContractId: 'KXBTC-24DEC31',
          polymarketClobTokenId: '0x1234',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
        {
          matchId: 'match-2',
          kalshiContractId: 'KXETH-24DEC31',
          polymarketClobTokenId: '0x5678',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(mockPrisma);
      const targets = await service.buildTargetList();

      expect(mockPrisma.contractMatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ operatorApproved: true }),
        }),
      );
      expect(targets.size).toBe(2);
      expect(targets.get('match-1')).toEqual(
        expect.objectContaining({
          kalshiTicker: 'KXBTC-24DEC31',
          polymarketTokenId: '0x1234',
        }),
      );
    });

    it('[P1] should skip records with null polymarketClobTokenId', async () => {
      const mockPrisma = createMockPrisma();

      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'match-1',
          kalshiContractId: 'KXBTC-24DEC31',
          polymarketClobTokenId: '0x1234',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
        {
          matchId: 'match-2',
          kalshiContractId: 'KXETH-24DEC31',
          polymarketClobTokenId: null, // Should be skipped
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(mockPrisma);
      const targets = await service.buildTargetList();

      expect(targets.size).toBe(1);
      expect(targets.has('match-2')).toBe(false);
    });
  });

  describe('runIngestion', () => {
    it('[P1] should call all services for each contract in target list', async () => {
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      mockKalshi.ingestPrices.mockResolvedValue({ recordCount: 100 });
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 50 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 80 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 40 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
      );

      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      expect(mockKalshi.ingestPrices).toHaveBeenCalledWith(
        'K1',
        expect.any(Object),
      );
      expect(mockKalshi.ingestTrades).toHaveBeenCalledWith(
        'K1',
        expect.any(Object),
      );
      expect(mockPoly.ingestPrices).toHaveBeenCalledWith(
        '0x1',
        expect.any(Object),
      );
      expect(mockPoly.ingestTrades).toHaveBeenCalledWith(
        '0x1',
        expect.any(Object),
      );
    });

    it('[P1] should continue with remaining contracts when one fails', async () => {
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      // First contract fails
      mockKalshi.ingestPrices.mockRejectedValueOnce(new Error('API failure'));
      // Second contract succeeds
      mockKalshi.ingestPrices.mockResolvedValueOnce({ recordCount: 100 });
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 50 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 80 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 40 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
        {
          matchId: 'm2',
          kalshiContractId: 'K2',
          polymarketClobTokenId: '0x2',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
      );

      // Should NOT throw — continues with m2
      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      // Second contract still processed
      expect(mockKalshi.ingestPrices).toHaveBeenCalledTimes(2);
    });

    it('[P4] should emit BacktestDataIngestedEvent per source/contract (6 events per contract)', async () => {
      const mockEmitter = { emit: vi.fn() };
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      mockKalshi.ingestPrices.mockResolvedValue({ recordCount: 10 });
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 5 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 8 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 4 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
        mockEmitter,
      );

      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      // Should emit 6 events: Kalshi prices/trades, Poly prices, Goldsky trades, PMXT depth, OddsPipe OHLCV
      const ingestedCalls = mockEmitter.emit.mock.calls.filter(
        (c: any[]) => c[0] === 'backtesting.data.ingested',
      );
      expect(ingestedCalls).toHaveLength(6);

      // Verify per-source events with correct platform/source
      expect(ingestedCalls[0]![1]).toEqual(
        expect.objectContaining({
          source: 'KALSHI_API',
          platform: 'kalshi',
          contractId: 'K1',
        }),
      );
      expect(ingestedCalls[2]![1]).toEqual(
        expect.objectContaining({
          source: 'POLYMARKET_API',
          platform: 'polymarket',
          contractId: '0x1',
        }),
      );
      expect(ingestedCalls[3]![1]).toEqual(
        expect.objectContaining({
          source: 'GOLDSKY',
          platform: 'polymarket',
          contractId: '0x1',
        }),
      );
      expect(ingestedCalls[4]![1]).toEqual(
        expect.objectContaining({
          source: 'PMXT_ARCHIVE',
          platform: 'polymarket',
        }),
      );
      expect(ingestedCalls[5]![1]).toEqual(
        expect.objectContaining({
          source: 'ODDSPIPE',
          platform: 'polymarket',
        }),
      );
    });

    it('[P6] should reject concurrent runIngestion calls', async () => {
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      // Make ingestion take a while
      mockKalshi.ingestPrices.mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ recordCount: 0 }), 100)),
      );
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 0 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 0 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 0 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
      );

      const dateRange = {
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      };

      // Start first run
      const first = service.runIngestion(dateRange);

      // Second run should throw
      await expect(service.runIngestion(dateRange)).rejects.toThrow(
        'Ingestion already in progress',
      );

      await first;

      // After first completes, isRunning should be false
      expect(service.isRunning).toBe(false);
    });

    it('[P6] should reset isRunning flag even when ingestion fails', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockRejectedValue(
        new Error('DB failure'),
      );

      const service = createOrchestratorService(mockPrisma);

      await expect(
        service.runIngestion({
          dateRangeStart: new Date('2025-01-01'),
          dateRangeEnd: new Date('2025-03-01'),
        }),
      ).rejects.toThrow('DB failure');

      expect(service.isRunning).toBe(false);
    });

    it('[P1] should delegate quality assessment to IngestionQualityAssessorService', async () => {
      const mockQualityAssessor = createMockQualityAssessor();
      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockQualityAssessor,
      );

      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      expect(mockQualityAssessor.runQualityAssessment).toHaveBeenCalledWith(
        'm1',
        expect.objectContaining({
          kalshiTicker: 'K1',
          polymarketTokenId: '0x1',
        }),
        expect.objectContaining({
          start: expect.any(Date),
          end: expect.any(Date),
        }),
        expect.any(String),
      );
    });
  });

  describe('progress tracking', () => {
    it('[P1] should track progress per contract via Map', async () => {
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      mockKalshi.ingestPrices.mockResolvedValue({ recordCount: 10 });
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 5 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 8 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 4 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
      );

      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      const progress = service.getProgress();
      expect(progress).toBeInstanceOf(Array);
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0]).toEqual(
        expect.objectContaining({
          contractId: expect.any(String),
          status: expect.stringMatching(/complete|failed/),
        }),
      );
    });

    it('[P1] should clear progress Map at the start of each run', async () => {
      const mockKalshi = createMockService();
      const mockPoly = createMockService();

      mockKalshi.ingestPrices.mockResolvedValue({ recordCount: 0 });
      mockKalshi.ingestTrades.mockResolvedValue({ recordCount: 0 });
      mockPoly.ingestPrices.mockResolvedValue({ recordCount: 0 });
      mockPoly.ingestTrades.mockResolvedValue({ recordCount: 0 });

      const mockPrisma = createMockPrisma();
      mockPrisma.contractMatch.findMany.mockResolvedValue([]);

      const service = createOrchestratorService(
        mockPrisma,
        mockKalshi,
        mockPoly,
      );

      // Run twice
      await service.runIngestion({
        dateRangeStart: new Date('2025-01-01'),
        dateRangeEnd: new Date('2025-02-01'),
      });
      await service.runIngestion({
        dateRangeStart: new Date('2025-02-01'),
        dateRangeEnd: new Date('2025-03-01'),
      });

      // Progress should reflect only the latest run
      const progress = service.getProgress();
      // No contracts = empty progress
      expect(progress).toHaveLength(0);
    });
  });

  // ============================================================
  // Story 10-9-1b: PMXT Archive + OddsPipe Source Integration
  // ============================================================

  describe('runIngestion — new sources (Story 10-9-1b)', () => {
    const dateRange = {
      dateRangeStart: new Date('2025-01-01'),
      dateRangeEnd: new Date('2025-03-01'),
    };

    function setupOnePrismaContract(prisma: any) {
      prisma.contractMatch.findMany.mockResolvedValue([
        {
          matchId: 'm1',
          kalshiContractId: 'K1',
          polymarketClobTokenId: '0x1',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ]);
    }

    it('[P1] should call PmxtArchiveService.ingestDepth for Polymarket contracts', async () => {
      const mockPmxt = createMockPmxtArchive();
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        undefined,
        mockPmxt,
      );

      await service.runIngestion(dateRange);
      expect(mockPmxt.ingestDepth).toHaveBeenCalledWith(
        '0x1',
        expect.objectContaining({
          start: expect.any(Date),
          end: expect.any(Date),
        }),
      );
    });

    it('[P1] should call OddsPipeService for Polymarket contracts only', async () => {
      const mockOddsPipe = createMockOddsPipe();
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        undefined,
        undefined,
        mockOddsPipe,
      );

      await service.runIngestion(dateRange);
      expect(mockOddsPipe.resolveMarketId).toHaveBeenCalledWith('0x1');
      expect(mockOddsPipe.ingestPrices).toHaveBeenCalledWith(
        42,
        '0x1',
        expect.objectContaining({
          start: expect.any(Date),
          end: expect.any(Date),
        }),
      );
    });

    it('[P1] should emit BacktestDataIngestedEvent with source PMXT_ARCHIVE', async () => {
      const mockEmitter = { emit: vi.fn() };
      const mockPmxt = createMockPmxtArchive();
      mockPmxt.ingestDepth.mockResolvedValue({
        recordCount: 50,
        source: 'PMXT_ARCHIVE',
      });
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        mockEmitter,
        mockPmxt,
      );

      await service.runIngestion(dateRange);
      const pmxtEvents = mockEmitter.emit.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'backtesting.data.ingested' &&
          c[1]?.source === 'PMXT_ARCHIVE',
      );
      expect(pmxtEvents).toHaveLength(1);
      expect(pmxtEvents[0]![1]).toEqual(
        expect.objectContaining({
          source: 'PMXT_ARCHIVE',
          platform: 'polymarket',
          recordCount: 50,
        }),
      );
    });

    it('[P1] should emit BacktestDataIngestedEvent with source ODDSPIPE', async () => {
      const mockEmitter = { emit: vi.fn() };
      const mockOddsPipe = createMockOddsPipe();
      mockOddsPipe.ingestPrices.mockResolvedValue({
        recordCount: 30,
        source: 'ODDSPIPE',
      });
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        mockEmitter,
        undefined,
        mockOddsPipe,
      );

      await service.runIngestion(dateRange);
      const oddsPipeEvents = mockEmitter.emit.mock.calls.filter(
        (c: any[]) =>
          c[0] === 'backtesting.data.ingested' && c[1]?.source === 'ODDSPIPE',
      );
      expect(oddsPipeEvents).toHaveLength(1);
      expect(oddsPipeEvents[0]![1]).toEqual(
        expect.objectContaining({
          source: 'ODDSPIPE',
          platform: 'polymarket',
          recordCount: 30,
        }),
      );
    });

    it('[P1] should skip OddsPipe ingestion when resolveMarketId returns null', async () => {
      const mockOddsPipe = createMockOddsPipe();
      mockOddsPipe.resolveMarketId.mockResolvedValue(null);
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        undefined,
        undefined,
        mockOddsPipe,
      );

      await service.runIngestion(dateRange);
      expect(mockOddsPipe.ingestPrices).not.toHaveBeenCalled();
    });

    it('[P1] should continue ingestion when PMXT source fails for a contract', async () => {
      const mockPmxt = createMockPmxtArchive();
      mockPmxt.ingestDepth.mockRejectedValueOnce(
        new Error('Parquet parse failed'),
      );
      const mockOddsPipe = createMockOddsPipe();
      const mockPrisma = createMockPrisma();
      setupOnePrismaContract(mockPrisma);

      const service = createOrchestratorService(
        mockPrisma,
        undefined,
        undefined,
        undefined,
        mockPmxt,
        mockOddsPipe,
      );

      await service.runIngestion(dateRange);
      expect(mockOddsPipe.ingestPrices).toHaveBeenCalled();
    });
  });
});
