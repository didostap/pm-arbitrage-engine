import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KalshiConnector } from './kalshi.connector.js';
import { PlatformId } from '../../common/types/index.js';
import { asContractId, asOrderId } from '../../common/types/branded.type.js';
import { PlatformApiError } from '../../common/errors/index.js';

const mockGetMarketOrderbook = vi.fn();
const mockCreateOrder = vi.fn();
const mockGetOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockGetAccountApiLimits = vi.fn();

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
  class MockAccountApi {
    getAccountApiLimits = mockGetAccountApiLimits;
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
    AccountApi: MockAccountApi,
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

// Mock deep import for AccountApi
vi.mock('kalshi-typescript/dist/api/account-api.js', () => {
  class MockAccountApi {
    getAccountApiLimits = mockGetAccountApiLimits;
  }
  return { AccountApi: MockAccountApi };
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
                KALSHI_API_TIER: 'BASIC',
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
    it('should return Kalshi fee schedule with worst-case takerFeePercent', () => {
      const fees = connector.getFeeSchedule();
      expect(fees.platformId).toBe(PlatformId.KALSHI);
      expect(fees.makerFeePercent).toBe(0);
      expect(fees.takerFeePercent).toBe(1.75);
      expect(fees.takerFeeForPrice).toBeDefined();
    });

    it('should provide takerFeeForPrice callback implementing 0.07 × (1-P) rate formula', () => {
      const fees = connector.getFeeSchedule();
      const fn = fees.takerFeeForPrice!;

      // At P=0.50: rate = 0.07 × 0.50 = 0.035
      expect(fn(0.5)).toBeCloseTo(0.035, 10);
      // At P=0.25: rate = 0.07 × 0.75 = 0.0525
      expect(fn(0.25)).toBeCloseTo(0.0525, 10);
      // At P=0.75: rate = 0.07 × 0.25 = 0.0175
      expect(fn(0.75)).toBeCloseTo(0.0175, 10);
      // At P=0.01: rate = 0.07 × 0.99 = 0.0693
      expect(fn(0.01)).toBeCloseTo(0.0693, 10);
      // At P=0.99: rate = 0.07 × 0.01 = 0.0007
      expect(fn(0.99)).toBeCloseTo(0.0007, 10);
    });

    it('should return 0 fee rate at price boundaries', () => {
      const fees = connector.getFeeSchedule();
      const fn = fees.takerFeeForPrice!;

      expect(fn(0)).toBe(0);
      expect(fn(1)).toBe(0);
    });
  });

  describe('getOrderBook', () => {
    it('should transform YES/NO dollar levels to normalized format', async () => {
      mockGetMarketOrderbook.mockResolvedValue({
        data: {
          orderbook_fp: {
            yes_dollars: [['0.6200', '1000.00']], // $0.62 YES bid
            no_dollars: [['0.3800', '800.00']], // $0.38 NO bid → YES ask (1 - 0.38 = 0.62)
          },
        },
      });

      const orderbook = await connector.getOrderBook(
        asContractId('CPI-22DEC-TN0.1'),
      );

      expect(orderbook.platformId).toBe(PlatformId.KALSHI);
      expect(orderbook.contractId).toBe(asContractId('CPI-22DEC-TN0.1'));
      // YES bid $0.62 → 0.62
      expect(orderbook.bids).toEqual([{ price: 0.62, quantity: 1000 }]);
      // NO bid $0.38 → YES ask (1 - 0.38) = 0.62
      expect(orderbook.asks).toEqual([{ price: 0.62, quantity: 800 }]);
    });

    it('should throw PlatformApiError on SDK error', async () => {
      mockGetMarketOrderbook.mockRejectedValue(
        new Error('API error: UNAUTHORIZED'),
      );

      await expect(
        connector.getOrderBook(asContractId('CPI-22DEC-TN0.1')),
      ).rejects.toThrow(PlatformApiError);
    });

    it('should handle empty orderbook', async () => {
      mockGetMarketOrderbook.mockResolvedValue({
        data: {
          orderbook_fp: {
            yes_dollars: undefined,
            no_dollars: undefined,
          },
        },
      });

      const orderbook = await connector.getOrderBook(asContractId('EMPTY'));
      expect(orderbook.bids).toEqual([]);
      expect(orderbook.asks).toEqual([]);
    });
  });

  describe('submitOrder', () => {
    it('should send dollar string price and return mapped result', async () => {
      mockCreateOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-1',
            status: 'executed',
            remaining_count_fp: '0.00',
            fill_count_fp: '10.00',
            taker_fill_count_fp: '10.00',
            taker_fill_cost_dollars: '4.50', // 10 contracts * $0.45
            created_time: '2026-01-01T00:00:00Z',
          },
        },
      });

      const result = await connector.submitOrder({
        contractId: asContractId('CPI-22DEC-TN0.1'),
        side: 'buy',
        quantity: 10,
        price: 0.45,
        type: 'limit',
      });

      expect(result.orderId).toBe(asOrderId('kalshi-order-1'));
      expect(result.status).toBe('filled');
      expect(result.filledQuantity).toBe(10);
      expect(result.filledPrice).toBe(0.45);
      expect(result.platformId).toBe(PlatformId.KALSHI);

      // Verify dollar string conversion: 0.45 → "0.45"
      expect(mockCreateOrder).toHaveBeenCalledWith(
        expect.objectContaining({ yes_price_dollars: '0.45' }),
      );
    });

    it('should map canceled status to rejected', async () => {
      mockCreateOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-2',
            status: 'canceled',
            remaining_count_fp: '10.00',
            fill_count_fp: '0.00',
            taker_fill_count_fp: '0.00',
            taker_fill_cost_dollars: '0.00',
            created_time: '2026-01-01T00:00:00Z',
          },
        },
      });

      const result = await connector.submitOrder({
        contractId: asContractId('CPI-22DEC-TN0.1'),
        side: 'buy',
        quantity: 10,
        price: 0.45,
        type: 'limit',
      });

      expect(result.status).toBe('rejected');
    });

    it('should round price DOWN to 2 decimal places (never up)', async () => {
      mockCreateOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-round',
            status: 'resting',
            remaining_count_fp: '10.00',
            fill_count_fp: '0.00',
            taker_fill_count_fp: '0.00',
            taker_fill_cost_dollars: '0.00',
            created_time: '2026-01-01T00:00:00Z',
          },
        },
      });

      await connector.submitOrder({
        contractId: asContractId('CPI-22DEC-TN0.1'),
        side: 'buy',
        quantity: 10,
        price: 0.455,
        type: 'limit',
      });

      // 0.455 should round DOWN to "0.45", not up to "0.46"
      expect(mockCreateOrder).toHaveBeenCalledWith(
        expect.objectContaining({ yes_price_dollars: '0.45' }),
      );
    });

    it('should throw PlatformApiError on SDK error', async () => {
      mockCreateOrder.mockRejectedValue(new Error('API error'));

      await expect(
        connector.submitOrder({
          contractId: asContractId('X'),
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
      await expect(connector.getOrder(asOrderId('order-1'))).rejects.toThrow(
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
            remaining_count_fp: '0.00',
            fill_count_fp: '10.00',
            taker_fill_count_fp: '10.00',
            taker_fill_cost_dollars: '4.50', // 10 contracts * $0.45 each = $4.50 total
          },
        },
      });

      const result = await connector.getOrder(asOrderId('kalshi-order-1'));

      expect(result.orderId).toBe(asOrderId('kalshi-order-1'));
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
            remaining_count_fp: '5.00',
            fill_count_fp: '5.00',
            taker_fill_count_fp: '5.00',
            taker_fill_cost_dollars: '2.25', // 5 contracts * $0.45 = $2.25 total
          },
        },
      });

      const result = await connector.getOrder(asOrderId('kalshi-order-2'));

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
            remaining_count_fp: '10.00',
            fill_count_fp: '0.00',
            taker_fill_count_fp: '0.00',
            taker_fill_cost_dollars: '0.00',
          },
        },
      });

      const result = await connector.getOrder(asOrderId('kalshi-order-3'));

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
            remaining_count_fp: '10.00',
            fill_count_fp: '0.00',
            taker_fill_count_fp: '0.00',
            taker_fill_cost_dollars: '0.00',
          },
        },
      });

      const result = await connector.getOrder(asOrderId('kalshi-order-4'));

      expect(result.status).toBe('cancelled');
    });

    it('should return not_found for 404 errors instead of throwing', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockRejectedValue(new Error('Order not found (404)'));

      const result = await connector.getOrder(asOrderId('missing-order'));

      expect(result.orderId).toBe(asOrderId('missing-order'));
      expect(result.status).toBe('not_found');
    });

    it('should throw PlatformApiError on non-404 SDK error', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockGetOrder.mockRejectedValue(new Error('UNAUTHORIZED'));

      await expect(connector.getOrder(asOrderId('order-1'))).rejects.toThrow(
        PlatformApiError,
      );
    });
  });

  describe('cancelOrder', () => {
    it('should throw PlatformApiError when not connected', async () => {
      await expect(connector.cancelOrder(asOrderId('order-1'))).rejects.toThrow(
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
          },
          reduced_by_fp: '10.00',
        },
      });

      const result = await connector.cancelOrder(asOrderId('kalshi-order-1'));

      expect(result.orderId).toBe(asOrderId('kalshi-order-1'));
      expect(result.status).toBe('cancelled');
    });

    it('should return already_filled when order status is executed', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: {
            order_id: 'kalshi-order-2',
            status: 'executed',
          },
          reduced_by_fp: '0.00',
        },
      });

      const result = await connector.cancelOrder(asOrderId('kalshi-order-2'));

      expect(result.orderId).toBe(asOrderId('kalshi-order-2'));
      expect(result.status).toBe('already_filled');
    });

    it('should return not_found for 404 errors', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockRejectedValue(new Error('Order not found (404)'));

      const result = await connector.cancelOrder(asOrderId('missing-order'));

      expect(result.orderId).toBe(asOrderId('missing-order'));
      expect(result.status).toBe('not_found');
    });

    it('should throw PlatformApiError on non-404 SDK error', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockRejectedValue(new Error('UNAUTHORIZED'));

      await expect(connector.cancelOrder(asOrderId('order-1'))).rejects.toThrow(
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
          },
          reduced_by_fp: '0.00',
        },
      });

      await expect(connector.cancelOrder(asOrderId('order-1'))).rejects.toThrow(
        PlatformApiError,
      );
    });

    it('should call rateLimiter.acquireWrite()', async () => {
      (connector as unknown as { connected: boolean }).connected = true;

      mockCancelOrder.mockResolvedValue({
        data: {
          order: { order_id: 'order-1', status: 'canceled' },
          reduced_by_fp: '5.00',
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

      await connector.cancelOrder(asOrderId('order-1'));

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

  describe('initializeRateLimiterFromApi (via onModuleInit)', () => {
    it('should upgrade rate limiter when API returns valid limits', async () => {
      // Use PREMIER limits (100/100) to distinguish from BASIC default (20/10)
      mockGetAccountApiLimits.mockResolvedValue({
        data: { usage_tier: 'PREMIER', read_limit: 100, write_limit: 100 },
      });

      await connector.onModuleInit();

      expect(mockGetAccountApiLimits).toHaveBeenCalledOnce();

      // Verify limiter was upgraded by checking bucket size
      // PREMIER fromLimits(100, 100) → readBucket = ceil(100 × 1.5) = 150
      // BASIC fromTier('BASIC') → readBucket = ceil(20 × 1.5) = 30
      const rateLimiter = (
        connector as unknown as {
          rateLimiter: {
            acquireRead: () => Promise<void>;
            getUtilization: () => { read: number; write: number };
          };
        }
      ).rateLimiter;
      await rateLimiter.acquireRead();
      const util = rateLimiter.getUtilization();
      // 1/150 ≈ 0.67% (PREMIER) vs 1/30 ≈ 3.33% (BASIC)
      expect(util.read).toBeLessThan(1);
    });

    it('should keep default limiter when API returns invalid data', async () => {
      mockGetAccountApiLimits.mockResolvedValue({
        data: { usage_tier: 'BASIC', read_limit: 0, write_limit: 10 },
      });

      const loggerSpy = vi.spyOn(connector['logger'], 'warn');

      await connector.onModuleInit();

      expect(mockGetAccountApiLimits).toHaveBeenCalledOnce();
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid rate limit data from API; keeping default limiter',
        }),
      );
    });

    it('should keep default limiter when API call fails', async () => {
      mockGetAccountApiLimits.mockRejectedValue(new Error('Network error'));

      const loggerSpy = vi.spyOn(connector['logger'], 'warn');

      await connector.onModuleInit();

      expect(mockGetAccountApiLimits).toHaveBeenCalledOnce();
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'Failed to fetch API rate limits; keeping default tier-based limiter',
        }),
      );
    });

    it('should skip API call when KALSHI_API_KEY_ID is empty', async () => {
      // Create connector with empty API key
      const module = await Test.createTestingModule({
        providers: [
          KalshiConnector,
          {
            provide: ConfigService,
            useValue: {
              get: vi.fn((key: string, defaultValue?: string) => {
                const config: Record<string, string> = {
                  KALSHI_API_KEY_ID: '',
                  KALSHI_PRIVATE_KEY_PATH: '/path/to/test.pem',
                  KALSHI_API_BASE_URL: 'https://demo-api.kalshi.co',
                  KALSHI_API_TIER: 'BASIC',
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const unconfiguredConnector =
        module.get<KalshiConnector>(KalshiConnector);
      await unconfiguredConnector.onModuleInit();

      expect(mockGetAccountApiLimits).not.toHaveBeenCalled();
    });
  });
});
