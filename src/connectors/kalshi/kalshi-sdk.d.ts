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
  }
}
