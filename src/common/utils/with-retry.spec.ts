import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry } from './with-retry.js';
import { RetryStrategy } from '../errors/index.js';

const FAST_STRATEGY: RetryStrategy = {
  maxRetries: 3,
  initialDelayMs: 1,
  maxDelayMs: 10,
  backoffMultiplier: 2,
};

describe('withRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, FAST_STRATEGY);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('success');

    const result = await withRetry(fn, FAST_STRATEGY);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

    await expect(withRetry(fn, FAST_STRATEGY)).rejects.toThrow(
      'persistent failure',
    );
    // initial + 3 retries = 4
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('should call onRetry callback on each retry', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const onRetry = vi.fn();
    await withRetry(fn, FAST_STRATEGY, onRetry);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('should handle non-Error throwables', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce('string error')
      .mockResolvedValue('ok');

    const result = await withRetry(fn, FAST_STRATEGY);
    expect(result).toBe('ok');
  });

  it('should respect maxRetries of 0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const noRetry: RetryStrategy = {
      ...FAST_STRATEGY,
      maxRetries: 0,
    };

    await expect(withRetry(fn, noRetry)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
