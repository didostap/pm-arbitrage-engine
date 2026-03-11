import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventConsumerService } from './event-consumer.service.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { AuditLogService } from './audit-log.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import Decimal from 'decimal.js';
import type { BaseEvent } from '../../common/events/base.event.js';

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

function makeBaseEvent(overrides: Partial<BaseEvent> = {}): BaseEvent {
  return {
    timestamp: new Date('2024-01-15T10:00:00Z'),
    correlationId: 'test-corr-123',
    ...overrides,
  } as BaseEvent;
}

describe('EventConsumerService', () => {
  let module: TestingModule;
  let service: EventConsumerService;
  let emitter: EventEmitter2;
  let mockTelegramService: {
    sendEventAlert: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockTelegramService = {
      sendEventAlert: vi.fn(),
    };

    module = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot({
          wildcard: true,
          delimiter: '.',
        }),
      ],
      providers: [
        EventConsumerService,
        { provide: TelegramAlertService, useValue: mockTelegramService },
      ],
    }).compile();

    await module.init();

    service = module.get(EventConsumerService);
    emitter = module.get(EventEmitter2);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('wildcard event subscription (AC #1)', () => {
    it('should receive events via onAny listener', async () => {
      const event = makeBaseEvent();
      emitter.emit(EVENT_NAMES.ORDER_FILLED, event);

      await new Promise((r) => setTimeout(r, 50));

      const metrics = service.getMetrics();
      expect(metrics.totalEventsProcessed).toBeGreaterThan(0);
      expect(metrics.eventCounts[EVENT_NAMES.ORDER_FILLED]).toBe(1);
    });

    it('should receive events from different namespaces', async () => {
      emitter.emit(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      emitter.emit(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());
      emitter.emit(EVENT_NAMES.PLATFORM_HEALTH_DEGRADED, makeBaseEvent());
      emitter.emit(EVENT_NAMES.ORDERBOOK_UPDATED, makeBaseEvent());

      await new Promise((r) => setTimeout(r, 50));

      const metrics = service.getMetrics();
      expect(metrics.eventCounts[EVENT_NAMES.ORDER_FILLED]).toBe(1);
      expect(metrics.eventCounts[EVENT_NAMES.LIMIT_BREACHED]).toBe(1);
      expect(metrics.eventCounts[EVENT_NAMES.PLATFORM_HEALTH_DEGRADED]).toBe(1);
      expect(metrics.eventCounts[EVENT_NAMES.ORDERBOOK_UPDATED]).toBe(1);
    });

    it('should capture future/unknown events automatically', async () => {
      emitter.emit('some.future.event', makeBaseEvent());

      await new Promise((r) => setTimeout(r, 50));

      const metrics = service.getMetrics();
      expect(metrics.eventCounts['some.future.event']).toBe(1);
    });
  });

  describe('severity classification (AC #2)', () => {
    it('should classify critical events correctly', () => {
      const criticalEvents = [
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        EVENT_NAMES.LIMIT_BREACHED,
        EVENT_NAMES.SYSTEM_TRADING_HALTED,
        EVENT_NAMES.SYSTEM_HEALTH_CRITICAL,
        EVENT_NAMES.RECONCILIATION_DISCREPANCY,
        EVENT_NAMES.TIME_DRIFT_HALT,
        EVENT_NAMES.RESOLUTION_DIVERGED,
      ];

      for (const eventName of criticalEvents) {
        expect(service.classifyEventSeverity(eventName)).toBe('critical');
      }
    });

    it('should classify warning events correctly', () => {
      const warningEvents = [
        EVENT_NAMES.EXECUTION_FAILED,
        EVENT_NAMES.LIMIT_APPROACHED,
        EVENT_NAMES.PLATFORM_HEALTH_DEGRADED,
        EVENT_NAMES.TIME_DRIFT_CRITICAL,
        EVENT_NAMES.TIME_DRIFT_WARNING,
        EVENT_NAMES.DEGRADATION_PROTOCOL_ACTIVATED,
      ];

      for (const eventName of warningEvents) {
        expect(service.classifyEventSeverity(eventName)).toBe('warning');
      }
    });

    it('should classify info events correctly', () => {
      const infoEvents = [
        EVENT_NAMES.ORDER_FILLED,
        EVENT_NAMES.EXIT_TRIGGERED,
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        EVENT_NAMES.SINGLE_LEG_EXPOSURE_REMINDER,
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        EVENT_NAMES.OPPORTUNITY_FILTERED,
        EVENT_NAMES.PLATFORM_HEALTH_UPDATED,
        EVENT_NAMES.PLATFORM_HEALTH_RECOVERED,
        EVENT_NAMES.PLATFORM_HEALTH_DISCONNECTED,
        EVENT_NAMES.ORDERBOOK_UPDATED,
        EVENT_NAMES.OVERRIDE_APPLIED,
        EVENT_NAMES.OVERRIDE_DENIED,
        EVENT_NAMES.BUDGET_RESERVED,
        EVENT_NAMES.BUDGET_COMMITTED,
        EVENT_NAMES.BUDGET_RELEASED,
        EVENT_NAMES.DEGRADATION_PROTOCOL_DEACTIVATED,
        EVENT_NAMES.RECONCILIATION_COMPLETE,
        EVENT_NAMES.SYSTEM_TRADING_RESUMED,
        EVENT_NAMES.PLATFORM_GAS_UPDATED,
        EVENT_NAMES.RESOLUTION_POLL_COMPLETED,
        EVENT_NAMES.CALIBRATION_COMPLETED,
      ];

      for (const eventName of infoEvents) {
        expect(service.classifyEventSeverity(eventName)).toBe('info');
      }
    });

    it('should default unknown events to info severity', () => {
      expect(service.classifyEventSeverity('some.unknown.event')).toBe('info');
    });

    it('should classify all events in the catalog', () => {
      for (const eventName of Object.values(EVENT_NAMES)) {
        const severity = service.classifyEventSeverity(eventName);
        expect(['critical', 'warning', 'info']).toContain(severity);
      }
    });
  });

  describe('severity routing (AC #2)', () => {
    it('should route critical events to Telegram + structured log', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      service.handleEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, makeBaseEvent());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          severity: 'critical',
          module: 'monitoring',
        }),
      );
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.anything(),
      );
    });

    it('should route warning events to Telegram + structured log', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      service.handleEvent(EVENT_NAMES.EXECUTION_FAILED, makeBaseEvent());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: EVENT_NAMES.EXECUTION_FAILED,
          severity: 'warning',
          module: 'monitoring',
        }),
      );
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.EXECUTION_FAILED,
        expect.anything(),
      );
    });

    it('should route eligible info events to Telegram + structured log', () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');

      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: EVENT_NAMES.ORDER_FILLED,
          severity: 'info',
          module: 'monitoring',
        }),
      );
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.ORDER_FILLED,
        expect.anything(),
      );
    });

    it('should route non-eligible info events to log only (no Telegram)', () => {
      service.handleEvent(EVENT_NAMES.ORDERBOOK_UPDATED, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).not.toHaveBeenCalled();
    });

    it('should not send budget events to Telegram', () => {
      service.handleEvent(EVENT_NAMES.BUDGET_RESERVED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.BUDGET_COMMITTED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.BUDGET_RELEASED, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).not.toHaveBeenCalled();
    });

    it('should send new critical events to Telegram even without formatter', () => {
      // A future critical event like time.drift.halt has no formatter yet
      service.handleEvent(EVENT_NAMES.TIME_DRIFT_HALT, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.TIME_DRIFT_HALT,
        expect.anything(),
      );
    });

    it('should send new warning events to Telegram even without formatter', () => {
      service.handleEvent(EVENT_NAMES.TIME_DRIFT_CRITICAL, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.TIME_DRIFT_CRITICAL,
        expect.anything(),
      );
    });
  });

  describe('error isolation (AC #5)', () => {
    it('should catch and log handler errors without propagating', () => {
      mockTelegramService.sendEventAlert.mockImplementationOnce(() => {
        throw new Error('Telegram exploded');
      });

      // Should NOT throw
      expect(() =>
        service.handleEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, makeBaseEvent()),
      ).not.toThrow();
    });

    it('should increment errorsCount when handler fails', () => {
      mockTelegramService.sendEventAlert.mockImplementationOnce(() => {
        throw new Error('fail');
      });

      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      expect(service.getMetrics().errorsCount).toBe(1);
    });

    it('should continue processing after handler error', () => {
      mockTelegramService.sendEventAlert.mockImplementationOnce(() => {
        throw new Error('fail');
      });

      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      expect(service.getMetrics().totalEventsProcessed).toBe(2);
    });

    it('should log error with event context', () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      mockTelegramService.sendEventAlert.mockImplementationOnce(() => {
        throw new Error('Telegram exploded');
      });

      service.handleEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, makeBaseEvent());

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Event consumer handler error',
          eventName: EVENT_NAMES.SINGLE_LEG_EXPOSURE,
          correlationId: 'test-corr-123',
          code: 4007,
        }),
      );
    });
  });

  describe('metrics (AC #7)', () => {
    it('should increment counters for each event', () => {
      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      const metrics = service.getMetrics();
      expect(metrics.totalEventsProcessed).toBe(3);
      expect(metrics.eventCounts[EVENT_NAMES.ORDER_FILLED]).toBe(2);
      expect(metrics.eventCounts[EVENT_NAMES.LIMIT_BREACHED]).toBe(1);
    });

    it('should increment severity counters correctly', () => {
      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()); // info
      service.handleEvent(EVENT_NAMES.EXECUTION_FAILED, makeBaseEvent()); // warning
      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent()); // critical

      const metrics = service.getMetrics();
      expect(metrics.severityCounts.info).toBe(1);
      expect(metrics.severityCounts.warning).toBe(1);
      expect(metrics.severityCounts.critical).toBe(1);
    });

    it('should update lastEventTimestamp', () => {
      expect(service.getMetrics().lastEventTimestamp).toBeNull();

      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      expect(service.getMetrics().lastEventTimestamp).toBeInstanceOf(Date);
    });

    it('should return shallow copies to prevent external mutation', () => {
      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      const metrics1 = service.getMetrics();
      metrics1.eventCounts['injected'] = 999;
      metrics1.severityCounts.critical = 999;

      const metrics2 = service.getMetrics();
      expect(metrics2.eventCounts['injected']).toBeUndefined();
      expect(metrics2.severityCounts.critical).toBe(0);
    });

    it('should reset all counters on resetMetrics()', () => {
      service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      service.resetMetrics();

      const metrics = service.getMetrics();
      expect(metrics.totalEventsProcessed).toBe(0);
      expect(metrics.eventCounts).toEqual({});
      expect(metrics.severityCounts).toEqual({
        critical: 0,
        warning: 0,
        info: 0,
      });
      expect(metrics.lastEventTimestamp).toBeNull();
      expect(metrics.errorsCount).toBe(0);
    });
  });

  describe('structured logging', () => {
    it('should include correlationId in log entries', () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      const event = makeBaseEvent({
        correlationId: 'corr-abc',
      } as Partial<BaseEvent>);

      service.handleEvent(EVENT_NAMES.ORDER_FILLED, event);

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'corr-abc',
        }),
      );
    });
  });

  describe('lifecycle', () => {
    it('should clean up onAny listener on module destroy', () => {
      const initialCount = emitter.listenersAny().length;
      expect(initialCount).toBeGreaterThan(0);

      service.onModuleDestroy();

      expect(emitter.listenersAny().length).toBe(initialCount - 1);
    });
  });

  describe('re-entrancy guard', () => {
    it('should skip Telegram delegation for re-entrant calls', () => {
      // Simulate re-entrancy: Telegram handler triggers another event during sendEventAlert
      mockTelegramService.sendEventAlert.mockImplementationOnce(() =>
        service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent()),
      );

      service.handleEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, makeBaseEvent());

      const metrics = service.getMetrics();
      // Both events should be counted (metrics/logging still work)
      expect(metrics.totalEventsProcessed).toBe(2);
      // But sendEventAlert should only be called once (for the outer event)
      // The re-entrant call's Telegram delegation is skipped
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        expect.anything(),
      );
    });
  });

  describe('CSV trade logging delegation (Story 6.3)', () => {
    let csvModule: TestingModule;
    let csvService: EventConsumerService;
    let mockCsvTradeLog: { logTrade: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      mockCsvTradeLog = {
        logTrade: vi.fn().mockResolvedValue(undefined),
      };

      csvModule = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        ],
        providers: [
          EventConsumerService,
          { provide: TelegramAlertService, useValue: mockTelegramService },
          { provide: CsvTradeLogService, useValue: mockCsvTradeLog },
        ],
      }).compile();

      await csvModule.init();
      csvService = csvModule.get(EventConsumerService);
    });

    afterEach(async () => {
      await csvModule.close();
    });

    it('should delegate ORDER_FILLED events to CsvTradeLogService', () => {
      const event = {
        ...makeBaseEvent(),
        platform: 'KALSHI',
        side: 'buy',
        price: 0.55,
        size: 100,
        fillPrice: 0.5501,
        fillSize: 100,
        positionId: 'pos-123',
        isPaper: false,
      };

      csvService.handleEvent(EVENT_NAMES.ORDER_FILLED, event as never);

      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledTimes(1);
      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'KALSHI',
          side: 'buy',
          positionId: 'pos-123',
          isPaper: false,
        }),
      );
    });

    it('should delegate EXIT_TRIGGERED events to CsvTradeLogService', () => {
      const event = {
        ...makeBaseEvent(),
        positionId: 'pos-456',
        pairId: 'pair-789',
        exitType: 'take_profit',
        initialEdge: '0.012',
        finalEdge: '0.003',
        realizedPnl: '5.50',
        isPaper: true,
      };

      csvService.handleEvent(EVENT_NAMES.EXIT_TRIGGERED, event as never);

      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledTimes(1);
      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          pnl: '5.50',
          pairId: 'pair-789',
          isPaper: true,
        }),
      );
    });

    it('should NOT delegate non-trade events to CsvTradeLogService', () => {
      csvService.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      expect(mockCsvTradeLog.logTrade).not.toHaveBeenCalled();
    });
  });

  describe('audit log integration (Story 6.5)', () => {
    let auditModule: TestingModule;
    let auditService: EventConsumerService;
    let mockAuditLogService: { append: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      mockAuditLogService = {
        append: vi.fn().mockResolvedValue(undefined),
      };

      auditModule = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        ],
        providers: [
          EventConsumerService,
          { provide: TelegramAlertService, useValue: mockTelegramService },
          {
            provide: AuditLogService,
            useValue: mockAuditLogService,
          },
        ],
      }).compile();

      await auditModule.init();
      auditService = auditModule.get(EventConsumerService);
    });

    afterEach(async () => {
      await auditModule.close();
    });

    it('should call audit log append for events', async () => {
      auditService.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      // Wait for fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(mockAuditLogService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: EVENT_NAMES.ORDER_FILLED,
          module: 'execution',
          correlationId: 'test-corr-123',
        }),
      );
    });

    it('should extract module from dot-notation event name', () => {
      expect(auditService.extractModule('execution.order.filled')).toBe(
        'execution',
      );
      expect(auditService.extractModule('risk.limit.breached')).toBe('risk');
      expect(auditService.extractModule('platform.health.degraded')).toBe(
        'platform',
      );
    });

    it('should sanitize event for audit', () => {
      const result = auditService.sanitizeEventForAudit({
        timestamp: new Date('2024-01-01'),
        correlationId: 'test',
        extra: 'data',
      });

      expect(result).toEqual(
        expect.objectContaining({
          correlationId: 'test',
          extra: 'data',
        }),
      );
    });

    it('should NOT audit monitoring.audit.* events (circular prevention)', async () => {
      auditService.handleEvent(
        'monitoring.audit.write_failed',
        makeBaseEvent(),
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAuditLogService.append).not.toHaveBeenCalled();
    });

    it('should not block event routing on audit failure', () => {
      mockAuditLogService.append.mockRejectedValue(new Error('DB down'));

      // Should NOT throw
      expect(() =>
        auditService.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()),
      ).not.toThrow();
    });
  });

  describe('audit log not injected', () => {
    it('should work when AuditLogService is not injected', () => {
      // The default `service` from beforeEach does not inject AuditLogService
      expect(() =>
        service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()),
      ).not.toThrow();
    });
  });

  describe('paper mode notification dedup (Story 6.5.5d)', () => {
    let paperModule: TestingModule;
    let paperService: EventConsumerService;
    let mockAuditLog: { append: ReturnType<typeof vi.fn> };

    function makePaperConfigService(
      kalshiMode = 'paper',
      polymarketMode = 'live',
    ): Partial<ConfigService> {
      return {
        get: vi.fn((key: string, defaultValue?: string) => {
          if (key === 'PLATFORM_MODE_KALSHI') return kalshiMode;
          if (key === 'PLATFORM_MODE_POLYMARKET') return polymarketMode;
          return defaultValue;
        }),
      };
    }

    function makeOpportunityEvent(
      pairId: string | number | undefined,
    ): BaseEvent {
      const opp: Record<string, unknown> = {
        netEdge: 0.01,
        grossEdge: 0.02,
        buyPlatformId: 'kalshi',
        sellPlatformId: 'polymarket',
      };
      if (pairId !== undefined) opp['pairId'] = pairId;
      return {
        ...makeBaseEvent(),
        opportunity: opp,
      } as unknown as BaseEvent;
    }

    function makeExitEvent(pairId: string): BaseEvent {
      return {
        ...makeBaseEvent(),
        pairId,
        positionId: 'pos-1',
        exitType: 'take_profit',
      } as unknown as BaseEvent;
    }

    function makeSingleLegResolvedEvent(pairId: string): BaseEvent {
      return {
        ...makeBaseEvent(),
        pairId,
        positionId: 'pos-1',
        resolutionType: 'retried',
      } as unknown as BaseEvent;
    }

    beforeEach(async () => {
      mockAuditLog = {
        append: vi.fn().mockResolvedValue(undefined),
      };

      paperModule = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        ],
        providers: [
          EventConsumerService,
          { provide: TelegramAlertService, useValue: mockTelegramService },
          {
            provide: ConfigService,
            useValue: makePaperConfigService(),
          },
          { provide: AuditLogService, useValue: mockAuditLog },
        ],
      }).compile();

      await paperModule.init();
      paperService = paperModule.get(EventConsumerService);
    });

    afterEach(async () => {
      await paperModule.close();
    });

    it('should suppress repeat Telegram notification for same pair in paper mode', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
    });

    it('should allow different pairs in paper mode', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-B'),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(2);
    });

    it('should allow re-notification after EXIT_TRIGGERED clears pair', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.EXIT_TRIGGERED,
        makeExitEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );

      // 3 calls: opportunity(1) + exit_triggered + opportunity(2 after clear)
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(3);
      // Verify the re-notification happened for OPPORTUNITY_IDENTIFIED (called twice)
      const oppCalls = mockTelegramService.sendEventAlert.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      );
      expect(oppCalls).toHaveLength(2);
    });

    it('should allow re-notification after SINGLE_LEG_RESOLVED clears pair', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.SINGLE_LEG_RESOLVED,
        makeSingleLegResolvedEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );

      // 3 calls: opportunity(1) + single_leg_resolved + opportunity(2 after clear)
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(3);
      const oppCalls = mockTelegramService.sendEventAlert.mock.calls.filter(
        (call: unknown[]) => call[0] === EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      );
      expect(oppCalls).toHaveLength(2);
    });

    it('should NOT suppress in live mode (zero behavioral change)', async () => {
      const liveModule = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        ],
        providers: [
          EventConsumerService,
          { provide: TelegramAlertService, useValue: mockTelegramService },
          {
            provide: ConfigService,
            useValue: makePaperConfigService('live', 'live'),
          },
        ],
      }).compile();

      await liveModule.init();
      const liveService = liveModule.get(EventConsumerService);

      liveService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      liveService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(2);

      await liveModule.close();
    });

    it('should handle missing pairId gracefully (no crash, sends Telegram)', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent(undefined),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
    });

    it('should handle non-string pairId gracefully (sends Telegram)', () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent(123 as unknown as string),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
    });

    it('should record suppression in audit trail', async () => {
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-A'),
      );

      await new Promise((r) => setTimeout(r, 10));

      // Find the suppression audit call (not the regular event audit calls)
      const suppressionCall = mockAuditLog.append.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>).eventType ===
          'monitoring.telegram.suppressed',
      );
      expect(suppressionCall).toBeDefined();
      expect(suppressionCall![0]).toMatchObject({
        eventType: 'monitoring.telegram.suppressed',
        module: 'monitoring',
        details: { reason: 'paper_mode_dedup', pairId: 'pair-A' },
      });
    });

    it('should log paper mode status at startup', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');

      const startupModule = await Test.createTestingModule({
        imports: [
          EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        ],
        providers: [
          EventConsumerService,
          { provide: TelegramAlertService, useValue: mockTelegramService },
          {
            provide: ConfigService,
            useValue: makePaperConfigService(),
          },
        ],
      }).compile();

      await startupModule.init();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            'Paper mode notification dedup: ENABLED',
          ) as string,
          module: 'monitoring',
        }),
      );

      await startupModule.close();
    });

    it('should evict notified set on overflow (1000 pairs)', () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      // Fill to capacity by sending 1000 unique pairs
      for (let i = 0; i < 1000; i++) {
        paperService.handleEvent(
          EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
          makeOpportunityEvent(`pair-${i}`),
        );
      }
      mockTelegramService.sendEventAlert.mockClear();

      // The 1001st should trigger overflow clear + send Telegram
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-overflow'),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Notified pairs set overflow, cleared',
        }),
      );

      // After clear, previously-seen pairs should send Telegram again
      mockTelegramService.sendEventAlert.mockClear();
      paperService.handleEvent(
        EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
        makeOpportunityEvent('pair-0'),
      );
      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('summarizeEvent serialization (AC #4)', () => {
    // Access private method for unit testing
    function summarize(event: BaseEvent): Record<string, unknown> | string {
      return service['summarizeEvent'](event);
    }

    it('should serialize Date values to ISO strings', () => {
      const event = makeBaseEvent({
        timestamp: new Date('2026-03-01T12:00:00.000Z'),
      });
      const result = summarize(event) as Record<string, unknown>;
      expect(result['timestamp']).toBe('2026-03-01T12:00:00.000Z');
    });

    it('should serialize arrays as actual arrays', () => {
      const event = {
        ...makeBaseEvent(),
        healthyPlatforms: ['kalshi', 'polymarket'],
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['healthyPlatforms']).toEqual(['kalshi', 'polymarket']);
    });

    it('should serialize array of Dates as array of ISO strings', () => {
      const event = {
        ...makeBaseEvent(),
        dates: [new Date('2026-01-01'), new Date('2026-02-01')],
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['dates']).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ]);
    });

    it('should serialize Decimal instances to string', () => {
      const event = {
        ...makeBaseEvent(),
        price: new Decimal('0.55'),
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['price']).toBe('0.55');
    });

    it('should serialize nested plain objects recursively', () => {
      const event = {
        ...makeBaseEvent(),
        impactSummary: { pollingCycleCount: 3, reason: 'websocket_timeout' },
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['impactSummary']).toEqual({
        pollingCycleCount: 3,
        reason: 'websocket_timeout',
      });
    });

    it('should passthrough null', () => {
      const event = {
        ...makeBaseEvent(),
        lastDataTimestamp: null,
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['lastDataTimestamp']).toBeNull();
    });

    it('should passthrough primitives', () => {
      const event = {
        ...makeBaseEvent(),
        count: 42,
        active: true,
        label: 'test',
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      expect(result['count']).toBe(42);
      expect(result['active']).toBe(true);
      expect(result['label']).toBe('test');
    });

    it('should never produce [object] in any output', () => {
      const event = {
        ...makeBaseEvent(),
        nested: { a: { b: 'deep' } },
        arr: [1, 2, 3],
        date: new Date(),
        decimal: new Decimal('1.5'),
      } as unknown as BaseEvent;
      const result = summarize(event);
      const json = JSON.stringify(result);
      expect(json).not.toContain('[object]');
    });

    it('should handle circular references with [Circular]', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj['self'] = obj;
      const event = {
        ...makeBaseEvent(),
        circular: obj,
      } as unknown as BaseEvent;
      const result = summarize(event) as Record<string, unknown>;
      const circular = result['circular'] as Record<string, unknown>;
      expect(circular['self']).toBe('[Circular]');
    });

    it('should handle deep nesting (>10 levels) with [MaxDepth]', () => {
      let obj: Record<string, unknown> = { value: 'bottom' };
      for (let i = 0; i < 15; i++) {
        obj = { nested: obj };
      }
      const event = {
        ...makeBaseEvent(),
        deep: obj,
      } as unknown as BaseEvent;
      const result = summarize(event);
      const json = JSON.stringify(result);
      expect(json).toContain('[MaxDepth]');
    });

    it('should return fallback object on serialization error', () => {
      // Create a getter that throws
      const badEvent = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(badEvent, 'timestamp', {
        get() {
          return new Date();
        },
        enumerable: true,
      });
      Object.defineProperty(badEvent, 'correlationId', {
        get() {
          return 'test';
        },
        enumerable: true,
      });
      Object.defineProperty(badEvent, 'bomb', {
        get() {
          throw new Error('serialization bomb');
        },
        enumerable: true,
      });

      const result = summarize(badEvent as unknown as BaseEvent) as Record<
        string,
        unknown
      >;
      expect(result['error']).toBe('serialization_failed');
    });
  });
});
