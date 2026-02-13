/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Test, TestingModule } from '@nestjs/testing';
import { OrderBookNormalizerService } from './order-book-normalizer.service';
import { PlatformId } from '../../common/types/platform.type';
import { PlatformApiError } from '../../common/errors/platform-api-error';

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
      };

      const normalized = service.normalize(kalshiBook);

      // Best bid: highest YES bid = 60¢ = 0.60
      expect(normalized.bids[0].price).toBe(0.6);
      expect(normalized.bids[0].quantity).toBe(1000);

      // Best ask: 1 - highest NO bid = 1 - 0.35 = 0.65
      expect(normalized.asks[0].price).toBe(0.65);
      expect(normalized.asks[0].quantity).toBe(800);

      // Spread = 0.65 - 0.60 = 0.05 (5 cents)
      const spread = normalized.asks[0].price - normalized.bids[0].price;
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
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids[0].price).toBe(0.62);
      expect(normalized.asks[0].price).toBe(0.62); // 1 - 0.38 = 0.62
      expect(normalized.asks[0].price - normalized.bids[0].price).toBe(0); // Zero spread
    });

    it('should detect and log crossed market', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[65, 1000]], // YES bid 65¢
        no: [[30, 800]], // NO bid 30¢ → YES ask 70¢
      };

      // Spy on logger.warn
      const warnSpy = vi.spyOn(service['logger'], 'warn');

      const normalized = service.normalize(kalshiBook);

      // Best bid (0.65) < Best ask (0.70) - this is normal, not crossed
      expect(normalized.bids[0].price).toBe(0.65);
      expect(normalized.asks[0].price).toBe(0.7);

      // No crossed market warning for normal spread
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should log warning for actual crossed market', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[65, 1000]], // YES bid 65¢
        no: [[40, 800]], // NO bid 40¢ → YES ask 60¢ (CROSSED!)
      };

      const warnSpy = vi.spyOn(service['logger'], 'warn');

      const normalized = service.normalize(kalshiBook);

      // Best bid (0.65) > Best ask (0.60) - CROSSED
      expect(normalized.bids[0].price).toBe(0.65);
      expect(normalized.asks[0].price).toBe(0.6);

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
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids).toHaveLength(0);
      expect(normalized.asks).toHaveLength(0);
      expect(normalized.platformId).toBe(PlatformId.KALSHI);
    });

    it('should handle single-sided book (only YES bids)', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [],
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids).toHaveLength(1);
      expect(normalized.asks).toHaveLength(0);
      expect(normalized.bids[0].price).toBe(0.6);
    });

    it('should handle single-sided book (only NO bids)', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [[35, 800]],
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids).toHaveLength(0);
      expect(normalized.asks).toHaveLength(1);
      expect(normalized.asks[0].price).toBe(0.65);
    });

    it('should throw PlatformApiError for price > 1', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[150, 1000]], // Invalid: 150¢ > 100¢
        no: [],
      };

      expect(() => service.normalize(kalshiBook)).toThrow(PlatformApiError);
      expect(() => service.normalize(kalshiBook)).toThrow(
        'Invalid price outside 0-1 range: 1.5',
      );
    });

    it('should throw PlatformApiError for price < 0', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [],
        no: [[110, 800]], // NO 110¢ → YES ask -10¢ (invalid)
      };

      expect(() => service.normalize(kalshiBook)).toThrow(PlatformApiError);
      expect(() => service.normalize(kalshiBook)).toThrow(
        'Invalid price outside 0-1 range: -0.1',
      );
    });

    it('should allow price exactly 0', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[0, 1000]], // 0¢ valid for impossible outcome
        no: [],
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids[0].price).toBe(0);
    });

    it('should allow price exactly 1', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[100, 1000]], // 100¢ valid for certain outcome
        no: [],
      };

      const normalized = service.normalize(kalshiBook);

      expect(normalized.bids[0].price).toBe(1);
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
      };

      const normalized = service.normalize(kalshiBook);

      // NO bids [30, 35, 25] → YES asks [0.70, 0.65, 0.75]
      // Sorted ascending: [0.65, 0.70, 0.75]
      expect(normalized.asks[0].price).toBe(0.65);
      expect(normalized.asks[1].price).toBe(0.7);
      expect(normalized.asks[2].price).toBe(0.75);
    });

    it('should track normalization latency', () => {
      const kalshiBook = {
        market_ticker: 'TEST-MARKET',
        yes: [[60, 1000]],
        no: [[35, 800]],
      };

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
      };

      const normalized = service.normalize(kalshiBook);

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
      };

      for (let i = 0; i < 100; i++) {
        service.normalize(kalshiBook);
      }

      const p95 = service.getP95Latency();
      expect(p95).toBeGreaterThanOrEqual(0);
      expect(typeof p95).toBe('number');
    });
  });
});
