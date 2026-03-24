import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';

import type {
  BatchPositionResult,
  IPositionCloseService,
  PositionCloseResult,
} from '../../common/interfaces/position-close-service.interface';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { ExecutionLockService } from './execution-lock.service';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  ExitTriggeredEvent,
  SingleLegExposureEvent,
} from '../../common/events/execution.events';
import { BatchCompleteEvent } from '../../common/events/batch.events';
import { RiskStateDivergenceEvent } from '../../common/events/system.events';
import { EXECUTION_ERROR_CODES } from '../../common/errors/execution-error';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { KALSHI_ERROR_CODES } from '../../common/errors/platform-api-error';
import { POLYMARKET_ERROR_CODES } from '../../connectors/polymarket/polymarket-error-codes';
import {
  PlatformId,
  asContractId,
  asOrderId,
  asPairId,
  asPositionId,
} from '../../common/types';
import { FinancialMath, getResidualSize } from '../../common/utils';
import { getCorrelationId } from '../../common/services/correlation-context';

@Injectable()
export class PositionCloseService implements IPositionCloseService {
  private readonly logger = new Logger(PositionCloseService.name);

  constructor(
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    @Inject(RISK_MANAGER_TOKEN)
    private readonly riskManager: IRiskManager,
    private readonly eventEmitter: EventEmitter2,
    private readonly executionLockService: ExecutionLockService,
  ) {}

  async closePosition(
    positionId: string,
    rationale?: string,
  ): Promise<PositionCloseResult> {
    // Pre-lock validation: fast fail for non-existent positions
    const preCheck =
      await this.positionRepository.findByIdWithOrders(positionId);
    if (!preCheck) {
      return {
        success: false,
        error: 'Position not found',
        errorCode: 'NOT_FOUND',
      };
    }

    let lockAcquired = false;
    try {
      await this.executionLockService.acquire();
      lockAcquired = true;

      // Re-read position after lock acquisition (may have changed while waiting)
      const position =
        await this.positionRepository.findByIdWithOrders(positionId);

      if (!position) {
        return {
          success: false,
          error: 'Position not found',
          errorCode: 'NOT_FOUND',
        };
      }

      // Status guard — also catches race condition where exit monitor closed it during lock wait
      if (position.status !== 'OPEN' && position.status !== 'EXIT_PARTIAL') {
        return {
          success: false,
          error: `Position is not in a closeable state (current: ${position.status}). Position may be already transitioning.`,
          errorCode: 'NOT_CLOSEABLE',
        };
      }

      const kalshiOrder = position.kalshiOrder;
      const polymarketOrder = position.polymarketOrder;

      if (
        !kalshiOrder?.fillPrice ||
        !polymarketOrder?.fillPrice ||
        !kalshiOrder?.fillSize ||
        !polymarketOrder?.fillSize
      ) {
        return {
          success: false,
          error: 'Missing order fill data',
          errorCode: 'EXECUTION_FAILED',
        };
      }

      if (!position.kalshiSide || !position.polymarketSide) {
        return {
          success: false,
          error: 'Missing side data',
          errorCode: 'EXECUTION_FAILED',
        };
      }

      // Compute effective sizes
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
          const existingPnl = new Decimal(
            position.realizedPnl?.toString() ?? '0',
          );
          await this.positionRepository.closePosition(
            position.positionId,
            existingPnl,
          );
          try {
            await this.riskManager.closePosition(
              new Decimal(0),
              new Decimal(0),
              asPairId(position.pairId),
            );
          } catch (riskError) {
            this.logger.error({
              message:
                'CRITICAL: Position CLOSED in DB but risk state update failed — divergence detected',
              data: {
                positionId: position.positionId,
                error:
                  riskError instanceof Error
                    ? riskError.message
                    : String(riskError),
              },
            });
            this.eventEmitter.emit(
              EVENT_NAMES.RISK_STATE_DIVERGENCE,
              new RiskStateDivergenceEvent(
                asPositionId(position.positionId),
                asPairId(position.pairId),
                'close',
                riskError instanceof Error
                  ? riskError.message
                  : String(riskError),
              ),
            );
          }
          this.logger.warn({
            message:
              'EXIT_PARTIAL position has zero residual — transitioned to CLOSED',
            data: { positionId: position.positionId },
          });
          return { success: true, realizedPnl: '0.00000000' };
        }

        // One leg zero, other non-zero → data integrity issue, cannot close normally
        if (kalshiEffectiveSize.isZero() || polymarketEffectiveSize.isZero()) {
          this.logger.error({
            message:
              'DATA INTEGRITY: EXIT_PARTIAL has zero residual on one leg but not the other — cannot submit balanced close',
            data: {
              positionId: position.positionId,
              kalshiResidual: kalshiEffectiveSize.toString(),
              polymarketResidual: polymarketEffectiveSize.toString(),
            },
          });
          return {
            success: false,
            error: `Cannot close: one leg has zero residual (kalshi: ${kalshiEffectiveSize.toString()}, polymarket: ${polymarketEffectiveSize.toString()}). Data integrity issue — use close-leg endpoint to resolve.`,
            errorCode: 'EXECUTION_FAILED',
          };
        }
      }

