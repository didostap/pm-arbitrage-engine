/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DailySummaryService } from './daily-summary.service.js';
import { EventConsumerService } from './event-consumer.service.js';
import { TelegramAlertService } from './telegram-alert.service.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { PositionRepository } from '../../persistence/repositories/position.repository.js';

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

describe('DailySummaryService', () => {
  let service: DailySummaryService;
  let mockEventConsumer: {
    getMetrics: ReturnType<typeof vi.fn>;
  };
  let mockTelegram: {
    enqueueAndSend: ReturnType<typeof vi.fn>;
  };
  let mockCsvTradeLog: {
    appendSummaryRow: ReturnType<typeof vi.fn>;
    isEnabled: ReturnType<typeof vi.fn>;
  };
  let mockOrderRepo: {
    countByDateRange: ReturnType<typeof vi.fn>;
  };
  let mockPositionRepo: {
    countByStatus: ReturnType<typeof vi.fn>;
    countClosedByDateRange: ReturnType<typeof vi.fn>;
    sumClosedEdgeByDateRange: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockEventConsumer = {
      getMetrics: vi.fn().mockReturnValue({
        totalEventsProcessed: 50,
        eventCounts: {
          'detection.opportunity.identified': 10,
          'execution.order.filled': 5,
          'execution.single_leg.exposure': 1,
          'risk.limit.breached': 0,
          'risk.limit.approached': 2,
        },
        severityCounts: { critical: 1, warning: 3, info: 46 },
        lastEventTimestamp: new Date('2026-02-24T23:50:00Z'),
        errorsCount: 2,
      }),
    };

    mockTelegram = {
      enqueueAndSend: vi.fn().mockResolvedValue(undefined),
    };

    mockCsvTradeLog = {
      appendSummaryRow: vi.fn().mockResolvedValue(undefined),
      isEnabled: vi.fn().mockReturnValue(true),
    };

    mockOrderRepo = {
      countByDateRange: vi.fn().mockResolvedValue(12),
    };

    mockPositionRepo = {
      countByStatus: vi.fn().mockResolvedValue(2),
      countClosedByDateRange: vi.fn().mockResolvedValue(3),
      sumClosedEdgeByDateRange: vi.fn().mockResolvedValue('15.50'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailySummaryService,
        { provide: EventConsumerService, useValue: mockEventConsumer },
        { provide: TelegramAlertService, useValue: mockTelegram },
        { provide: CsvTradeLogService, useValue: mockCsvTradeLog },
        { provide: OrderRepository, useValue: mockOrderRepo },
        { provide: PositionRepository, useValue: mockPositionRepo },
      ],
    }).compile();

    service = module.get(DailySummaryService);
  });

  describe('handleDailySummary', () => {
    it('should generate correct summary from DB + metrics', async () => {
      await service.handleDailySummary();

      expect(mockOrderRepo.countByDateRange).toHaveBeenCalled();
      expect(mockPositionRepo.countByStatus).toHaveBeenCalledWith('OPEN');
      expect(mockPositionRepo.countClosedByDateRange).toHaveBeenCalled();
      expect(mockPositionRepo.sumClosedEdgeByDateRange).toHaveBeenCalled();
    });

    it('should write summary CSV row to daily-summaries.csv', async () => {
      await service.handleDailySummary();

      expect(mockCsvTradeLog.appendSummaryRow).toHaveBeenCalledTimes(1);
      expect(mockCsvTradeLog.appendSummaryRow).toHaveBeenCalledWith(
        expect.stringContaining('12'), // total_trades
      );
      expect(mockCsvTradeLog.appendSummaryRow).toHaveBeenCalledWith(
        expect.stringContaining('15.50'), // total_pnl
      );
    });

    it('should send Telegram message with summary', async () => {
      await service.handleDailySummary();

      expect(mockTelegram.enqueueAndSend).toHaveBeenCalledTimes(1);
      expect(mockTelegram.enqueueAndSend).toHaveBeenCalledWith(
        expect.stringContaining('Daily Summary'),
        'info',
      );
    });

    it('should catch and log handler failure (never propagates)', async () => {
      mockOrderRepo.countByDateRange.mockRejectedValue(new Error('DB failure'));
      const errorSpy = vi.spyOn(Logger.prototype, 'error');

      // Should NOT throw
      await expect(service.handleDailySummary()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Daily summary generation failed'),
        }),
      );
    });

    it('should produce zero-count summary for empty day', async () => {
      mockOrderRepo.countByDateRange.mockResolvedValue(0);
      mockPositionRepo.countByStatus.mockResolvedValue(0);
      mockPositionRepo.countClosedByDateRange.mockResolvedValue(0);
      mockPositionRepo.sumClosedEdgeByDateRange.mockResolvedValue('0');
      mockEventConsumer.getMetrics.mockReturnValue({
        totalEventsProcessed: 0,
        eventCounts: {},
        severityCounts: { critical: 0, warning: 0, info: 0 },
        lastEventTimestamp: null,
        errorsCount: 0,
      });

      await service.handleDailySummary();

      expect(mockCsvTradeLog.appendSummaryRow).toHaveBeenCalledTimes(1);
      expect(mockTelegram.enqueueAndSend).toHaveBeenCalledTimes(1);
    });
  });
});
