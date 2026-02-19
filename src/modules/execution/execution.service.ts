import { Inject, Injectable, Logger } from '@nestjs/common';
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
  OrderFilledEvent,
  ExecutionFailedEvent,
} from '../../common/events/execution.events';
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

  constructor(
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    private readonly orderRepository: OrderRepository,
    private readonly positionRepository: PositionRepository,
  ) {}

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

    const primaryContractId =
      primaryLeg === 'kalshi'
        ? dislocation.pairConfig.kalshiContractId
        : dislocation.pairConfig.polymarketContractId;
    const secondaryContractId =
      primaryLeg === 'kalshi'
        ? dislocation.pairConfig.polymarketContractId
        : dislocation.pairConfig.kalshiContractId;

    // Determine sides: the buy platform buys, the sell platform sells
    const primarySide =
      dislocation.buyPlatformId === primaryPlatform ? 'buy' : 'sell';
    const secondarySide = primarySide === 'buy' ? 'sell' : 'buy';

    const targetPrice =
      primarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;
    const secondaryTargetPrice =
      secondarySide === 'buy' ? dislocation.buyPrice : dislocation.sellPrice;

    const targetSize = new Decimal(reservation.reservedCapitalUsd)
      .div(targetPrice)
      .floor()
      .toNumber();

    // Step 1: Verify depth on primary platform
    const primaryDepthOk = await this.verifyDepth(
      primaryConnector,
      primaryContractId,
      primarySide,
      targetPrice.toNumber(),
      targetSize,
    );

    if (!primaryDepthOk) {
      this.logger.warn({
        message: 'Pre-primary depth verification failed',
        module: 'execution',
        data: {
          pairId,
          platform: primaryPlatform,
          contractId: primaryContractId,
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
        ),
      );
      return { success: false, partialFill: false, error };
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
    });

    // Step 4: Verify depth on secondary platform
    const secondarySize = new Decimal(reservation.reservedCapitalUsd)
      .div(secondaryTargetPrice)
      .floor()
      .toNumber();

    const secondaryDepthOk = await this.verifyDepth(
      secondaryConnector,
      secondaryContractId,
      secondarySide,
      secondaryTargetPrice.toNumber(),
      secondarySize,
    );

    if (!secondaryDepthOk) {
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
      );
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

    return {
      success: true,
      partialFill: false,
      positionId: position.positionId,
      primaryOrder,
      secondaryOrder,
    };
  }

  private async verifyDepth(
    connector: IPlatformConnector,
    contractId: string,
    side: 'buy' | 'sell',
    targetPrice: number,
    targetSize: number,
  ): Promise<boolean> {
    try {
      const book = await connector.getOrderBook(contractId);
      const levels: PriceLevel[] = side === 'buy' ? book.asks : book.bids;

      let availableQty = 0;
      for (const level of levels) {
        const priceOk =
          side === 'buy'
            ? level.price <= targetPrice
            : level.price >= targetPrice;
        if (priceOk) {
          availableQty += level.quantity;
        }
      }

      return availableQty >= targetSize;
    } catch {
      // Rate limited or API error — treat as insufficient liquidity
      return false;
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

    const error = new ExecutionError(
      EXECUTION_ERROR_CODES.SINGLE_LEG_EXPOSURE,
      errorMessage,
      'critical',
      undefined,
      { positionId: position.positionId, pairId },
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