      // Determine close sides
      const kalshiCloseSide = position.kalshiSide === 'buy' ? 'sell' : 'buy';
      const polymarketCloseSide =
        position.polymarketSide === 'buy' ? 'sell' : 'buy';

      // Fetch fresh order books and compute VWAP close prices
      const [kalshiOrderBook, polymarketOrderBook] = await Promise.all([
        this.kalshiConnector.getOrderBook(
          asContractId(position.pair.kalshiContractId),
        ),
        this.polymarketConnector.getOrderBook(
          asContractId(position.pair.polymarketClobTokenId!),
        ),
      ]);

      const kalshiLevels =
        position.kalshiSide === 'buy'
          ? kalshiOrderBook.bids
          : kalshiOrderBook.asks;
      const polymarketLevels =
        position.polymarketSide === 'buy'
          ? polymarketOrderBook.bids
          : polymarketOrderBook.asks;

      const kalshiClosePrice = this.computeVwap(
        kalshiLevels,
        kalshiEffectiveSize,
      );
      const polymarketClosePrice = this.computeVwap(
        polymarketLevels,
        polymarketEffectiveSize,
      );

      if (!kalshiClosePrice || !polymarketClosePrice) {
        return {
          success: false,
          error: 'Empty order book — cannot determine close price',
          errorCode: 'EXECUTION_FAILED',
        };
      }

      // Determine primary/secondary leg
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
        : position.pair.polymarketClobTokenId!;
      const secondaryContractId = isPrimaryKalshi
        ? position.pair.polymarketClobTokenId!
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
      // Cross-leg equalization: both legs submit min(both effective sizes)
      const exitSize = Decimal.min(
        kalshiEffectiveSize,
        polymarketEffectiveSize,
      );
      const primaryPlatform = isPrimaryKalshi ? 'KALSHI' : 'POLYMARKET';
      const secondaryPlatform = isPrimaryKalshi ? 'POLYMARKET' : 'KALSHI';

      // Submit primary leg
      // Note: If primary fails, no orders were placed — position stays in its
      // original state (OPEN/EXIT_PARTIAL) with no exposure. Only secondary
      // failure creates SINGLE_LEG_EXPOSED (one leg filled, other failed).
      let primaryResult;
      try {
        primaryResult = await primaryConnector.submitOrder({
          contractId: asContractId(primaryContractId),
          side: primaryCloseSide,
          quantity: exitSize.toNumber(),
          price: primaryClosePrice.toNumber(),
          type: 'limit',
        });
      } catch (error) {
        return {
          success: false,
          error: `Primary leg submission failed: ${error instanceof Error ? error.message : String(error)}`,
          errorCode: 'EXECUTION_FAILED',
        };
      }

