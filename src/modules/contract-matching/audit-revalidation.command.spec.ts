/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { AuditRevalidationService } from './audit-revalidation.command';
import type { IScoringStrategy } from '../../common/interfaces/scoring-strategy.interface';
import type { PrismaService } from '../../common/prisma.service';
import type { ConfigService } from '@nestjs/config';
import type { CatalogSyncService } from './catalog-sync.service';
import type { OutcomeDirectionValidator } from './outcome-direction-validator';
import type { ClusterClassifierService } from './cluster-classifier.service';
import type { ContractSummary } from '../../common/interfaces/contract-catalog-provider.interface';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { PlatformId } from '../../common/types/platform.type';
import { asClusterId } from '../../common/types/branded.type';

function createMockScoring(): IScoringStrategy {
  return {
    scoreMatch: vi.fn().mockResolvedValue({
      score: 90,
      confidence: 'high',
      reasoning: 'Same event, aligned outcomes',
      model: 'test-model',
      escalated: false,
    }),
  };
}

function createMockPrisma() {
  return {
    contractMatch: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    clusterTagMapping: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function createMockClusterClassifier() {
  return {
    classifyMatch: vi.fn().mockResolvedValue({
      clusterId: asClusterId('new-cluster-id'),
      clusterName: 'Correctly Classified',
      rawCategories: [],
      wasLlmClassified: true,
    }),
    onModuleInit: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCatalogSync() {
  return {
    syncCatalogs: vi.fn().mockResolvedValue(new Map()),
  };
}

function createMockValidator() {
  return {
    validateDirection: vi.fn().mockResolvedValue({
      aligned: null,
      reason: 'Labels missing',
    }),
  };
}

function createMockConfig(
  overrides: Record<string, unknown> = {},
): ConfigService {
  const defaults: Record<string, unknown> = {
    AUDIT_LLM_BATCH_SIZE: 10,
    AUDIT_LLM_DELAY_MS: 0,
    ...overrides,
  };
  return {
    get: vi.fn(
      (key: string, defaultVal?: unknown) => defaults[key] ?? defaultVal,
    ),
  } as unknown as ConfigService;
}

function makeDbMatch(overrides: Record<string, unknown> = {}) {
  return {
    matchId: 'match-1',
    polymarketContractId: 'poly-1',
    kalshiContractId: 'kalshi-1',
    polymarketDescription: 'Will Fighter A win?',
    kalshiDescription: 'Fighter B wins',
    polymarketClobTokenId: 'clob-token-wrong',
    operatorApproved: true,
    polymarketOutcomeLabel: null,
    kalshiOutcomeLabel: null,
    ...overrides,
  };
}

function makeContractSummary(
  platform: PlatformId,
  contractId: string,
  overrides: Partial<ContractSummary> = {},
): ContractSummary {
  return {
    contractId,
    title: `Title ${contractId}`,
    description: `Description ${contractId}`,
    platform,
    ...overrides,
  };
}

describe('AuditRevalidationService', () => {
  let service: AuditRevalidationService;
  let mockScoring: IScoringStrategy;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockCatalogSync: ReturnType<typeof createMockCatalogSync>;
  let mockValidator: ReturnType<typeof createMockValidator>;
  let mockClusterClassifier: ReturnType<typeof createMockClusterClassifier>;
  let mockConfig: ConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockScoring = createMockScoring();
    mockPrisma = createMockPrisma();
    mockCatalogSync = createMockCatalogSync();
    mockValidator = createMockValidator();
    mockClusterClassifier = createMockClusterClassifier();
    mockConfig = createMockConfig();

    service = new AuditRevalidationService(
      mockScoring,
      mockPrisma as unknown as PrismaService,
      mockCatalogSync as unknown as CatalogSyncService,
      mockValidator as unknown as OutcomeDirectionValidator,
      mockConfig,
      mockClusterClassifier as unknown as ClusterClassifierService,
    );
  });

  describe('UFC mis-match cleanup (AC 7)', () => {
    it('should reject confirmed UFC mis-matches by match ID prefix', async () => {
      const ufcMatch = makeDbMatch({
        matchId: '339a6d3e-full-uuid-here',
        operatorApproved: true,
        lastAnnualizedReturn: new Decimal('1500'),
        lastNetEdge: new Decimal('0.27'),
      });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([ufcMatch]) // UFC lookup
        .mockResolvedValueOnce([]); // full audit query

      const report = await service.runAudit();

      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: '339a6d3e-full-uuid-here' },
        data: expect.objectContaining({
          operatorApproved: false,
          lastAnnualizedReturn: null,
          lastNetEdge: null,
          operatorRationale: expect.stringContaining('direction mismatch'),
        }),
      });
      expect(report.ufcRejected).toBeGreaterThanOrEqual(1);
    });

    it('should skip UFC cleanup gracefully when IDs not found', async () => {
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([]); // full audit query

      const report = await service.runAudit();
      expect(report.ufcRejected).toBe(0);
    });
  });

  describe('catalog-based token correction', () => {
    it('should swap clobTokenId when direction validator finds correction', async () => {
      const match = makeDbMatch({
        polymarketContractId: 'poly-1',
        kalshiContractId: 'kalshi-1',
        polymarketClobTokenId: 'token-wrong',
      });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'Fighter A wins',
        clobTokenId: 'token-a',
        outcomeTokens: [
          { tokenId: 'token-a', outcomeLabel: 'Fighter A wins' },
          { tokenId: 'token-b', outcomeLabel: 'Fighter B wins' },
        ],
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'Fighter B wins',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: true,
        correctedTokenId: 'token-b',
        correctedLabel: 'Fighter B wins',
        reason: 'Self-corrected: swapped token',
      });

      const report = await service.runAudit();

      expect(report.tokensCorrected).toBe(1);
      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: expect.objectContaining({
          polymarketClobTokenId: 'token-b',
          polymarketOutcomeLabel: 'Fighter B wins',
        }),
      });
    });

    it('should flag as mismatched when validator says misaligned and no correction possible', async () => {
      const match = makeDbMatch();
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'Fighter A wins',
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'Fighter B wins',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: false,
        reason: 'No aligning token',
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(1);
      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: expect.stringContaining('direction mismatch'),
        }),
      });
    });

    it('should backfill outcome labels from catalog data when aligned', async () => {
      const match = makeDbMatch({
        polymarketOutcomeLabel: null,
        kalshiOutcomeLabel: null,
      });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'Yes',
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'Before Jan 1',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: true,
        reason: 'LLM alignment confirmed',
      });

      const report = await service.runAudit();

      expect(report.backfilled).toBe(1);
      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: expect.objectContaining({
          polymarketOutcomeLabel: 'Yes',
          kalshiOutcomeLabel: 'Before Jan 1',
        }),
      });
    });

    it('should pass through when validator returns aligned=null (no labels)', async () => {
      const match = makeDbMatch();
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1');
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1');

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: null,
        reason: 'Labels missing',
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(0);
      expect(report.total).toBe(1);
    });
  });

  describe('LLM fallback for expired contracts', () => {
    it('should fall back to LLM scoring when contract not found in catalogs', async () => {
      const match = makeDbMatch();
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      // Catalogs return empty — contract is expired/delisted
      mockCatalogSync.syncCatalogs.mockResolvedValue(new Map());

      // LLM says misaligned
      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        score: 20,
        confidence: 'high',
        reasoning: 'Different participants',
        model: 'test-model',
        escalated: false,
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(1);
      expect(mockScoring.scoreMatch).toHaveBeenCalled();
      expect(mockValidator.validateDirection).not.toHaveBeenCalled();
    });

    it('should retry LLM on failure with exponential backoff and skip after 3 retries', async () => {
      vi.useFakeTimers();

      const match = makeDbMatch();
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      mockCatalogSync.syncCatalogs.mockResolvedValue(new Map());

      (mockScoring.scoreMatch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('LLM API timeout'),
      );

      const promise = service.runAudit();
      await vi.runAllTimersAsync();
      const report = await promise;

      expect(mockScoring.scoreMatch).toHaveBeenCalledTimes(3);
      expect(report.skipped).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('catalog fetch failure', () => {
    it('should continue with LLM fallback when catalog sync fails', async () => {
      const match = makeDbMatch();
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([match]); // full audit query

      mockCatalogSync.syncCatalogs.mockRejectedValue(new Error('API down'));

      const report = await service.runAudit();

      // Should still process via LLM fallback
      expect(mockScoring.scoreMatch).toHaveBeenCalled();
      expect(report.total).toBe(1);
    });
  });

  describe('batch processing', () => {
    it('should process matches in batches respecting AUDIT_LLM_BATCH_SIZE', async () => {
      const matches = Array.from({ length: 15 }, (_, i) =>
        makeDbMatch({
          matchId: `match-${i}`,
          polymarketContractId: `poly-${i}`,
          kalshiContractId: `kalshi-${i}`,
        }),
      );
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce(matches); // full audit query

      mockConfig = createMockConfig({ AUDIT_LLM_BATCH_SIZE: 5 });
      service = new AuditRevalidationService(
        mockScoring,
        mockPrisma as unknown as PrismaService,
        mockCatalogSync as unknown as CatalogSyncService,
        mockValidator as unknown as OutcomeDirectionValidator,
        mockConfig,
        mockClusterClassifier as unknown as ClusterClassifierService,
      );

      const report = await service.runAudit();

      expect(report.total).toBe(15);
      // Falls back to LLM since no catalog data
      expect(mockScoring.scoreMatch).toHaveBeenCalledTimes(15);
    });
  });

  describe('complementary price check (AC 8)', () => {
    let mockKalshiConnector: { getOrderBook: ReturnType<typeof vi.fn> };
    let mockPolyConnector: { getOrderBook: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockKalshiConnector = { getOrderBook: vi.fn() };
      mockPolyConnector = { getOrderBook: vi.fn() };
      service = new AuditRevalidationService(
        mockScoring,
        mockPrisma as unknown as PrismaService,
        mockCatalogSync as unknown as CatalogSyncService,
        mockValidator as unknown as OutcomeDirectionValidator,
        mockConfig,
        mockClusterClassifier as unknown as ClusterClassifierService,
        mockKalshiConnector as unknown as IPlatformConnector,
        mockPolyConnector as unknown as IPlatformConnector,
      );
    });

    it('should flag match when ask prices sum to ≈ 1.00 (complementary signal)', async () => {
      const match = makeDbMatch({ polymarketClobTokenId: 'clob-token-1' });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([match]); // full audit

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'Fighter A wins',
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'Fighter B wins',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      // Direction validator says null (ambiguous)
      mockValidator.validateDirection.mockResolvedValue({
        aligned: null,
        reason: 'Labels ambiguous',
      });

      // polyAsk=0.60, kalshiAsk=0.40 → sum=1.00 (complementary)
      mockPolyConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'clob-token-1',
        bids: [],
        asks: [{ price: 0.6, quantity: 100 }],
        timestamp: new Date(),
      });
      mockKalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-1',
        bids: [],
        asks: [{ price: 0.4, quantity: 100 }],
        timestamp: new Date(),
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(1);
      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: expect.objectContaining({
          operatorApproved: false,
          operatorRationale: expect.stringContaining('complementary pricing'),
        }),
      });
    });

    it('should NOT flag when ask prices do NOT sum to ≈ 1.00', async () => {
      const match = makeDbMatch({ polymarketClobTokenId: 'clob-token-1' });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([match]); // full audit

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'BTC above $200k',
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'BTC above $200k',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: true,
        reason: 'Substring match',
      });

      // polyAsk=0.55, kalshiAsk=0.58 → sum=1.13 (not complementary)
      mockPolyConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'clob-token-1',
        bids: [],
        asks: [{ price: 0.55, quantity: 100 }],
        timestamp: new Date(),
      });
      mockKalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-1',
        bids: [],
        asks: [{ price: 0.58, quantity: 100 }],
        timestamp: new Date(),
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(0);
    });

    it('should skip complementary check when order books are empty', async () => {
      const match = makeDbMatch({ polymarketClobTokenId: 'clob-token-1' });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([match]); // full audit

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1');
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1');

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: null,
        reason: 'Labels missing',
      });

      mockPolyConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'clob-token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });
      mockKalshiConnector.getOrderBook.mockResolvedValue({
        platformId: PlatformId.KALSHI,
        contractId: 'kalshi-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      const report = await service.runAudit();

      expect(report.flagged).toBe(0);
    });

    it('should skip complementary check when order book fetch fails', async () => {
      const match = makeDbMatch({ polymarketClobTokenId: 'clob-token-1' });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([match]); // full audit

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1');
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1');

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      mockValidator.validateDirection.mockResolvedValue({
        aligned: null,
        reason: 'Labels missing',
      });

      mockPolyConnector.getOrderBook.mockRejectedValue(
        new Error('Connection refused'),
      );

      const report = await service.runAudit();

      expect(report.flagged).toBe(0);
    });

    it('should skip complementary check when direction already flagged', async () => {
      const match = makeDbMatch({ polymarketClobTokenId: 'clob-token-1' });
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([match]); // full audit

      const polySummary = makeContractSummary(PlatformId.POLYMARKET, 'poly-1', {
        outcomeLabel: 'Fighter A wins',
      });
      const kalshiSummary = makeContractSummary(PlatformId.KALSHI, 'kalshi-1', {
        outcomeLabel: 'Fighter B wins',
      });

      mockCatalogSync.syncCatalogs.mockResolvedValue(
        new Map([
          [PlatformId.POLYMARKET, [polySummary]],
          [PlatformId.KALSHI, [kalshiSummary]],
        ]),
      );

      // Direction already says mismatch
      mockValidator.validateDirection.mockResolvedValue({
        aligned: false,
        reason: 'No aligning token',
      });

      const report = await service.runAudit();

      // Should be flagged=1 (from direction), not flagged=2
      expect(report.flagged).toBe(1);
      // Connectors should NOT have been called (skipped complementary check)
      expect(mockPolyConnector.getOrderBook).not.toHaveBeenCalled();
      expect(mockKalshiConnector.getOrderBook).not.toHaveBeenCalled();
    });
  });

  describe('summary report', () => {
    it('should return complete summary report with tokensCorrected', async () => {
      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([]) // full audit query
        .mockResolvedValueOnce([]); // reclassification query

      const report = await service.runAudit();

      expect(report).toEqual(
        expect.objectContaining({
          total: expect.any(Number),
          flagged: expect.any(Number),
          skipped: expect.any(Number),
          backfilled: expect.any(Number),
          tokensCorrected: expect.any(Number),
          ufcRejected: expect.any(Number),
          clustersReclassified: expect.any(Number),
        }),
      );
    });
  });

  describe('cluster reclassification (Phase C)', () => {
    it('should purge tag mappings and reclassify approved matches via LLM', async () => {
      const match = makeDbMatch({
        matchId: 'match-1',
        clusterId: 'old-wrong-cluster',
        polymarketRawCategory: 'mayweather',
        kalshiRawCategory: 'Sports',
      });

      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([]) // full audit query
        .mockResolvedValueOnce([match]); // reclassification query

      mockClusterClassifier.classifyMatch.mockResolvedValue({
        clusterId: asClusterId('boxing-cluster-id'),
        clusterName: 'Boxing',
        rawCategories: [],
        wasLlmClassified: true,
      });

      const report = await service.runAudit();

      expect(mockPrisma.clusterTagMapping.deleteMany).toHaveBeenCalledWith({});
      expect(mockClusterClassifier.classifyMatch).toHaveBeenCalledWith(
        'mayweather',
        'Sports',
        expect.any(String),
        expect.any(String),
      );
      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: { clusterId: 'boxing-cluster-id' },
      });
      expect(report.clustersReclassified).toBe(1);
    });

    it('should not update match when cluster assignment is unchanged', async () => {
      const match = makeDbMatch({
        matchId: 'match-2',
        clusterId: 'correct-cluster-id',
        polymarketRawCategory: 'Weather',
        kalshiRawCategory: 'Climate and Weather',
      });

      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC lookup
        .mockResolvedValueOnce([]) // full audit query
        .mockResolvedValueOnce([match]); // reclassification query

      mockClusterClassifier.classifyMatch.mockResolvedValue({
        clusterId: asClusterId('correct-cluster-id'),
        clusterName: 'Climate and Weather',
        rawCategories: [],
        wasLlmClassified: true,
      });

      const report = await service.runAudit();

      // Update should NOT be called for reclassification (same cluster)
      expect(report.clustersReclassified).toBe(0);
    });

    it('should continue reclassification when individual match fails', async () => {
      const match1 = makeDbMatch({
        matchId: 'match-fail',
        clusterId: 'old-1',
        polymarketRawCategory: 'Cat1',
        kalshiRawCategory: 'Cat2',
      });
      const match2 = makeDbMatch({
        matchId: 'match-ok',
        clusterId: 'old-2',
        polymarketRawCategory: 'Cat3',
        kalshiRawCategory: 'Cat4',
      });

      mockPrisma.contractMatch.findMany
        .mockResolvedValueOnce([]) // UFC
        .mockResolvedValueOnce([]) // audit
        .mockResolvedValueOnce([match1, match2]); // reclassification

      mockClusterClassifier.classifyMatch
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce({
          clusterId: asClusterId('new-cluster'),
          clusterName: 'New Cluster',
          rawCategories: [],
          wasLlmClassified: true,
        });

      const report = await service.runAudit();

      expect(report.clustersReclassified).toBe(1);
    });
  });
});
