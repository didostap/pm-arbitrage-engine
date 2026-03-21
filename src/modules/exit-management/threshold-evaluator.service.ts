import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  FinancialMath,
  calculateLegPnl as sharedCalculateLegPnl,
} from '../../common/utils/financial-math';
import {
  SL_MULTIPLIER,
  computeTakeProfitThreshold,
} from '../../common/constants/exit-thresholds';
import type {
  CriterionResult,
  ExitCriterion,
  ExitMode,
} from '../../common/types/exit-criteria.types';
import { EXIT_CRITERION_PRIORITY } from '../../common/types/exit-criteria.types';

export interface ThresholdEvalInput {
  initialEdge: Decimal;
  kalshiEntryPrice: Decimal;
  polymarketEntryPrice: Decimal;
  currentKalshiPrice: Decimal;
  currentPolymarketPrice: Decimal;
  kalshiSide: string;
  polymarketSide: string;
  /** Position size on Kalshi. INVARIANT: Must equal polymarketSize (execution guarantees equal leg sizes). */
  kalshiSize: Decimal;
  /** Position size on Polymarket. INVARIANT: Must equal kalshiSize. */
  polymarketSize: Decimal;
  kalshiFeeDecimal: Decimal;
  polymarketFeeDecimal: Decimal;
  resolutionDate: Date | null;
  now: Date;
  /** Close-side top-of-book price at entry for Kalshi leg (6.5.5i). Null for legacy positions. */
  entryClosePriceKalshi?: Decimal | null;
  /** Close-side top-of-book price at entry for Polymarket leg (6.5.5i). Null for legacy positions. */
  entryClosePricePolymarket?: Decimal | null;
  /** Fee rate as decimal fraction at entry close price for Kalshi (6.5.5i). Null for legacy positions. */
  entryKalshiFeeRate?: Decimal | null;
  /** Fee rate as decimal fraction at entry close price for Polymarket (6.5.5i). Null for legacy positions. */
  entryPolymarketFeeRate?: Decimal | null;
  /** Data source classification for exit pricing (Story 10.1). */
  dataSource?: 'websocket' | 'polling' | 'stale_fallback';
  /** Age of order book data in milliseconds (Story 10.1). */
  dataFreshnessMs?: number;

  // ─── Six-Criteria Model Fields (Story 10.2) ──────────────────────────────
  /** Confidence score snapshot from ContractMatch at position entry. Null for legacy positions. */
  entryConfidenceScore?: number | null;
  /** Current ContractMatch confidence score. Null if lookup failed. */
  currentConfidenceScore?: number | null;
  /** Available exit depth on Kalshi side (contracts). */
  kalshiExitDepth?: Decimal | null;
  /** Available exit depth on Polymarket side (contracts). */
  polymarketExitDepth?: Decimal | null;
  /** True when portfolio risk budget is near limit (>= EXIT_RISK_BUDGET_PCT). */
  portfolioRiskApproaching?: boolean;
  /** Dense rank among open positions by recalculated edge (ascending, 1 = lowest edge). */
  edgeRankAmongOpen?: number;
  /** Total count of open positions for rank normalization. */
  totalOpenPositions?: number;
  /** Exit mode for this evaluation cycle. */
  exitMode?: ExitMode;

  // ─── Six-Criteria Config (passed from ExitMonitorService via ConfigService) ─
  /** C1: edge evaporation multiplier (default -1.0 = breakeven). */
  edgeEvapMultiplier?: number;
  /** C2: % confidence drop from entry that triggers exit (default 20). */
  confidenceDropPct?: number;
  /** C3: time decay horizon in hours (default 168). */
  timeDecayHorizonH?: number;
  /** C3: quadratic steepness exponent (default 2.0). */
  timeDecaySteepness?: number;
  /** C3: proximity threshold that triggers exit (default 0.8). */
  timeDecayTrigger?: number;
  /** C4: dense rank cutoff (default 1 = lowest-edge position only). */
  riskRankCutoff?: number;
  /** C5: minimum exit depth in contracts (default 5). */
  minDepth?: number;
  /** C6: profit capture ratio — fraction of scaled initial edge (default 0.5). */
  profitCaptureRatio?: number;
}

export interface ThresholdEvalResult {
  triggered: boolean;
  type?: 'stop_loss' | 'take_profit' | 'time_based' | ExitCriterion;
  currentEdge: Decimal;
  currentPnl: Decimal;
  capturedEdgePercent: Decimal;
  /** Data source classification passed through from input (Story 10.1). */
  dataSource?: 'websocket' | 'polling' | 'stale_fallback';

