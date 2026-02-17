/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-misused-promises */
// Disabled for test file: mock implementation typing requires flexible assignment and async mock callbacks

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ExecutionQueueService } from './execution-queue.service';
import { ExecutionLockService } from './execution-lock.service';
import { RISK_MANAGER_TOKEN } from '../risk-management/risk-management.constants';
import { RankedOpportunity } from '../../common/types/risk.type';
import { FinancialDecimal } from '../../common/utils/financial-math';
import { RiskLimitError } from '../../common/errors/risk-limit-error';

function makeRankedOpportunity(
  opportunityId: string,
  netEdge: number,
): RankedOpportunity {
  return {
    opportunity: { id: opportunityId },
    netEdge: new FinancialDecimal(netEdge),
    reservationRequest: {
      opportunityId,
      recommendedPositionSizeUsd: new FinancialDecimal(300),
      pairId: `pair-${opportunityId}`,
    },
  };
}

describe('ExecutionQueueService', () => {
  let service: ExecutionQueueService;
  let mockLockService: {
    acquire: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    isLocked: ReturnType<typeof vi.fn>;
  };
  let mockRiskManager: {
    reserveBudget: ReturnType<typeof vi.fn>;
    commitReservation: ReturnType<typeof vi.fn>;
    releaseReservation: ReturnType<typeof vi.fn>;
    validatePosition: ReturnType<typeof vi.fn>;
    getCurrentExposure: ReturnType<typeof vi.fn>;
    getOpenPositionCount: ReturnType<typeof vi.fn>;
    updateDailyPnl: ReturnType<typeof vi.fn>;
    isTradingHalted: ReturnType<typeof vi.fn>;
    processOverride: ReturnType<typeof vi.fn>;
  };
  let reservationCounter: number;

  beforeEach(async () => {
    reservationCounter = 0;
    mockLockService = {
      acquire: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
      isLocked: vi.fn().mockReturnValue(false),
    };

    mockRiskManager = {
      reserveBudget: vi.fn().mockImplementation((req) => {
        reservationCounter++;
        return Promise.resolve({
          reservationId: `res-${reservationCounter}`,
          opportunityId: req.opportunityId,
          reservedPositionSlots: 1,
          reservedCapitalUsd: new FinancialDecimal(300),
          correlationExposure: new FinancialDecimal(0),
          createdAt: new Date(),
        });
      }),
      commitReservation: vi.fn().mockResolvedValue(undefined),
      releaseReservation: vi.fn().mockResolvedValue(undefined),
      validatePosition: vi.fn(),
      getCurrentExposure: vi.fn(),
      getOpenPositionCount: vi.fn(),
      updateDailyPnl: vi.fn(),
      isTradingHalted: vi.fn(),
      processOverride: vi.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        ExecutionQueueService,
        { provide: ExecutionLockService, useValue: mockLockService },
        { provide: RISK_MANAGER_TOKEN, useValue: mockRiskManager },
      ],
    }).compile();

    service = module.get(ExecutionQueueService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return empty array for empty queue', async () => {
    const results = await service.processOpportunities([]);
    expect(results).toEqual([]);
    expect(mockLockService.acquire).not.toHaveBeenCalled();
  });

  it('should process single opportunity correctly', async () => {
    const results = await service.processOpportunities([
      makeRankedOpportunity('opp-1', 0.05),
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      opportunityId: 'opp-1',
      reserved: true,
      executed: true,
      committed: true,
    });
  });

  it('should acquire lock before each opportunity', async () => {
    await service.processOpportunities([
      makeRankedOpportunity('opp-1', 0.05),
      makeRankedOpportunity('opp-2', 0.03),
    ]);

    expect(mockLockService.acquire).toHaveBeenCalledTimes(2);
    expect(mockLockService.release).toHaveBeenCalledTimes(2);
  });

  it('should reserve budget after lock acquisition', async () => {
    await service.processOpportunities([makeRankedOpportunity('opp-1', 0.05)]);

    // Lock acquired first, then reserve
    const acquireOrder =
      mockLockService.acquire.mock.invocationCallOrder[0] ?? 0;
    const reserveOrder =
      mockRiskManager.reserveBudget.mock.invocationCallOrder[0] ?? 0;
    expect(acquireOrder).toBeLessThan(reserveOrder);
  });

  it('should commit reservation on success', async () => {
    await service.processOpportunities([makeRankedOpportunity('opp-1', 0.05)]);

    expect(mockRiskManager.commitReservation).toHaveBeenCalledWith('res-1');
  });

  it('should release reservation on failure', async () => {
    mockRiskManager.commitReservation.mockRejectedValueOnce(
      new Error('commit failed'),
    );

    const results = await service.processOpportunities([
      makeRankedOpportunity('opp-1', 0.05),
    ]);

    expect(results[0]?.committed).toBe(false);
    expect(mockRiskManager.releaseReservation).toHaveBeenCalledWith('res-1');
  });

  it('should not block subsequent opportunities when one fails reservation', async () => {
    mockRiskManager.reserveBudget
      .mockRejectedValueOnce(
        new RiskLimitError(3005, 'No budget', 'error', 'budget', 0, 0),
      )
      .mockImplementationOnce((req: { opportunityId: string }) => {
        reservationCounter++;
        return Promise.resolve({
          reservationId: `res-${reservationCounter}`,
          opportunityId: req.opportunityId,
          reservedPositionSlots: 1,
          reservedCapitalUsd: new FinancialDecimal(300),
          correlationExposure: new FinancialDecimal(0),
          createdAt: new Date(),
        });
      });

    const results = await service.processOpportunities([
      makeRankedOpportunity('opp-1', 0.05),
      makeRankedOpportunity('opp-2', 0.03),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.reserved).toBe(false);
    expect(results[1]?.reserved).toBe(true);
    expect(results[1]?.committed).toBe(true);
  });

  it('should process opportunities in the order they are given (pre-ranked)', async () => {
    const processOrder: string[] = [];
    mockRiskManager.reserveBudget.mockImplementation(
      (req: { opportunityId: string }) => {
        processOrder.push(req.opportunityId);
        reservationCounter++;
        return Promise.resolve({
          reservationId: `res-${reservationCounter}`,
          opportunityId: req.opportunityId,
          reservedPositionSlots: 1,
          reservedCapitalUsd: new FinancialDecimal(300),
          correlationExposure: new FinancialDecimal(0),
          createdAt: new Date(),
        });
      },
    );

    // Provide already sorted by netEdge desc
    await service.processOpportunities([
      makeRankedOpportunity('opp-high', 0.1),
      makeRankedOpportunity('opp-mid', 0.05),
      makeRankedOpportunity('opp-low', 0.02),
    ]);

    expect(processOrder).toEqual(['opp-high', 'opp-mid', 'opp-low']);
  });
});