      if (
        primaryResult.status !== 'filled' &&
        primaryResult.status !== 'partial'
      ) {
        return {
          success: false,
          error: `Primary leg not filled (status: ${primaryResult.status})`,
          errorCode: 'EXECUTION_FAILED',
        };
      }

      // Persist primary close order
      const primaryCloseOrder = await this.orderRepository.create({
        platform: primaryPlatform,
        contractId: primaryContractId,
        pair: { connect: { matchId: position.pairId } },
        side: primaryCloseSide,
        price: primaryClosePrice.toNumber(),
        size: exitSize.toNumber(),
        status: primaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
        fillPrice: primaryResult.filledPrice,
        fillSize: primaryResult.filledQuantity,
        isPaper: position.isPaper ?? false,
      });

      // Re-fetch secondary order book after primary fills (price may have moved)
      let freshSecondaryClosePrice = secondaryClosePrice;
      try {
        const freshSecondaryBook = await secondaryConnector.getOrderBook(
          asContractId(secondaryContractId),
        );
        const freshSecondaryLevels = isPrimaryKalshi
          ? position.polymarketSide === 'buy'
            ? freshSecondaryBook.bids
            : freshSecondaryBook.asks
          : position.kalshiSide === 'buy'
            ? freshSecondaryBook.bids
            : freshSecondaryBook.asks;
        const refreshedPrice = this.computeVwap(freshSecondaryLevels, exitSize);
        if (refreshedPrice) {
          freshSecondaryClosePrice = refreshedPrice;
        }
      } catch {
        // Fall back to original price if re-fetch fails
        this.logger.warn({
          message:
            'Secondary order book re-fetch failed — using original price',
          data: { positionId: position.positionId },
        });
      }

      // Submit secondary leg
      let secondaryResult;
      try {
        secondaryResult = await secondaryConnector.submitOrder({
          contractId: asContractId(secondaryContractId),
          side: secondaryCloseSide,
          quantity: exitSize.toNumber(),
          price: freshSecondaryClosePrice.toNumber(),
          type: 'limit',
        });
      } catch (error) {
        // Secondary failed → SINGLE_LEG_EXPOSED
        return this.handleSingleLegFailure(
          position,
          primaryCloseOrder.orderId,
          isPrimaryKalshi,
          error,
          freshSecondaryClosePrice,
          exitSize,
        );
      }

      if (
        secondaryResult.status !== 'filled' &&
        secondaryResult.status !== 'partial'
      ) {
        return this.handleSingleLegFailure(
          position,
          primaryCloseOrder.orderId,
          isPrimaryKalshi,
          new Error(`Order status: ${secondaryResult.status}`),
          freshSecondaryClosePrice,
          exitSize,
        );
      }

      // Persist secondary close order
      const secondaryCloseOrder = await this.orderRepository.create({
        platform: secondaryPlatform,
        contractId: secondaryContractId,
        pair: { connect: { matchId: position.pairId } },
        side: secondaryCloseSide,
        price: freshSecondaryClosePrice.toNumber(),
        size: exitSize.toNumber(),
        status: secondaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
        fillPrice: secondaryResult.filledPrice,
        fillSize: secondaryResult.filledQuantity,
        isPaper: position.isPaper ?? false,
      });

      // Compute P&L
      const kalshiExitFillSize = isPrimaryKalshi
        ? new Decimal(primaryResult.filledQuantity)
        : new Decimal(secondaryResult.filledQuantity);
      const polymarketExitFillSize = isPrimaryKalshi
        ? new Decimal(secondaryResult.filledQuantity)
        : new Decimal(primaryResult.filledQuantity);

      const kalshiEntryPrice = new Decimal(kalshiOrder.fillPrice.toString());
      const polymarketEntryPrice = new Decimal(
        polymarketOrder.fillPrice.toString(),
      );
      const kalshiCloseFilledPrice = isPrimaryKalshi
        ? new Decimal(primaryResult.filledPrice)
        : new Decimal(secondaryResult.filledPrice);
      const polymarketCloseFilledPrice = isPrimaryKalshi
        ? new Decimal(secondaryResult.filledPrice)
        : new Decimal(primaryResult.filledPrice);

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

