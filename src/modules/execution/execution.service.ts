import { Injectable, Logger } from '@nestjs/common';
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
import type { OrderResult } from '../../common/types/index';
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
} from '../../common/events/execution.events';
import { OpportunityFilteredEvent } from '../../common/events/detection.events';
import { ComplianceValidatorService } from './compliance/compliance-validator.service';
import type { ComplianceDecision } from './compliance/compliance-config';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import type { EnrichedOpportunity } from '../arbitrage-detection/types/enriched-opportunity.type';
import { FinancialMath } from '../../common/utils/financial-math';
import {
  asContractId,
  asOrderId,
  asPositionId,
  type OpportunityId,
} from '../../common/types/branded.type';
import { LegSequencingService } from './leg-sequencing.service';
import { DepthAnalysisService } from './depth-analysis.service';
import type {
  ExecutionMetadata,
  PipelineState,
  SubmitSuccess,
  SubmitResult,
} from './execution-pipeline.types';

/** Post-10-8-3 evaluation: service assessed at 1024 lines (590 logical, Prettier-expanded).
 *  Single responsibility: two-leg execution pipeline orchestration. Three candidate extractions
 *  (OrderSubmission, PositionCreation, sizing→DepthAnalysis) evaluated and rejected — all would
 *  add indirection without reducing coupling. Revisit if a new pipeline step introduces genuinely
 *  independent concerns. */
@Injectable()
export class ExecutionService implements IExecutionEngine {
  private readonly logger = new Logger(ExecutionService.name);
  private minFillRatio: number;
  private readonly minEdgeThreshold: Decimal;

