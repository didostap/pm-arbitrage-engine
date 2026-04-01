/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PredexonHistoricalService } from './predexon-historical.service';

let mockFetch: ReturnType<typeof vi.fn>;

function createJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: () => Promise.resolve(body),
  };
}

function createMockPrisma() {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    historicalPrice: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { timestamp: null } }),
    },
    historicalDepth: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { timestamp: null } }),
    },
    historicalTrade: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({ _max: { timestamp: null } }),
    },
  };
}

function createMockConfigService() {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'PREDEXON_API_KEY') return 'test-predexon-key';
      if (key === 'PREDEXON_BASE_URL') return 'https://api.predexon.com';
      return undefined;
    }),
  };
}

function createService(prisma = createMockPrisma()) {
  return {
    service: new PredexonHistoricalService(
      prisma as any,
      createMockConfigService() as any,
    ),
    prisma,
  };
}

describe('PredexonHistoricalService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('ingestPolymarketPrices', () => {
    it('[P0] should fetch candlesticks and persist to historicalPrice', async () => {
      const { service, prisma } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          condition_id: '0xcond1',
          candlesticks: [
            {
              end_period_ts: 1704067200,
              price: {
                open: 0.5,
                high: 0.6,
                low: 0.4,
                close: 0.55,
                open_dollars: '0.50',
                high_dollars: '0.60',
                low_dollars: '0.40',
                close_dollars: '0.55',
              },
              volume: 1000,
            },
          ],
        }),
      );

      const result = await service.ingestPolymarketPrices('0xcond1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const sql = prisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sql).toContain('INSERT INTO historical_prices');
      expect(sql).toContain('ON CONFLICT');
      // Params include source='PREDEXON' and open='0.50'
      const params = prisma.$executeRawUnsafe.mock.calls[0]?.slice(1);
      expect(params).toContain('PREDEXON');
      expect(params).toContain('0.50');
      expect(result.recordCount).toBeGreaterThanOrEqual(0);
    });

    it('[P0] should use condition_id in URL path', async () => {
      const { service } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          condition_id: '0xcond1',
          candlesticks: [],
        }),
      );

      await service.ingestPolymarketPrices('0xcond1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const url = mockFetch.mock.calls[0]?.[0] as string;
      expect(url).toContain('/v2/polymarket/candlesticks/0xcond1');
      expect(url).toContain('interval=60');
    });
  });

  describe('ingestPolymarketDepth', () => {
    it('[P0] should fetch orderbook snapshots and persist to historicalDepth', async () => {
      const { service, prisma } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          snapshots: [
            {
              token_id: '12345',
              timestamp: 1704067200000,
              bids: [{ price: 50, size: 100 }],
              asks: [{ price: 55, size: 200 }],
            },
          ],
          pagination: { limit: 200, count: 1, has_more: false },
        }),
      );

      const result = await service.ingestPolymarketDepth('12345', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const sql = prisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sql).toContain('INSERT INTO historical_depths');
      expect(sql).toContain('ON CONFLICT');
      const params = prisma.$executeRawUnsafe.mock.calls[0]?.slice(1);
      expect(params).toContain('PREDEXON');
      // bids serialized as JSON string
      expect(params).toContain(JSON.stringify([{ price: '50', size: '100' }]));
      expect(result.recordCount).toBeGreaterThanOrEqual(0);
    });

    it('[P0] should paginate with pagination_key', async () => {
      const { service } = createService();

      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({
            snapshots: [
              {
                timestamp: 1704067200000,
                bids: [],
                asks: [],
              },
            ],
            pagination: {
              limit: 200,
              count: 1,
              has_more: true,
              pagination_key: 'cursor-1',
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            snapshots: [],
            pagination: { limit: 200, count: 0, has_more: false },
          }),
        );

      await service.ingestPolymarketDepth('12345', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const secondUrl = mockFetch.mock.calls[1]?.[0] as string;
      expect(secondUrl).toContain('pagination_key=cursor-1');
    });
  });

  describe('ingestPolymarketTrades', () => {
    it('[P0] should fetch trades and persist to historicalTrade', async () => {
      const { service, prisma } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 'trade-1',
              timestamp: 1704067200000,
              price: 0.55,
              size: 100,
              side: 'buy',
            },
          ],
          pagination: { limit: 200, count: 1, has_more: false },
        }),
      );

      const result = await service.ingestPolymarketTrades('12345', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const sql = prisma.$executeRawUnsafe.mock.calls[0]?.[0] as string;
      expect(sql).toContain('INSERT INTO historical_trades');
      const params = prisma.$executeRawUnsafe.mock.calls[0]?.slice(1);
      expect(params).toContain('PREDEXON');
      expect(params).toContain('trade-1');
      expect(result.recordCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('ingestKalshiDepth', () => {
    it('[P0] should fetch Kalshi orderbook snapshots', async () => {
      const { service, prisma } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          snapshots: [
            {
              ticker: 'KXBTC',
              timestamp: 1704067200000,
              yes_bids: [{ price: 4, size: 25 }],
              yes_asks: [{ price: 96, size: 25 }],
              best_bid: 4,
              best_ask: 96,
              bid_depth: 1117,
              ask_depth: 1117,
              sequence: 1674286,
            },
          ],
          pagination: { limit: 200, count: 1, has_more: false },
        }),
      );

      await service.ingestKalshiDepth('KXBTC', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const params = prisma.$executeRawUnsafe.mock.calls[0]?.slice(1);
      expect(params).toContain('KALSHI');
      expect(params).toContain('KXBTC');
    });
  });

  describe('ingestKalshiTrades', () => {
    it('[P0] should fetch Kalshi trades', async () => {
      const { service, prisma } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 'kalshi-trade-1',
              timestamp: 1704067200000,
              price: 0.6,
              size: 25,
              side: 'sell',
            },
          ],
          pagination: { limit: 200, count: 1, has_more: false },
        }),
      );

      await service.ingestKalshiTrades('KXBTC', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const params = prisma.$executeRawUnsafe.mock.calls[0]?.slice(1);
      expect(params).toContain('KALSHI');
      expect(params).toContain('KXBTC');
    });
  });

  describe('error handling', () => {
    it('[P0] should return null on 403 (graceful degradation)', async () => {
      const { service } = createService();

      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        headers: new Map(),
        json: () => Promise.resolve({ error: 'Forbidden' }),
      });

      const result = await service.ingestPolymarketPrices('0xcond1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(result.recordCount).toBe(0);
    });

    it('[P0] should include x-api-key header in requests', async () => {
      const { service } = createService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({ condition_id: '0x1', candlesticks: [] }),
      );

      await service.ingestPolymarketPrices('0x1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const options = mockFetch.mock.calls[0]?.[1];
      expect(options?.headers?.['x-api-key']).toBe('test-predexon-key');
    });

    it('[P1] concurrent calls should serialize through rate limiter', async () => {
      const { service } = createService();

      // Each call triggers one fetch
      mockFetch.mockResolvedValue(
        createJsonResponse({ condition_id: '0x1', candlesticks: [] }),
      );

      // Fire 3 calls concurrently (simulates parallel ingest per target)
      await Promise.all([
        service.ingestPolymarketPrices('0x1', {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-02'),
        }),
        service.ingestPolymarketPrices('0x2', {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-02'),
        }),
        service.ingestPolymarketPrices('0x3', {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-02'),
        }),
      ]);

      // All 3 should have completed (serialized through chain, not dropped)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
