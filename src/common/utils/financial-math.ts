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
   * Formula: sellPrice - buyPrice (signed — positive means profitable arb)
   *
   * @param buyPrice - YES price on the buy-side platform (0-1 decimal probability)
   * @param sellPrice - YES price on the sell-side platform (0-1 decimal probability)
   */
  static calculateGrossEdge(buyPrice: Decimal, sellPrice: Decimal): Decimal {
    FinancialMath.validateDecimalInput(buyPrice, 'buyPrice');
    FinancialMath.validateDecimalInput(sellPrice, 'sellPrice');

    // Cross-platform arb: buy YES at ask on platform A, sell YES at bid on platform B.
    // Profit per contract = sellBid - buyAsk. Negative means no arb.
    return sellPrice.minus(buyPrice);
  }

  /**
   * Calculate net edge after fees and gas.
   * Formula:
   *   buyFeeRate = calculateTakerFeeRate(buyPrice, buyFeeSchedule)
   *   buyFeeCost = buyPrice * buyFeeRate
   *   sellFeeRate = calculateTakerFeeRate(sellPrice, sellFeeSchedule)
   *   sellFeeCost = sellPrice * sellFeeRate
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

    const buyFeeRate = FinancialMath.calculateTakerFeeRate(
      buyPrice,
      buyFeeSchedule,
    );
    const sellFeeRate = FinancialMath.calculateTakerFeeRate(
      sellPrice,
      sellFeeSchedule,
    );
    const buyFeeCost = buyPrice.mul(buyFeeRate);
    const sellFeeCost = sellPrice.mul(sellFeeRate);
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

  /**
   * Returns the taker fee rate as a decimal fraction for the given price and fee schedule.
   * Uses the dynamic `takerFeeForPrice` callback when present, falls back to `takerFeePercent / 100`.
   */
  static calculateTakerFeeRate(
    price: Decimal,
    feeSchedule: FeeSchedule,
  ): Decimal {
    if (feeSchedule.takerFeeForPrice) {
      return new FinancialDecimal(
        feeSchedule.takerFeeForPrice(price.toNumber()),
      );
    }
    return new FinancialDecimal(feeSchedule.takerFeePercent).div(100);
  }

  /**
   * Compute the mark-to-market entry cost baseline for threshold calibration (6.5.5i).
   * Returns a non-positive Decimal representing the natural MtM deficit at position entry
   * (spread cost + exit fees at entry close prices). Returns Decimal(0) when any input is null.
   */
  static computeEntryCostBaseline(params: {
    kalshiEntryPrice: Decimal;
    polymarketEntryPrice: Decimal;
    kalshiSide: string;
    polymarketSide: string;
    kalshiSize: Decimal;
    polymarketSize: Decimal;
    entryClosePriceKalshi: Decimal | null | undefined;
    entryClosePricePolymarket: Decimal | null | undefined;
    entryKalshiFeeRate: Decimal | null | undefined;
    entryPolymarketFeeRate: Decimal | null | undefined;
  }): Decimal {
    const {
      kalshiEntryPrice,
      polymarketEntryPrice,
      kalshiSide,
      polymarketSide,
      kalshiSize,
      polymarketSize,
      entryClosePriceKalshi,
      entryClosePricePolymarket,
      entryKalshiFeeRate,
      entryPolymarketFeeRate,
    } = params;

    if (
      entryClosePriceKalshi == null ||
      entryClosePricePolymarket == null ||
      entryKalshiFeeRate == null ||
      entryPolymarketFeeRate == null
    ) {
      return new Decimal(0);
    }

    // Spread cost (direction-aware, clamped to >= 0)
    const kalshiSpread =
      kalshiSide === 'buy'
        ? Decimal.max(
            new Decimal(0),
            kalshiEntryPrice.minus(entryClosePriceKalshi),
          )
        : Decimal.max(
            new Decimal(0),
            entryClosePriceKalshi.minus(kalshiEntryPrice),
          );
    const polymarketSpread =
      polymarketSide === 'buy'
        ? Decimal.max(
            new Decimal(0),
            polymarketEntryPrice.minus(entryClosePricePolymarket),
          )
        : Decimal.max(
            new Decimal(0),
            entryClosePricePolymarket.minus(polymarketEntryPrice),
          );

    const spreadCost = kalshiSpread
      .mul(kalshiSize)
      .plus(polymarketSpread.mul(polymarketSize));

    // Exit fees at entry close prices using persisted fee rates
    const entryExitFees = entryClosePriceKalshi
      .mul(kalshiSize)
      .mul(entryKalshiFeeRate)
      .plus(
        entryClosePricePolymarket
          .mul(polymarketSize)
          .mul(entryPolymarketFeeRate),
      );

    return spreadCost.plus(entryExitFees).neg();
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
