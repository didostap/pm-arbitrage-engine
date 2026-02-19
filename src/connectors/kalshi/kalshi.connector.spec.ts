import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KalshiConnector } from './kalshi.connector.js';
import { PlatformId } from '../../common/types/index.js';
import { PlatformApiError } from '../../common/errors/index.js';

const mockGetMarketOrderbook = vi.fn();
const mockCreateOrder = vi.fn();

// Mock withRetry to execute fn once without retries (avoids real delay in tests)
vi.mock('../../common/utils/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../common/utils/index.js')>();
  return {
    ...actual,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

// Mock kalshi-typescript SDK with proper classes
vi.mock('kalshi-typescript', () => {
  class MockConfiguration {}
  class MockMarketApi {
    getMarketOrderbook = mockGetMarketOrderbook;
    createOrder = mockCreateOrder;
  }
  class MockPortfolioApi {
    getPositions = vi.fn();
  }
  class MockOrdersApi {}
  class MockKalshiAuth {
    generateAuthHeaders() {
      return {};
    }
  }
  return {
    Configuration: MockConfiguration,
    MarketApi: MockMarketApi,
    PortfolioApi: MockPortfolioApi,
    OrdersApi: MockOrdersApi,
    KalshiAuth: MockKalshiAuth,
  };
});

// Mock ws
vi.mock('ws', () => ({ default: vi.fn() }));

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('mock-pem-content'),
}));

describe('KalshiConnector', () => {
  let connector: KalshiConnector;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KalshiConnector,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                KALSHI_API_KEY_ID: 'test-key-id',
                KALSHI_PRIVATE_KEY_PATH: '/path/to/test.pem',
                KALSHI_API_BASE_URL: 'https://demo-api.kalshi.co',
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    connector = module.get<KalshiConnector>(KalshiConnector);
  });

  describe('getPlatformId', () => {
    it('should return KALSHI', () => {
      expect(connector.getPlatformId()).toBe(PlatformId.KALSHI);
    });
  });

  describe('getHealth', () => {
    it('should return disconnected when not connected', () => {
      const health = connector.getHealth();
      expect(health.status).toBe('disconnected');
      expect(health.platformId).toBe(PlatformId.KALSHI);
    });
  });

  describe('getFeeSchedule', () => {
    it('should return Kalshi fee schedule', () => {
      const fees = connector.getFeeSchedule();
      expect(fees.platformId).toBe(PlatformId.KALSHI);
      expect(fees.makerFeePercent).toBe(0);
      expect(fees.takerFeePercent).toBe(0);
    });
  });

  describe('getOrderBook', () => {
    it('should transform YES/NO bids to normalized format', async () => {
      mockGetMarketOrderbook.mockResolvedValue({
        data: {
          orderbook: {
            true: [[62, 1000]], // 62¢ YES bid
            false: [[38, 800]], // 38¢ NO bid → 62¢ YES ask (1 - 0.38)
          },
        },
      });

      const orderbook = await connector.getOrderBook('CPI-22DEC-TN0.1');

      expect(orderbook.platformId).toBe(PlatformId.KALSHI);
      expect(orderbook.contractId).toBe('CPI-22DEC-TN0.1');
      // YES bid 62¢ → 0.62
      expect(orderbook.bids).toEqual([{ price: 0.62, quantity: 1000 }]);
      // NO bid 38¢ → YES ask (1 - 0.38) = 0.62
      expect(orderbook.asks).toEqual([{ price: 0.62, quantity: 800 }]);
    });

    it('should throw PlatformApiError on SDK error', async () => {
      mockGetMarketOrderbook.mockRejectedValue(
        new Error('API error: UNAUTHORIZED'),
      );

      await expect(connector.getOrderBook('CPI-22DEC-TN0.1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should handle empty orderbook', async () => {
      mockGetMarketOrderbook.mockResolvedValue({
        data: {
          orderbook: {
            true: undefined,
            false: undefined,
          },
        },
      });

      const orderbook = await connector.getOrderBook('EMPTY');
      expect(orderbook.bids).toEqual([]);
      expect(orderbook.asks).toEqual([]);
    });
  });

  describe('submitOrder', () => {
    it('should convert decimal price to cents and return mapped result', async () => {
      mockCreateOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-1',
            status: 'executed',
            remaining_count: 0,
            taker_fill_count: 10,
            taker_fill_cost: 450, // 10 contracts * 45 cents
            created_time: '2026-01-01T00:00:00Z',
          },
        },
      });

      const result = await connector.submitOrder({
        contractId: 'CPI-22DEC-TN0.1',
        side: 'buy',
        quantity: 10,
        price: 0.45,
        type: 'limit',
      });

      expect(result.orderId).toBe('kalshi-order-1');
      expect(result.status).toBe('filled');
      expect(result.filledQuantity).toBe(10);
      expect(result.filledPrice).toBe(0.45);
      expect(result.platformId).toBe(PlatformId.KALSHI);

      // Verify cents conversion: 0.45 → 45 cents
      expect(mockCreateOrder).toHaveBeenCalledWith(
        expect.objectContaining({ yes_price: 45 }),
      );
    });

    it('should map canceled status to rejected', async () => {
      mockCreateOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-2',
            status: 'canceled',
            remaining_count: 10,
            taker_fill_count: 0,
            taker_fill_cost: 0,
            created_time: '2026-01-01T00:00:00Z',
          },
        },
      });

      const result = await connector.submitOrder({
        contractId: 'CPI-22DEC-TN0.1',
        side: 'buy',
        quantity: 10,
        price: 0.45,
        type: 'limit',
      });

      expect(result.status).toBe('rejected');
    });

    it('should throw PlatformApiError on SDK error', async () => {
      mockCreateOrder.mockRejectedValue(new Error('API error'));

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
  });

  describe('placeholder methods', () => {
    it('cancelOrder should throw not-implemented error', () => {
      expect(() => connector.cancelOrder('order-1')).toThrow(
        'cancelOrder not implemented',
      );
    });

    it('getPositions should throw not-implemented error', () => {
      expect(() => connector.getPositions()).toThrow(
        'getPositions not implemented',
      );
    });
  });

  describe('onOrderBookUpdate', () => {
    it('should accept callback without error', () => {
      expect(() => connector.onOrderBookUpdate(vi.fn())).not.toThrow();
    });
  });
});
