import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let logger: Logger;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new Logger('TestRateLimiter');
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(logger, 'log').mockImplementation(() => {});
    limiter = new RateLimiter(16, 8, 16, 8, logger);
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

  it('should create limiter from fromLimits() with correct bucket sizes and refill rates', async () => {
    const fl = RateLimiter.fromLimits(20, 10, logger);

    // Bucket sizes: ceil(20 × 1.5) = 30 read, ceil(10 × 1.5) = 15 write
    // After consuming 1 read token: utilization = 1/30 ≈ 3.33%
    await fl.acquireRead();
    const util = fl.getUtilization();
    expect(util.read).toBeCloseTo((1 / 30) * 100, 0);
    // After consuming 1 write token: utilization = 1/15 ≈ 6.67%
    await fl.acquireWrite();
    const util2 = fl.getUtilization();
    expect(util2.write).toBeCloseTo((1 / 15) * 100, 0);
  });

  it('should produce equivalent limiters from fromTier("BASIC") and fromLimits(20, 10)', async () => {
    const tierLimiter = RateLimiter.fromTier('BASIC', logger);
    const limitsLimiter = RateLimiter.fromLimits(20, 10, logger);

    // Consume same number of tokens from each
    for (let i = 0; i < 5; i++) {
      await tierLimiter.acquireRead();
      await limitsLimiter.acquireRead();
    }

    const tierUtil = tierLimiter.getUtilization();
    const limitsUtil = limitsLimiter.getUtilization();
    expect(tierUtil.read).toBeCloseTo(limitsUtil.read, 0);
    expect(tierUtil.write).toBeCloseTo(limitsUtil.write, 0);
  });

  it('should refill read and write buckets at independent rates', async () => {
    // High read refill (100/s), low write refill (1/s)
    const asymmetric = new RateLimiter(10, 10, 100, 1, logger);

    // Drain both buckets equally
    for (let i = 0; i < 8; i++) {
      await asymmetric.acquireRead();
      await asymmetric.acquireWrite();
    }

    const utilBefore = asymmetric.getUtilization();
    expect(utilBefore.read).toBeGreaterThan(50);
    expect(utilBefore.write).toBeGreaterThan(50);

    // Wait 100ms — read refills 10 tokens (100 * 0.1), write refills 0.1 tokens (1 * 0.1)
    await new Promise((r) => setTimeout(r, 100));

    const utilAfter = asymmetric.getUtilization();
    // Read should have recovered significantly more than write
    expect(utilAfter.read).toBeLessThan(utilAfter.write);
  });

  it('should throw for non-positive limits in fromLimits()', () => {
    expect(() => RateLimiter.fromLimits(0, 10, logger)).toThrow(
      'must be positive',
    );
    expect(() => RateLimiter.fromLimits(20, -1, logger)).toThrow(
      'must be positive',
    );
    expect(() => RateLimiter.fromLimits(-5, -5, logger)).toThrow(
      'must be positive',
    );
  });

  it('should emit startup configuration log from fromLimits()', () => {
    RateLimiter.fromLimits(20, 10, logger);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Rate limiter configured',
        data: {
          readBurst: 30,
          writeBurst: 15,
          readSustained: 16,
          writeSustained: 8,
        },
      }),
    );
  });
});
