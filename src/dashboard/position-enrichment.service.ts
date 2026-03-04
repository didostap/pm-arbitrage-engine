import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { IPriceFeedService } from '../common/interfaces/price-feed-service.interface.js';
import { PRICE_FEED_SERVICE_TOKEN } from '../common/interfaces/price-feed-service.interface.js';
import type { PositionRepository } from '../persistence/repositories/position.repository.js';

/** Position shape from findByStatusWithOrders() — includes pair + both orders */
type PositionWithOrders = Awaited<
  ReturnType<PositionRepository['findByStatusWithOrders']>
>[0];

export interface EnrichedPosition {
  currentPrices: { kalshi: string | null; polymarket: string | null };
  currentEdge: string | null;
  unrealizedPnl: string | null;
  exitProximity: { stopLoss: string; takeProfit: string } | null;
  resolutionDate: string | null;
  timeToResolution: string | null;
}

export interface EnrichmentResult {
  status: 'enriched' | 'partial' | 'failed';
  data: EnrichedPosition;
  errors?: string[];
}

@Injectable()
export class PositionEnrichmentService {
  constructor(
    @Inject(PRICE_FEED_SERVICE_TOKEN)
    private readonly priceFeed: IPriceFeedService,
  ) {}

  async enrich(position: PositionWithOrders): Promise<EnrichmentResult> {
    const errors: string[] = [];
    const pair = position.pair;
    const kalshiOrder = position.kalshiOrder;
    const polymarketOrder = position.polymarketOrder;

    // Resolution date / time to resolution
    const resolutionDate = pair.resolutionDate
      ? pair.resolutionDate.toISOString()
      : null;
    const timeToResolution = pair.resolutionDate
      ? this.computeTimeToResolution(pair.resolutionDate)
      : null;

    // Default empty result
    const emptyData: EnrichedPosition = {
      currentPrices: { kalshi: null, polymarket: null },
      currentEdge: null,
      unrealizedPnl: null,
      exitProximity: null,
      resolutionDate,
      timeToResolution,
    };

    // Validate order fill data
    if (
      !kalshiOrder?.fillPrice ||
      !kalshiOrder?.fillSize ||
      !polymarketOrder?.fillPrice ||
      !polymarketOrder?.fillSize
    ) {
      errors.push('Missing order fill data — cannot compute P&L');
      return { status: 'failed', data: emptyData, errors };
    }

    if (!position.kalshiSide || !position.polymarketSide) {
      errors.push('Missing side data — cannot compute P&L');
      return { status: 'failed', data: emptyData, errors };
    }

    // Fetch current close prices
    const [kalshiClosePrice, polymarketClosePrice] = await Promise.all([
      this.priceFeed.getCurrentClosePrice(
        'kalshi',
        pair.kalshiContractId,
        position.kalshiSide as 'buy' | 'sell',
      ),
      this.priceFeed.getCurrentClosePrice(
        'polymarket',
        pair.polymarketContractId,
        position.polymarketSide as 'buy' | 'sell',
      ),
    ]);

    const currentPrices = {
      kalshi: kalshiClosePrice?.toString() ?? null,
      polymarket: polymarketClosePrice?.toString() ?? null,
    };

    // If either price unavailable
    if (kalshiClosePrice === null || polymarketClosePrice === null) {
      if (kalshiClosePrice === null)
        errors.push('Kalshi close price unavailable');
      if (polymarketClosePrice === null)
        errors.push('Polymarket close price unavailable');

      const status =
        kalshiClosePrice === null && polymarketClosePrice === null
          ? 'failed'
          : 'partial';

      return {
        status,
        data: {
          currentPrices,
          currentEdge: null,
          unrealizedPnl: null,
          exitProximity: null,
          resolutionDate,
          timeToResolution,
        },
        errors,
      };
    }

    // Extract Decimal values from orders
    const kalshiEntryPrice = new Decimal(kalshiOrder.fillPrice.toString());
    const polymarketEntryPrice = new Decimal(
      polymarketOrder.fillPrice.toString(),
    );
    const kalshiSize = new Decimal(kalshiOrder.fillSize.toString());
    const polymarketSize = new Decimal(polymarketOrder.fillSize.toString());
    const initialEdge = new Decimal(position.expectedEdge.toString());

    // Fee rates
    const kalshiFeeDecimal = this.priceFeed.getTakerFeeRate(
      'kalshi',
      kalshiClosePrice,
    );
    const polymarketFeeDecimal = this.priceFeed.getTakerFeeRate(
      'polymarket',
      polymarketClosePrice,
    );

    // Per-leg P&L (same formula as ThresholdEvaluatorService)
    const kalshiPnl = this.calculateLegPnl(
      position.kalshiSide,
      kalshiEntryPrice,
      kalshiClosePrice,
      kalshiSize,
    );
    const polymarketPnl = this.calculateLegPnl(
      position.polymarketSide,
      polymarketEntryPrice,
      polymarketClosePrice,
      polymarketSize,
    );

    // Exit fees
    const kalshiExitFee = kalshiClosePrice
      .mul(kalshiSize)
      .mul(kalshiFeeDecimal);
    const polymarketExitFee = polymarketClosePrice
      .mul(polymarketSize)
      .mul(polymarketFeeDecimal);
    const totalExitFees = kalshiExitFee.plus(polymarketExitFee);

    // Totals
    const currentPnl = kalshiPnl.plus(polymarketPnl).minus(totalExitFees);
    const minLegSize = Decimal.min(kalshiSize, polymarketSize);
    const currentEdge = currentPnl.div(
      minLegSize.isZero() ? new Decimal(1) : minLegSize,
    );

    // Exit proximity
    const scaledInitialEdge = initialEdge.mul(minLegSize);
    const stopLossThreshold = scaledInitialEdge.mul(-2);
    const takeProfitThreshold = scaledInitialEdge.mul(new Decimal('0.80'));

    const stopLossProximity = Decimal.min(
      new Decimal(1),
      Decimal.max(
        new Decimal(0),
        stopLossThreshold.isZero()
          ? new Decimal(0)
          : currentPnl.div(stopLossThreshold).abs(),
      ),
    );
    const takeProfitProximity = Decimal.min(
      new Decimal(1),
      Decimal.max(
        new Decimal(0),
        takeProfitThreshold.isZero()
          ? new Decimal(0)
          : currentPnl.div(takeProfitThreshold),
      ),
    );

    return {
      status: 'enriched',
      data: {
        currentPrices,
        currentEdge: currentEdge.toFixed(8),
        unrealizedPnl: currentPnl.toFixed(8),
        exitProximity: {
          stopLoss: stopLossProximity.toFixed(8),
          takeProfit: takeProfitProximity.toFixed(8),
        },
        resolutionDate,
        timeToResolution,
      },
    };
  }

  private calculateLegPnl(
    side: string,
    entryPrice: Decimal,
    currentPrice: Decimal,
    size: Decimal,
  ): Decimal {
    if (side === 'buy') {
      return currentPrice.minus(entryPrice).mul(size);
    }
    return entryPrice.minus(currentPrice).mul(size);
  }

  private computeTimeToResolution(resolutionDate: Date): string {
    const now = new Date();
    const diffMs = resolutionDate.getTime() - now.getTime();
    if (diffMs <= 0) return '< 1h';

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;

    if (days > 0) return `${days}d ${remainingHours}h`;
    return `${hours}h`;
  }
}
