import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PredexonMatchingService } from './predexon-matching.service';
import { SYSTEM_HEALTH_ERROR_CODES } from '../../../common/errors/system-health-error';

function createPredexonPair(overrides?: Record<string, unknown>) {
  return {
    polymarket_condition_id: '0xabc123',
    kalshi_ticker: 'KXBTC-24DEC31',
    polymarket_title: 'Will Bitcoin exceed $100k?',
    kalshi_title: 'Bitcoin above $100,000',
    similarity: 0.97,
    ...overrides,
  };
}

function createPredexonPairResponse(
  pairs: ReturnType<typeof createPredexonPair>[],
  pagination?: {
    total?: number;
    limit?: number;
    offset?: number;
    has_more?: boolean;
  },
) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: pairs,
        pagination: {
          total: pagination?.total ?? pairs.length,
          limit: pagination?.limit ?? 100,
          offset: pagination?.offset ?? 0,
          has_more: pagination?.has_more ?? false,
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
      }),
    );
  });

  it('[P1] should paginate with offset until has_more === false', async () => {
    const page1Pairs = Array.from({ length: 2 }, (_, i) =>
      createPredexonPair({
        polymarket_condition_id: `0xpage1_${i}`,
        kalshi_ticker: `K-P1-${i}`,
      }),
    );
    const page2Pairs = [
      createPredexonPair({
        polymarket_condition_id: '0xpage2_0',
        kalshi_ticker: 'K-P2-0',
      }),
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createPredexonPairResponse(page1Pairs, {
          total: 3,
          limit: 100,
          offset: 0,
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        createPredexonPairResponse(page2Pairs, {
          total: 3,
          limit: 100,
          offset: 100,
          has_more: false,
        }),
      );

    vi.stubGlobal('fetch', fetchMock);

    const service = createService();
    const pairs = await service.fetchMatchedPairs();

    expect(pairs).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Verify offset pagination in URL
    expect(fetchMock.mock.calls[1]![0]).toContain('offset=100');
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
        polymarket_condition_id: '0xp2',
        kalshi_ticker: 'K-P2',
      }),
    ];

    const timestamps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        timestamps.push(Date.now());
        return Promise.resolve(
          createPredexonPairResponse(page1, {
            total: 2,
            offset: 0,
            has_more: true,
          }),
        );
      })
      .mockImplementationOnce(() => {
        timestamps.push(Date.now());
        return Promise.resolve(
          createPredexonPairResponse(page2, {
            total: 2,
            offset: 100,
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
});
