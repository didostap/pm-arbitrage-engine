import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PredexonMatchingService } from './predexon-matching.service';
import { SYSTEM_HEALTH_ERROR_CODES } from '../../../common/errors/system-health-error';

function createPredexonPair(overrides?: Record<string, unknown>) {
  return {
    POLYMARKET: {
      condition_id: '0xabc123',
      title: 'Will Bitcoin exceed $100k?',
      ...((overrides?.POLYMARKET as Record<string, unknown>) ?? {}),
    },
    KALSHI: {
      market_ticker: 'KXBTC-24DEC31',
      title: 'Bitcoin above $100,000',
      ...((overrides?.KALSHI as Record<string, unknown>) ?? {}),
    },
    similarity:
      overrides?.similarity !== undefined ? overrides.similarity : 0.97,
    earliest_expiration_ts:
      overrides?.earliest_expiration_ts !== undefined
        ? overrides.earliest_expiration_ts
        : 1798675200, // 2026-12-31T00:00:00Z
    ...Object.fromEntries(
      Object.entries(overrides ?? {}).filter(
        ([k]) =>
          ![
            'POLYMARKET',
            'KALSHI',
            'similarity',
            'earliest_expiration_ts',
          ].includes(k),
      ),
    ),
  };
}

function createPredexonPairResponse(
  pairs: ReturnType<typeof createPredexonPair>[],
  pagination?: {
    has_more?: boolean;
    pagination_key?: string;
  },
) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        pairs,
        pagination: {
          limit: 100,
          count: pairs.length,
          has_more: pagination?.has_more ?? false,
          pagination_key: pagination?.pagination_key,
        },
      }),
  };
}

function createMockConfigService() {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'PREDEXON_API_KEY') return 'test-predexon-key';
      if (key === 'PREDEXON_BASE_URL') return 'https://api.predexon.com';
      return undefined;
    }),
  } as any;
}

function createService() {
  return new PredexonMatchingService(createMockConfigService());
}

