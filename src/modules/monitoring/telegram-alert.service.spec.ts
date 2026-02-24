import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { TelegramAlertService } from './telegram-alert.service.js';

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
    TELEGRAM_TEST_ALERT_CRON: '0 8 * * *',
    TELEGRAM_TEST_ALERT_TIMEZONE: 'UTC',
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

describe('TelegramAlertService', () => {
  let service: TelegramAlertService;
  let configService: Partial<ConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    configService = makeConfigService();
    service = new TelegramAlertService(configService as ConfigService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization (AC #1)', () => {
    it('should initialize with valid config and set enabled=true', () => {
      service.onModuleInit();
      expect(service.isEnabled()).toBe(true);
    });

    it('should disable gracefully with missing token', () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });

    it('should disable gracefully with missing chat ID', () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_CHAT_ID: '' }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });

    it('should disable gracefully with undefined token', () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BOT_TOKEN: undefined }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });
  });

  describe('sendMessage (AC #2)', () => {
    it('should send message successfully via fetch', async () => {
      service.onModuleInit();
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
      service.onModuleInit();
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(false));

      const result = await service.sendMessage('test');
      expect(result).toBe(false);
    });

    it('should return false on fetch exception', async () => {
      service.onModuleInit();
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.sendMessage('test');
      expect(result).toBe(false);
    });

    it('should use AbortSignal.timeout for request timeout', async () => {
      service.onModuleInit();
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));

      await service.sendMessage('test');
      const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]?.signal).toBeDefined();
    });
  });

  describe('enqueueAndSend (AC #3)', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

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

    it('should skip processing when service is disabled', async () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      await svc.enqueueAndSend('test', 'info');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(svc.getBufferSize()).toBe(0);
    });
  });

  describe('priority buffer (AC #3)', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it('should store failed messages with severity', async () => {
      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      await service.enqueueAndSend('critical msg', 'critical');
      await service.enqueueAndSend('warning msg', 'warning');
      await service.enqueueAndSend('info msg', 'info');

      expect(service.getBufferSize()).toBe(3);
    });

    it('should cap buffer at max size', async () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 5 }) as ConfigService,
      );
      svc.onModuleInit();

      mockFetch.mockResolvedValue(makeTelegramResponse(false));

      for (let i = 0; i < 7; i++) {
        await svc.enqueueAndSend(`msg ${i}`, 'info');
      }

      expect(svc.getBufferSize()).toBe(5);
    });

    it('should drop lowest priority first on overflow', async () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 3 }) as ConfigService,
      );
      svc.onModuleInit();

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
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BUFFER_MAX_SIZE: 2 }) as ConfigService,
      );
      svc.onModuleInit();

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

  describe('circuit breaker (AC #3)', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

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

  describe('error logging (AC #3)', () => {
    it('should log SystemHealthError(4006) on send failure', async () => {
      service.onModuleInit();
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

  describe('daily test alert (AC #4)', () => {
    it('should send formatted test message with uptime', async () => {
      service.onModuleInit();
      mockFetch.mockResolvedValueOnce(makeTelegramResponse(true));

      await service.handleTestAlert();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('Alerting system healthy');
      expect(body.text).toContain('Uptime:');
    });

    it('should not send test alert when disabled', async () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      await svc.handleTestAlert();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('event handlers (AC #2, #6)', () => {
    beforeEach(() => {
      service.onModuleInit();
      mockFetch.mockResolvedValue(makeTelegramResponse(true));
    });

    const baseEvent = {
      timestamp: new Date('2024-01-15T10:00:00Z'),
      correlationId: 'test-corr',
    };

    it('should handle OPPORTUNITY_IDENTIFIED and send info-level alert', async () => {
      await service.handleOpportunityIdentified({
        opportunity: { netEdge: '0.01', pairId: 'p-1', positionSizeUsd: '100' },
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('Opportunity Identified');
    });

    it('should handle ORDER_FILLED and send info-level alert', async () => {
      await service.handleOrderFilled({
        orderId: 'ord-1',
        platform: 'KALSHI',
        side: 'BUY',
        price: 0.5,
        size: 10,
        fillPrice: 0.5,
        fillSize: 10,
        positionId: 'pos-1',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('Order Filled');
    });

    it('should handle EXECUTION_FAILED and send warning-level alert', async () => {
      await service.handleExecutionFailed({
        reasonCode: 2001,
        reason: 'Depth issue',
        opportunityId: 'opp-1',
        context: {},
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('Execution Failed');
    });

    it('should handle SINGLE_LEG_EXPOSURE and send critical-level alert', async () => {
      await service.handleSingleLegExposure({
        positionId: 'pos-1',
        pairId: 'pair-1',
        expectedEdge: 0.012,
        filledLeg: {
          platform: 'KALSHI',
          orderId: 'ord-1',
          side: 'BUY',
          price: 0.5,
          size: 10,
          fillPrice: 0.5,
          fillSize: 10,
        },
        failedLeg: {
          platform: 'POLYMARKET',
          reason: 'Timeout',
          reasonCode: 1009,
          attemptedPrice: 0.45,
          attemptedSize: 10,
        },
        pnlScenarios: {
          closeNowEstimate: '-$2',
          retryAtCurrentPrice: '+$1',
          holdRiskAssessment: 'Moderate',
        },
        recommendedActions: ['Retry'],
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('SINGLE LEG EXPOSURE');
    });

    it('should handle SINGLE_LEG_RESOLVED', async () => {
      await service.handleSingleLegResolved({
        positionId: 'pos-1',
        pairId: 'pair-1',
        resolutionType: 'retried',
        resolvedOrder: {
          orderId: 'ord-2',
          platform: 'POLYMARKET',
          status: 'FILLED',
          filledPrice: 0.45,
          filledQuantity: 10,
        },
        originalEdge: 0.012,
        newEdge: 0.01,
        realizedPnl: null,
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle EXIT_TRIGGERED', async () => {
      await service.handleExitTriggered({
        positionId: 'pos-1',
        pairId: 'pair-1',
        exitType: 'take_profit',
        initialEdge: '0.0120',
        finalEdge: '0.0005',
        realizedPnl: '+$3',
        kalshiCloseOrderId: 'k-1',
        polymarketCloseOrderId: 'p-1',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle LIMIT_APPROACHED', async () => {
      await service.handleLimitApproached({
        limitType: 'daily_loss',
        currentValue: 400,
        threshold: 500,
        percentUsed: 80,
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle LIMIT_BREACHED', async () => {
      await service.handleLimitBreached({
        limitType: 'daily_loss',
        currentValue: 550,
        threshold: 500,
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle PLATFORM_HEALTH_DEGRADED', async () => {
      await service.handlePlatformDegraded({
        platformId: 'KALSHI',
        health: { status: 'degraded', latencyMs: 2500 },
        previousStatus: 'healthy',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle PLATFORM_HEALTH_RECOVERED', async () => {
      await service.handlePlatformRecovered({
        platformId: 'KALSHI',
        health: { status: 'healthy', latencyMs: 100 },
        previousStatus: 'degraded',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle SYSTEM_TRADING_HALTED', async () => {
      await service.handleTradingHalted({
        reason: 'DAILY_LOSS_LIMIT',
        details: {},
        haltTimestamp: new Date(),
        severity: 'critical',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle SYSTEM_TRADING_RESUMED', async () => {
      await service.handleTradingResumed({
        removedReason: 'DAILY_LOSS_LIMIT',
        remainingReasons: [],
        resumeTimestamp: new Date(),
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle RECONCILIATION_DISCREPANCY', async () => {
      await service.handleReconciliationDiscrepancy({
        positionId: 'pos-1',
        pairId: 'pair-1',
        discrepancyType: 'order_status_mismatch',
        localState: 'FILLED',
        platformState: 'PENDING',
        recommendedAction: 'Manual review',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle SYSTEM_HEALTH_CRITICAL', async () => {
      await service.handleSystemHealthCritical({
        component: 'database',
        diagnosticInfo: 'Pool exhausted',
        recommendedActions: ['Restart'],
        severity: 'critical',
        ...baseEvent,
      } as never);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should never throw from event handlers (try-catch wrapping)', async () => {
      // Make the formatter throw by passing a malformed event
      // The handleEvent wrapper should catch and send fallback
      const badEvent = {
        timestamp: new Date(),
        correlationId: 'corr-bad',
      };

      // This should NOT throw even with incomplete event data
      await expect(
        service.handleOpportunityIdentified(badEvent as never),
      ).resolves.toBeUndefined();

      await expect(
        service.handleOrderFilled(badEvent as never),
      ).resolves.toBeUndefined();

      await expect(
        service.handleSingleLegExposure(badEvent as never),
      ).resolves.toBeUndefined();
    });

    it('should send fallback alert when formatter throws', async () => {
      // Pass event that will cause formatter to throw due to missing fields
      const badEvent = { timestamp: new Date(), correlationId: 'bad-corr' };

      await service.handleSingleLegExposure(badEvent as never);

      // Should still have attempted to send something (fallback message)
      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(
        (mockFetch.mock.calls[0] as [string, RequestInit])[1]?.body as string,
      ) as { text: string };
      expect(body.text).toContain('Alert format error');
    });

    it('should not process events when disabled', async () => {
      const svc = new TelegramAlertService(
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      await svc.handleOpportunityIdentified({
        opportunity: {},
        timestamp: new Date(),
      } as never);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('buffer drain with withRetry (AC #3)', () => {
    it('should retry failed drain sends before giving up', async () => {
      service.onModuleInit();

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
});