      // Exit fees
      const kalshiFeeSchedule = this.kalshiConnector.getFeeSchedule();
      const polymarketFeeSchedule = this.polymarketConnector.getFeeSchedule();
      const kalshiExitFee = kalshiCloseFilledPrice
        .mul(kalshiExitFillSize)
        .mul(
          FinancialMath.calculateTakerFeeRate(
            kalshiCloseFilledPrice,
            kalshiFeeSchedule,
          ),
        );
      const polymarketExitFee = polymarketCloseFilledPrice
        .mul(polymarketExitFillSize)
        .mul(
          FinancialMath.calculateTakerFeeRate(
            polymarketCloseFilledPrice,
            polymarketFeeSchedule,
          ),
        );

      const realizedPnl = kalshiPnl
        .plus(polymarketPnl)
        .minus(kalshiExitFee)
        .minus(polymarketExitFee);

      // Capital on exited portion
      const exitedEntryCapital = kalshiEntryPrice
        .mul(kalshiExitFillSize)
        .plus(polymarketEntryPrice.mul(polymarketExitFillSize));
      const capitalReturned = exitedEntryCapital.plus(realizedPnl);

      // Determine full vs partial exit (compare exit fills to effective sizes)
      const isFullExit =
        kalshiExitFillSize.round().gte(kalshiEffectiveSize.round()) &&
        polymarketExitFillSize.round().gte(polymarketEffectiveSize.round());

      const kalshiCloseOrderId = asOrderId(
        isPrimaryKalshi
          ? primaryCloseOrder.orderId
          : secondaryCloseOrder.orderId,
      );
      const polymarketCloseOrderId = asOrderId(
        isPrimaryKalshi
          ? secondaryCloseOrder.orderId
          : primaryCloseOrder.orderId,
      );

