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
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { PlatformId } from '../../common/types/platform.type';
import { SingleLegResolutionService } from './single-leg-resolution.service';

const REMINDER_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 55_000;

@Injectable()
export class ExposureAlertScheduler {
  private readonly logger = new Logger(ExposureAlertScheduler.name);
  private readonly lastEmitted = new Map<string, number>();

  constructor(
    private readonly positionRepository: PositionRepository,
    private readonly orderRepository: OrderRepository,
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly eventEmitter: EventEmitter2,
    private readonly resolutionService: SingleLegResolutionService,
  ) {}

  @Interval(REMINDER_INTERVAL_MS)
  async checkExposedPositions(): Promise<void> {
    const positions = await this.positionRepository.findByStatusWithPair({
      in: ['SINGLE_LEG_EXPOSED', 'EXIT_PARTIAL'],
    });

    for (const position of positions) {
      try {
        await this.reEmitForPosition(position);
      } catch (error) {
        this.logger.error({
          message: 'Failed to re-emit exposure alert',
          data: {
            positionId: position.positionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    // Clean up entries for positions no longer exposed
    const activeIds = new Set(positions.map((p) => p.positionId));
    for (const key of this.lastEmitted.keys()) {
      if (!activeIds.has(key)) {
        this.lastEmitted.delete(key);
      }
    }
  }

  private async reEmitForPosition(position: {
    positionId: string;
    pairId: string;
    kalshiOrderId: string | null;
    polymarketOrderId: string | null;
    kalshiSide: string | null;
    polymarketSide: string | null;
    expectedEdge: unknown;
    pair: { kalshiContractId: string; polymarketContractId: string } | null;
  }): Promise<void> {
    // Debounce check
    const now = Date.now();
    const lastEmittedAt = this.lastEmitted.get(position.positionId);
    if (lastEmittedAt && now - lastEmittedAt < DEBOUNCE_MS) {
      return;
    }

    // Skip if either connector is disconnected
    const kalshiHealth = this.kalshiConnector.getHealth();
    const polymarketHealth = this.polymarketConnector.getHealth();
    if (
      kalshiHealth.status === 'disconnected' ||
      polymarketHealth.status === 'disconnected'
    ) {
      this.logger.debug({
        message: 'Skipping re-emission: connector disconnected',
        data: {
          positionId: position.positionId,
          kalshiStatus: kalshiHealth.status,
          polymarketStatus: polymarketHealth.status,
        },
      });
      return;
    }

    if (!position.pair) {
      return;
    }

    // Determine filled/failed legs
    const filledPlatform =
      position.kalshiOrderId !== null
        ? PlatformId.KALSHI
        : PlatformId.POLYMARKET;
    const failedPlatform =
      position.kalshiOrderId === null
        ? PlatformId.KALSHI
        : PlatformId.POLYMARKET;
    const filledSide =
      filledPlatform === PlatformId.KALSHI
        ? position.kalshiSide!
        : position.polymarketSide!;

    // Get filled order for event payload
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
      return;
    }

    // Compute paper/mixed mode from connector health
    const isPaper =
      kalshiHealth.mode === 'paper' || polymarketHealth.mode === 'paper';
    const mixedMode =
      (kalshiHealth.mode === 'paper') !== (polymarketHealth.mode === 'paper');

    const fillPrice = new Decimal(filledOrder.fillPrice.toString()).toNumber();
    const fillSize = new Decimal(filledOrder.fillSize.toString()).toNumber();

    // Delegate P&L scenario building to SingleLegResolutionService
    const { pnlScenarios, recommendedActions, currentPrices } =
      await this.resolutionService.buildPnlScenarios(
        position as Parameters<
          typeof this.resolutionService.buildPnlScenarios
        >[0],
      );

    const expectedEdge = new Decimal(String(position.expectedEdge)).toNumber();

    this.eventEmitter.emit(
      EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER,
      new SingleLegExposureEvent(
        position.positionId,
        position.pairId,
        expectedEdge,
        {
          platform: filledPlatform,
          orderId: filledOrderId,
          side: filledSide,
          price: new Decimal(filledOrder.price.toString()).toNumber(),
          size: new Decimal(filledOrder.size.toString()).toNumber(),
          fillPrice,
          fillSize,
        },
        {
          platform: failedPlatform,
          reason: 'Position remains in SINGLE_LEG_EXPOSED state',
          reasonCode: 2004,
          attemptedPrice: 0,
          attemptedSize: 0,
        },
        currentPrices,
        pnlScenarios,
        recommendedActions,
        undefined,
        isPaper,
        mixedMode,
      ),
    );

    this.lastEmitted.set(position.positionId, now);

    this.logger.debug({
      message: 'Re-emitted exposure alert',
      data: {
        positionId: position.positionId,
        pairId: position.pairId,
      },
    });
  }
}
