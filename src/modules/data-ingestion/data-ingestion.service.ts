import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PolymarketConnector } from '../../connectors/polymarket/polymarket.connector';
import { PlatformHealthService } from './platform-health.service';
import { PrismaService } from '../../common/prisma.service';
import {
  NormalizedOrderBook,
  PriceLevel,
} from '../../common/types/normalized-order-book.type';
import { PlatformId } from '../../common/types/platform.type';
import { OrderBookUpdatedEvent } from '../../common/events/orderbook.events';
import { SystemHealthError } from '../../common/errors';
import { toPlatformEnum } from '../../common/utils';

/** Placeholder token ID for Polymarket polling - will be replaced by Epic 3 contract pairs */
const POLYMARKET_PLACEHOLDER_TOKEN_ID =
  '110251828161543119357013227499774714771527179764174739487025581227481937033858';

/** Serialize price levels to Prisma JSON: build JsonObject so types align without cast. */
function priceLevelsToJsonArray(levels: PriceLevel[]): Prisma.JsonArray {
  return levels.map((level) => {
    const obj: Prisma.JsonObject = {};
    obj['price'] = level.price;
    obj['quantity'] = level.quantity;
    return obj;
  });
}

@Injectable()
export class DataIngestionService implements OnModuleInit {
  private readonly logger = new Logger(DataIngestionService.name);
  private consecutiveFailures = 0;

