/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-misused-promises */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IncrementalFetchService } from './incremental-fetch.service';

describe('IncrementalFetchService', () => {
  let service: IncrementalFetchService;
  let prisma: {
    historicalPrice: { aggregate: ReturnType<typeof vi.fn> };
    historicalTrade: { aggregate: ReturnType<typeof vi.fn> };
    historicalDepth: { aggregate: ReturnType<typeof vi.fn> };
    matchValidationReport: { findMany: ReturnType<typeof vi.fn> };
  };
  let predexonHistorical: {
    ingestPolymarketPrices: ReturnType<typeof vi.fn>;
    ingestPolymarketDepth: ReturnType<typeof vi.fn>;
    ingestPolymarketTrades: ReturnType<typeof vi.fn>;
    ingestKalshiDepth: ReturnType<typeof vi.fn>;
    ingestKalshiTrades: ReturnType<typeof vi.fn>;
  };
  let matchValidation: { runValidation: ReturnType<typeof vi.fn> };
  let qualityAssessor: {
    runQualityAssessment: ReturnType<typeof vi.fn>;
  };
  const targets = new Map([
    [
      'match-1',
      {
        kalshiTicker: 'KXBTC-24DEC31',
        polymarketTokenId: '0x1234',
        operatorApproved: true,
        resolutionTimestamp: null,
      },
    ],
  ]);

  function meta(recordCount: number) {
    return {
      source: 'PREDEXON',
      platform: 'polymarket',
      contractId: '0x1234',
      recordCount,
      dateRange: { start: new Date('2026-03-27'), end: new Date() },
      durationMs: 100,
    };
  }

  beforeEach(() => {
    prisma = {
      historicalPrice: {
        aggregate: vi.fn().mockResolvedValue({
          _max: { timestamp: new Date('2026-03-27T00:00:00Z') },
        }),
      },
      historicalTrade: {
        aggregate: vi.fn().mockResolvedValue({
          _max: { timestamp: new Date('2026-03-27T00:00:00Z') },
        }),
      },
      historicalDepth: {
        aggregate: vi.fn().mockResolvedValue({ _max: { timestamp: null } }),
      },
      matchValidationReport: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    predexonHistorical = {
      ingestPolymarketPrices: vi.fn().mockResolvedValue(meta(25)),
      ingestPolymarketDepth: vi.fn().mockResolvedValue(meta(10)),
      ingestPolymarketTrades: vi.fn().mockResolvedValue(meta(5)),
      ingestKalshiDepth: vi.fn().mockResolvedValue(meta(5)),
      ingestKalshiTrades: vi.fn().mockResolvedValue(meta(5)),
    };
    matchValidation = {
      runValidation: vi.fn().mockResolvedValue({ externalOnlyCount: 0 }),
    };
    qualityAssessor = {
      runQualityAssessment: vi.fn().mockResolvedValue(undefined),
    };

    service = new IncrementalFetchService(
      prisma as any,
      {} as any, // kalshiHistorical — fetchPlatformData currently disabled
      {} as any, // polymarketHistorical — fetchPlatformData currently disabled
      predexonHistorical as any,
      matchValidation as any,
      qualityAssessor as any,
    );

    vi.useRealTimers();
  });

  it('[P0] fetchAll should return a Map of results per source', async () => {
    const results = await service.fetchAll(targets);

    expect(results).toBeInstanceOf(Map);
    expect(results.size).toBeGreaterThan(0);
  });

  it('[P0] should call PredexonHistorical.ingestPolymarketPrices for candlesticks', async () => {
    await service.fetchAll(targets);

    expect(predexonHistorical.ingestPolymarketPrices).toHaveBeenCalledWith(
      '0x1234',
      expect.objectContaining({
        start: expect.any(Date),
        end: expect.any(Date),
      }),
    );
  });

  it('[P0] should call PredexonHistorical.ingestPolymarketDepth for orderbooks', async () => {
    await service.fetchAll(targets);

    expect(predexonHistorical.ingestPolymarketDepth).toHaveBeenCalledWith(
      '0x1234',
      expect.objectContaining({
        start: expect.any(Date),
        end: expect.any(Date),
      }),
    );
  });

  it('[P0] should use PREDEXON source for incremental depth starts', async () => {
    await service.fetchAll(targets);

    const depthCalls = prisma.historicalDepth.aggregate.mock.calls;
    const predexonCall = depthCalls.find(
      (c: any[]) => c[0]?.where?.source === 'PREDEXON',
    );
    expect(predexonCall).toBeDefined();
  });

  it('[P0] should use PREDEXON source for incremental price starts', async () => {
    await service.fetchAll(targets);

    const priceCalls = prisma.historicalPrice.aggregate.mock.calls;
    const predexonCall = priceCalls.find(
      (c: any[]) => c[0]?.where?.source === 'PREDEXON',
    );
    expect(predexonCall).toBeDefined();
  });

  it('[P0] per-contract error isolation: one contract failure does not block others', async () => {
    predexonHistorical.ingestPolymarketPrices.mockRejectedValueOnce(
      new Error('Timeout'),
    );

    const results = await service.fetchAll(targets);

    // Should still complete (error caught per-contract)
    expect(results).toBeInstanceOf(Map);
  });

  it('[P0] results Map should contain PREDEXON source entry', async () => {
    const results = await service.fetchAll(targets);

    expect(results.has('PREDEXON' as any)).toBe(true);
    const predexonResult = results.get('PREDEXON' as any);
    expect(predexonResult?.recordCount).toBeGreaterThanOrEqual(0);
  });

  it('[P1] per-ingest error isolation: depth succeeds even if prices fail', async () => {
    predexonHistorical.ingestPolymarketPrices.mockRejectedValue(
      new Error('prices down'),
    );
    // depth and kalshi depth still succeed
    predexonHistorical.ingestPolymarketDepth.mockResolvedValue(meta(10));
    predexonHistorical.ingestKalshiDepth.mockResolvedValue(meta(5));

    const results = await service.fetchAll(targets);

    // Depth calls should still have been invoked
    expect(predexonHistorical.ingestPolymarketDepth).toHaveBeenCalled();
    expect(predexonHistorical.ingestKalshiDepth).toHaveBeenCalled();
    const predexonResult = results.get('PREDEXON' as any);
    expect(predexonResult?.recordCount).toBe(15);
  });

  it('[P1] should call all 3 ingest methods concurrently per target', async () => {
    const callOrder: string[] = [];
    predexonHistorical.ingestPolymarketPrices.mockImplementation(async () => {
      callOrder.push('prices-start');
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push('prices-end');
      return meta(25);
    });
    predexonHistorical.ingestPolymarketDepth.mockImplementation(async () => {
      callOrder.push('depth-start');
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push('depth-end');
      return meta(10);
    });
    predexonHistorical.ingestKalshiDepth.mockImplementation(async () => {
      callOrder.push('kalshi-start');
      await new Promise((r) => setTimeout(r, 5));
      callOrder.push('kalshi-end');
      return meta(5);
    });

    await service.fetchAll(targets);

    // All 3 should start before any finishes (concurrent, not sequential)
    const starts = callOrder.filter((c) => c.endsWith('-start'));
    const firstEnd = callOrder.findIndex((c) => c.endsWith('-end'));
    expect(starts.length).toBe(3);
    // All 3 starts should appear before the first end
    expect(firstEnd).toBeGreaterThanOrEqual(3);
  });

  it('[P1] should deduplicate targets sharing the same contract IDs', async () => {
    const dupTargets = new Map([
      [
        'match-1',
        {
          kalshiTicker: 'KXBTC-24DEC31',
          polymarketTokenId: '0x1234',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ],
      [
        'match-2',
        {
          kalshiTicker: 'KXBTC-24DEC31',
          polymarketTokenId: '0x1234',
          operatorApproved: true,
          resolutionTimestamp: null,
        },
      ],
    ]);

    await service.fetchAll(dupTargets);

    // Same contract pair — should only call each ingest method once, not twice
    expect(predexonHistorical.ingestPolymarketPrices).toHaveBeenCalledTimes(1);
    expect(predexonHistorical.ingestPolymarketDepth).toHaveBeenCalledTimes(1);
    expect(predexonHistorical.ingestKalshiDepth).toHaveBeenCalledTimes(1);
  });
});
