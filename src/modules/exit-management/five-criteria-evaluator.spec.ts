import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
  ThresholdEvaluatorService,
  ThresholdEvalInput,
} from './threshold-evaluator.service';
import type { CriterionResult } from '../../common/types/exit-criteria.types';

describe('ThresholdEvaluatorService — Six-Criteria Model-Driven Exit (Story 10.2)', () => {
  const service = new ThresholdEvaluatorService();
  const loggerWarnSpy = vi
    .spyOn(service['logger'], 'warn')
    .mockImplementation(() => {});
  const loggerErrorSpy = vi
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => {});

  beforeEach(() => {
    loggerWarnSpy.mockClear();
    loggerErrorSpy.mockClear();
  });

  /**
   * Factory for ThresholdEvalInput with sensible defaults.
   * New Story 10.2 fields default to null/undefined to preserve backward compat.
   */
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
      now: new Date('2026-03-20T00:00:00Z'),
      // Story 10.2 fields — default to null/undefined
      entryConfidenceScore: null,
      currentConfidenceScore: null,
      kalshiExitDepth: null,
      polymarketExitDepth: null,
      portfolioRiskApproaching: false,
      edgeRankAmongOpen: undefined,
      totalOpenPositions: undefined,
      exitMode: undefined,
      ...overrides,
    };
  }

  // ==========================================================================
  // C1 — Edge evaporation
  // ==========================================================================
  describe('C1 — Edge evaporation', () => {
    it('[P0] should trigger when PnL drops below edge evaporation threshold', () => {
      // Edge evaporation threshold = entryCostBaseline + (scaledInitialEdge * -1.0)
      // With dramatically adverse prices, PnL falls well below threshold.
      // kalshi buy@0.62, sell@0.52 => (0.52-0.62)*100 = -10.0
      // poly sell@0.65, buy@0.75 => (0.65-0.75)*100 = -10.0
      // fees: 0.52*100*0.02 + 0.75*100*0.02 = 1.04 + 1.50 = 2.54
      // currentPnl = -10.0 + -10.0 - 2.54 = -22.54 (well below threshold)
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.52'),
        currentPolymarketPrice: new Decimal('0.75'),
      });
      const result = service.evaluateModelDriven(input);
      expect(result.triggered).toBe(true);
      const c1 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'edge_evaporation',
      );
      expect(c1).toBeDefined();
      expect(c1!.triggered).toBe(true);
      expect(c1!.proximity.gte(new Decimal('1.0'))).toBe(true);
    });

    it('[P0] should NOT trigger when edge is well above breakeven', () => {
      // Prices have moved favorably — substantial positive PnL above threshold
      // kalshi buy@0.62, sell@0.66 => (0.66-0.62)*100 = 4.0
      // poly sell@0.65, buy@0.62 => (0.65-0.62)*100 = 3.0
      // fees: 0.66*100*0.02 + 0.62*100*0.02 = 1.32 + 1.24 = 2.56
      // currentPnl = 4.0 + 3.0 - 2.56 = 4.44 (well above any breakeven threshold)
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      const result = service.evaluateModelDriven(input);
      const c1 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'edge_evaporation',
      );
      expect(c1).toBeDefined();
      expect(c1!.triggered).toBe(false);
      expect(c1!.proximity.lt(new Decimal('1.0'))).toBe(true);
    });

    it('[P1] should trigger with entry cost baseline offset when PnL well below threshold', () => {
      // With entry close prices creating a substantial entry cost baseline,
      // the threshold shifts further negative. Need large adverse move to trigger.
      // kalshi buy@0.62, sell@0.50 => (0.50-0.62)*100 = -12.0
      // poly sell@0.65, buy@0.78 => (0.65-0.78)*100 = -13.0
      // fees: 0.50*100*0.02 + 0.78*100*0.02 = 1.00 + 1.56 = 2.56
      // currentPnl = -12.0 + -13.0 - 2.56 = -27.56 (well below threshold)
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.50'),
        currentPolymarketPrice: new Decimal('0.78'),
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
      });
      const result = service.evaluateModelDriven(input);
      const c1 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'edge_evaporation',
      );
      expect(c1).toBeDefined();
      expect(c1!.triggered).toBe(true);
    });
  });

  // ==========================================================================
  // C2 — Model confidence drop
  // ==========================================================================
  describe('C2 — Model confidence drop', () => {
    it('[P1] should trigger when confidence dropped below threshold', () => {
      // Default EXIT_CONFIDENCE_DROP_PCT = 30 (assumed)
      // triggerThreshold = 0.90 * (1 - 30/100) = 0.90 * 0.70 = 0.63
      // currentConfidence = 0.55 < 0.63 => triggered
      // proximity = 1 - (0.55 - 0.63) / (0.90 - 0.63) = 1 - (-0.08 / 0.27) = 1 + 0.296 = 1.296 → clamped to 1.0
      const input = makeInput({
        exitMode: 'model',
        entryConfidenceScore: 0.9,
        currentConfidenceScore: 0.55,
      });
      const result = service.evaluateModelDriven(input);
      const c2 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'model_confidence',
      );
      expect(c2).toBeDefined();
      expect(c2!.triggered).toBe(true);
      expect(c2!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should NOT trigger when confidence above threshold', () => {
      // triggerThreshold = 0.90 * 0.70 = 0.63
      // currentConfidence = 0.80 > 0.63 => NOT triggered
      // proximity = 1 - (0.80 - 0.63) / (0.90 - 0.63) = 1 - (0.17 / 0.27) ≈ 1 - 0.63 = 0.37
      const input = makeInput({
        exitMode: 'model',
        entryConfidenceScore: 0.9,
        currentConfidenceScore: 0.8,
      });
      const result = service.evaluateModelDriven(input);
      const c2 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'model_confidence',
      );
      expect(c2).toBeDefined();
      expect(c2!.triggered).toBe(false);
      expect(c2!.proximity.gt(new Decimal('0'))).toBe(true);
      expect(c2!.proximity.lt(new Decimal('1'))).toBe(true);
    });

    it('[P1] should disable (proximity=0) when entryConfidenceScore is null', () => {
      const input = makeInput({
        exitMode: 'model',
        entryConfidenceScore: null,
        currentConfidenceScore: 0.5,
      });
      const result = service.evaluateModelDriven(input);
      const c2 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'model_confidence',
      );
      expect(c2).toBeDefined();
      expect(c2!.triggered).toBe(false);
      expect(c2!.proximity.eq(new Decimal('0'))).toBe(true);
    });

    it('[P2] should trigger when confidence at exact threshold boundary', () => {
      // triggerThreshold = 0.90 * 0.70 = 0.63
      // currentConfidence = 0.63 => exactly at threshold
      // proximity = 1 - (0.63 - 0.63) / (0.90 - 0.63) = 1 - 0 = 1.0 => triggered
      const input = makeInput({
        exitMode: 'model',
        entryConfidenceScore: 0.9,
        currentConfidenceScore: 0.63,
      });
      const result = service.evaluateModelDriven(input);
      const c2 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'model_confidence',
      );
      expect(c2).toBeDefined();
      expect(c2!.triggered).toBe(true);
      expect(c2!.proximity.eq(new Decimal('1'))).toBe(true);
    });
  });

  // ==========================================================================
  // C3 — Time decay (quadratic)
  // ==========================================================================
  describe('C3 — Time decay (quadratic)', () => {
    it('[P1] should have proximity ≈ 0.00 at 168h remaining (start of horizon), NOT triggered', () => {
      // At full horizon (168h), proximity = ((168 - 168) / 168)^steepness = 0^2 = 0.00
      const now = new Date('2026-03-20T00:00:00Z');
      const resolutionDate = new Date(now.getTime() + 168 * 60 * 60 * 1000); // +168 hours
      const input = makeInput({
        exitMode: 'model',
        now,
        resolutionDate,
      });
      const result = service.evaluateModelDriven(input);
      const c3 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'time_decay',
      );
      expect(c3).toBeDefined();
      expect(c3!.triggered).toBe(false);
      expect(c3!.proximity.toNumber()).toBeCloseTo(0.0, 2);
    });

    it('[P1] should trigger at 15h remaining (proximity ≈ 0.83, above default trigger 0.8)', () => {
      // proximity = ((168 - 15) / 168)^2 = (153/168)^2 = (0.9107)^2 ≈ 0.829
      // EXIT_TIME_DECAY_TRIGGER default = 0.8, 0.829 >= 0.8 → triggered
      const now = new Date('2026-03-20T00:00:00Z');
      const resolutionDate = new Date(now.getTime() + 15 * 60 * 60 * 1000); // +15 hours
      const input = makeInput({
        exitMode: 'model',
        now,
        resolutionDate,
      });
      const result = service.evaluateModelDriven(input);
      const c3 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'time_decay',
      );
      expect(c3).toBeDefined();
      expect(c3!.triggered).toBe(true);
      expect(c3!.proximity.toNumber()).toBeCloseTo(0.83, 1);
    });

    it('[P1] should have proximity = 1.00 at 0h remaining, triggered', () => {
      // proximity = ((168 - 0) / 168)^2 = 1^2 = 1.0
      const now = new Date('2026-03-20T00:00:00Z');
      const resolutionDate = new Date(now.getTime()); // 0 hours remaining
      const input = makeInput({
        exitMode: 'model',
        now,
        resolutionDate,
      });
      const result = service.evaluateModelDriven(input);
      const c3 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'time_decay',
      );
      expect(c3).toBeDefined();
      expect(c3!.triggered).toBe(true);
      expect(c3!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should disable (proximity=0) when resolutionDate is null', () => {
      const input = makeInput({
        exitMode: 'model',
        resolutionDate: null,
      });
      const result = service.evaluateModelDriven(input);
      const c3 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'time_decay',
      );
      expect(c3).toBeDefined();
      expect(c3!.triggered).toBe(false);
      expect(c3!.proximity.eq(new Decimal('0'))).toBe(true);
    });
  });

  // ==========================================================================
  // C4 — Risk budget
  // ==========================================================================
  describe('C4 — Risk budget', () => {
    it('[P0] should trigger when risk approaching + rank 1 (lowest edge)', () => {
      // portfolioRiskApproaching = true, edgeRankAmongOpen = 1, totalOpenPositions = 5
      // proximity = 1 - (1 - 1) / (5 - 1) = 1 - 0/4 = 1.0
      // EXIT_RISK_RANK_CUTOFF default = 1, rank 1 <= 1 => triggered
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 5,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(true);
      expect(c4!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should NOT trigger when risk approaching + rank 2 (default cutoff=1)', () => {
      // rank 2 > cutoff 1 => NOT triggered
      // proximity = 1 - (2 - 1) / (5 - 1) = 1 - 0.25 = 0.75
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 2,
        totalOpenPositions: 5,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(false);
      expect(c4!.proximity.toNumber()).toBeCloseTo(0.75, 2);
    });

    it('[P1] should have proximity 0 when risk NOT approaching', () => {
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: false,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 5,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(false);
      expect(c4!.proximity.eq(new Decimal('0'))).toBe(true);
    });

    it('[P2] should handle dense rank ties: edges [0.5, 0.5, 1.0] → ranks [1, 1, 2]', () => {
      // When two positions share the lowest edge (0.5), both get rank 1
      // The position with edge 1.0 gets rank 2
      // For the rank-1 position: proximity = 1 - (1-1)/(3-1) = 1.0
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1, // Dense rank: tied for lowest
        totalOpenPositions: 3,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(true);
      expect(c4!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P2] should have proximity 1 for single position + risk approaching', () => {
      // totalOpenPositions = 1, edgeRankAmongOpen = 1
      // proximity = 1 - (1 - 1) / (1 - 1) → denominator is 0 → proximity = 1 (single position gets full proximity)
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 1,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(true);
      expect(c4!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should disable C4 when edgeRankAmongOpen is undefined (null recalculatedEdge)', () => {
      // Position excluded from ranking → criterion disabled, never triggers
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: undefined,
        totalOpenPositions: undefined,
      });
      const result = service.evaluateModelDriven(input);
      const c4 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'risk_budget',
      );
      expect(c4).toBeDefined();
      expect(c4!.triggered).toBe(false);
      expect(c4!.proximity.eq(new Decimal('0'))).toBe(true);
      expect(c4!.detail).toContain('excluded');
    });
  });

  // ==========================================================================
  // C5 — Liquidity deterioration
  // ==========================================================================
  describe('C5 — Liquidity deterioration', () => {
    it('[P0] should trigger when depth below EXIT_MIN_DEPTH on both sides', () => {
      // EXIT_MIN_DEPTH default = 500 (assumed)
      // kalshiExitDepth = 0, polymarketExitDepth = 0
      // minDepth = min(0, 0) = 0
      // proximity = max(0, 1 - 0/500) = 1.0 => triggered
      const input = makeInput({
        exitMode: 'model',
        kalshiExitDepth: new Decimal('0'),
        polymarketExitDepth: new Decimal('0'),
      });
      const result = service.evaluateModelDriven(input);
      const c5 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'liquidity_deterioration',
      );
      expect(c5).toBeDefined();
      expect(c5!.triggered).toBe(true);
      expect(c5!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should NOT trigger when depth at EXIT_MIN_DEPTH (proximity = 0)', () => {
      // minDepth = min(500, 600) = 500
      // proximity = max(0, 1 - 500/500) = max(0, 0) = 0
      const input = makeInput({
        exitMode: 'model',
        kalshiExitDepth: new Decimal('500'),
        polymarketExitDepth: new Decimal('600'),
      });
      const result = service.evaluateModelDriven(input);
      const c5 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'liquidity_deterioration',
      );
      expect(c5).toBeDefined();
      expect(c5!.triggered).toBe(false);
      expect(c5!.proximity.eq(new Decimal('0'))).toBe(true);
    });

    it('[P1] should trigger when single-side insufficient (one below, one above)', () => {
      // kalshiExitDepth = 0, polymarketExitDepth = 1000
      // minDepth = min(0, 1000) = 0
      // proximity = max(0, 1 - 0/500) = 1.0 => triggered
      const input = makeInput({
        exitMode: 'model',
        kalshiExitDepth: new Decimal('0'),
        polymarketExitDepth: new Decimal('1000'),
      });
      const result = service.evaluateModelDriven(input);
      const c5 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'liquidity_deterioration',
      );
      expect(c5).toBeDefined();
      expect(c5!.triggered).toBe(true);
      expect(c5!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[S1] should trigger when depth is below minDepth but not zero', () => {
      // kalshiExitDepth = 3, polymarketExitDepth = 10, default minDepth = 5
      // minSideDepth = 3 < 5 → triggered
      // proximity = max(0, 1 - 3/5) = 0.4
      const input = makeInput({
        exitMode: 'model',
        kalshiExitDepth: new Decimal('3'),
        polymarketExitDepth: new Decimal('10'),
      });
      const result = service.evaluateModelDriven(input);
      const c5 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'liquidity_deterioration',
      );
      expect(c5).toBeDefined();
      expect(c5!.triggered).toBe(true);
      expect(c5!.proximity.toNumber()).toBeCloseTo(0.4, 2);
    });
  });

  // ==========================================================================
  // Priority ordering
  // ==========================================================================
  describe('Priority ordering', () => {
    it('[P0] should select highest priority criterion when multiple triggered (risk budget > edge evaporation)', () => {
      // Set up conditions where both risk_budget (P1) and edge_evaporation (P2) trigger.
      // Risk budget has higher priority, so result.type should be 'risk_budget'.
      const now = new Date('2026-03-20T00:00:00Z');
      const input = makeInput({
        exitMode: 'model',
        // C1 edge evaporation: adverse prices to trigger
        currentKalshiPrice: new Decimal('0.59'),
        currentPolymarketPrice: new Decimal('0.68'),
        entryClosePriceKalshi: new Decimal('0.60'),
        entryClosePricePolymarket: new Decimal('0.67'),
        entryKalshiFeeRate: new Decimal('0.02'),
        entryPolymarketFeeRate: new Decimal('0.02'),
        // C4 risk budget: approaching + lowest rank
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 5,
        now,
      });
      const result = service.evaluateModelDriven(input);
      expect(result.triggered).toBe(true);
      // Risk budget (P1 priority) should win over edge evaporation (P2)
      expect(result.type).toBe('risk_budget');
    });

    it('[P0] should always return CriterionResult[] with 6 entries (no short-circuit)', () => {
      // Even when the first criterion triggers, all 6 must be evaluated and returned
      const now = new Date('2026-03-20T00:00:00Z');
      const resolutionDate = new Date(now.getTime() + 18 * 60 * 60 * 1000);
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 3,
        entryConfidenceScore: 0.9,
        currentConfidenceScore: 0.4,
        kalshiExitDepth: new Decimal('0'),
        polymarketExitDepth: new Decimal('0'),
        resolutionDate,
        now,
      });
      const result = service.evaluateModelDriven(input);
      expect(result.criteria).toBeDefined();
      expect(result.criteria).toHaveLength(6);
      const criterionNames = result.criteria!.map(
        (c: CriterionResult) => c.criterion,
      );
      expect(criterionNames).toContain('edge_evaporation');
      expect(criterionNames).toContain('model_confidence');
      expect(criterionNames).toContain('time_decay');
      expect(criterionNames).toContain('risk_budget');
      expect(criterionNames).toContain('liquidity_deterioration');
      expect(criterionNames).toContain('profit_capture');
    });
  });

  // ==========================================================================
  // C6 — Profit capture
  // ==========================================================================
  describe('C6 — Profit capture', () => {
    it('[P0] should trigger when PnL reaches profit capture target', () => {
      // kalshi buy@0.62, sell@0.66 => (0.66-0.62)*100 = 4.0
      // poly sell@0.65, buy@0.62 => (0.65-0.62)*100 = 3.0
      // fees: 0.66*100*0.02 + 0.62*100*0.02 = 1.32+1.24 = 2.56
      // currentPnl = 4.0 + 3.0 - 2.56 = 4.44
      // scaledInitialEdge = 0.03 * 100 = 3.0
      // profitTarget = 0 + 3.0 * 0.5 = 1.5 (default ratio 0.5)
      // 4.44 >= 1.5 → triggered
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
      });
      const result = service.evaluateModelDriven(input);
      const c6 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'profit_capture',
      );
      expect(c6).toBeDefined();
      expect(c6!.triggered).toBe(true);
      expect(c6!.proximity.eq(new Decimal('1'))).toBe(true);
    });

    it('[P1] should NOT trigger when PnL below profit target', () => {
      // currentPnl at entry prices (no movement) → negative due to fees
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.62'),
        currentPolymarketPrice: new Decimal('0.65'),
      });
      const result = service.evaluateModelDriven(input);
      const c6 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'profit_capture',
      );
      expect(c6).toBeDefined();
      expect(c6!.triggered).toBe(false);
    });

    it('[P2] should respect custom profitCaptureRatio', () => {
      // Same favorable prices as trigger test, but with ratio=5.0 (500% of edge)
      // profitTarget = 0 + 3.0 * 5.0 = 15.0
      // currentPnl = 4.44 < 15.0 → NOT triggered
      const input = makeInput({
        exitMode: 'model',
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
        profitCaptureRatio: 5.0,
      });
      const result = service.evaluateModelDriven(input);
      const c6 = result.criteria!.find(
        (c: CriterionResult) => c.criterion === 'profit_capture',
      );
      expect(c6).toBeDefined();
      expect(c6!.triggered).toBe(false);
      // Proximity should be partial (4.44/15.0 ≈ 0.296)
      expect(c6!.proximity.gt(new Decimal('0'))).toBe(true);
      expect(c6!.proximity.lt(new Decimal('1'))).toBe(true);
    });
  });

  // ==========================================================================
  // Mode branching (fixed / model / shadow)
  // ==========================================================================
  describe('Mode branching', () => {
    it('[P0] exitMode=fixed → existing evaluate() logic, no criteria array', () => {
      // Fixed mode should behave identically to existing evaluate() — no new fields in result
      const input = makeInput({
        exitMode: 'fixed',
        currentKalshiPrice: new Decimal('0.56'),
        currentPolymarketPrice: new Decimal('0.68'),
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
      expect(result.criteria).toBeUndefined();
    });

    it('[P0] exitMode=model → evaluateModelDriven(), returns criteria array', () => {
      const input = makeInput({
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 3,
      });
      const result = service.evaluateModelDriven(input);
      expect(result.criteria).toBeDefined();
      expect(Array.isArray(result.criteria)).toBe(true);
      expect(result.criteria!.length).toBe(6);
      // Each entry should have criterion, proximity, triggered
      for (const cr of result.criteria!) {
        expect(cr.criterion).toBeDefined();
        expect(cr.proximity).toBeInstanceOf(Decimal);
        expect(typeof cr.triggered).toBe('boolean');
      }
    });

    it('[P0] exitMode=shadow → both evaluations, fixed primary + shadowModelResult', () => {
      // Shadow mode: FIXED is primary (governs real exits), model attached for comparison
      const input = makeInput({
        exitMode: 'shadow',
        currentKalshiPrice: new Decimal('0.56'),
        currentPolymarketPrice: new Decimal('0.68'),
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 3,
      });
      const result = service.evaluate(input);
      // Fixed is the primary result — with these adverse prices, fixed triggers stop_loss
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
      // Model criteria array should be populated for dashboard visibility
      expect(result.criteria).toBeDefined();
      expect(result.criteria!.length).toBe(6);
      // Shadow model result is attached
      expect(result.shadowModelResult).toBeDefined();
      expect(typeof result.shadowModelResult!.triggered).toBe('boolean');
      expect(result.shadowModelResult!.currentPnl).toBeInstanceOf(Decimal);
    });
  });

  // ==========================================================================
  // Regression guards — fixed mode backward compatibility
  // ==========================================================================
  describe('Regression guards', () => {
    it('[P0] Fixed mode: new null fields do not affect existing stop_loss behavior', () => {
      // Same test scenario as existing stop_loss tests, but with all new fields set to null/undefined
      const input = makeInput({
        exitMode: 'fixed',
        currentKalshiPrice: new Decimal('0.56'),
        currentPolymarketPrice: new Decimal('0.68'),
        // All new fields explicitly null/undefined
        entryConfidenceScore: null,
        currentConfidenceScore: null,
        kalshiExitDepth: null,
        polymarketExitDepth: null,
        portfolioRiskApproaching: false,
        edgeRankAmongOpen: undefined,
        totalOpenPositions: undefined,
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('stop_loss');
      expect(result.criteria).toBeUndefined();
      // Verify PnL calculation is unchanged from pre-10.2 behavior
      // kalshi buy@0.62, sell@0.56: (0.56-0.62)*100 = -6.0
      // poly sell@0.65, buy@0.68: (0.65-0.68)*100 = -3.0
      // fees: 0.56*100*0.02 + 0.68*100*0.02 = 1.12+1.36 = 2.48
      // currentPnl = -6.0 + -3.0 - 2.48 = -11.48
      expect(result.currentPnl.toFixed(2)).toBe('-11.48');
    });

    it('[P0] Fixed mode: new null fields do not affect existing take_profit behavior', () => {
      const input = makeInput({
        exitMode: 'fixed',
        currentKalshiPrice: new Decimal('0.66'),
        currentPolymarketPrice: new Decimal('0.62'),
        // All new fields explicitly null/undefined
        entryConfidenceScore: null,
        currentConfidenceScore: null,
        kalshiExitDepth: null,
        polymarketExitDepth: null,
        portfolioRiskApproaching: false,
        edgeRankAmongOpen: undefined,
        totalOpenPositions: undefined,
      });
      const result = service.evaluate(input);
      expect(result.triggered).toBe(true);
      expect(result.type).toBe('take_profit');
      expect(result.criteria).toBeUndefined();
      // kalshi P&L: (0.66-0.62)*100 = 4.0
      // poly P&L: (0.65-0.62)*100 = 3.0
      // fees: 0.66*100*0.02 + 0.62*100*0.02 = 1.32+1.24 = 2.56
      // currentPnl = 4.0 + 3.0 - 2.56 = 4.44
      expect(result.currentPnl.toFixed(2)).toBe('4.44');
    });
  });

  // ==========================================================================
  // Paper/live parity
  // ==========================================================================
  describe('Paper/live parity', () => {
    it('[P0] Model-driven evaluation is identical regardless of paper/live (no isPaper branching)', () => {
      // The evaluator is a pure function — it does not receive or check isPaper.
      // Both calls with identical inputs must produce identical results.
      const baseOverrides: Partial<ThresholdEvalInput> = {
        exitMode: 'model',
        portfolioRiskApproaching: true,
        edgeRankAmongOpen: 1,
        totalOpenPositions: 3,
        entryConfidenceScore: 0.85,
        currentConfidenceScore: 0.5,
        kalshiExitDepth: new Decimal('100'),
        polymarketExitDepth: new Decimal('200'),
        resolutionDate: new Date('2026-03-21T00:00:00Z'),
      };
      const inputA = makeInput(baseOverrides);
      const inputB = makeInput(baseOverrides);
      const resultA = service.evaluateModelDriven(inputA);
      const resultB = service.evaluateModelDriven(inputB);

      expect(resultA.triggered).toBe(resultB.triggered);
      expect(resultA.type).toBe(resultB.type);
      expect(resultA.currentPnl.eq(resultB.currentPnl)).toBe(true);
      expect(resultA.criteria!.length).toBe(resultB.criteria!.length);
      for (let i = 0; i < resultA.criteria!.length; i++) {
        expect(resultA.criteria![i]!.criterion).toBe(
          resultB.criteria![i]!.criterion,
        );
        expect(resultA.criteria![i]!.triggered).toBe(
          resultB.criteria![i]!.triggered,
        );
        expect(
          resultA.criteria![i]!.proximity.eq(resultB.criteria![i]!.proximity),
        ).toBe(true);
      }
    });
  });
});
