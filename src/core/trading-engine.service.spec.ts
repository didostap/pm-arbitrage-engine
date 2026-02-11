/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { Test, TestingModule } from '@nestjs/testing';
import { TradingEngineService } from './trading-engine.service';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('TradingEngineService', () => {
  let service: TradingEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TradingEngineService],
    }).compile();

    service = module.get<TradingEngineService>(TradingEngineService);
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
      // Stub the pipeline to throw an error
      vi.spyOn(
        service as any,
        'executePipelinePlaceholder',
      ).mockRejectedValueOnce(new Error('Pipeline error'));

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
      // Mock a long-running cycle that won't complete in time
      vi.spyOn(service as any, 'executePipelinePlaceholder').mockImplementation(
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
