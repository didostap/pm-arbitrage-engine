import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MatchValidationService } from './match-validation.service';
import type { ExternalMatchedPair } from '../types/match-validation.types';

function createContractMatch(overrides?: Record<string, unknown>) {
  return {
    matchId: overrides?.matchId ?? 'match-1',
    polymarketContractId: overrides?.polymarketContractId ?? '0xPM-A',
    kalshiContractId: overrides?.kalshiContractId ?? 'K-A',
    polymarketDescription:
      overrides?.polymarketDescription ?? 'Will Bitcoin exceed $100k?',
    kalshiDescription: overrides?.kalshiDescription ?? 'Bitcoin above $100,000',
    confidenceScore: overrides?.confidenceScore ?? 0.95,
    operatorApproved: overrides?.operatorApproved ?? true,
  };
}

function createExternalPair(
  overrides?: Partial<ExternalMatchedPair>,
): ExternalMatchedPair {
  return {
    polymarketId: '0xPM-A',
    kalshiId: 'K-A',
    polymarketTitle: 'Will Bitcoin exceed $100k?',
    kalshiTitle: 'Bitcoin above $100,000',
    source: 'predexon',
    similarity: 0.97,
    spreadData: null,
    ...overrides,
  };
}

function createMockPrisma(
  matches: ReturnType<typeof createContractMatch>[] = [],
) {
  return {
    contractMatch: {
      findMany: vi.fn().mockResolvedValue(matches),
    },
    matchValidationReport: {
      create: vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 1, ...args.data }),
        ),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as any;
}

function createMockOddsPipe(pairs: ExternalMatchedPair[] = []) {
  return {
    fetchMatchedPairs: vi.fn().mockResolvedValue(pairs),
  } as any;
}

function createMockPredexon(pairs: ExternalMatchedPair[] = []) {
  return {
    fetchMatchedPairs: vi.fn().mockResolvedValue(pairs),
  } as any;
}

function createMockEventEmitter() {
  return { emit: vi.fn() } as any;
}

function createMockConfigService(overrides?: Record<string, string>) {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (overrides && key in overrides) return overrides[key];
      return undefined;
    }),
  } as any;
}

function createDto(
  sources: ('oddspipe' | 'predexon')[] = ['oddspipe', 'predexon'],
) {
  return { includeSources: sources };
}

function createService(
  matches: ReturnType<typeof createContractMatch>[] = [],
  oddsPipePairs: ExternalMatchedPair[] = [],
  predexonPairs: ExternalMatchedPair[] = [],
  configOverrides?: Record<string, string>,
) {
  const prisma = createMockPrisma(matches);
  const oddsPipe = createMockOddsPipe(oddsPipePairs);
  const predexon = createMockPredexon(predexonPairs);
  const events = createMockEventEmitter();
  const config = createMockConfigService(configOverrides);

  const service = new MatchValidationService(
    prisma,
    oddsPipe,
    predexon,
    events,
    config,
  );

  return { service, prisma, oddsPipe, predexon, events };
}

