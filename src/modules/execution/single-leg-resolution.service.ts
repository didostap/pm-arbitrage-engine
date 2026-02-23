import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import type { IRiskManager } from '../../common/interfaces/risk-manager.interface';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  SingleLegResolvedEvent,
  OrderFilledEvent,
} from '../../common/events/execution.events';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';
import { PlatformId } from '../../common/types/platform.type';
import {
  calculateSingleLegPnlScenarios,
  buildRecommendedActions,
} from './single-leg-pnl.util';

export interface RetryLegResult {
  success: boolean;
  orderId?: string;
  newEdge?: number;
  reason?: string;
  pnlScenarios?: {
    closeNowEstimate: string;
    retryAtCurrentPrice: string;
    holdRiskAssessment: string;
  };
  recommendedActions?: string[];
}

export interface CloseLegResult {
  success: boolean;
  closeOrderId?: string;
  realizedPnl?: string;
  reason?: string;
}

@Injectable()
export class SingleLegResolutionService {
  private readonly logger = new Logger(SingleLegResolutionService.name);

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
  ) {}

  async retryLeg(
    positionId: string,
    retryPrice: number,
  ): Promise<RetryLegResult> {
    const position = await this.positionRepository.findByIdWithPair(positionId);
    if (!position) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
        `Position ${positionId} not found`,
        'error',
      );
    }

    if (
      position.status !== 'SINGLE_LEG_EXPOSED' &&
      position.status !== 'EXIT_PARTIAL'
    ) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
        'Position is not in single-leg exposed or exit-partial state',
        'warning',
      );
    }

    const failedPlatform = this.getFailedPlatform(position);
    const connector = this.getConnector(failedPlatform);
    const contractId = this.getContractId(position.pair, failedPlatform);
    const side = this.getSide(position, failedPlatform);
    const sizes = position.sizes as { kalshi: string; polymarket: string };
    const size = parseFloat(
      failedPlatform === PlatformId.KALSHI ? sizes.kalshi : sizes.polymarket,
    );

    // Compute paper/mixed mode from connector health
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();
    const isPaper =
      kalshiHealth.mode === 'paper' || polymarketHealth.mode === 'paper';
    const mixedMode =
      (kalshiHealth.mode === 'paper') !== (polymarketHealth.mode === 'paper');

    let orderResult;
    try {
      orderResult = await connector.submitOrder({
        contractId,
        side,
        quantity: size,
        price: retryPrice,
        type: 'limit',
      });
    } catch (error) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.RETRY_FAILED,
        `Retry leg submission failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }

    if (orderResult.status === 'filled' || orderResult.status === 'partial') {
      const newOrder = await this.orderRepository.create({
        platform:
          failedPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
        contractId,
        pair: { connect: { matchId: position.pairId } },
        side,
        price: retryPrice,
        size,
        status: orderResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
        fillPrice: orderResult.filledPrice,
        fillSize: orderResult.filledQuantity,
      });

      const updateData: Record<string, unknown> = { status: 'OPEN' as const };
      if (failedPlatform === PlatformId.KALSHI) {
        updateData.kalshiOrder = { connect: { orderId: newOrder.orderId } };
      } else {
        updateData.polymarketOrder = { connect: { orderId: newOrder.orderId } };
      }
      await this.positionRepository.updateWithOrder(positionId, updateData);

      const filledPlatform = this.getFilledPlatform(position);
      const filledOrderId =
        filledPlatform === PlatformId.KALSHI
          ? position.kalshiOrderId!
          : position.polymarketOrderId!;
      const filledOrder = await this.orderRepository.findById(filledOrderId);
      const entryFillPrice = filledOrder
        ? new Decimal(filledOrder.fillPrice?.toString() ?? '0').toNumber()
        : 0;

      const newEdge = Math.abs(entryFillPrice - orderResult.filledPrice);

      this.eventEmitter.emit(
        EVENT_NAMES.ORDER_FILLED,
        new OrderFilledEvent(
          newOrder.orderId,
          failedPlatform,
          side,
          retryPrice,
          size,
          orderResult.filledPrice,
          orderResult.filledQuantity,
          positionId,
          undefined,
          isPaper,
          mixedMode,
        ),
      );

      this.eventEmitter.emit(
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        new SingleLegResolvedEvent(
          positionId,
          position.pairId,
          'retried',
          {
            orderId: newOrder.orderId,
            platform: failedPlatform,
            status: orderResult.status,
            filledPrice: orderResult.filledPrice,
            filledQuantity: orderResult.filledQuantity,
          },
          new Decimal(position.expectedEdge.toString()).toNumber(),
          newEdge,
          retryPrice,
          null,
          undefined,
          isPaper,
          mixedMode,
        ),
      );

      this.logger.log({
        message: 'Single-leg exposure resolved via retry',
        data: {
          positionId,
          pairId: position.pairId,
          retryPrice,
          originalEdge: position.expectedEdge.toString(),
          newEdge,
          orderId: newOrder.orderId,
        },
      });

      return { success: true, orderId: newOrder.orderId, newEdge };
    }

    // Order failed — return current P&L scenarios
    const pnlData = await this.buildPnlScenarios(position);

    this.logger.warn({
      message: 'Retry leg submission did not fill',
      data: {
        positionId,
        pairId: position.pairId,
        retryPrice,
        orderStatus: orderResult.status,
      },
    });

    return {
      success: false,
      reason: `Order status: ${orderResult.status}`,
      pnlScenarios: pnlData.pnlScenarios,
      recommendedActions: pnlData.recommendedActions,
    };
  }

  async closeLeg(
    positionId: string,
    rationale?: string,
  ): Promise<CloseLegResult> {
    const position = await this.positionRepository.findByIdWithPair(positionId);
    if (!position) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.CLOSE_FAILED,
        `Position ${positionId} not found`,
        'error',
      );
    }

    if (
      position.status !== 'SINGLE_LEG_EXPOSED' &&
      position.status !== 'EXIT_PARTIAL'
    ) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
        'Position is not in single-leg exposed or exit-partial state',
        'warning',
      );
    }

    const filledPlatform = this.getFilledPlatform(position);
    const connector = this.getConnector(filledPlatform);
    const contractId = this.getContractId(position.pair, filledPlatform);
    const filledSide = this.getSide(position, filledPlatform);

    // Compute paper/mixed mode from connector health
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();
    const isPaper =
      kalshiHealth.mode === 'paper' || polymarketHealth.mode === 'paper';
    const mixedMode =
      (kalshiHealth.mode === 'paper') !== (polymarketHealth.mode === 'paper');

    // Get the filled order record for entry price
    const filledOrderId =
      filledPlatform === PlatformId.KALSHI
        ? position.kalshiOrderId!
        : position.polymarketOrderId!;
    const filledOrder = await this.orderRepository.findById(filledOrderId);
    if (
      !filledOrder ||
      filledOrder.fillPrice === null ||
      filledOrder.fillSize === null
    ) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.CLOSE_FAILED,
        'Cannot determine entry price from filled order',
        'error',
      );
    }

    // Get current order book for close price
    let orderBook;
    try {
      orderBook = await connector.getOrderBook(contractId);
    } catch (error) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.CLOSE_FAILED,
        `Failed to fetch order book: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }

    // Determine close price: opposing side
    const opposingSide = filledSide === 'buy' ? 'sell' : 'buy';
    let closePrice: number;
    if (opposingSide === 'sell') {
      // Selling: use best bid
      if (orderBook.bids.length === 0) {
        throw new ExecutionError(
          EXECUTION_ERROR_CODES.CLOSE_FAILED,
          'Cannot determine close price: order book has no bids',
          'warning',
        );
      }
      closePrice = orderBook.bids[0]!.price;
    } else {
      // Buying: use best ask
      if (orderBook.asks.length === 0) {
        throw new ExecutionError(
          EXECUTION_ERROR_CODES.CLOSE_FAILED,
          'Cannot determine close price: order book has no asks',
          'warning',
        );
      }
      closePrice = orderBook.asks[0]!.price;
    }

    const fillSize = new Decimal(filledOrder.fillSize.toString()).toNumber();

    let closeOrderResult;
    try {
      closeOrderResult = await connector.submitOrder({
        contractId,
        side: opposingSide,
        quantity: fillSize,
        price: closePrice,
        type: 'limit',
      });
    } catch (error) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.CLOSE_FAILED,
        `Close leg submission failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }

    if (
      closeOrderResult.status !== 'filled' &&
      closeOrderResult.status !== 'partial'
    ) {
      throw new ExecutionError(
        EXECUTION_ERROR_CODES.CLOSE_FAILED,
        `Close order not filled: ${closeOrderResult.status}`,
        'error',
      );
    }

    // Persist close order
    const closeOrder = await this.orderRepository.create({
      platform: filledPlatform === PlatformId.KALSHI ? 'KALSHI' : 'POLYMARKET',
      contractId,
      pair: { connect: { matchId: position.pairId } },
      side: opposingSide,
      price: closePrice,
      size: fillSize,
      status: closeOrderResult.status === 'filled' ? 'FILLED' : 'PARTIAL',
      fillPrice: closeOrderResult.filledPrice,
      fillSize: closeOrderResult.filledQuantity,
    });

    // Calculate realized P&L
    const entryFillPrice = new Decimal(filledOrder.fillPrice.toString());
    const closeFillPrice = new Decimal(closeOrderResult.filledPrice);
    const qty = new Decimal(filledOrder.fillSize.toString());
    const feeSchedule = connector.getFeeSchedule();
    const takerFeeDecimal = new Decimal(feeSchedule.takerFeePercent).div(100);
    const closeFee = closeFillPrice.mul(qty).mul(takerFeeDecimal);

    let rawPnl: Decimal;
    if (filledSide === 'buy') {
      // buy→sell: P&L = (closePrice - entryPrice) × size
      rawPnl = closeFillPrice.minus(entryFillPrice).mul(qty);
    } else {
      // sell→buy: P&L = (entryPrice - closePrice) × size
      rawPnl = entryFillPrice.minus(closeFillPrice).mul(qty);
    }
    const realizedPnl = rawPnl.minus(closeFee);

    // Update position status to CLOSED
    await this.positionRepository.updateStatus(positionId, 'CLOSED');

    // Release budget via risk manager
    const entryCapital = entryFillPrice.mul(qty);
    const capitalReturned = entryCapital.plus(realizedPnl);
    await this.riskManager.closePosition(capitalReturned, realizedPnl);

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_RESOLVED,
      new SingleLegResolvedEvent(
        positionId,
        position.pairId,
        'closed',
        {
          orderId: closeOrder.orderId,
          platform: filledPlatform,
          status: closeOrderResult.status,
          filledPrice: closeOrderResult.filledPrice,
          filledQuantity: closeOrderResult.filledQuantity,
        },
        new Decimal(position.expectedEdge.toString()).toNumber(),
        null,
        null,
        realizedPnl.toFixed(8),
        undefined,
        isPaper,
        mixedMode,
      ),
    );

    this.logger.log({
      message: 'Single-leg exposure resolved via close',
      data: {
        positionId,
        pairId: position.pairId,
        realizedPnl: realizedPnl.toFixed(8),
        rationale: rationale ?? 'none provided',
        closeOrderId: closeOrder.orderId,
      },
    });

    return {
      success: true,
      closeOrderId: closeOrder.orderId,
      realizedPnl: realizedPnl.toFixed(8),
    };
  }

  private getFailedPlatform(position: {
    kalshiOrderId: string | null;
    polymarketOrderId: string | null;
  }): PlatformId {
    if (position.kalshiOrderId === null) return PlatformId.KALSHI;
    if (position.polymarketOrderId === null) return PlatformId.POLYMARKET;
    throw new ExecutionError(
      EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
      'Cannot determine failed leg: both orders exist',
      'error',
    );
  }

  private getFilledPlatform(position: {
    kalshiOrderId: string | null;
    polymarketOrderId: string | null;
  }): PlatformId {
    if (position.kalshiOrderId !== null) return PlatformId.KALSHI;
    if (position.polymarketOrderId !== null) return PlatformId.POLYMARKET;
    throw new ExecutionError(
      EXECUTION_ERROR_CODES.INVALID_POSITION_STATE,
      'Cannot determine filled leg: no orders exist',
      'error',
    );
  }

  private getConnector(platform: PlatformId): IPlatformConnector {
    return platform === PlatformId.KALSHI
      ? this.kalshiConnector
      : this.polymarketConnector;
  }

  private getContractId(
    pair: { kalshiContractId: string; polymarketContractId: string },
    platform: PlatformId,
  ): string {
    return platform === PlatformId.KALSHI
      ? pair.kalshiContractId
      : pair.polymarketContractId;
  }

  private getSide(
    position: { kalshiSide: string | null; polymarketSide: string | null },
    platform: PlatformId,
  ): 'buy' | 'sell' {
    const side =
      platform === PlatformId.KALSHI
        ? position.kalshiSide
        : position.polymarketSide;
    return side as 'buy' | 'sell';
  }

  async buildPnlScenarios(position: {
    kalshiOrderId: string | null;
    polymarketOrderId: string | null;
    kalshiSide: string | null;
    polymarketSide: string | null;
    pairId: string;
    positionId: string;
    pair: { kalshiContractId: string; polymarketContractId: string };
  }) {
    const filledPlatform = this.getFilledPlatform(position);
    const failedPlatform = this.getFailedPlatform(position);
    const filledSide = this.getSide(position, filledPlatform);
    const failedSide = this.getSide(position, failedPlatform);

    const filledOrderId =
      filledPlatform === PlatformId.KALSHI
        ? position.kalshiOrderId!
        : position.polymarketOrderId!;
    const filledOrder = await this.orderRepository.findById(filledOrderId);

    const fillPrice = filledOrder?.fillPrice
      ? new Decimal(filledOrder.fillPrice.toString()).toNumber()
      : 0;
    const fillSize = filledOrder?.fillSize
      ? new Decimal(filledOrder.fillSize.toString()).toNumber()
      : 0;

    const ORDERBOOK_FETCH_TIMEOUT_MS = 2000;
    const withTimeout = <T>(
      promise: Promise<T>,
      ms: number,
    ): Promise<T | null> =>
      Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
      ]);

    const [kalshiBook, polymarketBook] = await Promise.all([
      withTimeout(
        this.kalshiConnector.getOrderBook(position.pair.kalshiContractId),
        ORDERBOOK_FETCH_TIMEOUT_MS,
      ).catch(() => null),
      withTimeout(
        this.polymarketConnector.getOrderBook(
          position.pair.polymarketContractId,
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

    const kalshiFee = this.kalshiConnector.getFeeSchedule();
    const polymarketFee = this.polymarketConnector.getFeeSchedule();
    const filledTakerFeeDecimal =
      (filledPlatform === PlatformId.KALSHI
        ? kalshiFee.takerFeePercent
        : polymarketFee.takerFeePercent) / 100;
    const failedTakerFeeDecimal =
      (failedPlatform === PlatformId.KALSHI
        ? kalshiFee.takerFeePercent
        : polymarketFee.takerFeePercent) / 100;

    const pnlScenarios = calculateSingleLegPnlScenarios({
      filledPlatform,
      filledSide,
      fillPrice,
      fillSize,
      currentPrices,
      secondaryPlatform: failedPlatform,
      secondarySide: failedSide,
      takerFeeDecimal: filledTakerFeeDecimal,
      secondaryTakerFeeDecimal: failedTakerFeeDecimal,
    });

    const recommendedActions = buildRecommendedActions(
      pnlScenarios,
      position.positionId,
    );

    return { pnlScenarios, recommendedActions, currentPrices };
  }
}
