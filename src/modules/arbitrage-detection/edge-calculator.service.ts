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
import {
  FinancialMath,
  FinancialDecimal,
  calculateVwapWithFillInfo,
} from '../../common/utils';
import { ConfigValidationError } from '../../common/errors';
import { getCorrelationId } from '../../common/services/correlation-context';
import { RawDislocation } from './types/raw-dislocation.type';
import { EnrichedOpportunity } from './types/enriched-opportunity.type';
import {
  EdgeCalculationResult,
  FilteredDislocation,
} from './types/edge-calculation-result.type';
import {
  buildLiquidityDepth,
  buildFeeBreakdown,
  filterInsufficientVwapDepth,
  checkCapitalEfficiency,
} from './edge-calculator.helpers';

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

  private minEdgeThreshold: Decimal = new FinancialDecimal(0.008);
  private detectionMinFillRatio: Decimal = new FinancialDecimal(0.25);
  private depthEdgeScalingFactor: Decimal = new FinancialDecimal(10);
  private maxDynamicEdgeThreshold: Decimal = new FinancialDecimal(0.05);

  onModuleInit(): void {
    this.validateConfig('DETECTION_MIN_EDGE_THRESHOLD', 0.008);
    this.validateConfig('DETECTION_GAS_ESTIMATE_USD', 0.3);
    this.validateConfig('DETECTION_POSITION_SIZE_USD', 300);
    this.minEdgeThreshold = new FinancialDecimal(
      this.configService.get<string>('DETECTION_MIN_EDGE_THRESHOLD', '0.008'),
    );
    this.validateMinAnnualizedReturn();
    this.validateDetectionMinFillRatio();
    this.validateDepthEdgeScalingFactor();
    this.validateMaxDynamicEdgeThreshold();
    this.logger.log('Edge calculator configuration validated');
  }

  private validateConfig(key: string, defaultValue: number): void {
    const raw = this.configService.get<string>(key, String(defaultValue));
    const value = Number(raw);
    if (isNaN(value)) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: ${key} is invalid (NaN or missing)`,
        [`${key}: ${raw} is not a valid number`],
      );
    }
    if (value < 0) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: ${key} must not be negative, got ${value}`,
        [`${key}: ${value} is negative`],
      );
    }
  }

  private validateMinAnnualizedReturn(): void {
    const value = new FinancialDecimal(
      this.configService.get<string>('MIN_ANNUALIZED_RETURN', '0.15'),
    );
    if (value.isNeg()) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: MIN_ANNUALIZED_RETURN must not be negative, got ${value.toString()}`,
        [`MIN_ANNUALIZED_RETURN: ${value.toString()} is negative`],
      );
    }
    if (value.gt(10)) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: MIN_ANNUALIZED_RETURN must not exceed 10.0 (1000%), got ${value.toString()}`,
        [`MIN_ANNUALIZED_RETURN: ${value.toString()} exceeds maximum 10.0`],
      );
    }
    this.logger.log(
      `Capital efficiency gate: MIN_ANNUALIZED_RETURN = ${value.mul(100).toFixed(0)}%`,
    );
  }

  private get minAnnualizedReturn(): Decimal {
    return new FinancialDecimal(
      this.configService.get<string>('MIN_ANNUALIZED_RETURN', '0.15'),
    );
  }

  private validateDetectionMinFillRatio(): void {
    const raw = this.configService.get<string>(
      'DETECTION_MIN_FILL_RATIO',
      '0.25',
    );
    const val = Number(raw);
    if (isNaN(val) || val <= 0 || val > 1.0) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: DETECTION_MIN_FILL_RATIO must be > 0 and <= 1.0, got ${raw}`,
        [`DETECTION_MIN_FILL_RATIO: ${raw} is out of range (0, 1.0]`],
      );
    }
    this.detectionMinFillRatio = new FinancialDecimal(val);
  }

  private validateDepthEdgeScalingFactor(): void {
    const raw = this.configService.get<string>(
      'DEPTH_EDGE_SCALING_FACTOR',
      '10',
    );
    const val = Number(raw);
    if (isNaN(val) || val < 0) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: DEPTH_EDGE_SCALING_FACTOR must be >= 0, got ${raw}`,
        [`DEPTH_EDGE_SCALING_FACTOR: ${raw} is negative or invalid`],
      );
    }
    this.depthEdgeScalingFactor = new FinancialDecimal(val);
  }

  private validateMaxDynamicEdgeThreshold(): void {
    const raw = this.configService.get<string>(
      'MAX_DYNAMIC_EDGE_THRESHOLD',
      '0.05',
    );
    const val = Number(raw);
    if (isNaN(val) || val <= 0 || val > 1.0) {
      throw new ConfigValidationError(
        `EdgeCalculatorService: MAX_DYNAMIC_EDGE_THRESHOLD must be > 0 and <= 1.0, got ${raw}`,
        [`MAX_DYNAMIC_EDGE_THRESHOLD: ${raw} is out of range (0, 1.0]`],
      );
    }
    this.maxDynamicEdgeThreshold = new FinancialDecimal(val);
  }

  reloadConfig(settings: {
    minEdgeThreshold?: string;
    detectionMinFillRatio?: string;
    depthEdgeScalingFactor?: string;
    maxDynamicEdgeThreshold?: string;
  }): void {
    if (settings.minEdgeThreshold !== undefined) {
      const val = Number(settings.minEdgeThreshold);
      if (isNaN(val) || val < 0) {
        this.logger.warn({
          message: `Invalid minEdgeThreshold: ${settings.minEdgeThreshold}, keeping current value`,
        });
      } else {
        this.minEdgeThreshold = new FinancialDecimal(val);
        this.logger.log(
          `Min edge threshold updated to ${this.minEdgeThreshold.toString()}`,
        );
      }
    }
    if (settings.detectionMinFillRatio !== undefined) {
      const val = Number(settings.detectionMinFillRatio);
      if (isNaN(val) || val <= 0 || val > 1.0) {
        this.logger.warn({
          message: `Invalid detectionMinFillRatio: ${settings.detectionMinFillRatio}, keeping current value`,
        });
      } else {
        this.detectionMinFillRatio = new FinancialDecimal(val);
        this.logger.log(
          `Detection min fill ratio updated to ${this.detectionMinFillRatio.toString()}`,
        );
      }
    }
    if (settings.depthEdgeScalingFactor !== undefined) {
      const val = Number(settings.depthEdgeScalingFactor);
      if (isNaN(val) || val < 0) {
        this.logger.warn({
          message: `Invalid depthEdgeScalingFactor: ${settings.depthEdgeScalingFactor}, keeping current value`,
        });
      } else {
        this.depthEdgeScalingFactor = new FinancialDecimal(val);
        this.logger.log(
          `Depth edge scaling factor updated to ${this.depthEdgeScalingFactor.toString()}`,
        );
      }
    }
    if (settings.maxDynamicEdgeThreshold !== undefined) {
      const val = Number(settings.maxDynamicEdgeThreshold);
      if (isNaN(val) || val <= 0 || val > 1.0) {
        this.logger.warn({
          message: `Invalid maxDynamicEdgeThreshold: ${settings.maxDynamicEdgeThreshold}, keeping current value`,
        });
      } else {
        this.maxDynamicEdgeThreshold = new FinancialDecimal(val);
        this.logger.log(
          `Max dynamic edge threshold updated to ${this.maxDynamicEdgeThreshold.toString()}`,
        );
      }
    }
  }

  private computeDynamicThreshold(minDepth: Decimal): Decimal {
    const scalingTerm = this.depthEdgeScalingFactor.div(minDepth);
    const dynamicBase = this.minEdgeThreshold.mul(
      new FinancialDecimal(1).plus(scalingTerm),
    );
    return Decimal.min(dynamicBase, this.maxDynamicEdgeThreshold);
  }

  private getGasEstimateUsd(...feeSchedules: FeeSchedule[]): Decimal {
    // Use dynamic gas estimate from FeeSchedule if available (Polymarket path)
    for (const schedule of feeSchedules) {
      if (schedule.gasEstimateUsd !== undefined) {
        return new FinancialDecimal(schedule.gasEstimateUsd);
      }
    }
    // Fallback to static config (Kalshi-only path)
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

    const gasEstimate = this.getGasEstimateUsd(buyFeeSchedule, sellFeeSchedule);

    const pairEventDescription = dislocation.pairConfig.eventDescription;

    // --- VWAP computation (Story 10-7-2) ---

    // Guard: zero prices → cannot compute VWAP target contracts
    if (dislocation.buyPrice.isZero() || dislocation.sellPrice.isZero()) {
      filterInsufficientVwapDepth(
        pairEventDescription,
        dislocation,
        filtered,
        this.eventEmitter,
      );
      return;
    }

    // Convert USD position size → target contract counts using best-level prices
    const buyTargetContracts = this.positionSizeUsd
      .div(dislocation.buyPrice)
      .ceil();
    const sellTargetContracts = this.positionSizeUsd
      .div(dislocation.sellPrice)
      .ceil();

    // Compute VWAP for both legs
    // Buy leg: buying at ask side → closeSide='sell' walks asks (counterintuitive — see design doc)
    const buyVwapResult = calculateVwapWithFillInfo(
      dislocation.buyOrderBook,
      'sell',
      buyTargetContracts,
    );
    // Sell leg: selling at bid side → closeSide='buy' walks bids
    const sellVwapResult = calculateVwapWithFillInfo(
      dislocation.sellOrderBook,
      'buy',
      sellTargetContracts,
    );

    // Null VWAP = empty book side → filter
    if (!buyVwapResult || !sellVwapResult) {
      filterInsufficientVwapDepth(
        pairEventDescription,
        dislocation,
        filtered,
        this.eventEmitter,
      );
      return;
    }

    // Check fill ratios against detectionMinFillRatio
    const buyFillRatio = buyVwapResult.filledQty.div(buyTargetContracts);
    const sellFillRatio = sellVwapResult.filledQty.div(sellTargetContracts);

    if (
      buyFillRatio.lt(this.detectionMinFillRatio) ||
      sellFillRatio.lt(this.detectionMinFillRatio)
    ) {
      filterInsufficientVwapDepth(
        pairEventDescription,
        dislocation,
        filtered,
        this.eventEmitter,
      );
      return;
    }

    const vwapBuyPrice = buyVwapResult.vwap;
    const vwapSellPrice = sellVwapResult.vwap;

    // Best-level net edge (for comparison logging)
    const bestLevelNetEdge = FinancialMath.calculateNetEdge(
      dislocation.grossEdge,
      dislocation.buyPrice,
      dislocation.sellPrice,
      buyFeeSchedule,
      sellFeeSchedule,
      gasEstimate,
      this.positionSizeUsd,
    );

    // VWAP-based gross edge and net edge
    const vwapGrossEdge = vwapSellPrice.minus(vwapBuyPrice);
    const netEdge = FinancialMath.calculateNetEdge(
      vwapGrossEdge,
      vwapBuyPrice,
      vwapSellPrice,
      buyFeeSchedule,
      sellFeeSchedule,
      gasEstimate,
      this.positionSizeUsd,
    );

    this.logger.debug({
      message: `Edge comparison: ${pairEventDescription}`,
      correlationId: getCorrelationId(),
      data: {
        bestLevelNetEdge: bestLevelNetEdge.toString(),
        vwapNetEdge: netEdge.toString(),
        edgeDelta: bestLevelNetEdge.minus(netEdge).toString(),
      },
    });

    // --- Threshold filtering (uses VWAP edge) ---

    const multiplier = this.degradationService.getEdgeThresholdMultiplier(
      dislocation.buyPlatformId,
    );

    // Dynamic threshold: scale inversely with book depth
    // Falls back to static minEdgeThreshold when scalingFactor=0 (disabled) or minDepth=0 (unreachable — VWAP null check upstream)
    let dynamicBase = this.minEdgeThreshold;
    if (this.depthEdgeScalingFactor.gt(0)) {
      const minDepth = Decimal.min(
        buyVwapResult.totalQtyAvailable,
        sellVwapResult.totalQtyAvailable,
      );
      if (minDepth.gt(0)) {
        dynamicBase = this.computeDynamicThreshold(minDepth);
      }
    }
    const effectiveThreshold = dynamicBase.mul(multiplier);

    this.logger.debug({
      message: `Threshold: ${pairEventDescription}`,
      correlationId: getCorrelationId(),
      data: {
        baseMinEdge: this.minEdgeThreshold.toString(),
        dynamicBase: dynamicBase.toString(),
        multiplier: multiplier.toString(),
        effectiveThreshold: effectiveThreshold.toString(),
      },
    });

    if (!FinancialMath.isAboveThreshold(netEdge, effectiveThreshold)) {
      const reason = netEdge.isNegative() ? 'negative_edge' : 'below_threshold';

      filtered.push({
        pairEventDescription,
        netEdge: netEdge.toString(),
        threshold: effectiveThreshold.toString(),
        reason,
        bestLevelNetEdge: bestLevelNetEdge.toString(),
      });

      this.logger.debug({
        message: `Opportunity filtered: ${pairEventDescription}`,
        correlationId: getCorrelationId(),
        data: {
          pairEventDescription,
          netEdge: netEdge.toString(),
          bestLevelNetEdge: bestLevelNetEdge.toString(),
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
          undefined,
          { matchId: dislocation.pairConfig.matchId },
        ),
      );

      return;
    }

    // Capital efficiency gate (FR-AD-08): resolution date + annualized return
    const { passed, annualizedReturn } = checkCapitalEfficiency({
      dislocation,
      netEdge,
      pairEventDescription,
      filtered,
      minAnnualizedReturn: this.minAnnualizedReturn,
      logger: this.logger,
      eventEmitter: this.eventEmitter,
    });
    if (!passed) return;

    const feeBreakdown = buildFeeBreakdown(
      dislocation,
      buyFeeSchedule,
      sellFeeSchedule,
      gasEstimate,
      this.positionSizeUsd,
    );
    const liquidityDepth = buildLiquidityDepth(dislocation);

    const enriched: EnrichedOpportunity = {
      dislocation,
      netEdge,
      grossEdge: vwapGrossEdge,
      bestLevelNetEdge,
      vwapBuyPrice,
      vwapSellPrice,
      buyFillRatio: buyFillRatio.toNumber(),
      sellFillRatio: sellFillRatio.toNumber(),
      feeBreakdown,
      liquidityDepth,
      recommendedPositionSize: null,
      annualizedReturn,
      effectiveMinEdge: effectiveThreshold,
      enrichedAt: new Date(),
    };

    opportunities.push(enriched);

    this.eventEmitter.emit(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      new OpportunityIdentifiedEvent({
        netEdge: netEdge.toNumber(),
        grossEdge: vwapGrossEdge.toNumber(),
        bestLevelNetEdge: bestLevelNetEdge.toNumber(),
        vwapBuyPrice: vwapBuyPrice.toNumber(),
        vwapSellPrice: vwapSellPrice.toNumber(),
        buyFillRatio: buyFillRatio.toNumber(),
        sellFillRatio: sellFillRatio.toNumber(),
        buyPlatformId: dislocation.buyPlatformId,
        sellPlatformId: dislocation.sellPlatformId,
        buyPrice: dislocation.buyPrice.toNumber(),
        sellPrice: dislocation.sellPrice.toNumber(),
        pairId: dislocation.pairConfig.eventDescription,
        matchId: dislocation.pairConfig.matchId ?? null,
        positionSizeUsd: this.positionSizeUsd.toNumber(),
        feeBreakdown: {
          buyFeeCost: feeBreakdown.buyFeeCost.toNumber(),
          sellFeeCost: feeBreakdown.sellFeeCost.toNumber(),
          gasFraction: feeBreakdown.gasFraction.toNumber(),
          totalCosts: feeBreakdown.totalCosts.toNumber(),
        },
        liquidityDepth,
        annualizedReturn: annualizedReturn?.toNumber() ?? null,
        effectiveMinEdge: effectiveThreshold.toNumber(),
        enrichedAt: enriched.enrichedAt,
      }),
    );
  }
}
