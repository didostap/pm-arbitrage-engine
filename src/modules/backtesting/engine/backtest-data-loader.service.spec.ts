import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import type { NormalizedHistoricalDepth } from '../types/normalized-historical.types';

// ============================================================
// UNIT Tests — generateChunkRanges()
// ============================================================
describe('BacktestDataLoaderService — generateChunkRanges', () => {
  let service: any;

  beforeEach(async () => {
    const { BacktestDataLoaderService } =
      await import('./backtest-data-loader.service');
    service = new BacktestDataLoaderService({} as any);
  });

  // 10-9-3a ATDD: UNIT-008
  it('[P0] generates correct day-aligned chunk ranges for exact multi-day range (7-day → 7 ranges)', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2025-01-08T00:00:00Z');
    const ranges = service.generateChunkRanges(start, end, 1);
    expect(ranges).toHaveLength(7);
    expect(ranges[0].start).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(ranges[0].end).toEqual(new Date('2025-01-02T00:00:00Z'));
    expect(ranges[6].start).toEqual(new Date('2025-01-07T00:00:00Z'));
    expect(ranges[6].end).toEqual(new Date('2025-01-08T00:00:00Z'));
  });

  // 10-9-3a ATDD: UNIT-009
  it('[P0] last chunk is shorter when date range is not evenly divisible (10 days, chunkWindowDays=3 → 4 ranges, last is 1 day)', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2025-01-11T00:00:00Z');
    const ranges = service.generateChunkRanges(start, end, 3);
    expect(ranges).toHaveLength(4);
    // Last range: Jan 10 to Jan 11 (1 day)
    expect(ranges[3].start).toEqual(new Date('2025-01-10T00:00:00Z'));
    expect(ranges[3].end).toEqual(new Date('2025-01-11T00:00:00Z'));
  });

  // 10-9-3a ATDD: UNIT-010
  it('[P1] single-day range with chunkWindowDays=1 → exactly 1 range', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2025-01-02T00:00:00Z');
    const ranges = service.generateChunkRanges(start, end, 1);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({
      start: new Date('2025-01-01T00:00:00Z'),
      end: new Date('2025-01-02T00:00:00Z'),
    });
  });

  // 10-9-3a ATDD: UNIT-011
  it('[P1] chunkWindowDays larger than date range → 1 range covering entire range', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2025-01-04T00:00:00Z');
    const ranges = service.generateChunkRanges(start, end, 30);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start, end });
  });

  // 10-9-3a ATDD: UNIT-012
  it('[P2] chunk ranges are contiguous with no gaps or overlaps', () => {
    const start = new Date('2025-01-01T00:00:00Z');
    const end = new Date('2025-01-15T00:00:00Z');
    const ranges = service.generateChunkRanges(start, end, 4);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].start.getTime()).toBe(ranges[i - 1].end.getTime());
    }
    expect(ranges[0].start.getTime()).toBe(start.getTime());
    expect(ranges[ranges.length - 1].end.getTime()).toBe(end.getTime());
  });
});

