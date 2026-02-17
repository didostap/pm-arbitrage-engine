import { RiskDecision, RiskExposure } from '../types/risk.type.js';

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
}
