import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Decimal from 'decimal.js';
import { PositionRepository } from '../../persistence/repositories/position.repository';
import { OrderRepository } from '../../persistence/repositories/order.repository';
import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import {
  AutoUnwindEvent,
  SingleLegExposureEvent,
  type PartialSingleLegContext,
} from '../../common/events/execution.events';
import {
  ExecutionError,
  EXECUTION_ERROR_CODES,
} from '../../common/errors/execution-error';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import { PlatformId } from '../../common/types/platform.type';
import {
  asContractId,
  asPositionId,
  asPairId,
} from '../../common/types/branded.type';
import type { CloseLegResult } from './single-leg-resolution.service';
import { SingleLegResolutionService } from './single-leg-resolution.service';

// #6 — Named constants instead of magic numbers. Single source of truth;
//       env.schema.ts defaults are authoritative, these are ConfigService.get fallbacks only.
const DEFAULT_DELAY_MS = 2000;
const DEFAULT_MAX_LOSS_PCT = 5;
const MAX_IN_FLIGHT = 100;
// #9 — Explicit Decimal precision for loss estimation financial math
const LOSS_PCT_DECIMAL_PLACES = 2;

/** Statuses eligible for auto-unwind.
 *  OPEN is excluded: single-leg exposure only occurs during execution, not exit.
 *  If an exit fails partially the position moves to EXIT_PARTIAL, which IS handled. (#5)
 */
const UNWINDABLE_STATUSES = new Set(['SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL']);

interface LossEstimate {
  estimatedLossPct: number;
  closePrice: Decimal;
}

@Injectable()
export class AutoUnwindService {
  private readonly logger = new Logger(AutoUnwindService.name);

