import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { TelegramCircuitBreakerService } from './telegram-circuit-breaker.service.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Suppress logger output in tests
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

function makeConfigService(
  overrides: Record<string, unknown> = {},
): Partial<ConfigService> {
  const defaults: Record<string, unknown> = {
    TELEGRAM_BOT_TOKEN: 'test-token-123',
    TELEGRAM_CHAT_ID: '12345',
    TELEGRAM_SEND_TIMEOUT_MS: 2000,
    TELEGRAM_MAX_RETRIES: 3,
    TELEGRAM_BUFFER_MAX_SIZE: 100,
    TELEGRAM_CIRCUIT_BREAK_MS: 60000,
  };
  const config = { ...defaults, ...overrides };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => config[key] ?? defaultValue,
    ),
  };
}

function makeTelegramResponse(ok: boolean, description?: string) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: () =>
      Promise.resolve({
        ok,
        description: description ?? (ok ? 'Message sent' : 'Bad request'),
      }),
  };
}

function make429Response(retryAfter: number) {
  return {
    ok: false,
    status: 429,
    json: () =>
      Promise.resolve({
        ok: false,
        description: 'Too Many Requests',
        parameters: { retry_after: retryAfter },
      }),
  };
}

describe('TelegramCircuitBreakerService', () => {
  let service: TelegramCircuitBreakerService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    service = new TelegramCircuitBreakerService(
      makeConfigService() as ConfigService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sendMessage', () => {
    it('should send message successfully via fetch', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));

      const result = await service.sendMessage('<b>Test</b>');
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/bottest-token-123/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: '12345',
            text: '<b>Test</b>',
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }),
      );
    });

    it('should return false on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));

      const result = await service.sendMessage('test');
      expect(result).toBe(false);
    });

    it('should return false on fetch exception', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.sendMessage('test');
      expect(result).toBe(false);
    });

    it('should use AbortSignal.timeout for request timeout', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));

      await service.sendMessage('test');
      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]?.signal).toBeDefined();
    });
  });

  describe('enqueueAndSend', () => {
    it('should send message on success and reset failures', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));

      await service.enqueueAndSend('<b>Alert</b>', 'critical');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should buffer message on failure', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));

      await service.enqueueAndSend('Failed message', 'warning');
      expect(service.getBufferSize()).toBe(1);
    });

    it('should not attempt send when circuit breaker is OPEN', async () => {
      // Trip circuit breaker: 3 consecutive failures
      mockFetch.mockResolvedValue(makeTelegramResponse(false));
      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      mockFetch.mockClear();

      // This should buffer without attempting HTTP
      await service.enqueueAndSend('buffered', 'critical');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(service.getBufferSize()).toBe(4); // 3 failed + 1 buffered
    });
  });

  describe('priority buffer', () => {
    it('should store failed messages with severity', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('critical msg', 'critical');
      await service.enqueueAndSend('warning msg', 'warning');
      await service.enqueueAndSend('info msg', 'info');

      expect(service.getBufferSize()).toBe(3);
    });

    it('should cap buffer at max size', async () => {
      const svc = new TelegramCircuitBreakerService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 5 }) as ConfigService,
      );

      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      for (let i = 0; i < 7; i++) {
        await svc.enqueueAndSend(`msg ${i}`, 'info');
      }

      expect(svc.getBufferSize()).toBe(5);
    });

    it('should drop lowest priority first on overflow', async () => {
      const svc = new TelegramCircuitBreakerService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 3 }) as ConfigService,
      );

      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await svc.enqueueAndSend('info1', 'info');
      await svc.enqueueAndSend('warning1', 'warning');
      await svc.enqueueAndSend('critical1', 'critical');
      // Buffer is full: [info1, warning1, critical1]

      // Adding another critical should drop info1
      await svc.enqueueAndSend('critical2', 'critical');
      expect(svc.getBufferSize()).toBe(3);

      const contents = svc.getBufferContents();
      expect(contents.some((m) => m.text === 'info1')).toBe(false);
      expect(contents.some((m) => m.text === 'critical2')).toBe(true);
    });

    it('should drop oldest within same priority on overflow', async () => {
      const svc = new TelegramCircuitBreakerService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 2 }) as ConfigService,
      );

      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await svc.enqueueAndSend('critical1', 'critical');
      await svc.enqueueAndSend('critical2', 'critical');
      // Buffer full: [critical1, critical2]

      await svc.enqueueAndSend('critical3', 'critical');
      expect(svc.getBufferSize()).toBe(2);

      const contents = svc.getBufferContents();
      expect(contents.some((m) => m.text === 'critical1')).toBe(false);
      expect(contents.some((m) => m.text === 'critical3')).toBe(true);
    });

    it('should drain buffer on successful send (highest priority first)', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('info msg', 'info');
      await service.enqueueAndSend('critical msg', 'critical');
      expect(service.getBufferSize()).toBe(2);

      // Now make sends succeed and trigger drain
      mockFetch.mockResolvedValue(makeTelegramResponse(true));

      await service.enqueueAndSend('new msg', 'info');

      // Drain runs asynchronously via setImmediate. Advance timers.
      await vi.advanceTimersByTimeAsync(3000);

      expect(service.getBufferSize()).toBe(0);
    });
  });

  describe('circuit breaker state transitions', () => {
    it('should open after 3 consecutive failures', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      expect(service.getCircuitState()).toBe('OPEN');
    });

    it('should not attempt HTTP calls when OPEN', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');
      mockFetch.mockClear();

      await service.enqueueAndSend('buffered', 'info');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after break period', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      // Advance past circuit break period (60s)
      vi.advanceTimersByTime(61000);

      expect(service.getCircuitState()).toBe('HALF_OPEN');
    });

    it('should close circuit on successful probe in HALF_OPEN', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));
      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      vi.advanceTimersByTime(61000);

      // Probe succeeds
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));
      await service.enqueueAndSend('probe', 'info');

      expect(service.getCircuitState()).toBe('CLOSED');
    });

    it('should re-open circuit on failed probe in HALF_OPEN', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));
      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      vi.advanceTimersByTime(61000);

      // Probe fails
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));
      await service.enqueueAndSend('probe', 'info');

      expect(service.getCircuitState()).toBe('OPEN');
    });

    it('should respect Telegram 429 retry_after in circuit break duration', async () => {
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));
      // Third failure is a 429 with retry_after=120
      mockFetch.mockResolvedValueOnce(make429Response(120));

      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      expect(service.getCircuitState()).toBe('OPEN');

      // 60s (default) is NOT enough — retry_after says 120s
      vi.advanceTimersByTime(61000);
      expect(service.getCircuitState()).toBe('OPEN');

      // 120s should be enough
      vi.advanceTimersByTime(60000);
      expect(service.getCircuitState()).toBe('HALF_OPEN');
    });

    it('should still buffer messages when OPEN (not drop them)', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));
      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      const sizeBefore = service.getBufferSize();
      await service.enqueueAndSend('critical during open', 'critical');
      expect(service.getBufferSize()).toBe(sizeBefore + 1);
    });

    it('should drain buffer after HALF_OPEN probe succeeds', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));
      await service.enqueueAndSend('fail1', 'info');
      await service.enqueueAndSend('fail2', 'info');
      await service.enqueueAndSend('fail3', 'info');

      vi.advanceTimersByTime(61000);

      // Probe succeeds, should trigger drain
      mockFetch.mockResolvedValue(makeTelegramResponse(true));
      await service.enqueueAndSend('probe', 'info');

      // Drain runs asynchronously
      await vi.advanceTimersByTimeAsync(5000);

      expect(service.getBufferSize()).toBe(0);
    });
  });

  describe('error logging', () => {
    it('should log SystemHealthError(4006) on send failure', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));

      await service.enqueueAndSend('test', 'info');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 4006,
          component: 'telegram-alerting',
        }),
      );
    });
  });

  describe('buffer drain with withRetry', () => {
    it('should retry failed drain sends before giving up', async () => {
      // Buffer a message by failing first
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));
      await service.enqueueAndSend('buffered msg', 'info');
      expect(service.getBufferSize()).toBe(1);

      // Succeed on the trigger message, but fail on drain retries
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true)); // trigger send
      mockFetch.mockResolvedValue(makeTelegramResponse(false)); // drain retries fail

      await service.enqueueAndSend('trigger msg', 'info');

      // Drain runs async — advance to allow withRetry to run
      await vi.advanceTimersByTimeAsync(15000);

      // Buffer should still have the message since all retries failed
      expect(service.getBufferSize()).toBe(1);
    });
  });

  describe('reloadConfig', () => {
    it('should update config values when provided', async () => {
      service.reloadConfig({
        sendTimeoutMs: 5000,
        maxRetries: 5,
        bufferMaxSize: 200,
        circuitBreakMs: 120000,
      });

      // Verify by checking circuit state after custom maxRetries (5 instead of 3)
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      // 3 failures should NOT trip circuit with maxRetries=5
      await service.enqueueAndSend('f1', 'info');
      await service.enqueueAndSend('f2', 'info');
      await service.enqueueAndSend('f3', 'info');
      expect(service.getCircuitState()).toBe('CLOSED');
    });

    it('should only update specified fields', () => {
      service.reloadConfig({ sendTimeoutMs: 5000 });
      // Other fields should remain at defaults — no crash, service still works
      expect(service.getCircuitState()).toBe('CLOSED');
    });
  });

  describe('getBufferSize and getBufferContents', () => {
    it('should return 0 for empty buffer', () => {
      expect(service.getBufferSize()).toBe(0);
    });

    it('should return empty array for empty buffer contents', () => {
      expect(service.getBufferContents()).toEqual([]);
    });

    it('should reflect buffer state after messages are added', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('msg1', 'warning');
      expect(service.getBufferSize()).toBe(1);

      const contents = service.getBufferContents();
      expect(contents).toHaveLength(1);
      expect(contents[0]).toEqual(
        expect.objectContaining({
          text: 'msg1',
          severity: 'warning',
        }),
      );
    });
  });
});
