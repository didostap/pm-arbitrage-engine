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
      polymarketClobTokenId: 'pm-clob-token-1',
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

    it('computes exit proximity correctly (baseline-relative)', async () => {
      // Large positive P&L → take-profit proximity clamped to 1.0, SL clamped to 0.0
      // No entry close prices → baseline = 0
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = 0 + 1.2*-2 = -2.4, TP threshold = 0 + 1.2*0.80 = 0.96
      // currentPnl = 10.0 (no fees: kalshi (0.60-0.55)*100=5, poly (0.45-0.40)*100=5)
      // SL: (0 - 10) / (0 - (-2.4)) = -10/2.4 → clamp → 0
      // TP: (10 - 0) / (0.96 - 0) = 10.42 → clamp → 1.0
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
      const sl = new Decimal(proximity.stopLoss);
      const tp = new Decimal(proximity.takeProfit);
      // P&L far above baseline → SL proximity 0 (away from SL), TP clamped to 1.0
      expect(sl.toNumber()).toBeCloseTo(0.0, 4);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
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

    it('should produce positive TP threshold for negative baseline in enrichment (6.5.5j AC4)', async () => {
      // entryCostBaseline = -5.73 (same setup as threshold-evaluator AC4 test)
      // scaledInitialEdge = 0.0165 * 100 = 1.65
      // Journey TP: max(0, -5.73 + 0.80*(1.65-(-5.73))) = max(0, -5.73+5.904) = 0.174
      // currentPnl: kalshi (0.52-0.50)*100=2, poly (0.50-0.49)*100=1, fees=1.02+0.98=2.0
      // currentPnl = 2+1-2 = 1.0
      // TP proximity: (1.0-(-5.73)) / (0.174-(-5.73)) = 6.73/5.904 → clamp → 1.0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.52'));
          return Promise.resolve(new Decimal('0.49'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        expectedEdge: { toString: () => '0.0165' } as unknown,
        kalshiOrder: {
          ...createMockPosition().kalshiOrder,
          fillPrice: { toString: () => '0.50' },
          side: 'buy',
        },
        polymarketOrder: {
          ...createMockPosition().polymarketOrder,
          fillPrice: { toString: () => '0.50' },
          side: 'sell',
        },
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryClosePriceKalshi: { toString: () => '0.4714' },
        entryClosePricePolymarket: { toString: () => '0.5287' },
        entryKalshiFeeRate: { toString: () => '0' },
        entryPolymarketFeeRate: { toString: () => '0' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // TP proximity should be clamped to 1.0 (well above threshold)
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
    });

    it('should activate floor for extreme spread in enrichment (6.5.5j AC5)', async () => {
      // entryCostBaseline = -20, scaledInitialEdge = 1.0
      // Journey TP: max(0, -20 + 0.80*(1.0-(-20))) = max(0, -3.2) = 0 (floor)
      // currentPnl with slightly negative prices: -1.0
      // TP proximity: (-1.0-(-20)) / (0-(-20)) = 19/20 = 0.95
      // (position is actually 95% of the way from baseline to threshold=0)
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.505'));
          return Promise.resolve(new Decimal('0.495'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        expectedEdge: { toString: () => '0.01' } as unknown,
        kalshiOrder: {
          ...createMockPosition().kalshiOrder,
          fillPrice: { toString: () => '0.50' },
          side: 'buy',
        },
        polymarketOrder: {
          ...createMockPosition().polymarketOrder,
          fillPrice: { toString: () => '0.50' },
          side: 'sell',
        },
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryClosePriceKalshi: { toString: () => '0.40' },
        entryClosePricePolymarket: { toString: () => '0.60' },
        entryKalshiFeeRate: { toString: () => '0' },
        entryPolymarketFeeRate: { toString: () => '0' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // TP threshold = 0 (floor active)
      // currentPnl = (0.505-0.50)*100 + (0.50-0.495)*100 - fees
      //            = 0.5 + 0.5 - (0.505*100*0.02 + 0.495*100*0.02) = 1.0 - 2.0 = -1.0
      // TP proximity: (-1.0-(-20)) / (0-(-20)) = 19/20 = 0.95
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(0.95, 3);
    });

    it('offsets exit proximity with entry cost baseline (6.5.5i)', async () => {
      // Kalshi buy@0.55, entry close bid=0.53 → spread = 0.55-0.53 = 0.02
      // Poly sell@0.45, entry close ask=0.47 → spread = 0.47-0.45 = 0.02
      // spreadCost = (0.02 * 100) + (0.02 * 100) = 4.0
      // entryExitFees = (0.53 * 100 * 0.02) + (0.47 * 100 * 0.02) = 1.06 + 0.94 = 2.0
      // entryCostBaseline = -(4.0 + 2.0) = -6.0
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = -6.0 + 1.2*-2 = -8.4
      // TP threshold (6.5.5j journey): max(0, -6.0 + 0.80*(1.2-(-6.0))) = max(0, -6.0+5.76) = max(0, -0.24) = 0.00 (floor)
      //
      // currentPnl = -5.96 (see computation below)
      // Baseline-relative SL: (-6.0 - (-5.96)) / (-6.0 - (-8.4)) = -0.04/2.4 → clamp → 0
      // Baseline-relative TP: (-5.96 - (-6.0)) / (0.00 - (-6.0)) = 0.04/6.0 ≈ 0.00667
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
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
      // Position just opened (currentPnl ≈ baseline) — both proximities near 0
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(sl.toNumber()).toBeCloseTo(0.0, 2);
      expect(tp.toNumber()).toBeCloseTo(0.00667, 3);
    });

    it('uses baseline=0 when entry close prices are null (legacy fallback)', async () => {
      // Legacy position: baseline=0
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = 0 + 1.2*-2 = -2.4, TP threshold = 0 + 1.2*0.80 = 0.96
      // currentPnl = 8.0 (kalshi (0.60-0.55)*100=5, poly (0.45-0.40)*100=5, fees=2.0)
      //
      // New formula with baseline=0:
      //   SL: (0 - 8.0) / (0 - (-2.4)) = -8.0/2.4 → clamp → 0
      //   TP: (8.0 - 0) / (0.96 - 0) = 8.33 → clamp → 1.0
      //
      // Old formula:
      //   SL: |8.0 / -2.4| = 3.33 → clamp → 1.0 (note: old formula gives wrong result for positive PnL)
      //   TP: 8.0 / 0.96 = 8.33 → clamp → 1.0
      //
      // Algebraic equivalence for legacy (baseline=0):
      //   New SL numerator: (0 - currentPnl) = -currentPnl
      //   New SL denominator: (0 - slThreshold) = -slThreshold
      //   Result: -currentPnl / -slThreshold = currentPnl / slThreshold
      //   Old formula: currentPnl.div(slThreshold).abs()
      //   Since both currentPnl and slThreshold are negative when approaching SL,
      //   currentPnl/slThreshold is positive → abs() is identity → formulas agree.
      //
      //   New TP: (currentPnl - 0) / (tpThreshold - 0) = currentPnl / tpThreshold
      //   Old TP: currentPnl / tpThreshold → identical.
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
      expect(result.data.exitProximity).not.toBeNull();

      // Verify algebraic equivalence: new formula with baseline=0 produces same
      // values as old formula for the negative-PnL case (SL approach)
      const currentPnl = new Decimal('8.0');
      const slThreshold = new Decimal('-2.4');
      const tpThreshold = new Decimal('0.96');
      const baseline = new Decimal('0');

      // Old formula values
      const oldSl = Decimal.min(
        new Decimal(1),
        Decimal.max(new Decimal(0), currentPnl.div(slThreshold).abs()),
      );
      const oldTp = Decimal.min(
        new Decimal(1),
        Decimal.max(new Decimal(0), currentPnl.div(tpThreshold)),
      );

      // New formula values
      const newSl = Decimal.min(
        new Decimal(1),
        Decimal.max(
          new Decimal(0),
          baseline.minus(currentPnl).div(baseline.minus(slThreshold)),
        ),
      );
      const newTp = Decimal.min(
        new Decimal(1),
        Decimal.max(
          new Decimal(0),
          currentPnl.minus(baseline).div(tpThreshold.minus(baseline)),
        ),
      );

      // TP formulas are algebraically identical for baseline=0
      expect(newTp.eq(oldTp)).toBe(true);
      // SL: new formula gives currentPnl/slThreshold (no abs), old uses abs()
      // When currentPnl > 0 and slThreshold < 0: ratio is negative → new clamps to 0, old abs → positive
      // The new formula is CORRECT here (positive PnL means far from SL → 0%)
      // The old formula was wrong (abs made it look close to SL)
      expect(oldSl.toNumber()).toBe(1); // old: WRONG — abs() made positive PnL look close to SL
      expect(newSl.toNumber()).toBe(0); // new: correct — far from SL
    });

    it('just-opened position: both proximities exactly 0', async () => {
      // Current prices === entry prices → PnL = 0 (before fees)
      // With fees, PnL is slightly negative, but entry close prices match current
      // so entryCostBaseline offsets this exactly
      //
      // Setup: entry at 0.55/0.45, current close at 0.55/0.45 (no price movement)
      // entryCostBaseline = -(spreadCost + exitFees)
      //   spreadCost: kalshi buy@0.55, close=0.55 → spread=0; poly sell@0.45, close=0.45 → spread=0
      //   exitFees: 0.55*100*0.02 + 0.45*100*0.02 = 1.10 + 0.90 = 2.0
      //   entryCostBaseline = -(0 + 2.0) = -2.0
      // currentPnl: kalshi (0.55-0.55)*100=0, poly (0.45-0.45)*100=0, exitFees=2.0 → -2.0
      // currentPnl == entryCostBaseline → both proximities exactly 0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.55'));
          return Promise.resolve(new Decimal('0.45'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(sl.toNumber()).toBe(0);
      expect(tp.toNumber()).toBe(0);
    });

    it('just-opened with small price drift: both proximities small but nonzero', async () => {
      // Entry at 0.55/0.45, entry close same, current close drifts slightly against us
      // kalshi close 0.54 (bid dropped slightly), poly close 0.46 (ask rose slightly)
      // entryCostBaseline = -2.0 (same as above: no spread at entry, fees only)
      // currentPnl: kalshi (0.54-0.55)*100=-1, poly (0.45-0.46)*100=-1
      //   exitFees: 0.54*100*0.02 + 0.46*100*0.02 = 1.08+0.92 = 2.0
      //   currentPnl = -1 + -1 - 2.0 = -4.0
      // scaledInitialEdge = 1.2
      // SL threshold = -2.0 + 1.2*-2 = -4.4
      // TP threshold (6.5.5j journey): max(0, -2.0 + 0.80*(1.2-(-2.0))) = max(0, -2.0+2.56) = 0.56
      // SL: (-2.0 - (-4.0)) / (-2.0 - (-4.4)) = 2.0/2.4 ≈ 0.8333
      // TP: (-4.0 - (-2.0)) / (0.56 - (-2.0)) = -2.0/2.56 → clamp → 0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.54'));
          return Promise.resolve(new Decimal('0.46'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      // Moved toward SL — nonzero SL proximity
      expect(sl.toNumber()).toBeCloseTo(0.8333, 3);
      // Moved away from TP — clamped to 0
      expect(tp.toNumber()).toBe(0);
    });

    it('P&L halfway to SL: SL proximity ~50%, TP ~0%', async () => {
      // entryCostBaseline = -2.0 (no spread, fees only — same entry close setup)
      // scaledInitialEdge = 1.2
      // SL threshold = -2.0 + 1.2*-2 = -4.4
      // Halfway: currentPnl = -2.0 + (-4.4 - (-2.0))/2 = -2.0 + (-1.2) = -3.2
      // Need prices that give currentPnl = -3.2
      // kalshi (close-0.55)*100 + (0.45-close)*100 - exitFees = -3.2
      // Try kalshi close=0.545, poly close=0.455
      // kalshi: (0.545-0.55)*100 = -0.5, poly: (0.45-0.455)*100 = -0.5
      // exitFees: 0.545*100*0.02 + 0.455*100*0.02 = 1.09+0.91 = 2.0
      // currentPnl = -0.5 + -0.5 - 2.0 = -3.0 (not exactly -3.2)
      // SL: (-2.0 - (-3.0)) / (-2.0 - (-4.4)) = 1.0/2.4 ≈ 0.4167
      // TP (6.5.5j): (-3.0 - (-2.0)) / (0.56 - (-2.0)) = -1.0/2.56 → clamp → 0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.545'));
          return Promise.resolve(new Decimal('0.455'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(sl.toNumber()).toBeCloseTo(0.4167, 3);
      expect(tp.toNumber()).toBe(0);
    });

    it('P&L at TP threshold with non-zero baseline: TP proximity = 100%', async () => {
      // entryCostBaseline = -2.0 (no spread at entry, fees only)
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // TP threshold (6.5.5j journey): max(0, -2.0 + 0.80*(1.2-(-2.0))) = max(0, -2.0+2.56) = 0.56
      // Need currentPnl = 0.56 (at TP threshold exactly)
      // With 0% exit fee rate:
      //   kalshi (close-0.55)*100 + (0.45-close)*100 = 0.56
      //   (kalshiClose - polyClose - 0.10)*100 = 0.56
      //   kalshiClose - polyClose = 0.1056
      //   e.g. kalshi=0.5528, poly=0.4472
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.5528'));
          return Promise.resolve(new Decimal('0.4472'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // currentPnl = (0.5528-0.55)*100 + (0.45-0.4472)*100 = 0.28+0.28 = 0.56
      // baseline = -2.0, TP threshold = 0.56
      // TP: (0.56 - (-2.0)) / (0.56 - (-2.0)) = 2.56/2.56 = 1.0
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
    });

    it('zero scaledInitialEdge (zero-edge): both proximities = 0 (AC2)', async () => {
      // expectedEdge = 0 → scaledInitialEdge = 0
      // baseline = -2.0 (with entry close prices)
      // SL threshold = -2.0 + 0*-2 = -2.0 (== baseline)
      // TP threshold (6.5.5j journey): max(0, -2.0 + 0.80*(0-(-2.0))) = max(0, -0.4) = 0
      // SL denominator: baseline - SL = -2.0 - (-2.0) = 0 → division-by-zero guard → 0
      // TP denominator: TP - baseline = 0 - (-2.0) = 2.0 → numerator: -2.0-(-2.0) = 0 → 0/2.0 = 0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.55'));
          return Promise.resolve(new Decimal('0.45'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        expectedEdge: { toString: () => '0' } as unknown,
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(sl.toNumber()).toBe(0);
      expect(tp.toNumber()).toBe(0);
      // Verify no NaN or Infinity
      expect(sl.isFinite()).toBe(true);
      expect(tp.isFinite()).toBe(true);
    });

    it('clamping: beyond threshold clamps to 1.0, opposite direction clamps to 0.0', async () => {
      // Set up a position deep past SL threshold
      // baseline = 0 (no entry close prices), SL = -2.4, TP = 0.96
      // currentPnl deeply negative (beyond SL)
      // kalshi close=0.40 (dropped a lot), poly close=0.60 (rose a lot)
      // kalshi: (0.40-0.55)*100 = -15, poly: (0.45-0.60)*100 = -15
      // exitFees: 0.40*100*0.02 + 0.60*100*0.02 = 0.80+1.20 = 2.0
      // currentPnl = -15 + -15 - 2.0 = -32.0
      // SL: (0 - (-32.0)) / (0 - (-2.4)) = 32/2.4 = 13.33 → clamp → 1.0
      // TP: (-32.0 - 0) / (0.96 - 0) = -33.33 → clamp → 0.0
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.40'));
          return Promise.resolve(new Decimal('0.60'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      // Beyond SL → clamped to 1.0
      expect(sl.toNumber()).toBe(1);
      // Opposite direction of TP → clamped to 0.0
      expect(tp.toNumber()).toBe(0);
    });

    it('should include projectedSlPnl and projectedTpPnl for OPEN positions', async () => {
      // Setup: same as first test, zero entry close prices → baseline = 0
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = 0 + 1.2*-2 = -2.4
      // TP threshold = max(0, 0 + 0.80*(1.2 - 0)) = 0.96
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
      expect(result.data.projectedSlPnl).toBeDefined();
      expect(result.data.projectedTpPnl).toBeDefined();

      const sl = new Decimal(result.data.projectedSlPnl!);
      const tp = new Decimal(result.data.projectedTpPnl!);

      // SL threshold = -2.4
      expect(sl.toNumber()).toBeCloseTo(-2.4, 6);
      // TP threshold = 0.96
      expect(tp.toNumber()).toBeCloseTo(0.96, 6);
    });

    it('EXIT_PARTIAL: uses residual size for SL/TP thresholds', async () => {
      // Entry: 100 contracts each side. After partial exit of 60 per side, residual = 40.
      // scaledInitialEdge (residual) = 0.012 * 40 = 0.48
      // baseline = 0 (no entry close prices)
      // SL threshold = 0 + 0.48*-2 = -0.96
      // TP threshold = max(0, 0 + 0.80*(0.48 - 0)) = 0.384
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
        kalshiOrderId: 'k-order-1',
        polymarketOrderId: 'pm-order-1',
      });

      const allPairOrders = [
        // Entry orders (excluded by getResidualSize)
        {
          orderId: 'k-order-1',
          platform: 'KALSHI',
          fillSize: { toString: () => '100' },
        },
        {
          orderId: 'pm-order-1',
          platform: 'POLYMARKET',
          fillSize: { toString: () => '100' },
        },
        // Exit orders (60 contracts each)
        {
          orderId: 'exit-k-1',
          platform: 'KALSHI',
          fillSize: { toString: () => '60' },
        },
        {
          orderId: 'exit-pm-1',
          platform: 'POLYMARKET',
          fillSize: { toString: () => '60' },
        },
      ];

      const result = await service.enrich(position as never, allPairOrders);

      expect(result.status).toBe('enriched');

      // Verify residual-based thresholds
      const sl = new Decimal(result.data.projectedSlPnl!);
      const tp = new Decimal(result.data.projectedTpPnl!);
      expect(sl.toNumber()).toBeCloseTo(-0.96, 6);
      expect(tp.toNumber()).toBeCloseTo(0.384, 6);
    });

    it('EXIT_PARTIAL: falls back to full size when no allPairOrders provided', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.60'));
          return Promise.resolve(new Decimal('0.40'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // Without allPairOrders, uses full legSize=100
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = 1.2*-2 = -2.4, TP threshold = 0.96
      const sl = new Decimal(result.data.projectedSlPnl!);
      const tp = new Decimal(result.data.projectedTpPnl!);
      expect(sl.toNumber()).toBeCloseTo(-2.4, 6);
      expect(tp.toNumber()).toBeCloseTo(0.96, 6);
    });

    it('should return null projectedSlPnl/projectedTpPnl when prices unavailable', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(null);

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('failed');
      expect(result.data.projectedSlPnl).toBeUndefined();
      expect(result.data.projectedTpPnl).toBeUndefined();
    });

    it('should call getCurrentClosePrice with polymarketClobTokenId (not polymarketContractId)', async () => {
      vi.mocked(priceFeed.getCurrentClosePrice).mockResolvedValue(
        new Decimal('0.55'),
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      await service.enrich(position as never);

      const calls = vi.mocked(priceFeed.getCurrentClosePrice).mock.calls;
      const polymarketCall = calls.find((c) => c[0] === 'polymarket');
      expect(polymarketCall).toBeDefined();
      // Must use CLOB token ID, not condition ID (polymarketContractId)
      expect(polymarketCall![1]).toBe('pm-clob-token-1');
      expect(polymarketCall![1]).not.toBe('pm-contract-1');
    });

    it('should compute projectedSlPnl with non-zero entry cost baseline', async () => {
      // Same setup as 6.5.5i test:
      // entryCostBaseline = -2.0 (no spread at entry, fees only)
      // scaledInitialEdge = 0.012 * 100 = 1.2
      // SL threshold = -2.0 + 1.2*-2 = -4.4
      // TP threshold (6.5.5j journey): max(0, -2.0 + 0.80*(1.2-(-2.0))) = max(0, -2.0+2.56) = 0.56
      vi.mocked(priceFeed.getCurrentClosePrice).mockImplementation(
        (platform: string): Promise<Decimal | null> => {
          if (platform === 'kalshi')
            return Promise.resolve(new Decimal('0.55'));
          return Promise.resolve(new Decimal('0.45'));
        },
      );
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.projectedSlPnl!);
      const tp = new Decimal(result.data.projectedTpPnl!);

      // SL = -4.4
      expect(sl.toNumber()).toBeCloseTo(-4.4, 6);
      // TP = 0.56
      expect(tp.toNumber()).toBeCloseTo(0.56, 6);
    });
  });
});
