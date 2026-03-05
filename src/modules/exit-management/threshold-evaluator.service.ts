import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { FinancialMath } from '../../common/utils/financial-math';

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
}

export interface ThresholdEvalResult {
  triggered: boolean;
  type?: 'stop_loss' | 'take_profit' | 'time_based';
  currentEdge: Decimal;
  currentPnl: Decimal;
  capturedEdgePercent: Decimal;
}

@Injectable()
export class ThresholdEvaluatorService {
  private readonly logger = new Logger(ThresholdEvaluatorService.name);

  evaluate(params: ThresholdEvalInput): ThresholdEvalResult {
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
      resolutionDate,
      now,
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
    // Use kalshiSize as legSize — execution guarantees equal sizes
    const legSize = kalshiSize;
    const scaledInitialEdge = initialEdge.mul(legSize);
    const currentEdge = currentPnl.div(
      legSize.isZero() ? new Decimal(1) : legSize,
    );
    const capturedEdgePercent = scaledInitialEdge.isZero()
      ? new Decimal(0)
      : currentPnl.div(scaledInitialEdge).mul(100);

    // Entry cost baseline (6.5.5i): offset thresholds by the natural MtM deficit at entry
    const {
      entryClosePriceKalshi,
      entryClosePricePolymarket,
      entryKalshiFeeRate,
      entryPolymarketFeeRate,
    } = params;

    const hasAnyEntryField =
      entryClosePriceKalshi != null ||
      entryClosePricePolymarket != null ||
      entryKalshiFeeRate != null ||
      entryPolymarketFeeRate != null;

    const entryCostBaseline = FinancialMath.computeEntryCostBaseline({
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
    });

    // Warn if partially populated (data corruption indicator) — baseline defaults to 0
    if (entryCostBaseline.isZero() && hasAnyEntryField) {
      this.logger.warn(
        'Partially populated entry close price fields — using baseline=0',
        {
          entryClosePriceKalshi: entryClosePriceKalshi?.toString() ?? 'null',
          entryClosePricePolymarket:
            entryClosePricePolymarket?.toString() ?? 'null',
          entryKalshiFeeRate: entryKalshiFeeRate?.toString() ?? 'null',
          entryPolymarketFeeRate: entryPolymarketFeeRate?.toString() ?? 'null',
        },
      );
    }

    // Priority 1: Stop-loss — currentPnl <= entryCostBaseline + -(2 * initialEdge * legSize)
    const stopLossThreshold = entryCostBaseline.plus(scaledInitialEdge.mul(-2));
    if (currentPnl.lte(stopLossThreshold)) {
      return {
        triggered: true,
        type: 'stop_loss',
        currentEdge,
        currentPnl,
        capturedEdgePercent,
      };
    }

    // Priority 2: Take-profit — journey-based with floor (6.5.5j)
    // max(0, entryCostBaseline + 0.80 * (scaledInitialEdge - entryCostBaseline))
    const takeProfitThreshold = Decimal.max(
      new Decimal(0),
      entryCostBaseline.plus(
        scaledInitialEdge.minus(entryCostBaseline).mul(new Decimal('0.80')),
      ),
    );
    if (currentPnl.gte(takeProfitThreshold)) {
      return {
        triggered: true,
        type: 'take_profit',
        currentEdge,
        currentPnl,
        capturedEdgePercent,
      };
    }

    // Priority 3: Time-based — resolutionDate - now <= 48 hours
    if (resolutionDate !== null) {
      const hoursRemaining =
        (resolutionDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursRemaining <= 48) {
        return {
          triggered: true,
          type: 'time_based',
          currentEdge,
          currentPnl,
          capturedEdgePercent,
        };
      }
    }

    return {
      triggered: false,
      currentEdge,
      currentPnl,
      capturedEdgePercent,
    };
  }

  private calculateLegPnl(
    side: string,
    entryPrice: Decimal,
    currentPrice: Decimal,
    size: Decimal,
  ): Decimal {
    if (side === 'buy') {
      // Bought at entry, close by selling at current → P&L = (current - entry) * size
      return currentPrice.minus(entryPrice).mul(size);
    }
    // Sold at entry, close by buying at current → P&L = (entry - current) * size
    return entryPrice.minus(currentPrice).mul(size);
  }
}
