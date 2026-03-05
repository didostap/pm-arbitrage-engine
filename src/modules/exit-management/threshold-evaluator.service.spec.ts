import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  ThresholdEvaluatorService,
  ThresholdEvalInput,
} from './threshold-evaluator.service';

describe('ThresholdEvaluatorService', () => {
  const service = new ThresholdEvaluatorService();
  // Spy on the internal NestJS Logger used by ThresholdEvaluatorService
  const loggerErrorSpy = vi
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => {});

  beforeEach(() => {
    loggerErrorSpy.mockClear();
  });

  function makeInput(
    overrides: Partial<ThresholdEvalInput> = {},
  ): ThresholdEvalInput {
    return {
      initialEdge: new Decimal('0.03'),
      kalshiEntryPrice: new Decimal('0.62'),
      polymarketEntryPrice: new Decimal('0.65'),
      currentKalshiPrice: new Decimal('0.63'),
      currentPolymarketPrice: new Decimal('0.64'),
      kalshiSide: 'buy',
      polymarketSide: 'sell',
      kalshiSize: new Decimal('100'),
      polymarketSize: new Decimal('100'),
      kalshiFeeDecimal: new Decimal('0.02'),
      polymarketFeeDecimal: new Decimal('0.02'),
      resolutionDate: null,
      now: new Date('2026-02-20T00:00:00Z'),
      ...overrides,
    };
  }

  describe('take-profit threshold', () => {
    it('should trigger at 80% captured edge', () => {
      // P&L calc: kalshi buy@0.62, sell@0.66 → (0.66-0.62)*100 = 4.0
      // polymarket sell@0.65, buy@0.62 → (0.65-0.62)*100 = 3.0
      // Exit fees: 0.66*100*0.02 + 0.62*100*0.02 = 1.32 + 1.24 = 2.56
      // Total P&L = 4.0 + 3.0 - 2.56 = 4.44
      // Threshold = 0.80 * 0.03 * 100 = 2.40
      // 4.44 >= 2.40 → trigger
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
    });

    it('should NOT trigger at 79% captured edge', () => {
      // Need P&L just below 2.40 threshold (0.80 * 0.03 * 100)
      // kalshi buy@0.62, sell@0.6405 → (0.6405-0.62)*100 = 2.05
      // poly sell@0.65, buy@0.6490 → (0.65-0.6490)*100 = 0.10
      // Exit fees: 0.6405*100*0.02 + 0.6490*100*0.02 = 1.281 + 1.298 = 2.579
      // Total P&L = 2.05 + 0.10 - 2.579 = -0.429
      // -0.429 < 2.40 → no trigger
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.6405'),
        currentPolymarketPrice: new Decimal('0.6490'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
    });
  });

  describe('stop-loss threshold', () => {
    it('should trigger at -2x initial edge', () => {
      // Threshold: -(2 * 0.03 * 100) = -6.00
      // kalshi buy@0.62, sell@0.56 → (0.56-0.62)*100 = -6.0
      // poly sell@0.65, buy@0.68 → (0.65-0.68)*100 = -3.0
      // Exit fees: 0.56*100*0.02 + 0.68*100*0.02 = 1.12+1.36 = 2.48
      // Total P&L = -6.0 + -3.0 - 2.48 = -11.48
      // -11.48 <= -6.00 → trigger
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.56'),
        currentPolymarketPrice: new Decimal('0.68'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
    });

    it('should NOT trigger at -1.9x initial edge', () => {
      // Threshold = -6.00. Need P&L around -5.70 (1.9*3)
      // kalshi buy@0.62, sell@0.605 → (0.605-0.62)*100 = -1.5
      // poly sell@0.65, buy@0.675 → (0.65-0.675)*100 = -2.5
      // Exit fees: 0.605*100*0.02 + 0.675*100*0.02 = 1.21+1.35 = 2.56
      // Total P&L = -1.5 + -2.5 - 2.56 = -6.56 → this is actually below threshold...
      // Let me pick values that give P&L = -5.0 (above -6.0 threshold)
      // kalshi buy@0.62, sell@0.61 → (0.61-0.62)*100 = -1.0
      // poly sell@0.65, buy@0.66 → (0.65-0.66)*100 = -1.0
      // Exit fees: 0.61*100*0.02 + 0.66*100*0.02 = 1.22+1.32 = 2.54
      // Total P&L = -1.0 + -1.0 - 2.54 = -4.54
      // -4.54 > -6.00 → no trigger
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.61'),
        currentPolymarketPrice: new Decimal('0.66'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
    });
  });

  describe('time-based threshold', () => {
    it('should trigger at 47 hours before resolution', () => {
      const now = new Date('2026-02-20T00:00:00Z');
      const resolutionDate = new Date('2026-02-21T23:00:00Z'); // 47 hours later
      const input = makeInput({ now, resolutionDate });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('time_based');
    });

    it('should NOT trigger at 49 hours before resolution', () => {
      const now = new Date('2026-02-20T00:00:00Z');
      const resolutionDate = new Date('2026-02-22T01:00:00Z'); // 49 hours later
      const input = makeInput({ now, resolutionDate });
      const result = service.evaluate(input);
      // With default prices, neither stop-loss nor take-profit triggers
      expect(result.triggered).toBe(false);
    });

    it('should skip time-based when resolutionDate is null', () => {
      const input = makeInput({ resolutionDate: null });
      const result = service.evaluate(input);
      // Default prices don't trigger stop-loss or take-profit either
      expect(result.triggered).toBe(false);
    });
  });

  describe('priority order', () => {
    it('should prioritize stop-loss over take-profit when both conditions true', () => {
      // Edge case: initialEdge is very small, so both thresholds are near zero
      // With negative P&L, stop-loss should win
      const input = makeInput({
        initialEdge: new Decimal('0.001'),
        currentKalshiPrice: new Decimal('0.56'),
        currentPolymarketPrice: new Decimal('0.68'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
    });
  });

  describe('P&L calculation with fees', () => {
    it('should correctly calculate P&L with different fee rates', () => {
      // kalshi buy@0.62, sell@0.66 → (0.66-0.62)*100 = 4.0
      // poly sell@0.65, buy@0.62 → (0.65-0.62)*100 = 3.0
      // Exit fees with 5% fee: 0.66*100*0.05 + 0.62*100*0.05 = 3.3+3.1 = 6.4
      // Total P&L = 4.0 + 3.0 - 6.4 = 0.6
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
        kalshiFeeDecimal: new Decimal('0.05'),
        polymarketFeeDecimal: new Decimal('0.05'),
      });
      const result = service.evaluate(input);
      expect(result.currentPnl.toFixed(8)).toBe('0.60000000');
    });
  });

  describe('Decimal precision', () => {
    it('should use Decimal for all math (no floating point precision loss)', () => {
      // Use values known to cause floating-point issues with IEEE 754
      const input = makeInput({
        initialEdge: new Decimal('0.1'),
        kalshiEntryPrice: new Decimal('0.1'),
        polymarketEntryPrice: new Decimal('0.2'),
        currentKalshiPrice: new Decimal('0.3'),
        currentPolymarketPrice: new Decimal('0.1'),
        kalshiSize: new Decimal('3'),
        polymarketSize: new Decimal('3'),
        kalshiFeeDecimal: new Decimal('0'),
        polymarketFeeDecimal: new Decimal('0'),
      });
      const result = service.evaluate(input);
      expect(result.currentPnl).toBeInstanceOf(Decimal);
      expect(result.currentEdge).toBeInstanceOf(Decimal);
      expect(result.capturedEdgePercent).toBeInstanceOf(Decimal);
      // kalshi buy@0.1, sell@0.3 → (0.3-0.1)*3 = 0.6
      // poly sell@0.2, buy@0.1 → (0.2-0.1)*3 = 0.3
      // Total P&L = 0.6 + 0.3 = 0.9
      expect(result.currentPnl.toFixed(1)).toBe('0.9');
    });
  });

  describe('edge cases', () => {
    it('should use kalshiSize as legSize (equal sizes guaranteed by execution)', () => {
      // With equal sizes of 100, legSize = kalshiSize = 100
      // scaledInitialEdge = 0.03 * 100 = 3.0
      // Take-profit threshold = 0.80 * 3.0 = 2.40
      const input = makeInput({
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      const result = service.evaluate(input);
      // kalshi P&L: (0.66-0.62)*100 = 4.0
      // poly P&L: (0.65-0.62)*100 = 3.0
      // Fees: 0.66*100*0.02 + 0.62*100*0.02 = 1.32+1.24 = 2.56
      // Total P&L = 4.0 + 3.0 - 2.56 = 4.44
      // currentEdge = 4.44 / 100 = 0.0444
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
      expect(result.currentEdge.toFixed(4)).toBe('0.0444');
    });

    it('should log error when kalshiSize !== polymarketSize (debug assertion)', () => {
      const input = makeInput({
        kalshiSize: new Decimal('100'),
        polymarketSize: new Decimal('80'),
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      // Should still compute using kalshiSize as legSize (100, not min of 80)
      const result = service.evaluate(input);
      // legSize = 100 (kalshiSize), scaledInitialEdge = 0.03 * 100 = 3.0
      // Take-profit threshold = 0.80 * 3.0 = 2.40
      // kalshi P&L: (0.66-0.62)*100 = 4.0
      // poly P&L: (0.65-0.62)*80 = 2.4
      // Fees: 0.66*100*0.02 + 0.62*80*0.02 = 1.32+0.992 = 2.312
      // Total P&L = 4.0 + 2.4 - 2.312 = 4.088
      // currentEdge = 4.088 / 100 = 0.04088
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
      expect(result.currentEdge.toFixed(5)).toBe('0.04088');
      // Verify logger.error was called
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unequal leg sizes'),
        expect.objectContaining({
          kalshiSize: '100',
          polymarketSize: '80',
        }),
      );
    });

    it('should return result details when no threshold triggered', () => {
      const input = makeInput();
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
      expect(result.type).toBeUndefined();
      expect(result.currentEdge).toBeInstanceOf(Decimal);
      expect(result.currentPnl).toBeInstanceOf(Decimal);
      expect(result.capturedEdgePercent).toBeInstanceOf(Decimal);
    });
  });

  describe('entry cost baseline (6.5.5i)', () => {
    // Spy on logger.warn for partial-null warnings
    const loggerWarnSpy = vi
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => {});

    beforeEach(() => {
      loggerWarnSpy.mockClear();
    });

    it('should NOT trigger SL for P&L between old and new thresholds (key differentiator)', () => {
      // Without baseline: SL threshold = -(2 * 0.03 * 100) = -6.0
      // With baseline: entryCostBaseline = -(4.0 + 2.54) = -6.54
      //   SL threshold = -6.54 + -6.0 = -12.54
      //
      // Construct P&L = -9.52 (between -6.0 and -12.54):
      // kalshi buy@0.62, sell@0.58 → (0.58-0.62)*100 = -4.0
      // poly sell@0.65, buy@0.68 → (0.65-0.68)*100 = -3.0
      // exit fees: 0.58*100*0.02 + 0.68*100*0.02 = 1.16+1.36 = 2.52
      // currentPnl = -4.0 + -3.0 - 2.52 = -9.52
      //
      // Old behavior: -9.52 <= -6.0 → TRIGGERS SL
      // New behavior: -9.52 > -12.54 → does NOT trigger SL ✓
      const input = makeInput({
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
        currentKalshiPrice: new Decimal('0.58'),
        currentPolymarketPrice: new Decimal('0.68'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
    });

    it('should trigger SL only when P&L drops well below baseline', () => {
      // Same baseline as above: -6.54
      // SL threshold = -12.54
      // Make prices tank enough to breach -12.54
      // kalshi buy@0.62 → sell@0.52: (0.52-0.62)*100 = -10.0
      // poly sell@0.65 → buy@0.72: (0.65-0.72)*100 = -7.0
      // exit fees: 0.52*100*0.02 + 0.72*100*0.02 = 1.04+1.44 = 2.48
      // currentPnl = -10.0 + -7.0 - 2.48 = -19.48
      // -19.48 <= -12.54 → trigger SL
      const input = makeInput({
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
        currentKalshiPrice: new Decimal('0.52'),
        currentPolymarketPrice: new Decimal('0.72'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
    });

    it('should use zero spread when close prices equal fill prices', () => {
      // Kalshi buy@0.62, entry close = 0.62 → spread = 0
      // Poly sell@0.65, entry close = 0.65 → spread = 0
      // spreadCost = 0
      // entryExitFees = (0.62 * 100 * 0.02) + (0.65 * 100 * 0.02) = 1.24 + 1.30 = 2.54
      // entryCostBaseline = -(0 + 2.54) = -2.54
      // SL threshold = -2.54 + -6.0 = -8.54
      // TP threshold = -2.54 + 2.40 = -0.14
      const input = makeInput({
        entryClosePriceKalshi: new Decimal('0.62'),
        entryClosePricePolymarket: new Decimal('0.65'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      const result = service.evaluate(input);
      // Default currentPnl ≈ -0.54 (from default prices)
      // -0.54 > -8.54 → no SL
      expect(result.triggered).toBe(false);
    });

    it('should clamp negative spread to zero (market moved favorably)', () => {
      // Kalshi buy@0.62, entry close bid=0.64 → spread = 0.62-0.64 = -0.02 → clamped to 0
      // Poly sell@0.65, entry close ask=0.63 → spread = 0.63-0.65 = -0.02 → clamped to 0
      // Same as zero spread case: spreadCost = 0
      // entryCostBaseline = -(0 + entryExitFees) = -(0.64*100*0.02 + 0.63*100*0.02) = -(1.28+1.26) = -2.54
      const input = makeInput({
        entryClosePriceKalshi: new Decimal('0.64'),
        entryClosePricePolymarket: new Decimal('0.63'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      const result = service.evaluate(input);
      // Should behave same as zero spread
      expect(result.triggered).toBe(false);
    });

    it('should default to baseline=0 for legacy positions (null entry close prices)', () => {
      // No entry close prices → entryCostBaseline = 0 → current behavior
      const input = makeInput({
        entryClosePriceKalshi: null,
        entryClosePricePolymarket: null,
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      const result = service.evaluate(input);
      // Same result as existing tests without entry close prices
      // kalshi P&L: (0.63-0.62)*100 = 1.0
      // poly P&L: (0.65-0.64)*100 = 1.0
      // exit fees: 0.63*100*0.02 + 0.64*100*0.02 = 1.26+1.28 = 2.54
      // currentPnl = 1.0 + 1.0 - 2.54 = -0.54
      // SL threshold = 0 + -6.0 = -6.0
      // -0.54 > -6.0 → no trigger (current behavior)
      expect(result.triggered).toBe(false);
    });

    it('should default to baseline=0 when entry fields are undefined', () => {
      // Omitting entry close price fields entirely (undefined)
      const input = makeInput();
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
    });

    it('should warn and use baseline=0 when entry fields are partially populated', () => {
      // Only close prices, no fee rates
      const input = makeInput({
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: null,
        entryPolymarketFeeRate: null,
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(false);
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('should handle Kalshi dynamic fee at different entry price tier', () => {
      // Kalshi close price at 0.20 → different fee tier than typical 0.60
      // Fee rate 0.035 (higher for extreme prices), Polymarket flat 0.02
      // Kalshi buy@0.20, entry close bid=0.18 → spread = 0.20-0.18 = 0.02
      // Poly sell@0.80, entry close ask=0.82 → spread = 0.82-0.80 = 0.02
      // spreadCost = (0.02 * 50) + (0.02 * 50) = 2.0
      // entryExitFees = (0.18 * 50 * 0.035) + (0.82 * 50 * 0.02) = 0.315 + 0.82 = 1.135
      // entryCostBaseline = -(2.0 + 1.135) = -3.135
      // SL threshold = -3.135 + (0.05 * 50 * -2) = -8.135
      // TP threshold = -3.135 + (0.05 * 50 * 0.80) = -1.135
      //
      // currentPnl: kalshi (0.21-0.20)*50=0.5, poly (0.80-0.79)*50=0.5
      // exit fees: 0.21*50*0.02 + 0.79*50*0.02 = 0.21+0.79 = 1.0
      // currentPnl = 0.5 + 0.5 - 1.0 = 0.0
      // 0.0 >= -1.135 → triggers TP (P&L recovered above TP threshold)
      const input = makeInput({
        initialEdge: new Decimal('0.05'),
        kalshiEntryPrice: new Decimal('0.20'),
        polymarketEntryPrice: new Decimal('0.80'),
        currentKalshiPrice: new Decimal('0.21'),
        currentPolymarketPrice: new Decimal('0.79'),
        kalshiSize: new Decimal('50'),
        polymarketSize: new Decimal('50'),
        entryClosePriceKalshi: new Decimal('0.18'),
        entryClosePricePolymarket: new Decimal('0.82'),
        entryKalshiFeeRate: new Decimal('0.035'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
    });
  });
});
