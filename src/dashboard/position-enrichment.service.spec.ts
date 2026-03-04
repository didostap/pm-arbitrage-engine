/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PositionEnrichmentService } from './position-enrichment.service.js';
import type { IPriceFeedService } from '../common/interfaces/price-feed-service.interface.js';
import Decimal from 'decimal.js';

function createMockPriceFeed(
  overrides: Partial<IPriceFeedService> = {},
): IPriceFeedService {
  return {
    getCurrentClosePrice: vi.fn(),
    getTakerFeeRate: vi.fn(),
    ...overrides,
  };
}

/**
 * Creates a mock position object matching the shape returned by
 * findByStatusWithOrders() (includes pair + kalshiOrder + polymarketOrder).
 */
function createMockPosition(overrides: Record<string, unknown> = {}) {
  return {
    positionId: 'pos-1',
    pairId: 'pair-1',
    polymarketOrderId: 'pm-order-1',
    kalshiOrderId: 'k-order-1',
    polymarketSide: 'sell',
    kalshiSide: 'buy',
    entryPrices: { kalshi: '0.55', polymarket: '0.45' },
    sizes: { kalshi: '100', polymarket: '100' },
    expectedEdge: { toString: () => '0.012' } as unknown,
    status: 'OPEN',
    isPaper: false,
    createdAt: new Date('2026-03-01'),
    updatedAt: new Date('2026-03-04'),
    reconciliationContext: null,
    pair: {
      matchId: 'pair-1',
      polymarketContractId: 'pm-contract-1',
      kalshiContractId: 'k-contract-1',
      polymarketDescription: 'Will BTC hit $100K?',
      kalshiDescription: 'BTC-100K-YES',
      operatorApproved: true,
      primaryLeg: 'kalshi',
      resolutionDate: new Date('2026-04-01'),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    kalshiOrder: {
      orderId: 'k-order-1',
      platform: 'KALSHI',
      contractId: 'k-contract-1',
      side: 'buy',
      price: { toString: () => '0.55' },
      size: { toString: () => '100' },
      fillPrice: { toString: () => '0.55' },
      fillSize: { toString: () => '100' },
      status: 'FILLED',
    },
    polymarketOrder: {
      orderId: 'pm-order-1',
      platform: 'POLYMARKET',
      contractId: 'pm-contract-1',
      side: 'sell',
      price: { toString: () => '0.45' },
      size: { toString: () => '100' },
      fillPrice: { toString: () => '0.45' },
      fillSize: { toString: () => '100' },
      status: 'FILLED',
    },
    ...overrides,
  };
}

describe('PositionEnrichmentService', () => {
  let service: PositionEnrichmentService;
  let priceFeed: IPriceFeedService;

  beforeEach(() => {
    priceFeed = createMockPriceFeed();
    service = new PositionEnrichmentService(priceFeed);
  });

  describe('enrich', () => {
    it('computes P&L with correct formula matching ThresholdEvaluatorService', async () => {
      // Setup: Kalshi buy@0.55, Polymarket sell@0.45
      // Current: Kalshi best bid 0.60 (close buy→sell), Polymarket best ask 0.40 (close sell→buy)
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string, _contractId: string, _side: 'buy' | 'sell') => {
          if (platform === 'kalshi') return new Decimal('0.60');
          return new Decimal('0.40');
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      expect(result.errors).toBeUndefined();

      const data = result.data;

      // Verify current prices
      expect(data.currentPrices).toEqual({
        kalshi: '0.6',
        polymarket: '0.4',
      });

      // Manual calculation:
      // Kalshi buy: (0.60 - 0.55) * 100 = 5.0
      // Polymarket sell: (0.45 - 0.40) * 100 = 5.0
      // Kalshi exit fee: 0.60 * 100 * 0.02 = 1.2
      // Poly exit fee: 0.40 * 100 * 0.02 = 0.8
      // Total P&L = 5.0 + 5.0 - 1.2 - 0.8 = 8.0
      const pnl = new Decimal(data.unrealizedPnl!);
      expect(pnl.toNumber()).toBeCloseTo(8.0, 6);

      // Current edge = pnl / minLegSize = 8.0 / 100 = 0.08
      const edge = new Decimal(data.currentEdge!);
      expect(edge.toNumber()).toBeCloseTo(0.08, 6);

      // Exit proximity should be defined
      expect(data.exitProximity).not.toBeNull();
    });

    it('computes negative P&L correctly', async () => {
      // Price moved against us: Kalshi bid dropped, Polymarket ask increased
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string) => {
          if (platform === 'kalshi') return new Decimal('0.50'); // bid dropped
          return new Decimal('0.50'); // ask increased
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');

      // Kalshi buy: (0.50 - 0.55) * 100 = -5.0
      // Polymarket sell: (0.45 - 0.50) * 100 = -5.0
      // Kalshi exit fee: 0.50 * 100 * 0.02 = 1.0
      // Poly exit fee: 0.50 * 100 * 0.02 = 1.0
      // Total = -5.0 + (-5.0) - 1.0 - 1.0 = -12.0
      const pnl = new Decimal(result.data.unrealizedPnl!);
      expect(pnl.toNumber()).toBeCloseTo(-12.0, 6);
    });

    it('returns partial result when one connector is down', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string) => {
          if (platform === 'kalshi') return new Decimal('0.60');
          return null; // polymarket down
        },
      );

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('partial');
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      // Fields that depend on both prices should be null
      expect(result.data.currentEdge).toBeNull();
      expect(result.data.unrealizedPnl).toBeNull();
      expect(result.data.exitProximity).toBeNull();
      // Partial current prices populated
      expect(result.data.currentPrices).toEqual({
        kalshi: '0.6',
        polymarket: null,
      });
    });

    it('returns failed result when both connectors are down', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(null);

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('failed');
      expect(result.data.currentPrices).toEqual({
        kalshi: null,
        polymarket: null,
      });
      expect(result.data.currentEdge).toBeNull();
      expect(result.data.unrealizedPnl).toBeNull();
      expect(result.data.exitProximity).toBeNull();
    });

    it('handles missing order fill data gracefully', async () => {
      const position = createMockPosition({
        kalshiOrder: {
          orderId: 'k-order-1',
          fillPrice: null,
          fillSize: null,
          side: 'buy',
        },
      });

      const result = await service.enrich(position as never);

      expect(result.status).toBe('failed');
      expect(result.errors).toBeDefined();
    });

    it('handles zero-size edge case (division-by-zero protection)', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(
        new Decimal('0.55'),
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        kalshiOrder: {
          orderId: 'k-order-1',
          side: 'buy',
          fillPrice: { toString: () => '0.55' },
          fillSize: { toString: () => '0' },
        },
        polymarketOrder: {
          orderId: 'pm-order-1',
          side: 'sell',
          fillPrice: { toString: () => '0.45' },
          fillSize: { toString: () => '0' },
        },
      });

      const result = await service.enrich(position as never);

      // Should not throw — division by zero guarded
      expect(result.status).toBe('enriched');
      const edge = new Decimal(result.data.currentEdge!);
      // minLegSize is 0, so currentEdge = currentPnl / 1 (fallback)
      expect(edge.isFinite()).toBe(true);
    });

    it('computes exit proximity correctly', async () => {
      // Large positive P&L → take-profit proximity high
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string) => {
          if (platform === 'kalshi') return new Decimal('0.60');
          return new Decimal('0.40');
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(
        new Decimal('0.00'), // zero fees for simpler calculation
      );

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      expect(result.data.exitProximity).not.toBeNull();

      const proximity = result.data.exitProximity!;
      // stopLoss and takeProfit should be decimal strings in 0-1 range
      const sl = new Decimal(proximity.stopLoss);
      const tp = new Decimal(proximity.takeProfit);
      expect(sl.gte(0) && sl.lte(1)).toBe(true);
      expect(tp.gte(0) && tp.lte(1)).toBe(true);
    });

    it('enriches paper trading position correctly', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(
        new Decimal('0.55'),
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({ isPaper: true });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // Paper positions enriched same way as live
      expect(result.data.unrealizedPnl).toBeDefined();
    });

    it('includes resolutionDate and timeToResolution', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(
        new Decimal('0.55'),
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const futureDate = new Date(
        Date.now() + 48 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000,
      ); // ~53h from now
      const position = createMockPosition({
        pair: {
          ...createMockPosition().pair,
          resolutionDate: futureDate,
        },
      });

      const result = await service.enrich(position as never);

      expect(result.data.resolutionDate).toBe(futureDate.toISOString());
      expect(result.data.timeToResolution).toMatch(/\d+d\s+\d+h|\d+h/);
    });

    it('returns null timeToResolution when resolutionDate is null', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(
        new Decimal('0.55'),
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        pair: {
          ...createMockPosition().pair,
          resolutionDate: null,
        },
      });

      const result = await service.enrich(position as never);

      expect(result.data.resolutionDate).toBeNull();
      expect(result.data.timeToResolution).toBeNull();
    });
  });
});