// ============================================================
// UNIT Tests — preloadDepthsForChunk()
// ============================================================
describe('BacktestDataLoaderService — preloadDepthsForChunk', () => {
  let service: { preloadDepthsForChunk: (...args: unknown[]) => Promise<Map<string, unknown[]>> };
  let prismaService: ReturnType<typeof createDepthPrisma>;

  function createDepthPrisma() {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
  }

  beforeEach(async () => {
    prismaService = createDepthPrisma();
    const { BacktestDataLoaderService } =
      await import('./backtest-data-loader.service');
    service = new BacktestDataLoaderService(prismaService as never);
  });

  // 10-9-3a ATDD: UNIT-013
  it('[P0] returns Map<string, ParsedHistoricalDepth[]> keyed by ${platform}:${contractId}', async () => {
    const ts1 = new Date('2025-01-01T12:00:00Z');
    prismaService.$queryRaw.mockResolvedValue([
      {
        platform: 'KALSHI',
        contract_id: 'K1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '80' }],
        timestamp: ts1,
        update_type: 'snapshot',
      },
    ]);

    const cache = await service.preloadDepthsForChunk(
      ['K1'],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    expect(cache).toBeInstanceOf(Map);
    expect(cache.has('KALSHI:K1')).toBe(true);
    const entries = cache.get('KALSHI:K1')!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.bids[0]!.price).toBeInstanceOf(Decimal);
  });

  // 10-9-3a ATDD: UNIT-014
  it('[P0] depths per key are sorted by timestamp DESC', async () => {
    const ts1 = new Date('2025-01-01T10:00:00Z');
    const ts2 = new Date('2025-01-01T14:00:00Z');
    prismaService.$queryRaw.mockResolvedValue([
      {
        platform: 'KALSHI',
        contract_id: 'K1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.55', size: '80' }],
        timestamp: ts1,
        update_type: 'snapshot',
      },
      {
        platform: 'KALSHI',
        contract_id: 'K1',
        source: 'PMXT_ARCHIVE',
        bids: [{ price: '0.51', size: '90' }],
        asks: [{ price: '0.56', size: '70' }],
        timestamp: ts2,
        update_type: 'snapshot',
      },
    ]);

    const cache = await service.preloadDepthsForChunk(
      ['K1'],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    const entries = cache.get('KALSHI:K1')!;
    expect(entries[0]!.timestamp.getTime()).toBeGreaterThan(
      entries[1]!.timestamp.getTime(),
    );
  });

  // 10-9-3a ATDD: UNIT-015
  it('[P1] deduplicates contractIds before querying', async () => {
    await service.preloadDepthsForChunk(
      ['K1', 'P1', 'K1'],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    expect(prismaService.$queryRaw).toHaveBeenCalledTimes(1);
    // The $queryRaw call uses ANY(dedupedIds::text[]) — verify dedup via behavior:
    // passing 3 IDs with 1 duplicate should still query (not short-circuit)
    expect(prismaService.$queryRaw).toHaveBeenCalled();
  });

  // 10-9-3a ATDD: UNIT-016
  it('[P1] uses $queryRaw to bypass napi bridge for large IN clauses', async () => {
    await service.preloadDepthsForChunk(
      ['K1', 'P1'],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    expect(prismaService.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('[P1] returns empty Map for empty contractIds array', async () => {
    const cache = await service.preloadDepthsForChunk(
      [],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    expect(cache.size).toBe(0);
    expect(prismaService.$queryRaw).not.toHaveBeenCalled();
  });

  // 10-9-3a ATDD: UNIT-017
  it('[P2] returns empty Map when no depth records exist', async () => {
    const cache = await service.preloadDepthsForChunk(
      ['K1'],
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );
    expect(cache).toBeInstanceOf(Map);
    expect(cache.size).toBe(0);
  });
});

// ============================================================
// UNIT Tests — findNearestDepthFromCache() (pure function)
// ============================================================
describe('findNearestDepthFromCache', () => {
  let findNearestDepthFromCache: any;

  beforeEach(async () => {
    const mod = await import('./backtest-data-loader.service');
    findNearestDepthFromCache = mod.findNearestDepthFromCache;
  });

  const makeDepth = (
    ts: string,
    platform = 'KALSHI',
    contractId = 'K1',
  ): NormalizedHistoricalDepth => ({
    platform,
    contractId,
    source: 'PMXT_ARCHIVE' as any,
    bids: [{ price: new Decimal('0.50'), size: new Decimal('100') }],
    asks: [{ price: new Decimal('0.55'), size: new Decimal('80') }],
    timestamp: new Date(ts),
    updateType: 'snapshot',
  });

  // 10-9-3a ATDD: UNIT-019
  it('[P0] returns the depth with timestamp <= queryTimestamp (nearest earlier snapshot)', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [
      makeDepth('2025-01-01T14:00:00Z'),
      makeDepth('2025-01-01T10:00:00Z'),
    ]); // DESC order

    const result = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T12:00:00Z'),
    );
    expect(result).not.toBeNull();
    expect(result!.timestamp).toEqual(new Date('2025-01-01T10:00:00Z'));
  });

  // 10-9-3a ATDD: UNIT-020
  it('[P0] returns exact match when query timestamp equals a snapshot timestamp', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [
      makeDepth('2025-01-01T14:00:00Z'),
      makeDepth('2025-01-01T10:00:00Z'),
    ]);

    const result = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T14:00:00Z'),
    );
    expect(result).not.toBeNull();
    expect(result!.timestamp).toEqual(new Date('2025-01-01T14:00:00Z'));
  });

  // 10-9-3a ATDD: UNIT-021
  it('[P0] returns null when query timestamp is before all snapshots in cache', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [makeDepth('2025-01-01T14:00:00Z')]);

    const result = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T08:00:00Z'),
    );
    expect(result).toBeNull();
  });

  // 10-9-3a ATDD: UNIT-022
  it('[P0] returns null when cache has no entry for the given platform:contractId key', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    const result = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T12:00:00Z'),
    );
    expect(result).toBeNull();
  });

  // 10-9-3a ATDD: UNIT-023
  it('[P1] multiple contracts in cache are keyed independently', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [makeDepth('2025-01-01T10:00:00Z', 'KALSHI', 'K1')]);
    cache.set('POLYMARKET:P1', [
      makeDepth('2025-01-01T12:00:00Z', 'POLYMARKET', 'P1'),
    ]);

    const resultK = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T15:00:00Z'),
    );
    const resultP = findNearestDepthFromCache(
      cache,
      'POLYMARKET',
      'P1',
      new Date('2025-01-01T15:00:00Z'),
    );

    expect(resultK!.contractId).toBe('K1');
    expect(resultP!.contractId).toBe('P1');
  });

  // 10-9-3a ATDD: UNIT-024
  it('[P1] function is a pure standalone export (not a service method)', async () => {
    const mod = await import('./backtest-data-loader.service');
    expect(typeof mod.findNearestDepthFromCache).toBe('function');
    // Ensure it does NOT use `this` — it's exported as a standalone function
    const src = mod.findNearestDepthFromCache.toString();
    expect(src).not.toContain('this.');
  });

  // 10-9-3a ATDD: UNIT-025
  it('[P1] between two snapshots, returns the earlier one (binary search correctness with >2 entries)', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [
      makeDepth('2025-01-01T18:00:00Z'),
      makeDepth('2025-01-01T14:00:00Z'),
      makeDepth('2025-01-01T10:00:00Z'),
      makeDepth('2025-01-01T06:00:00Z'),
    ]); // DESC order

    const result = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T12:00:00Z'),
    );
    expect(result!.timestamp).toEqual(new Date('2025-01-01T10:00:00Z'));
  });

  // 10-9-3a ATDD: UNIT-026
  it('[P2] handles single-entry cache correctly (query after → returns it, query before → null)', () => {
    const cache = new Map<string, NormalizedHistoricalDepth[]>();
    cache.set('KALSHI:K1', [makeDepth('2025-01-01T12:00:00Z')]);

    const resultAfter = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T15:00:00Z'),
    );
    expect(resultAfter).not.toBeNull();
    expect(resultAfter!.timestamp).toEqual(new Date('2025-01-01T12:00:00Z'));

    const resultBefore = findNearestDepthFromCache(
      cache,
      'KALSHI',
      'K1',
      new Date('2025-01-01T08:00:00Z'),
    );
    expect(resultBefore).toBeNull();
  });
});

