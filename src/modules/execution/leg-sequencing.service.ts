import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type { ExecutionResult } from '../../common/interfaces/execution-engine.interface';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { PlatformId } from '../../common/types/platform.type';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';
import {
  OrderFilledEvent,
  SingleLegExposureEvent,
} from '../../common/events/execution.events';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import {
  calculateSingleLegPnlScenarios,
  buildRecommendedActions,
} from './single-leg-pnl.util';
import { FinancialMath } from '../../common/utils/financial-math';
import {
  asContractId,
  asOrderId,
  asPairId,
  asPositionId,
} from '../../common/types/branded.type';
import type { SingleLegContext } from './single-leg-context.type';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';

export interface SequencingDecision {
  primaryLeg: 'kalshi' | 'polymarket';
  reason: 'static_config' | 'latency_override';
  kalshiLatencyMs: number | null;
  polymarketLatencyMs: number | null;
}

@Injectable()
export class LegSequencingService {
  private readonly logger = new Logger(LegSequencingService.name);

  constructor(
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    private readonly positionRepository: PositionRepository,
    private readonly configService: ConfigService,
    /** Deviation from 5-dep target: PlatformHealthService needed for adaptive sequencing latency data.
     *  This is inherently a sequencing concern — per design doc Section 3.3, Option A. */
    private readonly platformHealthService: PlatformHealthService,
  ) {}

  resolveConnectors(primaryLeg: 'kalshi' | 'polymarket'): {
    primaryConnector: IPlatformConnector;
    secondaryConnector: IPlatformConnector;
    primaryPlatform: PlatformId;
    secondaryPlatform: PlatformId;
  } {
    if (primaryLeg === 'kalshi') {
      return {
        primaryConnector: this.kalshiConnector,
        secondaryConnector: this.polymarketConnector,
        primaryPlatform: PlatformId.KALSHI,
        secondaryPlatform: PlatformId.POLYMARKET,
      };
    }
    return {
      primaryConnector: this.polymarketConnector,
      secondaryConnector: this.kalshiConnector,
      primaryPlatform: PlatformId.POLYMARKET,
      secondaryPlatform: PlatformId.KALSHI,
    };
  }

  determineSequencing(
    staticPrimaryLeg: 'kalshi' | 'polymarket',
  ): SequencingDecision {
    const enabledRaw = this.configService.get<boolean | string>(
      'ADAPTIVE_SEQUENCING_ENABLED',
      true,
    );
    const enabled = enabledRaw === true || enabledRaw === 'true';
    if (!enabled) {
      return {
        primaryLeg: staticPrimaryLeg,
        reason: 'static_config',
        kalshiLatencyMs: null,
        polymarketLatencyMs: null,
      };
    }

    const kalshiHealth = this.platformHealthService.getPlatformHealth(
      PlatformId.KALSHI,
    );
    const polymarketHealth = this.platformHealthService.getPlatformHealth(
      PlatformId.POLYMARKET,
    );
    const kalshiLatencyMs = kalshiHealth.latencyMs ?? null;
    const polymarketLatencyMs = polymarketHealth.latencyMs ?? null;

    // Null fallback: if either platform has no latency data, use static config
    if (kalshiLatencyMs === null || polymarketLatencyMs === null) {
      return {
        primaryLeg: staticPrimaryLeg,
        reason: 'static_config',
        kalshiLatencyMs,
        polymarketLatencyMs,
      };
    }

    const threshold = Number(
      this.configService.get('ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS', '200'),
    );
    const delta = Math.abs(kalshiLatencyMs - polymarketLatencyMs);

    if (delta > threshold) {
      const overridePrimaryLeg =
        kalshiLatencyMs < polymarketLatencyMs ? 'kalshi' : 'polymarket';
      this.logger.log({
        message: 'Adaptive sequencing override',
        module: 'execution',
        data: {
          staticPrimaryLeg,
          overridePrimaryLeg,
          kalshiLatencyMs,
          polymarketLatencyMs,
          delta,
          threshold,
        },
      });
      return {
        primaryLeg: overridePrimaryLeg,
        reason: 'latency_override',
        kalshiLatencyMs,
        polymarketLatencyMs,
      };
    }

    return {
      primaryLeg: staticPrimaryLeg,
      reason: 'static_config',
      kalshiLatencyMs,
      polymarketLatencyMs,
    };
  }

