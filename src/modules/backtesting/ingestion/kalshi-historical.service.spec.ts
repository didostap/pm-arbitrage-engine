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

    it('[P20] should throw on non-2xx cutoff response via fetchWithRetry', { timeout: 45_000 }, async () => {
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

    it('[AC3] should fetch from live endpoint only when range is entirely post-cutoff', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff in the past
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );

      // Live candlestick response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC-24DEC31',
              candlesticks: [
                {
                  end_period_ts: 1735689600,
                  price: {
                    open_dollars: '0.56',
                    high_dollars: '0.58',
                    low_dollars: '0.54',
                    close_dollars: '0.57',
                  },
                  volume_fp: '10.00',
                },
              ],
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(1);
      // cutoff + 1 live call
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify live endpoint used
      const liveUrl = mockFetch.mock.calls[1]![0] as string;
      expect(liveUrl).toContain('/markets/candlesticks');
      expect(liveUrl).not.toContain('/historical/');
    });

    it('[AC1] should fetch from both endpoints when range spans cutoff', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff at 2025-06-15
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-15T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2025-06-15T00:00:00Z',
        }),
      );

      // Historical candlestick response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          candlesticks: [
            {
              end_period_ts: 1718323200,
              open: '0.50',
              high: '0.52',
              low: '0.48',
              close: '0.51',
              volume: '100',
            },
          ],
        }),
      );

      // Live candlestick response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC-24DEC31',
              candlesticks: [
                {
                  end_period_ts: 1718409600,
                  price: {
                    open_dollars: '0.56',
                    high_dollars: '0.58',
                    low_dollars: '0.54',
                    close_dollars: '0.57',
                  },
                  volume_fp: '10.00',
                },
              ],
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2025-06-14'),
        end: new Date('2025-06-16'),
      });

      // AC#9: combined record count
      expect(result.recordCount).toBe(2);
      // cutoff + 1 historical + 1 live
      expect(mockFetch).toHaveBeenCalledTimes(3);
      // Verify historical endpoint used
      const historicalUrl = mockFetch.mock.calls[1]![0] as string;
      expect(historicalUrl).toContain('/historical/markets/');
      // Verify live endpoint used
      const liveUrl = mockFetch.mock.calls[2]![0] as string;
      expect(liveUrl).toContain('/markets/candlesticks');
    });

    it('[AC9] should combine record counts from both partitions', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff at 2025-06-15
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-15T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2025-06-15T00:00:00Z',
        }),
      );

      // Historical: 3 records
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          candlesticks: [
            {
              end_period_ts: 1718323200,
              open: '0.50',
              high: '0.52',
              low: '0.48',
              close: '0.51',
              volume: '100',
            },
            {
              end_period_ts: 1718323260,
              open: '0.51',
              high: '0.53',
              low: '0.49',
              close: '0.52',
              volume: '200',
            },
            {
              end_period_ts: 1718323320,
              open: '0.52',
              high: '0.54',
              low: '0.50',
              close: '0.53',
              volume: '300',
            },
          ],
        }),
      );

      // Live: 2 records
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC-24DEC31',
              candlesticks: [
                {
                  end_period_ts: 1718409600,
                  price: {
                    open_dollars: '0.56',
                    high_dollars: '0.58',
                    low_dollars: '0.54',
                    close_dollars: '0.57',
                  },
                  volume_fp: '10.00',
                },
                {
                  end_period_ts: 1718409660,
                  price: {
                    open_dollars: '0.57',
                    high_dollars: '0.59',
                    low_dollars: '0.55',
                    close_dollars: '0.58',
                  },
                  volume_fp: '11.00',
                },
              ],
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2025-06-14'),
        end: new Date('2025-06-16'),
      });

      expect(result.recordCount).toBe(5);
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

    it('[AC6] should fetch from live trades endpoint only when range is entirely post-cutoff', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff in the past
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );

      // Live trades response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'live-t1',
              yes_price_dollars: '0.56',
              taker_side: 'yes',
              count_fp: '10',
              created_time: '2026-01-15T10:30:00Z',
            },
          ],
          cursor: '',
        }),
      );

      const result = await service.ingestTrades('KXBTC-24DEC31', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(1);
      // cutoff + 1 live call
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const liveUrl = mockFetch.mock.calls[1]![0] as string;
      expect(liveUrl).toContain('/markets/trades');
      expect(liveUrl).not.toContain('/historical/');
    });

    it('[AC5] should fetch from both endpoints when trade range spans cutoff', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff at 2025-06-15
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-15T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2025-06-15T00:00:00Z',
        }),
      );

      // Historical trades
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 'h-t1',
              yes_price_dollars: '0.50',
              taker_side: 'yes',
              count: '10',
              created_time: '2025-06-14T10:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      // Live trades
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'l-t1',
              yes_price_dollars: '0.56',
              taker_side: 'no',
              count_fp: '5',
              created_time: '2025-06-16T10:00:00Z',
            },
            {
              trade_id: 'l-t2',
              yes_price_dollars: '0.57',
              taker_side: 'yes',
              count_fp: '3',
              created_time: '2025-06-16T11:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      const result = await service.ingestTrades('KXBTC-24DEC31', {
        start: new Date('2025-06-14'),
        end: new Date('2025-06-17'),
      });

      // AC#9: combined record count
      expect(result.recordCount).toBe(3);
      // cutoff + historical + live
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const historicalUrl = mockFetch.mock.calls[1]![0] as string;
      expect(historicalUrl).toContain('/historical/trades');
      const liveUrl = mockFetch.mock.calls[2]![0] as string;
      expect(liveUrl).toContain('/markets/trades');
    });

    it('[AC5] should use trades_created_ts cutoff for trades (not market_settled_ts)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Different cutoffs: market_settled = Jan 1, trades = June 15
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );

      // Historical trades (should be called because range starts before trades_created_ts)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              id: 'h-t1',
              yes_price_dollars: '0.50',
              taker_side: 'yes',
              count: '1',
              created_time: '2025-06-14T00:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      const result = await service.ingestTrades('KXBTC', {
        start: new Date('2025-06-14'),
        end: new Date('2025-06-15'),
      });

      // Only historical (end == cutoff, so live condition end > cutoffTs is false)
      expect(result.recordCount).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
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

  describe('fetchAndPersistLiveTrades', () => {
    it('[AC5] should fetch from /markets/trades with cursor pagination and persist per-page', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Page 1 with cursor
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'live-t1',
              yes_price_dollars: '0.56',
              no_price_dollars: '0.44',
              taker_side: 'yes',
              count_fp: '10',
              created_time: '2026-01-15T10:30:00Z',
            },
          ],
          cursor: 'page2',
        }),
      );

      // Page 2 no cursor
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'live-t2',
              yes_price_dollars: '0.60',
              taker_side: 'no',
              count_fp: '5',
              created_time: '2026-01-15T11:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      const count = await (service as any).fetchAndPersistLiveTrades(
        'KXBTC-24DEC31',
        { start: new Date('2026-01-15'), end: new Date('2026-01-16') },
      );

      expect(count).toBe(2);
      // Per-page writes: 2 createMany calls (1 per page)
      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              platform: 'KALSHI',
              contractId: 'KXBTC-24DEC31',
              externalTradeId: 'live-t1',
              price: new Decimal('0.56'),
              side: 'buy',
            }),
          ]),
          skipDuplicates: true,
        }),
      );
      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              side: 'sell',
            }),
          ]),
        }),
      );

      // 2 pages
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstUrl = mockFetch.mock.calls[0]![0] as string;
      expect(firstUrl).toContain('/markets/trades');
      expect(firstUrl).toContain('ticker=KXBTC-24DEC31');
      // Unix seconds — NOT milliseconds
      const minTs = String(Math.floor(new Date('2026-01-15').getTime() / 1000));
      const maxTs = String(Math.floor(new Date('2026-01-16').getTime() / 1000));
      expect(firstUrl).toContain(`min_ts=${minTs}`);
      expect(firstUrl).toContain(`max_ts=${maxTs}`);
    });

    it('[AC6] should handle empty response', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({ trades: [], cursor: '' }),
      );

      const count = await (service as any).fetchAndPersistLiveTrades(
        'KXBTC-24DEC31',
        { start: new Date('2026-01-15'), end: new Date('2026-01-16') },
      );

      expect(count).toBe(0);
      expect(mockPrisma.historicalTrade.createMany).not.toHaveBeenCalled();
    });

    it('[AC5] should use same trade parsing as historical (reuse KalshiTrade type)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'live-t1',
              yes_price_dollars: '0.5600',
              no_price_dollars: '0.4400',
              taker_side: 'yes',
              count_fp: '10.00',
              created_time: '2026-01-15T10:30:00Z',
            },
          ],
          cursor: '',
        }),
      );

      await (service as any).fetchAndPersistLiveTrades('KXBTC', {
        start: new Date('2026-01-15'),
        end: new Date('2026-01-16'),
      });

      const insertedData =
        mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0]?.data;
      expect(insertedData?.[0]?.price).toEqual(new Decimal('0.5600'));
      expect(insertedData?.[0]?.size).toEqual(new Decimal('10.00'));
      expect(insertedData?.[0]?.source).toBe('KALSHI_API');
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

    it('[P0] should throw SystemHealthError with code 4206 on API failure', { timeout: 45_000 }, async () => {
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

  describe('fetchAndPersistLiveCandlesticks', () => {
    it('[AC3] should fetch from /markets/candlesticks with correct query params and persist per-chunk', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC-24DEC31',
              candlesticks: [
                {
                  end_period_ts: 1704067260,
                  price: {
                    open_dollars: '0.56',
                    high_dollars: '0.58',
                    low_dollars: '0.54',
                    close_dollars: '0.57',
                  },
                  volume_fp: '10.00',
                  open_interest_fp: '25.00',
                },
              ],
            },
          ],
        }),
      );

      const count = await (service as any).fetchAndPersistLiveCandlesticks(
        'KXBTC-24DEC31',
        { start: new Date('2026-01-01'), end: new Date('2026-01-02') },
      );

      expect(count).toBe(1);
      // Per-chunk DB write
      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              platform: 'KALSHI',
              contractId: 'KXBTC-24DEC31',
              open: new Decimal('0.56'),
              close: new Decimal('0.57'),
            }),
          ]),
          skipDuplicates: true,
        }),
      );

      // Verify URL contains /markets/candlesticks with Unix seconds params
      const calledUrl = mockFetch.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('/markets/candlesticks');
      expect(calledUrl).toContain('market_tickers=KXBTC-24DEC31');
      expect(calledUrl).toContain('period_interval=1');
      // Unix seconds — NOT milliseconds
      const startTs = String(
        Math.floor(new Date('2026-01-01').getTime() / 1000),
      );
      const endTs = String(Math.floor(new Date('2026-01-02').getTime() / 1000));
      expect(calledUrl).toContain(`start_ts=${startTs}`);
      expect(calledUrl).toContain(`end_ts=${endTs}`);
    });

    it('[AC8] should chunk into 6-day windows for live endpoint', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // 13-day range: 3 chunks (6+6+1)
      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({
            markets: [{ market_ticker: 'T', candlesticks: [] }],
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            markets: [{ market_ticker: 'T', candlesticks: [] }],
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            markets: [{ market_ticker: 'T', candlesticks: [] }],
          }),
        );

      await (service as any).fetchAndPersistLiveCandlesticks('T', {
        start: new Date('2026-01-01'),
        end: new Date('2026-01-14'),
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('[AC3] should handle empty markets array gracefully', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(createJsonResponse({ markets: [] }));

      const count = await (service as any).fetchAndPersistLiveCandlesticks(
        'NONEXISTENT',
        { start: new Date('2026-01-01'), end: new Date('2026-01-02') },
      );

      expect(count).toBe(0);
      expect(mockPrisma.historicalPrice.createMany).not.toHaveBeenCalled();
    });

    it('[AC3] should handle market not found in response', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'OTHER-TICKER',
              candlesticks: [
                {
                  end_period_ts: 123,
                  price: {
                    open_dollars: '0.5',
                    high_dollars: '0.5',
                    low_dollars: '0.5',
                    close_dollars: '0.5',
                  },
                },
              ],
            },
          ],
        }),
      );

      const count = await (service as any).fetchAndPersistLiveCandlesticks(
        'KXBTC-24DEC31',
        { start: new Date('2026-01-01'), end: new Date('2026-01-02') },
      );

      expect(count).toBe(0);
      expect(mockPrisma.historicalPrice.createMany).not.toHaveBeenCalled();
    });

    it('[AC7] should route live requests through shared fetchWithRateLimit', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      const timestamps: number[] = [];
      mockFetch.mockImplementation(async () => {
        timestamps.push(Date.now());
        return createJsonResponse({
          markets: [{ market_ticker: 'T', candlesticks: [] }],
        });
      });

      // 2 chunks — verifies rate limiting between live requests
      await (service as any).fetchAndPersistLiveCandlesticks('T', {
        start: new Date('2026-01-01'),
        end: new Date('2026-01-14'),
      });

      // At least 2 calls, all go through rate limiter
      expect(mockFetch).toHaveBeenCalledTimes(3);
      if (timestamps.length >= 2) {
        const interval = timestamps[1]! - timestamps[0]!;
        // Rate limiter enforces ~71ms between requests
        expect(interval).toBeGreaterThanOrEqual(60);
      }
    });
  });

  describe('dual-partition edge cases', () => {
    it('[AC4] should use historical only when range entirely pre-cutoff (unchanged behavior)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff far in the future
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
              volume: '100',
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC-24DEC31', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(result.recordCount).toBe(1);
      // Only historical endpoint called
      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/historical/markets/'))).toBe(true);
      expect(urls.some((u) => u.includes('/markets/candlesticks'))).toBe(false);
    });

    it('should handle cutoff exactly at range start (only live)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff = range start → historical condition (start < cutoff) is false → live only
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-15T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2025-06-15T00:00:00Z',
        }),
      );
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC',
              candlesticks: [
                {
                  end_period_ts: 1718496000,
                  price: {
                    open_dollars: '0.50',
                    high_dollars: '0.52',
                    low_dollars: '0.48',
                    close_dollars: '0.51',
                  },
                  volume_fp: '10',
                },
              ],
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC', {
        start: new Date('2025-06-15T00:00:00Z'),
        end: new Date('2025-06-16T00:00:00Z'),
      });

      expect(result.recordCount).toBe(1);
      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/historical/markets/'))).toBe(false);
      expect(urls.some((u) => u.includes('/markets/candlesticks'))).toBe(true);
    });

    it('should handle cutoff exactly at range start for trades (only live)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // trades_created_ts = range start → hasHistorical false → live only
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-15T00:00:00Z',
          trades_created_ts: '2025-06-15T00:00:00Z',
          orders_updated_ts: '2025-06-15T00:00:00Z',
        }),
      );
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          trades: [
            {
              trade_id: 'lt-1',
              yes_price_dollars: '0.56',
              taker_side: 'yes',
              count_fp: '5',
              created_time: '2025-06-15T01:00:00Z',
            },
          ],
          cursor: '',
        }),
      );

      const result = await service.ingestTrades('KXBTC', {
        start: new Date('2025-06-15T00:00:00Z'),
        end: new Date('2025-06-16T00:00:00Z'),
      });

      expect(result.recordCount).toBe(1);
      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/historical/trades'))).toBe(false);
      expect(urls.some((u) => u.includes('/markets/trades'))).toBe(true);
    });

    it('should handle cutoff exactly at range end (only historical)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      // Cutoff = range end → live condition (end > cutoff) is false → historical only
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2025-06-16T00:00:00Z',
          trades_created_ts: '2025-06-16T00:00:00Z',
          orders_updated_ts: '2025-06-16T00:00:00Z',
        }),
      );
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          candlesticks: [
            {
              end_period_ts: 1718409600,
              open: '0.50',
              high: '0.52',
              low: '0.48',
              close: '0.51',
              volume: '100',
            },
          ],
        }),
      );

      const result = await service.ingestPrices('KXBTC', {
        start: new Date('2025-06-15T00:00:00Z'),
        end: new Date('2025-06-16T00:00:00Z'),
      });

      expect(result.recordCount).toBe(1);
      const urls = mockFetch.mock.calls.map((c) => c[0] as string);
      expect(urls.some((u) => u.includes('/historical/markets/'))).toBe(true);
      expect(urls.some((u) => u.includes('/markets/candlesticks'))).toBe(false);
    });

    it('should return empty when live endpoint returns no data for market post-cutoff', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );
      // Live endpoint returns empty markets array
      mockFetch.mockResolvedValueOnce(createJsonResponse({ markets: [] }));

      const result = await service.ingestPrices('KXBTC', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(0);
    });

    it('should retry live endpoint 5xx same as historical', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );
      // 2 failures then success on live endpoint
      mockFetch
        .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(
          createJsonResponse({
            markets: [
              {
                market_ticker: 'KXBTC',
                candlesticks: [
                  {
                    end_period_ts: 1735689600,
                    price: {
                      open_dollars: '0.56',
                      high_dollars: '0.58',
                      low_dollars: '0.54',
                      close_dollars: '0.57',
                    },
                    volume_fp: '10',
                  },
                ],
              },
            ],
          }),
        );

      const result = await service.ingestPrices('KXBTC', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(1);
      // cutoff + 3 attempts on live
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('[AC2] should maintain Decimal precision for _dollars strings', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          markets: [
            {
              market_ticker: 'KXBTC',
              candlesticks: [
                {
                  end_period_ts: 1735689600,
                  price: {
                    open_dollars: '0.123456789',
                    high_dollars: '0.987654321',
                    low_dollars: '0.111111111',
                    close_dollars: '0.999999999',
                  },
                  volume_fp: '12345.6789',
                  open_interest_fp: '98765.4321',
                },
              ],
            },
          ],
        }),
      );

      await service.ingestPrices('KXBTC', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      const insertedData =
        mockPrisma.historicalPrice.createMany.mock.calls[0]?.[0]?.data;
      expect(insertedData?.[0]?.open.toString()).toBe('0.123456789');
      expect(insertedData?.[0]?.high.toString()).toBe('0.987654321');
      expect(insertedData?.[0]?.volume.toString()).toBe('12345.6789');
      expect(insertedData?.[0]?.openInterest.toString()).toBe('98765.4321');
    });

    it('[AC6] should handle live batch endpoint returning markets: [] for trades', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createKalshiService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          market_settled_ts: '2024-01-01T00:00:00Z',
          trades_created_ts: '2024-01-01T00:00:00Z',
          orders_updated_ts: '2024-01-01T00:00:00Z',
        }),
      );
      // Live trades empty
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({ trades: [], cursor: '' }),
      );

      const result = await service.ingestTrades('KXBTC', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      expect(result.recordCount).toBe(0);
    });
  });

  describe('parseLiveCandlestick', () => {
    it('[AC2] should map _dollars fields to standard Decimal columns', async () => {
      const { service } = createKalshiService();
      const parsed = (service as any).parseLiveCandlestick(
        {
          end_period_ts: 1704067260,
          price: {
            open_dollars: '0.5600',
            high_dollars: '0.5800',
            low_dollars: '0.5400',
            close_dollars: '0.5700',
          },
          volume_fp: '10.00',
          open_interest_fp: '25.00',
        },
        'KXBTC-24DEC31',
      );

      expect(parsed).toEqual(
        expect.objectContaining({
          platform: 'KALSHI',
          contractId: 'KXBTC-24DEC31',
          source: 'KALSHI_API',
          intervalMinutes: 1,
          timestamp: new Date(1704067260 * 1000),
          open: new Decimal('0.5600'),
          high: new Decimal('0.5800'),
          low: new Decimal('0.5400'),
          close: new Decimal('0.5700'),
          volume: new Decimal('10.00'),
          openInterest: new Decimal('25.00'),
        }),
      );
    });

    it('[AC2] should map null/undefined volume_fp and open_interest_fp to null', async () => {
      const { service } = createKalshiService();
      const parsed = (service as any).parseLiveCandlestick(
        {
          end_period_ts: 1704067260,
          price: {
            open_dollars: '0.50',
            high_dollars: '0.52',
            low_dollars: '0.48',
            close_dollars: '0.51',
          },
        },
        'KXBTC-24DEC31',
      );

      expect(parsed.volume).toBeNull();
      expect(parsed.openInterest).toBeNull();
    });

    it('[AC2] should produce same Decimal precision as historical parser', async () => {
      const { service } = createKalshiService();
      const parsed = (service as any).parseLiveCandlestick(
        {
          end_period_ts: 1704067260,
          price: {
            open_dollars: '0.123456789',
            high_dollars: '0.123456789',
            low_dollars: '0.123456789',
            close_dollars: '0.123456789',
          },
          volume_fp: '999.99',
          open_interest_fp: '1234.56',
        },
        'KXBTC-24DEC31',
      );

      // Decimal should preserve full precision
      expect(parsed.open.toString()).toBe('0.123456789');
      expect(parsed.volume.toString()).toBe('999.99');
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
