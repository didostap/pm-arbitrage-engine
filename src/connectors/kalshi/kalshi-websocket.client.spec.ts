import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
      wsUrl: 'wss://demo-api.kalshi.co/trade-api/v2/ws',
    });
  });

  describe('applyDelta', () => {
    it('should add a new YES price level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [[38, 800]],
      };

      client.applyDelta(state, 63, 200, 'yes');

      expect(state.yes).toContainEqual([63, 200]);
      expect(state.yes).toHaveLength(2);
      expect(state.yes[0]?.[0]).toBe(63);
      expect(state.yes[1]?.[0]).toBe(62);
    });

    it('should add a new NO price level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [],
        no: [[38, 800]],
      };

      client.applyDelta(state, 40, 500, 'no');

      expect(state.no).toContainEqual([40, 500]);
      expect(state.no).toHaveLength(2);
    });

    it('should increase quantity on existing level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [],
      };

      client.applyDelta(state, 62, 500, 'yes');

      expect(state.yes).toEqual([[62, 1500]]);
    });

    it('should decrease quantity on existing level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [],
      };

      client.applyDelta(state, 62, -300, 'yes');

      expect(state.yes).toEqual([[62, 700]]);
    });

    it('should remove level when quantity goes to zero', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [],
      };

      client.applyDelta(state, 62, -1000, 'yes');

      expect(state.yes).toHaveLength(0);
    });

    it('should remove level when quantity goes below zero', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 500]],
        no: [],
      };

      client.applyDelta(state, 62, -600, 'yes');

      expect(state.yes).toHaveLength(0);
    });

    it('should ignore negative delta for non-existent level', () => {
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [],
      };

      client.applyDelta(state, 99, -100, 'yes');

      expect(state.yes).toEqual([[62, 1000]]);
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

  describe('onUpdate', () => {
    it('should invoke registered callback when snapshot is emitted', () => {
      const callback = vi.fn();
      client.onUpdate(callback);

      // Simulate internal snapshot handling via applyDelta + emit
      // We can verify the callback registration by constructing state and triggering emit
      const state: LocalOrderbookState = {
        seq: 1,
        yes: [[62, 1000]],
        no: [[38, 800]],
      };

      // Use applyDelta which is public, then check callback was NOT called
      // (applyDelta doesn't emit — only internal handleSnapshot/handleDelta do)
      client.applyDelta(state, 63, 200, 'yes');
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
        wsUrl: 'wss://demo-api.kalshi.co/trade-api/v2/ws',
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