  async handleSingleLeg(context: SingleLegContext): Promise<ExecutionResult> {
    const {
      pairId,
      primaryLeg,
      primaryOrderId,
      primaryOrder,
      primarySide,
      secondarySide,
      primaryPrice,
      secondaryPrice,
      primarySize,
      secondarySize,
      enriched,
      opportunity,
      errorCode,
      errorMessage,
      isPaper,
      mixedMode,
    } = context;

    const kalshiSide = primaryLeg === 'kalshi' ? primarySide : secondarySide;
    const polymarketSide =
      primaryLeg === 'kalshi' ? secondarySide : primarySide;
    const kalshiPrice = primaryLeg === 'kalshi' ? primaryPrice : secondaryPrice;
    const polymarketPrice =
      primaryLeg === 'kalshi' ? secondaryPrice : primaryPrice;
    const kalshiSize = primaryLeg === 'kalshi' ? primarySize : secondarySize;
    const polymarketSize =
      primaryLeg === 'kalshi' ? secondarySize : primarySize;

    const kalshiOrderConnect =
      primaryLeg === 'kalshi'
        ? { connect: { orderId: primaryOrderId } }
        : undefined;
    const polymarketOrderConnect =
      primaryLeg === 'polymarket'
        ? { connect: { orderId: primaryOrderId } }
        : undefined;

    const position = await this.positionRepository.create({
      pair: { connect: { matchId: pairId } },
      ...(kalshiOrderConnect ? { kalshiOrder: kalshiOrderConnect } : {}),
      ...(polymarketOrderConnect
        ? { polymarketOrder: polymarketOrderConnect }
        : {}),
      kalshiSide,
      polymarketSide,
      entryPrices: {
        kalshi: kalshiPrice.toString(),
        polymarket: polymarketPrice.toString(),
      },
      sizes: {
        kalshi: kalshiSize.toString(),
        polymarket: polymarketSize.toString(),
      },
      expectedEdge: enriched.netEdge.toNumber(),
      status: 'SINGLE_LEG_EXPOSED',
      isPaper,

      ...(context.executionMetadata
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          { executionMetadata: context.executionMetadata as any }
        : {}),
    });

    // Emit OrderFilledEvent for the filled primary leg only
    const primaryPlatform =
      primaryLeg === 'kalshi' ? PlatformId.KALSHI : PlatformId.POLYMARKET;
    const primaryLegConnector =
      primaryLeg === 'kalshi' ? this.kalshiConnector : this.polymarketConnector;
    const singleLegFeeRate = FinancialMath.calculateTakerFeeRate(
      new Decimal(primaryOrder.filledPrice),
      primaryLegConnector.getFeeSchedule(),
    );
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        asOrderId(primaryOrderId),
        primaryPlatform,
        primarySide,
        primaryPrice.toNumber(),
        primarySize,
        primaryOrder.filledPrice,
        primaryOrder.filledQuantity,
        asPositionId(position.positionId),
        undefined,
        isPaper,
        mixedMode,
        singleLegFeeRate.toString(),
        null,
      ),
    );

    this.logger.warn({
      message: 'Single-leg exposure detected',
      module: 'execution',
      data: {
        positionId: position.positionId,
        pairId,
        errorCode,
        errorMessage,
        opportunityId: opportunity.reservationRequest.opportunityId,
      },
    });

    // Fetch current order books for P&L scenarios (2s timeout per fetch)
    const ORDERBOOK_FETCH_TIMEOUT_MS = 2000;
    const withTimeout = <T>(
      promise: Promise<T>,
      ms: number,
    ): Promise<T | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);

    const { pairConfig } = enriched.dislocation;
    const [kalshiBook, polymarketBook] = await Promise.all([
      withTimeout(
        this.kalshiConnector.getOrderBook(
          asContractId(pairConfig.kalshiContractId),
        ),
        ORDERBOOK_FETCH_TIMEOUT_MS,
      ).catch(() => null),
      withTimeout(
        this.polymarketConnector.getOrderBook(
          asContractId(pairConfig.polymarketClobTokenId),
        ),
        ORDERBOOK_FETCH_TIMEOUT_MS,
      ).catch(() => null),
    ]);

    const currentPrices = {
      kalshi: kalshiBook
        ? {
            bestBid: kalshiBook.bids[0]?.price ?? null,
            bestAsk: kalshiBook.asks[0]?.price ?? null,
          }
        : { bestBid: null, bestAsk: null },
      polymarket: polymarketBook
        ? {
            bestBid: polymarketBook.bids[0]?.price ?? null,
            bestAsk: polymarketBook.asks[0]?.price ?? null,
          }
        : { bestBid: null, bestAsk: null },
    };

    const secondaryPlatform =
      primaryLeg === 'kalshi' ? PlatformId.POLYMARKET : PlatformId.KALSHI;
    const kalshiFee = this.kalshiConnector.getFeeSchedule();
    const polymarketFee = this.polymarketConnector.getFeeSchedule();

    const primaryFeeSchedule =
      primaryPlatform === PlatformId.KALSHI ? kalshiFee : polymarketFee;
    const secondaryFeeSchedule =
      secondaryPlatform === PlatformId.KALSHI ? kalshiFee : polymarketFee;
    const primaryTakerFeeDecimal = new Decimal(
      primaryFeeSchedule.takerFeePercent,
    )
      .div(100)
      .toNumber();
    const secondaryTakerFeeDecimal = new Decimal(
      secondaryFeeSchedule.takerFeePercent,
    )
      .div(100)
      .toNumber();

    const pnlScenarios = calculateSingleLegPnlScenarios({
      filledPlatform: primaryPlatform,
      filledSide: primarySide,
      fillPrice: primaryOrder.filledPrice,
      fillSize: primaryOrder.filledQuantity,
      currentPrices,
      secondaryPlatform,
      secondarySide,
      takerFeeDecimal: primaryTakerFeeDecimal,
      secondaryTakerFeeDecimal,
      takerFeeForPrice: primaryFeeSchedule.takerFeeForPrice,
      secondaryTakerFeeForPrice: secondaryFeeSchedule.takerFeeForPrice,
    });

    const recommendedActions = buildRecommendedActions(
      pnlScenarios,
      position.positionId,
    );

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      new SingleLegExposureEvent(
        asPositionId(position.positionId),
        asPairId(pairId),
        enriched.netEdge.toNumber(),
        {
          platform: primaryPlatform,
          orderId: asOrderId(primaryOrderId),
          side: primarySide,
          price: primaryPrice.toNumber(),
          size: primarySize,
          fillPrice: primaryOrder.filledPrice,
          fillSize: primaryOrder.filledQuantity,
        },
        {
          platform: secondaryPlatform,
          reason: errorMessage,
          reasonCode: errorCode,
          attemptedPrice: secondaryPrice.toNumber(),
          attemptedSize: secondarySize,
        },
        currentPrices,
        pnlScenarios,
        recommendedActions,
        undefined,
        undefined,
        isPaper,
        mixedMode,
      ),
    );

    const error = new ExecutionError(
      EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      errorMessage,
      'critical',
      undefined,
      {
        positionId: position.positionId,
        pairId,
        reasonCode: errorCode,
        pnlScenarios,
        recommendedActions,
      },
    );

    return {
      success: false,
      partialFill: true,
      positionId: asPositionId(position.positionId),
      primaryOrder,
      error,
    };
  }
}
