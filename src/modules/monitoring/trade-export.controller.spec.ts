/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { TradeExportController } from './trade-export.controller.js';
import { OrderRepository } from '../../persistence/repositories/order.repository.js';
import { CsvTradeLogService } from './csv-trade-log.service.js';

// Suppress logger output
vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makeMockOrder(overrides = {}) {
  return {
    orderId: 'order-1',
    platform: 'KALSHI',
    contractId: 'contract-1',
    pairId: 'pair-1',
    side: 'buy',
    price: { toString: () => '0.55' },
    size: { toString: () => '100' },
    status: 'FILLED',
    fillPrice: { toString: () => '0.5501' },
    fillSize: { toString: () => '100' },
    isPaper: false,
    createdAt: new Date('2026-02-20T10:00:00Z'),
    updatedAt: new Date('2026-02-20T10:00:00Z'),
    pair: { matchId: 'pair-1' },
    ...overrides,
  };
}

describe('TradeExportController', () => {
  let controller: TradeExportController;
  let mockOrderRepo: {
    findByDateRange: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    mockOrderRepo = {
      findByDateRange: vi.fn().mockResolvedValue([makeMockOrder()]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TradeExportController],
      providers: [
        { provide: OrderRepository, useValue: mockOrderRepo },
        {
          provide: CsvTradeLogService,
          useValue: { isEnabled: vi.fn().mockReturnValue(true) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn((key: string) => {
              if (key === 'OPERATOR_API_TOKEN') return 'test-token';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    controller = module.get(TradeExportController);
  });

  describe('exportTrades', () => {
    it('should return JSON format with standard API response wrapper', async () => {
      const mockReply = {
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'json',
        },
        mockReply as never,
      );

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.any(Array),
          count: 1,
          timestamp: expect.any(String),
        }),
      );
    });

    it('should set correct Content-Type and Content-Disposition for CSV', async () => {
      const mockReply = {
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'csv',
        },
        mockReply as never,
      );

      expect(mockReply.header).toHaveBeenCalledWith('Content-Type', 'text/csv');
      expect(mockReply.header).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="trades-2026-02-20-to-2026-02-21.csv"',
      );
    });

    it('should reject date range >90 days with 400 error', async () => {
      const mockReply = {
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      };

      await controller.exportTrades(
        {
          startDate: '2026-01-01',
          endDate: '2026-06-01',
          format: 'json',
        },
        mockReply as never,
      );

      expect(mockReply.status).toHaveBeenCalledWith(400);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('90'),
          }),
        }),
      );
    });

    it('should return empty array for no results (JSON)', async () => {
      mockOrderRepo.findByDateRange.mockResolvedValue([]);
      const mockReply = {
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'json',
        },
        mockReply as never,
      );

      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [],
          count: 0,
        }),
      );
    });

    it('should return CSV with header only for no results', async () => {
      mockOrderRepo.findByDateRange.mockResolvedValue([]);
      const mockReply = {
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'csv',
        },
        mockReply as never,
      );

      const csvContent = mockReply.send.mock.calls[0]![0] as string;
      expect(csvContent).toContain('timestamp,platform,contract_id');
      // Only header line, no data rows
      const lines = csvContent.trim().split('\n');
      expect(lines.length).toBe(1);
    });

    it('should return 429 after 5 requests per minute', async () => {
      const mockReply = () => ({
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      });

      // Fire 5 requests — all should succeed
      for (let i = 0; i < 5; i++) {
        const reply = mockReply();
        await controller.exportTrades(
          {
            startDate: '2026-02-20',
            endDate: '2026-02-21',
            format: 'json',
          },
          reply as never,
        );
        expect(reply.status).not.toHaveBeenCalledWith(429);
      }

      // 6th request should be rate limited
      const reply6 = mockReply();
      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'json',
        },
        reply6 as never,
      );

      expect(reply6.status).toHaveBeenCalledWith(429);
      expect(reply6.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 4009,
          }),
        }),
      );
    });

    it('should reset rate limit after cooldown period', async () => {
      const mockReply = () => ({
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
        status: vi.fn().mockReturnThis(),
      });

      // Reset rate limiter for clean state
      controller.resetRateLimiter();

      // Fill rate limit
      for (let i = 0; i < 5; i++) {
        await controller.exportTrades(
          {
            startDate: '2026-02-20',
            endDate: '2026-02-21',
            format: 'json',
          },
          mockReply() as never,
        );
      }

      // Manually reset (simulates time passing)
      controller.resetRateLimiter();

      const reply = mockReply();
      await controller.exportTrades(
        {
          startDate: '2026-02-20',
          endDate: '2026-02-21',
          format: 'json',
        },
        reply as never,
      );

      expect(reply.status).not.toHaveBeenCalledWith(429);
    });
  });
});
