import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import type {
  IExecutionEngine,
  ExecutionResult,
} from '../../common/interfaces/execution-engine.interface';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import type {
  RankedOpportunity,
  BudgetReservation,
} from '../../common/types/risk.type';
import type { OrderResult, PriceLevel } from '../../common/types/index';
import { PlatformId } from '../../common/types/platform.type';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';
import {
  SystemHealthError,
  SYSTEM_HEALTH_ERROR_CODES,
} from '../../common/errors/system-health-error';
import {
  OrderFilledEvent,
  ExecutionFailedEvent,
  SingleLegExposureEvent,
  DepthCheckFailedEvent,
} from '../../common/events/execution.events';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
import type { ComplianceDecision } from './compliance/compliance-config';
import {
  calculateSingleLegPnlScenarios,
  buildRecommendedActions,
} from './single-leg-pnl.util';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import type { SingleLegContext } from './single-leg-context.type';
import { FinancialMath } from '../../common/utils/financial-math';
import {
  asContractId,
  asOrderId,
  asPairId,
  asPositionId,
} from '../../common/types/branded.type';
import { PlatformHealthService } from '../data-ingestion/platform-health.service';
import { DataDivergenceService } from '../data-ingestion/data-divergence.service';

interface SequencingDecision {
  primaryLeg: string; // 'kalshi' | 'polymarket'
  reason: 'static_config' | 'latency_override';
  kalshiLatencyMs: number | null;
  polymarketLatencyMs: number | null;
}

interface ExecutionMetadata {
  primaryLeg: string;
  sequencingReason: string;
  kalshiLatencyMs: number | null;
  polymarketLatencyMs: number | null;
  idealCount: number;
  matchedCount: number;
  kalshiDataSource: string;
  polymarketDataSource: string;
  divergenceDetected: boolean;
}

@Injectable()
export class ExecutionService implements IExecutionEngine {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly minFillRatio: number;
  private readonly minEdgeThreshold: Decimal;

