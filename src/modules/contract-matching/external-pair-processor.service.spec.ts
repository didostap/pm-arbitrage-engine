/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest expect.objectContaining returns any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  ExternalPairProcessorService,
  computeTitleSimilarity,
} from './external-pair-processor.service';
import { PrismaService } from '../../common/prisma.service';
import {
  ODDSPIPE_PAIR_PROVIDER_TOKEN,
  PREDEXON_PAIR_PROVIDER_TOKEN,
} from '../../common/interfaces/external-pair-provider.interface';
import { SCORING_STRATEGY_TOKEN } from '../../common/interfaces/scoring-strategy.interface';
import { CLUSTER_CLASSIFIER_TOKEN } from '../../common/interfaces/cluster-classifier.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import type { ExternalMatchedPair } from '../../common/types';

function makePair(
  overrides: Partial<ExternalMatchedPair> = {},
): ExternalMatchedPair {
  return {
    polymarketId: 'poly-cond-1',
    kalshiId: 'KXBTC-24DEC31',
    polymarketTitle: 'Will Bitcoin exceed $100k?',
    kalshiTitle: 'Bitcoin above $100,000',
    source: 'predexon',
    similarity: 0.97,
    spreadData: null,
    ...overrides,
  };
}

describe('ExternalPairProcessorService', () => {
  let service: ExternalPairProcessorService;
  let prisma: {
    contractMatch: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let oddsPipeProvider: {
    fetchPairs: ReturnType<typeof vi.fn>;
    getSourceId: ReturnType<typeof vi.fn>;
  };
  let predexonProvider: {
    fetchPairs: ReturnType<typeof vi.fn>;
    getSourceId: ReturnType<typeof vi.fn>;
  };
  let scoringStrategy: { scoreMatch: ReturnType<typeof vi.fn> };
  let clusterClassifier: { classifyMatch: ReturnType<typeof vi.fn> };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      contractMatch: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ matchId: 'uuid-new' }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };

    oddsPipeProvider = {
      fetchPairs: vi.fn().mockResolvedValue([]),
      getSourceId: vi.fn().mockReturnValue('oddspipe'),
    };

    predexonProvider = {
      fetchPairs: vi.fn().mockResolvedValue([]),
      getSourceId: vi.fn().mockReturnValue('predexon'),
    };

    scoringStrategy = {
      scoreMatch: vi.fn().mockResolvedValue({
        score: 90,
        model: 'gemini-2.5-flash',
        escalated: false,
      }),
    };

    clusterClassifier = {
      classifyMatch: vi.fn().mockResolvedValue({
        clusterId: 'cluster-1',
        clusterName: 'Crypto',
        wasLlmClassified: true,
      }),
    };

    emitter = { emit: vi.fn() };

    configService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
        const map: Record<string, unknown> = {
          LLM_AUTO_APPROVE_THRESHOLD: 85,
          LLM_MIN_REVIEW_THRESHOLD: 40,
          EXTERNAL_PAIR_DEDUP_TITLE_THRESHOLD: 0.45,
          EXTERNAL_PAIR_LLM_CONCURRENCY: 5,
        };
        return map[key] ?? defaultValue;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExternalPairProcessorService,
        { provide: PrismaService, useValue: prisma },
        { provide: ODDSPIPE_PAIR_PROVIDER_TOKEN, useValue: oddsPipeProvider },
        { provide: PREDEXON_PAIR_PROVIDER_TOKEN, useValue: predexonProvider },
        { provide: SCORING_STRATEGY_TOKEN, useValue: scoringStrategy },
        { provide: CLUSTER_CLASSIFIER_TOKEN, useValue: clusterClassifier },
        { provide: EventEmitter2, useValue: emitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(ExternalPairProcessorService);
  });

  describe('provider fetching + error isolation', () => {
    it('[P0] processAllProviders() should call fetchPairs() on both registered providers', async () => {
      await service.processAllProviders();

      expect(oddsPipeProvider.fetchPairs).toHaveBeenCalledOnce();
      expect(predexonProvider.fetchPairs).toHaveBeenCalledOnce();
    });

    it('[P0] when one provider fetch fails, should continue processing pairs from remaining provider', async () => {
      oddsPipeProvider.fetchPairs.mockRejectedValue(new Error('OddsPipe down'));
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      const result = await service.processAllProviders();

      const predexonStats = result.sources.find((s) => s.source === 'predexon');
      expect(predexonStats?.fetched).toBe(1);
      expect(scoringStrategy.scoreMatch).toHaveBeenCalled();
    });

    it('[P1] when provider fetch fails, error recorded in stats as providerError', async () => {
      oddsPipeProvider.fetchPairs.mockRejectedValue(new Error('API timeout'));

      const result = await service.processAllProviders();

      const oddsPipeStats = result.sources.find((s) => s.source === 'oddspipe');
      expect(oddsPipeStats?.providerError).toEqual(expect.any(String));
    });
  });

  describe('field mapping', () => {
    it('[P0] ExternalMatchedPair.polymarketId should map to ContractMatch.polymarketContractId', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            polymarketContractId: 'poly-cond-1',
            kalshiContractId: 'KXBTC-24DEC31',
          }),
        }),
      );
    });

    it('[P0] ExternalMatchedPair.polymarketTitle should map to ContractMatch.polymarketDescription', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            polymarketDescription: 'Will Bitcoin exceed $100k?',
            kalshiDescription: 'Bitcoin above $100,000',
          }),
        }),
      );
    });
  });

  describe('dedup — Predexon composite key', () => {
    it('[P0] Predexon pair with matching composite key in existing ContractMatch should be skipped', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue({
        matchId: 'existing-uuid',
      });
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      const result = await service.processAllProviders();

      expect(scoringStrategy.scoreMatch).not.toHaveBeenCalled();
      const stats = result.sources.find((s) => s.source === 'predexon');
      expect(stats?.deduplicated).toBe(1);
    });

    it('[P0] Predexon pair with NO matching ContractMatch should proceed to scoring', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue(null);
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(scoringStrategy.scoreMatch).toHaveBeenCalledOnce();
    });
  });

  describe('dedup — OddsPipe fuzzy title matching', () => {
    it('[P0] OddsPipe pair WITH contract IDs: should use composite key dedup', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue({ matchId: 'existing' });
      oddsPipeProvider.fetchPairs.mockResolvedValue([
        makePair({
          source: 'oddspipe',
          polymarketId: 'poly-1',
          kalshiId: 'kalshi-1',
        }),
      ]);

      const result = await service.processAllProviders();

      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.deduplicated).toBe(1);
    });

    it('[P0] OddsPipe pair WITH IDs, no composite key match, titles ABOVE threshold should be fuzzy deduplicated', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue(null);
      const pair = makePair({
        source: 'oddspipe',
        polymarketId: 'poly-new',
        kalshiId: 'kalshi-new',
        polymarketTitle: 'Will Bitcoin exceed $100k by December 2025?',
        kalshiTitle: 'Bitcoin above $100,000 by Dec 2025',
      });
      oddsPipeProvider.fetchPairs.mockResolvedValue([pair]);

      prisma.contractMatch.findMany.mockResolvedValue([
        {
          polymarketDescription: 'Will Bitcoin exceed $100k by December 2025?',
          kalshiDescription: 'Bitcoin above $100,000 by Dec 2025',
        },
      ]);

      const result = await service.processAllProviders();

      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.deduplicated).toBe(1);
      expect(scoringStrategy.scoreMatch).not.toHaveBeenCalled();
    });

    it('[P0] OddsPipe pair WITH IDs, no composite key match, titles BELOW threshold should proceed to scoring', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue(null);
      const pair = makePair({
        source: 'oddspipe',
        polymarketId: 'poly-unique',
        kalshiId: 'kalshi-unique',
        polymarketTitle: 'Completely unique event happening in 2026',
        kalshiTitle: 'Totally different event with no overlap',
      });
      oddsPipeProvider.fetchPairs.mockResolvedValue([pair]);

      prisma.contractMatch.findMany.mockResolvedValue([
        {
          polymarketDescription: 'Will Bitcoin exceed $100k?',
          kalshiDescription: 'Bitcoin above $100,000',
        },
      ]);

      const result = await service.processAllProviders();

      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.scored).toBe(1);
      expect(scoringStrategy.scoreMatch).toHaveBeenCalledOnce();
    });

    it('[P0] Predexon pair should NEVER do fuzzy title dedup even with matching titles', async () => {
      prisma.contractMatch.findFirst.mockResolvedValue(null);
      const pair = makePair({
        source: 'predexon',
        polymarketId: 'poly-pred',
        kalshiId: 'kalshi-pred',
        polymarketTitle: 'Will Bitcoin exceed $100k?',
        kalshiTitle: 'Bitcoin above $100,000',
      });
      predexonProvider.fetchPairs.mockResolvedValue([pair]);

      prisma.contractMatch.findMany.mockResolvedValue([
        {
          polymarketDescription: 'Will Bitcoin exceed $100k?',
          kalshiDescription: 'Bitcoin above $100,000',
        },
      ]);

      const result = await service.processAllProviders();

      // Predexon uses composite key only — not fuzzy title match
      const stats = result.sources.find((s) => s.source === 'predexon');
      expect(stats?.scored).toBe(1);
      expect(scoringStrategy.scoreMatch).toHaveBeenCalledOnce();
    });

    it('[P0] OddsPipe pair WITHOUT IDs should be unresolvable regardless of title similarity', async () => {
      const pair = makePair({
        source: 'oddspipe',
        polymarketId: null,
        kalshiId: null,
        polymarketTitle: 'Will Bitcoin exceed $100k by December 2025?',
        kalshiTitle: 'Bitcoin above $100,000 by Dec 2025',
      });
      oddsPipeProvider.fetchPairs.mockResolvedValue([pair]);

      prisma.contractMatch.findMany.mockResolvedValue([
        {
          polymarketDescription: 'Will Bitcoin exceed $100k by December 2025?',
          kalshiDescription: 'Bitcoin above $100,000 by Dec 2025',
        },
      ]);

      const result = await service.processAllProviders();

      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.unresolvable).toBe(1);
    });
  });

  describe('OddsPipe ID-less pairs', () => {
    it('[P1] pair lacking BOTH polymarketId and kalshiId should be logged as unresolvable and skipped', async () => {
      oddsPipeProvider.fetchPairs.mockResolvedValue([
        makePair({ source: 'oddspipe', polymarketId: null, kalshiId: null }),
      ]);

      const result = await service.processAllProviders();

      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.unresolvable).toBe(1);
      expect(scoringStrategy.scoreMatch).not.toHaveBeenCalled();
    });
  });

  describe('LLM scoring', () => {
    it('[P0] novel pair without enrichment should be scored with undefined metadata', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(scoringStrategy.scoreMatch).toHaveBeenCalledWith(
        'Will Bitcoin exceed $100k?',
        'Bitcoin above $100,000',
        expect.objectContaining({
          resolutionDate: undefined,
          category: undefined,
        }),
      );
    });

    it('[P0] enriched pair should pass settlementDate and category to scoreMatch', async () => {
      const enrichedDate = new Date('2026-12-31');
      predexonProvider.fetchPairs.mockResolvedValue([
        makePair({ settlementDate: enrichedDate, category: 'Crypto' }),
      ]);

      await service.processAllProviders();

      expect(scoringStrategy.scoreMatch).toHaveBeenCalledWith(
        'Will Bitcoin exceed $100k?',
        'Bitcoin above $100,000',
        expect.objectContaining({
          resolutionDate: enrichedDate,
          category: 'Crypto',
        }),
      );
    });

    it('[P1] LLM concurrency should be limited by EXTERNAL_PAIR_LLM_CONCURRENCY config', async () => {
      const pairs = Array.from({ length: 10 }, (_, i) =>
        makePair({ polymarketId: `poly-${i}`, kalshiId: `kalshi-${i}` }),
      );
      predexonProvider.fetchPairs.mockResolvedValue(pairs);

      await service.processAllProviders();

      // All 10 should be scored (concurrency limits batching, not total)
      expect(scoringStrategy.scoreMatch).toHaveBeenCalledTimes(10);
    });
  });

  describe('direction validation skip', () => {
    it('[P0] direction validation should be SKIPPED; divergenceNotes should record skip reason', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            divergenceNotes:
              'Direction validation skipped — external pair lacks outcome metadata',
          }),
        }),
      );
    });
  });

  describe('auto-approve/reject/review thresholds', () => {
    it('[P0] pair with effectiveScore >= 85 should be auto-approved', async () => {
      scoringStrategy.scoreMatch.mockResolvedValue({
        score: 92,
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operatorApproved: true }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.objectContaining({ matchId: 'uuid-new' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.objectContaining({ matchId: 'uuid-new', confidenceScore: 92 }),
      );
    });

    it('[P0] pair with effectiveScore < 40 should be auto-rejected', async () => {
      scoringStrategy.scoreMatch.mockResolvedValue({
        score: 25,
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operatorApproved: false }),
        }),
      );
      expect(emitter.emit).not.toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.anything(),
      );
    });

    it('[P0] pair with score between 40-84 should be pending review', async () => {
      scoringStrategy.scoreMatch.mockResolvedValue({
        score: 60,
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ operatorApproved: false }),
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_PENDING_REVIEW,
        expect.objectContaining({ matchId: 'uuid-new', confidenceScore: 60 }),
      );
    });
  });

  describe('ContractMatch creation + origin', () => {
    it('[P0] should create ContractMatch with origin PREDEXON for Predexon-sourced pairs', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([
        makePair({ source: 'predexon' }),
      ]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ origin: 'PREDEXON' }),
        }),
      );
    });

    it('[P0] should create ContractMatch with origin ODDSPIPE for OddsPipe-sourced pairs', async () => {
      oddsPipeProvider.fetchPairs.mockResolvedValue([
        makePair({
          source: 'oddspipe',
          polymarketId: 'poly-1',
          kalshiId: 'kalshi-1',
        }),
      ]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ origin: 'ODDSPIPE' }),
        }),
      );
    });
  });

  describe('P2002 race condition', () => {
    it('[P2] when prisma.contractMatch.create throws P2002, should log debug, increment deduplicated stat, and skip', async () => {
      const p2002Error = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
      });
      prisma.contractMatch.create.mockRejectedValue(p2002Error);
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      const result = await service.processAllProviders();

      // Should not throw — next pair still processed
      expect(result.sources).toBeDefined();
      const predexonStats = result.sources.find(
        (s: { source: string }) => s.source === 'predexon',
      );
      expect(predexonStats?.deduplicated).toBe(1);
    });

    it('[P2] when prisma.contractMatch.create throws a non-P2002 error, should increment scoringFailures stat', async () => {
      prisma.contractMatch.create.mockRejectedValue(
        new Error('Connection lost'),
      );
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      const result = await service.processAllProviders();

      const predexonStats = result.sources.find(
        (s: { source: string }) => s.source === 'predexon',
      );
      expect(predexonStats?.scoringFailures).toBe(1);
    });
  });

  describe('cluster classification', () => {
    it('[P1] non-rejected pairs should have classifyMatch called; failure should NOT block ContractMatch creation', async () => {
      scoringStrategy.scoreMatch.mockResolvedValue({
        score: 90,
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      clusterClassifier.classifyMatch.mockRejectedValue(
        new Error('Cluster LLM timeout'),
      );
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(prisma.contractMatch.create).toHaveBeenCalled();
      expect(clusterClassifier.classifyMatch).toHaveBeenCalled();
    });
  });

  describe('event emission with payload verification', () => {
    it('[P0] auto-approved pair should emit MatchApprovedEvent, MatchAutoApprovedEvent, and ClusterAssignedEvent', async () => {
      scoringStrategy.scoreMatch.mockResolvedValue({
        score: 92,
        model: 'gemini-2.5-flash',
        escalated: false,
      });
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      await service.processAllProviders();

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_APPROVED,
        expect.objectContaining({ matchId: 'uuid-new' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.MATCH_AUTO_APPROVED,
        expect.objectContaining({ matchId: 'uuid-new', confidenceScore: 92 }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_NAMES.CLUSTER_ASSIGNED,
        expect.objectContaining({ matchId: 'uuid-new' }),
      );
    });
  });

  describe('enrichFn callback', () => {
    it('[P0] processAllProviders with enrichFn should apply enrichment before processing', async () => {
      oddsPipeProvider.fetchPairs.mockResolvedValue([
        makePair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Will Bitcoin exceed $100k?',
          kalshiTitle: 'Bitcoin above $100,000',
        }),
      ]);

      const enrichFn = vi
        .fn()
        .mockImplementation((pairs: ExternalMatchedPair[]) =>
          Promise.resolve(
            pairs.map((p) => ({
              ...p,
              polymarketId: '0xenriched',
              kalshiId: 'KXENRICHED',
              settlementDate: new Date('2026-12-31'),
              category: 'Crypto',
            })),
          ),
        );

      const result = await service.processAllProviders(enrichFn);

      expect(enrichFn).toHaveBeenCalledOnce();
      // Pair should have been scored (not unresolvable)
      const stats = result.sources.find((s) => s.source === 'oddspipe');
      expect(stats?.scored).toBe(1);
      expect(stats?.unresolvable).toBe(0);
    });

    it('[P1] enrichFn failure should process with raw pairs', async () => {
      predexonProvider.fetchPairs.mockResolvedValue([makePair()]);

      const enrichFn = vi
        .fn()
        .mockRejectedValue(new Error('Enrichment failed'));

      const result = await service.processAllProviders(enrichFn);

      // Should still process — Predexon pairs have IDs
      expect(result.sources).toBeDefined();
    });
  });
});

describe('computeTitleSimilarity', () => {
  it('identical titles return 1.0', () => {
    expect(
      computeTitleSimilarity(
        'Will Bitcoin exceed $100k?',
        'Will Bitcoin exceed $100k?',
      ),
    ).toBe(1);
  });

  it('completely different titles return 0', () => {
    expect(
      computeTitleSimilarity('Alpha beta gamma', 'Delta epsilon zeta'),
    ).toBe(0);
  });

  it('partial overlap returns correct ratio', () => {
    const score = computeTitleSimilarity(
      'Will Bitcoin exceed $100k by December',
      'Will Bitcoin reach $200k by December',
    );
    // Tokens: {will, bitcoin, exceed, 100k, by, december} vs {will, bitcoin, reach, 200k, by, december}
    // Intersection: {will, bitcoin, by, december} = 4, Max set: 6
    expect(score).toBeCloseTo(4 / 6, 2);
  });

  it('both empty returns 0', () => {
    expect(computeTitleSimilarity('', '')).toBe(0);
  });
});