describe('MatchValidationService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadOurMatches', () => {
    it('[P0] should load all ContractMatch records and build polymarket/kalshi/composite lookup maps', async () => {
      const matches = [
        createContractMatch({
          matchId: 'm1',
          polymarketContractId: '0xPM-A',
          kalshiContractId: 'K-A',
        }),
        createContractMatch({
          matchId: 'm2',
          polymarketContractId: '0xPM-B',
          kalshiContractId: 'K-B',
        }),
      ];

      const { service } = createService(matches);
      const result = await service.runValidation(createDto());

      expect(result).toBeDefined();
      expect(result.totalOurMatches).toBe(2);
    });
  });

  describe('matchExternalPair — ID-based + fuzzy fallback', () => {
    it('[P0] should match Predexon pair by polymarketContractId and kalshiContractId (ID-based)', async () => {
      const matches = [createContractMatch()];
      const predexonPairs = [createExternalPair({ source: 'predexon' })];

      const { service } = createService(matches, [], predexonPairs);
      const result = await service.runValidation(createDto(['predexon']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P0] should fall back to fuzzy title matching when OddsPipe pair lacks platform IDs', async () => {
      const matches = [
        createContractMatch({
          polymarketDescription:
            'Will Bitcoin exceed one hundred thousand dollars',
          kalshiDescription: 'Bitcoin above $100,000',
        }),
      ];
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle:
            'Will Bitcoin exceed one hundred thousand dollars by December',
          kalshiTitle: 'Bitcoin above $100,000',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P1] should use stop-word removal and bidirectional substring containment for fuzzy matching', async () => {
      const matches = [
        createContractMatch({
          polymarketDescription: 'The GDP growth rate will exceed 3%',
          kalshiDescription: 'GDP growth above 3 percent',
        }),
      ];
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'GDP growth rate will exceed 3%',
          kalshiTitle: 'GDP growth above 3 percent',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P1] should accept fuzzy match when >=60% of significant tokens overlap (default threshold)', async () => {
      const matches = [
        createContractMatch({
          polymarketDescription:
            'Bitcoin price above hundred thousand end of year',
          kalshiDescription: 'Bitcoin hundred thousand',
        }),
      ];
      // Only partial overlap — enough tokens match to be >= 60%
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle:
            'Bitcoin price above hundred thousand dollars in December',
          kalshiTitle: 'Bitcoin hundred thousand',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P7] should respect VALIDATION_TITLE_MATCH_THRESHOLD env var', async () => {
      const matches = [
        createContractMatch({
          polymarketDescription: 'Bitcoin price above 100k',
          kalshiDescription: 'Bitcoin 100k',
        }),
      ];
      // Pair that would match at 0.4 threshold but not at 0.9
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Bitcoin price above 100k end of year',
          kalshiTitle: 'Bitcoin 100k',
        }),
      ];

      // With high threshold, should NOT match
      const { service: strictService } = createService(
        matches,
        oddsPipePairs,
        [],
        { VALIDATION_TITLE_MATCH_THRESHOLD: '0.99' },
      );
      const strictResult = await strictService.runValidation(
        createDto(['oddspipe']),
      );
      expect(strictResult.confirmedCount).toBe(0);

      // With default threshold, should match
      const { service: defaultService } = createService(
        matches,
        oddsPipePairs,
        [],
      );
      const defaultResult = await defaultService.runValidation(
        createDto(['oddspipe']),
      );
      expect(defaultResult.confirmedCount).toBe(1);
    });
  });

  describe('Conflict Detection Decision Table (AC#4)', () => {
    it('[P0] should categorize as Confirmed when all 3 sources agree (A↔B, A↔B, A↔B)', async () => {
      const matches = [createContractMatch()];
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Will Bitcoin exceed $100k?',
          kalshiTitle: 'Bitcoin above $100,000',
        }),
      ];
      const predexonPairs = [createExternalPair({ source: 'predexon' })];

      const { service } = createService(matches, oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      expect(result.confirmedCount).toBe(1);
      expect(result.conflictCount).toBe(0);
    });

    it('[P0] should categorize as Confirmed when ours + OddsPipe agree (A↔B, A↔B, —)', async () => {
      const matches = [createContractMatch()];
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Will Bitcoin exceed $100k?',
          kalshiTitle: 'Bitcoin above $100,000',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P0] should categorize as Confirmed when ours + Predexon agree (A↔B, —, A↔B)', async () => {
      const matches = [createContractMatch()];
      const predexonPairs = [createExternalPair({ source: 'predexon' })];

      const { service } = createService(matches, [], predexonPairs);
      const result = await service.runValidation(createDto(['predexon']));

      expect(result.confirmedCount).toBe(1);
    });

    it('[P1] should categorize as Our-only when no external source has the pair (A↔B, —, —)', async () => {
      const matches = [createContractMatch()];

      const { service } = createService(matches, [], []);
      const result = await service.runValidation(createDto());

      expect(result.ourOnlyCount).toBe(1);
    });

    it("[P1] should categorize as External-only when both externals agree but we don't have it (—, A↔B, A↔B)", async () => {
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Election outcome 2028',
          kalshiTitle: 'Election result 2028',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xELEC',
          kalshiId: 'K-ELEC',
          polymarketTitle: 'Election outcome 2028',
          kalshiTitle: 'Election result 2028',
        }),
      ];

      const { service } = createService([], oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      expect(result.externalOnlyCount).toBeGreaterThanOrEqual(1);
    });

    it('[P1] should categorize as External-only when only OddsPipe has the pair (—, A↔B, —)', async () => {
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Unique OddsPipe market',
          kalshiTitle: 'Unique Kalshi market',
        }),
      ];

      const { service } = createService([], oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      expect(result.externalOnlyCount).toBe(1);
    });

    it('[P1] should categorize as External-only when only Predexon has the pair (—, —, A↔B)', async () => {
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xUNIQUE',
          kalshiId: 'K-UNIQUE',
          polymarketTitle: 'Unique Predexon market',
          kalshiTitle: 'Unique Kalshi market',
        }),
      ];

      const { service } = createService([], [], predexonPairs);
      const result = await service.runValidation(createDto(['predexon']));

      expect(result.externalOnlyCount).toBe(1);
    });

    it('[P0] should categorize as Conflict when OddsPipe disagrees on Kalshi side (A↔B, A↔C, A↔B)', async () => {
      const matches = [
        createContractMatch({
          polymarketContractId: '0xPM-A',
          kalshiContractId: 'K-A',
        }),
      ];
      // OddsPipe maps same PM to different Kalshi
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Will Bitcoin exceed $100k?',
          kalshiTitle: 'Bitcoin to $200k', // Different Kalshi contract
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xPM-A',
          kalshiId: 'K-A',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      expect(result.conflictCount).toBeGreaterThanOrEqual(1);
    });

    it('[P0] should categorize as Conflict when Predexon disagrees on Kalshi side (A↔B, A↔B, A↔C)', async () => {
      const matches = [
        createContractMatch({
          polymarketContractId: '0xPM-A',
          kalshiContractId: 'K-A',
        }),
      ];
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Will Bitcoin exceed $100k?',
          kalshiTitle: 'Bitcoin above $100,000',
        }),
      ];
      // Predexon maps same PM to different Kalshi
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xPM-A',
          kalshiId: 'K-DIFFERENT',
        }),
      ];

      const { service } = createService(matches, oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      expect(result.conflictCount).toBeGreaterThanOrEqual(1);
    });

    it('[P0] should categorize as Conflict when externals disagree and we have no opinion — both title-only (—, A↔B, A↔C)', async () => {
      // Both sources use title-only (no IDs) — title comparison detects conflict
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'New election market',
          kalshiTitle: 'Election yes',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'New election market',
          kalshiTitle: 'Election no',
        }),
      ];

      const { service } = createService([], oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      // P-2: Must detect as conflict, not external-only
      expect(result.conflictCount).toBeGreaterThanOrEqual(1);
    });

    it('[P0] should categorize as Conflict when externals disagree — both have IDs (—, A↔B, A↔C)', async () => {
      // Both sources have IDs — ID comparison detects conflict
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: '0xNEW',
          kalshiId: 'K-VERSION-A',
          polymarketTitle: 'New election market',
          kalshiTitle: 'Election yes',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xNEW',
          kalshiId: 'K-VERSION-B',
          polymarketTitle: 'New election market',
          kalshiTitle: 'Election no',
        }),
      ];

      const { service } = createService([], oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      expect(result.conflictCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Report Entry Content (AC#5, #6)', () => {
    it('[P1] should set isKnowledgeBaseCandidate=true for all external-only entries with full metadata (AC#5)', async () => {
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'External-only market',
          kalshiTitle: 'External-only Kalshi',
          spreadData: {
            yesDiff: 0.05,
            polyYesPrice: 0.6,
            kalshiYesPrice: 0.55,
          },
        }),
      ];

      const { service } = createService([], oddsPipePairs, []);
      const result = await service.runValidation(createDto(['oddspipe']));

      const entries = result.reportData as any[];
      const externalOnly = entries.find(
        (e: any) => e.category === 'external-only',
      );
      expect(externalOnly).toBeDefined();
      expect(externalOnly.isKnowledgeBaseCandidate).toBe(true);
      // P-18: Verify AC#5 metadata fields
      expect(externalOnly.oddsPipeMatch).toEqual(
        expect.objectContaining({
          polymarketTitle: 'External-only market',
          kalshiTitle: 'External-only Kalshi',
          yesDiff: 0.05,
          polyYesPrice: 0.6,
          kalshiYesPrice: 0.55,
        }),
      );
    });

    it('[P1] should include source metadata for Predexon external-only entries (AC#5)', async () => {
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xEXT',
          kalshiId: 'K-EXT',
          polymarketTitle: 'Predexon-only market',
          kalshiTitle: 'Predexon-only Kalshi',
          similarity: 0.98,
        }),
      ];

      const { service } = createService([], [], predexonPairs);
      const result = await service.runValidation(createDto(['predexon']));

      const entries = result.reportData as any[];
      const externalOnly = entries.find(
        (e: any) => e.category === 'external-only',
      );
      expect(externalOnly).toBeDefined();
      expect(externalOnly.isKnowledgeBaseCandidate).toBe(true);
      expect(externalOnly.predexonMatch).toEqual(
        expect.objectContaining({
          polymarketConditionId: '0xEXT',
          kalshiId: 'K-EXT',
          polymarketTitle: 'Predexon-only market',
          kalshiTitle: 'Predexon-only Kalshi',
          similarity: 0.98,
        }),
      );
    });

    it('[P1] should include conflictDescription with identifiers from each source for conflict entries (AC#6)', async () => {
      const matches = [
        createContractMatch({
          polymarketContractId: '0xPM-A',
          kalshiContractId: 'K-A',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xPM-A',
          kalshiId: 'K-DIFFERENT',
        }),
      ];

      const { service } = createService(matches, [], predexonPairs);
      const result = await service.runValidation(createDto(['predexon']));

      const entries = result.reportData as any[];
      const conflict = entries.find((e: any) => e.category === 'conflict');
      expect(conflict).toBeDefined();
      expect(conflict.conflictDescription).toBeDefined();
      // P-19: Verify description contains specific identifiers from each source
      expect(conflict.conflictDescription).toContain('0xPM-A');
      expect(conflict.conflictDescription).toContain('K-A');
      expect(conflict.conflictDescription).toContain('K-DIFFERENT');
    });

    it('[P1] should include conflictDescription for cross-external conflicts (AC#6)', async () => {
      // Both title-only so comparison works
      const oddsPipePairs = [
        createExternalPair({
          source: 'oddspipe',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Cross-conflict market',
          kalshiTitle: 'Kalshi version A',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: null,
          kalshiId: null,
          polymarketTitle: 'Cross-conflict market',
          kalshiTitle: 'Kalshi version B',
        }),
      ];

      const { service } = createService([], oddsPipePairs, predexonPairs);
      const result = await service.runValidation(createDto());

      const entries = result.reportData as any[];
      const conflict = entries.find((e: any) => e.category === 'conflict');
      expect(conflict).toBeDefined();
      expect(conflict.conflictDescription).toBeDefined();
      expect(conflict.conflictDescription).toContain('OddsPipe');
      expect(conflict.conflictDescription).toContain('Predexon');
    });
  });

  describe('Orchestration & Guards', () => {
    it('[P1] should throw SystemHealthError when validation is already running (concurrency guard)', async () => {
      const matches = [createContractMatch()];
      const { service } = createService(matches);

      // Start first run (don't await)
      const run1 = service.runValidation(createDto());

      // Second attempt should throw SystemHealthError
      await expect(service.runValidation(createDto())).rejects.toThrow(
        'already running',
      );

      await run1;
    });

    it('[P1] should reset _isRunning after 10-minute safety timeout', async () => {
      const prisma = createMockPrisma([]);
      // Make loadOurMatches hang forever
      prisma.contractMatch.findMany.mockReturnValue(new Promise(() => {}));
      const events = createMockEventEmitter();
      const config = createMockConfigService();

      const service = new MatchValidationService(
        prisma,
        createMockOddsPipe(),
        createMockPredexon(),
        events,
        config,
      );

      // Start a validation that will hang
      service.runValidation(createDto()).catch(() => {});

      expect(service.isRunning).toBe(true);

      // Advance past the 10-minute safety timeout
      await vi.advanceTimersByTimeAsync(600_001);

      expect(service.isRunning).toBe(false);
    });

    it('[P1] should accept correlationId from caller and persist it', async () => {
      const { service, prisma } = createService([createContractMatch()]);
      const correlationId = 'test-correlation-id-123';

      await service.runValidation(createDto(), correlationId);

      expect(prisma.matchValidationReport.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          correlationId: 'test-correlation-id-123',
        }),
      });
    });
  });

  describe('Event Emission (AC#8)', () => {
    it('[P1] should emit BacktestValidationCompletedEvent with summary counts and reportId on success', async () => {
      const matches = [createContractMatch()];
      const predexonPairs = [createExternalPair({ source: 'predexon' })];

      const { service, events } = createService(matches, [], predexonPairs);
      await service.runValidation(createDto(['predexon']));

      expect(events.emit).toHaveBeenCalledWith(
        'backtesting.validation.completed',
        expect.objectContaining({
          reportId: expect.any(Number),
          confirmedCount: 1,
        }),
      );
    });

    it('[P1] should emit BacktestDataQualityWarningEvent when conflict count > 0', async () => {
      const matches = [
        createContractMatch({
          polymarketContractId: '0xPM-A',
          kalshiContractId: 'K-A',
        }),
      ];
      const predexonPairs = [
        createExternalPair({
          source: 'predexon',
          polymarketId: '0xPM-A',
          kalshiId: 'K-DIFFERENT',
        }),
      ];

      const { service, events } = createService(matches, [], predexonPairs);
      await service.runValidation(createDto(['predexon']));

      expect(events.emit).toHaveBeenCalledWith(
        'backtesting.data.quality-warning',
        expect.objectContaining({
          message: expect.stringContaining('conflict'),
        }),
      );
    });

    it('[P1] should NOT emit events on validation failure', async () => {
      const prisma = createMockPrisma([]);
      prisma.contractMatch.findMany.mockRejectedValue(new Error('DB down'));
      const events = createMockEventEmitter();
      const config = createMockConfigService();

      const service = new MatchValidationService(
        prisma,
        createMockOddsPipe(),
        createMockPredexon(),
        events,
        config,
      );

      await expect(
        service.runValidation(createDto(['oddspipe'])),
      ).rejects.toThrow();

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('Persistence (AC#7)', () => {
    it('[P0] should persist MatchValidationReport with summary counts and full reportData JSON', async () => {
      const matches = [createContractMatch()];
      const predexonPairs = [createExternalPair({ source: 'predexon' })];

      const { service, prisma } = createService(matches, [], predexonPairs);
      await service.runValidation(createDto(['predexon']));

      expect(prisma.matchValidationReport.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          correlationId: expect.any(String),
          runTimestamp: expect.any(Date),
          totalOurMatches: 1,
          confirmedCount: 1,
          reportData: expect.any(Array),
          durationMs: expect.any(Number),
        }),
      });
    });
  });

  describe('Pagination (AC#7)', () => {
    it('[P1] should pass page and limit to getReports()', async () => {
      const { service, prisma } = createService();

      await service.getReports(2, 25);

      expect(prisma.matchValidationReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 25,
          orderBy: { runTimestamp: 'desc' },
        }),
      );
    });

    it('[P1] should cap limit at 100', async () => {
      const { service, prisma } = createService();

      await service.getReports(1, 500);

      expect(prisma.matchValidationReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        }),
      );
    });
  });

  describe('Edge Cases', () => {
    it('[P1] should handle empty external responses gracefully (both sources return 0 pairs)', async () => {
      const matches = [
        createContractMatch({ matchId: 'm1' }),
        createContractMatch({
          matchId: 'm2',
          polymarketContractId: '0xPM-B',
          kalshiContractId: 'K-B',
        }),
      ];

      const { service } = createService(matches, [], []);
      const result = await service.runValidation(createDto());

      expect(result.ourOnlyCount).toBe(2);
      expect(result.confirmedCount).toBe(0);
      expect(result.externalOnlyCount).toBe(0);
      expect(result.conflictCount).toBe(0);
    });

    it('[P10] should warn when duplicate polymarketContractId exists in ContractMatch', async () => {
      const matches = [
        createContractMatch({
          matchId: 'm1',
          polymarketContractId: '0xDUPE',
          kalshiContractId: 'K-1',
        }),
        createContractMatch({
          matchId: 'm2',
          polymarketContractId: '0xDUPE',
          kalshiContractId: 'K-2',
        }),
      ];

      const { service } = createService(matches);
      const logSpy = vi.spyOn((service as any).logger, 'warn');

      await service.runValidation(createDto());

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate polymarketContractId'),
      );
    });
  });
});