  // ─── Six-Criteria Model Fields (Story 10.2) ──────────────────────────────
  /** All 6 criterion results — populated in model/shadow mode. */
  criteria?: CriterionResult[];
  /** Model-mode result attached in shadow mode for comparison (fixed is primary). */
  shadowModelResult?: {
    triggered: boolean;
    type?: string;
    currentPnl: Decimal;
    criteria?: CriterionResult[];
  };
}

/** Shared intermediate values computed from ThresholdEvalInput */
interface EvalCommon {
  currentPnl: Decimal;
  currentEdge: Decimal;
  capturedEdgePercent: Decimal;
  legSize: Decimal;
  scaledInitialEdge: Decimal;
  entryCostBaseline: Decimal;
}

const DECIMAL_ZERO = new Decimal(0);
const DECIMAL_ONE = new Decimal(1);

@Injectable()
export class ThresholdEvaluatorService {
  private readonly logger = new Logger(ThresholdEvaluatorService.name);

  /**
   * Main entry point — branches on exitMode.
   * - 'fixed' (default): existing SL/TP/time logic (zero regression)
   * - 'model': six-criteria evaluation
   * - 'shadow': both evaluations, fixed result primary, model attached as shadowModelResult
   */
  evaluate(params: ThresholdEvalInput): ThresholdEvalResult {
    const mode = params.exitMode ?? 'fixed';
    const common = this.computeCommon(params);

    if (mode === 'fixed') {
      return this.evaluateFixed(params, common);
    }

    if (mode === 'model') {
      return this.evaluateModelDriven(params, common);
    }

    // Shadow mode: run both, return FIXED as primary (governs real exits),
    // model attached as shadowModelResult for comparison logging
    const fixedResult = this.evaluateFixed(params, common);
    const modelResult = this.evaluateModelDriven(params, common);
    return {
      ...fixedResult,
      criteria: modelResult.criteria,
      shadowModelResult: {
        triggered: modelResult.triggered,
        type: modelResult.type,
        currentPnl: modelResult.currentPnl,
        criteria: modelResult.criteria,
      },
    };
  }

  /**
   * Six-criteria model-driven evaluation.
   * All 6 criteria evaluate every cycle (for dashboard visibility).
   * Highest-priority triggered criterion determines exit type.
   */
  evaluateModelDriven(
    params: ThresholdEvalInput,
    common?: EvalCommon,
  ): ThresholdEvalResult {
    const c = common ?? this.computeCommon(params);
    const criteria = this.evaluateAllCriteria(params, c);

    // Find triggered criteria, select highest priority
    const triggered = criteria.filter((cr) => cr.triggered);
    if (triggered.length > 0) {
      triggered.sort(
        (a, b) =>
          EXIT_CRITERION_PRIORITY[a.criterion] -
          EXIT_CRITERION_PRIORITY[b.criterion],
      );
      return {
        triggered: true,
        type: triggered[0]!.criterion,
        currentEdge: c.currentEdge,
        currentPnl: c.currentPnl,
        capturedEdgePercent: c.capturedEdgePercent,
        dataSource: params.dataSource,
        criteria,
      };
    }

    return {
      triggered: false,
      currentEdge: c.currentEdge,
      currentPnl: c.currentPnl,
      capturedEdgePercent: c.capturedEdgePercent,
      dataSource: params.dataSource,
      criteria,
    };
  }

  // ─── Private: Fixed-mode evaluation (existing logic, zero changes) ──────

  private evaluateFixed(
    params: ThresholdEvalInput,
    common: EvalCommon,
  ): ThresholdEvalResult {
    const {
      currentPnl,
      currentEdge,
      capturedEdgePercent,
      scaledInitialEdge,
      entryCostBaseline,
    } = common;

    // Priority 1: Stop-loss
    const stopLossThreshold = entryCostBaseline.plus(
      scaledInitialEdge.mul(SL_MULTIPLIER),
    );
    if (currentPnl.lte(stopLossThreshold)) {
      return {
        triggered: true,
        type: 'stop_loss',
        currentEdge,
        currentPnl,
        capturedEdgePercent,
        dataSource: params.dataSource,
      };
    }

    // Priority 2: Take-profit
    const takeProfitThreshold = computeTakeProfitThreshold(
      entryCostBaseline,
      scaledInitialEdge,
    );
    if (currentPnl.gte(takeProfitThreshold)) {
      return {
        triggered: true,
        type: 'take_profit',
        currentEdge,
        currentPnl,
        capturedEdgePercent,
        dataSource: params.dataSource,
      };
    }

    // Priority 3: Time-based — resolutionDate - now <= 48 hours
    if (params.resolutionDate !== null) {
      const hoursRemaining =
        (params.resolutionDate.getTime() - params.now.getTime()) /
        (1000 * 60 * 60);
      if (hoursRemaining <= 48) {
        return {
          triggered: true,
          type: 'time_based',
          currentEdge,
          currentPnl,
          capturedEdgePercent,
          dataSource: params.dataSource,
        };
      }
    }

    return {
      triggered: false,
      currentEdge,
      currentPnl,
      capturedEdgePercent,
      dataSource: params.dataSource,
    };
  }

