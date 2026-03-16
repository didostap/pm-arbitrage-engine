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
    getVwapClosePrice: vi.fn(),
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
    entryClosePriceKalshi: null,
    entryClosePricePolymarket: null,
    entryKalshiFeeRate: null,
    entryPolymarketFeeRate: null,
    recalculatedEdge: null,
    lastRecalculatedAt: null,
    recalculationDataSource: null,
    realizedPnl: null,
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

/** Helper to mock getVwapClosePrice for both platforms */
function mockVwapPrices(
  priceFeed: IPriceFeedService,
  kalshiPrice: string | null,
  polymarketPrice: string | null,
  opts: {
    kalshiDepthSufficient?: boolean;
    polymarketDepthSufficient?: boolean;
  } = {},
) {
  const { kalshiDepthSufficient = true, polymarketDepthSufficient = true } =
    opts;
  vi.mocked(priceFeed.getVwapClosePrice).mockImplementation(
    (
      platform: string,
    ): Promise<{ price: Decimal; depthSufficient: boolean } | null> => {
      if (platform === 'kalshi') {
        return Promise.resolve(
          kalshiPrice !== null
            ? {
                price: new Decimal(kalshiPrice),
                depthSufficient: kalshiDepthSufficient,
              }
            : null,
        );
      }
      return Promise.resolve(
        polymarketPrice !== null
          ? {
              price: new Decimal(polymarketPrice),
              depthSufficient: polymarketDepthSufficient,
            }
          : null,
      );
    },
  );
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      expect(result.errors).toBeUndefined();

      const data = result.data;

      // Verify current prices
      expect(data.currentPrices.kalshi).toBe('0.6');
      expect(data.currentPrices.polymarket).toBe('0.4');

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
      mockVwapPrices(priceFeed, '0.50', '0.50');
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
      mockVwapPrices(priceFeed, '0.60', null);

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
      expect(result.data.currentPrices.kalshi).toBe('0.6');
      expect(result.data.currentPrices.polymarket).toBeNull();
    });

    it('returns failed result when both connectors are down', async () => {
      mockVwapPrices(priceFeed, null, null);

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('failed');
      expect(result.data.currentPrices.kalshi).toBeNull();
      expect(result.data.currentPrices.polymarket).toBeNull();
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
      mockVwapPrices(priceFeed, '0.55', '0.55');
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
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
      mockVwapPrices(priceFeed, '0.55', '0.55');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({ isPaper: true });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      // Paper positions enriched same way as live
      expect(result.data.unrealizedPnl).toBeDefined();
    });

    it('includes resolutionDate and timeToResolution', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.55');
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
      mockVwapPrices(priceFeed, '0.55', '0.55');
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
    });

    it('should produce positive TP threshold for negative baseline in enrichment (6.5.5j AC4)', async () => {
      mockVwapPrices(priceFeed, '0.52', '0.49');
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

    it('should use edge-relative fallback for extreme spread in enrichment (6.5.5j AC5, 9-18)', async () => {
      mockVwapPrices(priceFeed, '0.505', '0.495');
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
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(0.9135, 3);
    });

    it('offsets exit proximity with entry cost baseline (6.5.5i, 9-18)', async () => {
      mockVwapPrices(priceFeed, '0.52', '0.46');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.53' },
        entryClosePricePolymarket: { toString: () => '0.47' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.exitProximity!.stopLoss);
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(sl.toNumber()).toBeCloseTo(0.0, 2);
      expect(tp.toNumber()).toBeCloseTo(0.00575, 3);
    });

    it('uses baseline=0 when entry close prices are null (legacy fallback)', async () => {
      mockVwapPrices(priceFeed, '0.60', '0.40');
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
      expect(oldSl.toNumber()).toBe(1); // old: WRONG — abs() made positive PnL look close to SL
      expect(newSl.toNumber()).toBe(0); // new: correct — far from SL
    });

    it('just-opened position: both proximities exactly 0', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.45');
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
      mockVwapPrices(priceFeed, '0.54', '0.46');
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
      expect(sl.toNumber()).toBeCloseTo(0.8333, 3);
      expect(tp.toNumber()).toBe(0);
    });

    it('P&L halfway to SL: SL proximity ~50%, TP ~0%', async () => {
      mockVwapPrices(priceFeed, '0.545', '0.455');
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
      mockVwapPrices(priceFeed, '0.5528', '0.4472');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0'));

      const position = createMockPosition({
        entryClosePriceKalshi: { toString: () => '0.55' },
        entryClosePricePolymarket: { toString: () => '0.45' },
        entryKalshiFeeRate: { toString: () => '0.02' },
        entryPolymarketFeeRate: { toString: () => '0.02' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const tp = new Decimal(result.data.exitProximity!.takeProfit);
      expect(tp.toNumber()).toBeCloseTo(1.0, 4);
    });

    it('zero scaledInitialEdge (zero-edge): both proximities = 0 (AC2)', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.45');
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
      mockVwapPrices(priceFeed, '0.40', '0.60');
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
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
      mockVwapPrices(priceFeed, '0.60', '0.40');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({ status: 'EXIT_PARTIAL' });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      const sl = new Decimal(result.data.projectedSlPnl!);
      const tp = new Decimal(result.data.projectedTpPnl!);
      expect(sl.toNumber()).toBeCloseTo(-2.4, 6);
      expect(tp.toNumber()).toBeCloseTo(0.96, 6);
    });

    it('should return null projectedSlPnl/projectedTpPnl when prices unavailable', async () => {
      mockVwapPrices(priceFeed, null, null);

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('failed');
      expect(result.data.projectedSlPnl).toBeUndefined();
      expect(result.data.projectedTpPnl).toBeUndefined();
    });

    it('should call getVwapClosePrice with polymarketClobTokenId (not polymarketContractId)', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.55');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      await service.enrich(position as never);

      const calls = vi.mocked(priceFeed.getVwapClosePrice).mock.calls;
      const polymarketCall = calls.find((c) => c[0] === 'polymarket');
      expect(polymarketCall).toBeDefined();
      // Must use CLOB token ID, not condition ID (polymarketContractId)
      expect(polymarketCall![1]).toBe('pm-clob-token-1');
      expect(polymarketCall![1]).not.toBe('pm-contract-1');
    });

    it('should compute projectedSlPnl with non-zero entry cost baseline', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.45');
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

    it('should produce positive TP and valid proximity when baseline dominates edge (9-18)', async () => {
      mockVwapPrices(priceFeed, '0.505', '0.495');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0'));

      const position = createMockPosition({
        expectedEdge: { toString: () => '0.02536' } as unknown,
        kalshiOrder: {
          ...createMockPosition().kalshiOrder,
          fillPrice: { toString: () => '0.50' },
          fillSize: { toString: () => '44.55' },
          side: 'buy',
        },
        polymarketOrder: {
          ...createMockPosition().polymarketOrder,
          fillPrice: { toString: () => '0.50' },
          fillSize: { toString: () => '44.55' },
          side: 'sell',
        },
        kalshiSide: 'buy',
        polymarketSide: 'sell',
        entryClosePriceKalshi: { toString: () => '0.4097' },
        entryClosePricePolymarket: { toString: () => '0.5904' },
        entryKalshiFeeRate: { toString: () => '0' },
        entryPolymarketFeeRate: { toString: () => '0' },
      });
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');

      // projectedTpPnl should be positive (not $0.00)
      const projectedTp = new Decimal(result.data.projectedTpPnl!);
      expect(projectedTp.gt(0)).toBe(true);

      // TP proximity must be in [0, 1] with no NaN
      const tpProximity = parseFloat(result.data.exitProximity!.takeProfit);
      expect(tpProximity).toBeGreaterThanOrEqual(0);
      expect(tpProximity).toBeLessThanOrEqual(1);
      expect(Number.isNaN(tpProximity)).toBe(false);
    });

    // --- New depth-sufficiency tests (AC #19) ---

    it('propagates depthSufficient=true when both platforms have sufficient depth', async () => {
      mockVwapPrices(priceFeed, '0.60', '0.40', {
        kalshiDepthSufficient: true,
        polymarketDepthSufficient: true,
      });
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      expect(result.data.currentPrices.kalshiDepthSufficient).toBe(true);
      expect(result.data.currentPrices.polymarketDepthSufficient).toBe(true);
    });

    it('propagates depthSufficient=false when Kalshi has insufficient depth', async () => {
      mockVwapPrices(priceFeed, '0.60', '0.40', {
        kalshiDepthSufficient: false,
        polymarketDepthSufficient: true,
      });
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('enriched');
      expect(result.data.currentPrices.kalshiDepthSufficient).toBe(false);
      expect(result.data.currentPrices.polymarketDepthSufficient).toBe(true);
    });

    it('defaults depthSufficient to true when VWAP returns null (unavailable platform)', async () => {
      // When a platform returns null (no order book), depth flags default to true
      // to avoid false estimation markers — prices will be null anyway
      mockVwapPrices(priceFeed, '0.60', null);

      const position = createMockPosition();
      const result = await service.enrich(position as never);

      expect(result.status).toBe('partial');
      expect(result.data.currentPrices.kalshiDepthSufficient).toBe(true);
      expect(result.data.currentPrices.polymarketDepthSufficient).toBe(true);
    });

    it('passes position fill sizes to getVwapClosePrice', async () => {
      mockVwapPrices(priceFeed, '0.55', '0.55');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition();
      await service.enrich(position as never);

      const calls = vi.mocked(priceFeed.getVwapClosePrice).mock.calls;
      // Kalshi call should pass size=100
      const kalshiCall = calls.find((c) => c[0] === 'kalshi');
      expect(kalshiCall![3].toString()).toBe('100');
      // Polymarket call should pass size=100
      const polymarketCall = calls.find((c) => c[0] === 'polymarket');
      expect(polymarketCall![3].toString()).toBe('100');
    });

    it('EXIT_PARTIAL: passes entry fill sizes (not residual) to getVwapClosePrice', async () => {
      mockVwapPrices(priceFeed, '0.60', '0.40');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const position = createMockPosition({
        status: 'EXIT_PARTIAL',
        kalshiOrderId: 'k-order-1',
        polymarketOrderId: 'pm-order-1',
      });

      const allPairOrders = [
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

      await service.enrich(position as never, allPairOrders);

      const calls = vi.mocked(priceFeed.getVwapClosePrice).mock.calls;
      // VWAP should use entry fill sizes (100), not residual (40)
      const kalshiCall = calls.find((c) => c[0] === 'kalshi');
      expect(kalshiCall![3].toString()).toBe('100');
      const polymarketCall = calls.find((c) => c[0] === 'polymarket');
      expect(polymarketCall![3].toString()).toBe('100');
    });
  });

  describe('recalculated edge from DB (Story 10.1)', () => {
    it('should read persisted recalculatedEdge and compute edgeDelta', async () => {
      const pos = createMockPosition({
        recalculatedEdge: { toString: () => '0.008' },
        lastRecalculatedAt: new Date('2026-03-16T12:00:00Z'),
        recalculationDataSource: 'websocket',
      });

      mockVwapPrices(priceFeed, '0.56', '0.44');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const result = await service.enrich(pos as never);

      expect(result.status).toBe('enriched');
      expect(result.data.recalculatedEdge).toBe('0.00800000');
      // edgeDelta = 0.008 - 0.012 = -0.004
      expect(result.data.edgeDelta).toBe('-0.00400000');
      expect(result.data.lastRecalculatedAt).toBe('2026-03-16T12:00:00.000Z');
      expect(result.data.dataSource).toBe('websocket');
    });

    it('should return null recalculatedEdge when not yet computed', async () => {
      const pos = createMockPosition({
        recalculatedEdge: null,
        lastRecalculatedAt: null,
        recalculationDataSource: null,
      });

      mockVwapPrices(priceFeed, '0.56', '0.44');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const result = await service.enrich(pos as never);

      expect(result.status).toBe('enriched');
      expect(result.data.recalculatedEdge).toBeNull();
      expect(result.data.edgeDelta).toBeNull();
      expect(result.data.lastRecalculatedAt).toBeNull();
      expect(result.data.dataSource).toBeNull();
      expect(result.data.dataFreshnessMs).toBeNull();
    });

    it('should compute dataFreshnessMs from lastRecalculatedAt', async () => {
      const recalcTime = new Date(Date.now() - 15_000); // 15s ago
      const pos = createMockPosition({
        recalculatedEdge: { toString: () => '0.008' },
        lastRecalculatedAt: recalcTime,
        recalculationDataSource: 'websocket',
      });

      mockVwapPrices(priceFeed, '0.56', '0.44');
      vi.mocked(priceFeed.getTakerFeeRate).mockReturnValue(new Decimal('0.02'));

      const result = await service.enrich(pos as never);

      expect(result.status).toBe('enriched');
      // dataFreshnessMs should be approximately 15000ms (allow 5s tolerance for test execution)
      expect(result.data.dataFreshnessMs).toBeGreaterThanOrEqual(14_000);
      expect(result.data.dataFreshnessMs).toBeLessThan(20_000);
    });
  });
});
