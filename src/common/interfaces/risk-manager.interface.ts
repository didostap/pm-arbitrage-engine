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
}
