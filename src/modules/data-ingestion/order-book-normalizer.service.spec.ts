/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformId } from '../../common/types/platform.type';
import type { PolymarketOrderBookMessage } from '../../connectors/polymarket/polymarket.types';
import type { KalshiOrderBook } from '../../connectors/kalshi/kalshi-websocket.client';
import { vi } from 'vitest';

describe('OrderBookNormalizerService', () => {
  let service: OrderBookNormalizerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrderBookNormalizerService],
    }).compile();

    service = module.get<OrderBookNormalizerService>(
      OrderBookNormalizerService,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('normalize()', () => {
    it('should convert Kalshi cents to decimal with realistic spread', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [
          [60, 1000],
          [59, 500],
        ], // YES bids: 60¢, 59¢
        no: [
          [35, 800],
          [34, 600],
        ], // NO bids: 35¢, 34¢ → YES asks: 65¢, 66¢
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      // Best bid: highest YES bid = 60¢ = 0.60
      expect(normalized.bids[0]!.price).toBe(0.6);
      expect(normalized.bids[0]!.quantity).toBe(1000);

      // Best ask: 1 - highest NO bid = 1 - 0.35 = 0.65
      expect(normalized.asks[0]!.price).toBe(0.65);
      expect(normalized.asks[0]!.quantity).toBe(800);

      // Spread = 0.65 - 0.60 = 0.05 (5 cents)
      const spread = normalized.asks[0]!.price - normalized.bids[0]!.price;
      expect(spread).toBeCloseTo(0.05, 10); // 10 decimal places precision

      // Verify full depth
      expect(normalized.bids).toHaveLength(2);
      expect(normalized.asks).toHaveLength(2);

      // Verify platform ID
      expect(normalized.platformId).toBe(PlatformId.KALSHI);
      expect(normalized.contractId).toBe('TEST-MARKET');
    });

    it('should handle zero-spread (locked) market', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[62, 1000]],
        no: [[38, 800]], // 62 + 38 = 100 → zero spread
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids[0]!.price).toBe(0.62);
      expect(normalized.asks[0]!.price).toBe(0.62); // 1 - 0.38 = 0.62
      expect(normalized.asks[0]!.price - normalized.bids[0]!.price).toBe(0); // Zero spread
    });

    it('should detect and log crossed market', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[65, 1000]], // YES bid 65¢
        no: [[30, 800]], // NO bid 30¢ → YES ask 70¢
      } as KalshiOrderBook;

      // Spy on logger.warn
      const warnSpy = vi.spyOn(service['logger'], 'warn');

      const normalized = service.normalize(kalshiBook)!;

      // Best bid (0.65) < Best ask (0.70) - this is normal, not crossed
      expect(normalized.bids[0]!.price).toBe(0.65);
      expect(normalized.asks[0]!.price).toBe(0.7);

      // No crossed market warning for normal spread
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should log warning for actual crossed market', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[65, 1000]], // YES bid 65¢
        no: [[40, 800]], // NO bid 40¢ → YES ask 60¢ (CROSSED!)
      } as KalshiOrderBook;

      const warnSpy = vi.spyOn(service['logger'], 'warn');

      const normalized = service.normalize(kalshiBook)!;

      // Best bid (0.65) > Best ask (0.60) - CROSSED
      expect(normalized.bids[0]!.price).toBe(0.65);
      expect(normalized.asks[0]!.price).toBe(0.6);

      // Should log crossed market warning
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Crossed market detected',
          bestBid: 0.65,
          bestAsk: 0.6,
        }),
      );
    });

    it('should handle empty orderbook', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [],
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids).toHaveLength(0);
      expect(normalized.asks).toHaveLength(0);
      expect(normalized.platformId).toBe(PlatformId.KALSHI);
    });

    it('should handle single-sided book (only YES bids)', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [],
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids).toHaveLength(1);
      expect(normalized.asks).toHaveLength(0);
      expect(normalized.bids[0]!.price).toBe(0.6);
    });

    it('should handle single-sided book (only NO bids)', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [[35, 800]],
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids).toHaveLength(0);
      expect(normalized.asks).toHaveLength(1);
      expect(normalized.asks[0]!.price).toBe(0.65);
    });

    it('should return null and log error for price > 1', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[150, 1000]], // Invalid: 150¢ > 100¢
        no: [],
      } as KalshiOrderBook;

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalize(kalshiBook)!;

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid Kalshi price'),
          price: 1.5,
          contractId: 'TEST-MARKET',
        }),
      );
    });

    it('should return null and log error for price < 0', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [[110, 800]], // NO 110¢ → YES ask -10¢ (invalid)
      } as KalshiOrderBook;

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalize(kalshiBook)!;

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid Kalshi price'),
          contractId: 'TEST-MARKET',
        }),
      );
      // Verify price is negative (floating point precision makes exact match unreliable)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const loggedPrice = errorSpy.mock.calls[0]?.[0]?.price as number;
      expect(loggedPrice).toBeLessThan(0);
    });

    it('should allow price exactly 0', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[0, 1000]], // 0¢ valid for impossible outcome
        no: [],
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids[0]!.price).toBe(0);
    });

    it('should allow price exactly 1', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[100, 1000]], // 100¢ valid for certain outcome
        no: [],
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.bids[0]!.price).toBe(1);
    });

    it('should sort asks ascending', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [
          [30, 800],
          [35, 600],
          [25, 1000],
        ], // Unsorted NO bids
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      // NO bids [30, 35, 25] → YES asks [0.70, 0.65, 0.75]
      // Sorted ascending: [0.65, 0.70, 0.75]
      expect(normalized.asks[0]!.price).toBe(0.65);
      expect(normalized.asks[1]!.price).toBe(0.7);
      expect(normalized.asks[2]!.price).toBe(0.75);
    });

    it('should track normalization latency', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [[35, 800]],
      } as KalshiOrderBook;

      // Normalize several times
      for (let i = 0; i < 10; i++) {
        service.normalize(kalshiBook);
      }

      // P95 should be updated
      const newP95 = service.getP95Latency();
      expect(newP95).toBeGreaterThanOrEqual(0);
    });

    it('should set timestamp and sequence number', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [[35, 800]],
        seq: 12345,
      } as KalshiOrderBook;

      const normalized = service.normalize(kalshiBook)!;

      expect(normalized.timestamp).toBeInstanceOf(Date);
      expect(normalized.sequenceNumber).toBe(12345);
    });
  });

  describe('getP95Latency()', () => {
    it('should return 0 for no samples', () => {
      expect(service.getP95Latency()).toBe(0);
    });

    it('should calculate p95 correctly', () => {
      // Normalize multiple times to build samples
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [[35, 800]],
      } as KalshiOrderBook;

      for (let i = 0; i < 100; i++) {
        service.normalize(kalshiBook)!;
      }

      const p95 = service.getP95Latency();
      expect(p95).toBeGreaterThanOrEqual(0);
      expect(typeof p95).toBe('number');
    });
  });

  describe('normalizePolymarket()', () => {
    it('should normalize valid Polymarket order book', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [
          { price: '0.65', size: '1000' },
          { price: '0.60', size: '500' },
        ],
        asks: [
          { price: '0.70', size: '800' },
          { price: '0.75', size: '600' },
        ],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.platformId).toBe(PlatformId.POLYMARKET);
      expect(normalized?.contractId).toBe('0x123abc');
      expect(normalized?.bids).toHaveLength(2);
      expect(normalized?.asks).toHaveLength(2);

      // Verify price parsing
      expect(normalized?.bids[0]!.price).toBe(0.65);
      expect(normalized?.bids[0]!.quantity).toBe(1000);
      expect(normalized?.asks[0]!.price).toBe(0.7);
      expect(normalized?.asks[0]!.quantity).toBe(800);

      // Verify spread
      const spread =
        (normalized?.asks[0]!.price ?? 0) - (normalized?.bids[0]!.price ?? 0);
      expect(spread).toBeCloseTo(0.05, 10);
    });

    it('should return null and log error for price > 1.0', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '1.5', size: '1000' }], // Invalid price
        asks: [],
        hash: 'abc123',
      };

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid Polymarket price'),
          price: 1.5,
          contractId: '0x123abc',
        }),
      );
    });

    it('should return null and log error for price < 0.0', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [],
        asks: [{ price: '-0.1', size: '800' }], // Invalid price
        hash: 'abc123',
      };

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Invalid Polymarket price'),
          price: -0.1,
        }),
      );
    });

    it('should allow price exactly 0.0', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.0', size: '1000' }],
        asks: [],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids[0]!.price).toBe(0);
    });

    it('should allow price exactly 1.0', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '1.0', size: '1000' }],
        asks: [],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids[0]!.price).toBe(1);
    });

    it('should log warning for crossed market but return valid book', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.75', size: '1000' }], // Bid > ask (crossed)
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const warnSpy = vi.spyOn(service['logger'], 'warn');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Crossed market detected',
          bestBid: 0.75,
          bestAsk: 0.7,
        }),
      );
    });

    it('should handle empty order book', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [],
        asks: [],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids).toHaveLength(0);
      expect(normalized?.asks).toHaveLength(0);
      expect(normalized?.platformId).toBe(PlatformId.POLYMARKET);
    });

    it('should handle single-sided book (only bids)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.60', size: '1000' }],
        asks: [],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids).toHaveLength(1);
      expect(normalized?.asks).toHaveLength(0);
      expect(normalized?.bids[0]!.price).toBe(0.6);
    });

    it('should handle single-sided book (only asks)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids).toHaveLength(0);
      expect(normalized?.asks).toHaveLength(1);
      expect(normalized?.asks[0]!.price).toBe(0.7);
    });

    it('should handle zero-spread book', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.62', size: '1000' }],
        asks: [{ price: '0.62', size: '800' }],
        hash: 'abc123',
      };

      const infoSpy = vi.spyOn(service['logger'], 'log');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids[0]!.price).toBe(0.62);
      expect(normalized?.asks[0]!.price).toBe(0.62);
      expect(
        (normalized?.asks[0]!.price ?? 0) - (normalized?.bids[0]!.price ?? 0),
      ).toBe(0);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Zero-spread market detected',
        }),
      );
    });

    it('should track latency across multiple normalizations', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.65', size: '1000' }],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      // Normalize 100 times to build latency samples
      for (let i = 0; i < 100; i++) {
        service.normalizePolymarket(polymarketBook);
      }

      const p95 = service.getP95Latency();
      expect(p95).toBeGreaterThanOrEqual(0);
    });

    it('should log warning if P95 normalization latency exceeds 500ms SLA', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.65', size: '1000' }],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const warnSpy = vi.spyOn(service['logger'], 'warn');
      const nowSpy = vi.spyOn(Date, 'now');

      // Build up samples where P95 exceeds threshold
      // Add 100 samples: 95 at 400ms (fast), 5 at 600ms (slow)
      // P95 will be 600ms (exceeds 500ms threshold)
      for (let i = 0; i < 95; i++) {
        nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(400);
        service.normalizePolymarket(polymarketBook);
      }
      for (let i = 0; i < 5; i++) {
        nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(600);
        service.normalizePolymarket(polymarketBook);
      }

      // Last call should trigger warning (P95 > 500ms)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'P95 normalization latency exceeded SLA',
          p95LatencyMs: 600,
          threshold: 500,
        }),
      );
    });

    it('should complete normalization in <10ms (performance benchmark)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.65', size: '1000' }],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const start = Date.now();
      service.normalizePolymarket(polymarketBook);
      const latency = Date.now() - start;

      // Polymarket normalization should be much faster than Kalshi
      // (no probabilistic inversion needed)
      expect(latency).toBeLessThan(10);
    });

    it('should set timestamp correctly', () => {
      const timestamp = Date.now();
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp,
        bids: [{ price: '0.65', size: '1000' }],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.timestamp).toBeInstanceOf(Date);
      expect(normalized?.timestamp.getTime()).toBe(timestamp);
    });

    it('should set sequenceNumber to undefined (Polymarket does not provide)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.65', size: '1000' }],
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      };

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.sequenceNumber).toBeUndefined();
    });

    it('should return null and log error for malformed price string (NaN)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: 'invalid', size: '1000' }], // Malformed price
        asks: [],
        hash: 'abc123',
      };

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('NaN'),
          contractId: '0x123abc',
        }),
      );
    });

    it('should return null and log error for malformed quantity string (NaN)', () => {
      const polymarketBook: PolymarketOrderBookMessage = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [],
        asks: [{ price: '0.65', size: 'abc' }], // Malformed quantity
        hash: 'abc123',
      };

      const errorSpy = vi.spyOn(service['logger'], 'error');
      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('NaN'),
        }),
      );
    });

    it('should handle null bids array gracefully', () => {
      const polymarketBook = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: null, // Null array
        asks: [{ price: '0.70', size: '800' }],
        hash: 'abc123',
      } as unknown as PolymarketOrderBookMessage;

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids).toEqual([]);
      expect(normalized?.asks).toHaveLength(1);
    });

    it('should handle undefined asks array gracefully', () => {
      const polymarketBook = {
        asset_id: '0x123abc',
        market: '0xmarket',
        timestamp: Date.now(),
        bids: [{ price: '0.65', size: '1000' }],
        asks: undefined, // Undefined array
        hash: 'abc123',
      } as unknown as PolymarketOrderBookMessage;

      const normalized = service.normalizePolymarket(polymarketBook);

      expect(normalized).not.toBeNull();
      expect(normalized?.bids).toHaveLength(1);
      expect(normalized?.asks).toEqual([]);
    });
  });
});