  // ─── Private: Six criterion methods (stateless — all data via input) ───

  private evaluateAllCriteria(
    params: ThresholdEvalInput,
    common: EvalCommon,
  ): CriterionResult[] {
    return [
      this.evaluateEdgeEvaporation(params, common),
      this.evaluateModelConfidence(params),
      this.evaluateTimeDecay(params),
      this.evaluateRiskBudget(params),
      this.evaluateLiquidityDeterioration(params),
      this.evaluateProfitCapture(params, common),
    ];
  }

  /** C1 — Edge evaporation (Priority 2): recalculated edge below breakeven after costs */
  private evaluateEdgeEvaporation(
    params: ThresholdEvalInput,
    common: EvalCommon,
  ): CriterionResult {
    const { currentPnl, scaledInitialEdge, entryCostBaseline } = common;
    // Same formula as SL but with configurable multiplier (default -1.0 = breakeven)
    const multiplier = new Decimal(params.edgeEvapMultiplier ?? -1.0);
    const threshold = entryCostBaseline.plus(scaledInitialEdge.mul(multiplier));

    // Reuse existing proximity pattern
    const denom = threshold.minus(entryCostBaseline);
    let proximity: Decimal;
    if (denom.isZero()) {
      proximity = currentPnl.lte(entryCostBaseline)
        ? DECIMAL_ONE
        : DECIMAL_ZERO;
    } else {
      const raw = currentPnl.minus(entryCostBaseline).div(denom);
      proximity = Decimal.min(DECIMAL_ONE, Decimal.max(DECIMAL_ZERO, raw));
    }

    return {
      criterion: 'edge_evaporation',
      proximity,
      triggered: currentPnl.lte(threshold),
      detail: `PnL ${currentPnl.toFixed(4)} vs threshold ${threshold.toFixed(4)}`,
    };
  }

  /** C2 — Model confidence drop (Priority 4): confidence decreased below threshold */
  private evaluateModelConfidence(params: ThresholdEvalInput): CriterionResult {
    const { entryConfidenceScore, currentConfidenceScore } = params;
    const dropPct = params.confidenceDropPct ?? 20;

    // Disabled if entry confidence is null (legacy positions)
    if (entryConfidenceScore == null || entryConfidenceScore === 0) {
      return {
        criterion: 'model_confidence',
        proximity: DECIMAL_ZERO,
        triggered: false,
        detail: 'Disabled: no entry confidence score',
      };
    }

    const current = currentConfidenceScore ?? entryConfidenceScore;
    const triggerThreshold = entryConfidenceScore * (1 - dropPct / 100);

    // Avoid division by zero when entry === trigger (100% drop configured)
    const range = entryConfidenceScore - triggerThreshold;
    let proximity: Decimal;
    if (range <= 0) {
      proximity = current <= triggerThreshold ? DECIMAL_ONE : DECIMAL_ZERO;
    } else {
      const raw = 1 - (current - triggerThreshold) / range;
      proximity = Decimal.min(
        DECIMAL_ONE,
        Decimal.max(DECIMAL_ZERO, new Decimal(raw)),
      );
    }

    return {
      criterion: 'model_confidence',
      proximity,
      triggered: current <= triggerThreshold,
      detail: `Confidence ${current.toFixed(1)} vs trigger ${triggerThreshold.toFixed(1)} (entry: ${entryConfidenceScore})`,
    };
  }

