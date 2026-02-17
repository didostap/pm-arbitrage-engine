/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-floating-promises */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TradingEngineService } from './trading-engine.service';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service';
import { DetectionService } from '../modules/arbitrage-detection/detection.service';
import { EdgeCalculatorService } from '../modules/arbitrage-detection/edge-calculator.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FinancialDecimal } from '../common/utils/financial-math';

describe('TradingEngineService', () => {
  let service: TradingEngineService;

  const mockDataIngestionService = {
    ingestCurrentOrderBooks: vi.fn().mockResolvedValue(undefined),
  };

  const mockDetectionService = {
    detectDislocations: vi.fn().mockResolvedValue({
      dislocations: [],
      pairsEvaluated: 0,
      pairsSkipped: 0,
      cycleDurationMs: 0,
    }),
  };

  const mockEdgeCalculator = {
    processDislocations: vi.fn().mockReturnValue({
      opportunities: [],
      filtered: [],
      summary: {
        totalInput: 0,
        totalFiltered: 0,
        totalActionable: 0,
        skippedErrors: 0,
        processingDurationMs: 0,
      },
    }),
  };

  const mockEventEmitter = {
    emit: vi.fn(),
  };

  const mockRiskManager = {
    validatePosition: vi.fn().mockResolvedValue({
      approved: true,
      reason: 'Position within risk limits',
      maxPositionSizeUsd: new FinancialDecimal(300),
      currentOpenPairs: 0,
    }),
    getCurrentExposure: vi.fn(),
    getOpenPositionCount: vi.fn().mockReturnValue(0),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TradingEngineService,
        {
          provide: DataIngestionService,
          useValue: mockDataIngestionService,
        },
        {
          provide: DetectionService,
          useValue: mockDetectionService,
        },
        {
          provide: EdgeCalculatorService,
          useValue: mockEdgeCalculator,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
        {
          provide: 'IRiskManager',
          useValue: mockRiskManager,
        },
      ],
    }).compile();

    service = module.get<TradingEngineService>(TradingEngineService);

    // Clear mocks
    vi.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('executeCycle', () => {
    it('should execute placeholder pipeline and log timing', async () => {
      await service.executeCycle();
      expect(service.isCycleInProgress()).toBe(false);
    });

    it('should skip cycle if shutting down', async () => {
      service.initiateShutdown();
      await service.executeCycle();
      // Should return immediately without incrementing inflightOperations
      expect(service.isCycleInProgress()).toBe(false);
    });

    it('should track in-flight operations', async () => {
      const cyclePromise = service.executeCycle();
      expect(service.isCycleInProgress()).toBe(true);
      await cyclePromise;
      expect(service.isCycleInProgress()).toBe(false);
    });

    it('should log cycle start and completion', async () => {
      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.executeCycle();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('cycle'),
        }),
      );
    });

    it('should handle errors gracefully', async () => {
      // Mock data ingestion to throw an error
      mockDataIngestionService.ingestCurrentOrderBooks.mockRejectedValueOnce(
        new Error('Pipeline error'),
      );

      await expect(service.executeCycle()).resolves.not.toThrow();
      expect(service.isCycleInProgress()).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('should wait for in-flight operations to complete', async () => {
      const cyclePromise = service.executeCycle();
      expect(service.isCycleInProgress()).toBe(true);

      const shutdownPromise = service.waitForShutdown(5000);
      await cyclePromise; // Complete the cycle

      await shutdownPromise;
      expect(service.isCycleInProgress()).toBe(false);
    });

    it('should timeout if operations take too long', async () => {
      // Mock data ingestion to take a long time
      mockDataIngestionService.ingestCurrentOrderBooks.mockImplementation(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second delay
        },
      );

      // Start a cycle but don't await it
      service.executeCycle();

      const startTime = Date.now();
      await service.waitForShutdown(500); // 500ms timeout
      const duration = Date.now() - startTime;

      expect(duration).toBeGreaterThanOrEqual(500);
      expect(duration).toBeLessThan(700); // Should not wait significantly longer
    });

    it('should resolve immediately if no operations in progress', async () => {
      const startTime = Date.now();
      await service.waitForShutdown(5000);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(100); // Should resolve quickly
    });
  });

  describe('risk validation integration', () => {
    it('should call validatePosition for each opportunity', async () => {
      const mockOpportunity = {
        dislocation: {
          pairConfig: {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-1',
          },
        },
        netEdge: new FinancialDecimal(0.05),
      };
      mockEdgeCalculator.processDislocations.mockReturnValueOnce({
        opportunities: [mockOpportunity, mockOpportunity],
        filtered: [],
        summary: {
          totalInput: 2,
          totalFiltered: 0,
          totalActionable: 2,
          skippedErrors: 0,
          processingDurationMs: 1,
        },
      });

      await service.executeCycle();
      expect(mockRiskManager.validatePosition).toHaveBeenCalledTimes(2);
    });

    it('should log approved and rejected decisions separately', async () => {
      const mockOpportunity = {
        dislocation: {
          pairConfig: {
            polymarketContractId: 'poly-1',
            kalshiContractId: 'kalshi-1',
          },
        },
        netEdge: new FinancialDecimal(0.05),
      };
      mockEdgeCalculator.processDislocations.mockReturnValueOnce({
        opportunities: [mockOpportunity],
        filtered: [],
        summary: {
          totalInput: 1,
          totalFiltered: 0,
          totalActionable: 1,
          skippedErrors: 0,
          processingDurationMs: 1,
        },
      });
      mockRiskManager.validatePosition.mockResolvedValueOnce({
        approved: false,
        reason: 'Max open pairs limit reached',
        maxPositionSizeUsd: new FinancialDecimal(300),
        currentOpenPairs: 10,
      });

      const logSpy = vi.spyOn(service['logger'], 'log');
      await service.executeCycle();

      expect(logSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Opportunity rejected'),
        }),
      );
    });
  });

  describe('isCycleInProgress', () => {
    it('should return false when no cycles running', () => {
      expect(service.isCycleInProgress()).toBe(false);
    });

    it('should return true when cycle is running', async () => {
      const cyclePromise = service.executeCycle();
      expect(service.isCycleInProgress()).toBe(true);
      await cyclePromise;
    });
  });
});
