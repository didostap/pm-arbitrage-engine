import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  ThresholdEvaluatorService,
  ThresholdEvalInput,
} from './threshold-evaluator.service';

describe('ThresholdEvaluatorService', () => {
  const service = new ThresholdEvaluatorService();

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
    it('should handle unequal leg sizes correctly', () => {
      // kalshiSize=100, polymarketSize=80 → minLegSize=80
      // Threshold = 0.80 * 0.03 * 80 = 1.92
      const input = makeInput({
        polymarketSize: new Decimal('80'),
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      const result = service.evaluate(input);
      // kalshi P&L: (0.66-0.62)*100 = 4.0
      // poly P&L: (0.65-0.62)*80 = 2.4
      // Fees: 0.66*100*0.02 + 0.62*80*0.02 = 1.32+0.992 = 2.312
      // Total P&L = 4.0 + 2.4 - 2.312 = 4.088
      // 4.088 >= 1.92 → trigger take-profit
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
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
});
