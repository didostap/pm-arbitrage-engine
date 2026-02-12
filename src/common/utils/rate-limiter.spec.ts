import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const logger = new Logger('TestRateLimiter');
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    limiter = new RateLimiter(16, 8, 1, logger);
  });

  it('should allow read requests within limit', async () => {
    await limiter.acquireRead();
    const utilization = limiter.getUtilization();
    expect(utilization.read).toBeLessThan(10);
  });

  it('should allow write requests within limit', async () => {
    await limiter.acquireWrite();
    const utilization = limiter.getUtilization();
    expect(utilization.write).toBeLessThan(20);
  });

  it('should emit alert at 70% read utilization', async () => {
    // Consume 12 of 16 tokens = 75%
    for (let i = 0; i < 12; i++) {
      await limiter.acquireRead();
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Rate limit utilization high',
        type: 'read',
      }),
    );
  });

  it('should emit alert at 70% write utilization', async () => {
    // Consume 6 of 8 tokens = 75%
    for (let i = 0; i < 6; i++) {
      await limiter.acquireWrite();
    }

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Rate limit utilization high',
        type: 'write',
      }),
    );
  });

  it('should track read and write buckets separately', async () => {
    // Exhaust write tokens
    for (let i = 0; i < 8; i++) {
      await limiter.acquireWrite();
    }

    // Read bucket should still have tokens
    await limiter.acquireRead();
    const utilization = limiter.getUtilization();
    expect(utilization.read).toBeLessThan(10);
    expect(utilization.write).toBeGreaterThan(90);
  });

  it('should create limiter from tier name', () => {
    const basicLimiter = RateLimiter.fromTier('BASIC');
    expect(basicLimiter).toBeInstanceOf(RateLimiter);
  });

  it('should throw for unknown tier', () => {
    expect(() => RateLimiter.fromTier('UNKNOWN')).toThrow(
      'Unknown rate limit tier: UNKNOWN',
    );
  });
});
