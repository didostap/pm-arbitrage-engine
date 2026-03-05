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
        (
          platform: string,
          _contractId: string,
          _side: 'buy' | 'sell',
        ): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
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

      // Current edge = pnl / legSize = 8.0 / 100 = 0.08
      const edge = new Decimal(data.currentEdge!);
      expect(edge.toNumber()).toBeCloseTo(0.08, 6);

      // Exit proximity should be defined
      expect(data.exitProximity).not.toBeNull();
    });

    it('computes negative P&L correctly', async () => {
      // Price moved against us: Kalshi bid dropped, Polymarket ask increased
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.50')); // bid dropped
          return Promise.resolve(new Decimal('0.50')); // ask increased
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
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(null); // polymarket down
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

      // legSize is 0, so currentEdge = currentPnl / 1 (fallback)
      expect(edge.isFinite()).toBe(true);
    });

    it('computes exit proximity correctly', async () => {
      // Large positive P&L → take-profit proximity high
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
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

    it('uses legSize=kalshiSize for exit proximity (6.5.5h fix in enrichment)', async () => {
      // Equal sizes (100/100) → legSize = 100
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = 1.2 * -2 = -2.4 (without baseline)
      // TP threshold = 1.2 * 0.80 = 0.96 (without baseline)
      // currentPnl = 8.0 (from first test)
      // TP proximity = min(1, max(0, 8.0 / 0.96)) = 1.0 (capped)
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
    });

    it('offsets exit proximity with entry cost baseline (6.5.5i)', async () => {
      // Kalshi buy@0.55, entry close bid=0.53 → spread = 0.55-0.53 = 0.02
      // Poly sell@0.45, entry close ask=0.47 → spread = 0.47-0.45 = 0.02
      // spreadCost = (0.02 * 100) + (0.02 * 100) = 4.0
      // entryExitFees = (0.53 * 100 * 0.02) + (0.47 * 100 * 0.02) = 1.06 + 0.94 = 2.0
      // entryCostBaseline = -(4.0 + 2.0) = -6.0
      // SL threshold = -6.0 + (0.012 * 100 * -2) = -6.0 + -2.4 = -8.4
      //
      // Without baseline (old): SL threshold = -2.4
      // With currentPnl = -4.0:
      //   Old SL proximity = min(1, |-4.0 / -2.4|) = min(1, 1.667) = 1.0 (maxed out)
      //   New SL proximity = min(1, |-4.0 / -8.4|) = min(1, 0.476) = 0.476
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          // Prices that give currentPnl ≈ -4.0
          // kalshi buy@0.55 sell@0.52 → (0.52-0.55)*100 = -3.0
          // poly sell@0.45 buy@0.46 → (0.45-0.46)*100 = -1.0
          // exit fees: 0.52*100*0.02 + 0.46*100*0.02 = 1.04+0.92 = 1.96
          // currentPnl = -3.0 + -1.0 - 1.96 = -5.96
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.52'));
          return Promise.resolve(new Decimal('0.46'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.53' },
        entryClosePricePolymarket: { toString: () => '0.47' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // currentPnl = -5.96
      // Without baseline: SL threshold = -2.4, proximity = min(1, |-5.96/-2.4|) = 1.0
      // With baseline: SL threshold = -8.4, proximity = min(1, |-5.96/-8.4|) ≈ 0.7095
      // This test verifies the NEW behavior (proximity < 1.0)
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      expect(sl.toNumber()).toBeCloseTo(0.7095, 2);
    });

    it('uses baseline=0 when entry close prices are null (legacy fallback)', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      // No entry close price fields (legacy position)
      const position = createMockPosition({
        entryClosePriceKalshi: null,
        entryClosePricePolymarket: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // Same behavior as without entry close prices — baseline=0
      expect(result.data.exitProximity).not.toBeNull();
    });
  });
});
