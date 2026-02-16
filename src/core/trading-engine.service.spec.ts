/* eslint-disable @typescript-eslint/no-unsafe-assignment */

/* eslint-disable @typescript-eslint/no-floating-promises */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TradingEngineService } from './trading-engine.service';
import { DataIngestionService } from '../modules/data-ingestion/data-ingestion.service';
import { DetectionService } from '../modules/arbitrage-detection/detection.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

  const mockEventEmitter = {
    emit: vi.fn(),
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
          provide: EventEmitter2,
          useValue: mockEventEmitter,
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
