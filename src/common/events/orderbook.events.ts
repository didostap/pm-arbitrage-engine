import { NormalizedOrderBook } from '../types/normalized-order-book.type';

/**
 * Event emitted when an order book is successfully normalized and persisted.
 * Consumed by arbitrage detection module to trigger opportunity analysis.
 */
export class OrderBookUpdatedEvent {
  constructor(public readonly orderBook: NormalizedOrderBook) {}
}
