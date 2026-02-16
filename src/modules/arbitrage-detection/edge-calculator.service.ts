import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { DegradationProtocolService } from '../data-ingestion/degradation-protocol.service';
import {
  EVENT_NAMES,
  OpportunityIdentifiedEvent,
  OpportunityFilteredEvent,
} from '../../common/events';
import { PlatformId, FeeSchedule } from '../../common/types';
import { FinancialMath, FinancialDecimal } from '../../common/utils';
import { getCorrelationId } from '../../common/services/correlation-context';
import { RawDislocation } from './types/raw-dislocation.type';
import {
  EnrichedOpportunity,
  FeeBreakdown,
  LiquidityDepth,
} from './types/enriched-opportunity.type';
import {
  EdgeCalculationResult,
  FilteredDislocation,
} from './types/edge-calculation-result.type';

@Injectable()
export class EdgeCalculatorService implements OnModuleInit {
  private readonly logger = new Logger(EdgeCalculatorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly degradationService: DegradationProtocolService,
    private readonly kalshiConnector: KalshiConnector,
    private readonly polymarketConnector: PolymarketConnector,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.validateConfig('DETECTION_MIN_EDGE_THRESHOLD', 0.008);
    this.validateConfig('DETECTION_GAS_ESTIMATE_USD', 0.3);
    this.validateConfig('DETECTION_POSITION_SIZE_USD', 300);
    this.logger.log('Edge calculator configuration validated');
  }

  private validateConfig(key: string, defaultValue: number): void {
    const value = this.configService.get<number>(key, defaultValue);
    if (value === null || value === undefined || isNaN(value)) {
      throw new Error(
        `EdgeCalculatorService: ${key} is invalid (NaN or missing)`,
      );
    }
    if (value < 0) {
      throw new Error(
        `EdgeCalculatorService: ${key} must not be negative, got ${value}`,
      );
    }
  }

  private get minEdgeThreshold(): Decimal {
    return new FinancialDecimal(
      this.configService.get<number>('DETECTION_MIN_EDGE_THRESHOLD', 0.008),
    );
  }

  private get gasEstimateUsd(): Decimal {
    return new FinancialDecimal(
      this.configService.get<number>('DETECTION_GAS_ESTIMATE_USD', 0.3),
    );
  }

  private get positionSizeUsd(): Decimal {
    return new FinancialDecimal(
      this.configService.get<number>('DETECTION_POSITION_SIZE_USD', 300),
    );
  }

  private getConnector(
    platformId: PlatformId,
  ): KalshiConnector | PolymarketConnector {
    return platformId === PlatformId.KALSHI
      ? this.kalshiConnector
      : this.polymarketConnector;
  }

