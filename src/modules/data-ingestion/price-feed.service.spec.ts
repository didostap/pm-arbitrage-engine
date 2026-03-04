/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PriceFeedService } from './price-feed.service.js';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface.js';
import type { NormalizedOrderBook } from '../../common/types/normalized-order-book.type.js';
import type { FeeSchedule } from '../../common/types/platform.type.js';
import { PlatformId } from '../../common/types/platform.type.js';
import Decimal from 'decimal.js';

function createMockConnector(
  overrides: Partial<IPlatformConnector> = {},
): IPlatformConnector {
  return {
    getOrderBook: vi.fn(),
    getFeeSchedule: vi.fn(),
    getPlatformId: vi.fn(),
    getHealth: vi.fn(),
    getPositions: vi.fn(),
    submitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOrder: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onOrderBookUpdate: vi.fn(),
    ...overrides,
  } as IPlatformConnector;
}

function makeOrderBook(
  bids: Array<{ price: number; quantity: number }>,
  asks: Array<{ price: number; quantity: number }>,
): NormalizedOrderBook {
  return {
    platformId: PlatformId.KALSHI,
    contractId: 'contract-1',
    bids: bids.map((b) => ({ price: b.price, quantity: b.quantity })),
    asks: asks.map((a) => ({ price: a.price, quantity: a.quantity })),
    timestamp: new Date(),
    sequenceNumber: 1,
    isSnapshot: true,
  };
}

describe('PriceFeedService', () => {
  let service: PriceFeedService;
  let kalshiConnector: IPlatformConnector;
  let polymarketConnector: IPlatformConnector;

  const kalshiFeeSchedule: FeeSchedule = {
    platformId: PlatformId.KALSHI,
    makerFeePercent: 0,
    takerFeePercent: 7,
    description: 'Kalshi dynamic fees',
    takerFeeForPrice: (price: number) => {
      const complement = 1 - price;
      return Math.min(price, complement) * 0.07;
    },
  };

  const polymarketFeeSchedule: FeeSchedule = {
    platformId: PlatformId.POLYMARKET,
    makerFeePercent: 0,
    takerFeePercent: 2,
    description: 'Polymarket flat fees',
  };

  beforeEach(() => {
    kalshiConnector = createMockConnector({
      getPlatformId: vi.fn().mockReturnValue(PlatformId.KALSHI),
      getFeeSchedule: vi.fn().mockReturnValue(kalshiFeeSchedule),
    });
    polymarketConnector = createMockConnector({
      getPlatformId: vi.fn().mockReturnValue(PlatformId.POLYMARKET),
      getFeeSchedule: vi.fn().mockReturnValue(polymarketFeeSchedule),
    });

    service = new PriceFeedService(kalshiConnector, polymarketConnector);
  });

  describe('getCurrentClosePrice', () => {
    it('returns best bid for buy side (selling to close)', async () => {
      vi.mocked(kalshiConnector.getOrderBook).mockResolvedValue(
        makeOrderBook(
          [
            { price: 0.55, quantity: 10 },
            { price: 0.5, quantity: 5 },
          ],
          [{ price: 0.6, quantity: 10 }],
        ),
      );

      const result = await service.getCurrentClosePrice(
        'kalshi',
        'contract-1',
        'buy',
      );
      expect(result).toEqual(new Decimal('0.55'));
    });

    it('returns best ask for sell side (buying to close)', async () => {
      vi.mocked(polymarketConnector.getOrderBook).mockResolvedValue(
        makeOrderBook(
          [{ price: 0.4, quantity: 10 }],
          [
            { price: 0.45, quantity: 10 },
            { price: 0.5, quantity: 5 },
          ],
        ),
      );

      const result = await service.getCurrentClosePrice(
        'polymarket',
        'contract-2',
        'sell',
      );
      expect(result).toEqual(new Decimal('0.45'));
    });

    it('returns null when bids empty for buy side', async () => {
      vi.mocked(kalshiConnector.getOrderBook).mockResolvedValue(
        makeOrderBook([], [{ price: 0.6, quantity: 10 }]),
      );

      const result = await service.getCurrentClosePrice(
        'kalshi',
        'contract-1',
        'buy',
      );
      expect(result).toBeNull();
    });

    it('returns null when asks empty for sell side', async () => {
      vi.mocked(polymarketConnector.getOrderBook).mockResolvedValue(
        makeOrderBook([{ price: 0.4, quantity: 10 }], []),
      );

      const result = await service.getCurrentClosePrice(
        'polymarket',
        'contract-2',
        'sell',
      );
      expect(result).toBeNull();
    });

    it('returns null when connector throws (order book unavailable)', async () => {
      vi.mocked(kalshiConnector.getOrderBook).mockRejectedValue(
        new Error('Disconnected'),
      );

      const result = await service.getCurrentClosePrice(
        'kalshi',
        'contract-1',
        'buy',
      );
      expect(result).toBeNull();
    });

    it('selects correct connector based on platform string', async () => {
      vi.mocked(kalshiConnector.getOrderBook).mockResolvedValue(
        makeOrderBook([{ price: 0.55, quantity: 10 }], []),
      );
      vi.mocked(polymarketConnector.getOrderBook).mockResolvedValue(
        makeOrderBook([{ price: 0.4, quantity: 10 }], []),
      );

      await service.getCurrentClosePrice('kalshi', 'c1', 'buy');
      expect(kalshiConnector.getOrderBook).toHaveBeenCalledWith('c1');
      expect(polymarketConnector.getOrderBook).not.toHaveBeenCalled();

      await service.getCurrentClosePrice('polymarket', 'c2', 'buy');
      expect(polymarketConnector.getOrderBook).toHaveBeenCalledWith('c2');
    });
  });

  describe('getTakerFeeRate', () => {
    it('returns dynamic Kalshi fee rate using takerFeeForPrice callback', () => {
      const price = new Decimal('0.60');
      const result = service.getTakerFeeRate('kalshi', price);

      // Kalshi: min(price, 1-price) * 0.07 = min(0.6, 0.4) * 0.07 = 0.4 * 0.07 = 0.028
      expect(result.toNumber()).toBeCloseTo(0.028, 6);
    });

    it('returns flat Polymarket fee rate from takerFeePercent', () => {
      const price = new Decimal('0.45');
      const result = service.getTakerFeeRate('polymarket', price);

      // Polymarket: 2% / 100 = 0.02
      expect(result.toNumber()).toBeCloseTo(0.02, 6);
    });

    it('uses fallback takerFeePercent when Kalshi callback absent', () => {
      const noCallbackFee: FeeSchedule = {
        platformId: PlatformId.KALSHI,
        makerFeePercent: 0,
        takerFeePercent: 7,
        description: 'Kalshi no callback',
      };
      vi.mocked(kalshiConnector.getFeeSchedule).mockReturnValue(noCallbackFee);

      const price = new Decimal('0.60');
      const result = service.getTakerFeeRate('kalshi', price);

      // Fallback: 7 / 100 = 0.07
      expect(result.toNumber()).toBeCloseTo(0.07, 6);
    });
  });
});
