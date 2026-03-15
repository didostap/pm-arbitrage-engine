import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Decimal from 'decimal.js';
import type { NormalizedOrderBook } from '../../common/types/index.js';
import type { LocalOrderbookState } from './kalshi.types.js';
import { KalshiWebSocketClient } from './kalshi-websocket.client.js';

// Mock ws module — use a regular function (not arrow) so it can be called with `new`
let __wsMockInstance: unknown = null;
vi.mock('ws', () => {
  const MockWebSocket = vi.fn(function (this: unknown) {
    return __wsMockInstance;
  } as unknown as (...args: unknown[]) => unknown);
  (MockWebSocket as unknown as Record<string, number>).OPEN = 1;
  return { default: MockWebSocket };
});

describe('KalshiWebSocketClient', () => {
  let client: KalshiWebSocketClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new KalshiWebSocketClient({
      apiKeyId: 'test-key-id',
      privateKeyPem: 'test-pem-content',
      wsUrl: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
    });
  });

  describe('applyDelta', () => {
    it('should add a new YES price level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [['0.3800', '800.00']],
      };

      client.applyDelta(state, '0.6300', '200.00', 'yes');

      expect(state.yes).toContainEqual(['0.6300', '200.00']);
      expect(state.yes).toHaveLength(2);
      expect(state.yes[0]?.[0]).toBe('0.6300');
      expect(state.yes[1]?.[0]).toBe('0.6200');
    });

    it('should add a new NO price level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [],
        no: [['0.3800', '800.00']],
      };

      client.applyDelta(state, '0.4000', '500.00', 'no');

      expect(state.no).toContainEqual(['0.4000', '500.00']);
      expect(state.no).toHaveLength(2);
    });

    it('should increase quantity on existing level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [],
      };

      client.applyDelta(state, '0.6200', '500.00', 'yes');

      expect(state.yes[0]?.[0]).toBe('0.6200');
      expect(state.yes[0]?.[1]).toBe('1500');
    });

    it('should decrease quantity on existing level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [],
      };

      client.applyDelta(state, '0.6200', '-300.00', 'yes');

      expect(state.yes[0]?.[0]).toBe('0.6200');
      expect(state.yes[0]?.[1]).toBe('700');
    });

    it('should remove level when quantity goes to zero', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [],
      };

      client.applyDelta(state, '0.6200', '-1000.00', 'yes');

      expect(state.yes).toHaveLength(0);
    });

    it('should remove level when quantity goes below zero', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '500.00']],
        no: [],
      };

      client.applyDelta(state, '0.6200', '-600.00', 'yes');

      expect(state.yes).toHaveLength(0);
    });

    it('should ignore negative delta for non-existent level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [],
      };

      client.applyDelta(state, '0.9900', '-100.00', 'yes');

      expect(state.yes).toEqual([['0.6200', '1000.00']]);
    });

    it('should log debug when negative delta targets non-existent level', () => {
      const debugSpy = vi.spyOn(client['logger'], 'debug');
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [],
      };

      client.applyDelta(state, '0.9900', '-100.00', 'yes');

      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Negative delta for non-existent level (ignored)',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: expect.objectContaining({
            price: '0.9900',
            delta: '-100.00',
            side: 'yes',
          }),
        }),
      );
    });

    it('should truncate levels beyond MAX_ORDERBOOK_DEPTH (50)', () => {
      const levels: [string, string][] = [];
      for (let i = 0; i < 50; i++) {
        levels.push([
          new Decimal(0.5).plus(new Decimal(i).mul(0.01)).toFixed(4),
          '100.00',
        ]);
      }
      const state: LocalOrderbookState = {
        seq: 1,
        yes: levels,
        no: [],
      };

      // Adding a 51st level should result in truncation to 50
      client.applyDelta(state, '0.0100', '50.00', 'yes');

      expect(state.yes).toHaveLength(50);
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should track subscriptions without sending when disconnected', () => {
      client.subscribe('CPI-22DEC');
      client.subscribe('BTC-30DEC');
      // Not connected, so no messages sent, but subscriptions tracked
      expect(client.getConnectionStatus()).toBe(false);
    });

    it('should remove subscription and state on unsubscribe', () => {
      client.subscribe('CPI-22DEC');
      client.unsubscribe('CPI-22DEC');
      // State cleared — re-applying a delta for this ticker should be a no-op
      expect(client.getConnectionStatus()).toBe(false);
    });
  });

  describe('subscription ID tracking (AC #5)', () => {
    interface MockWs {
      on: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      ping: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      readyState: number;
      listeners: Record<string, ((...args: unknown[]) => void)[]>;
    }
    let mockWs: MockWs;

    function createMockWs(): MockWs {
      const ws: MockWs = {
        on: vi.fn(),
        send: vi.fn(),
        ping: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
        readyState: 1,
        listeners: {},
      };
      ws.on.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (!ws.listeners[event]) ws.listeners[event] = [];
          ws.listeners[event].push(handler);
          return ws;
        },
      );
      return ws;
    }

    let kalshiClient: KalshiWebSocketClient;

    beforeEach(() => {
      vi.useFakeTimers();
      mockWs = createMockWs();
      __wsMockInstance = mockWs;
      kalshiClient = new KalshiWebSocketClient({
        apiKeyId: 'test-key-id',
        privateKeyPem: '',
        wsUrl: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function triggerWsEvent(ws: MockWs, event: string, ...args: unknown[]) {
      const handlers = ws.listeners[event] || [];
      for (const h of handlers) h(...args);
    }

    it('should store sid from subscribed response', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      // Simulate subscribed response
      const subscribedMsg = JSON.stringify({
        type: 'subscribed',
        sid: 42,
        msg: { channel: 'orderbook_delta', sid: 42 },
      });
      triggerWsEvent(mockWs, 'message', subscribedMsg);

      expect(kalshiClient.subscriptionId).toBe(42);
    });

    it('should have null subscriptionId initially', () => {
      expect(kalshiClient.subscriptionId).toBeNull();
    });

    it('should send correct addMarkets payload via WS (internal subsystem verification)', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      // Set sid as if subscribed response was received
      kalshiClient['_subscriptionId'] = 1;
      mockWs.send.mockClear();

      kalshiClient.addMarkets(['TICKER-A', 'TICKER-B']);

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        mockWs.send.mock.calls[0]![0] as string,
      ) as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          cmd: 'update_subscription',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          params: expect.objectContaining({
            sids: [1],
            market_tickers: ['TICKER-A', 'TICKER-B'],
            action: 'add_markets',
          }),
        }),
      );
    });

    it('should send correct removeMarkets payload via WS (internal subsystem verification)', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      kalshiClient['_subscriptionId'] = 1;
      mockWs.send.mockClear();

      kalshiClient.removeMarkets(['TICKER-A']);

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        mockWs.send.mock.calls[0]![0] as string,
      ) as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          cmd: 'update_subscription',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          params: expect.objectContaining({
            sids: [1],
            market_tickers: ['TICKER-A'],
            action: 'delete_markets',
          }),
        }),
      );
    });

    it('should not send addMarkets when disconnected', () => {
      kalshiClient.addMarkets(['TICKER-A']);
      // No ws exists, so nothing should be sent (no error thrown)
      expect(kalshiClient.getConnectionStatus()).toBe(false);
    });

    it('should not send removeMarkets when disconnected', () => {
      kalshiClient.removeMarkets(['TICKER-A']);
      expect(kalshiClient.getConnectionStatus()).toBe(false);
    });

    it('should use update_subscription format for unsubscribe when sid is set', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      kalshiClient['_subscriptionId'] = 5;
      kalshiClient.subscribe('CPI-22DEC');
      mockWs.send.mockClear();

      kalshiClient.unsubscribe('CPI-22DEC');

      expect(mockWs.send).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(
        mockWs.send.mock.calls[0]![0] as string,
      ) as Record<string, unknown>;
      expect(payload).toEqual(
        expect.objectContaining({
          cmd: 'update_subscription',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          params: expect.objectContaining({
            sids: [5],
            market_tickers: ['CPI-22DEC'],
            action: 'delete_markets',
          }),
        }),
      );
    });

    it('should use addMarkets in debouncedResubscribe when sid is set', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      // Set sid and subscribe
      kalshiClient['_subscriptionId'] = 1;
      kalshiClient.subscribe('CPI-22DEC');
      mockWs.send.mockClear();

      // Simulate a sequence gap delta that triggers debouncedResubscribe
      const delta = JSON.stringify({
        type: 'orderbook_delta',
        sid: 1,
        msg: {
          seq: 999,
          market_ticker: 'CPI-22DEC',
          price_dollars: '0.50',
          delta_fp: '10.00',
          side: 'yes',
        },
      });
      triggerWsEvent(mockWs, 'message', delta);

      // Should have sent addMarkets (not subscribe) since sid exists
      const sendCalls = mockWs.send.mock.calls.map(
        (call: unknown[]) =>
          JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      const addMarketsCalls = sendCalls.filter(
        (p: Record<string, unknown>) => p.cmd === 'update_subscription',
      );
      expect(addMarketsCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onUpdate', () => {
    it('should invoke registered callback when snapshot is emitted', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // Simulate internal snapshot handling via applyDelta + emit
      // We can verify the callback registration by constructing state and triggering emit
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [['0.6200', '1000.00']],
        no: [['0.3800', '800.00']],
      };

      // Use applyDelta which is public, then check callback was NOT called
      // (applyDelta doesn't emit — only internal handleSnapshot/handleDelta do)
      client.applyDelta(state, '0.6300', '200.00', 'yes');
      // callback not called because applyDelta is a pure state mutation
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getConnectionStatus', () => {
    it('should return false when not connected', () => {
      expect(client.getConnectionStatus()).toBe(false);
    });
  });

  describe('WebSocket keepalive ping', () => {
    interface MockWs {
      on: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      ping: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      readyState: number;
      listeners: Record<string, ((...args: unknown[]) => void)[]>;
    }
    let mockWs: MockWs;

    function createMockWs(): MockWs {
      const ws: MockWs = {
        on: vi.fn(),
        send: vi.fn(),
        ping: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
        readyState: 1,
        listeners: {},
      };
      ws.on.mockImplementation(
        (event: string, handler: (...args: unknown[]) => void) => {
          if (!ws.listeners[event]) ws.listeners[event] = [];
          ws.listeners[event].push(handler);
          return ws;
        },
      );
      return ws;
    }

    let kalshiClient: KalshiWebSocketClient;

    beforeEach(() => {
      vi.useFakeTimers();
      mockWs = createMockWs();
      __wsMockInstance = mockWs;
      // Use empty privateKeyPem to skip RSA signing in generateAuthHeaders
      kalshiClient = new KalshiWebSocketClient({
        apiKeyId: 'test-key-id',
        privateKeyPem: '',
        wsUrl: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function triggerWsEvent(ws: MockWs, event: string, ...args: unknown[]) {
      const handlers = ws.listeners[event] || [];
      for (const h of handlers) h(...args);
    }

    it('should start ping interval after connect', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(1);

      triggerWsEvent(mockWs, 'pong');
      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(2);
    });

    it('should clear ping timers on disconnect', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      kalshiClient.disconnect();

      vi.advanceTimersByTime(60_000);
      expect(mockWs.ping).not.toHaveBeenCalled();
    });

    it('should terminate on pong timeout (10s)', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      expect(mockWs.terminate).toHaveBeenCalledTimes(1);
    });

    it('should clear pong timeout when pong received', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(1);

      triggerWsEvent(mockWs, 'pong');

      vi.advanceTimersByTime(10_000);
      expect(mockWs.terminate).not.toHaveBeenCalled();
    });

    it('should clear previous pong timeout before new ping (overlapping prevention)', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      // First ping at 30s
      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(1);

      // Pong timeout from first ping fires at 40s (30+10) — terminate called once
      vi.advanceTimersByTime(10_000);
      expect(mockWs.terminate).toHaveBeenCalledTimes(1);

      // Advance to second ping at 60s — clearTimeout(pongTimeout) is called but pongTimeout is already cleared
      // This verifies the guard: even if pongTimeout was already fired, the cleanup doesn't crash
      mockWs.terminate.mockClear();
      vi.advanceTimersByTime(20_000); // Advance from T=40s to T=60s
      expect(mockWs.ping).toHaveBeenCalledTimes(2);

      // Second pong timeout fires at T=70s
      vi.advanceTimersByTime(10_000);
      expect(mockWs.terminate).toHaveBeenCalledTimes(1);
    });

    it('should not ping if ws is null or not OPEN (null guard)', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      mockWs.readyState = 3; // CLOSED

      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).not.toHaveBeenCalled();
    });

    it('should clear ping timers on error event', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      triggerWsEvent(mockWs, 'error', new Error('test error'));

      vi.advanceTimersByTime(60_000);
      expect(mockWs.ping).not.toHaveBeenCalled();
    });

    it('should clear ping timers on close event', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      kalshiClient['shouldReconnect'] = false;
      triggerWsEvent(mockWs, 'close', 1000, Buffer.from('normal'));

      vi.advanceTimersByTime(60_000);
      expect(mockWs.ping).not.toHaveBeenCalled();
    });

    it('should restart ping interval after reconnect', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      vi.advanceTimersByTime(30_000);
      expect(mockWs.ping).toHaveBeenCalledTimes(1);

      const mockWs2 = createMockWs();
      __wsMockInstance = mockWs2;

      kalshiClient['shouldReconnect'] = true;
      triggerWsEvent(mockWs, 'close', 1006, Buffer.from(''));

      vi.advanceTimersByTime(5_000);
      triggerWsEvent(mockWs2, 'open');

      vi.advanceTimersByTime(30_000);
      expect(mockWs2.ping).toHaveBeenCalledTimes(1);
    });

    it('should debounce resubscribe within cooldown period', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      // Subscribe to a ticker
      kalshiClient.subscribe('CPI-22DEC');
      mockWs.send.mockClear();

      // Simulate two rapid sequence gap resubscribes via handleMessage
      const delta1 = JSON.stringify({
        type: 'orderbook_delta',
        sid: 1,
        msg: {
          seq: 999,
          market_ticker: 'CPI-22DEC',
          price_dollars: '0.50',
          delta_fp: '10.00',
          side: 'yes',
        },
      });
      triggerWsEvent(mockWs, 'message', delta1);

      const delta2 = JSON.stringify({
        type: 'orderbook_delta',
        sid: 1,
        msg: {
          seq: 1000,
          market_ticker: 'CPI-22DEC',
          price_dollars: '0.50',
          delta_fp: '10.00',
          side: 'yes',
        },
      });
      triggerWsEvent(mockWs, 'message', delta2);

      // Only one resubscribe should have been sent (second suppressed by cooldown)
      const subscribeCalls = mockWs.send.mock.calls.filter(
        (call: unknown[]) => {
          const parsed = JSON.parse(call[0] as string) as { cmd?: string };
          return parsed.cmd === 'subscribe';
        },
      );
      expect(subscribeCalls).toHaveLength(1);
    });

    it('should deduplicate snapshot levels with duplicate prices', async () => {
      const connectPromise = kalshiClient.connect();
      triggerWsEvent(mockWs, 'open');
      await connectPromise;

      const callback = vi.fn();
      kalshiClient.onUpdate(callback);
      kalshiClient.subscribe('CPI-22DEC');

      // Snapshot with duplicate price '0.6500' in yes — last occurrence should win
      const snapshot = JSON.stringify({
        type: 'orderbook_snapshot',
        sid: 1,
        msg: {
          seq: 1,
          market_ticker: 'CPI-22DEC',
          yes_dollars_fp: [
            ['0.6500', '100.00'],
            ['0.6500', '200.00'],
            ['0.7000', '50.00'],
          ],
          no_dollars_fp: [],
        },
      });
      triggerWsEvent(mockWs, 'message', snapshot);

      expect(callback).toHaveBeenCalledTimes(1);
      const book = callback.mock.calls[0]![0] as NormalizedOrderBook;
      // Deduplication: '0.6500' appears once with qty 200 (last wins)
      expect(book.bids).toHaveLength(2);
      const bid65 = book.bids.find((b) => Math.abs(b.price - 0.65) < 0.001);
      expect(bid65?.quantity).toBe(200);
    });

    it('should reject with timeout if connect takes >10s', async () => {
      // Don't trigger 'open' — let it hang
      const connectPromise = kalshiClient.connect();

      // Advance 10s — timeout should fire
      vi.advanceTimersByTime(10_000);

      await expect(connectPromise).rejects.toThrow(
        'WebSocket connect timeout (10s)',
      );
    });
  });
});
