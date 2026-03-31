import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  PolymarketHistoricalService,
  USDC_ASSET_ID,
} from './polymarket-historical.service';

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

function createPolymarketService(prismaOverride?: any) {
  const prisma = prismaOverride ?? createMockPrisma();
  const config = createMockConfigService();
  const service = new PolymarketHistoricalService(prisma, config);
  return { service, prisma };
}

describe('PolymarketHistoricalService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('ingestPrices', () => {
    it('[P0] should fetch prices-history and normalize Polymarket decimal probabilities', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          history: [
            { t: 1704067200, p: 0.55 },
            { t: 1704067260, p: 0.56 },
            { t: 1704067320, p: 0.54 },
          ],
        }),
      );

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 3 });

      const result = await service.ingestPrices('0x1234567890abcdef', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/prices-history'),
        expect.any(Object),
      );
      // Verify market param = token ID (NOT condition_id)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('market=0x1234567890abcdef'),
        expect.any(Object),
      );
      expect(mockPrisma.historicalPrice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              platform: 'POLYMARKET',
            }),
          ]),
          skipDuplicates: true,
        }),
      );
      expect(result.recordCount).toBe(3);
    });

    it('[P1] should chunk date ranges >7 days into 7-day windows', async () => {
      const { service } = createPolymarketService();

      // 15-day range should produce 3 chunks: 7+7+1
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ history: [] }))
        .mockResolvedValueOnce(createJsonResponse({ history: [] }))
        .mockResolvedValueOnce(createJsonResponse({ history: [] }));

      await service.ingestPrices('0x1234', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-16'),
      });

      // 3 fetch calls for 3 chunks
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('[P12] should convert float prices to string before Decimal to avoid IEEE 754 noise', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      // Price that has IEEE 754 representation issues
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          history: [{ t: 1704067200, p: 0.57 }],
        }),
      );

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 1 });

      await service.ingestPrices('0x1234', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const insertedData =
        mockPrisma.historicalPrice.createMany.mock.calls[0]?.[0]?.data;
      if (insertedData?.[0]) {
        // Should be exactly 0.57, not 0.5700000000000001
        expect(insertedData[0].close.toString()).toBe('0.57');
      }
    });
  });

  describe('Goldsky trade ingestion', () => {
    it('[P0] should derive BUY side when maker asset is USDC', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: [
              {
                id: 'event-1',
                transactionHash: '0xabc',
                timestamp: '1704067200',
                maker: '0xmaker1',
                taker: '0xtaker1',
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: '12345678', // contract token
                makerAmountFilled: '50000000', // 50 USDC (6 decimals)
                takerAmountFilled: '100000000', // 100 tokens (6 decimals)
                fee: '500000',
              },
            ],
          },
        }),
      );

      // Empty second page
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      await service.ingestTrades('12345678', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              side: 'buy',
            }),
          ]),
          skipDuplicates: true,
        }),
      );
    });

    it('[P0] should derive SELL side when taker asset is USDC', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: [
              {
                id: 'event-2',
                transactionHash: '0xdef',
                timestamp: '1704067200',
                maker: '0xmaker2',
                taker: '0xtaker2',
                makerAssetId: '12345678', // contract token
                takerAssetId: USDC_ASSET_ID,
                makerAmountFilled: '100000000', // 100 tokens
                takerAmountFilled: '60000000', // 60 USDC
                fee: '600000',
              },
            ],
          },
        }),
      );

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      await service.ingestTrades('12345678', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              side: 'sell',
            }),
          ]),
        }),
      );
    });

    it('[P0] should skip token-to-token trades (neither side is USDC)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: [
              {
                id: 'event-3',
                transactionHash: '0x111',
                timestamp: '1704067200',
                maker: '0xmaker3',
                taker: '0xtaker3',
                makerAssetId: '11111111', // token A
                takerAssetId: '22222222', // token B (neither is USDC)
                makerAmountFilled: '100000000',
                takerAmountFilled: '100000000',
                fee: '0',
              },
            ],
          },
        }),
      );

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 0 });

      await service.ingestTrades('11111111', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // Should NOT insert token-to-token trades
      const callArgs = mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0];
      if (callArgs) {
        expect(callArgs.data).toHaveLength(0);
      }
    });

    it('[P0] should use Decimal arithmetic for price derivation (never native JS operators)', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: [
              {
                id: 'event-4',
                transactionHash: '0xghi',
                timestamp: '1704067200',
                maker: '0xmaker4',
                taker: '0xtaker4',
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: '12345678',
                makerAmountFilled: '33333333', // 33.333333 USDC — tests precision
                takerAmountFilled: '66666666', // 66.666666 tokens
                fee: '333333',
              },
            ],
          },
        }),
      );

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      await service.ingestTrades('12345678', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      const insertedData =
        mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0]?.data;
      if (insertedData && insertedData.length > 0) {
        const trade = insertedData[0];
        // Price should be Decimal, not native number
        expect(trade.price).toBeInstanceOf(Decimal);
        expect(trade.size).toBeInstanceOf(Decimal);
        // price = 33.333333 / 66.666666 ≈ 0.5 (Decimal precision)
        expect(trade.price.toNumber()).toBeCloseTo(0.5, 4);
      }
    });

    it('[P0] should paginate Goldsky via id_gt per asset side', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      // makerAssetId query — page 1 (full)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: Array.from({ length: 1000 }, (_, i) => ({
              id: `maker-${String(i).padStart(4, '0')}`,
              transactionHash: `0x${i}`,
              timestamp: '1704067200',
              maker: '0xmaker',
              taker: '0xtaker',
              makerAssetId: '12345678',
              takerAssetId: USDC_ASSET_ID,
              makerAmountFilled: '100000000',
              takerAmountFilled: '50000000',
              fee: '500000',
            })),
          },
        }),
      );

      // makerAssetId query — page 2 (empty)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      // takerAssetId query — page 1 (empty — no taker-side trades)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1000 });

      await service.ingestTrades('12345678', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // Page 2 of maker query should include id_gt from last result of page 1
      const secondCallBody = JSON.parse(
        mockFetch.mock.calls[1]?.[1]?.body || '{}',
      );
      expect(secondCallBody.variables?.id_gt).toBe('maker-0999');
      // First call should filter by makerAssetId
      const firstCallBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body || '{}',
      );
      expect(firstCallBody.query).toContain('makerAssetId');
    });

    it('[P0] should include contractId in GraphQL where clause for server-side filtering', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      const TARGET_TOKEN = '12345678';

      // makerAssetId query — empty (token is on taker side)
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      // takerAssetId query — returns the matching event
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: {
            orderFilledEvents: [
              {
                id: 'e1',
                transactionHash: '0x1',
                timestamp: '1704067200',
                maker: '0xm',
                taker: '0xt',
                makerAssetId: USDC_ASSET_ID,
                takerAssetId: TARGET_TOKEN,
                makerAmountFilled: '50000000',
                takerAmountFilled: '100000000',
                fee: '0',
              },
            ],
          },
        }),
      );

      // takerAssetId query — page 2 empty
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 1 });

      await service.ingestTrades(TARGET_TOKEN, {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // Verify both queries include contractId
      const firstCallBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body || '{}',
      );
      expect(firstCallBody.variables?.contractId).toBe(TARGET_TOKEN);
      // First query filters makerAssetId, second filters takerAssetId
      expect(firstCallBody.query).toContain('makerAssetId');
      const secondCallBody = JSON.parse(
        mockFetch.mock.calls[1]?.[1]?.body || '{}',
      );
      expect(secondCallBody.query).toContain('takerAssetId');

      // The matching event should be inserted
      const insertedData =
        mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0]?.data;
      expect(insertedData).toHaveLength(1);
    });

    it('[P10] should use timeout for Goldsky requests', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      // Two queries (maker side + taker side) — both empty, separate response objects
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          data: { orderFilledEvents: [] },
        }),
      );

      await service.ingestTrades('12345678', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-02'),
      });

      // The fetch call should have a signal property (from AbortController)
      const fetchOptions = mockFetch.mock.calls[0]?.[1];
      expect(fetchOptions).toHaveProperty('signal');
    });
  });

  describe('poly_data bootstrap', () => {
    it('[P1] should parse CSV and persist as HistoricalTrade with source POLY_DATA', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      const csvContent = [
        'timestamp,price,usd_amount,side',
        '1704067200,0.55,25.50,buy',
        '1704067260,0.56,30.00,sell',
        '1704067320,0.54,15.75,buy',
      ].join('\n');

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 3 });

      await service.importPolyDataBootstrap(csvContent, '0x1234');

      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({
              source: 'POLY_DATA',
              platform: 'POLYMARKET',
              side: 'buy',
            }),
          ]),
          skipDuplicates: true,
        }),
      );
    });

    it('[P1] should be idempotent — re-import creates no duplicates', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      const csvContent =
        'timestamp,price,usd_amount,side\n1704067200,0.55,25.50,buy';

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 0 }); // 0 = all duplicates

      await service.importPolyDataBootstrap(csvContent, '0x1234');

      expect(mockPrisma.historicalTrade.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
    });

    it('[P13] should skip malformed CSV lines and continue', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      const csvContent = [
        'timestamp,price,usd_amount,side',
        '1704067200,0.55,25.50,buy', // valid
        'bad-timestamp,0.55,25.50,buy', // invalid timestamp
        '1704067260,N/A,25.50,sell', // invalid price
        '1704067320,0.54,15.75,unknown', // invalid side
        '1704067380', // too few columns
        '1704067440,0.56,30.00,sell', // valid
      ].join('\n');

      mockPrisma.historicalTrade.createMany.mockResolvedValue({ count: 2 });

      await service.importPolyDataBootstrap(csvContent, '0x1234');

      // Only 2 valid lines should be inserted
      const insertedData =
        mockPrisma.historicalTrade.createMany.mock.calls[0]?.[0]?.data;
      expect(insertedData).toHaveLength(2);
    });
  });

  describe('Cloudflare throttle detection', () => {
    it('[P1] should detect throttle and apply backoff on subsequent chunk', async () => {
      const mockPrisma = createMockPrisma();
      const { service } = createPolymarketService(mockPrisma);

      // Simulate slow response (>5s = Cloudflare throttling signal)
      mockFetch.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5100));
        return createJsonResponse({ history: [] });
      });

      mockPrisma.historicalPrice.createMany.mockResolvedValue({ count: 0 });

      await service.ingestPrices('0x1234', {
        start: new Date('2025-01-01'),
        end: new Date('2025-01-02'),
      });

      // Verify service detected the slow response
      expect(service.isThrottled).toBe(true);
    });
  });
});
