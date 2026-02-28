import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KalshiConnector } from './kalshi.connector.js';
import { PlatformId } from '../../common/types/index.js';
import { PlatformApiError } from '../../common/errors/index.js';

const mockGetMarketOrderbook = vi.fn();
const mockCreateOrder = vi.fn();
const mockGetOrder = vi.fn();
const mockCancelOrder = vi.fn();

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
  class MockOrdersApi {
    getOrder = mockGetOrder;
    cancelOrder = mockCancelOrder;
  }
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

// Mock deep import for OrdersApi (barrel re-export broken under nodenext)
vi.mock('kalshi-typescript/dist/api/orders-api.js', () => {
  class MockOrdersApi {
    getOrder = mockGetOrder;
    cancelOrder = mockCancelOrder;
  }
  return { OrdersApi: MockOrdersApi };
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
            yes: [[62, 1000]], // 62¢ YES bid
            no: [[38, 800]], // 38¢ NO bid → 62¢ YES ask (1 - 0.38)
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
            yes: undefined,
            no: undefined,
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

  describe('getOrder', () => {
    it('should throw PlatformApiError when not connected', async () => {
      await expect(connector.getOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should return filled status for executed order with no remaining', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-1',
            status: 'executed',
            remaining_count: 0,
            fill_count: 10,
            taker_fill_cost: 450, // 10 contracts * 45 cents each = 450 cents total
          },
        },
      });

      const result = await connector.getOrder('kalshi-order-1');

      expect(result.orderId).toBe('kalshi-order-1');
      expect(result.status).toBe('filled');
      expect(result.fillPrice).toBe(0.45);
      expect(result.fillSize).toBe(10);
      expect(result.rawResponse).toBeDefined();
    });

    it('should return partial status for executed order with remaining', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-2',
            status: 'executed',
            remaining_count: 5,
            fill_count: 5,
            taker_fill_cost: 225, // 5 contracts * 45 cents = 225 cents total
          },
        },
      });

      const result = await connector.getOrder('kalshi-order-2');

      expect(result.status).toBe('partial');
      expect(result.fillSize).toBe(5);
    });

    it('should return pending status for resting order', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-3',
            status: 'resting',
            remaining_count: 10,
            fill_count: 0,
            taker_fill_cost: 0,
          },
        },
      });

      const result = await connector.getOrder('kalshi-order-3');

      expect(result.status).toBe('pending');
      expect(result.fillPrice).toBeUndefined();
      expect(result.fillSize).toBeUndefined();
    });

    it('should return cancelled status for canceled order', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-4',
            status: 'canceled',
            remaining_count: 10,
            fill_count: 0,
            taker_fill_cost: 0,
          },
        },
      });

      const result = await connector.getOrder('kalshi-order-4');

      expect(result.status).toBe('cancelled');
    });

    it('should return not_found for 404 errors instead of throwing', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockRejectedValue(new Error('Order not found (404)'));

      const result = await connector.getOrder('missing-order');

      expect(result.orderId).toBe('missing-order');
      expect(result.status).toBe('not_found');
    });

    it('should throw PlatformApiError on non-404 SDK error', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

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

    it('should return cancelled status when order is canceled', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-1',
            status: 'canceled',
            remaining_count: 0,
            fill_count: 0,
          },
          reduced_by: 10,
        },
      });

      const result = await connector.cancelOrder('kalshi-order-1');

      expect(result.orderId).toBe('kalshi-order-1');
      expect(result.status).toBe('cancelled');
    });

    it('should return already_filled when order status is executed', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-2',
            status: 'executed',
            remaining_count: 0,
            fill_count: 10,
          },
          reduced_by: 0,
        },
      });

      const result = await connector.cancelOrder('kalshi-order-2');

      expect(result.orderId).toBe('kalshi-order-2');
      expect(result.status).toBe('already_filled');
    });

    it('should return not_found for 404 errors', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockRejectedValue(new Error('Order not found (404)'));

      const result = await connector.cancelOrder('missing-order');

      expect(result.orderId).toBe('missing-order');
      expect(result.status).toBe('not_found');
    });

    it('should throw PlatformApiError on non-404 SDK error', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockRejectedValue(new Error('UNAUTHORIZED'));

      await expect(connector.cancelOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should throw PlatformApiError on unexpected order status', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'order-1',
            status: 'resting',
            remaining_count: 10,
            fill_count: 0,
          },
          reduced_by: 0,
        },
      });

      await expect(connector.cancelOrder('order-1')).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should call rateLimiter.acquireWrite()', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: { order_id: 'order-1', status: 'canceled' },
          reduced_by: 5,
        },
      });

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
    it('getPositions should throw PlatformApiError with code 1100 (NOT_IMPLEMENTED)', () => {
      let caught: PlatformApiError | undefined;
      try {
        void connector.getPositions();
      } catch (error) {
        caught = error as PlatformApiError;
      }
      expect(caught).toBeInstanceOf(PlatformApiError);
      expect(caught?.code).toBe(1100);
      expect(caught?.severity).toBe('warning');
      expect(caught?.platformId).toBe(PlatformId.KALSHI);
    });
  });

  describe('onOrderBookUpdate', () => {
    it('should accept callback without error', () => {
      expect(() => connector.onOrderBookUpdate(vi.fn())).not.toThrow();
    });
  });
});
