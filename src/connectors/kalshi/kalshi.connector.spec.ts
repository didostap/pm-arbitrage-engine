import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KalshiConnector } from './kalshi.connector.js';
import { PlatformId } from '../../common/types/index.js';
import { PlatformApiError } from '../../common/errors/index.js';

const mockGetMarketOrderbook = vi.fn();

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
            true: [[62, 1000]],
            false: [[38, 800]],
          },
        },
      });

      const orderbook = await connector.getOrderBook('CPI-22DEC-TN0.1');

      expect(orderbook.platformId).toBe(PlatformId.KALSHI);
      expect(orderbook.contractId).toBe('CPI-22DEC-TN0.1');
      expect(orderbook.bids).toEqual([{ price: 62, quantity: 1000 }]);
      expect(orderbook.asks).toEqual([{ price: 62, quantity: 800 }]);
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

  describe('placeholder methods', () => {
    it('submitOrder should throw not-implemented error', () => {
      expect(() =>
        connector.submitOrder({
          contractId: 'X',
          side: 'buy',
          quantity: 1,
          price: 50,
          type: 'limit',
        }),
      ).toThrow('submitOrder not implemented');
    });

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
