import Decimal from 'decimal.js';
import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import WebSocket from 'ws';
import { PlatformId, PriceLevel } from '../../common/types/index.js';
import { RETRY_STRATEGIES } from '../../common/errors/index.js';
import { DataStaleEvent } from '../../common/events/platform.events.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import type {
  PolymarketOrderBookMessage,
  PolymarketPriceChangeMessage,
  PolymarketWebSocketConfig,
} from './polymarket.types.js';
import { parseWsMessage } from '../common/parse-ws-message.js';
import {
  polymarketOrderBookMsgSchema,
  polymarketPriceChangeMsgSchema,
} from './polymarket-response.schema.js';

interface LocalOrderBookState {
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

/** Maximum depth for each side of the local orderbook. Prevents unbounded growth. */
const MAX_ORDERBOOK_DEPTH = 50;

/**
 * WebSocket client for Polymarket real-time market data.
 * Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribes to `book` (full snapshots) and `price_change` (best bid/ask updates).
 * Reconnects with exponential backoff on disconnect.
 */
export class PolymarketWebSocketClient {
  private readonly logger = new Logger(PolymarketWebSocketClient.name);
  private readonly eventEmitter: EventEmitter2;
  private ws: WebSocket | null = null;
  private orderbookState = new Map<string, LocalOrderBookState>();
  private subscribers: Array<(book: PolymarketOrderBookMessage) => void> = [];
  private subscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private hasInitialSubscription = false;

  constructor(private readonly config: PolymarketWebSocketConfig) {
    this.eventEmitter = config.eventEmitter;
  }

  async connect(): Promise<void> {
    const connectPromise = new Promise<void>((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempt = 0;
          this.logger.log({
            message: 'WebSocket connected',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
          });

          // Resubscribe to all tracked tokens after (re)connect
          this.hasInitialSubscription = false;
          if (this.subscriptions.size > 0) {
            this.sendInitialSubscription([...this.subscriptions]);
          }

          // Start keepalive ping interval
          this.startPingInterval();

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('pong', () => {
          if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
          }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.isConnected = false;
          this.clearPingTimers();
          this.logger.warn({
            message: 'WebSocket disconnected',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
            metadata: { code, reason: reason.toString() },
          });
          this.scheduleReconnect();
        });

        this.ws.on('error', (error: Error) => {
          this.clearPingTimers();
          this.logger.error({
            message: 'WebSocket error',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.POLYMARKET,
            metadata: { error: error.message },
          });
          if (!this.isConnected) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('WebSocket connect timeout (10s)'));
      }, 10_000);
    });

