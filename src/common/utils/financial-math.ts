import Decimal from 'decimal.js';
import { FeeSchedule } from '../types/platform.type.js';

// Isolated Decimal constructor configured for financial precision.
// Uses Decimal.clone() to avoid mutating the global Decimal settings,
// so other modules can safely import decimal.js with their own config.
export const FinancialDecimal = Decimal.clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -18,
  toExpPos: 20,
});

/**
 * Pure financial math utility for arbitrage edge calculations.
 * All methods use decimal.js — never native `number` for financial calculations.
 */
export class FinancialMath {
  /**
   * Calculate gross edge between buy and sell prices.
   * Formula: |buyPrice - (1 - sellPrice)|
   *
   * @param buyPrice - YES price on the buy-side platform (0-1 decimal probability)
   * @param sellPrice - YES price on the sell-side platform (0-1 decimal probability)
   */
  static calculateGrossEdge(buyPrice: Decimal, sellPrice: Decimal): Decimal {
    FinancialMath.validateDecimalInput(buyPrice, 'buyPrice');
    FinancialMath.validateDecimalInput(sellPrice, 'sellPrice');

    return buyPrice.minus(new FinancialDecimal(1).minus(sellPrice)).abs();
  }

  /**
   * Calculate net edge after fees and gas.
   * Formula:
   *   buyFeeCost = buyPrice * (buyFeeSchedule.takerFeePercent / 100)
   *   sellFeeCost = sellPrice * (sellFeeSchedule.takerFeePercent / 100)
   *   gasFraction = gasEstimateUsd / positionSizeUsd
   *   netEdge = grossEdge - buyFeeCost - sellFeeCost - gasFraction
   *
   * @param grossEdge - Pre-computed gross edge
   * @param buyPrice - YES price on buy-side platform
   * @param sellPrice - YES price on sell-side platform
   * @param buyFeeSchedule - Fee schedule for buy-side platform
   * @param sellFeeSchedule - Fee schedule for sell-side platform
   * @param gasEstimateUsd - Estimated gas cost in USD
   * @param positionSizeUsd - Position size in USD
   */
  static calculateNetEdge(
    grossEdge: Decimal,
    buyPrice: Decimal,
    sellPrice: Decimal,
    buyFeeSchedule: FeeSchedule,
    sellFeeSchedule: FeeSchedule,
    gasEstimateUsd: Decimal,
    positionSizeUsd: Decimal,
  ): Decimal {
    FinancialMath.validateDecimalInput(grossEdge, 'grossEdge');
    FinancialMath.validateDecimalInput(buyPrice, 'buyPrice');
    FinancialMath.validateDecimalInput(sellPrice, 'sellPrice');
    FinancialMath.validateDecimalInput(gasEstimateUsd, 'gasEstimateUsd');
    FinancialMath.validateDecimalInput(positionSizeUsd, 'positionSizeUsd');
    FinancialMath.validateNumberInput(
      buyFeeSchedule.takerFeePercent,
      'buyFeeSchedule.takerFeePercent',
    );
    FinancialMath.validateNumberInput(
      sellFeeSchedule.takerFeePercent,
      'sellFeeSchedule.takerFeePercent',
    );

    if (positionSizeUsd.isZero()) {
      throw new Error(
        'FinancialMath: positionSizeUsd must not be zero (division by zero)',
      );
    }

    const buyFeeCost = buyPrice.mul(
      new FinancialDecimal(buyFeeSchedule.takerFeePercent).div(100),
    );
    const sellFeeCost = sellPrice.mul(
      new FinancialDecimal(sellFeeSchedule.takerFeePercent).div(100),
    );
    const gasFraction = gasEstimateUsd.div(positionSizeUsd);

    return grossEdge.minus(buyFeeCost).minus(sellFeeCost).minus(gasFraction);
  }

  /**
   * Check if net edge meets the minimum threshold.
   *
   * @param netEdge - Calculated net edge (decimal, e.g., 0.008 = 0.8%)
   * @param threshold - Minimum threshold (decimal, e.g., 0.008 = 0.8%)
   */
  static isAboveThreshold(netEdge: Decimal, threshold: Decimal): boolean {
    FinancialMath.validateDecimalInput(netEdge, 'netEdge');
    FinancialMath.validateDecimalInput(threshold, 'threshold');

    return netEdge.gte(threshold);
  }

  private static validateDecimalInput(value: Decimal, name: string): void {
    if (value.isNaN()) {
      throw new Error(`FinancialMath: ${name} must not be NaN`);
    }
    if (!value.isFinite()) {
      throw new Error(`FinancialMath: ${name} must not be Infinity`);
    }
  }

  private static validateNumberInput(value: number, name: string): void {
    if (Number.isNaN(value)) {
      throw new Error(`FinancialMath: ${name} must not be NaN`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`FinancialMath: ${name} must not be Infinity`);
    }
  }
}