      if (isFullExit) {
        // Full exit → CLOSED with realizedPnl (add to any accumulated partial PnL)
        const existingPnl = new Decimal(
          position.realizedPnl?.toString() ?? '0',
        );
        await this.positionRepository.closePosition(
          position.positionId,
          existingPnl.plus(realizedPnl),
        );
        try {
          await this.riskManager.closePosition(
            capitalReturned,
            realizedPnl,
            asPairId(position.pairId),
          );
        } catch (riskError) {
          this.logger.error({
            message:
              'CRITICAL: Position CLOSED in DB but risk state update failed — divergence detected',
            data: {
              positionId: position.positionId,
              error:
                riskError instanceof Error
                  ? riskError.message
                  : String(riskError),
            },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.RISK_STATE_DIVERGENCE,
            new RiskStateDivergenceEvent(
              asPositionId(position.positionId),
              asPairId(position.pairId),
              'close',
              riskError instanceof Error
                ? riskError.message
                : String(riskError),
            ),
          );
        }

        this.eventEmitter.emit(
          EVENT_NAMES.EXIT_TRIGGERED,
          new ExitTriggeredEvent(
            asPositionId(position.positionId),
            asPairId(position.pairId),
            'manual',
            new Decimal(position.expectedEdge.toString()).toFixed(8),
            '0',
            realizedPnl.toFixed(8),
            kalshiCloseOrderId,
            polymarketCloseOrderId,
            undefined,
            position.isPaper ?? false,
            false,
          ),
        );

        this.logger.log({
          message: 'Position manually closed',
          data: {
            positionId: position.positionId,
            rationale,
            realizedPnl: realizedPnl.toFixed(8),
            kalshiCloseOrderId,
            polymarketCloseOrderId,
          },
        });

        return {
          success: true,
          realizedPnl: realizedPnl.toFixed(8),
        };
      } else {
        // Partial fill → EXIT_PARTIAL with accumulated PnL persistence
        const existingPnl = new Decimal(
          position.realizedPnl?.toString() ?? '0',
        );
        await this.positionRepository.updateStatusWithAccumulatedPnl(
          position.positionId,
          'EXIT_PARTIAL',
          realizedPnl,
          existingPnl,
        );
        try {
          await this.riskManager.releasePartialCapital(
            exitedEntryCapital.plus(realizedPnl),
            realizedPnl,
            asPairId(position.pairId),
          );
        } catch (riskError) {
          this.logger.error({
            message:
              'CRITICAL: Position EXIT_PARTIAL in DB but risk state update failed — divergence detected',
            data: {
              positionId: position.positionId,
              error:
                riskError instanceof Error
                  ? riskError.message
                  : String(riskError),
            },
          });
          this.eventEmitter.emit(
            EVENT_NAMES.RISK_STATE_DIVERGENCE,
            new RiskStateDivergenceEvent(
              asPositionId(position.positionId),
              asPairId(position.pairId),
              'partial_release',
              riskError instanceof Error
                ? riskError.message
                : String(riskError),
            ),
          );
        }

        this.logger.warn({
          message:
            'Manual close partially filled — position remains EXIT_PARTIAL',
          data: {
            positionId: position.positionId,
            rationale,
            kalshiExitFillSize: kalshiExitFillSize.toString(),
            polymarketExitFillSize: polymarketExitFillSize.toString(),
            realizedPnl: realizedPnl.toFixed(8),
          },
        });

        return {
          success: true,
          realizedPnl: realizedPnl.toFixed(8),
          error:
            'Partial fill — position remains EXIT_PARTIAL with updated residual',
        };
      }
    } catch (error) {
      this.logger.error({
        message: 'Manual close failed',
        data: {
          positionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });

      if (error instanceof PlatformApiError && this.isRateLimitError(error)) {
        return {
          success: false,
          error: error.message,
          errorCode: 'RATE_LIMITED',
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'EXECUTION_FAILED',
      };
    } finally {
      if (lockAcquired) this.executionLockService.release();
    }
  }

  private async handleSingleLegFailure(
    position: NonNullable<
      Awaited<ReturnType<PositionRepository['findByIdWithOrders']>>
    >,
    filledCloseOrderId: string,
    filledIsPrimaryKalshi: boolean,
    error: unknown,
    failedAttemptedPrice: Decimal,
    failedAttemptedSize: Decimal,
  ): Promise<PositionCloseResult> {
    await this.positionRepository.updateStatus(
      position.positionId,
      'SINGLE_LEG_EXPOSED',
    );

    const filledPlatformId = filledIsPrimaryKalshi
      ? PlatformId.KALSHI
      : PlatformId.POLYMARKET;
    const failedPlatformId = filledIsPrimaryKalshi
      ? PlatformId.POLYMARKET
      : PlatformId.KALSHI;

    const filledOrder = await this.orderRepository.findById(filledCloseOrderId);

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE,
      new SingleLegExposureEvent(
        asPositionId(position.positionId),
        asPairId(position.pairId),
        new Decimal(position.expectedEdge.toString()).toNumber(),
        {
          platform: filledPlatformId,
          orderId: asOrderId(filledCloseOrderId),
          side:
            filledPlatformId === PlatformId.KALSHI
              ? position.kalshiSide === 'buy'
                ? 'sell'
                : 'buy'
              : position.polymarketSide === 'buy'
                ? 'sell'
                : 'buy',
          price: filledOrder?.price
            ? new Decimal(filledOrder.price.toString()).toNumber()
            : 0,
          size: filledOrder?.size
            ? new Decimal(filledOrder.size.toString()).toNumber()
            : 0,
          fillPrice: filledOrder?.fillPrice
            ? new Decimal(filledOrder.fillPrice.toString()).toNumber()
            : 0,
          fillSize: filledOrder?.fillSize
            ? new Decimal(filledOrder.fillSize.toString()).toNumber()
            : 0,
        },
        {
          platform: failedPlatformId,
          reason: error instanceof Error ? error.message : String(error),
          reasonCode: EXECUTION_ERROR_CODES.CLOSE_FAILED,
          attemptedPrice: failedAttemptedPrice.toNumber(),
          attemptedSize: failedAttemptedSize.toNumber(),
        },
        {
          kalshi: { bestBid: null, bestAsk: null },
          polymarket: { bestBid: null, bestAsk: null },
        },
        {
          closeNowEstimate: 'Manual close — one leg filled, other failed',
          retryAtCurrentPrice: 'Use retry-leg or close-leg endpoint',
          holdRiskAssessment:
            'SINGLE_LEG_EXPOSED: Operator intervention needed',
        },
        [
          'Retry failed leg via POST /api/positions/:id/retry-leg',
          'Close filled leg via POST /api/positions/:id/close-leg',
        ],
        undefined,
        'manual_close',
        position.isPaper ?? false,
        false,
      ),
    );

    return {
      success: false,
      error: `Single-leg exposure: ${filledPlatformId} filled, ${failedPlatformId} failed. Use retry-leg or close-leg to resolve.`,
    };
  }

