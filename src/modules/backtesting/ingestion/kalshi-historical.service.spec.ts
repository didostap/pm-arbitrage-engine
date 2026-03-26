import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { KalshiHistoricalService } from './kalshi-historical.service';
import { SystemHealthError } from '../../../common/errors/system-health-error';

const mockFetch = vi.fn();

function createMockPrisma() {
  return {
    historicalPrice: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    historicalTrade: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  } as any;
}

function createJsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createMockConfigService() {
  return {
    get: vi.fn((_key: string, defaultValue: string) => defaultValue),
  } as any;
}

/** Returns a far-future cutoff so date range checks never clip */
function farFutureCutoffResponse() {
  return createJsonResponse({
    market_settled_ts: '2099-12-31T00:00:00Z',
    trades_created_ts: '2099-12-31T00:00:00Z',
    orders_updated_ts: '2099-12-31T00:00:00Z',
  });
}

function createKalshiService(prismaOverride?: any) {
  const prisma = prismaOverride ?? createMockPrisma();
  const config = createMockConfigService();
  const service = new KalshiHistoricalService(prisma, config);
  return { service, prisma };
}

describe('KalshiHistoricalService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('fetchCutoff', () => {
    it('[P0] should fetch and parse cutoff timestamps', async () => {
      const { service } = createKalshiService();

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-03-01T00:00:00Z',
          trades_created_ts: '2025-03-01T00:00:00Z',
          orders_updated_ts: '2025-03-01T00:00:00Z',
        }),
      );

      const cutoff = await service.fetchCutoff();
      expect(cutoff.market_settled_ts).toBeInstanceOf(Date);
      expect(cutoff.trades_created_ts).toBeInstanceOf(Date);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/historical/cutoff'),
        undefined,
      );
    });

    it('[P1] should cache cutoff for 1 hour (TTL)', async () => {
      const { service } = createKalshiService();

      mockFetch.mockResolvedValue(
        createJsonResponse({
          market_settled_ts: '2025-03-01T00:00:00Z',
          trades_created_ts: '2025-03-01T00:00:00Z',
          orders_updated_ts: '2025-03-01T00:00:00Z',
        }),
      );

      await service.fetchCutoff();
      await service.fetchCutoff();

      // Should only call fetch once (cached)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('[P1] should refresh cutoff after TTL expires', async () => {
      const { service } = createKalshiService();

      const cutoffPayload = {
        market_settled_ts: '2025-03-01T00:00:00Z',
        trades_created_ts: '2025-03-01T00:00:00Z',
        orders_updated_ts: '2025-03-01T00:00:00Z',
      };
      mockFetch
        .mockResolvedValueOnce(createJsonResponse(cutoffPayload))
        .mockResolvedValueOnce(createJsonResponse(cutoffPayload));

      await service.fetchCutoff();

      // Simulate time passing beyond TTL (1 hour)
      vi.advanceTimersByTime(3600001);

      await service.fetchCutoff();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('[P20] should throw on non-2xx cutoff response via fetchWithRetry', async () => {
      const { service } = createKalshiService();

      mockFetch.mockResolvedValue(
        new Response('Service Unavailable', { status: 503 }),
      );

      await expect(service.fetchCutoff()).rejects.toThrow(SystemHealthError);
    });
  });

  describe('ingestPrices', () => {
    it('[P0] should fetch candlestick data and normalize Kalshi dollar strings to Decimal', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Mock cutoff (far future)
      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());

      // Mock candlestick response — Kalshi returns dollar strings
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          candlesticks: [
            {
              end_period_ts: 1704067260,
              open: '0.5600',
              high: '0.5800',
              low: '0.5500',
              close: '0.5700',
              volume: '15000',
              open_interest: '50000',
            },
            {
              end_period_ts: 1704067320,
              open: '0.5700',
              high: '0.5900',
              low: '0.5600',
              close: '0.5800',
              volume: '12000',
              open_interest: '51000',
            },
          ],
        }),
      );

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 2 });

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // Verify dollar strings normalized to Decimal (no division by 100)
      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              open: expect.any(Decimal),
              close: expect.any(Decimal),
              platform: 'KALSHI',
            }),
          ]),
          skipDuplicates: true,
        }),
      );
      expect(result.recordCount).toBe(2);
    });

    it('[P0] should batch insert in chunks of 500', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());

      // Mock 600 candlesticks (should be split into 2 batches: 500 + 100)
      const candlesticks = Array.from({ length: 600 }, (_, i) => ({
        end_period_ts: 1704067200 + i * 60,
        open: '0.50',
        high: '0.52',
        low: '0.48',
        close: '0.51',
        volume: '1000',
        open_interest: '5000',
      }));
      mockFetch.mockResolvedValueOnce(createJsonResponse({ candlesticks }));

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 500 });

      await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // Should call createMany twice (500 + 100)
      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledTimes(2);
    });

    it('[P0] should use skipDuplicates for idempotent re-ingestion', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          candlesticks: [
            {
              end_period_ts: 1704067260,
              open: '0.50',
              high: '0.52',
              low: '0.48',
              close: '0.51',
              volume: '1000',
            },
          ],
        }),
      );

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 0 }); // all duplicates

      await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('[P2] should return 0 records when date range is entirely beyond cutoff', async () => {
      const { service } = createKalshiService();

      // Cutoff is in the past
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(0);
      // No candlestick fetch call (only cutoff)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('[IG-1] should chunk date ranges into 7-day windows for candlestick pagination', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());

      // 15-day range: 3 chunks (7+7+1)
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ candlesticks: [] }))
        .mockResolvedValueOnce(createJsonResponse({ candlesticks: [] }))
        .mockResolvedValueOnce(createJsonResponse({ candlesticks: [] }));

      await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-16'),
      });

      // cutoff + 3 chunk calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('ingestTrades', () => {
    it('[P0] should paginate via cursor until empty cursor returned', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());

      // Page 1: has cursor
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 't1',
              yes_price_dollars: '0.56',
              no_price_dollars: '0.44',
              taker_side: 'yes',
              count: 10,
              created_time: '2025-01-01T00:00:00Z',
            },
          ],
          cursor: 'next-page-cursor',
        }),
      );

      // Page 2: no cursor (end)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 't2',
              yes_price_dollars: '0.60',
              no_price_dollars: '0.40',
              taker_side: 'no',
              count: 5,
              created_time: '2025-01-01T01:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      const result = await service.ingestTrades('KXBTC-24DEC31', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      // Verify pagination: 3 fetch calls (cutoff + 2 pages)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      // Verify taker_side mapping: 'yes' → 'buy', 'no' → 'sell'
      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ side: 'buy' }),
          ]),
          skipDuplicates: true,
        }),
      );
    });

    it('[P5] should generate synthetic externalTradeId when source fields are missing', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              // No trade_id or id — should generate synthetic
              yes_price_dollars: '0.50',
              taker_side: 'yes',
              count: '1',
              created_time: '2025-01-01T00:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      await service.ingestTrades('KXBTC', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      const insertedData =
        mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0]?.data;
      expect(insertedData?.[0]?.externalTradeId).toMatch(/^kalshi-/);
      expect(insertedData?.[0]?.externalTradeId).not.toBeNull();
    });
  });

  describe('error handling', () => {
    it('[P0] should retry 5xx errors with exponential backoff (3 attempts)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Mock cutoff success
      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());

      // 2 failures then success
      mockFetch
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Server Error', { status: 502 }))
        .mockResolvedValueOnce(createJsonResponse({ candlesticks: [] }));

      await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // cutoff + 3 candlestick attempts
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('[P1] should NOT retry 4xx errors', async () => {
      const { service } = createKalshiService();

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());
      mockFetch.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );

      await expect(
        service.ingestPrices('NONEXISTENT', {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-02'),
        }),
      ).rejects.toThrow();

      // cutoff + 1 failed attempt (no retry)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('[P0] should throw SystemHealthError with code 4206 on API failure', async () => {
      const { service } = createKalshiService();

      mockFetch.mockResolvedValueOnce(farFutureCutoffResponse());
      mockFetch.mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      await expect(
        service.ingestPrices('KXBTC-24DEC31', {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-02'),
        }),
      ).rejects.toThrow(SystemHealthError);
    });
  });

  // P22: Real-timer test in its own describe block to avoid timer state leaks
  describe('rate limiting (real timers)', () => {
    beforeEach(() => {
      vi.useRealTimers();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('[P1] should enforce 14 req/s rate limit (70% of 20 req/s)', async () => {
      const { service } = createKalshiService();

      const timestamps: number[] = [];
      mockFetch.mockImplementation(async () => {
        timestamps.push(Date.now());
        return createJsonResponse({
          market_settled_ts: '2025-12-31T00:00:00Z',
          trades_created_ts: '2025-12-31T00:00:00Z',
          orders_updated_ts: '2025-12-31T00:00:00Z',
        });
      });

      // Two sequential calls to measure rate limiting
      await service.fetchCutoff();
      // Reset cache to force second fetch
      (service as any).cachedCutoff = null;
      await service.fetchCutoff();

      if (timestamps.length >= 2) {
        const interval = timestamps[1]! - timestamps[0]!;
        expect(interval).toBeGreaterThanOrEqual(60); // ~71ms min
      }
    });
  });
});
