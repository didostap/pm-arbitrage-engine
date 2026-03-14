import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { MatchAprUpdaterService } from './match-apr-updater.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import { EVENT_NAMES } from '../../common/events/event-catalog.js';
import {
  OpportunityIdentifiedEvent,
  OpportunityFilteredEvent,
} from '../../common/events/detection.events.js';

vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const tick = () => new Promise((r) => setTimeout(r, 50));

describe('MatchAprUpdaterService', () => {
  let module: TestingModule;
  let emitter: EventEmitter2;
  let mockPrisma: {
    contractMatch: {
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    mockPrisma = {
      contractMatch: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    module = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot({
          wildcard: true,
          delimiter: '.',
        }),
      ],
      providers: [
        MatchAprUpdaterService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    await module.init();

    emitter = module.get(EventEmitter2);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('OpportunityIdentifiedEvent', () => {
    it('should update all 3 fields when matchId is present', async () => {
      const enrichedAt = new Date('2026-03-13T10:00:00Z');
      const event = new OpportunityIdentifiedEvent({
        matchId: 'match-1',
        netEdge: 0.025,
        annualizedReturn: 0.42,
        enrichedAt,
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).toHaveBeenCalledWith({
        where: { matchId: 'match-1' },
        data: {
          lastNetEdge: '0.025',
          lastAnnualizedReturn: '0.42',
          lastComputedAt: enrichedAt,
        },
      });
    });

    it('should skip when matchId is missing', async () => {
      const event = new OpportunityIdentifiedEvent({
        netEdge: 0.025,
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).not.toHaveBeenCalled();
    });

    it('should skip when matchId is null', async () => {
      const event = new OpportunityIdentifiedEvent({
        matchId: null,
        netEdge: 0.025,
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).not.toHaveBeenCalled();
    });

    it('should null out lastAnnualizedReturn when annualizedReturn is null', async () => {
      const enrichedAt = new Date('2026-03-13T11:00:00Z');
      const event = new OpportunityIdentifiedEvent({
        matchId: 'match-2',
        netEdge: 0.01,
        annualizedReturn: null,
        enrichedAt,
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown> | undefined;
      expect(data).toBeDefined();
      expect(data?.['lastAnnualizedReturn']).toBeNull();
      expect(data?.['lastNetEdge']).toBe('0.01');
      expect(data?.['lastComputedAt']).toEqual(enrichedAt);
    });

    it('should null out lastNetEdge when netEdge is null', async () => {
      const enrichedAt = new Date('2026-03-13T12:00:00Z');
      const event = new OpportunityIdentifiedEvent({
        matchId: 'match-ne',
        netEdge: null,
        annualizedReturn: 0.25,
        enrichedAt,
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown> | undefined;
      expect(data).toBeDefined();
      expect(data?.['lastNetEdge']).toBeNull();
      expect(data?.['lastAnnualizedReturn']).toBe('0.25');
      expect(data?.['lastComputedAt']).toEqual(enrichedAt);
    });

    it('should catch and log DB errors without throwing', async () => {
      mockPrisma.contractMatch.update.mockRejectedValue(
        new Error('DB connection lost'),
      );

      const event = new OpportunityIdentifiedEvent({
        matchId: 'match-err',
        netEdge: 0.03,
        annualizedReturn: 0.5,
        enrichedAt: new Date(),
        pairId: 'test-pair',
      });

      emitter.emit(EVENT_NAMES.OPPORTUNITY_IDENTIFIED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to update match APR from identified event',
          matchId: 'match-err',
          error: 'DB connection lost',
        }),
      );
    });
  });

  describe('OpportunityFilteredEvent', () => {
    it('should update netEdge and timestamp when matchId is present', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.015'),
        new Decimal('0.008'),
        'below_threshold',
        undefined,
        { matchId: 'match-3' },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(call?.['where']).toEqual({ matchId: 'match-3' });
      const data = call?.['data'] as Record<string, unknown>;
      expect(data['lastNetEdge']).toBe('0.015');
      expect(data['lastComputedAt']).toBeInstanceOf(Date);
      expect(data?.['lastAnnualizedReturn']).toBeNull();
    });

    it('should set annualizedReturn when provided (APR-threshold-filtered)', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.01'),
        new Decimal('0.15'),
        'annualized_return_below_threshold',
        undefined,
        { matchId: 'match-4', annualizedReturn: 0.12 },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown>;
      expect(data['lastAnnualizedReturn']).toBe('0.12');
      expect(data['lastNetEdge']).toBe('0.01');
    });

    it('should skip when matchId is missing', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.005'),
        new Decimal('0.008'),
        'below_threshold',
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).not.toHaveBeenCalled();
    });

    it('should catch and log DB errors without throwing', async () => {
      mockPrisma.contractMatch.update.mockRejectedValue(
        new Error('DB timeout'),
      );

      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.02'),
        new Decimal('0.008'),
        'below_threshold',
        undefined,
        { matchId: 'match-err' },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      expect(mockPrisma.contractMatch.update).toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Failed to update match APR from filtered event',
          matchId: 'match-err',
          error: 'DB timeout',
        }),
      );
    });

    it('should null out APR on negative_edge filtered event', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('-0.005'),
        new Decimal('0.008'),
        'negative_edge',
        undefined,
        { matchId: 'match-neg', annualizedReturn: null },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown>;
      expect(data?.['lastAnnualizedReturn']).toBeNull();
      expect(data?.['lastNetEdge']).toBe('-0.005');
    });

    it('should null out APR on no_resolution_date filtered event', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.02'),
        new Decimal('0.008'),
        'no_resolution_date',
        undefined,
        { matchId: 'match-nrd', annualizedReturn: null },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown>;
      expect(data?.['lastAnnualizedReturn']).toBeNull();
    });

    it('should null out APR on resolution_date_passed filtered event', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.01'),
        new Decimal('0.008'),
        'resolution_date_passed',
        undefined,
        { matchId: 'match-rdp', annualizedReturn: null },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown>;
      expect(data?.['lastAnnualizedReturn']).toBeNull();
    });

    it('should null out lastAnnualizedReturn when event has no computed APR (below_threshold)', async () => {
      const event = new OpportunityFilteredEvent(
        'BTC > $100k',
        new Decimal('0.006'),
        new Decimal('0.008'),
        'below_threshold',
        undefined,
        { matchId: 'match-5', annualizedReturn: null },
      );

      emitter.emit(EVENT_NAMES.OPPORTUNITY_FILTERED, event);
      await tick();

      const call = mockPrisma.contractMatch.update.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      const data = call?.['data'] as Record<string, unknown>;
      expect(data).toBeDefined();
      expect(data?.['lastAnnualizedReturn']).toBeNull();
    });
  });
});
