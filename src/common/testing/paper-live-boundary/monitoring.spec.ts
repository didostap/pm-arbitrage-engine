/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Story 10-5.5 — Paper/Live Mode Boundary Tests: Monitoring Module
 *
 * Verifies that paper mode Telegram dedup does not suppress live notifications
 * and that EventConsumer detects config/connector mode mismatch.
 *
 * TDD RED PHASE — all tests use it()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { EventConsumerService } from '../../../modules/monitoring/event-consumer.service';
import { TelegramAlertService } from '../../../modules/monitoring/telegram-alert.service';
import { AuditLogService } from '../../../modules/monitoring/audit-log.service';
import { EVENT_NAMES } from '../../../common/events/event-catalog';
import type { BaseEvent } from '../../../common/events/base.event';

// ──────────────────────────────────────────────────────────────
// Mock helpers
// ──────────────────────────────────────────────────────────────

function createMockEvent(overrides: Record<string, unknown> = {}): BaseEvent {
  return {
    timestamp: new Date(),
    correlationId: 'test-correlation-id',
    ...overrides,
  } as unknown as BaseEvent;
}

function createOpportunityEvent(pairId: string): BaseEvent {
  return createMockEvent({
    opportunity: { pairId },
  });
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describe('Paper/Live Boundary — EventConsumerService', () => {
  let telegramService: { sendEventAlert: ReturnType<typeof vi.fn> };
  let auditLogService: { append: ReturnType<typeof vi.fn> };
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    telegramService = { sendEventAlert: vi.fn() };
    auditLogService = { append: vi.fn().mockResolvedValue(undefined) };
    eventEmitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
  });

  it('[P1] paper mode Telegram dedup does not suppress live notifications', () => {
    // ARRANGE: Create an EventConsumer in paper mode
    // Paper mode is determined by PLATFORM_MODE_KALSHI or PLATFORM_MODE_POLYMARKET = 'paper'
    const paperConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'PLATFORM_MODE_KALSHI') return 'paper';
        if (key === 'PLATFORM_MODE_POLYMARKET') return 'paper';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    const paperConsumer = new EventConsumerService(
      paperConfigService,
      eventEmitter,
      telegramService as unknown as TelegramAlertService,
      undefined, // csvTradeLogService
      auditLogService as unknown as AuditLogService,
    );

    // Suppress onModuleInit to prevent onAny registration
    vi.spyOn(paperConsumer, 'onModuleInit').mockImplementation(() => {});

    // Create a SEPARATE EventConsumer for live mode
    const liveConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'PLATFORM_MODE_KALSHI') return 'live';
        if (key === 'PLATFORM_MODE_POLYMARKET') return 'live';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    const liveConsumer = new EventConsumerService(
      liveConfigService,
      eventEmitter,
      telegramService as unknown as TelegramAlertService,
      undefined,
      auditLogService as unknown as AuditLogService,
    );
    vi.spyOn(liveConsumer, 'onModuleInit').mockImplementation(() => {});

    const pairId = 'pair-dedup-test';
    const oppEvent = createOpportunityEvent(pairId);

    // ACT: Paper consumer sees the opportunity and adds to notifiedPairs
    paperConsumer.handleEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, oppEvent);

    // Reset telegram call count
    telegramService.sendEventAlert.mockClear();

    // Paper consumer sees the SAME opportunity again — should be suppressed
    paperConsumer.handleEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, oppEvent);

    // ASSERT: Paper consumer suppressed the duplicate
    expect(telegramService.sendEventAlert).not.toHaveBeenCalled();

    // ACT: Live consumer sees the same opportunity — should NOT be suppressed
    telegramService.sendEventAlert.mockClear();
    liveConsumer.handleEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, oppEvent);

    // ASSERT: Live consumer sends the Telegram alert regardless of paper dedup state
    // Live mode does NOT use the dedup mechanism (isPaperMode is false)
    expect(telegramService.sendEventAlert).toHaveBeenCalledWith(
      EVENT_NAMES.OPPORTUNITY_IDENTIFIED,
      oppEvent,
    );
  });

  it('[P1] EventConsumer isPaperMode config/connector mismatch detection test', () => {
    // ARRANGE: Create config where one platform is paper and the other is live
    // This is a mixed-mode configuration that should still set isPaperMode = true
    const mixedConfigService = {
      get: vi.fn().mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'PLATFORM_MODE_KALSHI') return 'paper';
        if (key === 'PLATFORM_MODE_POLYMARKET') return 'live';
        return defaultValue;
      }),
    } as unknown as ConfigService;

    const consumer = new EventConsumerService(
      mixedConfigService,
      eventEmitter,
      telegramService as unknown as TelegramAlertService,
      undefined,
      auditLogService as unknown as AuditLogService,
    );
    vi.spyOn(consumer, 'onModuleInit').mockImplementation(() => {});

    // ASSERT: isPaperMode should be true because at least one platform is in paper mode
    // The computation: isPaperMode = kalshiMode === 'paper' || polymarketMode === 'paper'
    // Access through the private field via type casting (test-only)
    const isPaperMode = (consumer as any).isPaperMode;
    expect(isPaperMode).toBe(true);

    // ACT: Process an opportunity event — dedup should be active
    const pairId = 'pair-mixed-mode';
    const oppEvent = createOpportunityEvent(pairId);

    consumer.handleEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, oppEvent);

    // ASSERT: First notification goes through
    expect(telegramService.sendEventAlert).toHaveBeenCalledTimes(1);

    // ACT: Same pair again — should be suppressed in paper mode
    telegramService.sendEventAlert.mockClear();
    consumer.handleEvent(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, oppEvent);
    expect(telegramService.sendEventAlert).not.toHaveBeenCalled();

    // ACT: Critical events should NEVER be suppressed, even in paper mode
    telegramService.sendEventAlert.mockClear();
    const criticalEvent = createMockEvent({ severity: 'critical' });
    consumer.handleEvent(EVENT_NAMES.SYSTEM_HEALTH_CRITICAL, criticalEvent);

    // ASSERT: Critical events bypass all dedup — always sent
    expect(telegramService.sendEventAlert).toHaveBeenCalledTimes(1);
  });
});
