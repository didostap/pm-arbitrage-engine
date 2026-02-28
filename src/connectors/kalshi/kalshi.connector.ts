import Decimal from 'decimal.js';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { Configuration, MarketApi } from 'kalshi-typescript';
import { OrdersApi } from 'kalshi-typescript/dist/api/orders-api.js';
import type { IPlatformConnector } from '../../common/interfaces/index.js';
import type {
  CancelResult,
  FeeSchedule,
  NormalizedOrderBook,
  OrderParams,
  OrderResult,
  OrderStatusResult,
  PlatformHealth,
  Position,
} from '../../common/types/index.js';
import { PlatformId } from '../../common/types/index.js';
import {
  KALSHI_ERROR_CODES,
  PlatformApiError,
  RETRY_STRATEGIES,
} from '../../common/errors/index.js';
import { withRetry, normalizeKalshiLevels } from '../../common/utils/index.js';
import { RateLimiter } from '../../common/utils/rate-limiter.js';
import { KalshiWebSocketClient } from './kalshi-websocket.client.js';

/** Minimal shape of the Kalshi SDK Order returned by GET /portfolio/orders/{order_id}. */
interface KalshiOrderResponse {
  data: {
    order: {
      order_id: string;
      status: string;
      remaining_count: number;
      fill_count: number;
      taker_fill_cost: number;
    };
  };
}

/** Minimal shape of the Kalshi SDK cancel response. */
interface KalshiCancelOrderResponse {
  data: {
    order: {
      order_id: string;
      status: string;
      remaining_count: number;
      fill_count: number;
    };
    reduced_by: number;
  };
}

/** Kalshi SDK OrdersApi — typed locally to avoid unresolvable generic return types. */
interface KalshiOrdersApi {
  getOrder(orderId: string): Promise<KalshiOrderResponse>;
  cancelOrder(orderId: string): Promise<KalshiCancelOrderResponse>;
}

@Injectable()
export class KalshiConnector implements IPlatformConnector, OnModuleDestroy {
  private readonly logger = new Logger(KalshiConnector.name);
  private readonly marketApi: MarketApi;
  private readonly ordersApi: KalshiOrdersApi;
  private readonly wsClient: KalshiWebSocketClient;
  private readonly rateLimiter: RateLimiter;
  private lastHeartbeat: Date | null = null;
  private connected = false;

  constructor(private readonly configService: ConfigService) {
    const apiKeyId = this.configService.get<string>('KALSHI_API_KEY_ID', '');
    const privateKeyPath = this.configService.get<string>(
      'KALSHI_PRIVATE_KEY_PATH',
      '',
    );
    const baseUrl = this.configService.get<string>(
      'KALSHI_API_BASE_URL',
      'https://api.elections.kalshi.com/trade-api/v2',
    );

    let privateKeyPem = '';
    if (privateKeyPath) {
      try {
        privateKeyPem = readFileSync(privateKeyPath, 'utf-8');
      } catch {
        this.logger.warn({
          message: 'Could not read private key file; authentication will fail',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.KALSHI,
          metadata: { path: privateKeyPath },
        });
      }
    }

    const config = new Configuration({
      apiKey: apiKeyId,
      privateKeyPem,
      basePath: baseUrl,
    });

    this.marketApi = new MarketApi(config);
    this.ordersApi = new OrdersApi(
      config as ConstructorParameters<typeof OrdersApi>[0],
    ) as unknown as KalshiOrdersApi;

    this.wsClient = new KalshiWebSocketClient({
      apiKeyId,
      privateKeyPem,
      wsUrl: `${baseUrl.replace('https://', 'wss://')}/trade-api/v2/ws`,
    });

    this.rateLimiter = RateLimiter.fromTier('BASIC', this.logger);
  }