describe('PredexonMatchingService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('[P0] should fetch matched pairs from GET /v2/matching-markets/pairs and normalize to ExternalMatchedPair', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(createPredexonPairResponse([createPredexonPair()])),
    );

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(
      expect.objectContaining({
        polymarketId: '0xabc123',
        kalshiId: 'KXBTC-24DEC31',
        polymarketTitle: 'Will Bitcoin exceed $100k?',
        kalshiTitle: 'Bitcoin above $100,000',
        source: 'predexon',
        similarity: 0.97,
        spreadData: null,
        settlementDate: new Date('2026-12-31T00:00:00.000Z'),
      }),
    );
  });

  it('[P1] should map earliest_expiration_ts to settlementDate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        createPredexonPairResponse([
          createPredexonPair({ earliest_expiration_ts: 1751328000 }), // 2025-07-01
        ]),
      ),
    );

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs[0]!.settlementDate).toEqual(new Date(1751328000 * 1000));
  });

  it('[P1] should leave settlementDate undefined when no expiration timestamp available', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          createPredexonPairResponse([
            createPredexonPair({ earliest_expiration_ts: null }),
          ]),
        ),
    );

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs[0]!.settlementDate).toBeUndefined();
  });

  it('[P1] should paginate with pagination_key until has_more === false', async () => {
    const page1Pairs = Array.from({ length: 2 }, (_, i) =>
      createPredexonPair({
        POLYMARKET: { condition_id: `0xpage1_${i}`, title: `P1 ${i}` },
        KALSHI: { market_ticker: `K-P1-${i}`, title: `K1 ${i}` },
      }),
    );
    const page2Pairs = [
      createPredexonPair({
        POLYMARKET: { condition_id: '0xpage2_0', title: 'P2 0' },
        KALSHI: { market_ticker: 'K-P2-0', title: 'K2 0' },
      }),
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createPredexonPairResponse(page1Pairs, {
          has_more: true,
          pagination_key: 'cursor-abc',
        }),
      )
      .mockResolvedValueOnce(
        createPredexonPairResponse(page2Pairs, {
          has_more: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Verify cursor-based pagination in URL
    expect(fetchMock.mock.calls[1]![0]).toContain('pagination_key=cursor-abc');
  });

  it('[P1] should include lowercase x-api-key header from PREDEXON_API_KEY config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(createPredexonPairResponse([])),
    );

    const service = createService();
    await service.fetchMatchedPairs();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'test-predexon-key',
        }),
      }),
    );
  });

  it('[P1] should enforce 72ms minimum interval between requests (14 req/s effective)', async () => {
    const page1 = [createPredexonPair()];
    const page2 = [
      createPredexonPair({
        POLYMARKET: { condition_id: '0xp2', title: 'P2' },
        KALSHI: { market_ticker: 'K-P2', title: 'K2' },
      }),
    ];

    const timestamps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        timestamps.push(Date.now());
        return Promise.resolve(
          createPredexonPairResponse(page1, {
            has_more: true,
            pagination_key: 'cursor-1',
          }),
        );
      })
      .mockImplementationOnce(() => {
        timestamps.push(Date.now());
        return Promise.resolve(
          createPredexonPairResponse(page2, {
            has_more: false,
          }),
        );
      });

    vi.stubGlobal('fetch', fetchMock);

    const service = createService();
    await service.fetchMatchedPairs();

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(70);
  });

  it('[P1] should preserve null similarity for pre-Jan-2025 matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          createPredexonPairResponse([
            createPredexonPair({ similarity: null }),
          ]),
        ),
    );

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs[0]!.similarity).toBeNull();
  });

  it('[P1] should abort after 30s via fetchWithTimeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(
                new DOMException('The operation was aborted.', 'AbortError'),
              ),
            );
            // Advance timers past the 30s + backoff timeouts for all 3 retry attempts
            // Each retry: 30s timeout + backoff (1s, 2s)
            void Promise.resolve().then(() => vi.advanceTimersByTime(35_000));
          }),
      ),
    );

    const service = createService();
    await expect(service.fetchMatchedPairs()).rejects.toMatchObject({
      code: SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
    });
  });

  it('[P1] should retry with exponential backoff (3 attempts) on transient errors', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockRejectedValueOnce(new Error('Network timeout'))
      .mockResolvedValueOnce(createPredexonPairResponse([]));

    vi.stubGlobal('fetch', fetchMock);

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('[P1] should throw SystemHealthError code 4202 after all retries exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network failure')),
    );

    const service = createService();
    await expect(service.fetchMatchedPairs()).rejects.toMatchObject({
      code: SYSTEM_HEALTH_ERROR_CODES.BACKTEST_PREDEXON_API_ERROR,
    });
  });

  it('[P0] should return empty array on 403 (free tier) with warn-level log, not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: 'Forbidden',
            message: 'Dev tier subscription required',
          }),
      }),
    );

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs).toEqual([]);
  });

  // Story 10-9-7: IExternalPairProvider adapter tests
  describe('IExternalPairProvider adapter', () => {
    it('[P0] fetchPairs() should delegate to existing fetchMatchedPairs() and return ExternalMatchedPair[]', async () => {
      const pair = createPredexonPair();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createPredexonPairResponse([pair], {
            has_more: false,
          }),
        ),
      );

      const service = createService();
      const spy = vi.spyOn(service, 'fetchMatchedPairs');
      const result = await service.fetchPairs();

      expect(spy).toHaveBeenCalledOnce();
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            polymarketId: '0xabc123',
            kalshiId: 'KXBTC-24DEC31',
            source: 'predexon',
          }),
        ]),
      );
    });

    it('[P0] getSourceId() should return "predexon"', () => {
      const service = createService();
      expect(service.getSourceId()).toBe('predexon');
    });

    it('[P1] fetchPairs() should propagate errors from fetchMatchedPairs() without adding retry layer', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('Network failure')),
      );

      const service = createService();
      await expect(service.fetchPairs()).rejects.toThrow();
    });
  });
});
