import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';

import { FinancialMath, calculateLegCapital } from '../../common/utils';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  ExitTriggeredEvent,
  SingleLegExposureEvent,
} from '../../common/events/execution.events';
import { RiskStateDivergenceEvent } from '../../common/events/system.events';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { Platform } from '@prisma/client';
import {
  PlatformId,
  asContractId,
  asOrderId,
  asPairId,
  asPositionId,
} from '../../common/types';
import type { ThresholdEvalResult } from './threshold-evaluator.service';
import { ExitDataSourceService } from './exit-data-source.service';

const MAX_EXIT_CHUNK_ITERATIONS = 50;

@Injectable()
export class ExitExecutionService {
  private readonly logger = new Logger(ExitExecutionService.name);
  private exitMaxChunkSize: number;

  constructor(
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly exitDataSourceService: ExitDataSourceService,
  ) {
    this.exitMaxChunkSize = 0;
  }

  reloadConfig(settings: { exitMaxChunkSize?: number }): void {
    if (settings.exitMaxChunkSize !== undefined)
      this.exitMaxChunkSize = settings.exitMaxChunkSize;
  }

  async executeExit(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    evalResult: ThresholdEvalResult,
    kalshiClosePrice: Decimal,
    polymarketClosePrice: Decimal,
    isPaper: boolean,
    mixedMode: boolean,
    kalshiEffectiveSize?: Decimal,
    polymarketEffectiveSize?: Decimal,
  ): Promise<void> {
    // Re-read position status before order submission (guard against concurrent manual close)
    const freshPosition = await this.positionRepository.findByIdWithOrders(
      position.positionId,
    );
    if (
      !freshPosition ||
      (freshPosition.status !== 'OPEN' &&
        freshPosition.status !== 'EXIT_PARTIAL')
    ) {
      this.logger.warn({
        message: 'Position status changed during evaluation — skipping exit',
        data: {
          positionId: position.positionId,
          currentStatus: freshPosition?.status ?? 'not_found',
        },
      });
      return;
    }

    const kalshiOrder = position.kalshiOrder!;
    const polymarketOrder = position.polymarketOrder!;
    const kalshiCloseSide = position.kalshiSide === 'buy' ? 'sell' : 'buy';
    const polymarketCloseSide =
      position.polymarketSide === 'buy' ? 'sell' : 'buy';
    const kalshiFillSize =
      kalshiEffectiveSize ?? new Decimal(kalshiOrder.fillSize!.toString());
    const polymarketFillSize =
      polymarketEffectiveSize ??
      new Decimal(polymarketOrder.fillSize!.toString());

    // Determine primary/secondary leg order (same as entry)
    const isPrimaryKalshi = (position.pair.primaryLeg ?? 'kalshi') === 'kalshi';
    const pick = <T>(k: T, p: T): T => (isPrimaryKalshi ? k : p);
    const primaryConnector = pick(
      this.kalshiConnector,
      this.polymarketConnector,
    );
    const secondaryConnector = pick(
      this.polymarketConnector,
      this.kalshiConnector,
    );
    const primaryContractId = pick(
      position.pair.kalshiContractId,
      position.pair.polymarketClobTokenId!,
    );
    const secondaryContractId = pick(
      position.pair.polymarketClobTokenId!,
      position.pair.kalshiContractId,
    );
    const primaryCloseSide = pick(kalshiCloseSide, polymarketCloseSide);
    const secondaryCloseSide = pick(polymarketCloseSide, kalshiCloseSide);
    const primaryClosePrice = pick(kalshiClosePrice, polymarketClosePrice);
    const secondaryClosePrice = pick(polymarketClosePrice, kalshiClosePrice);
    const primaryEffectiveSize = pick(kalshiFillSize, polymarketFillSize);
    const secondaryEffectiveSize = pick(polymarketFillSize, kalshiFillSize);
    const primaryPlatform = pick('KALSHI', 'POLYMARKET') as Platform;
    const secondaryPlatform = pick('POLYMARKET', 'KALSHI') as Platform;
    const primaryPlatformId = pick(PlatformId.KALSHI, PlatformId.POLYMARKET);
    const secondaryPlatformId = pick(PlatformId.POLYMARKET, PlatformId.KALSHI);

    // ── Chunked exit loop (Story 10-7-5) ──
    let remainingPrimary = primaryEffectiveSize;
    let remainingSecondary = secondaryEffectiveSize;
    const existingPnl = new Decimal(position.realizedPnl?.toString() ?? '0');
    let accumulatedPnl = existingPnl;
    let chunksCompleted = 0;
    let totalKalshiExitFillSize = new Decimal(0);
    let totalPolyExitFillSize = new Decimal(0);
    let lastPrimaryExitOrder: { orderId: string } | null = null;
    let lastSecondaryExitOrder: { orderId: string } | null = null;
    const kalshiEntryPrice = new Decimal(kalshiOrder.fillPrice!.toString());
    const polymarketEntryPrice = new Decimal(
      polymarketOrder.fillPrice!.toString(),
    );

    // Pre-loop guard
    if (remainingPrimary.lte(0) || remainingSecondary.lte(0)) {
      this.logger.warn({
        message: 'Exit skipped — zero remaining size',
        data: { positionId: position.positionId },
      });
      return;
    }

    let iterations = 0;
    while (
      remainingPrimary.gt(0) &&
      remainingSecondary.gt(0) &&
      iterations < MAX_EXIT_CHUNK_ITERATIONS
    ) {
      iterations++;
      const chunkSize = await this.calculateChunkSize(
        primaryPlatformId,
        secondaryPlatformId,
        primaryContractId,
        secondaryContractId,
        primaryCloseSide,
        secondaryCloseSide,
        primaryClosePrice,
        secondaryClosePrice,
        remainingPrimary,
        remainingSecondary,
        position.positionId,
      );

      if (chunkSize === null) break;

      // Submit primary leg for this chunk
      let primaryResult;
      try {
        primaryResult = await primaryConnector.submitOrder({
          contractId: asContractId(primaryContractId),
          side: primaryCloseSide,
          quantity: chunkSize.toNumber(),
          price: primaryClosePrice.toNumber(),
          type: 'limit',
        });
      } catch (error) {
        this.logger.warn({
          message: 'Exit chunk primary leg failed — stopping chunking',
          data: {
            positionId: position.positionId,
            chunk: iterations,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        break;
      }
      if (
        primaryResult.status !== 'filled' &&
        primaryResult.status !== 'partial'
      ) {
        this.logger.warn({
          message: 'Exit chunk primary leg not filled — stopping chunking',
          data: {
            positionId: position.positionId,
            orderStatus: primaryResult.status,
            chunk: iterations,
          },
        });
        break;
      }

      // Persist primary exit order
      const primaryExitOrder = await this.orderRepository.create({
        platform: primaryPlatform,
        contractId: primaryContractId,
        pair: { connect: { matchId: position.pairId } },
        side: primaryCloseSide,
        price: primaryClosePrice.toNumber(),
        size: chunkSize.toNumber(),
        status: primaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
        fillPrice: primaryResult.filledPrice,
        fillSize: primaryResult.filledQuantity,
        isPaper,
      });

      // Submit secondary leg for this chunk (inline to preserve error context for handlePartialExit)
      let secondaryResult;
      try {
        secondaryResult = await secondaryConnector.submitOrder({
          contractId: asContractId(secondaryContractId),
          side: secondaryCloseSide,
          quantity: chunkSize.toNumber(),
          price: secondaryClosePrice.toNumber(),
          type: 'limit',
        });
      } catch (error) {
        // Secondary fails → chunk-level single-leg exposure
        await this.handlePartialExit(
          position,
          primaryExitOrder.orderId,
          isPrimaryKalshi,
          error,
          secondaryClosePrice,
          chunkSize,
          isPaper,
          mixedMode,
          chunksCompleted > 0, // D1: skip status update if prior chunks succeeded
        );
        break;
      }

      if (
        secondaryResult.status !== 'filled' &&
        secondaryResult.status !== 'partial'
      ) {
        await this.handlePartialExit(
          position,
          primaryExitOrder.orderId,
          isPrimaryKalshi,
          new Error(`Order status: ${secondaryResult.status}`),
          secondaryClosePrice,
          chunkSize,
          isPaper,
          mixedMode,
          chunksCompleted > 0, // D1: skip status update if prior chunks succeeded
        );
        break;
      }

      // Persist secondary exit order
      const secondaryExitOrder = await this.orderRepository.create({
        platform: secondaryPlatform,
        contractId: secondaryContractId,
        pair: { connect: { matchId: position.pairId } },
        side: secondaryCloseSide,
        price: secondaryClosePrice.toNumber(),
        size: chunkSize.toNumber(),
        status: secondaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
        fillPrice: secondaryResult.filledPrice,
        fillSize: secondaryResult.filledQuantity,
        isPaper,
      });

      lastPrimaryExitOrder = primaryExitOrder;
      lastSecondaryExitOrder = secondaryExitOrder;

      // Compute chunk P&L
      const { chunkPnl, chunkKalshiExitFillSize, chunkPolyExitFillSize } =
        this.computeChunkPnl(
          primaryResult,
          secondaryResult,
          isPrimaryKalshi,
          kalshiEntryPrice,
          polymarketEntryPrice,
          position.kalshiSide!,
          position.polymarketSide!,
        );
      accumulatedPnl = accumulatedPnl.plus(chunkPnl);

      totalKalshiExitFillSize = totalKalshiExitFillSize.plus(
        chunkKalshiExitFillSize,
      );
      totalPolyExitFillSize = totalPolyExitFillSize.plus(chunkPolyExitFillSize);

      const primaryFillSize = new Decimal(primaryResult.filledQuantity);
      const secondaryFillSize = new Decimal(secondaryResult.filledQuantity);

      // P1 guard: break if platform returned partial with zero fill to prevent infinite loop
      if (primaryFillSize.isZero() || secondaryFillSize.isZero()) {
        this.logger.warn({
          message: 'Exit chunk returned zero fill size — stopping chunking',
          data: {
            positionId: position.positionId,
            chunk: iterations,
            primaryFillSize: primaryFillSize.toString(),
            secondaryFillSize: secondaryFillSize.toString(),
          },
        });
        break;
      }

      remainingPrimary = remainingPrimary.minus(primaryFillSize);
      remainingSecondary = remainingSecondary.minus(secondaryFillSize);

      chunksCompleted++;
    }

    // Post-loop: iteration limit warning
    if (iterations >= MAX_EXIT_CHUNK_ITERATIONS) {
      this.logger.warn({
        message: 'Exit chunking hit iteration limit',
        data: {
          positionId: position.positionId,
          chunksCompleted,
          remainingPrimary: remainingPrimary.toString(),
          remainingSecondary: remainingSecondary.toString(),
        },
      });
    }

    // Post-loop: no chunks completed → deferred to next cycle
    if (chunksCompleted === 0) return;

    await this.finalizeExitStatus(
      position,
      evalResult,
      remainingPrimary,
      remainingSecondary,
      accumulatedPnl,
      existingPnl,
      totalKalshiExitFillSize,
      totalPolyExitFillSize,
      kalshiEntryPrice,
      polymarketEntryPrice,
      lastPrimaryExitOrder!,
      lastSecondaryExitOrder!,
      isPrimaryKalshi,
      isPaper,
      mixedMode,
      chunksCompleted,
    );
  }

  async handlePartialExit(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    filledExitOrderId: string,
    filledIsPrimaryKalshi: boolean,
    error: unknown,
    failedAttemptedPrice: Decimal,
    failedAttemptedSize: Decimal,
    isPaper: boolean,
    mixedMode: boolean,
    skipStatusUpdate = false,
  ): Promise<void> {
    if (!skipStatusUpdate)
      await this.positionRepository.updateStatus(
        position.positionId,
        'EXIT_PARTIAL',
      );

    const filledPlatformId = filledIsPrimaryKalshi
      ? PlatformId.KALSHI
      : PlatformId.POLYMARKET;
    const failedPlatformId = filledIsPrimaryKalshi
      ? PlatformId.POLYMARKET
      : PlatformId.KALSHI;
    const filledExitOrder =
      await this.orderRepository.findById(filledExitOrderId);
    const toNum = (v: { toString(): string } | null | undefined): number =>
      v ? new Decimal(v.toString()).toNumber() : 0;
    const filledSide =
      filledPlatformId === PlatformId.KALSHI
        ? position.kalshiSide === 'buy'
          ? 'sell'
          : 'buy'
        : position.polymarketSide === 'buy'
          ? 'sell'
          : 'buy';
    const errMsg = error instanceof Error ? error.message : String(error);

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      new SingleLegExposureEvent(
        asPositionId(position.positionId),
        asPairId(position.pairId),
        new Decimal(position.expectedEdge.toString()).toNumber(),
        {
          platform: filledPlatformId,
          orderId: asOrderId(filledExitOrderId),
          side: filledSide,
          price: toNum(filledExitOrder?.price),
          size: toNum(filledExitOrder?.size),
          fillPrice: toNum(filledExitOrder?.fillPrice),
          fillSize: toNum(filledExitOrder?.fillSize),
        },
        {
          platform: failedPlatformId,
          reason: errMsg,
          reasonCode: EXECUTION_ERROR_CODES.PARTIAL_EXIT_FAILURE,
          attemptedPrice: failedAttemptedPrice.toNumber(),
          attemptedSize: failedAttemptedSize.toNumber(),
        },
        {
          kalshi: { bestBid: null, bestAsk: null },
          polymarket: { bestBid: null, bestAsk: null },
        },
        {
          closeNowEstimate: 'Partial exit — one leg closed, other remains open',
          retryAtCurrentPrice: 'Use retry-leg or close-leg endpoint',
          holdRiskAssessment:
            'EXIT_PARTIAL: Operator intervention needed to close remaining leg',
        },
        [
          'Retry failed exit leg via POST /api/positions/:id/retry-leg',
          'Close remaining leg via POST /api/positions/:id/close-leg',
        ],
        undefined,
        undefined,
        isPaper,
        mixedMode,
      ),
    );

    this.logger.error({
      message: 'Partial exit — one leg filled, other failed',
      data: {
        positionId: position.positionId,
        filledExitOrderId,
        filledPlatform: filledPlatformId,
        failedPlatform: failedPlatformId,
        error: errMsg,
        isPaper,
        mixedMode,
      },
    });
  }

  /** Calculate chunk size from available depth on both legs. */
  private async calculateChunkSize(
    primaryPlatformId: PlatformId,
    secondaryPlatformId: PlatformId,
    primaryContractId: string,
    secondaryContractId: string,
    primaryCloseSide: string,
    secondaryCloseSide: string,
    primaryClosePrice: Decimal,
    secondaryClosePrice: Decimal,
    remainingPrimary: Decimal,
    remainingSecondary: Decimal,
    positionId: string,
  ): Promise<Decimal | null> {
    let chunkSize = Decimal.min(remainingPrimary, remainingSecondary);
    try {
      const [primaryDepth, secondaryDepth] = await Promise.all([
        this.exitDataSourceService.getAvailableExitDepth(
          primaryPlatformId,
          primaryContractId,
          primaryCloseSide as 'buy' | 'sell',
          primaryClosePrice,
        ),
        this.exitDataSourceService.getAvailableExitDepth(
          secondaryPlatformId,
          secondaryContractId,
          secondaryCloseSide as 'buy' | 'sell',
          secondaryClosePrice,
        ),
      ]);
      if (primaryDepth.isZero() || secondaryDepth.isZero()) return null;
      chunkSize = Decimal.min(
        primaryDepth,
        secondaryDepth,
        remainingPrimary,
        remainingSecondary,
      );
    } catch (error) {
      this.logger.warn({
        message: 'Exit depth fetch failed — deferring to next cycle',
        data: {
          positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null; // D2: defer to next polling cycle
    }
    if (this.exitMaxChunkSize > 0)
      chunkSize = Decimal.min(chunkSize, new Decimal(this.exitMaxChunkSize));
    return chunkSize.isZero() ? null : chunkSize;
  }

  /** Compute P&L for a single chunk from fill results. */
  private computeChunkPnl(
    primaryResult: { filledPrice: number; filledQuantity: number },
    secondaryResult: { filledPrice: number; filledQuantity: number },
    isPrimaryKalshi: boolean,
    kalshiEntryPrice: Decimal,
    polymarketEntryPrice: Decimal,
    kalshiSide: string,
    polymarketSide: string,
  ): {
    chunkPnl: Decimal;
    chunkKalshiExitFillSize: Decimal;
    chunkPolyExitFillSize: Decimal;
  } {
    const [kResult, pResult] = isPrimaryKalshi
      ? [primaryResult, secondaryResult]
      : [secondaryResult, primaryResult];
    const chunkKalshiExitFillSize = new Decimal(kResult.filledQuantity);
    const chunkPolyExitFillSize = new Decimal(pResult.filledQuantity);
    const kalshiCloseFilledPrice = new Decimal(kResult.filledPrice);
    const polymarketCloseFilledPrice = new Decimal(pResult.filledPrice);

    // Direction-adjusted PnL per leg
    const legPnl = (
      side: string,
      entryPrice: Decimal,
      closePrice: Decimal,
      size: Decimal,
    ): Decimal =>
      side === 'buy'
        ? closePrice.minus(entryPrice).mul(size)
        : entryPrice.minus(closePrice).mul(size);
    const kalshiPnl = legPnl(
      kalshiSide,
      kalshiEntryPrice,
      kalshiCloseFilledPrice,
      chunkKalshiExitFillSize,
    );
    const polymarketPnl = legPnl(
      polymarketSide,
      polymarketEntryPrice,
      polymarketCloseFilledPrice,
      chunkPolyExitFillSize,
    );

    // Exit fees
    const calcFee = (
      closePrice: Decimal,
      size: Decimal,
      connector: IPlatformConnector,
    ): Decimal =>
      closePrice
        .mul(size)
        .mul(
          FinancialMath.calculateTakerFeeRate(
            closePrice,
            connector.getFeeSchedule(),
          ),
        );
    const kalshiExitFee = calcFee(
      kalshiCloseFilledPrice,
      chunkKalshiExitFillSize,
      this.kalshiConnector,
    );
    const polymarketExitFee = calcFee(
      polymarketCloseFilledPrice,
      chunkPolyExitFillSize,
      this.polymarketConnector,
    );

    const chunkPnl = kalshiPnl
      .plus(polymarketPnl)
      .minus(kalshiExitFee)
      .minus(polymarketExitFee);

    return { chunkPnl, chunkKalshiExitFillSize, chunkPolyExitFillSize };
  }

  /** Finalize position state after chunk loop: close or mark partial. */
  private async finalizeExitStatus(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    evalResult: ThresholdEvalResult,
    remainingPrimary: Decimal,
    remainingSecondary: Decimal,
    accumulatedPnl: Decimal,
    existingPnl: Decimal,
    totalKalshiExitFillSize: Decimal,
    totalPolyExitFillSize: Decimal,
    kalshiEntryPrice: Decimal,
    polymarketEntryPrice: Decimal,
    lastPrimaryExitOrder: { orderId: string },
    lastSecondaryExitOrder: { orderId: string },
    isPrimaryKalshi: boolean,
    isPaper: boolean,
    mixedMode: boolean,
    chunksCompleted: number,
  ): Promise<void> {
    const isFullExit = remainingPrimary.lte(0) && remainingSecondary.lte(0);
    const exitedEntryCapital = calculateLegCapital(
      position.kalshiSide ?? 'buy',
      kalshiEntryPrice,
      totalKalshiExitFillSize,
    ).plus(
      calculateLegCapital(
        position.polymarketSide ?? 'buy',
        polymarketEntryPrice,
        totalPolyExitFillSize,
      ),
    );
    const cyclePnl = accumulatedPnl.minus(existingPnl);
    const kalshiCloseOrderId = asOrderId(
      isPrimaryKalshi
        ? lastPrimaryExitOrder.orderId
        : lastSecondaryExitOrder.orderId,
    );
    const polymarketCloseOrderId = asOrderId(
      isPrimaryKalshi
        ? lastSecondaryExitOrder.orderId
        : lastPrimaryExitOrder.orderId,
    );

    // Persist position state
    if (isFullExit) {
      await this.positionRepository.closePosition(
        position.positionId,
        accumulatedPnl,
      );
    } else {
      await this.positionRepository.updateStatusWithAccumulatedPnl(
        position.positionId,
        'EXIT_PARTIAL',
        cyclePnl,
        existingPnl,
      );
    }

    // Update risk state
    const capitalArg = isFullExit
      ? exitedEntryCapital.plus(cyclePnl)
      : exitedEntryCapital.plus(cyclePnl);
    const riskOp = isFullExit ? 'close' : 'partial_release';
    try {
      if (isFullExit) {
        await this.riskManager.closePosition(
          capitalArg,
          cyclePnl,
          asPairId(position.pairId),
          isPaper,
        );
      } else {
        await this.riskManager.releasePartialCapital(
          capitalArg,
          cyclePnl,
          asPairId(position.pairId),
          isPaper,
        );
      }
    } catch (riskError) {
      const errMsg =
        riskError instanceof Error ? riskError.message : String(riskError);
      this.logger.error({
        message: `CRITICAL: Position ${isFullExit ? 'CLOSED' : 'EXIT_PARTIAL'} in DB but risk state update failed — divergence detected`,
        data: { positionId: position.positionId, error: errMsg },
      });
      this.eventEmitter.emit(
        EVENT_NAMES.RISK_STATE_DIVERGENCE,
        new RiskStateDivergenceEvent(
          asPositionId(position.positionId),
          asPairId(position.pairId),
          riskOp,
          errMsg,
        ),
      );
    }

    // Emit exit event
    this.eventEmitter.emit(
      isFullExit
        ? EVENT_NAMES.EXIT_TRIGGERED
        : EVENT_NAMES.EXIT_PARTIAL_CHUNKED,
      new ExitTriggeredEvent(
        asPositionId(position.positionId),
        asPairId(position.pairId),
        evalResult.type!,
        new Decimal(position.expectedEdge.toString()).toFixed(8),
        evalResult.currentEdge.toFixed(8),
        cyclePnl.toFixed(8),
        kalshiCloseOrderId,
        polymarketCloseOrderId,
        undefined,
        isPaper,
        mixedMode,
        chunksCompleted,
        !isFullExit,
      ),
    );

    // Log
    if (isFullExit) {
      this.logger.log({
        message: 'Position exited successfully',
        data: {
          positionId: position.positionId,
          exitType: evalResult.type,
          realizedPnl: cyclePnl.toFixed(8),
          kalshiCloseOrderId,
          polymarketCloseOrderId,
          chunksCompleted,
          isPaper,
          mixedMode,
        },
      });
    } else {
      this.logger.warn({
        message: 'Partial chunked exit — remainder deferred to next cycle',
        data: {
          positionId: position.positionId,
          chunksCompleted,
          remainingPrimary: remainingPrimary.toString(),
          remainingSecondary: remainingSecondary.toString(),
          accumulatedPnl: accumulatedPnl.toFixed(8),
          isPaper,
          mixedMode,
        },
      });
    }
  }
}
