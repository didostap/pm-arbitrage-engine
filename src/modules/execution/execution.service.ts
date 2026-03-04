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

    // Determine primary/secondary based on pair config
    const primaryLeg = dislocation.pairConfig.primaryLeg ?? 'kalshi';
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
        : dislocation.pairConfig.polymarketContractId;
    const secondaryContractId =
      primaryLeg === 'kalshi'
        ? dislocation.pairConfig.polymarketContractId
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

    // === DEPTH-AWARE SIZING — PRIMARY LEG ===
    const idealSize = new Decimal(reservation.reservedCapitalUsd)
      .div(targetPrice)
      .floor()
      .toNumber();

    // Guard: reject if ideal size rounds to zero (extreme price or tiny reservation)
    if (idealSize <= 0) {
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
          `Ideal position size is 0 (reservedCapitalUsd=${reservation.reservedCapitalUsd.toString()}, targetPrice=${targetPrice.toString()})`,
          'warning',
        ),
      };
    }

    const primaryAvailableDepth = await this.getAvailableDepth(
      primaryConnector,
      primaryContractId,
      primarySide,
      targetPrice.toNumber(),
      primaryPlatform,
    );

    const primaryMinFillSize = Math.ceil(idealSize * this.minFillRatio);
    const targetSize = Math.min(idealSize, primaryAvailableDepth);

    if (targetSize < primaryMinFillSize) {
      this.logger.warn({
        message: 'Depth below minimum fill threshold',
        module: 'execution',
        data: {
          pairId,
          idealSize,
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

    // Track actual capital used (DO NOT mutate reservation)
    const primaryCapitalUsed = new Decimal(targetSize).mul(targetPrice);

    if (targetSize < idealSize) {
      this.logger.log({
        message: 'Depth-aware size cap applied',
        module: 'execution',
        data: {
          idealSize,
          cappedSize: targetSize,
          availableDepth: primaryAvailableDepth,
          platform: primaryPlatform,
        },
      });
    }

    // Step 2: Submit primary leg
    let primaryOrder: OrderResult;
    try {
      primaryOrder = await primaryConnector.submitOrder({
        contractId: primaryContractId,
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

    // Step 3: Persist primary order
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

    // === DEPTH-AWARE SIZING — SECONDARY LEG ===
    // Secondary ideal size computed from SECONDARY price (NOT reusing primary's idealSize)
    const secondaryIdealSize = new Decimal(reservation.reservedCapitalUsd)
      .div(secondaryTargetPrice)
      .floor()
      .toNumber();

    // Guard: reject if secondary ideal size rounds to zero
    if (secondaryIdealSize <= 0) {
      return this.handleSingleLeg(
        pairId,
        primaryLeg,
        primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        targetPrice,
        secondaryTargetPrice,
        targetSize,
        0,
        enriched,
        opportunity,
        reservation,
        EXECUTION_ERROR_CODES.GENERIC_EXECUTION_FAILURE,
        `Secondary ideal size is 0 (reservedCapitalUsd=${reservation.reservedCapitalUsd.toString()}, secondaryTargetPrice=${secondaryTargetPrice.toString()})`,
        isPaper,
        mixedMode,
      );
    }

    const secondaryAvailableDepth = await this.getAvailableDepth(
      secondaryConnector,
      secondaryContractId,
      secondarySide,
      secondaryTargetPrice.toNumber(),
      secondaryPlatform,
    );

    const secondaryMinFillSize = Math.ceil(
      secondaryIdealSize * this.minFillRatio,
    );
    const secondarySize = Math.min(secondaryIdealSize, secondaryAvailableDepth);

    if (secondarySize < secondaryMinFillSize) {
      // Single-leg exposure — primary filled but secondary depth insufficient
      return this.handleSingleLeg(
        pairId,
        primaryLeg,
        primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        targetPrice,
        secondaryTargetPrice,
        targetSize,
        secondarySize,
        enriched,
        opportunity,
        reservation,
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
        `Secondary depth insufficient on ${secondaryPlatform}`,
        isPaper,
        mixedMode,
      );
    }

    // === EDGE RE-VALIDATION AFTER DEPTH CAPPING ===
    const sizeWasReduced =
      targetSize < idealSize || secondarySize < secondaryIdealSize;

    if (sizeWasReduced) {
      // Null guard: fee breakdown must be populated by detection pipeline
      if (!enriched.feeBreakdown?.gasFraction) {
        this.logger.error({
          message:
            'Missing gasFraction in enriched opportunity — rejecting trade conservatively',
          module: 'execution',
          data: { pairId },
        });
        return this.handleSingleLeg(
          pairId,
          primaryLeg,
          primaryOrderRecord.orderId,
          primaryOrder,
          primarySide,
          secondarySide,
          targetPrice,
          secondaryTargetPrice,
          targetSize,
          secondarySize,
          enriched,
          opportunity,
          reservation,
          EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
          'Fee breakdown missing for edge re-validation',
          isPaper,
          mixedMode,
        );
      }

      // Use smaller leg for conservative gas amortization
      const smallerLegSize = Math.min(targetSize, secondarySize);
      const conservativePositionSizeUsd = new Decimal(smallerLegSize).mul(
        targetPrice.plus(secondaryTargetPrice),
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
          message: 'Edge eroded below threshold after depth-aware sizing',
          module: 'execution',
          data: {
            pairId,
            originalNetEdge: enriched.netEdge.toString(),
            adjustedNetEdge: adjustedNetEdge.toString(),
            threshold: this.minEdgeThreshold.toString(),
            idealSize,
            secondaryIdealSize,
            targetSize,
            secondarySize,
            smallerLegSize,
            originalGasFraction: enriched.feeBreakdown.gasFraction.toString(),
            newGasFraction: newGasFraction.toString(),
          },
        });

        // Primary already submitted — this becomes a single-leg situation
        return this.handleSingleLeg(
          pairId,
          primaryLeg,
          primaryOrderRecord.orderId,
          primaryOrder,
          primarySide,
          secondarySide,
          targetPrice,
          secondaryTargetPrice,
          targetSize,
          secondarySize,
          enriched,
          opportunity,
          reservation,
          EXECUTION_ERROR_CODES.EDGE_ERODED_BY_SIZE,
          'Edge eroded below threshold after depth-aware sizing',
          isPaper,
          mixedMode,
        );
      }
    }

    if (secondarySize < secondaryIdealSize) {
      this.logger.log({
        message: 'Depth-aware size cap applied (secondary)',
        module: 'execution',
        data: {
          idealSize: secondaryIdealSize,
          cappedSize: secondarySize,
          availableDepth: secondaryAvailableDepth,
          platform: secondaryPlatform,
        },
      });
    }

    // Step 5: Submit secondary leg
    let secondaryOrder: OrderResult;
    try {
      secondaryOrder = await secondaryConnector.submitOrder({
        contractId: secondaryContractId,
        side: secondarySide,
        quantity: secondarySize,
        price: secondaryTargetPrice.toNumber(),
        type: 'limit',
      });
    } catch (err) {
      return this.handleSingleLeg(
        pairId,
        primaryLeg,
        primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        targetPrice,
        secondaryTargetPrice,
        targetSize,
        secondarySize,
        enriched,
        opportunity,
        reservation,
        EXECUTION_ERROR_CODES.ORDER_REJECTED,
        `Secondary leg submission failed: ${err instanceof Error ? err.message : String(err)}`,
        isPaper,
        mixedMode,
      );
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

      return this.handleSingleLeg(
        pairId,
        primaryLeg,
        primaryOrderRecord.orderId,
        primaryOrder,
        primarySide,
        secondarySide,
        targetPrice,
        secondaryTargetPrice,
        targetSize,
        secondarySize,
        enriched,
        opportunity,
        reservation,
        secondaryOrder.status === 'pending'
          ? EXECUTION_ERROR_CODES.ORDER_TIMEOUT
          : EXECUTION_ERROR_CODES.ORDER_REJECTED,
        `Secondary leg ${secondaryOrder.status} on ${secondaryPlatform}`,
        isPaper,
        mixedMode,
      );
    }

    // Step 6: Both legs filled — persist secondary order and position
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
    const kalshiSize = primaryLeg === 'kalshi' ? targetSize : secondarySize;
    const polymarketSize = primaryLeg === 'kalshi' ? secondarySize : targetSize;

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
        kalshi: kalshiSize.toString(),
        polymarket: polymarketSize.toString(),
      },
      expectedEdge: enriched.netEdge.toNumber(),
      status: 'OPEN',
      isPaper,
    });

    // Emit OrderFilledEvent for both legs
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        primaryOrderRecord.orderId,
        primaryPlatform,
        primarySide,
        targetPrice.toNumber(),
        targetSize,
        primaryOrder.filledPrice,
        primaryOrder.filledQuantity,
        position.positionId,
        undefined,
        isPaper,
        mixedMode,
      ),
    );
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        secondaryOrderRecord.orderId,
        secondaryPlatform,
        secondarySide,
        secondaryTargetPrice.toNumber(),
        secondarySize,
        secondaryOrder.filledPrice,
        secondaryOrder.filledQuantity,
        position.positionId,
        undefined,
        isPaper,
        mixedMode,
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

    // Calculate actual capital used across both legs
    const secondaryCapitalUsed = new Decimal(secondarySize).mul(
      secondaryTargetPrice,
    );
    const actualCapitalUsed = primaryCapitalUsed.plus(secondaryCapitalUsed);

    return {
      success: true,
      partialFill: false,
      positionId: position.positionId,
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
      const book = await connector.getOrderBook(contractId);
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
          contractId,
          side,
          error instanceof Error ? error.constructor.name : 'Unknown',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return 0;
    }
  }

  private async handleSingleLeg(
    pairId: string,
    primaryLeg: string,
    primaryOrderId: string,
    primaryOrder: OrderResult,
    primarySide: string,
    secondarySide: string,
    primaryPrice: Decimal,
    secondaryPrice: Decimal,
    primarySize: number,
    secondarySize: number,
    enriched: EnrichedOpportunity,
    opportunity: RankedOpportunity,
    _reservation: BudgetReservation,
    errorCode: number,
    errorMessage: string,
    isPaper: boolean,
    mixedMode: boolean,
  ): Promise<ExecutionResult> {
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
    });

    // Emit OrderFilledEvent for the filled primary leg only
    const primaryPlatform =
      primaryLeg === 'kalshi' ? PlatformId.KALSHI : PlatformId.POLYMARKET;
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        primaryOrderId,
        primaryPlatform,
        primarySide,
        primaryPrice.toNumber(),
        primarySize,
        primaryOrder.filledPrice,
        primaryOrder.filledQuantity,
        position.positionId,
        undefined,
        isPaper,
        mixedMode,
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
        this.kalshiConnector.getOrderBook(pairConfig.kalshiContractId),
        ORDERBOOK_FETCH_TIMEOUT_MS,
      ).catch(() => null),
      withTimeout(
        this.polymarketConnector.getOrderBook(pairConfig.polymarketContractId),
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
        position.positionId,
        pairId,
        enriched.netEdge.toNumber(),
        {
          platform: primaryPlatform,
          orderId: primaryOrderId,
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
      positionId: position.positionId,
      primaryOrder,
      error,
    };
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
