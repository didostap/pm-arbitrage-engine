import { NormalizedOrderBook } from '../types/normalized-order-book.type';
import { BaseEvent } from './base.event';

/**
 * Event emitted when an order book is successfully normalized and persisted.
 * Consumed by arbitrage detection module to trigger opportunity analysis.
 */
export class OrderBookUpdatedEvent extends BaseEvent {
  constructor(
    public readonly orderBook: NormalizedOrderBook,
    correlationId?: string, // Optional - backward compatible
  ) {
    super(correlationId); // Call BaseEvent constructor
  }
}
