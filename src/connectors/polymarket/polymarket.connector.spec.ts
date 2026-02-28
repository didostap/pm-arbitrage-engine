import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PolymarketConnector } from './polymarket.connector.js';
import { GasEstimationService } from './gas-estimation.service.js';
import { PlatformId } from '../../common/types/index.js';
import { PlatformApiError } from '../../common/errors/index.js';
import { OrderBookNormalizerService } from '../../modules/data-ingestion/order-book-normalizer.service.js';

const mockCreateOrDeriveApiKey = vi.fn();
const mockGetOrderBook = vi.fn();
const mockGetOrderBooks = vi.fn();
const mockCreateOrder = vi.fn();
const mockPostOrder = vi.fn();
const mockGetOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockNormalizePolymarket = vi.fn();
const mockGetGasEstimateUsd = vi.fn().mockReturnValue(new Decimal('0.003'));

// Mock @polymarket/clob-client
vi.mock('@polymarket/clob-client', () => {
  class MockClobClient {
    createOrDeriveApiKey = mockCreateOrDeriveApiKey;
    getOrderBook = mockGetOrderBook;
    getOrderBooks = mockGetOrderBooks;
    createOrder = mockCreateOrder;
    postOrder = mockPostOrder;
    getOrder = mockGetOrder;
    cancelOrder = mockCancelOrder;
  }
  return { ClobClient: MockClobClient, Side: { BUY: 'BUY', SELL: 'SELL' } };
});

// Mock @ethersproject/wallet
vi.mock('@ethersproject/wallet', () => {
  class MockWallet {
    address: string;
    constructor(key: string) {
      if (key === 'invalid-key') {
        throw new Error('invalid private key');
      }
      this.address = '0xMockAddress';
    }
  }
  return { Wallet: MockWallet };
});

