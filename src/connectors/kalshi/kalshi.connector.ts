import Decimal from 'decimal.js';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { Configuration, MarketApi } from 'kalshi-typescript';
import { OrdersApi } from 'kalshi-typescript/dist/api/orders-api.js';
import { AccountApi } from 'kalshi-typescript/dist/api/account-api.js';
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
import { PlatformId, asOrderId } from '../../common/types/index.js';
import type { ContractId, OrderId } from '../../common/types/index.js';
import {
  KALSHI_ERROR_CODES,
  PlatformApiError,
  RETRY_STRATEGIES,
} from '../../common/errors/index.js';
import { withRetry, normalizeKalshiLevels } from '../../common/utils/index.js';
import { RateLimiter } from '../../common/utils/rate-limiter.js';
import { KalshiWebSocketClient } from './kalshi-websocket.client.js';
import { parseApiResponse } from '../common/parse-api-response.js';
import {
  kalshiOrderResponseSchema,
  kalshiAccountLimitsResponseSchema,
  kalshiCancelOrderResponseSchema,
} from './kalshi-response.schema.js';

/** Minimal shape of the Kalshi SDK Order returned by GET /portfolio/orders/{order_id}. */
interface KalshiOrderResponse {
  data: {
    order: {
      order_id: string;
      status: string;
      remaining_count_fp: string;
      fill_count_fp: string;
      taker_fill_cost_dollars: string;
    };
  };
}

/** Minimal shape of the Kalshi SDK cancel response. */
interface KalshiCancelOrderResponse {
  data: {
    order: {
      order_id: string;
      status: string;
    };
    reduced_by_fp: string;
  };
}

/** Kalshi SDK OrdersApi — typed locally to avoid unresolvable generic return types. */
interface KalshiOrdersApi {
  getOrder(orderId: string): Promise<KalshiOrderResponse>;
  cancelOrder(orderId: string): Promise<KalshiCancelOrderResponse>;
}

/** Minimal shape of the Kalshi SDK AccountApi response for rate limits. */
interface KalshiAccountApiLimitsResponse {
  data: {
    usage_tier: string;
    read_limit: number;
    write_limit: number;
  };
}

/** Minimal shape of Kalshi SDK AccountApi. */
interface KalshiAccountApi {
  getAccountApiLimits(): Promise<KalshiAccountApiLimitsResponse>;
}

