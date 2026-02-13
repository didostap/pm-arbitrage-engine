import { Injectable, Logger } from '@nestjs/common';
import {
  NormalizedOrderBook,
  PriceLevel,
} from '../../common/types/normalized-order-book.type';
import { PlatformId } from '../../common/types/platform.type';
import { PlatformApiError } from '../../common/errors/platform-api-error';
import type { KalshiOrderBook } from '../../connectors/kalshi/kalshi-websocket.client';

@Injectable()
export class OrderBookNormalizerService {
  private readonly logger = new Logger(OrderBookNormalizerService.name);
  private latencySamples: number[] = [];

  /**
   * Normalizes Kalshi order book to unified format.
   * Converts cents to decimal, transforms NO bids to YES asks.
   *
   * @param kalshiBook - Raw order book from Kalshi API
   * @returns Normalized order book with prices in 0.00-1.00 range
   * @throws PlatformApiError if prices are outside valid range
   */
  normalize(kalshiBook: KalshiOrderBook): NormalizedOrderBook {
    const startTime = Date.now();

    // 1. Transform YES bids (already in correct format)
    const bids: PriceLevel[] = kalshiBook.yes.map(([priceCents, qty]) => ({
      price: priceCents / 100, // 60¢ → 0.60
      quantity: qty,
    }));

    // 2. Transform NO bids to YES asks
    // NO bid at 35¢ = someone will sell YES at 65¢ (1 - 0.35)
    const asks: PriceLevel[] = kalshiBook.no.map(([priceCents, qty]) => ({
      price: 1 - priceCents / 100, // NO 35¢ → YES ask 0.65
      quantity: qty,
    }));

    // 3. Sort asks ascending (lowest ask first)
    asks.sort((a, b) => a.price - b.price);

    // 4. Validate all prices in 0-1 range
    const allLevels = [...bids, ...asks];
    for (const level of allLevels) {
      if (level.price < 0 || level.price > 1) {
        throw new PlatformApiError(
          1007, // Schema Change
          `Invalid price outside 0-1 range: ${level.price}`,
          PlatformId.KALSHI,
          'error',
        );
      }
    }

    // 5. Check for crossed market (best bid > best ask)
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (
      bids.length > 0 &&
      asks.length > 0 &&
      bestBid &&
      bestAsk &&
      bestBid.price > bestAsk.price
    ) {
      this.logger.warn({
        message: 'Crossed market detected',
        module: 'data-ingestion',
        contractId: kalshiBook.market_ticker,
        bestBid: bestBid.price,
        bestAsk: bestAsk.price,
        spread: bestAsk.price - bestBid.price,
      });
    }

    const latency = Date.now() - startTime;
    this.trackLatency(latency);

    // 6. Log if latency exceeds SLA (500ms at 95th percentile)
    if (latency > 500) {
      this.logger.warn({
        message: 'Normalization latency exceeded SLA',
        module: 'data-ingestion',
        latencyMs: latency,
        threshold: 500,
        contractId: kalshiBook.market_ticker,
      });
    }

    return {
      platformId: PlatformId.KALSHI,
      contractId: kalshiBook.market_ticker,
      bids,
      asks,
      timestamp: new Date(),
      sequenceNumber: kalshiBook.seq, // From WebSocket delta tracking
    };
  }

  /**
   * Tracks normalization latency for performance monitoring.
   * Maintains rolling window of last 100 samples.
   */
  private trackLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > 100) {
      this.latencySamples.shift();
    }
  }

  /**
   * Calculates 95th percentile latency from tracked samples.
   * Used for performance monitoring and health checks.
   */
  getP95Latency(): number {
    if (this.latencySamples.length === 0) return 0;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    return sorted[p95Index] || 0;
  }
}