  /** 7 deps — documented: orchestrates full lifecycle including order/position DB persistence,
   *  connector resolution, compliance, depth analysis, and sequencing. Per 10-8-2 precedent. */
  constructor(
    private readonly legSequencingService: LegSequencingService,
    private readonly depthAnalysisService: DepthAnalysisService,
    private readonly complianceValidator: ComplianceValidatorService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly orderRepository: OrderRepository,
    private readonly positionRepository: PositionRepository,
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

  /** Reload minFillRatio from DB-backed config, delegate dualLegMinDepthRatio to child */
  reloadConfig(settings: {
    minFillRatio?: string;
    dualLegMinDepthRatio?: string;
  }): void {
    if (settings.minFillRatio !== undefined) {
      const value = Number(settings.minFillRatio);
      if (!isNaN(value) && value > 0 && value <= 1) {
        this.minFillRatio = value;
      }
    }
    this.depthAnalysisService.reloadConfig({
      dualLegMinDepthRatio: settings.dualLegMinDepthRatio,
    });
    this.logger.log({
      message: 'Execution config reloaded',
      data: { minFillRatio: this.minFillRatio },
    });
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

    // Sequencing + connector resolution
    const staticPrimaryLeg = dislocation.pairConfig.primaryLeg ?? 'kalshi';
    const sequencingDecision =
      this.legSequencingService.determineSequencing(staticPrimaryLeg);
    const primaryLeg = sequencingDecision.primaryLeg;
    const {
      primaryConnector,
      secondaryConnector,
      primaryPlatform,
      secondaryPlatform,
    } = this.legSequencingService.resolveConnectors(primaryLeg);

    // Paper mode
    const primaryHealth = primaryConnector.getHealth();
    const secondaryHealth = secondaryConnector.getHealth();
    const isPaper =
      primaryHealth.mode === 'paper' || secondaryHealth.mode === 'paper';
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
    const complianceError = this.validateCompliance(
      pairId,
      opportunity.reservationRequest.opportunityId,
      dislocation.pairConfig,
      primaryPlatform,
      secondaryPlatform,
      isPaper,
      mixedMode,
    );
    if (complianceError) return complianceError;

    // Sides and prices
    const primarySide =
      dislocation.buyPlatformId === primaryPlatform ? 'buy' : 'sell';
    const secondarySide = primarySide === 'buy' ? 'sell' : 'buy';
    const targetPrice =
      primarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;
    const secondaryTargetPrice =
      secondarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;

    // === COLLATERAL-AWARE SIZING ===
    const sizingResult = this.calculateIdealSize(
      primarySide,
      secondarySide,
      targetPrice,
      secondaryTargetPrice,
      reservation,
      opportunity.reservationRequest.opportunityId,
      isPaper,
      mixedMode,
    );
    if ('success' in sizingResult) return sizingResult;
    const { idealCount } = sizingResult;

    // === DUAL-LEG DEPTH GATE ===
    const depthGateError = await this.validateDualLegDepthGate(
      primaryConnector,
      primaryContractId,
      primarySide,
      targetPrice,
      primaryPlatform,
      secondaryConnector,
      secondaryContractId,
      secondarySide,
      secondaryTargetPrice,
      secondaryPlatform,
      idealCount,
      pairId,
      enriched,
      opportunity.reservationRequest.opportunityId,
      isPaper,
      mixedMode,
    );
    if (depthGateError) return depthGateError;

    // === DATA SOURCE CLASSIFICATION + DIVERGENCE ===
    const { kalshiDataSource, polymarketDataSource, divergenceDetected } =
      this.classifyDataSources(
        primaryConnector,
        secondaryConnector,
        primaryContractId,
        secondaryContractId,
        primaryPlatform,
        pairId,
      );

    const executionMetadata: ExecutionMetadata = {
      primaryLeg: sequencingDecision.primaryLeg,
      sequencingReason: sequencingDecision.reason,
      kalshiLatencyMs: sequencingDecision.kalshiLatencyMs,
      polymarketLatencyMs: sequencingDecision.polymarketLatencyMs,
      idealCount,
      matchedCount: 0,
      kalshiDataSource,
      polymarketDataSource,
      divergenceDetected,
    };

    const state: PipelineState = {
      enriched,
      opportunity,
      reservation,
      sequencingDecision,
      primaryLeg,
      primaryConnector,
      secondaryConnector,
      primaryPlatform,
      secondaryPlatform,
      isPaper,
      mixedMode,
      primarySide,
      secondarySide,
      targetPrice,
      secondaryTargetPrice,
      primaryContractId,
      secondaryContractId,
      pairId,
      idealCount,
      executionMetadata,
    };

    const submitResult = await this.submitOrderPair(state);
    if (!submitResult.ok) return submitResult.result;

    executionMetadata.matchedCount = submitResult.equalizedSize;
    const position = await this.createPositionFromFills(state, submitResult);
    this.emitExecutionEvents(state, submitResult, position.positionId);

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

    const pCap =
      primarySide === 'sell'
        ? new Decimal(submitResult.equalizedSize).mul(
            new Decimal(1).minus(targetPrice),
          )
        : new Decimal(submitResult.equalizedSize).mul(targetPrice);
    const sCap =
      secondarySide === 'sell'
        ? new Decimal(submitResult.equalizedSize).mul(
            new Decimal(1).minus(secondaryTargetPrice),
          )
        : new Decimal(submitResult.equalizedSize).mul(secondaryTargetPrice);

    return {
      success: true,
      partialFill: false,
      positionId: asPositionId(position.positionId),
      primaryOrder: submitResult.primaryOrder,
      secondaryOrder: submitResult.secondaryOrder,
      actualCapitalUsed: pCap.plus(sCap),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Private helpers — extracted from execute() for readability
  // ═══════════════════════════════════════════════════════════════

  private validateCompliance(
    pairId: string,
    opportunityId: string,
    pairConfig: {
      eventDescription: string;
      kalshiContractId: string;
      polymarketContractId: string;
    },
    primaryPlatform: PlatformId,
    secondaryPlatform: PlatformId,
    isPaper: boolean,
    mixedMode: boolean,
  ): ExecutionResult | null {
    let complianceResult: ComplianceDecision;
    try {
      complianceResult = this.complianceValidator.validate(
        {
          pairId,
          opportunityId,
          primaryPlatform,
          secondaryPlatform,
          eventDescription: pairConfig.eventDescription,
          kalshiContractId: pairConfig.kalshiContractId,
          polymarketContractId: pairConfig.polymarketContractId,
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
    return null;
  }

  private calculateIdealSize(
    primarySide: 'buy' | 'sell',
    secondarySide: 'buy' | 'sell',
    targetPrice: Decimal,
    secondaryTargetPrice: Decimal,
    reservation: BudgetReservation,
    opportunityId: OpportunityId,
    isPaper: boolean,
    mixedMode: boolean,
  ): { idealCount: number } | ExecutionResult {
    const primaryDivisor =
      primarySide === 'sell' ? new Decimal(1).minus(targetPrice) : targetPrice;
    const secondaryDivisor =
      secondarySide === 'sell'
        ? new Decimal(1).minus(secondaryTargetPrice)
        : secondaryTargetPrice;
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
          opportunityId,
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

    const idealCount = new Decimal(reservation.reservedCapitalUsd)
      .div(combinedDivisor)
      .floor()
      .toNumber();
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
    return { idealCount };
  }

  private async validateDualLegDepthGate(
    primaryConnector: IPlatformConnector,
    primaryContractId: string,
    primarySide: 'buy' | 'sell',
    targetPrice: Decimal,
    primaryPlatform: PlatformId,
    secondaryConnector: IPlatformConnector,
    secondaryContractId: string,
    secondarySide: 'buy' | 'sell',
    secondaryTargetPrice: Decimal,
    secondaryPlatform: PlatformId,
    idealCount: number,
    pairId: string,
    enriched: EnrichedOpportunity,
    opportunityId: OpportunityId,
    isPaper: boolean,
    mixedMode: boolean,
  ): Promise<ExecutionResult | null> {
    const dualLegResult = await this.depthAnalysisService.validateDualLegDepth({
      primaryConnector,
      primaryContractId,
      primarySide,
      primaryPrice: targetPrice.toNumber(),
      primaryPlatform,
      secondaryConnector,
      secondaryContractId,
      secondarySide,
      secondaryPrice: secondaryTargetPrice.toNumber(),
      secondaryPlatform,
      idealCount,
    });

    if (!dualLegResult.passed) {
      this.eventEmitter.emit(
        EVENT_NAMES.OPPORTUNITY_FILTERED,
        new OpportunityFilteredEvent(
          enriched.dislocation.pairConfig.eventDescription,
          enriched.netEdge,
          new Decimal(String(dualLegResult.minDepthRequired)),
          dualLegResult.reason,
          undefined,
          { matchId: pairId },
        ),
      );
      return {
        success: false,
        partialFill: false,
        error: new ExecutionError(
          EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
          dualLegResult.reason,
          'warning',
        ),
      };
    }

    // Asymmetric depth capping + min fill check
    const dualLegCapped = Math.min(
      idealCount,
      dualLegResult.primaryDepth,
      dualLegResult.secondaryDepth,
    );
    const dualLegMinFillSize = Math.ceil(idealCount * this.minFillRatio);

    if (dualLegCapped < dualLegMinFillSize) {
      this.logger.warn({
        message: 'Dual-leg capped size below minimum fill threshold',
        module: 'execution',
        data: {
          pairId,
          idealCount,
          dualLegCapped,
          dualLegMinFillSize,
          primaryDepth: dualLegResult.primaryDepth,
          secondaryDepth: dualLegResult.secondaryDepth,
        },
      });
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
        `Dual-leg capped size ${dualLegCapped} below min fill threshold ${dualLegMinFillSize}`,
        'warning',
      );
      this.eventEmitter.emit(
        EVENT_NAMES.EXECUTION_FAILED,
        new ExecutionFailedEvent(
          EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
          error.message,
          opportunityId,
          {
            primaryDepth: dualLegResult.primaryDepth,
            secondaryDepth: dualLegResult.secondaryDepth,
            dualLegCapped,
            dualLegMinFillSize,
          },
          undefined,
          isPaper,
          mixedMode,
        ),
      );
      return { success: false, partialFill: false, error };
    }

    if (dualLegCapped < idealCount) {
      this.logger.log({
        message:
          'Dual-leg depth cap applied — per-leg checks will handle sizing',
        module: 'execution',
        data: { idealCount, dualLegCapped },
      });
    }
    return null;
  }

  private classifyDataSources(
    primaryConnector: IPlatformConnector,
    secondaryConnector: IPlatformConnector,
    primaryContractId: string,
    secondaryContractId: string,
    primaryPlatform: PlatformId,
    pairId: string,
  ): {
    kalshiDataSource: string;
    polymarketDataSource: string;
    divergenceDetected: boolean;
  } {
    const wsThreshold = Number(
      this.configService.get('WS_STALENESS_THRESHOLD_MS', '60000'),
    );
    const now = new Date();
    const pFresh = primaryConnector.getOrderBookFreshness(
      asContractId(primaryContractId),
    );
    const sFresh = secondaryConnector.getOrderBookFreshness(
      asContractId(secondaryContractId),
    );
    const pDS = this.depthAnalysisService.classifyDataSource(
      pFresh.lastWsUpdateAt,
      now,
      wsThreshold,
    );
    const sDS = this.depthAnalysisService.classifyDataSource(
      sFresh.lastWsUpdateAt,
      now,
      wsThreshold,
    );
    const kalshiDataSource = primaryPlatform === PlatformId.KALSHI ? pDS : sDS;
    const polymarketDataSource =
      primaryPlatform === PlatformId.KALSHI ? sDS : pDS;

    const {
      divergenceDetected,
      kalshi: kalshiDiv,
      polymarket: pmDiv,
    } = this.depthAnalysisService.getDivergenceStatus();
    if (divergenceDetected) {
      this.logger.warn({
        message: 'Data divergence detected during execution',
        module: 'execution',
        data: {
          pairId,
          kalshiDivergence: kalshiDiv,
          polymarketDivergence: pmDiv,
          primaryContractId,
          secondaryContractId,
        },
      });
    }
    return { kalshiDataSource, polymarketDataSource, divergenceDetected };
  }

  // ═══════════════════════════════════════════════════════════════
  // Private helpers — order submission & position management
  // ═══════════════════════════════════════════════════════════════

  private async submitOrderPair(s: PipelineState): Promise<SubmitResult> {
    // Per-leg depth checks
    const pDepth = await this.checkPerLegDepth(
      s.primaryConnector,
      s.primaryContractId,
      s.primarySide,
      s.targetPrice,
      s.primaryPlatform,
      s.idealCount,
      s.pairId,
      s.opportunity,
      s.isPaper,
      s.mixedMode,
    );
    if (!pDepth.ok) return { ok: false, result: pDepth.result };

    const sDepth = await this.checkPerLegDepth(
      s.secondaryConnector,
      s.secondaryContractId,
      s.secondarySide,
      s.secondaryTargetPrice,
      s.secondaryPlatform,
      s.idealCount,
      s.pairId,
      s.opportunity,
      s.isPaper,
      s.mixedMode,
      true,
    );
    if (!sDepth.ok) return { ok: false, result: sDepth.result };

    const equalizedSize = Math.min(pDepth.capped, sDepth.capped);

    // Edge re-validation
    if (equalizedSize < s.idealCount) {
      const edgeErr = this.validateEdgeAfterEqualization(s, equalizedSize);
      if (edgeErr) return { ok: false, result: edgeErr };
    }

    // Submit primary
    let primaryOrder: OrderResult;
    try {
      primaryOrder = await s.primaryConnector.submitOrder({
        contractId: asContractId(s.primaryContractId),
        side: s.primarySide,
        quantity: equalizedSize,
        price: s.targetPrice.toNumber(),
        type: 'limit',
      });
    } catch (err) {
      return {
        ok: false,
        result: {
          success: false,
          partialFill: false,
          error: new ExecutionError(
            EXECUTION_ERROR_CODES.ORDER_REJECTED,
            `Primary leg submission failed: ${err instanceof Error ? err.message : String(err)}`,
            'error',
            undefined,
            { platform: s.primaryPlatform, contractId: s.primaryContractId },
          ),
        },
      };
    }

    if (primaryOrder.status !== 'filled' && primaryOrder.status !== 'partial') {
      return {
        ok: false,
        result: {
          success: false,
          partialFill: false,
          error: new ExecutionError(
            primaryOrder.status === 'pending'
              ? EXECUTION_ERROR_CODES.ORDER_TIMEOUT
              : EXECUTION_ERROR_CODES.ORDER_REJECTED,
            `Primary leg ${primaryOrder.status} on ${s.primaryPlatform}`,
            'warning',
            undefined,
            { orderId: primaryOrder.orderId, status: primaryOrder.status },
          ),
        },
      };
    }

    const primaryOrderRecord = await this.orderRepository.create({
      platform:
        s.primaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
      contractId: s.primaryContractId,
      pair: { connect: { matchId: s.pairId } },
      side: s.primarySide,
      price: s.targetPrice.toNumber(),
      size: equalizedSize,
      status: primaryOrder.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: primaryOrder.filledPrice,
      fillSize: primaryOrder.filledQuantity,
      isPaper: s.isPaper,
    });

    // Submit secondary
    let secondaryOrder: OrderResult;
    try {
      secondaryOrder = await s.secondaryConnector.submitOrder({
        contractId: asContractId(s.secondaryContractId),
        side: s.secondarySide,
        quantity: equalizedSize,
        price: s.secondaryTargetPrice.toNumber(),
        type: 'limit',
      });
    } catch (err) {
      return {
        ok: false,
        result: await this.handleExecutionFailure(
          s,
          primaryOrderRecord.orderId,
          primaryOrder,
          equalizedSize,
          EXECUTION_ERROR_CODES.ORDER_REJECTED,
          `Secondary leg submission failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    if (
      secondaryOrder.status !== 'filled' &&
      secondaryOrder.status !== 'partial'
    ) {
      if (secondaryOrder.status === 'pending') {
        await this.orderRepository.create({
          platform:
            s.secondaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
          contractId: s.secondaryContractId,
          pair: { connect: { matchId: s.pairId } },
          side: s.secondarySide,
          price: s.secondaryTargetPrice.toNumber(),
          size: equalizedSize,
          status: 'PENDING',
          fillPrice: null,
          fillSize: null,
          isPaper: s.isPaper,
        });
        this.logger.warn({
          message:
            'Polymarket order pending after timeout — persisted for reconciliation',
          module: 'execution',
          data: { orderId: secondaryOrder.orderId, pairId: s.pairId },
        });
      }
      return {
        ok: false,
        result: await this.handleExecutionFailure(
          s,
          primaryOrderRecord.orderId,
          primaryOrder,
          equalizedSize,
          secondaryOrder.status === 'pending'
            ? EXECUTION_ERROR_CODES.ORDER_TIMEOUT
            : EXECUTION_ERROR_CODES.ORDER_REJECTED,
          `Secondary leg ${secondaryOrder.status} on ${s.secondaryPlatform}`,
        ),
      };
    }

    const secondaryOrderRecord = await this.orderRepository.create({
      platform:
        s.secondaryPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
      contractId: s.secondaryContractId,
      pair: { connect: { matchId: s.pairId } },
      side: s.secondarySide,
      price: s.secondaryTargetPrice.toNumber(),
      size: equalizedSize,
      status: secondaryOrder.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: secondaryOrder.filledPrice,
      fillSize: secondaryOrder.filledQuantity,
      isPaper: s.isPaper,
    });

    return {
      ok: true,
      primaryOrderRecord,
      secondaryOrderRecord,
      primaryOrder,
      secondaryOrder,
      equalizedSize,
    };
  }

  private async checkPerLegDepth(
    connector: IPlatformConnector,
    contractId: string,
    side: 'buy' | 'sell',
    price: Decimal,
    platform: PlatformId,
    idealCount: number,
    pairId: string,
    opportunity: RankedOpportunity,
    isPaper: boolean,
    mixedMode: boolean,
    isSecondary = false,
  ): Promise<
    { ok: true; capped: number } | { ok: false; result: ExecutionResult }
  > {
    const depth = await this.depthAnalysisService.getAvailableDepth(
      connector,
      contractId,
      side,
      price.toNumber(),
      platform,
    );
    const minFillSize = Math.ceil(idealCount * this.minFillRatio);
    const capped = Math.min(idealCount, depth);

    if (capped < minFillSize) {
      this.logger.warn({
        message: `Depth below minimum fill threshold${isSecondary ? ' (secondary)' : ''}`,
        module: 'execution',
        data: {
          pairId,
          idealCount,
          availableDepth: depth,
          minFillSize,
          platform,
        },
      });
      const error = new ExecutionError(
        EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
        `Insufficient liquidity on ${platform} for ${contractId}`,
        'warning',
      );
      this.eventEmitter.emit(
        EVENT_NAMES.EXECUTION_FAILED,
        new ExecutionFailedEvent(
          EXECUTION_ERROR_CODES.INSUFFICIENT_LIQUIDITY,
          error.message,
          opportunity.reservationRequest.opportunityId,
          { platform, contractId },
          undefined,
          isPaper,
          mixedMode,
        ),
      );
      return {
        ok: false,
        result: { success: false, partialFill: false, error },
      };
    }

    if (capped < idealCount) {
      this.logger.log({
        message: `Depth-aware size cap applied${isSecondary ? ' (secondary)' : ''}`,
        module: 'execution',
        data: {
          idealCount,
          cappedSize: capped,
          availableDepth: depth,
          platform,
        },
      });
    }
    return { ok: true, capped };
  }

  private validateEdgeAfterEqualization(
    s: PipelineState,
    equalizedSize: number,
  ): ExecutionResult | null {
    if (!s.enriched.feeBreakdown?.gasFraction) {
      this.logger.error({
        message:
          'Missing gasFraction in enriched opportunity — rejecting trade conservatively',
        module: 'execution',
        data: { pairId: s.pairId },
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

    const pDiv =
      s.primarySide === 'sell'
        ? new Decimal(1).minus(s.targetPrice)
        : s.targetPrice;
    const sDiv =
      s.secondarySide === 'sell'
        ? new Decimal(1).minus(s.secondaryTargetPrice)
        : s.secondaryTargetPrice;
    const combinedDiv = pDiv.plus(sDiv);
    const conservativeSize = new Decimal(equalizedSize).mul(combinedDiv);
    const gasEst = s.enriched.feeBreakdown.gasFraction.mul(
      new Decimal(s.reservation.reservedCapitalUsd),
    );
    const newGasFrac = gasEst.div(conservativeSize);
    const adjustedEdge = s.enriched.netEdge
      .plus(s.enriched.feeBreakdown.gasFraction)
      .minus(newGasFrac);

    if (adjustedEdge.lt(this.minEdgeThreshold)) {
      this.logger.warn({
        message: 'Edge eroded below threshold after equalization',
        module: 'execution',
        data: {
          pairId: s.pairId,
          originalNetEdge: s.enriched.netEdge.toString(),
          adjustedNetEdge: adjustedEdge.toString(),
          threshold: this.minEdgeThreshold.toString(),
          idealCount: s.idealCount,
          equalizedSize,
          originalGasFraction: s.enriched.feeBreakdown.gasFraction.toString(),
          newGasFraction: newGasFrac.toString(),
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
    return null;
  }

  private async createPositionFromFills(s: PipelineState, r: SubmitSuccess) {
    const kOId =
      s.primaryLeg === 'kalshi'
        ? r.primaryOrderRecord.orderId
        : r.secondaryOrderRecord.orderId;
    const pOId =
      s.primaryLeg === 'kalshi'
        ? r.secondaryOrderRecord.orderId
        : r.primaryOrderRecord.orderId;
    const kSide = s.primaryLeg === 'kalshi' ? s.primarySide : s.secondarySide;
    const pSide = s.primaryLeg === 'kalshi' ? s.secondarySide : s.primarySide;
    const kPrice =
      s.primaryLeg === 'kalshi' ? s.targetPrice : s.secondaryTargetPrice;
    const pPrice =
      s.primaryLeg === 'kalshi' ? s.secondaryTargetPrice : s.targetPrice;

    // Close-side price capture
    const pFill = new Decimal(r.primaryOrder.filledPrice);
    const sFill = new Decimal(r.secondaryOrder.filledPrice);
    let pClose: Decimal = pFill;
    let sClose: Decimal = sFill;

    try {
      const [pBook, sBook] = await Promise.all([
        s.primaryConnector.getOrderBook(asContractId(s.primaryContractId)),
        s.secondaryConnector.getOrderBook(asContractId(s.secondaryContractId)),
      ]);
      pClose = this.extractClosePrice(
        pBook,
        s.primarySide,
        pFill,
        s.primaryContractId,
      );
      sClose = this.extractClosePrice(
        sBook,
        s.secondarySide,
        sFill,
        s.secondaryContractId,
      );
    } catch (err) {
      this.logger.warn({
        message:
          'Close-side order book fetch failed — using fill prices as fallback',
        module: 'execution',
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }

    const kClose = s.primaryLeg === 'kalshi' ? pClose : sClose;
    const pmClose = s.primaryLeg === 'kalshi' ? sClose : pClose;

    let kFeeRate: Decimal;
    let pmFeeRate: Decimal;
    try {
      const kConn =
        s.primaryLeg === 'kalshi' ? s.primaryConnector : s.secondaryConnector;
      const pmConn =
        s.primaryLeg === 'kalshi' ? s.secondaryConnector : s.primaryConnector;
      kFeeRate = FinancialMath.calculateTakerFeeRate(
        kClose,
        kConn.getFeeSchedule(),
      );
      pmFeeRate = FinancialMath.calculateTakerFeeRate(
        pmClose,
        pmConn.getFeeSchedule(),
      );
    } catch (err) {
      this.logger.warn({
        message: 'Fee rate computation failed — using flat fee fallback (2%)',
        module: 'execution',
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      kFeeRate = new Decimal('0.02');
      pmFeeRate = new Decimal('0.02');
    }

    return this.positionRepository.create({
      pair: { connect: { matchId: s.pairId } },
      kalshiOrder: { connect: { orderId: kOId } },
      polymarketOrder: { connect: { orderId: pOId } },
      kalshiSide: kSide,
      polymarketSide: pSide,
      entryPrices: { kalshi: kPrice.toString(), polymarket: pPrice.toString() },
      sizes: {
        kalshi: r.equalizedSize.toString(),
        polymarket: r.equalizedSize.toString(),
      },
      expectedEdge: s.enriched.netEdge.toNumber(),
      status: 'OPEN',
      isPaper: s.isPaper,
      entryClosePriceKalshi: kClose.toNumber(),
      entryClosePricePolymarket: pmClose.toNumber(),
      entryKalshiFeeRate: kFeeRate.toNumber(),
      entryPolymarketFeeRate: pmFeeRate.toNumber(),
      entryConfidenceScore:
        s.enriched.dislocation.pairConfig.confidenceScore ?? null,
      exitMode: this.configService.get<string>('EXIT_MODE', 'fixed'),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      executionMetadata: JSON.parse(JSON.stringify(s.executionMetadata)),
    });
  }

  private extractClosePrice(
    book: { bids: { price: number }[]; asks: { price: number }[] },
    side: string,
    fillPrice: Decimal,
    contractId: string,
  ): Decimal {
    const levels = side === 'buy' ? book.bids : book.asks;
    if (levels[0]) return new Decimal(levels[0].price);
    this.logger.warn({
      message: 'Empty close-side book — using fill price as fallback',
      module: 'execution',
      data: { contractId, side, fillPrice: fillPrice.toString() },
    });
    return fillPrice;
  }

  private emitExecutionEvents(
    s: PipelineState,
    r: SubmitSuccess,
    positionId: string,
  ): void {
    const pFee = FinancialMath.calculateTakerFeeRate(
      new Decimal(r.primaryOrder.filledPrice),
      s.primaryConnector.getFeeSchedule(),
    );
    const sFee = FinancialMath.calculateTakerFeeRate(
      new Decimal(r.secondaryOrder.filledPrice),
      s.secondaryConnector.getFeeSchedule(),
    );
    const gasFrac = s.enriched.feeBreakdown?.gasFraction;
    const gasStr =
      gasFrac && !gasFrac.isZero()
        ? gasFrac.mul(new Decimal(s.reservation.reservedCapitalUsd)).toString()
        : null;

    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        asOrderId(r.primaryOrderRecord.orderId),
        s.primaryPlatform,
        s.primarySide,
        s.targetPrice.toNumber(),
        r.equalizedSize,
        r.primaryOrder.filledPrice,
        r.primaryOrder.filledQuantity,
        asPositionId(positionId),
        undefined,
        s.isPaper,
        s.mixedMode,
        pFee.toString(),
        gasStr,
        s.sequencingDecision,
      ),
    );
    this.eventEmitter.emit(
      EVENT_NAMES.ORDER_FILLED,
      new OrderFilledEvent(
        asOrderId(r.secondaryOrderRecord.orderId),
        s.secondaryPlatform,
        s.secondarySide,
        s.secondaryTargetPrice.toNumber(),
        r.equalizedSize,
        r.secondaryOrder.filledPrice,
        r.secondaryOrder.filledQuantity,
        asPositionId(positionId),
        undefined,
        s.isPaper,
        s.mixedMode,
        sFee.toString(),
        gasStr,
      ),
    );
  }

  private async handleExecutionFailure(
    s: PipelineState,
    primaryOrderId: string,
    primaryOrder: OrderResult,
    size: number,
    errorCode: number,
    errorMessage: string,
  ): Promise<ExecutionResult> {
    // P1 fix: set matchedCount to actual equalizedSize before delegating to single-leg handler
    s.executionMetadata.matchedCount = size;

    return this.legSequencingService.handleSingleLeg({
      pairId: s.pairId,
      primaryLeg: s.primaryLeg,
      primaryOrderId,
      primaryOrder,
      primarySide: s.primarySide,
      secondarySide: s.secondarySide,
      primaryPrice: s.targetPrice,
      secondaryPrice: s.secondaryTargetPrice,
      primarySize: size,
      secondarySize: size,
      enriched: s.enriched,
      opportunity: s.opportunity,
      errorCode,
      errorMessage,
      isPaper: s.isPaper,
      mixedMode: s.mixedMode,
      executionMetadata: JSON.parse(
        JSON.stringify(s.executionMetadata),
      ) as Record<string, unknown>,
    });
  }
}
