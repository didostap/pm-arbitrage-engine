/**
 * Exit threshold constants shared between ThresholdEvaluatorService (hot path)
 * and PositionEnrichmentService (dashboard display).
 *
 * Extracting to common/constants avoids cross-module imports between
 * exit-management and dashboard modules.
 */

import Decimal from 'decimal.js';

/** Stop-loss multiplier: SL fires when currentPnl <= entryCostBaseline + scaledInitialEdge * SL_MULTIPLIER */
export const SL_MULTIPLIER = -2;

/**
 * Take-profit ratio (80% of journey or edge).
 *
 * Normal case: TP = entryCostBaseline + (scaledInitialEdge - entryCostBaseline) × TP_RATIO
 * Fallback (when journey TP ≤ 0, i.e. |baseline| > 4 × edge): TP = max(0, scaledInitialEdge × TP_RATIO)
 */
export const TP_RATIO = 0.8;

/** Pre-computed Decimal constants to avoid repeated allocations on the hot path */
const TP_RATIO_DECIMAL = new Decimal(TP_RATIO.toString());
const DECIMAL_ZERO = new Decimal(0);

/**
 * Compute the take-profit threshold with edge-relative fallback.
 * @param entryCostBaseline MtM deficit at entry (≤ 0). May be recomputed for
 *   residual size in EXIT_PARTIAL (callers pass as `thresholdBaseline`).
 * @param scaledInitialEdge initialEdge × legSize (> 0 for real positions).
 */
export function computeTakeProfitThreshold(
  entryCostBaseline: Decimal,
  scaledInitialEdge: Decimal,
): Decimal {
  // Journey-based TP (6.5.5j): 80% of the path from baseline to convergence
  const journeyTp = entryCostBaseline.plus(
    scaledInitialEdge.minus(entryCostBaseline).mul(TP_RATIO_DECIMAL),
  );

  if (journeyTp.gt(0)) {
    return journeyTp;
  }

  // Fallback (9-18): edge-relative TP when baseline dominates edge
  return Decimal.max(DECIMAL_ZERO, scaledInitialEdge.mul(TP_RATIO_DECIMAL));
}

/**
 * Unified exit proximity calculation for both SL and TP.
 * Formula: clamp(0, 1, (currentPnl - baseline) / (target - baseline))
 *
 * Works for both directions:
 * - SL (target < baseline): both numerator and denominator are negative as PnL drops, producing positive proximity
 * - TP (target > baseline): positive numerator/denominator as PnL rises
 *
 * Returns Decimal(0) when target === baseline (zero denominator guard).
 */
export function calculateExitProximity(
  currentPnl: Decimal,
  baseline: Decimal,
  target: Decimal,
): Decimal {
  const denom = target.minus(baseline);
  if (denom.isZero()) return DECIMAL_ZERO;
  const raw = currentPnl.minus(baseline).div(denom);
  return Decimal.min(new Decimal(1), Decimal.max(DECIMAL_ZERO, raw));
}
