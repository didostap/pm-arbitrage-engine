import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolymarketWebSocketClient } from './polymarket-websocket.client.js';
import type { NormalizedOrderBook } from '../../common/types/index.js';

// Mock ws module
vi.mock('ws', () => {
  return {
    default: vi.fn(),
  };
});

describe('PolymarketWebSocketClient', () => {
  let client: PolymarketWebSocketClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PolymarketWebSocketClient({
      wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
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
        timestamp: 1700000000000,
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
      const normalized = callback.mock.calls[0]?.[0] as NormalizedOrderBook;
      expect(normalized.platformId).toBe('polymarket');
      expect(normalized.contractId).toBe('token-123');
      // Bids sorted descending
      expect(normalized.bids[0]?.price).toBe(0.62);
      expect(normalized.bids[1]?.price).toBe(0.6);
      // Asks sorted ascending
      expect(normalized.asks[0]?.price).toBe(0.65);
      expect(normalized.asks[1]?.price).toBe(0.68);
    });

    it('should handle empty book snapshot', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const bookMsg = JSON.stringify({
        event_type: 'book',
        asset_id: 'token-empty',
        market: 'market-1',
        timestamp: 1700000000000,
        bids: [],
        asks: [],
        hash: '',
      });

      client.handleMessage(bookMsg);

      expect(callback).toHaveBeenCalledTimes(1);
      const normalized = callback.mock.calls[0]?.[0] as NormalizedOrderBook;
      expect(normalized.bids).toEqual([]);
      expect(normalized.asks).toEqual([]);
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
        timestamp: 1700000000000,
        bids: [{ price: '0.62', size: '1000' }],
        asks: [{ price: '0.65', size: '800' }],
        hash: 'abc',
      });
      client.handleMessage(bookMsg);

      // Then send price_change
      const priceMsg = JSON.stringify({
        event_type: 'price_change',
        asset_id: 'token-123',
        price: '0.63',
        timestamp: 1700000001000,
      });
      client.handleMessage(priceMsg);

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should ignore price_change for untracked token', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      const priceMsg = JSON.stringify({
        event_type: 'price_change',
        asset_id: 'unknown-token',
        price: '0.55',
        timestamp: 1700000000000,
      });
      client.handleMessage(priceMsg);

      expect(callback).not.toHaveBeenCalled();
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
          timestamp: 1700000000000,
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.55', size: '200' }],
          hash: 'x',
        },
        {
          event_type: 'book',
          asset_id: 'token-b',
          market: 'market-2',
          timestamp: 1700000000000,
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