    return Promise.race([connectPromise, timeoutPromise]);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearPingTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.hasInitialSubscription = false;
    this.orderbookState.clear();
  }

  subscribe(tokenId: string): void {
    this.subscriptions.add(tokenId);
    if (this.isConnected) {
      this.sendSubscribe(tokenId);
    }
  }

  unsubscribe(tokenId: string): void {
    this.subscriptions.delete(tokenId);
    this.orderbookState.delete(tokenId);
    if (this.isConnected && this.ws) {
      this.ws.send(
        JSON.stringify({
          assets_ids: [tokenId],
          operation: 'unsubscribe',
        }),
      );
    }
  }

  onUpdate(callback: (book: PolymarketOrderBookMessage) => void): void {
    this.subscribers.push(callback);
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /** Send initial subscription message (first subscription after connect). */
  private sendInitialSubscription(tokenIds: string[]): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: 'market',
        assets_ids: tokenIds,
        custom_feature_enabled: true,
      }),
    );
    this.hasInitialSubscription = true;
  }

  /** Send dynamic subscribe for a single token (after initial subscription). */
  private sendSubscribe(tokenId: string): void {
    if (!this.ws) return;
    if (!this.hasInitialSubscription) {
      this.sendInitialSubscription([tokenId]);
      return;
    }
    this.ws.send(
      JSON.stringify({
        assets_ids: [tokenId],
        operation: 'subscribe',
      }),
    );
  }

  handleMessage(data: WebSocket.Data): void {
    try {
      const raw =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf-8')
            : Buffer.from(data as ArrayBuffer).toString('utf-8');
      const messages = JSON.parse(raw) as unknown[];

      if (Array.isArray(messages)) {
        for (const msg of messages) {
          this.processMessage(msg as Record<string, unknown>);
        }
      } else {
        this.processMessage(messages as unknown as Record<string, unknown>);
      }
    } catch {
      this.logger.warn({
        message: 'Failed to parse WebSocket message',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
      });
    }
  }

  private processMessage(msg: Record<string, unknown>): void {
    const eventType = msg['event_type'] as string | undefined;

    if (eventType === 'book') {
      const validated = parseWsMessage(polymarketOrderBookMsgSchema, msg, {
        platform: PlatformId.POLYMARKET,
      });
      if (validated) this.handleBookSnapshot(validated);
    } else if (eventType === 'price_change') {
      const validated = parseWsMessage(polymarketPriceChangeMsgSchema, msg, {
        platform: PlatformId.POLYMARKET,
      });
      if (validated) this.handlePriceChange(validated);
    }
  }

  private handleBookSnapshot(msg: PolymarketOrderBookMessage): void {
    const dedupedBids = this.deduplicateLevels(msg.bids ?? []);
    const dedupedAsks = this.deduplicateLevels(msg.asks ?? []);

    const bids: PriceLevel[] = dedupedBids.map((b) => ({
      price: new Decimal(b.price).toNumber(),
      quantity: new Decimal(b.size).toNumber(),
    }));
    const asks: PriceLevel[] = dedupedAsks.map((a) => ({
      price: new Decimal(a.price).toNumber(),
      quantity: new Decimal(a.size).toNumber(),
    }));

    // Sort bids descending, asks ascending
    bids.sort((a, b) => new Decimal(b.price).comparedTo(a.price));
    asks.sort((a, b) => new Decimal(a.price).comparedTo(b.price));

    if (bids.length > MAX_ORDERBOOK_DEPTH) bids.length = MAX_ORDERBOOK_DEPTH;
    if (asks.length > MAX_ORDERBOOK_DEPTH) asks.length = MAX_ORDERBOOK_DEPTH;

    const state: LocalOrderBookState = {
      bids,
      asks,
      timestamp: msg.timestamp ?? Date.now(),
    };

    this.orderbookState.set(msg.asset_id, state);
    this.emitUpdate(msg.asset_id, state);
  }

  private handlePriceChange(msg: PolymarketPriceChangeMessage): void {
    const changes = msg.price_changes;
    if (!Array.isArray(changes)) return;

    const msgTimestamp = parseInt(String(msg.timestamp), 10) || Date.now();

    for (const entry of changes) {
      const state = this.orderbookState.get(entry.asset_id);
      if (!state) continue;

      // Skip price updates if no book snapshot received yet — we have no
      // quantity data, so emitting would produce misleading zero-liquidity levels.
      if (state.bids.length === 0 && state.asks.length === 0) continue;

      const bestBid = new Decimal(entry.best_bid).toNumber();
      const bestAsk = new Decimal(entry.best_ask).toNumber();

      // Update top-of-book from best_bid/best_ask
      if (!isNaN(bestBid) && state.bids.length > 0 && state.bids[0]) {
        state.bids[0].price = bestBid;
      }
      if (!isNaN(bestAsk) && state.asks.length > 0 && state.asks[0]) {
        state.asks[0].price = bestAsk;
      }

      state.timestamp = msgTimestamp;
      this.emitUpdate(entry.asset_id, state);
    }
  }

  private emitUpdate(tokenId: string, state: LocalOrderBookState): void {
    const staleness = Date.now() - state.timestamp;
    if (staleness > 30000) {
      this.logger.error({
        message: 'Order book data too stale, discarding',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
        metadata: { tokenId, stalenessMs: staleness },
      });
      this.eventEmitter.emit(
        EVENT_NAMES.DATA_STALE,
        new DataStaleEvent(PlatformId.POLYMARKET, tokenId, staleness),
      );
      return; // Don't emit stale data (defensive: prevents trading on old prices)
    }

    // Emit raw platform data (connector will normalize)
    const rawBook: PolymarketOrderBookMessage = {
      asset_id: tokenId,
      market: '', // Not needed for normalization
      timestamp: state.timestamp,
      bids: state.bids.map((level) => ({
        price: level.price.toString(),
        size: level.quantity.toString(),
      })),
      asks: state.asks.map((level) => ({
        price: level.price.toString(),
        size: level.quantity.toString(),
      })),
      hash: '', // Not needed for normalization
    };

    for (const sub of this.subscribers) {
      sub(rawBook);
    }
  }

  /**
   * Deduplicates price levels, keeping the last occurrence for each price.
   * Guards against malformed snapshots with duplicate price entries.
   */
  private deduplicateLevels(
    levels: Array<{ price: string; size: string }>,
  ): Array<{ price: string; size: string }> {
    const seen = new Map<string, { price: string; size: string }>();
    for (const level of levels) {
      seen.set(level.price, level);
    }
    return [...seen.values()];
  }

  private startPingInterval(): void {
    this.clearPingTimers();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Clear any existing pong timeout to prevent overlapping timeouts
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
      this.ws.ping();
      this.pongTimeout = setTimeout(() => {
        this.logger.warn({
          message: 'Pong timeout — forcing reconnect',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.POLYMARKET,
        });
        this.ws?.terminate();
      }, 10_000);
    }, 30_000);
  }

  private clearPingTimers(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const { initialDelayMs, maxDelayMs, backoffMultiplier, maxRetries } =
      RETRY_STRATEGIES.WEBSOCKET_RECONNECT;

    if (this.reconnectAttempt >= maxRetries) {
      this.logger.error({
        message: 'Max reconnect attempts reached — giving up',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.POLYMARKET,
        metadata: { maxRetries, attempts: this.reconnectAttempt },
      });
      return;
    }

    const baseDelay = Math.min(
      initialDelayMs * Math.pow(backoffMultiplier, this.reconnectAttempt),
      maxDelayMs,
    );
    const delay = Math.min(baseDelay * (0.5 + Math.random()), maxDelayMs);

    this.reconnectAttempt++;

    this.logger.log({
      message: 'Scheduling WebSocket reconnection',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.POLYMARKET,
      metadata: {
        attempt: this.reconnectAttempt,
        delayMs: delay,
      },
    });

    this.reconnectTimer = setTimeout(() => {
      this.orderbookState.clear();
      this.connect().catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({
          message: 'WebSocket reconnection failed',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.POLYMARKET,
          metadata: { error: errMsg, attempt: this.reconnectAttempt },
        });
      });
    }, delay);
  }
}