  async closeAllPositions(rationale?: string): Promise<{ batchId: string }> {
    const batchId = randomUUID();
    const correlationId = getCorrelationId();

    // Query all closeable positions (both live and paper)
    const [livePositions, paperPositions] = await Promise.all([
      this.positionRepository.findByStatusWithPair(
        { in: ['OPEN', 'EXIT_PARTIAL'] },
        false,
      ),
      this.positionRepository.findByStatusWithPair(
        { in: ['OPEN', 'EXIT_PARTIAL'] },
        true,
      ),
    ]);
    const positions = [...livePositions, ...paperPositions];

    // Fire-and-forget — controller returns 202 immediately
    void this.processCloseAllBatch(
      batchId,
      positions,
      rationale,
      correlationId,
    );

    return { batchId };
  }

  private async processCloseAllBatch(
    batchId: string,
    positions: Array<{
      positionId: string;
      pairId: string;
      pair: {
        pairName?: string | null;
        kalshiContractId: string;
        polymarketContractId: string;
      };
    }>,
    rationale?: string,
    correlationId?: string,
  ): Promise<void> {
    const results: BatchPositionResult[] = [];

    try {
      for (const position of positions) {
        try {
          const result = await this.closePosition(
            position.positionId,
            rationale,
          );
          results.push({
            positionId: position.positionId,
            pairName:
              position.pair.pairName ??
              `${position.pair.kalshiContractId} / ${position.pair.polymarketContractId}`,
            status: result.success
              ? 'success'
              : result.errorCode === 'RATE_LIMITED'
                ? 'rate_limited'
                : 'failure',
            realizedPnl: result.realizedPnl,
            error: result.error,
          });
        } catch (error) {
          this.logger.error({
            message: 'Batch close unexpected error',
            data: {
              batchId,
              positionId: position.positionId,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          results.push({
            positionId: position.positionId,
            pairName:
              position.pair.pairName ??
              `${position.pair.kalshiContractId} / ${position.pair.polymarketContractId}`,
            status: 'failure',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Batch close loop failed',
        data: {
          batchId,
          error: error instanceof Error ? error.message : String(error),
          completedCount: results.length,
          totalCount: positions.length,
        },
      });
    }

    try {
      this.eventEmitter.emit(
        EVENT_NAMES.BATCH_COMPLETE,
        new BatchCompleteEvent(batchId, results, correlationId),
      );
    } catch (error) {
      this.logger.error({
        message: 'Failed to emit batch.complete event',
        data: {
          batchId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private isRateLimitError(error: PlatformApiError): boolean {
    return (
      error.code === KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED ||
      error.code === POLYMARKET_ERROR_CODES.RATE_LIMIT
    );
  }

  private computeVwap(
    levels: Array<{ price: number; quantity: number }>,
    positionSize: Decimal,
  ): Decimal | null {
    if (levels.length === 0) return null;

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
