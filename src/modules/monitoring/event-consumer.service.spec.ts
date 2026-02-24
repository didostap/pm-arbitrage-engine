import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { EventConsumerService } from './event-consumer.service.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { AuditLogService } from './audit-log.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
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
      sendEventAlert: vi.fn().mockResolvedValue(undefined),
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
    it('should route critical events to Telegram + structured log', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      await service.handleEvent(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        makeBaseEvent(),
      );

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

    it('should route warning events to Telegram + structured log', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');

      await service.handleEvent(EVENT_NAMES.EXECUTION_FAILED, makeBaseEvent());

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

    it('should route eligible info events to Telegram + structured log', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');

      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

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

    it('should route non-eligible info events to log only (no Telegram)', async () => {
      await service.handleEvent(EVENT_NAMES.ORDERBOOK_UPDATED, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).not.toHaveBeenCalled();
    });

    it('should not send budget events to Telegram', async () => {
      await service.handleEvent(EVENT_NAMES.BUDGET_RESERVED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.BUDGET_COMMITTED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.BUDGET_RELEASED, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).not.toHaveBeenCalled();
    });

    it('should send new critical events to Telegram even without formatter', async () => {
      // A future critical event like time.drift.halt has no formatter yet
      await service.handleEvent(EVENT_NAMES.TIME_DRIFT_HALT, makeBaseEvent());

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.TIME_DRIFT_HALT,
        expect.anything(),
      );
    });

    it('should send new warning events to Telegram even without formatter', async () => {
      await service.handleEvent(
        EVENT_NAMES.TIME_DRIFT_CRITICAL,
        makeBaseEvent(),
      );

      expect(mockTelegramService.sendEventAlert).toHaveBeenCalledWith(
        EVENT_NAMES.TIME_DRIFT_CRITICAL,
        expect.anything(),
      );
    });
  });

  describe('error isolation (AC #5)', () => {
    it('should catch and log handler errors without propagating', async () => {
      mockTelegramService.sendEventAlert.mockRejectedValueOnce(
        new Error('Telegram exploded'),
      );

      // Should NOT throw
      await expect(
        service.handleEvent(EVENT_NAMES.SINGLE_LEG_EXPOSURE, makeBaseEvent()),
      ).resolves.toBeUndefined();
    });

    it('should increment errorsCount when handler fails', async () => {
      mockTelegramService.sendEventAlert.mockRejectedValueOnce(
        new Error('fail'),
      );

      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      expect(service.getMetrics().errorsCount).toBe(1);
    });

    it('should continue processing after handler error', async () => {
      mockTelegramService.sendEventAlert.mockRejectedValueOnce(
        new Error('fail'),
      );
      mockTelegramService.sendEventAlert.mockResolvedValueOnce(undefined);

      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      expect(service.getMetrics().totalEventsProcessed).toBe(2);
    });

    it('should log error with event context', async () => {
      const errorSpy = vi.spyOn(Logger.prototype, 'error');
      mockTelegramService.sendEventAlert.mockRejectedValueOnce(
        new Error('Telegram exploded'),
      );

      await service.handleEvent(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        makeBaseEvent(),
      );

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
    it('should increment counters for each event', async () => {
      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

      const metrics = service.getMetrics();
      expect(metrics.totalEventsProcessed).toBe(3);
      expect(metrics.eventCounts[EVENT_NAMES.ORDER_FILLED]).toBe(2);
      expect(metrics.eventCounts[EVENT_NAMES.LIMIT_BREACHED]).toBe(1);
    });

    it('should increment severity counters correctly', async () => {
      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()); // info
      await service.handleEvent(EVENT_NAMES.EXECUTION_FAILED, makeBaseEvent()); // warning
      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent()); // critical

      const metrics = service.getMetrics();
      expect(metrics.severityCounts.info).toBe(1);
      expect(metrics.severityCounts.warning).toBe(1);
      expect(metrics.severityCounts.critical).toBe(1);
    });

    it('should update lastEventTimestamp', async () => {
      expect(service.getMetrics().lastEventTimestamp).toBeNull();

      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      expect(service.getMetrics().lastEventTimestamp).toBeInstanceOf(Date);
    });

    it('should return shallow copies to prevent external mutation', async () => {
      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

      const metrics1 = service.getMetrics();
      metrics1.eventCounts['injected'] = 999;
      metrics1.severityCounts.critical = 999;

      const metrics2 = service.getMetrics();
      expect(metrics2.eventCounts['injected']).toBeUndefined();
      expect(metrics2.severityCounts.critical).toBe(0);
    });

    it('should reset all counters on resetMetrics()', async () => {
      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());
      await service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

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
    it('should include correlationId in log entries', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log');
      const event = makeBaseEvent({
        correlationId: 'corr-abc',
      } as Partial<BaseEvent>);

      await service.handleEvent(EVENT_NAMES.ORDER_FILLED, event);

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
    it('should skip Telegram delegation for re-entrant calls', async () => {
      // Simulate re-entrancy: Telegram handler triggers another event during sendEventAlert
      mockTelegramService.sendEventAlert.mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        () => service.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent()),
      );

      await service.handleEvent(
        EVENT_NAMES.SINGLE_LEG_EXPOSURE,
        makeBaseEvent(),
      );

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

    it('should delegate ORDER_FILLED events to CsvTradeLogService', async () => {
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

      await csvService.handleEvent(EVENT_NAMES.ORDER_FILLED, event as never);

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

    it('should delegate EXIT_TRIGGERED events to CsvTradeLogService', async () => {
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

      await csvService.handleEvent(EVENT_NAMES.EXIT_TRIGGERED, event as never);

      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledTimes(1);
      expect(mockCsvTradeLog.logTrade).toHaveBeenCalledWith(
        expect.objectContaining({
          pnl: '5.50',
          pairId: 'pair-789',
          isPaper: true,
        }),
      );
    });

    it('should NOT delegate non-trade events to CsvTradeLogService', async () => {
      await csvService.handleEvent(EVENT_NAMES.LIMIT_BREACHED, makeBaseEvent());

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
      await auditService.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent());

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
      await auditService.handleEvent(
        'monitoring.audit.write_failed',
        makeBaseEvent(),
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(mockAuditLogService.append).not.toHaveBeenCalled();
    });

    it('should not block event routing on audit failure', async () => {
      mockAuditLogService.append.mockRejectedValue(new Error('DB down'));

      // Should NOT throw
      await expect(
        auditService.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()),
      ).resolves.toBeUndefined();
    });
  });

  describe('audit log not injected', () => {
    it('should work when AuditLogService is not injected', async () => {
      // The default `service` from beforeEach does not inject AuditLogService
      await expect(
        service.handleEvent(EVENT_NAMES.ORDER_FILLED, makeBaseEvent()),
      ).resolves.toBeUndefined();
    });
  });
});