  constructor(
    private readonly kalshiConnector: KalshiConnector,
    private readonly polymarketConnector: PolymarketConnector,
    private readonly healthService: PlatformHealthService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Module initialization lifecycle hook.
   * Registers WebSocket callbacks for real-time order book updates from both platforms.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async onModuleInit() {
    const correlationId = randomUUID();

    // Register WebSocket callbacks for real-time updates (already normalized by connectors)

    this.kalshiConnector.onOrderBookUpdate(
      (normalizedBook: NormalizedOrderBook) => {
        // Process asynchronously, don't block WebSocket
        this.processWebSocketUpdate(normalizedBook).catch((error) => {
          this.logger.error({
            message: 'WebSocket update processing failed',
            module: 'data-ingestion',
            correlationId: randomUUID(), // WebSocket callback - new correlation per update
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        });
      },
    );

    this.polymarketConnector.onOrderBookUpdate(
      (normalizedBook: NormalizedOrderBook) => {
        // Process asynchronously, don't block WebSocket
        this.processWebSocketUpdate(normalizedBook).catch((error) => {
          this.logger.error({
            message: 'WebSocket update processing failed',
            module: 'data-ingestion',
            correlationId: randomUUID(), // WebSocket callback - new correlation per update
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        });
      },
    );

    this.logger.log({
      message:
        'DataIngestionService initialized - WebSocket callbacks registered (Kalshi, Polymarket)',
      module: 'data-ingestion',
      correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Polling path called by TradingEngineService during each cycle.
   * Fetches current orderbooks from all connected platforms.
   */
  async ingestCurrentOrderBooks(): Promise<void> {
    const correlationId = randomUUID();

    this.logger.log({
      message: 'Ingesting current order books (polling)',
      module: 'data-ingestion',
      correlationId,
      timestamp: new Date().toISOString(),
    });

    // Ingest Kalshi (isolated try/catch)
    try {
      // For MVP, we'll use a placeholder market ticker
      // In production, this would iterate over configured market tickers
      const kalshiTickers = ['KXTABLETENNIS-26FEB121755MLADPY-MLA']; // Placeholder

      for (const ticker of kalshiTickers) {
        const startTime = Date.now();

        try {
          // Connector returns already normalized data
          const normalized = await this.kalshiConnector.getOrderBook(ticker);

          await this.persistSnapshot(normalized, correlationId);

          this.eventEmitter.emit(
            'orderbook.updated',
            new OrderBookUpdatedEvent(normalized),
          );

          const latency = Date.now() - startTime;
          this.healthService.recordUpdate(PlatformId.KALSHI, latency);

          this.logger.log({
            message: 'Order book ingested (polling)',
            module: 'data-ingestion',
            correlationId,
            timestamp: new Date().toISOString(),
            contractId: normalized.contractId,
            latencyMs: latency,
            metadata: {
              platformId: normalized.platformId,
              bidLevels: normalized.bids.length,
              askLevels: normalized.asks.length,
              bestBid: normalized.bids[0]?.price,
              bestAsk: normalized.asks[0]?.price,
            },
          });
        } catch (error) {
          this.logger.error({
            message: 'Failed to ingest order book',
            module: 'data-ingestion',
            correlationId,
            ticker,
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Kalshi order book ingestion failed',
        module: 'data-ingestion',
        correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }

    // Ingest Polymarket (isolated try/catch)
    try {
      // Placeholder token IDs - these will fail against real API
      // Real token IDs will come from Epic 3 contract pair configuration
      const polymarketTokens = [POLYMARKET_PLACEHOLDER_TOKEN_ID];

      for (const tokenId of polymarketTokens) {
        const startTime = Date.now();

        try {
          // Connector returns already normalized data
          const normalized =
            await this.polymarketConnector.getOrderBook(tokenId);

          await this.persistSnapshot(normalized, correlationId);

          this.eventEmitter.emit(
            'orderbook.updated',
            new OrderBookUpdatedEvent(normalized),
          );

          const latency = Date.now() - startTime;
          this.healthService.recordUpdate(PlatformId.POLYMARKET, latency);

          this.logger.log({
            message: 'Order book ingested (polling)',
            module: 'data-ingestion',
            correlationId,
            timestamp: new Date().toISOString(),
            contractId: normalized.contractId,
            latencyMs: latency,
            metadata: {
              platformId: normalized.platformId,
              bidLevels: normalized.bids.length,
              askLevels: normalized.asks.length,
              bestBid: normalized.bids[0]?.price,
              bestAsk: normalized.asks[0]?.price,
            },
          });
        } catch (error) {
          this.logger.error({
            message: 'Failed to ingest order book',
            module: 'data-ingestion',
            correlationId,
            tokenId,
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Polymarket order book ingestion failed',
        module: 'data-ingestion',
        correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * WebSocket path - processes real-time updates (already normalized by connector).
   * Called by connector's WebSocket callback.
   */
  private async processWebSocketUpdate(
    normalized: NormalizedOrderBook,
  ): Promise<void> {
    const correlationId = randomUUID();
    const startTime = Date.now();

    try {
      // Persist (with error handling, NOT fire-and-forget)
      await this.persistSnapshot(normalized, correlationId);

      // Emit event
      this.eventEmitter.emit(
        'orderbook.updated',
        new OrderBookUpdatedEvent(normalized),
      );

      // Track latency for health monitoring (use platformId from normalized data)
      const latency = Date.now() - startTime;
      this.healthService.recordUpdate(normalized.platformId, latency);

      this.logger.log({
        message: 'Order book normalized (WebSocket)',
        module: 'data-ingestion',
        correlationId,
        timestamp: new Date().toISOString(),
        latencyMs: latency,
        contractId: normalized.contractId,
        metadata: {
          platformId: normalized.platformId,
          bidLevels: normalized.bids.length,
          askLevels: normalized.asks.length,
          bestBid: normalized.bids[0]?.price,
          bestAsk: normalized.asks[0]?.price,
          sequenceNumber: normalized.sequenceNumber,
        },
      });
    } catch (error) {
      this.logger.error({
        message: 'WebSocket order book processing failed',
        module: 'data-ingestion',
        correlationId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
      throw error; // Re-throw to be caught by onModuleInit handler
    }
  }

  /**
   * Persists normalized orderbook snapshot to database.
   * CRITICAL: Awaits persistence, logs errors, tracks failures.
   */
  private async persistSnapshot(
    book: NormalizedOrderBook,
    correlationId?: string,
  ): Promise<void> {
    const cid = correlationId || randomUUID();

    try {
      await this.prisma.orderBookSnapshot.create({
        data: {
          platform: toPlatformEnum(book.platformId),
          contract_id: book.contractId,
          bids: priceLevelsToJsonArray(book.bids),
          asks: priceLevelsToJsonArray(book.asks),
          sequence_number: book.sequenceNumber,
          created_at: new Date(),
        },
      });
      this.consecutiveFailures = 0; // Reset on success
    } catch (error) {
      this.consecutiveFailures++;
      this.logger.error({
        message: 'Snapshot persistence failed',
        module: 'data-ingestion',
        correlationId: cid,
        contractId: book.contractId,
        failures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      });

      // Critical alert after sustained failures
      if (this.consecutiveFailures >= 10) {
        // Throw SystemHealthError which will be caught by global exception filter
        // and routed appropriately (Telegram + audit + potential halt)
        throw new SystemHealthError(
          4005,
          'Persistent snapshot write failure',
          'critical',
          'data-ingestion',
          undefined,
          { consecutiveFailures: this.consecutiveFailures },
        );
      }

      throw error; // Re-throw to let caller handle
    }
  }
}