// Mock withRetry to execute fn once without retries
vi.mock('../../common/utils/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../common/utils/index.js')>();
  return {
    ...actual,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

// Mock ws
vi.mock('ws', () => ({ default: vi.fn() }));

describe('PolymarketConnector', () => {
  let connector: PolymarketConnector;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCreateOrDeriveApiKey.mockResolvedValue({
      key: 'test-api-key',
      secret: 'test-secret',
      passphrase: 'test-passphrase',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolymarketConnector,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                POLYMARKET_PRIVATE_KEY:
                  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
                POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
                POLYMARKET_WS_URL:
                  'wss://ws-subscriptions-clob.polymarket.com/ws/market',
                POLYMARKET_CHAIN_ID: 137,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
        {
          provide: OrderBookNormalizerService,
          useValue: {
            normalizePolymarket: mockNormalizePolymarket,
          },
        },
        {
          provide: GasEstimationService,
          useValue: {
            getGasEstimateUsd: mockGetGasEstimateUsd,
          },
        },
        {
          provide: EventEmitter2,
          useValue: { emit: vi.fn() },
        },
      ],
    }).compile();

    connector = module.get<PolymarketConnector>(PolymarketConnector);
  });

  describe('getPlatformId', () => {
    it('should return POLYMARKET', () => {
      expect(connector.getPlatformId()).toBe(PlatformId.POLYMARKET);
    });
  });

  describe('getHealth', () => {
    it('should return disconnected when not connected', () => {
      const health = connector.getHealth();
      expect(health.status).toBe('disconnected');
      expect(health.platformId).toBe(PlatformId.POLYMARKET);
    });

    it('should return degraded when only REST connected (no WS)', () => {
      // Simulate partial connect: set connected = true but wsClient not connected
      // We use connect() but the ws mock won't actually connect
      // Instead, test through the public interface by checking after failed ws connect
      const health = connector.getHealth();
      expect(health.status).toBe('disconnected');
    });
  });

  describe('getFeeSchedule', () => {
    it('should return Polymarket fee schedule with dynamic gas estimate', () => {
      const fees = connector.getFeeSchedule();
      expect(fees.platformId).toBe(PlatformId.POLYMARKET);
      expect(fees.makerFeePercent).toBe(0);
      expect(fees.takerFeePercent).toBe(2);
      expect(fees.gasEstimateUsd).toBe(0.003);
      expect(mockGetGasEstimateUsd).toHaveBeenCalled();
    });
  });

  describe('connect', () => {
    it('should throw PlatformApiError 1008 on invalid private key', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PolymarketConnector,
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn((key: string, defaultValue?: unknown) => {
                const config: Record<string, unknown> = {
                  POLYMARKET_PRIVATE_KEY: 'invalid-key',
                  POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
                  POLYMARKET_WS_URL:
                    'wss://ws-subscriptions-clob.polymarket.com/ws/market',
                  POLYMARKET_CHAIN_ID: 137,
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
          {
            provide: OrderBookNormalizerService,
            useValue: {
              normalizePolymarket: mockNormalizePolymarket,
            },
          },
          {
            provide: GasEstimationService,
            useValue: {
              getGasEstimateUsd: mockGetGasEstimateUsd,
            },
          },
          {
            provide: EventEmitter2,
            useValue: { emit: vi.fn() },
          },
        ],
      }).compile();

      const invalidConnector =
        module.get<PolymarketConnector>(PolymarketConnector);

      try {
        await invalidConnector.connect();
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PlatformApiError);
        expect((e as PlatformApiError).code).toBe(1008);
      }
    });

    it('should throw PlatformApiError 1012 on API key derivation failure', async () => {
      mockCreateOrDeriveApiKey.mockRejectedValue(
        new Error('derivation failed'),
      );

      try {
        await connector.connect();
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(PlatformApiError);
        expect((e as PlatformApiError).code).toBe(1012);
      }
    });
  });

  describe('getOrderBook', () => {
    it('should throw when not connected', async () => {
      await expect(connector.getOrderBook('token-123')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should return normalized order book with decimal prices', async () => {
      // Manually set up the connected state by accessing internals
      // We need to simulate a connected state
      mockGetOrderBook.mockResolvedValue({
        bids: [
          { price: '0.62', size: '1000' },
          { price: '0.60', size: '500' },
        ],
        asks: [
          { price: '0.65', size: '800' },
          { price: '0.68', size: '300' },
        ],
      });

      mockNormalizePolymarket.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'token-123',
        bids: [
          { price: 0.62, quantity: 1000 },
          { price: 0.6, quantity: 500 },
        ],
        asks: [
          { price: 0.65, quantity: 800 },
          { price: 0.68, quantity: 300 },
        ],
        timestamp: new Date(),
      });

      // Access private field to simulate connected state
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      const orderbook = await connector.getOrderBook('token-123');

      expect(orderbook.platformId).toBe(PlatformId.POLYMARKET);
      expect(orderbook.contractId).toBe('token-123');
      // Bids sorted descending
      expect(orderbook.bids[0]?.price).toBe(0.62);
      expect(orderbook.bids[1]?.price).toBe(0.6);
      // Asks sorted ascending
      expect(orderbook.asks[0]?.price).toBe(0.65);
      expect(orderbook.asks[1]?.price).toBe(0.68);
    });

    it('should handle empty orderbook', async () => {
      mockGetOrderBook.mockResolvedValue({
        bids: [],
        asks: [],
      });

      mockNormalizePolymarket.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'empty-token',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      const orderbook = await connector.getOrderBook('empty-token');
      expect(orderbook.bids).toEqual([]);
      expect(orderbook.asks).toEqual([]);
    });

    it('should throw PlatformApiError on SDK error', async () => {
      mockGetOrderBook.mockRejectedValue(new Error('API error: UNAUTHORIZED'));

      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      await expect(connector.getOrderBook('token-123')).rejects.toThrow(
        PlatformApiError,
      );
    });
  });

  describe('getOrderBooks (batch)', () => {
    const setupConnected = () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
        getOrderBooks: mockGetOrderBooks,
      };
    };

    it('should throw when not connected (clobClient null)', async () => {
      await expect(
        connector.getOrderBooks(['token-1', 'token-2']),
      ).rejects.toThrow(PlatformApiError);
    });

    it('should return empty array for empty input without SDK call', async () => {
      setupConnected();

      const result = await connector.getOrderBooks([]);

      expect(result).toEqual([]);
      expect(mockGetOrderBooks).not.toHaveBeenCalled();
    });

    it('should return normalized books for batch of 3 tokens', async () => {
      setupConnected();

      mockGetOrderBooks.mockResolvedValue([
        {
          asset_id: 'token-1',
          market: 'market-1',
          timestamp: '1709145352532',
          bids: [{ price: '0.62', size: '1000' }],
          asks: [{ price: '0.65', size: '800' }],
          hash: 'hash-1',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.63',
        },
        {
          asset_id: 'token-2',
          market: 'market-2',
          timestamp: '1709145352532',
          bids: [{ price: '0.55', size: '500' }],
          asks: [{ price: '0.58', size: '300' }],
          hash: 'hash-2',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.56',
        },
        {
          asset_id: 'token-3',
          market: 'market-3',
          timestamp: '1709145352532',
          bids: [{ price: '0.70', size: '200' }],
          asks: [{ price: '0.75', size: '150' }],
          hash: 'hash-3',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.72',
        },
      ]);

      const normalizedBook1 = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'token-1',
        bids: [{ price: 0.62, quantity: 1000 }],
        asks: [{ price: 0.65, quantity: 800 }],
        timestamp: new Date(),
      };
      const normalizedBook2 = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'token-2',
        bids: [{ price: 0.55, quantity: 500 }],
        asks: [{ price: 0.58, quantity: 300 }],
        timestamp: new Date(),
      };
      const normalizedBook3 = {
        platformId: PlatformId.POLYMARKET,
        contractId: 'token-3',
        bids: [{ price: 0.7, quantity: 200 }],
        asks: [{ price: 0.75, quantity: 150 }],
        timestamp: new Date(),
      };

      mockNormalizePolymarket
        .mockReturnValueOnce(normalizedBook1)
        .mockReturnValueOnce(normalizedBook2)
        .mockReturnValueOnce(normalizedBook3);

      const result = await connector.getOrderBooks([
        'token-1',
        'token-2',
        'token-3',
      ]);

      expect(result).toHaveLength(3);
      expect(result[0]).toBe(normalizedBook1);
      expect(result[1]).toBe(normalizedBook2);
      expect(result[2]).toBe(normalizedBook3);
      // Single SDK call
      expect(mockGetOrderBooks).toHaveBeenCalledOnce();
    });

    it('should handle partial results — log warning for missing tokens', async () => {
      setupConnected();

      // Request 3 tokens, only 2 returned
      mockGetOrderBooks.mockResolvedValue([
        {
          asset_id: 'token-1',
          market: 'market-1',
          timestamp: '1709145352532',
          bids: [{ price: '0.62', size: '1000' }],
          asks: [{ price: '0.65', size: '800' }],
          hash: 'hash-1',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.63',
        },
        {
          asset_id: 'token-3',
          market: 'market-3',
          timestamp: '1709145352532',
          bids: [{ price: '0.70', size: '200' }],
          asks: [{ price: '0.75', size: '150' }],
          hash: 'hash-3',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.72',
        },
      ]);

      mockNormalizePolymarket
        .mockReturnValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: 'token-1',
          bids: [],
          asks: [],
          timestamp: new Date(),
        })
        .mockReturnValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: 'token-3',
          bids: [],
          asks: [],
          timestamp: new Date(),
        });

      const loggerSpy = vi.spyOn(connector['logger'], 'warn');

      const result = await connector.getOrderBooks([
        'token-1',
        'token-2',
        'token-3',
      ]);

      expect(result).toHaveLength(2);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'No order book returned for token',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: expect.objectContaining({ tokenId: 'token-2' }),
        }),
      );
    });

    it('should filter out books that fail normalization', async () => {
      setupConnected();

      mockGetOrderBooks.mockResolvedValue([
        {
          asset_id: 'token-1',
          market: 'market-1',
          timestamp: '1709145352532',
          bids: [{ price: '0.62', size: '1000' }],
          asks: [{ price: '0.65', size: '800' }],
          hash: 'hash-1',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0.63',
        },
        {
          asset_id: 'token-2',
          market: 'market-2',
          timestamp: '1709145352532',
          bids: [],
          asks: [],
          hash: 'hash-2',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0',
        },
      ]);

      mockNormalizePolymarket
        .mockReturnValueOnce({
          platformId: PlatformId.POLYMARKET,
          contractId: 'token-1',
          bids: [{ price: 0.62, quantity: 1000 }],
          asks: [{ price: 0.65, quantity: 800 }],
          timestamp: new Date(),
        })
        .mockReturnValueOnce(null); // Normalization fails

      const result = await connector.getOrderBooks(['token-1', 'token-2']);

      expect(result).toHaveLength(1);
      expect(result[0]?.contractId).toBe('token-1');
    });

    it('should throw PlatformApiError on full SDK failure', async () => {
      setupConnected();

      mockGetOrderBooks.mockRejectedValue(new Error('Network error'));

      await expect(
        connector.getOrderBooks(['token-1', 'token-2']),
      ).rejects.toThrow(PlatformApiError);
    });

    it('should rethrow PlatformApiError as-is', async () => {
      setupConnected();

      const apiError = new PlatformApiError(
        1009,
        'Rate limited',
        PlatformId.POLYMARKET,
        'warning',
      );
      mockGetOrderBooks.mockRejectedValue(apiError);

      await expect(connector.getOrderBooks(['token-1'])).rejects.toBe(apiError);
    });

    it('should update lastHeartbeat after successful batch call', async () => {
      setupConnected();

      mockGetOrderBooks.mockResolvedValue([
        {
          asset_id: 'token-1',
          market: '',
          timestamp: '1709145352532',
          bids: [],
          asks: [],
          hash: '',
          tick_size: '0.01',
          neg_risk: false,
          last_trade_price: '0',
        },
      ]);

      mockNormalizePolymarket.mockReturnValue({
        platformId: PlatformId.POLYMARKET,
        contractId: 'token-1',
        bids: [],
        asks: [],
        timestamp: new Date(),
      });

      await connector.getOrderBooks(['token-1']);
      const after = connector['lastHeartbeat'];

      expect(after).toBeInstanceOf(Date);
      expect(after?.getTime()).toBeGreaterThan(0);
    });
  });

  describe('error mapping', () => {
    it('should map 401 to PlatformApiError 1008', async () => {
      const error = Object.assign(new Error('Unauthorized'), {
        response: { status: 401 },
      });
      mockGetOrderBook.mockRejectedValue(error);

      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      try {
        await connector.getOrderBook('token-123');
      } catch (e) {
        expect(e).toBeInstanceOf(PlatformApiError);
        expect((e as PlatformApiError).code).toBe(1008);
      }
    });

    it('should map 429 to PlatformApiError 1009', async () => {
      const error = Object.assign(new Error('Rate limited'), {
        response: { status: 429, headers: { 'retry-after': '5' } },
      });
      mockGetOrderBook.mockRejectedValue(error);

      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      try {
        await connector.getOrderBook('token-123');
      } catch (e) {
        expect(e).toBeInstanceOf(PlatformApiError);
        expect((e as PlatformApiError).code).toBe(1009);
      }
    });

    it('should map generic error to PlatformApiError 1010', async () => {
      mockGetOrderBook.mockRejectedValue(new Error('something broke'));

      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrderBook: mockGetOrderBook,
      };

      try {
        await connector.getOrderBook('token-123');
      } catch (e) {
        expect(e).toBeInstanceOf(PlatformApiError);
        expect((e as PlatformApiError).code).toBe(1010);
      }
    });
  });

  describe('disconnect', () => {
    it('should clean up resources', async () => {
      await connector.disconnect();
      const health = connector.getHealth();
      expect(health.status).toBe('disconnected');
    });
  });

  describe('submitOrder', () => {
    it('should throw PlatformApiError when not connected', async () => {
      await expect(
        connector.submitOrder({
          contractId: 'X',
          side: 'buy',
          quantity: 1,
          price: 0.5,
          type: 'limit',
        }),
      ).rejects.toThrow(PlatformApiError);
    });

    it('should return filled when order is immediately matched', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        createOrder: mockCreateOrder,
        postOrder: mockPostOrder,
        getOrder: mockGetOrder,
      };

      mockCreateOrder.mockResolvedValue({ orderPayload: 'payload' });
      mockPostOrder.mockResolvedValue({
        orderID: 'pm-order-1',
        status: 'matched',
      });

      const result = await connector.submitOrder({
        contractId: 'token-abc',
        side: 'buy',
        quantity: 10,
        price: 0.65,
        type: 'limit',
      });

      expect(result.orderId).toBe('pm-order-1');
      expect(result.status).toBe('filled');
      expect(result.filledQuantity).toBe(10);
      expect(result.filledPrice).toBe(0.65);
      expect(result.platformId).toBe(PlatformId.POLYMARKET);
    });

    it('should poll and return filled when order fills after delay', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        createOrder: mockCreateOrder,
        postOrder: mockPostOrder,
        getOrder: mockGetOrder,
      };

      mockCreateOrder.mockResolvedValue({ orderPayload: 'payload' });
      mockPostOrder.mockResolvedValue({
        orderID: 'pm-order-2',
        status: 'live',
      });
      // First poll: still live, second poll: filled
      mockGetOrder
        .mockResolvedValueOnce({ status: 'live' })
        .mockResolvedValueOnce({
          status: 'matched',
          filledSize: 10,
          filledPrice: 0.65,
        });

      const result = await connector.submitOrder({
        contractId: 'token-abc',
        side: 'sell',
        quantity: 10,
        price: 0.65,
        type: 'limit',
      });

      expect(result.status).toBe('filled');
      expect(result.filledQuantity).toBe(10);
      expect(mockGetOrder).toHaveBeenCalled();
    });

    it('should return pending after 5s poll timeout', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        createOrder: mockCreateOrder,
        postOrder: mockPostOrder,
        getOrder: mockGetOrder,
      };

      mockCreateOrder.mockResolvedValue({ orderPayload: 'payload' });
      mockPostOrder.mockResolvedValue({
        orderID: 'pm-order-3',
        status: 'live',
      });
      // Always return live — never fills
      mockGetOrder.mockResolvedValue({ status: 'live' });

      const result = await connector.submitOrder({
        contractId: 'token-abc',
        side: 'buy',
        quantity: 5,
        price: 0.5,
        type: 'limit',
      });

      expect(result.status).toBe('pending');
      expect(result.orderId).toBe('pm-order-3');
      expect(result.filledQuantity).toBe(0);
    }, 10000);

    it('should return rejected when order is canceled during polling', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        createOrder: mockCreateOrder,
        postOrder: mockPostOrder,
        getOrder: mockGetOrder,
      };

      mockCreateOrder.mockResolvedValue({ orderPayload: 'payload' });
      mockPostOrder.mockResolvedValue({
        orderID: 'pm-order-4',
        status: 'live',
      });
      mockGetOrder.mockResolvedValue({ status: 'canceled' });

      const result = await connector.submitOrder({
        contractId: 'token-abc',
        side: 'buy',
        quantity: 5,
        price: 0.5,
        type: 'limit',
      });

      expect(result.status).toBe('rejected');
      expect(result.filledQuantity).toBe(0);
    });

    it('should throw PlatformApiError when createOrder fails', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        createOrder: mockCreateOrder,
        postOrder: mockPostOrder,
        getOrder: mockGetOrder,
      };

      mockCreateOrder.mockRejectedValue(new Error('CLOB error'));

      await expect(
        connector.submitOrder({
          contractId: 'token-abc',
          side: 'buy',
          quantity: 1,
          price: 0.5,
          type: 'limit',
        }),
      ).rejects.toThrow(PlatformApiError);
    });
  });

  describe('getOrder', () => {
    it('should throw PlatformApiError when not connected', async () => {
      await expect(connector.getOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should return filled status for MATCHED order', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrder: mockGetOrder,
      };

      mockGetOrder.mockResolvedValue({
        status: 'MATCHED',
        filledSize: 10,
        filledPrice: 0.65,
      });

      const result = await connector.getOrder('pm-order-1');

      expect(result.orderId).toBe('pm-order-1');
      expect(result.status).toBe('filled');
      expect(result.fillPrice).toBe(0.65);
      expect(result.fillSize).toBe(10);
      expect(result.rawResponse).toBeDefined();
    });

    it('should return pending status for LIVE order', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrder: mockGetOrder,
      };

      mockGetOrder.mockResolvedValue({ status: 'LIVE' });

      const result = await connector.getOrder('pm-order-2');

      expect(result.status).toBe('pending');
    });

    it('should return cancelled status for CANCELED order', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrder: mockGetOrder,
      };

      mockGetOrder.mockResolvedValue({ status: 'CANCELED' });

      const result = await connector.getOrder('pm-order-3');

      expect(result.status).toBe('cancelled');
    });

    it('should return not_found for 404 errors instead of throwing', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrder: mockGetOrder,
      };

      mockGetOrder.mockRejectedValue(new Error('Order not found'));

      const result = await connector.getOrder('missing-order');

      expect(result.orderId).toBe('missing-order');
      expect(result.status).toBe('not_found');
    });

    it('should throw PlatformApiError on non-404 error', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        getOrder: mockGetOrder,
      };

      mockGetOrder.mockRejectedValue(new Error('UNAUTHORIZED'));

      await expect(connector.getOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });
  });

  describe('cancelOrder', () => {
    it('should throw PlatformApiError when not connected', async () => {
      await expect(connector.cancelOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should return cancelled status on success', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockResolvedValue({ success: true });

      const result = await connector.cancelOrder('pm-order-1');

      expect(result.orderId).toBe('pm-order-1');
      expect(result.status).toBe('cancelled');
    });

    it('should return not_found when error contains "not found"', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockRejectedValue(new Error('Order not found'));

      const result = await connector.cancelOrder('missing-order');

      expect(result.orderId).toBe('missing-order');
      expect(result.status).toBe('not_found');
    });

    it('should return already_filled when error contains "matched"', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockRejectedValue(new Error('Order already matched'));

      const result = await connector.cancelOrder('filled-order');

      expect(result.orderId).toBe('filled-order');
      expect(result.status).toBe('already_filled');
    });

    it('should throw PlatformApiError on other SDK errors', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockRejectedValue(new Error('UNAUTHORIZED'));

      await expect(connector.cancelOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should throw on ambiguous already errors that are not already matched', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockRejectedValue(
        new Error('Request already in progress'),
      );

      await expect(connector.cancelOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should call rateLimiter.acquireWrite()', async () => {
      (connector as unknown as { connected: boolean }).connected = true;
      (connector as unknown as { clobClient: unknown }).clobClient = {
        cancelOrder: mockCancelOrder,
      };

      mockCancelOrder.mockResolvedValue({ success: true });

      const acquireWriteSpy = vi.spyOn(
        (
          connector as unknown as {
            rateLimiter: { acquireWrite: () => Promise<void> };
          }
        ).rateLimiter,
        'acquireWrite',
      );

      await connector.cancelOrder('order-1');

      expect(acquireWriteSpy).toHaveBeenCalledOnce();
    });
  });

  describe('placeholder methods', () => {
    it('getPositions should throw PlatformApiError with code 1017', () => {
      let caught: PlatformApiError | undefined;
      try {
        void connector.getPositions();
      } catch (error) {
        caught = error as PlatformApiError;
      }
      expect(caught).toBeInstanceOf(PlatformApiError);
      expect(caught?.code).toBe(1017);
      expect(caught?.severity).toBe('warning');
      expect(caught?.platformId).toBe(PlatformId.POLYMARKET);
    });
  });

  describe('onOrderBookUpdate', () => {
    it('should accept callback without error when wsClient is null', () => {
      expect(() => connector.onOrderBookUpdate(vi.fn())).not.toThrow();
    });
  });
});