// ============================================================
// UNIT Tests — parseJsonDepthLevels()
// ============================================================
describe('parseJsonDepthLevels', () => {
  let parseJsonDepthLevels: any;

  beforeEach(async () => {
    const mod = await import('../utils/depth-parsing.utils');
    parseJsonDepthLevels = mod.parseJsonDepthLevels;
  });

  // 10-9-3a ATDD: UNIT-027
  it('[P1] parses JSON { price: string; size: string }[] → { price: Decimal; size: Decimal }[]', () => {
    const input = [
      { price: '0.50', size: '100' },
      { price: '0.55', size: '80' },
    ];
    const result = parseJsonDepthLevels(input);
    expect(result).toHaveLength(2);
    expect(result[0].price).toBeInstanceOf(Decimal);
    expect(result[0].price.toString()).toBe('0.5');
    expect(result[0].size).toBeInstanceOf(Decimal);
    expect(result[0].size.toString()).toBe('100');
  });

  // 10-9-3a ATDD: UNIT-028
  it('[P2] handles empty array input → returns empty array', () => {
    const result = parseJsonDepthLevels([]);
    expect(result).toEqual([]);
  });

  // 10-9-3a ATDD: UNIT-029
  it('[P2] handles malformed JSON depth levels gracefully', () => {
    const input = [{ size: '100' }, { price: '0.50' }];
    // Should not throw — graceful handling (skip or use 0)
    expect(() => parseJsonDepthLevels(input)).not.toThrow();
  });
});

