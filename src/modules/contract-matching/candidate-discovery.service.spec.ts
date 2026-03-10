/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import { CatalogSyncService } from './catalog-sync.service';
import { PreFilterService } from './pre-filter.service';
import { PlatformId } from '../../common/types/platform.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { LlmScoringError } from '../../common/errors/llm-scoring-error';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface';
import type {
  IScoringStrategy,
  ScoringResult,
} from '../../common/interfaces/scoring-strategy.interface';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaService } from '../../common/prisma.service';

vi.mock('../../common/services/correlation-context', () => ({
  withCorrelationId: <T>(fn: () => Promise<T>) => fn(),
  getCorrelationId: () => 'test-corr-id',
}));

function makeContract(
  platform: PlatformId,
  id: string,
  overrides: Partial<ContractSummary> = {},
): ContractSummary {
  return {
    contractId: id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    platform,
    settlementDate: new Date('2026-06-15'),
    ...overrides,
  };
}

function makeScoringResult(score: number): ScoringResult {
  return {
    score,
    confidence: score >= 80 ? 'high' : 'medium',
    reasoning: 'test reasoning',
    model: 'test-model',
    escalated: false,
  };
}

describe('CandidateDiscoveryService', () => {
  let service: CandidateDiscoveryService;
  let catalogSync: { syncCatalogs: ReturnType<typeof vi.fn> };
  let preFilter: { filterCandidates: ReturnType<typeof vi.fn> };
  let scoringStrategy: IScoringStrategy;
  let prisma: {
    contractMatch: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let configService: ConfigService;
  let schedulerRegistry: { addCronJob: ReturnType<typeof vi.fn> };

  const configValues: Record<string, string | number> = {
    DISCOVERY_ENABLED: 'true',
    DISCOVERY_CRON_EXPRESSION: '0 0 8,20 * * *',
    DISCOVERY_PREFILTER_THRESHOLD: 0.15,
    DISCOVERY_SETTLEMENT_WINDOW_DAYS: 7,
    DISCOVERY_MAX_CANDIDATES_PER_CONTRACT: 20,
    LLM_AUTO_APPROVE_THRESHOLD: 85,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    catalogSync = { syncCatalogs: vi.fn() };
    preFilter = { filterCandidates: vi.fn() };
    scoringStrategy = { scoreMatch: vi.fn() };
    prisma = {
      contractMatch: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi
          .fn()
          .mockImplementation((args: { data: { matchId?: string } }) =>
            Promise.resolve({ matchId: 'new-match-id', ...args.data }),
          ),
      },
    };
    eventEmitter = { emit: vi.fn() };
    configService = {
      get: vi.fn(
        (key: string, defaultVal?: unknown) => configValues[key] ?? defaultVal,
      ),
    } as unknown as ConfigService;
    schedulerRegistry = { addCronJob: vi.fn() };

    service = new CandidateDiscoveryService(
      catalogSync as unknown as CatalogSyncService,
      preFilter as unknown as PreFilterService,
      scoringStrategy,
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      configService,
      schedulerRegistry as unknown as SchedulerRegistry,
    );
  });

  describe('onModuleInit', () => {
    it('should register cron job when discovery is enabled', () => {
      service.onModuleInit();
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'candidate-discovery',
        expect.anything(),
      );
    });

    it('should not register cron job when discovery is disabled', () => {
      configValues['DISCOVERY_ENABLED'] = 'false';
      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        prisma as unknown as PrismaService,
        eventEmitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      service.onModuleInit();
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();

      // Reset
      configValues['DISCOVERY_ENABLED'] = 'true';
    });

    it('should run discovery on startup when DISCOVERY_RUN_ON_STARTUP is true', () => {
      vi.useFakeTimers();
      configValues['DISCOVERY_RUN_ON_STARTUP'] = 'true';

      catalogSync.syncCatalogs.mockResolvedValue(new Map());

      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        prisma as unknown as PrismaService,
        eventEmitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      service.onModuleInit();

      // Discovery not called yet (setTimeout pending)
      expect(catalogSync.syncCatalogs).not.toHaveBeenCalled();

      // Advance past the 3-second delay
      vi.advanceTimersByTime(3500);

      expect(catalogSync.syncCatalogs).toHaveBeenCalled();

      vi.useRealTimers();
      configValues['DISCOVERY_RUN_ON_STARTUP'] = 'false';
    });

    it('should not run discovery on startup when DISCOVERY_RUN_ON_STARTUP is false', () => {
      vi.useFakeTimers();
      configValues['DISCOVERY_RUN_ON_STARTUP'] = 'false';

      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        prisma as unknown as PrismaService,
        eventEmitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      service.onModuleInit();
      vi.advanceTimersByTime(5000);

      expect(catalogSync.syncCatalogs).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('runDiscovery', () => {
    const polyContracts = [
      makeContract(PlatformId.POLYMARKET, 'P1'),
      makeContract(PlatformId.POLYMARKET, 'P2'),
    ];
    const kalshiContracts = [
      makeContract(PlatformId.KALSHI, 'K1'),
      makeContract(PlatformId.KALSHI, 'K2'),
    ];

    beforeEach(() => {
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, polyContracts],
          [PlatformId.KALSHI, kalshiContracts],
        ]),
      );
    });

    it('should run full pipeline: prefilter → score → create match → emit events', async () => {
      preFilter.filterCandidates
        .mockReturnValueOnce([
          {
            id: 'K1',
            description: 'Title K1',
            combinedScore: 0.5,
            tfidfScore: 0.4,
            keywordOverlap: 0.6,
          },
        ])
        .mockReturnValue([]);

      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(90));

      await service.runDiscovery();

      // Score called once (P1→K1)
      expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(1);
      // Match created
      expect(prisma.contractMatch.create).toHaveBeenCalledTimes(1);
      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          polymarketContractId: 'P1',
          kalshiContractId: 'K1',
          confidenceScore: 90,
          operatorApproved: true,
        }),
      });
      // Events: MatchApproved + MatchAutoApproved + DiscoveryRunCompleted
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            autoApproved: 1,
            pendingReview: 0,
            scoringFailures: 0,
          }),
        }),
      );
    });

    it('should emit pending review event when score is below auto-approve threshold', async () => {
      preFilter.filterCandidates
        .mockReturnValueOnce([
          {
            id: 'K1',
            description: 'Title K1',
            combinedScore: 0.5,
            tfidfScore: 0.4,
            keywordOverlap: 0.6,
          },
        ])
        .mockReturnValue([]);

      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(70));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorApprovalTimestamp: null,
          operatorRationale: null,
        }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.anything(),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.anything(),
      );
    });

    it('should skip pairs already in the database', async () => {
      preFilter.filterCandidates
        .mockReturnValueOnce([
          {
            id: 'K1',
            description: 'Title K1',
            combinedScore: 0.5,
            tfidfScore: 0.4,
            keywordOverlap: 0.6,
          },
        ])
        .mockReturnValue([]);

      // Pair already exists in DB
      prisma.contractMatch.findFirst.mockResolvedValueOnce({
        matchId: 'existing',
      });

      await service.runDiscovery();

      expect(scoringStrategy.scoreMatch).not.toHaveBeenCalled();
      expect(prisma.contractMatch.create).not.toHaveBeenCalled();
    });

    it('should continue pipeline when LLM scoring fails', async () => {
      preFilter.filterCandidates
        .mockReturnValueOnce([
          {
            id: 'K1',
            description: 'Title K1',
            combinedScore: 0.5,
            tfidfScore: 0.4,
            keywordOverlap: 0.6,
          },
          {
            id: 'K2',
            description: 'Title K2',
            combinedScore: 0.4,
            tfidfScore: 0.3,
            keywordOverlap: 0.5,
          },
        ])
        .mockReturnValue([]);

      (scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(
          new LlmScoringError(4100, 'API down', 'test-model', 'test-provider'),
        )
        .mockResolvedValueOnce(makeScoringResult(90));

      await service.runDiscovery();

      // First fails, second succeeds
      expect(prisma.contractMatch.create).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            scoringFailures: 1,
            autoApproved: 1,
          }),
        }),
      );
    });

    it('should early-return when fewer than 2 platforms have catalogs', async () => {
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([[PlatformId.KALSHI, kalshiContracts]]),
      );

      await service.runDiscovery();

      expect(preFilter.filterCandidates).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            catalogsFetched: 1,
            pairsScored: 0,
          }),
        }),
      );
    });

    it('should filter by settlement date window', async () => {
      const farFutureKalshi = [
        makeContract(PlatformId.KALSHI, 'K-FAR', {
          settlementDate: new Date('2027-12-31'),
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [makeContract(PlatformId.POLYMARKET, 'P1')]],
          [PlatformId.KALSHI, farFutureKalshi],
        ]),
      );

      // Pre-filter won't be called with candidates outside the window
      preFilter.filterCandidates.mockReturnValue([]);

      await service.runDiscovery();

      // The far-future K-FAR should be filtered out before pre-filter
      // Since P1 has settlement 2026-06-15 and K-FAR has 2027-12-31, diff > 7 days
      const preFilterCalls = preFilter.filterCandidates.mock.calls;
      expect(preFilterCalls).toHaveLength(1);

      expect(preFilterCalls[0]![1]).toHaveLength(0); // no candidates passed date filter
    });

    it('should not filter by date when settlement date is undefined', async () => {
      const noDateKalshi = [
        makeContract(PlatformId.KALSHI, 'K-NODATE', {
          settlementDate: undefined,
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [makeContract(PlatformId.POLYMARKET, 'P1')]],
          [PlatformId.KALSHI, noDateKalshi],
        ]),
      );

      preFilter.filterCandidates.mockReturnValue([]);

      await service.runDiscovery();

      const preFilterCalls = preFilter.filterCandidates.mock.calls;
      expect(preFilterCalls).toHaveLength(1);

      expect(preFilterCalls[0]![1]).toHaveLength(1); // candidate passes when date unknown
    });

    it('should limit candidates per contract via DISCOVERY_MAX_CANDIDATES_PER_CONTRACT', async () => {
      // Create 30 Kalshi contracts so the find() lookup succeeds
      const manyKalshi = Array.from({ length: 30 }, (_, i) =>
        makeContract(PlatformId.KALSHI, `KX${i}`),
      );
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [makeContract(PlatformId.POLYMARKET, 'PX')]],
          [PlatformId.KALSHI, manyKalshi],
        ]),
      );

      const manyCandidates = Array.from({ length: 30 }, (_, i) => ({
        id: `KX${i}`,
        description: `Title KX${i}`,
        combinedScore: 0.5 - i * 0.01,
        tfidfScore: 0.4,
        keywordOverlap: 0.6,
      }));

      preFilter.filterCandidates.mockReturnValue(manyCandidates);

      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValue(makeScoringResult(90));

      await service.runDiscovery();

      // Max 20 candidates scored per contract
      expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(20);
    });

    it('should handle P2002 unique constraint violation as a race condition', async () => {
      preFilter.filterCandidates
        .mockReturnValueOnce([
          {
            id: 'K1',
            description: 'Title K1',
            combinedScore: 0.5,
            tfidfScore: 0.4,
            keywordOverlap: 0.6,
          },
        ])
        .mockReturnValue([]);

      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(90));

      // Simulate race condition: findFirst returns null, but create fails with P2002
      const p2002Error = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
      });
      prisma.contractMatch.create.mockRejectedValueOnce(p2002Error);

      await service.runDiscovery();

      // Should NOT count as a scoring failure (it's a benign race condition)
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            pairsScored: 0,
            scoringFailures: 0,
          }),
        }),
      );
      // No match events emitted since create failed
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.anything(),
      );
    });

    it('should emit DiscoveryRunCompletedEvent with correct stats', async () => {
      preFilter.filterCandidates.mockReturnValue([]);
      await service.runDiscovery();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            catalogsFetched: 2,
            candidatesPreFiltered: 0,
            pairsScored: 0,
            autoApproved: 0,
            pendingReview: 0,
            scoringFailures: 0,
          }),
        }),
      );
    });
  });
});
