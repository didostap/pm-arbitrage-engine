import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';

import {
  KALSHI_CONNECTOR_TOKEN,
  POLYMARKET_CONNECTOR_TOKEN,
} from '../../connectors/connector.constants';
import type { IPlatformConnector } from '../../common/interfaces/platform-connector.interface';
import { PlatformId, asContractId } from '../../common/types';
import { calculateVwapClosePrice } from '../../common/utils';

/** Data source classification: stale_fallback > polling > websocket (where > = worse). */
export type DataSource = 'websocket' | 'polling' | 'stale_fallback';

@Injectable()
export class ExitDataSourceService {
  private wsStalenessThresholdMs: number;
  private exitDepthSlippageTolerance: number;

  constructor(
    @Inject(KALSHI_CONNECTOR_TOKEN)
    private readonly kalshiConnector: IPlatformConnector,
    @Inject(POLYMARKET_CONNECTOR_TOKEN)
    private readonly polymarketConnector: IPlatformConnector,
    private readonly configService: ConfigService,
  ) {
    this.wsStalenessThresholdMs = this.configService.get<number>(
      'WS_STALENESS_THRESHOLD_MS',
      60_000,
    );
    this.exitDepthSlippageTolerance = this.configService.get<number>(
      'EXIT_DEPTH_SLIPPAGE_TOLERANCE',
      0.02,
    );
  }

  reloadConfig(settings: {
    wsStalenessThresholdMs?: number;
    exitDepthSlippageTolerance?: number;
  }): void {
    if (settings.wsStalenessThresholdMs !== undefined)
      this.wsStalenessThresholdMs = settings.wsStalenessThresholdMs;
    if (settings.exitDepthSlippageTolerance !== undefined)
      this.exitDepthSlippageTolerance = settings.exitDepthSlippageTolerance;
  }

  /** Resolve connector by platform ID. */
  resolveConnector(platform: PlatformId): IPlatformConnector {
    return platform === PlatformId.KALSHI
      ? this.kalshiConnector
      : this.polymarketConnector;
  }

  /** Get connector health for a specific platform. */
  getConnectorHealth(
    platform: PlatformId,
  ): ReturnType<IPlatformConnector['getHealth']> {
    return this.resolveConnector(platform).getHealth();
  }

  /** Get order book freshness for a specific platform/contract. */
  getOrderBookFreshness(
    platform: PlatformId,
    contractId: string,
  ): ReturnType<IPlatformConnector['getOrderBookFreshness']> {
    return this.resolveConnector(platform).getOrderBookFreshness(
      asContractId(contractId),
    );
  }

  /** Get fee schedule for a specific platform. */
  getFeeSchedule(
    platform: PlatformId,
  ): ReturnType<IPlatformConnector['getFeeSchedule']> {
    return this.resolveConnector(platform).getFeeSchedule();
  }

  /** Classify a single platform's data source based on WS freshness. */
  classifyDataSource(lastWsUpdateAt: Date | null, now: Date): DataSource {
    if (lastWsUpdateAt === null) return 'polling';
    const age = now.getTime() - lastWsUpdateAt.getTime();
    return age >= this.wsStalenessThresholdMs ? 'stale_fallback' : 'websocket';
  }

  /** Combine two platform data sources using worst-of-two precedence. */
  combineDataSources(a: DataSource, b: DataSource): DataSource {
    const precedence: Record<DataSource, number> = {
      websocket: 0,
      polling: 1,
      stale_fallback: 2,
    };
    return precedence[a] >= precedence[b] ? a : b;
  }

  /**
   * Get close price for a position on a specific platform.
   * Without positionSize: top-of-book. With positionSize: VWAP.
   */
  async getClosePrice(
    platform: PlatformId,
    contractId: string,
    originalSide: string,
    positionSize?: Decimal,
  ): Promise<Decimal | null> {
    const connector = this.resolveConnector(platform);
    const orderBook = await connector.getOrderBook(asContractId(contractId));
    const levels = originalSide === 'buy' ? orderBook.bids : orderBook.asks;

    if (levels.length === 0) return null;

    // Without positionSize: top-of-book (backward compatible)
    if (!positionSize) {
      return new Decimal(levels[0]!.price);
    }

    // With positionSize: delegate to shared VWAP function
    return calculateVwapClosePrice(
      orderBook,
      originalSide as 'buy' | 'sell',
      positionSize,
    );
  }

  /**
   * Calculate available depth at close price (with slippage tolerance) for exit sizing.
   * Uses internally configured exitDepthSlippageTolerance.
   *
   * Buy-close: includes asks ≤ closePrice × (1 + tolerance).
   * Sell-close: includes bids ≥ closePrice × (1 - tolerance).
   */
  async getAvailableExitDepth(
    platform: PlatformId,
    contractId: string,
    closeSide: 'buy' | 'sell',
    closePrice: Decimal,
  ): Promise<Decimal> {
    const connector = this.resolveConnector(platform);
    const book = await connector.getOrderBook(asContractId(contractId));
    // Close side buy → consume asks at closePrice or lower
    // Close side sell → consume bids at closePrice or higher
    // D4: Defensive sort — connectors sort best-to-worst, but the type has no compile-time guarantee
    const levels =
      closeSide === 'buy'
        ? [...book.asks].sort((a, b) => a.price - b.price) // asks: lowest first
        : [...book.bids].sort((a, b) => b.price - a.price); // bids: highest first

    // Apply slippage tolerance band (Story 10-7-3)
    // Buy-close (asks): accept prices up to closePrice × (1 + tolerance)
    // Sell-close (bids): accept prices down to closePrice × (1 - tolerance)
    const toleranceFraction =
      closeSide === 'buy'
        ? new Decimal(1).plus(this.exitDepthSlippageTolerance)
        : new Decimal(1).minus(this.exitDepthSlippageTolerance);
    const adjustedCutoff = closePrice.mul(toleranceFraction);

    let depth = new Decimal(0);
    for (const level of levels) {
      const levelPrice = new Decimal(level.price);
      const priceOk =
        closeSide === 'buy'
          ? levelPrice.lte(adjustedCutoff)
          : levelPrice.gte(adjustedCutoff);
      if (priceOk) {
        if (level.quantity > 0) {
          depth = depth.plus(level.quantity);
        }
      } else if (depth.gt(0)) {
        // Sorted book: once a level fails after qualifying levels, all subsequent fail too
        break;
      }
    }
    return depth;
  }
}
