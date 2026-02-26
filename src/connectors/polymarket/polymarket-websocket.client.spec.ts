import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolymarketWebSocketClient } from './polymarket-websocket.client.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import { DataStaleEvent } from '../../common/events/platform.events.js';
import type { PolymarketOrderBookMessage } from './polymarket.types.js';

// Mock ws module
vi.mock('ws', () => {
  return {
    default: vi.fn(),
  };
});

describe('PolymarketWebSocketClient', () => {
  let client: PolymarketWebSocketClient;
  let mockEventEmitter: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventEmitter = { emit: vi.fn() };
    client = new PolymarketWebSocketClient({
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      eventEmitter:
        mockEventEmitter as unknown as import('@nestjs/event-emitter').EventEmitter2,
    });
  });

  describe('getConnectionStatus', () => {
    it('should return false when not connected', () => {
      expect(client.getConnectionStatus()).toBe(false);
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should track subscriptions without sending when disconnected', () => {
      client.subscribe('token-123');
      client.subscribe('token-456');
      expect(client.getConnectionStatus()).toBe(false);
    });

    it('should remove subscription on unsubscribe', () => {
      client.subscribe('token-123');
      client.unsubscribe('token-123');
      expect(client.getConnectionStatus()).toBe(false);
    });
  });

  describe('handleMessage - book snapshot', () => {
    it('should parse book snapshot and notify subscribers', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const bookMsg = JSON.stringify({
        event_type: 'book',
        asset_id: 'token-123',
        market: 'market-1',
        timestamp: Date.now(), // Use current time to avoid staleness check
        bids: [
          { price: '0.62', size: '1000' },
          { price: '0.60', size: '500' },
        ],
        asks: [
          { price: '0.65', size: '800' },
          { price: '0.68', size: '300' },
        ],
        hash: 'abc',
      });

      client.handleMessage(bookMsg);

      expect(callback).toHaveBeenCalledTimes(1);
      const rawBook = callback.mock.calls[0]?.[0] as PolymarketOrderBookMessage;
      expect(rawBook.asset_id).toBe('token-123');
      expect(rawBook.timestamp).toBeGreaterThan(0); // Timestamp is Date.now(), just verify it exists
      // Bids sorted descending (as strings)
      expect(rawBook.bids[0]?.price).toBe('0.62');
      expect(rawBook.bids[1]?.price).toBe('0.6');
      // Asks sorted ascending (as strings)
      expect(rawBook.asks[0]?.price).toBe('0.65');
      expect(rawBook.asks[1]?.price).toBe('0.68');
    });

    it('should handle empty book snapshot', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const bookMsg = JSON.stringify({
        event_type: 'book',
        asset_id: 'token-empty',
        market: 'market-1',
        timestamp: Date.now(), // Use current time to avoid staleness check
        bids: [],
        asks: [],
        hash: '',
      });

      client.handleMessage(bookMsg);

      expect(callback).toHaveBeenCalledTimes(1);
      const rawBook = callback.mock.calls[0]?.[0] as PolymarketOrderBookMessage;
      expect(rawBook.bids).toEqual([]);
      expect(rawBook.asks).toEqual([]);
    });
  });

  describe('handleMessage - price_change', () => {
    it('should emit update for tracked token on price_change', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // First send a book snapshot to initialize state
      const bookMsg = JSON.stringify({
        event_type: 'book',
        asset_id: 'token-123',
        market: 'market-1',
        timestamp: Date.now(),
        bids: [{ price: '0.62', size: '1000' }],
        asks: [{ price: '0.65', size: '800' }],
        hash: 'abc',
      });
      client.handleMessage(bookMsg);

      // Then send price_change with price_changes array
      const priceMsg = JSON.stringify({
        event_type: 'price_change',
        market: 'market-1',
        timestamp: String(Date.now() + 1000),
        price_changes: [
          {
            asset_id: 'token-123',
            price: '0.63',
            size: '100',
            side: 'BUY',
            hash: 'xyz',
            best_bid: '0.63',
            best_ask: '0.66',
          },
        ],
      });
      client.handleMessage(priceMsg);

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should update top-of-book prices from best_bid/best_ask', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // Initialize state with book snapshot
      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'token-123',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.62', size: '1000' }],
          asks: [{ price: '0.65', size: '800' }],
          hash: 'abc',
        }),
      );

      // Send price_change with updated best_bid/best_ask
      client.handleMessage(
        JSON.stringify({
          event_type: 'price_change',
          market: 'market-1',
          timestamp: String(Date.now() + 1000),
          price_changes: [
            {
              asset_id: 'token-123',
              price: '0.63',
              size: '50',
              side: 'BUY',
              hash: 'xyz',
              best_bid: '0.64',
              best_ask: '0.67',
            },
          ],
        }),
      );

      expect(callback).toHaveBeenCalledTimes(2);
      const updatedBook = callback.mock.calls[1]?.[0] as {
        bids: Array<{ price: string }>;
        asks: Array<{ price: string }>;
      };
      // Verify top-of-book prices are updated
      expect(updatedBook.bids[0]?.price).toBe('0.64');
      expect(updatedBook.asks[0]?.price).toBe('0.67');
    });

    it('should ignore price_change for untracked token', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const priceMsg = JSON.stringify({
        event_type: 'price_change',
        market: 'market-1',
        timestamp: String(Date.now()),
        price_changes: [
          {
            asset_id: 'unknown-token',
            price: '0.55',
            size: '100',
            side: 'BUY',
            hash: 'xyz',
            best_bid: '0.54',
            best_ask: '0.56',
          },
        ],
      });
      client.handleMessage(priceMsg);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle multiple price_changes entries in one message', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // Initialize two tokens
      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'token-a',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: 'x',
        }),
      );
      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'token-b',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.30', size: '50' }],
          asks: [{ price: '0.35', size: '60' }],
          hash: 'y',
        }),
      );

      // Send price_change affecting both tokens
      client.handleMessage(
        JSON.stringify({
          event_type: 'price_change',
          market: 'market-1',
          timestamp: String(Date.now() + 1000),
          price_changes: [
            {
              asset_id: 'token-a',
              price: '0.51',
              size: '10',
              side: 'BUY',
              hash: 'h1',
              best_bid: '0.51',
              best_ask: '0.54',
            },
            {
              asset_id: 'token-b',
              price: '0.31',
              size: '20',
              side: 'BUY',
              hash: 'h2',
              best_bid: '0.31',
              best_ask: '0.34',
            },
          ],
        }),
      );

      // 2 book snapshots + 2 price_change updates
      expect(callback).toHaveBeenCalledTimes(4);
    });
  });

  describe('handleMessage - array format', () => {
    it('should handle array of messages', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const msgs = JSON.stringify([
        {
          event_type: 'book',
          asset_id: 'token-a',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: 'x',
        },
        {
          event_type: 'book',
          asset_id: 'token-b',
          market: 'market-2',
          timestamp: Date.now(),
          bids: [{ price: '0.30', size: '50' }],
          asks: [{ price: '0.35', size: '60' }],
          hash: 'y',
        },
      ]);

      client.handleMessage(msgs);
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe('handleMessage - invalid data', () => {
    it('should not throw on invalid JSON', () => {
      expect(() => client.handleMessage('not-json{')).not.toThrow();
    });

    it('should ignore unknown event types', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      client.handleMessage(JSON.stringify({ event_type: 'unknown', data: {} }));
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('staleness event emission (AC #4)', () => {
    it('should emit DataStaleEvent when order book data is stale (>30s)', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // Send book with timestamp >30s in the past
      const staleTimestamp = Date.now() - 35000;
      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'stale-token',
          market: 'market-1',
          timestamp: staleTimestamp,
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: '',
        }),
      );

      // Subscriber should NOT be called (stale data discarded)
      expect(callback).not.toHaveBeenCalled();

      // DataStaleEvent should be emitted
      const staleCalls = mockEventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DATA_STALE,
      );
      expect(staleCalls).toHaveLength(1);

      const event = staleCalls[0]![1] as DataStaleEvent;
      expect(event).toBeInstanceOf(DataStaleEvent);
      expect(event.platformId).toBe('polymarket');
      expect(event.tokenId).toBe('stale-token');
      expect(event.stalenessMs).toBeGreaterThanOrEqual(30000);
    });

    it('should NOT emit DataStaleEvent when data is fresh (<30s)', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'fresh-token',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: '',
        }),
      );

      // Subscriber should be called (fresh data)
      expect(callback).toHaveBeenCalledTimes(1);

      // No DataStaleEvent should be emitted
      const staleCalls = mockEventEmitter.emit.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.DATA_STALE,
      );
      expect(staleCalls).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    it('should clear state on disconnect', () => {
      // Simulate some state by handling a message
      const callback = vi.fn();
      client.onUpdate(callback);

      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'token-123',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.50', size: '100' }],
          asks: [],
          hash: '',
        }),
      );

      client.disconnect();
      expect(client.getConnectionStatus()).toBe(false);
    });
  });

  describe('onUpdate', () => {
    it('should notify all registered subscribers', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      client.onUpdate(cb1);
      client.onUpdate(cb2);

      client.handleMessage(
        JSON.stringify({
          event_type: 'book',
          asset_id: 'token-x',
          market: 'market-1',
          timestamp: Date.now(),
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: '',
        }),
      );

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });
});