  constructor(
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    private readonly orderRepository: OrderRepository,
    private readonly positionRepository: PositionRepository,
    private readonly complianceValidator: ComplianceValidatorService,
    private readonly configService: ConfigService,
    private readonly platformHealthService: PlatformHealthService,
    private readonly dataDivergenceService: DataDivergenceService,
  ) {
    this.minFillRatio = Number(
      this.configService.get<string>('EXECUTION_MIN_FILL_RATIO', '0.25'),
    );
    if (
      isNaN(this.minFillRatio) ||
      this.minFillRatio <= 0 ||
      this.minFillRatio > 1
    ) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        'Invalid EXECUTION_MIN_FILL_RATIO: must be >0 and ≤1',
        'error',
        'execution',
      );
    }

    const edgeThresholdRaw = this.configService.get<string>(
      'DETECTION_MIN_EDGE_THRESHOLD',
      '0.008',
    );
    try {
      this.minEdgeThreshold = new Decimal(edgeThresholdRaw);
    } catch {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        `Invalid DETECTION_MIN_EDGE_THRESHOLD: '${edgeThresholdRaw}' is not a valid number`,
        'error',
        'execution',
      );
    }
    if (this.minEdgeThreshold.lte(0)) {
      throw new SystemHealthError(
        SYSTEM_HEALTH_ERROR_CODES.INVALID_CONFIGURATION,
        'Invalid DETECTION_MIN_EDGE_THRESHOLD: must be >0',
        'error',
        'execution',
      );
    }
  }

  async execute(
    opportunity: RankedOpportunity,
    reservation: BudgetReservation,
  ): Promise<ExecutionResult> {
    const enriched = opportunity.opportunity as EnrichedOpportunity;
    if (!enriched?.dislocation?.pairConfig) {
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
          'Opportunity missing enriched dislocation data',
          'error',
        ),
      };
    }
    const dislocation = enriched.dislocation;
    const pairId = opportunity.reservationRequest.pairId;

    // Determine primary/secondary based on adaptive sequencing
    const staticPrimaryLeg = dislocation.pairConfig.primaryLeg ?? 'kalshi';
    const sequencingDecision = this.determineSequencing(staticPrimaryLeg);
    const primaryLeg = sequencingDecision.primaryLeg;
    const {
      primaryConnector,
      secondaryConnector,
      primaryPlatform,
      secondaryPlatform,
    } = this.resolveConnectors(primaryLeg);

    // Determine paper mode from connector health
    const primaryHealth = primaryConnector.getHealth();
    const secondaryHealth = secondaryConnector.getHealth();
    const isPaper =
      primaryHealth.mode === 'paper' || secondaryHealth.mode === 'paper';
    // XOR: true when exactly one connector is paper and the other is live
    const mixedMode =
      (primaryHealth.mode === 'paper') !== (secondaryHealth.mode === 'paper');

    const primaryContractId =
      primaryLeg === 'kalshi'
        ? dislocation.pairConfig.kalshiContractId
        : dislocation.pairConfig.polymarketClobTokenId;
    const secondaryContractId =
      primaryLeg === 'kalshi'
        ? dislocation.pairConfig.polymarketClobTokenId
        : dislocation.pairConfig.kalshiContractId;

    // === COMPLIANCE GATE ===
    let complianceResult: ComplianceDecision;
    try {
      complianceResult = this.complianceValidator.validate(
        {
          pairId,
          opportunityId: opportunity.reservationRequest.opportunityId,
          primaryPlatform,
          secondaryPlatform,
          eventDescription: dislocation.pairConfig.eventDescription,
          kalshiContractId: dislocation.pairConfig.kalshiContractId,
          polymarketContractId: dislocation.pairConfig.polymarketContractId,
        },
        isPaper,
        mixedMode,
      );
    } catch (err) {
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED,
          `Compliance validation error: ${err instanceof Error ? err.message : String(err)}`,
          'error',
          undefined,
          { pairId },
        ),
      };
    }

    if (!complianceResult.approved) {
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.COMPLIANCE_BLOCKED,
          `Trade blocked by compliance: ${complianceResult.violations.map((v) => v.rule).join(', ')}`,
          'warning',
          undefined,
          { pairId, violations: complianceResult.violations },
        ),
      };
    }

    // Determine sides: the buy platform buys, the sell platform sells
    const primarySide =
      dislocation.buyPlatformId === primaryPlatform ? 'buy' : 'sell';
    const secondarySide = primarySide === 'buy' ? 'sell' : 'buy';

    const targetPrice =
      primarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;
    const secondaryTargetPrice =
      secondarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;

    // === COLLATERAL-AWARE SIZING — UNIFIED FORMULA (Story 10.4) ===
    // Buy: cost = price per contract. Sell: collateral = (1 - price) per contract.
    const primaryDivisor =
      primarySide === 'sell' ? new Decimal(1).minus(targetPrice) : targetPrice;
    const secondaryDivisor =
      secondarySide === 'sell'
        ? new Decimal(1).minus(secondaryTargetPrice)
        : secondaryTargetPrice;

    // Guard: combined divisor must be positive
    const combinedDivisor = primaryDivisor.plus(secondaryDivisor);
    if (combinedDivisor.lte(0)) {
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
        'Non-positive combined collateral divisor',
        'warning',
      );
      this.eventEmitter.emit(
        EVENT_NAMES.EXECUTION_FAILED,
        new ExecutionFailedEvent(
          EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
          error.message,
          opportunity.reservationRequest.opportunityId,
          {
            primaryDivisor: primaryDivisor.toString(),
            secondaryDivisor: secondaryDivisor.toString(),
          },
          undefined,
          isPaper,
          mixedMode,
        ),
      );
      return { success: false, partialFill: false, error };
    }

    // Unified formula: both legs fit within budget
    const idealCount = new Decimal(reservation.reservedCapitalUsd)
      .div(combinedDivisor)
      .floor()
      .toNumber();

    // Guard: reject if ideal count rounds to zero (extreme price or tiny reservation)
    if (idealCount <= 0) {
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
          `Ideal position size is 0 (reservedCapitalUsd=${reservation.reservedCapitalUsd.toString()}, combinedDivisor=${combinedDivisor.toString()})`,
          'warning',
        ),
      };
    }

    // Depth check — both legs BEFORE any order submission
    const primaryAvailableDepth = await this.getAvailableDepth(
      primaryConnector,
      primaryContractId,
      primarySide,
      targetPrice.toNumber(),
      primaryPlatform,
    );

    const primaryMinFillSize = Math.ceil(idealCount * this.minFillRatio);
    const primaryCapped = Math.min(idealCount, primaryAvailableDepth);

    if (primaryCapped < primaryMinFillSize) {
      this.logger.warn({
        message: 'Depth below minimum fill threshold',
        module: 'execution',
        data: {
          pairId,
          idealCount,
          availableDepth: primaryAvailableDepth,
          minFillSize: primaryMinFillSize,
          platform: primaryPlatform,
        },
      });
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
        `Insufficient liquidity on ${primaryPlatform} for ${primaryContractId}`,
        'warning',
      );
      this.eventEmitter.emit(
        EVENT_NAMES.EXECUTION_FAILED,
        new ExecutionFailedEvent(
          EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
          error.message,
          opportunity.reservationRequest.opportunityId,
          { platform: primaryPlatform, contractId: primaryContractId },
          undefined,
          isPaper,
          mixedMode,
        ),
      );
      return { success: false, partialFill: false, error };
    }

    if (primaryCapped < idealCount) {
      this.logger.log({
        message: 'Depth-aware size cap applied',
        module: 'execution',
        data: {
          idealCount,
          cappedSize: primaryCapped,
          availableDepth: primaryAvailableDepth,
          platform: primaryPlatform,
        },
      });
    }

    const secondaryAvailableDepth = await this.getAvailableDepth(
      secondaryConnector,
      secondaryContractId,
      secondarySide,
      secondaryTargetPrice.toNumber(),
      secondaryPlatform,
    );

    const secondaryMinFillSize = Math.ceil(idealCount * this.minFillRatio);
    const secondaryCapped = Math.min(idealCount, secondaryAvailableDepth);

    if (secondaryCapped < secondaryMinFillSize) {
      this.logger.warn({
        message: 'Depth below minimum fill threshold (secondary)',
        module: 'execution',
        data: {
          pairId,
          idealCount,
          availableDepth: secondaryAvailableDepth,
          minFillSize: secondaryMinFillSize,
          platform: secondaryPlatform,
        },
      });
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
        `Insufficient liquidity on ${secondaryPlatform} for ${secondaryContractId}`,
        'warning',
      );
      this.eventEmitter.emit(
        EVENT_NAMES.EXECUTION_FAILED,
        new ExecutionFailedEvent(
          EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
          error.message,
          opportunity.reservationRequest.opportunityId,
          { platform: secondaryPlatform, contractId: secondaryContractId },
          undefined,
          isPaper,
          mixedMode,
        ),
      );
      return { success: false, partialFill: false, error };
    }

    if (secondaryCapped < idealCount) {
      this.logger.log({
        message: 'Depth-aware size cap applied (secondary)',
        module: 'execution',
        data: {
          idealCount,
          cappedSize: secondaryCapped,
          availableDepth: secondaryAvailableDepth,
          platform: secondaryPlatform,
        },
      });
    }

    // === CROSS-LEG EQUALIZATION ===
    const equalizedSize = Math.min(primaryCapped, secondaryCapped);
    const targetSize = equalizedSize;
    const secondarySize = equalizedSize;

    // === EDGE RE-VALIDATION AFTER EQUALIZATION ===
    const sizeWasReduced = equalizedSize < idealCount;

    if (sizeWasReduced) {
      // Null guard: fee breakdown must be populated by detection pipeline
      if (!enriched.feeBreakdown?.gasFraction) {
        this.logger.error({
          message:
            'Missing gasFraction in enriched opportunity — rejecting trade conservatively',
          module: 'execution',
          data: { pairId },
        });
        return {
          success: false,
          partialFill: false,
          error: new ExecutionError(
            EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
            'Fee breakdown missing for edge re-validation',
            'warning',
          ),
        };
      }

      // Collateral-aware: combinedDivisor already computed
      const conservativePositionSizeUsd = new Decimal(equalizedSize).mul(
        combinedDivisor,
      );

      // Recover absolute gas estimate: gasFraction = gasEstimateUsd / detectionPositionSizeUsd
      const gasEstimateUsd = enriched.feeBreakdown.gasFraction.mul(
        new Decimal(reservation.reservedCapitalUsd),
      );

      const newGasFraction = gasEstimateUsd.div(conservativePositionSizeUsd);
      const adjustedNetEdge = enriched.netEdge
        .plus(enriched.feeBreakdown.gasFraction) // remove old gas fraction
        .minus(newGasFraction); // apply new gas fraction

      if (adjustedNetEdge.lt(this.minEdgeThreshold)) {
        this.logger.warn({
          message: 'Edge eroded below threshold after equalization',
          module: 'execution',
          data: {
            pairId,
            originalNetEdge: enriched.netEdge.toString(),
            adjustedNetEdge: adjustedNetEdge.toString(),
            threshold: this.minEdgeThreshold.toString(),
            idealCount,
            equalizedSize,
            originalGasFraction: enriched.feeBreakdown.gasFraction.toString(),
            newGasFraction: newGasFraction.toString(),
          },
        });

        return {
          success: false,
          partialFill: false,
          error: new ExecutionError(
            EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
            'Edge eroded below threshold after equalization',
            'warning',
          ),
        };
      }
    }

    // === RUNTIME INVARIANT: EQUAL LEG SIZES ===
    if (targetSize !== secondarySize) {
      this.logger.error({
        message: 'Leg size mismatch detected before order submission',
        module: 'execution',
        data: {
          pairId,
          primarySize: targetSize,
          secondarySize,
          primaryPlatform,
          secondaryPlatform,
        },
      });
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.LEG_SIZE_MISMATCH,
          `Leg size mismatch: primary=${targetSize}, secondary=${secondarySize}`,
          'error',
        ),
      };
    }

    // === DATA SOURCE CLASSIFICATION (Story 10.4, AC#6) ===
    // NOTE: Classification reflects WS freshness for audit trail, NOT the data source used in depth checks.
    // Depth checks use getOrderBook() which always fetches fresh REST data (the authoritative conservative source).
    const now = new Date();
    const wsThreshold = this.configService.get<number>(
      'WS_STALENESS_THRESHOLD_MS',
      60000,
    );

    const primaryFreshness = primaryConnector.getOrderBookFreshness(
      asContractId(primaryContractId),
    );
    const secondaryFreshness = secondaryConnector.getOrderBookFreshness(
      asContractId(secondaryContractId),
    );

    const primaryDataSource = this.classifyDataSource(
      primaryFreshness.lastWsUpdateAt,
      now,
      wsThreshold,
    );
    const secondaryDataSource = this.classifyDataSource(
      secondaryFreshness.lastWsUpdateAt,
      now,
      wsThreshold,
    );

    // Map to platform-specific names (NOT primary/secondary)
    const kalshiDataSource =
      primaryPlatform === PlatformId.KALSHI
        ? primaryDataSource
        : secondaryDataSource;
    const polymarketDataSource =
      primaryPlatform === PlatformId.KALSHI
        ? secondaryDataSource
        : primaryDataSource;

    // Check divergence status per platform
    let divergenceDetected = false;
    const kalshiDivergence = this.dataDivergenceService.getDivergenceStatus(
      PlatformId.KALSHI,
    );
    const polymarketDivergence = this.dataDivergenceService.getDivergenceStatus(
      PlatformId.POLYMARKET,
    );
    if (
      kalshiDivergence === 'divergent' ||
      polymarketDivergence === 'divergent'
    ) {
      divergenceDetected = true;
      this.logger.warn({
        message: 'Data divergence detected during execution',
        module: 'execution',
        data: {
          pairId,
          kalshiDivergence,
          polymarketDivergence,
          primaryContractId,
          secondaryContractId,
        },
      });
    }

    // Build execution metadata
    const executionMetadata: ExecutionMetadata = {
      primaryLeg: sequencingDecision.primaryLeg,
      sequencingReason: sequencingDecision.reason,
      kalshiLatencyMs: sequencingDecision.kalshiLatencyMs,
      polymarketLatencyMs: sequencingDecision.polymarketLatencyMs,
      idealCount,
      matchedCount: equalizedSize,
      kalshiDataSource,
      polymarketDataSource,
      divergenceDetected,
    };

    // === SUBMIT PRIMARY LEG ===
    let primaryOrder: OrderResult;
    try {
      primaryOrder = await primaryConnector.submitOrder({
        contractId: asContractId(primaryContractId),
        side: primarySide,
        quantity: targetSize,
        price: targetPrice.toNumber(),
        type: 'limit',
      });
    } catch (err) {
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.ORDER_REJECTED,
        `Primary leg submission failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
        undefined,
        { platform: primaryPlatform, contractId: primaryContractId },
      );
      return { success: false, partialFill: false, error };
    }

    // Check primary fill status
    if (primaryOrder.status !== 'filled' && primaryOrder.status !== 'partial') {
      const error = new ExecutionError(
        primaryOrder.status === 'pending'
          ? EXECUTION_ERROR_CODES.ORDER_TIMEOUT
          : EXECUTION_ERROR_CODES.ORDER_REJECTED,
        `Primary leg ${primaryOrder.status} on ${primaryPlatform}`,
        'warning',
        undefined,
        { orderId: primaryOrder.orderId, status: primaryOrder.status },
      );
      return { success: false, partialFill: false, error };
    }

    // Persist primary order
    const primaryOrderRecord = await this.orderRepository.create({
      platform: primaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
      contractId: primaryContractId,
      pair: { connect: { matchId: pairId } },
      side: primarySide,
      price: targetPrice.toNumber(),
      size: targetSize,
      status: primaryOrder.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: primaryOrder.filledPrice,
      fillSize: primaryOrder.filledQuantity,
      isPaper,
    });

    // === SUBMIT SECONDARY LEG ===
    let secondaryOrder: OrderResult;
    try {
      secondaryOrder = await secondaryConnector.submitOrder({
        contractId: asContractId(secondaryContractId),
        side: secondarySide,
        quantity: secondarySize,
        price: secondaryTargetPrice.toNumber(),
        type: 'limit',
      });
    } catch (err) {
      return this.handleSingleLeg({
        pairId,
        primaryLeg,
        primaryOrderId: primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        primaryPrice: targetPrice,
        secondaryPrice: secondaryTargetPrice,
        primarySize: targetSize,
        secondarySize,
        enriched,
        opportunity,
        errorCode: EXECUTION_ERROR_CODES.ORDER_REJECTED,
        errorMessage: `Secondary leg submission failed: ${err instanceof Error ? err.message : String(err)}`,
        isPaper,
        mixedMode,
        executionMetadata: JSON.parse(
          JSON.stringify(executionMetadata),
        ) as Record<string, unknown>,
      });
    }

    // Check secondary fill status
    if (
      secondaryOrder.status !== 'filled' &&
      secondaryOrder.status !== 'partial'
    ) {
      // If pending on Polymarket, persist the pending order for reconciliation
      if (secondaryOrder.status === 'pending') {
        await this.orderRepository.create({
          platform:
            secondaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
          contractId: secondaryContractId,
          pair: { connect: { matchId: pairId } },
          side: secondarySide,
          price: secondaryTargetPrice.toNumber(),
          size: secondarySize,
          status: 'PENDING',
          fillPrice: null,
          fillSize: null,
          isPaper,
        });
        this.logger.warn({
          message:
            'Polymarket order pending after timeout — persisted for reconciliation',
          module: 'execution',
          data: { orderId: secondaryOrder.orderId, pairId },
        });
      }

      return this.handleSingleLeg({
        pairId,
        primaryLeg,
        primaryOrderId: primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        primaryPrice: targetPrice,
        secondaryPrice: secondaryTargetPrice,
        primarySize: targetSize,
        secondarySize,
        enriched,
        opportunity,
        errorCode:
          secondaryOrder.status === 'pending'
            ? EXECUTION_ERROR_CODES.ORDER_TIMEOUT
            : EXECUTION_ERROR_CODES.ORDER_REJECTED,
        errorMessage: `Secondary leg ${secondaryOrder.status} on ${secondaryPlatform}`,
        isPaper,
        mixedMode,
        executionMetadata: JSON.parse(
          JSON.stringify(executionMetadata),
        ) as Record<string, unknown>,
      });
    }

    // === BOTH LEGS FILLED — PERSIST ===
    const secondaryOrderRecord = await this.orderRepository.create({
      platform:
        secondaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
      contractId: secondaryContractId,
      pair: { connect: { matchId: pairId } },
      side: secondarySide,
      price: secondaryTargetPrice.toNumber(),
      size: secondarySize,
      status: secondaryOrder.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: secondaryOrder.filledPrice,
      fillSize: secondaryOrder.filledQuantity,
      isPaper,
    });

    const kalshiOrderId =
      primaryLeg === 'kalshi'
        ? primaryOrderRecord.orderId
        : secondaryOrderRecord.orderId;
    const polymarketOrderId =
      primaryLeg === 'kalshi'
        ? secondaryOrderRecord.orderId
        : primaryOrderRecord.orderId;
    const kalshiSide = primaryLeg === 'kalshi' ? primarySide : secondarySide;
    const polymarketSide =
      primaryLeg === 'kalshi' ? secondarySide : primarySide;
    const kalshiPrice =
      primaryLeg === 'kalshi' ? targetPrice : secondaryTargetPrice;
    const polymarketPrice =
      primaryLeg === 'kalshi' ? secondaryTargetPrice : targetPrice;

    // === CLOSE-SIDE PRICE CAPTURE (6.5.5i) ===
    // Fetch close-side order books to compute entry cost baseline for threshold calibration.
    // Close-side = the side you'd trade to close each leg (buy→sell at bid, sell→buy at ask).
    const primaryFillPrice = new Decimal(primaryOrder.filledPrice);
    const secondaryFillPrice = new Decimal(secondaryOrder.filledPrice);
    let primaryClosePrice: Decimal = primaryFillPrice;
    let secondaryClosePrice: Decimal = secondaryFillPrice;

    try {
      const [primaryBook, secondaryBook] = await Promise.all([
        primaryConnector.getOrderBook(asContractId(primaryContractId)),
        secondaryConnector.getOrderBook(asContractId(secondaryContractId)),
      ]);

      // Primary leg close-side price
      if (primarySide === 'buy') {
        // Close buy → sell at best bid
        primaryClosePrice = primaryBook.bids[0]
          ? new Decimal(primaryBook.bids[0].price)
          : primaryFillPrice;
        if (!primaryBook.bids[0]) {
          this.logger.warn({
            message: 'Empty close-side book — using fill price as fallback',
            module: 'execution',
            data: {
              contractId: primaryContractId,
              side: primarySide,
              fillPrice: primaryFillPrice.toString(),
            },
          });
        }
      } else {
        // Close sell → buy at best ask
        primaryClosePrice = primaryBook.asks[0]
          ? new Decimal(primaryBook.asks[0].price)
          : primaryFillPrice;
        if (!primaryBook.asks[0]) {
          this.logger.warn({
            message: 'Empty close-side book — using fill price as fallback',
            module: 'execution',
            data: {
              contractId: primaryContractId,
              side: primarySide,
              fillPrice: primaryFillPrice.toString(),
            },
          });
        }
      }

      // Secondary leg close-side price
      if (secondarySide === 'buy') {
        secondaryClosePrice = secondaryBook.bids[0]
          ? new Decimal(secondaryBook.bids[0].price)
          : secondaryFillPrice;
        if (!secondaryBook.bids[0]) {
          this.logger.warn({
            message: 'Empty close-side book — using fill price as fallback',
            module: 'execution',
            data: {
              contractId: secondaryContractId,
              side: secondarySide,
              fillPrice: secondaryFillPrice.toString(),
            },
          });
        }
      } else {
        secondaryClosePrice = secondaryBook.asks[0]
          ? new Decimal(secondaryBook.asks[0].price)
          : secondaryFillPrice;
        if (!secondaryBook.asks[0]) {
          this.logger.warn({
            message: 'Empty close-side book — using fill price as fallback',
            module: 'execution',
            data: {
              contractId: secondaryContractId,
              side: secondarySide,
              fillPrice: secondaryFillPrice.toString(),
            },
          });
        }
      }
    } catch (err) {
      this.logger.warn({
        message:
          'Close-side order book fetch failed — using fill prices as fallback',
        module: 'execution',
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      // primaryClosePrice/secondaryClosePrice already initialized to fill prices
    }

    // Map to kalshi/polymarket
    const kalshiEntryClosePrice =
      primaryLeg === 'kalshi' ? primaryClosePrice : secondaryClosePrice;
    const polymarketEntryClosePrice =
      primaryLeg === 'kalshi' ? secondaryClosePrice : primaryClosePrice;

    // Compute fee rates at close prices (must not block position creation)
    let entryKalshiFeeRate: Decimal;
    let entryPolymarketFeeRate: Decimal;
    try {
      const kalshiFeeSchedule = (
        primaryLeg === 'kalshi' ? primaryConnector : secondaryConnector
      ).getFeeSchedule();
      const polymarketFeeSchedule = (
        primaryLeg === 'kalshi' ? secondaryConnector : primaryConnector
      ).getFeeSchedule();
      entryKalshiFeeRate = FinancialMath.calculateTakerFeeRate(
        kalshiEntryClosePrice,
        kalshiFeeSchedule,
      );
      entryPolymarketFeeRate = FinancialMath.calculateTakerFeeRate(
        polymarketEntryClosePrice,
        polymarketFeeSchedule,
      );
    } catch (err) {
      this.logger.warn({
        message: 'Fee rate computation failed — using flat fee fallback (2%)',
        module: 'execution',
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      entryKalshiFeeRate = new Decimal('0.02');
      entryPolymarketFeeRate = new Decimal('0.02');
    }

    // Capture confidence score at entry + exit mode (Story 10.2)
    // The enriched opportunity carries the pair config which was loaded from ContractMatch;
    // confidenceScore is available on the dislocation's pair config if it was populated.
    const entryConfidenceScore = dislocation.pairConfig.confidenceScore ?? null;
    const exitMode = this.configService.get<string>('EXIT_MODE', 'fixed');

    const position = await this.positionRepository.create({
      pair: { connect: { matchId: pairId } },
      kalshiOrder: { connect: { orderId: kalshiOrderId } },
      polymarketOrder: { connect: { orderId: polymarketOrderId } },
      kalshiSide,
      polymarketSide,
      entryPrices: {
        kalshi: kalshiPrice.toString(),
        polymarket: polymarketPrice.toString(),
      },
      sizes: {
        kalshi: equalizedSize.toString(),
        polymarket: equalizedSize.toString(),
      },
      expectedEdge: enriched.netEdge.toNumber(),
      status: 'OPEN',
      isPaper,
      entryClosePriceKalshi: kalshiEntryClosePrice.toNumber(),
      entryClosePricePolymarket: polymarketEntryClosePrice.toNumber(),
      entryKalshiFeeRate: entryKalshiFeeRate.toNumber(),
      entryPolymarketFeeRate: entryPolymarketFeeRate.toNumber(),
      entryConfidenceScore,
      exitMode,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      executionMetadata: JSON.parse(JSON.stringify(executionMetadata)),
    });

    // Compute taker fee rates for event enrichment (CF-4, Story 10.1)
    const primaryFeeRate = FinancialMath.calculateTakerFeeRate(
      new Decimal(primaryOrder.filledPrice),
      primaryConnector.getFeeSchedule(),
    );
    const secondaryFeeRate = FinancialMath.calculateTakerFeeRate(
      new Decimal(secondaryOrder.filledPrice),
      secondaryConnector.getFeeSchedule(),
    );
    // Gas estimate: recover from fee breakdown if available
    const gasFraction = enriched.feeBreakdown?.gasFraction;
    const gasEstimateStr =
      gasFraction && !gasFraction.isZero()
        ? gasFraction
            .mul(new Decimal(reservation.reservedCapitalUsd))
            .toString()
        : null;

    // Emit OrderFilledEvent for both legs
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        asOrderId(primaryOrderRecord.orderId),
        primaryPlatform,
        primarySide,
        targetPrice.toNumber(),
        targetSize,
        primaryOrder.filledPrice,
        primaryOrder.filledQuantity,
        asPositionId(position.positionId),
        undefined,
        isPaper,
        mixedMode,
        primaryFeeRate.toString(),
        gasEstimateStr,
        sequencingDecision,
      ),
    );
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        asOrderId(secondaryOrderRecord.orderId),
        secondaryPlatform,
        secondarySide,
        secondaryTargetPrice.toNumber(),
        secondarySize,
        secondaryOrder.filledPrice,
        secondaryOrder.filledQuantity,
        asPositionId(position.positionId),
        undefined,
        isPaper,
        mixedMode,
        secondaryFeeRate.toString(),
        gasEstimateStr,
      ),
    );

    this.logger.log({
      message: 'Two-leg execution complete',
      module: 'execution',
      data: {
        positionId: position.positionId,
        pairId,
        primaryPlatform,
        secondaryPlatform,
      },
    });

    // Calculate actual capital used across both legs (collateral-aware)
    const primaryCapitalUsed =
      primarySide === 'sell'
        ? new Decimal(targetSize).mul(new Decimal(1).minus(targetPrice))
        : new Decimal(targetSize).mul(targetPrice);
    const secondaryCapitalUsed =
      secondarySide === 'sell'
        ? new Decimal(secondarySize).mul(
            new Decimal(1).minus(secondaryTargetPrice),
          )
        : new Decimal(secondarySize).mul(secondaryTargetPrice);
    const actualCapitalUsed = primaryCapitalUsed.plus(secondaryCapitalUsed);

    return {
      success: true,
      partialFill: false,
      positionId: asPositionId(position.positionId),
      primaryOrder,
      secondaryOrder,
      actualCapitalUsed,
    };
  }

  private async getAvailableDepth(
    connector: IPlatformConnector,
    contractId: string,
    side: 'buy' | 'sell',
    targetPrice: number,
    platformId: PlatformId,
  ): Promise<number> {
    try {
      const book = await connector.getOrderBook(asContractId(contractId));
      const levels: PriceLevel[] = side === 'buy' ? book.asks : book.bids;

      let availableQty = new Decimal(0);
      for (const level of levels) {
        const priceOk =
          side === 'buy'
            ? level.price <= targetPrice
            : level.price >= targetPrice;
        if (priceOk) {
          availableQty = availableQty.plus(level.quantity);
        }
      }

      return availableQty.toNumber();
    } catch (error) {
      this.logger.warn({
        message: 'Depth query failed',
        module: 'execution',
        platform: platformId,
        contractId,
        side,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.eventEmitter.emit(
        EVENT_NAMES.DEPTH_CHECK_FAILED,
        new DepthCheckFailedEvent(
          platformId,
          asContractId(contractId),
          side,
          error instanceof Error ? error.constructor.name : 'Unknown',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return 0;
    }
  }

  private async handleSingleLeg(
    context: SingleLegContext,
  ): Promise<ExecutionResult> {
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

  private determineSequencing(staticPrimaryLeg: string): SequencingDecision {
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

    const threshold = this.configService.get<number>(
      'ADAPTIVE_SEQUENCING_LATENCY_THRESHOLD_MS',
      200,
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

  private classifyDataSource(
    lastWsUpdateAt: Date | null,
    now: Date,
    stalenessThresholdMs: number,
  ): string {
    if (lastWsUpdateAt === null) return 'polling';
    const age = now.getTime() - lastWsUpdateAt.getTime();
    return age >= stalenessThresholdMs ? 'stale_fallback' : 'websocket';
  }

  private resolveConnectors(primaryLeg: string): {
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
}
