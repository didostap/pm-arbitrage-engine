/**
 * Type declarations for kalshi-typescript SDK.
 *
 * The SDK's package.json uses "typings" instead of "types" and lacks
 * an ESM "exports" map, so moduleResolution: "nodenext" cannot resolve
 * its types. This declaration re-exports what we use.
 */
declare module 'kalshi-typescript' {
  export interface ConfigurationParameters {
    apiKey?: string;
    privateKeyPem?: string;
    basePath?: string;
  }

  export class Configuration {
    constructor(params?: ConfigurationParameters);
  }

  export interface Orderbook {
    true?: Array<Array<number>>;
    false?: Array<Array<number>>;
    yes_dollars: Array<Array<string>>;
    no_dollars: Array<Array<string>>;
  }

  export interface GetMarketOrderbookResponse {
    orderbook: Orderbook;
  }

  export class MarketApi {
    constructor(
      configuration?: Configuration,
      basePath?: string,
      axios?: unknown,
    );

    getMarketOrderbook(
      ticker: string,
      depth?: number,
      options?: unknown,
    ): Promise<{ data: GetMarketOrderbookResponse }>;

    createOrder(
      createOrderRequest: CreateOrderRequest,
      options?: unknown,
    ): Promise<{ data: CreateOrderResponse }>;
  }

  export interface CreateOrderRequest {
    ticker: string;
    action: 'buy' | 'sell';
    type: 'limit' | 'market';
    side: 'yes' | 'no';
    count: number;
    yes_price?: number; // cents (1-99)
    no_price?: number; // cents (1-99)
  }

  export interface CreateOrderResponse {
    order: KalshiOrder;
  }

  export interface KalshiOrder {
    order_id: string;
    ticker: string;
    action: string;
    side: string;
    type: string;
    status: string; // 'resting' | 'executed' | 'canceled' | 'pending'
    yes_price: number;
    no_price: number;
    created_time: string;
    expiration_time: string;
    taker_fill_count: number;
    taker_fill_cost: number;
    remaining_count: number;
    place_count: number;
  }
}
