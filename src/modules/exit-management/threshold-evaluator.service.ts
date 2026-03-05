import { Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';

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

    // Priority 1: Stop-loss — currentPnl <= -(2 * initialEdge * legSize)
    // The 2x multiplier is a conservative default for binary options arbitrage:
    // - Initial edges are small (0.8%-5%), so 2x provides enough room for normal
    //   market oscillation without premature exit
    // - Binary option prices are bounded [0,1], limiting downside vs. unbounded assets
    // - Consistent with mean-reversion stop-loss practice (2-3x entry signal)
    // TODO: Consider making configurable via EXIT_STOP_LOSS_MULTIPLIER env var
    //       for tuning during paper trading validation
    const stopLossThreshold = scaledInitialEdge.mul(-2);
    if (currentPnl.lte(stopLossThreshold)) {
      return {
        triggered: true,
        type: 'stop_loss',
        currentEdge,
        currentPnl,
        capturedEdgePercent,
      };
    }

    // Priority 2: Take-profit — currentPnl >= 0.80 * initialEdge * legSize
    const takeProfitThreshold = scaledInitialEdge.mul(new Decimal('0.80'));
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
