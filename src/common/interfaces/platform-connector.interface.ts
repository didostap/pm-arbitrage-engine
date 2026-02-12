import {
  CancelResult,
  FeeSchedule,
  NormalizedOrderBook,
  OrderParams,
  OrderResult,
  PlatformHealth,
  PlatformId,
  Position,
} from '../types/index.js';

/**
 * Platform connector interface — the single abstraction boundary between
 * platform-specific connectors and core arbitrage logic.
 *
 * Every prediction market platform (Kalshi, Polymarket, etc.) implements
 * this interface to provide a unified API surface.
 */
export interface IPlatformConnector {
  /** Submit an order to the platform. */
  submitOrder(params: OrderParams): Promise<OrderResult>;

  /** Cancel an existing order by ID. */
  cancelOrder(orderId: string): Promise<CancelResult>;

  /** Fetch a point-in-time order book snapshot for a contract. */
  getOrderBook(contractId: string): Promise<NormalizedOrderBook>;

  /** Retrieve all open positions on this platform. */
  getPositions(): Promise<Position[]>;

  /** Return current health/connectivity status. */
  getHealth(): PlatformHealth;

  /** Return the platform identifier. */
  getPlatformId(): PlatformId;

  /** Return the platform's fee schedule. */
  getFeeSchedule(): FeeSchedule;

  /** Establish REST and WebSocket connections. */
  connect(): Promise<void>;

  /** Gracefully disconnect all connections. */
  disconnect(): Promise<void>;

  /** Register a callback for real-time order book updates. */
  onOrderBookUpdate(callback: (book: NormalizedOrderBook) => void): void;
}