  processDislocations(dislocations: RawDislocation[]): EdgeCalculationResult {
    const startTime = Date.now();
    const opportunities: EnrichedOpportunity[] = [];
    const filtered: FilteredDislocation[] = [];
    let skippedErrors = 0;

    for (const dislocation of dislocations) {
      try {
        this.processSingleDislocation(dislocation, opportunities, filtered);
      } catch (error) {
        skippedErrors++;
        this.logger.error({
          message: 'Failed to process dislocation, skipping',
          correlationId: getCorrelationId(),
          data: {
            pairEventDescription: dislocation.pairConfig.eventDescription,
            buyPlatformId: dislocation.buyPlatformId,
            sellPlatformId: dislocation.sellPlatformId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }

    const processingDurationMs = Date.now() - startTime;

    const summary = {
      totalInput: dislocations.length,
      totalFiltered: filtered.length,
      totalActionable: opportunities.length,
      skippedErrors,
      processingDurationMs,
    };

    this.logger.log({
      message: `Edge calculation complete: ${summary.totalActionable} actionable of ${summary.totalInput} input`,
      correlationId: getCorrelationId(),
      data: summary,
    });

    return { opportunities, filtered, summary };
  }

  private processSingleDislocation(
    dislocation: RawDislocation,
    opportunities: EnrichedOpportunity[],
    filtered: FilteredDislocation[],
  ): void {
    const buyFeeSchedule = this.getConnector(
      dislocation.buyPlatformId,
    ).getFeeSchedule();
    const sellFeeSchedule = this.getConnector(
      dislocation.sellPlatformId,
    ).getFeeSchedule();

    const netEdge = FinancialMath.calculateNetEdge(
      dislocation.grossEdge,
      dislocation.buyPrice,
      dislocation.sellPrice,
      buyFeeSchedule,
      sellFeeSchedule,
      this.gasEstimateUsd,
      this.positionSizeUsd,
    );

    const multiplier = this.degradationService.getEdgeThresholdMultiplier(
      dislocation.buyPlatformId,
    );
    const effectiveThreshold = this.minEdgeThreshold.mul(multiplier);

    const pairEventDescription = dislocation.pairConfig.eventDescription;

    if (!FinancialMath.isAboveThreshold(netEdge, effectiveThreshold)) {
      const reason = netEdge.isNegative() ? 'negative_edge' : 'below_threshold';

      filtered.push({
        pairEventDescription,
        netEdge: netEdge.toString(),
        threshold: effectiveThreshold.toString(),
        reason,
      });

      this.logger.debug({
        message: `Opportunity filtered: ${pairEventDescription}`,
        correlationId: getCorrelationId(),
        data: {
          pairEventDescription,
          netEdge: netEdge.toString(),
          threshold: effectiveThreshold.toString(),
          reason,
        },
      });

      this.eventEmitter.emit(
        EVENT_NAMES.OPPORTUNITY_FILTERED,
        new OpportunityFilteredEvent(
          pairEventDescription,
          netEdge,
          effectiveThreshold,
          reason,
        ),
      );

      return;
    }

    const feeBreakdown = this.buildFeeBreakdown(
      dislocation,
      buyFeeSchedule,
      sellFeeSchedule,
    );
    const liquidityDepth = this.buildLiquidityDepth(dislocation);

    const enriched: EnrichedOpportunity = {
      dislocation,
      netEdge,
      grossEdge: dislocation.grossEdge,
      feeBreakdown,
      liquidityDepth,
      recommendedPositionSize: null,
      enrichedAt: new Date(),
    };

    opportunities.push(enriched);

    this.eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      new OpportunityIdentifiedEvent(
        enriched as unknown as Record<string, unknown>,
      ),
    );
  }

  private buildFeeBreakdown(
    dislocation: RawDislocation,
    buyFeeSchedule: FeeSchedule,
    sellFeeSchedule: FeeSchedule,
  ): FeeBreakdown {
    const buyFeeCost = dislocation.buyPrice.mul(
      new FinancialDecimal(buyFeeSchedule.takerFeePercent).div(100),
    );
    const sellFeeCost = dislocation.sellPrice.mul(
      new FinancialDecimal(sellFeeSchedule.takerFeePercent).div(100),
    );
    const gasFraction = this.gasEstimateUsd.div(this.positionSizeUsd);
    const totalCosts = buyFeeCost.plus(sellFeeCost).plus(gasFraction);

    return {
      buyFeeCost,
      sellFeeCost,
      gasFraction,
      totalCosts,
      buyFeeSchedule,
      sellFeeSchedule,
    };
  }

  private buildLiquidityDepth(dislocation: RawDislocation): LiquidityDepth {
    const buyBook = dislocation.buyOrderBook;
    const sellBook = dislocation.sellOrderBook;

    return {
      buyBestAskSize: buyBook.asks.length > 0 ? buyBook.asks[0]!.quantity : 0,
      sellBestAskSize:
        sellBook.asks.length > 0 ? sellBook.asks[0]!.quantity : 0,
      buyBestBidSize: buyBook.bids.length > 0 ? buyBook.bids[0]!.quantity : 0,
      sellBestBidSize:
        sellBook.bids.length > 0 ? sellBook.bids[0]!.quantity : 0,
    };
  }
}