@Injectable()
export class KalshiConnector
  implements IPlatformConnector, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KalshiConnector.name);
  private readonly marketApi: MarketApi;
  private readonly ordersApi: KalshiOrdersApi;
  private readonly accountApi: KalshiAccountApi;
  private readonly wsClient: KalshiWebSocketClient;
  private rateLimiter: RateLimiter;
  private lastHeartbeat: Date | null = null;
  private connected = false;
  private readonly lastWsUpdateMap = new Map<string, Date>();

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
    this.accountApi = new AccountApi(
      config as ConstructorParameters<typeof AccountApi>[0],
    ) as unknown as KalshiAccountApi;

    // Kalshi WS endpoint: .../trade-api/ws/v2 (not .../trade-api/v2/ws)
    const wsUrl = baseUrl
      .replace('https://', 'wss://')
      .replace('/trade-api/v2', '/trade-api/ws/v2');

    this.wsClient = new KalshiWebSocketClient({
      apiKeyId,
      privateKeyPem,
      wsUrl,
    });

    // Track WS update timestamps for freshness queries (Story 10.1)
    this.wsClient.onUpdate((book) => {
      this.lastWsUpdateMap.set(book.contractId as string, new Date());
    });

    // Default rate limiter from tier config; may be upgraded in onModuleInit() via API
    const tier = this.configService.get<string>('KALSHI_API_TIER', 'BASIC');
    this.rateLimiter = RateLimiter.fromTier(tier, this.logger);
  }

  async onModuleInit(): Promise<void> {
    const apiKeyId = this.configService.get<string>('KALSHI_API_KEY_ID', '');
    if (!apiKeyId) {
      this.logger.warn({
        message:
          'KALSHI_API_KEY_ID not configured; Kalshi connector will not connect',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
      });
      return;
    }

    await this.initializeRateLimiterFromApi();

    try {
      await this.connect();
    } catch (error) {
      // Log but don't crash — getHealth() will report degraded/disconnected
      // and the WebSocket client will attempt reconnection automatically
      this.logger.error({
        message:
          'Kalshi initial connection failed; will retry via WebSocket reconnect',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async initializeRateLimiterFromApi(): Promise<void> {
    try {
      const rawResponse = await this.accountApi.getAccountApiLimits();
      const response = parseApiResponse(
        kalshiAccountLimitsResponseSchema,
        rawResponse,
        { platform: PlatformId.KALSHI, operation: 'getAccountApiLimits' },
      );
      const { read_limit, write_limit, usage_tier } = response.data;

      if (
        !read_limit ||
        !write_limit ||
        read_limit <= 0 ||
        write_limit <= 0 ||
        isNaN(read_limit) ||
        isNaN(write_limit)
      ) {
        this.logger.warn({
          message: 'Invalid rate limit data from API; keeping default limiter',
          module: 'connector',
          timestamp: new Date().toISOString(),
          platformId: PlatformId.KALSHI,
          metadata: { read_limit, write_limit, usage_tier },
        });
        return;
      }

      this.rateLimiter = RateLimiter.fromLimits(
        read_limit,
        write_limit,
        this.logger,
      );

      this.logger.log({
        message: 'Rate limiter upgraded from API',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: { usage_tier, read_limit, write_limit },
      });
    } catch (error) {
      this.logger.warn({
        message:
          'Failed to fetch API rate limits; keeping default tier-based limiter',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
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
    this.lastWsUpdateMap.clear();
    this.connected = false;
    return Promise.resolve();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  async getOrderBook(contractId: ContractId): Promise<NormalizedOrderBook> {
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
      const orderbookFp = response.data.orderbook_fp;
      const yesRaw: [string, string][] | undefined =
        orderbookFp?.yes_dollars as [string, string][] | undefined;
      const noRaw: [string, string][] | undefined = orderbookFp?.no_dollars as
        | [string, string][]
        | undefined;

      const yesBids: [string, string][] = Array.isArray(yesRaw) ? yesRaw : [];
      const noBids: [string, string][] = Array.isArray(noRaw) ? noRaw : [];
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
      // Convert internal decimal price (0.00-1.00) to dollar string for Kalshi FP API.
      // ROUND_DOWN: never round a buy price up — conservative for the trader.
      const priceDollars = new Decimal(params.price.toString()).toFixed(
        2,
        Decimal.ROUND_DOWN,
      );

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
            yes_price_dollars: priceDollars,
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
      const validated = parseApiResponse(kalshiOrderResponseSchema, response, {
        platform: PlatformId.KALSHI,
        operation: 'submitOrder',
      });
      const order = validated.data.order;

      // Map Kalshi status to OrderResult status
      const remainingCount = new Decimal(order.remaining_count_fp).toNumber();
      let status: OrderResult['status'];
      if (order.status === 'executed') {
        status = remainingCount > 0 ? 'partial' : 'filled';
      } else if (order.status === 'canceled') {
        status = 'rejected';
      } else {
        status = 'pending';
      }

      // Fill price from dollar-based fields — no /100 conversion needed
      const filledQty = new Decimal(order.taker_fill_count_fp);
      const filledQuantity = filledQty.toNumber();
      const filledPrice = filledQty.greaterThan(0)
        ? new Decimal(order.taker_fill_cost_dollars).div(filledQty).toNumber()
        : 0;

      // created_time passes through via .passthrough()
      const rawOrder = order as Record<string, unknown>;
      return {
        orderId: asOrderId(order.order_id),
        platformId: PlatformId.KALSHI,
        status,
        filledQuantity,
        filledPrice,
        timestamp: new Date(
          (rawOrder['created_time'] as string) ?? new Date().toISOString(),
        ),
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async cancelOrder(orderId: OrderId): Promise<CancelResult> {
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
      const validated = parseApiResponse(
        kalshiCancelOrderResponseSchema,
        response,
        { platform: PlatformId.KALSHI, operation: 'cancelOrder' },
      );
      const order = validated.data.order;

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

  async getOrder(orderId: OrderId): Promise<OrderStatusResult> {
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
      const validated = parseApiResponse(kalshiOrderResponseSchema, response, {
        platform: PlatformId.KALSHI,
        operation: 'getOrder',
      });
      const order = validated.data.order;

      const remainingCount = new Decimal(order.remaining_count_fp).toNumber();
      let status: OrderStatusResult['status'];
      if (order.status === 'resting') {
        status = 'pending';
      } else if (order.status === 'canceled') {
        status = 'cancelled';
      } else if (order.status === 'executed') {
        status = remainingCount > 0 ? 'partial' : 'filled';
      } else {
        status = 'pending';
      }

      const fillQty = new Decimal(order.fill_count_fp);
      const fillCount = fillQty.toNumber();
      const fillPrice = fillQty.greaterThan(0)
        ? new Decimal(order.taker_fill_cost_dollars).div(fillQty).toNumber()
        : undefined;

      return {
        orderId: asOrderId(order.order_id),
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

  /**
   * Returns the effective read rate from the rate limiter.
   * Used by DataIngestionService for polling cycle duration estimation.
   * Note: may reflect initial fromTier() value if called before connect().
   */
  getEffectiveReadRate(): number {
    return this.rateLimiter.getReadRate();
  }

  getFeeSchedule(): FeeSchedule {
    return {
      platformId: PlatformId.KALSHI,
      makerFeePercent: 0,
      takerFeePercent: 1.75,
      description:
        'Kalshi dynamic taker fee: 0.07 × P × (1-P) per contract. ' +
        'takerFeePercent=1.75 is worst-case at P=0.50 ($0.0175/contract = 1.75% of $1.00 notional). ' +
        'takerFeeForPrice returns the fee rate per unit price; total fee = price × rate.',
      // Returns fee *rate* per unit price: consumers compute total = P × rate = P × 0.07 × (1-P).
      takerFeeForPrice: (price: number): number => {
        if (price <= 0 || price >= 1) return 0;
        return new Decimal(0.07).mul(new Decimal(1).minus(price)).toNumber();
      },
    };
  }

  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void {
    this.wsClient.onUpdate(callback);
  }

  subscribeToContracts(contractIds: ContractId[]): void {
    try {
      const tickers = contractIds.map((id) => id as string);
      if (this.wsClient.subscriptionId !== null) {
        // Existing subscription — batch add via update_subscription
        this.wsClient.addMarkets(tickers);
      } else if (!this.wsClient.pendingSubscription) {
        // No subscription and none pending — subscribe to first ticker to establish one
        if (tickers.length > 0) {
          this.wsClient.subscribe(tickers[0]!);
          // Remaining tickers are tracked in wsClient.subscriptions and will be
          // added via debouncedResubscribe on reconnect or picked up on next subscribe call
          for (let i = 1; i < tickers.length; i++) {
            this.wsClient.subscribe(tickers[i]!);
          }
        }
      } else {
        // Subscription pending — just track tickers (they'll be resubscribed on reconnect)
        for (const ticker of tickers) {
          this.wsClient.subscribe(ticker);
        }
      }
    } catch (error) {
      this.logger.error({
        message: 'Failed to subscribe to contracts',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          contractIds,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  unsubscribeFromContracts(contractIds: ContractId[]): void {
    try {
      // unsubscribe() handles both WS message (via removeMarkets if sid set) and local cleanup
      for (const ticker of contractIds) {
        this.wsClient.unsubscribe(ticker as string);
        this.lastWsUpdateMap.delete(ticker as string);
      }
    } catch (error) {
      this.logger.error({
        message: 'Failed to unsubscribe from contracts',
        module: 'connector',
        timestamp: new Date().toISOString(),
        platformId: PlatformId.KALSHI,
        metadata: {
          contractIds,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  getOrderBookFreshness(contractId: ContractId): {
    lastWsUpdateAt: Date | null;
  } {
    const lastUpdate = this.lastWsUpdateMap.get(contractId as string);
    return { lastWsUpdateAt: lastUpdate ?? null };
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
