import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExposureTrackerService } from './exposure-tracker.service';
import { SingleLegExposureEvent } from '../../common/events/execution.events';
import { PlatformId } from '../../common/types/platform.type';
import { EVENT_NAMES } from '../../common/events/event-catalog';
import { PositionRepository } from '../../persistence/repositories/position.repository';

vi.mock('../../common/services/correlation-context', () => ({
  getCorrelationId: () => 'test-correlation-id',
}));

function makeExposureEvent(
  overrides?: Partial<{ positionId: string }>,
): SingleLegExposureEvent {
  return new SingleLegExposureEvent(
    overrides?.positionId ?? 'pos-1',
    'pair-1',
    0.08,
    {
      platform: PlatformId.KALSHI,
      orderId: 'order-1',
      side: 'buy',
      price: 0.45,
      size: 200,
      fillPrice: 0.45,
      fillSize: 200,
    },
    {
      platform: PlatformId.POLYMARKET,
      reason: 'rejected',
      reasonCode: 2004,
      attemptedPrice: 0.55,
      attemptedSize: 182,
    },
    {
      kalshi: { bestBid: 0.44, bestAsk: 0.46 },
      polymarket: { bestBid: 0.54, bestAsk: 0.56 },
    },
    {
      closeNowEstimate: '-3.76',
      retryAtCurrentPrice: 'Retry would yield ~14.18% edge',
      holdRiskAssessment:
        'EXPOSED: $90.00 on kalshi (buy 200@0.45). No hedge. Immediate operator action recommended.',
    },
    ['Monitor position'],
  );
}

function getIsoWeekKey(date: Date): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${d.getUTCFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
}

