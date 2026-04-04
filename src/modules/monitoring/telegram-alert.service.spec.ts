import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  TelegramAlertService,
  TELEGRAM_ELIGIBLE_EVENTS,
} from './telegram-alert.service.js';
import { TelegramCircuitBreakerService } from './telegram-circuit-breaker.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';

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
    TELEGRAM_BATCH_WINDOW_MS: '3000',
  };
  const config = { ...defaults, ...overrides };
  return {
    get: vi.fn(
      (key: string, defaultValue?: unknown) => config[key] ?? defaultValue,
    ),
  };
}

function makeMockCircuitBreaker(): {
  mock: Record<string, ReturnType<typeof vi.fn>>;
  instance: TelegramCircuitBreakerService;
} {
  const mock = {
    sendMessage: vi.fn().mockResolvedValue(true),
    enqueueAndSend: vi.fn().mockResolvedValue(undefined),
    getCircuitState: vi.fn().mockReturnValue('CLOSED'),
    getBufferSize: vi.fn().mockReturnValue(0),
    getBufferContents: vi.fn().mockReturnValue([]),
    reloadConfig: vi.fn(),
  };
  return { mock, instance: mock as unknown as TelegramCircuitBreakerService };
}

describe('TelegramAlertService', () => {
  let service: TelegramAlertService;
  let configService: Partial<ConfigService>;
  let cbMock: ReturnType<typeof makeMockCircuitBreaker>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    configService = makeConfigService();
    cbMock = makeMockCircuitBreaker();
    service = new TelegramAlertService(
      cbMock.instance,
      configService as ConfigService,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with valid config and set enabled=true', () => {
      service.onModuleInit();
      expect(service.isEnabled()).toBe(true);
    });

    it('should disable gracefully with missing token', () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });

    it('should disable gracefully with missing chat ID', () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_CHAT_ID: '' }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });

    it('should disable gracefully with undefined token', () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: undefined }) as ConfigService,
      );
      svc.onModuleInit();
      expect(svc.isEnabled()).toBe(false);
    });
  });

  describe('pass-through methods', () => {
    it('should delegate sendMessage to circuit breaker when enabled', async () => {
      service.onModuleInit();
      const result = await service.sendMessage('<b>Test</b>');
      expect(cbMock.mock.sendMessage).toHaveBeenCalledWith('<b>Test</b>');
      expect(result).toBe(true);
    });

    it('should skip sendMessage when disabled', async () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      const result = await svc.sendMessage('test');
      expect(result).toBe(false);
      expect(cbMock.mock.sendMessage).not.toHaveBeenCalled();
    });

    it('should delegate enqueueAndSend to circuit breaker when enabled', async () => {
      service.onModuleInit();
      await service.enqueueAndSend('test', 'info');
      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledWith('test', 'info');
    });

    it('should skip enqueueAndSend when disabled', async () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      await svc.enqueueAndSend('test', 'info');
      expect(cbMock.mock.enqueueAndSend).not.toHaveBeenCalled();
    });

    it('should delegate getBufferSize to circuit breaker', () => {
      cbMock.mock.getBufferSize.mockReturnValue(5);
      expect(service.getBufferSize()).toBe(5);
    });

    it('should delegate getBufferContents to circuit breaker', () => {
      const contents = [{ text: 'msg', severity: 'info', timestamp: 123 }];
      cbMock.mock.getBufferContents.mockReturnValue(contents);
      expect(service.getBufferContents()).toBe(contents);
    });

    it('should delegate getCircuitState to circuit breaker', () => {
      cbMock.mock.getCircuitState.mockReturnValue('HALF_OPEN');
      expect(service.getCircuitState()).toBe('HALF_OPEN');
    });

    it('should delegate reloadConfig to circuit breaker', () => {
      const settings = { sendTimeoutMs: 5000 };
      service.reloadConfig(settings);
      expect(cbMock.mock.reloadConfig).toHaveBeenCalledWith(settings);
    });
  });

  describe('daily test alert', () => {
    it('should send formatted test message with uptime', async () => {
      service.onModuleInit();

      await service.handleTestAlert();

      expect(cbMock.mock.sendMessage).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.sendMessage.mock.calls[0]![0] as string;
      expect(text).toContain('Alerting system healthy');
      expect(text).toContain('Uptime:');
    });

    it('should not send test alert when disabled', async () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      await svc.handleTestAlert();
      expect(cbMock.mock.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendEventAlert dispatch', () => {
    const baseEvent = {
      timestamp: new Date('2024-01-15T10:00:00Z'),
      correlationId: 'test-corr',
    };

    beforeEach(() => {
      service.onModuleInit();
    });

    it('should dispatch OPPORTUNITY_IDENTIFIED via formatter', async () => {
      service.sendEventAlert(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, {
        opportunity: { netEdge: '0.01', pairId: 'p-1', positionSizeUsd: '100' },
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('Opportunity Identified');
    });

    it('should dispatch ORDER_FILLED via formatter', async () => {
      service.sendEventAlert(EVENT_NAMES.ORDER_FILLED, {
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

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('Order Filled');
    });

    it('should dispatch EXECUTION_FAILED via formatter', async () => {
      service.sendEventAlert(EVENT_NAMES.EXECUTION_FAILED, {
        reasonCode: 2001,
        reason: 'Depth issue',
        opportunityId: 'opp-1',
        context: {},
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('Execution Failed');
    });

    it('should dispatch SINGLE_LEG_EXPOSURE via formatter', () => {
      service.sendEventAlert(EVENT_NAMES.SINGLE_LEG_EXPOSURE, {
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

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('SINGLE LEG EXPOSURE');
    });

    it('should dispatch SINGLE_LEG_RESOLVED', async () => {
      service.sendEventAlert(EVENT_NAMES.SINGLE_LEG_RESOLVED, {
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

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch EXIT_TRIGGERED', async () => {
      service.sendEventAlert(EVENT_NAMES.EXIT_TRIGGERED, {
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

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch LIMIT_APPROACHED', async () => {
      service.sendEventAlert(EVENT_NAMES.LIMIT_APPROACHED, {
        limitType: 'daily_loss',
        currentValue: 400,
        threshold: 500,
        percentUsed: 80,
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch LIMIT_BREACHED', () => {
      service.sendEventAlert(EVENT_NAMES.LIMIT_BREACHED, {
        limitType: 'daily_loss',
        currentValue: 550,
        threshold: 500,
        ...baseEvent,
      } as never);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch PLATFORM_HEALTH_DEGRADED', async () => {
      service.sendEventAlert(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED, {
        platformId: 'KALSHI',
        health: { status: 'degraded', latencyMs: 2500 },
        previousStatus: 'healthy',
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch PLATFORM_HEALTH_RECOVERED', async () => {
      service.sendEventAlert(EVENT_NAMES.PLATFORM_HEALTH_RECOVERED, {
        platformId: 'KALSHI',
        health: { status: 'healthy', latencyMs: 100 },
        previousStatus: 'degraded',
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch SYSTEM_TRADING_HALTED', () => {
      service.sendEventAlert(EVENT_NAMES.SYSTEM_TRADING_HALTED, {
        reason: 'DAILY_LOSS_LIMIT',
        details: {},
        haltTimestamp: new Date(),
        severity: 'critical',
        ...baseEvent,
      } as never);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch SYSTEM_TRADING_RESUMED', async () => {
      service.sendEventAlert(EVENT_NAMES.SYSTEM_TRADING_RESUMED, {
        removedReason: 'DAILY_LOSS_LIMIT',
        remainingReasons: [],
        resumeTimestamp: new Date(),
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch RECONCILIATION_DISCREPANCY', () => {
      service.sendEventAlert(EVENT_NAMES.RECONCILIATION_DISCREPANCY, {
        positionId: 'pos-1',
        pairId: 'pair-1',
        discrepancyType: 'order_status_mismatch',
        localState: 'FILLED',
        platformState: 'PENDING',
        recommendedAction: 'Manual review',
        ...baseEvent,
      } as never);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should dispatch SYSTEM_HEALTH_CRITICAL', () => {
      service.sendEventAlert(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL, {
        component: 'database',
        diagnosticInfo: 'Pool exhausted',
        recommendedActions: ['Restart'],
        severity: 'critical',
        ...baseEvent,
      } as never);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should send generic alert for unknown events without formatter', async () => {
      service.sendEventAlert('some.unknown.event', {
        ...baseEvent,
      } as never);

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('some.unknown.event');
    });

    it('should never throw from sendEventAlert (try-catch wrapping)', () => {
      // Make the formatter throw by passing a malformed event
      const badEvent = {
        timestamp: new Date(),
        correlationId: 'corr-bad',
      };

      // This should NOT throw even with incomplete event data
      expect(() =>
        service.sendEventAlert(
          EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
          badEvent as never,
        ),
      ).not.toThrow();

      expect(() =>
        service.sendEventAlert(EVENT_NAMES.ORDER_FILLED, badEvent as never),
      ).not.toThrow();

      expect(() =>
        service.sendEventAlert(
          EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          badEvent as never,
        ),
      ).not.toThrow();
    });

    it('should send fallback alert when formatter throws', () => {
      // Pass event that will cause formatter to throw due to missing fields
      const badEvent = { timestamp: new Date(), correlationId: 'bad-corr' };

      service.sendEventAlert(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        badEvent as never,
      );

      // Should still have attempted to send something (fallback message)
      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalled();
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('Alert format error');
    });

    it('should not process events when disabled', () => {
      const svc = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({ TELEGRAM_BOT_TOKEN: '' }) as ConfigService,
      );
      svc.onModuleInit();

      svc.sendEventAlert(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, {
        opportunity: {},
        timestamp: new Date(),
      } as never);

      expect(cbMock.mock.enqueueAndSend).not.toHaveBeenCalled();
    });

    it('should dispatch DATA_DIVERGENCE via formatter', async () => {
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
      const { DataDivergenceEvent } =
        await import('../../common/events/platform.events');
      const { asContractId } = await import('../../common/types/branded.type');

      service.sendEventAlert(
        EVENT_NAMES.DATA_DIVERGENCE,
        new DataDivergenceEvent(
          'kalshi',
          asContractId('DIV-TEST'),
          '0.50',
          '0.55',
          '2026-03-15T00:00:00Z',
          '0.47',
          '0.52',
          '2026-03-15T00:01:30Z',
          '0.03',
          90000,
        ),
      );

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('Data Divergence');
      expect(text).toContain('DIV-TEST');
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
    });
  });

  describe('TELEGRAM_ELIGIBLE_EVENTS constant', () => {
    it('should contain exactly 26 events', () => {
      expect(TELEGRAM_ELIGIBLE_EVENTS.size).toBe(26);
    });

    it('should contain all expected events', () => {
      const expected = [
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        EVENT_NAMES.ORDER_FILLED,
        EVENT_NAMES.EXECUTION_FAILED,
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        EVENT_NAMES.EXIT_TRIGGERED,
        EVENT_NAMES.LIMIT_APPROACHED,
        EVENT_NAMES.LIMIT_BREACHED,
        EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
        EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
        EVENT_NAMES.SYSTEM_TRADING_HALTED,
        EVENT_NAMES.SYSTEM_TRADING_RESUMED,
        EVENT_NAMES.RECONCILIATION_DISCREPANCY,
        EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
        EVENT_NAMES.RESOLUTION_DIVERGED,
        EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
        EVENT_NAMES.CALIBRATION_COMPLETED,
        EVENT_NAMES.ORDERBOOK_STALE,
        EVENT_NAMES.ORDERBOOK_RECOVERED,
        EVENT_NAMES.CLUSTER_LIMIT_BREACHED,
        EVENT_NAMES.AGGREGATE_CLUSTER_LIMIT_BREACHED,
        EVENT_NAMES.CONFIG_BANKROLL_UPDATED,
        EVENT_NAMES.DATA_DIVERGENCE,
        EVENT_NAMES.TIMESCALE_RETENTION_COMPLETED,
      ];
      for (const eventName of expected) {
        expect(TELEGRAM_ELIGIBLE_EVENTS.has(eventName)).toBe(true);
      }
    });
  });

  describe('message batching', () => {
    let batchService: TelegramAlertService;

    beforeEach(() => {
      batchService = new TelegramAlertService(
        cbMock.instance,
        makeConfigService({
          TELEGRAM_BATCH_WINDOW_MS: '3000',
        }) as ConfigService,
      );
      batchService.onModuleInit();
    });

    it('should send single message as-is after batch window expires', async () => {
      batchService['addToBatch'](
        'detection.opportunity.identified',
        'Single message',
        'info',
      );

      expect(cbMock.mock.enqueueAndSend).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toBe('Single message');
    });

    it('should consolidate multiple messages for same event type', async () => {
      batchService['addToBatch'](
        'detection.opportunity.identified',
        'Message 1',
        'info',
      );
      batchService['addToBatch'](
        'detection.opportunity.identified',
        'Message 2',
        'info',
      );
      batchService['addToBatch'](
        'detection.opportunity.identified',
        'Message 3',
        'info',
      );

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('3x detection.opportunity.identified');
      expect(text).toContain('1/3:');
      expect(text).toContain('Message 1');
    });

    it('should send critical messages immediately (bypass batching)', () => {
      batchService['addToBatch'](
        'execution.single_leg.exposure',
        'Critical alert!',
        'critical',
      );

      // Should be sent immediately without waiting for timer
      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });

    it('should batch different event types separately', async () => {
      batchService['addToBatch']('event.type.a', 'Msg A1', 'info');
      batchService['addToBatch']('event.type.a', 'Msg A2', 'info');
      batchService['addToBatch']('event.type.b', 'Msg B1', 'info');

      await vi.advanceTimersByTimeAsync(3000);

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(2);
    });

    it('should escalate severity within a batch', async () => {
      batchService['addToBatch']('event.type.a', 'Info msg', 'info');
      batchService['addToBatch']('event.type.a', 'Warning msg', 'warning');

      await vi.advanceTimersByTimeAsync(3000);

      // The consolidated send should use the highest severity (warning)
      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledWith(
        expect.stringContaining('2x event.type.a'),
        'warning',
      );
    });

    it('should respect 4096 character limit in consolidated messages', async () => {
      const longMsg = 'A'.repeat(2000);
      for (let i = 0; i < 10; i++) {
        batchService['addToBatch']('event.type.a', longMsg, 'info');
      }

      await vi.advanceTimersByTimeAsync(3000);

      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text.length).toBeLessThanOrEqual(4096);
    });

    it('should perform HTML-safe truncation', () => {
      const result = batchService['truncateHtmlSafe'](
        '<b>some long text that gets cut off mid-t',
        30,
      );
      // Should not contain unclosed <b> tag fragment
      expect(result).not.toMatch(/<[^>]*$/);
      expect(result).toContain('…');
    });

    it('should cap at 10 messages per batch with overflow note', async () => {
      for (let i = 0; i < 15; i++) {
        batchService['addToBatch']('event.type.a', `Msg ${i}`, 'info');
      }

      await vi.advanceTimersByTimeAsync(3000);

      const text = cbMock.mock.enqueueAndSend.mock.calls[0]![0] as string;
      expect(text).toContain('15x event.type.a');
      expect(text).toContain('...and 5 more');
    });

    it('should flush all pending batches on module destroy', async () => {
      batchService['addToBatch']('event.type.a', 'Pending msg 1', 'info');
      batchService['addToBatch']('event.type.b', 'Pending msg 2', 'warning');

      // Don't advance timers — call destroy directly
      await batchService.onModuleDestroy();

      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(2);
    });

    it('should not send before batch window expires', async () => {
      batchService['addToBatch']('event.type.a', 'Test msg', 'info');

      await vi.advanceTimersByTimeAsync(2999);
      expect(cbMock.mock.enqueueAndSend).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(cbMock.mock.enqueueAndSend).toHaveBeenCalledTimes(1);
    });
  });
});