  async connect(): Promise<void> {
    this.logger.log({
      message: 'Connecting to Kalshi',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
    });

    try {
      await this.wsClient.connect();
      this.connected = true;
      this.lastHeartbeat = new Date();

      this.logger.log({
        message: 'Kalshi connection established',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          websocketConnected: true,
        },
      });
    } catch (error) {
      this.connected = false;
      throw this.mapError(error);
    }
  }

  disconnect(): Promise<void> {
    this.logger.log({
      message: 'Disconnecting from Kalshi',
      module: 'connector',
      timestamp: new Date().toISOString(),
      platformId: PlatformId.KALSHI,
    });

    this.wsClient.disconnect();
    this.connected = false;
    return Promise.resolve();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async getOrderBook(contractId: string): Promise<NormalizedOrderBook> {
    await this.rateLimiter.acquireRead();

    try {
      const response = await withRetry(
        () => this.marketApi.getMarketOrderbook(contractId, 10),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying getMarketOrderbook',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { contractId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();
      const orderbook = response.data.orderbook;
      const yesRaw: [number, number][] | undefined = orderbook?.yes as
        | [number, number][]
        | undefined;
      const noRaw: [number, number][] | undefined = orderbook?.no as
        | [number, number][]
        | undefined;

      // Kalshi API returns orderbook.yes / orderbook.no (not true/false)
      const yesBids: [number, number][] = Array.isArray(yesRaw)
        ? yesRaw.map(([p, q]: number[]) => [p ?? 0, q ?? 0])
        : [];
      const noBids: [number, number][] = Array.isArray(noRaw)
        ? noRaw.map(([p, q]: number[]) => [p ?? 0, q ?? 0])
        : [];
      const { bids, asks } = normalizeKalshiLevels(yesBids, noBids);

      return {
        platformId: PlatformId.KALSHI,
        contractId,
        bids,
        asks,
        timestamp: new Date(),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  getPositions(): Promise<Position[]> {
    throw new PlatformApiError(
      KALSHI_ERROR_CODES.NOT_IMPLEMENTED,
      'getPositions not implemented — positions tracked via Prisma OpenPosition model',
      PlatformId.KALSHI,
      'warning',
      undefined,
      { reason: 'unimplemented', plannedEpic: 'Phase 1' },
    );
  }

  async submitOrder(params: OrderParams): Promise<OrderResult> {
    await this.rateLimiter.acquireWrite();

    try {
      // Convert internal decimal price (0.00-1.00) to Kalshi cents (1-99)
      const priceCents = new Decimal(params.price.toString())
        .mul(100)
        .round()
        .toNumber();

      const response = await withRetry(
        () =>
          this.marketApi.createOrder({
            ticker: params.contractId,
            action: params.side,
            type: params.type,
            // Binary markets: always trade the YES side. `action` carries buy/sell intent.
            // Buying YES = long, Selling YES = short (equivalent to inverse NO position).
            side: 'yes',
            count: params.quantity,
            yes_price: priceCents,
          }),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying createOrder',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: {
              contractId: params.contractId,
              attempt,
              error: error.message,
            },
          });
        },
      );

      this.lastHeartbeat = new Date();
      const order = response.data.order;

      // Map Kalshi status to OrderResult status
      let status: OrderResult['status'];
      if (order.status === 'executed') {
        status = order.remaining_count > 0 ? 'partial' : 'filled';
      } else if (order.status === 'canceled') {
        status = 'rejected';
      } else {
        status = 'pending';
      }

      // Convert fill price back from cents to decimal
      const filledQuantity = order.taker_fill_count;
      const filledPrice =
        filledQuantity > 0 && order.taker_fill_cost > 0
          ? new Decimal(order.taker_fill_cost.toString())
              .div(filledQuantity)
              .div(100)
              .toNumber()
          : 0;

      return {
        orderId: order.order_id,
        platformId: PlatformId.KALSHI,
        status,
        filledQuantity,
        filledPrice,
        timestamp: new Date(order.created_time),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async cancelOrder(orderId: string): Promise<CancelResult> {
    if (!this.connected) {
      throw new PlatformApiError(
        KALSHI_ERROR_CODES.INVALID_REQUEST,
        'Kalshi connector not connected',
        PlatformId.KALSHI,
        'error',
      );
    }

    await this.rateLimiter.acquireWrite();

    try {
      const response = await withRetry(
        () => this.ordersApi.cancelOrder(orderId),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying cancelOrder',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { orderId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();
      const order = response.data.order;

      if (order.status === 'canceled') {
        return { orderId, status: 'cancelled' };
      }
      if (order.status === 'executed') {
        return { orderId, status: 'already_filled' };
      }

      // Unexpected status — cancel may not have taken effect
      throw new PlatformApiError(
        KALSHI_ERROR_CODES.INVALID_REQUEST,
        `Unexpected order status after cancel: ${order.status}`,
        PlatformId.KALSHI,
        'warning',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found') || message.includes('404')) {
        return { orderId, status: 'not_found' };
      }
      throw this.mapError(error);
    }
  }

  async getOrder(orderId: string): Promise<OrderStatusResult> {
    if (!this.connected) {
      throw new PlatformApiError(
        KALSHI_ERROR_CODES.INVALID_REQUEST,
        'Kalshi connector not connected',
        PlatformId.KALSHI,
        'error',
      );
    }

    await this.rateLimiter.acquireRead();

    try {
      const response = await withRetry(
        () => this.ordersApi.getOrder(orderId),
        RETRY_STRATEGIES.NETWORK_ERROR,
        (attempt, error) => {
          this.logger.warn({
            message: 'Retrying getOrder',
            module: 'connector',
            timestamp: new Date().toISOString(),
            platformId: PlatformId.KALSHI,
            metadata: { orderId, attempt, error: error.message },
          });
        },
      );

      this.lastHeartbeat = new Date();
      const order = response.data.order;

      let status: OrderStatusResult['status'];
      if (order.status === 'resting') {
        status = 'pending';
      } else if (order.status === 'canceled') {
        status = 'cancelled';
      } else if (order.status === 'executed') {
        status = order.remaining_count > 0 ? 'partial' : 'filled';
      } else {
        status = 'pending';
      }

      const fillCount = order.fill_count;
      const fillPrice =
        fillCount > 0 && order.taker_fill_cost > 0
          ? new Decimal(order.taker_fill_cost.toString())
              .div(fillCount)
              .div(100)
              .toNumber()
          : undefined;

      return {
        orderId: order.order_id,
        status,
        fillPrice,
        fillSize: fillCount > 0 ? fillCount : undefined,
        rawResponse: order,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('not found') || message.includes('404')) {
        return { orderId, status: 'not_found' };
      }
      throw this.mapError(error);
    }
  }

  getHealth(): PlatformHealth {
    const wsConnected = this.wsClient.getConnectionStatus();
    let status: PlatformHealth['status'] = 'disconnected';
    if (this.connected && wsConnected) {
      status = 'healthy';
    } else if (this.connected || wsConnected) {
      status = 'degraded';
    }

    return {
      platformId: PlatformId.KALSHI,
      status,
      lastHeartbeat: this.lastHeartbeat,
      latencyMs: null,
    };
  }

  getPlatformId(): PlatformId {
    return PlatformId.KALSHI;
  }

  getFeeSchedule(): FeeSchedule {
    return {
      platformId: PlatformId.KALSHI,
      makerFeePercent: 0,
      takerFeePercent: 0,
      description: 'Kalshi charges no trading fees for standard contracts',
    };
  }

  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.wsClient.onUpdate(callback);
  }

  subscribeToTicker(ticker: string): void {
    this.wsClient.subscribe(ticker);
  }

  private mapError(error: unknown): PlatformApiError {
    if (error instanceof PlatformApiError) return error;

    const message = error instanceof Error ? error.message : String(error);

    // Map common API error patterns to specific codes
    if (message.includes('UNAUTHORIZED') || message.includes('401')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.UNAUTHORIZED,
        message,
        PlatformId.KALSHI,
        'critical',
      );
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message,
        PlatformId.KALSHI,
        'warning',
        RETRY_STRATEGIES.RATE_LIMIT,
      );
    }
    if (message.includes('not found') || message.includes('404')) {
      return new PlatformApiError(
        KALSHI_ERROR_CODES.MARKET_NOT_FOUND,
        message,
        PlatformId.KALSHI,
        'warning',
      );
    }

    return new PlatformApiError(
      KALSHI_ERROR_CODES.INVALID_REQUEST,
      message,
      PlatformId.KALSHI,
      'error',
    );
  }
}