  /** C3 — Time decay (Priority 5): expected value diminishes as resolution approaches */
  private evaluateTimeDecay(params: ThresholdEvalInput): CriterionResult {
    const { resolutionDate, now } = params;
    const horizonH = params.timeDecayHorizonH ?? 168;
    const steepness = params.timeDecaySteepness ?? 2.0;
    const trigger = params.timeDecayTrigger ?? 0.8;

    // Disabled if no resolution date
    if (resolutionDate === null) {
      return {
        criterion: 'time_decay',
        proximity: DECIMAL_ZERO,
        triggered: false,
        detail: 'Disabled: no resolution date',
      };
    }

    const hoursRemaining =
      (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    // If already past resolution, proximity = 1
    if (hoursRemaining <= 0) {
      return {
        criterion: 'time_decay',
        proximity: DECIMAL_ONE,
        triggered: true,
        detail: `Past resolution (${hoursRemaining.toFixed(1)}h remaining)`,
      };
    }

    // Quadratic decay: ((horizon - remaining) / horizon) ^ steepness
    const ratio = Math.max(0, (horizonH - hoursRemaining) / horizonH);
    const proximity = new Decimal(Math.pow(ratio, steepness));
    const clamped = Decimal.min(
      DECIMAL_ONE,
      Decimal.max(DECIMAL_ZERO, proximity),
    );

    return {
      criterion: 'time_decay',
      proximity: clamped,
      triggered: clamped.gte(new Decimal(trigger)),
      detail: `${hoursRemaining.toFixed(1)}h remaining, proximity ${clamped.toFixed(4)}`,
    };
  }

  /** C4 — Risk budget breach (Priority 1): portfolio-level risk limit approached, lowest edge exits first */
  private evaluateRiskBudget(params: ThresholdEvalInput): CriterionResult {
    const { portfolioRiskApproaching, edgeRankAmongOpen, totalOpenPositions } =
      params;
    const rankCutoff = params.riskRankCutoff ?? 1;

    // Not approaching risk limit → proximity 0
    if (!portfolioRiskApproaching) {
      return {
        criterion: 'risk_budget',
        proximity: DECIMAL_ZERO,
        triggered: false,
        detail: 'Portfolio risk within budget',
      };
    }

    // Position excluded from ranking (null recalculatedEdge) → disable criterion
    if (edgeRankAmongOpen == null || totalOpenPositions == null) {
      return {
        criterion: 'risk_budget',
        proximity: DECIMAL_ZERO,
        triggered: false,
        detail: 'Disabled: position excluded from edge ranking',
      };
    }

    const rank = edgeRankAmongOpen;
    const total = totalOpenPositions;

    // Single position or total=1 → proximity 1 if approaching
    let proximity: Decimal;
    if (total <= 1) {
      proximity = DECIMAL_ONE;
    } else {
      const raw = 1 - (rank - 1) / (total - 1);
      proximity = Decimal.min(
        DECIMAL_ONE,
        Decimal.max(DECIMAL_ZERO, new Decimal(raw)),
      );
    }

    return {
      criterion: 'risk_budget',
      proximity,
      triggered: rank <= rankCutoff,
      detail: `Rank ${rank}/${total}, cutoff ${rankCutoff}`,
    };
  }

  /** C5 — Liquidity deterioration (Priority 3): order book depth below minimum executable */
  private evaluateLiquidityDeterioration(
    params: ThresholdEvalInput,
  ): CriterionResult {
    const { kalshiExitDepth, polymarketExitDepth } = params;
    const minDepth = new Decimal(params.minDepth ?? 5);

    // If depth data unavailable, assume sufficient (no trigger)
    if (kalshiExitDepth == null || polymarketExitDepth == null) {
      return {
        criterion: 'liquidity_deterioration',
        proximity: DECIMAL_ZERO,
        triggered: false,
        detail: 'Depth data unavailable',
      };
    }

    const minSideDepth = Decimal.min(kalshiExitDepth, polymarketExitDepth);
    // proximity = max(0, 1 - minDepth_actual / EXIT_MIN_DEPTH)
    const proximity = minDepth.isZero()
      ? DECIMAL_ZERO
      : Decimal.max(
          DECIMAL_ZERO,
          DECIMAL_ONE.minus(minSideDepth.div(minDepth)),
        );

    return {
      criterion: 'liquidity_deterioration',
      proximity,
      triggered: minSideDepth.lt(minDepth),
      detail: `Min depth ${minSideDepth.toFixed(0)} vs required ${minDepth.toFixed(0)}`,
    };
  }

  /** C6 — Profit capture (Priority 6): unrealized profit reaches target threshold */
  private evaluateProfitCapture(
    params: ThresholdEvalInput,
    common: EvalCommon,
  ): CriterionResult {
    const { currentPnl, scaledInitialEdge, entryCostBaseline } = common;
    const ratio = new Decimal(params.profitCaptureRatio ?? 0.5);
    const profitTarget = entryCostBaseline.plus(scaledInitialEdge.mul(ratio));

    // Proximity: progress from baseline toward profit target
    const denom = profitTarget.minus(entryCostBaseline);
    let proximity: Decimal;
    if (denom.isZero()) {
      proximity = currentPnl.gte(entryCostBaseline)
        ? DECIMAL_ONE
        : DECIMAL_ZERO;
    } else {
      const raw = currentPnl.minus(entryCostBaseline).div(denom);
      proximity = Decimal.min(DECIMAL_ONE, Decimal.max(DECIMAL_ZERO, raw));
    }

    return {
      criterion: 'profit_capture',
      proximity,
      triggered: currentPnl.gte(profitTarget),
      detail: `PnL ${currentPnl.toFixed(4)} vs target ${profitTarget.toFixed(4)}`,
    };
  }

  // ─── Private: Shared computation ────────────────────────────────────────

  private computeCommon(params: ThresholdEvalInput): EvalCommon {
    const {
      initialEdge,
      kalshiEntryPrice,
      polymarketEntryPrice,
      currentKalshiPrice,
      currentPolymarketPrice,
      kalshiSide,
      polymarketSide,
      kalshiSize,
      polymarketSize,
      kalshiFeeDecimal,
      polymarketFeeDecimal,
    } = params;

    // Debug assertion: execution guarantees equal leg sizes
    if (!kalshiSize.eq(polymarketSize)) {
      this.logger.error(
        'Unequal leg sizes detected — execution should guarantee equal sizes',
        {
          kalshiSize: kalshiSize.toString(),
          polymarketSize: polymarketSize.toString(),
        },
      );
    }

    // Calculate per-leg P&L
    const kalshiPnl = this.calculateLegPnl(
      kalshiSide,
      kalshiEntryPrice,
      currentKalshiPrice,
      kalshiSize,
    );
    const polymarketPnl = this.calculateLegPnl(
      polymarketSide,
      polymarketEntryPrice,
      currentPolymarketPrice,
      polymarketSize,
    );

    // Exit fees
    const kalshiExitFee = currentKalshiPrice
      .mul(kalshiSize)
      .mul(kalshiFeeDecimal);
    const polymarketExitFee = currentPolymarketPrice
      .mul(polymarketSize)
      .mul(polymarketFeeDecimal);
    const totalExitFees = kalshiExitFee.plus(polymarketExitFee);

    const currentPnl = kalshiPnl.plus(polymarketPnl).minus(totalExitFees);
    const legSize = kalshiSize;
    const scaledInitialEdge = initialEdge.mul(legSize);
    const currentEdge = currentPnl.div(
      legSize.isZero() ? DECIMAL_ONE : legSize,
    );
    const capturedEdgePercent = scaledInitialEdge.isZero()
      ? DECIMAL_ZERO
      : currentPnl.div(scaledInitialEdge).mul(100);

    // Entry cost baseline (6.5.5i)
    const entryCostBaseline = FinancialMath.computeEntryCostBaseline({
      kalshiEntryPrice,
      polymarketEntryPrice,
      kalshiSide,
      polymarketSide,
      kalshiSize,
      polymarketSize,
      entryClosePriceKalshi: params.entryClosePriceKalshi,
      entryClosePricePolymarket: params.entryClosePricePolymarket,
      entryKalshiFeeRate: params.entryKalshiFeeRate,
      entryPolymarketFeeRate: params.entryPolymarketFeeRate,
    });

    // Warn if partially populated
    const hasAnyEntryField =
      params.entryClosePriceKalshi != null ||
      params.entryClosePricePolymarket != null ||
      params.entryKalshiFeeRate != null ||
      params.entryPolymarketFeeRate != null;
    if (entryCostBaseline.isZero() && hasAnyEntryField) {
      this.logger.warn(
        'Partially populated entry close price fields — using baseline=0',
        {
          entryClosePriceKalshi:
            params.entryClosePriceKalshi?.toString() ?? 'null',
          entryClosePricePolymarket:
            params.entryClosePricePolymarket?.toString() ?? 'null',
          entryKalshiFeeRate: params.entryKalshiFeeRate?.toString() ?? 'null',
          entryPolymarketFeeRate:
            params.entryPolymarketFeeRate?.toString() ?? 'null',
        },
      );
    }

    return {
      currentPnl,
      currentEdge,
      capturedEdgePercent,
      legSize,
      scaledInitialEdge,
      entryCostBaseline,
    };
  }

  private calculateLegPnl(
    side: string,
    entryPrice: Decimal,
    currentPrice: Decimal,
    size: Decimal,
  ): Decimal {
    return sharedCalculateLegPnl(side, entryPrice, currentPrice, size);
  }
}
