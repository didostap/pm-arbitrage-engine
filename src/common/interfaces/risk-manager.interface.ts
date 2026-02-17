import { RiskDecision, RiskExposure } from '../types/risk.type.js';

export interface IRiskManager {
  /**
   * Validate whether an opportunity passes risk checks.
   * @param opportunity - EnrichedOpportunity from arbitrage-detection module
   */
  validatePosition(opportunity: unknown): Promise<RiskDecision>;
  getCurrentExposure(): RiskExposure;
  getOpenPositionCount(): number;
}
