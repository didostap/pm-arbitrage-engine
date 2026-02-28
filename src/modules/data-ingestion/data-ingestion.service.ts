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
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { OrderBookUpdatedEvent } from '../../common/events/orderbook.events';
import { SystemHealthError } from '../../common/errors';
import { toPlatformEnum } from '../../common/utils';
import { DegradationProtocolService } from './degradation-protocol.service';
import { ContractPairLoaderService } from '../contract-matching/contract-pair-loader.service';

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
    private readonly degradationService: DegradationProtocolService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly contractPairLoader: ContractPairLoaderService,
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
  /**
   * Retrieves configured tickers from contract pair configuration.
   * Returns empty arrays if no pairs are configured (with warning log).
   */
  private getConfiguredTickers(correlationId: string): {
    kalshiTickers: string[];
    polymarketTokens: string[];
  } {
    const activePairs = this.contractPairLoader.getActivePairs();

    if (activePairs.length === 0) {
      this.logger.warn({
        message:
          'No active contract pairs configured — skipping order book ingestion',
        module: 'data-ingestion',
        correlationId,
        timestamp: new Date().toISOString(),
      });
      return { kalshiTickers: [], polymarketTokens: [] };
    }

    return {
      kalshiTickers: activePairs.map((p) => p.kalshiContractId),
      polymarketTokens: activePairs.map((p) => p.polymarketContractId),
    };
  }

  async ingestCurrentOrderBooks(): Promise<void> {
    const correlationId = randomUUID();

    this.logger.log({
      message: 'Ingesting current order books (polling)',
      module: 'data-ingestion',
      correlationId,
      timestamp: new Date().toISOString(),
    });

    const { kalshiTickers, polymarketTokens } =
      this.getConfiguredTickers(correlationId);

    if (kalshiTickers.length === 0 && polymarketTokens.length === 0) {
      return;
    }

    // Ingest Kalshi (isolated try/catch) — skip if degraded
    if (!this.degradationService.isDegraded(PlatformId.KALSHI)) {
      try {
        for (const ticker of kalshiTickers) {
          const startTime = Date.now();

          try {
            // Connector returns already normalized data
            const normalized = await this.kalshiConnector.getOrderBook(ticker);

            await this.persistSnapshot(normalized, correlationId);

            this.eventEmitter.emit(
              EVENT_NAMES.ORDERBOOK_UPDATED,
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
    } // end Kalshi degradation check

    // Ingest Polymarket (isolated try/catch) — skip if degraded
    if (!this.degradationService.isDegraded(PlatformId.POLYMARKET)) {
      try {
        for (const tokenId of polymarketTokens) {
          const startTime = Date.now();

          try {
            // Connector returns already normalized data
            const normalized =
              await this.polymarketConnector.getOrderBook(tokenId);

            await this.persistSnapshot(normalized, correlationId);

            this.eventEmitter.emit(
              EVENT_NAMES.ORDERBOOK_UPDATED,
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
    } // end Polymarket degradation check

    // Poll degraded platforms via REST fallback
    await this.pollDegradedPlatforms(correlationId);
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
        EVENT_NAMES.ORDERBOOK_UPDATED,
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
   * Polls degraded platforms via REST fallback.
   * Called from ingestCurrentOrderBooks(), NOT a separate cron.
   * Tags data with platformHealth: 'degraded' and tracks polling cycles.
   */
  private async pollDegradedPlatforms(correlationId: string): Promise<void> {
    const { kalshiTickers, polymarketTokens } =
      this.getConfiguredTickers(correlationId);

    const connectors = [
      {
        connector: this.kalshiConnector,
        contracts: kalshiTickers,
        platformId: PlatformId.KALSHI,
      },
      {
        connector: this.polymarketConnector,
        contracts: polymarketTokens,
        platformId: PlatformId.POLYMARKET,
      },
    ];

    for (const { connector, contracts, platformId } of connectors) {
      if (!this.degradationService.isDegraded(platformId)) continue;

      for (const contractId of contracts) {
        try {
          const startTime = Date.now();
          const book = await connector.getOrderBook(contractId);
          book.platformHealth = 'degraded';
          await this.persistSnapshot(book, correlationId);
          this.eventEmitter.emit(
            EVENT_NAMES.ORDERBOOK_UPDATED,
            new OrderBookUpdatedEvent(book),
          );
          const latency = Date.now() - startTime;
          this.healthService.recordUpdate(platformId, latency);
          this.degradationService.incrementPollingCycle(platformId);

          this.logger.log({
            message: 'Order book ingested (degraded polling)',
            module: 'data-ingestion',
            correlationId,
            contractId: book.contractId,
            platformId,
            latencyMs: latency,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          this.logger.error({
            message: 'Degraded polling failed',
            module: 'data-ingestion',
            correlationId,
            platformId,
            contractId,
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          });
          // Log but don't crash — platform is already degraded
        }
      }
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
