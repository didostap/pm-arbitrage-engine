import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ExecutionLockService } from './execution-lock.service';

describe('ExecutionLockService', () => {
  let service: ExecutionLockService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [ExecutionLockService],
    }).compile();

    service = module.get(ExecutionLockService);
  });

  afterEach(() => {
    // Ensure lock is released to prevent hanging
    service.release();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should acquire lock when unlocked', async () => {
    expect(service.isLocked()).toBe(false);
    await service.acquire();
    expect(service.isLocked()).toBe(true);
    service.release();
  });

  it('should release lock correctly', async () => {
    await service.acquire();
    expect(service.isLocked()).toBe(true);
    service.release();
    expect(service.isLocked()).toBe(false);
  });

  it('should allow second acquire to wait until first releases', async () => {
    const order: string[] = [];

    await service.acquire();
    order.push('first-acquired');

    const secondAcquire = service.acquire().then(() => {
      order.push('second-acquired');
    });

    // Second acquire should be waiting
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-acquired']);

    service.release();
    order.push('first-released');

    await secondAcquire;

    expect(order).toEqual([
      'first-acquired',
      'first-released',
      'second-acquired',
    ]);
    service.release();
  });

  it('should be a no-op when releasing an unlocked lock', () => {
    expect(service.isLocked()).toBe(false);
    service.release(); // Should not throw
    expect(service.isLocked()).toBe(false);
  });

  it('should reflect current state via isLocked()', async () => {
    expect(service.isLocked()).toBe(false);
    await service.acquire();
    expect(service.isLocked()).toBe(true);
    service.release();
    expect(service.isLocked()).toBe(false);
  });

  it('should handle multiple sequential acquire/release cycles', async () => {
    for (let i = 0; i < 5; i++) {
      expect(service.isLocked()).toBe(false);
      await service.acquire();
      expect(service.isLocked()).toBe(true);
      service.release();
      expect(service.isLocked()).toBe(false);
    }
  });

  it('should auto-release after 30s timeout', async () => {
    vi.useFakeTimers();

    await service.acquire();
    expect(service.isLocked()).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(service.isLocked()).toBe(false);

    vi.useRealTimers();
  });

  it('should clear timeout on normal release', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    await service.acquire();
    service.release();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(service.isLocked()).toBe(false);

    vi.useRealTimers();
  });
});
