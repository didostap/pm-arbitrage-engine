import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Platform, Prisma } from '@prisma/client';
import { KalshiConnector } from '../../connectors/kalshi/kalshi.connector';
import { PlatformHealthService } from './platform-health.service';
import { PrismaService } from '../../common/prisma.service';
import {
  NormalizedOrderBook,
  PriceLevel,
} from '../../common/types/normalized-order-book.type';
import { PlatformId } from '../../common/types/platform.type';
import { OrderBookUpdatedEvent } from '../../common/events/orderbook.events';

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
    private readonly healthService: PlatformHealthService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async onModuleInit() {
    // Register WebSocket callback for real-time updates (already normalized by connector)

    this.kalshiConnector.onOrderBookUpdate(
      (normalizedBook: NormalizedOrderBook) => {
        // Process asynchronously, don't block WebSocket
        this.processWebSocketUpdate(normalizedBook).catch((error) => {
          this.logger.error({
            message: 'WebSocket update processing failed',
            module: 'data-ingestion',
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        });
      },
    );

    this.logger.log({
      message:
        'DataIngestionService initialized - WebSocket callback registered',
      module: 'data-ingestion',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Polling path called by TradingEngineService during each cycle.
   * Fetches current orderbooks from all connected platforms.
   */
  async ingestCurrentOrderBooks(): Promise<void> {
    this.logger.log({
      message: 'Ingesting current order books (polling)',
      module: 'data-ingestion',
      timestamp: new Date().toISOString(),
    });

    try {
      // For MVP, we'll use a placeholder market ticker
      // In production, this would iterate over configured market tickers
      const marketTickers = ['KXTABLETENNIS-26FEB121755MLADPY-MLA']; // Placeholder

      for (const ticker of marketTickers) {
        const startTime = Date.now();

        try {
          // Connector returns already normalized data
          const normalized = await this.kalshiConnector.getOrderBook(ticker);

          await this.persistSnapshot(normalized);

          this.eventEmitter.emit(
            'orderbook.updated',
            new OrderBookUpdatedEvent(normalized),
          );

          const latency = Date.now() - startTime;
          this.healthService.recordUpdate(PlatformId.KALSHI, latency);

          this.logger.log({
            message: 'Order book ingested (polling)',
            module: 'data-ingestion',
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
            ticker,
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Order book ingestion failed',
        module: 'data-ingestion',
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
    const startTime = Date.now();

    try {
      // Persist (with error handling, NOT fire-and-forget)
      await this.persistSnapshot(normalized);

      // Emit event
      this.eventEmitter.emit(
        'orderbook.updated',
        new OrderBookUpdatedEvent(normalized),
      );

      // Track latency for health monitoring
      const latency = Date.now() - startTime;
      this.healthService.recordUpdate(PlatformId.KALSHI, latency);

      this.logger.log({
        message: 'Order book normalized (WebSocket)',
        module: 'data-ingestion',
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
  private async persistSnapshot(book: NormalizedOrderBook): Promise<void> {
    try {
      await this.prisma.orderBookSnapshot.create({
        data: {
          platform: book.platformId.toUpperCase() as Platform, // Convert lowercase to uppercase for DB enum
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
        contractId: book.contractId,
        failures: this.consecutiveFailures,
        error: error instanceof Error ? error.message : 'Unknown',
        timestamp: new Date().toISOString(),
      });

      // Critical alert after sustained failures
      if (this.consecutiveFailures >= 10) {
        this.eventEmitter.emit('system.health.critical', {
          code: 4005,
          message: 'Persistent snapshot write failure',
          severity: 'critical',
        });
      }

      throw error; // Re-throw to let caller handle
    }
  }
}
