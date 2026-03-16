/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
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
import type { IClusterClassifier } from '../../common/interfaces/cluster-classifier.interface';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaService } from '../../common/prisma.service';
import { asClusterId } from '../../common/types/branded.type';
import type { OutcomeDirectionValidator } from './outcome-direction-validator';

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
    ...(platform === PlatformId.POLYMARKET
      ? { clobTokenId: `clob-${id}` }
      : {}),
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
  let clusterClassifier: IClusterClassifier;
  let directionValidator: { validateDirection: ReturnType<typeof vi.fn> };
  let prisma: {
    contractMatch: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let configService: ConfigService;
  let schedulerRegistry: { addCronJob: ReturnType<typeof vi.fn> };

  const configValues: Record<string, string | number | boolean> = {
    DISCOVERY_ENABLED: true,
    DISCOVERY_CRON_EXPRESSION: '0 0 8,20 * * *',
    DISCOVERY_PREFILTER_THRESHOLD: 0.25,
    DISCOVERY_SETTLEMENT_WINDOW_DAYS: 7,
    DISCOVERY_MAX_CANDIDATES_PER_CONTRACT: 20,
    DISCOVERY_LLM_CONCURRENCY: 10,
    LLM_AUTO_APPROVE_THRESHOLD: 85,
    LLM_MIN_REVIEW_THRESHOLD: 40,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    catalogSync = { syncCatalogs: vi.fn() };
    preFilter = { filterCandidates: vi.fn() };
    scoringStrategy = { scoreMatch: vi.fn() };
    directionValidator = {
      validateDirection: vi.fn().mockResolvedValue({
        aligned: null,
        reason: 'Labels missing — skipping validation',
      }),
    };
    clusterClassifier = {
      classifyMatch: vi.fn().mockResolvedValue({
        clusterId: asClusterId('test-cluster-id'),
        clusterName: 'Test Cluster',
        rawCategories: [],
        wasLlmClassified: false,
      }),
      getOrCreateCluster: vi.fn(),
      reassignCluster: vi.fn(),
    };
    prisma = {
      contractMatch: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi
          .fn()
          .mockImplementation((args: { data: { matchId?: string } }) =>
            Promise.resolve({ matchId: 'new-match-id', ...args.data }),
          ),
        update: vi.fn().mockResolvedValue({}),
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
      clusterClassifier,
      directionValidator as unknown as OutcomeDirectionValidator,
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
      configValues['DISCOVERY_ENABLED'] = false;
      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        clusterClassifier,
        directionValidator as unknown as OutcomeDirectionValidator,
        prisma as unknown as PrismaService,
        eventEmitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      service.onModuleInit();
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();

      // Reset
      configValues['DISCOVERY_ENABLED'] = true;
    });

    it('should run discovery on startup when DISCOVERY_RUN_ON_STARTUP is true', () => {
      vi.useFakeTimers();
      configValues['DISCOVERY_RUN_ON_STARTUP'] = true;

      catalogSync.syncCatalogs.mockResolvedValue(new Map());

      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        clusterClassifier,
        directionValidator as unknown as OutcomeDirectionValidator,
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
      configValues['DISCOVERY_RUN_ON_STARTUP'] = false;
    });

    it('should not run discovery on startup when DISCOVERY_RUN_ON_STARTUP is false', () => {
      vi.useFakeTimers();
      configValues['DISCOVERY_RUN_ON_STARTUP'] = false;

      service = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        clusterClassifier,
        directionValidator as unknown as OutcomeDirectionValidator,
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
          polymarketClobTokenId: 'clob-P1',
          kalshiContractId: 'K1',
          confidenceScore: 90,
          operatorApproved: true,
        }),
      });
      // Cluster classification called for auto-approved match
      expect(clusterClassifier.classifyMatch).toHaveBeenCalledTimes(1);
      expect(prisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'new-match-id' },
        data: { clusterId: 'test-cluster-id' },
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CLUSTER_ASSIGNED,
        expect.anything(),
      );
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
            autoRejected: 0,
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
      // Cluster classification still runs for pending-review matches
      expect(clusterClassifier.classifyMatch).toHaveBeenCalledTimes(1);
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
            autoRejected: 0,
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

    it('should exclude candidates when candidate settlement date is undefined', async () => {
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

      expect(preFilterCalls[0]![1]).toHaveLength(0); // candidate excluded when date undefined
    });

    it('should exclude candidates when source settlement date is undefined', async () => {
      const noDatePoly = [
        makeContract(PlatformId.POLYMARKET, 'P-NODATE', {
          settlementDate: undefined,
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, noDatePoly],
          [PlatformId.KALSHI, [makeContract(PlatformId.KALSHI, 'K1')]],
        ]),
      );

      preFilter.filterCandidates.mockReturnValue([]);

      await service.runDiscovery();

      const preFilterCalls = preFilter.filterCandidates.mock.calls;
      expect(preFilterCalls).toHaveLength(1);

      expect(preFilterCalls[0]![1]).toHaveLength(0); // candidate excluded when source date undefined
    });

    it('should exclude candidates when both settlement dates are undefined', async () => {
      const noDatePoly = [
        makeContract(PlatformId.POLYMARKET, 'P-NODATE', {
          settlementDate: undefined,
        }),
      ];
      const noDateKalshi = [
        makeContract(PlatformId.KALSHI, 'K-NODATE', {
          settlementDate: undefined,
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, noDatePoly],
          [PlatformId.KALSHI, noDateKalshi],
        ]),
      );

      preFilter.filterCandidates.mockReturnValue([]);

      await service.runDiscovery();

      const preFilterCalls = preFilter.filterCandidates.mock.calls;
      expect(preFilterCalls).toHaveLength(1);

      expect(preFilterCalls[0]![1]).toHaveLength(0); // both excluded
    });

    it('should include candidates when both settlement dates are valid and within window', async () => {
      const nearPoly = [
        makeContract(PlatformId.POLYMARKET, 'P-NEAR', {
          settlementDate: new Date('2026-06-15'),
        }),
      ];
      const nearKalshi = [
        makeContract(PlatformId.KALSHI, 'K-NEAR', {
          settlementDate: new Date('2026-06-18'),
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, nearPoly],
          [PlatformId.KALSHI, nearKalshi],
        ]),
      );

      preFilter.filterCandidates.mockReturnValue([]);

      await service.runDiscovery();

      const preFilterCalls = preFilter.filterCandidates.mock.calls;
      expect(preFilterCalls).toHaveLength(1);

      expect(preFilterCalls[0]![1]).toHaveLength(1); // within 7 day window
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
            autoRejected: 0,
            pendingReview: 0,
            scoringFailures: 0,
          }),
        }),
      );
    });

    it('should auto-reject candidates with score below minReviewThreshold', async () => {
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
      ).mockResolvedValueOnce(makeScoringResult(25));

      await service.runDiscovery();

      // Match still created in DB (for record-keeping)
      expect(prisma.contractMatch.create).toHaveBeenCalledTimes(1);
      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: expect.stringContaining(
            'Auto-rejected: below review threshold',
          ),
        }),
      });

      // Cluster classification skipped for auto-rejected matches (no LLM cost)
      expect(clusterClassifier.classifyMatch).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.CLUSTER_ASSIGNED,
        expect.anything(),
      );

      // No match events emitted for auto-rejected
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.anything(),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.anything(),
      );
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.anything(),
      );

      // Stats should track autoRejected
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            autoRejected: 1,
            pendingReview: 0,
            autoApproved: 0,
          }),
        }),
      );
    });

    it('should emit pending review for scores between minReviewThreshold and autoApproveThreshold', async () => {
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
      ).mockResolvedValueOnce(makeScoringResult(60));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: null,
        }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            pendingReview: 1,
            autoRejected: 0,
            autoApproved: 0,
          }),
        }),
      );
    });

    it('should store polymarketClobTokenId as null when clobTokenId is undefined', async () => {
      const polyWithoutClob = [
        makeContract(PlatformId.POLYMARKET, 'P-NOCLOB', {
          clobTokenId: undefined,
        }),
      ];
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, polyWithoutClob],
          [PlatformId.KALSHI, kalshiContracts],
        ]),
      );

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

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          polymarketClobTokenId: null,
        }),
      });
    });

    describe('batch parallelization', () => {
      // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
      let logSpy: ReturnType<typeof vi.spyOn> | undefined;

      afterEach(() => {
        logSpy?.mockRestore();
        logSpy = undefined;
        configValues['DISCOVERY_LLM_CONCURRENCY'] = 10;
      });

      it('should continue processing when a candidate in the batch rejects', async () => {
        const kalshi3 = [
          makeContract(PlatformId.KALSHI, 'K1'),
          makeContract(PlatformId.KALSHI, 'K2'),
          makeContract(PlatformId.KALSHI, 'K3'),
        ];
        catalogSync.syncCatalogs.mockResolvedValue(
          new Map([
            [
              PlatformId.POLYMARKET,
              [makeContract(PlatformId.POLYMARKET, 'P1')],
            ],
            [PlatformId.KALSHI, kalshi3],
          ]),
        );

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
              combinedScore: 0.45,
              tfidfScore: 0.35,
              keywordOverlap: 0.55,
            },
            {
              id: 'K3',
              description: 'Title K3',
              combinedScore: 0.4,
              tfidfScore: 0.3,
              keywordOverlap: 0.5,
            },
          ])
          .mockReturnValue([]);

        (
          scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
        ).mockResolvedValue(makeScoringResult(90));

        // K1 succeeds, K2 throws non-P2002 error (bubbles up from processCandidate), K3 succeeds
        prisma.contractMatch.create
          .mockResolvedValueOnce({ matchId: 'match-1' })
          .mockRejectedValueOnce(new Error('DB connection lost'))
          .mockResolvedValueOnce({ matchId: 'match-3' });

        await service.runDiscovery();

        expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(3);
        expect(prisma.contractMatch.create).toHaveBeenCalledTimes(3);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
          expect.objectContaining({
            stats: expect.objectContaining({
              pairsScored: 2,
              autoApproved: 2,
              scoringFailures: 1,
            }),
          }),
        );
      });

      it('should respect DISCOVERY_LLM_CONCURRENCY config', async () => {
        logSpy = vi.spyOn(Logger.prototype, 'debug');

        configValues['DISCOVERY_LLM_CONCURRENCY'] = 2;
        service = new CandidateDiscoveryService(
          catalogSync as unknown as CatalogSyncService,
          preFilter as unknown as PreFilterService,
          scoringStrategy,
          clusterClassifier,
          directionValidator as unknown as OutcomeDirectionValidator,
          prisma as unknown as PrismaService,
          eventEmitter as unknown as EventEmitter2,
          configService,
          schedulerRegistry as unknown as SchedulerRegistry,
        );

        const kalshi5 = Array.from({ length: 5 }, (_, i) =>
          makeContract(PlatformId.KALSHI, `KX${i}`),
        );
        catalogSync.syncCatalogs.mockResolvedValue(
          new Map([
            [
              PlatformId.POLYMARKET,
              [makeContract(PlatformId.POLYMARKET, 'PX')],
            ],
            [PlatformId.KALSHI, kalshi5],
          ]),
        );

        preFilter.filterCandidates
          .mockReturnValueOnce(
            kalshi5.map((k, i) => ({
              id: k.contractId,
              description: k.title,
              combinedScore: 0.5 - i * 0.01,
              tfidfScore: 0.4,
              keywordOverlap: 0.6,
            })),
          )
          .mockReturnValue([]);

        (
          scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
        ).mockResolvedValue(makeScoringResult(90));

        await service.runDiscovery();

        expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(5);

        const batchLog = logSpy.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === 'object' &&
            call[0] !== null &&
            'message' in call[0] &&
            (call[0] as { message: string }).message ===
              'Candidate batch completed',
        );
        expect(batchLog).toBeDefined();
        expect(batchLog![0]).toEqual(
          expect.objectContaining({
            data: expect.objectContaining({
              candidateCount: 5,
              concurrency: 2,
            }),
          }),
        );
      });

      it('should emit timing log per polyContract with durationMs', async () => {
        logSpy = vi.spyOn(Logger.prototype, 'debug');

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
              combinedScore: 0.45,
              tfidfScore: 0.35,
              keywordOverlap: 0.55,
            },
          ])
          .mockReturnValue([]);

        (
          scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
        ).mockResolvedValue(makeScoringResult(90));

        await service.runDiscovery();

        const batchLog = logSpy.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === 'object' &&
            call[0] !== null &&
            'message' in call[0] &&
            (call[0] as { message: string }).message ===
              'Candidate batch completed' &&
            'data' in call[0] &&
            (call[0] as { data: { candidateCount: number } }).data
              .candidateCount > 0,
        );
        expect(batchLog).toBeDefined();
        const data = (batchLog![0] as { data: Record<string, unknown> }).data;
        expect(data.candidateCount).toBe(2);
        expect(data.concurrency).toBe(10);
        expect(typeof data.durationMs).toBe('number');
      });

      it('should emit timing log with candidateCount 0 when no Kalshi matches found', async () => {
        logSpy = vi.spyOn(Logger.prototype, 'debug');

        // Pre-filter returns candidates whose IDs don't match any Kalshi contract
        preFilter.filterCandidates
          .mockReturnValueOnce([
            {
              id: 'NONEXISTENT1',
              description: 'No match',
              combinedScore: 0.5,
              tfidfScore: 0.4,
              keywordOverlap: 0.6,
            },
            {
              id: 'NONEXISTENT2',
              description: 'No match',
              combinedScore: 0.45,
              tfidfScore: 0.35,
              keywordOverlap: 0.55,
            },
          ])
          .mockReturnValue([]);

        await service.runDiscovery();

        expect(scoringStrategy.scoreMatch).not.toHaveBeenCalled();

        const batchLog = logSpy.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === 'object' &&
            call[0] !== null &&
            'message' in call[0] &&
            (call[0] as { message: string }).message ===
              'Candidate batch completed',
        );
        expect(batchLog).toBeDefined();
        const data = (batchLog![0] as { data: Record<string, unknown> }).data;
        expect(data.candidateCount).toBe(0);
        expect(typeof data.durationMs).toBe('number');
      });

      it('should floor concurrency to 1 when DISCOVERY_LLM_CONCURRENCY is 0', async () => {
        logSpy = vi.spyOn(Logger.prototype, 'debug');

        configValues['DISCOVERY_LLM_CONCURRENCY'] = 0;
        service = new CandidateDiscoveryService(
          catalogSync as unknown as CatalogSyncService,
          preFilter as unknown as PreFilterService,
          scoringStrategy,
          clusterClassifier,
          directionValidator as unknown as OutcomeDirectionValidator,
          prisma as unknown as PrismaService,
          eventEmitter as unknown as EventEmitter2,
          configService,
          schedulerRegistry as unknown as SchedulerRegistry,
        );

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

        expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(1);
        expect(prisma.contractMatch.create).toHaveBeenCalledTimes(1);

        // Verify concurrency actually floored to 1 (not silently using default 10)
        const batchLog = logSpy.mock.calls.find(
          (call: unknown[]) =>
            typeof call[0] === 'object' &&
            call[0] !== null &&
            'message' in call[0] &&
            (call[0] as { message: string }).message ===
              'Candidate batch completed',
        );
        expect(batchLog).toBeDefined();
        expect(
          (batchLog![0] as { data: { concurrency: number } }).data.concurrency,
        ).toBe(1);
      });
    });
  });

  describe('three-tier scoring boundary values', () => {
    const polyContracts = [makeContract(PlatformId.POLYMARKET, 'P1')];
    const kalshiContracts = [makeContract(PlatformId.KALSHI, 'K1')];

    beforeEach(() => {
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, polyContracts],
          [PlatformId.KALSHI, kalshiContracts],
        ]),
      );
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
    });

    it('should auto-reject at score 39 (one below minReviewThreshold)', async () => {
      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(39));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: expect.stringContaining(
            'Auto-rejected: below review threshold',
          ),
        }),
      });
      // No cluster classification for auto-rejected
      expect(clusterClassifier.classifyMatch).not.toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            autoRejected: 1,
            pendingReview: 0,
            autoApproved: 0,
          }),
        }),
      );
    });

    it('should pending-review at score 40 (exactly minReviewThreshold) and classify cluster', async () => {
      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(40));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: null,
        }),
      });
      // Score 40 is at the boundary — classification DOES run
      expect(clusterClassifier.classifyMatch).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            pendingReview: 1,
            autoRejected: 0,
            autoApproved: 0,
          }),
        }),
      );
    });

    it('should pending-review at score 84 (one below autoApproveThreshold)', async () => {
      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(84));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: null,
        }),
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.anything(),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.DISCOVERY_RUN_COMPLETED,
        expect.objectContaining({
          stats: expect.objectContaining({
            pendingReview: 1,
            autoRejected: 0,
            autoApproved: 0,
          }),
        }),
      );
    });

    it('should auto-approve at score 85 (exactly autoApproveThreshold)', async () => {
      (
        scoringStrategy.scoreMatch as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(makeScoringResult(85));

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: true,
        }),
      });
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
            autoRejected: 0,
          }),
        }),
      );
    });
  });

  describe('threshold validation', () => {
    it('should throw ConfigValidationError when minReviewThreshold >= autoApproveThreshold', () => {
      configValues['LLM_MIN_REVIEW_THRESHOLD'] = 85;
      configValues['LLM_AUTO_APPROVE_THRESHOLD'] = 85;

      const invalidService = new CandidateDiscoveryService(
        catalogSync as unknown as CatalogSyncService,
        preFilter as unknown as PreFilterService,
        scoringStrategy,
        clusterClassifier,
        directionValidator as unknown as OutcomeDirectionValidator,
        prisma as unknown as PrismaService,
        eventEmitter as unknown as EventEmitter2,
        configService,
        schedulerRegistry as unknown as SchedulerRegistry,
      );

      expect(() => invalidService.onModuleInit()).toThrow(
        'LLM_MIN_REVIEW_THRESHOLD',
      );

      // Reset
      configValues['LLM_MIN_REVIEW_THRESHOLD'] = 40;
      configValues['LLM_AUTO_APPROVE_THRESHOLD'] = 85;
    });
  });

  describe('outcome direction validation gate', () => {
    const polyContracts = [
      makeContract(PlatformId.POLYMARKET, 'P1', {
        outcomeLabel: 'Fighter A wins',
        outcomeTokens: [
          { tokenId: 'token-a', outcomeLabel: 'Fighter A wins' },
          { tokenId: 'token-b', outcomeLabel: 'Fighter B wins' },
        ],
      }),
    ];
    const kalshiContracts = [
      makeContract(PlatformId.KALSHI, 'K1', {
        outcomeLabel: 'Fighter B wins',
      }),
    ];

    beforeEach(() => {
      catalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, polyContracts],
          [PlatformId.KALSHI, kalshiContracts],
        ]),
      );
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
      ).mockResolvedValue(makeScoringResult(90));
    });

    it('should block auto-approval when direction is mismatched', async () => {
      directionValidator.validateDirection.mockResolvedValue({
        aligned: false,
        reason: 'No aligning token found',
      });

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: false,
          confidenceScore: 50,
          divergenceNotes: expect.stringContaining('Direction mismatch'),
        }),
      });
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.anything(),
      );
    });

    it('should apply self-correction when validator provides correctedTokenId', async () => {
      directionValidator.validateDirection.mockResolvedValue({
        aligned: true,
        correctedTokenId: 'token-b',
        correctedLabel: 'Fighter B wins',
        reason: 'Self-corrected: swapped token',
      });

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          polymarketClobTokenId: 'token-b',
          operatorApproved: true,
          polymarketOutcomeLabel: 'Fighter B wins',
        }),
      });
    });

    it('should proceed normally when aligned=null (labels missing)', async () => {
      directionValidator.validateDirection.mockResolvedValue({
        aligned: null,
        reason: 'Labels missing',
      });

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operatorApproved: true,
          confidenceScore: 90,
        }),
      });
    });

    it('should persist outcome labels in ContractMatch creation', async () => {
      directionValidator.validateDirection.mockResolvedValue({
        aligned: true,
        reason: 'Substring match',
      });

      await service.runDiscovery();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          polymarketOutcomeLabel: 'Fighter A wins',
          kalshiOutcomeLabel: 'Fighter B wins',
        }),
      });
    });
  });
});
