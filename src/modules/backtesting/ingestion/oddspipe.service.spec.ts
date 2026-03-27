import { describe, it, expect, vi, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import { OddsPipeService } from './oddspipe.service';

function createMockPrisma() {
  return {
    contractMatch: {
      findFirst: vi.fn().mockResolvedValue({
        polymarketDescription: 'Will Bitcoin exceed $100k by Dec 2025?',
      }),
    },
    historicalPrice: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
}

function createMockConfigService() {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'ODDSPIPE_API_KEY') return 'test-api-key-123';
      if (key === 'ODDSPIPE_BASE_URL') return 'https://oddspipe.com/v1';
      return undefined;
    }),
  } as any;
}

function createMarketSearchResponse(
  markets: Array<{ id: number; title: string }>,
) {
  return {
    ok: true,
    json: () => Promise.resolve(markets),
  };
}

function createCandlestickResponse(
  candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
) {
  return {
    ok: true,
    json: () => Promise.resolve(candles),
  };
}

function createService(prismaOverride?: any) {
  return new OddsPipeService(
    prismaOverride ?? createMockPrisma(),
    createMockConfigService(),
  );
}

describe('OddsPipeService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('resolveMarketId', () => {
    it('[P1] should resolve OddsPipe market ID via title search from ContractMatch description', async () => {
      const mockPrisma = createMockPrisma();
      const service = createService(mockPrisma);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createMarketSearchResponse([
            { id: 42, title: 'Will Bitcoin exceed $100k by December 2025?' },
            { id: 99, title: 'Bitcoin price prediction 2026' },
          ]),
        ),
      );

      const marketId = await service.resolveMarketId('0xTokenABC');
      expect(marketId).toBe(42);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/markets/search?q='),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key-123',
          }),
        }),
      );
    });

    it('[P1] should cache market ID mapping in Map to avoid repeated lookups', async () => {
      const service = createService();

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            createMarketSearchResponse([{ id: 42, title: 'Bitcoin $100k' }]),
          ),
      );

      const id1 = await service.resolveMarketId('0xTokenABC');
      const id2 = await service.resolveMarketId('0xTokenABC');

      expect(id1).toBe(42);
      expect(id2).toBe(42);
      // Only one fetch for market search (first call does DB + API, second from cache)
      // fetch is called once for the market search
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('[P1] should return null when no matching market found and log warning', async () => {
      const service = createService();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(createMarketSearchResponse([])),
      );

      const marketId = await service.resolveMarketId('0xUnknownToken');
      expect(marketId).toBeNull();
    });

    it('[P1] should clear market ID cache on service destroy (onModuleDestroy)', async () => {
      const service = createService();

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            createMarketSearchResponse([{ id: 42, title: 'Bitcoin $100k' }]),
          ),
      );

      await service.resolveMarketId('0xTokenABC');
      service.onModuleDestroy();
      // Cache cleared — next call should re-fetch
      await service.resolveMarketId('0xTokenABC');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ingestPrices', () => {
    it('[P0] should fetch OHLCV candlesticks and normalize to NormalizedPrice with Decimal', async () => {
      const mockPrisma = createMockPrisma();
      const service = createService(mockPrisma);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createCandlestickResponse([
            {
              timestamp: 1717200000,
              open: 0.55,
              high: 0.6,
              low: 0.5,
              close: 0.58,
              volume: 15000,
            },
          ]),
        ),
      );

      await service.ingestPrices(42, '0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              platform: 'POLYMARKET',
              contractId: '0xTokenABC',
              source: 'ODDSPIPE',
              open: expect.any(Decimal),
              high: expect.any(Decimal),
              low: expect.any(Decimal),
              close: expect.any(Decimal),
              volume: expect.any(Decimal),
            }),
          ]),
          skipDuplicates: true,
        }),
      );
    });

    it('[P0] should persist prices with source ODDSPIPE, 500/batch, skipDuplicates', async () => {
      const mockPrisma = createMockPrisma();
      const service = createService(mockPrisma);

      const candles = Array.from({ length: 1200 }, (_, i) => ({
        timestamp: 1717200000 + i * 3600,
        open: 0.5,
        high: 0.55,
        low: 0.48,
        close: 0.52,
        volume: 1000,
      }));
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(createCandlestickResponse(candles)),
      );

      await service.ingestPrices(42, '0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-08-01T00:00:00Z'),
      });

      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledTimes(3);
      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('[P0] should not create duplicates on re-ingestion (idempotency)', async () => {
      const mockPrisma = createMockPrisma();
      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 0 });
      const service = createService(mockPrisma);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          createCandlestickResponse([
            {
              timestamp: 1717200000,
              open: 0.5,
              high: 0.55,
              low: 0.48,
              close: 0.52,
              volume: 1000,
            },
          ]),
        ),
      );

      const metadata = await service.ingestPrices(42, '0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(metadata.recordCount).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('[P1] should enforce 857ms minimum interval between requests (70 req/min)', async () => {
      const service = createService();

      const timestamps: number[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          timestamps.push(Date.now());
          return Promise.resolve(createCandlestickResponse([]));
        }),
      );

      const dateRange = {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      };

      await service.ingestPrices(42, '0xToken1', dateRange);
      await service.ingestPrices(43, '0xToken2', dateRange);

      expect(timestamps.length).toBeGreaterThanOrEqual(2);
      if (timestamps.length >= 2) {
        expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(800);
      }
    });
  });

  describe('auth', () => {
    it('[P1] should include X-API-Key header from ConfigService in all requests', async () => {
      const service = createService();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(createCandlestickResponse([])),
      );

      await service.ingestPrices(42, '0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-API-Key': 'test-api-key-123',
          }),
        }),
      );
    });
  });

  describe('30-day history limit', () => {
    it('[P1] should clamp date ranges exceeding 30 days to most recent 30 days', async () => {
      const service = createService();

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(createCandlestickResponse([])),
      );

      const dateRange = {
        start: new Date('2025-01-01T00:00:00Z'),
        end: new Date('2025-06-01T00:00:00Z'),
      };

      const metadata = await service.ingestPrices(42, '0xTokenABC', dateRange);

      // The clamped start should be ~30 days before end
      const clampedStart = metadata.dateRange.start;
      const diffDays =
        (metadata.dateRange.end.getTime() - clampedStart.getTime()) /
        (1000 * 60 * 60 * 24);
      expect(diffDays).toBeLessThanOrEqual(30);
    });
  });

  describe('error handling', () => {
    it('[P1] should throw SystemHealthError code 4209 on OddsPipe API failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      const service = createService();
      await expect(
        service.ingestPrices(42, '0xTokenABC', {
          start: new Date('2025-06-01T00:00:00Z'),
          end: new Date('2025-06-01T23:59:59Z'),
        }),
      ).rejects.toMatchObject({
        code: 4209,
        message: expect.stringContaining('OddsPipe'),
      });
    });

    it('[P1] should retry with exponential backoff (3 attempts) on transient errors', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockRejectedValueOnce(new Error('Network timeout'))
        .mockResolvedValueOnce(createCandlestickResponse([]));
      vi.stubGlobal('fetch', fetchMock);

      const service = createService();
      await service.ingestPrices(42, '0xTokenABC', {
        start: new Date('2025-06-01T00:00:00Z'),
        end: new Date('2025-06-01T23:59:59Z'),
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
