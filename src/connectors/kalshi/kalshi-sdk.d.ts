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
    yes_dollars: Array<Array<string>>;
    no_dollars: Array<Array<string>>;
  }

  export interface GetMarketOrderbookResponse {
    orderbook_fp: Orderbook;
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

    getMarket(
      ticker: string,
      options?: unknown,
    ): Promise<{ data: { market: KalshiMarketDetail } }>;
  }

  export interface CreateOrderRequest {
    ticker: string;
    action: 'buy' | 'sell';
    type: 'limit' | 'market';
    side: 'yes' | 'no';
    count: number;
    yes_price_dollars?: string; // dollar string (e.g. "0.42")
    no_price_dollars?: string; // dollar string (e.g. "0.58")
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
    yes_price_dollars: string;
    no_price_dollars: string;
    created_time: string;
    expiration_time: string;
    taker_fill_count_fp: string;
    taker_fill_cost_dollars: string;
    remaining_count_fp: string;
    fill_count_fp: string;
    place_count: number;
  }

  // [Story 8.4] Events API for catalog discovery
  export interface KalshiEvent {
    event_ticker: string;
    title: string;
    category?: string;
    series_ticker?: string;
    markets?: KalshiMarketDetail[];
  }

  export interface KalshiMarketDetail {
    ticker: string;
    event_ticker: string;
    title: string;
    subtitle?: string;
    yes_sub_title?: string;
    no_sub_title?: string;
    status: string;
    expected_expiration_time?: string;
    expiration_time?: string;
    close_time?: string;
    result?: string;
    rules_primary?: string;
  }

  export interface GetEventsResponse {
    events: KalshiEvent[];
    cursor: string;
  }

  export class EventsApi {
    constructor(
      configuration?: Configuration,
      basePath?: string,
      axios?: unknown,
    );

    getEvents(
      limit?: number,
      cursor?: string,
      withNestedMarkets?: boolean,
      withMilestones?: boolean,
      status?: string,
      seriesTicker?: string,
      minCloseTs?: number,
    ): Promise<{ data: GetEventsResponse }>;
  }
}
