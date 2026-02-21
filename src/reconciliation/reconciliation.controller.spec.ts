import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { StartupReconciliationService } from './startup-reconciliation.service';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { AuthTokenGuard } from '../common/guards/auth-token.guard';
import { ReconciliationResult } from '../common/types/reconciliation.types';

describe('ReconciliationController', () => {
  let controller: ReconciliationController;

  const mockReconciliationService = {
    resolveDiscrepancy: vi.fn(),
    reconcile: vi.fn(),
    getLastRunResult: vi.fn(),
    lastRunAt: null as Date | null,
  };

  const mockPositionRepository = {
    findByStatus: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReconciliationService.lastRunAt = null;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        {
          provide: StartupReconciliationService,
          useValue: mockReconciliationService,
        },
        {
          provide: PositionRepository,
          useValue: mockPositionRepository,
        },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-token' },
        },
        AuthTokenGuard,
      ],
    }).compile();

    controller = module.get<ReconciliationController>(ReconciliationController);
  });

  describe('resolve', () => {
    it('should return 200 with result when acknowledging discrepancy', async () => {
      const resolveResult = {
        success: true,
        positionId: 'pos-123',
        newStatus: 'ACTIVE',
        remainingDiscrepancies: 2,
      };
      mockReconciliationService.resolveDiscrepancy.mockResolvedValue(
        resolveResult,
      );

      const result = await controller.resolve('pos-123', {
        action: 'acknowledge',
        rationale: 'Verified position is correct after manual check',
      });

      expect(result).toEqual({
        data: resolveResult,
        timestamp: expect.any(String) as string,
      });
      expect(mockReconciliationService.resolveDiscrepancy).toHaveBeenCalledWith(
        'pos-123',
        'acknowledge',
        'Verified position is correct after manual check',
      );
    });

    it('should return 200 with result when force closing', async () => {
      const resolveResult = {
        success: true,
        positionId: 'pos-456',
        newStatus: 'CLOSED',
        remainingDiscrepancies: 0,
      };
      mockReconciliationService.resolveDiscrepancy.mockResolvedValue(
        resolveResult,
      );

      const result = await controller.resolve('pos-456', {
        action: 'force_close',
        rationale: 'Position is stale and needs to be closed immediately',
      });

      expect(result).toEqual({
        data: resolveResult,
        timestamp: expect.any(String) as string,
      });
      expect(mockReconciliationService.resolveDiscrepancy).toHaveBeenCalledWith(
        'pos-456',
        'force_close',
        'Position is stale and needs to be closed immediately',
      );
    });

    it('should throw 404 when position not found', async () => {
      mockReconciliationService.resolveDiscrepancy.mockRejectedValue(
        new Error('Position not found: pos-999'),
      );

      try {
        await controller.resolve('pos-999', {
          action: 'acknowledge',
          rationale: 'Attempting to resolve nonexistent position',
        });
        expect.unreachable('Should have thrown HttpException');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(404);
      }
    });

    it('should throw 409 when position is not in RECONCILIATION_REQUIRED state', async () => {
      mockReconciliationService.resolveDiscrepancy.mockRejectedValue(
        new Error(
          'Position pos-789 is not in RECONCILIATION_REQUIRED state (current: ACTIVE)',
        ),
      );

      try {
        await controller.resolve('pos-789', {
          action: 'force_close',
          rationale: 'Trying to resolve an already-active position',
        });
        expect.unreachable('Should have thrown HttpException');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(409);
      }
    });
  });

  describe('run', () => {
    const mockResult: ReconciliationResult = {
      positionsChecked: 5,
      ordersVerified: 10,
      pendingOrdersResolved: 1,
      discrepanciesFound: 0,
      durationMs: 1500,
      platformsUnavailable: [],
      discrepancies: [],
    };

    it('should return 200 with reconciliation result', async () => {
      mockReconciliationService.reconcile.mockResolvedValue(mockResult);

      const result = await controller.run();

      expect(result).toEqual({
        data: mockResult,
        timestamp: expect.any(String) as string,
      });
      expect(mockReconciliationService.reconcile).toHaveBeenCalled();
    });

    it('should throw 429 when run was called less than 30s ago', async () => {
      mockReconciliationService.lastRunAt = new Date();

      try {
        await controller.run();
        expect.unreachable('Should have thrown HttpException');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(429);
        const response = httpError.getResponse() as Record<string, unknown>;
        expect(response).toEqual({
          error: {
            code: 429,
            message: 'Reconciliation was run less than 30 seconds ago',
            severity: 'info',
          },
          timestamp: expect.any(String) as string,
        });
      }
    });

    it('should allow run when lastRunAt is older than 30s', async () => {
      mockReconciliationService.lastRunAt = new Date(Date.now() - 31_000);
      mockReconciliationService.reconcile.mockResolvedValue(mockResult);

      const result = await controller.run();

      expect(result).toEqual({
        data: mockResult,
        timestamp: expect.any(String) as string,
      });
    });
  });

  describe('status', () => {
    it('should return 200 with last run result and outstanding discrepancies', async () => {
      const lastRunResult: ReconciliationResult = {
        positionsChecked: 3,
        ordersVerified: 6,
        pendingOrdersResolved: 0,
        discrepanciesFound: 1,
        durationMs: 800,
        platformsUnavailable: [],
        discrepancies: [],
      };
      const runDate = new Date('2026-01-15T10:00:00.000Z');
      mockReconciliationService.getLastRunResult.mockReturnValue(lastRunResult);
      mockReconciliationService.lastRunAt = runDate;
      mockPositionRepository.findByStatus.mockResolvedValue([
        { positionId: 'pos-1' },
        { positionId: 'pos-2' },
      ]);

      const result = await controller.status();

      expect(result).toEqual({
        data: {
          lastRun: lastRunResult,
          lastRunAt: '2026-01-15T10:00:00.000Z',
          outstandingDiscrepancies: 2,
        },
        timestamp: expect.any(String) as string,
      });
      expect(mockPositionRepository.findByStatus).toHaveBeenCalledWith(
        'RECONCILIATION_REQUIRED',
      );
    });

    it('should return null lastRun when no reconciliation has been run', async () => {
      mockReconciliationService.getLastRunResult.mockReturnValue(null);
      mockReconciliationService.lastRunAt = null;
      mockPositionRepository.findByStatus.mockResolvedValue([]);

      const result = await controller.status();

      expect(result).toEqual({
        data: {
          lastRun: null,
          lastRunAt: null,
          outstandingDiscrepancies: 0,
        },
        timestamp: expect.any(String) as string,
      });
    });
  });
});