describe('ExposureTrackerService', () => {
  let service: ExposureTrackerService;
  let eventEmitter: EventEmitter2;
  let positionRepo: { findByStatus: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    positionRepo = {
      findByStatus: vi.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExposureTrackerService,
        EventEmitter2,
        { provide: PositionRepository, useValue: positionRepo },
      ],
    }).compile();

    service = module.get<ExposureTrackerService>(ExposureTrackerService);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
  });

  describe('monthly threshold', () => {
    it('should not emit warning when count is at or below 5', () => {
      const emitSpy = vi.spyOn(eventEmitter, 'emit');

      for (let i = 0; i < 5; i++) {
        service.onSingleLegExposure(
          makeExposureEvent({ positionId: `pos-${i}` }),
        );
      }

      const warningCalls = emitSpy.mock.calls.filter(
        (call) =>
          call[0] === EVENT_NAMES.LIMIT_APPROACHED &&
          typeof call[1] === 'object' &&
          (call[1] as Record<string, unknown>)?.type === 'monthly_exposure',
      );
      expect(warningCalls).toHaveLength(0);
    });

    it('should emit warning when monthly count exceeds 5', () => {
      const emitSpy = vi.spyOn(eventEmitter, 'emit');

      for (let i = 0; i < 6; i++) {
        service.onSingleLegExposure(
          makeExposureEvent({ positionId: `pos-${i}` }),
        );
      }

      const warningCalls = emitSpy.mock.calls.filter(
        (call) =>
          call[0] === EVENT_NAMES.LIMIT_APPROACHED &&
          typeof call[1] === 'object' &&
          (call[1] as Record<string, unknown>)?.type === 'monthly_exposure',
      );
      expect(warningCalls).toHaveLength(1);
    });
  });

  describe('weekly consecutive threshold', () => {
    it('should emit critical warning when 3+ consecutive weeks have >1 event', () => {
      const emitSpy = vi.spyOn(eventEmitter, 'emit');

      // Simulate 3 consecutive weeks with >1 event each
      const now = new Date();

      // Week 1 (2 weeks ago)
      const week1 = new Date(now);
      week1.setUTCDate(week1.getUTCDate() - 14);
      const week1Key = getIsoWeekKey(week1);

      // Week 2 (1 week ago)
      const week2 = new Date(now);
      week2.setUTCDate(week2.getUTCDate() - 7);
      const week2Key = getIsoWeekKey(week2);

      // Directly set internal state for testing
      service['weeklyExposures'].set(week1Key, 2);
      service['weeklyExposures'].set(week2Key, 2);
      service['consecutiveBreachedWeeks'] = 2;
      service['lastEvaluatedWeek'] = week2Key;

      // Now fire 2 events in current week to breach it
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'pos-w3-1' }),
      );
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'pos-w3-2' }),
      );

      const criticalCalls = emitSpy.mock.calls.filter(
        (call) =>
          call[0] === EVENT_NAMES.LIMIT_BREACHED &&
          typeof call[1] === 'object' &&
          (call[1] as Record<string, unknown>)?.type ===
            'weekly_consecutive_exposure',
      );
      expect(criticalCalls).toHaveLength(1);
    });

    it('should reset consecutive count when a week has <=1 event', () => {
      const emitSpy = vi.spyOn(eventEmitter, 'emit');

      // Simulate 2 consecutive breached weeks then a clean week
      const now = new Date();
      const week1 = new Date(now);
      week1.setUTCDate(week1.getUTCDate() - 14);
      const week1Key = getIsoWeekKey(week1);
      const week2 = new Date(now);
      week2.setUTCDate(week2.getUTCDate() - 7);
      const week2Key = getIsoWeekKey(week2);

      service['weeklyExposures'].set(week1Key, 2);
      service['weeklyExposures'].set(week2Key, 1); // NOT breached (<=1)
      service['consecutiveBreachedWeeks'] = 0;
      service['lastEvaluatedWeek'] = week2Key;

      // Fire 2 events this week
      service.onSingleLegExposure(makeExposureEvent({ positionId: 'pos-1' }));
      service.onSingleLegExposure(makeExposureEvent({ positionId: 'pos-2' }));

      // Should not emit critical since previous week had <=1
      const criticalCalls = emitSpy.mock.calls.filter(
        (call) =>
          call[0] === EVENT_NAMES.LIMIT_BREACHED &&
          typeof call[1] === 'object' &&
          (call[1] as Record<string, unknown>)?.type ===
            'weekly_consecutive_exposure',
      );
      expect(criticalCalls).toHaveLength(0);
    });

    it('should evaluate weekly consecutive threshold end-to-end via event flow across week boundaries', () => {
      const emitSpy = vi.spyOn(eventEmitter, 'emit');

      // Simulate 3 consecutive weeks with >1 event each by faking Date.now()
      const baseDate = new Date('2026-01-05T12:00:00Z'); // Monday of Week 2, 2026

      // Week 1: 2 events
      vi.spyOn(Date, 'now').mockReturnValue(baseDate.getTime());
      vi.setSystemTime(baseDate);
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w1-1' }),
      );
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w1-2' }),
      );

      // Week 2: 2 events
      const week2 = new Date(baseDate);
      week2.setUTCDate(week2.getUTCDate() + 7);
      vi.setSystemTime(week2);
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w2-1' }),
      );
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w2-2' }),
      );

      // Week 3: 2 events — should trigger critical warning
      const week3 = new Date(baseDate);
      week3.setUTCDate(week3.getUTCDate() + 14);
      vi.setSystemTime(week3);
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w3-1' }),
      );
      service.onSingleLegExposure(
        makeExposureEvent({ positionId: 'e2e-w3-2' }),
      );

      const criticalCalls = emitSpy.mock.calls.filter(
        (call) =>
          call[0] === EVENT_NAMES.LIMIT_BREACHED &&
          typeof call[1] === 'object' &&
          (call[1] as Record<string, unknown>)?.type ===
            'weekly_consecutive_exposure',
      );
      expect(criticalCalls).toHaveLength(1);
      expect(
        (criticalCalls[0]![1] as Record<string, unknown>).consecutiveWeeks,
      ).toBe(3);

      vi.useRealTimers();
    });
  });

  describe('counter resets', () => {
    it('should track events per calendar month (UTC)', () => {
      const event = makeExposureEvent();
      service.onSingleLegExposure(event);

      const now = new Date();
      const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(service['monthlyExposures'].get(monthKey)).toBe(1);
    });

    it('should track events per ISO week', () => {
      const event = makeExposureEvent();
      service.onSingleLegExposure(event);

      const weekKey = getIsoWeekKey(new Date());
      expect(service['weeklyExposures'].get(weekKey)).toBe(1);
    });
  });

  describe('startup rebuild from DB', () => {
    it('should rebuild counters from positions on module init', async () => {
      const now = new Date();
      positionRepo.findByStatus.mockResolvedValue([
        {
          positionId: 'pos-db-1',
          createdAt: now,
          status: 'SINGLE_LEG_EXPOSED',
        },
        {
          positionId: 'pos-db-2',
          createdAt: now,
          status: 'SINGLE_LEG_EXPOSED',
        },
      ]);

      await service.onModuleInit();

      const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const weekKey = getIsoWeekKey(now);
      expect(service['monthlyExposures'].get(monthKey)).toBe(2);
      expect(service['weeklyExposures'].get(weekKey)).toBe(2);
    });

    it('should rebuild consecutiveBreachedWeeks from historical positions', async () => {
      const now = new Date('2026-02-19T12:00:00Z');
      vi.setSystemTime(now);

      // Create positions spanning 2 previous consecutive breached weeks
      const lastWeek = new Date(now);
      lastWeek.setUTCDate(lastWeek.getUTCDate() - 7);
      const twoWeeksAgo = new Date(now);
      twoWeeksAgo.setUTCDate(twoWeeksAgo.getUTCDate() - 14);

      positionRepo.findByStatus.mockResolvedValue([
        // 2 weeks ago: 2 events (breached)
        {
          positionId: 'pos-w1-1',
          createdAt: twoWeeksAgo,
          status: 'SINGLE_LEG_EXPOSED',
        },
        {
          positionId: 'pos-w1-2',
          createdAt: twoWeeksAgo,
          status: 'SINGLE_LEG_EXPOSED',
        },
        // 1 week ago: 2 events (breached)
        {
          positionId: 'pos-w2-1',
          createdAt: lastWeek,
          status: 'SINGLE_LEG_EXPOSED',
        },
        {
          positionId: 'pos-w2-2',
          createdAt: lastWeek,
          status: 'SINGLE_LEG_EXPOSED',
        },
      ]);

      await service.onModuleInit();

      expect(service['consecutiveBreachedWeeks']).toBe(2);

      vi.useRealTimers();
    });
  });
});
