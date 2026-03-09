/**
 * Exit threshold constants shared between ThresholdEvaluatorService (hot path)
 * and PositionEnrichmentService (dashboard display).
 *
 * Extracting to common/constants avoids cross-module imports between
 * exit-management and dashboard modules.
 */

/** Stop-loss multiplier: SL fires when currentPnl <= entryCostBaseline + scaledInitialEdge * SL_MULTIPLIER */
export const SL_MULTIPLIER = -2;

/** Take-profit ratio: TP fires when currentPnl >= max(0, entryCostBaseline + (scaledInitialEdge - entryCostBaseline) * TP_RATIO) */
export const TP_RATIO = 0.8;
