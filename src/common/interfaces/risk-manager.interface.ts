import {
  BudgetReservation,
  ReservationRequest,
  RiskDecision,
  RiskExposure,
} from '../types/risk.type.js';

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
   */
  updateDailyPnl(pnlDelta: unknown): Promise<void>;
  /**
   * Check if trading is currently halted.
   */
  isTradingHalted(): boolean;
  /**
   * Process an operator override for a rejected opportunity.
   * @param opportunityId - The opportunity to override
   * @param rationale - Operator's reason for the override (min 10 chars)
   */
  processOverride(
    opportunityId: string,
    rationale: string,
  ): Promise<RiskDecision>;
  /**
   * Atomically validate budget availability and reserve risk budget for an opportunity.
   */
  reserveBudget(request: ReservationRequest): Promise<BudgetReservation>;
  /**
   * Commit a reservation — budget permanently allocated to new position.
   */
  commitReservation(reservationId: string): Promise<void>;
  /**
   * Release a reservation — budget returned to available pool.
   */
  releaseReservation(reservationId: string): Promise<void>;
  /**
   * Close a committed position — return capital to pool, decrement position count.
   * Called when a position transitions to CLOSED.
   * @param capitalReturned - Decimal amount of capital being returned to the pool
   * @param pnlDelta - Realized P&L (positive = profit, negative = loss)
   */
  closePosition(capitalReturned: unknown, pnlDelta: unknown): Promise<void>;
}