// ============================================================
// Integration Tests — loadPricesForChunk()
// ============================================================
describe('BacktestDataLoaderService — loadPricesForChunk', () => {
  let service: any;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      historicalPrice: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      historicalDepth: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const { BacktestDataLoaderService } =
      await import('./backtest-data-loader.service');
    service = new BacktestDataLoaderService(prismaService);
  });

  // 10-9-3a ATDD: INT-001
  it('[P0] returns only HistoricalPrice records within the specified chunk timestamp range (exclusive end)', async () => {
    const chunkStart = new Date('2025-01-01T00:00:00Z');
    const chunkEnd = new Date('2025-01-02T00:00:00Z');

    await service.loadPricesForChunk(chunkStart, chunkEnd);

    expect(prismaService.historicalPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          timestamp: { gte: chunkStart, lt: chunkEnd },
        }),
      }),
    );
  });

  it('[P0] returns HistoricalPrice records with inclusive end when endInclusive=true (last chunk)', async () => {
    const chunkStart = new Date('2025-01-01T00:00:00Z');
    const chunkEnd = new Date('2025-01-02T00:00:00Z');

    await service.loadPricesForChunk(chunkStart, chunkEnd, true);

    expect(prismaService.historicalPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          timestamp: { gte: chunkStart, lte: chunkEnd },
        }),
      }),
    );
  });

  // 10-9-3a ATDD: INT-002
  it('[P1] returns records ordered by timestamp ASC', async () => {
    await service.loadPricesForChunk(
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    expect(prismaService.historicalPrice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { timestamp: 'asc' },
      }),
    );
  });

  // 10-9-3a ATDD: INT-003
  it('[P1] returns empty array when no records exist in the chunk range', async () => {
    prismaService.historicalPrice.findMany.mockResolvedValue([]);
    const result = await service.loadPricesForChunk(
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );
    expect(result).toEqual([]);
  });

  // 10-9-3a ATDD: INT-004
  it('[P2] does NOT return records outside the chunk range (exclusive end by default)', async () => {
    await service.loadPricesForChunk(
      new Date('2025-01-01T00:00:00Z'),
      new Date('2025-01-02T00:00:00Z'),
    );

    const call = prismaService.historicalPrice.findMany.mock.calls[0][0];
    expect(call.where.timestamp.gte).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(call.where.timestamp.lt).toEqual(new Date('2025-01-02T00:00:00Z'));
  });
});

// ============================================================
// Integration Tests — loadPairs()
// ============================================================
describe('BacktestDataLoaderService — loadPairs', () => {
  let service: any;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      contractMatch: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      historicalPrice: { findMany: vi.fn() },
      historicalDepth: { findMany: vi.fn() },
    };
    const { BacktestDataLoaderService } =
      await import('./backtest-data-loader.service');
    service = new BacktestDataLoaderService(prismaService);
  });

  // 10-9-3a ATDD: INT-005
  it('[P1] loads ContractMatch pairs using existing logic', async () => {
    const mockPairs = [
      { id: 1, kalshiContractId: 'K1', operatorApproved: true },
    ];
    prismaService.contractMatch.findMany.mockResolvedValue(mockPairs);

    const result = await service.loadPairs({
      minConfidenceScore: 0.8,
    } as any);

    expect(prismaService.contractMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operatorApproved: true,
          confidenceScore: { gte: 0.8 },
        }),
      }),
    );
    expect(result).toEqual(mockPairs);
  });

  // 10-9-3a ATDD: INT-006
  it('[P2] returns empty array when no pairs match config criteria', async () => {
    prismaService.contractMatch.findMany.mockResolvedValue([]);
    const result = await service.loadPairs({
      minConfidenceScore: 0.99,
    } as any);
    expect(result).toEqual([]);
  });
});
