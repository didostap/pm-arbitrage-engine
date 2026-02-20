import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';

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

    let positions;
    try {
      positions = await this.positionRepository.findByStatusWithOrders('OPEN');
    } catch (error) {
      this.logger.error({
        message: 'Failed to query open positions for exit evaluation',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (positions.length === 0) {
      return;
    }

    let anySucceeded = false;

    for (const position of positions) {
      try {
        await this.evaluatePosition(position);
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
  ): Promise<void> {
    // Check connector health — skip if either platform is disconnected
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();

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

    // Fetch current close prices
    const kalshiClosePrice = await this.getClosePrice(
      this.kalshiConnector,
      position.pair.kalshiContractId,
      position.kalshiSide,
    );
    const polymarketClosePrice = await this.getClosePrice(
      this.polymarketConnector,
      position.pair.polymarketContractId,
      position.polymarketSide,
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
      kalshiSize: new Decimal(kalshiOrder.fillSize.toString()),
      polymarketSize: new Decimal(polymarketOrder.fillSize.toString()),
      kalshiFeeDecimal: new Decimal(kalshiFeeSchedule.takerFeePercent).div(100),
      polymarketFeeDecimal: new Decimal(
        polymarketFeeSchedule.takerFeePercent,
      ).div(100),
      resolutionDate: position.pair.resolutionDate,
      now: new Date(),
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
  ): Promise<void> {
    const kalshiOrder = position.kalshiOrder!;
    const polymarketOrder = position.polymarketOrder!;

    // Determine close sides
    const kalshiCloseSide = position.kalshiSide === 'buy' ? 'sell' : 'buy';
    const polymarketCloseSide =
      position.polymarketSide === 'buy' ? 'sell' : 'buy';

    const kalshiFillSize = new Decimal(kalshiOrder.fillSize!.toString());
    const polymarketFillSize = new Decimal(
      polymarketOrder.fillSize!.toString(),
    );

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
    const primaryFillSize = isPrimaryKalshi
      ? kalshiFillSize
      : polymarketFillSize;
    const secondaryFillSize = isPrimaryKalshi
      ? polymarketFillSize
      : kalshiFillSize;
    const primaryPlatform = isPrimaryKalshi ? 'KALSHI' : 'POLYMARKET';
    const secondaryPlatform = isPrimaryKalshi ? 'POLYMARKET' : 'KALSHI';

    // Submit primary leg exit
    let primaryResult;
    try {
      primaryResult = await primaryConnector.submitOrder({
        contractId: primaryContractId,
        side: primaryCloseSide,
        quantity: primaryFillSize.toNumber(),
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
      size: primaryFillSize.toNumber(),
      status: primaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: primaryResult.filledPrice,
      fillSize: primaryResult.filledQuantity,
    });

    // Submit secondary leg exit
    let secondaryResult;
    try {
      secondaryResult = await secondaryConnector.submitOrder({
        contractId: secondaryContractId,
        side: secondaryCloseSide,
        quantity: secondaryFillSize.toNumber(),
        price: secondaryClosePrice.toNumber(),
        type: 'limit',
      });
    } catch (error) {
      // Secondary fails → partial exit
      await this.handlePartialExit(
        position,
        primaryExitOrder.orderId,
        isPrimaryKalshi,
        error,
        secondaryClosePrice,
        secondaryFillSize,
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
        secondaryFillSize,
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
      size: secondaryFillSize.toNumber(),
      status: secondaryResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: secondaryResult.filledPrice,
      fillSize: secondaryResult.filledQuantity,
    });

    // Both legs filled — calculate realized P&L
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

    // Per-leg P&L
    let kalshiPnl: Decimal;
    if (position.kalshiSide === 'buy') {
      kalshiPnl = kalshiCloseFilledPrice
        .minus(kalshiEntryPrice)
        .mul(kalshiFillSize);
    } else {
      kalshiPnl = kalshiEntryPrice
        .minus(kalshiCloseFilledPrice)
        .mul(kalshiFillSize);
    }

    let polymarketPnl: Decimal;
    if (position.polymarketSide === 'buy') {
      polymarketPnl = polymarketCloseFilledPrice
        .minus(polymarketEntryPrice)
        .mul(polymarketFillSize);
    } else {
      polymarketPnl = polymarketEntryPrice
        .minus(polymarketCloseFilledPrice)
        .mul(polymarketFillSize);
    }

    // Exit fees
    const kalshiFee = this.kalshiConnector.getFeeSchedule();
    const polymarketFee = this.polymarketConnector.getFeeSchedule();
    const kalshiExitFee = kalshiCloseFilledPrice
      .mul(kalshiFillSize)
      .mul(new Decimal(kalshiFee.takerFeePercent).div(100));
    const polymarketExitFee = polymarketCloseFilledPrice
      .mul(polymarketFillSize)
      .mul(new Decimal(polymarketFee.takerFeePercent).div(100));

    const realizedPnl = kalshiPnl
      .plus(polymarketPnl)
      .minus(kalshiExitFee)
      .minus(polymarketExitFee);

    // Update position to CLOSED
    await this.positionRepository.updateStatus(position.positionId, 'CLOSED');

    // Release budget via risk manager
    const totalEntryCapital = kalshiEntryPrice
      .mul(kalshiFillSize)
      .plus(polymarketEntryPrice.mul(polymarketFillSize));
    const capitalReturned = totalEntryCapital.plus(realizedPnl);
    await this.riskManager.closePosition(capitalReturned, realizedPnl);

    // Determine which order is kalshi and which is polymarket
    const kalshiCloseOrderId = isPrimaryKalshi
      ? primaryExitOrder.orderId
      : secondaryExitOrder.orderId;
    const polymarketCloseOrderId = isPrimaryKalshi
      ? secondaryExitOrder.orderId
      : primaryExitOrder.orderId;

    // Emit exit event
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
      },
    });
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
      },
    });
  }

  async getClosePrice(
    connector: IPlatformConnector,
    contractId: string,
    originalSide: string,
  ): Promise<Decimal | null> {
    const orderBook = await connector.getOrderBook(contractId);
    if (originalSide === 'buy') {
      // Selling: use best bid
      if (orderBook.bids.length === 0) return null;
      return new Decimal(orderBook.bids[0]!.price);
    }
    // Buying: use best ask
    if (orderBook.asks.length === 0) return null;
    return new Decimal(orderBook.asks[0]!.price);
  }
}
