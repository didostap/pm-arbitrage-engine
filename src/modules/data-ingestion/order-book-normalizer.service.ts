import Decimal from 'decimal.js';
import { Injectable, Logger } from '@nestjs/common';
import {
  NormalizedOrderBook,
  PriceLevel,
} from '../../common/types/normalized-order-book.type.js';
import { PlatformId } from '../../common/types/platform.type.js';
import { normalizeKalshiLevels } from '../../common/utils/index.js';
import type { KalshiOrderBook } from '../../connectors/kalshi/kalshi-websocket.client';
import type { PolymarketOrderBookMessage } from '../../connectors/polymarket/polymarket.types';

@Injectable()
export class OrderBookNormalizerService {
  private readonly logger = new Logger(OrderBookNormalizerService.name);
  private readonly MAX_LATENCY_SAMPLES = 100; // Rolling window size for P95 calculation
  private latencySamples: number[] = [];

  /**
   * Normalizes Kalshi order book to unified format.
   * Converts cents to decimal, transforms NO bids to YES asks.
   *
   * @param kalshiBook - Raw order book from Kalshi API
   * @returns Normalized order book or null if invalid prices detected
   */
  normalize(kalshiBook: KalshiOrderBook): NormalizedOrderBook | null {
    const startTime = Date.now();

    const { bids, asks } = normalizeKalshiLevels(kalshiBook.yes, kalshiBook.no);

    // Validate all prices in 0-1 range
    const allLevels = [...bids, ...asks];
    for (const level of allLevels) {
      if (level.price < 0 || level.price > 1) {
        this.logger.error({
          message: 'Invalid Kalshi price detected, discarding order book',
          module: 'data-ingestion',
          contractId: kalshiBook.market_ticker,
          price: level.price,
        });
        return null; // Discard book instead of throwing
      }
    }

    // Check for crossed market (best bid > best ask)
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
        spread: new Decimal(bestAsk.price).minus(bestBid.price).toNumber(),
      });
    }

    const latency = Date.now() - startTime;
    this.trackLatency(latency);

    // 6. Log if P95 latency exceeds SLA (500ms at 95th percentile)
    const p95Latency = this.getP95Latency();
    if (p95Latency > 500) {
      this.logger.warn({
        message: 'P95 normalization latency exceeded SLA',
        module: 'data-ingestion',
        p95LatencyMs: p95Latency,
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
   * Normalizes Polymarket order book to unified format.
   * Polymarket prices are already decimal (0.00-1.00), just parse and validate.
   *
   * @param polymarketBook - Raw order book from Polymarket CLOB API
   * @returns Normalized order book or null if invalid prices detected
   */
  normalizePolymarket(
    polymarketBook: PolymarketOrderBookMessage,
  ): NormalizedOrderBook | null {
    const startTime = Date.now();

    // 1. Parse bids (strings to floats) with null/undefined safety
    const bids: PriceLevel[] = (polymarketBook.bids ?? []).map((level) => ({
      price: parseFloat(level.price),
      quantity: parseFloat(level.size),
    }));

    // 2. Parse asks (strings to floats) with null/undefined safety
    const asks: PriceLevel[] = (polymarketBook.asks ?? []).map((level) => ({
      price: parseFloat(level.price),
      quantity: parseFloat(level.size),
    }));

    // 3. Validate all parsed values are valid numbers (catch NaN from malformed data)
    const allLevels = [...bids, ...asks];
    for (const level of allLevels) {
      if (isNaN(level.price) || isNaN(level.quantity)) {
        this.logger.error({
          message:
            'Invalid Polymarket price or quantity (NaN), discarding order book',
          module: 'data-ingestion',
          contractId: polymarketBook.asset_id,
          level,
        });
        return null; // Discard book with malformed numeric data
      }
    }

    // 4. Validate all prices in 0.0-1.0 range
    for (const level of allLevels) {
      if (level.price < 0 || level.price > 1) {
        this.logger.error({
          message: 'Invalid Polymarket price detected, discarding order book',
          module: 'data-ingestion',
          contractId: polymarketBook.asset_id,
          price: level.price,
        });
        return null; // Discard book instead of throwing
      }
    }

    // Check for crossed market (best bid > best ask)
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
        contractId: polymarketBook.asset_id,
        bestBid: bestBid.price,
        bestAsk: bestAsk.price,
        spread: new Decimal(bestAsk.price).minus(bestBid.price).toNumber(),
      });
    }

    // 6. Check for zero-spread market
    if (
      bids.length > 0 &&
      asks.length > 0 &&
      bestBid &&
      bestAsk &&
      bestBid.price === bestAsk.price
    ) {
      this.logger.log({
        message: 'Zero-spread market detected',
        module: 'data-ingestion',
        contractId: polymarketBook.asset_id,
        price: bestBid.price,
      });
    }

    const latency = Date.now() - startTime;
    this.trackLatency(latency);

    // 7. Log if P95 latency exceeds SLA (500ms at 95th percentile)
    const p95Latency = this.getP95Latency();
    if (p95Latency > 500) {
      this.logger.warn({
        message: 'P95 normalization latency exceeded SLA',
        module: 'data-ingestion',
        p95LatencyMs: p95Latency,
        threshold: 500,
        contractId: polymarketBook.asset_id,
      });
    }

    return {
      platformId: PlatformId.POLYMARKET,
      contractId: polymarketBook.asset_id,
      bids,
      asks,
      timestamp: new Date(polymarketBook.timestamp),
      // Polymarket WebSocket doesn't provide sequence tracking (uses hash-based integrity instead)
      sequenceNumber: undefined,
    };
  }

  /**
   * Tracks normalization latency for performance monitoring.
   * Maintains rolling window of samples for P95 calculation.
   */
  private trackLatency(latencyMs: number): void {
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > this.MAX_LATENCY_SAMPLES) {
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
