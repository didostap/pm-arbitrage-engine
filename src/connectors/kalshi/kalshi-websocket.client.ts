import { Logger } from '@nestjs/common';
import { createSign, constants as cryptoConstants } from 'crypto';
import Decimal from 'decimal.js';
import WebSocket from 'ws';
import {
  NormalizedOrderBook,
  PlatformId,
  asContractId,
} from '../../common/types/index.js';
import { RETRY_STRATEGIES } from '../../common/errors/index.js';
import { normalizeKalshiLevels } from '../../common/utils/index.js';
import { parseWsMessage } from '../common/parse-ws-message.js';
import { kalshiWsMessageSchema } from './kalshi-response.schema.js';
import type {
  KalshiOrderbookDeltaMsg,
  KalshiOrderbookSnapshotMsg,
  LocalOrderbookState,
} from './kalshi.types.js';

/** Raw Kalshi order book format (dollar string tuples from fixed-point API) */
export interface KalshiOrderBook {
  market_ticker: string;
  yes: [string, string][]; // [[price_dollars, quantity_fp], ...]
  no: [string, string][]; // [[price_dollars, quantity_fp], ...]
  seq?: number; // Optional sequence number for WebSocket
}

export interface KalshiWebSocketConfig {
  apiKeyId: string;
  privateKeyPem: string;
  wsUrl: string;
}

/** Maximum depth for each side of the local orderbook. Prevents unbounded growth. */
const MAX_ORDERBOOK_DEPTH = 50;

/** Minimum interval between resubscribe requests for the same ticker (ms). */
const RESUBSCRIBE_COOLDOWN_MS = 1_000;

/**
 * WebSocket client for Kalshi real-time orderbook data.
 * Maintains local orderbook state by applying delta updates to snapshots.
 * Reconnects with exponential backoff on disconnect.
 */
export class KalshiWebSocketClient {
  private readonly logger = new Logger(KalshiWebSocketClient.name);
  private ws: WebSocket | null = null;
  /** Cleanup: .delete() on unsub, .clear() on disconnect */
  private orderbookState = new Map<string, LocalOrderbookState>();
  /** Cleanup: .delete() on unsub, .clear() on disconnect */
  private lastSequence = new Map<string, number>();
  private subscribers: Array<(book: NormalizedOrderBook) => void> = [];
  /** Cleanup: .delete() on unsub */
  private subscriptions = new Set<string>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;
  private shouldReconnect = true;
  private commandId = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Cleanup: .delete() on unsub, .clear() on disconnect */
  private lastResubscribeTime = new Map<string, number>();
  private _subscriptionId: number | null = null;
  private _pendingSubscription = false;

  /** Subscription ID from the Kalshi `subscribed` response. Used for update_subscription commands. */
  get subscriptionId(): number | null {
    return this._subscriptionId;
  }

  /** Whether a subscribe() call is in-flight awaiting a `subscribed` response with an sid. */
  get pendingSubscription(): boolean {
    return this._pendingSubscription;
  }

  constructor(private readonly config: KalshiWebSocketConfig) {}

