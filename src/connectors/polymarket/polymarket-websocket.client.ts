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

interface LocalOrderBookState {
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

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

  constructor(private readonly config: PolymarketWebSocketConfig) {
    this.eventEmitter = config.eventEmitter;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
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

          // Resubscribe to all tracked tokens after reconnect
          for (const tokenId of this.subscriptions) {
            this.sendSubscribe(tokenId);
          }

          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
          this.isConnected = false;
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
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
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
  }

  onUpdate(callback: (book: PolymarketOrderBookMessage) => void): void {
    this.subscribers.push(callback);
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  private sendSubscribe(tokenId: string): void {
    if (!this.ws) return;
    this.ws.send(
      JSON.stringify({
        auth: {},
        type: 'subscribe',
        markets: [],
        assets_ids: [tokenId],
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
      this.handleBookSnapshot(msg as unknown as PolymarketOrderBookMessage);
    } else if (eventType === 'price_change') {
      this.handlePriceChange(msg as unknown as PolymarketPriceChangeMessage);
    }
  }

  private handleBookSnapshot(msg: PolymarketOrderBookMessage): void {
    const bids: PriceLevel[] = (msg.bids ?? []).map((b) => ({
      price: parseFloat(b.price),
      quantity: parseFloat(b.size),
    }));
    const asks: PriceLevel[] = (msg.asks ?? []).map((a) => ({
      price: parseFloat(a.price),
      quantity: parseFloat(a.size),
    }));

    // Sort bids descending, asks ascending
    bids.sort((a, b) => new Decimal(b.price).minus(a.price).toNumber());
    asks.sort((a, b) => new Decimal(a.price).minus(b.price).toNumber());

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

      const bestBid = parseFloat(entry.best_bid);
      const bestAsk = parseFloat(entry.best_ask);

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

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const { initialDelayMs, maxDelayMs, backoffMultiplier } =
      RETRY_STRATEGIES.WEBSOCKET_RECONNECT;
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
