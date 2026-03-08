import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';

import { FinancialMath, getResidualSize } from '../../common/utils';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import {
  ThresholdEvaluatorService,
  ThresholdEvalInput,
  ThresholdEvalResult,
} from './threshold-evaluator.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  ExitTriggeredEvent,
  SingleLegExposureEvent,
} from '../../common/events/execution.events';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { PlatformId } from '../../common/types';

const EXIT_POLL_INTERVAL_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

@Injectable()
export class ExitMonitorService {
  private readonly logger = new Logger(ExitMonitorService.name);
  private consecutiveFullFailures = 0;
  private skipNextCycle = false;

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
    private readonly thresholdEvaluator: ThresholdEvaluatorService,
  ) {}

  @Interval(EXIT_POLL_INTERVAL_MS)
  async evaluatePositions(): Promise<void> {
    if (this.skipNextCycle) {
      this.skipNextCycle = false;
      this.consecutiveFullFailures = 0;
      this.logger.warn({
        message: 'Skipping exit evaluation cycle (circuit breaker recovery)',
      });
      return;
    }

    // Derive paper/mixed mode from connector health (same pattern as SingleLegResolutionService)
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();
    const isPaper =
      kalshiHealth.mode === 'paper' || polymarketHealth.mode === 'paper';
    const mixedMode =
      (kalshiHealth.mode === 'paper') !== (polymarketHealth.mode === 'paper');

    let positions;
    try {
      positions = await this.positionRepository.findByStatusWithOrders(
        { in: ['OPEN', 'EXIT_PARTIAL'] },
        isPaper,
      );
    } catch (error) {
      this.logger.error({
        message:
          'Failed to query OPEN/EXIT_PARTIAL positions for exit evaluation',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (positions.length === 0) {
      return;
    }

    this.logger.log({
      message: `Evaluating ${positions.length} OPEN/EXIT_PARTIAL positions for exit`,
      data: { count: positions.length, isPaper, mixedMode },
    });

    let anySucceeded = false;

    for (const position of positions) {
      try {
        await this.evaluatePosition(
          position,
          isPaper,
          mixedMode,
          kalshiHealth,
          polymarketHealth,
        );
        anySucceeded = true;
      } catch (error) {
        this.logger.error({
          message: 'Exit evaluation failed for position',
          data: {
            positionId: position.positionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    if (anySucceeded) {
      this.consecutiveFullFailures = 0;
    } else {
      this.consecutiveFullFailures++;
      if (this.consecutiveFullFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.skipNextCycle = true;
        this.logger.error({
          message: `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} consecutive full failures, skipping next cycle`,
          data: { consecutiveFullFailures: this.consecutiveFullFailures },
        });
      }
    }
  }

  private async evaluatePosition(
    position: Awaited<
      ReturnType<PositionRepository['findByStatusWithOrders']>
    >[0],
    isPaper: boolean,
    mixedMode: boolean,
    kalshiHealth: ReturnType<IPlatformConnector['getHealth']>,
    polymarketHealth: ReturnType<IPlatformConnector['getHealth']>,
  ): Promise<void> {
    // Check connector health — skip if either platform disconnected since cycle start

    if (
      kalshiHealth.status === 'disconnected' ||
      polymarketHealth.status === 'disconnected'
    ) {
      this.logger.warn({
        message: 'Skipping exit evaluation — connector disconnected',
        data: {
          positionId: position.positionId,
          kalshiStatus: kalshiHealth.status,
          polymarketStatus: polymarketHealth.status,
        },
      });
      return;
    }

    // Get entry fill prices from order records
    const kalshiOrder = position.kalshiOrder;
    const polymarketOrder = position.polymarketOrder;

    if (
      !kalshiOrder?.fillPrice ||
      !polymarketOrder?.fillPrice ||
      !kalshiOrder?.fillSize ||
      !polymarketOrder?.fillSize
    ) {
      this.logger.warn({
        message: 'Skipping exit evaluation — missing order fill data',
        data: { positionId: position.positionId },
      });
      return;
    }

    if (!position.kalshiSide || !position.polymarketSide) {
      this.logger.warn({
        message: 'Skipping exit evaluation — missing side data',
        data: { positionId: position.positionId },
      });
      return;
    }

    // Compute effective sizes: residual for EXIT_PARTIAL, entry fill for OPEN
    let kalshiEffectiveSize = new Decimal(kalshiOrder.fillSize.toString());
    let polymarketEffectiveSize = new Decimal(
      polymarketOrder.fillSize.toString(),
    );

    if (position.status === 'EXIT_PARTIAL') {
      const allPairOrders = await this.orderRepository.findByPairId(
        position.pairId,
      );
      const residual = getResidualSize(position, allPairOrders);
      kalshiEffectiveSize = residual.kalshi;
      polymarketEffectiveSize = residual.polymarket;

      if (residual.floored) {
        this.logger.error({
          message:
            'DATA INTEGRITY: Exit orders exceed entry fill size — residual floored to zero',
          data: {
            positionId: position.positionId,
            kalshiResidual: kalshiEffectiveSize.toString(),
            polymarketResidual: polymarketEffectiveSize.toString(),
          },
        });
      }

      // Zero residual on both legs → position should already be CLOSED
      if (kalshiEffectiveSize.isZero() && polymarketEffectiveSize.isZero()) {
        this.logger.warn({
          message:
            'EXIT_PARTIAL position has zero residual on both legs — transitioning to CLOSED',
          data: { positionId: position.positionId },
        });
        await this.positionRepository.updateStatus(
          position.positionId,
          'CLOSED',
        );
        await this.riskManager.closePosition(
          new Decimal(0),
          new Decimal(0),
          position.pairId,
        );
        return;
      }

      // One leg zero, other non-zero → data integrity issue, defer to operator
      if (kalshiEffectiveSize.isZero() || polymarketEffectiveSize.isZero()) {
        this.logger.error({
          message:
            'DATA INTEGRITY: EXIT_PARTIAL has zero residual on one leg but not the other — skipping exit evaluation',
          data: {
            positionId: position.positionId,
            kalshiResidual: kalshiEffectiveSize.toString(),
            polymarketResidual: polymarketEffectiveSize.toString(),
          },
        });
        return;
      }

      this.logger.log({
        message: 'EXIT_PARTIAL position — using residual sizes',
        data: {
          positionId: position.positionId,
          kalshiResidual: kalshiEffectiveSize.toString(),
          polymarketResidual: polymarketEffectiveSize.toString(),
        },
      });
    }

    // Fetch current close prices (VWAP-aware using effective position size)
    const kalshiClosePrice = await this.getClosePrice(
      this.kalshiConnector,
      position.pair.kalshiContractId,
      position.kalshiSide,
      kalshiEffectiveSize,
    );
    const polymarketClosePrice = await this.getClosePrice(
      this.polymarketConnector,
      position.pair.polymarketContractId,
      position.polymarketSide,
      polymarketEffectiveSize,
    );

    if (kalshiClosePrice === null || polymarketClosePrice === null) {
      this.logger.warn({
        message: 'Skipping exit evaluation — empty order book side',
        data: {
          positionId: position.positionId,
          kalshiClosePrice: kalshiClosePrice?.toString() ?? 'null',
          polymarketClosePrice: polymarketClosePrice?.toString() ?? 'null',
        },
      });
      return;
    }

    // Build threshold input
    const kalshiFeeSchedule = this.kalshiConnector.getFeeSchedule();
    const polymarketFeeSchedule = this.polymarketConnector.getFeeSchedule();

    const evalInput: ThresholdEvalInput = {
      initialEdge: new Decimal(position.expectedEdge.toString()),
      kalshiEntryPrice: new Decimal(kalshiOrder.fillPrice.toString()),
      polymarketEntryPrice: new Decimal(polymarketOrder.fillPrice.toString()),
      currentKalshiPrice: kalshiClosePrice,
      currentPolymarketPrice: polymarketClosePrice,
      kalshiSide: position.kalshiSide,
      polymarketSide: position.polymarketSide,
      kalshiSize: kalshiEffectiveSize,
      polymarketSize: polymarketEffectiveSize,
      kalshiFeeDecimal: FinancialMath.calculateTakerFeeRate(
        kalshiClosePrice,
        kalshiFeeSchedule,
      ),
      polymarketFeeDecimal: FinancialMath.calculateTakerFeeRate(
        polymarketClosePrice,
        polymarketFeeSchedule,
      ),
      resolutionDate: position.pair.resolutionDate,
      now: new Date(),
      entryClosePriceKalshi: position.entryClosePriceKalshi
        ? new Decimal(position.entryClosePriceKalshi.toString())
        : null,
      entryClosePricePolymarket: position.entryClosePricePolymarket
        ? new Decimal(position.entryClosePricePolymarket.toString())
        : null,
      entryKalshiFeeRate: position.entryKalshiFeeRate
        ? new Decimal(position.entryKalshiFeeRate.toString())
        : null,
      entryPolymarketFeeRate: position.entryPolymarketFeeRate
        ? new Decimal(position.entryPolymarketFeeRate.toString())
        : null,
    };

    const evalResult = this.thresholdEvaluator.evaluate(evalInput);

    if (evalResult.triggered) {
      this.logger.log({
        message: `Exit threshold triggered: ${evalResult.type}`,
        data: {
          positionId: position.positionId,
          pairId: position.pairId,
          exitType: evalResult.type,
          currentPnl: evalResult.currentPnl.toFixed(8),
          currentEdge: evalResult.currentEdge.toFixed(8),
        },
      });
      await this.executeExit(
        position,
        evalResult,
        kalshiClosePrice,
        polymarketClosePrice,
        isPaper,
        mixedMode,
        kalshiEffectiveSize,
        polymarketEffectiveSize,
      );
    }
  }

  private async executeExit(
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

    // Determine close sides
    const kalshiCloseSide = position.kalshiSide === 'buy' ? 'sell' : 'buy';
    const polymarketCloseSide =
      position.polymarketSide === 'buy' ? 'sell' : 'buy';

    const kalshiEntryFillSize = new Decimal(kalshiOrder.fillSize!.toString());
    const polymarketEntryFillSize = new Decimal(
      polymarketOrder.fillSize!.toString(),
    );

    // Use effective (residual) sizes for exit cap when provided (EXIT_PARTIAL),
    // otherwise fall back to entry fill sizes (OPEN)
    const kalshiFillSize = kalshiEffectiveSize ?? kalshiEntryFillSize;
    const polymarketFillSize =
      polymarketEffectiveSize ?? polymarketEntryFillSize;

    // Determine primary/secondary leg order (same as entry)
    const primaryLeg = position.pair.primaryLeg ?? 'kalshi';
    const isPrimaryKalshi = primaryLeg === 'kalshi';

    const primaryConnector = isPrimaryKalshi
      ? this.kalshiConnector
      : this.polymarketConnector;
    const secondaryConnector = isPrimaryKalshi
      ? this.polymarketConnector
      : this.kalshiConnector;
    const primaryContractId = isPrimaryKalshi
      ? position.pair.kalshiContractId
      : position.pair.polymarketContractId;
    const secondaryContractId = isPrimaryKalshi
      ? position.pair.polymarketContractId
      : position.pair.kalshiContractId;
    const primaryCloseSide = isPrimaryKalshi
      ? kalshiCloseSide
      : polymarketCloseSide;
    const secondaryCloseSide = isPrimaryKalshi
      ? polymarketCloseSide
      : kalshiCloseSide;
    const primaryClosePrice = isPrimaryKalshi
      ? kalshiClosePrice
      : polymarketClosePrice;
    const secondaryClosePrice = isPrimaryKalshi
      ? polymarketClosePrice
      : kalshiClosePrice;
    const primaryEffectiveSize = isPrimaryKalshi
      ? kalshiFillSize
      : polymarketFillSize;
    const secondaryEffectiveSize = isPrimaryKalshi
      ? polymarketFillSize
      : kalshiFillSize;
    const primaryPlatform = isPrimaryKalshi ? 'KALSHI' : 'POLYMARKET';
    const secondaryPlatform = isPrimaryKalshi ? 'POLYMARKET' : 'KALSHI';

    // Pre-exit depth check — intentional second fetch (book may have changed since threshold evaluation)
    let exitSize = Decimal.min(primaryEffectiveSize, secondaryEffectiveSize); // Default: min of both legs' effective sizes
    try {
      const [primaryDepth, secondaryDepth] = await Promise.all([
        this.getAvailableExitDepth(
          primaryConnector,
          primaryContractId,
          primaryCloseSide,
          primaryClosePrice,
        ),
        this.getAvailableExitDepth(
          secondaryConnector,
          secondaryContractId,
          secondaryCloseSide,
          secondaryClosePrice,
        ),
      ]);

      // Zero depth on either side → defer exit to next cycle
      if (primaryDepth.isZero() || secondaryDepth.isZero()) {
        this.logger.warn({
          message: 'Exit deferred — zero depth on one or both sides',
          data: {
            positionId: position.positionId,
            primaryDepth: primaryDepth.toString(),
            secondaryDepth: secondaryDepth.toString(),
          },
        });
        return;
      }

      // Cap exit sizes: min(primaryDepth, secondaryDepth, primaryEffective, secondaryEffective)
      // Cross-leg equalization: both legs submit the same exitSize
      exitSize = Decimal.min(
        primaryDepth,
        secondaryDepth,
        primaryEffectiveSize,
        secondaryEffectiveSize,
      );

      if (exitSize.isZero()) return;
    } catch (error) {
      // Fetch failure: fall back to entry fill size — attempt full exit rather than deferring
      this.logger.warn({
        message: 'Exit depth fetch failed — using entry fill size',
        data: {
          positionId: position.positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // Submit primary leg exit
    let primaryResult;
    try {
      primaryResult = await primaryConnector.submitOrder({
        contractId: primaryContractId,
        side: primaryCloseSide,
        quantity: exitSize.toNumber(),
        price: primaryClosePrice.toNumber(),
        type: 'limit',
      });
    } catch (error) {
      // First leg fails → position stays OPEN, retry next cycle
      this.logger.warn({
        message: 'Exit primary leg submission failed — will retry next cycle',
        data: {
          positionId: position.positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (
      primaryResult.status !== 'filled' &&
      primaryResult.status !== 'partial'
    ) {
      this.logger.warn({
        message:
          'Exit primary leg not filled — position stays OPEN, retry next cycle',
        data: {
          positionId: position.positionId,
          orderStatus: primaryResult.status,
        },
      });
      return;
    }

    // Persist primary exit order
    const primaryExitOrder = await this.orderRepository.create({
      platform: primaryPlatform,
      contractId: primaryContractId,
      pair: { connect: { matchId: position.pairId } },
      side: primaryCloseSide,
      price: primaryClosePrice.toNumber(),
      size: exitSize.toNumber(),
      status: primaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: primaryResult.filledPrice,
      fillSize: primaryResult.filledQuantity,
      isPaper,
    });

    // Submit secondary leg exit (same exitSize for cross-leg equalization)
    let secondaryResult;
    try {
      secondaryResult = await secondaryConnector.submitOrder({
        contractId: secondaryContractId,
        side: secondaryCloseSide,
        quantity: exitSize.toNumber(),
        price: secondaryClosePrice.toNumber(),
        type: 'limit',
      });
    } catch (error) {
      // Secondary fails → partial exit (total secondary failure)
      await this.handlePartialExit(
        position,
        primaryExitOrder.orderId,
        isPrimaryKalshi,
        error,
        secondaryClosePrice,
        exitSize,
        isPaper,
        mixedMode,
      );
      return;
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
        exitSize,
        isPaper,
        mixedMode,
      );
      return;
    }

    // Persist secondary exit order
    const secondaryExitOrder = await this.orderRepository.create({
      platform: secondaryPlatform,
      contractId: secondaryContractId,
      pair: { connect: { matchId: position.pairId } },
      side: secondaryCloseSide,
      price: secondaryClosePrice.toNumber(),
      size: exitSize.toNumber(),
      status: secondaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: secondaryResult.filledPrice,
      fillSize: secondaryResult.filledQuantity,
      isPaper,
    });

    // Both legs returned filled/partial — use actual exit fill sizes for P&L (not entry fill sizes)
    const kalshiExitFillSize = isPrimaryKalshi
      ? new Decimal(primaryResult.filledQuantity)
      : new Decimal(secondaryResult.filledQuantity);
    const polymarketExitFillSize = isPrimaryKalshi
      ? new Decimal(secondaryResult.filledQuantity)
      : new Decimal(primaryResult.filledQuantity);

    const kalshiEntryPrice = new Decimal(kalshiOrder.fillPrice!.toString());
    const polymarketEntryPrice = new Decimal(
      polymarketOrder.fillPrice!.toString(),
    );
    const kalshiCloseFilledPrice = isPrimaryKalshi
      ? new Decimal(primaryResult.filledPrice)
      : new Decimal(secondaryResult.filledPrice);
    const polymarketCloseFilledPrice = isPrimaryKalshi
      ? new Decimal(secondaryResult.filledPrice)
      : new Decimal(primaryResult.filledPrice);

    // Per-leg P&L — using exit fill sizes
    let kalshiPnl: Decimal;
    if (position.kalshiSide === 'buy') {
      kalshiPnl = kalshiCloseFilledPrice
        .minus(kalshiEntryPrice)
        .mul(kalshiExitFillSize);
    } else {
      kalshiPnl = kalshiEntryPrice
        .minus(kalshiCloseFilledPrice)
        .mul(kalshiExitFillSize);
    }

    let polymarketPnl: Decimal;
    if (position.polymarketSide === 'buy') {
      polymarketPnl = polymarketCloseFilledPrice
        .minus(polymarketEntryPrice)
        .mul(polymarketExitFillSize);
    } else {
      polymarketPnl = polymarketEntryPrice
        .minus(polymarketCloseFilledPrice)
        .mul(polymarketExitFillSize);
    }

    // Exit fees — on actual traded notional (exit fill size x exit fill price)
    const kalshiFee = this.kalshiConnector.getFeeSchedule();
    const polymarketFee = this.polymarketConnector.getFeeSchedule();
    const kalshiExitFee = kalshiCloseFilledPrice
      .mul(kalshiExitFillSize)
      .mul(
        FinancialMath.calculateTakerFeeRate(kalshiCloseFilledPrice, kalshiFee),
      );
    const polymarketExitFee = polymarketCloseFilledPrice
      .mul(polymarketExitFillSize)
      .mul(
        FinancialMath.calculateTakerFeeRate(
          polymarketCloseFilledPrice,
          polymarketFee,
        ),
      );

    const realizedPnl = kalshiPnl
      .plus(polymarketPnl)
      .minus(kalshiExitFee)
      .minus(polymarketExitFee);

    // Capital calculation on exited portion only
    const exitedEntryCapital = kalshiEntryPrice
      .mul(kalshiExitFillSize)
      .plus(polymarketEntryPrice.mul(polymarketExitFillSize));

    // Determine full vs partial exit (compare exit fills to effective sizes — residual for EXIT_PARTIAL, entry for OPEN)
    const isFullExit =
      kalshiExitFillSize.round().gte(kalshiFillSize.round()) &&
      polymarketExitFillSize.round().gte(polymarketFillSize.round());

    // Determine which order is kalshi and which is polymarket
    const kalshiCloseOrderId = isPrimaryKalshi
      ? primaryExitOrder.orderId
      : secondaryExitOrder.orderId;
    const polymarketCloseOrderId = isPrimaryKalshi
      ? secondaryExitOrder.orderId
      : primaryExitOrder.orderId;

    if (isFullExit) {
      // Full exit → CLOSED
      await this.positionRepository.updateStatus(position.positionId, 'CLOSED');
      const capitalReturned = exitedEntryCapital.plus(realizedPnl);
      await this.riskManager.closePosition(
        capitalReturned,
        realizedPnl,
        position.pairId,
      );

      this.eventEmitter.emit(
        EVENT_NAMES.EXIT_TRIGGERED,
        new ExitTriggeredEvent(
          position.positionId,
          position.pairId,
          evalResult.type!,
          new Decimal(position.expectedEdge.toString()).toFixed(8),
          evalResult.currentEdge.toFixed(8),
          realizedPnl.toFixed(8),
          kalshiCloseOrderId,
          polymarketCloseOrderId,
          undefined,
          isPaper,
          mixedMode,
        ),
      );

      this.logger.log({
        message: 'Position exited successfully',
        data: {
          positionId: position.positionId,
          exitType: evalResult.type,
          realizedPnl: realizedPnl.toFixed(8),
          kalshiCloseOrderId,
          polymarketCloseOrderId,
          isPaper,
          mixedMode,
        },
      });
    } else {
      // Partial exit → EXIT_PARTIAL with proportional capital release
      await this.positionRepository.updateStatus(
        position.positionId,
        'EXIT_PARTIAL',
      );
      await this.riskManager.releasePartialCapital(
        exitedEntryCapital.plus(realizedPnl),
        realizedPnl,
        position.pairId,
      );

      // Overloaded: partial exit remainder, not single-leg failure
      const primaryExitFillSize = new Decimal(primaryResult.filledQuantity);
      const secondaryExitFillSize = new Decimal(secondaryResult.filledQuantity);
      const filledLegIsPrimary = primaryExitFillSize.gte(secondaryExitFillSize);
      const filledPlatformId = filledLegIsPrimary
        ? isPrimaryKalshi
          ? PlatformId.KALSHI
          : PlatformId.POLYMARKET
        : isPrimaryKalshi
          ? PlatformId.POLYMARKET
          : PlatformId.KALSHI;
      const failedPlatformId = filledLegIsPrimary
        ? isPrimaryKalshi
          ? PlatformId.POLYMARKET
          : PlatformId.KALSHI
        : isPrimaryKalshi
          ? PlatformId.KALSHI
          : PlatformId.POLYMARKET;
      const filledOrder = filledLegIsPrimary
        ? primaryExitOrder
        : secondaryExitOrder;
      const filledSide = filledLegIsPrimary
        ? primaryCloseSide
        : secondaryCloseSide;
      this.eventEmitter.emit(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        new SingleLegExposureEvent(
          position.positionId,
          position.pairId,
          new Decimal(position.expectedEdge.toString()).toNumber(),
          {
            platform: filledPlatformId,
            orderId: filledOrder.orderId,
            side: filledSide,
            price: (filledLegIsPrimary
              ? primaryClosePrice
              : secondaryClosePrice
            ).toNumber(),
            size: exitSize.toNumber(),
            fillPrice: filledLegIsPrimary
              ? primaryResult.filledPrice
              : secondaryResult.filledPrice,
            fillSize: filledLegIsPrimary
              ? primaryResult.filledQuantity
              : secondaryResult.filledQuantity,
          },
          {
            platform: failedPlatformId,
            reason: 'Partial exit — remainder contracts unexited',
            reasonCode: EXECUTION_ERROR_CODES.PARTIAL_EXIT_FAILURE,
            attemptedPrice: (filledLegIsPrimary
              ? secondaryClosePrice
              : primaryClosePrice
            ).toNumber(),
            attemptedSize: exitSize.toNumber(),
          },
          {
            kalshi: { bestBid: null, bestAsk: null },
            polymarket: { bestBid: null, bestAsk: null },
          },
          {
            closeNowEstimate: 'Partial exit — some contracts remain open',
            retryAtCurrentPrice: 'Use retry-leg or close-leg endpoint',
            holdRiskAssessment:
              'EXIT_PARTIAL: Operator intervention needed to close remaining contracts',
          },
          [
            'Retry exit via POST /api/positions/:id/retry-leg',
            'Close remaining via POST /api/positions/:id/close-leg',
          ],
          undefined,
          undefined,
          isPaper,
          mixedMode,
        ),
      );

      this.logger.warn({
        message: 'Partial exit — remainder contracts unexited',
        data: {
          positionId: position.positionId,
          entryKalshiFillSize: kalshiFillSize.toString(),
          entryPolymarketFillSize: polymarketFillSize.toString(),
          exitKalshiFillSize: kalshiExitFillSize.toString(),
          exitPolymarketFillSize: polymarketExitFillSize.toString(),
          realizedPnl: realizedPnl.toFixed(8),
          isPaper,
          mixedMode,
        },
      });
    }
  }

  /**
   * Calculate available depth at close price or better for exit sizing.
   */
  private async getAvailableExitDepth(
    connector: IPlatformConnector,
    contractId: string,
    closeSide: 'buy' | 'sell',
    closePrice: Decimal,
  ): Promise<Decimal> {
    const book = await connector.getOrderBook(contractId);
    // Close side buy → consume asks at closePrice or lower
    // Close side sell → consume bids at closePrice or higher
    const levels = closeSide === 'buy' ? book.asks : book.bids;

    let depth = new Decimal(0);
    for (const level of levels) {
      const priceOk =
        closeSide === 'buy'
          ? level.price <= closePrice.toNumber()
          : level.price >= closePrice.toNumber();
      if (priceOk) {
        depth = depth.plus(level.quantity);
      } else if (depth.gt(0)) {
        // Sorted book: once a level fails after qualifying levels, all subsequent fail too
        break;
      }
    }
    return depth;
  }

  private async handlePartialExit(
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
  ): Promise<void> {
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

    // Get the filled exit order for event data
    const filledExitOrder =
      await this.orderRepository.findById(filledExitOrderId);

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      new SingleLegExposureEvent(
        position.positionId,
        position.pairId,
        new Decimal(position.expectedEdge.toString()).toNumber(),
        {
          platform: filledPlatformId,
          orderId: filledExitOrderId,
          side:
            filledPlatformId === PlatformId.KALSHI
              ? position.kalshiSide === 'buy'
                ? 'sell'
                : 'buy'
              : position.polymarketSide === 'buy'
                ? 'sell'
                : 'buy',
          price: filledExitOrder?.price
            ? new Decimal(filledExitOrder.price.toString()).toNumber()
            : 0,
          size: filledExitOrder?.size
            ? new Decimal(filledExitOrder.size.toString()).toNumber()
            : 0,
          fillPrice: filledExitOrder?.fillPrice
            ? new Decimal(filledExitOrder.fillPrice.toString()).toNumber()
            : 0,
          fillSize: filledExitOrder?.fillSize
            ? new Decimal(filledExitOrder.fillSize.toString()).toNumber()
            : 0,
        },
        {
          platform: failedPlatformId,
          reason: error instanceof Error ? error.message : String(error),
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
        error: error instanceof Error ? error.message : String(error),
        isPaper,
        mixedMode,
      },
    });
  }

  async getClosePrice(
    connector: IPlatformConnector,
    contractId: string,
    originalSide: string,
    positionSize?: Decimal,
  ): Promise<Decimal | null> {
    const orderBook = await connector.getOrderBook(contractId);
    const levels = originalSide === 'buy' ? orderBook.bids : orderBook.asks;

    if (levels.length === 0) return null;

    // Without positionSize: top-of-book (backward compatible)
    if (!positionSize) {
      return new Decimal(levels[0]!.price);
    }

    // With positionSize: VWAP across levels
    let remainingQty = positionSize;
    let totalCost = new Decimal(0);
    for (const level of levels) {
      const fillAtLevel = Decimal.min(
        remainingQty,
        new Decimal(level.quantity),
      );
      totalCost = totalCost.plus(fillAtLevel.mul(new Decimal(level.price)));
      remainingQty = remainingQty.minus(fillAtLevel);
      if (remainingQty.lte(0)) break;
    }
    const filledQty = positionSize.minus(remainingQty);
    if (filledQty.isZero()) return null;
    return totalCost.div(filledQty);
  }
}
