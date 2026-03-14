import Decimal from 'decimal.js';
import {
  BudgetReservation,
  ReservationRequest,
  RiskDecision,
  RiskExposure,
} from '../types/risk.type.js';
import type {
  OpportunityId,
  PairId,
  ReservationId,
} from '../types/branded.type.js';

export interface IRiskManager {
  /**
   * Validate whether an opportunity passes risk checks.
   * @param opportunity - EnrichedOpportunity from arbitrage-detection module
   */
  validatePosition(opportunity: unknown): Promise<RiskDecision>;
  getCurrentExposure(): RiskExposure;
  getOpenPositionCount(): number;
  /**
   * Update daily P&L with a realized profit/loss delta.
   * @param pnlDelta - Decimal amount (positive = gain, negative = loss)
   * @param isPaper - When true, targets paper mode risk state. Defaults to false (live).
   */
  updateDailyPnl(pnlDelta: unknown, isPaper?: boolean): Promise<void>;
  /**
   * Check if trading is currently halted.
   */
  isTradingHalted(): boolean;
  /**
   * Halt trading for the given reason. Adds to the set of active halt reasons.
   * @param reason - The halt reason string (from HALT_REASONS)
   */
  haltTrading(reason: string): void;
  /**
   * Resume trading for the given reason. Removes only the specified reason.
   * Trading actually resumes only when all halt reasons are cleared.
   * @param reason - The halt reason to remove
   */
  resumeTrading(reason: string): void;
  /**
   * Force-set open position count and total capital deployed from reconciliation data.
   * @param openCount - Reconciled open position count
   * @param capitalDeployed - Reconciled total capital deployed
   */
  recalculateFromPositions(
    openCount: number,
    capitalDeployed: Decimal,
    mode?: 'live' | 'paper',
  ): Promise<void>;
  /**
   * Process an operator override for a rejected opportunity.
   * @param opportunityId - The opportunity to override
   * @param rationale - Operator's reason for the override (min 10 chars)
   */
  processOverride(
    opportunityId: OpportunityId,
    rationale: string,
  ): Promise<RiskDecision>;
  /**
   * Atomically validate budget availability and reserve risk budget for an opportunity.
   */
  reserveBudget(request: ReservationRequest): Promise<BudgetReservation>;
  /**
   * Commit a reservation — budget permanently allocated to new position.
   */
  commitReservation(reservationId: ReservationId): Promise<void>;
  /**
   * Release a reservation — budget returned to available pool.
   */
  releaseReservation(reservationId: ReservationId): Promise<void>;
  /**
   * Adjust a reservation's capital downward (depth-aware sizing).
   * No-op if newCapitalUsd >= current reserved amount.
   */
  adjustReservation(
    reservationId: ReservationId,
    newCapitalUsd: Decimal,
  ): Promise<void>;
  /**
   * Close a committed position — return capital to pool, decrement position count.
   * Called when a position transitions to CLOSED.
   * @param capitalReturned - Decimal amount of capital being returned to the pool
   * @param pnlDelta - Realized P&L (positive = profit, negative = loss)
   * @param pairId - Optional pair ID to remove from paper active set
   */
  closePosition(
    capitalReturned: unknown,
    pnlDelta: unknown,
    pairId?: PairId,
    isPaper?: boolean,
  ): Promise<void>;
  /**
   * Release capital for a partial exit — reduces deployed capital and updates P&L
   * without decrementing position count or removing from paper active pairs.
   * Called when a position transitions to EXIT_PARTIAL.
   * @param capitalReleased - Capital to return to available pool (exited portion)
   * @param realizedPnl - Realized P&L on the exited contracts
   * @param pairId - Optional pair ID (NOT removed from paper active set)
   */
  releasePartialCapital(
    capitalReleased: unknown,
    realizedPnl: unknown,
    pairId?: PairId,
    isPaper?: boolean,
  ): Promise<void>;
  /**
   * Get bankroll configuration from DB (bankroll value + last update timestamp).
   */
  getBankrollConfig(): Promise<{
    bankrollUsd: string;
    paperBankrollUsd: string | null;
    updatedAt: string;
  }>;
  /**
   * Get current bankroll as Decimal (for other services to read single source of truth).
   */
  getBankrollUsd(): Decimal;
  /**
   * Re-read bankroll from DB and recalculate all derived limits.
   */
  reloadBankroll(): Promise<void>;
}