  async connect(): Promise<void> {
    const connectPromise = new Promise<void>((resolve, reject) => {
      try {
        const wsPath = new URL(this.config.wsUrl).pathname;
        const headers = this.generateAuthHeaders('GET', wsPath);

        this.ws = new WebSocket(this.config.wsUrl, { headers });

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempt = 0;
          this.logger.log({
            message: 'WebSocket connected',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
          });

          // Resubscribe to all tickers after reconnect
          for (const ticker of this.subscriptions) {
            this.sendSubscribe(ticker);
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
            platformId: PlatformId.KALSHI,
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
            platformId: PlatformId.KALSHI,
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
    this._subscriptionId = null;
    this._pendingSubscription = false;
    this.orderbookState.clear();
    this.lastSequence.clear();
    this.lastResubscribeTime.clear();
  }

  subscribe(ticker: string): void {
    if (this.subscriptions.has(ticker)) return; // Already tracked, skip duplicate WS command
    this.subscriptions.add(ticker);
    if (this.isConnected) {
      this.sendSubscribe(ticker);
    }
  }

  unsubscribe(ticker: string): void {
    this.subscriptions.delete(ticker);
    this.orderbookState.delete(ticker);
    this.lastSequence.delete(ticker);
    this.lastResubscribeTime.delete(ticker);
    if (this.isConnected && this.ws) {
      this.removeMarkets([ticker]);
    }
  }

  /** Dynamically add markets to the existing orderbook_delta subscription. */
  addMarkets(tickers: string[]): void {
    if (!this.isConnected || !this.ws || this._subscriptionId === null) return;
    this.ws.send(
      JSON.stringify({
        id: ++this.commandId,
        cmd: 'update_subscription',
        params: {
          sids: [this._subscriptionId],
          market_tickers: tickers,
          action: 'add_markets',
        },
      }),
    );
  }

  /** Dynamically remove markets from the existing orderbook_delta subscription. */
  removeMarkets(tickers: string[]): void {
    if (!this.isConnected || !this.ws || this._subscriptionId === null) return;
    this.ws.send(
      JSON.stringify({
        id: ++this.commandId,
        cmd: 'update_subscription',
        params: {
          sids: [this._subscriptionId],
          market_tickers: tickers,
          action: 'delete_markets',
        },
      }),
    );
  }

  onUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.subscribers.push(callback);
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  private sendSubscribe(ticker: string): void {
    if (!this.ws) return;
    this._pendingSubscription = true;
    this.ws.send(
      JSON.stringify({
        id: ++this.commandId,
        cmd: 'subscribe',
        params: {
          channels: ['orderbook_delta'],
          market_ticker: ticker,
        },
      }),
    );
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const raw =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf-8')
            : Buffer.from(data as ArrayBuffer).toString('utf-8');
      const message = parseWsMessage(kalshiWsMessageSchema, JSON.parse(raw), {
        platform: PlatformId.KALSHI,
      });
      if (!message) return;

      switch (message.type) {
        case 'orderbook_snapshot':
          this.handleSnapshot(message.msg as KalshiOrderbookSnapshotMsg);
          break;
        case 'orderbook_delta':
          this.handleDelta(message.msg as KalshiOrderbookDeltaMsg);
          break;
        case 'subscribed':
          this._subscriptionId = message.sid;
          this._pendingSubscription = false;
          this.logger.log({
            message: 'Subscription confirmed',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { sid: message.sid },
          });
          break;
        case 'error':
          this.logger.error({
            message: 'WebSocket server error',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { msg: message.msg },
          });
          break;
        default:
          break;
      }
    } catch {
      this.logger.warn({
        message: 'Failed to parse WebSocket message',
        module: 'connector',
        timestamp: new Date().toISOString(),
      });
    }
  }

  private handleSnapshot(msg: KalshiOrderbookSnapshotMsg): void {
    const state: LocalOrderbookState = {
      seq: msg.seq,
      yes: this.deduplicateLevels([...msg.yes_dollars_fp]),
      no: this.deduplicateLevels([...msg.no_dollars_fp]),
    };
    this.orderbookState.set(msg.market_ticker, state);
    this.lastSequence.set(msg.market_ticker, msg.seq);
    this.emitUpdate(msg.market_ticker, state);
  }

  private handleDelta(msg: KalshiOrderbookDeltaMsg): void {
    const lastSeq = this.lastSequence.get(msg.market_ticker);

    // Sequence gap detection
    if (lastSeq !== undefined && msg.seq !== lastSeq + 1) {
      this.logger.warn({
        message: 'Sequence gap detected, requesting snapshot',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          ticker: msg.market_ticker,
          expected: lastSeq + 1,
          received: msg.seq,
        },
      });
      this.debouncedResubscribe(msg.market_ticker);
      return;
    }

    const state = this.orderbookState.get(msg.market_ticker);
    if (!state) {
      this.debouncedResubscribe(msg.market_ticker);
      return;
    }

    this.applyDelta(state, msg.price_dollars, msg.delta_fp, msg.side);
    state.seq = msg.seq;
    this.lastSequence.set(msg.market_ticker, msg.seq);
    this.emitUpdate(msg.market_ticker, state);
  }

  applyDelta(
    state: LocalOrderbookState,
    priceDollars: string,
    deltaFp: string,
    side: 'yes' | 'no',
  ): void {
    const levels = side === 'yes' ? state.yes : state.no;
    const levelIndex = levels.findIndex(([p]) => p === priceDollars);
    const deltaDecimal = new Decimal(deltaFp);

    if (deltaDecimal.greaterThan(0)) {
      if (levelIndex >= 0) {
        const level = levels[levelIndex];
        if (level) {
          level[1] = new Decimal(level[1]).plus(deltaDecimal).toString();
        }
      } else {
        levels.push([priceDollars, deltaFp]);
        levels.sort((a, b) => new Decimal(b[0]).comparedTo(new Decimal(a[0])));
        if (levels.length > MAX_ORDERBOOK_DEPTH) {
          levels.length = MAX_ORDERBOOK_DEPTH;
        }
      }
    } else if (levelIndex >= 0) {
      const level = levels[levelIndex];
      if (level) {
        level[1] = new Decimal(level[1]).plus(deltaDecimal).toString();
        if (new Decimal(level[1]).lte(0)) {
          levels.splice(levelIndex, 1);
        }
      }
    } else {
      this.logger.debug({
        message: 'Negative delta for non-existent level (ignored)',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: { price: priceDollars, delta: deltaFp, side },
      });
    }
  }

  private emitUpdate(ticker: string, state: LocalOrderbookState): void {
    const { bids, asks } = normalizeKalshiLevels(state.yes, state.no);

    const normalized: NormalizedOrderBook = {
      platformId: PlatformId.KALSHI,
      contractId: asContractId(ticker),
      bids,
      asks,
      timestamp: new Date(),
      sequenceNumber: state.seq,
    };

    for (const sub of this.subscribers) {
      sub(normalized);
    }
  }

  private startPingInterval(): void {
    this.clearPingTimers();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Clear any existing pong timeout to prevent overlapping timeouts.
      // No race condition: Node.js is single-threaded, so clearTimeout + ping + setTimeout
      // execute atomically within this tick — no concurrent handler can interleave.
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
          platformId: PlatformId.KALSHI,
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

  /**
   * Deduplicates price levels, keeping the last occurrence for each price.
   * Guards against malformed snapshots with duplicate price entries.
   */
  private deduplicateLevels(levels: [string, string][]): [string, string][] {
    const seen = new Map<string, [string, string]>();
    for (const level of levels) {
      seen.set(level[0], level);
    }
    return [...seen.values()];
  }

  /**
   * Sends a resubscribe only if the cooldown period has elapsed for this ticker.
   * Prevents rapid-fire resubscribe storms during sequence gap bursts.
   */
  private debouncedResubscribe(ticker: string): void {
    const now = Date.now();
    const lastTime = this.lastResubscribeTime.get(ticker) ?? 0;
    if (now - lastTime < RESUBSCRIBE_COOLDOWN_MS) {
      return;
    }
    this.lastResubscribeTime.set(ticker, now);
    if (this._subscriptionId !== null) {
      this.addMarkets([ticker]);
    } else {
      this.sendSubscribe(ticker);
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
        platformId: PlatformId.KALSHI,
        metadata: { maxRetries, attempts: this.reconnectAttempt },
      });
      return;
    }

    const baseDelay = Math.min(
      initialDelayMs * Math.pow(backoffMultiplier, this.reconnectAttempt),
      maxDelayMs,
    );
    // Add jitter (0.5x–1.5x) to prevent thundering herd
    const delay = Math.min(baseDelay * (0.5 + Math.random()), maxDelayMs);

    this.reconnectAttempt++;

    this.logger.log({
      message: 'Scheduling WebSocket reconnection',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
      metadata: {
        attempt: this.reconnectAttempt,
        delayMs: delay,
      },
    });

    this.reconnectTimer = setTimeout(() => {
      this.orderbookState.clear();
      this.lastSequence.clear();
      this.connect().catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error({
          message: 'WebSocket reconnection failed',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.KALSHI,
          metadata: { error: errMsg, attempt: this.reconnectAttempt },
        });
      });
    }, delay);
  }

  /**
   * Generate RSA-PSS auth headers for WebSocket handshake.
   * Uses Node.js crypto directly since KalshiAuth isn't exported from kalshi-typescript.
   */
  private generateAuthHeaders(
    method: string,
    path: string,
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const message = `${timestamp}${method}${path}`;

    if (!this.config.privateKeyPem) {
      return {
        'KALSHI-ACCESS-KEY': this.config.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': '',
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      };
    }

    const sign = createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign(
      {
        key: this.config.privateKeyPem,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      'base64',
    );

    return {
      'KALSHI-ACCESS-KEY': this.config.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    };
  }
}
