import Decimal from 'decimal.js';

/**
 * Six-criteria model-driven exit logic types (Story 10.2).
 * Used by ThresholdEvaluatorService (stateless evaluator) and ExitMonitorService (caller).
 */

/** The six exit criteria identifiers */
export type ExitCriterion =
  | 'edge_evaporation'
  | 'model_confidence'
  | 'time_decay'
  | 'risk_budget'
  | 'liquidity_deterioration'
  | 'profit_capture';

/** Result of evaluating a single criterion */
export interface CriterionResult {
  criterion: ExitCriterion;
  /** Proximity to trigger: 0 = far from triggering, 1 = at/beyond trigger threshold */
  proximity: Decimal;
  triggered: boolean;
  /** Human-readable detail for dashboard display */
  detail?: string;
}

/** Exit mode configuration */
export type ExitMode = 'fixed' | 'model' | 'shadow';

/**
 * Priority order for exit criteria (lower number = higher priority).
 * When multiple criteria trigger simultaneously, highest priority determines exit type.
 */
export const EXIT_CRITERION_PRIORITY: Record<ExitCriterion, number> = {
  risk_budget: 1,
  edge_evaporation: 2,
  liquidity_deterioration: 3,
  model_confidence: 4,
  time_decay: 5,
  profit_capture: 6,
};