  /** Cleanup: .delete() in finally block after each unwind attempt */
  /** Tracks positionIds currently being auto-unwound to prevent duplicate processing.
   *  Node.js is single-threaded so check+add is atomic within the event loop (#2). */
  private readonly inFlightUnwinds = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly resolutionService: SingleLegResolutionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * CRITICAL: Only subscribe to SINGLE_LEG_EXPOSURE, NOT SINGLE_LEG_EXPOSURE_REMINDER.
   * Auto-unwind is a one-shot mechanism — reminders must NOT trigger re-attempts.
   */
  @OnEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE)
  async onSingleLegExposure(event: SingleLegExposureEvent): Promise<void> {
    const startTime = Date.now();
    const positionId = event.positionId as string;

    // 1. Config guard — if disabled, entire path is inert
    // Use === true for defense-in-depth: raw string "false" is truthy in JS
    const enabled = this.configService.get<boolean>('AUTO_UNWIND_ENABLED');
    if (enabled !== true) {
      return;
    }

    // 2. In-flight guard — prevent duplicate processing (#2: combined check+add+capacity)
    if (!this.tryAcquireInFlight(positionId)) {
      return;
    }

    try {
      const delay = this.configService.get<number>(
        'AUTO_UNWIND_DELAY_MS',
        DEFAULT_DELAY_MS,
      );
      const maxLossPct = this.configService.get<number>(
        'AUTO_UNWIND_MAX_LOSS_PCT',
        DEFAULT_MAX_LOSS_PCT,
      );

      const context = this.reconstructContext(event);

      // 3. Wait for order book to stabilize after failed submission
      await new Promise((resolve) => setTimeout(resolve, delay));

      // 4. Re-check position status via DB query (not cached) — may have been resolved during delay
      const position =
        await this.positionRepository.findByIdWithPair(positionId);
      if (!position) {
        this.emitAutoUnwindEvent(
          event,
          'failed',
          'failed',
          context,
          null,
          null,
          null,
          startTime,
        );
        return;
      }

      // #5 — Only SINGLE_LEG_EXPOSED and EXIT_PARTIAL are eligible.
      //       OPEN is excluded: single-leg only occurs during execution, not exit.
      if (!UNWINDABLE_STATUSES.has(position.status)) {
        this.emitAutoUnwindEvent(
          event,
          'skip_already_resolved',
          'skipped',
          context,
          null,
          null,
          null,
          startTime,
        );
        return;
      }

      // 5. Estimate unwind loss
      // #4 — If order book is unavailable, lossEstimate is null and we proceed
      //       with close (conservative: better to close than hold unbounded risk per FR-EX-07).
      let lossEstimate: LossEstimate | null = null;
      try {
        lossEstimate = await this.estimateCloseLoss(position);
      } catch (error) {
        // Database query failures should NOT proceed — system error
        if (!(error instanceof PlatformApiError)) {
          this.logger.error({
            message: 'Loss estimation failed with system error',
            data: {
              positionId,
              autoUnwindDecision: 'abort_system_error',
              error: error instanceof Error ? error.message : String(error),
            },
          });
          this.emitAutoUnwindEvent(
            event,
            'failed',
            'failed',
            context,
            null,
            null,
            null,
            startTime,
          );
          return;
        }
        // PlatformApiError — proceed with close (conservative)
        this.logger.warn({
          message:
            'Loss estimation failed due to platform API error, proceeding with close without price visibility',
          data: {
            positionId,
            autoUnwindDecision: 'proceed_without_estimate',
            platformError: error.message,
          },
        });
      }

      if (lossEstimate === null) {
        this.logger.warn({
          message:
            'Order book unavailable or empty — proceeding with close without loss estimate (FR-EX-07: close > hold unbounded risk)',
          data: { positionId, autoUnwindDecision: 'proceed_null_estimate' },
        });
      }

      // 6. Check loss threshold
      if (
        lossEstimate &&
        maxLossPct > 0 &&
        lossEstimate.estimatedLossPct > maxLossPct
      ) {
        this.logger.warn({
          message: `Auto-unwind skipped: estimated loss ${lossEstimate.estimatedLossPct.toFixed(2)}% exceeds max ${maxLossPct}%`,
          data: {
            positionId,
            autoUnwindDecision: 'skip_loss_limit',
            estimatedLossPct: lossEstimate.estimatedLossPct,
            maxLossPct,
          },
        });
        this.emitAutoUnwindEvent(
          event,
          'skip_loss_limit',
          'skipped',
          context,
          lossEstimate.estimatedLossPct,
          null,
          null,
          startTime,
        );
        return;
      }

      // 7. Attempt close via existing closeLeg() — reuses all close logic
      let closeResult: CloseLegResult;
      try {
        closeResult = await this.resolutionService.closeLeg(
          positionId,
          'Auto-unwind: second leg failed',
        );
      } catch (error) {
        if (error instanceof ExecutionError) {
          if (error.code === EXECUTION_ERROR_CODES.INVALID_POSITION_STATE) {
            // Operator resolved during close attempt
            this.emitAutoUnwindEvent(
              event,
              'skip_already_resolved',
              'skipped',
              context,
              lossEstimate?.estimatedLossPct ?? null,
              null,
              null,
              startTime,
            );
            return;
          }
          // CLOSE_FAILED or other execution error
          this.emitAutoUnwindEvent(
            event,
            'failed',
            'failed',
            context,
            lossEstimate?.estimatedLossPct ?? null,
            null,
            null,
            startTime,
          );
          return;
        }

        // Non-ExecutionError — log at error level
        this.logger.error({
          message: 'Unexpected error during auto-unwind close',
          data: {
            positionId,
            autoUnwindDecision: 'failed_unexpected',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
        this.emitAutoUnwindEvent(
          event,
          'failed',
          'failed',
          context,
          lossEstimate?.estimatedLossPct ?? null,
          null,
          null,
          startTime,
        );
        return;
      }

      // 8. Close succeeded
      this.emitAutoUnwindEvent(
        event,
        'close',
        'success',
        context,
        lossEstimate?.estimatedLossPct ?? null,
        closeResult.realizedPnl ?? null,
        closeResult.closeOrderId ?? null,
        startTime,
      );
    } catch (error) {
      // Catch-all — async event handler must NEVER crash process
      this.logger.error({
        message: 'Auto-unwind handler unexpected error',
        data: {
          positionId,
          autoUnwindDecision: 'failed_catch_all',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });

      // #10 — Last-resort event emission with stderr fallback
      try {
        this.emitAutoUnwindEvent(
          event,
          'failed',
          'failed',
          this.reconstructContext(event),
          null,
          null,
          null,
          startTime,
        );
      } catch (emitError) {
        // Last resort: write to stderr so the failure is not silent
        this.logger.error({
          message:
            'CRITICAL: Failed to emit AutoUnwindEvent in catch-all handler',
          data: {
            positionId,
            originalError:
              error instanceof Error ? error.message : String(error),
            emitError:
              emitError instanceof Error
                ? emitError.message
                : String(emitError),
          },
        });
      }
    } finally {
      // Always clean up in-flight set
      this.inFlightUnwinds.delete(positionId);
    }
  }

  /**
   * #2 — Atomic-like check+add+capacity guard for in-flight set.
   * Returns true if the position was successfully acquired, false if skipped.
   * Node.js is single-threaded so this is inherently atomic within the event loop,
   * but combining into one method prevents accidental separation of check and add.
   */
  private tryAcquireInFlight(positionId: string): boolean {
    if (this.inFlightUnwinds.has(positionId)) {
      return false;
    }

    if (this.inFlightUnwinds.size >= MAX_IN_FLIGHT) {
      this.logger.warn({
        message: 'In-flight unwind set at max capacity, skipping auto-unwind',
        data: { positionId, maxCapacity: MAX_IN_FLIGHT },
      });
      return false;
    }

    this.inFlightUnwinds.add(positionId);
    return true;
  }

  /**
   * Estimate the loss from closing the filled leg at current market price.
   * Returns null if order book is unavailable or empty — caller decides whether to proceed.
   * #9 — Uses explicit Decimal precision (LOSS_PCT_DECIMAL_PLACES) for financial math.
   */
  private async estimateCloseLoss(position: {
    positionId: string;
    kalshiOrderId: string | null;
    polymarketOrderId: string | null;
    pair: {
      kalshiContractId: string;
      polymarketClobTokenId: string | null;
    } | null;
    kalshiSide: string | null;
    polymarketSide: string | null;
  }): Promise<LossEstimate | null> {
    // Determine filled platform
    const filledPlatform =
      position.kalshiOrderId !== null
        ? PlatformId.KALSHI
        : PlatformId.POLYMARKET;

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
      return null;
    }

    const connector =
      filledPlatform === PlatformId.KALSHI
        ? this.kalshiConnector
        : this.polymarketConnector;

    if (!position.pair) {
      this.logger.warn({
        message: 'Position has no pair relation, cannot estimate close loss',
        data: { positionId: position.positionId },
      });
      return null;
    }

    if (
      filledPlatform === PlatformId.POLYMARKET &&
      !position.pair.polymarketClobTokenId
    ) {
      this.logger.warn({
        message: 'Polymarket clobTokenId is null, cannot estimate close loss',
        data: { positionId: position.positionId },
      });
      return null;
    }

    const contractId =
      filledPlatform === PlatformId.KALSHI
        ? position.pair.kalshiContractId
        : position.pair.polymarketClobTokenId!;

    // Fetch order book — distinguish failure modes
    let orderBook;
    try {
      orderBook = await connector.getOrderBook(asContractId(contractId));
    } catch (error) {
      if (error instanceof PlatformApiError) {
        this.logger.warn({
          message:
            'Order book fetch failed for loss estimation, proceeding with close',
          data: {
            positionId: position.positionId,
            error: error.message,
          },
        });
        return null;
      }
      throw error; // Re-throw non-platform errors (#3: all async errors properly await-ed)
    }

    // Determine close side
    const filledSide =
      filledPlatform === PlatformId.KALSHI
        ? position.kalshiSide
        : position.polymarketSide;
    const closeSide = filledSide === 'buy' ? 'sell' : 'buy';

    // Get close price from opposing side
    let bestPrice: number;
    if (closeSide === 'sell') {
      if (orderBook.bids.length === 0) return null; // Empty book — cannot estimate
      bestPrice = orderBook.bids[0]!.price;
    } else {
      if (orderBook.asks.length === 0) return null; // Empty book — cannot estimate
      bestPrice = orderBook.asks[0]!.price;
    }

    // Calculate estimated loss using decimal.js (#9: explicit precision)
    const entryPrice = new Decimal(filledOrder.fillPrice.toString());
    const closePrice = new Decimal(bestPrice.toString());
    const fillSize = new Decimal(filledOrder.fillSize.toString());

    const loss =
      filledSide === 'buy'
        ? entryPrice.minus(closePrice).mul(fillSize) // bought high, selling low = loss
        : closePrice.minus(entryPrice).mul(fillSize); // sold low, buying back high = loss

    const legValue = entryPrice.mul(fillSize);
    const lossPct = legValue.isZero()
      ? new Decimal(0)
      : loss
          .div(legValue)
          .mul(100)
          .toDecimalPlaces(LOSS_PCT_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);

    return {
      estimatedLossPct: lossPct.toNumber(),
      closePrice,
    };
  }

  /**
   * Reconstruct partial SingleLegContext from SingleLegExposureEvent for audit trail (AC #2).
   * #7 — Branded types require `as string` for plain-object serialization.
   */
  private reconstructContext(
    event: SingleLegExposureEvent,
  ): PartialSingleLegContext {
    return {
      pairId: event.pairId as string,
      primaryLeg: event.filledLeg.platform as string,
      primaryOrderId: event.filledLeg.orderId as string,
      primaryOrder: null,
      primarySide: event.filledLeg.side,
      secondarySide: event.filledLeg.side === 'buy' ? 'sell' : 'buy',
      primaryPrice: String(event.filledLeg.price),
      secondaryPrice: String(event.failedLeg.attemptedPrice),
      primarySize: event.filledLeg.size,
      secondarySize: event.failedLeg.attemptedSize,
      enriched: null,
      opportunity: null,
      errorCode: event.failedLeg.reasonCode,
      errorMessage: event.failedLeg.reason,
      isPaper: event.isPaper,
      mixedMode: event.mixedMode,
    };
  }

  private emitAutoUnwindEvent(
    event: SingleLegExposureEvent,
    action: AutoUnwindEvent['action'],
    result: AutoUnwindEvent['result'],
    context: PartialSingleLegContext,
    estimatedLossPct: number | null,
    realizedPnl: string | null,
    closeOrderId: string | null,
    startTime: number,
  ): void {
    // #1 — `simulated` and `isPaper` both derive from `event.isPaper` intentionally.
    //       simulated = "this close used simulated fills" (paper connector).
    //       isPaper = "this position's mode". They coincide because paper mode
    //       always uses paper connectors. Extracted to named variable for clarity.
    const simulated = event.isPaper;

    this.eventEmitter.emit(
      EVENT_NAMES.AUTO_UNWIND,
      new AutoUnwindEvent(
        asPositionId(event.positionId as string),
        asPairId(event.pairId as string),
        action,
        result,
        context,
        estimatedLossPct,
        realizedPnl,
        closeOrderId,
        Date.now() - startTime,
        simulated,
        event.correlationId,
        event.isPaper,
        event.mixedMode,
      ),
    );
  }
}
